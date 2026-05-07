// =============================================================================
// timeCard.js — Time Card xlsx parser + permission cross-reference
//
// Replaces the old CSV ingestion. The Time Card export format from the
// fingerprint device is a single-sheet xlsx with the raw punch stream:
//
//   Sheet name: <YYYYMMDD> (export date, not necessarily the data date)
//   Row 1: empty
//   Row 2: 'Time Card' title
//   Row 3: column headers — Employee ID | First Name | Date | Times | Time
//   Row 4+: one row per (employee × day):
//     • Employee ID — bare numeric ('94590'), portal needs 'H' prefix
//     • First Name  — actually the FULL name despite the column label
//     • Date        — DD/MM/YYYY (Saudi convention)
//     • Times       — count of raw punch events (informational only;
//                     we recount after deduping below)
//     • Time        — comma-separated HH:MM:SS timestamps, 24-hour
//
// What this module does:
//   1. parseTimeCardXlsx(file)
//        Validates the file is the right shape (headers, sheet count,
//        column names). Returns parsed rows or throws a typed error.
//
//   2. crossReferenceWithPermissions(rows, permissions, employeesById)
//        For each parsed row, looks up approved permission_requests
//        for that employee+date and produces the final per-row status:
//          OK | LATE_PERMITTED | LATE_BEYOND | LATE_NO_PERMISSION
//             | EARLY_PERMITTED | EARLY_BEYOND | EARLY_NO_PERMISSION
//             | INCOMPLETE | DUPLICATE
//        Status carries minutes-over/under figures and the relevant
//        permission window so the UI can render context inline.
//
// Punch-stream cleaning:
//   • Sub-60-second duplicates are collapsed (the device reads a single
//     badge tap as two events when the sensor double-fires).
//   • A row with 1 unique punch → INCOMPLETE (no punch-out).
//   • A row with 2 unique punches but span < 1 minute → DUPLICATE.
//   • A row with ≥2 unique punches and span ≥ 1 minute → first =
//     earliest, last = latest, midDay = the rest.
// =============================================================================

import * as XLSX from 'xlsx';
import { applyPsnAlias } from './psnAliases.js';

// Policy constants — single source of truth. Late/early thresholds.
// Override per-employee if shift schedule differs (handled at the
// cross-reference layer, not here).
export const ATTENDANCE_POLICY = {
  // Late if first punch is strictly after this. 8:00 AM is the
  // canonical start; the old CSV ingestion had a 15-min grace
  // window (LATE_CUTOFF = '08:15') which we keep as the default
  // grace. Bashaier asked for the cutoff to be 08:00 in the
  // requirements discussion, so the grace becomes a separate knob.
  startTime:  '08:00',
  graceLate:  15, // minutes — lateness ignored if first punch ≤ 08:15

  // Early-leave thresholds. SUP department has a 16:00 end; everyone
  // else is 17:00. Same 15-min grace applies on the other end.
  endTimeStandard: '17:00',
  endTimeSup:      '16:00',
  graceEarly:      15,

  // Below this many seconds between consecutive raw punches, we treat
  // the second as a device duplicate of the first and drop it.
  dedupeWindowSec: 60,
};

// ─── Parser ──────────────────────────────────────────────────────────────────

export class TimeCardParseError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.name = 'TimeCardParseError';
    this.code = code;
    this.hint = hint || null;
  }
}

const REQUIRED_HEADERS = ['Employee ID', 'First Name', 'Date', 'Times', 'Time'];

/**
 * Parse a Time Card xlsx File or Blob into an array of typed rows.
 * Throws TimeCardParseError on any structural mismatch — caller should
 * catch and surface .message + .hint to the user.
 *
 * @param {File|Blob|ArrayBuffer} input
 * @returns {Promise<{rows: ParsedRow[], dataDate: string|null, sheetName: string}>}
 */
export async function parseTimeCardXlsx(input) {
  let buffer;
  if (input instanceof ArrayBuffer) {
    buffer = input;
  } else if (input && typeof input.arrayBuffer === 'function') {
    buffer = await input.arrayBuffer();
  } else {
    throw new TimeCardParseError(
      'BAD_INPUT',
      'Could not read the file.',
      'Try saving the file again from the device export and re-uploading.',
    );
  }

  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'array', cellDates: false });
  } catch (e) {
    throw new TimeCardParseError(
      'NOT_XLSX',
      'This file is not a valid Excel workbook.',
      'Upload the .xlsx export from the fingerprint device — the previous CSV format is no longer accepted.',
    );
  }

  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    throw new TimeCardParseError('NO_SHEETS', 'The workbook has no sheets.', null);
  }

  // The Time Card export ships exactly one data sheet, named like
  // '20260502'. We don't rely on that name — we just take the first
  // sheet — but warn if there are multiple to make accidental ingestion
  // of the wrong file louder.
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

  if (matrix.length < 4) {
    throw new TimeCardParseError(
      'TOO_SHORT',
      'The file is empty or too short to be a Time Card export.',
      'Expected at least one header row and one data row.',
    );
  }

  // Header detection: the file ships with row 1 = blank, row 2 = 'Time
  // Card' title, row 3 = the actual headers. Be lenient — scan the
  // first 5 rows and pick the row that contains all REQUIRED_HEADERS
  // case-insensitively. Surfaces helpful errors if the layout drifts.
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(matrix.length, 5); i++) {
    const row = (matrix[i] || []).map(c => String(c || '').trim().toLowerCase());
    const hit = REQUIRED_HEADERS.every(h => row.includes(h.toLowerCase()));
    if (hit) { headerRowIdx = i; break; }
  }
  if (headerRowIdx === -1) {
    throw new TimeCardParseError(
      'BAD_FORMAT',
      'This does not look like the Time Card export.',
      'The expected columns are: Employee ID, First Name, Date, Times, Time. ' +
      'If the device export changed, contact admin to update the parser.',
    );
  }

  const headers = matrix[headerRowIdx].map(c => String(c || '').trim());
  // Build a column-index map by header label.
  const colIdx = {};
  REQUIRED_HEADERS.forEach(label => {
    const idx = headers.findIndex(h => h.toLowerCase() === label.toLowerCase());
    colIdx[label] = idx;
  });

  const rows = [];
  let dataDate = null; // first non-empty parsed date, used to warn on multi-day files

  for (let r = headerRowIdx + 1; r < matrix.length; r++) {
    const raw = matrix[r];
    if (!raw || raw.length === 0) continue;

    const idCell    = String(raw[colIdx['Employee ID']] || '').trim();
    const nameCell  = String(raw[colIdx['First Name']]  || '').trim();
    const dateCell  = String(raw[colIdx['Date']]        || '').trim();
    const timesCell = String(raw[colIdx['Times']]       || '').trim();
    const timeCell  = String(raw[colIdx['Time']]        || '').trim();

    if (!idCell && !nameCell && !timeCell) continue; // blank row
    if (!idCell || !nameCell || !dateCell) continue; // partial row — skip rather than throw

    const psn = normalisePsn(idCell);
    const name = normaliseName(nameCell);
    const date = parseDdmmyyyy(dateCell);
    if (!date) continue;
    if (!dataDate) dataDate = date;

    const allPunches = parseTimeList(timeCell);
    const deduped    = dedupePunches(allPunches, ATTENDANCE_POLICY.dedupeWindowSec);

    rows.push({
      psn,
      name,
      date,
      rawPunches:    allPunches,             // every reading from the device
      uniquePunches: deduped,                // after the <60s dedupe pass
      rawCount:      Number(timesCell) || allPunches.length,
      uniqueCount:   deduped.length,
      firstPunch:    deduped[0] || null,
      lastPunch:     deduped.length >= 2 ? deduped[deduped.length - 1] : null,
      midDayPunches: deduped.length > 2 ? deduped.slice(1, -1) : [],
    });
  }

  return { rows, dataDate, sheetName };
}

// Public so the UI can sanity-check a row before ingestion (optional).
export function normalisePsn(idCell) {
  const digits = String(idCell || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  const raw = 'H' + digits.padStart(5, '0');
  // Apply biometric → master PSN alias if one is registered. See
  // src/lib/psnAliases.js for the table and rationale (typically
  // staff whose biometric device emits a different ID than what
  // their employees-table record uses, and we don't want to lose
  // their logs while IT fixes the device config).
  return applyPsnAlias(raw);
}

export function normaliseName(name) {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse Saudi-convention DD/MM/YYYY → ISO YYYY-MM-DD. Returns null on
// anything we can't confidently parse so the caller skips the row.
export function parseDdmmyyyy(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const dd = String(m[1]).padStart(2, '0');
  const mm = String(m[2]).padStart(2, '0');
  const yyyy = m[3];
  // Sanity-check ranges so '13/13/2026' doesn't silently become a date.
  if (Number(dd) < 1 || Number(dd) > 31) return null;
  if (Number(mm) < 1 || Number(mm) > 12) return null;
  return `${yyyy}-${mm}-${dd}`;
}

function parseTimeList(s) {
  return String(s || '')
    .split(',')
    .map(t => t.trim())
    .filter(t => /^\d{1,2}:\d{2}(:\d{2})?$/.test(t))
    .map(normaliseTime)
    .sort(); // lex sort works for HH:MM:SS 24-hour strings
}

function normaliseTime(t) {
  // Pad HH:MM to HH:MM:00 so all timestamps in the row are comparable.
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (!m) return t;
  return `${String(m[1]).padStart(2, '0')}:${m[2]}:${m[3] || '00'}`;
}

function timeToSec(t) {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(t);
  if (!m) return NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function dedupePunches(times, windowSec) {
  // Walk in sorted order, drop any entry that's within `windowSec`
  // of the previously-kept entry. Captures device double-reads.
  const out = [];
  let prevSec = -Infinity;
  for (const t of times) {
    const s = timeToSec(t);
    if (Number.isNaN(s)) continue;
    if (s - prevSec >= windowSec) {
      out.push(t);
      prevSec = s;
    }
  }
  return out;
}

// ─── Cross-reference with permissions ────────────────────────────────────────

/**
 * For each parsed row, look up the matching approved permission and
 * produce a status enum + context. Permissions and rows must be for
 * the same date — caller's responsibility to filter.
 *
 * @param {ParsedRow[]} rows
 * @param {Permission[]} permissions  approved permission_requests
 *                                    (any date — we filter by row.date)
 * @param {Object<string, Employee>} employeesById  for shift overrides
 * @returns {AnnotatedRow[]}
 */
export function crossReferenceWithPermissions(rows, permissions = [], employeesById = {}) {
  // Index permissions by employee+date+type for O(1) lookup.
  // Keep only stage='approved' rows — pending or rejected don't grant
  // coverage. The portal's stage values come from the leave/permission
  // workflow refactor; older rows may still have status='approved' set
  // independently, so we accept either.
  const permIdx = new Map();
  for (const p of permissions || []) {
    const stageOk = p.stage === 'approved' || p.status === 'approved';
    if (!stageOk) continue;
    if (!p.employee_id || !p.permission_date || !p.type) continue;
    const key = `${p.employee_id}|${p.permission_date}|${p.type}`;
    // If multiple permissions exist for the same employee+date+type
    // (shouldn't happen but defend against it), prefer the widest
    // window.
    const prev = permIdx.get(key);
    if (!prev || windowMinutes(p) > windowMinutes(prev)) {
      permIdx.set(key, p);
    }
  }

  return rows.map(row => annotateRow(row, permIdx, employeesById));
}

function windowMinutes(p) {
  if (!p.time_from || !p.time_to) return Number(p.hours || 0) * 60;
  return Math.max(0, timeToSec(normaliseTime(p.time_to)) - timeToSec(normaliseTime(p.time_from))) / 60;
}

function annotateRow(row, permIdx, employeesById) {
  const annotated = { ...row, status: 'OK', detail: null, permission: null };
  const emp = employeesById[row.psn] || null;
  annotated.employee = emp;

  // Determine scheduled end based on department.
  const endTime = (emp?.department === 'SUP')
    ? ATTENDANCE_POLICY.endTimeSup
    : ATTENDANCE_POLICY.endTimeStandard;
  annotated.scheduledStart = ATTENDANCE_POLICY.startTime;
  annotated.scheduledEnd   = endTime;

  // Incomplete / duplicate handling first — these are data-quality
  // statuses that take precedence over late/early.
  if (row.uniqueCount === 0) {
    annotated.status = 'INCOMPLETE';
    annotated.detail = 'No valid punches recorded.';
    return annotated;
  }
  if (row.uniqueCount === 1) {
    annotated.status = 'INCOMPLETE';
    annotated.detail = `Only one punch on file (${row.firstPunch}). No punch-out recorded.`;
    return annotated;
  }
  // Span check (catches device error where two reads were just outside
  // the dedupe window but functionally identical).
  const span = timeToSec(row.lastPunch) - timeToSec(row.firstPunch);
  if (span < 60) {
    annotated.status = 'DUPLICATE';
    annotated.detail = `Punches are ${span} seconds apart — likely device duplicate.`;
    return annotated;
  }

  // Late check
  const startSec       = timeToSec(normaliseTime(ATTENDANCE_POLICY.startTime));
  const graceLateSec   = startSec + ATTENDANCE_POLICY.graceLate * 60;
  const firstSec       = timeToSec(row.firstPunch);
  const isLate         = firstSec > graceLateSec;

  // Early check
  const endSec         = timeToSec(normaliseTime(endTime));
  const graceEarlySec  = endSec - ATTENDANCE_POLICY.graceEarly * 60;
  const lastSec        = timeToSec(row.lastPunch);
  const isEarly        = lastSec < graceEarlySec;

  // Apply permissions if relevant.
  if (isLate) {
    const perm = permIdx.get(`${row.psn}|${row.date}|late_arrival`);
    if (!perm) {
      annotated.status = 'LATE_NO_PERMISSION';
      annotated.detail = `Arrived at ${trimSec(row.firstPunch)} — ${minutesPast(firstSec, startSec)} min after ${ATTENDANCE_POLICY.startTime}, no permission on file.`;
      annotated.minutesLate = minutesPast(firstSec, startSec);
    } else {
      const permEndSec = timeToSec(normaliseTime(perm.time_to || ''));
      annotated.permission = pickPermFields(perm);
      if (Number.isFinite(permEndSec) && firstSec > permEndSec) {
        const minBeyond = Math.round((firstSec - permEndSec) / 60);
        annotated.status = 'LATE_BEYOND';
        annotated.detail = `Permitted to ${trimSec(perm.time_to)}, arrived ${trimSec(row.firstPunch)} — ${minBeyond} min beyond permission.`;
        annotated.minutesBeyond = minBeyond;
        annotated.minutesLate = minutesPast(firstSec, startSec);
      } else {
        annotated.status = 'LATE_PERMITTED';
        annotated.detail = `Arrived ${trimSec(row.firstPunch)} — within approved late-arrival permission (${trimSec(perm.time_from)}–${trimSec(perm.time_to)}).`;
      }
    }
    return annotated;
  }

  if (isEarly) {
    const perm = permIdx.get(`${row.psn}|${row.date}|early_leave`);
    if (!perm) {
      annotated.status = 'EARLY_NO_PERMISSION';
      annotated.detail = `Left at ${trimSec(row.lastPunch)} — ${minutesPast(endSec, lastSec)} min before ${endTime}, no permission on file.`;
      annotated.minutesEarly = minutesPast(endSec, lastSec);
    } else {
      const permStartSec = timeToSec(normaliseTime(perm.time_from || ''));
      annotated.permission = pickPermFields(perm);
      if (Number.isFinite(permStartSec) && lastSec < permStartSec) {
        const minBeyond = Math.round((permStartSec - lastSec) / 60);
        annotated.status = 'EARLY_BEYOND';
        annotated.detail = `Permitted from ${trimSec(perm.time_from)}, left ${trimSec(row.lastPunch)} — ${minBeyond} min beyond permission.`;
        annotated.minutesBeyond = minBeyond;
        annotated.minutesEarly = minutesPast(endSec, lastSec);
      } else {
        annotated.status = 'EARLY_PERMITTED';
        annotated.detail = `Left ${trimSec(row.lastPunch)} — within approved early-departure permission (${trimSec(perm.time_from)}–${trimSec(perm.time_to)}).`;
      }
    }
    return annotated;
  }

  // Normal day. Surface a tidy summary.
  const totalMin = Math.round(span / 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  annotated.status = 'OK';
  annotated.detail = `${trimSec(row.firstPunch)} → ${trimSec(row.lastPunch)} · ${hh}h ${mm}m`;
  return annotated;
}

function trimSec(t) {
  // 'HH:MM:SS' → 'HH:MM' for display
  const m = /^(\d{2}):(\d{2})/.exec(String(t || ''));
  return m ? `${m[1]}:${m[2]}` : (t || '');
}

function minutesPast(later, earlier) {
  return Math.max(0, Math.round((later - earlier) / 60));
}

function pickPermFields(p) {
  return {
    id:        p.id,
    type:      p.type,
    time_from: p.time_from,
    time_to:   p.time_to,
    hours:     p.hours,
    reason:    p.reason || null,
  };
}

// ─── Status helpers ──────────────────────────────────────────────────────────

export const STATUS_PRESENTATION = {
  OK:                  { label: 'On time',                 tone: 'green',  emoji: '✓'  },
  LATE_PERMITTED:      { label: 'Late — permitted',         tone: 'amber',  emoji: '◐'  },
  LATE_BEYOND:         { label: 'Late beyond permission',   tone: 'red',    emoji: '!'  },
  LATE_NO_PERMISSION:  { label: 'Late — no permission',     tone: 'red',    emoji: '!'  },
  EARLY_PERMITTED:     { label: 'Early — permitted',        tone: 'amber',  emoji: '◐'  },
  EARLY_BEYOND:        { label: 'Early beyond permission',  tone: 'red',    emoji: '!'  },
  EARLY_NO_PERMISSION: { label: 'Early — no permission',    tone: 'red',    emoji: '!'  },
  INCOMPLETE:          { label: 'Incomplete punches',       tone: 'grey',   emoji: '?'  },
  DUPLICATE:           { label: 'Duplicate punches',        tone: 'grey',   emoji: '?'  },
};

// True for statuses that warrant Bashaier's manual email follow-up.
export function isActionable(status) {
  return status === 'LATE_NO_PERMISSION'
      || status === 'LATE_BEYOND'
      || status === 'EARLY_NO_PERMISSION'
      || status === 'EARLY_BEYOND'
      || status === 'INCOMPLETE';
}

// True for statuses where a permission softened the violation.
export function isCovered(status) {
  return status === 'LATE_PERMITTED' || status === 'EARLY_PERMITTED';
}
