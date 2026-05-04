import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Upload, FileText, Clock, AlertTriangle, Mail, CheckCircle2,
  X, Calendar, Briefcase, Users, Send, Sparkles
} from 'lucide-react';
import { directGet, directPost } from '../supabaseClient.js';
import { parseTimeCardXlsx, TimeCardParseError } from '../lib/timeCard.js';

/* ────────────────────────────────────────────────────────────────────────
   Daily attendance check — driven by Time Card xlsx upload.

   Bashaier uploads a 2-day Time Card export (.xlsx) every morning,
   covering yesterday's working day + today. A single upload drives
   both passes:

     TODAY's rows      → late arrivals + missed punch-in
     YESTERDAY's rows  → early departures + missed punch-out

   The file is rejected if it doesn't contain rows for both dates
   (computed from the real-world clock, not the file's contents). On
   Sunday, "yesterday's working day" is Thursday since Fri+Sat are
   KSA weekend.

   Detection per row:
     1. LATE  (today's data only) — punched in after 08:15
        (8:00 official start + 15 min grace).
        Cross-referenced against approved late_arrival permissions:
          • LATE_PERMITTED   — permission on file, within window
          • LATE_BEYOND      — permission on file, but came in even later
          • LATE_NO_PERMISSION — actual violation, action required
     2. EARLY (yesterday's data only) — punched out before scheduled
        end - 15 min grace.
          • SUP team: scheduled end 16:00 (4 PM) → cutoff 15:45
          • All other depts: scheduled end 17:00 (5 PM) → cutoff 16:45
        Same WITH/WITHOUT permission split as late.
     3. MISSED PUNCH-IN  (today's data only) — no first-punch on record
     4. MISSED PUNCH-OUT (yesterday's data only) — no last-punch on record

   For each WITHOUT-PERMISSION row: an "Email" button opens her mail client
   with a pre-filled email (TO: employee, CC: direct manager + execs).
   No automated send — every email needs her review and explicit Send click.

   Anyone with an approved leave request covering the date is excluded
   automatically (they are on leave, not absent or late).

   Weekend rows (Friday/Saturday in KSA) are skipped entirely.

   The xlsx format is the ONLY accepted format going forward. The
   previous CSV path has been removed — uploaders will see a clear
   error if they try to upload anything else.
   ──────────────────────────────────────────────────────────────────────── */

// ESAU policy constants
const OFFICIAL_START   = '08:00';
const LATE_CUTOFF      = '08:15';   // after this = late
const SUP_END          = '16:00';   // SUP team scheduled end (4 PM)
const SUP_EARLY_CUTOFF = '15:45';   // before this = early leave (SUP)
const STD_END          = '17:00';   // other depts scheduled end (5 PM)
const STD_EARLY_CUTOFF = '16:45';   // before this = early leave (non-SUP)

// Always-CC list per company policy
const FIXED_CC = [
  'johnho@evergreen-shipping.com.sa',                // John Ho — Country Head
  'jamesliu@evergreen-shipping.com.sa',              // James Liu — Country Head
  'badria.alhassan@evergreen-shipping.com.sa',       // Badria — SUP team
  'jaffar.aldarweash@evergreen-shipping.com.sa',     // Jaffar — SUP team
  'fahad.alhussain@evergreen-shipping.com.sa',       // Fahad — SUP team manager
];

// Bashaier's full corporate sign-off — provided verbatim by Nadeem.
// Multi-line so the recipient's mail client renders it as a proper signature.
const HR_SIGNATURE =
  'Thanks and regards,\n\n' +
  'BASHAIER ALI\n' +
  'Evergreen Shipping Agency Saudi Co.,(L.L.C)\n' +
  'ESAU - SADMN SUP/ HR DEPT\n' +
  'Whatsapp: 966-54 320 9694\n' +
  'Tel: 966-013 813 8563 – Ext 8543\n' +
  'Email:bashaier.alsubaie@evergreen-shipping.com.sa';

// ────────────────────────────────────────────────────────────────────────
// CSV parsing — handles quoted fields, returns array of row-objects keyed
// by header. Tolerant of trailing whitespace, BOM, mixed line endings.
// ────────────────────────────────────────────────────────────────────────
function parseCsv(text) {
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
  if (lines.length < 2) return { headers: [], rows: [], err: 'CSV is empty or has no data rows.' };

  function splitLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (c === ',' && !inQuotes) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  const headers = splitLine(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitLine(lines[i]);
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (cells[idx] || '').replace(/^"|"$/g, '').trim(); });
    rows.push(obj);
  }
  return { headers, rows };
}

// Time string → minutes since midnight. Handles "8:15", "08:15", "08:15:00", "8:15 AM".
// Returns null if not parseable.
function timeToMinutes(s) {
  if (!s || typeof s !== 'string') return null;
  const trimmed = s.trim();
  if (!trimmed) return null;
  const m = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = (m[3] || '').toUpperCase();
  if (ampm === 'PM' && h < 12) h += 12;
  if (ampm === 'AM' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minutesToHHMM(min) {
  if (min == null) return '—';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// Used by P4 to derive the late/early grace cutoffs from a custom shift's
// start/end. Returns 'HH:MM'. Handles negative deltas. Falls back to the
// input string if it can't be parsed (so callers degrade safely).
function addMinutesToTime(timeStr, deltaMin) {
  const base = timeToMinutes(timeStr);
  if (base == null) return timeStr;
  const total = ((base + deltaMin) % 1440 + 1440) % 1440;
  return minutesToHHMM(total);
}

// Format a 24-hour HH:MM string as a 12-hour string with AM/PM. Used in
// the early-departure email's policy bullets so the times match the
// late-arrival email's style ("8:00 AM" rather than "08:00"). Returns
// the original input unchanged if it doesn't parse — defensive against
// callers passing already-formatted strings.
function fmtTime12h(hhmm) {
  if (typeof hhmm !== 'string' || !/^\d{1,2}:\d{2}/.test(hhmm)) return hhmm;
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12  = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// Department check — SUP team has 8-4 hours.
// Working-hours group is now stored on the employee record as
// working_hours_group ('standard' default, or 'sup_team'). The
// SUP team works 08:00 → 16:00 with a 15:45 early-leave cutoff;
// 'standard' is 08:00 → 17:00 with a 16:45 cutoff. Driving this
// from a flag, not a hardcoded PSN list, makes the schedule
// reassignable without a code deploy.
function isSupTeam(emp) {
  return emp?.working_hours_group === 'sup_team';
}

// Lookup the schedule for an employee.
function scheduleFor(emp) {
  if (isSupTeam(emp)) {
    return { startStr: OFFICIAL_START, endStr: SUP_END, lateCutoffStr: LATE_CUTOFF, earlyCutoffStr: SUP_EARLY_CUTOFF, label: 'SUP team (08:00–16:00)' };
  }
  return { startStr: OFFICIAL_START, endStr: STD_END, lateCutoffStr: LATE_CUTOFF, earlyCutoffStr: STD_EARLY_CUTOFF, label: 'Standard (08:00–17:00)' };
}

// Detect the date represented by the CSV. Looks for the most-common Date value
// in rows. Returns YYYY-MM-DD or null.
function detectCsvDate(rows) {
  if (!rows || !rows.length) return null;
  const counts = {};
  rows.forEach(r => {
    const d = (r['Date'] || r['date'] || '').trim();
    if (!d) return;
    counts[d] = (counts[d] || 0) + 1;
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  return normaliseDate(top[0]);
}

// Convert any plausible date string to YYYY-MM-DD.
function normaliseDate(s) {
  if (!s) return null;
  s = s.trim();
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD-MM-YYYY
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  // YYYY/MM/DD
  m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  // Try Date parse fallback
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }
  return null;
}

// Is the given date a KSA weekend (Friday=5, Saturday=6)?
function isKsaWeekend(yyyymmdd) {
  if (!yyyymmdd) return false;
  const d = new Date(yyyymmdd + 'T00:00:00');
  const day = d.getDay();
  return day === 5 || day === 6;
}

// Most-recent working day before the given date. Skips KSA weekend
// (Fri+Sat). e.g. Sun → Thu (skip Sat+Fri); Tue → Mon. Used for the
// 2-day file workflow: when Bashaier uploads a file on day X, "yesterday"
// for end-of-day checks (early departures + missed punch-out) is the
// previous working day, not necessarily X-1.
// Most-recent working day before the given date. Skips KSA weekend
// (Fri+Sat). e.g. Sun → Thu (skip Sat+Fri); Tue → Mon; Mon → Sun.
//
// IMPORTANT — this used to use new Date('YYYY-MM-DDT00:00:00') +
// d.toISOString().slice(0,10) for every step. Both halves drifted to
// UTC: the constructor is local but toISOString returns UTC, so in
// KSA (UTC+3) every formatted step lost a day. The bug visible to
// Bashaier: Mon May 4 came back as Apr 30 (because each "previous
// day" got mis-formatted one further back, walking through Sat+Fri
// it should have skipped). Fix: build the Date with the year/month/
// day constructor (unambiguously local), use d.getDay() to test the
// weekend (no formatting at all), and only format with local Y-M-D
// at the very end.
function previousWorkingDay(yyyymmdd) {
  if (!yyyymmdd) return null;
  const [y, m, d] = yyyymmdd.split('-').map(Number);
  const dt = new Date(y, m - 1, d); // local-noon construction is safer but local-midnight works for date-only math
  do {
    dt.setDate(dt.getDate() - 1);
  } while (dt.getDay() === 5 || dt.getDay() === 6); // KSA weekend = Fri (5) + Sat (6)
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// Today's date in local time (browser clock) as YYYY-MM-DD. Avoids
// the UTC-shift bug from `new Date().toISOString().slice(0,10)` —
// at 02:00 KSA local, that returns the previous day's UTC date,
// which would silently break the today/yesterday enforcement check.
function todayInLocal() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

function formatDateLong(yyyymmdd) {
  if (!yyyymmdd) return '—';
  const d = new Date(yyyymmdd + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ────────────────────────────────────────────────────────────────────────
// Email body builders. Each returns { subject, body }.
// ────────────────────────────────────────────────────────────────────────
function lateEmailContent({ employee, dateLong, punchInStr, minutesLate, scheduledStart, lateCutoff }) {
  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  const subject = 'Late Arrival Notice — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  // Policy bullets — kept identical for every late-arrival email so
  // staff see consistent wording. Em-dashes were stripped (per Nadeem
  // 2026-05). Bullet 3 was updated 2026-05 to combined wording: the
  // 3-permissions-per-month entitlement is shared across late-arrival
  // and early-departure (per the official ESAU Permission Request
  // Form), not separate quotas. The early-departure email uses the
  // same wording for the same reason.
  const policyBullets = [
    '\u2022 The official clock-in time is 8:00 AM on regular working days.',
    '\u2022 A 15-minute grace period is allowed; arrivals after 8:15 AM are recorded as late.',
    '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
  ];

  // Divider — 71 equals signs, character + count both confirmed by
  // Nadeem against his actual mail client's rendering. NOT computed
  // from bullet length: equals are narrower than the unicode
  // box-drawing chars used previously, so a length-matched count
  // would overshoot. If the bullets are ever rewritten and the box
  // looks misaligned in production, re-test in the real mail client
  // and update this constant rather than introducing dynamic sizing
  // (which proved sensitive to character-width differences in
  // proportional-font mail clients).
  const divider = '='.repeat(71);

  // Body — written in HR-Department voice (institutional, not
  // personal). Em-dashes replaced with commas (first prose em-dash)
  // or periods (second prose em-dash, where a comma would have
  // created a splice between two independent clauses).
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows your punch-in at ' + punchInStr + ', ' + minutesLate + ' minutes past the 15-minute grace period and with no approved permission on file. This is recorded as a late-arrival violation.\n\n' +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    policyBullets.join('\n') + '\n' +
    divider + '\n\n' +
    'You are still required to submit a late-arrival permission request via the ESAU HR Portal (esauhr.netlify.app \u2192 New Request \u2192 Permission) for today\u2019s punch-in. Submitting it after the fact lets HR record the reason and consider it against your monthly entitlement. Without an approved permission, the day stands as an unexcused violation on your evaluation record.\n\n' +
    'For exceptional cases (medical, official, or other documented emergencies that go beyond the monthly entitlement), please reply to this email within two working days with the supporting details.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

function earlyLeaveEmailContent({ employee, dateLong, punchOutStr, scheduledEnd, minutesEarly }) {
  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  const subject = 'Early Departure Notice — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  // Time-of-day formatting for the policy bullets and the violation
  // summary. The system stores scheduledEnd in 24-hour HH:MM (either
  // "16:00" for SUP team or "17:00" for everyone else, but the policy
  // tolerates any value that comes in). We display 12-hour with AM/PM
  // to mirror the late-arrival email style ("8:00 AM"). Cutoff is
  // always scheduledEnd minus the 15-minute grace window.
  const endStr12h    = fmtTime12h(scheduledEnd);
  const cutoffStr    = addMinutesToTime(scheduledEnd, -15);
  const cutoffStr12h = fmtTime12h(cutoffStr);

  // Policy bullets — bullet 1 + 2 are personalized to the staff's
  // own scheduled clock-out time and grace cutoff (varies by role).
  // Bullet 3 mirrors the late-arrival email exactly: the 3 permissions
  // per month is a SHARED entitlement spanning both late arrival and
  // early departure (per the official ESAU Permission Request Form).
  const policyBullets = [
    '\u2022 Your scheduled clock-out time is ' + endStr12h + ' on regular working days.',
    '\u2022 A 15-minute grace period is allowed; departures before ' + cutoffStr12h + ' are recorded as early leave.',
    '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
  ];

  // Divider — 71 equals signs, character + count both confirmed by
  // Nadeem against the late-arrival email's rendering in his actual
  // mail client. Re-test in production if the bullets are rewritten
  // and the visual fit looks off.
  const divider = '='.repeat(71);

  // Body — HR-Department voice, mirrors the late-arrival template.
  // Em-dashes deliberately avoided in prose (commas / periods used
  // instead). The violation summary phrases the timing as "X minutes
  // before your scheduled [time] clock-out time" — this is the diff
  // between punch-out and scheduledEnd (NOT from the cutoff), which
  // matches how minutesEarly is computed upstream.
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows your punch-out at ' + punchOutStr + ', ' + minutesEarly + ' minutes before your scheduled ' + endStr12h + ' clock-out time and with no approved permission on file. This is recorded as an early-departure violation.\n\n' +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    policyBullets.join('\n') + '\n' +
    divider + '\n\n' +
    'You are still required to submit an early-departure permission request via the ESAU HR Portal (esauhr.netlify.app \u2192 New Request \u2192 Permission) for today\u2019s punch-out. Submitting it after the fact lets HR record the reason and consider it against your monthly entitlement. Without an approved permission, the day stands as an unexcused violation on your evaluation record.\n\n' +
    'For exceptional cases (medical, official, or other documented emergencies that go beyond the monthly entitlement), please reply to this email within two working days with the supporting details.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

function missedPunchEmailContent({ employee, dateLong, missingType }) {
  // missingType: 'in' | 'out' | 'both'
  // Wording variants for the violation summary line and the action
  // paragraph. Both have to agree on which punch(es) are missing —
  // kept as a single switch so future edits don't drift.
  const missingPhrase = missingType === 'in'
    ? 'your punch-in'
    : missingType === 'out'
    ? 'your punch-out'
    : 'both your punch-in and punch-out';
  const actualTimesPhrase = missingType === 'in'
    ? 'your actual arrival time'
    : missingType === 'out'
    ? 'your actual departure time'
    : 'your actual arrival and departure times';

  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  const subject = 'Missing Punch Notice — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  // Policy bullets — different shape from the late/early emails
  // because missed punches aren't a "you exceeded your quota"
  // situation. The framing is: a complete record is required, the
  // gap has real downstream consequences (payroll, overtime,
  // Saudi labor compliance), and the correction must come through
  // the line manager within a 2-day window.
  const policyBullets = [
    '\u2022 A complete punch-in and punch-out is required on every working day.',
    '\u2022 Missing punches affect payroll, overtime, and Saudi labor law compliance.',
    '\u2022 Missed punches must be reported and confirmed by your manager within two working days.',
  ];

  // Same 71-char "=" divider as the late/early emails (visual fit
  // confirmed in production mail-client rendering by Nadeem).
  const divider = '='.repeat(71);

  // Body — HR-Department voice. Action paragraph routes the
  // correction through the line manager (who is already CC'd on
  // this email by the AttendanceView build): staff discusses the
  // actual times with their manager, manager replies to confirm,
  // HR updates the log. Removed the previous "device fault /
  // operations team" exception paragraph per Nadeem's instruction
  // — manager-confirmation now covers all legitimate correction
  // cases including faulty terminal readings.
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows ' + missingPhrase + ' missing from the time card. This leaves the day\u2019s record incomplete and cannot be processed for payroll until corrected.\n\n' +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    policyBullets.join('\n') + '\n' +
    divider + '\n\n' +
    'Please discuss ' + actualTimesPhrase + ' for ' + dateLong + ' with your direct manager (copied on this email). Your manager must then reply confirming the times within two working days, after which the attendance log will be updated. Without manager confirmation, the day stands as incomplete on your record.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

// ─────────────────────────────────────────────────────────────────────────
// TEMP / PRE-LAUNCH EMAIL VARIANTS
// ─────────────────────────────────────────────────────────────────────────
// While the ESAU HR Portal is in pre-launch testing, Bashaier needs a
// way to send violation notices that DO NOT reference the portal or the
// esauhr.netlify.app URL. Once the portal is officially announced to
// staff, the temp buttons disappear and only the live versions remain.
//
// Design constraint: the live wording (lateEmailContent /
// earlyLeaveEmailContent / missedPunchEmailContent above) was carefully
// reviewed by Nadeem and IS LOCKED. The temp variants are deliberately
// kept as separate functions rather than parameterizing the live ones
// with a `mode` flag — this way, future tweaks to the test wording
// can never accidentally drift the production wording.
//
// Differences vs the live versions:
//   1. Late + early temps drop the entire "submit a permission request
//      via the ESAU HR Portal" paragraph.
//   2. The action becomes "reply to this email with a valid reason"
//      since portal-tracked permission submission isn't available
//      pre-launch.
//   3. The "evaluation record" / "unexcused violation" language is
//      softened to just stating the violation has been recorded —
//      formal evaluation tracking goes through the portal which
//      isn't live yet.
//   4. Missed-punch temp is identical to its live version because
//      the live version already routes through manager confirmation
//      (no portal mention). Both functions are kept symmetric so
//      the UI plumbing treats all three violation types uniformly.
// ─────────────────────────────────────────────────────────────────────────

function lateEmailContentTemp({ employee, dateLong, punchInStr, minutesLate, scheduledStart, lateCutoff }) {
  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  const subject = 'Late Arrival Notice — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  // Same policy bullets as the live version — these are factual policy
  // statements, not portal-related, so they stay verbatim.
  const policyBullets = [
    '\u2022 The official clock-in time is 8:00 AM on regular working days.',
    '\u2022 A 15-minute grace period is allowed; arrivals after 8:15 AM are recorded as late.',
    '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
  ];

  const divider = '='.repeat(71);

  // Body — same opening + policy block as live, but the action paragraph
  // routes the explanation through email reply rather than portal
  // submission. The closing "evaluation record" line is softened to
  // just confirming the violation is on file.
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows your punch-in at ' + punchInStr + ', ' + minutesLate + ' minutes past the 15-minute grace period and with no approved permission on file. This is recorded as a late-arrival violation.\n\n' +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    policyBullets.join('\n') + '\n' +
    divider + '\n\n' +
    'If you had a valid reason for this lateness (medical, official, or other documented circumstances), please reply to this email within two working days with the supporting details so HR can record it on file. Your line manager is copied on this email and may be consulted as part of the review.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

function earlyLeaveEmailContentTemp({ employee, dateLong, punchOutStr, scheduledEnd, minutesEarly }) {
  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  const subject = 'Early Departure Notice — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  // Personalized clock-out times — same logic as the live version.
  const endStr12h    = fmtTime12h(scheduledEnd);
  const cutoffStr    = addMinutesToTime(scheduledEnd, -15);
  const cutoffStr12h = fmtTime12h(cutoffStr);

  const policyBullets = [
    '\u2022 Your scheduled clock-out time is ' + endStr12h + ' on regular working days.',
    '\u2022 A 15-minute grace period is allowed; departures before ' + cutoffStr12h + ' are recorded as early leave.',
    '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
  ];

  const divider = '='.repeat(71);

  // Body — same shape as the late-arrival temp variant. Action shifts
  // to email reply within the same two-working-day window.
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows your punch-out at ' + punchOutStr + ', ' + minutesEarly + ' minutes before your scheduled ' + endStr12h + ' clock-out time and with no approved permission on file. This is recorded as an early-departure violation.\n\n' +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    policyBullets.join('\n') + '\n' +
    divider + '\n\n' +
    'If you had a valid reason for leaving early (medical, official, or other documented circumstances), please reply to this email within two working days with the supporting details so HR can record it on file. Your line manager is copied on this email and may be consulted as part of the review.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

function missedPunchEmailContentTemp(args) {
  // The live missed-punch email already routes through line-manager
  // confirmation (no portal mention), so the temp variant is a thin
  // pass-through. Kept as a named function for UI plumbing symmetry —
  // every kind ('late', 'early', 'missed') has both a live and a temp
  // content function, so the dispatch logic doesn't need a special
  // case for missed punches.
  return missedPunchEmailContent(args);
}

// Build a mailto: URL with the proper TO + CC + subject + body.
function buildMailto({ to, cc, subject, body }) {
  // We use encodeURIComponent (not URLSearchParams) because URLSearchParams encodes
  // spaces as '+' which several mail clients leave literally as '+' instead of
  // decoding back to a space. encodeURIComponent uses '%20' for spaces, which
  // every mail client decodes correctly.
  //
  // CC is joined with ';' (semicolon), not ',' (comma). The mailto: spec
  // (RFC 6068) technically uses comma, but Outlook on Windows treats a
  // comma-separated CC list as a SINGLE address with embedded commas — the
  // recipients become invalid and have to be re-typed. Semicolon is what
  // Outlook actually parses correctly, and other clients (Apple Mail,
  // Gmail web, Outlook for Mac) accept both. Per Bashaier's observation
  // when the CC field showed a single rejected address — fix is to use
  // ';' here. Same separator used in the To field would also help if we
  // ever added multiple To-addresses, but for now To is always one
  // address.
  const parts = [];
  const ccStr = (cc || []).filter(Boolean).join(';');
  if (ccStr)   parts.push('cc='      + encodeURIComponent(ccStr));
  if (subject) parts.push('subject=' + encodeURIComponent(subject));
  if (body)    parts.push('body='    + encodeURIComponent(body));
  return 'mailto:' + (to || '') + (parts.length ? '?' + parts.join('&') : '');
}

// ────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────────────────
export default function AttendanceView({ me, employees }) {
  // The xlsx ingestion replaces the legacy CSV path entirely. We hold
  // the parsed result rather than the raw text — there's no use case
  // for re-parsing on the fly the way the CSV path was wired.
  const [xlsxFileName, setXlsxFileName] = useState('');
  const [parsedData, setParsedData]     = useState({ rows: [], dataDate: null, sheetName: null });
  const [parseError, setParseError]     = useState(null);

  // File-integrity state. fileSha256 is the SHA-256 of the raw bytes;
  // we use it to dedupe accidental re-uploads of the same file (and
  // to record an audit row in attendance_uploads). fileSize is shown
  // in the summary so Bashaier can sanity-check before processing.
  // existingUpload is the row from attendance_uploads that already
  // exists for this (data_date, file_sha256) pair — when present it
  // means the file was processed before.
  const [fileSha256,     setFileSha256]     = useState('');
  const [fileSize,       setFileSize]       = useState(0);
  const [existingUpload, setExistingUpload] = useState(null);
  const [uploadId,       setUploadId]       = useState(null); // current upload row pk

  // Per-row email confirm modal state. Holds the entry being
  // emailed so the modal can show a TO/CC/SUBJECT preview before
  // the mailto fires.
  // Shape: { entry, kind: 'late'|'early'|'missed', mode: 'live'|'test' }
  // Default mode is 'live'. The Test buttons set mode='test' which
  // routes to the temp email content functions (no portal references).
  const [confirmEntry, setConfirmEntry] = useState(null);

  // Bulk-action session. When Bashaier clicks 'Email all N actionable'
  // on a section header, we stage a queue of entries to email and
  // open a modal that lets her step through them one by one. Mailto:
  // can only fire one email at a time (browser limitation), so the
  // UX is sequential — but the modal stays open and tracks progress.
  // bulkSession shape: { kind: 'late'|'early'|'missed', queue: entry[],
  //                      sentIds: Set<string>, mode: 'live'|'test' }
  // The mode field defaults to 'live' (production wording) but Bashaier
  // can flip to 'test' inside the bulk modal during the pre-launch
  // period — same as the per-row Test button, but applied across the
  // whole queue. Mirrors the per-row mode toggle so a bulk session and
  // a per-row click never produce divergent wording for the same kind.
  const [bulkSession, setBulkSession] = useState(null);

  // Tile drill-down state — which kind's panel is currently expanded
  // inside the FileSummary card. Lifted from FileSummary so the
  // action panels (built below) can be constructed alongside the
  // email handlers and shared state, then passed down. Resets to
  // null whenever a new file is loaded so the next session starts
  // clean.
  const [drillKind, setDrillKind] = useState(null);

  // View mode is no longer needed — the 2-day workflow runs both
  // morning (today's late + missed-in) and end-of-day (yesterday's
  // early + missed-out) checks simultaneously off a single upload.
  // The previous viewMode + viewModeOverride state was retired when
  // the workflow shifted; one upload now covers both passes.

  const [approvedLeaves, setApprovedLeaves]       = useState([]);
  const [approvedPermissions, setApprovedPerms]   = useState([]); // for the data date
  const [acceptedShifts, setAcceptedShifts]       = useState([]);
  const [sentMarkers, setSentMarkers]             = useState({}); // key: row.id → true
  const [loggedMarkers, setLoggedMarkers]         = useState({}); // key: 'empId:type' → true
  // Pending-EOD-review tracker. Populated from attendance_review_log on
  // mount and after each file-load mode-log. Each entry: { review_date,
  // morning_at, eod_at }. eod_at is null by definition for everything
  // surfaced here (it's the "you started but didn't finish" list).
  const [pendingEodDates, setPendingEodDates] = useState([]);
  // Bumps after every successful review-log upsert so the pending-fetch
  // effect re-runs and clears any date Bashaier just completed.
  const [reviewLogTick, setReviewLogTick]     = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  // The xlsx parser yields rows with { psn, name, date, firstPunch,
  // lastPunch, uniquePunches, midDayPunches, ... }. The downstream
  // detection logic in this file (carried over from the CSV era)
  // expects rows keyed by the spreadsheet header names: 'Employee ID',
  // 'First Name', 'Date', 'First Punch', 'Last Punch'. We adapt the
  // shape here once at ingestion time so detection stays untouched —
  // less risk of regressing the shift-override and weekend handling
  // that already work.
  // ── Two-day data window ──────────────────────────────────────────────
  // The new daily workflow asks Bashaier to download a TWO-DAY export
  // (yesterday + today) so a single upload covers both passes:
  //
  //   Today's data      → late arrivals + missed punch-in
  //   Yesterday's data  → early departures + missed punch-out
  //
  // ENFORCEMENT (per Nadeem): the file MUST contain rows for BOTH
  // today and yesterday's working day. A file with only today, only
  // yesterday, or with the wrong dates entirely is rejected with a
  // clear blocking banner. The expected dates come from the real-
  // world clock (todayInLocal) — NOT from the file — so a file
  // dated last week can't sneak through by claiming to be today.
  //
  // Weekend exception: when today is a KSA weekend (Fri/Sat), no
  // review is expected at all. The first working day after a weekend
  // (Sunday) computes yesterday=Thursday automatically via
  // previousWorkingDay, so Sunday's standard import naturally spans
  // Thu→Sun.
  const expectedToday = useMemo(() => todayInLocal(), []);
  const expectedYesterday = useMemo(() => previousWorkingDay(expectedToday), [expectedToday]);
  const todayIsWeekend = useMemo(() => isKsaWeekend(expectedToday), [expectedToday]);

  // csvDate / yesterdayDate are driven by the real clock so the
  // detection runs against the correct dates regardless of how the
  // file's rows are ordered. (The xlsx parser previously took the
  // first row's date as `dataDate`; that's brittle when the export
  // happens to put yesterday's rows before today's.)
  const csvDate       = expectedToday;
  const yesterdayDate = expectedYesterday;
  const csvIsWeekend  = todayIsWeekend;

  // Window-mismatch validation. Returns null when the file matches
  // the strict today+yesterday requirement; otherwise returns an
  // object describing what's missing so the UI can render a clear
  // blocking banner. Skips on weekend (no review expected) and on
  // empty file (already handled by parseError).
  const windowMismatch = useMemo(() => {
    if (!parsedData.rows || parsedData.rows.length === 0) return null;
    if (todayIsWeekend) return null;
    const datesInFile = new Set((parsedData.rows || []).map(r => r.date).filter(Boolean));
    const hasExpectedToday     = datesInFile.has(expectedToday);
    const hasExpectedYesterday = datesInFile.has(expectedYesterday);
    if (hasExpectedToday && hasExpectedYesterday) return null;
    return {
      expectedToday,
      expectedYesterday,
      datesInFile: [...datesInFile].sort(),
      hasExpectedToday,
      hasExpectedYesterday,
    };
  }, [parsedData.rows, expectedToday, expectedYesterday, todayIsWeekend]);

  // Shape parsed rows for the detection logic, AND filter to today + yesterday.
  // The xlsx export sometimes contains rows for dates outside the
  // 2-day window (legacy single-day flow used to land here too;
  // multi-day exports occasionally include a small lookback). Anything
  // outside today + yesterday is dropped, with the count surfaced via
  // parsed.offDateCount so a small inline warning can appear in the
  // file summary.
  //
  // SPECIAL CASE — weekend rows. When today is the first working day
  // after a weekend (typically Sunday), yesterdayDate is the previous
  // working day (Thursday for KSA). The natural date range Bashaier
  // downloads is then Thu→Sun, which means Fri+Sat rows are inside
  // the window but on weekend dates. We don't want them in
  // parsed.rows (would trigger spurious late/early/missed checks)
  // but we DO want to keep them for the separate weekend report
  // that goes to Mr John. So they're collected into parsed.weekendRows
  // — a parallel bucket with the same shape, dispatched into
  // detection.weekend by the detection useMemo below.
  const parsed = useMemo(() => {
    const allRows = parsedData.rows || [];
    const inWorkingWindow = (r) =>
      (r.date === csvDate || r.date === yesterdayDate) && !isKsaWeekend(r.date);
    // Weekend rows are now decoupled from the daily window — any
    // Fri/Sat in the uploaded file qualifies. This supports the
    // catch-up case (Bashaier absent Sunday joins Monday and exports
    // a wider Thu→Mon range to recover the missed weekend report)
    // and the retroactive case (sending a weekend report for a
    // historical weekend a week or two later). The daily flow's
    // today+yesterday requirement is unaffected — it still enforces
    // working-day coverage. The weekend tile picks up whatever
    // Fri/Sat rows are present, regardless of where they sit
    // relative to today/yesterday.
    const isWeekendRow = (r) => isKsaWeekend(r.date);
    const onWindow      = (csvDate || yesterdayDate) ? allRows.filter(inWorkingWindow) : allRows;
    const weekendInRange = allRows.filter(isWeekendRow);
    const offDateCount = allRows.length - onWindow.length - weekendInRange.length;
    const shape = (r) => ({
      'Employee ID': r.psn,
      'First Name':  r.name,
      'Date':        r.date,
      'First Punch': r.firstPunch ? r.firstPunch.slice(0, 5) : '', // HH:MM
      'Last Punch':  r.lastPunch  ? r.lastPunch.slice(0, 5)  : '',
      // Carry the whole parsed entry so cross-reference can read
      // uniqueCount / midDayPunches / rawPunches without re-parsing.
      _tc: r,
    });
    const rows         = onWindow.map(shape);
    const weekendRows  = weekendInRange.map(shape);
    // Convenience flags so render can hide sections when the file
    // doesn't actually contain that day's data.
    const hasTodayData     = rows.some(r => r['Date'] === csvDate);
    const hasYesterdayData = !!yesterdayDate && rows.some(r => r['Date'] === yesterdayDate);
    return {
      headers: ['Employee ID','First Name','Date','First Punch','Last Punch'],
      rows, weekendRows, offDateCount, hasTodayData, hasYesterdayData,
    };
  }, [parsedData, csvDate, yesterdayDate]);

  // Fetch approved leaves overlapping the 2-day window.
  useEffect(() => {
    if (!csvDate) { setApprovedLeaves([]); return; }
    let cancelled = false;
    const windowStart = yesterdayDate || csvDate;
    (async () => {
      try {
        const data = await directGet(
          'leave_requests?select=employee_id,start_date,end_date,status&status=eq.approved&start_date=lte.' + csvDate + '&end_date=gte.' + windowStart
        );
        if (!cancelled) setApprovedLeaves(data || []);
      } catch (e) {
        console.warn('Could not fetch approved leaves:', e);
        if (!cancelled) setApprovedLeaves([]);
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate, yesterdayDate]);

  // Fetch approved permission_requests for the data date so the
  // detection step can split late/early into WITH-permission vs
  // WITHOUT-permission. Bashaier wants the actionable signal — only
  // rows without coverage need a follow-up email.
  // Schema-wise: permission_requests has stage='approved' for fully
  // signed-off rows. Older rows may set status='approved' as well, so
  // we fetch on stage but the cross-ref function below tolerates either.
  useEffect(() => {
    if (!csvDate) { setApprovedPerms([]); return; }
    let cancelled = false;
    (async () => {
      try {
        // Two-day window: pull permissions for both today and yesterday
        // so the detection cross-ref works against both day's rows.
        const dates = [csvDate, yesterdayDate].filter(Boolean);
        const inList = '(' + dates.map(d => '"' + d + '"').join(',') + ')';
        const data = await directGet(
          'permission_requests?select=id,employee_id,permission_date,type,time_from,time_to,hours,reason,stage,status'
          + '&permission_date=in.' + inList
          + '&stage=eq.approved'
        );
        if (!cancelled) setApprovedPerms(data || []);
      } catch (e) {
        console.warn('Could not fetch approved permissions:', e);
        if (!cancelled) setApprovedPerms([]);
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate, yesterdayDate]);

  // P4: fetch employee_shifts the staff have accepted for the CSV's date.
  // These take precedence over the default 08:00–17:00 / SUP 08:00–16:00.
  // Only status='accepted' rows are honoured — pending/declined fall back
  // to the defaults so an unconfirmed manager schedule never affects HR.
  useEffect(() => {
    if (!csvDate) { setAcceptedShifts([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await directGet(
          'employee_shifts?select=employee_id,start_time,end_time,status&status=eq.accepted&shift_date=eq.' + csvDate
        );
        if (!cancelled) setAcceptedShifts(data || []);
      } catch (e) {
        console.warn('Could not fetch accepted shifts:', e);
        if (!cancelled) setAcceptedShifts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate]);

  // P5: pre-load already-logged violations for the data date so revisiting
  // the same file shows the rows that have already been emailed.
  // The map's value is the `email_sent_at` timestamp string (or true if
  // unknown) — used by the button's idempotency UX so already-emailed
  // rows show 'Emailed [date]' instead of the active button.
  useEffect(() => {
    if (!csvDate) { setLoggedMarkers({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'attendance_violations?select=employee_id,violation_type,email_sent_at&violation_date=eq.' + csvDate
          + '&cleared_at=is.null'
        );
        if (cancelled) return;
        const next = {};
        (rows || []).forEach(r => {
          if (r.employee_id && r.violation_type) {
            // Truthy — the timestamp if available, otherwise just true.
            next[r.employee_id + ':' + r.violation_type] = r.email_sent_at || true;
          }
        });
        setLoggedMarkers(next);
      } catch (e) {
        if (!cancelled) setLoggedMarkers({});
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate]);

  // Repeat-offender lookup. Counts each employee's violations in the
  // current calendar month so the row can flag people with 3+ events.
  // Visible as a red 'REPEAT × N' badge inline. Ties into the existing
  // monthly evaluation deduction flow (which kicks in at 5).
  // We use the data date's month so re-processing an old file shows
  // the right context for that month, not today's month.
  const [monthlyCounts, setMonthlyCounts] = useState({}); // key: empId → count
  useEffect(() => {
    if (!csvDate) { setMonthlyCounts({}); return; }
    let cancelled = false;
    (async () => {
      try {
        // Bound by the calendar month containing csvDate.
        const d = new Date(csvDate);
        const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
        const monthEnd   = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
        const rows = await directGet(
          'attendance_violations?select=employee_id,violation_type,violation_date'
          + '&violation_date=gte.' + monthStart
          + '&violation_date=lte.' + monthEnd
          + '&cleared_at=is.null'
        );
        if (cancelled) return;
        // Count distinct (employee, date) so a single day with both
        // a late + early flag for the same person counts as 1 incident.
        const seen = new Set();
        const counts = {};
        (rows || []).forEach(r => {
          if (!r.employee_id || !r.violation_date) return;
          const k = r.employee_id + '|' + r.violation_date;
          if (seen.has(k)) return;
          seen.add(k);
          counts[r.employee_id] = (counts[r.employee_id] || 0) + 1;
        });
        setMonthlyCounts(counts);
      } catch (e) {
        if (!cancelled) setMonthlyCounts({});
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate]);

  // Date-aware leave check. The 2-day file flow needs to evaluate
  // leave coverage independently for today's rows vs yesterday's rows,
  // so the date is part of the lookup. Returns true when the
  // employee has an approved leave whose [start,end] range straddles
  // the given date.
  const onLeaveOnDate = useCallback((empId, dateStr) => {
    if (!dateStr) return false;
    return approvedLeaves.some(l =>
      String(l.employee_id) === String(empId)
      && l.start_date <= dateStr
      && l.end_date   >= dateStr
    );
  }, [approvedLeaves]);

  // P4: fast lookup of accepted-shift override for the current csvDate, keyed
  // by employee_id (uppercased). Stored as { startStr, endStr } — the time
  // strings are normalised to 'HH:MM' (Postgres returns 'HH:MM:SS').
  const shiftOverrideById = useMemo(() => {
    const m = {};
    (acceptedShifts || []).forEach(s => {
      if (!s?.employee_id || !s?.start_time || !s?.end_time) return;
      m[String(s.employee_id).toUpperCase()] = {
        startStr: String(s.start_time).slice(0, 5),
        endStr:   String(s.end_time).slice(0, 5),
      };
    });
    return m;
  }, [acceptedShifts]);

  // Build employee lookup by ID (PSN) and name
  // Build employee lookup. Three indices, each robust to a different
  // failure mode in the data:
  //   • empById: exact-string match on id/psn (preserved for backward
  //     compat — fastest, catches the well-formed cases)
  //   • empByDigits: digits-only canonical key (strips H prefix, leading
  //     zeros, any non-digit). The Time Card xlsx omits the H prefix
  //     and may also omit leading zeros — e.g. file shows '4458' for
  //     Badria whose directory id is 'H04458' (or sometimes 'H4458').
  //     Digits-only matching collapses both to '4458' and matches.
  // Detection below tries empById first (preserves the strict path),
  // then falls back to empByDigits which always wins when the digit
  // sequences agree.
  const psnDigits = (s) => {
    const digits = String(s || '').replace(/[^0-9]/g, '');
    // Strip leading zeros so '04458' and '4458' compare equal.
    return digits.replace(/^0+/, '') || '0';
  };
  const empById = useMemo(() => {
    const m = {};
    (employees || []).forEach(e => {
      if (e.id) m[String(e.id).toUpperCase()] = e;
      if (e.psn) m[String(e.psn).toUpperCase()] = e;
    });
    return m;
  }, [employees]);
  const empByDigits = useMemo(() => {
    const m = {};
    (employees || []).forEach(e => {
      const k = psnDigits(e.id || e.psn);
      if (k) m[k] = e;
    });
    return m;
  }, [employees]);

  // Manager email lookup — given an employee, return their direct manager's email
  const getManagerEmail = useCallback((emp) => {
    if (!emp || !emp.manager_id) return null;
    const mgr = empById[String(emp.manager_id).toUpperCase()];
    return mgr?.email || null;
  }, [empById]);

  // Index approved permissions by employee+type for O(1) lookup during
  // detection. The cross-reference layer turns a late/early flag into
  // one of three outcomes:
  //   • permitted, within window     → covered, audit only
  //   • permitted, beyond window     → still actionable, but with context
  //   • no permission on file        → actionable, the actual violation
  // Bashaier asked for this split so the email-action queue surfaces
  // only true violations and the rest serve as a record.
  const permIndex = useMemo(() => {
    const m = new Map();
    (approvedPermissions || []).forEach(p => {
      if (!p?.employee_id || !p?.type || !p?.permission_date) return;
      // Key includes the date so a 2-day file can cross-ref permissions
      // independently for today vs yesterday. Same employee can have a
      // permission on one day and not the other.
      const key = String(p.employee_id).toUpperCase() + '|' + p.type + '|' + p.permission_date;
      // If multiple, keep the widest window (defensive — should be 1).
      const prev = m.get(key);
      const span = (a) => {
        const f = timeToMinutes(String(a.time_from || '').slice(0,5));
        const t = timeToMinutes(String(a.time_to   || '').slice(0,5));
        return Math.max(0, (t || 0) - (f || 0));
      };
      if (!prev || span(p) > span(prev)) m.set(key, p);
    });
    return m;
  }, [approvedPermissions]);

  // Run detection — TWO-DAY FLOW
  //
  // Each row carries its own date. We evaluate it differently based on
  // whether it's TODAY's data (csvDate) or YESTERDAY's data (yesterdayDate):
  //
  //   TODAY's rows      → check Late arrival + Missed punch-in
  //                       (early-departure + missed-out checks would be
  //                       false positives — staff are still working)
  //
  //   YESTERDAY's rows  → check Early departure + Missed punch-out
  //                       (late-arrival check is skipped — already done
  //                       on yesterday's morning import)
  //
  // Buckets: late + missedIn live on TODAY; early + missedOut live on
  // YESTERDAY. on-time, on-leave, unknown all combine across both days.
  const detection = useMemo(() => {
    const out = {
      late: [], missedIn: [],
      early: [], missedOut: [],
      onTime: [], onLeave: [], unknownEmp: [],
      weekend: [],
    };
    if (!parsed.rows.length && !(parsed.weekendRows || []).length) return out;

    parsed.rows.forEach((row, idx) => {
      const rowDate = row['Date'];
      const isToday     = !!csvDate       && rowDate === csvDate;
      const isYesterday = !!yesterdayDate && rowDate === yesterdayDate;
      if (!isToday && !isYesterday) return; // guarded already by parsed filter, defensive

      // Skip the entire day if it's a KSA weekend.
      if (isKsaWeekend(rowDate)) return;

      const empIdRaw = row['Employee ID'] || row['employee_id'] || row['EmployeeID'] || row['ID'] || '';
      const empId = String(empIdRaw).trim();
      const lookupKey = empId.toUpperCase().startsWith('H') ? empId.toUpperCase() : ('H' + empId).toUpperCase();
      const emp = empById[empId.toUpperCase()]
               || empById[lookupKey]
               || empByDigits[psnDigits(empId)]
               || null;
      if (!emp) {
        out.unknownEmp.push({ id: 'row-' + idx, row, empId, csvName: row['First Name'] || '', dateLabel: rowDate });
        return;
      }
      // Skip if on approved leave for THAT specific date.
      if (onLeaveOnDate(emp.id, rowDate)) {
        // De-dup across days: if an employee is on leave both today AND
        // yesterday, only show once. The shared bucket holds one entry
        // per employee regardless of date.
        if (!out.onLeave.some(x => x.employee?.id === emp.id)) {
          out.onLeave.push({ id: 'row-' + idx, employee: emp });
        }
        return;
      }
      const empKey = String(emp.id || '').toUpperCase();
      const override = shiftOverrideById[empKey];
      const sched = override
        ? {
            startStr: override.startStr,
            endStr:   override.endStr,
            lateCutoffStr:  addMinutesToTime(override.startStr,  +15),
            earlyCutoffStr: addMinutesToTime(override.endStr,    -15),
            label: 'Custom shift (' + override.startStr + '–' + override.endStr + ')',
            isCustom: true,
          }
        : scheduleFor(emp);
      const lateCutoffMin   = timeToMinutes(sched.lateCutoffStr);
      const earlyCutoffMin  = timeToMinutes(sched.earlyCutoffStr);
      const scheduledEndMin = timeToMinutes(sched.endStr);
      const punchInStr  = (row['First Punch'] || '').trim();
      const punchOutStr = (row['Last Punch']  || '').trim();
      const punchInMin  = timeToMinutes(punchInStr);
      const punchOutMin = timeToMinutes(punchOutStr);

      // ── TODAY's rows: Late arrival + Missed punch-in ─────────────────
      if (isToday) {
        // Missed punch-in: no first punch on file. Treat as the bigger
        // problem and skip the late check (we don't know when they
        // arrived). Includes "both missing" (probably absent).
        if (!punchInMin) {
          out.missedIn.push({
            id: 'row-' + idx, employee: emp, row,
            missingType: !punchOutMin ? 'both' : 'in',
            punchInStr, punchOutStr,
            scheduledStart: sched.startStr,
            scheduledEnd: sched.endStr,
            lateCutoff: sched.lateCutoffStr,
            scheduleLabel: sched.label,
            isCustomShift: !!sched.isCustom,
            dateLabel: rowDate,
          });
          return;
        }
        // Late check: punched in but past the grace cutoff.
        if (punchInMin > lateCutoffMin) {
          const permKey = String(emp.id).toUpperCase() + '|late_arrival|' + rowDate;
          const perm = permIndex.get(permKey) || null;
          let permStatus = 'LATE_NO_PERMISSION';
          let minutesBeyond = null;
          if (perm) {
            const permEndMin = timeToMinutes(String(perm.time_to || '').slice(0, 5));
            if (Number.isFinite(permEndMin) && punchInMin > permEndMin) {
              permStatus = 'LATE_BEYOND';
              minutesBeyond = punchInMin - permEndMin;
            } else {
              permStatus = 'LATE_PERMITTED';
            }
          }
          out.late.push({
            id: 'row-' + idx, employee: emp, row,
            punchInStr, punchInMin,
            minutesLate: punchInMin - lateCutoffMin,
            scheduledStart: sched.startStr,
            scheduledEnd: sched.endStr,
            lateCutoff: sched.lateCutoffStr,
            scheduleLabel: sched.label,
            isCustomShift: !!sched.isCustom,
            permission: perm, permStatus, minutesBeyond,
            dateLabel: rowDate,
          });
          return;
        }
        // On-time: arrived within grace window. We don't know about
        // their departure yet (they're still working) — that's
        // tomorrow's yesterday-pass job.
        out.onTime.push({ id: 'row-' + idx, employee: emp, punchInStr, punchOutStr, dateLabel: rowDate });
        return;
      }

      // ── YESTERDAY's rows: Early departure + Missed punch-out ─────────
      if (isYesterday) {
        // Missed punch-out: had a punch-in but no punch-out by EOD.
        // Could be a real missed punch (forgot to clock out) or rare
        // device sync issue. Either way, actionable.
        if (!punchOutMin) {
          out.missedOut.push({
            id: 'row-' + idx, employee: emp, row,
            missingType: !punchInMin ? 'both' : 'out',
            punchInStr, punchOutStr,
            scheduledStart: sched.startStr,
            scheduledEnd: sched.endStr,
            lateCutoff: sched.lateCutoffStr,
            scheduleLabel: sched.label,
            isCustomShift: !!sched.isCustom,
            dateLabel: rowDate,
          });
          return;
        }
        // Early-leave check: punched out before the early cutoff.
        if (punchOutMin < earlyCutoffMin) {
          const permKey = String(emp.id).toUpperCase() + '|early_leave|' + rowDate;
          const perm = permIndex.get(permKey) || null;
          let permStatus = 'EARLY_NO_PERMISSION';
          let minutesBeyond = null;
          if (perm) {
            const permStartMin = timeToMinutes(String(perm.time_from || '').slice(0, 5));
            if (Number.isFinite(permStartMin) && punchOutMin < permStartMin) {
              permStatus = 'EARLY_BEYOND';
              minutesBeyond = permStartMin - punchOutMin;
            } else {
              permStatus = 'EARLY_PERMITTED';
            }
          }
          out.early.push({
            id: 'row-' + idx, employee: emp, row,
            punchOutStr, punchOutMin,
            scheduledStart: sched.startStr,
            scheduledEnd: sched.endStr,
            lateCutoff: sched.lateCutoffStr,
            earlyCutoff: sched.earlyCutoffStr,
            scheduleLabel: sched.label,
            isCustomShift: !!sched.isCustom,
            minutesEarly: scheduledEndMin - punchOutMin,
            isSup: isSupTeam(emp),
            permission: perm, permStatus, minutesBeyond,
            dateLabel: rowDate,
          });
          return;
        }
        // No yesterday violation — staff worked a full day. We don't
        // add them to onTime here because that bucket is reserved for
        // today's arrival (yesterday's on-time was already counted
        // yesterday's morning import).
      }
    });

    // ── Weekend attendance ──────────────────────────────────────────
    // Per Nadeem: a separate report goes to Mr John each week showing
    // which staff worked on the weekend (Fri/Sat in KSA), how many
    // hours they put in, and which department + location they're in.
    // We collect these from parsed.weekendRows (any Fri/Sat rows in
    // the uploaded file — not bound to the daily today/yesterday
    // window, so wider exports can recover missed or older weekends).
    // Rows without any punch are skipped: nobody we'd want to flag,
    // since they didn't actually come in.
    //
    // Each entry carries a `weekendKey` = the Friday's date for that
    // weekend. Saturday entries derive the key by walking back one
    // day. Used downstream to group entries by weekend so the panel
    // can show a date selector when the file contains multiple
    // weekends.
    (parsed.weekendRows || []).forEach((row, idx) => {
      const empIdRaw = row['Employee ID'] || '';
      const empId = String(empIdRaw).trim();
      const lookupKey = empId.toUpperCase().startsWith('H') ? empId.toUpperCase() : ('H' + empId).toUpperCase();
      const emp = empById[empId.toUpperCase()]
               || empById[lookupKey]
               || empByDigits[psnDigits(empId)]
               || null;
      if (!emp) return; // skip — already surfaced via the working-day
                        // unknownEmp bucket if they're missing entirely;
                        // weekend mismatch alone shouldn't flag a new one
      const punchInStr  = (row['First Punch'] || '').trim();
      const punchOutStr = (row['Last Punch']  || '').trim();
      const punchInMin  = timeToMinutes(punchInStr);
      const punchOutMin = timeToMinutes(punchOutStr);
      if (!punchInMin) return; // didn't actually come in
      // Hours worked. If only one punch is on file (forgot to clock
      // out at the end of a weekend shift), surface as null hours
      // rather than guessing — Bashaier can flag it manually.
      const hoursDecimal = punchOutMin && punchOutMin > punchInMin
        ? (punchOutMin - punchInMin) / 60
        : null;
      // Weekend key: the Friday date for this Fri/Sat. Walk back one
      // day from a Saturday; pass through a Friday unchanged. Used
      // to bucket entries by weekend in the panel selector.
      const [yy, mm, dd] = row['Date'].split('-').map(Number);
      const dt = new Date(yy, mm - 1, dd);
      if (dt.getDay() === 6) dt.setDate(dt.getDate() - 1); // Sat → back to Fri
      const wkKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
      out.weekend.push({
        id: 'weekend-' + idx,
        employee: emp,
        dateLabel: row['Date'],
        weekendKey: wkKey,
        punchInStr,
        punchOutStr: punchOutStr || null,
        punchInMin,
        punchOutMin: punchOutMin || null,
        hoursDecimal,
        department: emp.department || '—',
        location:   emp.location   || '—',
      });
    });

    // Sort every bucket consistently: who came first → who came last.
    // For arrival-keyed buckets (late, missedOut, onTime, weekend),
    // that's punch-in ascending. For departure-keyed (early), it's
    // punch-out ascending (who left first → who left last). For
    // bucket entries that don't carry a time at all (missedIn, onLeave,
    // unknownEmp), fall back to name/PSN alphabetical so the order is
    // still deterministic between renders.
    const byPunchIn  = (a, b) => (a.punchInMin  || 0) - (b.punchInMin  || 0);
    const byPunchOut = (a, b) => (a.punchOutMin || 0) - (b.punchOutMin || 0);
    const byName     = (a, b) =>
      String(a.employee?.name || '').localeCompare(String(b.employee?.name || ''));
    const byPsn      = (a, b) =>
      String(a.empId || a.employee?.id || '').localeCompare(String(b.empId || b.employee?.id || ''));
    out.late.sort(byPunchIn);
    out.early.sort(byPunchOut);
    out.missedOut.sort(byPunchIn);    // they punched in but not out — use the in time
    out.onTime.sort(byPunchIn);
    out.missedIn.sort(byName);        // no punch-in available; use name
    out.onLeave.sort(byName);
    out.unknownEmp.sort(byPsn);
    // weekend already sorted (location → dept → check-in) by the
    // weekendSorted memo downstream — leave the raw out.weekend in
    // file order so the memo's sort owns the canonical order.

    return out;
  }, [parsed.rows, parsed.weekendRows, csvDate, yesterdayDate, empById, empByDigits, onLeaveOnDate, shiftOverrideById, permIndex]);

  // File handling
  const handleFile = useCallback(async (file) => {
    setParseError(null);
    if (!file) return;
    // xlsx-only — the CSV format is no longer supported. Reject with
    // a clear message so the user doesn't end up with a half-parsed
    // file silently producing wrong results.
    if (!/\.xlsx$/i.test(file.name)) {
      setParseError(
        'Please upload the .xlsx Time Card export. CSV files are no longer accepted — ' +
        're-export from the fingerprint device as Excel and try again.',
      );
      return;
    }
    try {
      const buf = await file.arrayBuffer();
      // Compute SHA-256 of the raw bytes so duplicate uploads can be
      // detected (same file content for the same data date). Done
      // before parsing so the hash is available even if parsing fails.
      const hashBuf = await crypto.subtle.digest('SHA-256', buf);
      const hashHex = Array.from(new Uint8Array(hashBuf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');

      const result = await parseTimeCardXlsx(buf);
      setParsedData(result);
      setXlsxFileName(file.name);
      setFileSha256(hashHex);
      setFileSize(file.size || buf.byteLength);
      setSentMarkers({});
      setUploadId(null);
      setExistingUpload(null);
      if (!result.dataDate) {
        setParseError('The file parsed but contained no usable rows. Check the export.');
        return;
      }
      // Look up any prior upload of this exact file for this exact
      // review date — if present, surface a banner so Bashaier knows
      // she's looking at processed history, not new work. The review
      // date is the real-world today, which is the value we record
      // in attendance_uploads.data_date for new inserts. Querying on
      // the file's internal first-row date here would create a
      // mismatch with the insert (e.g. a multi-day file with a
      // yesterday-first ordering would dedup against the wrong key).
      const realToday = todayInLocal();
      try {
        const prior = await directGet(
          'attendance_uploads?select=id,uploaded_by,uploaded_at,row_count&'
          + 'data_date=eq.' + realToday
          + '&file_sha256=eq.' + hashHex
        );
        if (prior && prior.length > 0) {
          setExistingUpload(prior[0]);
          setUploadId(prior[0].id);
        }
      } catch (e) {
        // Table may not exist yet (migration not run). Degrade
        // gracefully — the rest of the UI continues to work; only
        // the dedupe banner is suppressed.
        console.warn('[Attendance] attendance_uploads lookup failed (migration may not be applied):', e?.message || e);
      }
    } catch (e) {
      if (e instanceof TimeCardParseError) {
        setParseError(`${e.message}${e.hint ? '  ' + e.hint : ''}`);
      } else {
        console.error('[Attendance] xlsx parse failed:', e);
        setParseError('Could not read the file. Please try re-uploading.');
      }
    }
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const onPick = useCallback((e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  }, [handleFile]);

  const reset = () => {
    setParsedData({ rows: [], dataDate: null, sheetName: null });
    setXlsxFileName('');
    setParseError(null);
    setSentMarkers({});
    setFileSha256('');
    setFileSize(0);
    setExistingUpload(null);
    setUploadId(null);
    setConfirmEntry(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const markSent = (rowId) => setSentMarkers(prev => ({ ...prev, [rowId]: true }));

  // Lazily insert (or reuse) an attendance_uploads row the first time
  // Bashaier acts on the file. We don't write on parse — most uploads
  // are previewed but never acted upon (e.g., she opens to check
  // counts). The first violation log triggers the audit row.
  // Idempotent: subsequent calls re-use the same uploadId for the
  // session. If the table doesn't exist (migration not yet run), we
  // log a warning and continue — violations still get written.
  const ensureUploadRecorded = useCallback(async () => {
    if (uploadId) return uploadId;
    if (!fileSha256 || !csvDate || !xlsxFileName) return null;
    try {
      // The unique (data_date, file_sha256) means a re-upload of the
      // exact same file for the same date returns 23505. We catch
      // that and re-fetch the existing row's id.
      const payload = {
        uploaded_by: me?.id || 'H94830',
        data_date: csvDate,
        sheet_name: parsedData.sheetName || null,
        file_name: xlsxFileName,
        file_size_bytes: fileSize || null,
        file_sha256: fileSha256,
        row_count: parsedData.rows?.length || 0,
      };
      const created = await directPost('attendance_uploads', payload, { timeoutMs: 6000 });
      const id = created?.[0]?.id || null;
      if (id) setUploadId(id);
      return id;
    } catch (e) {
      const msg = String(e?.message || e);
      if (msg.includes('23505') || msg.includes('duplicate key')) {
        // Race or genuine re-upload — fetch the existing row and use it.
        try {
          const prior = await directGet(
            'attendance_uploads?select=id&data_date=eq.' + csvDate + '&file_sha256=eq.' + fileSha256
          );
          const id = prior?.[0]?.id || null;
          if (id) setUploadId(id);
          return id;
        } catch (_) { /* fall through */ }
      }
      // Table missing or permission denied — degrade gracefully.
      console.warn('[Attendance] could not record upload row:', msg);
      return null;
    }
  }, [uploadId, fileSha256, csvDate, xlsxFileName, fileSize, parsedData, me]);

  // Build mailto for a row
  // P5: write a row to attendance_violations whenever Bashaier clicks an
  // email button. Idempotent — the unique constraint on
  // (employee_id, violation_date, violation_type) means a second click on
  // the same row gets a 23505 from Postgres, which we swallow as success.
  // Real schema (verified against live DB): id, employee_id, violation_date,
  // violation_type, minutes_off, punch_in_time, punch_out_time,
  // scheduled_start, scheduled_end, recorded_by, recorded_at, email_sent_at,
  // plus the new upload_id and permission_id columns from
  // migration_attendance_uploads.sql.
  const logViolation = useCallback(async ({ entry, violationType, minutesOff, punchInTime, punchOutTime, scheduledStart, scheduledEnd }) => {
    const empId = entry.employee.id;
    const markerKey = empId + ':' + violationType;
    // Optimistic: mark as logged immediately so the UI flips before the
    // network round trip. If the insert fails for an unexpected reason
    // (not a 23505 dup), we revert below.
    setLoggedMarkers(prev => ({ ...prev, [markerKey]: true }));
    // Make sure the upload row exists before recording the violation —
    // gives us the audit trail. ensureUploadRecorded is idempotent;
    // subsequent violations on the same upload share the upload_id.
    const ensuredUploadId = await ensureUploadRecorded();
    const row = {
      employee_id: empId,
      // Date the violation actually occurred on. With the 2-day flow,
      // late/missedIn entries are dated TODAY but early/missedOut are
      // dated YESTERDAY — entry.dateLabel carries the correct day.
      // Fall back to csvDate for any pre-2-day entry shape.
      violation_date: entry.dateLabel || csvDate,
      violation_type: violationType,           // 'late' | 'early_leave' | 'missed_in' | 'missed_out'
      minutes_off: minutesOff ?? null,
      punch_in_time:  punchInTime  || null,
      punch_out_time: punchOutTime || null,
      scheduled_start: scheduledStart || null,
      scheduled_end:   scheduledEnd   || null,
      recorded_by: me?.id || 'H94830',
      email_sent_at: new Date().toISOString(),
      // New fields. Pin which upload + which permission (if any) was
      // on file at the moment of action. permission_id is null on
      // pure no-permission violations — that's the explicit case.
      upload_id:     ensuredUploadId || null,
      permission_id: entry?.permission?.id || null,
    };
    try {
      await directPost('attendance_violations', row, { timeoutMs: 6000 });
      return { ok: true };
    } catch (e) {
      const msg = String(e?.message || e);
      // 23505 = unique_violation. Means the row already exists for this
      // (employee_id, violation_date, violation_type) — exactly what the
      // unique constraint is for. Treat as success.
      if (msg.includes('23505') || msg.includes('duplicate key')) {
        return { ok: true, alreadyLogged: true };
      }
      // Real error — revert the optimistic marker so the user can retry.
      setLoggedMarkers(prev => {
        const next = { ...prev };
        delete next[markerKey];
        return next;
      });
      console.warn('Could not log attendance violation:', msg);
      return { ok: false, error: msg };
    }
  }, [csvDate, me]);

  // mode: 'live' (production wording, references the ESAU HR Portal)
  //     | 'test' (pre-launch wording, drops portal references and asks
  //               for an email-reply explanation instead)
  // Default is 'live' so any caller that doesn't pass the param gets
  // the production behaviour. The per-row Test buttons explicitly pass
  // mode='test'.
  const handleEmailLate = (entry, mode = 'live') => {
    // Use the entry's own date label so the email correctly says
    // "today" or "yesterday" relative to the event, not the file's
    // primary date. Late entries always come from today, but
    // dateLabel is still the source of truth — defensive.
    const dateLong = formatDateLong(entry.dateLabel || csvDate);
    const contentFn = mode === 'test' ? lateEmailContentTemp : lateEmailContent;
    const { subject, body } = contentFn({
      employee: entry.employee,
      dateLong,
      punchInStr: entry.punchInStr,
      minutesLate: entry.minutesLate, // minutes past the grace window — matches the email body wording
      scheduledStart: entry.scheduledStart,
      lateCutoff: entry.lateCutoff,
    });
    const cc = [getManagerEmail(entry.employee), ...FIXED_CC].filter(Boolean);
    const url = buildMailto({ to: entry.employee.email, cc, subject, body });
    // Both modes log to attendance_violations — the email is real
    // either way, just with different wording. Audit trail stays
    // consistent so re-imports don't flag the same row twice.
    logViolation({
      entry,
      violationType: 'late',
      minutesOff: entry.minutesLate,
      punchInTime: entry.punchInStr,
      scheduledStart: entry.scheduledStart || '08:00',
      scheduledEnd: entry.scheduledEnd,
    });
    window.location.href = url;
  };

  const handleEmailEarly = (entry, mode = 'live') => {
    // Early-departure entries come from YESTERDAY's data in the
    // 2-day workflow. Use entry.dateLabel so the email correctly
    // references the day the staff actually left early on.
    const dateLong = formatDateLong(entry.dateLabel || csvDate);
    const contentFn = mode === 'test' ? earlyLeaveEmailContentTemp : earlyLeaveEmailContent;
    const { subject, body } = contentFn({
      employee: entry.employee,
      dateLong,
      punchOutStr: entry.punchOutStr,
      scheduledEnd: entry.scheduledEnd,
      minutesEarly: entry.minutesEarly,
    });
    const cc = [getManagerEmail(entry.employee), ...FIXED_CC].filter(Boolean);
    const url = buildMailto({ to: entry.employee.email, cc, subject, body });
    logViolation({
      entry,
      violationType: 'early_leave',
      minutesOff: entry.minutesEarly,
      punchOutTime: entry.punchOutStr,
      scheduledStart: entry.scheduledStart || '08:00',
      scheduledEnd: entry.scheduledEnd,
    });
    window.location.href = url;
  };

  const handleEmailMissed = (entry, mode = 'live') => {
    // Missed-punch entries come from EITHER day in the 2-day flow:
    //   • missedIn  → today  (no clock-in by file pull time)
    //   • missedOut → yesterday (no clock-out by EOD)
    // Use entry.dateLabel so the email body references the right date.
    const dateLong = formatDateLong(entry.dateLabel || csvDate);
    const contentFn = mode === 'test' ? missedPunchEmailContentTemp : missedPunchEmailContent;
    const { subject, body } = contentFn({
      employee: entry.employee,
      dateLong,
      missingType: entry.missingType,
    });
    const cc = [getManagerEmail(entry.employee), ...FIXED_CC].filter(Boolean);
    const url = buildMailto({ to: entry.employee.email, cc, subject, body });
    // Translate missingType ('in' | 'out' | 'both') into one or two violation rows.
    const types = entry.missingType === 'both'
      ? ['missed_in', 'missed_out']
      : entry.missingType === 'in' ? ['missed_in'] : ['missed_out'];
    types.forEach((violationType) => {
      logViolation({
        entry,
        violationType,
        minutesOff: null,
        scheduledStart: entry.scheduledStart || '08:00',
        scheduledEnd: entry.scheduledEnd,
      });
    });
    window.location.href = url;
  };

  // ─── Render ────────────────────────────────────────────────────────────
  const hasFile = !!xlsxFileName;

  // Date sanity flags — surface as a banner above the count summary.
  // These detect the most common upload mistakes:
  //   • TODAY  — file is for today's date; staff haven't punched out
  //              yet, so most rows will look INCOMPLETE
  //   • STALE  — file is for a date >7 days old; possibly the wrong file
  //   • FUTURE — file is for a date after today; almost certainly a
  //              wrong export or device clock drift
  const dateSanity = useMemo(() => {
    if (!csvDate) return null;
    const todayIso = new Date().toISOString().slice(0, 10);
    if (csvDate > todayIso) return { kind: 'FUTURE', label: 'Future-dated file' };
    if (csvDate === todayIso) return { kind: 'TODAY', label: 'Today\'s data' };
    const ageMs = new Date(todayIso).getTime() - new Date(csvDate).getTime();
    const ageDays = Math.round(ageMs / 86_400_000);
    if (ageDays > 7) return { kind: 'STALE', label: `${ageDays} days old`, ageDays };
    return null;
  }, [csvDate]);

  // ─── Review-log upsert ───────────────────────────────────────────────
  // Each time a file is loaded (or mode toggles), record the pass into
  // attendance_review_log. The table has one row per review_date; the
  // morning_at / eod_at columns are populated independently. This is
  // what powers the "EOD review pending" banner — we need an explicit
  // marker that morning was done so the absence of an EOD pass is
  // detectable. Best-effort: failures are silent because the violation
  // emails work without this; it's pure tracking. Skips weekends since
  // there's no expectation of a daily attendance review for them.
  useEffect(() => {
    if (!csvDate || !me?.id) return;
    const nowIso = new Date().toISOString();
    // 2-day workflow: a single upload covers BOTH today's morning pass
    // AND yesterday's end-of-day pass. Write both rows so the
    // "pending EOD review" banner clears automatically — Bashaier no
    // longer has to come back the next day to re-import yesterday's
    // file. Each row is independent (one per review_date), so the
    // upsert with on_conflict=review_date is safe to run twice.
    const writes = [];
    if (parsed.hasTodayData && !isKsaWeekend(csvDate)) {
      writes.push({ review_date: csvDate, morning_at: nowIso, morning_by: me.id });
    }
    if (parsed.hasYesterdayData && yesterdayDate && !isKsaWeekend(yesterdayDate)) {
      writes.push({ review_date: yesterdayDate, eod_at: nowIso, eod_by: me.id });
    }
    if (writes.length === 0) return;
    Promise.all(writes.map(row => directPost('attendance_review_log', row, {
      timeoutMs: 5000,
      upsert: true,
      onConflict: 'review_date',
    }))).then(() => setReviewLogTick(t => t + 1))
      .catch(() => { /* non-blocking; tracker is best-effort */ });
  }, [csvDate, yesterdayDate, parsed.hasTodayData, parsed.hasYesterdayData, me?.id]);

  // ─── Pending-EOD fetch ───────────────────────────────────────────────
  // Pull the last 14 calendar days of review log and surface any date
  // where the morning pass was logged but EOD wasn't. 14 days covers
  // ~2 working weeks accounting for weekends — older than that is
  // probably a write-off (the file may not even be available anymore).
  // Refetches whenever reviewLogTick bumps so the banner clears
  // immediately after Bashaier completes a pending date's EOD pass.
  useEffect(() => {
    if (!me?.id) return;
    let cancelled = false;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    directGet(
      'attendance_review_log?select=review_date,morning_at,eod_at'
        + '&review_date=gte.' + cutoffIso
        + '&order=review_date.desc',
      { timeoutMs: 6000 }
    )
      .then(rows => {
        if (cancelled) return;
        const today = new Date().toISOString().slice(0, 10);
        // Pending = morning was logged, EOD wasn't, AND the review_date
        // is at least one calendar day in the past. We deliberately
        // don't flag today's morning pass — it's normal for her to be
        // mid-cycle (morning done, EOD will happen tomorrow).
        const pending = (rows || []).filter(r =>
          r.morning_at != null && r.eod_at == null && r.review_date < today
        );
        setPendingEodDates(pending);
      })
      .catch(() => {
        if (!cancelled) setPendingEodDates([]);
      });
    return () => { cancelled = true; };
  }, [me?.id, reviewLogTick]);

  // Anomaly detection — if a high fraction of rows are INCOMPLETE
  // (only one punch on file), the file was probably exported mid-day
  // before staff punched out. We compute this from the raw parsed
  // rows so it works regardless of which detection bucket they
  // landed in.
  const anomaly = useMemo(() => {
    const rows = parsedData.rows || [];
    if (rows.length === 0) return null;
    const incomplete = rows.filter(r => r.uniqueCount <= 1).length;
    const pct = Math.round((incomplete / rows.length) * 100);
    if (pct >= 50) {
      return {
        kind: 'MOSTLY_INCOMPLETE',
        message: `${incomplete} of ${rows.length} rows (${pct}%) have only one punch on file. ` +
                 `This usually means the file was exported before staff punched out — please re-export at end of day.`,
      };
    }
    return null;
  }, [parsedData.rows]);

  // Sheet-name vs data-date check. The fingerprint device names its
  // export sheet 'YYYYMMDD' (the export date — e.g. '20260502' for a
  // file exported on 2 May 2026). The actual punches are normally for
  // a recent prior day. Two abnormal cases worth flagging:
  //   • Sheet date BEFORE data date — impossible if data is real, so
  //     either the wrong file or the device clock drifted
  //   • Sheet date >7 days AFTER data date — uncommon enough to warn
  //     ('exporting a week-old day's data' is unusual workflow)
  // When the sheet name doesn't parse as YYYYMMDD we just skip the
  // check rather than warning — some export configurations name
  // sheets differently and we shouldn't false-positive on those.
  const sheetSanity = useMemo(() => {
    const name = parsedData.sheetName || '';
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(name);
    if (!m || !csvDate) return null;
    const sheetDate = `${m[1]}-${m[2]}-${m[3]}`;
    if (sheetDate === csvDate) return null;
    const sheetMs = new Date(sheetDate + 'T00:00:00Z').getTime();
    const dataMs  = new Date(csvDate   + 'T00:00:00Z').getTime();
    const diffDays = Math.round((sheetMs - dataMs) / 86_400_000);
    if (diffDays < 0) {
      return {
        kind: 'SHEET_BEFORE_DATA',
        sheetDate,
        message: `The sheet is named '${name}' (decoded ${sheetDate}) but the punches are dated ${csvDate} — the export pre-dates the data. ` +
                 `Likely the wrong file or the device clock has drifted; please verify.`,
      };
    }
    if (diffDays > 7) {
      return {
        kind: 'SHEET_FAR_AFTER',
        sheetDate,
        diffDays,
        message: `The sheet is named '${name}' (decoded ${sheetDate}) but the punches are dated ${csvDate} — that's ${diffDays} days apart. ` +
                 `Make sure this is the file you intended to process.`,
      };
    }
    return null;
  }, [parsedData.sheetName, csvDate]);

  // Read-only / preview mode. By default actions are enabled. When
  // the duplicate-upload banner shows (existingUpload != null) we
  // auto-flip to read-only — the same file was processed before and
  // emails are already on record, so the sensible default is "look,
  // don't touch". Bashaier can manually toggle either way via the
  // Actions toggle in the FileSummary footer. State is in component
  // scope so it persists across renders without lurching.
  const [actionsEnabled, setActionsEnabled] = useState(true);
  useEffect(() => {
    // When a fresh upload comes in, restore the default. If it's a
    // duplicate, switch to read-only. The toggle is always visible
    // so Bashaier can override either default.
    setActionsEnabled(!existingUpload);
  }, [existingUpload, fileSha256]);

  // Reset drill-down whenever a new file is loaded so the next
  // session starts collapsed, instead of inheriting the previous
  // file's expanded panel.
  useEffect(() => {
    setDrillKind(null);
  }, [fileSha256]);

  // ── Per-kind progress (collapsed-tile badge) ─────────────────────────
  // For each actionable kind, count how many of the entries have already
  // had their notice email sent today. "Sent" = either the in-session
  // sentMarkers flag (she just clicked Send) or a logged violation in
  // attendance_violations (DB persistence — survives re-uploads of the
  // same day's file). Permitted-but-actioned cases (LATE_PERMITTED,
  // EARLY_PERMITTED) don't count toward the total because they aren't
  // actionable — they show in-list with an AUDIT ONLY badge instead.
  const isActionable = (e) =>
    e.permStatus !== 'LATE_PERMITTED' && e.permStatus !== 'EARLY_PERMITTED';
  const isSent = (e, violationKey) =>
    !!sentMarkers[e.id] || !!loggedMarkers[e.employee?.id + ':' + violationKey];
  const progressByKind = {
    late:      (() => {
      const a = detection.late.filter(isActionable);
      return { total: a.length, sent: a.filter(e => isSent(e, 'late')).length };
    })(),
    missedIn:  (() => {
      const a = detection.missedIn;
      return { total: a.length, sent: a.filter(e => isSent(e, 'missed_in')).length };
    })(),
    early:     (() => {
      const a = detection.early.filter(isActionable);
      return { total: a.length, sent: a.filter(e => isSent(e, 'early_leave')).length };
    })(),
    missedOut: (() => {
      const a = detection.missedOut;
      return { total: a.length, sent: a.filter(e => isSent(e, 'missed_out')).length };
    })(),
  };

  // ── Per-kind action panels (tile-expansion content) ──────────────────
  // Each FlaggedSection-equivalent for the four actionable kinds.
  // Constructed here so the email handlers, bulk session, sent/logged
  // markers, etc. are all in scope. FileSummary receives this object
  // and renders the matching panel inside the tile expansion area —
  // there are no longer any always-visible action sections below the
  // FileSummary card; everything happens inside the tile.
  const buildLatePanel = () => (
    <FlaggedSection
      title="Late arrivals"
      kicker={'AFTER ' + LATE_CUTOFF + ' · TODAY'}
      iconColor="#BE123C"
      barFrom="#FB7185" barTo="#BE123C"
      empty="Nobody arrived late today — well done team."
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'late', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      entries={detection.late.map(e => {
        const baseDetail = 'Punched in at ' + e.punchInStr + ' — '
          + e.minutesLate + ' min after grace period'
          + (e.isCustomShift ? ' · ' + e.scheduleLabel : '');
        let detail = baseDetail;
        let permBadge = null;
        if (e.permStatus === 'LATE_PERMITTED') {
          detail = baseDetail + ' · Covered by approved permission '
            + (e.permission?.time_from || '').slice(0,5) + '–'
            + (e.permission?.time_to   || '').slice(0,5);
          permBadge = { tone: 'amber', text: 'PERMITTED' };
        } else if (e.permStatus === 'LATE_BEYOND') {
          // "Permitted but still late" — the staff had permission
          // until X but came in even later. Bashaier asked for this
          // case to read clearly: yes there was permission, but it
          // didn't cover the full delay. Badge stays in red so it's
          // visually grouped with the no-permission cases (still
          // actionable), with the wording reflecting the nuance.
          detail = baseDetail + ' · Permitted only until '
            + (e.permission?.time_to || '').slice(0,5)
            + ' — still ' + e.minutesBeyond + ' min late beyond permission';
          permBadge = { tone: 'red', text: 'LATE BEYOND PERMISSION' };
        } else {
          permBadge = { tone: 'red', text: 'NO PERMISSION' };
        }
        return {
          ...e,
          detail,
          permBadge,
          actionable: e.permStatus !== 'LATE_PERMITTED',
          metaIcon: <Clock className="w-4 h-4"/>,
          logged: !!loggedMarkers[e.employee.id + ':late'],
          emailSentAt: typeof loggedMarkers[e.employee.id + ':late'] === 'string'
            ? loggedMarkers[e.employee.id + ':late']
            : null,
          monthlyCount: monthlyCounts[e.employee.id] || 0,
        };
      })}
      renderButton={(entry) => !actionsEnabled ? (
        <span className="text-[10px] tracking-wider font-semibold px-2 py-1 rounded-md"
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E0D5' }}
          title="Read-only mode — toggle 'Actions on' in the file summary above to enable emailing.">
          READ-ONLY
        </span>
      ) : entry.actionable ? (
        <RowButton
          onClick={() => setConfirmEntry({ entry, kind: 'late', mode: 'live' })}
          onClickTest={() => setConfirmEntry({ entry, kind: 'late', mode: 'test' })}
          onMarkSent={() => markSent(entry.id)}
          sent={!!sentMarkers[entry.id]}
          logged={entry.logged}
          emailSentAt={entry.emailSentAt}
          label="Email lateness notice"
        />
      ) : (
        <span className="text-[10px] tracking-wider font-semibold px-2 py-1 rounded-md"
          style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' }}>
          AUDIT ONLY · COVERED
        </span>
      )}
    />
  );
  const buildMissedInPanel = () => (
    <FlaggedSection
      title="Missed punch-in"
      kicker="NO CLOCK-IN ON RECORD · TODAY"
      iconColor="#4338CA"
      barFrom="#818CF8" barTo="#4338CA"
      empty="Every staff member has a punch-in on record for today."
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'missedIn', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      entries={detection.missedIn.map(e => {
        const types = e.missingType === 'both' ? ['missed_in', 'missed_out'] : ['missed_in'];
        const allLogged = types.every(t => loggedMarkers[e.employee.id + ':' + t]);
        const sentTimestamp = types
          .map(t => loggedMarkers[e.employee.id + ':' + t])
          .find(v => typeof v === 'string') || null;
        return ({
          ...e,
          detail: (e.missingType === 'both'
            ? 'No punch-in or punch-out on record — likely absent today'
            : 'No punch-in on record')
            + (e.isCustomShift ? ' · ' + e.scheduleLabel : ''),
          metaIcon: <AlertTriangle className="w-4 h-4"/>,
          logged: allLogged,
          actionable: true,
          emailSentAt: sentTimestamp,
          monthlyCount: monthlyCounts[e.employee.id] || 0,
        });
      })}
      renderButton={(entry) => !actionsEnabled ? (
        <span className="text-[10px] tracking-wider font-semibold px-2 py-1 rounded-md"
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E0D5' }}>
          READ-ONLY
        </span>
      ) : (
        <RowButton
          onClick={() => setConfirmEntry({ entry, kind: 'missedIn', mode: 'live' })}
          onClickTest={() => setConfirmEntry({ entry, kind: 'missedIn', mode: 'test' })}
          onMarkSent={() => markSent(entry.id)}
          sent={!!sentMarkers[entry.id]}
          logged={entry.logged}
          emailSentAt={entry.emailSentAt}
          label="Email missed punch-in notice"
        />
      )}
    />
  );
  const buildEarlyPanel = () => (
    <FlaggedSection
      title="Early departures"
      kicker="LEFT BEFORE GRACE WINDOW · YESTERDAY"
      iconColor="#A16207"
      barFrom="#FACC15" barTo="#A16207"
      empty="Nobody left early yesterday — full day attendance recorded."
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'early', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      entries={detection.early.map(e => {
        const baseDetail = 'Punched out at ' + e.punchOutStr + ' — '
          + e.minutesEarly + ' min before scheduled ' + e.scheduledEnd
          + (e.isCustomShift ? ' · ' + e.scheduleLabel : (e.isSup ? ' (SUP team)' : ''));
        let detail = baseDetail;
        let permBadge = null;
        if (e.permStatus === 'EARLY_PERMITTED') {
          detail = baseDetail + ' · Covered by approved permission '
            + (e.permission?.time_from || '').slice(0,5) + '–'
            + (e.permission?.time_to   || '').slice(0,5);
          permBadge = { tone: 'amber', text: 'PERMITTED' };
        } else if (e.permStatus === 'EARLY_BEYOND') {
          detail = baseDetail + ' · Permitted only from '
            + (e.permission?.time_from || '').slice(0,5)
            + ' — still ' + e.minutesBeyond + ' min early beyond permission';
          permBadge = { tone: 'red', text: 'EARLY BEYOND PERMISSION' };
        } else {
          permBadge = { tone: 'red', text: 'NO PERMISSION' };
        }
        return {
          ...e,
          detail,
          permBadge,
          actionable: e.permStatus !== 'EARLY_PERMITTED',
          metaIcon: <Briefcase className="w-4 h-4"/>,
          logged: !!loggedMarkers[e.employee.id + ':early_leave'],
          emailSentAt: typeof loggedMarkers[e.employee.id + ':early_leave'] === 'string'
            ? loggedMarkers[e.employee.id + ':early_leave']
            : null,
          monthlyCount: monthlyCounts[e.employee.id] || 0,
        };
      })}
      renderButton={(entry) => !actionsEnabled ? (
        <span className="text-[10px] tracking-wider font-semibold px-2 py-1 rounded-md"
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E0D5' }}>
          READ-ONLY
        </span>
      ) : entry.actionable ? (
        <RowButton
          onClick={() => setConfirmEntry({ entry, kind: 'early', mode: 'live' })}
          onClickTest={() => setConfirmEntry({ entry, kind: 'early', mode: 'test' })}
          onMarkSent={() => markSent(entry.id)}
          sent={!!sentMarkers[entry.id]}
          logged={entry.logged}
          emailSentAt={entry.emailSentAt}
          label="Email early-departure notice"
        />
      ) : (
        <span className="text-[10px] tracking-wider font-semibold px-2 py-1 rounded-md"
          style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' }}>
          AUDIT ONLY · COVERED
        </span>
      )}
    />
  );
  const buildMissedOutPanel = () => (
    <FlaggedSection
      title="Missed punch-out"
      kicker="NO CLOCK-OUT ON RECORD · YESTERDAY"
      iconColor="#7E22CE"
      barFrom="#C084FC" barTo="#7E22CE"
      empty="Every staff member has a punch-out on record for yesterday."
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'missedOut', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      entries={detection.missedOut.map(e => {
        const types = e.missingType === 'both' ? ['missed_in', 'missed_out'] : ['missed_out'];
        const allLogged = types.every(t => loggedMarkers[e.employee.id + ':' + t]);
        const sentTimestamp = types
          .map(t => loggedMarkers[e.employee.id + ':' + t])
          .find(v => typeof v === 'string') || null;
        return ({
          ...e,
          detail: (e.missingType === 'both'
            ? 'No punch-in or punch-out on record — likely absent yesterday'
            : 'No punch-out on record (punch-in: ' + (e.punchInStr || '—') + ')')
            + (e.isCustomShift ? ' · ' + e.scheduleLabel : ''),
          metaIcon: <AlertTriangle className="w-4 h-4"/>,
          logged: allLogged,
          actionable: true,
          emailSentAt: sentTimestamp,
          monthlyCount: monthlyCounts[e.employee.id] || 0,
        });
      })}
      renderButton={(entry) => !actionsEnabled ? (
        <span className="text-[10px] tracking-wider font-semibold px-2 py-1 rounded-md"
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E0D5' }}>
          READ-ONLY
        </span>
      ) : (
        <RowButton
          onClick={() => setConfirmEntry({ entry, kind: 'missedOut', mode: 'live' })}
          onClickTest={() => setConfirmEntry({ entry, kind: 'missedOut', mode: 'test' })}
          onMarkSent={() => markSent(entry.id)}
          sent={!!sentMarkers[entry.id]}
          logged={entry.logged}
          emailSentAt={entry.emailSentAt}
          label="Email missed punch-out notice"
        />
      )}
    />
  );
  // ── Weekend attendance report ──────────────────────────────────────
  // Each entry in detection.weekend carries a weekendKey = the Friday
  // date for that Fri/Sat. We expose two memos to drive the panel:
  //
  //   availableWeekends — unique weekend keys present in the file,
  //                       newest first, with friendly labels and
  //                       per-weekend staff counts. Used by the
  //                       date selector when 2+ weekends exist.
  //
  //   weekendSorted     — entries for the currently-selected weekend
  //                       only, sorted location → department →
  //                       check-in time. Drives the panel render
  //                       and feeds the export and email helpers.
  //
  // selectedWeekendKey defaults to the most recent weekend (the
  // first entry in availableWeekends). Resets to null when the
  // file changes (fileSha256 in deps); a follow-up effect snaps it
  // to the most recent weekend once availableWeekends is ready.
  const availableWeekends = useMemo(() => {
    const map = new Map();
    (detection.weekend || []).forEach(e => {
      if (!e.weekendKey) return;
      if (!map.has(e.weekendKey)) {
        map.set(e.weekendKey, { key: e.weekendKey, dates: new Set(), staff: 0 });
      }
      const w = map.get(e.weekendKey);
      w.dates.add(e.dateLabel);
      w.staff += 1;
    });
    // Build saturday date from each Friday key for the friendly label
    return [...map.values()]
      .map(w => {
        const [y, m, d] = w.key.split('-').map(Number);
        const sat = new Date(y, m - 1, d + 1);
        const satKey = `${sat.getFullYear()}-${String(sat.getMonth() + 1).padStart(2, '0')}-${String(sat.getDate()).padStart(2, '0')}`;
        return { ...w, fridayKey: w.key, saturdayKey: satKey };
      })
      .sort((a, b) => (a.key < b.key ? 1 : -1)); // newest first
  }, [detection.weekend]);

  const [selectedWeekendKey, setSelectedWeekendKey] = useState(null);

  // Snap selection to the newest weekend whenever the available
  // set changes (new file uploaded, or file recomputed). If the
  // currently-selected key is still present in the new set we keep
  // it, otherwise we fall through to the most recent weekend.
  useEffect(() => {
    if (!availableWeekends.length) {
      if (selectedWeekendKey !== null) setSelectedWeekendKey(null);
      return;
    }
    const stillPresent = availableWeekends.some(w => w.key === selectedWeekendKey);
    if (!stillPresent) {
      setSelectedWeekendKey(availableWeekends[0].key);
    }
  }, [availableWeekends, selectedWeekendKey]);

  const weekendSorted = useMemo(() => {
    let arr = [...(detection.weekend || [])];
    if (selectedWeekendKey) {
      arr = arr.filter(e => e.weekendKey === selectedWeekendKey);
    }
    arr.sort((a, b) => {
      // Primary: date (Friday before Saturday in the same weekend)
      if (a.dateLabel !== b.dateLabel) return a.dateLabel < b.dateLabel ? -1 : 1;
      // Then: location alphabetical
      const loc = (a.location || '').localeCompare(b.location || '');
      if (loc !== 0) return loc;
      // Then: department alphabetical
      const dept = (a.department || '').localeCompare(b.department || '');
      if (dept !== 0) return dept;
      // Then: punch-in time ascending
      return (a.punchInMin || 0) - (b.punchInMin || 0);
    });
    return arr;
  }, [detection.weekend, selectedWeekendKey]);

  // Report exporter — produces a polished, print-friendly HTML file.
  // Why HTML over PDF: jspdf's default helvetica is Latin-1 only,
  // tables look mechanical, and styling is tedious. HTML gives us a
  // proper design system (real fonts, real CSS, hover states for
  // on-screen viewing), and Bashaier can still print to PDF from
  // her browser if a PDF is needed downstream — Cmd/Ctrl+P → Save
  // as PDF retains the print stylesheet baked into the file.
  //
  // The file is fully self-contained: all CSS inline, no external
  // assets, no fonts to load. She can email the .html as an
  // attachment, open it in any browser, or print it.
  const exportWeekendHtml = useCallback(() => {
    if (!weekendSorted.length) return;

    // Preparer name comes from the logged-in user record. Falls back
    // to "Bashaier Ali" since she's the standing HR reviewer; that
    // matches HR_SIGNATURE elsewhere in the file.
    const preparedBy = me?.name || me?.first_name || 'Bashaier Ali';
    const yDate = formatDateLong(yesterdayDate);
    const tDate = formatDateLong(csvDate);

    // Tiny helper: escape user-provided strings before splicing into
    // the HTML template. We trust the directory data here, but better
    // safe than sorry.
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    // Group + tally per date — same shape as the panel render and
    // the email body so the three views agree on the numbers.
    const byDate = new Map();
    weekendSorted.forEach(e => {
      if (!byDate.has(e.dateLabel)) byDate.set(e.dateLabel, []);
      byDate.get(e.dateLabel).push(e);
    });

    let tablesHtml = '';
    byDate.forEach((rows, date) => {
      const totalHrs = rows.reduce((s, e) => s + (e.hoursDecimal || 0), 0);
      let bodyRows = '';
      let prevLoc = null;
      let locStaff = 0;
      let locHours = 0;
      const flushSubtotal = () => {
        if (prevLoc !== null) {
          bodyRows += `<tr class="subtotal">
            <td colspan="4" class="r">${esc(prevLoc)} subtotal</td>
            <td></td>
            <td class="r">${locStaff} staff</td>
            <td class="r">${locHours.toFixed(2)}</td>
          </tr>`;
        }
      };
      rows.forEach(e => {
        if (e.location !== prevLoc) {
          flushSubtotal();
          prevLoc = e.location;
          locStaff = 0;
          locHours = 0;
        }
        bodyRows += `<tr>
          <td class="loc">${esc(e.location || '-')}</td>
          <td>${esc(e.department || '-')}</td>
          <td class="psn">${esc(e.employee.id || '')}</td>
          <td class="name">${esc(e.employee.name || '')}</td>
          <td class="t">${esc(e.punchInStr || '-')}</td>
          <td class="t">${esc(e.punchOutStr || '-')}</td>
          <td class="r">${e.hoursDecimal != null ? e.hoursDecimal.toFixed(2) : '<span class="muted">-</span>'}</td>
        </tr>`;
        locStaff += 1;
        locHours += (e.hoursDecimal || 0);
      });
      flushSubtotal();
      bodyRows += `<tr class="day-total">
        <td colspan="4" class="r">Day total</td>
        <td></td>
        <td class="r">${rows.length} staff</td>
        <td class="r">${totalHrs.toFixed(2)}</td>
      </tr>`;
      tablesHtml += `<section class="day-section">
        <div class="day-header">
          <h2>${esc(formatDateLong(date))}</h2>
          <div class="day-summary"><strong>${rows.length}</strong> staff &middot; <strong>${totalHrs.toFixed(2)}</strong> hours</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>Department</th>
              <th>PSN</th>
              <th>Name</th>
              <th class="t">Punch In</th>
              <th class="t">Punch Out</th>
              <th class="r">Hours</th>
            </tr>
          </thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </section>`;
    });

    const grandTotalStaff = weekendSorted.length;
    const grandTotalHours = weekendSorted.reduce((s, e) => s + (e.hoursDecimal || 0), 0);

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weekend Attendance Report &mdash; ${esc(yesterdayDate)} to ${esc(csvDate)}</title>
<style>
  :root {
    --green:       #0F4C2A;
    --green-soft:  #E8F5E9;
    --green-mid:   #BBDEC0;
    --cream:       #FAF6EC;
    --beige:       #E5E0D5;
    --ink:         #0A0A0A;
    --ink-mute:    #555555;
    --rule:        #F0EBDD;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #FFFFFF;
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  .page {
    max-width: 1180px;
    margin: 0 auto;
    padding: 40px 36px 56px;
  }
  header.report-header {
    border-bottom: 3px solid var(--green);
    padding-bottom: 18px;
    margin-bottom: 28px;
  }
  .kicker {
    font-size: 11px;
    letter-spacing: 0.28em;
    color: var(--green);
    font-weight: 700;
    text-transform: uppercase;
    margin-bottom: 8px;
  }
  h1.report-title {
    margin: 0;
    font-size: 30px;
    font-weight: 700;
    color: var(--ink);
    letter-spacing: -0.6px;
    line-height: 1.15;
  }
  .meta-row {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px 24px;
    margin-top: 14px;
    font-size: 12px;
    color: var(--ink-mute);
  }
  .meta-row .item strong {
    color: var(--ink);
    font-weight: 600;
  }
  .meta-row .item .label {
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.18em;
    color: var(--ink-mute);
    display: block;
    margin-bottom: 2px;
  }

  .summary-band {
    background: var(--cream);
    border: 1px solid var(--beige);
    border-radius: 10px;
    padding: 14px 18px;
    margin-bottom: 28px;
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px 32px;
  }
  .summary-band .stat .num {
    font-size: 22px;
    font-weight: 700;
    color: var(--green);
    letter-spacing: -0.4px;
  }
  .summary-band .stat .label {
    font-size: 10px;
    letter-spacing: 0.2em;
    color: var(--ink-mute);
    text-transform: uppercase;
    margin-top: 2px;
  }

  .day-section {
    margin-bottom: 32px;
    page-break-inside: avoid;
  }
  .day-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 0 12px;
    border-bottom: 1px solid var(--beige);
    margin-bottom: 0;
  }
  .day-header h2 {
    margin: 0;
    font-size: 16px;
    color: var(--green);
    font-weight: 700;
    letter-spacing: -0.2px;
  }
  .day-summary {
    font-size: 12px;
    color: var(--ink-mute);
  }
  .day-summary strong {
    color: var(--ink);
    font-weight: 600;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 0;
    font-size: 12px;
    table-layout: auto;
  }
  thead th {
    background: var(--green);
    color: #FFFFFF;
    text-align: left;
    padding: 10px 12px;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  tbody td {
    padding: 9px 12px;
    border-top: 1px solid var(--rule);
    white-space: nowrap;
    vertical-align: middle;
  }
  tbody tr:nth-child(even) td { background: var(--cream); }
  td.loc, td.name { font-weight: 600; }
  td.psn { color: var(--ink-mute); font-variant-numeric: tabular-nums; }
  td.t   { text-align: center; font-variant-numeric: tabular-nums; }
  td.r, th.r { text-align: right; font-variant-numeric: tabular-nums; }
  .muted { color: var(--ink-mute); font-style: italic; }

  tr.subtotal td {
    background: var(--green-soft) !important;
    font-weight: 600;
    color: var(--green);
    border-top: 1px solid var(--green-mid);
  }
  tr.day-total td {
    background: var(--green-mid) !important;
    font-weight: 700;
    color: var(--green);
    border-top: 2px solid var(--green);
    border-bottom: 2px solid var(--green);
  }

  footer.report-footer {
    margin-top: 48px;
    padding-top: 16px;
    border-top: 1px solid var(--beige);
    text-align: center;
    color: var(--ink-mute);
    font-size: 11px;
  }
  footer.report-footer strong { color: var(--ink); font-weight: 600; }

  @media print {
    @page { size: A4 landscape; margin: 12mm; }
    body { background: #FFFFFF; }
    .page { padding: 0; max-width: none; }
    .day-section { page-break-inside: avoid; }
    thead { display: table-header-group; }  /* repeat header on each page */
  }
</style>
</head>
<body>
  <div class="page">
    <header class="report-header">
      <div class="kicker">Evergreen Shipping Agency Saudi Co. (LLC)</div>
      <h1 class="report-title">Weekend Attendance Report</h1>
      <div class="meta-row">
        <div class="item">
          <span class="label">Window</span>
          <strong>${esc(yDate)}</strong> to <strong>${esc(tDate)}</strong>
        </div>
        <div class="item">
          <span class="label">Prepared by</span>
          <strong>${esc(preparedBy)}</strong>
        </div>
      </div>
    </header>

    <div class="summary-band">
      <div class="stat">
        <div class="num">${grandTotalStaff}</div>
        <div class="label">Staff who attended</div>
      </div>
      <div class="stat">
        <div class="num">${grandTotalHours.toFixed(2)}</div>
        <div class="label">Total hours worked</div>
      </div>
      <div class="stat">
        <div class="num">${byDate.size}</div>
        <div class="label">Weekend day${byDate.size === 1 ? '' : 's'}</div>
      </div>
    </div>

    ${tablesHtml}

    <footer class="report-footer">
      <strong>ESAU HR</strong> &middot; Evergreen Shipping Agency Saudi Co. (LLC)
    </footer>
  </div>
</body>
</html>`;

    // Trigger download as a file. Self-contained — Bashaier can open
    // it in any browser, view as-is, or use the browser's print
    // dialog (Ctrl/Cmd+P → Save as PDF) if a PDF is needed for
    // attaching to the email.
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Weekend_Attendance_${yesterdayDate}_to_${csvDate}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [weekendSorted, csvDate, yesterdayDate, me]);

  // Email builder — TO Mr John, CC James + DMN SUP team. Body is a
  // brief summary only; the detailed staff list lives in the PDF
  // (which Bashaier attaches before sending). Per Nadeem: don't
  // duplicate the data in the body when the PDF is attached.
  const emailWeekendReport = useCallback(() => {
    if (!weekendSorted.length) return;
    const to = 'johnho@evergreen-shipping.com.sa';
    const cc = [
      'jamesliu@evergreen-shipping.com.sa',
      'badria.alhassan@evergreen-shipping.com.sa',
      'jaffar.aldarweash@evergreen-shipping.com.sa',
      'fahad.alhussain@evergreen-shipping.com.sa',
    ];
    const yDate = formatDateLong(yesterdayDate);
    const tDate = formatDateLong(csvDate);
    const subject = `Weekend Attendance Report — ${yesterdayDate} to ${csvDate}`;

    // Per-day staff count + total hours — high-level summary numbers
    // only, no per-employee rows.
    const byDate = new Map();
    weekendSorted.forEach(e => {
      if (!byDate.has(e.dateLabel)) byDate.set(e.dateLabel, []);
      byDate.get(e.dateLabel).push(e);
    });
    const totalHours = weekendSorted.reduce((s, e) => s + (e.hoursDecimal || 0), 0);

    const lines = [];
    lines.push('Dear Mr John,');
    lines.push('');
    lines.push(`Please find attached the weekend attendance report covering ${yDate} to ${tDate}.`);
    lines.push('');
    lines.push('Summary:');
    byDate.forEach((rows, date) => {
      const hrs = rows.reduce((s, e) => s + (e.hoursDecimal || 0), 0);
      lines.push(`  - ${formatDateLong(date)}: ${rows.length} staff, ${hrs.toFixed(2)} hours`);
    });
    lines.push(`  - Total: ${weekendSorted.length} staff, ${totalHours.toFixed(2)} hours`);
    lines.push('');
    lines.push('The full breakdown by location and department is in the attached report.');
    lines.push('');
    lines.push('Kindly let me know if any clarification is needed.');
    lines.push('');
    lines.push(HR_SIGNATURE);

    const body = lines.join('\n');
    const url = buildMailto({ to, cc, subject, body });
    window.location.href = url;
  }, [weekendSorted, csvDate, yesterdayDate]);

  // Weekend panel — custom layout (not a FlaggedSection). Grouped
  // by weekend date with location/department/check-in sort already
  // applied via weekendSorted. Two action buttons at the top:
  // Export PDF + Email John (plus CC).
  const buildWeekendPanel = () => {
    const byDate = new Map();
    weekendSorted.forEach(e => {
      if (!byDate.has(e.dateLabel)) byDate.set(e.dateLabel, []);
      byDate.get(e.dateLabel).push(e);
    });
    // Friendly weekend label for the chip + active-weekend caption.
    // E.g. "Fri 1 May – Sat 2 May" for Friday=2026-05-01.
    const weekendChipLabel = (w) => {
      const fmt = (yyyymmdd) => {
        const [y, m, d] = yyyymmdd.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      };
      return `${fmt(w.fridayKey)} \u2013 ${fmt(w.saturdayKey)}`;
    };
    const activeWeekend = availableWeekends.find(w => w.key === selectedWeekendKey);
    return (
      <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: '#D4C7AB' }}>
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <div className="text-[10px] mb-1" style={{ color: '#0A0A0A', letterSpacing: '0.25em', fontWeight: 700 }}>
              WEEKEND ATTENDANCE
            </div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#0A0A0A' }}>
              Weekend report for Mr John
            </div>
            <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.75 }}>
              {activeWeekend
                ? <>{weekendChipLabel(activeWeekend)} &middot; {weekendSorted.length} staff attended</>
                : <>{weekendSorted.length} staff attended</>}
              {' '}&middot; sorted by location &rarr; department &rarr; check-in time
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button onClick={exportWeekendHtml}
              disabled={!weekendSorted.length}
              className="text-xs px-3 py-2 rounded-full inline-flex items-center gap-1.5 transition-shadow hover:shadow"
              style={{
                background: weekendSorted.length ? '#0F4C2A' : '#E5E0D5',
                color: weekendSorted.length ? '#FFFFFF' : '#0A0A0A',
                fontWeight: 600,
                cursor: weekendSorted.length ? 'pointer' : 'not-allowed',
              }}
              title="Download a polished HTML report (sorted by location/department/check-in). Open it in a browser to view, print, or save as PDF.">
              <FileText className="w-3.5 h-3.5"/> Export Report
            </button>
            <button onClick={emailWeekendReport}
              disabled={!weekendSorted.length}
              className="text-xs px-3 py-2 rounded-full inline-flex items-center gap-1.5 transition-shadow hover:shadow"
              style={{
                background: weekendSorted.length ? '#FFFFFF' : '#FAF6EC',
                color: weekendSorted.length ? '#0F4C2A' : '#0A0A0A',
                border: '1px solid ' + (weekendSorted.length ? '#0F4C2A' : '#E5E0D5'),
                fontWeight: 600,
                cursor: weekendSorted.length ? 'pointer' : 'not-allowed',
              }}
              title="Open a draft email to Mr John (CC James + DMN SUP team) with the weekend summary in the body. Attach the report (HTML or printed PDF) before sending.">
              <Mail className="w-3.5 h-3.5"/> Email Mr John
            </button>
          </div>
        </div>

        {/* Weekend selector — appears when the file contains 2+
            weekends. Lets Bashaier pick which weekend to view, export,
            and email. Single-weekend files skip the selector entirely
            since there's nothing to choose. */}
        {availableWeekends.length > 1 && (
          <div className="mb-4">
            <div className="text-[10px] mb-1.5" style={{ color: '#0A0A0A', letterSpacing: '0.2em', fontWeight: 700, opacity: 0.7 }}>
              CHOOSE WEEKEND
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {availableWeekends.map(w => {
                const isSel = w.key === selectedWeekendKey;
                return (
                  <button
                    key={w.key}
                    type="button"
                    onClick={() => setSelectedWeekendKey(w.key)}
                    className="px-3 py-1.5 rounded-full text-xs transition-all"
                    style={{
                      border: isSel ? '2px solid #0F4C2A' : '0.5px solid #D4C7AB',
                      background: isSel ? '#0F4C2A' : '#FFFFFF',
                      color: isSel ? '#FFFFFF' : '#0A0A0A',
                      fontWeight: isSel ? 600 : 500,
                      cursor: 'pointer',
                    }}
                    aria-pressed={isSel}
                  >
                    {weekendChipLabel(w)} <span style={{ opacity: 0.75, marginLeft: 4 }}>({w.staff})</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {weekendSorted.length === 0 ? (
          <div className="rounded-xl p-6 text-center text-sm" style={{ background: '#FAF6EC', color: '#0A0A0A', opacity: 0.75 }}>
            No staff attended on this weekend.
          </div>
        ) : (
          <div className="space-y-4">
            {[...byDate.entries()].map(([date, rows]) => (
              <div key={date}>
                <div className="text-[10px] mb-2" style={{ color: '#0A0A0A', letterSpacing: '0.25em', fontWeight: 700 }}>
                  {formatDateLong(date).toUpperCase()} &middot; {rows.length} STAFF
                </div>
                <div className="rounded-lg border overflow-hidden" style={{ borderColor: '#E5E0D5' }}>
                  <table className="w-full text-xs" style={{ color: '#0A0A0A' }}>
                    <thead style={{ background: '#FAF6EC' }}>
                      <tr>
                        <th className="text-left px-3 py-2 font-bold tracking-wider" style={{ fontSize: '10px' }}>LOCATION</th>
                        <th className="text-left px-3 py-2 font-bold tracking-wider" style={{ fontSize: '10px' }}>DEPT</th>
                        <th className="text-left px-3 py-2 font-bold tracking-wider" style={{ fontSize: '10px' }}>PSN</th>
                        <th className="text-left px-3 py-2 font-bold tracking-wider" style={{ fontSize: '10px' }}>NAME</th>
                        <th className="text-center px-3 py-2 font-bold tracking-wider" style={{ fontSize: '10px' }}>IN</th>
                        <th className="text-center px-3 py-2 font-bold tracking-wider" style={{ fontSize: '10px' }}>OUT</th>
                        <th className="text-right px-3 py-2 font-bold tracking-wider" style={{ fontSize: '10px' }}>HOURS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((e, i) => (
                        <tr key={e.id} style={{ background: i % 2 ? '#FFFDF7' : '#FFFFFF', borderTop: '1px solid #F0EBDD' }}>
                          <td className="px-3 py-2" style={{ fontWeight: 600 }}>{e.location}</td>
                          <td className="px-3 py-2">{e.department}</td>
                          <td className="px-3 py-2" style={{ opacity: 0.7 }}>{e.employee.id}</td>
                          <td className="px-3 py-2" style={{ fontWeight: 600 }}>{e.employee.name}</td>
                          <td className="px-3 py-2 text-center">{e.punchInStr}</td>
                          <td className="px-3 py-2 text-center">{e.punchOutStr || <span style={{ color: '#A16207', fontStyle: 'italic' }}>missing</span>}</td>
                          <td className="px-3 py-2 text-right" style={{ fontWeight: 700 }}>
                            {e.hoursDecimal != null ? e.hoursDecimal.toFixed(2) + 'h' : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  // The map FileSummary uses to render the right panel for the
  // currently-expanded tile. Daily panels (late/early/missedIn/
  // missedOut) require a clean today+yesterday window — they're
  // gated on !windowMismatch && !csvIsWeekend. The weekend panel
  // is independent: it can render whenever the file contains any
  // Fri/Sat rows, regardless of whether the daily window matches.
  // This supports the retroactive case where Bashaier uploads a
  // historical export for an older weekend report — the file
  // doesn't satisfy today+yesterday so the daily flow rejects
  // (banner shown elsewhere), but the weekend tile still produces
  // the report.
  const dailyPanelsOk = !windowMismatch && !csvIsWeekend;
  const actionPanels = {
    ...(dailyPanelsOk && parsed.hasTodayData     ? { late:      buildLatePanel() }      : {}),
    ...(dailyPanelsOk && parsed.hasTodayData     ? { missedIn:  buildMissedInPanel() }  : {}),
    ...(dailyPanelsOk && parsed.hasYesterdayData ? { early:     buildEarlyPanel() }     : {}),
    ...(dailyPanelsOk && parsed.hasYesterdayData ? { missedOut: buildMissedOutPanel() } : {}),
    ...(detection.weekend.length ? { weekend: buildWeekendPanel() } : {}),
  };

  return (
    <div className="space-y-6" style={{ fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif' }}>
      {/* Header */}
      <div>
        <div className="text-[10px] mb-2 flex items-center gap-2" style={{ color: '#1F1B16', letterSpacing: '0.3em' }}>
          <span className="inline-block w-7 h-px" style={{ background: '#1F1B16' }}/>ATTENDANCE
        </div>
        <h1 className="leading-none" style={{ fontFamily: 'Georgia, serif', fontSize: 'clamp(2.2rem, 4.5vw, 3rem)', fontWeight: 400, color: '#1F1B16', letterSpacing: '-0.02em' }}>
          Daily attendance check.
        </h1>
        <ul className="text-sm mt-3 max-w-3xl space-y-1.5 list-disc pl-5" style={{ color: '#0A0A0A' }}>
          <li>Every morning, export the <strong>Time Card (.xlsx)</strong> covering <strong>yesterday and today</strong>, then upload it here.</li>
          <li><strong>Today&rsquo;s data</strong> is checked for <strong>late arrivals</strong> and <strong>missed punch-in</strong>.</li>
          <li><strong>Yesterday&rsquo;s data</strong> is checked for <strong>early departures</strong> and <strong>missed punch-out</strong>.</li>
          <li>Approved permissions are cross-referenced automatically &mdash; permitted cases are marked, not actioned.</li>
          <li>Anyone on approved leave for that date is <strong>excluded</strong> from the violation lists.</li>
          <li>Each notice is pre-filled with the right wording &mdash; review it and click <strong>Send</strong> in your mail client.</li>
          <li>If the file covers a weekend (Fri/Sat), a <strong>weekend attendance</strong> tile appears with an option to <strong>export the report</strong> and <strong>email Mr John</strong> (CC James + DMN SUP team). The file can include extra dates beyond today+yesterday &mdash; useful if you missed a Sunday and need to recover the weekend, or want to send a report for an older weekend.</li>
          <li>When the file contains more than one weekend, a <strong>choose weekend</strong> selector appears so you can pick which weekend to view, export, and email.</li>
          <li>On <strong>Sunday</strong>, &ldquo;yesterday&rdquo; means <strong>Thursday</strong> (Fri + Sat are KSA weekend), so the file should span Thursday&rarr;Sunday.</li>
        </ul>
      </div>

      {/* ─── Pending end-of-day review banner ───────────────────────────
          Surfaces dates where the morning pass was completed but the
          end-of-day pass is overdue. Sticky at the top of the page so
          it's the first thing Bashaier sees on load — including before
          she imports today's file. The list comes from
          attendance_review_log; rows here are derived, not editable,
          and clear automatically the moment she imports the missing
          date's complete file (the upsert flips eod_at, the fetch
          re-runs via reviewLogTick, the row drops out of the list). */}
      {/* ── Pending end-of-day reviews banner ─────────────────────────
          Surfaces working days where Bashaier did the morning late
          check but never re-imported the file the next day to catch
          early-leavers and missed punches. Self-clears as soon as
          the EOD pass is logged for each date (the upsert effect
          bumps reviewLogTick, the fetch effect re-runs, the banner
          refilters). 14-day window — older dates age out
          automatically.

          Renders ONLY if pendingEodDates is non-empty. When the list
          is empty (caught up or fresh user), the banner vanishes
          entirely so it's not a permanent fixture; its presence
          carries meaning. */}
      {pendingEodDates.length > 0 && (
        <div className="rounded-2xl border-2 p-4 sm:p-5 flex gap-3 sm:gap-4"
             style={{ background: '#FFFBEB', borderColor: '#92400E' }}>
          <div className="flex-shrink-0 w-11 h-11 rounded-full flex items-center justify-center"
               style={{ background: '#FBBF24' }}>
            <AlertTriangle className="w-5 h-5" style={{ color: '#7C2D12' }}/>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <div className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
                END-OF-DAY REVIEW PENDING
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full"
                style={{ background: '#92400E', color: '#FFFFFF', fontWeight: 700 }}>
                {pendingEodDates.length} day{pendingEodDates.length === 1 ? '' : 's'}
              </span>
            </div>
            <p className="text-sm mt-1.5" style={{ color: '#0A0A0A' }}>
              These working days were reviewed for late arrivals only. Re-import each file
              to complete the <strong>early departure</strong> and <strong>missed punch</strong> checks.
              The list clears itself as soon as you import the file again — nothing else to do.
            </p>
            <ul className="mt-3 space-y-1.5">
              {pendingEodDates.map(p => {
                // Display as "Tue 28 Apr · late check at 10:14"
                const d = new Date(p.review_date + 'T00:00:00');
                const dateLabel = d.toLocaleDateString('en-GB', {
                  weekday: 'short', day: '2-digit', month: 'short',
                });
                const morningTime = p.morning_at
                  ? new Date(p.morning_at).toLocaleTimeString('en-GB', {
                      hour: '2-digit', minute: '2-digit',
                    })
                  : '';
                // Days-old indicator — gentle nudge if it's getting stale.
                const ageDays = Math.max(0, Math.round(
                  (new Date().getTime() - new Date(p.review_date + 'T00:00:00').getTime()) / 86_400_000
                ));
                const ageLabel = ageDays === 0 ? 'today'
                              : ageDays === 1 ? 'yesterday'
                                              : ageDays + ' days ago';
                const stale = ageDays >= 5;
                return (
                  <li key={p.review_date}
                      className="flex items-center justify-between gap-3 text-sm rounded-lg px-3 py-2"
                      style={{ background: '#FFFFFF', border: '1px solid #FDE68A' }}>
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <Calendar className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#92400E' }}/>
                      <span style={{ color: '#0A0A0A', fontWeight: 600 }}>{dateLabel}</span>
                      <span className="text-xs" style={{ color: '#0A0A0A', opacity: 0.7 }}>·</span>
                      <span className="text-xs" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                        late check at {morningTime || '—'}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{
                          background: stale ? '#FEE2E2' : '#F4F4EE',
                          color: stale ? '#7F1D1D' : '#0A0A0A',
                          fontWeight: 600, letterSpacing: '0.05em',
                        }}>
                        {ageLabel}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {!hasFile ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          onClick={() => fileInputRef.current?.click()}
          className="rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors"
          style={{
            borderColor: isDragging ? '#10B981' : '#D4C7AB',
            background: isDragging ? '#ECFDF5' : '#FAF6EC',
          }}>
          <Upload className="w-10 h-10 mx-auto mb-4" style={{ color: '#1F1B16' }}/>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#1F1B16', marginBottom: '6px' }}>
            Drop your Time Card .xlsx here
          </div>
          <div className="text-sm" style={{ color: '#1F1B16' }}>
            or <span style={{ color: '#047857', textDecoration: 'underline', fontWeight: 600 }}>click to browse</span>
          </div>
          <div className="text-xs mt-4" style={{ color: '#0A0A0A' }}>
            Expected columns: Employee ID · First Name · Date · Times · Time
          </div>
          <div className="text-[11px] mt-1" style={{ color: '#1F1B16', opacity: 0.7 }}>
            Only the .xlsx export from the fingerprint device is accepted.
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={onPick}
          />
          {parseError && (
            <div className="mt-4 text-sm px-3 py-2 rounded-md inline-block text-left" style={{ color: '#BE123C', background: '#FEF2F2', maxWidth: '480px' }}>{parseError}</div>
          )}
        </div>
      ) : windowMismatch ? (
        <>
          <WindowMismatchBanner
            mismatch={windowMismatch}
            fileName={xlsxFileName}
            onReset={reset}
          />
          {/* Even when the file fails the daily today+yesterday
              window check, if it contains weekend rows we still
              render the weekend panel so Bashaier can produce
              the report for a missed or older weekend. The daily
              panels stay hidden — those require the working-day
              window — but weekend reporting is a parallel surface. */}
          {detection.weekend.length > 0 && (
            <div className="mt-6">
              {buildWeekendPanel()}
            </div>
          )}
        </>
      ) : (
        <FileSummary
          fileName={xlsxFileName}
          csvDate={csvDate}
          isWeekend={csvIsWeekend}
          totalRows={parsed.rows.length}
          offDateCount={parsed.offDateCount}
          counts={{
            late:      detection.late.length,
            missedIn:  detection.missedIn.length,
            early:     detection.early.length,
            missedOut: detection.missedOut.length,
            onTime:    detection.onTime.length,
            onLeave:   detection.onLeave.length,
            unknown:   detection.unknownEmp.length,
            weekend:   detection.weekend.length,
          }}
          dates={{ today: csvDate, yesterday: yesterdayDate }}
          windowAvail={{ today: parsed.hasTodayData, yesterday: parsed.hasYesterdayData }}
          detection={detection}
          drillKind={drillKind}
          setDrillKind={setDrillKind}
          actionPanels={actionPanels}
          progressByKind={progressByKind}
          actionsEnabled={actionsEnabled}
          onToggleActions={() => setActionsEnabled(v => !v)}
          isDuplicate={!!existingUpload}
          onReset={reset}
        />
      )}

      {/* INTEGRITY BANNERS — surface upload sanity issues prominently
          before any actions are taken. Each is independent; multiple
          can show at once. Order: most critical first. */}

      {/* Duplicate-upload notice — same file content for the same
          data date has been processed before. Cheap dedupe via
          SHA-256 hash. Doesn't block re-processing — just informs. */}
      {hasFile && existingUpload && (
        <div className="rounded-2xl border p-4 flex items-start gap-3"
             style={{ borderColor: '#A16207', background: '#FEFCE8' }}>
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#A16207' }}/>
          <div className="text-sm" style={{ color: '#0A0A0A' }}>
            <div className="font-bold mb-1">This file was processed before.</div>
            <div>
              The same content (identical SHA-256) was uploaded for {formatDateLong(csvDate)} on{' '}
              <strong>{new Date(existingUpload.uploaded_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</strong>
              {' '}({existingUpload.row_count} rows). Re-processing is allowed but any prior
              violation emails are already on record — the buttons below will skip duplicates
              automatically.
            </div>
          </div>
        </div>
      )}

      {/* Date sanity — today / future / very stale */}
      {hasFile && dateSanity && (
        <div className="rounded-2xl border p-4 flex items-start gap-3"
             style={{
               borderColor: dateSanity.kind === 'FUTURE' ? '#BE123C' : '#A16207',
               background:  dateSanity.kind === 'FUTURE' ? '#FEF2F2' : '#FEFCE8',
             }}>
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5"
            style={{ color: dateSanity.kind === 'FUTURE' ? '#BE123C' : '#A16207' }}/>
          <div className="text-sm" style={{ color: '#0A0A0A' }}>
            <div className="font-bold mb-1">{dateSanity.label}.</div>
            <div>
              {dateSanity.kind === 'TODAY' && (
                <>This file is for today — staff who haven't punched out yet will appear as Incomplete.
                Wait until end of day for a complete picture.</>
              )}
              {dateSanity.kind === 'FUTURE' && (
                <>The data date ({formatDateLong(csvDate)}) is in the future. Likely the wrong file
                — please verify before sending notices.</>
              )}
              {dateSanity.kind === 'STALE' && (
                <>The data date ({formatDateLong(csvDate)}) is {dateSanity.ageDays} days old. Make sure
                this is the file you intended to process.</>
              )}
            </div>
          </div>
        </div>
      )}

      {/* High-incompleteness anomaly — typically means file was
          exported mid-day before staff punched out. */}
      {hasFile && !csvIsWeekend && anomaly?.kind === 'MOSTLY_INCOMPLETE' && (
        <div className="rounded-2xl border p-4 flex items-start gap-3"
             style={{ borderColor: '#A16207', background: '#FEFCE8' }}>
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#A16207' }}/>
          <div className="text-sm" style={{ color: '#0A0A0A' }}>
            <div className="font-bold mb-1">Most rows look incomplete.</div>
            <div>{anomaly.message}</div>
          </div>
        </div>
      )}

      {/* Sheet-name vs data-date mismatch. Catches mislabeled exports
          and device clock drift. Both kinds are mid-priority — yellow
          for stale, red-tinted yellow for impossible. */}
      {hasFile && sheetSanity && (
        <div className="rounded-2xl border p-4 flex items-start gap-3"
             style={{
               borderColor: sheetSanity.kind === 'SHEET_BEFORE_DATA' ? '#BE123C' : '#A16207',
               background:  sheetSanity.kind === 'SHEET_BEFORE_DATA' ? '#FEF2F2' : '#FEFCE8',
             }}>
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5"
            style={{ color: sheetSanity.kind === 'SHEET_BEFORE_DATA' ? '#BE123C' : '#A16207' }}/>
          <div className="text-sm" style={{ color: '#0A0A0A' }}>
            <div className="font-bold mb-1">
              {sheetSanity.kind === 'SHEET_BEFORE_DATA' ? 'Sheet name pre-dates the data.' : 'Sheet name far from data date.'}
            </div>
            <div>{sheetSanity.message}</div>
          </div>
        </div>
      )}

      {/* Sections — only show if file uploaded and not weekend */}
      {hasFile && csvIsWeekend && (
        <div className="rounded-2xl border p-6 text-center" style={{ borderColor: '#D4C7AB', background: '#FAF6EC' }}>
          <Calendar className="w-8 h-8 mx-auto mb-3" style={{ color: '#1F1B16' }}/>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: '18px', color: '#1F1B16' }}>This was a weekend day.</div>
          <div className="text-sm mt-2" style={{ color: '#0A0A0A' }}>
            {formatDateLong(csvDate)} is a Friday or Saturday — no detection runs on KSA weekends.
          </div>
        </div>
      )}


      {/* Confirm-before-send modal — every email button routes through
          here for an extra check. The mailto: link only fires after
          explicit confirmation. */}
      {confirmEntry && (
        <ConfirmEmailModal
          confirm={confirmEntry}
          csvDate={csvDate}
          getManagerEmail={getManagerEmail}
          onCancel={() => setConfirmEntry(null)}
          onConfirm={() => {
            const { entry, kind, mode = 'live' } = confirmEntry;
            setConfirmEntry(null);
            if (kind === 'late')   handleEmailLate(entry, mode);
            else if (kind === 'early')  handleEmailEarly(entry, mode);
            else if (kind === 'missed' || kind === 'missedIn' || kind === 'missedOut') handleEmailMissed(entry, mode);
          }}
        />
      )}

      {/* Bulk action modal — sequential email queue. Bashaier opens
          the first draft, sends in her mail client, returns to mark
          it done, then opens the next. The modal stays open across
          the queue so progress is visible and she can stop anywhere.
          Mode toggle (Live/Test) lives inside the modal — the parent
          just passes the current session and updates `mode` when
          the toggle is clicked. */}
      {bulkSession && (
        <BulkActionModal
          session={bulkSession}
          csvDate={csvDate}
          getManagerEmail={getManagerEmail}
          onClose={() => setBulkSession(null)}
          onSetMode={(nextMode) => setBulkSession(prev => prev ? { ...prev, mode: nextMode } : prev)}
          onOpenDraft={(entry) => {
            const k = bulkSession.kind;
            const m = bulkSession.mode || 'live';
            if (k === 'late')   handleEmailLate(entry, m);
            else if (k === 'early')  handleEmailEarly(entry, m);
            else if (k === 'missed' || k === 'missedIn' || k === 'missedOut') handleEmailMissed(entry, m);
            // Mark this one in the queue's sent set so the modal can
            // strike it through. Also flips the row's UI state below.
            setBulkSession(prev => prev ? {
              ...prev,
              sentIds: new Set([...(prev.sentIds || new Set()), entry.id]),
            } : prev);
            markSent(entry.id);
          }}
        />
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

// ─── Window-mismatch blocking banner ────────────────────────────────────
// Renders when the uploaded file fails the strict today+yesterday
// requirement. Replaces the FileSummary card and hides all action
// sections (Late / MissedIn / Early / MissedOut) downstream — Bashaier
// must upload the correct file before any review can run.
//
// Why blocking instead of a soft warning: per Nadeem, the daily flow
// is "download a 2-day report, upload, review". If only one day is
// in the file, the review is incomplete by definition — yesterday's
// early-departure or today's late-arrival check would silently be
// missing. Better to refuse than to half-process.
function WindowMismatchBanner({ mismatch, fileName, onReset }) {
  const { expectedToday, expectedYesterday, datesInFile, hasExpectedToday, hasExpectedYesterday } = mismatch;
  // Diagnose which of the two cases applies for the headline.
  // If the file has neither expected date, treat as "wrong file
  // entirely". If it has one of the two, name the missing one.
  const missingBoth = !hasExpectedToday && !hasExpectedYesterday;
  const headline = missingBoth
    ? 'This file does not cover today or the previous working day'
    : !hasExpectedToday
      ? 'This file is missing today\u2019s data'
      : 'This file is missing the previous working day\u2019s data';

  return (
    <div className="rounded-2xl border-2 p-5 sm:p-6"
         style={{ borderColor: '#BE123C', background: '#FEF2F2' }}>
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0"
             style={{ background: '#FECACA' }}>
          <AlertTriangle className="w-6 h-6" style={{ color: '#BE123C' }}/>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[10px] mb-1" style={{ color: '#0A0A0A', letterSpacing: '0.25em', fontWeight: 700 }}>
            FILE REJECTED &middot; DATE WINDOW MISMATCH
          </div>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#0A0A0A', lineHeight: 1.3 }}>
            {headline}.
          </div>
          <div className="text-sm mt-1" style={{ color: '#0A0A0A' }}>
            {fileName ? <><strong>{fileName}</strong> &middot; </> : null}
            cannot be processed.
          </div>
        </div>
        <button onClick={onReset}
          className="text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5 flex-shrink-0"
          style={{ borderColor: '#BE123C', background: '#FFFFFF', color: '#BE123C', fontWeight: 600 }}>
          <X className="w-3.5 h-3.5"/> Upload different file
        </button>
      </div>

      {/* Required vs. actual */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl p-3 border" style={{ background: '#FFFFFF', borderColor: '#FCA5A5' }}>
          <div className="text-[10px] mb-2" style={{ color: '#0A0A0A', letterSpacing: '0.18em', fontWeight: 700 }}>
            REQUIRED IN FILE
          </div>
          <ul className="space-y-1.5">
            <li className="flex items-baseline gap-2 text-sm" style={{ color: '#0A0A0A' }}>
              <span style={{ color: hasExpectedToday ? '#047857' : '#BE123C', fontWeight: 700, minWidth: '14px' }}>
                {hasExpectedToday ? '\u2713' : '\u2717'}
              </span>
              <div>
                <div><strong>Today &mdash; {formatDateLong(expectedToday)}</strong></div>
                <div className="text-xs" style={{ opacity: 0.7 }}>For late arrivals + missed punch-in</div>
              </div>
            </li>
            <li className="flex items-baseline gap-2 text-sm" style={{ color: '#0A0A0A' }}>
              <span style={{ color: hasExpectedYesterday ? '#047857' : '#BE123C', fontWeight: 700, minWidth: '14px' }}>
                {hasExpectedYesterday ? '\u2713' : '\u2717'}
              </span>
              <div>
                <div><strong>Yesterday &mdash; {formatDateLong(expectedYesterday)}</strong></div>
                <div className="text-xs" style={{ opacity: 0.7 }}>For early departures + missed punch-out</div>
              </div>
            </li>
          </ul>
        </div>
        <div className="rounded-xl p-3 border" style={{ background: '#FFFFFF', borderColor: '#E5E0D5' }}>
          <div className="text-[10px] mb-2" style={{ color: '#0A0A0A', letterSpacing: '0.18em', fontWeight: 700 }}>
            FOUND IN FILE
          </div>
          {datesInFile.length === 0 ? (
            <div className="text-sm" style={{ color: '#0A0A0A', opacity: 0.7 }}>No dated rows.</div>
          ) : (
            <ul className="space-y-1.5">
              {datesInFile.map(d => {
                const isMatch = d === expectedToday || d === expectedYesterday;
                return (
                  <li key={d} className="flex items-baseline gap-2 text-sm" style={{ color: '#0A0A0A' }}>
                    <span style={{ color: isMatch ? '#047857' : '#A16207', fontWeight: 700, minWidth: '14px' }}>&bull;</span>
                    <span>{formatDateLong(d)}{isMatch ? '' : ' (outside window)'}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Guidance */}
      <div className="mt-4 rounded-lg p-3 text-sm" style={{ background: '#FEF3C7', border: '1px solid #FDE68A', color: '#0A0A0A' }}>
        <strong>What to do:</strong> open the fingerprint device portal and re-export the Time Card with
        the date range set to <strong>{formatDateLong(expectedYesterday)}</strong> &rarr; <strong>{formatDateLong(expectedToday)}</strong>.
        Both days must be in the same file. If today is the first working day after a weekend, the &ldquo;previous working day&rdquo;
        will be the last working day before the weekend (e.g. on Sunday, the previous working day is Thursday).
      </div>
    </div>
  );
}

function FileSummary({
  fileName, csvDate, isWeekend, totalRows, offDateCount = 0,
  counts, dates, windowAvail, detection, progressByKind,
  drillKind, setDrillKind, actionPanels,
  actionsEnabled, onToggleActions, isDuplicate, onReset,
}) {
  // drillKind is now controlled by the parent (AttendanceView) so the
  // action UI for each kind can be constructed alongside the email
  // handlers and shared state. Per Nadeem's brief: when a tile is
  // open, all email functions live inside the tile area — no separate
  // sections below this card. When collapsed, each tile shows its
  // own progress (X of Y emailed).

  const today     = dates?.today;
  const yesterday = dates?.yesterday;
  const hasToday     = windowAvail?.today;
  const hasYesterday = windowAvail?.yesterday;

  // Short day labels for tile subtext (e.g. "Sun 3 May")
  const shortDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  return (
    <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: '#D4C7AB' }}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
            UPLOADED FILE
          </div>
          <div className="flex items-center gap-2" style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#1F1B16' }}>
            <FileText className="w-5 h-5"/> {fileName}
          </div>
          <div className="text-sm mt-2" style={{ color: '#0A0A0A' }}>
            <strong>Date detected:</strong> {csvDate ? formatDateLong(csvDate) : 'unknown'}
            {isWeekend && <span style={{ color: '#A16207', marginLeft: '8px' }}>(KSA weekend — skipped)</span>}
            {' · '}<strong>{totalRows}</strong> rows in 2-day window
          </div>
          {/* Two-day workflow note — describe what's being checked
              against which day so Bashaier sees the scope at a glance. */}
          <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.85 }}>
            {hasToday && hasYesterday ? (
              <>Today ({shortDate(today)}) → late arrivals + missed punch-in. Yesterday ({shortDate(yesterday)}) → early departures + missed punch-out.</>
            ) : hasToday ? (
              <>Today only ({shortDate(today)}) → late arrivals + missed punch-in. Yesterday's data not in this file — early departures + missed punch-out won't appear.</>
            ) : hasYesterday ? (
              <>Yesterday only ({shortDate(yesterday)}) → early departures + missed punch-out.</>
            ) : null}
          </div>
          {/* Off-window warning — rows for dates outside the today+
              yesterday pair are silently dropped from detection. Show
              the count so the user notices a wrong export early. */}
          {offDateCount > 0 && (
            <div className="text-xs mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-md"
                 style={{ background: '#FFFBEB', border: '1px solid #FDE68A', color: '#0A0A0A' }}>
              <AlertTriangle className="w-3.5 h-3.5" style={{ color: '#92400E' }}/>
              <span>
                <strong>{offDateCount}</strong> row{offDateCount === 1 ? '' : 's'} for dates outside the today/yesterday window were ignored.
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {typeof onToggleActions === 'function' && (
            <button onClick={onToggleActions}
              className="text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5"
              style={{
                borderColor: actionsEnabled ? '#0F4C2A' : '#D4C7AB',
                background:  actionsEnabled ? '#ECFDF5' : '#FFFFFF',
                color: '#0A0A0A',
                fontWeight: 600,
              }}
              title={actionsEnabled
                ? 'Email and bulk-action buttons are enabled. Click to switch to read-only mode.'
                : 'Read-only mode: email buttons are hidden. Click to enable actions.'}>
              <span className="inline-block w-2 h-2 rounded-full"
                style={{ background: actionsEnabled ? '#047857' : '#9CA3AF' }}/>
              {actionsEnabled ? 'Actions on' : 'Read-only'}
              {isDuplicate && actionsEnabled && (
                <span className="text-[9px] px-1 py-0.5 rounded font-bold tracking-wider"
                  style={{ background: '#FDE68A', color: '#92400E' }}>
                  DUPLICATE
                </span>
              )}
            </button>
          )}
          <button
            onClick={onReset}
            className="text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5"
            style={{ borderColor: '#D4C7AB', color: '#1F1B16' }}>
            <X className="w-3.5 h-3.5"/> Upload different file
          </button>
        </div>
      </div>

      {!isWeekend && (
        <div className="mt-5 space-y-4">
          {/* TODAY's bucket — late arrivals + missed punch-in */}
          {hasToday && (
            <div>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
                  TODAY
                </span>
                <span className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                  {shortDate(today)} · arrival checks
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <CountPill kind="onTime"   icon="✓"  label="On time"          count={counts.onTime}   color="#047857" tint="#ECFDF5" subtext="punched in by 8:15"        isOpen={drillKind === 'onTime'}   onClick={() => setDrillKind(drillKind === 'onTime'   ? null : 'onTime')}/>
                <CountPill kind="late"     icon="⚠"  label="Late arrival"     count={counts.late}     color="#BE123C" tint="#FFF1F2" subtext="punched in after 8:15"    isOpen={drillKind === 'late'}     onClick={() => setDrillKind(drillKind === 'late'     ? null : 'late')}     progress={progressByKind?.late}/>
                <CountPill kind="missedIn" icon="🚫" label="Missed punch-in"  count={counts.missedIn} color="#4338CA" tint="#EEF2FF" subtext="no first-punch on record"  isOpen={drillKind === 'missedIn'} onClick={() => setDrillKind(drillKind === 'missedIn' ? null : 'missedIn')} progress={progressByKind?.missedIn}/>
              </div>
            </div>
          )}

          {/* YESTERDAY's bucket — early departures + missed punch-out */}
          {hasYesterday && (
            <div>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
                  YESTERDAY
                </span>
                <span className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                  {shortDate(yesterday)} · departure checks
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <CountPill kind="early"     icon="⏰" label="Early departure"  count={counts.early}     color="#A16207" tint="#FEFCE8" subtext="left before grace cutoff"  isOpen={drillKind === 'early'}     onClick={() => setDrillKind(drillKind === 'early'     ? null : 'early')}     progress={progressByKind?.early}/>
                <CountPill kind="missedOut" icon="🚪" label="Missed punch-out" count={counts.missedOut} color="#7E22CE" tint="#FAF5FF" subtext="no last-punch on record"   isOpen={drillKind === 'missedOut'} onClick={() => setDrillKind(drillKind === 'missedOut' ? null : 'missedOut')} progress={progressByKind?.missedOut}/>
                <CountPill kind="onLeave"   icon="🌴" label="On leave"         count={counts.onLeave}   color="#0E7490" tint="#ECFEFF" subtext="approved leave on file"    isOpen={drillKind === 'onLeave'}   onClick={() => setDrillKind(drillKind === 'onLeave'   ? null : 'onLeave')}/>
              </div>
            </div>
          )}

          {/* WEEKEND attendance — Mr John's report. Surfaces only
              when the file's window includes a weekend day with
              actual punches (typically Sunday's import covering
              Thu→Sun, where Fri+Sat are weekend). Hidden the rest
              of the week to keep the page clean. */}
          {counts.weekend > 0 && (
            <div>
              <div className="flex items-baseline gap-2 mb-2">
                <span className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
                  WEEKEND
                </span>
                <span className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                  Fri + Sat &middot; report for Mr John
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <CountPill kind="weekend" icon="🏖" label="Weekend attendance" count={counts.weekend} color="#0F4C2A" tint="#F0FDF4" subtext="exported as report + emailed" isOpen={drillKind === 'weekend'} onClick={() => setDrillKind(drillKind === 'weekend' ? null : 'weekend')}/>
              </div>
            </div>
          )}

          {/* Inline drill-down — for ACTIONABLE kinds (late, missedIn,
              early, missedOut), render the action panel passed in from
              the parent (full FlaggedSection with email buttons). For
              read-only kinds (onTime, onLeave, unknown), render the
              simple BreakdownPanel list. Either way: in-page, no
              popup, all functions live inside the file-summary card. */}
          {drillKind && actionPanels?.[drillKind] && (
            <div>{actionPanels[drillKind]}</div>
          )}
          {drillKind && !actionPanels?.[drillKind] && detection && (
            <BreakdownPanel
              kind={drillKind}
              detection={detection}
              onClose={() => setDrillKind(null)}
            />
          )}

          {/* Unrecognised employees — only surfaces when count > 0,
              and stays out of the main day-grouped grid since it's
              a data-quality issue, not a daily attendance violation
              we'd email about. */}
          {counts.unknown > 0 && (
            <div>
              <CountPill
                kind="unknown" icon="?" label="Unrecognised"
                count={counts.unknown} color="#991B1B" tint="#FEF2F2"
                subtext="not in employee directory"
                isOpen={drillKind === 'unknown'}
                onClick={() => setDrillKind(drillKind === 'unknown' ? null : 'unknown')}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CountPill({ icon, label, count, color, tint, subtext, isOpen, onClick, progress }) {
  const isInteractive = typeof onClick === 'function' && count > 0;
  const Tag = isInteractive ? 'button' : 'div';
  // Progress: { sent: number, total: number } when this kind is
  // actionable and at least one email has been sent today. Surfaced
  // on the collapsed tile so Bashaier can see the day's progress at
  // a glance without expanding. e.g. "3 / 6 emailed". The whole
  // progress UI hides for non-actionable tiles or when nothing's
  // sent yet — keeps the tile clean until there's signal to show.
  const showProgress = !!progress && progress.total > 0;
  const allDone = showProgress && progress.sent >= progress.total;
  const progressPct = showProgress ? Math.round((progress.sent / progress.total) * 100) : 0;
  return (
    <Tag
      type={isInteractive ? 'button' : undefined}
      onClick={isInteractive ? onClick : undefined}
      className={
        'rounded-xl p-3 text-left transition-all w-full '
        + (isInteractive
            ? 'cursor-pointer hover:shadow-md hover:-translate-y-0.5 active:translate-y-0 focus:outline-none focus:ring-2 focus:ring-offset-1'
            : 'cursor-default')
      }
      style={{
        background: tint,
        outlineColor: color,
        boxShadow: isOpen ? `0 0 0 2px ${color}, 0 4px 12px rgba(31,27,22,0.08)` : undefined,
      }}
      title={isInteractive ? `Click to ${isOpen ? 'collapse' : 'expand'} the list of ${count} ${label.toLowerCase()} below` : undefined}>
      <div className="flex items-center gap-2" style={{ color }}>
        <span style={{ fontSize: '16px' }}>{icon}</span>
        <span className="text-[10px]" style={{ letterSpacing: '0.18em', fontWeight: 700, color: '#1F1B16' }}>{label.toUpperCase()}</span>
      </div>
      <div className="mt-1 flex items-baseline gap-2 flex-wrap">
        <span style={{ fontSize: '24px', fontWeight: 700, color, lineHeight: 1 }}>{count}</span>
        {isInteractive && (
          <span className="text-[10px]" style={{ color, opacity: 0.7, fontWeight: 600 }}>
            {isOpen ? '▾ open' : 'view ▸'}
          </span>
        )}
      </div>
      {subtext && (
        <div className="text-[10px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          {subtext}
        </div>
      )}
      {showProgress && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-[10px] mb-1" style={{ color: '#0A0A0A' }}>
            <span style={{ fontWeight: 700 }}>
              {allDone
                ? <><span style={{ color: '#047857' }}>✓</span> All {progress.total} emailed</>
                : <><strong>{progress.sent}</strong> of <strong>{progress.total}</strong> emailed</>}
            </span>
            {!allDone && (
              <span style={{ opacity: 0.7 }}>
                {progress.total - progress.sent} left
              </span>
            )}
          </div>
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#E5E0D5' }}>
            <div
              className="h-full transition-all"
              style={{ width: progressPct + '%', background: allDone ? '#047857' : color }}
            />
          </div>
        </div>
      )}
    </Tag>
  );
}

// ─── Inline breakdown panel ─────────────────────────────────────────────
// Renders below the tile grid (inside FileSummary) when a tile is
// clicked. Shows the full list of employees in that bucket. Replaces
// the previous BreakdownModal which used a portal overlay — Nadeem
// asked for everything to live on one scrollable page so HR doesn't
// chase data into popups.
//
// Read-only — actions still live in the per-section cards lower down
// the page. This panel exists purely as an "expand to see the list"
// drill-down, especially useful for ON-TIME and ON-LEAVE which don't
// have dedicated action sections.
function BreakdownPanel({ kind, detection, onClose }) {
  const config = {
    onTime:    { title: 'On time',         accent: '#047857', tint: '#ECFDF5', icon: '✓',  empty: 'No on-time entries.' },
    late:      { title: 'Late arrival',    accent: '#BE123C', tint: '#FFF1F2', icon: '⚠',  empty: 'Nobody arrived late — well done team.' },
    missedIn:  { title: 'Missed punch-in', accent: '#4338CA', tint: '#EEF2FF', icon: '🚫', empty: 'All staff have a punch-in on record.' },
    early:     { title: 'Early departure', accent: '#A16207', tint: '#FEFCE8', icon: '⏰', empty: 'Nobody left early.' },
    missedOut: { title: 'Missed punch-out',accent: '#7E22CE', tint: '#FAF5FF', icon: '🚪', empty: 'All staff have a punch-out on record.' },
    onLeave:   { title: 'On leave',        accent: '#0E7490', tint: '#ECFEFF', icon: '🌴', empty: 'Nobody on approved leave today.' },
    unknown:   { title: 'Unrecognised',    accent: '#991B1B', tint: '#FEF2F2', icon: '?',  empty: 'No unrecognised employees in the file.' },
  };
  const cfg = config[kind] || config.late;
  // Map kind → detection bucket key (unknown is stored under unknownEmp).
  const bucketKey = kind === 'unknown' ? 'unknownEmp' : kind;
  const entries = detection[bucketKey] || [];

  // Per-kind one-line detail. Tries to give Bashaier the most useful
  // single-glance fact about each entry.
  const detailFor = (e) => {
    if (kind === 'late') {
      let d = `Punched in at ${e.punchInStr} · ${e.minutesLate} min after grace`;
      d += e.permission ? ` · permitted to ${String(e.permission.time_to || '').slice(0,5)}` : ' · no permission';
      return d;
    }
    if (kind === 'early') {
      let d = `Punched out at ${e.punchOutStr} · ${e.minutesEarly} min before ${e.scheduledEnd}`;
      d += e.permission ? ` · permitted from ${String(e.permission.time_from || '').slice(0,5)}` : ' · no permission';
      return d;
    }
    if (kind === 'missedIn') {
      return e.missingType === 'both' ? 'Both punch-in and punch-out missing — likely absent'
                                      : 'No punch-in on record';
    }
    if (kind === 'missedOut') {
      return e.missingType === 'both' ? 'Both punch-in and punch-out missing — likely absent'
                                      : `No punch-out on record (punch-in: ${e.punchInStr || '—'})`;
    }
    if (kind === 'onTime')  return `In ${e.punchInStr || '—'} · Out ${e.punchOutStr || '—'}`;
    if (kind === 'onLeave') return 'Approved leave on file — excluded from violation checks';
    if (kind === 'unknown') return `File listed: "${e.csvName || '(no name)'}" · ID ${e.empId || '?'} — not in employee directory`;
    return '';
  };

  const nameOf = (e) => e.employee?.name || e.csvName || '(unknown)';
  const psnOf  = (e) => e.employee?.id   || e.empId   || '';
  const deptOf = (e) => e.employee?.department || '';

  return (
    <div className="rounded-xl border" style={{ borderColor: cfg.accent + '40', background: '#FFFFFF' }}>
      {/* Compact header strip with title + count + close */}
      <div className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap rounded-t-xl"
           style={{ background: cfg.tint, borderBottom: `1px solid ${cfg.accent}30` }}>
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ fontSize: '16px' }}>{cfg.icon}</span>
          <span className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
            {cfg.title.toUpperCase()}
          </span>
          <span className="text-sm" style={{ fontWeight: 700, color: cfg.accent }}>
            · {entries.length}
          </span>
        </div>
        <button type="button" onClick={onClose}
          className="text-[11px] px-2 py-1 rounded-full inline-flex items-center gap-1"
          style={{ background: '#FFFFFF', color: '#0A0A0A', border: `1px solid ${cfg.accent}40` }}
          title="Collapse this list">
          <X className="w-3 h-3"/> Close
        </button>
      </div>

      {/* List body */}
      {entries.length === 0 ? (
        <div className="p-6 text-center text-sm" style={{ color: '#0A0A0A', opacity: 0.65 }}>
          {cfg.empty}
        </div>
      ) : (
        <ul className="p-2 space-y-1.5 max-h-[40vh] overflow-y-auto">
          {entries.map((e, i) => (
            <li key={e.id || `entry-${i}`}
                className="rounded-md px-3 py-2 border"
                style={{ background: '#FFFFFF', borderColor: '#E5E0D5' }}>
              <div className="flex items-baseline gap-2 flex-wrap">
                <span style={{ fontWeight: 700, color: '#0A0A0A', fontSize: '14px' }}>
                  {nameOf(e)}
                </span>
                {psnOf(e) && (
                  <span className="text-xs" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                    · {psnOf(e)}
                  </span>
                )}
                {deptOf(e) && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-bold tracking-wider"
                        style={{ background: cfg.tint, color: cfg.accent }}>
                    {deptOf(e)}
                  </span>
                )}
                {e.dateLabel && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded"
                        style={{ background: '#F4F4EE', color: '#0A0A0A', fontWeight: 600 }}>
                    {e.dateLabel}
                  </span>
                )}
              </div>
              <div className="text-xs mt-0.5" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                {detailFor(e)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


function FlaggedSection({ title, kicker, iconColor, barFrom, barTo, entries, empty, renderButton, onBulk }) {
  if (!entries.length) {
    return (
      <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: '#D4C7AB' }}>
        <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>{kicker}</div>
        <div style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#1F1B16' }}>{title}</div>
        <div className="flex items-center gap-2 mt-3" style={{ color: '#047857' }}>
          <CheckCircle2 className="w-4 h-4"/>
          <span className="text-sm">{empty}</span>
        </div>
      </div>
    );
  }
  // Compute how many entries are actionable AND not already emailed
  // (no in-DB email_sent_at). The bulk button only appears when
  // there's at least 2 such rows — single rows don't need bulk UX.
  const bulkable = (entries || []).filter(e =>
    (e.actionable !== false) && !e.emailSentAt && !e.sent
  );
  return (
    <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: '#D4C7AB' }}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-1">
        <div className="text-[10px]" style={{ color: iconColor, letterSpacing: '0.25em', fontWeight: 700 }}>
          {kicker} · {entries.length}
        </div>
        {onBulk && bulkable.length >= 2 && (
          <button
            type="button"
            onClick={() => onBulk(bulkable)}
            className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full"
            style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 600 }}
            title={`Step through emailing all ${bulkable.length} actionable rows in this section.`}
          >
            <Mail className="w-3 h-3"/> Email all actionable ({bulkable.length})
          </button>
        )}
      </div>
      <div className="mb-4" style={{ fontFamily: 'Georgia, serif', fontSize: '22px', color: '#1F1B16' }}>{title}</div>
      <div className="space-y-3">
        {entries.map(entry => (
          <div key={entry.id} className="rounded-xl border bg-white relative overflow-hidden esau-badge"
               style={{ borderColor: '#E5E0D5', boxShadow: '0 1px 2px rgba(31,27,22,0.04), 0 4px 14px rgba(31,27,22,0.06)' }}>
            <div aria-hidden style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: '4px', background: 'linear-gradient(180deg, ' + barFrom + ' 0%, ' + barTo + ' 100%)' }}/>
            <div className="p-4 pl-5 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3 flex-1 min-w-[200px]">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap" style={{ color: '#1F1B16' }}>
                    <span style={{ fontWeight: 700, fontSize: '15px' }}>{entry.employee.name}</span>
                    <span className="text-xs font-normal" style={{ color: '#0A0A0A' }}>
                      · {entry.employee.id || entry.employee.psn || ''} · {entry.employee.department || ''}
                    </span>
                    {entry.permBadge && (
                      <span
                        className="text-[10px] tracking-wider font-bold px-2 py-0.5 rounded-md"
                        style={
                          entry.permBadge.tone === 'amber'
                            ? { background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' }
                            // Saturated red on red badge so "no permission"
                            // and "beyond permission" cases jump off the
                            // page — Bashaier wanted these visually
                            // unambiguous so she can spot actionable
                            // rows at a glance.
                            : { background: '#BE123C', color: '#FFFFFF', border: '1px solid #BE123C', letterSpacing: '0.05em' }
                        }
                        title={
                          entry.permBadge.tone === 'amber'
                            ? 'This row is covered by an approved permission — recorded for audit but no action needed.'
                            : 'No permission on file (or punched outside the permitted window) — action required.'
                        }
                      >
                        {entry.permBadge.text}
                      </span>
                    )}
                    {/* Repeat-offender flag — surfaced when this employee
                        has 3+ violations recorded this calendar month
                        (counted from attendance_violations, distinct
                        days). Ties into the monthly evaluation deduction
                        flow that triggers at 5. */}
                    {entry.monthlyCount >= 3 && (
                      <span
                        className="text-[10px] tracking-wider font-bold px-2 py-0.5 rounded-md inline-flex items-center gap-1"
                        style={{
                          background: entry.monthlyCount >= 5 ? '#7F1D1D' : '#991B1B',
                          color: '#FFFFFF',
                          border: '1px solid ' + (entry.monthlyCount >= 5 ? '#7F1D1D' : '#991B1B'),
                        }}
                        title={
                          entry.monthlyCount >= 5
                            ? `${entry.monthlyCount} incidents this month — past the 5-per-month threshold for HR review.`
                            : `${entry.monthlyCount} incidents this month — close to the 5-per-month review threshold.`
                        }
                      >
                        REPEAT × {entry.monthlyCount}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 text-xs" style={{ color: '#0A0A0A' }}>
                    {entry.metaIcon} {entry.detail}
                  </div>
                  {/* Mid-day punches — surfaced inline when the staff
                      member punched 3+ times that day. Shows the
                      timestamps that aren't first or last. Often these
                      are lunch-break punches, site visits, or device
                      retries. Purely informational at this stage —
                      shifts integration will turn these into proper
                      mid-day check counts later. */}
                  {entry.row?._tc?.midDayPunches?.length > 0 && (
                    <div className="flex items-center gap-1.5 mt-1 text-[11px] flex-wrap" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                      <span className="text-[9px] tracking-wider font-bold opacity-60">MID-DAY</span>
                      {entry.row._tc.midDayPunches.map((t, i) => (
                        <span key={i}
                          className="px-1.5 py-0.5 rounded font-mono text-[10px]"
                          style={{ background: '#F4F4EE', border: '1px solid #E5E0D5' }}>
                          {t.slice(0, 5)}
                        </span>
                      ))}
                      <span className="text-[10px] opacity-60">
                        ({entry.row._tc.uniqueCount} punches total)
                      </span>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {renderButton(entry)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function RowButton({ onClick, onClickTest, onMarkSent, sent, logged, emailSentAt, label }) {
  // Three button states, in order of decreasing certainty:
  //   1. sent (in-session)        — Bashaier just clicked Email above
  //   2. emailSentAt (DB record)  — a row exists in attendance_violations
  //                                  with email_sent_at set; she emailed
  //                                  this person before
  //   3. fresh                    — active button, no prior record
  // The DB-backed state (#2) shows a readable date and a smaller
  // 'Re-send' option in case a follow-up is genuinely needed. This
  // prevents accidental double-emailing when she revisits the file.
  //
  // Pre-launch period (Test button): when onClickTest is provided,
  // the fresh state renders a secondary yellow-bordered "Test" button
  // alongside the primary green "Email" button. Test sends the same
  // email but with no portal/esauhr.netlify.app references. Once the
  // portal is officially announced, callers can stop passing
  // onClickTest and the second button silently disappears.
  if (sent) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-full" style={{ background: '#ECFDF5', color: '#047857', fontWeight: 700 }}>
          <CheckCircle2 className="w-4 h-4"/> Email Sent
        </div>
        {logged && (
          <div className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 700, letterSpacing: '0.1em' }} title="A row has been recorded in attendance_violations for this incident.">
            LOGGED
          </div>
        )}
      </div>
    );
  }
  if (emailSentAt) {
    const sentDate = new Date(emailSentAt);
    const ago = (() => {
      const ms = Date.now() - sentDate.getTime();
      const days = Math.floor(ms / 86_400_000);
      if (days === 0) return 'today';
      if (days === 1) return 'yesterday';
      if (days < 7)   return days + 'd ago';
      return sentDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    })();
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-full" style={{ background: '#ECFDF5', color: '#0A0A0A', fontWeight: 600, border: '1px solid #A7F3D0' }} title={`Email logged at ${sentDate.toLocaleString('en-GB')}`}>
          <CheckCircle2 className="w-3.5 h-3.5" style={{ color: '#047857' }}/> Already emailed · {ago}
        </div>
        <button onClick={onClick}
          className="text-[11px] px-2.5 py-1.5 rounded-full border inline-flex items-center gap-1"
          style={{ borderColor: '#D4C7AB', color: '#0A0A0A', background: '#FFFFFF' }}
          title="Re-send the production-wording notice — only do this if a genuine follow-up is needed.">
          <Mail className="w-3 h-3"/> Re-send (Live)
        </button>
        {onClickTest && (
          <button onClick={onClickTest}
            className="text-[11px] px-2.5 py-1.5 rounded-full border inline-flex items-center gap-1"
            style={{ borderColor: '#FDE68A', color: '#92400E', background: '#FFFBEB' }}
            title="Re-send the pre-launch (test) wording — no portal references.">
            <Mail className="w-3 h-3"/> Re-send (Test)
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button onClick={onClick}
        className="text-xs px-3 py-2 rounded-full text-white flex items-center gap-1.5"
        style={{ background: '#0F4C2A', fontWeight: 600 }}
        title="Send the production-wording email (references the ESAU HR Portal).">
        <Mail className="w-4 h-4"/> {label}
      </button>
      {onClickTest && (
        <button onClick={onClickTest}
          className="text-xs px-3 py-2 rounded-full inline-flex items-center gap-1.5 border"
          style={{ background: '#FFFBEB', color: '#92400E', borderColor: '#FDE68A', fontWeight: 600 }}
          title="Send the pre-launch (test) wording — no references to esauhr.netlify.app or the HR Portal. For use until the portal is officially launched to staff.">
          <Mail className="w-4 h-4"/> Test
        </button>
      )}
      <button onClick={onMarkSent}
        className="text-xs px-2 py-2 rounded-full border"
        style={{ borderColor: '#D4C7AB', color: '#1F1B16' }}
        title="Mark as sent (no email opened — use this if you sent the notice through another channel).">
        ✓
      </button>
      {logged && (
        <div className="text-[10px] px-2 py-0.5 rounded-full" style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 700, letterSpacing: '0.1em' }} title="A row has been recorded in attendance_violations for this incident.">
          LOGGED
        </div>
      )}
    </div>
  );
}

// ─── Confirm-before-send modal ───────────────────────────────────────────
// Shows a TO / CC / SUBJECT / preview before the mailto: fires.
// Mirrors the pattern used by PermissionApprovedModal and
// RejoiningApprovedModal — Bashaier reviews the recipients,
// confirms, the email opens in her client. No silent sends.
function ConfirmEmailModal({ confirm, csvDate, getManagerEmail, onCancel, onConfirm }) {
  const { entry, kind, mode = 'live' } = confirm;
  const dateLong = formatDateLong(csvDate);
  const cc = [getManagerEmail(entry.employee), ...FIXED_CC].filter(Boolean);

  // Compute preview subject + a short summary line. The full body goes
  // out via the existing handleEmail* path; we don't duplicate it here.
  // mode='test' routes the preview to the temp content functions so the
  // subject + summary match what's actually about to be sent.
  let subject = '';
  let summary = '';
  if (kind === 'late') {
    const fn = mode === 'test' ? lateEmailContentTemp : lateEmailContent;
    const c = fn({
      employee: entry.employee, dateLong,
      punchInStr: entry.punchInStr,
      minutesLate: entry.minutesLate,
      scheduledStart: entry.scheduledStart,
      lateCutoff: entry.lateCutoff,
    });
    subject = c.subject;
    summary = `Late arrival on ${dateLong} — punched in ${entry.punchInStr}, ${entry.minutesLate} min after grace.`;
  } else if (kind === 'early') {
    const fn = mode === 'test' ? earlyLeaveEmailContentTemp : earlyLeaveEmailContent;
    const c = fn({
      employee: entry.employee, dateLong,
      punchOutStr: entry.punchOutStr,
      scheduledEnd: entry.scheduledEnd,
      minutesEarly: entry.minutesEarly,
    });
    subject = c.subject;
    summary = `Early departure on ${dateLong} — punched out ${entry.punchOutStr}, ${entry.minutesEarly} min before scheduled ${entry.scheduledEnd}.`;
  } else if (kind === 'missed' || kind === 'missedIn' || kind === 'missedOut') {
    const fn = mode === 'test' ? missedPunchEmailContentTemp : missedPunchEmailContent;
    const c = fn({
      employee: entry.employee, dateLong, missingType: entry.missingType,
    });
    subject = c.subject;
    summary = `Missing punch on ${dateLong} — ${entry.missingType === 'both' ? 'both in and out' : entry.missingType === 'in' ? 'punch-in' : 'punch-out'} not recorded.`;
  }

  // Test-mode banner copy varies by kind. For missed-punch the test
  // wording is identical to live (the live version doesn't reference
  // the portal anyway), so we surface that fact rather than implying
  // a difference that isn't there.
  const testBannerCopy = (kind === 'missed' || kind === 'missedIn' || kind === 'missedOut')
    ? 'TEST DRAFT — the missed-punch email has no portal references in either Live or Test wording, so this is identical to the Live version. The button is shown for UI consistency.'
    : 'TEST DRAFT — pre-launch wording with no references to esauhr.netlify.app or the HR Portal. The recipient is asked to reply with their explanation rather than submit a portal request.';

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px', overflowY: 'auto',
      }}
    >
      <div
        className="w-full max-w-lg rounded-2xl border"
        style={{
          borderColor: '#D4C7AB',
          background: '#FFFDF7',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b" style={{ borderColor: '#E5E0D5' }}>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                 style={{
                   background: mode === 'test' ? '#FEF3C7' : '#FEF3C7',
                   border:     mode === 'test' ? '1px solid #FDE68A' : '1px solid #FDE68A',
                 }}>
              <Mail className="w-5 h-5" style={{ color: mode === 'test' ? '#92400E' : '#A16207' }}/>
            </div>
            <div>
              <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '18px', color: '#0A0A0A', fontWeight: 500 }}>
                Confirm before sending
                {mode === 'test' && (
                  <span className="ml-2 align-middle text-[10px] px-2 py-0.5 rounded-full"
                        style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A', fontWeight: 700, letterSpacing: '0.18em' }}>
                    TEST DRAFT
                  </span>
                )}
              </h2>
              <div className="text-xs mt-1" style={{ color: '#0A0A0A' }}>
                Review the recipients and content. Your mail client will open the draft — you still need to click Send there.
              </div>
            </div>
          </div>
          <button type="button" onClick={onCancel}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors" aria-label="Cancel">
            <X className="w-4 h-4" style={{ color: '#0A0A0A' }}/>
          </button>
        </div>

        {/* Test-mode banner — explains the wording differences vs live */}
        {mode === 'test' && (
          <div className="px-6 py-3 border-b text-[11px]"
               style={{ borderColor: '#E5E0D5', background: '#FFFBEB', color: '#92400E', lineHeight: 1.5 }}>
            <strong style={{ letterSpacing: '0.1em', fontWeight: 700 }}>{testBannerCopy.split(' — ')[0]}</strong>
            {' — '}
            {testBannerCopy.split(' — ').slice(1).join(' — ')}
          </div>
        )}

        {/* Recipient + subject preview */}
        <div className="px-6 py-4 border-b text-xs" style={{ borderColor: '#E5E0D5', color: '#0A0A0A' }}>
          <div className="grid grid-cols-[60px_1fr] gap-x-3 gap-y-1.5">
            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>TO</span>
            <span>
              {entry.employee.name}{' '}
              {entry.employee.email
                ? <em style={{ opacity: 0.7 }}>&lt;{entry.employee.email}&gt;</em>
                : <span style={{ color: '#B91C1C' }}>(no email on file)</span>}
            </span>

            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>CC</span>
            <span>
              {getManagerEmail(entry.employee) ? 'Manager + ' : ''}{cc.length} executive{cc.length === 1 ? '' : 's'}
            </span>

            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>SUBJECT</span>
            <span>{subject}</span>

            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>SUMMARY</span>
            <span>{summary}</span>
          </div>
          {entry.permission && (
            <div className="mt-3 px-3 py-2 rounded-md text-[11px]"
                 style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' }}>
              <strong>Note:</strong> An approved permission is on file for this date
              ({String(entry.permission.time_from || '').slice(0,5)}–{String(entry.permission.time_to || '').slice(0,5)}).
              The email will explain that the punch was outside the permitted window.
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="p-5 flex flex-col sm:flex-row gap-2.5">
          <button type="button" onClick={onCancel}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border text-sm transition-colors"
            style={{ background: '#FFFFFF', borderColor: '#D4C7AB', color: '#0A0A0A', fontWeight: 500 }}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={!entry.employee.email}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
            style={mode === 'test'
              ? { background: '#92400E', color: '#FFFDF7', fontWeight: 500 }
              : { background: '#0A0A0A', color: '#FFFDF7', fontWeight: 500 }}>
            <Send className="w-4 h-4"/> {mode === 'test' ? 'Open test draft' : 'Open email draft'}
          </button>
        </div>

        {!entry.employee.email && (
          <div className="px-5 pb-4 text-xs" style={{ color: '#B91C1C' }}>
            No email address on file for {entry.employee.name}. Please add one in the directory before sending.
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Bulk action modal ──────────────────────────────────────────────────
// Sequential queue of email drafts. Bashaier sees the entire list with
// names + summaries, can skip any row, and steps through opening each
// draft in her mail client one at a time. mailto: only fires one
// email per click, so we don't try to batch — the modal handles the
// orchestration. Closing the modal at any point is fine; she can
// resume by clicking the bulk button again on a re-rendered section.
function BulkActionModal({ session, csvDate, getManagerEmail, onClose, onOpenDraft, onSetMode }) {
  const { kind, queue, sentIds } = session;
  const mode = session.mode || 'live';
  const remaining = queue.filter(e => !sentIds.has(e.id));
  const total = queue.length;
  const done  = total - remaining.length;
  const dateLong = formatDateLong(csvDate);

  // Helper: build a one-line summary per kind so the queue is scannable.
  const summarise = (entry) => {
    if (kind === 'late') {
      return `Late ${entry.punchInStr} · ${entry.minutesLate} min after grace`
        + (entry.permission ? ` · permitted to ${String(entry.permission.time_to || '').slice(0,5)}` : ' · no permission');
    }
    if (kind === 'early') {
      return `Left ${entry.punchOutStr} · ${entry.minutesEarly} min before ${entry.scheduledEnd}`
        + (entry.permission ? ` · permitted from ${String(entry.permission.time_from || '').slice(0,5)}` : ' · no permission');
    }
    if (kind === 'missed' || kind === 'missedIn' || kind === 'missedOut') {
      return entry.missingType === 'both' ? 'Both punch-in and punch-out missing'
           : entry.missingType === 'in'   ? 'No punch-in on record'
                                          : 'No punch-out on record';
    }
    return '';
  };

  const heading = kind === 'late'      ? 'Late arrivals (today)'
                : kind === 'early'     ? 'Early departures (yesterday)'
                : kind === 'missedIn'  ? 'Missed punch-in (today)'
                : kind === 'missedOut' ? 'Missed punch-out (yesterday)'
                : 'Missed punches';

  // Per-kind visual cues — buttons + accent colours flip based on mode
  // so Bashaier can tell at a glance which wording the queue is using.
  // Live = the production green we use elsewhere; Test = the same
  // amber/yellow that the per-row Test button uses, so the visual
  // language is consistent across single and bulk actions.
  const isTest = mode === 'test';
  const draftBtnBg     = isTest ? '#FFFBEB' : '#0F4C2A';
  const draftBtnFg     = isTest ? '#92400E' : '#FFFFFF';
  const draftBtnBorder = isTest ? '1px solid #FDE68A' : 'none';
  const headerKickerBg = isTest ? '#FEF3C7' : '#0A0A0A';
  const headerKickerFg = isTest ? '#92400E' : '#FFFDF7';
  const modeNotice     = isTest
    ? 'Pre-launch wording — no portal references. Switch to Live once the portal is announced.'
    : 'Production wording — includes the ESAU HR Portal links.';

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px', overflowY: 'auto',
      }}
    >
      <div
        className="w-full max-w-2xl rounded-2xl border"
        style={{
          borderColor: '#D4C7AB',
          background: '#FFFDF7',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b" style={{ borderColor: '#E5E0D5' }}>
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-2 mb-2">
              <span className="text-[10px] tracking-[0.25em] px-2 py-0.5 rounded-full"
                    style={{ fontWeight: 700, background: headerKickerBg, color: headerKickerFg }}>
                BULK · {heading.toUpperCase()} · {isTest ? 'TEST' : 'LIVE'}
              </span>
            </div>
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#0A0A0A', fontWeight: 500 }}>
              {done} of {total} drafts opened
            </h2>
            <div className="text-xs mt-1" style={{ color: '#0A0A0A' }}>
              {remaining.length === 0
                ? 'All drafts have been opened. Close when done.'
                : 'Click "Open" beside each row to launch the draft in your mail client. Send manually, then continue.'}
            </div>
            {/* Mode toggle — segmented control. Disabled mid-queue so a
                half-sent batch never mixes Live and Test wording. */}
            <div className="mt-3 inline-flex items-center gap-2 flex-wrap">
              <span className="text-[10px] tracking-[0.18em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
                MODE
              </span>
              <div className="inline-flex rounded-full overflow-hidden border" style={{ borderColor: '#D4C7AB', background: '#FFFFFF' }}>
                <button type="button"
                  onClick={() => onSetMode && onSetMode('live')}
                  disabled={done > 0 || !onSetMode}
                  className="text-[11px] px-3 py-1.5 disabled:opacity-50"
                  style={{
                    background: !isTest ? '#0F4C2A' : 'transparent',
                    color:      !isTest ? '#FFFFFF' : '#0A0A0A',
                    fontWeight: !isTest ? 700 : 500,
                  }}
                  title="Production wording — references the ESAU HR Portal.">
                  Live
                </button>
                <button type="button"
                  onClick={() => onSetMode && onSetMode('test')}
                  disabled={done > 0 || !onSetMode}
                  className="text-[11px] px-3 py-1.5 disabled:opacity-50"
                  style={{
                    background: isTest ? '#FEF3C7' : 'transparent',
                    color:      isTest ? '#92400E' : '#0A0A0A',
                    fontWeight: isTest ? 700 : 500,
                  }}
                  title="Pre-launch wording — no portal references. For use until the portal is officially announced.">
                  Test
                </button>
              </div>
              {done > 0 && (
                <span className="text-[10px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                  Locked — {done} draft{done === 1 ? '' : 's'} already opened in this mode.
                </span>
              )}
            </div>
            <div className="text-[11px] mt-2" style={{ color: '#0A0A0A', opacity: 0.85 }}>
              {modeNotice}
            </div>
          </div>
          <button type="button" onClick={onClose}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors flex-shrink-0" aria-label="Close">
            <X className="w-4 h-4" style={{ color: '#0A0A0A' }}/>
          </button>
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div className="px-6 pt-3">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#E5E0D5' }}>
              <div className="h-full transition-all" style={{
                width: `${(done / total) * 100}%`,
                background: isTest
                  ? 'linear-gradient(90deg, #FBBF24 0%, #92400E 100%)'
                  : 'linear-gradient(90deg, #047857 0%, #0F4C2A 100%)',
              }}/>
            </div>
          </div>
        )}

        {/* Queue */}
        <ul className="p-3 space-y-2 max-h-[55vh] overflow-y-auto">
          {queue.map(entry => {
            const sent = sentIds.has(entry.id);
            const cc   = [getManagerEmail(entry.employee), ...FIXED_CC].filter(Boolean);
            return (
              <li key={entry.id}
                  className="rounded-xl border p-3 flex items-center justify-between gap-3 flex-wrap"
                  style={{
                    background: sent ? '#ECFDF5' : '#FFFFFF',
                    borderColor: sent ? '#A7F3D0' : '#E5E0D5',
                    opacity: sent ? 0.75 : 1,
                  }}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span style={{ fontWeight: 700, color: '#0A0A0A', fontSize: '14px' }}>
                      {entry.employee.name}
                    </span>
                    <span className="text-xs" style={{ color: '#0A0A0A' }}>
                      · {entry.employee.id}
                    </span>
                    {entry.permission && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-bold tracking-wider"
                        style={{ background: '#FEF3C7', color: '#92400E' }}>
                        PERMITTED
                      </span>
                    )}
                    {(entry.monthlyCount || 0) >= 3 && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded font-bold tracking-wider"
                        style={{ background: '#7F1D1D', color: '#FFFFFF' }}>
                        REPEAT × {entry.monthlyCount}
                      </span>
                    )}
                  </div>
                  <div className="text-xs mt-1" style={{ color: '#0A0A0A' }}>
                    {summarise(entry)}
                  </div>
                  <div className="text-[10px] mt-0.5 opacity-70" style={{ color: '#0A0A0A' }}>
                    To: {entry.employee.email || '(no email)'} · CC: {cc.length} recipient{cc.length === 1 ? '' : 's'}
                  </div>
                </div>
                {sent ? (
                  <span className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full"
                    style={{ background: '#FFFFFF', color: '#047857', border: '1px solid #A7F3D0', fontWeight: 600 }}>
                    <CheckCircle2 className="w-3.5 h-3.5"/> Opened
                  </span>
                ) : (
                  <button type="button" onClick={() => onOpenDraft(entry)}
                    disabled={!entry.employee.email}
                    className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full disabled:opacity-50"
                    style={{ background: draftBtnBg, color: draftBtnFg, fontWeight: 600, border: draftBtnBorder }}
                    title={isTest
                      ? 'Open the pre-launch (test) draft — no portal references.'
                      : 'Open the production draft — references the ESAU HR Portal.'}>
                    <Mail className="w-3.5 h-3.5"/> Open {isTest ? 'test ' : ''}draft
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {/* Footer */}
        <div className="px-5 py-4 border-t flex items-center justify-between gap-2 flex-wrap"
             style={{ borderColor: '#E5E0D5', background: '#FAF6EC' }}>
          <div className="text-[11px]" style={{ color: '#0A0A0A' }}>
            Each click opens a draft in your mail client. You still send each one manually.
          </div>
          <button type="button" onClick={onClose}
            className="text-xs px-4 py-2 rounded-full"
            style={{ background: '#0A0A0A', color: '#FFFDF7', fontWeight: 500 }}>
            {remaining.length === 0 ? 'Done' : `Stop (${remaining.length} remaining)`}
          </button>
        </div>
      </div>
    </div>
  );
}
