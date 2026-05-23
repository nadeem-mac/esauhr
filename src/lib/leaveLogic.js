// ══════════════════════════════════════════════════════════════════════════
//  LEAVE LOGIC — the numeric core of the tracker
//
//  All calculations are pure functions, no side effects, easily testable.
//  This mirrors the approach of PalmHR, Bayzat, and other KSA HR platforms.
// ══════════════════════════════════════════════════════════════════════════

export const KSA_WEEKEND = [5, 6]; // Friday = 5, Saturday = 6 (JS getDay)
export const MS_PER_DAY = 86400000;

// ────────────── date helpers ──────────────
export const toISO = (d) => {
  const date = d instanceof Date ? d : new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

export const todayISO = () => toISO(new Date());

export const daysBetweenInclusive = (start, end) => {
  if (!start || !end) return 0;
  const s = new Date(start);
  const e = new Date(end);
  return Math.max(0, Math.floor((e - s) / MS_PER_DAY) + 1);
};

// ──────────────────────────────────────────────────────────────────────
//  WORKING DAYS — counts days between two dates excluding KSA weekends
//  and (optionally) a list of public holidays.  Mirrors PalmHR behaviour.
// ──────────────────────────────────────────────────────────────────────
export function countWorkingDays(startDate, endDate, holidays = [], weekendDays = KSA_WEEKEND) {
  if (!startDate || !endDate) return 0;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (end < start) return 0;

  const holidaySet = new Set(holidays.map(h => (typeof h === 'string' ? h : h.date)));
  const weekendSet = new Set(weekendDays);

  let count = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = toISO(cursor);
    if (!weekendSet.has(cursor.getDay()) && !holidaySet.has(iso)) count++;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

// ──────────────────────────────────────────────────────────────────────
//  CALENDAR DAYS — for leave types that count weekends (sick, maternity)
// ──────────────────────────────────────────────────────────────────────
export const countCalendarDays = (startDate, endDate) => daysBetweenInclusive(startDate, endDate);

// ──────────────────────────────────────────────────────────────────────
//  REQUEST DURATION — picks working or calendar days depending on leave type
// ──────────────────────────────────────────────────────────────────────
export function calculateRequestDays(startDate, endDate, leaveType, holidays = [], isHalfDay = false) {
  if (isHalfDay) return 0.5;
  const workingOnly = leaveType?.counts_working_days_only !== false;
  const days = workingOnly
    ? countWorkingDays(startDate, endDate, holidays)
    : countCalendarDays(startDate, endDate);
  return days;
}

// ──────────────────────────────────────────────────────────────────────
//  SERVICE LENGTH — in full years, between join_date and a reference date
// ──────────────────────────────────────────────────────────────────────
export function yearsOfService(joinDate, asOf = new Date()) {
  if (!joinDate) return 0;
  const start = new Date(joinDate);
  const end = asOf instanceof Date ? asOf : new Date(asOf);
  let years = end.getFullYear() - start.getFullYear();
  const m = end.getMonth() - start.getMonth();
  if (m < 0 || (m === 0 && end.getDate() < start.getDate())) years--;
  return Math.max(0, years);
}

export function monthsOfService(joinDate, asOf = new Date()) {
  if (!joinDate) return 0;
  const start = new Date(joinDate);
  const end = asOf instanceof Date ? asOf : new Date(asOf);
  return Math.max(0, (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth()));
}

// ──────────────────────────────────────────────────────────────────────
//  ACTIVE EMPLOYEE CHECK
//
//  Single source of truth for "is this employee part of the live
//  roster?" Used by all the count-by-X computations on Bashaier's
//  dashboard (active staff, by location, by department, by nationality,
//  by gender, headcount summary line) plus the Employees list page's
//  default filter.
//
//  Archived statuses ('inactive', 'departed', 'terminated') exclude
//  the row from active queries. The Employees page surfaces them
//  separately when the "Show inactive" toggle is on.
//
//  Treats missing employment_status as active — legacy rows from
//  before the lifecycle column was widely populated default to
//  active so removing the column doesn't accidentally hide everyone.
// ──────────────────────────────────────────────────────────────────────
const INACTIVE_STATUSES = new Set(['inactive', 'departed', 'terminated']);
export function isActiveEmployee(emp) {
  if (!emp) return false;
  const s = emp.employment_status;
  if (!s) return true;
  return !INACTIVE_STATUSES.has(s);
}

// ──────────────────────────────────────────────────────────────────────
//  FULL ANNUAL ENTITLEMENT by Saudi Labor Law
//    < 5 years of service   → 21 days
//    ≥ 5 years of service   → 30 days
// ──────────────────────────────────────────────────────────────────────
export function fullAnnualEntitlement(joinDate, asOf = new Date()) {
  return yearsOfService(joinDate, asOf) >= 5 ? 30 : 21;
}

// ──────────────────────────────────────────────────────────────────────
//  ANNUAL ENTITLEMENT for a given year — FLAT-RATE
//
//  KSA Labour Law Article 109: 21 days/year for the first 5 years of
//  service; 30 days/year from the 5-year anniversary onward.
//
//  Earlier this function pro-rated 21+30 around a mid-year 5-year
//  anniversary (more employee-favorable, MOL-strict). Nadeem 2026-05-21
//  rolled this back: 'drops MOL pro-rata, less employee-favorable
//  everywhere' — portal now aligns with the company's flat-rate Excel
//  tracker. The whole year takes the rate that applies at year-end.
//
//  Example:
//    Joined 01 Aug 2021. In 2026 he crosses 5 years on 01 Aug 2026.
//      • Old pro-rata view: 21×(212/365) + 30×(153/365) = 24.77
//      • New flat-rate view: 30 (because YOS at 31 Dec 2026 ≥ 5)
//
//  Partial-year join pro-rata still applies (someone who joined
//  mid-year only earns full × daysAsEmployee/365) — that's a separate
//  fairness concern, not MOL Article 109 specifically. Without it,
//  mid-year hires would get a free full-year allocation.
// ──────────────────────────────────────────────────────────────────────
export function annualEntitlementForYear(joinDate, year, asOf = new Date()) {
  if (!joinDate) return { full: 21, proRatedForYear: 21, earned: 21, remaining: 0 };

  const yearStart = new Date(year, 0, 1);
  const yearEnd   = new Date(year, 11, 31);
  const join      = new Date(joinDate);
  const today     = asOf instanceof Date ? asOf : new Date(asOf);

  // Flat rate for the whole calendar year — 21 or 30 based purely on
  // years of service at year-end.
  const fullEntitlement = fullAnnualEntitlement(joinDate, yearEnd);

  // Joined after the year ends → zero entitlement for this year.
  if (join > yearEnd) {
    return { full: fullEntitlement, proRatedForYear: 0, earned: 0, remaining: 0 };
  }

  // Pro-rate for partial-year join only — full year if join was before
  // year start, otherwise the fraction of the year actually worked.
  const effectiveStart = join > yearStart ? join : yearStart;
  const totalDaysInYear = Math.floor((yearEnd - yearStart) / MS_PER_DAY) + 1;
  const daysAsEmployee  = Math.floor((yearEnd - effectiveStart) / MS_PER_DAY) + 1;
  const proRatedForYear = (daysAsEmployee / totalDaysInYear) * fullEntitlement;

  // Earned-to-date — uniform accrual at the full year-end rate.
  // Returned for any downstream caller that wants the accrual view;
  // not displayed in the front-loaded UI.
  const asOfCapped =
        today > yearEnd        ? yearEnd
      : today < effectiveStart ? effectiveStart
      :                          today;
  const daysElapsed = Math.floor((asOfCapped - effectiveStart) / MS_PER_DAY) + 1;
  const earned      = (daysElapsed / totalDaysInYear) * fullEntitlement;

  return {
    full:            fullEntitlement,
    proRatedForYear: round2(proRatedForYear),
    earned:          round2(earned),
    remaining:       round2(proRatedForYear - earned),
  };
}

// ──────────────────────────────────────────────────────────────────────
//  COMPLETE BALANCE CALCULATION for an employee + leave type + year
//  Returns a rich object suitable for display.
// ──────────────────────────────────────────────────────────────────────
export function calculateBalance({ employee, leaveType, year, requests = [], adjustments = {}, asOf = new Date() }) {
  const y = year || new Date().getFullYear();
  const used = requests
    .filter(r =>
      r.employee_id === employee.id &&
      r.leave_type_id === leaveType.id &&
      r.status === 'approved' &&
      new Date(r.start_date).getFullYear() === y
    )
    .reduce((sum, r) => sum + Number(r.days || 0), 0);

  const pending = requests
    .filter(r =>
      r.employee_id === employee.id &&
      r.leave_type_id === leaveType.id &&
      r.status === 'pending' &&
      new Date(r.start_date).getFullYear() === y
    )
    .reduce((sum, r) => sum + Number(r.days || 0), 0);

  const carried = Number(adjustments.carried_over || 0);
  const adjustment = Number(adjustments.adjustment || 0);

  let entitlement = Number(leaveType.default_days || 0);
  let earned = entitlement;

  if (leaveType.id === 'annual' && employee.join_date) {
    const ent = annualEntitlementForYear(employee.join_date, y, asOf);
    entitlement = ent.proRatedForYear ?? ent.full;
    earned = ent.earned;
  }

  const total = entitlement + carried + adjustment;
  const available = total - used - pending;

  return {
    entitlement: round2(entitlement),
    earned:      round2(earned),
    carried:     round2(carried),
    adjustment:  round2(adjustment),
    total:       round2(total),
    used:        round2(used),
    pending:     round2(pending),
    available:   round2(available),
  };
}

// ──────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────
//  OVERLAP DETECTION — returns requests that conflict with a proposed range
//
//  Active = approved OR any pending_* stage. We deliberately catch
//  every pending sub-state (pending_substitutes, pending_manager,
//  pending_hr, pending_certificate) so a staff member can't submit
//  multiple overlapping requests while one is in flight.
//
//  Stage is the modern source of truth. The legacy `status` column
//  is still set by HrApprovalModal for finalised rows, so we fall
//  back to it for any row where stage is missing — covers schema-
//  era data from before the stage migration. Nadeem 2026-05-18:
//  'LV-1B33AC2A is overlapping' — confirmed the prior narrow filter
//  ('status === pending' literal) missed every modern pending row,
//  hence overlap warnings only fired against HR-approved leaves.
// ──────────────────────────────────────────────────────────────────────
export function findOverlappingRequests(employeeId, startDate, endDate, requests, excludeId = null) {
  return requests.filter(r => {
    if (r.employee_id !== employeeId) return false;
    if (r.id === excludeId)          return false;

    const stage  = r.stage  || '';
    const status = r.status || '';
    const isActive =
        stage === 'approved'
     || stage.startsWith('pending')
     || status === 'approved'                      // legacy fallback
     || status === 'pending';                      // legacy fallback
    if (!isActive) return false;

    // Date-range overlap: two ranges overlap unless one ends before
    // the other starts. String comparison works for ISO YYYY-MM-DD.
    return !(r.end_date < startDate || r.start_date > endDate);
  });
}

// ──────────────────────────────────────────────────────────────────────
//  INITIAL APPROVAL STAGE — where does this requester's row START?
// ──────────────────────────────────────────────────────────────────────
// Per Nadeem (2026-05-06) — explicit routing by role:
//   • ALL STAFF → MANAGER → BASHAIER         (final, normal flow)
//   • BASHAIER  → FAHAD H94712               (final, no Bashaier step)
//   • FAHAD     → BASHAIER                   (final, no manager step)
//   • Annual leaves add a SUBSTITUTES gate at the start of every
//     non-sick path; the rest of the routing is identical.
//
// This helper handles the FAHAD case — start his request at
// pending_hr so it skips the manager step and lands directly in
// Bashaier's HR queue.
//
// Rule: skip the manager step iff the requester has an HR-only
// (non-admin) reviewer as a direct report. That captures Fahad
// alone — his deputy Bashaier IS the HR reviewer. Sadakathullah
// has direct reports too, but none of them are HR-only reviewers,
// so his own request flows the normal staff path.
//
// Inputs:
//   • requester  — the employee record submitting the request
//   • employees  — the full company list (used to detect direct reports)
//
// Returns one of:
//   • 'pending_hr'      — requester's deputy is the HR reviewer
//   • 'pending_manager' — normal flow
export function initialApprovalStage(requester, employees = []) {
  if (!requester) return 'pending_manager';
  const directReports = (employees || []).filter(e => e.manager_id === requester.id);
  // HR-only direct reports — exclude admin so Nadeem (admin + HR)
  // doesn't accidentally mark anyone as a Fahad-style manager. The
  // rule is meant to capture the deputy-is-HR pattern, and Bashaier
  // is the only deputy-HR in this org.
  const hasHrOnlyDirectReport = directReports.some(e => e?.is_hr_reviewer && !e?.is_admin);
  if (hasHrOnlyDirectReport) return 'pending_hr';
  return 'pending_manager';
}

// ──────────────────────────────────────────────────────────────────────
export function checkEligibility(employee, leaveType, requests = [], asOf = new Date()) {
  const errors = [];
  const warnings = [];

  if (!employee.join_date && (leaveType.min_service_months || 0) > 0) {
    warnings.push(`Join date missing — cannot verify ${leaveType.min_service_months} month service minimum.`);
  } else if (leaveType.min_service_months > 0) {
    const months = monthsOfService(employee.join_date, asOf);
    if (months < leaveType.min_service_months) {
      errors.push(`Requires ${leaveType.min_service_months} months of service (employee has ${months}).`);
    }
  }

  if (leaveType.max_per_service) {
    const timesTaken = requests.filter(r =>
      r.employee_id === employee.id &&
      r.leave_type_id === leaveType.id &&
      r.status === 'approved'
    ).length;
    if (timesTaken >= leaveType.max_per_service) {
      errors.push(`Limit reached: ${leaveType.name} can only be taken ${leaveType.max_per_service} time${leaveType.max_per_service > 1 ? 's' : ''} per employment.`);
    }
  }

  // Rejoining gate — block new leave applications when the employee has
  // a prior approved leave whose end_date has passed but whose return
  // workflow has not yet reached final approval. Forces compliance with
  // the rejoining process: staff must close out their last leave (submit
  // → manager approve → HR approve) before applying for the next one.
  // Pending stages (pending_manager, pending_hr) and rejected stages
  // both count as "still open" — the employee needs to either get the
  // current rejoining approved or resubmit a rejected one.
  const todayISO = asOf.toISOString().slice(0, 10);
  const unreturned = requests.find(r =>
    r.employee_id === employee.id &&
    r.stage === 'approved' &&
    r.end_date < todayISO &&
    r.return_stage !== 'approved'
  );
  if (unreturned) {
    const stageLabel = !unreturned.return_stage
      ? 'not yet submitted'
      : unreturned.return_stage.replace(/_/g, ' ');
    errors.push(
      `Rejoining required for previous leave (${unreturned.start_date} → ${unreturned.end_date}). ` +
      `Current rejoining status: ${stageLabel}. Submit and complete the rejoining workflow before applying for new leave.`
    );
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ────────────── small utilities ──────────────
function round2(n) { return Math.round(Number(n) * 100) / 100; }

export function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtDateShort(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

export function getInitials(name = '') {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
}

export function avatarColor(id) {
  const palette = ['#2D5F3F', '#1F4A2F', '#5A8A6C', '#8B6B3E', '#5A7A9B', '#A67FB5', '#C97B84', '#D4875C', '#B84A3E'];
  const hash = String(id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return palette[hash % palette.length];
}

export const LOCATION_LABELS = { DMM: 'Dammam', JED: 'Jeddah', RYD: 'Riyadh' };

// =============================================================================
// REJECTION REASONS
//
// Catalog of standardised reasons a leave request can be rejected. Used by
// both the rejection modal (ReviewerPanel) and the staff status card
// (MyApplicationsCard) so labels stay in sync. Each reason has:
//   • code        — short machine-readable identifier, persisted in
//                   leave_requests.rejection_reason_code
//   • label       — human-readable label shown to the staff member
//   • description — explanatory tooltip the rejector sees in the dropdown
//   • scopes      — which leave types this reason applies to:
//                   ['*'] = any leave type
//                   ['sick'] = sick leave only
//                   ['annual', 'emergency'] = those types only
//   • requiresNote — when true, the rejector MUST write a follow-up note
//                    (e.g. 'Other reason' is meaningless without context)
//
// Adding a new reason: append a new entry. The rejection modal builds
// its dropdown from this list filtered by the request's leave type.
// =============================================================================
export const REJECTION_REASONS = [
  // ─── Sick-leave specific (Sehhaty-related) ──────────────────────────
  {
    code: 'sehhaty_invalid',
    label: 'Sehhaty leave ID is not valid',
    description: 'The leave ID could not be found on the Sehhaty portal.',
    scopes: ['sick'],
    requiresNote: false,
  },
  {
    code: 'sehhaty_mismatch_dates',
    label: 'Sehhaty dates do not match the request',
    description: 'The certificate on Sehhaty covers different dates than what was applied for.',
    scopes: ['sick'],
    requiresNote: false,
  },
  {
    code: 'sehhaty_mismatch_name',
    label: 'Sehhaty patient name does not match the requester',
    description: 'The certificate on Sehhaty was issued to a different person.',
    scopes: ['sick'],
    requiresNote: false,
  },
  {
    code: 'sehhaty_quota_exceeded',
    label: 'Annual sick-leave quota exceeded',
    description: 'The 120-day annual quota under Saudi Labour Law Art. 117 is fully used.',
    scopes: ['sick'],
    requiresNote: false,
  },

  // ─── Common across leave types ──────────────────────────────────────
  {
    code: 'insufficient_balance',
    label: 'Insufficient leave balance',
    description: 'The employee does not have enough days left in this leave-type bucket.',
    scopes: ['*'],
    requiresNote: false,
  },
  {
    code: 'business_critical',
    label: 'Business-critical period — cannot be granted',
    description: 'The dates fall in a peak/freeze window where leave is restricted.',
    scopes: ['*'],
    requiresNote: false,
  },
  {
    code: 'no_substitute',
    label: 'No suitable substitute coverage arranged',
    description: 'Substitute coverage is required for these dates and none has accepted.',
    scopes: ['annual', 'emergency', 'maternity', 'paternity', 'hajj', 'unpaid', 'other'],
    requiresNote: false,
  },
  {
    code: 'overlap',
    label: 'Overlaps with another approved leave or holiday',
    description: 'These dates collide with an existing approved leave or a public holiday.',
    scopes: ['*'],
    requiresNote: false,
  },
  {
    code: 'documentation_missing',
    label: 'Required supporting document is missing',
    description: 'A certificate, ticket, or other document required for this leave type was not provided.',
    scopes: ['*'],
    requiresNote: false,
  },
  {
    code: 'late_submission',
    label: 'Submitted too late — notice period not met',
    description: 'Company policy requires advance notice that has not been given.',
    scopes: ['annual', 'hajj', 'maternity', 'paternity', 'unpaid', 'other'],
    requiresNote: false,
  },
  {
    code: 'duplicate',
    label: 'Duplicate of an existing request',
    description: 'A request for the same period is already on file.',
    scopes: ['*'],
    requiresNote: false,
  },
  {
    code: 'resubmit_corrected',
    label: 'Please resubmit with corrected details',
    description: 'A field on this request needs correction before HR can process it. Add a note explaining what.',
    scopes: ['*'],
    requiresNote: true,
  },
  {
    code: 'other',
    label: 'Other reason (note required)',
    description: 'Free-text reason — a note is required.',
    scopes: ['*'],
    requiresNote: true,
  },
];

/**
 * Returns the reasons applicable to a given leave-type id, in the order
 * they should appear in the dropdown. Sick-specific reasons come first
 * for sick leaves so the rejector sees the most relevant options at the
 * top.
 */
export function rejectionReasonsForLeaveType(leaveTypeId) {
  return REJECTION_REASONS.filter(r =>
    r.scopes.includes('*') || r.scopes.includes(leaveTypeId || '')
  );
}

/**
 * Look up a reason by code. Returns the catalog entry or null.
 */
export function findRejectionReason(code) {
  if (!code) return null;
  return REJECTION_REASONS.find(r => r.code === code) || null;
}
