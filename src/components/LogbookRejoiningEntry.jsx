// ──────────────────────────────────────────────────────────────────────
//  LogbookRejoiningEntry — manual rejoining (return-from-leave) logging
//  for Bashaier. Mirrors the Leave / Permission Logbook entries: she
//  picks a staff member's approved leave, records the actual return date,
//  and it's written straight to the leave row as a fully-approved
//  rejoining (return_stage='approved', manager + HR return-decisions
//  stamped now). Recently-logged rejoinings get a prefilled email and a
//  manually-prepared Word .docx (no QR / Ref). (Nadeem 2026-06-08)
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useMemo, useEffect } from 'react';
import { directGet, directPatch } from '../supabaseClient.js';
import { Save, Loader2, CheckCircle2, AlertCircle, Mail, FileText, Trash2 } from 'lucide-react';
import { downloadRejoiningReportForRequest, buildRejoiningEmailDraft } from '../lib/rejoiningReport.js';

const addDaysIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const labelFor = (id) => (id ? String(id).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Leave');

export default function LogbookRejoiningEntry({ me, employees = [], onSaved }) {
  const [empQuery, setEmpQuery] = useState('');
  const [empId, setEmpId]       = useState('');
  const [leaves, setLeaves]     = useState([]);
  const [leaveId, setLeaveId]   = useState('');
  const [returnDate, setReturnDate] = useState('');
  const [notes, setNotes]       = useState('');
  const [busy, setBusy]         = useState(false);
  const [msg, setMsg]           = useState(null);
  const [recent, setRecent]     = useState([]);
  const [docId, setDocId]       = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const empMap = useMemo(() => {
    const m = {}; (employees || []).forEach(e => { m[e.id] = e; }); return m;
  }, [employees]);

  const empMatches = useMemo(() => {
    const q = (empQuery || '').trim().toLowerCase();
    if (q.length < 2) return [];
    return (employees || []).filter(e => e.id?.toLowerCase().includes(q) || (e.name || '').toLowerCase().includes(q)).slice(0, 8);
  }, [empQuery, employees]);

  const selectedEmp   = empMap[empId];
  const selectedLeave = useMemo(() => leaves.find(l => l.id === leaveId), [leaves, leaveId]);

  // Load the employee's approved leaves not yet rejoined (excluding sick).
  useEffect(() => {
    let cancelled = false;
    if (!empId) { setLeaves([]); setLeaveId(''); return; }
    (async () => {
      try {
        const rows = await directGet(
          'leave_requests',
          `select=*&employee_id=eq.${empId}`
          + `&or=(stage.eq.approved,status.eq.approved)`
          + `&leave_type_id=neq.sick`
          + `&order=end_date.desc&limit=25`,
          { timeoutMs: 10000 },
        );
        const eligible = (rows || []).filter(r => r.return_stage !== 'approved');
        if (!cancelled) setLeaves(eligible);
      } catch (e) { if (!cancelled) setLeaves([]); }
    })();
    return () => { cancelled = true; };
  }, [empId, msg]);

  // Default the return date to day after the leave ends.
  useEffect(() => {
    if (selectedLeave) setReturnDate(selectedLeave.actual_return_date || addDaysIso(selectedLeave.end_date, 1));
    else setReturnDate('');
  }, [selectedLeave]);

  const dateError =
    !returnDate ? 'Pick the actual return date.' :
    (selectedLeave && returnDate < selectedLeave.start_date) ? 'Return date cannot be before the leave start.' :
    '';
  const canSave = !!empId && !!leaveId && !dateError && !busy;

  // Recently-logged rejoinings
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'leave_requests',
          `select=*&return_stage=eq.approved&actual_return_date=not.is.null`
          + `&order=return_hr_decided_at.desc.nullslast&limit=10`,
          { timeoutMs: 10000 },
        );
        if (!cancelled) setRecent(rows || []);
      } catch (e) { /* best-effort */ }
    })();
    return () => { cancelled = true; };
  }, [msg]);

  async function save() {
    if (!canSave) return;
    setBusy(true); setMsg(null);
    try {
      const now = new Date().toISOString();
      // Stamp the employee's actual department manager as the return
      // approver (so the DEPT MGR box on the report resolves to them, e.g.
      // Sadakath for H94328 — NOT whoever logged it). HR = me. (Nadeem 2026-06-08)
      const mgrId = selectedEmp?.manager_id || me.id;
      await directPatch('leave_requests', 'id', leaveId, {
        actual_return_date:         returnDate,
        return_notes:               notes.trim() || null,
        return_submitted_at:        now,
        return_manager_decided_at:  now,
        return_manager_decided_by:  mgrId,
        return_hr_decided_at:       now,
        return_hr_decided_by:       me.id,
        return_stage:               'approved',
        return_rejection_reason:    null,
      }, { timeoutMs: 10000 });
      setMsg({ kind: 'ok', text: `Rejoining logged: ${selectedEmp?.name || empId} · returned ${returnDate}` });
      setLeaveId(''); setNotes('');
      onSaved?.();
    } catch (err) {
      setMsg({ kind: 'err', text: err?.message || 'Could not save the rejoining.' });
    } finally {
      setBusy(false);
    }
  }

  async function downloadWord(r) {
    setDocId(r.id); setMsg(null);
    try {
      await downloadRejoiningReportForRequest(r, empMap, true /* manual: no QR/Ref */);
    } catch (err) {
      setMsg({ kind: 'err', text: err?.message || 'Could not generate the Word document.' });
    } finally {
      setDocId(null);
    }
  }

  // Delete = undo the rejoining (clears the return fields on the leave
  // row so it goes back to "awaiting rejoining"). Same delete affordance
  // as the leave / permission entries. (Nadeem 2026-06-08)
  async function deleteEntry(r) {
    const e = empMap[r.employee_id];
    if (!window.confirm(`Remove the logged rejoining for ${e?.name || r.employee_id} (returned ${r.actual_return_date})? The leave will go back to "awaiting rejoining".`)) return;
    setDeletingId(r.id);
    try {
      await directPatch('leave_requests', 'id', r.id, {
        actual_return_date:         null,
        return_notes:               null,
        return_submitted_at:        null,
        return_manager_decided_at:  null,
        return_manager_decided_by:  null,
        return_hr_decided_at:       null,
        return_hr_decided_by:       null,
        return_stage:               null,
        return_rejection_reason:    null,
      }, { timeoutMs: 10000 });
      setRecent(prev => prev.filter(x => x.id !== r.id));
      onSaved?.();
    } catch (err) {
      setMsg({ kind: 'err', text: err?.message || 'Could not delete the rejoining.' });
    } finally {
      setDeletingId(null);
    }
  }

  function emailEntry(r) {
    try {
      const emp = empMap[r.employee_id];
      const manager = emp?.manager_id ? empMap[emp.manager_id] : null;
      const draft = buildRejoiningEmailDraft({ employee: emp, request: r, manager, hrApprover: me, employees });
      window.open(draft.mailto, '_blank');
    } catch (err) {
      setMsg({ kind: 'err', text: err?.message || 'Could not open the email draft.' });
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
            <button type="button" className="text-xs underline" onClick={() => { setEmpId(''); setEmpQuery(''); setLeaveId(''); }}>change</button>
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

      {/* Leave to rejoin from */}
      {empId && (
        <div>
          <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>Leave to rejoin from</label>
          {leaves.length === 0 ? (
            <p className="text-xs mt-1" style={{ color: '#1F1B16', opacity: 0.6 }}>No approved leave awaiting rejoining for this employee.</p>
          ) : (
            <select className={inputCls + ' mt-1'} value={leaveId} onChange={e => setLeaveId(e.target.value)}>
              <option value="">— select a leave —</option>
              {leaves.map(l => (
                <option key={l.id} value={l.id}>
                  {labelFor(l.leave_type_id)} · {l.start_date}{l.end_date !== l.start_date ? ` → ${l.end_date}` : ''}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Return date + notes */}
      {leaveId && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>Actual return date</label>
              <input type="date" className={inputCls + ' mt-1'} value={returnDate} onChange={e => setReturnDate(e.target.value)} />
            </div>
          </div>
          {dateError && <div className="text-xs" style={{ color: '#B91C1C' }}>{dateError}</div>}
          <div>
            <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>Notes (optional)</label>
            <input className={inputCls + ' mt-1'} placeholder="e.g. Returned on schedule" value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </>
      )}

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
          {busy ? 'Saving…' : 'Log rejoining'}
        </button>
      </div>

      {/* Recently logged */}
      <div className="pt-2 border-t border-black/10">
        <h3 className="text-sm font-semibold mb-2" style={{ color: '#1F1B16' }}>Recently logged rejoinings ({recent.length})</h3>
        {recent.length === 0 ? (
          <p className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>No rejoinings logged yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b border-black/10" style={{ color: '#1F1B16', opacity: 0.7 }}>
                <th className="py-2 font-semibold">Employee</th>
                <th className="py-2 font-semibold">Leave</th>
                <th className="py-2 font-semibold">Returned</th>
                <th className="py-2 font-semibold text-right" style={{ width: 92 }}></th>
              </tr>
            </thead>
            <tbody>
              {recent.map(r => {
                const e = empMap[r.employee_id];
                return (
                  <tr key={r.id} className="border-b border-black/5 last:border-0" style={{ color: '#1F1B16' }}>
                    <td className="py-2">{e?.name || r.employee_id}</td>
                    <td className="py-2">{labelFor(r.leave_type_id)}</td>
                    <td className="py-2">{r.actual_return_date}</td>
                    <td className="py-2 text-right whitespace-nowrap">
                      <button type="button" title="Open prefilled email" onClick={() => emailEntry(r)}
                        className="inline-flex items-center justify-center rounded p-1 hover:bg-emerald-50 mr-1" style={{ color: '#0F6E56' }}>
                        <Mail size={13} />
                      </button>
                      <button type="button" title="Download Word document" onClick={() => downloadWord(r)} disabled={docId === r.id}
                        className="inline-flex items-center justify-center rounded p-1 hover:bg-blue-50 mr-1" style={{ color: '#1D4ED8', opacity: docId === r.id ? 0.5 : 1 }}>
                        {docId === r.id ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                      </button>
                      <button type="button" title="Remove this rejoining (undo)" onClick={() => deleteEntry(r)} disabled={deletingId === r.id}
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
