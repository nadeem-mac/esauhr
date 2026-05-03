// =============================================================================
// retroactivePermissions.js
//
// Pure helpers for the "retroactive permission" feature: staff can file a
// permission request for a date that has already passed, within a 7-day
// rolling window. When HR approves such a request, any matching
// attendance_violations row is auto-cleared (soft-deleted via
// cleared_at + cleared_by_permission_id columns from
// migration_retroactive_permissions.sql).
//
// VOCABULARY
//   • retroactive       — permission whose permission_date is strictly
//                         before today (calendar date, not working day)
//   • coverage          — a permission "covers" a violation if same
//                         employee_id + same date + types align
//                         (late_arrival → 'late', early_leave → 'early_leave')
//   • clear             — to mark a violation row resolved by stamping
//                         cleared_by_permission_id, cleared_at, cleared_by
//
// CONSTRAINTS
//   This module is pure. It computes WHAT can be filed and WHAT to
//   clear; the caller (PermissionRequestModal, ReviewerPanel) is
//   responsible for I/O (directGet / directPatch). The split keeps the
//   rules testable without a Supabase mock.
// =============================================================================

/**
 * Maximum number of CALENDAR days a retroactive permission can look
 * back. Calendar (not working) days simplify the date picker math —
 * if today is Sunday and we used a 7 working-day window, the picker
 * would extend to the Sunday before last, which is confusing for
 * staff who expect "the past week".
 */
export const MAX_RETROACTIVE_DAYS = 7;

/**
 * The earliest permission_date a staff member can pick today, as a
 * YYYY-MM-DD string. Used to set the date input's `min` attribute.
 *
 * @param {Date|string} [today]  reference date; defaults to now()
 * @returns {string} YYYY-MM-DD
 */
export function getMinPermissionDate(today = new Date()) {
  const ref = today instanceof Date ? today : new Date(today);
  const min = new Date(ref);
  min.setDate(min.getDate() - MAX_RETROACTIVE_DAYS);
  return min.toISOString().slice(0, 10);
}

/**
 * @param {object|string} permission  permission_requests row OR a
 *                                    YYYY-MM-DD date string
 * @param {Date|string}   [today]
 * @returns {boolean} true when the permission's date is strictly
 *                    before today's date
 */
export function isRetroactive(permission, today = new Date()) {
  const dateStr = typeof permission === 'string'
    ? permission
    : permission?.permission_date;
  if (!dateStr) return false;
  const ref = today instanceof Date ? today : new Date(today);
  const todayStr = ref.toISOString().slice(0, 10);
  return dateStr < todayStr;
}

/**
 * Map a permission's `type` field to the corresponding
 * attendance_violations.violation_type value. The mapping is direct
 * for the two types that have a 1:1 relationship; missed_in /
 * missed_out / unauthorized_absence have no permission equivalent.
 *
 * @param {string} permissionType  'late_arrival' | 'early_leave'
 * @returns {string|null}          'late' | 'early_leave' | null
 */
export function violationTypeForPermission(permissionType) {
  switch (permissionType) {
    case 'late_arrival': return 'late';
    case 'early_leave':  return 'early_leave';
    default:             return null;
  }
}

/**
 * Find attendance_violations rows that an approved permission would
 * cover. Used by the post-approval hook in ReviewerPanel.
 *
 * Coverage criteria (kept simple per Nadeem's v1 scoping):
 *   • same employee_id
 *   • same violation_date == permission_date
 *   • violation_type matches permission_type via violationTypeForPermission
 *   • not already cleared (cleared_at IS NULL)
 *
 * Time-window matching is INTENTIONALLY not enforced — if a staff is
 * 60 min late but their permission only covers 09:00–09:30, we still
 * clear. Bashaier can manually re-add the violation if she
 * disagrees in the rare partial-coverage case.
 *
 * @param {object} permission   permission_requests row
 * @param {Array}  violations   attendance_violations rows
 * @returns {Array} matching violations
 */
export function findCoveredViolations(permission, violations = []) {
  if (!permission?.employee_id || !permission?.permission_date) return [];
  const targetType = violationTypeForPermission(permission.type);
  if (!targetType) return [];
  return violations.filter(v =>
    v.employee_id    === permission.employee_id &&
    v.violation_date === permission.permission_date &&
    v.violation_type === targetType &&
    !v.cleared_at
  );
}

/**
 * Build the patch payload for clearing a violation. The caller does
 * the actual directPatch; this just centralises the column names so
 * any future schema change touches one spot.
 *
 * @param {object} permission   the approving permission row (must have .id)
 * @param {string} actorPsn     the PSN of the HR approver
 * @returns {object}            patch payload
 */
export function buildClearPatch(permission, actorPsn) {
  return {
    cleared_by_permission_id: permission.id,
    cleared_at:               new Date().toISOString(),
    cleared_by:               actorPsn || 'system',
  };
}
