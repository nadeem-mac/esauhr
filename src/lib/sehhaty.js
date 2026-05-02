// =============================================================================
// sehhaty.js
//
// Helpers for the Sehhaty (صحتي / Saudi MOH) sick-leave workflow.
//
// Background: since 2022, all sick leaves in Saudi Arabia are issued
// digitally through the Sehhaty platform. Paper certificates are no
// longer accepted by HR. Each certificate carries a unique service
// code (also called GSL / verification code) that HR uses to confirm
// the certificate is real.
//
// There is no public REST API for verification — HR enters the
// service code on Sehhaty's website manually. This module's job is
// to:
//   • Validate the code format on entry
//   • Build the verification URL so 'Verify on Sehhaty' opens
//     the right page in a new tab
//   • Compute the Saudi Labour Law pay bracket given a sick-day
//     running total
// =============================================================================

// Direct entry to the Seha inquiry form where HR types the
// leave ID and ID number to verify a Sehhaty-issued sick leave.
// This is the closest single URL to a 'verify form' — drops
// Bashaier straight on the input page rather than the homepage.
//
// Caveat: Sehha periodically reorganises the inquiry routes;
// if this 404s in future, this is the single line to update.
export const SEHHATY_VERIFY_URL = 'https://www.seha.sa/#/inquiries/slenquiry';
// Alternative for sick leaves issued ABROAD (foreign certificates
// must be uploaded through the SEHA platform after diplomatic
// attestation). We don't do this flow today but the URL is
// captured so we can wire it in later when the need arises.
export const SEHA_FOREIGN_URL  = 'https://www.moh.gov.sa/en/eServices/Pages/Sick-Leaves.aspx';

// Saudi Labour Law sick-leave brackets (Article 117). Values are
// inclusive day-count thresholds, in order. The first bracket the
// running total fits into is the active one.
//   • 1–30   : 100% of basic salary
//   • 31–90  : 75%
//   • 91–120 : 0% (unpaid)
//   • 121+   : entitlement exhausted; HR may invoke termination
//              under Art. 82 after consulting the employee.
export const SICK_LEAVE_BRACKETS = [
  { upTo: 30,  pay: 1.00, label: 'Full pay',     color: '#047857' },
  { upTo: 90,  pay: 0.75, label: '75% pay',      color: '#A16207' },
  { upTo: 120, pay: 0.00, label: 'Unpaid',       color: '#B91C1C' },
  { upTo: Infinity, pay: 0.00, label: 'Quota exceeded', color: '#7F1D1D' },
];

/**
 * Given the year-to-date sick-day count BEFORE this request, and the
 * number of days in this request, return the bracket that applies to
 * the new days plus a friendly warning if the request crosses a
 * bracket boundary (so HR can flag the pay change to payroll).
 */
export function classifySickLeaveBracket(yearToDate, requestDays) {
  const startTotal = Number(yearToDate) || 0;
  const endTotal   = startTotal + (Number(requestDays) || 0);
  const bracketAt = (n) => SICK_LEAVE_BRACKETS.find(b => n <= b.upTo);
  const startBracket = bracketAt(startTotal + 1); // first new day's bracket
  const endBracket   = bracketAt(endTotal);
  return {
    startTotal,
    endTotal,
    quotaCap: 120,
    daysRemaining: Math.max(0, 120 - endTotal),
    startBracket,
    endBracket,
    crossesBoundary: startBracket && endBracket && startBracket.label !== endBracket.label,
    overQuota: endTotal > 120,
  };
}

/**
 * Light-touch validation on the service code as the user types.
 * Sehhaty codes are typically 8–14 digits depending on the issuing
 * source, sometimes preceded by 'GSL' or similar. We don't reject
 * anything — just normalise (strip spaces, uppercase) so the stored
 * value is consistent.
 */
export function normaliseSehhatyCode(input) {
  return String(input || '').trim().toUpperCase().replace(/\s+/g, '');
}

/** Loose 'looks like a code' check — anything 4+ alphanumerics. */
export function looksLikeSehhatyCode(input) {
  const norm = normaliseSehhatyCode(input);
  return /^[A-Z0-9-]{4,}$/.test(norm);
}

/**
 * Detailed validation with diagnostic output. Used by the HR
 * verification modal to give Bashaier a clear picture of what's
 * suspicious about a code before she has to make the call.
 *
 * Returns an object with:
 *   • severity   — 'ok' | 'warn' | 'error'
 *   • messages   — array of human-readable issues
 *   • normalised — the code as it'll be stored
 *
 * The severity ladder:
 *   'error' — the code is unusable (empty, way too short, illegal
 *             characters, or pure repetition like '0000'). Verify
 *             button is hard-disabled at this level.
 *   'warn'  — the code is technically usable but has features
 *             that look suspicious (very short, looks like a
 *             phone number, common test pattern). Verify is still
 *             allowed but Bashaier sees a yellow flag.
 *   'ok'    — looks like a normal Sehhaty code.
 *
 * This is ONLY a format check. The actual truthfulness of the code
 * — whether it matches a real certificate on Sehhaty — can only be
 * confirmed by Bashaier on the MOH portal.
 */
export function diagnoseSehhatyCode(input) {
  const messages = [];
  let severity = 'ok';
  const norm = normaliseSehhatyCode(input);

  if (!norm) {
    return { severity: 'error', messages: ['No code provided.'], normalised: '' };
  }

  // Hard format errors — code is unusable as a Sehhaty reference.
  if (norm.length < 4) {
    severity = 'error';
    messages.push(`Too short — only ${norm.length} character${norm.length === 1 ? '' : 's'}. Sehhaty codes are usually 8+.`);
  }
  if (!/^[A-Z0-9-]+$/.test(norm)) {
    severity = 'error';
    messages.push('Contains characters that aren\'t allowed (only letters, digits, and hyphens).');
  }
  if (/^(.)\1+$/.test(norm)) {
    // All same character — '0000', 'AAAA' etc.
    severity = 'error';
    messages.push('Looks like a placeholder (all same character).');
  }

  // Soft warnings — code might be valid but worth a second look.
  if (severity !== 'error') {
    if (norm.length >= 4 && norm.length < 8) {
      severity = 'warn';
      messages.push(`Code is ${norm.length} characters — Sehhaty codes are usually 8 or more.`);
    }
    if (/^(?:0?5|\+?9665)\d{8}$/.test(norm.replace(/-/g, ''))) {
      severity = 'warn';
      messages.push('Looks like a Saudi mobile number rather than a Sehhaty code.');
    }
    if (/^(0?1|0?2|0?3)\d{6,}$/.test(norm.replace(/-/g, ''))) {
      severity = 'warn';
      messages.push('Looks like an Iqama/National ID rather than a Sehhaty code.');
    }
    if (/^(?:1234|0000|TEST|DEMO|ABCD)/.test(norm)) {
      severity = 'warn';
      messages.push('Pattern looks like a test value, not a real certificate.');
    }
  }

  if (messages.length === 0) {
    messages.push('Format looks plausible. Verify the certificate on Sehhaty before approving.');
  }

  return { severity, messages, normalised: norm };
}
