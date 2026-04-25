import React, { useState, useMemo } from 'react';
import { Search, Download, Plus, Check, X, ClipboardList } from 'lucide-react';
import { fmtDateShort, todayISO } from '../lib/leaveLogic.js';
import { Card, Avatar, Pill, Empty } from './Dashboard.jsx';

export default function Requests({ requests, leaveTypes, typeMap, empMap, onDecide, onDelete, onNewRequest }) {
  const [filter, setFilter] = useState('pending');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);

  const filtered = useMemo(() => {
    return requests
      .filter(r => filter === 'all' ? true : r.status === filter)
      .filter(r => {
        if (!search) return true;
        const emp = empMap[r.employee_id];
        const s = search.toLowerCase();
        return emp?.name.toLowerCase().includes(s) || emp?.id.toLowerCase().includes(s);
      });
  }, [requests, filter, search, empMap]);

  const counts = {
    pending:  requests.filter(r => r.status === 'pending').length,
    approved: requests.filter(r => r.status === 'approved').length,
    rejected: requests.filter(r => r.status === 'rejected').length,
    all:      requests.length,
  };

  const act = async (id, status, note) => {
    setBusyId(id);
    try { await onDecide(id, status, note); }
    catch (e) { alert(e.message || 'Failed'); }
    finally { setBusyId(null); }
  };

  const remove = async (id) => {
    if (!confirm('Delete this request permanently?')) return;
    setBusyId(id);
    try { await onDelete(id); }
    catch (e) { alert(e.message || 'Failed'); }
    finally { setBusyId(null); }
  };

  const exportCSV = () => {
    const rows = [['Request ID','Employee ID','Employee Name','Location','Department','Leave Type','Start','End','Days','Status','Reason','Submitted','Decided At','Decided By']];
    filtered.forEach(r => {
      const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
      rows.push([
        r.id, emp?.id || '', emp?.name || '', emp?.location || '', emp?.department || '',
        tp?.name || r.leave_type_id, r.start_date, r.end_date, r.days, r.status, r.reason || '',
        r.requested_at || '', r.decided_at || '', r.decided_by || ''
      ]);
    });
    const csv = rows.map(row => row.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `leave-requests-${todayISO()}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] tracking-[0.25em] opacity-50 mb-2">LEAVE REQUESTS</div>
          <h1 className="serif text-4xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>Manage requests</h1>
        </div>
        <div className="flex gap-2">
          <button onClick={exportCSV}
            className="flex items-center gap-2 px-3 py-2 rounded-full text-sm border"
            style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
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
          {filtered.map(r => {
            const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
            if (!emp) return null;
            const isBusy = busyId === r.id;
            return (
              <div key={r.id} className="rounded-xl border p-4 flex flex-wrap items-center gap-4"
                   style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
                <Avatar id={emp.id} name={emp.name} size="lg"/>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="serif text-lg leading-tight" style={{ fontWeight: 500 }}>{emp.name}</div>
                    <span className="text-xs opacity-50 mono">{emp.id}</span>
                  </div>
                  <div className="text-xs opacity-60 mt-0.5">{emp.department} · {emp.location}</div>
                </div>
                <div className="text-right">
                  <Pill color={tp?.color}>{tp?.name || r.leave_type_id}</Pill>
                  <div className="text-sm mt-1">{fmtDateShort(r.start_date)} → {fmtDateShort(r.end_date)}</div>
                  <div className="text-xs opacity-60">{r.days} {Number(r.days) === 1 ? 'day' : 'days'}{r.is_half_day ? ' (½)' : ''}</div>
                </div>
                {r.reason && (
                  <div className="w-full text-sm px-3 py-2 rounded italic opacity-75"
                       style={{ background: 'var(--paper-2)' }}>
                    "{r.reason}"
                  </div>
                )}
                {r.decision_note && (
                  <div className="w-full text-xs px-3 py-2 rounded opacity-75"
                       style={{ background: 'var(--paper-2)' }}>
                    <strong>Note:</strong> {r.decision_note}
                  </div>
                )}
                <div className="flex gap-2 w-full sm:w-auto">
                  {r.status === 'pending' ? (
                    <>
                      <button onClick={() => act(r.id, 'approved')} disabled={isBusy}
                        className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-sm disabled:opacity-50"
                        style={{ background: 'var(--evergreen-500)', color: 'var(--paper)' }}>
                        <Check className="w-4 h-4"/> Approve
                      </button>
                      <button onClick={() => {
                        const note = prompt('Reason for rejection (optional):');
                        if (note !== null) act(r.id, 'rejected', note);
                      }} disabled={isBusy}
                        className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-full text-sm border disabled:opacity-50"
                        style={{ borderColor: 'var(--clay)', color: 'var(--clay)' }}>
                        <X className="w-4 h-4"/> Reject
                      </button>
                    </>
                  ) : (
                    <>
                      <Pill color={r.status === 'approved' ? 'var(--evergreen-500)' : 'var(--clay)'}>
                        {r.status === 'approved' ? '✓ Approved' : '✗ Rejected'}
                      </Pill>
                      <button onClick={() => remove(r.id)} disabled={isBusy}
                        className="text-xs opacity-40 hover:opacity-80 px-2">Delete</button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
