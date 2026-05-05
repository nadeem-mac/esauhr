// =============================================================================
// attendanceBackfill.js
//
// One-shot historical backfill for attendance_daily. Used when Bashaier
// imports a multi-month xlsx covering a period BEFORE the daily-upload
// flow was in use. Different from the daily recorder in three ways:
//
//   1. Processes EVERY date in the file, not just yesterday + today.
//   2. Status is always 'present' — the late/short/absent evaluation
//      requires shift schedule data which doesn't exist for historical
//      dates. Going forward (May 5 onwards) the daily flow with the
//      recorder will still write the proper evaluated status; backfill
//      only fills the gaps in the past.
//   3. Source field is 'backfill' (vs 'attendance_upload'), so admins
//      can distinguish historical fill rows from daily evaluation
//      rows in audit views.
//
// IDEMPOTENT
//   Upsert on (employee_id, attendance_date) — re-running over the
//   same file overwrites cleanly. Re-running with a fresh file that
//   covers the same date range will overwrite any existing rows for
//   those (employee, date) pairs — including ones written by the
//   daily flow. The UI warns about this before committing.
//
// CHUNKED
//   Posts in 100-row batches with an onProgress callback so the UI
//   can render a progress bar. A 4-month backfill for ~50 staff
//   could be 5,000+ rows; one big POST would risk timeout.
// =============================================================================

import { parseTimeCardXlsx } from './timeCard.js';
import { directPost, directGet } from '../supabaseClient.js';

// Local YYYY-MM-DD without timezone surprises.
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// HH:MM[:SS] → HH:MM:SS for Postgres `time`. Returns null for empty.
function toTime(s) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  if (/^\d{1,2}:\d{2}$/.test(trimmed))      return `${trimmed}:00`;
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(trimmed)) return trimmed;
  return null;
}

// DD/MM/YYYY → YYYY-MM-DD. Returns null on bad input.
function isoDate(ddmmyyyy) {
  if (!ddmmyyyy) return null;
  const m = String(ddmmyyyy).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

/**
 * Parse the file. Reuses the daily parser since the file format is
 * identical — just a longer date range.
 *
 * @param {File} file
 * @returns {Promise<{rows, dataDate, sheetName}>}
 */
export async function parseBackfillXlsx(file) {
  return parseTimeCardXlsx(file);
}

/**
 * Convert parsed rows into attendance_daily upsert payload.
 *
 * @param {Object} args
 * @param {Array}  args.parsedRows  — output of parseBackfillXlsx().rows
 * @param {Array}  args.employees   — directory for PSN canonicalization
 * @param {string} args.recordedBy  — PSN of the importer (Bashaier / admin)
 * @returns {{ rows, summary }}
 *
 *  summary = {
 *    parsed:     total parsed rows
 *    skipped:    rows missing PSN/date/punches
 *    unmatched:  rows whose PSN didn't resolve to any directory employee
 *    rows:       count of upsert-ready rows
 *    employees:  Set of unique employee IDs touched
 *    minDate:    earliest YYYY-MM-DD
 *    maxDate:    latest YYYY-MM-DD
 *  }
 */
export function buildBackfillRows({ parsedRows, employees, recordedBy }) {
  // Index the directory once. Two indexes — one for full PSN match
  // (e.g. "H94499"), one for the digits-only fallback ("94499") since
  // some xlsx exports drop the H prefix.
  const empById     = new Map();
  const empByDigits = new Map();
  (employees || []).forEach(e => {
    if (!e?.id) return;
    empById.set(String(e.id).toUpperCase(), e);
    const m = String(e.id).match(/(\d+)/);
    if (m && m[1]) empByDigits.set(m[1], e);
  });

  const rows = [];
  const touchedEmployees = new Set();
  let parsed = 0;
  let skipped = 0;
  let unmatched = 0;
  let minDate = null;
  let maxDate = null;
  const now = new Date().toISOString();

  // Validate ISO date shape — parser already returns YYYY-MM-DD, but
  // defend against unexpected null/garbage.
  const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

  for (const r of (parsedRows || [])) {
    parsed++;
    const psn = String(r.psn || '').toUpperCase().trim();
    // Date comes from parseTimeCardXlsx already in YYYY-MM-DD form
    // via parseDdmmyyyy. Use it directly — DON'T re-parse as
    // DD/MM/YYYY (the bug that caused 4901 rows to silently skip).
    const dateIso = (r.date && ISO_RE.test(r.date)) ? r.date : null;
    if (!psn || !dateIso) { skipped++; continue; }

    // Resolve to canonical employee_id
    const emp = empById.get(psn) ||
                empByDigits.get(psn.replace(/^H/, ''));
    const empId = emp?.id || psn;
    if (!emp) unmatched++;

    // Skip rows with no usable punch data — purely informational
    // entries that don't tell us anything attendance-wise.
    const firstPunch = r.firstPunch;
    const lastPunch  = r.lastPunch || r.firstPunch;
    if (!firstPunch && !lastPunch) { skipped++; continue; }

    rows.push({
      employee_id:        empId,
      attendance_date:    dateIso,
      status:             'present',
      first_punch:        toTime(firstPunch),
      last_punch:         toTime(lastPunch),
      punch_count:        r.uniqueCount || 0,
      expected_start:     null,  // unknown for historical dates
      expected_end:       null,
      late_minutes:       0,
      early_leave_minutes:0,
      leave_request_id:   null,
      notes:              'Imported via historical backfill',
      recorded_at:        now,
      recorded_by:        recordedBy || null,
      source:             'backfill',
    });

    touchedEmployees.add(empId);
    if (!minDate || dateIso < minDate) minDate = dateIso;
    if (!maxDate || dateIso > maxDate) maxDate = dateIso;
  }

  return {
    rows,
    summary: {
      parsed,
      skipped,
      unmatched,
      rows: rows.length,
      employees: touchedEmployees,
      minDate,
      maxDate,
    },
  };
}

/**
 * Check how many of the proposed rows would overwrite existing
 * attendance_daily entries. Lets the UI warn the user before they
 * commit a destructive backfill.
 *
 * @param {Array<{employee_id, attendance_date}>} rows
 * @returns {Promise<{ existingCount, sample }>}  — sample is up to 5
 *   (employee, date) pairs that would be overwritten
 */
export async function previewOverwrites(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { existingCount: 0, sample: [] };
  }
  // Take min/max date as a coarse window; the per-employee filter
  // would mean potentially hundreds of OR clauses which PostgREST
  // chokes on. Better to fetch the date range and filter client-side.
  const minDate = rows.reduce((m, r) => !m || r.attendance_date < m ? r.attendance_date : m, null);
  const maxDate = rows.reduce((m, r) => !m || r.attendance_date > m ? r.attendance_date : m, null);
  if (!minDate || !maxDate) return { existingCount: 0, sample: [] };

  try {
    const empIds = Array.from(new Set(rows.map(r => r.employee_id))).join(',');
    const existing = await directGet(
      'attendance_daily',
      `select=employee_id,attendance_date` +
      `&attendance_date=gte.${minDate}&attendance_date=lte.${maxDate}` +
      `&employee_id=in.(${encodeURIComponent(empIds)})`,
      { timeoutMs: 12000 }
    );
    const haveByKey = new Set(
      (existing || []).map(r => `${r.employee_id}|${r.attendance_date}`)
    );
    const overlapping = rows.filter(
      r => haveByKey.has(`${r.employee_id}|${r.attendance_date}`)
    );
    return {
      existingCount: overlapping.length,
      sample: overlapping.slice(0, 5).map(r => ({
        employee_id: r.employee_id,
        attendance_date: r.attendance_date,
      })),
    };
  } catch {
    return { existingCount: 0, sample: [] };
  }
}

/**
 * Upsert the rows in 100-row chunks, calling onProgress after each.
 *
 * @param {Array} rows
 * @param {(progress: {written, total}) => void} onProgress
 * @returns {Promise<{written}>}
 */
export async function recordBackfillRows(rows, onProgress) {
  if (!Array.isArray(rows) || rows.length === 0) return { written: 0 };
  const CHUNK = 100;
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    await directPost('attendance_daily', slice, {
      upsert: true,
      onConflict: 'employee_id,attendance_date',
      timeoutMs: 15000,
    });
    written += slice.length;
    if (onProgress) {
      try { onProgress({ written, total: rows.length }); } catch {}
    }
  }
  return { written };
}

// Re-export so consumers can format dates consistently.
export const __utils = { ymd, toTime, isoDate };
