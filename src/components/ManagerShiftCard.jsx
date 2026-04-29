import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { Card } from './Dashboard.jsx';
import { supabase, directGet, directPost, directDelete } from '../supabaseClient.js';
import { ChevronLeft, ChevronRight, Loader2, Check, CalendarClock, Lock } from 'lucide-react';

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
  // Postgres time → 'HH:MM:SS' or 'HH:MM' — normalise to 'HH:MM'
  if (!t) return DEFAULT_START;
  return String(t).slice(0, 5);
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

  // ── Mutations on local state ──
  const toggleDay = (key) => {
    setShifts(s => ({ ...s, [key]: { ...s[key], on: !s[key].on } }));
  };
  const setField = (key, field, value) => {
    setShifts(s => ({ ...s, [key]: { ...s[key], [field]: value } }));
  };

  // ── Save to DB ──
  async function handleSave() {
    if (!staffId || !me?.id || !supabase) return;
    setSaving(true);
    setError('');
    setToast('');

    // Validate: end > start for every "on" day not in the past
    const invalid = days.find(d => {
      if (d < today) return false;
      const s = shifts[ymd(d)];
      return s?.on && s.start >= s.end;
    });
    if (invalid) {
      setError(`End time must be after start time on ${invalid.toLocaleDateString(SAR_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' })}.`);
      setSaving(false);
      return;
    }

    const upserts = [];
    const deleteKeys = [];
    days.forEach(d => {
      if (d < today) return;          // never touch the past
      const key = ymd(d);
      const s = shifts[key];
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
        await directPost('employee_shifts', upserts, { upsert: true, timeoutMs: 15000 });
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
      const staffName = (staff?.name || '').split(' ')[0] || 'staff';
      setToast(`Saved. ${staffName} will see the schedule on next sign-in.`);
      setTimeout(() => setToast(''), 5000);
      await loadWeek(); // refresh status pills
    } catch (e) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  // No direct reports → don't render. Manager is a leaf node.
  if (directReports.length === 0) return null;

  const weekLabel = fmtRange(weekStart, weekEnd);
  const isThisWeek = weekOffset === 0;
  const canSave = !loading && !saving && days.some(d => d >= today);

  return (
    <Card
      title="Shift staff schedule"
      subtitle="Set rotating shift times for your team. Staff will be asked to acknowledge before HR is notified."
    >
      <div className="space-y-4">
        {/* Staff picker */}
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-2" style={SMALL_TEXT}>
            TEAM MEMBER
          </div>
          <select
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
            className="w-full px-3 py-2 rounded border bg-white text-sm focus:outline-none focus:ring-1"
            style={{ borderColor: 'var(--border)', color: '#1F1B16' }}
          >
            {directReports.map(e => (
              <option key={e.id} value={e.id}>
                {e.name || e.id} — {e.department || e.location || '—'}
              </option>
            ))}
          </select>
        </div>

        {/* Week navigator */}
        <div
          className="flex items-center justify-between rounded border px-3 py-2"
          style={{ borderColor: 'var(--border)', background: 'var(--paper-2)' }}
        >
          <button
            type="button"
            onClick={() => setWeekOffset(o => Math.max(0, o - 1))}
            disabled={weekOffset === 0}
            aria-label="Previous week"
            className="p-1 rounded hover:bg-white/60 disabled:opacity-25 disabled:cursor-not-allowed"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-2">
            <CalendarClock className="w-4 h-4" style={{ color: 'var(--evergreen-600)' }} />
            <span className="text-sm" style={{ color: '#1F1B16', fontWeight: 500 }}>
              {weekLabel}
            </span>
            {isThisWeek && (
              <span
                className="text-[10px] tracking-[0.2em] px-1.5 py-0.5 rounded"
                style={{ ...SMALL_TEXT, background: 'var(--evergreen-100)' }}
              >
                THIS WEEK
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => setWeekOffset(o => Math.min(WEEKS_AHEAD, o + 1))}
            disabled={weekOffset === WEEKS_AHEAD}
            aria-label="Next week"
            className="p-1 rounded hover:bg-white/60 disabled:opacity-25 disabled:cursor-not-allowed"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Day rows */}
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin" style={{ color: 'var(--evergreen-600)' }} />
          </div>
        ) : (
          <div className="space-y-1.5">
            {days.map(d => {
              const key = ymd(d);
              const s = shifts[key] || { on: false, start: DEFAULT_START, end: DEFAULT_END, status: null };
              const isPast = d < today;
              return (
                <div
                  key={key}
                  className="flex items-center gap-3 rounded border px-3 py-2.5 transition-colors"
                  style={{
                    borderColor: s.on && !isPast ? 'var(--evergreen-200)' : 'var(--border-soft)',
                    background:  s.on && !isPast ? 'var(--evergreen-50)' : 'transparent',
                    opacity:     isPast ? 0.55 : 1,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={s.on}
                    disabled={isPast}
                    onChange={() => toggleDay(key)}
                    className="w-4 h-4 cursor-pointer disabled:cursor-not-allowed"
                    style={{ accentColor: 'var(--evergreen-600)' }}
                    aria-label={`Toggle shift on ${d.toDateString()}`}
                  />

                  <div className="w-32 shrink-0">
                    <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                      {DOW_SHORT[d.getDay()]} {d.getDate()} {d.toLocaleDateString(SAR_LOCALE, { month: 'short' })}
                    </div>
                    {isPast ? (
                      <div className="text-[10px] tracking-[0.2em] flex items-center gap-1" style={SMALL_TEXT}>
                        <Lock className="w-2.5 h-2.5" /> LOCKED · PAST
                      </div>
                    ) : s.status ? (
                      <div className="text-[10px] tracking-[0.2em]" style={SMALL_TEXT}>
                        {s.status.toUpperCase()}
                      </div>
                    ) : null}
                  </div>

                  <div className="flex-1">
                    {s.on ? (
                      <div className="flex items-center gap-2 flex-wrap">
                        <input
                          type="time"
                          value={s.start}
                          disabled={isPast}
                          onChange={(e) => setField(key, 'start', e.target.value)}
                          className="px-2 py-1 rounded border text-sm bg-white disabled:bg-transparent"
                          style={{ borderColor: 'var(--border)', color: '#1F1B16' }}
                        />
                        <span className="text-sm" style={SMALL_TEXT}>→</span>
                        <input
                          type="time"
                          value={s.end}
                          disabled={isPast}
                          onChange={(e) => setField(key, 'end', e.target.value)}
                          className="px-2 py-1 rounded border text-sm bg-white disabled:bg-transparent"
                          style={{ borderColor: 'var(--border)', color: '#1F1B16' }}
                        />
                      </div>
                    ) : (
                      <div className="text-sm italic" style={SMALL_TEXT}>— Off —</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer / save */}
        <div className="flex items-start justify-between gap-3 pt-1">
          <div className="text-xs leading-relaxed flex-1" style={SMALL_TEXT}>
            {error ? (
              <span style={{ color: 'var(--clay)' }}>{error}</span>
            ) : toast ? (
              <span style={{ color: 'var(--evergreen-600)', fontWeight: 500 }}>{toast}</span>
            ) : (
              <>Past dates are locked. Saved entries are sent to the staff member for acknowledgment before HR is notified.</>
            )}
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="px-4 py-2 rounded text-sm flex items-center gap-2 transition-opacity shrink-0"
            style={{
              background: 'var(--evergreen-600)',
              color: 'white',
              opacity: canSave ? 1 : 0.5,
              cursor: canSave ? 'pointer' : 'not-allowed',
            }}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {saving ? 'Saving…' : 'Save & send'}
          </button>
        </div>
      </div>
    </Card>
  );
}
