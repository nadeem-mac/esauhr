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

// HR signature — kept in sync with the values used in vacationForm.js's
// buildEmailDraft. If those constants ever move into a shared module
// they can be imported from there; for now duplicating keeps this
// module self-contained.
const HR_SIGNATURE = {
  name: 'Bashaier Ali',
  unit: 'HR — Evergreen Shipping Agency Saudi Co.',
  whatsapp: '+966 50 000 0000',
  tel: '+966 13 000 0000',
  email: 'bashaier@evergreen-shipping.com.sa',
};

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
  const firstName = (employee?.name || '').split(' ')[0] || 'Colleague';
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
          `Thanks,`,
          ...signatureBlock(hrApprover),
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
          `Thanks,`,
          ...signatureBlock(hrApprover),
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
          `Thanks,`,
          ...signatureBlock(hrApprover),
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
          `Thanks,`,
          ...signatureBlock(hrApprover),
        ].join('\n'),
      };
  }
}

function signatureBlock(hrApprover) {
  const name = hrApprover?.name || HR_SIGNATURE.name;
  return [
    name,
    HR_SIGNATURE.unit,
    `WhatsApp: ${HR_SIGNATURE.whatsapp}`,
    `Tel: ${HR_SIGNATURE.tel}`,
    `Email: ${hrApprover?.email || HR_SIGNATURE.email}`,
  ];
}

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
