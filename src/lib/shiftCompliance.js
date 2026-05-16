// =============================================================================
// shiftCompliance.js
//
// Pure verdict logic for the Shift Compliance card. Takes the four
// canonical inputs (assignments, punches, leave coverage, permissions)
// and returns a per-staff per-day breakdown of who did NOT perform
// correctly on a day the manager assigned them.
//
// Outputs the six verdict categories used by the card and the manager
// digest email:
//
//   COVERED     — on approved leave the day of the shift (out of scope,
//                 not counted as an issue)
//   CLEAN       — punched in within 15 min of expected_start AND
//                 punched out within 15 min of expected_end
//   LATE        — punched in more than 15 min after expected_start,
//                 no approved late permission on file
//   EARLY_OUT   — punched out more than 15 min before expected_end,
//                 no approved early permission on file
//   NO_PUNCH_OUT— punched in but no last_punch recorded (Sonnie's
//                 specific concern: 'data without time out')
//   ABSENT      — no punches at all on a day with an assigned shift
//                 and no leave coverage
//   WRONG_WINDOW— punched in but at a time that doesn't match the
//                 assigned shift window at all (e.g. assigned
//                 16:00 → 00:00 but punched in at 00:29). Used for
//                 night-shift staff who flipped their schedule
//                 without telling the manager.
//
// Pure functions only — no React, no DB, no side effects. The card
// fetches the four data sources and passes them in.
// =============================================================================

const GRACE_MIN = 15;

// Convert 'HH:MM' or 'HH:MM:SS' time string to minutes-since-midnight.
// Returns null on garbage so callers can safely guard.
function timeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

// True if expected_end < expected_start, meaning the shift crosses
// midnight (e.g. 16:00 → 00:00, 20:00 → 05:00).
function isOvernight(startStr, endStr) {
  const s = timeToMinutes(startStr);
  const e = timeToMinutes(endStr);
  if (s == null || e == null) return false;
  return e < s;
}

// True if the timestamp falls within the "shift IN window" — start time
// ± 4 hours. Catches "wrong window" punches where the staff clocked in
// at a completely unrelated time (e.g. assigned 16:00 → 00:00 but
// punched in at 00:29).
function isInShiftWindow(punchStr, startStr) {
  const p = timeToMinutes(punchStr);
  const s = timeToMinutes(startStr);
  if (p == null || s == null) return false;
  // 4-hour tolerance window. Anything wider and we'd start accepting
  // morning-shift carryover as a valid evening-shift IN.
  const TOL = 4 * 60;
  // Handle wrap-around for late-evening shifts: distance on the
  // 24h clock between the two minute values.
  let diff = Math.abs(p - s);
  if (diff > 12 * 60) diff = 24 * 60 - diff;
  return diff <= TOL;
}

/**
 * Classify a single assigned shift day.
 *
 * @param {Object} shift — { shift_date, start_time, end_time }
 * @param {Object|null} att — attendance_daily row for this date, or
 *   null if the staff has no row at all (synthetic absent)
 * @param {boolean} hasLeaveCoverage — true if an approved leave
 *   request covers this date
 * @param {boolean} hasLatePerm — true if an approved late-arrival
 *   permission covers this date
 * @param {boolean} hasEarlyPerm — true if an approved early-departure
 *   permission covers this date
 * @returns {{ verdict, detail }}
 */
export function classifyAssignedDay({
  shift, att, hasLeaveCoverage, hasLatePerm, hasEarlyPerm,
}) {
  if (hasLeaveCoverage) {
    return { verdict: 'COVERED', detail: 'On approved leave' };
  }

  const first = att?.first_punch || null;
  const last  = att?.last_punch  || null;

  if (!first && !last) {
    return {
      verdict: 'ABSENT',
      detail: 'No punches recorded',
    };
  }

  const overnight = isOvernight(shift.start_time, shift.end_time);
  const expStart = timeToMinutes(shift.start_time);
  const expEnd   = timeToMinutes(shift.end_time);
  const inMin    = timeToMinutes(first);
  const outMin   = timeToMinutes(last);

  // Wrong-window check: the IN punch falls way outside the assigned
  // shift's start time. Treat as "wrong window" rather than "late"
  // because labelling it 'late by 9 hours' would be misleading.
  if (first && !isInShiftWindow(first, shift.start_time)) {
    return {
      verdict: 'WRONG_WINDOW',
      detail: `In ${first.slice(0,5)}, assigned ${shift.start_time.slice(0,5)} → ${shift.end_time.slice(0,5)}`,
    };
  }

  // No punch-out — Sonnie's specific scenario. Comes before the late
  // check because a row with first_punch but no last_punch is more
  // actionable than 'late by 3 minutes' for payroll purposes.
  if (first && !last) {
    return {
      verdict: 'NO_PUNCH_OUT',
      detail: `In ${first.slice(0,5)}, no out recorded`,
    };
  }

  // Late arrival.
  if (!hasLatePerm && inMin != null && expStart != null) {
    const lateBy = inMin - expStart;
    if (lateBy > GRACE_MIN) {
      return {
        verdict: 'LATE',
        detail: `In ${first.slice(0,5)}, ${lateBy} min after ${shift.start_time.slice(0,5)}`,
      };
    }
  }

  // Early out — only meaningful for day shifts. Overnight shifts have
  // their out-punch on the next calendar day, so we can't evaluate
  // here without joining the next-day row. v1 punts on early-out for
  // overnight; the NO_PUNCH_OUT check above already catches the
  // worst case (no out at all).
  if (!overnight && !hasEarlyPerm && outMin != null && expEnd != null) {
    const earlyBy = expEnd - outMin;
    if (earlyBy > GRACE_MIN) {
      return {
        verdict: 'EARLY_OUT',
        detail: `Out ${last.slice(0,5)}, ${earlyBy} min before ${shift.end_time.slice(0,5)}`,
      };
    }
  }

  return {
    verdict: 'CLEAN',
    detail: `In ${first.slice(0,5)}, out ${last ? last.slice(0,5) : '—'}`,
  };
}

/**
 * Build the full month summary grouped by manager.
 *
 * @param {Object} args
 * @param {Array} args.shifts — employee_shifts rows for the month,
 *   already filtered to status in (pending, accepted)
 * @param {Array} args.attendance — attendance_daily rows for the
 *   month (per-staff, per-day)
 * @param {Array} args.leaves — approved leave_requests overlapping
 *   the month (stage='approved')
 * @param {Array} args.permissions — approved permission_requests
 *   overlapping the month (stage='approved')
 * @param {Map} args.empById — Map of upper-cased PSN → employee
 *
 * @returns {{ totalIssues, byManager: [...] }}
 */
export function summarizeShiftCompliance({
  shifts = [], attendance = [], leaves = [], permissions = [], empById = new Map(),
}) {
  // Index attendance by (empId|date) for O(1) lookup.
  const attIndex = new Map();
  for (const a of attendance) {
    if (!a?.employee_id || !a?.attendance_date) continue;
    const key = `${String(a.employee_id).toUpperCase()}|${String(a.attendance_date).slice(0,10)}`;
    attIndex.set(key, a);
  }

  // Index leave coverage by (empId|date). Approved leave spans get
  // expanded to one entry per covered day so the day-lookup is O(1).
  const leaveCoverage = new Set();
  for (const lv of leaves) {
    if (!lv?.employee_id || !lv?.start_date || !lv?.end_date) continue;
    if (lv.stage !== 'approved') continue;
    const empKey = String(lv.employee_id).toUpperCase();
    let cur = new Date(String(lv.start_date).slice(0,10));
    const end = new Date(String(lv.end_date).slice(0,10));
    let safety = 0;
    while (cur <= end && safety++ < 366) {
      const k = `${empKey}|${cur.toISOString().slice(0,10)}`;
      leaveCoverage.add(k);
      cur.setDate(cur.getDate() + 1);
    }
  }

  // Permissions: split into late vs early sets by (empId|date).
  const latePermSet  = new Set();
  const earlyPermSet = new Set();
  for (const p of permissions) {
    if (!p?.employee_id || !p?.permission_date) continue;
    if (p.stage !== 'approved') continue;
    const k = `${String(p.employee_id).toUpperCase()}|${String(p.permission_date).slice(0,10)}`;
    if (p.type === 'late_arrival')    latePermSet.add(k);
    if (p.type === 'early_departure') earlyPermSet.add(k);
  }

  // Walk every assigned shift, classify, group by employee.
  const byStaff = new Map(); // empKey → { empId, empName, empEmail, managerId, assigned, ...counts, issueDays:[] }

  for (const s of shifts) {
    if (!s?.employee_id || !s?.shift_date || !s?.start_time || !s?.end_time) continue;
    const empKey = String(s.employee_id).toUpperCase();
    const dateStr = String(s.shift_date).slice(0,10);
    const dayKey  = `${empKey}|${dateStr}`;

    const emp = empById.get ? empById.get(empKey) : empById[empKey];
    if (!emp) continue; // unknown staff — skip silently

    if (!byStaff.has(empKey)) {
      byStaff.set(empKey, {
        empId:      emp.id,
        empName:    emp.name || '',
        empEmail:   emp.email || null,
        managerId:  String(emp.manager_id || '').toUpperCase() || null,
        assigned:   0,
        covered:    0,
        clean:      0,
        late:       0,
        earlyOut:   0,
        noPunchOut: 0,
        absent:     0,
        wrongWindow:0,
        issueDays:  [],
      });
    }

    const slot = byStaff.get(empKey);
    slot.assigned += 1;

    const { verdict, detail } = classifyAssignedDay({
      shift: s,
      att: attIndex.get(dayKey) || null,
      hasLeaveCoverage: leaveCoverage.has(dayKey),
      hasLatePerm:  latePermSet.has(dayKey),
      hasEarlyPerm: earlyPermSet.has(dayKey),
    });

    switch (verdict) {
      case 'COVERED':       slot.covered     += 1; break;
      case 'CLEAN':         slot.clean       += 1; break;
      case 'LATE':          slot.late        += 1; slot.issueDays.push({ date: dateStr, verdict, detail, shift: s }); break;
      case 'EARLY_OUT':     slot.earlyOut    += 1; slot.issueDays.push({ date: dateStr, verdict, detail, shift: s }); break;
      case 'NO_PUNCH_OUT':  slot.noPunchOut  += 1; slot.issueDays.push({ date: dateStr, verdict, detail, shift: s }); break;
      case 'ABSENT':        slot.absent      += 1; slot.issueDays.push({ date: dateStr, verdict, detail, shift: s }); break;
      case 'WRONG_WINDOW':  slot.wrongWindow += 1; slot.issueDays.push({ date: dateStr, verdict, detail, shift: s }); break;
      default: break;
    }
  }

  // Group by manager.
  const byManagerMap = new Map();
  let totalIssues = 0;

  for (const [, slot] of byStaff) {
    const mid = slot.managerId || '__UNASSIGNED__';
    const issues = slot.late + slot.earlyOut + slot.noPunchOut + slot.absent + slot.wrongWindow;
    totalIssues += issues;
    // Skip staff with zero issues — the card is an exception report,
    // not a roster listing. Clean staff don't need to take screen real
    // estate.
    if (issues === 0) continue;

    if (!byManagerMap.has(mid)) {
      const mgr = empById.get
        ? empById.get(mid === '__UNASSIGNED__' ? '' : mid)
        : empById[mid === '__UNASSIGNED__' ? '' : mid];
      byManagerMap.set(mid, {
        managerId:   mid === '__UNASSIGNED__' ? null : mid,
        managerName: mgr?.name  || (mid === '__UNASSIGNED__' ? '— No manager on file —' : mid),
        managerEmail: mgr?.email || null,
        totalIssues: 0,
        staff: [],
      });
    }
    const mgrSlot = byManagerMap.get(mid);
    mgrSlot.totalIssues += issues;
    mgrSlot.staff.push(slot);
  }

  // Sort: managers with the most issues first; staff inside each
  // manager block by issue count desc.
  const byManager = Array.from(byManagerMap.values())
    .map(m => ({
      ...m,
      staff: m.staff.sort((a, b) => {
        const issA = a.late + a.earlyOut + a.noPunchOut + a.absent + a.wrongWindow;
        const issB = b.late + b.earlyOut + b.noPunchOut + b.absent + b.wrongWindow;
        return issB - issA;
      }),
    }))
    .sort((a, b) => b.totalIssues - a.totalIssues);

  return { totalIssues, byManager };
}

// Verdict labels for the UI + email body.
export const VERDICT_LABEL = {
  COVERED:      'On leave',
  CLEAN:        'Clean',
  LATE:         'Late',
  EARLY_OUT:    'Early out',
  NO_PUNCH_OUT: 'No punch-out',
  ABSENT:       'Absent (no-show)',
  WRONG_WINDOW: 'Wrong shift window',
};

// Verdict colours for the UI badges.
export const VERDICT_COLOR = {
  COVERED:      { fg: '#0F4C2A', bg: '#ECFDF5' },
  CLEAN:        { fg: '#0F4C2A', bg: '#ECFDF5' },
  LATE:         { fg: '#92400E', bg: '#FEF3C7' },
  EARLY_OUT:    { fg: '#92400E', bg: '#FEF3C7' },
  NO_PUNCH_OUT: { fg: '#7F1D1D', bg: '#FEE2E2' },
  ABSENT:       { fg: '#7F1D1D', bg: '#FEE2E2' },
  WRONG_WINDOW: { fg: '#7F1D1D', bg: '#FEE2E2' },
};
