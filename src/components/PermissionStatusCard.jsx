import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { CheckCircle2, XCircle, Clock, AlertTriangle, Sunrise, Sunset, RefreshCw } from 'lucide-react';
import { directGet, supabase } from '../supabaseClient.js';
import PermissionTimelineModal from './PermissionTimelineModal.jsx';

// =============================================================================
// PermissionStatusCard
//
// Staff-side status card for permission requests (late arrival / early leave).
// Sits on PersonalDashboard alongside the leave request list and the shift
// status card, giving the staff one place to see:
//   • how many permission requests they've submitted recently
//   • which are still pending, approved, rejected, or flagged for HR review
//   • the decision note (if any) for each completed application
//
// Window: rolling 30 days (by permission_date), so cross-month visibility is
// preserved without bloating the list. The colored 'LATE ARRIVAL' /
// 'EARLY LEAVING' tiles above the dashboard already show monthly quota
// usage — this card is intentionally about the application audit trail
// (how many, what status), not the quota math.
//
// Self-hides when there's nothing to show — staff with no permission
// activity in the last 30 days don't see an empty card.
// =============================================================================

const TYPE_META = {
  late_arrival: { label: 'Late arrival',  Icon: Sunrise, color: '#A16207', bg: '#FEF3C7' },
  early_leave:  { label: 'Early leaving', Icon: Sunset,  color: '#BE185D', bg: '#FCE7F3' },
};

const STATUS_META = {
  pending:   { label: 'PENDING',   color: '#A16207', bg: '#FEF3C7', Icon: Clock },
  approved:  { label: 'APPROVED',  color: '#0F4C2A', bg: '#ECFDF5', Icon: CheckCircle2 },
  rejected:  { label: 'REJECTED',  color: '#B91C1C', bg: '#FEE2E2', Icon: XCircle },
  cancelled: { label: 'CANCELLED', color: '#737373', bg: '#F5F5F5', Icon: XCircle },
};

export default function PermissionStatusCard({ me }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Selected row for the timeline modal. Click any item in the per-row list
  // to read-only view its 4-stage approval progress (submitted → manager →
  // HR → final). Submission still goes exclusively through '+ New Request'.
  const [openRow, setOpenRow] = useState(null);

  const load = useCallback(async () => {
    if (!me?.id) return;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    try {
      const data = await directGet(
        'permission_requests',
        `select=*&employee_id=eq.${encodeURIComponent(me.id)}&permission_date=gte.${cutoffISO}&order=permission_date.desc`,
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

  // Realtime sub on this user's permission rows so the card flips state
  // (e.g. pending → approved) the moment Bashaier acts on a request,
  // without the staff member needing to refresh.
  useEffect(() => {
    if (!me?.id || !supabase) return;
    const channel = supabase.channel(`staff-permission-status-${me.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'permission_requests',
        filter: `employee_id=eq.${me.id}`,
      }, () => load())
      .subscribe();
    return () => { try { supabase.removeChannel(channel); } catch {} };
  }, [me?.id, load]);

  const counts = useMemo(() => {
    const c = { pending: 0, approved: 0, rejected: 0, flagged: 0, total: rows.length };
    rows.forEach(r => {
      if (r.status === 'pending')   c.pending++;
      if (r.status === 'approved')  c.approved++;
      if (r.status === 'rejected')  c.rejected++;
      if (r.exceeds_quota)          c.flagged++;
    });
    return c;
  }, [rows]);

  // Hide the card entirely when there's nothing to show
  if (loading) return null;
  if (rows.length === 0) return null;

  return (
    <section
      className="rounded-xl border p-5 esau-card"
      style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4 pb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
        <div>
          <div className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
            PERMISSION HISTORY
          </div>
          <h3 className="serif text-lg mt-0.5" style={{ fontWeight: 500, color: '#1F1B16' }}>
            Your applications
          </h3>
          <div className="text-xs mt-1" style={{ color: '#1F1B16' }}>
            Late arrival and early leave requests in the last 30 days. {counts.total} application{counts.total === 1 ? '' : 's'} total.
          </div>
        </div>
        <button
          type="button"
          onClick={() => { setRefreshing(true); load(); }}
          disabled={refreshing}
          className="p-1.5 rounded-full border opacity-70 hover:opacity-100 disabled:opacity-40"
          title="Refresh"
          aria-label="Refresh permission status"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Rollup pills — pending / approved / rejected / flagged-for-review.
          The flagged count overlaps approved+pending (it's exceeds_quota=true
          on any status), surfaced separately because over-quota requests are
          the ones that need the most attention from the staff and HR. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <Pill label="Pending"  count={counts.pending}  color="#A16207" bg="#FEF3C7" Icon={Clock} />
        <Pill label="Approved" count={counts.approved} color="#0F4C2A" bg="#ECFDF5" Icon={CheckCircle2} />
        <Pill label="Rejected" count={counts.rejected} color="#B91C1C" bg="#FEE2E2" Icon={XCircle} />
        <Pill label="Flagged"  count={counts.flagged}  color="#9A3412" bg="#FFEDD5" Icon={AlertTriangle} />
      </div>

      {/* Per-application list — each row is clickable, opens read-only
          timeline modal showing the 4 approval stages. */}
      <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
        {rows.map(r => <Row key={r.id} row={r} onClick={() => setOpenRow(r)} />)}
      </ul>

      {openRow && (
        <PermissionTimelineModal
          row={openRow}
          onClose={() => setOpenRow(null)}
        />
      )}
    </section>
  );
}

// ── Helper components ──────────────────────────────────────────────────────

function Pill({ label, count, color, bg, Icon }) {
  return (
    <div
      className="rounded-lg px-3 py-2 border"
      style={{ background: bg, borderColor: 'var(--border-soft)' }}
    >
      <div className="flex items-center gap-1.5" style={{ color }}>
        <Icon className="w-3 h-3" />
        <span className="text-[10px]" style={{ letterSpacing: '0.18em', fontWeight: 700 }}>
          {label.toUpperCase()}
        </span>
      </div>
      <div className="text-xl mt-0.5 tabular-nums" style={{ color, fontWeight: 600 }}>
        {count}
      </div>
    </div>
  );
}

// Stage-aware pill metadata. Falls through to legacy `status` for any rows
// that haven't yet had `stage` populated (defensive — the backfill in
// migration_permissions_two_step.sql should have set every existing row).
const STAGE_META = {
  pending_manager:     { label: 'AWAITING MANAGER', color: '#A16207', bg: '#FEF3C7', Icon: Clock },
  pending_hr:          { label: 'AWAITING HR',      color: '#1D4ED8', bg: '#DBEAFE', Icon: Clock },
  approved:            { label: 'APPROVED',         color: '#0F4C2A', bg: '#ECFDF5', Icon: CheckCircle2 },
  rejected_by_manager: { label: 'REJECTED · MGR',   color: '#B91C1C', bg: '#FEE2E2', Icon: XCircle },
  rejected_by_hr:      { label: 'REJECTED · HR',    color: '#B91C1C', bg: '#FEE2E2', Icon: XCircle },
  cancelled:           { label: 'CANCELLED',        color: '#737373', bg: '#F5F5F5', Icon: XCircle },
};

function Row({ row, onClick }) {
  const typeMeta = TYPE_META[row.type] || TYPE_META.late_arrival;
  // Prefer stage; fall back to legacy status if stage not yet populated
  const stageMeta = STAGE_META[row.stage]
                  || STATUS_META[row.status]
                  || STATUS_META.pending;
  const TypeIcon   = typeMeta.Icon;
  const StatusIcon = stageMeta.Icon;

  // Date formatting — show "Sun 3 May 2026" so the staff can spot the day at
  // a glance without having to mentally convert YYYY-MM-DD.
  const [y, m, d] = String(row.permission_date).split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()];
  const pretty = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left py-2.5 flex items-start gap-3 text-xs hover:bg-black/[0.02] rounded transition-colors px-1 -mx-1"
        aria-label={`Open progress timeline for ${typeMeta.label} on ${pretty}`}
      >
        {/* Type badge — colored circle with the matching icon */}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: typeMeta.bg, color: typeMeta.color, border: `1px solid ${typeMeta.bg}` }}
        >
          <TypeIcon className="w-4 h-4" />
        </div>

        <div className="flex-1 min-w-0">
          {/* Title row: type + date + hours */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium" style={{ color: '#1F1B16' }}>
              {typeMeta.label}
            </span>
            <span style={{ color: '#1F1B16' }}>·</span>
            <span style={{ color: '#1F1B16' }}>{dow} {pretty}</span>
            <span style={{ color: '#1F1B16' }}>·</span>
            <span className="tabular-nums" style={{ color: '#1F1B16' }}>
              {Number(row.hours)}h
            </span>
            {row.exceeds_quota && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded-full inline-flex items-center gap-1"
                style={{ background: '#FFEDD5', color: '#9A3412', fontWeight: 700, letterSpacing: '0.1em' }}
              >
                <AlertTriangle className="w-2.5 h-2.5" /> OVER QUOTA
              </span>
            )}
          </div>

          {/* Reason — short tap target hint at the end so users learn the row is clickable */}
          {row.reason && (
            <div className="mt-1" style={{ color: '#1F1B16' }}>
              <em>"{row.reason}"</em>
            </div>
          )}
          <div className="text-[10px] mt-1 opacity-60" style={{ color: '#1F1B16' }}>
            Tap to see approval progress
          </div>
        </div>

        {/* Stage pill */}
        <span
          className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1 flex-shrink-0 whitespace-nowrap"
          style={{ background: stageMeta.bg, color: stageMeta.color, fontWeight: 700, letterSpacing: '0.1em' }}
        >
          <StatusIcon className="w-2.5 h-2.5" /> {stageMeta.label}
        </span>
      </button>
    </li>
  );
}
