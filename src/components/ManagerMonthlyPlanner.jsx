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
import { directGet, directPost, directDelete, supabase } from '../supabaseClient.js';
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

  // Once on mount, check whether THIS manager has already committed
  // the current month's plan. If yes, AND next month is unlocked,
  // flip the default selection from current to next so the manager
  // lands on the more relevant tab. We only flip ONCE — if the
  // manager later clicks the current tab manually we don't bounce
  // them back.
  useEffect(() => {
    if (!me?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const cur = monthChoices[0];
        const planKey = ymd(startOfMonth(cur.year, cur.monthIdx));
        const rows = await directGet(
          'monthly_shift_plans',
          `select=last_committed_at` +
          `&manager_id=eq.${encodeURIComponent(me.id)}` +
          `&plan_month=eq.${planKey}` +
          `&limit=1`,
          { timeoutMs: 6000 }
        );
        if (cancelled) return;
        const committed = Boolean(rows?.[0]?.last_committed_at);
        setCurrentMonthCommitted(committed);
        // Refine the default: only flip to next if current is
        // committed AND next is unlocked AND we're still showing
        // the initial default (haven't navigated yet).
        const nxt = monthChoices[1];
        if (committed && nxt && !nxt.locked) {
          setMonthSel(prev => (prev?.monthIdx === cur.monthIdx ? nxt : prev));
        }
      } catch {
        if (!cancelled) setCurrentMonthCommitted(false);
      }
    })();
    return () => { cancelled = true; };
    // monthChoices is a stable useMemo result; me.id is the only
    // real dependency. We don't include monthChoices to avoid re-
    // running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.id]);

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

      // Fetch last-committed-at for this (manager, month) so we can
      // show a "last saved Tuesday at 3:42 PM" affordance.
      try {
        const planKey = ymd(startOfMonth(monthSel.year, monthSel.monthIdx));
        const planRows = await directGet(
          'monthly_shift_plans',
          `select=last_committed_at,shifts_count` +
          `&manager_id=eq.${encodeURIComponent(me.id)}` +
          `&plan_month=eq.${planKey}` +
          `&limit=1`,
          { timeoutMs: 6000 }
        );
        const r = Array.isArray(planRows) ? planRows[0] : null;
        setLastCommittedAt(r?.last_committed_at || null);
      } catch {
        setLastCommittedAt(null);
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

  // ─── Save ──────────────────────────────────────────────────────────
  async function save() {
    if (!employeeId || !monthSel || saving) return;
    // Defense-in-depth: even if the segmented control somehow let
    // a locked month through, refuse the save here. The dropdown
    // is the primary gate; this is the belt-and-braces backup.
    if (monthSel.locked) {
      setErrorMsg(`That month doesn't unlock until ${monthSel.unlockLabel}. Please plan the current month first.`);
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

      // Upsert — on conflict do update via PostgREST's resolution=
      // merge-duplicates header, scoped to (employee_id, shift_date).
      // 30s timeout because a 30-day month with 6 reports could
      // brush against the default on a slow connection — the upsert
      // itself is one round trip but PostgREST's MERGE path is
      // slower than a plain INSERT.
      if (rows.length > 0) {
        await directPost(
          'employee_shifts?on_conflict=employee_id,shift_date',
          rows,
          {
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            timeoutMs: 30000,
          }
        );
      }

      // Delete rows for days that are NOT selected (manager unchecked
      // a previously-saved day). One bulk DELETE-by-filter call instead
      // of fetching-then-deleting-each-row. PostgREST accepts
      // `shift_date=in.(d1,d2,...)` for set-membership filters.
      const keepKeys = new Set(rows.map(r => r.shift_date));
      // Find existing rows in the window so we know what to remove.
      const existing = await directGet(
        'employee_shifts',
        `select=shift_date` +
        `&employee_id=eq.${encodeURIComponent(employeeId)}` +
        `&shift_date=gte.${todayK > fromKey ? todayK : fromKey}` +
        `&shift_date=lte.${toKey}`,
        { timeoutMs: 12000 }
      );
      const datesToDelete = (existing || [])
        .map(r => r.shift_date)
        .filter(d => !keepKeys.has(d));

      if (datesToDelete.length > 0) {
        // Single bulk delete — PostgREST's `in.(...)` filter takes a
        // comma-separated list and deletes everything matching it
        // plus the employee_id scope, in one round trip. Way faster
        // than the previous one-call-per-row approach and avoids
        // the malformed-URL bug that hung on a wrong directDelete
        // signature.
        const inList = datesToDelete.map(d => encodeURIComponent(d)).join(',');
        const filter =
          `employee_id=eq.${encodeURIComponent(employeeId)}` +
          `&shift_date=in.(${inList})`;
        try {
          await directDelete('employee_shifts', filter, { timeoutMs: 12000 });
        } catch (e) {
          // Non-fatal — surface to console but don't block the save.
          // Worst case: the unchecked-but-not-deleted rows linger;
          // the manager re-saves and they get cleaned up next time.
          console.warn('shift bulk delete failed (non-fatal):', e?.message || e);
        }
      }

      // Upsert the monthly_shift_plans tracker row so the reminder
      // system knows this month is done. Same on-conflict pattern.
      await directPost(
        'monthly_shift_plans?on_conflict=manager_id,plan_month',
        [{
          manager_id:        me.id,
          plan_month:        fromKey,
          shifts_count:      rows.length,
          last_committed_at: new Date().toISOString(),
          last_committed_by: me.id,
        }],
        {
          headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
          timeoutMs: 8000,
        }
      );

      // Toast — SuccessToast pattern (we'll set our own state and
      // render inline since the rest of the dashboard mounts only
      // a small subset of toasts).
      const empName = myReports.find(r => r.id === employeeId)?.name || 'employee';
      setSavedToast({
        title: 'Shift plan saved',
        body: `${rows.length} ${rows.length === 1 ? 'shift' : 'shifts'} saved for ${empName} for ${monthLabel(monthSel.year, monthSel.monthIdx)}. Staff will be asked to acknowledge each shift on their next sign-in.`,
      });
      setLastCommittedAt(new Date().toISOString());
    } catch (e) {
      console.error('Plan save failed:', e);
      setErrorMsg(e?.message || 'Could not save the plan. Please try again.');
    } finally {
      setSaving(false);
    }
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

      {/* Calendar grid */}
      {planLoading ? (
        <div className="flex items-center gap-2 text-sm py-6 justify-center" style={{ color: '#0A0A0A', opacity: 0.6 }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading plan…
        </div>
      ) : (
        <CalendarGrid
          monthDays={monthDays}
          plan={plan}
          onToggle={toggleDay}
        />
      )}

      {/* Save row */}
      <div className="mt-4 flex items-center justify-between gap-3 flex-wrap">
        <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          Past dates can't be edited. Saved shifts go to the staff member for acknowledgment.
        </div>
        <button
          onClick={save}
          disabled={saving || planLoading || selectedCount === 0}
          className="rounded-lg inline-flex items-center gap-2 px-4 py-2 text-sm"
          style={{
            background: 'var(--evergreen-600)',
            color: '#FFFFFF',
            fontWeight: 600,
            cursor: (saving || planLoading || selectedCount === 0) ? 'not-allowed' : 'pointer',
            opacity: (saving || planLoading || selectedCount === 0) ? 0.5 : 1,
          }}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          Save {selectedCount > 0 ? `${selectedCount} ${selectedCount === 1 ? 'shift' : 'shifts'}` : 'plan'}
        </button>
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
    </Card>
  );
}

// ─── Calendar grid ────────────────────────────────────────────────────
function CalendarGrid({ monthDays, plan, onToggle }) {
  if (!monthDays.length) return null;
  // Padding cells before day 1 (so day 1 sits in the right column)
  const firstDow = monthDays[0].dow;
  const todayK = todayKey();

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
                    : isWeekend ? '#FAF5EE' : 'var(--paper)',
                color: isPast
                  ? '#A3A3A3'
                  : cell.selected
                    ? '#FFFFFF'
                    : '#0A0A0A',
                border: '1px solid ' + (
                  isPast
                    ? '#E5E5E5'
                    : cell.selected
                      ? 'var(--evergreen-600)'
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
