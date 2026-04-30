import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  CheckCircle2, XCircle, Clock, Bell, Loader2, RefreshCw, ChevronDown, ChevronRight,
} from 'lucide-react';
import { directGet, supabase } from '../supabaseClient.js';

// ─────────────────────────────────────────────────────────────────────────────
// ManagerShiftStatusCard
//
// Companion to ManagerShiftCard: shows the manager every shift they've
// assigned and the current state of the acknowledgment chain. So when
// Sadakathullah saves shifts for Ariel and walks away, he can come back
// next sign-in and immediately see "Ariel accepted 4 of 5", "Nasir hasn't
// looked yet", "Rizwan declined Wed and asked to swap".
//
// Data shape per shift:
//   pending        → grey  "Waiting for staff"
//   accepted       → green "Accepted DD MMM HH:mm" (+ optionally "Approved by SUP")
//   declined       → red   "Declined — '<reason>'"
//
// Scope: rows where set_by === me.id, ordered by shift_date asc.
// We hide rows that are >7 days in the past so the panel doesn't bloat.
//
// Realtime: subscribes to employee_shifts changes filtered to set_by=eq.{me.id}
// so when staff acknowledges, the row flips live without a manual refresh.
// ─────────────────────────────────────────────────────────────────────────────

export default function ManagerShiftStatusCard({ me, employees }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState(true);

  const empMap = useMemo(() => {
    const m = {};
    (employees || []).forEach(e => { m[e.id] = e; });
    return m;
  }, [employees]);

  const directReports = useMemo(
    () => (employees || []).filter(e => e.manager_id === me?.id),
    [employees, me?.id]
  );

  const load = useCallback(async () => {
    if (!me?.id) return;
    // Only show shifts from the past 7 days onward — older ones are irrelevant
    // and would just clutter the list.
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    try {
      const data = await directGet(
        'employee_shifts',
        `select=*&set_by=eq.${encodeURIComponent(me.id)}&shift_date=gte.${cutoffISO}&order=shift_date.asc`,
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

  // Realtime — flip the row's status the moment a staff member acknowledges.
  // Filter on set_by so this manager only gets events for shifts they assigned.
  useEffect(() => {
    if (!me?.id || !supabase) return;
    const channel = supabase
      .channel(`mgr-shift-status-${me.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'employee_shifts', filter: `set_by=eq.${me.id}` },
        () => load()
      )
      .subscribe();
    return () => { try { supabase.removeChannel(channel); } catch {} };
  }, [me?.id, load]);

  // Group by employee → array of shifts (chrono asc), keep original order
  const grouped = useMemo(() => {
    const g = {};
    rows.forEach(r => {
      if (!g[r.employee_id]) g[r.employee_id] = [];
      g[r.employee_id].push(r);
    });
    return Object.entries(g)
      .map(([empId, shifts]) => ({
        empId,
        emp: empMap[empId],
        shifts,
        counts: countByStatus(shifts),
      }))
      .sort((a, b) => (a.emp?.name || '').localeCompare(b.emp?.name || ''));
  }, [rows, empMap]);

  // Roll-up across the whole team
  const total = useMemo(() => countByStatus(rows), [rows]);

  // Manager has no direct reports OR no shifts on file → render nothing.
  // The ManagerShiftCard above already handles the empty-team case; here
  // we just suppress the empty status panel so the dashboard isn't noisy.
  if (directReports.length === 0) return null;
  if (!loading && rows.length === 0) {
    return (
      <div
        className="rounded-2xl border p-5"
        style={{
          background: 'white',
          borderColor: 'var(--border-soft)',
          boxShadow: '0 1px 2px rgba(31,27,22,0.04), 0 4px 14px rgba(31,27,22,0.06)',
        }}
      >
        <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#1F1B16', fontWeight: 700 }}>
          SHIFT STATUS
        </div>
        <div style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#1F1B16' }}>
          Acknowledgments
        </div>
        <div className="mt-3 text-sm" style={{ color: '#1F1B16' }}>
          You haven't assigned any shifts yet. Schedules you save above will appear here so you can track who's accepted.
        </div>
      </div>
    );
  }

  return (
    <div
      className="rounded-2xl border p-5"
      style={{
        background: 'white',
        borderColor: 'var(--border-soft)',
        boxShadow: '0 1px 2px rgba(31,27,22,0.04), 0 4px 14px rgba(31,27,22,0.06)',
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] tracking-[0.25em]" style={{ color: '#1F1B16', fontWeight: 700 }}>
            SHIFT STATUS
          </div>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#1F1B16' }}>
            Acknowledgments
          </div>
          <div className="text-xs mt-1" style={{ color: '#1F1B16' }}>
            Live status of every shift you've sent. Updates the moment staff accept or decline.
          </div>
        </div>
        <div className="flex items-center gap-2">
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
      </div>

      {/* Roll-up tiles — four columns. Reading left to right traces the
          happy path of the shift workflow: Waiting (sent, awaiting staff)
          → Accepted (staff acknowledged) → Approved by SUP (Bashaier/HR
          signed off) → Declined sits last as the negative-outcome bucket. */}
      <div className="grid grid-cols-4 gap-2 mt-4">
        <RollupTile
          label="Waiting for staff"
          count={total.pending}
          color="#A16207"
          bg="#FEF3C7"
          icon={<Clock className="w-3.5 h-3.5" />}
        />
        <RollupTile
          label="Accepted"
          count={total.accepted}
          color="#0F4C2A"
          bg="#ECFDF5"
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
        />
        <RollupTile
          label="Approved by SUP"
          count={total.approvedBySup}
          color="#1D4ED8"
          bg="#DBEAFE"
          icon={<Bell className="w-3.5 h-3.5" />}
        />
        <RollupTile
          label="Declined"
          count={total.declined}
          color="#B91C1C"
          bg="#FEE2E2"
          icon={<XCircle className="w-3.5 h-3.5" />}
        />
      </div>

      {/* Per-employee breakdown */}
      {loading ? (
        <div className="flex justify-center py-6">
          <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#0F4C2A' }} />
        </div>
      ) : (
        <div className="mt-4 space-y-2">
          {grouped.map(g => (
            <EmployeeStatusRow key={g.empId} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers ──

function countByStatus(rows) {
  // Four buckets: pending / accepted / declined are mutually exclusive on
  // status. approvedBySup is a SECONDARY count that overlaps with accepted —
  // an accepted shift becomes "approved by SUP" once Bashaier (or whoever
  // is acting in the SUP-review role) signs off and notified_hr_at gets a
  // timestamp. We surface it as its own tile so the manager can see at a
  // glance which accepted shifts have been fully greenlit through HR.
  const c = { pending: 0, accepted: 0, declined: 0, approvedBySup: 0 };
  rows.forEach(r => {
    if (r.status === 'pending')  c.pending++;
    if (r.status === 'accepted') c.accepted++;
    if (r.status === 'declined') c.declined++;
    if (r.status === 'accepted' && r.notified_hr_at != null) c.approvedBySup++;
  });
  return c;
}

function RollupTile({ label, count, color, bg, icon }) {
  return (
    <div
      className="rounded-lg px-3 py-2.5 border"
      style={{ background: bg, borderColor: 'var(--border-soft)' }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5" style={{ color, fontWeight: 700 }}>
          {icon}
          <span style={{ fontFamily: 'Georgia, serif', fontSize: '20px' }}>{count}</span>
        </span>
      </div>
      <div className="text-[10px] tracking-[0.15em] mt-0.5" style={{ color: '#1F1B16', fontWeight: 700 }}>
        {label.toUpperCase()}
      </div>
    </div>
  );
}

function EmployeeStatusRow({ group }) {
  const [open, setOpen] = useState(group.counts.declined > 0); // auto-open if anything declined
  const { emp, shifts, counts, empId } = group;
  const name = emp?.name || empId;
  const dept = emp?.department || '—';

  const summary = (() => {
    const parts = [];
    if (counts.accepted) parts.push(`${counts.accepted} accepted`);
    if (counts.pending)  parts.push(`${counts.pending} pending`);
    if (counts.declined) parts.push(`${counts.declined} declined`);
    return parts.join(' · ') || 'No shifts';
  })();

  const summaryColor = counts.declined ? '#B91C1C' : counts.pending ? '#A16207' : '#0F4C2A';

  return (
    <div className="rounded-lg border" style={{ borderColor: 'var(--border-soft)', background: '#FBFAF6' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-white/60 rounded-lg"
      >
        <span className="opacity-60">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm" style={{ color: '#1F1B16', fontWeight: 600 }}>{name}</div>
          <div className="text-[11px]" style={{ color: '#1F1B16' }}>
            {empId} · {dept}
          </div>
        </div>
        <div className="text-xs" style={{ color: summaryColor, fontWeight: 600 }}>
          {summary}
        </div>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-1.5">
          {shifts.map(s => (
            <ShiftStatusRow key={s.id} shift={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function ShiftStatusRow({ shift }) {
  const date = new Date(shift.shift_date + 'T00:00:00');
  const dateLabel = date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const timeRange = `${trimTime(shift.start_time)} → ${trimTime(shift.end_time)}`;

  let statusEl, detailEl;
  if (shift.status === 'pending') {
    statusEl = (
      <span className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1"
        style={{ background: '#FEF3C7', color: '#A16207', fontWeight: 700, letterSpacing: '0.1em' }}>
        <Clock className="w-2.5 h-2.5" /> WAITING
      </span>
    );
    detailEl = <span style={{ color: '#1F1B16' }}>Staff hasn't acknowledged yet.</span>;
  } else if (shift.status === 'accepted') {
    statusEl = (
      <span className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1"
        style={{ background: '#ECFDF5', color: '#0F4C2A', fontWeight: 700, letterSpacing: '0.1em' }}>
        <CheckCircle2 className="w-2.5 h-2.5" /> ACCEPTED
      </span>
    );
    detailEl = (
      <span style={{ color: '#1F1B16' }}>
        Accepted {fmtTimestamp(shift.accepted_at)}
        {shift.notified_hr_at && (
          <>
            {' '}·{' '}
            <span style={{ color: '#1D4ED8' }} className="inline-flex items-center gap-1">
              <Bell className="w-2.5 h-2.5" /> Approved by SUP
            </span>
          </>
        )}
      </span>
    );
  } else if (shift.status === 'declined') {
    statusEl = (
      <span className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1"
        style={{ background: '#FEE2E2', color: '#B91C1C', fontWeight: 700, letterSpacing: '0.1em' }}>
        <XCircle className="w-2.5 h-2.5" /> DECLINED
      </span>
    );
    detailEl = (
      <span style={{ color: '#1F1B16' }}>
        Declined {fmtTimestamp(shift.declined_at)}
        {shift.decline_reason && (
          <>
            {' '}— <em style={{ color: '#B91C1C' }}>"{shift.decline_reason}"</em>
          </>
        )}
      </span>
    );
  } else {
    statusEl = <span className="text-[10px] opacity-60">{(shift.status || 'unknown').toUpperCase()}</span>;
    detailEl = null;
  }

  return (
    <div className="flex items-start gap-3 px-2 py-2 rounded border bg-white" style={{ borderColor: 'var(--border-soft)' }}>
      <div className="flex-shrink-0" style={{ minWidth: 110 }}>
        <div className="text-xs" style={{ color: '#1F1B16', fontWeight: 600 }}>{dateLabel}</div>
        <div className="text-[10px]" style={{ color: '#1F1B16' }}>{timeRange}</div>
      </div>
      <div className="flex-1 min-w-0 text-[11px] leading-relaxed">
        <div className="mb-1">{statusEl}</div>
        {detailEl}
      </div>
    </div>
  );
}

function trimTime(t) {
  if (!t) return '';
  return String(t).slice(0, 5);
}

function fmtTimestamp(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit',
    hour12: false,
  });
}
