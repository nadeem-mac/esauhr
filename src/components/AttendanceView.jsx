import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Upload, FileText, Clock, AlertTriangle, Mail, CheckCircle2,
  X, Calendar, Briefcase, Users, Send, Sparkles
} from 'lucide-react';
import { directGet, directPost } from '../supabaseClient.js';
import { parseTimeCardXlsx, TimeCardParseError } from '../lib/timeCard.js';

/* ────────────────────────────────────────────────────────────────────────
   Daily attendance check — driven by Time Card xlsx upload.

   Bashaier uploads yesterday's Time Card export (.xlsx). The system finds:
     1. LATE   — punched in after 08:15 (8:00 official start + 15 min grace)
        Cross-referenced against approved late_arrival permissions:
          • LATE_PERMITTED   — permission on file, within window
          • LATE_BEYOND      — permission on file, but came in even later
          • LATE_NO_PERMISSION — actual violation, action required
     2. EARLY  — punched out before scheduled end - 15 min grace
                  • SUP team: scheduled end 16:00 (4 PM) → cutoff 15:45
                  • All other depts: scheduled end 17:00 (5 PM) → cutoff 16:45
        Same WITH/WITHOUT permission split as late.
     3. INCOMPLETE — only 1 punch on file (no punch-out recorded)

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
  // Body rewritten to speak as the HR Department (institutional voice,
  // not personal), per Nadeem's standing communications preference.
  // Structure:
  //   1. One-line factual record of the violation.
  //   2. Policy block in a fenced visual zone, each rule on its own
  //      line. Uses "grace period" terminology to teach the term.
  //   3. Action block — staff must still file a portal permission
  //      retroactively so the system can track usage against the
  //      monthly entitlement and feed the evaluation scorecard.
  //   4. Exception path — reply within 2 working days for documented
  //      cases that exceed the monthly cap.
  // Trade-off vs the previous version: shorter, less personal,
  // explicitly cites policy, ends with a clear action path. Drops
  // empathic language ("things come up — traffic, family") that
  // suited a peer-to-peer note but not an HR violation notice.
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows your punch-in at ' + punchInStr + ' \u2014 ' + minutesLate + ' minutes past the 15-minute grace period and with no approved permission on file. This is recorded as a late-arrival violation.\n\n' +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n' +
    '\u2022 The official clock-in time is 8:00 AM on regular working days.\n' +
    '\u2022 A 15-minute grace period is allowed; arrivals after 8:15 AM are recorded as late.\n' +
    '\u2022 Each staff is entitled to 3 late-arrival permissions per month \u2014 1 hour each, 3 times only.\n' +
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n\n' +
    'You are still required to submit a late-arrival permission request via the ESAU HR Portal (esauhr.netlify.app \u2192 New Request \u2192 Permission) for today\u2019s punch-in. Submitting it after the fact lets HR record the reason and consider it against your monthly entitlement \u2014 without an approved permission, the day stands as an unexcused violation on your evaluation record.\n\n' +
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
  const body =
    'Dear ' + greetName + ',\n\n' +
    'I hope you are well. I am reaching out on behalf of HR regarding your check-out on ' + dateLong + '.\n\n' +
    'Our time card log shows your punch-out at ' + punchOutStr + ', which is around ' + minutesEarly + ' minutes earlier than your scheduled end of ' + scheduledEnd + ' (we allow a 15-minute grace window before that time).\n\n' +
    'Before I update your record, I wanted to check in with you. If you had a manager-approved reason — a permission request, family matter, or medical appointment — please let me know and I will log it accordingly. If it was unplanned, kindly loop in your direct manager and HR ahead of time next time so we can keep your file clean.\n\n' +
    'We track these to keep payroll and overtime accurate, and to support fair evaluations. Repeated unapproved early departures are something HR has to flag, and I would much rather catch it now than have it become a pattern.\n\n' +
    'Thank you for your continued effort, and please reply when you have a moment so I can close out the record properly.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

function missedPunchEmailContent({ employee, dateLong, missingType }) {
  // missingType: 'in' | 'out' | 'both'
  const what = missingType === 'in'   ? 'your punch-in entry'
            : missingType === 'out'  ? 'your punch-out entry'
            : 'both your punch-in and punch-out entries';
  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  const subject = 'Missing Punch Reminder — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';
  const body =
    'Dear ' + greetName + ',\n\n' +
    'I hope this finds you well. I am reaching out on behalf of HR regarding your time card for ' + dateLong + '.\n\n' +
    'Our records show that ' + what + ' was missing for that day. Occasional misses do happen, and I am not raising this to alarm you — but consistent and complete punch-in / punch-out is one of the few things we cannot be flexible on. It directly affects your payroll, overtime calculation, and our compliance with Saudi labor regulations.\n\n' +
    'If your card or the terminal had an issue on that day, please reply with the actual times you started and finished, and I will correct the log manually. If it was an oversight, a quick check before leaving the office tends to help — even a phone reminder works wonders.\n\n' +
    'I do have to mention, as part of our HR procedure, that repeated missed punches are tracked. After a certain number of incidents in a month, this becomes a formal evaluation warning. I would much prefer never to send that email, so please help me keep your record clean.\n\n' +
    'Thank you, and please feel free to reach out if there is anything we can support you with on this.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

// Build a mailto: URL with the proper TO + CC + subject + body.
function buildMailto({ to, cc, subject, body }) {
  // We use encodeURIComponent (not URLSearchParams) because URLSearchParams encodes
  // spaces as '+' which several mail clients leave literally as '+' instead of
  // decoding back to a space. encodeURIComponent uses '%20' for spaces, which
  // every mail client decodes correctly.
  const parts = [];
  const ccStr = (cc || []).filter(Boolean).join(',');
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
  const [confirmEntry, setConfirmEntry] = useState(null); // { entry, kind: 'late'|'early'|'missed' }

  // Bulk-action session. When Bashaier clicks 'Email all N actionable'
  // on a section header, we stage a queue of entries to email and
  // open a modal that lets her step through them one by one. Mailto:
  // can only fire one email at a time (browser limitation), so the
  // UX is sequential — but the modal stays open and tracks progress.
  // bulkSession shape: { kind: 'late'|'early'|'missed', queue: entry[],
  //                      sentIds: Set<string> }
  const [bulkSession, setBulkSession] = useState(null);

  const [approvedLeaves, setApprovedLeaves]       = useState([]);
  const [approvedPermissions, setApprovedPerms]   = useState([]); // for the data date
  const [acceptedShifts, setAcceptedShifts]       = useState([]);
  const [sentMarkers, setSentMarkers]             = useState({}); // key: row.id → true
  const [loggedMarkers, setLoggedMarkers]         = useState({}); // key: 'empId:type' → true
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
  const parsed = useMemo(() => {
    const rows = (parsedData.rows || []).map(r => ({
      'Employee ID': r.psn,
      'First Name':  r.name,
      'Date':        r.date,
      'First Punch': r.firstPunch ? r.firstPunch.slice(0, 5) : '', // HH:MM
      'Last Punch':  r.lastPunch  ? r.lastPunch.slice(0, 5)  : '',
      // Carry the whole parsed entry so cross-reference can read
      // uniqueCount / midDayPunches / rawPunches without re-parsing.
      _tc: r,
    }));
    return { headers: ['Employee ID','First Name','Date','First Punch','Last Punch'], rows };
  }, [parsedData]);

  const csvDate = useMemo(() => parsedData.dataDate || null, [parsedData.dataDate]);
  const csvIsWeekend = isKsaWeekend(csvDate);

  // Fetch approved leaves for the CSV date
  useEffect(() => {
    if (!csvDate) { setApprovedLeaves([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const data = await directGet(
          'leave_requests?select=employee_id,start_date,end_date,status&status=eq.approved&start_date=lte.' + csvDate + '&end_date=gte.' + csvDate
        );
        if (!cancelled) setApprovedLeaves(data || []);
      } catch (e) {
        console.warn('Could not fetch approved leaves:', e);
        if (!cancelled) setApprovedLeaves([]);
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate]);

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
        const data = await directGet(
          'permission_requests?select=id,employee_id,permission_date,type,time_from,time_to,hours,reason,stage,status'
          + '&permission_date=eq.' + csvDate
          + '&stage=eq.approved'
        );
        if (!cancelled) setApprovedPerms(data || []);
      } catch (e) {
        console.warn('Could not fetch approved permissions:', e);
        if (!cancelled) setApprovedPerms([]);
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate]);

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

  const onLeaveOnDate = useCallback((empId) => {
    return approvedLeaves.some(l => String(l.employee_id) === String(empId));
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
      if (!p?.employee_id || !p?.type) return;
      const key = String(p.employee_id).toUpperCase() + '|' + p.type;
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

  // Run detection
  const detection = useMemo(() => {
    const out = { late: [], early: [], missed: [], onTime: [], onLeave: [], unknownEmp: [] };
    if (!parsed.rows.length || csvIsWeekend) return out;

    parsed.rows.forEach((row, idx) => {
      const empIdRaw = row['Employee ID'] || row['employee_id'] || row['EmployeeID'] || row['ID'] || '';
      const empId = String(empIdRaw).trim();
      // Tolerant lookup with three layers, in order of strictness:
      //   1. Exact-string match (e.g. 'H94590' → 'H94590')
      //   2. Exact match after explicit H-prefix prepend
      //   3. Digit-only canonical match — collapses leading zeros and
      //      missing/extra H prefixes. Catches cases like file '4458'
      //      vs directory 'H04458', or directory 'H4458' vs file '4458',
      //      regardless of how the device export was formatted.
      const lookupKey = empId.toUpperCase().startsWith('H') ? empId.toUpperCase() : ('H' + empId).toUpperCase();
      const emp = empById[empId.toUpperCase()]
               || empById[lookupKey]
               || empByDigits[psnDigits(empId)]
               || null;
      if (!emp) {
        out.unknownEmp.push({ id: 'row-' + idx, row, empId, csvName: row['First Name'] || '' });
        return;
      }
      // Skip if on approved leave
      if (onLeaveOnDate(emp.id)) {
        out.onLeave.push({ id: 'row-' + idx, employee: emp });
        return;
      }
      const dept = (row['Department'] || emp.department || '').trim();
      // P4: per-day shift override takes precedence over the team default.
      // If staff accepted a custom schedule for this date, build a one-shot
      // schedule object with a 15-min grace on each end (matching the policy
      // applied to the 08:00 default). Otherwise use the team default.
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
      const lateCutoffMin = timeToMinutes(sched.lateCutoffStr);
      const punchInStr = (row['First Punch'] || '').trim();
      const punchOutStr = (row['Last Punch'] || '').trim();
      const punchInMin = timeToMinutes(punchInStr);
      const punchOutMin = timeToMinutes(punchOutStr);

      // Missed punch first — supersedes late/early since we don't have data
      const missingIn  = !punchInMin;
      const missingOut = !punchOutMin;
      if (missingIn || missingOut) {
        out.missed.push({
          id: 'row-' + idx,
          employee: emp,
          row,
          missingType: missingIn && missingOut ? 'both' : (missingIn ? 'in' : 'out'),
          punchInStr, punchOutStr,
          scheduledStart: sched.startStr,
          scheduledEnd: sched.endStr,
          lateCutoff: sched.lateCutoffStr,
          scheduleLabel: sched.label,
          isCustomShift: !!sched.isCustom,
        });
        return;
      }

      let flagged = false;
      // Late check
      if (punchInMin > lateCutoffMin) {
        // Cross-reference with approved late_arrival permissions for
        // this employee on this date. Three sub-cases:
        //   • no permission           → LATE_NO_PERMISSION (actionable)
        //   • permission, within      → LATE_PERMITTED  (audit-only)
        //   • permission, beyond      → LATE_BEYOND     (actionable + context)
        const permKey = String(emp.id).toUpperCase() + '|late_arrival';
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
          id: 'row-' + idx,
          employee: emp,
          row,
          punchInStr,
          punchInMin,
          minutesLate: punchInMin - lateCutoffMin,
          scheduledStart: sched.startStr,
          scheduledEnd: sched.endStr,
          lateCutoff: sched.lateCutoffStr,
          scheduleLabel: sched.label,
          isCustomShift: !!sched.isCustom,
          permission: perm,
          permStatus,
          minutesBeyond,
        });
        flagged = true;
      }
      // Early-leave check
      const earlyCutoffMin = timeToMinutes(sched.earlyCutoffStr);
      const scheduledEndMin = timeToMinutes(sched.endStr);
      if (punchOutMin < earlyCutoffMin) {
        // Same WITH/WITHOUT permission split, mirror of the late branch.
        const permKey = String(emp.id).toUpperCase() + '|early_leave';
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
          id: 'row-' + idx,
          employee: emp,
          row,
          punchOutStr,
          punchOutMin,
          scheduledStart: sched.startStr,
          scheduledEnd: sched.endStr,
          lateCutoff: sched.lateCutoffStr,
          earlyCutoff: sched.earlyCutoffStr,
          scheduleLabel: sched.label,
          isCustomShift: !!sched.isCustom,
          minutesEarly: scheduledEndMin - punchOutMin,
          isSup: isSupTeam(emp),
          permission: perm,
          permStatus,
          minutesBeyond,
        });
        flagged = true;
      }
      if (!flagged) {
        out.onTime.push({ id: 'row-' + idx, employee: emp, punchInStr, punchOutStr });
      }
    });
    return out;
  }, [parsed.rows, empById, empByDigits, onLeaveOnDate, csvIsWeekend, shiftOverrideById, permIndex]);

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
      // data date — if present, surface a banner so Bashaier knows
      // she's looking at processed history, not new work.
      try {
        const prior = await directGet(
          'attendance_uploads?select=id,uploaded_by,uploaded_at,row_count&'
          + 'data_date=eq.' + result.dataDate
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
      violation_date: csvDate,                 // ISO yyyy-mm-dd from csvDate
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

  const handleEmailLate = (entry) => {
    const dateLong = formatDateLong(csvDate);
    const { subject, body } = lateEmailContent({
      employee: entry.employee,
      dateLong,
      punchInStr: entry.punchInStr,
      minutesLate: entry.minutesLate, // minutes past the grace window — matches the email body wording
      scheduledStart: entry.scheduledStart,
      lateCutoff: entry.lateCutoff,
    });
    const cc = [getManagerEmail(entry.employee), ...FIXED_CC].filter(Boolean);
    const url = buildMailto({ to: entry.employee.email, cc, subject, body });
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

  const handleEmailEarly = (entry) => {
    const dateLong = formatDateLong(csvDate);
    const { subject, body } = earlyLeaveEmailContent({
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

  const handleEmailMissed = (entry) => {
    const dateLong = formatDateLong(csvDate);
    const { subject, body } = missedPunchEmailContent({
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
        <p className="text-sm mt-3 max-w-3xl" style={{ color: '#0A0A0A' }}>
          Upload yesterday's <strong>Time Card export (.xlsx)</strong>. The system flags late arrivals,
          early departures, and incomplete punches per ESAU policy, cross-referenced against approved
          permissions. You review each notice and click Send in your mail client. Anyone with an approved
          leave on that date is excluded automatically.
        </p>
      </div>

      {/* Upload zone or file summary */}
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
      ) : (
        <FileSummary
          fileName={xlsxFileName}
          csvDate={csvDate}
          isWeekend={csvIsWeekend}
          totalRows={parsed.rows.length}
          counts={{
            late: detection.late.length,
            early: detection.early.length,
            missed: detection.missed.length,
            onTime: detection.onTime.length,
            onLeave: detection.onLeave.length,
            unknown: detection.unknownEmp.length,
          }}
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

      {hasFile && !csvIsWeekend && (
        <>
          <FlaggedSection
            title="Late arrivals"
            kicker={'AFTER ' + LATE_CUTOFF}
            iconColor="#BE123C"
            barFrom="#FB7185" barTo="#BE123C"
            empty="Nobody arrived late — well done team."
            onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'late', queue: rows, sentIds: new Set() }) : null}
            entries={detection.late.map(e => {
              // Detail line carries WITH/WITHOUT permission status. Bashaier
              // wants the difference visible at a glance.
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
                detail = baseDetail + ' · Permitted to '
                  + (e.permission?.time_to || '').slice(0,5)
                  + ' — ' + e.minutesBeyond + ' min beyond permission';
                permBadge = { tone: 'red', text: 'BEYOND PERMISSION' };
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
                onClick={() => setConfirmEntry({ entry, kind: 'late' })}
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

          <FlaggedSection
            title="Early departures"
            kicker="LEFT BEFORE GRACE WINDOW"
            iconColor="#A16207"
            barFrom="#FACC15" barTo="#A16207"
            empty="Nobody left early — full day attendance recorded."
            onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'early', queue: rows, sentIds: new Set() }) : null}
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
                detail = baseDetail + ' · Permitted from '
                  + (e.permission?.time_from || '').slice(0,5)
                  + ' — ' + e.minutesBeyond + ' min beyond permission';
                permBadge = { tone: 'red', text: 'BEYOND PERMISSION' };
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
                style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E0D5' }}
                title="Read-only mode — toggle 'Actions on' in the file summary above to enable emailing.">
                READ-ONLY
              </span>
            ) : entry.actionable ? (
              <RowButton
                onClick={() => setConfirmEntry({ entry, kind: 'early' })}
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

          <FlaggedSection
            title="Missed punches"
            kicker="REMINDER + ESCALATION NOTE"
            iconColor="#1D4ED8"
            barFrom="#60A5FA" barTo="#1D4ED8"
            empty="All staff punched in and out — perfect compliance."
            onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'missed', queue: rows, sentIds: new Set() }) : null}
            entries={detection.missed.map(e => {
              const types = e.missingType === 'both' ? ['missed_in', 'missed_out']
                : e.missingType === 'in' ? ['missed_in'] : ['missed_out'];
              const allLogged = types.every(t => loggedMarkers[e.employee.id + ':' + t]);
              // For missed punches, "already emailed" means at least one
              // of the missed_in/missed_out rows has email_sent_at set.
              const sentTimestamp = types
                .map(t => loggedMarkers[e.employee.id + ':' + t])
                .find(v => typeof v === 'string') || null;
              return ({
                ...e,
                detail: (e.missingType === 'in'  ? 'Missing punch-in (no first-punch on record)'
                      : e.missingType === 'out' ? 'Missing punch-out (no last-punch on record)'
                      : 'Missing both punch-in and punch-out')
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
                style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E0D5' }}
                title="Read-only mode — toggle 'Actions on' in the file summary above to enable emailing.">
                READ-ONLY
              </span>
            ) : (
              <RowButton
                onClick={() => setConfirmEntry({ entry, kind: 'missed' })}
                onMarkSent={() => markSent(entry.id)}
                sent={!!sentMarkers[entry.id]}
                logged={entry.logged}
                emailSentAt={entry.emailSentAt}
                label="Email reminder"
              />
            )}
          />

          {/* Approved leaves (excluded) */}
          {detection.onLeave.length > 0 && (
            <div className="rounded-2xl border p-3 sm:p-5" style={{ borderColor: '#D4C7AB', background: '#FAF6EC' }}>
              <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
                EXCLUDED — APPROVED LEAVE ({detection.onLeave.length})
              </div>
              <div className="text-sm" style={{ color: '#1F1B16' }}>
                {detection.onLeave.map(e => e.employee.name).filter(Boolean).join(', ')}
              </div>
            </div>
          )}

          {/* Unknown employees */}
          {detection.unknownEmp.length > 0 && (
            <div className="rounded-2xl border p-3 sm:p-5" style={{ borderColor: '#FCA5A5', background: '#FEF2F2' }}>
              <div className="text-[10px] mb-1" style={{ color: '#991B1B', letterSpacing: '0.25em', fontWeight: 700 }}>
                ⚠ UNRECOGNISED EMPLOYEES IN FILE ({detection.unknownEmp.length})
              </div>
              <div className="text-sm" style={{ color: '#0A0A0A' }}>
                These PSNs are in the file but not in the employee directory. The matcher already
                tries digit-only fallbacks (so '4458' will find 'H04458'), so a no-match here means the
                staff member truly isn't in the directory yet — open the Employees tab to add them, or
                check that their PSN was entered correctly when they were onboarded.
              </div>
              <ul className="mt-2 text-sm space-y-1" style={{ color: '#0A0A0A' }}>
                {detection.unknownEmp.map(u => (
                  <li key={u.id}><span style={{ fontWeight: 600 }}>{u.empId}</span> — {u.csvName || 'unknown'}</li>
                ))}
              </ul>
            </div>
          )}
        </>
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
            const { entry, kind } = confirmEntry;
            setConfirmEntry(null);
            if (kind === 'late')   handleEmailLate(entry);
            else if (kind === 'early')  handleEmailEarly(entry);
            else if (kind === 'missed') handleEmailMissed(entry);
          }}
        />
      )}

      {/* Bulk action modal — sequential email queue. Bashaier opens
          the first draft, sends in her mail client, returns to mark
          it done, then opens the next. The modal stays open across
          the queue so progress is visible and she can stop anywhere. */}
      {bulkSession && (
        <BulkActionModal
          session={bulkSession}
          csvDate={csvDate}
          getManagerEmail={getManagerEmail}
          onClose={() => setBulkSession(null)}
          onOpenDraft={(entry) => {
            const k = bulkSession.kind;
            if (k === 'late')   handleEmailLate(entry);
            else if (k === 'early')  handleEmailEarly(entry);
            else if (k === 'missed') handleEmailMissed(entry);
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

function FileSummary({ fileName, csvDate, isWeekend, totalRows, counts, actionsEnabled, onToggleActions, isDuplicate, onReset }) {
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
            {' · '}<strong>{totalRows}</strong> rows parsed
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Actions toggle. When OFF, every email/bulk button on the
              page renders as a disabled placeholder so Bashaier can
              study the data without risk of accidentally triggering
              an email. Auto-OFF on duplicate uploads (handled in the
              parent component) — toggle here lets her override either
              default. */}
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
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-4">
          <CountPill icon="✓"  label="On time"   count={counts.onTime} color="#047857" tint="#ECFDF5"/>
          <CountPill icon="⚠"  label="Late"      count={counts.late}    color="#BE123C" tint="#FFF1F2"/>
          <CountPill icon="⏰" label="Left early" count={counts.early}   color="#A16207" tint="#FEFCE8"/>
          <CountPill icon="🔇" label="Missed punch" count={counts.missed} color="#1D4ED8" tint="#EFF6FF"/>
          <CountPill icon="🌴" label="On leave"  count={counts.onLeave} color="#0E7490" tint="#ECFEFF"/>
          <CountPill icon="?"  label="Unknown"   count={counts.unknown} color="#991B1B" tint="#FEF2F2"/>
        </div>
      )}
    </div>
  );
}

function CountPill({ icon, label, count, color, tint }) {
  return (
    <div className="rounded-xl p-3" style={{ background: tint }}>
      <div className="flex items-center gap-2" style={{ color }}>
        <span style={{ fontSize: '16px' }}>{icon}</span>
        <span className="text-[10px]" style={{ letterSpacing: '0.18em', fontWeight: 700, color: '#1F1B16' }}>{label.toUpperCase()}</span>
      </div>
      <div className="mt-1" style={{ fontSize: '24px', fontWeight: 700, color, lineHeight: 1 }}>{count}</div>
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
                            : { background: '#FEE2E2', color: '#991B1B', border: '1px solid #FECACA' }
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

function RowButton({ onClick, onMarkSent, sent, logged, emailSentAt, label }) {
  // Three button states, in order of decreasing certainty:
  //   1. sent (in-session)        — Bashaier just clicked Email above
  //   2. emailSentAt (DB record)  — a row exists in attendance_violations
  //                                  with email_sent_at set; she emailed
  //                                  this person before
  //   3. fresh                    — active button, no prior record
  // The DB-backed state (#2) shows a readable date and a smaller
  // 'Re-send' option in case a follow-up is genuinely needed. This
  // prevents accidental double-emailing when she revisits the file.
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
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-full" style={{ background: '#ECFDF5', color: '#0A0A0A', fontWeight: 600, border: '1px solid #A7F3D0' }} title={`Email logged at ${sentDate.toLocaleString('en-GB')}`}>
          <CheckCircle2 className="w-3.5 h-3.5" style={{ color: '#047857' }}/> Already emailed · {ago}
        </div>
        <button onClick={onClick}
          className="text-[11px] px-2.5 py-1.5 rounded-full border inline-flex items-center gap-1"
          style={{ borderColor: '#D4C7AB', color: '#0A0A0A', background: '#FFFFFF' }}
          title="Re-send the notice — only do this if a genuine follow-up is needed.">
          <Mail className="w-3 h-3"/> Re-send
        </button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <button onClick={onClick}
        className="text-xs px-3 py-2 rounded-full text-white flex items-center gap-1.5"
        style={{ background: '#0F4C2A', fontWeight: 600 }}>
        <Mail className="w-4 h-4"/> {label}
      </button>
      <button onClick={onMarkSent}
        className="text-xs px-2 py-2 rounded-full border"
        style={{ borderColor: '#D4C7AB', color: '#1F1B16' }}
        title="Mark as sent">
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
  const { entry, kind } = confirm;
  const dateLong = formatDateLong(csvDate);
  const cc = [getManagerEmail(entry.employee), ...FIXED_CC].filter(Boolean);

  // Compute preview subject + a short summary line. The full body goes
  // out via the existing handleEmail* path; we don't duplicate it here.
  let subject = '';
  let summary = '';
  if (kind === 'late') {
    const c = lateEmailContent({
      employee: entry.employee, dateLong,
      punchInStr: entry.punchInStr,
      minutesLate: entry.minutesLate,
      scheduledStart: entry.scheduledStart,
      lateCutoff: entry.lateCutoff,
    });
    subject = c.subject;
    summary = `Late arrival on ${dateLong} — punched in ${entry.punchInStr}, ${entry.minutesLate} min after grace.`;
  } else if (kind === 'early') {
    const c = earlyLeaveEmailContent({
      employee: entry.employee, dateLong,
      punchOutStr: entry.punchOutStr,
      scheduledEnd: entry.scheduledEnd,
      minutesEarly: entry.minutesEarly,
    });
    subject = c.subject;
    summary = `Early departure on ${dateLong} — punched out ${entry.punchOutStr}, ${entry.minutesEarly} min before scheduled ${entry.scheduledEnd}.`;
  } else if (kind === 'missed') {
    const c = missedPunchEmailContent({
      employee: entry.employee, dateLong, missingType: entry.missingType,
    });
    subject = c.subject;
    summary = `Missing punch on ${dateLong} — ${entry.missingType === 'both' ? 'both in and out' : entry.missingType === 'in' ? 'punch-in' : 'punch-out'} not recorded.`;
  }

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
                 style={{ background: '#FEF3C7', border: '1px solid #FDE68A' }}>
              <Mail className="w-5 h-5" style={{ color: '#A16207' }}/>
            </div>
            <div>
              <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '18px', color: '#0A0A0A', fontWeight: 500 }}>
                Confirm before sending
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
            style={{ background: '#0A0A0A', color: '#FFFDF7', fontWeight: 500 }}>
            <Send className="w-4 h-4"/> Open email draft
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
function BulkActionModal({ session, csvDate, getManagerEmail, onClose, onOpenDraft }) {
  const { kind, queue, sentIds } = session;
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
    if (kind === 'missed') {
      return entry.missingType === 'both' ? 'Both punch-in and punch-out missing'
           : entry.missingType === 'in'   ? 'No punch-in on record'
                                          : 'No punch-out on record';
    }
    return '';
  };

  const heading = kind === 'late' ? 'Late arrivals'
                : kind === 'early' ? 'Early departures'
                : 'Missed punches';

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
          <div>
            <div className="text-[10px] tracking-[0.25em] mb-1" style={{ fontWeight: 700, color: '#0A0A0A' }}>
              BULK EMAIL · {heading.toUpperCase()}
            </div>
            <h2 style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#0A0A0A', fontWeight: 500 }}>
              {done} of {total} drafts opened
            </h2>
            <div className="text-xs mt-1" style={{ color: '#0A0A0A' }}>
              {remaining.length === 0
                ? 'All drafts have been opened. Close when done.'
                : 'Click "Open" beside each row to launch the draft in your mail client. Send manually, then continue.'}
            </div>
          </div>
          <button type="button" onClick={onClose}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors" aria-label="Close">
            <X className="w-4 h-4" style={{ color: '#0A0A0A' }}/>
          </button>
        </div>

        {/* Progress bar */}
        {total > 0 && (
          <div className="px-6 pt-3">
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#E5E0D5' }}>
              <div className="h-full transition-all" style={{
                width: `${(done / total) * 100}%`,
                background: 'linear-gradient(90deg, #047857 0%, #0F4C2A 100%)',
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
                    style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 600 }}>
                    <Mail className="w-3.5 h-3.5"/> Open draft
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
