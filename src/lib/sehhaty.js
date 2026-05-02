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

// Public Sehhaty / MOH verification entry point. The exact URL has
// shifted over the years between sehhaty.sa, my.gov.sa, and various
// MOH subdomains — the homepage of the consumer portal is the one
// that always redirects to the current verification flow, so we
// link there.
export const SEHHATY_VERIFY_URL = 'https://sehhaty.sa/';
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
