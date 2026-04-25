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
//  FULL ANNUAL ENTITLEMENT by Saudi Labor Law
//    < 5 years of service   → 21 days
//    ≥ 5 years of service   → 30 days
// ──────────────────────────────────────────────────────────────────────
export function fullAnnualEntitlement(joinDate, asOf = new Date()) {
  return yearsOfService(joinDate, asOf) >= 5 ? 30 : 21;
}

// ──────────────────────────────────────────────────────────────────────
//  PRO-RATA ANNUAL ENTITLEMENT for a given year
//  - If the employee joined before the year started, they get the full entitlement.
//  - If they joined during the year, entitlement is pro-rated from their join date.
//  - Days earned so far = (days served this year / days in year) × full entitlement
// ──────────────────────────────────────────────────────────────────────
export function annualEntitlementForYear(joinDate, year, asOf = new Date()) {
  if (!joinDate) return { full: 21, earned: 21, remaining: 0 };

  const yearStart = new Date(year, 0, 1);
  const yearEnd = new Date(year, 11, 31);
  const join = new Date(joinDate);
  const today = asOf instanceof Date ? asOf : new Date(asOf);

  const fullEntitlement = fullAnnualEntitlement(joinDate, yearEnd);

  // If they joined after the year ends, zero
  if (join > yearEnd) return { full: fullEntitlement, earned: 0, remaining: 0 };

  const effectiveStart = join > yearStart ? join : yearStart;
  const totalDaysInYear =
    Math.floor((yearEnd - yearStart) / MS_PER_DAY) + 1;
  const daysAsEmployee =
    Math.floor((yearEnd - effectiveStart) / MS_PER_DAY) + 1;

  const fullForThisYear =
    (daysAsEmployee / totalDaysInYear) * fullEntitlement;

  // Days earned "so far" (for accrual-aware balance display)
  const asOfCapped = today > yearEnd ? yearEnd : today < effectiveStart ? effectiveStart : today;
  const daysElapsed = Math.floor((asOfCapped - effectiveStart) / MS_PER_DAY) + 1;
  const earned = (daysElapsed / totalDaysInYear) * fullEntitlement;

  return {
    full: fullEntitlement,
    proRatedForYear: round2(fullForThisYear),
    earned: round2(earned),
    remaining: round2(fullForThisYear - earned),
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
  let accrualNote = '';

  if (leaveType.id === 'annual' && employee.join_date) {
    const ent = annualEntitlementForYear(employee.join_date, y, asOf);
    entitlement = ent.proRatedForYear ?? ent.full;
    earned = ent.earned;
    accrualNote = `${entitlement} days pro-rated · ${earned} earned so far`;
  }

  const total = entitlement + carried + adjustment;
  const available = total - used - pending;

  return {
    entitlement: round2(entitlement),
    earned: round2(earned),
    carried: round2(carried),
    adjustment: round2(adjustment),
    total: round2(total),
    used: round2(used),
    pending: round2(pending),
    available: round2(available),
    accrualNote,
  };
}

// ──────────────────────────────────────────────────────────────────────
//  OVERLAP DETECTION — returns requests that conflict with a proposed range
// ──────────────────────────────────────────────────────────────────────
export function findOverlappingRequests(employeeId, startDate, endDate, requests, excludeId = null) {
  return requests.filter(r =>
    r.employee_id === employeeId &&
    r.id !== excludeId &&
    (r.status === 'approved' || r.status === 'pending') &&
    !(r.end_date < startDate || r.start_date > endDate)
  );
}

// ──────────────────────────────────────────────────────────────────────
//  ELIGIBILITY CHECK — can this employee take this leave type right now?
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
