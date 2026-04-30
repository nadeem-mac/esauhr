import React, { useMemo, useState } from 'react';
import { X, Mail, AlertTriangle, Check, Loader2, Calendar, ExternalLink } from 'lucide-react';
import { directPost, directGet } from '../supabaseClient.js';

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
// Schema reference (verified against live DB):
//   evaluation_scores table columns are minimal:
//     id, employee_id, notes, reviewed_by, reviewed_at, created_at, updated_at
//   The view evaluation_scores_final exposes employee_id, base_score, final_score.
//   We pack the structured info (month, counts, deduction) into `notes` as
//   a single human-readable line so the view (whatever it does) and any
//   future report can parse it.
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
  const mgrFirst = (manager?.name || 'Manager').split(' ')[0];

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

    try {
      // Idempotency check: look for an existing row for this employee whose
      // notes already start with [<monthLong>]. If one exists, skip the insert
      // and treat as success.
      const tag = `[${monthLong}]`;
      const existing = await directGet(
        'evaluation_scores',
        `select=id,notes&employee_id=eq.${encodeURIComponent(employee.id)}` +
        `&notes=ilike.${encodeURIComponent(tag + '%')}`,
        { timeoutMs: 8000 }
      );
      if (Array.isArray(existing) && existing.length > 0) {
        setStep('already');
        // Still open the mail client — Bashaier likely wants to resend
        window.location.href = mailtoUrl;
        if (onLogged) onLogged({ alreadyLogged: true });
        return;
      }

      // Insert one row with structured notes
      const notes = buildNotes({
        monthLong,
        lateCount:   row.lateCount,
        earlyCount:  row.earlyCount,
        missedCount: row.missedCount,
        totalCount:  row.totalCount,
        pointsDeducted,
      });

      await directPost('evaluation_scores', {
        employee_id: employee.id,
        notes,
        reviewed_by: me?.id || 'H94830',
        reviewed_at: new Date().toISOString(),
      }, { timeoutMs: 10000 });

      setStep('done');
      // Open the mail client with the pre-drafted email
      window.location.href = mailtoUrl;
      if (onLogged) onLogged({ alreadyLogged: false });
    } catch (e) {
      const msg = String(e?.message || e);
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
