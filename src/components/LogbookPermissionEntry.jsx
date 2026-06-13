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
import { Save, Loader2, CheckCircle2, AlertCircle, Trash2, Clock, Mail, FileText } from 'lucide-react';
import { PERMISSION_TYPES, PERMISSION_QUOTA, summariseMonth, checkExceeds, reasonsFor } from '../lib/permissionLogic.js';
import { downloadPermissionLetter, buildPermissionEmailDraft } from '../lib/permissionLetter.js';
import { logAction } from '../lib/audit.js';

const toMin = (t) => { const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; };

// Rounded clock options for the permission From/To dropdowns — every 15
// minutes from 06:00 to 20:00 (e.g. 08:00, 08:15, 08:30…). Keeps entries
// tidy and avoids odd second-level values. (Nadeem 2026-06-08)
const TIME_OPTIONS = (() => {
  const out = [];
  for (let m = 6 * 60; m <= 20 * 60; m += 15) {
    out.push(`${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  }
  return out;
})();

export default function LogbookPermissionEntry({ me, employees = [], onSaved }) {
  const [empQuery, setEmpQuery] = useState('');
  const [empId, setEmpId]       = useState('');
  const [type, setType]         = useState('late_arrival');
  const [date, setDate]         = useState('');
  const [timeFrom, setTimeFrom] = useState('');
  const [timeTo, setTimeTo]     = useState('');
  const [reasonCategory, setReasonCategory] = useState('');
  const [reasonOther, setReasonOther]       = useState('');
  const [busy, setBusy]         = useState(false);
  const [msg, setMsg]           = useState(null);
  const [recent, setRecent]     = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  const [docId, setDocId]           = useState(null);
  const [monthRows, setMonthRows] = useState([]);

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

  const monthKey = (date || '').slice(0, 7);   // 'YYYY-MM'

  const reasonOptions = useMemo(() => reasonsFor(type), [type]);
  const isOtherReason = reasonCategory === 'Other';
  const finalReason = isOtherReason ? reasonOther.trim() : reasonCategory;

  // Load this employee's permissions for the selected month (to compute usage).
  useEffect(() => {
    let cancelled = false;
    if (!empId || !monthKey) { setMonthRows([]); return; }
    (async () => {
      try {
        const rows = await directGet(
          'permission_requests',
          `select=id,type,permission_date,time_from,time_to,hours,status,stage`
          + `&employee_id=eq.${empId}`
          + `&permission_date=gte.${monthKey}-01&permission_date=lte.${monthKey}-31`
          + `&order=permission_date.asc`,
          { timeoutMs: 10000 },
        );
        if (!cancelled) setMonthRows(rows || []);
      } catch (e) { if (!cancelled) setMonthRows([]); }
    })();
    return () => { cancelled = true; };
  }, [empId, monthKey, msg]);

  const monthSummary = useMemo(() => summariseMonth(monthRows), [monthRows]);
  const exceed = useMemo(
    () => (empId && hours > 0 ? checkExceeds(monthRows, hours) : { willExceed: false }),
    [empId, hours, monthRows],
  );

  // Compose a soft courtesy email to the staff listing their month's
  // permissions + a gentle note about evaluation / personal score.
  function emailStaffNotice() {
    if (!selectedEmp?.email) { setMsg({ kind: 'err', text: 'No email on file for this employee.' }); return; }
    const monthLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const counted = monthRows.filter(r => r.status === 'pending' || r.status === 'approved');
    const all = [...counted, { type, permission_date: date, time_from: timeFrom, time_to: timeTo }];
    const lines = all
      .sort((a, b) => String(a.permission_date).localeCompare(String(b.permission_date)))
      .map(r => `  • ${r.permission_date}  ·  ${PERMISSION_TYPES[r.type]?.label || r.type}  ·  ${String(r.time_from || '').slice(0,5)}–${String(r.time_to || '').slice(0,5)}`);
    const totalH = Math.round((monthSummary.hoursUsed + hours) * 10) / 10;
    const totalN = monthSummary.occurrences + 1;
    const firstRaw = (selectedEmp.name || '').trim().split(/\s+/)[0] || selectedEmp.name || '';
    const first = firstRaw.charAt(0).toUpperCase() + firstRaw.slice(1).toLowerCase();
    const body = [
      `Dear ${first},`, '',
      `This is a courtesy note regarding your permission (late arrival / early departure) usage for ${monthLabel}:`, '',
      ...lines, '',
      `Total this month: ${totalH} hour(s) across ${totalN} permission(s).`, '',
      `As per company policy, each employee is allowed a maximum of ${PERMISSION_QUOTA.monthlyOccurrences} permissions (${PERMISSION_QUOTA.monthlyHours} hours) per calendar month. You have now reached or exceeded this allowance.`, '',
      `Kindly note that permissions beyond the monthly limit may be reflected in your attendance evaluation and personal score. This is only a gentle reminder — please plan accordingly, and for any genuine need coordinate in advance with your manager and HR.`, '',
      `Thanks and regards,`,
      `BASHAIER ALI`,
      `Evergreen Shipping Agency Saudi Co., (L.L.C)`,
      `ESAU - SADMN SUP / HR DEPT`,
    ].join('\n');
    const subject = `Permission usage reminder — ${monthLabel}`;
    window.open(`mailto:${selectedEmp.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
  }

  // Quota already COMPLETED before this entry → logging more is blocked.
  const quotaCompleted = !!empId && (
    monthSummary.occurrences >= PERMISSION_QUOTA.monthlyOccurrences ||
    monthSummary.hoursUsed   >= PERMISSION_QUOTA.monthlyHours
  );

  // Reminder email for the BLOCKED case — the staff has used the full
  // monthly allowance, so this permission cannot be logged. Lists only the
  // permissions already counted (not the blocked attempt).
  function emailQuotaCompleted() {
    if (!selectedEmp?.email) { setMsg({ kind: 'err', text: 'No email on file for this employee.' }); return; }
    const monthLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const counted = monthRows.filter(r => r.status === 'pending' || r.status === 'approved');
    const lines = counted
      .sort((a, b) => String(a.permission_date).localeCompare(String(b.permission_date)))
      .map(r => `  • ${r.permission_date}  ·  ${PERMISSION_TYPES[r.type]?.label || r.type}  ·  ${String(r.time_from || '').slice(0,5)}–${String(r.time_to || '').slice(0,5)}`);
    const totalH = Math.round(monthSummary.hoursUsed * 10) / 10;
    const totalN = monthSummary.occurrences;
    const firstRaw = (selectedEmp.name || '').trim().split(/\s+/)[0] || selectedEmp.name || '';
    const first = firstRaw.charAt(0).toUpperCase() + firstRaw.slice(1).toLowerCase();
    const body = [
      `Dear ${first},`, '',
      `This is a reminder regarding your permission (late arrival / early departure) usage for ${monthLabel}.`, '',
      `You have already used your full monthly allowance:`, '',
      ...lines, '',
      `Total this month: ${totalH} hour(s) across ${totalN} permission(s) — the monthly limit is ${PERMISSION_QUOTA.monthlyOccurrences} permissions (${PERMISSION_QUOTA.monthlyHours} hours).`, '',
      `As your quota for ${monthLabel} is now complete, no further permissions can be accommodated this month. Any additional late arrival or early departure may be recorded as a violation and reflected in your attendance evaluation and personal score. Kindly plan accordingly, and for any genuine emergency please coordinate in advance with your manager and HR.`, '',
      `Thanks and regards,`,
      `BASHAIER ALI`,
      `Evergreen Shipping Agency Saudi Co., (L.L.C)`,
      `ESAU - SADMN SUP / HR DEPT`,
    ].join('\n');
    const subject = `Permission quota completed — ${monthLabel}`;
    window.open(`mailto:${selectedEmp.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`, '_blank');
  }

  const timeError =
    Number.isNaN(durationMin) ? 'Pick a start and end time.' :
    durationMin <= 0          ? 'End time must be after start time.' :
    durationMin < 15          ? 'Minimum permission window is 15 minutes.' :
    durationMin > 60          ? 'Each permission must not exceed 60 minutes (company policy).' :
    '';

  const canSave = !!empId && !!date && !timeError && !busy && !quotaCompleted;

  // Recent manual permission entries
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'permission_requests',
          `select=id,employee_id,type,permission_date,time_from,time_to,hours,reason,stage,requested_at,manager_decided_at,hr_decided_at,exceeds_quota`
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
    if (quotaCompleted) {
      setMsg({ kind: 'err', text: `${selectedEmp?.name || 'This employee'} has completed the monthly permission quota — this cannot be logged. Please send the reminder email instead.` });
      return;
    }
    setBusy(true); setMsg(null);
    try {
      const now = new Date().toISOString();
      // decided_by columns FK to employees.id (the PSN) — use me.id, not
      // the auth UUID, or the insert violates the foreign key.
      const deciderId = me.id;
      const row = {
        employee_id:        empId,
        type,
        permission_date:    date,
        time_from:          timeFrom,
        time_to:            timeTo,
        hours,
        reason:             `Manual entry · ${finalReason || 'Approved offline'}`,
        exceeds_quota:      !!exceed.willExceed,   // flag for evaluation/personal score
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
      setTimeFrom(''); setTimeTo(''); setReasonCategory(''); setReasonOther('');
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

  // Open a prefilled email for a logged permission (same draft the
  // approval flow uses — staff in To, manager + execs in CC).
  function emailEntry(r) {
    try {
      const emp = (employees || []).find(x => x.id === r.employee_id) || { id: r.employee_id, name: r.employee_id };
      const manager = emp.manager_id ? (employees || []).find(x => x.id === emp.manager_id) : null;
      const draft = buildPermissionEmailDraft({ employee: emp, manager, hrApprover: me, request: r, employees });
      window.open(draft.mailto, '_blank');
    } catch (err) {
      setMsg({ kind: 'err', text: err?.message || 'Could not open the email draft.' });
    }
  }

  // Manual Word document — looks like a hand-prepared permission form,
  // WITHOUT the QR code and Ref number (manual:true). Temporary measure
  // until the full system launch. (Nadeem 2026-06-08)
  async function downloadWord(r) {
    setDocId(r.id);
    setMsg(null);
    try {
      const emp = (employees || []).find(x => x.id === r.employee_id) || { id: r.employee_id, name: r.employee_id };
      const manager = emp.manager_id ? (employees || []).find(x => x.id === emp.manager_id) : null;
      await downloadPermissionLetter({
        employee: emp,
        manager,
        hrApprover: me,
        request: r,
        manual: true,
      });
    } catch (err) {
      setMsg({ kind: 'err', text: err?.message || 'Could not generate the Word document.' });
    } finally {
      setDocId(null);
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
          <select className={inputCls + ' mt-1'} value={timeFrom} onChange={e => setTimeFrom(e.target.value)}>
            <option value="">— select —</option>
            {TIME_OPTIONS.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>To</label>
          <select className={inputCls + ' mt-1'} value={timeTo} onChange={e => setTimeTo(e.target.value)}>
            <option value="">— select —</option>
            {TIME_OPTIONS.filter(t => !timeFrom || toMin(t) > toMin(timeFrom)).map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>
      <div className="text-xs flex items-center gap-1.5" style={{ color: timeError ? '#B91C1C' : '#1F1B16' }}>
        <Clock size={12} />
        {timeError || (durationMin > 0 ? `Duration: ${durationMin} mins · uses ${hours} ${hours === 1 ? 'hour' : 'hours'} of the monthly bucket.` : 'Enter the permission window.')}
      </div>

      {/* Reason / source */}
      <div>
        <label className="text-xs font-semibold" style={{ color: '#1F1B16' }}>Reason</label>
        <select className={inputCls + ' mt-1'} value={reasonCategory} onChange={e => setReasonCategory(e.target.value)}>
          <option value="">— select a reason —</option>
          {reasonOptions.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        {isOtherReason && (
          <input className={inputCls + ' mt-2'} placeholder="Specify the reason / source…"
            value={reasonOther} onChange={e => setReasonOther(e.target.value)} />
        )}
      </div>

      {/* Hard block — quota already completed: cannot log, remind instead */}
      {quotaCompleted && (
        <div className="rounded px-3 py-2.5 text-xs" style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}>
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <strong>{selectedEmp?.name}</strong> has already completed the monthly permission quota
              {' '}({Math.round(monthSummary.hoursUsed * 10) / 10} h / {monthSummary.occurrences} permissions · limit {PERMISSION_QUOTA.monthlyHours} h · {PERMISSION_QUOTA.monthlyOccurrences} permissions).
              {' '}This permission <strong>cannot be logged</strong>. Please remind the employee that their quota for this month is complete.
              <div className="mt-2">
                <button type="button" onClick={emailQuotaCompleted}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-semibold"
                  style={{ background: '#FFFFFF', color: '#991B1B', border: '1px solid #FCA5A5' }}>
                  <Mail size={12} /> Email {selectedEmp?.name?.split(' ')[0] || 'staff'} — quota completed
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Soft (non-blocking) over-quota notice — only when this entry would
          tip them over but the quota is not already fully used. */}
      {empId && hours > 0 && !quotaCompleted && exceed.willExceed && (
        <div className="rounded px-3 py-2.5 text-xs" style={{ background: '#FFFBEB', border: '1px solid #FCD34D', color: '#854F0B' }}>
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <strong>{selectedEmp?.name}</strong> will be over the monthly permission allowance this month
              {' '}({Math.round((monthSummary.hoursUsed + hours) * 10) / 10} h / {monthSummary.occurrences + 1} permissions vs the {PERMISSION_QUOTA.monthlyHours} h · {PERMISSION_QUOTA.monthlyOccurrences} limit).
              You can still log it — it will be flagged for evaluation. You may also send the staff a soft reminder.
              <div className="mt-2">
                <button type="button" onClick={emailStaffNotice}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-semibold"
                  style={{ background: '#FFFFFF', color: '#854F0B', border: '1px solid #FCD34D' }}>
                  <Mail size={12} /> Email {selectedEmp?.name?.split(' ')[0] || 'staff'} a soft reminder
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {msg && (
        <div className={`flex items-center gap-2 text-sm rounded px-3 py-2 ${msg.kind === 'ok' ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-900'}`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {msg.text}
        </div>
      )}

      <div className="flex justify-end">
        <button onClick={save} disabled={!canSave}
          title={quotaCompleted ? 'Monthly permission quota already completed — cannot log' : undefined}
          className="flex items-center gap-2 px-4 py-2 rounded text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: '#0F4C2A' }}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {busy ? 'Saving…' : quotaCompleted ? 'Quota completed' : 'Log permission'}
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
                <th className="py-2 font-semibold text-right" style={{ width: 92 }}></th>
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
                    <td className="py-2 text-right whitespace-nowrap">
                      <button type="button" title="Open prefilled email" onClick={() => emailEntry(r)}
                        className="inline-flex items-center justify-center rounded p-1 hover:bg-emerald-50 mr-1" style={{ color: '#0F6E56' }}>
                        <Mail size={13} />
                      </button>
                      <button type="button" title="Download Word document" onClick={() => downloadWord(r)} disabled={docId === r.id}
                        className="inline-flex items-center justify-center rounded p-1 hover:bg-blue-50 mr-1" style={{ color: '#1D4ED8', opacity: docId === r.id ? 0.5 : 1 }}>
                        {docId === r.id ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                      </button>
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
