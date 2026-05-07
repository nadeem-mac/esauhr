import React, { useState, useMemo, useEffect } from 'react';
import { X, Calendar, User, FileText, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { directPost } from '../supabaseClient.js';

// =============================================================================
// LogLeaveModal.jsx
//
// HR direct-entry path for long-term and special leaves. Bypasses the
// staff → manager → HR approval chain in favor of a single "log it now"
// action. Used for cases that don't fit the self-service flow:
//
//   • Maternity leave (often arranged informally before the system's
//     request UI is filled out)
//   • Hajj leave (planned far in advance, arranged offline)
//   • Extended sick leave with certificate already in HR's hands
//   • Bereavement, emergency leave the staff didn't have time to file
//   • Retroactive logging of a leave that was approved verbally
//
// On submit:
//   1. Inserts a leave_requests row with status='approved', stage='approved',
//      decided_at=NOW so it's immediately authoritative
//   2. Triggers attendance re-evaluation for the affected window so
//      attendance_daily rows reclassify (or get seeded if missing) to
//      the correct leave status
//
// Visible only to admin or HR reviewer.
// =============================================================================

// Days-calculation helpers. KSA weekend = Friday + Saturday.
function isKsaWeekend(date) {
  const dow = date.getDay();
  return dow === 5 || dow === 6;
}

function calendarDays(start, end) {
  if (!start || !end) return 0;
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end   + 'T00:00:00');
  if (e < s) return 0;
  return Math.round((e - s) / 86_400_000) + 1;
}

function workingDays(start, end) {
  if (!start || !end) return 0;
  const s = new Date(start + 'T00:00:00');
  const e = new Date(end   + 'T00:00:00');
  if (e < s) return 0;
  let count = 0;
  const cursor = new Date(s);
  while (cursor <= e) {
    if (!isKsaWeekend(cursor)) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

// For each leave type, decide whether the "days" field defaults to
// calendar days (statutory leaves: maternity / sick / hajj) or working
// days (annual / casual / emergency). The user can always override via
// the editable input — this just sets a sensible starting value.
function defaultDaysFor(leaveTypeId, start, end) {
  const k = String(leaveTypeId || '').toLowerCase();
  const useCalendar = (
    k.includes('sick')      ||
    k.includes('maternit')  ||
    k.includes('paternit')  ||
    k.includes('hajj')      ||
    k.includes('bereave')
  );
  return useCalendar ? calendarDays(start, end) : workingDays(start, end);
}

export default function LogLeaveModal({
  me,
  employees = [],
  leaveTypes = [],
  onClose,
  onSuccess,           // called after successful insert; parent should
                       // trigger reeval for the date range
}) {
  const [employeeId, setEmployeeId] = useState('');
  const [empSearch,  setEmpSearch]  = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate,   setEndDate]   = useState('');
  const [days,      setDays]      = useState('');
  const [reason,    setReason]    = useState('');
  const [isHalfDay, setIsHalfDay] = useState(false);
  const [halfDayPeriod, setHalfDayPeriod] = useState('morning');
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState(null);
  const [success,    setSuccess]    = useState(false);

  // When dates or leave type change, recompute the suggested days.
  // Only update if the user hasn't manually overridden — track via a
  // separate flag so a manual edit isn't clobbered by a date change.
  const [daysAutoFilled, setDaysAutoFilled] = useState(true);
  useEffect(() => {
    if (!daysAutoFilled) return;
    if (isHalfDay) {
      setDays('0.5');
      return;
    }
    if (startDate && endDate && leaveTypeId) {
      const d = defaultDaysFor(leaveTypeId, startDate, endDate);
      setDays(String(d));
    }
  }, [startDate, endDate, leaveTypeId, isHalfDay, daysAutoFilled]);

  // Half-day is only valid for single-day leaves. Disable the toggle
  // when the date range spans more than one day, and force-clear it
  // if the user extends the range while half-day was active.
  const isSingleDay = startDate && endDate && startDate === endDate;
  useEffect(() => {
    if (!isSingleDay && isHalfDay) setIsHalfDay(false);
  }, [isSingleDay, isHalfDay]);

  // Filter employee list by the search box. Empty search shows all.
  // Match is case-insensitive substring across name, PSN, and email.
  const filteredEmps = useMemo(() => {
    const q = empSearch.trim().toLowerCase();
    const all = (employees || [])
      .filter(e => e?.id && !e.terminated && e.is_active !== false && e.status !== 'inactive')
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    if (!q) return all.slice(0, 50); // cap render to keep dropdown snappy
    return all.filter(e => {
      const hay = [e.name, e.id, e.email].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    }).slice(0, 50);
  }, [employees, empSearch]);

  const selectedEmp = useMemo(
    () => (employees || []).find(e => e.id === employeeId) || null,
    [employees, employeeId]
  );
  const selectedType = useMemo(
    () => (leaveTypes || []).find(t => t.id === leaveTypeId) || null,
    [leaveTypes, leaveTypeId]
  );

  function validate() {
    if (!employeeId)            return 'Pick an employee.';
    if (!leaveTypeId)           return 'Pick a leave type.';
    if (!startDate || !endDate) return 'Set start and end dates.';
    if (endDate < startDate)    return 'End date can\u2019t be before start date.';
    if (!days || Number(days) <= 0) return 'Enter the number of days.';
    if (isHalfDay && !isSingleDay) return 'Half-day is only valid for a single date.';
    if (!reason || reason.trim().length < 3) return 'Add a brief reason (min 3 chars).';
    return null;
  }

  async function handleSubmit() {
    setError(null);
    const v = validate();
    if (v) { setError(v); return; }
    setSubmitting(true);
    try {
      const payload = {
        employee_id:    employeeId,
        leave_type_id:  leaveTypeId,
        start_date:     startDate,
        end_date:       endDate,
        days:           Number(days),
        reason:         reason.trim(),
        status:         'approved',
        stage:          'approved',
        decided_at:     new Date().toISOString(),
        is_half_day:    isHalfDay,
        half_day_period: isHalfDay ? halfDayPeriod : null,
        // Audit — record who direct-logged this so it's clear in the
        // history the leave didn't come through the normal request flow.
        notes:          `Direct entry by HR (${me?.name || me?.id || 'admin'})`,
      };
      await directPost('leave_requests', payload, { timeoutMs: 10000 });
      setSuccess(true);
      // Tell the parent so it can trigger reeval for the affected
      // window. Parent decides whether to close the modal immediately
      // or leave the success state visible.
      if (onSuccess) {
        try { onSuccess({ employeeId, startDate, endDate, leaveTypeId }); } catch {}
      }
      // Auto-close after a short delay so the user sees the success
      // state, then can return to the workspace.
      setTimeout(() => { try { onClose?.(); } catch {} }, 1400);
    } catch (e) {
      const msg = String(e?.message || e);
      // PostgREST surfaces the unique-constraint and FK errors via
      // numeric codes; map the common ones to human-readable text.
      if (msg.includes('23505')) {
        setError('A leave already exists for this employee on these dates.');
      } else if (msg.includes('23503')) {
        setError('Leave type or employee no longer exists in the directory.');
      } else if (msg.includes('23514')) {
        setError('Database rejected the row \u2014 likely a status check constraint.');
      } else {
        setError('Failed to log the leave: ' + msg);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Render ───────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(31,27,22,0.4)' }}
      onClick={onClose}>
      <div className="rounded-xl shadow-lg w-full max-w-2xl overflow-hidden"
        style={{
          background: '#FFFFFF',
          border: '1px solid #EEEAE0',
          fontFamily: 'inherit',
        }}
        onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="px-5 py-4 flex items-start justify-between"
          style={{ borderBottom: '1px solid #EEEAE0' }}>
          <div>
            <div className="text-[10px]" style={{ color: '#7A7A7A', letterSpacing: '0.08em', fontWeight: 600 }}>
              HR DIRECT ENTRY
            </div>
            <div className="text-[15px] mt-0.5" style={{ color: '#0A0A0A', fontWeight: 700 }}>
              Log long-term leave
            </div>
            <div className="text-[11px] mt-1" style={{ color: '#7A7A7A' }}>
              Bypasses the request workflow. Use for maternity, hajj, retroactive sick, or any leave already approved offline.
            </div>
          </div>
          <button onClick={onClose}
            className="p-1 rounded hover:bg-[#FAFAF9]"
            style={{ color: '#7A7A7A' }}
            disabled={submitting}>
            <X className="w-4 h-4"/>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">

          {/* Employee picker */}
          <div>
            <label className="text-[10px] block mb-1"
              style={{ color: '#0A0A0A', letterSpacing: '0.05em', fontWeight: 600, textTransform: 'uppercase' }}>
              <User className="w-3 h-3 inline-block mr-1" style={{ verticalAlign: '-1px' }}/>
              Employee
            </label>
            {selectedEmp ? (
              <div className="flex items-center justify-between px-3 py-2 rounded-md"
                style={{ background: '#F1FBF7', border: '1px solid #D7F0E5' }}>
                <div>
                  <div className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
                    {selectedEmp.name}
                  </div>
                  <div className="text-[10px]" style={{ color: '#7A7A7A', fontFamily: 'monospace' }}>
                    {selectedEmp.id}{selectedEmp.department ? ' \u00b7 ' + selectedEmp.department : ''}{selectedEmp.location ? ' \u00b7 ' + selectedEmp.location : ''}
                  </div>
                </div>
                <button onClick={() => { setEmployeeId(''); setEmpSearch(''); }}
                  className="text-[10px] px-2 py-1 rounded"
                  style={{ background: '#FFFFFF', border: '1px solid #D4D4D4', color: '#7A7A7A' }}
                  disabled={submitting}>
                  Change
                </button>
              </div>
            ) : (
              <div>
                <input
                  type="text"
                  value={empSearch}
                  onChange={(e) => setEmpSearch(e.target.value)}
                  placeholder="Search by name, PSN, or email..."
                  className="w-full px-3 py-2 rounded-md text-[12px]"
                  style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A' }}
                  disabled={submitting}
                />
                {empSearch.trim() && filteredEmps.length > 0 && (
                  <div className="mt-1 rounded-md max-h-48 overflow-y-auto"
                    style={{ border: '1px solid #EEEAE0', background: '#FFFFFF' }}>
                    {filteredEmps.map(e => (
                      <button key={e.id}
                        onClick={() => { setEmployeeId(e.id); setEmpSearch(''); }}
                        className="w-full text-left px-3 py-1.5 hover:bg-[#FAFAF9]"
                        disabled={submitting}>
                        <div className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 500 }}>
                          {e.name}
                          <span className="ml-2 text-[10px]" style={{ color: '#7A7A7A', fontFamily: 'monospace', fontWeight: 400 }}>
                            {e.id}
                          </span>
                        </div>
                        {(e.department || e.location) && (
                          <div className="text-[10px]" style={{ color: '#7A7A7A' }}>
                            {[e.department, e.location].filter(Boolean).join(' \u00b7 ')}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
                {empSearch.trim() && filteredEmps.length === 0 && (
                  <div className="text-[10px] mt-1" style={{ color: '#7A7A7A' }}>
                    No matching staff found.
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Leave type picker */}
          <div>
            <label className="text-[10px] block mb-1"
              style={{ color: '#0A0A0A', letterSpacing: '0.05em', fontWeight: 600, textTransform: 'uppercase' }}>
              <FileText className="w-3 h-3 inline-block mr-1" style={{ verticalAlign: '-1px' }}/>
              Leave type
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {(leaveTypes || []).map(t => (
                <button key={t.id}
                  onClick={() => { setLeaveTypeId(t.id); setDaysAutoFilled(true); }}
                  className="text-[11px] px-3 py-2 rounded-md text-left"
                  style={{
                    background:  leaveTypeId === t.id ? '#0F4C2A' : '#FFFFFF',
                    color:       leaveTypeId === t.id ? '#FFFFFF' : '#0A0A0A',
                    border:      '1px solid ' + (leaveTypeId === t.id ? '#0F4C2A' : '#D4D4D4'),
                    fontWeight:  leaveTypeId === t.id ? 600 : 500,
                  }}
                  disabled={submitting}>
                  {t.name}
                </button>
              ))}
            </div>
            {(!leaveTypes || leaveTypes.length === 0) && (
              <div className="text-[10px] mt-1" style={{ color: '#A32D2D' }}>
                No leave types configured \u2014 ask the admin to seed the leave_types table first.
              </div>
            )}
          </div>

          {/* Date range */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] block mb-1"
                style={{ color: '#0A0A0A', letterSpacing: '0.05em', fontWeight: 600, textTransform: 'uppercase' }}>
                <Calendar className="w-3 h-3 inline-block mr-1" style={{ verticalAlign: '-1px' }}/>
                Start
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); setDaysAutoFilled(true); }}
                className="w-full px-3 py-2 rounded-md text-[12px]"
                style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A' }}
                disabled={submitting}
              />
            </div>
            <div>
              <label className="text-[10px] block mb-1"
                style={{ color: '#0A0A0A', letterSpacing: '0.05em', fontWeight: 600, textTransform: 'uppercase' }}>
                End
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => { setEndDate(e.target.value); setDaysAutoFilled(true); }}
                className="w-full px-3 py-2 rounded-md text-[12px]"
                style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A' }}
                disabled={submitting}
              />
            </div>
          </div>

          {/* Days + half-day */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[10px] block mb-1"
                style={{ color: '#0A0A0A', letterSpacing: '0.05em', fontWeight: 600, textTransform: 'uppercase' }}>
                Days
              </label>
              <input
                type="number"
                min="0.5"
                step="0.5"
                value={days}
                onChange={(e) => { setDays(e.target.value); setDaysAutoFilled(false); }}
                className="w-full px-3 py-2 rounded-md text-[12px]"
                style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A' }}
                disabled={submitting}
              />
              {startDate && endDate && (
                <div className="text-[10px] mt-1" style={{ color: '#7A7A7A' }}>
                  {calendarDays(startDate, endDate)} calendar days \u00b7 {workingDays(startDate, endDate)} working days
                </div>
              )}
            </div>
            <div>
              <label className="text-[10px] block mb-1"
                style={{ color: '#0A0A0A', letterSpacing: '0.05em', fontWeight: 600, textTransform: 'uppercase' }}>
                Half-day?
              </label>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsHalfDay(v => !v)}
                  disabled={submitting || !isSingleDay}
                  className="text-[11px] px-3 py-2 rounded-md flex-1"
                  style={{
                    background: isHalfDay ? '#854F0B' : '#FFFFFF',
                    color:      isHalfDay ? '#FFFFFF' : (isSingleDay ? '#0A0A0A' : '#A1A1AA'),
                    border:     '1px solid ' + (isHalfDay ? '#854F0B' : '#D4D4D4'),
                    cursor:     isSingleDay ? 'pointer' : 'not-allowed',
                    fontWeight: 600,
                  }}>
                  {isHalfDay ? '\u2713 Half day' : 'Full day'}
                </button>
                {isHalfDay && (
                  <select
                    value={halfDayPeriod}
                    onChange={(e) => setHalfDayPeriod(e.target.value)}
                    className="text-[11px] px-2 py-2 rounded-md"
                    style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A' }}
                    disabled={submitting}>
                    <option value="morning">Morning</option>
                    <option value="afternoon">Afternoon</option>
                  </select>
                )}
              </div>
            </div>
          </div>

          {/* Reason */}
          <div>
            <label className="text-[10px] block mb-1"
              style={{ color: '#0A0A0A', letterSpacing: '0.05em', fontWeight: 600, textTransform: 'uppercase' }}>
              Reason / notes
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              placeholder="e.g., Maternity leave \u2014 medical certificate received 2026-04-28"
              className="w-full px-3 py-2 rounded-md text-[12px]"
              style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', resize: 'vertical' }}
              disabled={submitting}
            />
          </div>

          {/* Validation summary */}
          {error && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md"
              style={{ background: '#FEF2F2', border: '1px solid #FCA5A5' }}>
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#A32D2D' }}/>
              <div className="text-[11px]" style={{ color: '#A32D2D' }}>{error}</div>
            </div>
          )}

          {success && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md"
              style={{ background: '#F1FBF7', border: '1px solid #86EFAC' }}>
              <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#0F6E56' }}/>
              <div className="text-[11px]" style={{ color: '#0F6E56' }}>
                Leave logged. Re-evaluation has been triggered \u2014 the calendar will refresh with the new classification.
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 flex items-center justify-between gap-3"
          style={{ borderTop: '1px solid #EEEAE0', background: '#FAFAF9' }}>
          <div className="text-[10px]" style={{ color: '#7A7A7A' }}>
            {selectedType && (
              <>
                <strong style={{ color: '#0A0A0A' }}>{selectedType.name}</strong>
                {selectedEmp && <> for <strong style={{ color: '#0A0A0A' }}>{selectedEmp.name}</strong></>}
                {startDate && endDate && (
                  <> from <strong style={{ color: '#0A0A0A' }}>{startDate}</strong> to <strong style={{ color: '#0A0A0A' }}>{endDate}</strong></>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose}
              className="text-[11px] px-3 py-1.5 rounded-md"
              style={{ background: '#FFFFFF', border: '1px solid #D4D4D4', color: '#0A0A0A', fontWeight: 500 }}
              disabled={submitting}>
              Cancel
            </button>
            <button onClick={handleSubmit}
              className="text-[11px] px-4 py-1.5 rounded-md flex items-center gap-1.5"
              style={{
                background: submitting ? '#A1A1AA' : '#0F4C2A',
                color: '#FFFFFF',
                border: '1px solid ' + (submitting ? '#A1A1AA' : '#0F4C2A'),
                fontWeight: 600,
                cursor: submitting ? 'wait' : 'pointer',
              }}
              disabled={submitting || success}>
              {submitting && <Loader2 className="w-3 h-3 animate-spin"/>}
              {submitting ? 'Logging...' : success ? '\u2713 Logged' : 'Log leave (approved)'}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
