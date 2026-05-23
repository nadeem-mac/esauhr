import React, { useState, useMemo, useEffect } from 'react';
import { X, AlertTriangle, AlertCircle, Calendar, ShieldCheck } from 'lucide-react';
import {
  calculateRequestDays, calculateBalance, findOverlappingRequests, checkEligibility,
  todayISO, fmtDateShort, LOCATION_LABELS, initialApprovalStage,
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

  // ── Type-specific details (saved into request.type_details JSONB).
  // A single object keyed by field name; each leave-type sub-form mutates
  // the fields it needs. Reset when the user changes leave type so we
  // don't carry stale paternity fields into a maternity submission.
  // The submit handler picks only the keys relevant to the active type.
  // Nadeem 2026-05-17: Phase A maternity → Phase B all other types.
  const [typeDetails, setTypeDetails] = useState({});
  const updTd = (patch) => setTypeDetails(prev => ({ ...prev, ...patch }));
  useEffect(() => { setTypeDetails({}); }, [leaveTypeId]);

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
      // Build per-type details payload. The typeDetails state object
      // already holds the fields the user filled in for the active
      // leave type. We pick only the keys relevant to that type and
      // derive computed fields (postnatal_days from prenatal_days for
      // maternity). Annual/sick keep their existing pipelines untouched.
      let payloadTypeDetails = null;
      const td = typeDetails || {};
      if (leaveTypeId === 'maternity') {
        const prenatal = td.prenatal_days != null && td.prenatal_days !== ''
                          ? Number(td.prenatal_days) : null;
        payloadTypeDetails = {
          expected_delivery:  td.expected_delivery || null,
          hospital:           (td.hospital || '').trim() || null,
          cert_ref:           (td.cert_ref || '').trim() || null,
          pregnancy_number:   td.pregnancy_number || null,
          prenatal_days:      prenatal,
          // Postnatal derived from 10-week (70-day) total per Art. 151.
          postnatal_days:     prenatal != null ? Math.max(0, 70 - prenatal) : null,
          already_delivered:  !!td.already_delivered,
          actual_delivery:    td.already_delivered ? (td.actual_delivery || null) : null,
          nursing_hours:      td.nursing_hours !== false,  // default true
        };
      } else if (leaveTypeId === 'paternity') {
        payloadTypeDetails = {
          spouse_name:        (td.spouse_name || '').trim() || null,
          expected_delivery:  td.expected_delivery || null,
          hospital:           (td.hospital || '').trim() || null,
          actual_delivery:    td.actual_delivery || null,
        };
      } else if (leaveTypeId === 'hajj') {
        payloadTypeDetails = {
          season_year:        (td.season_year || '').trim() || null,
          group:              (td.group || '').trim() || null,
          departure_date:     td.departure_date || null,
          return_date:        td.return_date || null,
          first_time:         !!td.first_time,
          service_years:      td.service_years || null,
        };
      } else if (leaveTypeId === 'marriage') {
        payloadTypeDetails = {
          spouse_name:        (td.spouse_name || '').trim() || null,
          wedding_date:       td.wedding_date || null,
          location:           (td.location || '').trim() || null,
          contract_no:        (td.contract_no || '').trim() || null,
        };
      } else if (leaveTypeId === 'bereavement') {
        payloadTypeDetails = {
          deceased_name:      (td.deceased_name || '').trim() || null,
          relationship:       (td.relationship || '').trim() || null,
          date_of_passing:    td.date_of_passing || null,
          funeral_location:   (td.funeral_location || '').trim() || null,
        };
      } else if (leaveTypeId === 'emergency') {
        payloadTypeDetails = {
          nature:             (td.nature || '').trim() || null,
          contact_person:     (td.contact_person || '').trim() || null,
          contact_phone:      (td.contact_phone || '').trim() || null,
          location:           (td.location || '').trim() || null,
        };
      } else if (leaveTypeId === 'study') {
        payloadTypeDetails = {
          institution:        (td.institution || '').trim() || null,
          course:             (td.course || '').trim() || null,
          format:             td.format || 'Full-time',
          total_duration:     (td.total_duration || '').trim() || null,
          field:              (td.field || '').trim() || null,
          relevance:          (td.relevance || '').trim() || null,
        };
      } else if (leaveTypeId === 'unpaid') {
        payloadTypeDetails = {
          reason:             (td.reason_detail || '').trim() || null,
          return_commitment:  (td.return_commitment || '').trim() || null,
        };
      } else if (leaveTypeId === 'iddah') {
        payloadTypeDetails = {
          bereavement_date:   td.bereavement_date || null,
          location:           (td.location || '').trim() || null,
          cert_ref:           (td.cert_ref || '').trim() || null,
          expected_end:       td.expected_end || null,
        };
      } else if (leaveTypeId === 'other') {
        payloadTypeDetails = {
          justification:      (td.justification || '').trim() || null,
        };
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
        // type_details — JSONB column on leave_requests. Holds the
        // type-specific fields the PDF generator reads (expected
        // delivery for maternity, cert ref for sick, etc.). Null for
        // types with no extra context to record.
        type_details: payloadTypeDetails,
        // Stage routing — per Nadeem (2026-05-06) explicit rules:
        //   • ALL STAFF non-sick    → pending_substitutes
        //   • ALL STAFF sick        → pending_manager
        //   • BASHAIER non-sick     → pending_substitutes (then manager
        //                             via DB trigger; HR-self guard
        //                             finalises at Fahad's manager step)
        //   • BASHAIER sick         → pending_manager
        //   • FAHAD non-sick        → pending_substitutes (then HR via
        //                             DB trigger which detects the
        //                             manager-bypass case and routes
        //                             pending_substitutes → pending_hr,
        //                             skipping pending_manager)
        //   • FAHAD sick            → pending_hr (no substitutes for
        //                             sick; goes straight to Bashaier)
        stage: (() => {
          const initial = initialApprovalStage(me, employees);
          if (isSick) {
            // Sick leaves don't use substitutes. Fahad's sick leave goes
            // directly to pending_hr; everyone else goes pending_manager.
            return initial === 'pending_hr' ? 'pending_hr' : 'pending_manager';
          }
          // Non-sick (annual, casual, emergency-with-subs etc.): always
          // start at pending_substitutes. The substitute-accept DB
          // trigger figures out the next stage:
          //   - Fahad's row → pending_hr (skip manager)
          //   - everyone else → pending_manager
          return 'pending_substitutes';
        })(),
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
                 style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
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

              {/* Carry-forward callout — visible whenever any portion
                  of ENTITLED comes from a prior year's unused balance.
                  Nadeem 2026-05-21. */}
              {currentBalance?.carried > 0 && (
                <div className="flex items-center gap-1.5 text-xs"
                     style={{ color: '#A16207' }}>
                  <span aria-hidden="true">↩</span>
                  <span>
                    Includes <strong>{currentBalance.carried}</strong>
                    {' '}{currentBalance.carried === 1 ? 'day' : 'days'} carried forward from {new Date().getFullYear() - 1}
                  </span>
                </div>
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
                {overlapping.map(o => (
                  <li key={o.id}>
                    {fmtDateShort(o.start_date)} → {fmtDateShort(o.end_date)}
                    {' '}({o.stage || o.status || 'unknown'})
                  </li>
                ))}
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
                  placeholder="e.g. GSL26042340605 or PSL260430135678"
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

          {/* TYPE-SPECIFIC DETAILS — saved into request.type_details JSONB
              for the approval PDF. Each block is gated on the active
              leave type; only one renders at a time. Field names match
              what drawTypeSpecificSection() in leaveApplicationPdf.js
              reads, so adding a row to the PDF is symmetric with adding
              an input here. Nadeem 2026-05-17. */}
          <TypeDetailsSection
            leaveTypeId={leaveTypeId}
            typeDetails={typeDetails}
            updTd={updTd}
            Label={Label}
          />

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

// =============================================================================
// TypeDetailsSection
//
// Renders the leave-type-specific input panel. One block per type, gated by
// `leaveTypeId`. Fields write to the shared `typeDetails` object via
// `updTd({key: value})`. Field names must match what
// `drawTypeSpecificSection()` in `leaveApplicationPdf.js` reads — adding a
// row to the PDF is symmetric with adding an input here.
//
// Visual: warm-pink for maternity (matches Article 151 / KSA labour-law
// theme), neutral light cream for the others so the form doesn't peacock
// with colors. Each section has a one-line legal/policy caption explaining
// the relevant KSA Labour Law article so the staff and HR both see the
// context inline.
//
// Nadeem 2026-05-17: Phase B — all eight remaining types wired up.
// =============================================================================
function TypeDetailsSection({ leaveTypeId, typeDetails, updTd, Label }) {
  // Reusable input — keeps the JSX below readable. Defaults to text input.
  // The bg is white inside the colored panel so values pop and the panel
  // tint provides the section identity.
  const inp = (props) => (
    <input
      type={props.type || 'text'}
      value={typeDetails[props.k] || ''}
      onChange={e => updTd({ [props.k]: e.target.value })}
      placeholder={props.placeholder || ''}
      min={props.min} max={props.max}
      className="w-full px-3 py-2 rounded-lg border bg-white text-sm focus:outline-none"
      style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}
    />
  );

  // Panel shell — common layout for all type sections so they line up
  // visually with each other no matter how many fields they have.
  const Panel = ({ title, subtitle, tint, children }) => (
    <div className="rounded-xl border p-4 space-y-3"
         style={{ borderColor: 'var(--border-soft)', background: tint || '#FAFAF7' }}>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.2em', fontWeight: 700 }}>
          — {title}
        </div>
        {subtitle && (
          <span className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.55 }}>
            {subtitle}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>
    </div>
  );

  // ── MATERNITY (Phase A, kept as-is) ──────────────────────────────────────
  if (leaveTypeId === 'maternity') {
    const prenatal = Number(typeDetails.prenatal_days) || 0;
    return (
      <Panel title="MATERNITY DETAILS" subtitle="Required per KSA Labour Law Art. 151" tint="#FFF1F2">
        <div><Label>Expected delivery date</Label>{inp({ k: 'expected_delivery', type: 'date' })}</div>
        <div>
          <Label>Pregnancy number</Label>
          <select value={typeDetails.pregnancy_number || ''}
            onChange={e => updTd({ pregnancy_number: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border bg-white text-sm focus:outline-none"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}>
            <option value="">Select…</option>
            <option value="1st">1st pregnancy</option>
            <option value="2nd">2nd pregnancy</option>
            <option value="3rd">3rd pregnancy</option>
            <option value="4th+">4th or later</option>
          </select>
        </div>
        <div className="sm:col-span-2"><Label>Hospital / clinic</Label>{inp({ k: 'hospital', placeholder: 'e.g. Saudi German Hospital, Al-Khobar' })}</div>
        <div className="sm:col-span-2">
          <Label>Medical certificate reference <span className="opacity-60 ml-1 font-normal">(obstetrician's cert — confirms pregnancy + EDD)</span></Label>
          {inp({ k: 'cert_ref', placeholder: 'e.g. SGH-OB-2026-04298' })}
        </div>
        <div className="sm:col-span-2">
          <Label>Prenatal days <span className="opacity-60 ml-1 font-normal">(how many of the 70-day total to use BEFORE delivery — max 28)</span></Label>
          <div className="flex items-center gap-3">
            <input type="number" min="0" max="28"
              value={typeDetails.prenatal_days || ''}
              onChange={e => updTd({ prenatal_days: e.target.value })}
              placeholder="0"
              className="w-24 px-3 py-2 rounded-lg border bg-white text-sm focus:outline-none"
              style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}/>
            <span className="text-[12px]" style={{ color: '#0A0A0A' }}>
              prenatal · <strong>{Math.max(0, 70 - prenatal)}</strong> postnatal
            </span>
          </div>
        </div>
        <div className="sm:col-span-2 pt-1">
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: '#0A0A0A' }}>
            <input type="checkbox" checked={!!typeDetails.already_delivered}
              onChange={e => updTd({ already_delivered: e.target.checked })}/>
            <span>Already delivered</span>
          </label>
          {typeDetails.already_delivered && (
            <div className="mt-2"><Label>Actual delivery date</Label>{inp({ k: 'actual_delivery', type: 'date' })}</div>
          )}
        </div>
        <div className="sm:col-span-2 pt-1">
          <label className="flex items-start gap-2 text-sm cursor-pointer" style={{ color: '#0A0A0A' }}>
            <input type="checkbox" checked={typeDetails.nursing_hours !== false}
              onChange={e => updTd({ nursing_hours: e.target.checked })}
              className="mt-1"/>
            <span>
              Request nursing-hour entitlement upon return
              <div className="text-[11px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.75 }}>
                Article 153 — one paid nursing hour per day for 24 months after birth.
              </div>
            </span>
          </label>
        </div>
      </Panel>
    );
  }

  // ── PATERNITY ────────────────────────────────────────────────────────────
  if (leaveTypeId === 'paternity') {
    return (
      <Panel title="PATERNITY DETAILS" subtitle="Per KSA Labour Law Art. 113 — 3 days paid">
        <div><Label>Spouse name</Label>{inp({ k: 'spouse_name' })}</div>
        <div><Label>Expected delivery date</Label>{inp({ k: 'expected_delivery', type: 'date' })}</div>
        <div><Label>Hospital / clinic</Label>{inp({ k: 'hospital' })}</div>
        <div><Label>Actual delivery date <span className="opacity-60 ml-1 font-normal">(if already born)</span></Label>{inp({ k: 'actual_delivery', type: 'date' })}</div>
      </Panel>
    );
  }

  // ── HAJJ ─────────────────────────────────────────────────────────────────
  if (leaveTypeId === 'hajj') {
    return (
      <Panel title="HAJJ DETAILS" subtitle="Per KSA Labour Law Art. 114 — once per career after 2 yrs service">
        <div><Label>Hajj season (Hijri year)</Label>{inp({ k: 'season_year', placeholder: 'e.g. 1448 AH' })}</div>
        <div><Label>Pilgrimage group / agency</Label>{inp({ k: 'group', placeholder: 'e.g. Group 4, Tawafa Establishment' })}</div>
        <div><Label>Departure date</Label>{inp({ k: 'departure_date', type: 'date' })}</div>
        <div><Label>Return date</Label>{inp({ k: 'return_date', type: 'date' })}</div>
        <div className="sm:col-span-2">
          <label className="flex items-center gap-2 text-sm cursor-pointer" style={{ color: '#0A0A0A' }}>
            <input type="checkbox" checked={!!typeDetails.first_time}
              onChange={e => updTd({ first_time: e.target.checked })}/>
            <span>This is my first Hajj <span className="opacity-60">(required for entitlement)</span></span>
          </label>
        </div>
      </Panel>
    );
  }

  // ── MARRIAGE ─────────────────────────────────────────────────────────────
  if (leaveTypeId === 'marriage') {
    return (
      <Panel title="MARRIAGE DETAILS" subtitle="Per KSA Labour Law — 5 days paid">
        <div><Label>Spouse name</Label>{inp({ k: 'spouse_name' })}</div>
        <div><Label>Wedding date</Label>{inp({ k: 'wedding_date', type: 'date' })}</div>
        <div><Label>Location <span className="opacity-60 ml-1 font-normal">(city/town)</span></Label>{inp({ k: 'location' })}</div>
        <div><Label>Marriage contract no. <span className="opacity-60 ml-1 font-normal">(Aqd nikah)</span></Label>{inp({ k: 'contract_no' })}</div>
      </Panel>
    );
  }

  // ── BEREAVEMENT ──────────────────────────────────────────────────────────
  if (leaveTypeId === 'bereavement') {
    return (
      <Panel title="BEREAVEMENT DETAILS" subtitle="Per KSA Labour Law — duration varies by relationship">
        <div><Label>Deceased name</Label>{inp({ k: 'deceased_name' })}</div>
        <div>
          <Label>Relationship</Label>
          <select value={typeDetails.relationship || ''}
            onChange={e => updTd({ relationship: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border bg-white text-sm focus:outline-none"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}>
            <option value="">Select…</option>
            <option value="Spouse">Spouse</option>
            <option value="Parent">Parent</option>
            <option value="Child">Child</option>
            <option value="Sibling">Sibling</option>
            <option value="Grandparent">Grandparent</option>
            <option value="In-law">In-law</option>
            <option value="Other">Other</option>
          </select>
        </div>
        <div><Label>Date of passing</Label>{inp({ k: 'date_of_passing', type: 'date' })}</div>
        <div><Label>Funeral location</Label>{inp({ k: 'funeral_location' })}</div>
      </Panel>
    );
  }

  // ── EMERGENCY ────────────────────────────────────────────────────────────
  if (leaveTypeId === 'emergency') {
    return (
      <Panel title="EMERGENCY DETAILS" subtitle="HR will treat this as time-sensitive">
        <div className="sm:col-span-2"><Label>Nature of emergency</Label>{inp({ k: 'nature', placeholder: 'Brief description (HR-only)' })}</div>
        <div><Label>Contact person</Label>{inp({ k: 'contact_person', placeholder: 'Family member or doctor' })}</div>
        <div><Label>Contact phone</Label>{inp({ k: 'contact_phone', type: 'tel', placeholder: '+966 5xx xxx xxxx' })}</div>
        <div className="sm:col-span-2"><Label>Location <span className="opacity-60 ml-1 font-normal">(if outside city)</span></Label>{inp({ k: 'location' })}</div>
      </Panel>
    );
  }

  // ── STUDY ────────────────────────────────────────────────────────────────
  if (leaveTypeId === 'study') {
    return (
      <Panel title="STUDY DETAILS" subtitle="Approval discretionary — relevance to role considered">
        <div><Label>Institution</Label>{inp({ k: 'institution' })}</div>
        <div><Label>Course / program</Label>{inp({ k: 'course' })}</div>
        <div>
          <Label>Study format</Label>
          <select value={typeDetails.format || 'Full-time'}
            onChange={e => updTd({ format: e.target.value })}
            className="w-full px-3 py-2 rounded-lg border bg-white text-sm focus:outline-none"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}>
            <option value="Full-time">Full-time</option>
            <option value="Part-time">Part-time</option>
            <option value="Distance/online">Distance/online</option>
            <option value="Block-release">Block-release</option>
          </select>
        </div>
        <div><Label>Total duration <span className="opacity-60 ml-1 font-normal">(e.g. 6 months, 1 year)</span></Label>{inp({ k: 'total_duration' })}</div>
        <div><Label>Field of study</Label>{inp({ k: 'field' })}</div>
        <div><Label>Relevance to role <span className="opacity-60 ml-1 font-normal">(why HR should approve)</span></Label>{inp({ k: 'relevance' })}</div>
      </Panel>
    );
  }

  // ── UNPAID ───────────────────────────────────────────────────────────────
  if (leaveTypeId === 'unpaid') {
    return (
      <Panel title="UNPAID LEAVE DETAILS" subtitle="No salary deducted from balance; counts against monthly attendance">
        <div className="sm:col-span-2"><Label>Reason for unpaid leave</Label>
          <textarea value={typeDetails.reason_detail || ''}
            onChange={e => updTd({ reason_detail: e.target.value })}
            rows={2}
            placeholder="Why paid leave isn't sufficient for this case"
            className="w-full px-3 py-2 rounded-lg border bg-white text-sm focus:outline-none resize-none"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}/>
        </div>
        <div className="sm:col-span-2"><Label>Return commitment</Label>
          <textarea value={typeDetails.return_commitment || ''}
            onChange={e => updTd({ return_commitment: e.target.value })}
            rows={2}
            placeholder="Stated intent to resume duties — gives HR a basis to hold the position"
            className="w-full px-3 py-2 rounded-lg border bg-white text-sm focus:outline-none resize-none"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}/>
        </div>
      </Panel>
    );
  }

  // ── IDDAH ────────────────────────────────────────────────────────────────
  if (leaveTypeId === 'iddah') {
    return (
      <Panel title="IDDAH DETAILS" subtitle="Per KSA Labour Law Art. 160 — 4 months 10 days for widowed Muslim women">
        <div><Label>Date of bereavement</Label>{inp({ k: 'bereavement_date', type: 'date' })}</div>
        <div><Label>Location <span className="opacity-60 ml-1 font-normal">(where iddah will be observed)</span></Label>{inp({ k: 'location' })}</div>
        <div><Label>Death certificate ref</Label>{inp({ k: 'cert_ref' })}</div>
        <div><Label>Expected end date</Label>{inp({ k: 'expected_end', type: 'date' })}</div>
      </Panel>
    );
  }

  // ── OTHER ────────────────────────────────────────────────────────────────
  if (leaveTypeId === 'other') {
    return (
      <Panel title="OTHER LEAVE — JUSTIFICATION" subtitle="Approval discretionary">
        <div className="sm:col-span-2"><Label>Full justification</Label>
          <textarea value={typeDetails.justification || ''}
            onChange={e => updTd({ justification: e.target.value })}
            rows={3}
            placeholder="Why none of the standard leave types fit this case"
            className="w-full px-3 py-2 rounded-lg border bg-white text-sm focus:outline-none resize-none"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}/>
        </div>
      </Panel>
    );
  }

  // Annual / sick: no extra panel (sick has its own Sehhaty form elsewhere).
  return null;
}
