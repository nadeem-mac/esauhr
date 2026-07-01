import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Card } from './Dashboard.jsx';
import { supabase, directGet, directPost, directDelete } from '../supabaseClient.js';
import { Loader2, Check, Lock, CheckCircle2, Clock } from 'lucide-react';

// ─────────────────────────────────────────────────────────────────────────────
// ManagerShiftCard
// Phase 1 of the shift-staff workflow.
//
// What it does
//   • Manager picks any of their direct reports (no shift_eligible gate — Option B).
//   • Manager navigates current week + next 3 (4 weeks total).
//   • Per-day toggle + start/end time pickers. Days rotate independently.
//   • Save writes to employee_shifts (status='pending') via upsert on
//     (employee_id, shift_date). Re-opening the same week shows what was saved.
//   • Days strictly before today are read-only (LOCKED — PAST).
//
// Schema reference (employee_shifts):
//   employee_id, shift_date, start_time, end_time, set_by, status,
//   accepted_at, declined_at, decline_reason, notified_hr_at, notes
//   UNIQUE(employee_id, shift_date)
//
// Mounted from Dashboard.jsx for any user with is_manager=true.
// ─────────────────────────────────────────────────────────────────────────────

const SMALL_TEXT = { color: '#1F1B16' };
const DOW_SHORT  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DEFAULT_START = '09:00';
const DEFAULT_END   = '17:00';
const WEEKS_AHEAD = 3; // current + next 3 → 4 total
const SAR_LOCALE = 'en-GB';
// Full hour options 00:00 – 23:00 used by the custom-hour selects in
// the time-editor panel. Hour granularity only — managers don't pick
// minutes, so the existing "HH:MM" string format stays consistent
// (always "HH:00") for storage and matchers.
const HOUR_OPTIONS = Array.from({ length: 24 }, (_, h) =>
  `${String(h).padStart(2, '0')}:00`
);

// ── Date helpers ────────────────────────────────────────────────────────────
function startOfSundayWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - x.getDay()); // ESAU: Sun=0 starts the week
  return x;
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtRange(start, end) {
  const opts = { day: 'numeric', month: 'short' };
  const s = start.toLocaleDateString(SAR_LOCALE, opts);
  const e = end.toLocaleDateString(SAR_LOCALE, { ...opts, year: 'numeric' });
  return `${s} – ${e}`;
}

function trimTime(t) {
  // Postgres time → 'HH:MM:SS' or 'HH:MM' — normalise to 'HH:00'.
  // The shift card only stores hour-granularity times now, so any
  // half-hour or minute-level rows from older data are floored to
  // the start of the hour. Keeps the select dropdowns rendering
  // cleanly (no empty value when an old row carries 09:30 etc).
  if (!t) return DEFAULT_START;
  const hh = String(t).slice(0, 2);
  return /^\d{2}$/.test(hh) ? `${hh}:00` : DEFAULT_START;
}

// ── Component ───────────────────────────────────────────────────────────────
export default function ManagerShiftCard({ me, employees }) {
  const directReports = useMemo(() => {
    if (!me?.id || !Array.isArray(employees)) return [];
    return employees
      .filter(e => e.manager_id === me.id && e.id !== me.id)
      .filter(e => (e.employment_status || 'active') === 'active')
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [employees, me]);

  const [staffId, setStaffId] = useState('');
  const [weekOffset, setWeekOffset] = useState(0); // 0 = this week
  const [shifts, setShifts] = useState({});
  // Snapshot of shifts as loaded from the DB. Used by the
  // pendingDispatchPreview memo to distinguish a real delete
  // (clearing a saved day) from a no-op (toggling off a day that
  // was never saved). Updated only by loadWeek so user edits don't
  // drift it.
  const [loadedShifts, setLoadedShifts] = useState({});
  // Which day is currently in focus for the time-editor panel. `null`
  // means no day has been picked yet — the panel stays collapsed and
  // the manager just sees the day grid. Resets when staff or week
  // changes (the previously-selected day key may not be valid in the
  // new context).
  const [selectedDay, setSelectedDay] = useState(null);
  // Per-week scheduled-day counts for the four week pills. Loaded
  // alongside the active week so the pills can show "3 days set" /
  // "empty" without having to flip through each week to find out.
  const [weekCounts, setWeekCounts] = useState([0, 0, 0, 0]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');

  // Initialise selected staff once direct reports load
  useEffect(() => {
    if (!staffId && directReports.length) setStaffId(directReports[0].id);
  }, [directReports, staffId]);

  const weekStart = useMemo(
    () => addDays(startOfSundayWeek(new Date()), weekOffset * 7),
    [weekOffset]
  );
  const weekEnd = useMemo(() => addDays(weekStart, 6), [weekStart]);
  const days    = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart]
  );
  const today = useMemo(() => {
    const t = new Date();
    t.setHours(0, 0, 0, 0);
    return t;
  }, []);

  // Load existing rows whenever staff or week changes
  const loadWeek = useCallback(async () => {
    if (!staffId || !supabase) return;
    setLoading(true);
    setError('');
    const fromKey = ymd(days[0]);
    const toKey   = ymd(days[6]);
    let data;
    try {
      data = await directGet(
        'employee_shifts',
        `select=shift_date,start_time,end_time,status,accepted_at` +
        `&employee_id=eq.${encodeURIComponent(staffId)}` +
        `&shift_date=gte.${fromKey}&shift_date=lte.${toKey}`,
        { timeoutMs: 8000 }
      );
    } catch (err) {
      setError(err.message || 'Failed to load shifts');
      setLoading(false);
      return;
    }

    const next = {};
    days.forEach(d => {
      next[ymd(d)] = { on: false, start: DEFAULT_START, end: DEFAULT_END, status: null };
    });
    (data || []).forEach(row => {
      next[row.shift_date] = {
        on: true,
        start: trimTime(row.start_time),
        end:   trimTime(row.end_time),
        status: row.status,
        accepted_at: row.accepted_at || null,
      };
    });
    setShifts(next);
    // Snapshot what was loaded so the dispatch preview can tell
    // "clearing a saved day" from "toggling off a never-saved day"
    // — only the former actually fires a DELETE.
    setLoadedShifts(next);
    setLoading(false);
  }, [staffId, days]);

  useEffect(() => { loadWeek(); }, [loadWeek]);

  // Load scheduled-day counts for the four-week window so the week
  // pills can show how many days are already set in each week. Runs
  // when staff changes (not when week changes — the data covers all
  // four weeks at once). Refresh after every save so the counts
  // stay in sync with what the manager just dispatched.
  const loadWeekCounts = useCallback(async () => {
    if (!staffId || !supabase) {
      setWeekCounts([0, 0, 0, 0]);
      return;
    }
    const today0  = startOfSundayWeek(new Date());
    const winFrom = ymd(today0);
    const winTo   = ymd(addDays(today0, (WEEKS_AHEAD + 1) * 7 - 1));
    try {
      const data = await directGet(
        'employee_shifts',
        `select=shift_date` +
        `&employee_id=eq.${encodeURIComponent(staffId)}` +
        `&shift_date=gte.${winFrom}&shift_date=lte.${winTo}`,
        { timeoutMs: 8000 }
      );
      const counts = [0, 0, 0, 0];
      (data || []).forEach(r => {
        // r.shift_date is YYYY-MM-DD — parse as local date so the
        // week-index calc doesn't drift across the UTC boundary.
        const [y, mo, dd] = r.shift_date.split('-').map(Number);
        const d = new Date(y, mo - 1, dd);
        const idx = Math.floor((d - today0) / (7 * 24 * 3600 * 1000));
        if (idx >= 0 && idx < counts.length) counts[idx] += 1;
      });
      setWeekCounts(counts);
    } catch {
      setWeekCounts([0, 0, 0, 0]);
    }
  }, [staffId]);
  useEffect(() => { loadWeekCounts(); }, [loadWeekCounts]);

  // Selection resets when context changes — the previously-focused
  // day key wouldn't belong to the new week (and may not even
  // belong to the new staff member if their roster differs).
  useEffect(() => { setSelectedDay(null); }, [staffId, weekOffset]);

  // ── Mutations on local state ──
  // Day-card click: combined toggle + select. Keeps the interaction
  // to a single tap for the common case (turning a day on, then
  // editing its time) rather than splitting into separate "toggle"
  // and "edit" controls. Cycle:
  //   off, not selected   -> turns on, becomes selected (panel opens)
  //   on,  not selected   -> becomes selected (panel opens, no toggle)
  //   on,  selected       -> turns off (panel closes)
  // Locked days (past or accepted) just no-op.
  const handleDayClick = (d) => {
    const key = ymd(d);
    if (d < today) return;
    const s = shifts[key];
    if (s?.status === 'accepted') return;
    const isOn       = !!s?.on;
    const isSelected = selectedDay === key;
    if (isOn && isSelected) {
      // Toggle off
      setShifts(prev => ({ ...prev, [key]: { ...prev[key], on: false } }));
      setSelectedDay(null);
    } else if (isOn) {
      // Already on — just bring its editor into focus
      setSelectedDay(key);
    } else {
      // Turn on with defaults if first time, otherwise restore last times
      setShifts(prev => ({
        ...prev,
        [key]: {
          on:    true,
          start: prev[key]?.start || DEFAULT_START,
          end:   prev[key]?.end   || DEFAULT_END,
          status: prev[key]?.status || null,
        },
      }));
      setSelectedDay(key);
    }
  };
  const setField = (key, field, value) => {
    setShifts(s => ({ ...s, [key]: { ...s[key], [field]: value } }));
  };
  // Apply the focused day's start/end to every other working day in
  // the visible week — skips locked days (past, accepted) and skips
  // days that are currently off (so this only affects already-on
  // days, not rosters yet to be set). Bulk-edit shortcut for the
  // common case of a uniform weekly schedule.
  const applyToAll = () => {
    if (!selectedDay) return;
    const ref = shifts[selectedDay];
    if (!ref?.on) return;
    setShifts(prev => {
      const next = { ...prev };
      days.forEach(d => {
        const k = ymd(d);
        if (k === selectedDay) return;
        if (d < today) return;
        if (next[k]?.status === 'accepted') return;
        if (!next[k]?.on) return;
        next[k] = { ...next[k], start: ref.start, end: ref.end };
      });
      return next;
    });
  };

  // ── Save to DB ──
  async function handleSave() {
    if (!staffId || !me?.id || !supabase) return;
    setSaving(true);
    setError('');
    setToast('');

    // Validate: end != start for every "on" day not in the past.
    // Overnight shifts (start > end, e.g. 23:00 -> 07:00 Mawani
    // night shift) are valid — end-time is interpreted as next day.
    // Only zero-length (start === end) is rejected.
    const invalid = days.find(d => {
      if (d < today) return false;
      const s = shifts[ymd(d)];
      return s?.on && s.start === s.end;
    });
    if (invalid) {
      setError(`Start and end time must be different on ${invalid.toLocaleDateString(SAR_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })}.`);
      setSaving(false);
      return;
    }

    const upserts = [];
    const deleteKeys = [];
    days.forEach(d => {
      const key = ymd(d);
      const s = shifts[key];
      // Never touch the past, never overwrite an already-acknowledged
      // shift (re-saving would silently reset to pending and invalidate
      // the staff's acknowledgment), and never overwrite a row that
      // was already dispatched and is awaiting acknowledgment — once
      // saved, the day is locked. The day-card UI also disables
      // these states, so this skip is belt-and-braces in case
      // anything sneaks past the front-end gate.
      if (d < today) return;
      if (s?.status === 'accepted') return;
      if (s?.status === 'pending')  return;
      if (!s) return;
      if (s.on) {
        upserts.push({
          employee_id: staffId,
          shift_date:  key,
          start_time:  s.start,
          end_time:    s.end,
          set_by:      me.id,
          // Manager assignment is final: the staff must attend, no staff
          // acceptance or HR approval needed. Write as 'accepted' so the
          // shift is active immediately and attendance is captured against
          // it. (Nadeem 2026-06-25)
          status:      'accepted',
          accepted_at: new Date().toISOString(),
          declined_at: null,
          decline_reason: null,
          notified_hr_at: null,
        });
      } else {
        deleteKeys.push(key);
      }
    });

    try {
      if (upserts.length) {
        await directPost('employee_shifts', upserts, {
          upsert: true,
          onConflict: 'employee_id,shift_date',
          timeoutMs: 15000,
        });
      }
      if (deleteKeys.length) {
        // PostgREST "in" filter takes a comma-separated list, with quoted dates
        const list = deleteKeys.map(d => `"${d}"`).join(',');
        await directDelete(
          'employee_shifts',
          `employee_id=eq.${encodeURIComponent(staffId)}&shift_date=in.(${list})`,
          { timeoutMs: 12000 }
        );
      }
      const staff = directReports.find(e => e.id === staffId);
      const staffName = (staff?.name || '').split(' ')[0] || 'Staff';
      const nDays = upserts.length;
      const nRemoved = deleteKeys.length;
      // Build the success toast based on what actually changed. Three cases:
      //   1. Roster issued (any new/updated rows) — staff must acknowledge,
      //      then SUP (Bashaier) issues the final approval.
      //   2. Only off-days cleared — no acknowledgment chain, just confirm
      //      the schedule is updated.
      //   3. Nothing changed — terse no-op.
      let summary;
      if (nDays && nRemoved) {
        summary = `\u2713 Saved \u2014 ${nDays} day${nDays === 1 ? '' : 's'} dispatched, ${nRemoved} cleared. Waiting for ${staffName} to acknowledge. Once accepted, the shift is final and locked \u2014 they must attend at the time you've set.`;
      } else if (nDays) {
        summary = `\u2713 Saved \u2014 ${nDays} day${nDays === 1 ? '' : 's'} dispatched. Waiting for ${staffName} to acknowledge. Once accepted, the shift is final and locked \u2014 they must attend at the time you've set.`;
      } else if (nRemoved) {
        summary = `\u2713 Saved \u2014 ${nRemoved} day${nRemoved === 1 ? '' : 's'} cleared.`;
      } else {
        summary = '\u2713 No changes to save.';
      }
      setToast(summary);
      setTimeout(() => setToast(''), 9000);
      await loadWeek(); // refresh status pills
      await loadWeekCounts(); // refresh week pill counts
    } catch (e) {
      // If anything still fails we want a human-readable message instead of
      // raw HTTP. The 23505 path should be unreachable now thanks to the
      // on_conflict param, but if it ever fires we surface a friendly note.
      const raw = e?.message || 'Save failed';
      let friendly = raw;
      if (raw.includes('23505') || raw.includes('duplicate key')) {
        friendly = 'A schedule already exists for one of those days. Try saving again — the conflict should clear automatically.';
      } else if (raw.includes('HTTP 4')) {
        friendly = 'Server rejected the save. ' + raw.replace(/^HTTP \d+:\s*/, '');
      }
      setError(friendly);
    } finally {
      setSaving(false);
    }
  }

  // No direct reports → don't render. Manager is a leaf node.
  if (directReports.length === 0) return null;

  const isThisWeek = weekOffset === 0;
  const canSave = !loading && !saving && days.some(d => d >= today);

  // Pre-compute what the next save-and-send will dispatch and what
  // it will clear, so the confirmation modal can show the manager
  // exactly what's about to happen before they commit. Mirrors the
  // skip logic in handleSave: past days, accepted shifts, and
  // already-pending shifts are excluded — the manager can only
  // ever dispatch a new "on" entry or clear an "off" toggle for a
  // day that's not yet locked.
  const pendingDispatchPreview = useMemo(() => {
    const dispatch = []; // { dateKey, dow, dayLabel, start, end, isOvernight }
    const clear    = []; // { dateKey, dow, dayLabel }
    days.forEach(d => {
      if (d < today) return;
      const key = ymd(d);
      const s = shifts[key];
      if (!s) return;
      if (s.status === 'accepted' || s.status === 'pending') return;
      const dayLabel = d.toLocaleDateString(SAR_LOCALE, { day: 'numeric', month: 'short' });
      const dow = DOW_SHORT[d.getDay()];
      if (s.on) {
        dispatch.push({
          dateKey: key,
          dow, dayLabel,
          start: s.start,
          end: s.end,
          isOvernight: s.start && s.end && s.start > s.end,
        });
      } else {
        // Only counts as a "clear" if a shift previously existed
        // for this day. New off toggles on never-saved days are
        // no-ops.
        if (loadedShifts[key]) {
          clear.push({ dateKey: key, dow, dayLabel });
        }
      }
    });
    return { dispatch, clear };
  }, [days, shifts, loadedShifts, today]);

  const hasPendingChanges = pendingDispatchPreview.dispatch.length > 0
                         || pendingDispatchPreview.clear.length > 0;

  // Confirmation gate. The "Save and send" button now opens this
  // modal first; manager reviews the preview, clicks "Confirm
  // dispatch" to actually save. Per Nadeem: once dispatched, the
  // day is locked (handled by dayKindFor + the save-loop skip
  // above). Confirmation is the moment-of-no-return so the manager
  // gets one explicit pause to verify times before they're sent.
  const [confirmOpen, setConfirmOpen] = useState(false);
  const openConfirm = () => {
    if (!canSave) return;
    if (!hasPendingChanges) {
      setToast('\u2713 No changes to save.');
      setTimeout(() => setToast(''), 4000);
      return;
    }
    setError('');
    setToast('');
    setConfirmOpen(true);
  };
  const confirmAndSave = () => {
    setConfirmOpen(false);
    handleSave();
  };

  // Initials helper for the staff card avatars. Falls back to the
  // first two characters of whatever string we have if the name
  // can't be split into first/last.
  const getInitials = (name) => {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  // Time-preset matchers — used to highlight the chip whose hours
  // match what's currently on the selected day. "Custom" lights up
  // when none of the presets match.
  //
  // The Night preset is set to 23:00 – 07:00 to align with the
  // Saudi Labor Law definition of night work (11 PM – 6 AM, the
  // window that triggers night-work protections + transport-allowance
  // obligations under MHRSD guidance). Mawani as port-operations
  // regulator works under that same labor-law framework, so this
  // is the regulation-aligned 8-hour night shift.
  const PRESET_9_5   = { start: '09:00', end: '17:00', label: '9 \u2013 5' };
  const PRESET_8_4   = { start: '08:00', end: '16:00', label: '8 \u2013 4' };
  const PRESET_NIGHT = { start: '23:00', end: '07:00', label: 'Night 23 \u2013 07' };
  const focusedShift  = selectedDay ? shifts[selectedDay] : null;
  const matchPreset = (p) =>
    focusedShift?.start === p.start && focusedShift?.end === p.end;

  // Pre-compute the four week-pill descriptors so the render is just
  // a map. Labels match the user-facing copy: This week, Next week,
  // + 2 weeks, + 3 weeks.
  const weekPills = [0, 1, 2, 3].map((o) => {
    const start = addDays(startOfSundayWeek(new Date()), o * 7);
    const end   = addDays(start, 6);
    const label = o === 0 ? 'This week' : o === 1 ? 'Next week' : `+ ${o} weeks`;
    return { offset: o, label, range: fmtRange(start, end), count: weekCounts[o] || 0 };
  });

  // Day-card visual state — five buckets that drive the styling
  // table. Past locks the card; accepted locks but with brand-green
  // emphasis; pending locks with amber emphasis (saved + waiting on
  // staff acknowledgment); on/off toggle between cream-and-beige
  // (off) and green-tinted (on). Selected adds a 2px ring on top.
  //
  // 'pending' kind means the row exists in the database with
  // status='pending' — manager has already saved & dispatched, the
  // staff member has not yet acknowledged. Once dispatched, the
  // day is locked: the manager can't silently change the time
  // out from under the staff. To change a dispatched day, the
  // staff would need to decline (which lets it go back to off),
  // or — TODO — a withdraw mechanism that deletes the pending row.
  const dayKindFor = (d, s) => {
    if (d < today) return 'past';
    if (s?.status === 'accepted') return 'accepted';
    if (s?.status === 'declined') return 'declined';
    if (s?.status === 'pending')  return 'pending';
    if (s?.on) return 'on';
    return 'off';
  };

  return (
    <Card
      title="Shift staff schedule"
      subtitle="Set rotating shift times for your team. Staff will be asked to acknowledge before HR is notified."
    >
      <div className="space-y-5 pb-2">

        {/* ── Staff strip ──────────────────────────────────────────
            Horizontal scrollable cards. Each card is a tappable
            target with initials, name, and department code. Selected
            card gets the 2px brand-green ring + light-green tint. */}
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-2" style={{ color: '#0A0A0A', fontWeight: 700 }}>
            STAFF MEMBER
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1" style={{ scrollbarWidth: 'thin' }}>
            {directReports.map((staff) => {
              const isSel = staffId === staff.id;
              return (
                <button
                  key={staff.id}
                  type="button"
                  onClick={() => setStaffId(staff.id)}
                  className="flex-none flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all"
                  style={{
                    minWidth: 190,
                    border: isSel
                      ? '2px solid var(--evergreen-700, #0F4C2A)'
                      : '0.5px solid var(--border)',
                    background: isSel ? 'var(--evergreen-600)' : 'var(--paper-2)',
                    cursor: 'pointer',
                    boxShadow: isSel ? '0 2px 8px rgba(15, 76, 42, 0.25)' : 'none',
                    transform: isSel ? 'translateY(-1px)' : 'none',
                  }}
                  aria-pressed={isSel}
                  title={`${staff.name || staff.id} \u2014 ${staff.id}${staff.department ? ' \u2014 ' + staff.department : ''}`}
                >
                  <div
                    className="rounded-full flex-none flex items-center justify-center"
                    style={{
                      width: 36, height: 36,
                      background: isSel ? '#FFFFFF' : 'var(--paper-3, #EAEAEA)',
                      color: isSel ? 'var(--evergreen-700, #0F4C2A)' : '#0A0A0A',
                      fontWeight: 700, fontSize: '12px', letterSpacing: '0.04em',
                    }}
                  >
                    {getInitials(staff.name)}
                  </div>
                  <div className="text-left min-w-0 flex-1">
                    <div className="text-sm leading-tight" style={{
                      color: isSel ? '#FFFFFF' : '#0A0A0A',
                      fontWeight: isSel ? 700 : 500,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {staff.name || staff.id}
                    </div>
                    <div className="text-[11px] mt-0.5" style={{
                      color: isSel ? '#FFFFFF' : '#0A0A0A',
                      opacity: isSel ? 0.85 : 0.65,
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                    }}>
                      {staff.id}{staff.department ? ' \u00B7 ' + staff.department : ''}
                    </div>
                  </div>
                  {isSel && (
                    <CheckCircle2 className="w-4 h-4 flex-none" style={{ color: '#FFFFFF' }} />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Week pills ───────────────────────────────────────────
            Four weeks at a glance. Each pill shows label, date
            range, and how many days are already scheduled in that
            week. Tap to navigate. Replaces the prev/next arrow nav. */}
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-2" style={{ color: '#0A0A0A', fontWeight: 700 }}>
            WEEK
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {weekPills.map(({ offset, label, range, count }) => {
              const isSel = weekOffset === offset;
              return (
                <button
                  key={offset}
                  type="button"
                  onClick={() => setWeekOffset(offset)}
                  className="text-left px-3 py-2.5 rounded-lg transition-all"
                  style={{
                    border: isSel
                      ? '2px solid var(--evergreen-600)'
                      : '0.5px solid var(--border)',
                    background: isSel ? 'var(--evergreen-50, #ECFDF5)' : 'var(--paper-2)',
                    cursor: 'pointer',
                  }}
                  aria-pressed={isSel}
                >
                  <div className="text-[11px]" style={{
                    color: isSel ? 'var(--evergreen-700, #0F4C2A)' : '#0A0A0A',
                    fontWeight: 600,
                  }}>
                    {label}
                  </div>
                  <div className="text-xs mt-0.5" style={{
                    color: '#0A0A0A',
                    opacity: isSel ? 0.85 : 0.7,
                  }}>
                    {range}
                  </div>
                  <div className="text-[11px] mt-1" style={{
                    color: count > 0
                      ? (isSel ? 'var(--evergreen-700, #0F4C2A)' : '#0A0A0A')
                      : '#0A0A0A',
                    opacity: count > 0 ? (isSel ? 0.85 : 0.65) : 0.45,
                    fontWeight: count > 0 ? 600 : 400,
                  }}>
                    {count > 0 ? `${count} day${count === 1 ? '' : 's'} set` : 'empty'}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Status banner — same shape as before, just lifted above
            the day grid so the manager sees confirmation without
            scrolling past their schedule. */}
        {(toast || error) && (
          <div
            className="rounded-lg border px-3 py-2.5 text-xs leading-relaxed flex items-start gap-2"
            style={{
              borderColor: error ? 'var(--clay-200, #E5C5BD)' : 'var(--evergreen-200, #BBDEC0)',
              background:  error ? 'var(--clay-50,  #FCF1ED)' : 'var(--evergreen-50, #ECFDF5)',
              color:       error ? 'var(--clay)'             : 'var(--evergreen-700, #0F4C2A)',
              fontWeight: 500,
            }}
            role={error ? 'alert' : 'status'}
          >
            <span aria-hidden="true">{error ? '\u26A0' : '\u2713'}</span>
            <span>{error || toast}</span>
          </div>
        )}

        {/* ── Day grid ─────────────────────────────────────────────
            7-column tappable cards replacing the vertical row list.
            States: past (locked), off (cream), on (green tint),
            accepted (solid green), declined (red tint). Selected
            adds a 2px ring on top of whatever state colour applies. */}
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-2" style={{ color: '#0A0A0A', fontWeight: 700 }}>
            DAYS &mdash; TAP TO TOGGLE
          </div>
          {loading ? (
            <div className="flex justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--evergreen-600)' }} />
            </div>
          ) : (
            <div className="grid grid-cols-7 gap-1.5">
              {days.map((d) => {
                const key = ymd(d);
                const s = shifts[key] || { on: false, start: DEFAULT_START, end: DEFAULT_END, status: null };
                const kind = dayKindFor(d, s);
                const isSel = selectedDay === key;
                const isLocked = kind === 'past' || kind === 'accepted' || kind === 'pending';

                // Style table by kind
                let bg, fg, br, label;
                if (kind === 'past') {
                  bg = 'transparent'; fg = '#0A0A0A'; br = '0.5px solid var(--border)'; label = 'Past';
                } else if (kind === 'accepted') {
                  // Accepted cells stay locked but should still show the
                  // times the staff agreed to — otherwise the manager
                  // loses visibility of what was committed. Brand-green
                  // bg + bold border + CheckCircle icon (added in the
                  // label row below) carry the 'locked + accepted'
                  // semantics; the times themselves replace the bare
                  // 'ACCEPTED' word that was here before. Nadeem
                  // 2026-05-17.
                  bg = 'var(--evergreen-600)';
                  fg = '#FFFFFF';
                  br = '2px solid var(--evergreen-600)';
                  const overnight = s.start && s.end && s.start > s.end;
                  label = overnight
                    ? `${s.start}\u2192${s.end}`
                    : `${s.start}\u2013${s.end}`;
                } else if (kind === 'pending') {
                  // Saved & dispatched, awaiting staff acknowledgment.
                  // Light amber background to visually echo the pending
                  // status colour used elsewhere (legend chip, status
                  // pill, tooltip border). Times rendered on the chip
                  // so the manager sees what was sent without unlocking.
                  bg = '#FEF6E2';
                  fg = '#854F0B';
                  br = '0.5px solid #E8C896';
                  const overnight = s.start && s.end && s.start > s.end;
                  label = overnight
                    ? `${s.start}\u2192${s.end}`
                    : `${s.start}\u2013${s.end}`;
                } else if (kind === 'declined') {
                  bg = 'var(--clay-50, #FCF1ED)'; fg = '#0A0A0A'; br = '0.5px solid var(--clay-200, #E5C5BD)'; label = 'Declined';
                } else if (kind === 'on') {
                  bg = 'var(--evergreen-50, #ECFDF5)';
                  fg = 'var(--evergreen-700, #0F4C2A)';
                  br = '0.5px solid var(--evergreen-200, #BBDEC0)';
                  // Overnight shift indicator: end < start means the
                  // shift crosses midnight (e.g. 23:00 -> 07:00). The
                  // arrow on the label hints at the next-day end without
                  // making the cell taller than its peers.
                  const overnight = s.start && s.end && s.start > s.end;
                  label = overnight
                    ? `${s.start}\u2192${s.end}`
                    : `${s.start}\u2013${s.end}`;
                } else {
                  bg = 'var(--paper-2)'; fg = '#0A0A0A'; br = '0.5px solid var(--border)'; label = 'Off';
                }
                // Selection ring overrides the border (skipped for
                // accepted + pending — both are locked, no selection
                // needed).
                if (isSel && kind !== 'accepted' && kind !== 'pending') {
                  br = '2px solid var(--evergreen-600)';
                }
                const opacity = kind === 'past' ? 0.5 : 1;

                // Helpful tooltip explaining WHY a cell is locked. Shows
                // on hover (desktop) and long-press (mobile). Skipped
                // for editable kinds so they don't get a useless 'Tap
                // to edit' that just states the obvious.
                let lockTitle = '';
                if (kind === 'accepted') {
                  lockTitle = `Accepted by staff on ${s?.accepted_at ? new Date(s.accepted_at).toLocaleDateString(SAR_LOCALE, { day: 'numeric', month: 'short' }) : 'an earlier date'}. Shift is final — to change, staff must decline first.`;
                } else if (kind === 'pending') {
                  lockTitle = 'Dispatched — waiting for staff to acknowledge. To change times, wait for the staff to decline or accept.';
                } else if (kind === 'past') {
                  lockTitle = 'Past date — read-only.';
                }

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleDayClick(d)}
                    disabled={isLocked}
                    title={lockTitle || undefined}
                    className="flex flex-col items-center justify-start py-2 px-1 rounded-lg transition-all"
                    style={{
                      background: bg,
                      color: fg,
                      border: br,
                      opacity,
                      cursor: isLocked ? 'not-allowed' : 'pointer',
                      minHeight: 78,
                    }}
                    aria-pressed={isSel}
                    aria-label={`${DOW_SHORT[d.getDay()]} ${d.getDate()} ${d.toLocaleDateString(SAR_LOCALE, { month: 'short' })} — ${label}${kind === 'accepted' ? ' — accepted, locked' : kind === 'pending' ? ' — pending acknowledgment, locked' : ''}`}
                  >
                    <div className="text-[11px]" style={{ opacity: 0.8, fontWeight: 600 }}>
                      {DOW_SHORT[d.getDay()]}
                    </div>
                    <div className="text-lg leading-tight" style={{ fontWeight: 700 }}>
                      {d.getDate()}
                    </div>
                    <div className="text-[10px] mt-1 text-center" style={{
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      maxWidth: '100%',
                      fontWeight: 500,
                    }}>
                      {kind === 'accepted' && <CheckCircle2 className="w-3 h-3 inline mr-0.5 -mt-0.5" />}
                      {kind === 'pending'  && <Clock className="w-2.5 h-2.5 inline mr-0.5 -mt-0.5" />}
                      {kind === 'past' && <Lock className="w-2.5 h-2.5 inline mr-0.5 -mt-0.5" />}
                      {label}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Time editor panel ────────────────────────────────────
            Shows when a day has been picked and is not locked. Two
            quick-fill chips (9-5 / 8-4), the time pickers always
            visible below them, and an "apply to all" link for the
            common bulk-edit case. Hidden otherwise so the page
            stays focused on the day grid. */}
        {selectedDay && shifts[selectedDay]?.on
          && shifts[selectedDay]?.status !== 'accepted'
          && (() => {
              const [yyyy, mo, dd] = selectedDay.split('-').map(Number);
              const dObj = new Date(yyyy, mo - 1, dd);
              if (dObj < today) return null;
              const longLabel = dObj.toLocaleDateString(SAR_LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
              return (
                <div className="rounded-lg p-3 sm:p-4" style={{ background: 'var(--paper-2)', border: '0.5px solid var(--border)' }}>
                  <div className="text-sm mb-3" style={{ color: '#0A0A0A', fontWeight: 600 }}>
                    {longLabel} &mdash; set times
                  </div>
                  <div className="text-[10px] tracking-[0.2em] mb-1.5" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
                    QUICK PRESETS
                  </div>
                  <div className="flex gap-1.5 flex-wrap mb-3">
                    {[PRESET_9_5, PRESET_8_4, PRESET_NIGHT].map((p) => {
                      const active = matchPreset(p);
                      return (
                        <button
                          key={p.label}
                          type="button"
                          onClick={() => {
                            setField(selectedDay, 'start', p.start);
                            setField(selectedDay, 'end',   p.end);
                          }}
                          className="px-3 py-1.5 rounded-full text-xs transition-all"
                          style={{
                            border: active ? '2px solid var(--evergreen-600)' : '0.5px solid var(--border)',
                            background: active ? 'var(--evergreen-50, #ECFDF5)' : '#FFFFFF',
                            color: active ? 'var(--evergreen-700, #0F4C2A)' : '#0A0A0A',
                            fontWeight: active ? 600 : 500,
                            cursor: 'pointer',
                          }}
                          aria-pressed={active}
                        >
                          {p.label}
                        </button>
                      );
                    })}
                    <span
                      className="px-3 py-1.5 rounded-full text-xs"
                      style={{
                        border: !matchPreset(PRESET_9_5) && !matchPreset(PRESET_8_4) && !matchPreset(PRESET_NIGHT)
                          ? '2px solid var(--evergreen-600)'
                          : '0.5px solid var(--border-soft)',
                        background: 'transparent',
                        color: '#0A0A0A',
                        opacity: 0.85,
                        fontWeight: 500,
                      }}
                    >
                      Custom &mdash; set below
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap mb-2">
                    <select
                      value={shifts[selectedDay].start}
                      onChange={(e) => setField(selectedDay, 'start', e.target.value)}
                      className="px-2 py-1.5 rounded border text-sm bg-white"
                      style={{ borderColor: 'var(--border)', color: '#0A0A0A', fontVariantNumeric: 'tabular-nums', minWidth: 90 }}
                      aria-label="Start hour"
                    >
                      {HOUR_OPTIONS.map((h) => (
                        <option key={h} value={h}>{h} hrs</option>
                      ))}
                    </select>
                    <span className="text-sm" style={{ color: '#0A0A0A', opacity: 0.7 }}>&rarr;</span>
                    <select
                      value={shifts[selectedDay].end}
                      onChange={(e) => setField(selectedDay, 'end', e.target.value)}
                      className="px-2 py-1.5 rounded border text-sm bg-white"
                      style={{ borderColor: 'var(--border)', color: '#0A0A0A', fontVariantNumeric: 'tabular-nums', minWidth: 90 }}
                      aria-label="End hour"
                    >
                      {HOUR_OPTIONS.map((h) => (
                        <option key={h} value={h}>{h} hrs</option>
                      ))}
                    </select>
                    <span className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                      hour granularity only
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={applyToAll}
                    className="text-xs underline-offset-2 hover:underline"
                    style={{ color: 'var(--evergreen-700, #0F4C2A)', fontWeight: 500 }}
                    title="Copy this time to every other working day in the visible week"
                  >
                    Apply this time to all working days in this week
                  </button>
                </div>
              );
            })()}

      </div>

      {/* ── Sticky save bar ────────────────────────────────────────
          Stays visible at the bottom of the card on long content so
          the manager doesn't have to scroll back up to save. Sticky
          (not fixed) so it sits inside the card and respects layout
          on every screen size. Help text wraps under the button on
          mobile so the save button never gets crowded out. */}
      <div
        className="sticky pt-3 mt-2 -mx-4 sm:-mx-5 px-4 sm:px-5 pb-1 flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3"
        style={{
          bottom: 0,
          background: 'var(--paper, #FFFFFF)',
          borderTop: '1px solid var(--border-soft)',
          zIndex: 5,
        }}
      >
        <div className="text-xs leading-relaxed flex-1" style={{ color: '#0A0A0A' }}>
          {error ? (
            <span style={{ color: 'var(--clay)' }}>{error}</span>
          ) : toast ? (
            <span style={{ color: 'var(--evergreen-700, #0F4C2A)', fontWeight: 500 }}>{toast}</span>
          ) : (
            <>Past, dispatched, and accepted days are locked. Click <strong>Save and send</strong> to review and dispatch new entries; once confirmed, those days lock too.</>
          )}
        </div>
        <button
          type="button"
          onClick={openConfirm}
          disabled={!canSave}
          className="px-4 py-2.5 rounded-lg text-sm flex items-center justify-center gap-2 transition-opacity shrink-0"
          style={{
            background: 'var(--evergreen-600)',
            color: 'white',
            opacity: canSave ? 1 : 0.5,
            cursor: canSave ? 'pointer' : 'not-allowed',
            fontWeight: 600,
          }}
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
          {saving ? 'Saving\u2026' : 'Save and send'}
        </button>
      </div>

      {/* ── Confirm-dispatch modal ─────────────────────────────────
          Opens when the manager clicks "Save and send". Shows a
          summary of every day about to be dispatched (with times,
          night-shift annotations) plus any days about to be cleared.
          Manager confirms → handleSave fires. Cancel closes the
          modal without saving.

          After confirmation + save, the dispatched days become
          'pending' kind in the day grid (amber tint, locked). The
          manager cannot silently change a dispatched time out from
          under the staff member they sent it to. To change a
          dispatched day, the staff would need to decline and the
          manager would dispatch a fresh entry. */}
      {confirmOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm shift dispatch"
          onClick={() => setConfirmOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            background: 'rgba(15, 23, 42, 0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#FFFFFF',
              border: '1px solid var(--border)',
              borderRadius: 14,
              boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
              width: '100%',
              maxWidth: 480,
              maxHeight: 'calc(100vh - 32px)',
              overflowY: 'auto',
              padding: '20px 22px',
            }}
          >
            <div className="text-[10px] tracking-[0.25em] mb-1.5" style={{ color: '#0A0A0A', fontWeight: 700 }}>
              CONFIRM SHIFT DISPATCH
            </div>
            <div style={{ fontFamily: 'inherit', fontSize: '20px', color: '#0A0A0A', marginBottom: 6 }}>
              Send shifts to {(directReports.find(e => e.id === staffId)?.name || '').split(' ')[0] || 'staff'}?
            </div>
            <div className="text-xs leading-relaxed mb-4" style={{ color: '#0A0A0A' }}>
              Once you confirm, the day(s) below are dispatched to {(directReports.find(e => e.id === staffId)?.name || '').split(' ')[0] || 'the staff member'} for acknowledgment, and the times become locked on your end. To change a dispatched day later, the staff would need to decline and you'd dispatch a fresh entry.
            </div>

            {/* Dispatch list */}
            {pendingDispatchPreview.dispatch.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div className="text-[10px] tracking-[0.2em] mb-1.5" style={{ color: '#854F0B', fontWeight: 700 }}>
                  DISPATCH &middot; {pendingDispatchPreview.dispatch.length} DAY{pendingDispatchPreview.dispatch.length === 1 ? '' : 'S'}
                </div>
                <div style={{ background: '#FEF6E2', border: '1px solid #E8C896', borderRadius: 8, padding: '8px 10px' }}>
                  {pendingDispatchPreview.dispatch.map((row) => (
                    <div key={row.dateKey} className="flex items-center justify-between gap-3 py-1" style={{ fontSize: 12 }}>
                      <span style={{ color: '#0A0A0A', fontWeight: 600 }}>
                        {row.dow} {row.dayLabel}
                      </span>
                      <span style={{ color: '#854F0B', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                        {row.start} {row.isOvernight ? '\u2192' : '\u2013'} {row.end}
                        {row.isOvernight && (
                          <span style={{ fontSize: 10, fontWeight: 500, marginLeft: 4, opacity: 0.85 }}>
                            next day
                          </span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Clear list */}
            {pendingDispatchPreview.clear.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div className="text-[10px] tracking-[0.2em] mb-1.5" style={{ color: '#791F1F', fontWeight: 700 }}>
                  CLEAR &middot; {pendingDispatchPreview.clear.length} DAY{pendingDispatchPreview.clear.length === 1 ? '' : 'S'}
                </div>
                <div style={{ background: '#FCEFEF', border: '1px solid #E8B5B0', borderRadius: 8, padding: '8px 10px' }}>
                  {pendingDispatchPreview.clear.map((row) => (
                    <div key={row.dateKey} className="flex items-center justify-between gap-3 py-1" style={{ fontSize: 12 }}>
                      <span style={{ color: '#0A0A0A', fontWeight: 600 }}>
                        {row.dow} {row.dayLabel}
                      </span>
                      <span style={{ color: '#791F1F', fontWeight: 600 }}>
                        Removed
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="flex gap-2 mt-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 rounded-lg text-sm transition-opacity"
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
                type="button"
                onClick={confirmAndSave}
                className="px-4 py-2 rounded-lg text-sm flex items-center justify-center gap-2 transition-opacity"
                style={{
                  background: 'var(--evergreen-600)',
                  color: '#FFFFFF',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <Check className="w-4 h-4" />
                Confirm dispatch
              </button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
