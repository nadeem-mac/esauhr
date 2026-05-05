// =============================================================================
// ManagerMonthlyPlanner.jsx
//
// Replaces the previous week-by-week ManagerShiftCard. Per Nadeem:
// managers plan a full month in one shot, defaulting to last month's
// schedule cloned forward as the starting point.
//
// WORKFLOW
//   1. Manager picks an employee from the dropdown (their direct
//      reports only). On first load this auto-selects the first
//      report.
//   2. Manager picks a target month — current, next, or month-after-
//      next. Defaults to NEXT month (the most common case: planning
//      ahead for the upcoming month).
//   3. Planner pre-fills with last month's schedule cloned forward
//      one calendar month for that same employee. If no last-month
//      data exists, opens blank.
//   4. Manager applies a quick pattern (Every Sun-Thu / Every weekday
//      / Saturdays only / Clear all) or taps individual day cells to
//      toggle them.
//   5. Manager sets one Start time + one End time for the whole
//      month. Overnight shifts (end < start) are auto-flagged.
//   6. Save commits all selected days as employee_shifts rows
//      (status='pending') via upsert on (employee_id, shift_date).
//      Removed days get deleted. Manager sees a toast confirming
//      "X shifts saved for Khalid".
//   7. The save also writes/updates the monthly_shift_plans row so
//      the end-of-month reminder logic can detect that this manager
//      has planned this month.
//
// DESIGN NOTES
//   • One employee at a time. Multi-employee bulk would either be a
//     tab nightmare on mobile or a sprawling matrix that drowns the
//     phone screen. The dropdown swap is fast and matches how the
//     Sonnie/Sharique data was structured (per-employee blocks).
//   • Past dates are LOCKED (read-only). Mirrors the previous card's
//     behavior — once a day is past, the manager cannot retroactively
//     plan a shift.
//   • Hour granularity only (HH:00). Matches the existing time
//     storage convention; no minutes selector.
//   • Save calls are batched: one upsert for the new/updated rows,
//     one delete for removed rows, one upsert for the
//     monthly_shift_plans tracker row. Three round trips total
//     regardless of how many days are in the plan.
//
// SCHEMA REFERENCE
//   employee_shifts(employee_id, shift_date, start_time, end_time,
//                   set_by, status, notes)
//     UNIQUE(employee_id, shift_date)
//   monthly_shift_plans(manager_id, plan_month, shifts_count,
//                       last_committed_at, last_committed_by)
//     UNIQUE(manager_id, plan_month)
// =============================================================================

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Card } from './Dashboard.jsx';
import { directGet, directPost, directDelete, directPatchQuery, supabase } from '../supabaseClient.js';
import {
  Loader2, Save, Calendar as CalIcon, Lock, Moon, CheckCircle2, Sparkles, Copy, X,
} from 'lucide-react';

// ─── Constants ────────────────────────────────────────────────────────
const DOW_LONG  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_START = '09:00';
const DEFAULT_END   = '17:00';
const SAR_LOCALE = 'en-GB';

// Hour-granularity 00:00 → 23:00 select options. Same as the previous
// editor — the rest of the app's display + comparison logic assumes
// hour-only times.
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) =>
  `${String(h).padStart(2, '0')}:00`
);

// ─── Date helpers ─────────────────────────────────────────────────────
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfMonth(year, monthIdx) {
  return new Date(year, monthIdx, 1);
}
function endOfMonth(year, monthIdx) {
  return new Date(year, monthIdx + 1, 0); // day 0 of next month = last day this month
}

function trimTime(t) {
  // Normalise a time string from PG to 'HH:00'. Older rows might be
  // 'HH:MM:SS' or 'HH:MM'. Floor anything non-hour to a sensible
  // default so dropdowns always have a valid value.
  if (!t) return DEFAULT_START;
  const hh = String(t).slice(0, 2);
  return /^\d{2}$/.test(hh) ? `${hh}:00` : DEFAULT_START;
}

function todayKey() {
  return ymd(new Date());
}

function monthLabel(year, monthIdx) {
  return new Date(year, monthIdx, 1).toLocaleDateString(SAR_LOCALE, {
    month: 'long', year: 'numeric',
  });
}

// Build the list of "selectable months" for the segmented control.
// Always: current, next, month-after-next. But each is flagged
// `locked` if it's not yet within its planning window — the rule
// matches the end-of-month reminder cadence: a month "unlocks" on
// the 25th of the month before it. So:
//
//   • Current month  — always unlocked (managers can always edit
//     the current month even mid-month for late hires, schedule
//     changes, etc.)
//   • Next month     — unlocked from the 25th of the current month
//   • Month-after-next — unlocked from the 25th of the next month
//
// Locked tabs are shown but disabled, with a tooltip explaining
// when they'll unlock. This keeps a manager opening on May 5 from
// accidentally planning June while thinking they're planning May.
const UNLOCK_DAY_OF_MONTH = 25;

function buildMonthChoices() {
  const now = new Date();
  return [0, 1, 2].map(offset => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    // Unlock date: 25th of the month BEFORE the planned month.
    const unlockDate = new Date(d.getFullYear(), d.getMonth() - 1, UNLOCK_DAY_OF_MONTH);
    const locked = offset > 0 && now < unlockDate;
    return {
      year: d.getFullYear(),
      monthIdx: d.getMonth(),
      label: d.toLocaleDateString(SAR_LOCALE, { month: 'short', year: 'numeric' }),
      isCurrent: offset === 0,
      isNext: offset === 1,
      locked,
      unlockDate,
      unlockLabel: unlockDate.toLocaleDateString(SAR_LOCALE, { day: 'numeric', month: 'long' }),
    };
  });
}

// Pick the right default month for the segmented control. Rules:
//   1. If the current month is the only unlocked option, pick it.
//   2. If next month is unlocked AND the current month already has
//      a saved plan, pick next (the manager has already done this
//      month's work and is here to do next).
//   3. Otherwise pick current.
//
// `currentPlanCommitted` is the boolean from the
// monthly_shift_plans tracker — null means we don't know yet.
function chooseDefaultMonth(choices, currentPlanCommitted) {
  const [cur, nxt] = choices;
  if (nxt && !nxt.locked && currentPlanCommitted) return nxt;
  return cur;
}

// ─── Component ────────────────────────────────────────────────────────
export default function ManagerMonthlyPlanner({ me, employees }) {
  // Direct reports only — managers don't plan shifts for people who
  // don't report to them.
  const myReports = useMemo(() => {
    if (!me?.id || !Array.isArray(employees)) return [];
    return employees.filter(e => e.manager_id === me.id);
  }, [me?.id, employees]);

  // ─── Selection state ───────────────────────────────────────────────
  const [employeeId, setEmployeeId] = useState(null);
  const monthChoices = useMemo(buildMonthChoices, []);
  // Default to the CURRENT month for safety — locking a manager
  // out of planning the rest of the current month would be wrong,
  // and pre-selecting next month risks them planning June while
  // believing they're planning May. We refine this once we know
  // whether the current month is already committed (see effect
  // further down — flips to next month if current is already
  // saved AND next is unlocked).
  const [monthSel, setMonthSel] = useState(monthChoices[0]);
  // Has the manager already committed the CURRENT month's plan?
  // null = unknown (still loading), true/false once the
  // monthly_shift_plans tracker has been checked.
  const [currentMonthCommitted, setCurrentMonthCommitted] = useState(null);

  // Auto-pick first report on mount. If reports change (rare — admin
  // re-assignment) and the picked one is gone, fall back to the first.
  useEffect(() => {
    if (myReports.length === 0) {
      setEmployeeId(null);
      return;
    }
    if (!employeeId || !myReports.some(r => r.id === employeeId)) {
      setEmployeeId(myReports[0].id);
    }
  }, [myReports, employeeId]);

  // Once on mount, check whether THIS manager has committed plans
  // for ALL their direct reports for the current month. If yes,
  // AND next month is unlocked, flip the default selection from
  // current to next so the manager lands on the more relevant tab.
  // We only flip ONCE — if the manager later clicks the current
  // tab manually we don't bounce them back.
  //
  // Semantics under per-employee tracker: the previous version
  // flipped after ANY plan was saved for current month, which was
  // wrong — saving Khalid alone shouldn't flip the default away
  // from May when 5 other reports are still unplanned. Now we
  // require commits.size >= myReports.length.
  useEffect(() => {
    if (!me?.id) return;
    if (myReports.length === 0) return; // nothing to flip on
    let cancelled = false;
    (async () => {
      try {
        const cur = monthChoices[0];
        const planKey = ymd(startOfMonth(cur.year, cur.monthIdx));
        // Fetch ALL committed (employee_id) for this (manager, month)
        // so we can count distinct committed employees.
        const rows = await directGet(
          'monthly_shift_plans',
          `select=employee_id,last_committed_at` +
          `&manager_id=eq.${encodeURIComponent(me.id)}` +
          `&plan_month=eq.${planKey}`,
          { timeoutMs: 6000 }
        );
        if (cancelled) return;
        const committedEmployees = new Set(
          (rows || [])
            .filter(r => r.last_committed_at && r.employee_id)
            .map(r => r.employee_id)
        );
        const allCommitted = committedEmployees.size >= myReports.length;
        setCurrentMonthCommitted(allCommitted);
        // Refine the default: only flip to next if all direct reports
        // have committed plans for current month AND next month is
        // unlocked AND we're still showing the initial default.
        const nxt = monthChoices[1];
        if (allCommitted && nxt && !nxt.locked) {
          setMonthSel(prev => (prev?.monthIdx === cur.monthIdx ? nxt : prev));
        }
      } catch {
        if (!cancelled) setCurrentMonthCommitted(false);
      }
    })();
    return () => { cancelled = true; };
    // monthChoices is a stable useMemo result. Re-run if the manager's
    // direct-report set changes (rare admin reassignment) so the
    // "all committed" comparison stays accurate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id, myReports.length]);

  // ─── Plan state ────────────────────────────────────────────────────
  // Map of date-key (YYYY-MM-DD) → { selected: bool, start, end }.
  // 'selected' false means the day is unchecked (won't be saved).
  const [plan, setPlan] = useState({});
  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(DEFAULT_END);
  const [planLoading, setPlanLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState(null);
  const [lastCommittedAt, setLastCommittedAt] = useState(null);
  // dayPopover: { dateKey, draftStart, draftEnd } when a selected day
  // is being edited. null when nothing's open. Tapping a selected day
  // opens this; tapping an unselected day just adds it with the bulk
  // time (no popover, faster workflow for the common case).
  const [dayPopover, setDayPopover] = useState(null);
  const [errorMsg, setErrorMsg] = useState('');

  // ─── Weekly off-day pattern ────────────────────────────────────────
  // Per-employee, per-month set of weekday numbers (0=Sun, 6=Sat)
  // that the manager has explicitly marked as off-days. Distinct
  // from "no shift planned" — these are deliberate off-days that
  // get a visible OFF label in the calendar grid.
  //
  // Persisted alongside the working-shift plan in the
  // monthly_shift_plans tracker (off_weekdays column). Cloned
  // forward when the manager opens a fresh next-month plan.
  //
  // Working shifts WIN: if a date has both a working shift and
  // matches the off-pattern, the working shift renders. Pattern
  // is conceptually "default off, but assigned shifts override."
  const [offWeekdays, setOffWeekdays] = useState([]);
  const offWeekdaysSet = useMemo(() => new Set(offWeekdays), [offWeekdays]);

  function toggleOffWeekday(dow) {
    setOffWeekdays(prev =>
      prev.includes(dow) ? prev.filter(d => d !== dow) : [...prev, dow].sort()
    );
  }

  // ─── Edit-cap state ────────────────────────────────────────────────
  // The save flow is: first save commits the plan, button greys out
  // and an Edit button appears next to it. Manager hits Edit to
  // re-enable saves. Up to 3 edits after the initial save (so a
  // total of 4 commits) are allowed; the 4th edit attempt is blocked.
  //
  // editCount mirrors the monthly_shift_plans.edit_count column for
  // this (manager_id, plan_month) pair. Loaded with the rest of the
  // plan; refetched after each save.
  //
  // editMode: 'editing' = save button enabled (initial state for
  //            unsaved plans, or after Edit click)
  //           'locked'  = save button greyed; Edit button visible
  //                       if edits remain, or both buttons disabled
  //                       if cap is reached
  const [editCount, setEditCount] = useState(0);
  const [editMode, setEditMode]   = useState('editing');
  const MAX_EDITS = 3;

  // ─── Impact-confirmation dialog state ─────────────────────────────
  // When a save would re-pend already-accepted shifts (because their
  // times changed or the day was removed), we pause the save and
  // surface a confirmation modal listing the impacted shifts. The
  // manager confirms or backs out; on confirm, the save runs and
  // the impacted shifts are flipped back to pending. Without this
  // a manager could silently invalidate staff acknowledgments.
  //
  // Shape: { rows, datesToDelete, impactedAccepted: [{date, name, ...}] }
  const [pendingConfirm, setPendingConfirm] = useState(null);

  // ─── Build the empty calendar for the selected month ───────────────
  // Returns an array of date-keys (YYYY-MM-DD) for every day in the
  // month, plus the day-of-week index (0=Sun) for grid alignment.
  const monthDays = useMemo(() => {
    if (!monthSel) return [];
    const first = startOfMonth(monthSel.year, monthSel.monthIdx);
    const last  = endOfMonth(monthSel.year, monthSel.monthIdx);
    const days = [];
    for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
      days.push({
        key: ymd(d),
        dow: d.getDay(),
        date: d.getDate(),
      });
    }
    return days;
  }, [monthSel]);

  // ─── Load existing plan + clone-from-last-month ─────────────────────
  const loadPlan = useCallback(async () => {
    if (!employeeId || !monthSel) return;
    setPlanLoading(true);
    setErrorMsg('');
    // Reset edit-cap state immediately so the Save button doesn't
    // briefly show the PREVIOUS employee's locked "Saved" label
    // while the new employee's tracker row is being fetched. The
    // tracker fetch later in this function then sets these to the
    // correct values for the newly-selected (employee, month).
    setLastCommittedAt(null);
    setEditCount(0);
    setEditMode('editing');
    setPlan({});
    setOffWeekdays([]);
    try {
      const fromKey = ymd(startOfMonth(monthSel.year, monthSel.monthIdx));
      const toKey   = ymd(endOfMonth(monthSel.year, monthSel.monthIdx));

      const existing = await directGet(
        'employee_shifts',
        `select=shift_date,start_time,end_time` +
        `&employee_id=eq.${encodeURIComponent(employeeId)}` +
        `&shift_date=gte.${fromKey}&shift_date=lte.${toKey}`,
        { timeoutMs: 8000 }
      );

      const next = {};

      // Pre-fill every day with selected:false so the calendar shows
      // unchecked cells we can later toggle.
      for (const d of monthDays) {
        next[d.key] = { selected: false, start: DEFAULT_START, end: DEFAULT_END };
      }

      let derivedStart = null;
      let derivedEnd   = null;

      if (Array.isArray(existing) && existing.length > 0) {
        // ALREADY-PLANNED MONTH — restore the saved state. Picks the
        // most-common (start, end) pair as the bulk time so the
        // dropdowns reflect the bulk choice. Outliers stay on their
        // own day-specific times — the per-day overrides aren't shown
        // in this UI yet (future tweak), but the rows are preserved.
        const timeFreq = new Map();
        for (const row of existing) {
          const s = trimTime(row.start_time);
          const e = trimTime(row.end_time);
          next[row.shift_date] = { selected: true, start: s, end: e };
          const key = `${s}|${e}`;
          timeFreq.set(key, (timeFreq.get(key) || 0) + 1);
        }
        let topKey = null, topCount = 0;
        for (const [k, c] of timeFreq) {
          if (c > topCount) { topCount = c; topKey = k; }
        }
        if (topKey) {
          [derivedStart, derivedEnd] = topKey.split('|');
        }
      } else {
        // EMPTY MONTH — clone last month's schedule shifted forward by
        // one calendar month. If May has shifts on the 3rd, 4th, 5th,
        // we pre-select the 3rd, 4th, 5th of June with the same times.
        // Days that don't exist in the target month (e.g. cloning a
        // 31st into a 30-day month) are silently skipped.
        const prev = new Date(monthSel.year, monthSel.monthIdx - 1, 1);
        const prevFromKey = ymd(startOfMonth(prev.getFullYear(), prev.getMonth()));
        const prevToKey   = ymd(endOfMonth(prev.getFullYear(), prev.getMonth()));
        try {
          const lastMonth = await directGet(
            'employee_shifts',
            `select=shift_date,start_time,end_time` +
            `&employee_id=eq.${encodeURIComponent(employeeId)}` +
            `&shift_date=gte.${prevFromKey}&shift_date=lte.${prevToKey}`,
            { timeoutMs: 8000 }
          );
          if (Array.isArray(lastMonth) && lastMonth.length > 0) {
            const timeFreq = new Map();
            for (const row of lastMonth) {
              const [, , dayStr] = row.shift_date.split('-');
              const dayNum = parseInt(dayStr, 10);
              const target = new Date(monthSel.year, monthSel.monthIdx, dayNum);
              if (target.getMonth() !== monthSel.monthIdx) continue; // overflow
              const targetKey = ymd(target);
              if (!next[targetKey]) continue;
              const s = trimTime(row.start_time);
              const e = trimTime(row.end_time);
              next[targetKey] = { selected: true, start: s, end: e };
              const k = `${s}|${e}`;
              timeFreq.set(k, (timeFreq.get(k) || 0) + 1);
            }
            let topKey = null, topCount = 0;
            for (const [k, c] of timeFreq) {
              if (c > topCount) { topCount = c; topKey = k; }
            }
            if (topKey) {
              [derivedStart, derivedEnd] = topKey.split('|');
            }
          }
          // Also clone the off-weekday pattern from last month.
          // Best-effort — if the prior tracker row doesn't exist
          // we just open with no off-pattern.
          try {
            const prevPlanKey = ymd(startOfMonth(prev.getFullYear(), prev.getMonth()));
            const prevTrackerRows = await directGet(
              'monthly_shift_plans',
              `select=off_weekdays` +
              `&manager_id=eq.${encodeURIComponent(me.id)}` +
              `&employee_id=eq.${encodeURIComponent(employeeId)}` +
              `&plan_month=eq.${prevPlanKey}` +
              `&limit=1`,
              { timeoutMs: 5000 }
            );
            const prevR = Array.isArray(prevTrackerRows) ? prevTrackerRows[0] : null;
            if (Array.isArray(prevR?.off_weekdays) && prevR.off_weekdays.length > 0) {
              setOffWeekdays(prevR.off_weekdays.slice());
            }
          } catch {
            // Non-fatal — open without off-pattern
          }
        } catch (e) {
          // Clone failure is non-fatal — manager just gets a blank
          // calendar to plan from scratch.
          console.warn('Clone-from-last-month failed:', e?.message || e);
        }
      }

      // Once we know the bulk time, mark each selected day as
      // 'customized' if its own start/end differs from the bulk.
      // This drives the visual treatment (italic + bullet) and the
      // exclusion from bulk-time / pattern-preset overrides — a
      // manager who manually set Tuesday to 06:00 doesn't want a
      // "Tuesdays only" preset click to wipe it.
      if (derivedStart && derivedEnd) {
        for (const k of Object.keys(next)) {
          const c = next[k];
          if (c?.selected && (c.start !== derivedStart || c.end !== derivedEnd)) {
            next[k] = { ...c, customized: true };
          }
        }
      }

      setPlan(next);
      setStart(derivedStart || DEFAULT_START);
      setEnd(derivedEnd || DEFAULT_END);

      // Fetch last-committed-at + edit_count for this (manager, month)
      // so we can show "last saved Tuesday at 3:42 PM" + drive the
      // locked/editing state of the Save button.
      try {
        const planKey = ymd(startOfMonth(monthSel.year, monthSel.monthIdx));
        // Scope by employee_id — without it, switching the dropdown
        // from staff A to staff B would return A's tracker row and
        // wrongly lock the form for B. Each (manager, employee, month)
        // tuple has its own tracker row, matched by the new
        // (manager_id, employee_id, plan_month) unique constraint
        // on monthly_shift_plans.
        const planRows = await directGet(
          'monthly_shift_plans',
          `select=last_committed_at,shifts_count,edit_count,off_weekdays` +
          `&manager_id=eq.${encodeURIComponent(me.id)}` +
          `&employee_id=eq.${encodeURIComponent(employeeId)}` +
          `&plan_month=eq.${planKey}` +
          `&limit=1`,
          { timeoutMs: 6000 }
        );
        const r = Array.isArray(planRows) ? planRows[0] : null;
        setLastCommittedAt(r?.last_committed_at || null);
        const ec = Number.isInteger(r?.edit_count) ? r.edit_count : 0;
        setEditCount(ec);
        // If the plan has already been committed (last_committed_at
        // is non-null), open in 'locked' mode — manager has to click
        // Edit to make changes. If never saved before, open in
        // 'editing' so the first save works without an extra click.
        setEditMode(r?.last_committed_at ? 'locked' : 'editing');
        // Restore the off-day pattern. PG returns int[] as a JS
        // array; if absent/null, fall back to empty.
        setOffWeekdays(Array.isArray(r?.off_weekdays) ? r.off_weekdays.slice() : []);
      } catch {
        setLastCommittedAt(null);
        setEditCount(0);
        setEditMode('editing');
        setOffWeekdays([]);
      }
    } catch (e) {
      console.warn('Plan load failed:', e);
      setErrorMsg(e?.message || 'Could not load the plan.');
    } finally {
      setPlanLoading(false);
    }
  }, [employeeId, monthSel, monthDays, me?.id]);

  useEffect(() => { loadPlan(); }, [loadPlan]);

  // Realtime — refresh if someone else (admin/HR) edits the
  // employee's shifts while this planner is open.
  useEffect(() => {
    if (!supabase || !employeeId) return;
    let timer = null;
    const ch = supabase.channel(`monthly-planner-${employeeId}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'employee_shifts',
        filter: `employee_id=eq.${employeeId}`,
      }, () => {
        clearTimeout(timer);
        timer = setTimeout(loadPlan, 800);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [employeeId, loadPlan]);

  // ─── Selected count + overnight detection ──────────────────────────
  const selectedCount = useMemo(
    () => Object.values(plan).filter(d => d.selected).length,
    [plan]
  );

  const isOvernight = useMemo(() => {
    const sH = parseInt(start.slice(0, 2), 10);
    const eH = parseInt(end.slice(0, 2), 10);
    return eH <= sH;
  }, [start, end]);

  // ─── Pattern actions ───────────────────────────────────────────────
  // Each pattern operates on the CURRENT plan map: it sets `selected`
  // and applies the bulk start/end to days it touches. Doesn't clear
  // unrelated days unless the pattern explicitly does so (Clear all).
  function applyPattern(name) {
    setPlan(prev => {
      const next = { ...prev };
      const todayK = todayKey();
      for (const d of monthDays) {
        if (d.key < todayK) continue; // never touch past days
        const cur = next[d.key] || {};
        const wantSelected = matchesPattern(name, d);
        if (name === 'clear') {
          // 'Clear all' wipes everything including customizations —
          // the manager is starting fresh. customized flag goes too.
          next[d.key] = { ...cur, selected: false, customized: false };
        } else {
          // Preserve individually-customized day times. The pattern
          // controls SELECTION; if a day was already customized and
          // is in the pattern, it stays selected with its custom
          // time. If it's NOT in the pattern, it stays as-is (the
          // pattern doesn't deselect, only selects — same as before).
          if (cur.customized && cur.selected) {
            // Customized + selected → leave its times alone whether
            // or not the pattern matches. Manager can still untoggle
            // via the popover if they want.
            next[d.key] = { ...cur };
          } else if (wantSelected) {
            next[d.key] = { ...cur, selected: true, start, end, customized: false };
          } else {
            next[d.key] = { ...cur, selected: cur.selected || false };
          }
        }
      }
      return next;
    });
  }

  function matchesPattern(name, day) {
    switch (name) {
      case 'sun-thu':   return day.dow >= 0 && day.dow <= 4;
      case 'mon-fri':   return day.dow >= 1 && day.dow <= 5;
      case 'sat-only':  return day.dow === 6;
      case 'sun-only':  return day.dow === 0;
      case 'mon-only':  return day.dow === 1;
      case 'tue-only':  return day.dow === 2;
      case 'wed-only':  return day.dow === 3;
      case 'thu-only':  return day.dow === 4;
      default: return false;
    }
  }

  // Tapping a day cell:
  //   • Past dates → ignore (locked)
  //   • Unselected → add it with the bulk time (no popover; fast)
  //   • Selected → open the per-day editor popover so the manager
  //     can change just THIS day's time, snap it back to the bulk
  //     time, or remove it. Without this, changing the bulk time
  //     would override every selected day — there was no way to
  //     give one staff member a different time on a single date.
  function toggleDay(dateKey) {
    if (dateKey < todayKey()) return;
    const cur = plan[dateKey];
    if (cur?.selected) {
      setDayPopover({
        dateKey,
        draftStart: cur.start || start,
        draftEnd:   cur.end   || end,
      });
      return;
    }
    setPlan(prev => ({
      ...prev,
      [dateKey]: { selected: true, start, end, customized: false },
    }));
  }

  // Save a per-day time override. The day stays selected and is
  // flagged customized so subsequent bulk-time changes and pattern
  // preset clicks won't blow it away.
  function setDayTimes(dateKey, newStart, newEnd) {
    setPlan(prev => ({
      ...prev,
      [dateKey]: {
        ...prev[dateKey],
        selected: true,
        start: newStart,
        end:   newEnd,
        customized: !(newStart === start && newEnd === end),
      },
    }));
    setDayPopover(null);
  }

  // Snap a customized day back to the current bulk time. After this
  // the day tracks future bulk-time changes again.
  function resetDayToBulk(dateKey) {
    setPlan(prev => ({
      ...prev,
      [dateKey]: { ...prev[dateKey], start, end, customized: false },
    }));
    setDayPopover(null);
  }

  // Remove a previously-selected day from the plan. Same outcome the
  // old toggle had — the day becomes unchecked and won't be saved.
  function removeDay(dateKey) {
    setPlan(prev => ({
      ...prev,
      [dateKey]: { ...prev[dateKey], selected: false, customized: false },
    }));
    setDayPopover(null);
  }

  // When the bulk start/end changes, retroactively apply to all
  // currently-selected days that aren't individually customized.
  // Days the manager explicitly tweaked via the per-day popover
  // (cell.customized === true) are LEFT ALONE — that's the whole
  // point of customization. They snap back to the bulk only if
  // the manager hits "Reset to bulk" in the popover.
  useEffect(() => {
    setPlan(prev => {
      const next = { ...prev };
      let changed = false;
      for (const k of Object.keys(next)) {
        const c = next[k];
        if (c?.selected && !c.customized) {
          if (c.start !== start || c.end !== end) {
            next[k] = { ...c, start, end };
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [start, end]);

  // ─── Save (two-stage flow) ─────────────────────────────────────────
  // Stage 1: prepareSave() — gathers the payload, checks the edit
  // cap, queries for any already-accepted shifts that this save
  // would change/remove, and either:
  //   • opens the confirmation modal (if accepted shifts will be
  //     impacted), so the manager confirms before invalidating
  //     staff acknowledgments, OR
  //   • proceeds straight to executeSave() if no impact.
  //
  // Stage 2: executeSave({ rows, datesToDelete, impactedAccepted })
  // does the actual writes:
  //   1. Upsert the new/updated shifts (status = 'pending').
  //      For impacted accepted shifts this AUTO-CLEARS the
  //      acceptance because we send status='pending' on every
  //      row in the upsert payload — staff will see them in
  //      their acknowledgment queue again.
  //   2. Clear accepted_at/declined_at/decline_reason on impacted
  //      rows so the staff-side modal treats them as fresh.
  //   3. Bulk-delete the unchecked-day rows.
  //   4. Upsert the monthly_shift_plans tracker (bumps edit_count
  //      after the first save).
  //   5. Toast + lock the form (editMode='locked').
  async function prepareSave() {
    if (!employeeId || !monthSel || saving) return;
    if (monthSel.locked) {
      setErrorMsg(`That month doesn't unlock until ${monthSel.unlockLabel}. Please plan the current month first.`);
      return;
    }
    if (editMode !== 'editing') {
      // Belt-and-braces: button should already be greyed in 'locked'
      // mode, but if state ever gets out of sync this catches it.
      setErrorMsg('The plan is locked. Click "Edit schedule" to make changes.');
      return;
    }
    if (editCount >= MAX_EDITS) {
      // Caught here AND in the Edit handler. Means the manager has
      // already used up their 3 edits and somehow still has the
      // Save button enabled.
      setErrorMsg(`You've reached the limit of ${MAX_EDITS} edits for this month. Contact HR to make further changes.`);
      return;
    }

    setSaving(true);
    setErrorMsg('');

    try {
      const fromKey = ymd(startOfMonth(monthSel.year, monthSel.monthIdx));
      const toKey   = ymd(endOfMonth(monthSel.year, monthSel.monthIdx));
      const todayK = todayKey();

      // Build the upsert payload — only future-and-today selected days.
      const rows = [];
      for (const d of monthDays) {
        if (d.key < todayK) continue;
        const cell = plan[d.key];
        if (cell?.selected) {
          rows.push({
            employee_id: employeeId,
            shift_date:  d.key,
            start_time:  cell.start || start,
            end_time:    cell.end   || end,
            set_by:      me.id,
            status:      'pending',
          });
        }
      }

      // Pre-flight: pull existing rows in the window WITH their
      // acceptance state so we can flag impacted ones.
      const fromForExisting = todayK > fromKey ? todayK : fromKey;
      const existing = await directGet(
        'employee_shifts',
        `select=shift_date,start_time,end_time,status,accepted_at` +
        `&employee_id=eq.${encodeURIComponent(employeeId)}` +
        `&shift_date=gte.${fromForExisting}&shift_date=lte.${toKey}`,
        { timeoutMs: 12000 }
      );

      const existingByDate = new Map();
      for (const r of (existing || [])) existingByDate.set(r.shift_date, r);

      const keepKeys = new Set(rows.map(r => r.shift_date));
      const datesToDelete = Array.from(existingByDate.keys()).filter(d => !keepKeys.has(d));

      // Find impacted ACCEPTED shifts: anything that's currently
      // status='accepted' OR has an accepted_at, AND will either
      //   (a) be deleted (day unchecked), or
      //   (b) have its time changed (start or end differs).
      // Time strings are normalised to 'HH:MM' for comparison so
      // PG's 'HH:MM:SS' format doesn't false-flag a "change".
      const norm = t => trimTime(t);
      const impactedAccepted = [];
      for (const ex of (existing || [])) {
        const wasAccepted = ex.status === 'accepted' || Boolean(ex.accepted_at);
        if (!wasAccepted) continue;

        if (!keepKeys.has(ex.shift_date)) {
          impactedAccepted.push({
            date: ex.shift_date,
            kind: 'removed',
            oldStart: norm(ex.start_time),
            oldEnd:   norm(ex.end_time),
            newStart: null,
            newEnd:   null,
          });
          continue;
        }

        const newRow = rows.find(r => r.shift_date === ex.shift_date);
        if (newRow) {
          const oldS = norm(ex.start_time);
          const oldE = norm(ex.end_time);
          const newS = norm(newRow.start_time);
          const newE = norm(newRow.end_time);
          if (oldS !== newS || oldE !== newE) {
            impactedAccepted.push({
              date: ex.shift_date,
              kind: 'time-changed',
              oldStart: oldS, oldEnd: oldE,
              newStart: newS, newEnd: newE,
            });
          }
        }
      }

      const payload = { rows, datesToDelete, impactedAccepted, fromKey };

      if (impactedAccepted.length > 0) {
        // Open the confirmation modal — executeSave runs only if
        // the manager confirms.
        setSaving(false);
        setPendingConfirm(payload);
        return;
      }

      // No impact — write straight through.
      await executeSave(payload);
    } catch (e) {
      console.error('Save preflight failed:', e);
      setErrorMsg(e?.message || 'Could not check the plan before saving. Please try again.');
      setSaving(false);
    }
  }

  async function executeSave({ rows, datesToDelete, impactedAccepted, fromKey }) {
    setSaving(true);
    setErrorMsg('');
    try {
      // 1. Upsert. Sending status='pending' on every row means
      //    impacted accepted rows automatically lose their accepted
      //    status — staff will be re-prompted on their next sign-in.
      //
      // IMPORTANT: directPost only sends `Prefer: resolution=merge-
      // duplicates` when options.upsert is true. Passing it via
      // `headers` is silently ignored — the helper builds its own
      // Prefer header. Using the proper { upsert, onConflict } flags
      // is what actually triggers the upsert path; without them the
      // POST falls back to plain INSERT and conflicts fail with 23505.
      if (rows.length > 0) {
        await directPost(
          'employee_shifts',
          rows,
          {
            upsert: true,
            onConflict: 'employee_id,shift_date',
            timeoutMs: 30000,
          }
        );
      }

      // 2. Clear acknowledgment fields on the impacted rows so the
      //    staff-side modal treats them as fresh shifts. We use the
      //    bulk patch query helper. Best-effort — failure here just
      //    means the audit fields are stale; the status flip in step
      //    1 already drives the re-acknowledgment flow.
      if (impactedAccepted.some(i => i.kind === 'time-changed')) {
        const dates = impactedAccepted
          .filter(i => i.kind === 'time-changed')
          .map(i => i.date);
        if (dates.length > 0) {
          const inList = dates.map(d => encodeURIComponent(d)).join(',');
          const filter =
            `employee_id=eq.${encodeURIComponent(rows[0]?.employee_id || employeeId)}` +
            `&shift_date=in.(${inList})`;
          try {
            await directPatchQuery(
              'employee_shifts',
              filter,
              { accepted_at: null, declined_at: null, decline_reason: null, notified_hr_at: null },
              { timeoutMs: 10000 }
            );
          } catch (e) {
            console.warn('Acknowledgment-clear failed (non-fatal):', e?.message || e);
          }
        }
      }

      // 3. Bulk delete unchecked-day rows.
      if (datesToDelete.length > 0) {
        const inList = datesToDelete.map(d => encodeURIComponent(d)).join(',');
        const filter =
          `employee_id=eq.${encodeURIComponent(employeeId)}` +
          `&shift_date=in.(${inList})`;
        try {
          await directDelete('employee_shifts', filter, { timeoutMs: 12000 });
        } catch (e) {
          console.warn('shift bulk delete failed (non-fatal):', e?.message || e);
        }
      }

      // 4. Upsert tracker. Bump edit_count on subsequent saves; the
      //    first save (when no last_committed_at yet) keeps it at 0.
      //    Same upsert API fix as above — must pass upsert:true +
      //    onConflict, not raw headers.
      //
      //    Tracker is keyed by (manager_id, employee_id, plan_month).
      //    Without employee_id, switching the dropdown from staff A
      //    to staff B would return A's tracker row and wrongly lock
      //    the form for B (the previous design's bug).
      const isFirstSave = !lastCommittedAt;
      const newEditCount = isFirstSave ? 0 : Math.min(editCount + 1, MAX_EDITS);
      await directPost(
        'monthly_shift_plans',
        [{
          manager_id:        me.id,
          employee_id:       employeeId,
          plan_month:        fromKey,
          shifts_count:      rows.length,
          last_committed_at: new Date().toISOString(),
          last_committed_by: me.id,
          edit_count:        newEditCount,
          off_weekdays:      offWeekdays,
        }],
        {
          upsert: true,
          onConflict: 'manager_id,employee_id,plan_month',
          timeoutMs: 8000,
        }
      );

      const empName = myReports.find(r => r.id === employeeId)?.name || 'employee';
      const editsLeft = MAX_EDITS - newEditCount;
      const editsLine = isFirstSave
        ? `Click "Edit schedule" if you need to make changes — up to ${MAX_EDITS} edits allowed per month.`
        : (editsLeft > 0
            ? `${editsLeft} ${editsLeft === 1 ? 'edit' : 'edits'} remaining for this month.`
            : `You've used all ${MAX_EDITS} allowed edits for this month. Further changes need HR.`);
      const acknowledgmentLine = impactedAccepted.length > 0
        ? ` ${impactedAccepted.length} previously-accepted ${impactedAccepted.length === 1 ? 'shift was' : 'shifts were'} reset and will need re-confirmation.`
        : ' Staff will be asked to acknowledge each shift on their next sign-in.';

      setSavedToast({
        title: isFirstSave ? 'Shift plan saved' : 'Shift plan updated',
        body: `${rows.length} ${rows.length === 1 ? 'shift' : 'shifts'} saved for ${empName} for ${monthLabel(monthSel.year, monthSel.monthIdx)}.${acknowledgmentLine} ${editsLine}`,
      });
      setLastCommittedAt(new Date().toISOString());
      setEditCount(newEditCount);
      setEditMode('locked');
      setPendingConfirm(null);
    } catch (e) {
      console.error('Plan save failed:', e);
      setErrorMsg(e?.message || 'Could not save the plan. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  // ─── Edit handler ──────────────────────────────────────────────────
  // Manager clicks "Edit schedule" to re-enable Save. Refused if the
  // edit cap has been hit.
  function startEditing() {
    if (editCount >= MAX_EDITS) {
      setErrorMsg(`You've reached the limit of ${MAX_EDITS} edits for this month. Contact HR to make further changes.`);
      return;
    }
    setEditMode('editing');
    setErrorMsg('');
  }

  // ─── Empty state ────────────────────────────────────────────────────
  if (!myReports.length) {
    return (
      <Card title="Monthly Shift Planner" subtitle="Plan shifts for your direct reports">
        <p className="text-sm" style={{ color: '#1F1B16' }}>
          You don't have any direct reports configured. Ask Bashaier or Nadeem to assign team
          members to you in Settings → Manager assignments.
        </p>
      </Card>
    );
  }

  const selectedEmployee = myReports.find(r => r.id === employeeId);

  // ─── Render ─────────────────────────────────────────────────────────
  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><CalIcon className="w-4 h-4 opacity-70" /> Monthly Shift Planner</span>}
      subtitle="Pick an employee, pick a month, save the whole month in one shot"
    >
      {/* Employee + month selector row */}
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 mb-3">
        <label className="block">
          <span className="text-[11px] tracking-wider" style={{ color: '#0A0A0A', fontWeight: 600 }}>
            EMPLOYEE
          </span>
          <select
            value={employeeId || ''}
            onChange={e => setEmployeeId(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--paper)', color: '#0A0A0A' }}
          >
            {myReports.map(r => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.id})
              </option>
            ))}
          </select>
        </label>
        <div>
          <span className="text-[11px] tracking-wider" style={{ color: '#0A0A0A', fontWeight: 600 }}>
            MONTH
          </span>
          <div className="mt-1 inline-flex rounded-lg border" style={{ borderColor: 'var(--border)' }}>
            {monthChoices.map(m => {
              const isActive = m.year === monthSel?.year && m.monthIdx === monthSel?.monthIdx;
              return (
                <button
                  key={m.label}
                  onClick={() => { if (!m.locked) setMonthSel(m); }}
                  disabled={m.locked}
                  className="px-3 py-2 text-xs inline-flex items-center gap-1.5"
                  style={{
                    background: isActive ? 'var(--evergreen-600)' : 'transparent',
                    color: m.locked
                      ? '#A3A3A3'
                      : isActive ? '#FFFFFF' : '#0A0A0A',
                    fontWeight: isActive ? 600 : 500,
                    cursor: m.locked ? 'not-allowed' : 'pointer',
                    opacity: m.locked ? 0.6 : 1,
                  }}
                  title={m.locked
                    ? `Unlocks on ${m.unlockLabel}. Plan the current month first.`
                    : (m.isCurrent ? 'Current month' : (m.isNext ? 'Next month' : ''))
                  }
                >
                  {m.locked && <Lock className="w-3 h-3" />}
                  {m.label}
                </button>
              );
            })}
          </div>
          {/* Helper line — only show when at least one tab is locked,
              so it doesn't add chrome when both are unlocked. */}
          {monthChoices.some(m => m.locked) && (
            <div className="text-[10px] mt-1" style={{ color: '#0A0A0A', opacity: 0.6, maxWidth: 320 }}>
              Future months unlock on the 25th of the month before, so you finish the current month first.
            </div>
          )}
        </div>
      </div>

      {/* Plan summary banner */}
      <div className="rounded-lg border p-3 mb-3" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper-2)' }}>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-[10px] tracking-[0.2em]" style={{ color: '#0F4C2A', fontWeight: 700 }}>
              PLAN
            </div>
            <div className="text-sm mt-0.5" style={{ color: '#0A0A0A' }}>
              {selectedEmployee ? (
                <>
                  <strong>{selectedEmployee.name}</strong> · {monthSel ? monthLabel(monthSel.year, monthSel.monthIdx) : '—'}
                  {' · '}
                  <span style={{ color: selectedCount > 0 ? '#0F4C2A' : '#1F1B16', fontWeight: 600 }}>
                    {selectedCount} {selectedCount === 1 ? 'shift' : 'shifts'} selected
                  </span>
                </>
              ) : '—'}
            </div>
            {lastCommittedAt && (
              <div className="text-[11px] mt-1" style={{ color: '#0A0A0A', opacity: 0.65 }}>
                Last saved {new Date(lastCommittedAt).toLocaleString(SAR_LOCALE, { dateStyle: 'medium', timeStyle: 'short' })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Quick-pattern row */}
      <div className="flex flex-wrap gap-2 mb-3">
        <PatternBtn label="Every Sun–Thu"   onClick={() => applyPattern('sun-thu')}  primary />
        <PatternBtn label="Mon–Fri"          onClick={() => applyPattern('mon-fri')} />
        <PatternBtn label="Saturdays only"   onClick={() => applyPattern('sat-only')} />
        <PatternBtn label="Sundays only"     onClick={() => applyPattern('sun-only')} />
        <PatternBtn label="Mondays only"     onClick={() => applyPattern('mon-only')} />
        <PatternBtn label="Tuesdays only"    onClick={() => applyPattern('tue-only')} />
        <PatternBtn label="Wednesdays only"  onClick={() => applyPattern('wed-only')} />
        <PatternBtn label="Thursdays only"   onClick={() => applyPattern('thu-only')} />
        <PatternBtn label="Clear all"        onClick={() => applyPattern('clear')} dim />
      </div>

      {/* Time row */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <label className="block">
          <span className="text-[11px] tracking-wider" style={{ color: '#0A0A0A', fontWeight: 600 }}>
            SHIFT START
          </span>
          <select
            value={start}
            onChange={e => setStart(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--paper)', color: '#0A0A0A' }}
          >
            {HOUR_OPTIONS.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] tracking-wider" style={{ color: '#0A0A0A', fontWeight: 600 }}>
            SHIFT END
          </span>
          <select
            value={end}
            onChange={e => setEnd(e.target.value)}
            className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--paper)', color: '#0A0A0A' }}
          >
            {HOUR_OPTIONS.map(h => <option key={h} value={h}>{h}</option>)}
          </select>
        </label>
      </div>

      {/* Overnight notice — calls out the wrap-around when end <= start. */}
      {isOvernight && (
        <div className="rounded-lg p-2.5 mb-3 inline-flex items-center gap-2" style={{ background: '#EEF0FA', color: '#3B4279', fontSize: 12 }}>
          <Moon className="w-3.5 h-3.5" />
          Overnight shift — ends at {end} the next morning
        </div>
      )}

      {/* Weekly off-day picker. The manager toggles which weekdays
          are explicitly off for this employee — e.g. FAHAD has
          Sunday + Friday off. Toggled days render gray with an
          "OFF" label in the calendar. Working shifts override the
          off-pattern (a date with a working shift always shows as
          working, even if its weekday is in the off-pattern). */}
      <div className="mb-3">
        <span className="text-[11px] tracking-wider" style={{ color: '#0A0A0A', fontWeight: 600 }}>
          WEEKLY OFF-DAYS <span className="ml-1" style={{ opacity: 0.6, letterSpacing: 'normal', textTransform: 'none' }}>(optional)</span>
        </span>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {DOW_LONG.map((label, dow) => {
            const isOff = offWeekdaysSet.has(dow);
            return (
              <button
                key={label}
                onClick={() => toggleOffWeekday(dow)}
                className="text-[11px] px-3 py-1.5 rounded-full inline-flex items-center gap-1"
                style={{
                  background: isOff ? '#F5F5F5'   : 'var(--paper-2)',
                  color:      isOff ? '#525252'   : '#0A0A0A',
                  border:     '1px solid ' + (isOff ? '#A3A3A3' : 'var(--border)'),
                  fontWeight: isOff ? 600 : 500,
                  cursor: 'pointer',
                }}
                aria-pressed={isOff}
                title={isOff
                  ? `Click to remove ${label} from the off-day pattern`
                  : `Click to mark every ${label} as off-day`
                }
              >
                {isOff && <span style={{ fontSize: 10, opacity: 0.7 }}>OFF</span>}
                {label}
              </button>
            );
          })}
        </div>
        <div className="text-[10px] mt-1.5" style={{ color: '#0A0A0A', opacity: 0.6, maxWidth: 360 }}>
          Days marked OFF appear gray in the calendar. Working shifts override the pattern, so you can still assign a one-off shift on an off-day if needed.
        </div>
      </div>

      {/* Calendar grid */}
      {planLoading ? (
        <div className="flex items-center gap-2 text-sm py-6 justify-center" style={{ color: '#0A0A0A', opacity: 0.6 }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading plan…
        </div>
      ) : (
        <CalendarGrid
          monthDays={monthDays}
          plan={plan}
          offWeekdaysSet={offWeekdaysSet}
          onToggle={toggleDay}
        />
      )}

      {/* Save row — has two buttons that swap visibility based on
          editMode:
            • editing: Save enabled (if there's something to save)
            • locked:  Save greyed out, "Edit schedule" appears next
                       to it. Edit is enabled until the 3-edit cap
                       is hit; after that it greys out too with a
                       tooltip explaining HR is needed for further
                       changes. */}
      <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7, maxWidth: 360 }}>
          Past dates can't be edited. Saved shifts go to the staff member for acknowledgment.
          {lastCommittedAt && editCount > 0 && (
            <> · <strong>{Math.max(0, MAX_EDITS - editCount)}</strong> of <strong>{MAX_EDITS}</strong> edits remaining</>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Edit schedule — only visible AFTER an initial save and
              while the form is locked. Disabled if cap reached. */}
          {lastCommittedAt && editMode === 'locked' && (
            <button
              onClick={startEditing}
              disabled={editCount >= MAX_EDITS}
              className="rounded-lg inline-flex items-center gap-2 px-4 py-2 text-sm"
              style={{
                background: 'transparent',
                color: editCount >= MAX_EDITS ? '#A3A3A3' : '#0F4C2A',
                border: '1px solid ' + (editCount >= MAX_EDITS ? 'var(--border)' : '#A7D8B7'),
                fontWeight: 500,
                cursor: editCount >= MAX_EDITS ? 'not-allowed' : 'pointer',
                opacity: editCount >= MAX_EDITS ? 0.6 : 1,
              }}
              title={editCount >= MAX_EDITS
                ? `Edit limit reached (${MAX_EDITS} edits used). Contact HR for further changes.`
                : 'Click to make changes to this saved plan'
              }
            >
              {editCount >= MAX_EDITS ? <Lock className="w-4 h-4" /> : null}
              Edit schedule
            </button>
          )}

          <button
            onClick={prepareSave}
            disabled={saving || planLoading || selectedCount === 0 || editMode === 'locked'}
            className="rounded-lg inline-flex items-center gap-2 px-4 py-2 text-sm"
            style={{
              background: 'var(--evergreen-600)',
              color: '#FFFFFF',
              fontWeight: 600,
              cursor: (saving || planLoading || selectedCount === 0 || editMode === 'locked') ? 'not-allowed' : 'pointer',
              opacity: (saving || planLoading || selectedCount === 0 || editMode === 'locked') ? 0.5 : 1,
            }}
            title={editMode === 'locked'
              ? 'Plan is saved. Click "Edit schedule" to make changes.'
              : 'Save the plan'
            }
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {lastCommittedAt
              ? (editMode === 'locked' ? 'Saved' : 'Save changes')
              : `Save ${selectedCount > 0 ? `${selectedCount} ${selectedCount === 1 ? 'shift' : 'shifts'}` : 'plan'}`
            }
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-lg p-3 text-xs mt-3" style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}>
          {errorMsg}
        </div>
      )}

      {/* Confirmation toast — small in-card success banner.
          Auto-dismisses after 6s. */}
      {savedToast && (
        <SaveConfirmation toast={savedToast} onDismiss={() => setSavedToast(null)} />
      )}

      {/* Per-day editor popover — opens when the manager taps an
          already-selected day. Lets them change just that day's
          time, reset to the bulk time, or remove the day from the
          plan. Does NOT touch any other day. */}
      {dayPopover && (
        <DayEditPopover
          dateKey={dayPopover.dateKey}
          draftStart={dayPopover.draftStart}
          draftEnd={dayPopover.draftEnd}
          bulkStart={start}
          bulkEnd={end}
          isCustomized={Boolean(plan[dayPopover.dateKey]?.customized)}
          onChangeDraft={(s, e) => setDayPopover({ ...dayPopover, draftStart: s, draftEnd: e })}
          onSave={(s, e) => setDayTimes(dayPopover.dateKey, s, e)}
          onResetToBulk={() => resetDayToBulk(dayPopover.dateKey)}
          onRemove={() => removeDay(dayPopover.dateKey)}
          onClose={() => setDayPopover(null)}
        />
      )}

      {/* Acknowledgment-impact confirmation — surfaces when the
          manager's edit would invalidate already-accepted shifts.
          Lists the impacted dates and asks for confirmation before
          re-pending. */}
      {pendingConfirm && (
        <AcknowledgmentImpactDialog
          impacted={pendingConfirm.impactedAccepted}
          onCancel={() => { setPendingConfirm(null); setSaving(false); }}
          onConfirm={() => executeSave(pendingConfirm)}
        />
      )}
    </Card>
  );
}

// ─── Calendar grid ────────────────────────────────────────────────────
function CalendarGrid({ monthDays, plan, offWeekdaysSet, onToggle }) {
  if (!monthDays.length) return null;
  // Padding cells before day 1 (so day 1 sits in the right column)
  const firstDow = monthDays[0].dow;
  const todayK = todayKey();
  const offSet = offWeekdaysSet || new Set();

  return (
    <div>
      {/* Header — weekday labels Sun-Sat */}
      <div className="grid grid-cols-7 gap-1 mb-1">
        {DOW_LONG.map((d, i) => (
          <div
            key={d}
            className="text-[10px] tracking-wider text-center py-1"
            style={{
              color: '#0A0A0A',
              fontWeight: 700,
              background: (i === 5 || i === 6) ? '#FAF5EE' : 'transparent', // weekend tint
              borderRadius: 4,
            }}
          >
            {d}
          </div>
        ))}
      </div>

      {/* Day cells */}
      <div className="grid grid-cols-7 gap-1">
        {/* Pad before day 1 */}
        {Array.from({ length: firstDow }).map((_, i) => (
          <div key={`pad-${i}`} />
        ))}
        {monthDays.map(d => {
          const cell = plan[d.key] || { selected: false };
          const isPast = d.key < todayK;
          const isToday = d.key === todayK;
          const isWeekend = d.dow === 5 || d.dow === 6;
          // Off-day pattern: this weekday is in the off-set AND no
          // working shift is assigned. Working shifts always win
          // visually — manager assigning a Friday cover for FAHAD
          // shows green even though Fridays are normally OFF.
          const isOffPattern = offSet.has(d.dow) && !cell.selected;
          return (
            <button
              key={d.key}
              onClick={() => onToggle(d.key)}
              disabled={isPast}
              className="relative rounded-md p-2 text-center transition-all"
              style={{
                background: isPast
                  ? '#F5F5F5'
                  : cell.selected
                    ? 'var(--evergreen-600)'
                    : isOffPattern
                      ? '#EAEAE6'
                      : isWeekend ? '#FAF5EE' : 'var(--paper)',
                color: isPast
                  ? '#A3A3A3'
                  : cell.selected
                    ? '#FFFFFF'
                    : isOffPattern
                      ? '#525252'
                      : '#0A0A0A',
                border: '1px solid ' + (
                  isPast
                    ? '#E5E5E5'
                    : cell.selected
                      ? 'var(--evergreen-600)'
                      : isOffPattern
                        ? '#A3A3A3'
                        : isToday ? '#0F4C2A' : 'var(--border)'
                ),
                cursor: isPast ? 'not-allowed' : 'pointer',
                fontSize: 13,
                fontWeight: cell.selected ? 600 : 500,
                minHeight: 48,
              }}
              title={
                isPast
                  ? 'Past date — locked'
                  : cell.selected
                    ? (cell.customized
                        ? 'Custom time set for this day — tap to edit'
                        : 'Tap to edit time, reset, or remove')
                    : isOffPattern
                      ? 'Marked as off per the weekly pattern — tap to assign a shift anyway'
                      : 'Tap to add'
              }
            >
              <div>{d.date}</div>
              {cell.selected && (
                <div
                  className="text-[9px] mt-0.5"
                  style={{
                    opacity: 0.85,
                    fontStyle: cell.customized ? 'italic' : 'normal',
                  }}
                >
                  {/* Bullet prefix on customized days. Visible on both
                      light + green (selected) backgrounds. */}
                  {cell.customized ? '• ' : ''}
                  {cell.start}–{cell.end}
                </div>
              )}
              {/* Off-pattern label — small subtle "OFF" text under
                  the date number so the manager can confirm the
                  pattern at a glance without needing the legend. */}
              {!cell.selected && isOffPattern && !isPast && (
                <div
                  className="text-[8.5px] mt-0.5 tracking-wider"
                  style={{ opacity: 0.7, fontWeight: 700, letterSpacing: '0.1em' }}
                >
                  OFF
                </div>
              )}
              {isPast && (
                <Lock className="w-2.5 h-2.5 absolute top-1 right-1 opacity-60" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Pattern button ───────────────────────────────────────────────────
function PatternBtn({ label, onClick, primary, dim }) {
  return (
    <button
      onClick={onClick}
      className="text-[11px] px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
      style={{
        background: primary ? '#ECFDF3' : (dim ? 'transparent' : 'var(--paper-2)'),
        color: primary ? '#0F4C2A' : (dim ? '#525252' : '#0A0A0A'),
        border: '1px solid ' + (primary ? '#A7D8B7' : 'var(--border)'),
        fontWeight: primary ? 600 : 500,
        cursor: 'pointer',
      }}
    >
      <Sparkles className="w-3 h-3" />
      {label}
    </button>
  );
}

// ─── Save confirmation toast ──────────────────────────────────────────
function SaveConfirmation({ toast, onDismiss }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-lg p-3 mt-3 flex items-start gap-3"
      style={{
        background: '#ECFDF3',
        border: '1.5px solid #0F4C2A',
        boxShadow: '0 2px 10px rgba(15, 76, 42, 0.12)',
      }}
    >
      <CheckCircle2 className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#0F4C2A' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="text-[11px] tracking-wider" style={{ color: '#0F4C2A', fontWeight: 700 }}>
          {toast.title.toUpperCase()}
        </div>
        <div className="text-sm mt-0.5" style={{ color: '#0A0A0A', lineHeight: 1.5 }}>
          {toast.body}
        </div>
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="flex-shrink-0 p-1 rounded"
        style={{ background: 'transparent', color: '#0F4C2A', border: 'none', cursor: 'pointer' }}
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

// ─── Day edit popover ─────────────────────────────────────────────────
// Modal overlay that appears when a manager taps an already-selected
// day. Three actions:
//   • Save (with edited start/end) — saves a per-day override
//   • Reset to bulk time          — clears any custom time, day
//                                    re-tracks the bulk dropdowns
//   • Remove from plan            — unchecks the day entirely
//
// Closes on Escape, click outside, or X button.
function DayEditPopover({
  dateKey, draftStart, draftEnd, bulkStart, bulkEnd, isCustomized,
  onChangeDraft, onSave, onResetToBulk, onRemove, onClose,
}) {
  // Lock body scroll while open + Escape-to-close.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const dt = (() => {
    const [y, m, d] = dateKey.split('-').map(n => parseInt(n, 10));
    return new Date(y, m - 1, d);
  })();
  const dayLabel = dt.toLocaleDateString(SAR_LOCALE, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // Detect "no real change" so the Save button can read "Save changes"
  // vs grey out / no-op when the manager hasn't edited.
  const isNoChange = draftStart === bulkStart && draftEnd === bulkEnd && !isCustomized;
  const draftIsOvernight = parseInt(draftEnd.slice(0, 2), 10) <= parseInt(draftStart.slice(0, 2), 10);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Edit shift for ${dayLabel}`}
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 420,
          background: '#FFFFFF',
          borderRadius: 12,
          padding: '20px 22px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.20)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 4 }}>
          <div style={{ fontSize: 11, letterSpacing: '0.18em', fontWeight: 700, color: '#0F4C2A' }}>
            EDIT SHIFT FOR THIS DAY
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              color: '#0A0A0A',
              border: '1px solid var(--border)',
              padding: 6,
              cursor: 'pointer',
              borderRadius: 6,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        <div style={{ fontSize: 16, fontWeight: 600, color: '#0A0A0A', marginBottom: 4 }}>
          {dayLabel}
        </div>
        <div style={{ fontSize: 12, color: '#0A0A0A', opacity: 0.7, marginBottom: 14 }}>
          Bulk time is currently {bulkStart}–{bulkEnd}.
          {isCustomized && ' This day has a custom time set.'}
        </div>

        {/* Per-day time editors */}
        <div className="grid grid-cols-2 gap-3 mb-3">
          <label className="block">
            <span className="text-[11px] tracking-wider" style={{ color: '#0A0A0A', fontWeight: 600 }}>
              START
            </span>
            <select
              value={draftStart}
              onChange={e => onChangeDraft(e.target.value, draftEnd)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--paper)', color: '#0A0A0A' }}
            >
              {HOUR_OPTIONS.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] tracking-wider" style={{ color: '#0A0A0A', fontWeight: 600 }}>
              END
            </span>
            <select
              value={draftEnd}
              onChange={e => onChangeDraft(draftStart, e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--border)', background: 'var(--paper)', color: '#0A0A0A' }}
            >
              {HOUR_OPTIONS.map(h => <option key={h} value={h}>{h}</option>)}
            </select>
          </label>
        </div>

        {draftIsOvernight && (
          <div className="rounded-lg p-2 mb-3 inline-flex items-center gap-2" style={{ background: '#EEF0FA', color: '#3B4279', fontSize: 11 }}>
            <Moon className="w-3 h-3" />
            Overnight — ends at {draftEnd} the next morning
          </div>
        )}

        {/* Action row — primary save on the right, destructive remove
            on the left. Reset-to-bulk only shown when relevant. */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          <button
            onClick={onRemove}
            className="text-xs px-3 py-2 rounded-lg inline-flex items-center gap-1.5"
            style={{
              background: 'transparent',
              color: '#991B1B',
              border: '1px solid #FCA5A5',
              fontWeight: 500,
              cursor: 'pointer',
            }}
            title="Remove this day from the plan"
          >
            <X className="w-3 h-3" />
            Remove day
          </button>
          {isCustomized && (
            <button
              onClick={onResetToBulk}
              className="text-xs px-3 py-2 rounded-lg inline-flex items-center gap-1.5"
              style={{
                background: 'transparent',
                color: '#0A0A0A',
                border: '1px solid var(--border)',
                fontWeight: 500,
                cursor: 'pointer',
              }}
              title="Snap this day back to the bulk time"
            >
              Reset to bulk
            </button>
          )}
          <button
            onClick={() => onSave(draftStart, draftEnd)}
            disabled={isNoChange}
            className="text-xs px-3 py-2 rounded-lg inline-flex items-center gap-1.5 ml-auto"
            style={{
              background: 'var(--evergreen-600)',
              color: '#FFFFFF',
              border: '1px solid var(--evergreen-600)',
              fontWeight: 600,
              cursor: isNoChange ? 'not-allowed' : 'pointer',
              opacity: isNoChange ? 0.5 : 1,
            }}
            title={isNoChange ? 'No changes to save' : 'Save this day\'s time'}
          >
            <Save className="w-3 h-3" />
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Acknowledgment-impact confirmation dialog ────────────────────────
// Shown when a manager's edit would invalidate already-accepted
// shifts. Lists the impacted shifts (date + nature of change) and
// asks for explicit confirmation before re-pending. Without this
// step, staff acknowledgments could silently become stale (KHALID
// agreed to 11:00–20:00 but the row now says 11:00–14:00 with no
// re-acknowledgment).
//
// On Confirm: parent runs executeSave which clears the acceptance
// fields and flips status back to pending. Staff see the changed
// shifts in their queue on next sign-in.
//
// On Cancel: parent resets pendingConfirm + saving; nothing is
// written.
function AcknowledgmentImpactDialog({ impacted, onCancel, onConfirm }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(e) { if (e.key === 'Escape') onCancel?.(); }
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  // Format an impacted item into a human-readable line. Pulls
  // weekday + day + month from the date for context.
  function fmtRow(item) {
    const [y, m, d] = item.date.split('-').map(n => parseInt(n, 10));
    const dt = new Date(y, m - 1, d);
    const day = dt.toLocaleDateString(SAR_LOCALE, {
      weekday: 'short', day: 'numeric', month: 'short',
    });
    if (item.kind === 'removed') {
      return `${day} — was ${item.oldStart}–${item.oldEnd}, now removed`;
    }
    return `${day} — was ${item.oldStart}–${item.oldEnd}, now ${item.newStart}–${item.newEnd}`;
  }

  const count = impacted.length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm changes to accepted shifts"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 65,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: '40px 16px',
        overflowY: 'auto',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 480,
          background: '#FFFFFF',
          borderRadius: 12,
          padding: '20px 22px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.20)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <div
            style={{
              flexShrink: 0,
              width: 32,
              height: 32,
              borderRadius: '50%',
              background: '#FEF6E2',
              color: '#854F0B',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Sparkles className="w-4 h-4" />
          </div>
          <div style={{ fontSize: 11, letterSpacing: '0.18em', fontWeight: 700, color: '#854F0B' }}>
            CHANGES WILL RESET ACCEPTANCES
          </div>
        </div>

        <h2 style={{ fontSize: 16, fontWeight: 600, color: '#0A0A0A', margin: '0 0 8px' }}>
          {count} previously-accepted {count === 1 ? 'shift' : 'shifts'} will need re-confirmation
        </h2>

        <p style={{ fontSize: 13, color: '#0A0A0A', opacity: 0.75, lineHeight: 1.5, margin: '0 0 12px' }}>
          The staff member already accepted {count === 1 ? 'this shift' : 'these shifts'}, but your changes
          mean they need to confirm again. Their previous acceptance will be cleared and the shift will
          go back to pending in their queue.
        </p>

        <div
          style={{
            background: 'var(--paper-2)',
            border: '1px solid var(--border-soft)',
            borderRadius: 8,
            padding: '10px 12px',
            marginBottom: 14,
            maxHeight: 200,
            overflowY: 'auto',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', color: '#0A0A0A', marginBottom: 6 }}>
            IMPACTED SHIFTS
          </div>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {impacted.map(item => (
              <li
                key={item.date}
                style={{
                  fontSize: 12,
                  color: '#0A0A0A',
                  padding: '4px 0',
                  borderBottom: '1px dashed var(--border-soft)',
                }}
              >
                {fmtRow(item)}
              </li>
            ))}
          </ul>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            onClick={onCancel}
            className="text-sm px-4 py-2 rounded-lg"
            style={{
              background: 'transparent',
              color: '#0A0A0A',
              border: '1px solid var(--border)',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="text-sm px-4 py-2 rounded-lg inline-flex items-center gap-2"
            style={{
              background: '#854F0B',
              color: '#FFFFFF',
              border: '1px solid #854F0B',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            <CheckCircle2 className="w-4 h-4" />
            Confirm and save
          </button>
        </div>
      </div>
    </div>
  );
}
