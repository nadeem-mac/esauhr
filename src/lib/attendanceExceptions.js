// ─────────────────────────────────────────────────────────────────────────
//  Standing attendance exceptions (HR-approved arrangements)
//  Keyed by UPPERCASE PSN. These are pre-approved, recurring exceptions so
//  the attendance report does NOT flag them as violations and instead shows
//  a clear remark explaining the approval.
//
//  Currently used for approved EARLY-DEPARTURE arrangements (e.g. a
//  post-maternity nursing break under Saudi Labor Law Art. 151). To add a
//  new person, add an entry below — it propagates to the report automatically.
//
//  Fields:
//    earlyFrom   : approved early-out clock time 'HH:MM' (informational)
//    reason      : full reason (used in tooltips / long remarks)
//    remark      : short remark shown in the report Status cell
//    from / to   : optional 'YYYY-MM-DD' bounds; null = ongoing
//  (Nadeem 2026-06-06)
// ─────────────────────────────────────────────────────────────────────────

export const APPROVED_EARLY_DEPARTURES = {
  H94766: {
    earlyFrom: '16:00',
    reason: 'Approved post-maternity nursing break (Saudi Labor Law Art. 151)',
    remark: 'Approved early-out · nursing break',
    from: null,   // ongoing
    to: null,
  },
};

// Digit-only key so it matches whether the id is 'H94766', '94766' or 94766.
const _digits = (x) => String(x == null ? '' : x).replace(/\D/g, '');
const _BY_DIGITS = Object.fromEntries(
  Object.entries(APPROVED_EARLY_DEPARTURES).map(([k, v]) => [_digits(k), v]),
);

// Return the approved early-departure arrangement for a PSN, or null.
export function approvedEarlyDeparture(psn) {
  if (psn == null || psn === '') return null;
  return APPROVED_EARLY_DEPARTURES[String(psn).toUpperCase()]
      || _BY_DIGITS[_digits(psn)]
      || null;
}

// True when the arrangement is in effect on the given 'YYYY-MM-DD' date.
export function approvalCoversDate(appr, dateIso) {
  if (!appr) return false;
  const d = String(dateIso || '').slice(0, 10);
  if (!d) return false;
  if (appr.from && d < appr.from) return false;
  if (appr.to && d > appr.to) return false;
  return true;
}
