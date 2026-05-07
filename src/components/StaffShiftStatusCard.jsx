import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { CheckCircle2, XCircle, RefreshCw } from 'lucide-react';
import { directGet, supabase } from '../supabaseClient.js';

// ─────────────────────────────────────────────────────────────────────────────
// StaffShiftStatusCard
//
// Staff-side companion to ManagerShiftStatusCard. Renders on PersonalDashboard
// once the staff member has accepted or declined any shift in the last 30
// days, so they can see what's happening with each decision they've made:
//
//   accepted, notified_hr_at IS NULL     → "Awaiting SUP approval" (blue)
//   accepted, notified_hr_at IS NOT NULL → "Approved by SUP"       (green)
//   declined                              → "Declined"              (clay)
//
// Pending shifts are intentionally excluded — those live on the dedicated
// "Shift schedule — awaiting your acknowledgment" action card above this
// one. The two cards are complementary: action above, history below.
//
// Data scope: employee_shifts where employee_id = me.id AND shift_date is
// within the last 30 days through today (we don't show shifts the manager
// has just dispatched that haven't been acted on yet — those are pending
// and live on the action card).
//
// Realtime: subscribes to employee_shifts changes filtered to the staff's
// own employee_id so that when Bashaier signs off as SUP and notified_hr_at
// gets a timestamp, the row flips from "Awaiting SUP" to "Approved by SUP"
// without the staff member having to refresh.
// ─────────────────────────────────────────────────────────────────────────────

const SMALL_TEXT = { color: '#1F1B16' };

export default function StaffShiftStatusCard({ me }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!me?.id) return;
    // 30-day rolling window. We include shift_date >= today-30 with no
    // upper bound so future shifts the staff has already acted on are
    // visible until they age out of the window.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    try {
      const data = await directGet(
        'employee_shifts',
        `select=*&employee_id=eq.${encodeURIComponent(me.id)}&shift_date=gte.${cutoffISO}&status=in.(accepted,declined)&order=shift_date.asc`,
        { timeoutMs: 10000 }
      );
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [me?.id]);

  useEffect(() => { load(); }, [load]);

  // Realtime: keep the card in sync with downstream changes (SUP sign-off,
  // manager corrections, etc.) without needing manual refresh.
  useEffect(() => {
    if (!me?.id || !supabase) return;
    const channel = supabase.channel(`staff-shift-status-${me.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'employee_shifts',
        filter: `employee_id=eq.${me.id}`,
      }, () => load())
      .subscribe();
    return () => { try { supabase.removeChannel(channel); } catch {} };
  }, [me?.id, load]);

  // Roll-up counts across the visible window. Per Nadeem: shift
  // acknowledgment is between manager and staff directly — once
  // accepted, the shift is final and locked. No more SUP "approval"
  // step. Buckets simplify to two: accepted (locked) and declined.
  const counts = useMemo(() => {
    const c = { accepted: 0, declined: 0 };
    rows.forEach(r => {
      if (r.status === 'declined') c.declined++;
      else if (r.status === 'accepted') c.accepted++;
    });
    return c;
  }, [rows]);

  // Hide the card entirely when there's nothing to show — staff with no
  // shift activity shouldn't see an empty section.
  if (loading) return null;
  if (rows.length === 0) return null;

  return (
    <section
      className="rounded-2xl border bg-white p-5"
      style={{ borderColor: 'var(--border-soft)' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#1F1B16', fontWeight: 700 }}>
            SHIFT STATUS
          </div>
          <div style={{ fontFamily: 'inherit', fontSize: '20px', color: '#1F1B16' }}>
            Recent activity
          </div>
          <div className="text-xs mt-1" style={SMALL_TEXT}>
            Status of your shift decisions in the last 30 days. Once you accept a shift, it's final &mdash; the time is locked and used by HR for attendance checks.
          </div>
        </div>
        <button
          type="button"
          onClick={() => { setRefreshing(true); load(); }}
          disabled={refreshing}
          className="p-1.5 rounded-full border opacity-70 hover:opacity-100 disabled:opacity-40"
          title="Refresh"
          aria-label="Refresh shift status"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Roll-up tiles — two buckets covering the post-decision states.
          Pending shifts live on the action card above this one and are
          intentionally absent here. */}
      <div className="grid grid-cols-2 gap-2 mt-4">
        <Pill
          label="Accepted &amp; locked"
          count={counts.accepted}
          color="#0F4C2A"
          bg="#ECFDF5"
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
        />
        <Pill
          label="Declined"
          count={counts.declined}
          color="#B91C1C"
          bg="#FEE2E2"
          icon={<XCircle className="w-3.5 h-3.5" />}
        />
      </div>

      {/* Per-shift list */}
      <ul className="mt-4 divide-y" style={{ borderColor: 'var(--border-soft)' }}>
        {rows.map(r => <Row key={r.id} shift={r} />)}
      </ul>
    </section>
  );
}

// ── Helper components ──────────────────────────────────────────────────────

function Pill({ label, count, color, bg, icon }) {
  return (
    <div
      className="rounded-lg px-3 py-2.5 border"
      style={{ background: bg, borderColor: 'var(--border-soft)' }}
    >
      <div className="flex items-center gap-1.5" style={{ color }}>
        {icon}
        <span className="text-[10px] tracking-[0.18em]" style={{ fontWeight: 700 }}>
          {label.toUpperCase()}
        </span>
      </div>
      <div className="text-2xl mt-1 tabular-nums" style={{ color, fontWeight: 600 }}>
        {count}
      </div>
    </div>
  );
}

function Row({ shift }) {
  const [y, m, d] = String(shift.shift_date).split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()];
  const pretty = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const trim = (t) => String(t || '').slice(0, 5);

  let statusEl;
  let detailEl;

  if (shift.status === 'declined') {
    statusEl = (
      <span
        className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1"
        style={{ background: '#FEE2E2', color: '#B91C1C', fontWeight: 700, letterSpacing: '0.1em' }}
      >
        <XCircle className="w-2.5 h-2.5" /> DECLINED
      </span>
    );
    detailEl = (
      <span style={{ color: '#1F1B16' }}>
        {shift.decline_reason ? <em>"{shift.decline_reason}"</em> : 'Manager will follow up.'}
      </span>
    );
  } else if (shift.status === 'accepted') {
    // Single accepted state — the shift is final once you accept.
    // No SUP approval step, no waiting. The time is locked and HR
    // uses it for cross-referencing your attendance on the day.
    statusEl = (
      <span
        className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1"
        style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 700, letterSpacing: '0.1em' }}
      >
        <CheckCircle2 className="w-2.5 h-2.5" /> ACCEPTED &amp; LOCKED
      </span>
    );
    detailEl = (
      <span style={{ color: '#1F1B16' }}>
        You're confirmed for this shift. The time is locked and used by HR for attendance checks.
      </span>
    );
  }

  return (
    <li className="py-2.5 flex items-start gap-3 text-xs">
      <div className="shrink-0" style={{ minWidth: 110 }}>
        <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
          {dow} · {pretty}
        </div>
        <div className="text-[11px] tabular-nums mt-0.5" style={SMALL_TEXT}>
          {trim(shift.start_time)} – {trim(shift.end_time)}
        </div>
      </div>
      <div className="flex-1 min-w-0">
        <div className="mb-1">{statusEl}</div>
        <div className="text-xs">{detailEl}</div>
      </div>
    </li>
  );
}
