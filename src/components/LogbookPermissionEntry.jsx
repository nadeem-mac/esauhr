// ──────────────────────────────────────────────────────────────────────
//  LogbookPermissionEntry — manual permission logging for Bashaier
//
//  Companion to the Logbook leave entry. Lets HR record a permission
//  (late arrival / early departure) that was approved offline (paper
//  form / email / verbal), writing straight to permission_requests as
//  fully approved (stage + status = 'approved', manager + HR decided
//  stamped now) so it counts toward the monthly quota and clears any
//  matching attendance flag immediately.  (Nadeem 2026-06-08)
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useMemo, useEffect } from 'react';
import { directGet, directPost, directDelete } from '../supabaseClient.js';
import { Save, Loader2, CheckCircle2, AlertCircle, Trash2, Clock } from 'lucide-react';
import { PERMISSION_TYPES } from '../lib/permissionLogic.js';
import { logAction } from '../lib/audit.js';

const toMin = (t) => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };

export default function LogbookPermissionEntry({ me, employees = [], onSaved }) {
  const [empQuery, setEmpQuery] = useState('');
  const [empId, setEmpId]       = useState('');
  const [type, setType]         = useState('late_arrival');
  const [date, setDate]         = useState('');
  const [timeFrom, setTimeFrom] = useState('');
  const [timeTo, setTimeTo]     = useState('');
  const [reason, setReason]     = useState('');
  const [busy, setBusy]         = useState(false);
  const [msg, setMsg]           = useState(null);
  const [recent, setRecent]     = useState([]);
  const [deletingId, setDeletingId] = useState(null);

  const empMatches = useMemo(() => {
    const q = (empQuery || '').trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return (employees || [])
      .filter(e => e.id?.toLowerCase().includes(q) || (e.name || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [empQuery, employees]);

  const selectedEmp = useMemo(() => (employees || []).find(e => e.id === empId), [empId, employees]);

  const durationMin = useMemo(() => {
    const a = toMin(timeFrom), b = toMin(timeTo);
    if (a == null || b == null) return NaN;
    return b - a;
  }, [timeFrom, timeTo]);
  const hours = useMemo(() => (Number.isNaN(durationMin) || durationMin <= 0 ? 0 : Math.round((durationMin / 60) * 10) / 10), [durationMin]);

  const timeError =
    Number.isNaN(durationMin) ? 'Pick a start and end time.' :
    durationMin <= 0          ? 'End time must be after start time.' :
    durationMin < 15          ? 'Minimum permission window is 15 minutes.' :
    durationMin > 60          ? 'Each permission must not exceed 60 minutes (company policy).' :
    '';

  const canSave = !!empId && !!date && !timeError && !busy;

  // Recent manual permission entries
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'permission_requests',
          `select=id,employee_id,type,permission_date,time_from,time_to,hours,reason,stage,hr_decided_at`
          + `&reason=ilike.Manual entry*`
          + `&order=hr_decided_at.desc&limit=10`,
          { timeoutMs: 10000 },
        );
        if (!cancelled) setRecent(rows || []);
      } catch (e) { console.warn('perm recent load failed', e?.message || e); }
    })();
    return () => { cancelled = true; };
  }, [msg]);

  async function save() {
    if (!canSave) return;
    setBusy(true); setMsg(null);
    try {
      const now = new Date().toISOString();
      const deciderId = me.auth_user_id || me.id;
      const row = {
        employee_id:        empId,
        type,
        permission_date:    date,
        time_from:          timeFrom,
        time_to:            timeTo,
        hours,
        reason:             `Manual entry · ${reason.trim() || 'Approved offline'}`,
        exceeds_quota:      false,
        requested_at:       now,
        requested_by:       me.id,
        // Logged as already approved — skip the workflow, stamp both decisions.
        stage:              'approved',
        status:             'approved',
        manager_decided_at: now,
        manager_decided_by: deciderId,
        hr_decided_at:      now,
        hr_decided_by:      deciderId,
      };
      const created = await directPost('permission_requests', row, { timeoutMs: 10000 });
      const data = Array.isArray(created) ? created[0] : created;
      try {
        logAction(me, 'permission_create', {
          targetType: 'permission_request',
          targetId: data?.id,
          targetLabel: `Manual · ${PERMISSION_TYPES[type]?.label} · ${date} · ${timeFrom}–${timeTo}`,
          details: { manual: true, type, hours, time_from: timeFrom, time_to: timeTo },
        });
      } catch { /* audit best-effort */ }
      setMsg({ kind: 'ok', text: `Logged: ${selectedEmp?.name || empId} · ${PERMISSION_TYPES[type]?.label} · ${date}` });
      // reset for the next entry, keep the employee selected
      setTimeFrom(''); setTimeTo(''); setReason('');
      onSaved?.();
    } catch (err) {
      setMsg({ kind: 'err', text: err?.message || 'Could not save. Please try again.' });
    } finally {
      setBusy(false);
    }
  }

  async function deleteEntry(r) {
    if (!window.confirm('Delete this permission entry?')) return;
    setDeletingId(r.id);
    try {
      await directDelete('permission_requests', `id=eq.${r.id}`, { timeoutMs: 10000 });
      setRecent(prev => prev.filter(x => x.id !== r.id));
    } catch (err) {
      setMsg({ kind: 'err', text: err?.message || 'Could not delete.' });
    } finally {
      setDeletingId(null);
    }
  }

  const inputCls = 'w-full rounded border border-black/15 px-3 py-2 text-sm';

  return (
    <div className="rounded-lg border border-black/10 bg-white p-4 space-y-4">
      {/* Employee */}
      <div>
        <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>Employee</label>
        {selectedEmp ? (
          <div className="flex items-center justify-between mt-1 rounded border border-black/10 px-3 py-2 text-sm" style={{ color: '#1F1B16' }}>
            <span>{selectedEmp.name} <span style={{ opacity: 0.6 }}>· {selectedEmp.id} · {selectedEmp.department}/{selectedEmp.location}</span></span>
            <button type="button" className="text-xs underline" onClick={() => { setEmpId(''); setEmpQuery(''); }}>change</button>
          </div>
        ) : (
          <>
            <input className={inputCls + ' mt-1'} placeholder="Search name or PSN…" value={empQuery} onChange={e => setEmpQuery(e.target.value)} />
            {empMatches.length > 0 && (
              <div className="mt-1 rounded border border-black/10 divide-y divide-black/5">
                {empMatches.map(e => (
                  <button key={e.id} type="button" onClick={() => { setEmpId(e.id); setEmpQuery(''); }}
                    className="w-full text-left px-3 py-2 text-sm hover:bg-black/[0.03]" style={{ color: '#1F1B16' }}>
                    {e.name} <span style={{ opacity: 0.6 }}>· {e.id} · {e.department}/{e.location}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Type + date */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>Type</label>
          <select className={inputCls + ' mt-1'} value={type} onChange={e => setType(e.target.value)}>
            {Object.entries(PERMISSION_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>Permission date</label>
          <input type="date" className={inputCls + ' mt-1'} value={date} onChange={e => setDate(e.target.value)} />
        </div>
      </div>

      {/* Times */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>From</label>
          <input type="time" className={inputCls + ' mt-1'} value={timeFrom} onChange={e => setTimeFrom(e.target.value)} />
        </div>
        <div>
          <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>To</label>
          <input type="time" className={inputCls + ' mt-1'} value={timeTo} onChange={e => setTimeTo(e.target.value)} />
        </div>
      </div>
      <div className="text-xs flex items-center gap-1.5" style={{ color: timeError ? '#B91C1C' : '#1F1B16' }}>
        <Clock size={12} />
        {timeError || (durationMin > 0 ? `Duration: ${durationMin} mins · uses ${hours} ${hours === 1 ? 'hour' : 'hours'} of the monthly bucket.` : 'Enter the permission window.')}
      </div>

      {/* Reason / source */}
      <div>
        <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>Reason / source</label>
        <input className={inputCls + ' mt-1'} placeholder="e.g. Approved by manager via email 21 May" value={reason} onChange={e => setReason(e.target.value)} />
      </div>

      {msg && (
        <div className={`flex items-center gap-2 text-sm rounded px-3 py-2 ${msg.kind === 'ok' ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-900'}`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {msg.text}
        </div>
      )}

      <div className="flex justify-end">
        <button onClick={save} disabled={!canSave}
          className="flex items-center gap-2 px-4 py-2 rounded text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: '#0F4C2A' }}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {busy ? 'Saving…' : 'Log permission'}
        </button>
      </div>

      {/* Recent */}
      <div className="pt-2 border-t border-black/10">
        <h3 className="text-sm font-semibold mb-2" style={{ color: '#1F1B16' }}>Recently logged permissions ({recent.length})</h3>
        {recent.length === 0 ? (
          <p className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>No manual permission entries yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b border-black/10" style={{ color: '#1F1B16', opacity: 0.7 }}>
                <th className="py-2 font-semibold">Employee</th>
                <th className="py-2 font-semibold">Type</th>
                <th className="py-2 font-semibold">Date</th>
                <th className="py-2 font-semibold">Window</th>
                <th className="py-2 font-semibold text-right" style={{ width: 36 }}></th>
              </tr>
            </thead>
            <tbody>
              {recent.map(r => {
                const e = (employees || []).find(x => x.id === r.employee_id);
                return (
                  <tr key={r.id} className="border-b border-black/5 last:border-0" style={{ color: '#1F1B16' }}>
                    <td className="py-2">{e?.name || r.employee_id}</td>
                    <td className="py-2">{PERMISSION_TYPES[r.type]?.short || r.type}</td>
                    <td className="py-2">{r.permission_date}</td>
                    <td className="py-2 font-mono">{String(r.time_from || '').slice(0,5)}–{String(r.time_to || '').slice(0,5)}</td>
                    <td className="py-2 text-right">
                      <button type="button" title="Delete this entry" onClick={() => deleteEntry(r)} disabled={deletingId === r.id}
                        className="inline-flex items-center justify-center rounded p-1 hover:bg-red-50" style={{ color: '#B91C1C', opacity: deletingId === r.id ? 0.5 : 1 }}>
                        {deletingId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
