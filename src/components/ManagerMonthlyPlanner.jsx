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
// Always: current month (manager might still be planning current
// month early in the period), next month (the default), and month-
// after-next (early planners). Three buttons total.
function buildMonthChoices() {
  const now = new Date();
  return [0, 1, 2].map(offset => {
    const d = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    return {
      year: d.getFullYear(),
      monthIdx: d.getMonth(),
      label: d.toLocaleDateString(SAR_LOCALE, { month: 'short', year: 'numeric' }),
      isCurrent: offset === 0,
      isNext: offset === 1,
    };
  });
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
  // Default to NEXT month — the most common case for planning ahead.
  const [monthSel, setMonthSel] = useState(monthChoices[1]);

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
        const wantSelected = matchesPattern(name, d);
        if (name === 'clear') {
          next[d.key] = { ...next[d.key], selected: false };
        } else {
          next[d.key] = {
            ...next[d.key],
            selected: wantSelected ? true : next[d.key]?.selected || false,
            start, end,
          };
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

  function toggleDay(dateKey) {
    if (dateKey < todayKey()) return; // locked
    setPlan(prev => {
      const cur = prev[dateKey] || { selected: false, start, end };
      return {
        ...prev,
        [dateKey]: { ...cur, selected: !cur.selected, start, end },
      };
    });
  }

  // When the bulk start/end changes, retroactively apply to all
  // currently-selected days so the "one time, all days" mental model
  // holds. Days that were given a per-day override stay where they
  // were if we ever support that — for now they all track the bulk.
  useEffect(() => {
    setPlan(prev => {
      const next = { ...prev };
      let changed = false;
      for (const k of Object.keys(next)) {
        if (next[k]?.selected) {
          if (next[k].start !== start || next[k].end !== end) {
            next[k] = { ...next[k], start, end };
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
      if (rows.length > 0) {
        await directPost(
          'employee_shifts?on_conflict=employee_id,shift_date',
          rows,
          {
            headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
            timeoutMs: 12000,
          }
        );
      }

      // Delete rows for days that are NOT selected (manager unchecked
      // a previously-saved day). Scoped to this employee + this month
      // + future-or-today only (past rows are preserved as history).
      const keepKeys = new Set(rows.map(r => r.shift_date));
      // Find existing rows in the window we should delete.
      const existing = await directGet(
        'employee_shifts',
        `select=id,shift_date` +
        `&employee_id=eq.${encodeURIComponent(employeeId)}` +
        `&shift_date=gte.${todayK > fromKey ? todayK : fromKey}` +
        `&shift_date=lte.${toKey}`,
        { timeoutMs: 8000 }
      );
      const toDelete = (existing || []).filter(r => !keepKeys.has(r.shift_date));
      // Delete in parallel (one HTTP call per row — small N, fine).
      // Per-row catch so one failed delete doesn't kill the whole save.
      await Promise.all(
        toDelete.map(r =>
          directDelete('employee_shifts', 'id', r.id, { timeoutMs: 6000 })
            .catch(e => console.warn('shift delete failed (non-fatal):', e?.message || e))
        )
      );

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
                  onClick={() => setMonthSel(m)}
                  className="px-3 py-2 text-xs"
                  style={{
                    background: isActive ? 'var(--evergreen-600)' : 'transparent',
                    color: isActive ? '#FFFFFF' : '#0A0A0A',
                    fontWeight: isActive ? 600 : 500,
                  }}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
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
              title={isPast ? 'Past date — locked' : (cell.selected ? 'Tap to remove' : 'Tap to add')}
            >
              <div>{d.date}</div>
              {cell.selected && (
                <div className="text-[9px] mt-0.5" style={{ opacity: 0.85 }}>
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
