import React, { useState, useMemo, useEffect } from 'react';
import { X, AlertTriangle, AlertCircle, Calendar, ShieldCheck } from 'lucide-react';
import {
  calculateRequestDays, calculateBalance, findOverlappingRequests, checkEligibility,
  todayISO, fmtDateShort, LOCATION_LABELS,
} from '../lib/leaveLogic.js';
import {
  normaliseSehhatyCode, looksLikeSehhatyCode,
  classifySickLeaveBracket,
} from '../lib/sehhaty.js';

export default function NewRequestModal({ me, employees, leaveTypes, requests, balances, holidays, lockedLeaveType, onClose, onSubmit }) {
  // Picker rule: admin and HR can pick any employee (e.g. submitting on
  // someone's behalf). Everyone else can only submit for themselves — their
  // own name is pre-locked, no search box, no dropdown. This matches item 4
  // of the access-control overhaul: "the staff can only request" for himself.
  const isPicker = !!(me?.is_admin || me?.is_hr_reviewer);
  const [employeeId, setEmployeeId] = useState(isPicker ? '' : (me?.id || ''));
  // When opened via the 'Sick leave' tile in the request picker, the
  // leave type is locked to 'sick' from the start. The leave-type
  // selector is hidden so the user can't swap to annual mid-form.
  const [leaveTypeId, setLeaveTypeId] = useState(lockedLeaveType || 'annual');
  const [customLeaveType, setCustomLeaveType] = useState('');
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState(todayISO());
  const [isHalfDay, setIsHalfDay] = useState(false);
  const [halfDayPeriod, setHalfDayPeriod] = useState('morning');
  const [reason, setReason] = useState('');
  // Attachment URL was a manual link field for cert uploads. With
  // Sehhaty as the source of truth for sick-leave certificates we no
  // longer ask for a separate URL — HR validates the leave ID
  // against Sehhaty directly. State retained as null so the column
  // value remains stable for downstream queries that still read it.
  const [empSearch, setEmpSearch] = useState('');
  const [substituteIds, setSubstituteIds] = useState([]);
  const [substituteSearch, setSubstituteSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Sehhaty fields — only shown / required when leave type is 'sick'.
  // Staff provides only the leave ID (the certificate's verification
  // code). Issue date and clinic are not collected from the staff;
  // HR sees them on Sehhaty itself when they verify the leave ID.
  const [sehhatyCode, setSehhatyCode] = useState('');

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

  // Belt-and-braces: if a non-picker user somehow renders before `me` is set,
  // backfill employeeId once it arrives so the request is always self-attributed.
  useEffect(() => {
    if (!isPicker && me?.id && employeeId !== me.id) {
      setEmployeeId(me.id);
    }
  }, [isPicker, me?.id, employeeId]);

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

  // Sick-leave specific: classify the pay bracket for the new days
  // and flag if the request crosses a Saudi Labour Law boundary
  // (30/60/30 split). Year-to-date sick days are summed from
  // approved + pending sick leave requests for this employee in
  // the current year.
  const isSick = leaveTypeId === 'sick';
  const sickYTD = useMemo(() => {
    if (!isSick || !employee) return 0;
    const yearStart = new Date().getFullYear() + '-01-01';
    return (requests || [])
      .filter(r => r.employee_id === employee.id
        && r.leave_type_id === 'sick'
        && (r.status === 'approved' || /^pending/.test(r.status || ''))
        && r.start_date >= yearStart)
      .reduce((sum, r) => sum + (Number(r.days) || 0), 0);
  }, [isSick, employee, requests]);
  const sickBracket = useMemo(() =>
    isSick ? classifySickLeaveBracket(sickYTD, requestDays) : null
  , [isSick, sickYTD, requestDays]);

  // Sehhaty validation: when sick leave is selected, the leave ID
  // must look plausible (alphanumeric ≥4 chars). The portal can't
  // verify the ID itself — that's HR's job after the request lands —
  // but we ensure the field isn't empty so HR has something to
  // check against.
  const sehhatyCodeValid = !isSick || looksLikeSehhatyCode(sehhatyCode);

  const canSubmit = employee && leaveType && requestDays > 0 && eligibility.ok
    && sehhatyCodeValid;

  const submit = async (e) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError('');
    if (leaveTypeId === 'other' && !customLeaveType.trim()) {
      setError('Please specify the type of leave when "Other" is selected.');
      return;
    }
    // Substitutes are mandatory for normal leave types but skipped
    // entirely for sick leave — staff are typically already ill (often
    // back-dating the request) and can't realistically pre-arrange
    // coverage for an unplanned absence. Sick leaves bypass the
    // pending_substitutes stage and go straight to the manager.
    if (!isSick) {
      if (substituteIds.length === 0) {
        setError('Please pick at least one substitute who can cover for you.');
        return;
      }
      if (substituteIds.length > 3) {
        setError('You can pick at most 3 substitutes.');
        return;
      }
    }
    setSubmitting(true);
    try {
      const decisions = {};
      if (!isSick) {
        substituteIds.forEach(psn => { decisions[psn] = { decision: 'pending' }; });
      }
      await onSubmit({
        employee_id: employeeId,
        leave_type_id: leaveTypeId,
        start_date: startDate,
        end_date: endDate,
        days: requestDays,
        is_half_day: isHalfDay,
        half_day_period: isHalfDay ? halfDayPeriod : null,
        reason: leaveTypeId === 'other' && customLeaveType
          ? `Other (${customLeaveType}): ${reason || ''}`.trim().replace(/: $/, '')
          : (reason || null),
        attachment_url: null,
        // Sick leaves carry an empty substitutes set — the column is
        // an array so '[]' is a valid value, and substitute_decisions
        // stays as '{}'. This preserves schema shape for downstream
        // queries that read these fields.
        substitute_ids: isSick ? [] : substituteIds,
        substitute_decisions: decisions,
        // Stage transition skips pending_substitutes for sick leaves —
        // they go straight to the manager so the substitute-accept
        // gate doesn't block a back-dated illness submission.
        stage: isSick ? 'pending_manager' : 'pending_substitutes',
        // Sehhaty fields. Staff provides only the leave ID
        // (sehhaty_code). Issue date and clinic are left null —
        // HR sees them directly on Sehhaty during verification, so
        // we don't ask the staff member to copy that information.
        sehhaty_code:        isSick ? normaliseSehhatyCode(sehhatyCode) : null,
        sehhaty_issue_date:  null,
        sehhaty_clinic:      null,
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
            {isPicker ? (
              <>
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
              </>
            ) : (
              <div className="rounded-lg border px-3 py-2.5 flex items-center justify-between"
                   style={{ borderColor: 'var(--border-soft)', background: 'var(--evergreen-50)' }}>
                <div className="min-w-0">
                  <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                    {me?.name || employeeId || 'You'}
                  </div>
                  <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                    {employeeId} · Submitting on your own behalf
                  </div>
                </div>
                <span className="text-[10px] tracking-[0.18em] px-2 py-0.5 rounded-full"
                      style={{ background: '#0F4C2A', color: 'white', fontWeight: 700 }}>
                  YOU
                </span>
              </div>
            )}
          </div>

          {/* Leave type. When the modal is opened from the 'Sick
              leave' tile in the request picker the type is locked
              and shown as a small read-only badge instead of the
              clickable chip strip — picking sick from the menu was
              the choice; we don't ask again here. */}
          {lockedLeaveType ? (
            <div>
              <Label>Leave type</Label>
              {(() => {
                const t = leaveTypes.find(x => x.id === lockedLeaveType);
                if (!t) return null;
                return (
                  <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full"
                    style={{ background: `${t.color}25`, color: t.color, fontWeight: 600 }}>
                    <span className="inline-block w-2 h-2 rounded-full" style={{ background: t.color }}/>
                    {t.name}
                  </div>
                );
              })()}
            </div>
          ) : (
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
            {leaveTypeId === 'other' && (
              <div className="mt-3 p-3 rounded-lg" style={{ background: 'var(--paper-soft, #F8F8F2)', border: '1px solid var(--border-soft)' }}>
                <Label>Specify leave type</Label>
                <input
                  type="text"
                  value={customLeaveType}
                  onChange={(e) => setCustomLeaveType(e.target.value)}
                  placeholder="e.g. Educational leave, Compassionate, Personal..."
                  className="w-full text-sm rounded-lg px-3 py-2 border outline-none mt-1"
                  style={{ borderColor: 'var(--border-soft)' }}
                  maxLength={80}
                />
                <div className="text-[10px] opacity-60 mt-1">This will be noted on the vacation form and approval email.</div>
              </div>
            )}
            {leaveType?.description && (
              <div className="text-xs opacity-60 mt-2">{leaveType.description}</div>
            )}
          </div>
          )}

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

          {/* Sehhaty (صحتي) details — required for sick leave per
              Saudi Labour Law. Since 2022 only Sehhaty-issued
              certificates are accepted; HR uses the service code
              shown on the certificate to verify it on Sehhaty's
              portal. We capture the code at submission time so HR
              has something to cross-check. */}
          {isSick && (
            <div className="rounded-xl border p-4"
              style={{ borderColor: '#86EFAC', background: '#F0FDF4' }}>
              <div className="flex items-center gap-2 mb-3">
                <ShieldCheck className="w-4 h-4" style={{ color: '#047857' }}/>
                <div className="text-xs tracking-widest" style={{ fontWeight: 700, color: '#047857' }}>
                  SEHHATY MEDICAL CERTIFICATE
                </div>
              </div>
              <p className="text-[11px] mb-3" style={{ color: '#0A0A0A' }}>
                Enter the leave ID printed on your Sehhaty certificate. HR will verify it on the Sehhaty portal before approving.
              </p>
              <div>
                <Label>Sehhaty leave ID <span style={{ color: '#B91C1C' }}>*</span></Label>
                <input type="text" value={sehhatyCode}
                  onChange={e => setSehhatyCode(e.target.value)}
                  placeholder="e.g. GSL-1234567"
                  className="w-full px-3 py-2.5 rounded-lg border text-sm font-mono uppercase"
                  style={{
                    borderColor: sehhatyCode && !sehhatyCodeValid ? '#B91C1C' : 'var(--border-soft)',
                    background: '#FFFFFF', color: '#0A0A0A',
                  }}/>
                {sehhatyCode && !sehhatyCodeValid && (
                  <div className="text-[10px] mt-1" style={{ color: '#B91C1C' }}>
                    ID looks too short. Sehhaty leave IDs are typically 4+ characters.
                  </div>
                )}
              </div>

              {/* Saudi Labour Law bracket warning — visible whenever
                  the request would push the employee into a new
                  pay-bracket band (75% or unpaid) so the requester
                  knows what to expect financially. */}
              {sickBracket && (
                <div className="mt-3 rounded-lg p-3 text-[11px]"
                  style={{
                    background: '#FFFFFF',
                    border: '1px solid ' + (sickBracket.crossesBoundary || sickBracket.overQuota ? '#FCA5A5' : 'var(--border-soft)'),
                    color: '#0A0A0A',
                  }}>
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
                    <span style={{ fontWeight: 700 }}>
                      Year-to-date sick days: {sickBracket.startTotal} of 120
                    </span>
                    <span className="font-mono">
                      After this request: {sickBracket.endTotal} ({sickBracket.daysRemaining} remaining)
                    </span>
                  </div>
                  <div>
                    Pay bracket for this request:{' '}
                    <span style={{
                      fontWeight: 700,
                      color: sickBracket.endBracket?.color,
                    }}>
                      {sickBracket.endBracket?.label}
                    </span>
                    {sickBracket.crossesBoundary && (
                      <span style={{ color: '#B91C1C', marginLeft: '6px' }}>
                        — crosses pay-bracket boundary mid-request; payroll will need to split.
                      </span>
                    )}
                    {sickBracket.overQuota && (
                      <span style={{ color: '#7F1D1D', marginLeft: '6px' }}>
                        — exceeds 120-day annual quota.
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div>
            <Label>Reason <span className="opacity-60">(optional)</span></Label>
            <textarea value={reason} onChange={e => setReason(e.target.value)}
              rows={3} placeholder="Any context for the approver…"
              className="w-full px-3 py-2.5 rounded-lg border bg-transparent text-sm focus:outline-none resize-none"
              style={{ borderColor: 'var(--border-soft)' }}/>
          </div>

          {/* SUBSTITUTE PICKER — required for staff to nominate 1-3 colleagues to cover.
              Skipped entirely for sick leave (the request goes straight
              to the manager since you can't pre-arrange illness). */}
          {employee && isSick && (
            <div className="rounded-xl border p-3 text-xs"
              style={{ borderColor: 'var(--border-soft)', background: '#FAFAF7', color: '#0A0A0A' }}>
              <span style={{ fontWeight: 600 }}>Substitutes are not required for sick leave.</span>
              <span className="opacity-70"> Your manager will be notified directly so coverage can be arranged on your behalf.</span>
            </div>
          )}
          {employee && !isSick && (
            <div>
              <Label>
                Substitutes <span className="opacity-60">(pick 1–3 colleagues from {employee.department} · {LOCATION_LABELS?.[employee.location] || employee.location})</span>
              </Label>
              <div className="text-xs opacity-60 mb-2">
                Each colleague you select will be asked to confirm they can cover for you. Your manager only sees this request after they all accept.
              </div>

              {/* Selected substitutes pills */}
              {substituteIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {substituteIds.map(id => {
                    const sub = employees.find(e => e.id === id);
                    return (
                      <button key={id} type="button"
                        onClick={() => setSubstituteIds(substituteIds.filter(x => x !== id))}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs"
                        style={{ background: 'var(--evergreen-50)', color: 'var(--evergreen-700)', border: '1px solid var(--evergreen-100)' }}>
                        <span style={{ fontWeight: 500 }}>{sub?.name?.split(' ').slice(0,2).join(' ') || id}</span>
                        <X className="w-3 h-3 opacity-60" />
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Search/picker — only show if room for more */}
              {substituteIds.length < 3 && (
                <>
                  <input type="text" value={substituteSearch}
                    onChange={e => setSubstituteSearch(e.target.value)}
                    placeholder="Search by name or PSN…"
                    className="w-full px-3 py-2 rounded-lg border bg-transparent text-sm focus:outline-none mb-2"
                    style={{ borderColor: 'var(--border-soft)' }}/>
                  <div className="max-h-40 overflow-y-auto rounded-lg border" style={{ borderColor: 'var(--border-soft)' }}>
                    {employees
                      .filter(e =>
                        e.id !== employee.id &&
                        e.department === employee.department &&
                        e.location === employee.location &&
                        !substituteIds.includes(e.id) &&
                        (!substituteSearch ||
                          e.name.toLowerCase().includes(substituteSearch.toLowerCase()) ||
                          e.id.toLowerCase().includes(substituteSearch.toLowerCase()))
                      )
                      .slice(0, 8)
                      .map(e => (
                        <button key={e.id} type="button"
                          onClick={() => { setSubstituteIds([...substituteIds, e.id]); setSubstituteSearch(''); }}
                          className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-black/5 transition-colors text-left">
                          <span style={{ fontWeight: 500 }}>{e.name}</span>
                          <span className="text-xs opacity-50">{e.id}</span>
                        </button>
                      ))}
                    {employees.filter(e =>
                      e.id !== employee.id &&
                      e.department === employee.department &&
                      e.location === employee.location &&
                      !substituteIds.includes(e.id)
                    ).length === 0 && (
                      <div className="px-3 py-3 text-xs opacity-50 text-center">
                        No colleagues left to add from {employee.department} · {employee.location}.
                      </div>
                    )}
                  </div>
                </>
              )}

              {substituteIds.length >= 3 && (
                <div className="text-xs opacity-60">Maximum of 3 substitutes reached. Remove one above to swap.</div>
              )}
            </div>
          )}

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
