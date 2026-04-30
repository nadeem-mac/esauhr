// Permissions (late-arrival & early-leave) — quota math + helpers.
// Combined monthly bucket per staff: 3 hours total, max 3 occurrences.

export const PERMISSION_QUOTA = {
  monthlyHours:       3,
  monthlyOccurrences: 3,
  hoursPerOccurrence: 1,
};

export const PERMISSION_TYPES = {
  late_arrival: { label: 'Late arrival',  short: 'Late' },
  early_leave:  { label: 'Early leaving', short: 'Early' },
};

// Compute month-bucketed usage from an array of permission_requests rows.
// Returns { hoursUsed, occurrences, hoursRemaining, occurrencesRemaining,
//           atQuota, overQuota }  for a single (employee, month) pair.
export function summariseMonth(rows = []) {
  const counted = rows.filter(r => r.status === 'pending' || r.status === 'approved');
  const hoursUsed   = counted.reduce((s, r) => s + Number(r.hours || 0), 0);
  const occurrences = counted.length;
  return {
    hoursUsed,
    occurrences,
    hoursRemaining:       Math.max(0, PERMISSION_QUOTA.monthlyHours - hoursUsed),
    occurrencesRemaining: Math.max(0, PERMISSION_QUOTA.monthlyOccurrences - occurrences),
    atQuota:              hoursUsed >= PERMISSION_QUOTA.monthlyHours
                          || occurrences >= PERMISSION_QUOTA.monthlyOccurrences,
    overQuota:            hoursUsed > PERMISSION_QUOTA.monthlyHours
                          || occurrences > PERMISSION_QUOTA.monthlyOccurrences,
  };
}

// Will this candidate (hours, count=1) push the staff over quota?
// Returns { willExceed, reason } where reason is a human-readable string for
// the warning UI to show alongside the "Submit anyway — flag for evaluation"
// confirmation.
export function checkExceeds(monthRows, candidateHours = 1) {
  const m = summariseMonth(monthRows);
  const newHours       = m.hoursUsed + candidateHours;
  const newOccurrences = m.occurrences + 1;
  const exceedsHours       = newHours       > PERMISSION_QUOTA.monthlyHours;
  const exceedsOccurrences = newOccurrences > PERMISSION_QUOTA.monthlyOccurrences;
  if (!exceedsHours && !exceedsOccurrences) return { willExceed: false };
  const parts = [];
  if (exceedsHours)
    parts.push(`${newHours}h vs ${PERMISSION_QUOTA.monthlyHours}h cap`);
  if (exceedsOccurrences)
    parts.push(`${newOccurrences} occurrences vs ${PERMISSION_QUOTA.monthlyOccurrences} cap`);
  return {
    willExceed: true,
    reason: `Will exceed monthly quota (${parts.join(', ')}). Submission allowed but will be flagged for personal evaluation.`,
  };
}

// Helper to bucket an array of rows by 'YYYY-MM' month key
export function groupByMonth(rows) {
  const out = {};
  rows.forEach(r => {
    const key = (r.permission_date || '').slice(0, 7); // 'YYYY-MM'
    if (!key) return;
    (out[key] ||= []).push(r);
  });
  return out;
}

// Curated reason lists for permission requests. Drives the dropdown in
// PermissionRequestModal — replaces what used to be free-text. Sourced from
// what HR most frequently sees and approves at Evergreen Shipping (KSA):
// medical and government/Iqama paperwork dominate, followed by family
// responsibility and bank visits. The two lists are tailored separately
// because late-arrival and early-leave have slightly different framing
// (start-of-day vs end-of-day commitments).
//
// 'Other' is the safety valve — when picked, the modal asks for a brief
// free-text specifier so HR still gets useful context. Without 'Other',
// edge cases would force people into the closest-fit category, which
// muddies the data HR uses to plan.
export const LATE_ARRIVAL_REASONS = [
  'Medical appointment',
  'Government / Iqama / official paperwork',
  'Bank or financial appointment',
  'Family responsibility — school drop-off / dependent care',
  'Traffic or road delay',
  'Other',
];

export const EARLY_LEAVE_REASONS = [
  'Medical appointment',
  'Government / Iqama / official paperwork',
  'Bank or financial appointment',
  'Family responsibility — school pickup / dependent care',
  'Personal urgent matter',
  'Other',
];

export function reasonsFor(type) {
  return type === 'early_leave' ? EARLY_LEAVE_REASONS : LATE_ARRIVAL_REASONS;
}
