import React, { useMemo, useState } from 'react';
import { X, Mail, AlertTriangle, Check, Loader2, Calendar, ExternalLink } from 'lucide-react';
import { directPost } from '../supabaseClient.js';
import { parseEmailAddress } from '../lib/emailTemplates.js';
import { salutationFor } from '../lib/salutations.js';

// ─────────────────────────────────────────────────────────────────────────────
// EvaluationReviewModal
// Phase 6 of the shift-staff workflow.
//
// Trigger
//   BashaierTasksCard counts attendance_violations per employee per calendar
//   month. When an employee crosses 5 in a month, a row appears in the
//   "Performance escalation" panel. Bashaier clicks "Review" → this modal opens.
//
// What it does
//   • Shows the breakdown (late/early/missed counts, dates, deduction math).
//   • Pre-drafts a warning email to the direct manager (with the standard
//     CC chain). One-click "Send & log" opens the mail client AND writes
//     a row to evaluation_scores so the score view picks it up.
//
// Schema reference (verified against live DB by direct probe):
//   evaluation_scores columns:
//     id, employee_id, period_year, period_month,
//     base_score, attendance_deduction, violation_count,
//     warning_email_sent, warning_email_sent_at, warning_email_sent_to,
//     reviewed_by, reviewed_at, notes, created_at, updated_at
//   Unique constraint: (employee_id, period_year, period_month)
//
//   evaluation_scores_final view: same columns + computed final_score.
//   Verified live: final_score = base_score - attendance_deduction
//   (e.g. 8 violations → deduction 6 → final 94).
//
// Insert payload per click:
//   employee_id, period_year, period_month        → identity (constraint key)
//   violation_count                               → row.totalCount
//   base_score                                    → 100 (baseline)
//   attendance_deduction                          → max(0, totalCount - 5) * 2
//   warning_email_sent / _at / _to                → true / now / manager email
//   reviewed_by, reviewed_at                      → Bashaier / now
//   notes                                         → human-readable breakdown
//
// Idempotency: catch 23505 (unique_violation) on the unique constraint and
// treat it as success — same pattern P5 uses for attendance_violations.
//
// Idempotency
//   evaluation_scores has no unique constraint we can rely on, so we check
//   app-side: load existing rows for this employee and skip if a row with
//   the same month-tag already exists in `notes`.
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_CC = [
  'johnho@evergreen-shipping.com.sa',
  'jamesliu@evergreen-shipping.com.sa',
  'badria.alhassan@evergreen-shipping.com.sa',
  'jaffar.aldarweash@evergreen-shipping.com.sa',
  'fahad.alhussain@evergreen-shipping.com.sa',
];

const HR_SIGNATURE =
  'Thanks and regards,\n\n' +
  'BASHAIER ALI\n' +
  'Evergreen Shipping Agency Saudi Co.,(L.L.C)\n' +
  'ESAU - SADMN SUP/ HR DEPT\n' +
  'Whatsapp: 966-54 320 9694\n' +
  'Tel: 966-013 813 8563 – Ext 8543\n' +
  'Email:bashaier.alsubaie@evergreen-shipping.com.sa';

function buildMailto({ to, cc, subject, body }) {
  const parts = [];
  const ccStr = (cc || []).filter(Boolean).join(',');
  if (ccStr)   parts.push('cc='      + encodeURIComponent(ccStr));
  if (subject) parts.push('subject=' + encodeURIComponent(subject));
  if (body)    parts.push('body='    + encodeURIComponent(body));
  return 'mailto:' + (to || '') + (parts.length ? '?' + parts.join('&') : '');
}

function fmtMonthLong(monthStart) {
  // monthStart is 'YYYY-MM-01'
  const [y, m] = monthStart.split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, 1);
  return dt.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function fmtDateShort(d) {
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Build the structured notes string. We stuff the month tag at the start
// so app-side idempotency can match on a prefix without a unique constraint.
function buildNotes({ monthLong, lateCount, earlyCount, missedCount, totalCount, pointsDeducted }) {
  return (
    `[${monthLong}] Attendance escalation: ${totalCount} violations ` +
    `(${lateCount} late, ${earlyCount} early, ${missedCount} missed). ` +
    `${pointsDeducted} point${pointsDeducted === 1 ? '' : 's'} deducted ` +
    `(2 per violation beyond 5).`
  );
}

function buildWarningEmail({ employee, manager, monthLong, totalCount, lateCount, earlyCount, missedCount, pointsDeducted, sampleDates }) {
  const empPsn = String(employee?.id || '').toUpperCase();
  const empName = String(employee?.name || '').toUpperCase();
  // Salutation goes through the shared helper so per-PSN overrides
  // (e.g. Capt. Sharique for H94460) apply consistently across every
  // email composer in the app. Nadeem 2026-05-17.
  const mgrFirst = salutationFor(manager);

  const subject = `Attendance Escalation — ${empPsn} ${empName} — ${monthLong}`;

  const breakdown = [
    `• Late arrivals: ${lateCount}`,
    `• Early departures: ${earlyCount}`,
    `• Missed punches: ${missedCount}`,
  ].join('\n');

  const sampleLine = sampleDates && sampleDates.length
    ? `Recent dates flagged: ${sampleDates.slice(0, 5).map(fmtDateShort).join(', ')}` +
      (sampleDates.length > 5 ? ` (and ${sampleDates.length - 5} more)` : '')
    : '';

  const body =
    `Dear ${mgrFirst},\n\n` +
    `I am writing to flag an attendance concern with ${employee?.name || empPsn} for ${monthLong}. ` +
    `Across the month, ${employee?.first_name || (employee?.name || '').split(' ')[0] || 'they'} ` +
    `accumulated ${totalCount} attendance incidents — above our 5-per-month threshold:\n\n` +
    breakdown + '\n\n' +
    (sampleLine ? sampleLine + '\n\n' : '') +
    `Per ESAU policy, every incident beyond the fifth in a calendar month deducts 2 points from the ` +
    `attendance evaluation score. ${pointsDeducted} point${pointsDeducted === 1 ? '' : 's'} ` +
    `${pointsDeducted === 1 ? 'has' : 'have'} been deducted for ${monthLong} and recorded in the system.\n\n` +
    `I would appreciate it if you could speak with ${employee?.first_name || 'them'} directly. If there are ` +
    `extenuating reasons HR should be aware of — medical, family, scheduling — please loop me in so we can ` +
    `reflect them in the record. Otherwise, I would ask that we reset expectations for next month together.\n\n` +
    `Thank you for your support on this.\n\n` +
    HR_SIGNATURE;

  return { subject, body };
}

export default function EvaluationReviewModal({ row, employee, manager, onClose, onLogged, me }) {
  const [step, setStep] = useState('review');     // 'review' | 'submitting' | 'done' | 'already'
  const [error, setError] = useState('');

  const monthLong = useMemo(() => fmtMonthLong(row.monthStart), [row.monthStart]);
  const pointsDeducted = useMemo(
    () => Math.max(0, (row.totalCount - 5)) * 2,
    [row.totalCount]
  );

  const { subject, body } = useMemo(
    () => buildWarningEmail({
      employee, manager, monthLong,
      totalCount:  row.totalCount,
      lateCount:   row.lateCount,
      earlyCount:  row.earlyCount,
      missedCount: row.missedCount,
      pointsDeducted,
      sampleDates: row.dates,
    }),
    [employee, manager, monthLong, row, pointsDeducted]
  );

  const recipientTo = employee?.manager_id && manager?.email ? manager.email : '';
  const cc = [...FIXED_CC];
  const mailtoUrl = buildMailto({ to: recipientTo, cc, subject, body });

  async function handleSendAndLog() {
    setStep('submitting');
    setError('');

    // Period identifier — the table's unique constraint is
    // (employee_id, period_year, period_month). Derive both from row.monthStart.
    const [yStr, mStr] = (row.monthStart || '').split('-');
    const periodYear  = parseInt(yStr, 10);
    const periodMonth = parseInt(mStr, 10);
    const managerEmail = (employee?.manager_id && manager?.email) ? parseEmailAddress(manager.email) : null;

    try {
      // Direct insert — let the unique constraint enforce idempotency.
      // 23505 (duplicate key) is treated as success (already-logged).
      await directPost('evaluation_scores', {
        employee_id:           employee.id,
        period_year:           periodYear,
        period_month:          periodMonth,
        violation_count:       row.totalCount,
        base_score:            100,
        attendance_deduction:  pointsDeducted,
        warning_email_sent:    true,
        warning_email_sent_at: new Date().toISOString(),
        warning_email_sent_to: managerEmail,
        reviewed_by:           me?.id || 'H94830',
        reviewed_at:           new Date().toISOString(),
        notes:                 buildNotes({
          monthLong,
          lateCount:   row.lateCount,
          earlyCount:  row.earlyCount,
          missedCount: row.missedCount,
          totalCount:  row.totalCount,
          pointsDeducted,
        }),
      }, { timeoutMs: 10000 });

      setStep('done');
      window.location.href = mailtoUrl;
      if (onLogged) onLogged({ alreadyLogged: false });
    } catch (e) {
      const msg = String(e?.message || e);
      // 23505 = unique_violation on (employee_id, period_year, period_month).
      // Means we already reviewed this employee for this month — treat as
      // success and still open the mail client in case Bashaier wants to resend.
      if (msg.includes('23505') || msg.includes('duplicate key')) {
        setStep('already');
        window.location.href = mailtoUrl;
        if (onLogged) onLogged({ alreadyLogged: true });
        return;
      }
      setError(msg);
      setStep('review');
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(20, 30, 25, 0.55)', backdropFilter: 'blur(4px)' }}
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl max-w-2xl w-full max-h-[92vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        style={{ border: '1px solid var(--border-soft)' }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between px-6 pt-6 pb-4 sticky top-0 z-10 bg-white"
          style={{ borderBottom: '1px solid var(--border-soft)' }}
        >
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: '#FBE9E7', border: '1px solid #FFCDD2' }}
            >
              <AlertTriangle className="w-5 h-5" style={{ color: 'var(--clay)' }} />
            </div>
            <div>
              <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#1F1B16' }}>
                PERFORMANCE ESCALATION · {monthLong.toUpperCase()}
              </div>
              <h2 className="serif text-2xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
                {employee?.name || row.employeeId}
              </h2>
              <div className="text-xs mt-0.5" style={{ color: '#1F1B16' }}>
                {employee?.designation || employee?.department || '—'}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={step === 'submitting'}
            aria-label="Close"
            className="p-1 rounded hover:bg-stone-100 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <X className="w-5 h-5" style={{ color: '#1F1B16' }} />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Stat strip */}
          <div className="grid grid-cols-4 gap-2">
            <StatTile label="TOTAL" value={row.totalCount} accent="#1F1B16" />
            <StatTile label="LATE"    value={row.lateCount}    accent="#BE123C" />
            <StatTile label="EARLY"   value={row.earlyCount}   accent="#A16207" />
            <StatTile label="MISSED"  value={row.missedCount}  accent="#1D4ED8" />
          </div>

          {/* Deduction math */}
          <div
            className="rounded-lg border p-3"
            style={{ borderColor: 'var(--border-soft)', background: 'var(--paper-2)' }}
          >
            <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#1F1B16' }}>
              DEDUCTION
            </div>
            <div className="text-sm" style={{ color: '#1F1B16' }}>
              {row.totalCount} incidents − 5 grace = <strong>{Math.max(0, row.totalCount - 5)} chargeable</strong>
              {' · '}
              <strong>{pointsDeducted} point{pointsDeducted === 1 ? '' : 's'}</strong> from attendance score
              <span className="text-[11px] ml-1.5" style={{ color: '#1F1B16' }}>(2 pts each)</span>
            </div>
          </div>

          {/* Recent dates flagged */}
          {row.dates && row.dates.length > 0 && (
            <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-soft)' }}>
              <div className="text-[10px] tracking-[0.25em] mb-1.5" style={{ color: '#1F1B16' }}>
                <Calendar className="w-3 h-3 inline mr-1" /> DATES FLAGGED
              </div>
              <div className="text-xs flex flex-wrap gap-1.5">
                {row.dates.slice(0, 12).map(d => (
                  <span
                    key={d}
                    className="px-2 py-0.5 rounded"
                    style={{ background: 'var(--paper-2)', color: '#1F1B16' }}
                  >
                    {fmtDateShort(d)}
                  </span>
                ))}
                {row.dates.length > 12 && (
                  <span className="text-[11px] self-center" style={{ color: '#1F1B16' }}>
                    +{row.dates.length - 12} more
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Email preview */}
          <div className="rounded-lg border" style={{ borderColor: 'var(--border-soft)' }}>
            <div
              className="px-3 py-2 text-[10px] tracking-[0.25em] flex items-center justify-between"
              style={{ background: 'var(--paper-2)', color: '#1F1B16', borderBottom: '1px solid var(--border-soft)' }}
            >
              <span><Mail className="w-3 h-3 inline mr-1" /> EMAIL PREVIEW</span>
              <span>{recipientTo ? `To: ${manager?.name?.split(' ')[0] || 'Manager'}` : 'No manager email on file'}</span>
            </div>
            <div className="px-3 py-3">
              <div className="text-xs mb-1" style={{ color: '#1F1B16' }}>
                <strong>To:</strong> {recipientTo || <em>(no manager email — please verify before sending)</em>}
              </div>
              <div className="text-xs mb-2" style={{ color: '#1F1B16' }}>
                <strong>CC:</strong> {cc.join(', ')}
              </div>
              <div className="text-xs mb-2" style={{ color: '#1F1B16' }}>
                <strong>Subject:</strong> {subject}
              </div>
              <pre className="text-xs whitespace-pre-wrap font-sans rounded p-2 max-h-48 overflow-y-auto"
                   style={{ color: '#1F1B16', background: 'var(--paper-2)', border: '1px solid var(--border-soft)' }}>
                {body}
              </pre>
            </div>
          </div>

          {/* State messages */}
          {step === 'already' && (
            <div className="rounded p-3 text-sm" style={{ background: '#FFF7ED', color: '#9A3412', border: '1px solid #FED7AA' }}>
              An evaluation row already exists for {monthLong}. The score deduction has not been re-applied.
              The mail client has been opened so you can re-send if needed.
            </div>
          )}
          {step === 'done' && (
            <div className="rounded p-3 text-sm flex items-center gap-2" style={{ background: '#ECFDF5', color: '#047857', border: '1px solid #A7F3D0' }}>
              <Check className="w-4 h-4" /> Logged. {pointsDeducted} point{pointsDeducted === 1 ? '' : 's'} deducted. Email opened in your mail client.
            </div>
          )}
          {error && (
            <div className="rounded p-3 text-sm" style={{ background: '#FBE9E7', color: 'var(--clay)', border: '1px solid #FFCDD2' }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          className="px-6 py-4 flex items-center justify-end gap-2 sticky bottom-0 bg-white"
          style={{ borderTop: '1px solid var(--border-soft)' }}
        >
          {step === 'done' || step === 'already' ? (
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded text-sm text-white"
              style={{ background: 'var(--evergreen-600)' }}
            >
              Close
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={step === 'submitting'}
                className="px-4 py-2 rounded text-sm hover:bg-stone-50"
                style={{ color: '#1F1B16', border: '1px solid var(--border)' }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSendAndLog}
                disabled={step === 'submitting' || !recipientTo}
                className="px-4 py-2 rounded text-sm text-white flex items-center gap-2"
                style={{
                  background: 'var(--clay)',
                  opacity: (step === 'submitting' || !recipientTo) ? 0.5 : 1,
                  cursor: (step === 'submitting' || !recipientTo) ? 'not-allowed' : 'pointer',
                }}
                title={!recipientTo ? 'No manager email on file for this employee' : 'Open email and log to evaluation_scores'}
              >
                {step === 'submitting'
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Logging…</>
                  : <><ExternalLink className="w-4 h-4" /> Send & log deduction</>}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatTile({ label, value, accent }) {
  return (
    <div className="rounded-lg border p-3 text-center" style={{ borderColor: 'var(--border-soft)', background: 'white' }}>
      <div className="text-[9px] tracking-[0.2em] mb-0.5" style={{ color: '#1F1B16' }}>{label}</div>
      <div className="serif text-2xl" style={{ color: accent, fontWeight: 600 }}>{value}</div>
    </div>
  );
}
