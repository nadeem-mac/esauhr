// ──────────────────────────────────────────────────────────────────────
//  Logbook — private manual-entry workspace for Bashaier
//
//  Records paper/email leave applications she's still receiving offline.
//  Each entry writes straight to the master leave_requests table as
//  fully approved, so balances on the staff dashboard update immediately.
//
//  Nadeem 2026-05-21: 'a separate tab which stays exclusively for
//  Bashaier where she can manually enter annual leaves by herself …
//  the data when she enters it gets updated in the master'
//
//  Access is hard-gated upstream in AppShell to two PSNs:
//    H94830 (Bashaier), H94152 (Nadeem — admin oversight)
//  No one else sees the tab.
//
// ── DESIGN ──────────────────────────────────────────────────────────
//
//  Single-page form, top to bottom:
//    1. Employee picker  — typeahead by name or PSN
//    2. Leave type       — defaults to Annual
//    3. Date range       — start + end, plus a half-day toggle
//    4. Days (computed)  — read-only, mirrors what the portal computes
//    5. Reason / source  — free-text ('Received via email 18 May',
//                          'Verbal request approved by John')
//    6. Save             — writes to leave_requests with stage='approved'
//
//  Below the form, a 'Recently logged' table shows the last 10 entries
//  she's made so she can spot-check what she's added.
//
// ── WHAT GETS WRITTEN ───────────────────────────────────────────────
//
//  leave_requests row with:
//    stage:                 'approved'   (skip the workflow)
//    status:                'approved'   (legacy mirror)
//    requested_at:          now
//    manager_decided_at:    now
//    hr_decided_at:         now
//    substitute_ids:        []           (paper leaves don't go through
//    substitute_decisions:  {}            the online substitute-acceptance
//                                          loop — empty arrays/objects
//                                          signal 'no subs' to the PDF)
//    reason:                'Manual entry · ' + the source field
//    requested_by:          me.id        (Bashaier as the entry agent)
//
//  Balance computation picks this up automatically because
//  calculateBalance counts every stage='approved' row toward 'used'.
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useMemo, useEffect } from 'react';
import { directGet, directPost } from '../supabaseClient.js';
import { NotebookPen, Save, Loader2, Search, CheckCircle2, AlertCircle } from 'lucide-react';
import { calculateRequestDays, fmtDate } from '../lib/leaveLogic.js';
import LeaveApprovedModal from './LeaveApprovedModal.jsx';

export default function Logbook({ me, employees = [], leaveTypes = [], onSaved }) {
  const [empQuery, setEmpQuery] = useState('');
  const [empId, setEmpId] = useState('');
  const [leaveType, setLeaveType] = useState('annual');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isHalfDay, setIsHalfDay] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [recent, setRecent] = useState([]);
  // Manual override for the day count. When null, the form uses the
  // auto-calculated working-days figure (MOL Article 113). Bashaier
  // can override when the paper application explicitly states a
  // different number — e.g. calendar-day counts that include
  // weekends, which is how the legacy Excel tracker recorded leaves.
  const [daysOverride, setDaysOverride] = useState(null);
  const [savedModal, setSavedModal] = useState(null);

  // ── Employee search ────────────────────────────────────────────────
  const empMatches = useMemo(() => {
    const q = (empQuery || '').trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return (employees || [])
      .filter(e =>
        e.id?.toLowerCase().includes(q) ||
        (e.name || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [empQuery, employees]);

  const selectedEmp = useMemo(
    () => (employees || []).find(e => e.id === empId),
    [empId, employees]
  );

  // ── Day count ──────────────────────────────────────────────────────
  const lt = useMemo(
    () => (leaveTypes || []).find(t => t.id === leaveType) || { id: 'annual' },
    [leaveType, leaveTypes]
  );
  // Auto-calc (MOL Article 113 — working days, excludes Fri/Sat + public holidays)
  const autoDays = useMemo(() => {
    if (!startDate || !endDate) return 0;
    return calculateRequestDays(startDate, endDate, lt, [], isHalfDay);
  }, [startDate, endDate, lt, isHalfDay]);
  // Final days to insert — manual override takes precedence
  const days = daysOverride != null && daysOverride !== '' ? Number(daysOverride) : autoDays;

  // ── Recent entries — last 10 manual entries Bashaier logged ────────
  useEffect(() => {
    let cancelled = false;
    const loadRecent = async () => {
      try {
        const rows = await directGet(
          'leave_requests',
          `select=id,employee_id,leave_type_id,start_date,end_date,days,reason,hr_decided_at`
          + `&reason=ilike.Manual entry*`
          + `&order=hr_decided_at.desc&limit=10`,
          { timeoutMs: 10000 }
        );
        if (!cancelled) setRecent(rows || []);
      } catch (e) {
        console.warn('logbook recent load failed:', e?.message || e);
      }
    };
    loadRecent();
    return () => { cancelled = true; };
  }, [msg]);  // reload after each successful save

  // ── Submit ─────────────────────────────────────────────────────────
  const canSave = empId && leaveType && startDate && endDate && days > 0 && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setMsg(null);
    try {
      const now = new Date().toISOString();
      const payload = {
        employee_id:         empId,
        leave_type_id:       leaveType,
        start_date:          startDate,
        end_date:            endDate,
        days,
        is_half_day:         isHalfDay || null,
        reason:              `Manual entry · ${reason.trim() || 'paper/email'}`,
        stage:               'approved',
        status:              'approved',
        requested_at:        now,
        manager_decided_at:  now,
        hr_decided_at:       now,
        substitute_ids:      [],
        substitute_decisions: {},
        requested_by:        me?.id || null,
      };
      const inserted = await directPost('leave_requests', payload);
      const newRow = Array.isArray(inserted) ? inserted[0] : inserted;

      // Resolve the context the LeaveApprovedModal expects: the
      // employee, their manager (for CC + signature block), the HR
      // approver (Bashaier = me), and a small empMap for sick-leave
      // CC lookups. Annual leaves don't need badria/fahad so empMap
      // can be sparse — modal handles missing entries gracefully.
      const emp = (employees || []).find(e => e.id === empId);
      const mgr = emp?.manager_id
        ? (employees || []).find(e => e.id === emp.manager_id)
        : null;
      const empMap = (employees || []).reduce((acc, e) => {
        acc[e.id] = e;
        return acc;
      }, {});

      setSavedModal({
        request:    newRow,
        employee:   emp,
        manager:    mgr,
        hrApprover: me,
        empMap,
        substitutes: [],   // manual paper leaves don't go through online subs
      });

      setMsg({ kind: 'ok', text: `Logged ${days}d for ${emp?.name || empId}` });
      // Clear form so the next entry starts fresh
      setEmpQuery('');
      setEmpId('');
      setStartDate('');
      setEndDate('');
      setIsHalfDay(false);
      setReason('');
      setDaysOverride(null);
      onSaved?.();
    } catch (err) {
      console.error('logbook save error:', err);
      setMsg({ kind: 'err', text: err?.message || 'Failed to log entry' });
    } finally {
      setBusy(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-5 p-4 max-w-3xl mx-auto">
      <header className="flex items-center gap-2 pb-2 border-b border-black/10">
        <NotebookPen size={20} style={{ color: '#0F4C2A' }} />
        <h2 className="text-lg font-semibold" style={{ color: '#1F1B16' }}>
          Logbook
        </h2>
        <span className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
          · Manual entry for paper/email leave applications
        </span>
      </header>

      {/* Form */}
      <div className="rounded-lg border border-black/10 bg-white p-4 space-y-3">
        {/* Employee picker */}
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Employee
          </label>
          {selectedEmp ? (
            <div className="flex items-center justify-between rounded border border-black/15 bg-black/[0.02] px-3 py-2">
              <div>
                <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                  {selectedEmp.name}
                </div>
                <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
                  {selectedEmp.id} · {selectedEmp.department || '—'}
                </div>
              </div>
              <button
                onClick={() => { setEmpId(''); setEmpQuery(''); }}
                className="text-xs underline"
                style={{ color: '#0F4C2A' }}>
                change
              </button>
            </div>
          ) : (
            <div className="relative">
              <div className="flex items-center gap-2 rounded border border-black/15 bg-white px-3 py-2">
                <Search size={14} style={{ color: '#1F1B16', opacity: 0.5 }} />
                <input
                  className="flex-1 text-sm outline-none"
                  placeholder="Search by name or PSN (e.g. Nadeem, H94328)…"
                  value={empQuery}
                  onChange={(e) => setEmpQuery(e.target.value)}
                  autoFocus
                />
              </div>
              {empMatches.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full rounded border border-black/15 bg-white shadow-lg max-h-64 overflow-y-auto">
                  {empMatches.map(e => (
                    <li key={e.id}>
                      <button
                        onClick={() => { setEmpId(e.id); setEmpQuery(''); }}
                        className="w-full text-left px-3 py-2 hover:bg-black/[0.04] border-b border-black/5 last:border-0">
                        <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                          {e.name}
                        </div>
                        <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
                          {e.id} · {e.department || '—'} · {e.location || ''}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Leave type */}
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Leave type
          </label>
          <select
            value={leaveType}
            onChange={(e) => setLeaveType(e.target.value)}
            className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none">
            {(leaveTypes || []).map(t => (
              <option key={t.id} value={t.id}>{t.label || t.id}</option>
            ))}
            {/* fallback if leaveTypes hasn't loaded */}
            {(leaveTypes || []).length === 0 && (
              <option value="annual">Annual</option>
            )}
          </select>
        </div>

        {/* Dates + half-day */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
              Start date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
              End date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm" style={{ color: '#1F1B16' }}>
          <input
            type="checkbox"
            checked={isHalfDay}
            onChange={(e) => setIsHalfDay(e.target.checked)}
          />
          Half-day request
        </label>

        {/* Day count — auto from MOL working-day calc, but Bashaier can
            override when the paper application uses calendar days */}
        {startDate && endDate && (
          <div className="rounded bg-black/[0.03] px-3 py-2 space-y-2">
            <div className="flex items-center gap-3 text-sm" style={{ color: '#1F1B16' }}>
              <span>Duration:</span>
              <input
                type="number"
                step="0.5"
                min="0"
                value={daysOverride != null ? daysOverride : autoDays}
                onChange={(e) => setDaysOverride(e.target.value)}
                className="w-20 text-sm rounded border border-black/15 bg-white px-2 py-1 outline-none font-semibold"
              />
              <span style={{ opacity: 0.7 }}>
                {days === 1 ? 'day' : 'days'}
              </span>
              {daysOverride != null && Number(daysOverride) !== autoDays && (
                <button
                  onClick={() => setDaysOverride(null)}
                  className="text-xs underline ml-auto"
                  style={{ color: '#0F4C2A' }}>
                  reset to auto ({autoDays})
                </button>
              )}
            </div>
            <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
              {fmtDate(new Date(startDate))} → {fmtDate(new Date(endDate))}
              {' · '}
              {daysOverride == null
                ? `auto-computed working days (MOL Art. 113, excludes Fri+Sat + holidays)`
                : Number(daysOverride) !== autoDays
                  ? `manual override · auto was ${autoDays} working days`
                  : `auto-computed working days (MOL Art. 113, excludes Fri+Sat + holidays)`}
            </div>
          </div>
        )}

        {/* Reason / source */}
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Source / notes <span style={{ opacity: 0.6 }}>(optional)</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Paper form received 21 May 2026 · approved by Sadakathullah"
            className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none min-h-[60px]"
          />
        </div>

        {/* Status message */}
        {msg && (
          <div className={`flex items-center gap-2 text-sm rounded px-3 py-2 ${
            msg.kind === 'ok'
              ? 'bg-green-50 text-green-900'
              : 'bg-red-50 text-red-900'
          }`}>
            {msg.kind === 'ok' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            {msg.text}
          </div>
        )}

        {/* Save */}
        <div className="flex justify-end pt-2">
          <button
            onClick={save}
            disabled={!canSave}
            className="flex items-center gap-2 px-4 py-2 rounded text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: '#0F4C2A' }}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {busy ? 'Saving…' : 'Log entry'}
          </button>
        </div>
      </div>

      {/* Recent entries */}
      <div className="rounded-lg border border-black/10 bg-white p-4">
        <h3 className="text-sm font-semibold mb-2" style={{ color: '#1F1B16' }}>
          Recently logged ({recent.length})
          {recent.length > 0 && (
            <span className="ml-2 text-xs font-normal" style={{ opacity: 0.6 }}>
              · click a row to re-open PDF / email
            </span>
          )}
        </h3>
        {recent.length === 0 ? (
          <p className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
            No manual entries yet. Logged entries will appear here.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left border-b border-black/10" style={{ color: '#1F1B16', opacity: 0.7 }}>
                <th className="py-2 font-semibold">Date</th>
                <th className="py-2 font-semibold">Employee</th>
                <th className="py-2 font-semibold">Type</th>
                <th className="py-2 font-semibold">Period</th>
                <th className="py-2 font-semibold text-right">Days</th>
              </tr>
            </thead>
            <tbody>
              {recent.map(r => {
                const e = (employees || []).find(x => x.id === r.employee_id);
                return (
                  <tr
                    key={r.id}
                    onClick={() => {
                      // Re-open the PDF/email modal for any earlier entry —
                      // lets Bashaier resend if she missed it the first time.
                      const mgr = e?.manager_id
                        ? (employees || []).find(x => x.id === e.manager_id)
                        : null;
                      const empMap = (employees || []).reduce((acc, x) => {
                        acc[x.id] = x; return acc;
                      }, {});
                      setSavedModal({
                        request: r, employee: e, manager: mgr,
                        hrApprover: me, empMap, substitutes: [],
                      });
                    }}
                    className="border-b border-black/5 last:border-0 cursor-pointer hover:bg-black/[0.02]"
                    style={{ color: '#1F1B16' }}>
                    <td className="py-2">{r.hr_decided_at ? new Date(r.hr_decided_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—'}</td>
                    <td className="py-2">{e?.name || r.employee_id}</td>
                    <td className="py-2 capitalize">{r.leave_type_id}</td>
                    <td className="py-2">
                      {fmtDate(new Date(r.start_date))}
                      {r.end_date && r.end_date !== r.start_date && ` → ${fmtDate(new Date(r.end_date))}`}
                    </td>
                    <td className="py-2 text-right font-medium">{r.days}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Post-save modal — same Download PDF + Open Email surface the
          regular approval flow uses. Re-opens too when Bashaier clicks
          any row in 'Recently logged'. */}
      {savedModal && (
        <LeaveApprovedModal
          request={savedModal.request}
          employee={savedModal.employee}
          manager={savedModal.manager}
          hrApprover={savedModal.hrApprover}
          empMap={savedModal.empMap}
          substitutes={savedModal.substitutes}
          onClose={() => setSavedModal(null)}
        />
      )}
    </div>
  );
}
