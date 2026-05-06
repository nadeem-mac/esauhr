import React, { useState, useMemo } from 'react';
import {
  RefreshCw, Clock, CheckCircle2, XCircle, AlertTriangle,
  Palmtree, Sunrise, Sunset, Users2, Check, X, ArrowLeftCircle, HeartPulse,
} from 'lucide-react';
import { fmtDateShort, findRejectionReason } from '../lib/leaveLogic.js';
import { PERMISSION_TYPES } from '../lib/permissionLogic.js';
import LeaveTimelineModal from './LeaveTimelineModal.jsx';
import PermissionTimelineModal from './PermissionTimelineModal.jsx';
import RejoiningTimelineModal from './RejoiningTimelineModal.jsx';

// =============================================================================
// MyApplicationsCard
//
// Single unified card replacing four previous cards on the staff landing
// page (Permission 'Your applications', Shift 'Recent activity', the
// substitute wait card, and the legacy 'RECENT LEAVE REQUESTS' list).
// All four were showing slices of the same thing — what the staff member
// has applied for and where each item sits in the approval chain.
//
// One card. One row per item. Each row knows its kind (leave or
// permission), its current stage, and renders an inline status pill plus
// — for leave rows at pending_substitutes — the per-substitute mini-pills
// so the requester can see exactly who hasn't responded yet without a
// second card.
//
// Click any row to open the matching timeline modal (LeaveTimelineModal
// for leaves, PermissionTimelineModal for permissions). Filter chips at
// the top let the user scope to all / pending / approved / rejected.
//
// Self-contained for data — receives requests + permissions + empMap +
// leaveTypes from the parent dashboard (which already loads them) and
// derives everything in a useMemo. No fetches, no extra realtime subs.
// =============================================================================

// Stage-to-status-pill mapping. Returns { label, color, bg }. Values
// chosen so pending_* shades go warm (amber → orange → deeper orange as
// the request moves up the chain), final states go green/red.
function pillFor(item) {
  // Rejoining items use return_* fields, not stage/status.
  if (item._kind === 'rejoin') {
    const rs = item.return_stage;
    if (rs === 'approved')              return { label: 'Approved',           color: '#0F4C2A', bg: '#ECFDF5' };
    if (rs === 'rejected_by_manager')   return { label: 'Sent back by manager', color: '#B91C1C', bg: '#FEE2E2' };
    if (rs === 'rejected_by_hr')        return { label: 'Sent back by HR',     color: '#B91C1C', bg: '#FEE2E2' };
    if (rs === 'pending_manager')       return { label: 'Awaiting manager',    color: '#9A3412', bg: '#FFEDD5' };
    if (rs === 'pending_hr')            return { label: 'Awaiting HR',         color: '#7C2D12', bg: '#FED7AA' };
    return { label: 'Pending', color: '#92400E', bg: '#FEF3C7' };
  }

  // STAGE IS THE SOURCE OF TRUTH.
  // The previous implementation checked status === 'rejected' BEFORE
  // checking individual stage values. That meant a row whose `status`
  // field was somehow 'rejected' (legacy data, mismatched trigger
  // output, manual DB edit, etc.) would show "Rejected" even when
  // stage clearly indicated the row was still in progress (e.g.
  // stage='pending_manager'). User reported this exact mis-match:
  // a freshly submitted sick leave appeared as "Rejected" without
  // ever reaching Bashaier.
  //
  // The new order:
  //   1. Match against known stage values directly. Each stage maps
  //      to a single, unambiguous pill.
  //   2. Only fall back to `status` when stage is null / unrecognised
  //      / undefined — the safety net for malformed rows.
  //
  // This means the worst case is a row showing "Pending" instead of
  // its true terminal state, which is much less harmful than showing
  // "Rejected" on an in-progress row.
  const stage = item.stage;

  if (stage === 'approved')               return { label: 'Approved',                color: '#0F4C2A', bg: '#ECFDF5' };
  if (stage === 'pending_substitutes')    return { label: 'Awaiting substitutes',    color: '#92400E', bg: '#FEF3C7' };
  if (stage === 'pending_manager')        return { label: 'Awaiting manager',        color: '#9A3412', bg: '#FFEDD5' };
  if (stage === 'pending_hr')             return { label: 'Awaiting HR',             color: '#7C2D12', bg: '#FED7AA' };
  // Sick declaration sitting in 'pending_certificate' stage —
  // staff has registered the sick day but hasn't uploaded a Sehhaty
  // cert yet. Distinct from pending_manager so the staff knows what
  // they need to do (submit the cert) vs. wait for someone else.
  if (stage === 'pending_certificate')    return { label: 'Awaiting certificate',    color: '#991B1B', bg: '#FEE2E2' };
  if (stage === 'rejected_by_substitute') return { label: 'Substitute declined',     color: '#B91C1C', bg: '#FEE2E2' };
  if (stage === 'rejected_by_manager')    return { label: 'Rejected by manager',     color: '#B91C1C', bg: '#FEE2E2' };
  if (stage === 'rejected_by_hr')         return { label: 'Rejected by HR',          color: '#B91C1C', bg: '#FEE2E2' };
  if (stage === 'cancelled')              return { label: 'Cancelled',               color: '#6B7280', bg: '#F3F4F6' };
  if (stage === 'expired')                return { label: 'Expired',                 color: '#6B7280', bg: '#F3F4F6' };

  // Legacy / unknown stage — fall back to status field.
  if (item.status === 'approved')         return { label: 'Approved',                color: '#0F4C2A', bg: '#ECFDF5' };
  if (item.status === 'rejected')         return { label: 'Rejected',                color: '#B91C1C', bg: '#FEE2E2' };
  return { label: 'Pending', color: '#92400E', bg: '#FEF3C7' };
}

// Type-icon mapping — each item gets a small coloured circle that signals
// what kind of application it is. Mirrors the colour scheme used on the
// admin dashboard tiles for consistency.
//
// Sick leaves get their own icon (HeartPulse, red-toned) so they're
// distinguishable from regular vacation/annual leave at a glance.
// Otherwise sick days look identical to a vacation in the list and
// the staff can't visually parse "this red-pill row is my sick
// declaration" from "this green-pill row is my approved annual leave".
function iconFor(item) {
  if (item._kind === 'rejoin') {
    return { Icon: ArrowLeftCircle, color: '#0F4C2A', bg: '#D1FAE5' };
  }
  if (item._kind === 'leave') {
    if (item.leave_type_id === 'sick') {
      return { Icon: HeartPulse, color: '#B91C1C', bg: '#FEE2E2' };
    }
    return { Icon: Palmtree, color: '#0F4C2A', bg: '#ECFDF5' };
  }
  if (item.type === 'late_arrival') {
    return { Icon: Sunrise,  color: '#A16207', bg: '#FEF3C7' };
  }
  return   { Icon: Sunset,   color: '#BE185D', bg: '#FCE7F3' };
}

// Sort key — most recent activity first. We use the most-meaningful
// Pick the most informative timestamp on the row for sorting + the
// 90-day visibility window in MyApplicationsCard.
//
// FALLBACK CHAIN
//   leave / sick:
//     hr_decided_at → manager_decided_at → requested_at →
//     sick_declared_at → created_at → start_date → 0
//
//   permission:
//     hr_decided_at → manager_decided_at → requested_at →
//     created_at → permission_date → 0
//
//   rejoining (synthetic on top of an approved leave):
//     return_hr_decided_at → return_manager_decided_at →
//     return_submitted_at  → actual_return_date → 0
//
// Why the date-column fallback (start_date / permission_date)?
// Older rows may have null requested_at and no created_at default.
// Without a fallback the function returns 0 (1970-01-01) and the
// 90-day window filter excludes the row from the staff's visible
// list. Every leave row has a start_date and every permission has
// a permission_date — these are required schema fields — so falling
// back to them guarantees the row sorts somewhere sensible. The
// date-only YYYY-MM-DD strings parse as midnight UTC, which is fine
// for ordinal comparison even when paired with full ISO timestamps.
function sortKey(item) {
  if (item._kind === 'rejoin') {
    return new Date(
      item.return_hr_decided_at || item.return_manager_decided_at ||
      item.return_submitted_at  || item.actual_return_date || 0
    ).getTime();
  }
  if (item._kind === 'permission') {
    return new Date(
      item.hr_decided_at || item.manager_decided_at ||
      item.requested_at || item.created_at ||
      item.permission_date || 0
    ).getTime();
  }
  // leave (regular or sick)
  return new Date(
    item.hr_decided_at || item.manager_decided_at ||
    item.requested_at || item.sick_declared_at ||
    item.created_at   || item.start_date || 0
  ).getTime();
}

export default function MyApplicationsCard({
  me,
  requests = [],
  permissions = [],
  empMap = {},
  leaveTypes = [],
  onRefresh,
}) {
  const [filter, setFilter]       = useState('all');
  const [openLeave, setOpenLeave] = useState(null);
  const [openPerm,  setOpenPerm]  = useState(null);
  const [openRejoin, setOpenRejoin] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  // Combine leaves + permissions + synthesized rejoining entries, tag
  // each with _kind, apply 90-day visibility cutoff, sort newest first.
  //
  // Rejoining is a sub-state of an approved leave row, not its own table —
  // so we project a virtual 'rejoin' item from any leave row that has
  // return_stage set. The user sees their leave AND their rejoining as
  // separate entries with their own status/timeline. Same UX as having
  // them be distinct records, no schema change.
  const items = useMemo(() => {
    // 90-day cutoff — staff sees activity from the last 90 days; older
    // records live in HR's archive and no longer clutter the personal view.
    const cutoff = Date.now() - 90 * 86_400_000;
    const inWindow = (k) => k >= cutoff;

    const ls = (requests || [])
      .filter(r => r.employee_id === me?.id)
      .map(r => ({ ...r, _kind: 'leave' }))
      .filter(it => inWindow(sortKey(it)));

    const ps = (permissions || [])
      .filter(p => p.employee_id === me?.id)
      .map(p => ({ ...p, _kind: 'permission' }))
      .filter(it => inWindow(sortKey(it)));

    // Rejoining synthetic items — one per leave row whose rejoining
    // workflow has been started (return_stage IS NOT NULL). The leave
    // itself stays in the list; this just adds a sibling entry showing
    // the rejoining's own progress.
    const rs = (requests || [])
      .filter(r => r.employee_id === me?.id && !!r.return_stage)
      .map(r => ({ ...r, _kind: 'rejoin' }))
      .filter(it => inWindow(sortKey(it)));

    return [...ls, ...ps, ...rs].sort((a, b) => sortKey(b) - sortKey(a));
  }, [requests, permissions, me?.id]);

  const counts = useMemo(() => {
    const c = { all: items.length, pending: 0, approved: 0, rejected: 0 };
    for (const it of items) {
      if (it._kind === 'rejoin') {
        if (it.return_stage === 'approved')                c.approved++;
        else if (/^rejected/.test(it.return_stage || ''))   c.rejected++;
        else                                                c.pending++;
        continue;
      }
      // Stage-first bucketing — same rationale as pillFor. The previous
      // logic checked status first, which mis-classified rows where
      // status was somehow 'rejected' but stage was still pending_*.
      const stage = it.stage;
      if (stage === 'approved') c.approved++;
      else if (/^rejected/.test(stage || '')) c.rejected++;
      else if (stage && /^(pending_|cancelled|expired)/.test(stage)) c.pending++;
      // Fall back to status only when stage is missing/unknown.
      else if (it.status === 'approved') c.approved++;
      else if (it.status === 'rejected') c.rejected++;
      else c.pending++;
    }
    return c;
  }, [items]);

  const visible = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter(it => {
      if (it._kind === 'rejoin') {
        if (filter === 'approved')  return it.return_stage === 'approved';
        if (filter === 'rejected')  return /^rejected/.test(it.return_stage || '');
        return /^pending/.test(it.return_stage || '');
      }
      // Stage-first matching. Same rationale as pillFor / counts: the
      // status field can be stale or wrong (legacy rows, trigger
      // mismatches); stage is the truth.
      const stage = it.stage;
      if (filter === 'approved') {
        if (stage === 'approved') return true;
        if (stage) return false;            // any other recognised stage = not approved
        return it.status === 'approved';     // fall back only when stage is null
      }
      if (filter === 'rejected') {
        if (/^rejected/.test(stage || '')) return true;
        if (stage) return false;
        return it.status === 'rejected';
      }
      // Pending bucket — anything in a pending_* stage, or cancelled / expired,
      // or unknown stage with status='pending'.
      if (stage && /^(pending_|cancelled|expired)/.test(stage)) return true;
      return !stage && (it.status === 'pending' || !it.status);
    });
  }, [items, filter]);

  async function handleRefresh() {
    if (!onRefresh) return;
    setRefreshing(true);
    try { await onRefresh(); }
    finally { setRefreshing(false); }
  }

  return (
    <section
      id="your-applications"
      className="rounded-xl border p-5 esau-card"
      style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-4 pb-3 border-b"
           style={{ borderColor: 'var(--border-soft)' }}>
        <div>
          <div className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
            YOUR APPLICATIONS
          </div>
          <h3 className="serif text-lg mt-0.5" style={{ fontWeight: 500, color: '#1F1B16' }}>
            Leaves and permissions
          </h3>
          <div className="text-xs mt-1" style={{ color: '#1F1B16' }}>
            Click any row to see its full approval progress.
          </div>
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="p-1.5 rounded-full border opacity-70 hover:opacity-100 disabled:opacity-40"
            title="Refresh"
            aria-label="Refresh applications"
            style={{ borderColor: 'var(--border-soft)' }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {/* Filter chips — All / Pending / Approved / Rejected. Active chip
          gets the ink fill; counts always visible. */}
      <div className="flex gap-1.5 mb-4 flex-wrap">
        {['all', 'pending', 'approved', 'rejected'].map(f => {
          const active = filter === f;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className="text-xs px-3 py-1.5 rounded-full transition-colors"
              style={{
                background: active ? 'var(--ink)' : 'transparent',
                color: active ? 'var(--paper)' : '#1F1B16',
                border: `1px solid ${active ? 'var(--ink)' : 'var(--border-soft)'}`,
                fontWeight: active ? 600 : 500,
              }}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)} <span className="opacity-60 ml-1">{counts[f]}</span>
            </button>
          );
        })}
      </div>

      {visible.length === 0 ? (
        <div className="text-center py-8 text-sm" style={{ color: '#1F1B16', opacity: 0.6 }}>
          {filter === 'all'
            ? "You haven't submitted any applications yet."
            : `No ${filter} applications.`}
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
          {visible.map(item => (
            <Row
              key={`${item._kind}-${item.id}`}
              item={item}
              empMap={empMap}
              leaveTypes={leaveTypes}
              onClick={() => {
                if (item._kind === 'leave')       setOpenLeave(item);
                else if (item._kind === 'rejoin') setOpenRejoin(item);
                else                              setOpenPerm(item);
              }}
            />
          ))}
        </ul>
      )}

      {/* Footer note — staff sees 90 days of activity here. Older
          applications are kept in HR records but no longer surface
          on the personal landing page so the list stays focused on
          recent / actionable items. */}
      {items.length > 0 && (
        <div className="mt-4 pt-3 text-[10px] italic text-center"
             style={{ color: '#1F1B16', opacity: 0.6, borderTop: '1px dashed var(--border-soft, #E5E5E5)' }}>
          Showing your applications from the last 90 days · Older records are archived in HR
        </div>
      )}

      {/* Modals */}
      {openLeave && (
        <LeaveTimelineModal
          request={openLeave}
          empMap={empMap}
          leaveTypes={leaveTypes}
          requesterIsHr={!!me?.is_hr_reviewer}
          requesterIsManager={Object.values(empMap).some(e => e?.manager_id === me?.id)}
          onClose={() => setOpenLeave(null)}
        />
      )}
      {openPerm && (
        <PermissionTimelineModal
          row={openPerm}
          employee={empMap[openPerm.employee_id]}
          requesterIsHr={!!me?.is_hr_reviewer}
          requesterIsManager={Object.values(empMap).some(e => e?.manager_id === me?.id)}
          onClose={() => setOpenPerm(null)}
        />
      )}
      {openRejoin && (
        <RejoiningTimelineModal
          request={openRejoin}
          empMap={empMap}
          onClose={() => setOpenRejoin(null)}
        />
      )}
    </section>
  );
}

// ─── Row ──────────────────────────────────────────────────────────────────────
function Row({ item, empMap, leaveTypes, onClick }) {
  const { Icon, color, bg } = iconFor(item);
  const pill = pillFor(item);

  // Title varies by kind. For leaves, use the leave-type name. For
  // permissions, 'Late Arrival' / 'Early Leave'. For rejoinings,
  // 'Rejoining (<leave type>)'.
  const leaveTypeName = leaveTypes.find(t => t.id === item.leave_type_id)?.name;
  const title =
    item._kind === 'leave'  ? (leaveTypeName || 'Leave')
  : item._kind === 'rejoin' ? `Rejoining${leaveTypeName ? ` (${leaveTypeName})` : ''}`
  :                           (PERMISSION_TYPES[item.type]?.label || item.type);

  // Date string per kind.
  const dateStr =
    item._kind === 'leave'
      ? `${fmtDateShort(item.start_date)} → ${fmtDateShort(item.end_date)} · ${item.days} day${item.days !== 1 ? 's' : ''}`
    : item._kind === 'rejoin'
      ? `Returned ${fmtDateShort(item.actual_return_date)}${item.balance_after > 0 ? ` · +${item.balance_after}d credited back` : ''}`
    : `${fmtDateShort(item.permission_date)}${item.time_from && item.time_to ? `  ·  ${item.time_from}–${item.time_to}` : ''}  ·  ${Number(item.hours)} hr${Number(item.hours) === 1 ? '' : 's'}`;

  // Kind tag label
  const kindLabel =
    item._kind === 'leave'  ? 'LEAVE'
  : item._kind === 'rejoin' ? 'REJOINING'
  :                           'PERMISSION';

  // Backdated indicator — when a permission's date is earlier than the
  // request's requested_at date, the staff filed it retroactively
  // (covered by the "submit a permission for today's punch-in" path
  // in the attendance violation emails). Only meaningful for permissions;
  // leaves can also be backdated but use a different concept (rejoining
  // for partial early returns).
  const isBackdatedPermission =
    item._kind === 'permission' &&
    item.permission_date &&
    item.requested_at &&
    item.permission_date < String(item.requested_at).slice(0, 10);

  // Inline substitute progress strip for leaves at pending_substitutes
  // — replaces the standalone wait card. Hidden for any other kind/stage.
  const showSubProgress =
    item._kind === 'leave'
    && item.stage === 'pending_substitutes'
    && (item.substitute_ids || []).length > 0;

  // Rejection reason banner — surfaces the standardised reason code
  // and any free-text note Bashaier or the manager wrote when they
  // rejected the leave. Only shown for leaves that have actually
  // been rejected and that have a reason recorded (legacy rejections
  // pre-migration won't have one; they fall back to the pill alone).
  const isRejected = (item._kind === 'leave'
    && (item.status === 'rejected' || /^rejected/.test(item.stage || '')))
    || (item._kind === 'permission'
    && (item.status === 'rejected' || /^rejected/.test(item.stage || '')));
  // Leaves use rejection_reason_code/note (curated dropdown + freeform).
  // Permissions use decision_note (single freeform comment from the
  // RejectPermissionModal). Both surface here as a single rejection
  // explanation pill so the staff member sees WHY their request was
  // declined.
  const rejectionReason = (isRejected && item._kind === 'leave')
    ? findRejectionReason(item.rejection_reason_code)
    : null;
  const rejectionNote = isRejected
    ? ((item._kind === 'permission'
        ? (item.decision_note || '')
        : (item.rejection_reason_note || '')) || '').trim()
    : '';
  const showRejection = isRejected && (rejectionReason || rejectionNote);

  return (
    <li
      className="py-3 px-2 -mx-2 rounded-lg cursor-pointer hover:bg-black/5 transition-colors"
      onClick={onClick}
      title="See approval progress"
    >
      <div className="flex items-center gap-3">
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: bg, color }}
        >
          <Icon className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm" style={{ color: '#1F1B16', fontWeight: 600 }}>{title}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: bg, color, fontWeight: 600, letterSpacing: '0.05em' }}>
              {kindLabel}
            </span>
            {isBackdatedPermission && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded-full"
                style={{ background: '#FEF3C7', color: '#92400E', fontWeight: 600, letterSpacing: '0.05em', border: '1px solid #F59E0B' }}
                title="Filed retroactively for a date that had already passed"
              >
                BACKDATED
              </span>
            )}
          </div>
          <div className="text-xs mt-0.5" style={{ color: '#1F1B16', opacity: 0.7 }}>
            {dateStr}
          </div>
        </div>
        <span
          className="text-[11px] px-2.5 py-1 rounded-full whitespace-nowrap flex-shrink-0"
          style={{ background: pill.bg, color: pill.color, fontWeight: 600 }}
        >
          {pill.label}
        </span>
      </div>

      {showRejection && (
        <div className="mt-2 ml-12 rounded-lg p-2.5"
          style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
          <div className="text-[10px] tracking-wider font-bold mb-1" style={{ color: '#B91C1C' }}>
            REASON FOR REJECTION
          </div>
          {rejectionReason && (
            <div className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
              {rejectionReason.label}
            </div>
          )}
          {rejectionNote && (
            <div className="text-[11px] mt-1" style={{ color: '#0A0A0A', opacity: 0.85 }}>
              "{rejectionNote}"
            </div>
          )}
        </div>
      )}

      {showSubProgress && (
        <div className="mt-2 pl-12 flex items-center gap-1.5 flex-wrap">
          <Users2 className="w-3 h-3" style={{ color: '#1F1B16', opacity: 0.6 }} />
          <span className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.6, letterSpacing: '0.1em', fontWeight: 700 }}>
            COVER
          </span>
          {(item.substitute_ids || []).map(sid => {
            const raw = item.substitute_decisions?.[sid];
            const dec = !raw ? 'pending' : typeof raw === 'string' ? raw : (raw.decision || 'pending');
            const accepted = dec === 'accepted';
            const declined = dec === 'declined';
            const sBg    = accepted ? '#ECFDF5' : declined ? '#FEE2E2' : '#FEF3C7';
            const sCol   = accepted ? '#0F4C2A' : declined ? '#B91C1C' : '#92400E';
            const SIcon  = accepted ? Check : declined ? X : Clock;
            return (
              <span key={sid}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                style={{ background: sBg, color: sCol, fontSize: '10px', fontWeight: 500 }}>
                <SIcon className="w-2.5 h-2.5" />
                {empMap[sid]?.name || sid}
              </span>
            );
          })}
        </div>
      )}
    </li>
  );
}
