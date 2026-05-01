import React, { useState, useMemo } from 'react';
import {
  RefreshCw, Clock, CheckCircle2, XCircle, AlertTriangle,
  Palmtree, Sunrise, Sunset, Users2, Check, X,
} from 'lucide-react';
import { fmtDateShort } from '../lib/leaveLogic.js';
import { PERMISSION_TYPES } from '../lib/permissionLogic.js';
import LeaveTimelineModal from './LeaveTimelineModal.jsx';
import PermissionTimelineModal from './PermissionTimelineModal.jsx';

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
  const stage  = item.stage  || (item.status === 'approved' ? 'approved' : 'pending_manager');
  const status = item.status || (stage === 'approved' ? 'approved' : 'pending');
  if (status === 'approved' || stage === 'approved') {
    return { label: 'Approved',           color: '#0F4C2A', bg: '#ECFDF5' };
  }
  if (status === 'rejected' || /^rejected/.test(stage)) {
    const where = stage === 'rejected_by_substitute' ? 'Substitute declined'
               : stage === 'rejected_by_manager'    ? 'Rejected by manager'
               : stage === 'rejected_by_hr'         ? 'Rejected by HR'
               :                                       'Rejected';
    return { label: where, color: '#B91C1C', bg: '#FEE2E2' };
  }
  if (stage === 'pending_substitutes') return { label: 'Awaiting substitutes', color: '#92400E', bg: '#FEF3C7' };
  if (stage === 'pending_manager')     return { label: 'Awaiting manager',     color: '#9A3412', bg: '#FFEDD5' };
  if (stage === 'pending_hr')          return { label: 'Awaiting HR',          color: '#7C2D12', bg: '#FED7AA' };
  return { label: 'Pending', color: '#92400E', bg: '#FEF3C7' };
}

// Type-icon mapping — each item gets a small coloured circle that signals
// what kind of application it is. Mirrors the colour scheme used on the
// admin dashboard tiles for consistency.
function iconFor(item) {
  if (item._kind === 'leave') {
    return { Icon: Palmtree, color: '#0F4C2A', bg: '#ECFDF5' };
  }
  if (item.type === 'late_arrival') {
    return { Icon: Sunrise,  color: '#A16207', bg: '#FEF3C7' };
  }
  return   { Icon: Sunset,   color: '#BE185D', bg: '#FCE7F3' };
}

// Sort key — most recent activity first. We use the most-meaningful
// timestamp on the row: hr_decided_at > manager_decided_at > requested_at
// > created_at. That way an item that just got HR-approved bubbles up
// even if it was submitted weeks ago.
function sortKey(item) {
  return new Date(
    item.hr_decided_at || item.manager_decided_at || item.requested_at || item.created_at || 0
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
  const [refreshing, setRefreshing] = useState(false);

  // Combine leaves + permissions, tag each with _kind for downstream
  // rendering, sort newest-activity-first.
  const items = useMemo(() => {
    const ls = (requests || [])
      .filter(r => r.employee_id === me?.id)
      .map(r => ({ ...r, _kind: 'leave' }));
    const ps = (permissions || [])
      .filter(p => p.employee_id === me?.id)
      .map(p => ({ ...p, _kind: 'permission' }));
    return [...ls, ...ps].sort((a, b) => sortKey(b) - sortKey(a));
  }, [requests, permissions, me?.id]);

  const counts = useMemo(() => {
    const c = { all: items.length, pending: 0, approved: 0, rejected: 0 };
    for (const it of items) {
      const status = it.status || (it.stage === 'approved' ? 'approved' : 'pending');
      if (status === 'approved' || it.stage === 'approved') c.approved++;
      else if (status === 'rejected' || /^rejected/.test(it.stage || '')) c.rejected++;
      else c.pending++;
    }
    return c;
  }, [items]);

  const visible = useMemo(() => {
    if (filter === 'all') return items;
    return items.filter(it => {
      const status = it.status || (it.stage === 'approved' ? 'approved' : 'pending');
      if (filter === 'approved')  return status === 'approved' || it.stage === 'approved';
      if (filter === 'rejected')  return status === 'rejected' || /^rejected/.test(it.stage || '');
      return status === 'pending' || (it.stage && /^pending/.test(it.stage));
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
      className="rounded-xl border p-5 esau-card"
      style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}
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
                if (item._kind === 'leave') setOpenLeave(item);
                else                        setOpenPerm(item);
              }}
            />
          ))}
        </ul>
      )}

      {/* Modals */}
      {openLeave && (
        <LeaveTimelineModal
          request={openLeave}
          empMap={empMap}
          leaveTypes={leaveTypes}
          onClose={() => setOpenLeave(null)}
        />
      )}
      {openPerm && (
        <PermissionTimelineModal
          row={openPerm}
          employee={empMap[openPerm.employee_id]}
          onClose={() => setOpenPerm(null)}
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
  // permissions, use 'Late Arrival' / 'Early Leave'.
  const title = item._kind === 'leave'
    ? (leaveTypes.find(t => t.id === item.leave_type_id)?.name || 'Leave')
    : (PERMISSION_TYPES[item.type]?.label || item.type);

  // Date string — leaves use start→end, permissions use single date.
  const dateStr = item._kind === 'leave'
    ? `${fmtDateShort(item.start_date)} → ${fmtDateShort(item.end_date)} · ${item.days} day${item.days !== 1 ? 's' : ''}`
    : `${fmtDateShort(item.permission_date)}${item.time_from && item.time_to ? `  ·  ${item.time_from}–${item.time_to}` : ''}  ·  ${Number(item.hours)} hr${Number(item.hours) === 1 ? '' : 's'}`;

  // Inline substitute progress strip for leaves at pending_substitutes
  // — replaces the standalone wait card. Hidden for any other kind/stage.
  const showSubProgress =
    item._kind === 'leave'
    && item.stage === 'pending_substitutes'
    && (item.substitute_ids || []).length > 0;

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
              {item._kind === 'leave' ? 'LEAVE' : 'PERMISSION'}
            </span>
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
