// =============================================================================
// sickReminderEmail.js
//
// Email draft builders for the four kinds of sick-certificate reminders
// Bashaier sends to staff who declared sick without a Sehhaty cert.
// Same shape as buildEmailDraft in vacationForm.js — returns
// { to, cc, subject, body, mailto } so the caller can either open the
// mailto: link or copy the parts into a different mail client.
//
// REMINDER KINDS
//   gentle_24h   — first nudge, 24h after the staff returned (or 24h
//                  after end_date for declarations with no return signal).
//                  Friendly tone, assumes the staff just forgot.
//   firmer_72h   — second nudge, 72h after return. Cites the 48h policy
//                  expectation explicitly. Polite but firmer.
//   final_5d     — final warning at 5 working days. Mentions that
//                  unaccounted days will be marked as unauthorized
//                  absence (commit 5 will actually do the marking;
//                  this email signals the consequence is imminent).
//   manual       — Bashaier-driven, custom-purpose reminder. Same body
//                  template as gentle_24h but with the language pulled
//                  back to neutral so she can adapt it freely.
//
// CC POLICY (gradual escalation)
//   gentle_24h → staff only
//   firmer_72h → staff + line manager
//   final_5d   → staff + line manager + HR self-CC (for record)
//   manual     → staff only by default; Bashaier can edit if she wants
//
// LANGUAGE
//   Per Nadeem's standing HR-comms preference: brief, direct, natural
//   professional language — no formal boilerplate. The bodies below
//   stay short (3-5 short paragraphs) and lead with the ask.
// =============================================================================

import { REMINDER_KINDS } from './sickDeclaration.js';
import { renderHrSignature } from './emailTemplates.js';
import { salutationFor } from './salutations.js';

// HR signature is now rendered via the shared renderHrSignature()
// helper from emailTemplates.js. That function:
//   • Pulls the canonical signature data from the email_templates
//     row (or DEFAULT_TEMPLATES if not yet loaded)
//   • Returns a 6-line block prefixed with "Thanks and regards,"
//     so all auto-generated emails sign off the same way.
//
// Per Bashaier — every auto-generated email portal-wide must use
// "Thanks and regards," as the canonical sign-off (previously
// these reminders used a shorter "Thanks,"). The shared helper
// enforces that consistency.

const POLICY_LINE = 'Per Evergreen HR policy, the Sehhaty certificate must be submitted within 48 hours of returning to work after a declared sick day.';

function fmtDate(iso) {
  if (!iso) return '—';
  // Accept either YYYY-MM-DD strings or full ISO timestamps; normalise
  // to a readable medium form (e.g. "03 May 2026") for the email body.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function buildMailto(to, cc, subject, body) {
  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', body);
  return `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;
}

// Per-kind subject + body template.
//
// `declaration` — the leave_requests row in pending_certificate stage.
// `employee`    — the staff member receiving the reminder.
// `hrApprover`  — the HR person sending (typically Bashaier).
// `extraNote`   — optional free-text note Bashaier added in the modal,
//                 appended above the signature.
function templateFor(kind, { declaration, employee, hrApprover, extraNote }) {
  const firstName = salutationFor(employee);
  const declStart = fmtDate(declaration.start_date);
  const declEnd = fmtDate(declaration.end_date || declaration.start_date);
  const dateRange = (declaration.start_date === declaration.end_date || !declaration.end_date)
    ? declStart
    : `${declStart} – ${declEnd}`;

  switch (kind) {
    case REMINDER_KINDS.GENTLE_24H:
      return {
        subject: `Reminder: Sehhaty certificate for your sick leave on ${dateRange}`,
        body: [
          `Dear ${firstName},`,
          '',
          `This is a friendly reminder to upload your Sehhaty certificate for the sick leave you declared on ${dateRange}.`,
          '',
          `You can upload it via the HR portal — Sick leave → "Yes, I have it" — and it will attach automatically to your declaration.`,
          ...(extraNote ? ['', extraNote] : []),
          '',
          renderHrSignature(),
        ].join('\n'),
      };

    case REMINDER_KINDS.FIRMER_72H:
      return {
        subject: `Action needed: Sehhaty certificate overdue for ${dateRange}`,
        body: [
          `Dear ${firstName},`,
          '',
          `Your Sehhaty certificate for the sick leave on ${dateRange} is now more than 72 hours overdue.`,
          '',
          POLICY_LINE,
          '',
          `Please upload it as soon as possible via the HR portal. New leave or permission requests are blocked until it is submitted.`,
          ...(extraNote ? ['', extraNote] : []),
          '',
          renderHrSignature(),
        ].join('\n'),
      };

    case REMINDER_KINDS.FINAL_5D:
      return {
        subject: `Final notice: Sehhaty certificate for ${dateRange} — pending action`,
        body: [
          `Dear ${firstName},`,
          '',
          `This is a final reminder regarding the Sehhaty certificate for your sick leave on ${dateRange}, which has been outstanding for five working days.`,
          '',
          `Without the certificate, the affected days will be recorded as unauthorized absence and may be deducted from your salary. ${POLICY_LINE}`,
          '',
          `Please submit the certificate today, or contact HR if there is a documented reason it cannot be provided.`,
          ...(extraNote ? ['', extraNote] : []),
          '',
          renderHrSignature(),
        ].join('\n'),
      };

    case REMINDER_KINDS.MANUAL:
    default:
      return {
        subject: `Sehhaty certificate for your sick leave on ${dateRange}`,
        body: [
          `Dear ${firstName},`,
          '',
          `Following up on the Sehhaty certificate for your sick leave on ${dateRange}.`,
          ...(extraNote ? ['', extraNote] : []),
          '',
          `You can upload it via the HR portal at your earliest convenience.`,
          '',
          renderHrSignature(),
        ].join('\n'),
      };
  }
}

// signatureBlock has been replaced by the shared renderHrSignature()
// from emailTemplates.js. The shared helper returns the full block
// already prefixed with "Thanks and regards," so callers no longer
// need a separate sign-off line.
//
// The hrApprover argument is intentionally NOT used to substitute
// the signature: these emails are sent under the HR Department's
// authority, not the individual reviewer's, so the signature stays
// as Bashaier even when Nadeem (admin) triggers a reminder.

// CC list per kind. Returns a comma-separated string suitable for the
// mailto cc param, with duplicates and the primary-to address removed.
function ccFor(kind, { manager, hrApprover }, primaryTo) {
  let list = [];
  if (kind === REMINDER_KINDS.FIRMER_72H || kind === REMINDER_KINDS.FINAL_5D) {
    list.push(manager?.email);
  }
  if (kind === REMINDER_KINDS.FINAL_5D) {
    list.push(hrApprover?.email);
  }
  // Deduplicate + drop the primary recipient if it ended up here.
  list = Array.from(new Set(list.filter(Boolean).filter(e => e !== primaryTo)));
  return list.join(',');
}

/**
 * Build a complete email draft for a single reminder send.
 *
 * @param {object} params
 * @param {object} params.employee     leave_request.employee_id record (must have .email and .name)
 * @param {object} params.declaration  the pending_certificate leave row
 * @param {object} [params.manager]    line manager (used for CC at firmer/final tiers)
 * @param {object} params.hrApprover   the sender (typically Bashaier; used in signature)
 * @param {string} params.kind         one of REMINDER_KINDS values
 * @param {string} [params.extraNote]  optional free-text appended above signature
 *
 * @returns {{ to: string, cc: string, subject: string, body: string, mailto: string }}
 */
export function buildSickReminderEmail({ employee, declaration, manager, hrApprover, kind, extraNote }) {
  const to = (employee?.email || '').trim();
  const cc = ccFor(kind, { manager, hrApprover }, to);
  const { subject, body } = templateFor(kind, { declaration, employee, hrApprover, extraNote });
  const mailto = buildMailto(to, cc, subject, body);
  return { to, cc, subject, body, mailto };
}

/**
 * Suggest the appropriate reminder kind for a declaration based on its
 * current pressure stage. The kinds line up with the pressure escalation
 * defined in classifyPressure() in sickDeclaration.js so a row's
 * "natural" next reminder always matches its visual pressure pill.
 *
 * Mapping:
 *   in_grace      → gentle_24h    (returned, within 48h grace — still polite)
 *   soft_overdue  → firmer_72h    (returned, 2-5 working days late)
 *   hard_overdue  → final_5d      (5+ working days late, escalation imminent)
 *   still_out     → manual        (no return signal; Bashaier picks tone)
 *   exempt        → manual        (shouldn't get reminded but defensive default)
 */
export function suggestKindForPressure(pressure) {
  switch (pressure) {
    case 'in_grace':     return REMINDER_KINDS.GENTLE_24H;
    case 'soft_overdue': return REMINDER_KINDS.FIRMER_72H;
    case 'hard_overdue': return REMINDER_KINDS.FINAL_5D;
    default:             return REMINDER_KINDS.MANUAL;
  }
}

/**
 * Pretty label for a reminder kind, used in dropdowns and audit
 * surfaces. Distinct from REMINDER_KINDS values (which are the
 * machine-readable identifiers stored in sick_reminders.reminder_kind).
 */
export function reminderKindLabel(kind) {
  switch (kind) {
    case REMINDER_KINDS.GENTLE_24H: return 'Gentle (24h)';
    case REMINDER_KINDS.FIRMER_72H: return 'Firmer (72h)';
    case REMINDER_KINDS.FINAL_5D:   return 'Final (5 days)';
    case REMINDER_KINDS.MANUAL:     return 'Manual';
    default:                         return kind || '—';
  }
}

/**
 * Build the unauthorized-absence digest email for a single staff
 * member. Sent (manually, via mailto) by Bashaier when the weekly
 * digest CTA fires on her dashboard.
 *
 * Distinct from the reminder emails because the consequence has
 * already happened — these days ARE in the system as unauthorized.
 * The email's job is to tell the staff and explain how to undo it
 * (submit cert within 14 days for auto-undo; later requires HR
 * intervention).
 *
 * @param {object} params
 * @param {object} params.employee     staff record (must have .email and .name)
 * @param {object[]} params.violations unauthorized_absence rows for this staff
 * @param {object[]} params.declarations the source pending_certificate rows
 *                                       (joined by source_request_id)
 * @param {object} params.hrApprover   sender (Bashaier)
 *
 * @returns {{ to, cc, subject, body, mailto }} same shape as buildSickReminderEmail
 */
export function buildUnauthorizedAbsenceDigestEmail({
  employee,
  violations = [],
  declarations = [],
  hrApprover,
}) {
  const firstName = salutationFor(employee);
  const dayCount = violations.length;
  const dayList = [...new Set(violations.map(v => v.violation_date))]
    .sort()
    .map(d => fmtDate(d));
  const declarationsLine = declarations.length
    ? declarations.map(d => formatDeclarationCompact(d)).join(', ')
    : '—';

  const to = (employee?.email || '').trim();
  const cc = ''; // staff only; the digest is a private notice

  const subject = `Unauthorized absence recorded — ${dayCount} day${dayCount === 1 ? '' : 's'}`;
  const body = [
    `Dear ${firstName},`,
    '',
    `Because the Sehhaty certificate for your sick leave (${declarationsLine}) is now more than five working days overdue, the following day${dayCount === 1 ? ' has' : 's have'} been recorded as unauthorized absence on your attendance record:`,
    '',
    ...dayList.map(d => `  • ${d}`),
    '',
    'How to clear this:',
    '  1. Submit your Sehhaty certificate within 14 days of this notice via the HR portal (Sick leave → "Yes, I have it"). The unauthorized status will be removed automatically.',
    '  2. After 14 days, the unauthorized status becomes final and only HR can adjust it on documented grounds.',
    '',
    'Unauthorized absence may be deducted from your salary per the Evergreen HR policy. Please contact HR if you believe this notice was sent in error.',
    '',
    renderHrSignature(),
  ].join('\n');

  const mailto = buildMailto(to, cc, subject, body);
  return { to, cc, subject, body, mailto };
}

function formatDeclarationCompact(d) {
  if (!d) return '—';
  if (!d.end_date || d.start_date === d.end_date) return fmtDate(d.start_date);
  return `${fmtDate(d.start_date)} – ${fmtDate(d.end_date)}`;
}

/**
 * Given the existing reminders for a declaration, decide whether the
 * "natural next" reminder kind for the row's current pressure has
 * already been sent. Used by PendingSickCertsCard to surface a
 * "REMINDER DUE" badge only when the suggested kind hasn't fired yet,
 * so Bashaier doesn't spam the same staff with the same message twice.
 *
 * Returns a small descriptor:
 *   {
 *     suggested:     <kind id>,        // the auto-suggested kind for this pressure
 *     alreadySent:   <bool>,           // is the suggested kind already in the log?
 *     lastSentAt:    <ISO timestamp>,  // most-recent reminder sent for this row, or null
 *     lastSentKind:  <kind id>,        // most recent kind sent
 *   }
 */
export function reminderStatus(declaration, pressure, reminders = []) {
  const suggested = suggestKindForPressure(pressure);
  const forThisRow = reminders.filter(r => r.request_id === declaration.id);
  const alreadySent = forThisRow.some(r => r.reminder_kind === suggested);
  const sorted = [...forThisRow].sort(
    (a, b) => new Date(b.sent_at) - new Date(a.sent_at)
  );
  const last = sorted[0] || null;
  return {
    suggested,
    alreadySent,
    lastSentAt: last?.sent_at || null,
    lastSentKind: last?.reminder_kind || null,
  };
}
