import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Card } from './Dashboard.jsx';
import { supabase, directGet, directPost, directDelete } from '../supabaseClient.js';
import { Loader2, Check, Lock, CheckCircle2 } from 'lucide-react';

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
        `select=shift_date,start_time,end_time,status` +
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
      };
    });
    setShifts(next);
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
      // Never touch the past, and never overwrite a shift the staff
      // member has already accepted — re-saving would reset its status
      // back to pending and silently invalidate their acknowledgment.
      if (d < today || s?.status === 'accepted') return;
      if (!s) return;
      if (s.on) {
        upserts.push({
          employee_id: staffId,
          shift_date:  key,
          start_time:  s.start,
          end_time:    s.end,
          set_by:      me.id,
          status:      'pending',
          accepted_at: null,
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
        summary = `✓ Shift roster issued — ${nDays} day${nDays === 1 ? '' : 's'} dispatched, ${nRemoved} cleared. ${staffName} will be asked to acknowledge on next sign-in. Final approval will be issued by the SUP (Bashaier) once acknowledged.`;
      } else if (nDays) {
        summary = `✓ Shift roster issued — ${nDays} day${nDays === 1 ? '' : 's'} dispatched. ${staffName} will be asked to acknowledge on next sign-in. Final approval will be issued by the SUP (Bashaier) once acknowledged.`;
      } else if (nRemoved) {
        summary = `✓ Schedule updated — ${nRemoved} day${nRemoved === 1 ? '' : 's'} cleared.`;
      } else {
        summary = '✓ No changes to save.';
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
  // emphasis; on/off toggle between cream-and-beige (off) and
  // green-tinted (on). Selected adds a 2px ring on top.
  const dayKindFor = (d, s) => {
    if (d < today) return 'past';
    if (s?.status === 'accepted') return 'accepted';
    if (s?.status === 'declined') return 'declined';
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
                      background: isSel ? '#FFFFFF' : 'var(--paper-3, #E8E0CC)',
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
                const isLocked = kind === 'past' || kind === 'accepted';

                // Style table by kind
                let bg, fg, br, label;
                if (kind === 'past') {
                  bg = 'transparent'; fg = '#0A0A0A'; br = '0.5px solid var(--border)'; label = 'Past';
                } else if (kind === 'accepted') {
                  bg = 'var(--evergreen-600)'; fg = '#FFFFFF'; br = '2px solid var(--evergreen-600)'; label = 'Accepted';
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
                // Selection ring overrides the border
                if (isSel && kind !== 'accepted') {
                  br = '2px solid var(--evergreen-600)';
                }
                const opacity = kind === 'past' ? 0.5 : 1;

                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => handleDayClick(d)}
                    disabled={isLocked}
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
                    aria-label={`${DOW_SHORT[d.getDay()]} ${d.getDate()} ${d.toLocaleDateString(SAR_LOCALE, { month: 'short' })} — ${label}`}
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
          background: 'var(--paper, #FFFDF7)',
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
            <>Past days and accepted shifts are locked. Saved entries are dispatched to the staff member for acknowledgment, then routed to the SUP (Bashaier) for final approval.</>
          )}
        </div>
        <button
          type="button"
          onClick={handleSave}
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
    </Card>
  );
}
