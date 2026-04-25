import React, { useState, useMemo, useEffect } from 'react';
import { X, AlertTriangle, AlertCircle, Calendar } from 'lucide-react';
import {
  calculateRequestDays, calculateBalance, findOverlappingRequests, checkEligibility,
  todayISO, fmtDateShort, LOCATION_LABELS,
} from '../lib/leaveLogic.js';

export default function NewRequestModal({ employees, leaveTypes, requests, balances, holidays, onClose, onSubmit }) {
  const [employeeId, setEmployeeId] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('annual');
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(todayISO());
  const [isHalfDay, setIsHalfDay] = useState(false);
  const [halfDayPeriod, setHalfDayPeriod] = useState('morning');
  const [reason, setReason] = useState('');
  const [attachmentUrl, setAttachmentUrl] = useState('');
  const [empSearch, setEmpSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const employee = employees.find(e => e.id === employeeId);
  const leaveType = leaveTypes.find(t => t.id === leaveTypeId);

  const filteredEmps = useMemo(() => {
    if (!empSearch) return employees;
    const s = empSearch.toLowerCase();
    return employees.filter(e => e.name.toLowerCase().includes(s) || e.id.toLowerCase().includes(s));
  }, [employees, empSearch]);

  // Auto-sync end date when start changes
  useEffect(() => {
    if (endDate < startDate) setEndDate(startDate);
  }, [startDate, endDate]);

  const requestDays = useMemo(() =>
    leaveType ? calculateRequestDays(startDate, endDate, leaveType, holidays, isHalfDay) : 0
  , [startDate, endDate, leaveType, holidays, isHalfDay]);

  const currentBalance = useMemo(() => {
    if (!employee || !leaveType) return null;
    const adj = balances.find(b => b.employee_id === employee.id && b.leave_type_id === leaveType.id && b.year === new Date().getFullYear()) || {};
    return calculateBalance({ employee, leaveType, year: new Date().getFullYear(), requests, adjustments: adj });
  }, [employee, leaveType, balances, requests]);

  const overlapping = useMemo(() =>
    employee ? findOverlappingRequests(employee.id, startDate, endDate, requests) : []
  , [employee, startDate, endDate, requests]);

  const eligibility = useMemo(() =>
    employee && leaveType ? checkEligibility(employee, leaveType, requests) : { ok: true, errors: [], warnings: [] }
  , [employee, leaveType, requests]);

  const willExceedBalance = currentBalance && (currentBalance.available - requestDays) < 0;
  const canSubmit = employee && leaveType && requestDays > 0 && eligibility.ok;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(''); setSubmitting(true);
    try {
      await onSubmit({
        employee_id: employeeId,
        leave_type_id: leaveTypeId,
        start_date: startDate,
        end_date: endDate,
        days: requestDays,
        is_half_day: isHalfDay,
        half_day_period: isHalfDay ? halfDayPeriod : null,
        reason: reason || null,
        attachment_url: attachmentUrl || null,
        status: 'pending',
      });
    } catch (err) {
      setError(err.message || 'Failed to submit');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
         style={{ background: 'rgba(15, 31, 26, 0.4)' }}
         onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="bg-paper rounded-t-2xl sm:rounded-2xl w-full max-w-2xl max-h-[92vh] overflow-y-auto fade-in"
        style={{ background: 'var(--paper)' }}>
        <div className="sticky top-0 z-10 flex items-center justify-between p-5 border-b backdrop-blur"
             style={{ borderColor: 'var(--border-soft)', background: 'rgba(250, 247, 240, 0.95)' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] opacity-50">NEW REQUEST</div>
            <h2 className="serif text-2xl mt-0.5" style={{ fontWeight: 500 }}>Request leave</h2>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-black/5">
            <X className="w-5 h-5"/>
          </button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-5">
          {/* Employee */}
          <div>
            <Label>Employee</Label>
            <input value={empSearch} onChange={e => setEmpSearch(e.target.value)}
              placeholder="Search by name or ID…"
              className="w-full px-3 py-2.5 rounded-lg border bg-transparent text-sm focus:outline-none mb-2"
              style={{ borderColor: 'var(--border-soft)' }}/>
            <div className="max-h-40 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border-soft)' }}>
              {filteredEmps.length === 0 ? (
                <div className="p-3 text-sm opacity-60 text-center">No employees match.</div>
              ) : filteredEmps.slice(0, 50).map(e => (
                <button key={e.id} type="button" onClick={() => { setEmployeeId(e.id); setEmpSearch(e.name); }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-black/5 flex justify-between border-b"
                  style={{
                    borderColor: 'var(--border-soft)',
                    background: employeeId === e.id ? 'var(--evergreen-50)' : 'transparent',
                  }}>
                  <span>{e.name}</span>
                  <span className="opacity-50 text-xs mono">{e.id} · {LOCATION_LABELS[e.location] || e.location}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Leave type */}
          <div>
            <Label>Leave type</Label>
            <div className="flex flex-wrap gap-2">
              {leaveTypes.map(t => (
                <button key={t.id} type="button" onClick={() => setLeaveTypeId(t.id)}
                  className="text-sm px-3 py-1.5 rounded-full border transition-all"
                  style={{
                    background: leaveTypeId === t.id ? `${t.color}25` : 'transparent',
                    borderColor: leaveTypeId === t.id ? t.color : 'var(--border-soft)',
                    color: leaveTypeId === t.id ? t.color : 'inherit',
                    fontWeight: leaveTypeId === t.id ? 500 : 400,
                  }}>
                  <span className="inline-block w-2 h-2 rounded-full mr-2" style={{ background: t.color }}/>
                  {t.name}
                </button>
              ))}
            </div>
            {leaveType?.description && (
              <div className="text-xs opacity-60 mt-2">{leaveType.description}</div>
            )}
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start date</Label>
              <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} required
                className="w-full px-3 py-2.5 rounded-lg border bg-transparent text-sm focus:outline-none"
                style={{ borderColor: 'var(--border-soft)' }}/>
            </div>
            <div>
              <Label>End date</Label>
              <input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} required min={startDate}
                disabled={isHalfDay}
                className="w-full px-3 py-2.5 rounded-lg border bg-transparent text-sm focus:outline-none disabled:opacity-50"
                style={{ borderColor: 'var(--border-soft)' }}/>
            </div>
          </div>

          <div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={isHalfDay}
                onChange={e => { setIsHalfDay(e.target.checked); if (e.target.checked) setEndDate(startDate); }}
                className="w-4 h-4"/>
              <span className="text-sm">Half-day request</span>
            </label>
            {isHalfDay && (
              <div className="flex gap-2 mt-2 ml-6">
                {['morning','afternoon'].map(p => (
                  <button key={p} type="button" onClick={() => setHalfDayPeriod(p)}
                    className="text-xs px-3 py-1 rounded-full border"
                    style={{
                      background: halfDayPeriod === p ? 'var(--evergreen-500)' : 'transparent',
                      color: halfDayPeriod === p ? 'var(--paper)' : 'inherit',
                      borderColor: halfDayPeriod === p ? 'var(--evergreen-500)' : 'var(--border-soft)',
                    }}>
                    {p.charAt(0).toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Live preview / warnings */}
          {employee && leaveType && (
            <div className="rounded-lg border p-4 space-y-3"
                 style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs opacity-70">
                  <Calendar className="w-4 h-4"/>
                  Duration
                </div>
                <div className="serif text-2xl" style={{ fontWeight: 500 }}>
                  {requestDays} <span className="text-sm opacity-60">{requestDays === 1 ? 'day' : 'days'}</span>
                </div>
              </div>

              {currentBalance && (
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <Stat tag="ENTITLED" val={currentBalance.total}/>
                  <Stat tag="USED+PENDING" val={`${currentBalance.used + currentBalance.pending}`}/>
                  <Stat tag="AFTER REQUEST"
                        val={(currentBalance.available - requestDays).toFixed(1)}
                        accent={willExceedBalance ? 'var(--clay)' : 'var(--evergreen-500)'}/>
                </div>
              )}

              {currentBalance?.accrualNote && (
                <div className="text-xs opacity-60">{currentBalance.accrualNote}</div>
              )}
            </div>
          )}

          {/* Eligibility errors */}
          {eligibility.errors.length > 0 && (
            <Warning kind="error">
              {eligibility.errors.map((e, i) => <div key={i}>{e}</div>)}
            </Warning>
          )}

          {willExceedBalance && (
            <Warning kind="warn">
              This request exceeds available balance by {Math.abs(currentBalance.available - requestDays).toFixed(1)} days. You can still submit, but will need to grant a balance adjustment for it to settle cleanly.
            </Warning>
          )}

          {overlapping.length > 0 && (
            <Warning kind="warn">
              Overlaps with {overlapping.length} other {overlapping.length === 1 ? 'request' : 'requests'} for this employee:
              <ul className="mt-1 ml-4 list-disc">
                {overlapping.map(o => <li key={o.id}>{fmtDateShort(o.start_date)} → {fmtDateShort(o.end_date)} ({o.status})</li>)}
              </ul>
            </Warning>
          )}

          {leaveType?.requires_attachment && (
            <div>
              <Label>Attachment URL <span className="opacity-60">(certificate, document)</span></Label>
              <input type="url" value={attachmentUrl} onChange={e => setAttachmentUrl(e.target.value)}
                placeholder="https://…"
                className="w-full px-3 py-2.5 rounded-lg border bg-transparent text-sm focus:outline-none"
                style={{ borderColor: 'var(--border-soft)' }}/>
            </div>
          )}

          <div>
            <Label>Reason <span className="opacity-60">(optional)</span></Label>
            <textarea value={reason} onChange={e => setReason(e.target.value)}
              rows={3} placeholder="Any context for the approver…"
              className="w-full px-3 py-2.5 rounded-lg border bg-transparent text-sm focus:outline-none resize-none"
              style={{ borderColor: 'var(--border-soft)' }}/>
          </div>

          {error && <Warning kind="error">{error}</Warning>}

          <div className="flex gap-3 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-3 rounded-full border text-sm"
              style={{ borderColor: 'var(--border-soft)' }}>
              Cancel
            </button>
            <button type="submit" disabled={!canSubmit || submitting}
              className="flex-1 px-4 py-3 rounded-full text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: 'var(--ink)', color: 'var(--paper)', fontWeight: 500 }}>
              {submitting ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Label({ children }) {
  return <label className="text-[10px] tracking-[0.2em] opacity-70 block mb-2 uppercase">{children}</label>;
}

function Stat({ tag, val, accent = 'var(--ink)' }) {
  return (
    <div className="rounded p-2 text-center" style={{ background: 'var(--paper-2)' }}>
      <div className="text-[9px] tracking-widest opacity-60">{tag}</div>
      <div className="serif text-lg mt-0.5" style={{ fontWeight: 500, color: accent }}>{val}</div>
    </div>
  );
}

function Warning({ kind, children }) {
  const isErr = kind === 'error';
  const Icon = isErr ? AlertCircle : AlertTriangle;
  return (
    <div className="flex items-start gap-2 text-xs p-3 rounded-lg"
         style={{
           background: isErr ? 'rgba(184,74,62,0.1)' : 'rgba(196,155,97,0.12)',
           color: isErr ? 'var(--clay)' : '#8B6B3E',
         }}>
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5"/>
      <div className="flex-1">{children}</div>
    </div>
  );
}
