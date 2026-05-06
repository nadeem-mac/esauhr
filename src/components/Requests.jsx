import React, { useState, useMemo } from 'react';
import { Search, Download, Plus, ClipboardList, Trash2, AlertTriangle, Clock } from 'lucide-react';
import { fmtDateShort, todayISO } from '../lib/leaveLogic.js';
import { downloadVacationFormForRequest } from '../lib/vacationForm.js';
import { Card, Avatar, Pill, Empty } from './Dashboard.jsx';
import LeaveTimelineModal from './LeaveTimelineModal.jsx';

// ─── Requests tab ─────────────────────────────────────────────────────────
// For admin (Nadeem): full company leave + permission ledger with per-row
// hard-delete. Per Nadeem: "How I can clear the applied leave of all type
// for any staff … only my ID has access to do this, where I can see all
// requests at a glance and choose to delete whatever I want." This view is
// the answer.
// For everyone else: only their own leaves and permissions, view-only
// (Cancel-style delete only on PENDING rows they own).
//
// Both kinds are merged into one chronological list with a small purple
// PERMISSION pill so the admin can scan everything in one place.

export default function Requests({
  requests,
  permissions = [],
  leaveTypes,
  typeMap,
  empMap,
  me,
  onDecide,
  onDelete,
  onDeletePermission,
  onNewRequest,
}) {
  const isAdmin = !!me?.is_admin;
  const [filter, setFilter] = useState('pending');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [timelineRequest, setTimelineRequest] = useState(null);
  // Admin-only confirm modal — replaces the browser confirm() so the row
  // being deleted is rendered in front of the user before commit.
  const [pendingDelete, setPendingDelete] = useState(null);

  // Merge leaves and permissions into a unified item list. Each item
  // carries a `_kind` discriminator so render code branches cleanly.
  const items = useMemo(() => {
    const leaves = (requests || []).map(r => ({
      ...r,
      _kind: 'leave',
      _ts: new Date(r.requested_at || r.created_at || r.start_date || 0).getTime(),
    }));
    const perms  = (permissions || []).map(p => ({
      ...p,
      _kind: 'permission',
      _ts: new Date(p.requested_at || p.created_at || p.permission_date || 0).getTime(),
    }));
    return [...leaves, ...perms].sort((a, b) => b._ts - a._ts);
  }, [requests, permissions]);

  const filtered = useMemo(() => {
    return items
      .filter(it => filter === 'all' ? true : it.status === filter)
      .filter(it => {
        if (!search) return true;
        const emp = empMap[it.employee_id];
        const s = search.toLowerCase();
        return emp?.name?.toLowerCase().includes(s) || emp?.id?.toLowerCase().includes(s);
      });
  }, [items, filter, search, empMap]);

  const counts = {
    pending:  items.filter(it => it.status === 'pending').length,
    approved: items.filter(it => it.status === 'approved').length,
    rejected: items.filter(it => it.status === 'rejected').length,
    all:      items.length,
  };

  const requestDelete = (item) => {
    setPendingDelete(item);
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setBusyId(pendingDelete.id);
    try {
      if (pendingDelete._kind === 'permission') {
        if (typeof onDeletePermission === 'function') await onDeletePermission(pendingDelete.id);
      } else {
        if (typeof onDelete === 'function') await onDelete(pendingDelete.id);
      }
      setPendingDelete(null);
    } catch (e) {
      alert(e?.message || 'Failed');
    } finally {
      setBusyId(null);
    }
  };

  const exportCSV = () => {
    const rows = [['Kind','ID','Employee ID','Employee Name','Location','Department','Type','Start','End','Hours/Days','Status','Reason','Submitted','Decision Note']];
    filtered.forEach(it => {
      const emp = empMap[it.employee_id];
      if (it._kind === 'permission') {
        rows.push([
          'PERMISSION', it.id, emp?.id || '', emp?.name || '', emp?.location || '', emp?.department || '',
          it.type === 'late_arrival' ? 'Late arrival' : 'Early leave',
          it.permission_date, it.permission_date,
          `${Number(it.hours)}h`, it.status, it.reason || '',
          it.requested_at || '', it.decision_note || '',
        ]);
      } else {
        const tp = typeMap[it.leave_type_id];
        rows.push([
          'LEAVE', it.id, emp?.id || '', emp?.name || '', emp?.location || '', emp?.department || '',
          tp?.name || it.leave_type_id, it.start_date, it.end_date, `${it.days}d`, it.status, it.reason || '',
          it.requested_at || '', it.decision_note || it.rejection_reason_note || '',
        ]);
      }
    });
    const csv = rows.map(row => row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `requests-${todayISO()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] tracking-[0.25em] opacity-50 mb-2">REQUESTS LEDGER</div>
          <h1 className="serif text-4xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
            {isAdmin ? 'All requests' : 'My requests'}
          </h1>
          {isAdmin && (
            <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.6 }}>
              Leaves + permissions across the whole company. Only you can delete.
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={exportCSV}
            className="flex items-center gap-2 px-3 py-2 rounded-full text-sm border"
            style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
            <Download className="w-4 h-4"/> Export
          </button>
          <button onClick={onNewRequest}
            className="flex items-center gap-2 px-4 py-2 rounded-full text-sm"
            style={{ background: 'var(--ink)', color: 'var(--paper)' }}>
            <Plus className="w-4 h-4"/> New
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        {[
          { id: 'pending',  label: 'Pending',  count: counts.pending },
          { id: 'approved', label: 'Approved', count: counts.approved },
          { id: 'rejected', label: 'Rejected', count: counts.rejected },
          { id: 'all',      label: 'All',      count: counts.all     },
        ].map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className="px-3 py-1.5 rounded-full text-sm transition-all"
            style={{
              background: filter === f.id ? 'var(--ink)' : 'transparent',
              color: filter === f.id ? 'var(--paper)' : 'var(--ink-soft)',
              border: filter === f.id ? '1px solid var(--ink)' : '1px solid var(--border-soft)',
            }}>
            {f.label} <span className="opacity-60 ml-1">{f.count}</span>
          </button>
        ))}
        <div className="relative flex-1 min-w-[200px] max-w-xs ml-auto">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-40"/>
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search employee…"
            className="w-full pl-9 pr-3 py-2 rounded-full text-sm border bg-transparent focus:outline-none"
            style={{ borderColor: 'var(--border-soft)' }}/>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card>
          <Empty icon={ClipboardList}
            message={filter === 'pending' ? 'No pending requests — all clear.' : 'No requests found.'}/>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(it => {
            const emp = empMap[it.employee_id];
            if (!emp) return null;
            const isBusy = busyId === it.id;
            const isPerm = it._kind === 'permission';
            const tp    = !isPerm ? typeMap[it.leave_type_id] : null;

            return (
              <div key={`${it._kind}-${it.id}`}
                   className="rounded-xl border p-4 flex flex-wrap items-center gap-4 cursor-pointer hover:shadow-sm transition-shadow"
                   style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}
                   onClick={() => !isPerm && setTimelineRequest(it)}
                   title={!isPerm ? 'Click to see approval progress' : ''}>
                <Avatar id={emp.id} name={emp.name} size="lg"/>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="serif text-lg leading-tight" style={{ fontWeight: 500 }}>{emp.name}</div>
                    <span className="text-xs opacity-50 mono">{emp.id}</span>
                    {isPerm && (
                      <span className="text-[9.5px] px-1.5 py-0.5 rounded-full"
                        style={{ background: '#F5F3FF', color: '#6D28D9', fontWeight: 700, letterSpacing: '0.08em' }}>
                        PERMISSION
                      </span>
                    )}
                  </div>
                  <div className="text-xs opacity-60 mt-0.5">{emp.department} · {emp.location}</div>
                </div>
                <div className="text-right">
                  {isPerm ? (
                    <>
                      <Pill color="#6D28D9">
                        {it.type === 'late_arrival' ? 'Late arrival' : 'Early leave'}
                      </Pill>
                      <div className="text-sm mt-1">{fmtDateShort(it.permission_date)}</div>
                      <div className="text-xs opacity-60 inline-flex items-center gap-1">
                        <Clock className="w-3 h-3"/> {Number(it.hours)}h
                      </div>
                    </>
                  ) : (
                    <>
                      <Pill color={tp?.color}>{tp?.name || it.leave_type_id}</Pill>
                      <div className="text-sm mt-1">{fmtDateShort(it.start_date)} → {fmtDateShort(it.end_date)}</div>
                      <div className="text-xs opacity-60">{it.days} {Number(it.days) === 1 ? 'day' : 'days'}{it.is_half_day ? ' (½)' : ''}</div>
                    </>
                  )}
                </div>
                {it.reason && (
                  <div className="w-full text-sm px-3 py-2 rounded italic opacity-75"
                       style={{ background: 'var(--paper-2)' }}>
                    "{it.reason}"
                  </div>
                )}
                {(it.decision_note || it.rejection_reason_note) && (
                  <div className="w-full text-xs px-3 py-2 rounded"
                       style={{ background: '#FEF2F2', color: '#7F1D1D', border: '1px solid #FCA5A5' }}>
                    <strong>Decision note:</strong> {it.decision_note || it.rejection_reason_note}
                  </div>
                )}
                <div className="flex items-center gap-2 w-full sm:w-auto" onClick={(e) => e.stopPropagation()}>
                  {it.status === 'pending' ? (
                    <Pill color="var(--copper)">
                      ⏳ {it.stage === 'pending_hr' ? 'Awaiting HR' :
                         it.stage === 'pending_manager' ? 'Awaiting manager' :
                         it.stage === 'pending_substitutes' ? 'Awaiting substitute' :
                         'Pending'}
                    </Pill>
                  ) : (
                    <Pill color={it.status === 'approved' ? 'var(--evergreen-500)' : 'var(--clay)'}>
                      {it.status === 'approved' ? '✓ Approved' : '✗ Rejected'}
                    </Pill>
                  )}

                  {/* Vacation form download — leaves only, approved only */}
                  {!isPerm && it.status === 'approved' && (
                    <button
                      onClick={async () => {
                        try { await downloadVacationFormForRequest(it, empMap); }
                        catch (err) { alert('Could not generate the form: ' + (err?.message || err)); }
                      }}
                      title="Download approved vacation form"
                      className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-full"
                      style={{ background: 'rgba(45,95,63,0.08)', color: '#2D5F3F', border: '1px solid rgba(45,95,63,0.25)' }}>
                      <Download className="w-3 h-3" /> Form
                    </button>
                  )}

                  {/* Admin delete — Nadeem only. Red pill, prominent.
                      Works on ANY status (pending, approved, rejected)
                      and ANY kind (leave, permission). */}
                  {isAdmin && (
                    <button onClick={() => requestDelete(it)} disabled={isBusy}
                      title="Permanently delete this request (admin only)"
                      className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full"
                      style={{
                        background: '#FEE2E2',
                        border: '1px solid #FCA5A5',
                        color: '#991B1B',
                        fontWeight: 700,
                        cursor: isBusy ? 'not-allowed' : 'pointer',
                        opacity: isBusy ? 0.5 : 1,
                      }}>
                      <Trash2 className="w-3 h-3" /> Delete
                    </button>
                  )}

                  {/* Self-cancel — non-admin can delete only their own
                      pending requests (cancel before review). */}
                  {!isAdmin && it.status === 'pending' && it.employee_id === me.id && (
                    <button onClick={() => requestDelete(it)} disabled={isBusy}
                      className="text-xs opacity-40 hover:opacity-80 px-2">Cancel</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Admin delete confirmation — replaces window.confirm() with a
          modal that renders the row being deleted, so admin sees what's
          about to disappear before clicking through. */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4"
             style={{ background: 'rgba(15,31,26,0.55)' }}
             onClick={(e) => { if (e.target === e.currentTarget) setPendingDelete(null); }}>
          <div className="bg-paper rounded-2xl w-full max-w-md fade-in p-5"
               style={{ boxShadow: '0 12px 40px rgba(31,27,22,0.2)' }}>
            <div className="flex items-start gap-2 mb-3">
              <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#991B1B' }} />
              <div>
                <div className="text-[11px] tracking-[0.2em] font-bold uppercase" style={{ color: '#991B1B' }}>
                  Permanent delete
                </div>
                <div className="text-sm mt-1" style={{ color: '#0A0A0A' }}>
                  Remove this {pendingDelete._kind === 'permission' ? 'permission' : 'leave'} request from the system?
                </div>
              </div>
            </div>
            <div className="rounded-lg p-3 mb-3 text-[12px]"
                 style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#7F1D1D' }}>
              <div style={{ fontWeight: 700 }}>
                {empMap[pendingDelete.employee_id]?.name || pendingDelete.employee_id}
              </div>
              <div className="opacity-90 mt-0.5">
                {pendingDelete._kind === 'permission'
                  ? `${pendingDelete.type === 'late_arrival' ? 'Late arrival' : 'Early leave'} · ${Number(pendingDelete.hours)}h on ${pendingDelete.permission_date}`
                  : `${typeMap[pendingDelete.leave_type_id]?.name || pendingDelete.leave_type_id} · ${pendingDelete.start_date} → ${pendingDelete.end_date} (${pendingDelete.days}d)`}
              </div>
              <div className="mt-1 opacity-75">Status: {pendingDelete.status}</div>
            </div>
            <div className="text-[11px] mb-3" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              The action will be recorded in the activity log under your name. This cannot be undone.
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPendingDelete(null)}
                className="text-[12px] px-3 py-1.5 rounded-full border"
                style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A', fontWeight: 600 }}>
                Cancel
              </button>
              <button onClick={confirmDelete} disabled={busyId === pendingDelete.id}
                className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-full"
                style={{
                  background: '#991B1B',
                  color: '#FFFFFF',
                  fontWeight: 700,
                  cursor: (busyId === pendingDelete.id) ? 'not-allowed' : 'pointer',
                  opacity: (busyId === pendingDelete.id) ? 0.5 : 1,
                }}>
                <Trash2 className="w-3 h-3" />
                {busyId === pendingDelete.id ? 'Deleting…' : 'Delete permanently'}
              </button>
            </div>
          </div>
        </div>
      )}

      {timelineRequest && (
        <LeaveTimelineModal
          request={timelineRequest}
          empMap={empMap}
          leaveTypes={leaveTypes}
          onClose={() => setTimelineRequest(null)}
        />
      )}
    </div>
  );
}
