import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Upload, FileText, Clock, AlertTriangle, Mail, CheckCircle2,
  X, Calendar, Briefcase, Users, Send, Sparkles
} from 'lucide-react';
import { directGet, directPost } from '../supabaseClient.js';

/* ────────────────────────────────────────────────────────────────────────
   Daily attendance check — driven by Time Card CSV upload.

   Bashaier uploads yesterday's Time Card export (CSV). The system finds:
     1. LATE   — punched in after 08:15 (8:00 official start + 15 min grace)
     2. EARLY  — punched out before scheduled end - 15 min grace
                  • SUP team: scheduled end 16:00 (4 PM) → cutoff 15:45
                  • All other depts: scheduled end 17:00 (5 PM) → cutoff 16:45
     3. MISSED — First Punch empty OR Last Punch empty

   For each flagged person: an "Email To" button opens her mail client with a
   pre-filled email (TO: employee, CC: direct manager + John + James + SUP team).
   No automated send — every email needs her review and explicit Send click.

   Anyone with an approved leave request covering the CSV's date is excluded
   automatically (they are on leave, not absent or late).

   Weekend rows (Friday/Saturday in KSA) are skipped entirely.
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
  const startStr  = scheduledStart || '08:00';
  const cutoffStr = lateCutoff     || '08:15';
  const body =
    'Dear ' + greetName + ',\n\n' +
    'I hope this finds you well. I am writing on behalf of HR regarding your attendance on ' + dateLong + '.\n\n' +
    'According to our time card records for that day, your punch-in was logged at ' + punchInStr + ', which puts you about ' + minutesLate + ' minutes after the ' + cutoffStr + ' grace window (with your scheduled start time of ' + startStr + ').\n\n' +
    'I understand that things come up — traffic, family matters, anything unexpected. If that was the case here, please reply with a short note so I can reflect it accurately in our records. If a planned reason is going to come up again, kindly inform your direct manager and HR in advance so we can plan around it together.\n\n' +
    'Otherwise, I would appreciate your attention to morning timing going forward. Repeated late arrivals without prior approval do feed into the performance evaluation cycle, and I would much rather we avoid that conversation altogether.\n\n' +
    'Thank you for understanding, and please do not hesitate to reach out if there is anything we can support you with.\n\n' +
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
  const [csvText, setCsvText] = useState('');
  const [csvFileName, setCsvFileName] = useState('');
  const [parseError, setParseError] = useState(null);
  const [approvedLeaves, setApprovedLeaves] = useState([]);
  const [acceptedShifts, setAcceptedShifts] = useState([]);
  const [sentMarkers, setSentMarkers] = useState({}); // key: row.id → true
  const [loggedMarkers, setLoggedMarkers] = useState({}); // key: 'empId:type' → true (P5)
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef(null);

  // Parse the CSV
  const parsed = useMemo(() => {
    if (!csvText) return { headers: [], rows: [] };
    try {
      return parseCsv(csvText);
    } catch (e) {
      return { headers: [], rows: [], err: e.message };
    }
  }, [csvText]);

  const csvDate = useMemo(() => detectCsvDate(parsed.rows), [parsed.rows]);
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

  // P5: pre-load already-logged violations for the CSV date so re-uploading
  // the same CSV (or revisiting after the page was closed) shows the rows
  // that have already been emailed as already-logged.
  useEffect(() => {
    if (!csvDate) { setLoggedMarkers({}); return; }
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'attendance_violations?select=employee_id,violation_type&violation_date=eq.' + csvDate
        );
        if (cancelled) return;
        const next = {};
        (rows || []).forEach(r => {
          if (r.employee_id && r.violation_type) {
            next[r.employee_id + ':' + r.violation_type] = true;
          }
        });
        setLoggedMarkers(next);
      } catch (e) {
        if (!cancelled) setLoggedMarkers({});
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
  const empById = useMemo(() => {
    const m = {};
    (employees || []).forEach(e => {
      if (e.id) m[String(e.id).toUpperCase()] = e;
      if (e.psn) m[String(e.psn).toUpperCase()] = e;
    });
    return m;
  }, [employees]);

  // Manager email lookup — given an employee, return their direct manager's email
  const getManagerEmail = useCallback((emp) => {
    if (!emp || !emp.manager_id) return null;
    const mgr = empById[String(emp.manager_id).toUpperCase()];
    return mgr?.email || null;
  }, [empById]);

  // Run detection
  const detection = useMemo(() => {
    const out = { late: [], early: [], missed: [], onTime: [], onLeave: [], unknownEmp: [] };
    if (!parsed.rows.length || csvIsWeekend) return out;

    parsed.rows.forEach((row, idx) => {
      const empIdRaw = row['Employee ID'] || row['employee_id'] || row['EmployeeID'] || row['ID'] || '';
      const empId = String(empIdRaw).trim();
      // Some CSVs have integer IDs without H prefix; tolerant lookup
      const lookupKey = empId.toUpperCase().startsWith('H') ? empId.toUpperCase() : ('H' + empId).toUpperCase();
      const emp = empById[empId.toUpperCase()] || empById[lookupKey] || null;
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
        });
        flagged = true;
      }
      // Early-leave check
      const earlyCutoffMin = timeToMinutes(sched.earlyCutoffStr);
      const scheduledEndMin = timeToMinutes(sched.endStr);
      if (punchOutMin < earlyCutoffMin) {
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
        });
        flagged = true;
      }
      if (!flagged) {
        out.onTime.push({ id: 'row-' + idx, employee: emp, punchInStr, punchOutStr });
      }
    });
    return out;
  }, [parsed.rows, empById, onLeaveOnDate, csvIsWeekend, shiftOverrideById]);

  // File handling
  const handleFile = useCallback((file) => {
    setParseError(null);
    if (!file) return;
    if (!/\.csv$/i.test(file.name) && !/\.cvs$/i.test(file.name)) {
      setParseError('Please upload a CSV file.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
      setCsvText(String(e.target?.result || ''));
      setCsvFileName(file.name);
      setSentMarkers({});
    };
    reader.onerror = () => setParseError('Could not read the file.');
    reader.readAsText(file);
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
    setCsvText(''); setCsvFileName(''); setParseError(null); setSentMarkers({});
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const markSent = (rowId) => setSentMarkers(prev => ({ ...prev, [rowId]: true }));

  // Build mailto for a row
  // P5: write a row to attendance_violations whenever Bashaier clicks an
  // email button. Idempotent — the unique constraint on
  // (employee_id, violation_date, violation_type) means a second click on
  // the same row gets a 23505 from Postgres, which we swallow as success.
  // Real schema (verified against live DB): id, employee_id, violation_date,
  // violation_type, minutes_off, punch_in_time, punch_out_time,
  // scheduled_start, scheduled_end, recorded_by, recorded_at, email_sent_at.
  const logViolation = useCallback(async ({ entry, violationType, minutesOff, punchInTime, punchOutTime, scheduledStart, scheduledEnd }) => {
    const empId = entry.employee.id;
    const markerKey = empId + ':' + violationType;
    // Optimistic: mark as logged immediately so the UI flips before the
    // network round trip. If the insert fails for an unexpected reason
    // (not a 23505 dup), we revert below.
    setLoggedMarkers(prev => ({ ...prev, [markerKey]: true }));
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
  const hasFile = !!csvText;

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
        <p className="text-sm mt-3 max-w-3xl" style={{ color: '#1F1B16' }}>
          Upload yesterday's <strong>Time Card export (CSV)</strong>. The system will flag late arrivals,
          early departures, and missed punches per ESAU policy. You review each notice and click Send in your mail client.
          Anyone with an approved leave on that date is excluded automatically.
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
            Drop your Time Card CSV here
          </div>
          <div className="text-sm" style={{ color: '#1F1B16' }}>
            or <span style={{ color: '#047857', textDecoration: 'underline', fontWeight: 600 }}>click to browse</span>
          </div>
          <div className="text-xs mt-4" style={{ color: '#1F1B16' }}>
            Expected columns: Employee ID, First Name, Department, Date, Weekday, First Punch, Last Punch, Total Time
          </div>
          <input ref={fileInputRef} type="file" accept=".csv,.cvs,text/csv" className="hidden" onChange={onPick}/>
          {parseError && (
            <div className="mt-4 text-sm" style={{ color: '#BE123C' }}>{parseError}</div>
          )}
        </div>
      ) : (
        <FileSummary
          fileName={csvFileName}
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
          onReset={reset}
        />
      )}

      {/* Sections — only show if file uploaded and not weekend */}
      {hasFile && csvIsWeekend && (
        <div className="rounded-2xl border p-6 text-center" style={{ borderColor: '#D4C7AB', background: '#FAF6EC' }}>
          <Calendar className="w-8 h-8 mx-auto mb-3" style={{ color: '#1F1B16' }}/>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: '18px', color: '#1F1B16' }}>This was a weekend day.</div>
          <div className="text-sm mt-2" style={{ color: '#1F1B16' }}>
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
            entries={detection.late.map(e => ({
              ...e,
              detail: 'Punched in at ' + e.punchInStr + ' — ' + e.minutesLate + ' min after grace period'
                + (e.isCustomShift ? ' · ' + e.scheduleLabel : ''),
              metaIcon: <Clock className="w-4 h-4"/>,
              logged: !!loggedMarkers[e.employee.id + ':late'],
            }))}
            renderButton={(entry) => (
              <RowButton
                onClick={() => handleEmailLate(entry)}
                onMarkSent={() => markSent(entry.id)}
                sent={!!sentMarkers[entry.id]}
                logged={entry.logged}
                label="Email lateness notice"
              />
            )}
          />

          <FlaggedSection
            title="Early departures"
            kicker="LEFT BEFORE GRACE WINDOW"
            iconColor="#A16207"
            barFrom="#FACC15" barTo="#A16207"
            empty="Nobody left early — full day attendance recorded."
            entries={detection.early.map(e => ({
              ...e,
              detail: 'Punched out at ' + e.punchOutStr + ' — ' + e.minutesEarly + ' min before scheduled ' + e.scheduledEnd
                + (e.isCustomShift ? ' · ' + e.scheduleLabel : (e.isSup ? ' (SUP team)' : '')),
              metaIcon: <Briefcase className="w-4 h-4"/>,
              logged: !!loggedMarkers[e.employee.id + ':early_leave'],
            }))}
            renderButton={(entry) => (
              <RowButton
                onClick={() => handleEmailEarly(entry)}
                onMarkSent={() => markSent(entry.id)}
                sent={!!sentMarkers[entry.id]}
                logged={entry.logged}
                label="Email early-departure notice"
              />
            )}
          />

          <FlaggedSection
            title="Missed punches"
            kicker="REMINDER + ESCALATION NOTE"
            iconColor="#1D4ED8"
            barFrom="#60A5FA" barTo="#1D4ED8"
            empty="All staff punched in and out — perfect compliance."
            entries={detection.missed.map(e => {
              const types = e.missingType === 'both' ? ['missed_in', 'missed_out']
                : e.missingType === 'in' ? ['missed_in'] : ['missed_out'];
              const allLogged = types.every(t => loggedMarkers[e.employee.id + ':' + t]);
              return ({
                ...e,
                detail: (e.missingType === 'in'  ? 'Missing punch-in (no first-punch on record)'
                      : e.missingType === 'out' ? 'Missing punch-out (no last-punch on record)'
                      : 'Missing both punch-in and punch-out')
                  + (e.isCustomShift ? ' · ' + e.scheduleLabel : ''),
                metaIcon: <AlertTriangle className="w-4 h-4"/>,
                logged: allLogged,
              });
            })}
            renderButton={(entry) => (
              <RowButton
                onClick={() => handleEmailMissed(entry)}
                onMarkSent={() => markSent(entry.id)}
                sent={!!sentMarkers[entry.id]}
                logged={entry.logged}
                label="Email reminder"
              />
            )}
          />

          {/* Approved leaves (excluded) */}
          {detection.onLeave.length > 0 && (
            <div className="rounded-2xl border p-5" style={{ borderColor: '#D4C7AB', background: '#FAF6EC' }}>
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
            <div className="rounded-2xl border p-5" style={{ borderColor: '#FCA5A5', background: '#FEF2F2' }}>
              <div className="text-[10px] mb-1" style={{ color: '#991B1B', letterSpacing: '0.25em', fontWeight: 700 }}>
                ⚠ UNRECOGNISED EMPLOYEES IN CSV ({detection.unknownEmp.length})
              </div>
              <div className="text-sm" style={{ color: '#1F1B16' }}>
                These IDs were in the CSV but are not in the employee directory.
                Check the IDs and re-upload, or ask Admin to add the missing employees.
              </div>
              <ul className="mt-2 text-sm space-y-1" style={{ color: '#1F1B16' }}>
                {detection.unknownEmp.map(u => (
                  <li key={u.id}><span style={{ fontWeight: 600 }}>{u.empId}</span> — {u.csvName || 'unknown'}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function FileSummary({ fileName, csvDate, isWeekend, totalRows, counts, onReset }) {
  return (
    <div className="rounded-2xl border bg-white p-5" style={{ borderColor: '#D4C7AB' }}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
            UPLOADED FILE
          </div>
          <div className="flex items-center gap-2" style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#1F1B16' }}>
            <FileText className="w-5 h-5"/> {fileName}
          </div>
          <div className="text-sm mt-2" style={{ color: '#1F1B16' }}>
            <strong>Date detected:</strong> {csvDate ? formatDateLong(csvDate) : 'unknown'}
            {isWeekend && <span style={{ color: '#A16207', marginLeft: '8px' }}>(KSA weekend — skipped)</span>}
            {' · '}<strong>{totalRows}</strong> rows parsed
          </div>
        </div>
        <button
          onClick={onReset}
          className="text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5"
          style={{ borderColor: '#D4C7AB', color: '#1F1B16' }}>
          <X className="w-3.5 h-3.5"/> Upload different file
        </button>
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

function FlaggedSection({ title, kicker, iconColor, barFrom, barTo, entries, empty, renderButton }) {
  if (!entries.length) {
    return (
      <div className="rounded-2xl border bg-white p-5" style={{ borderColor: '#D4C7AB' }}>
        <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>{kicker}</div>
        <div style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#1F1B16' }}>{title}</div>
        <div className="flex items-center gap-2 mt-3" style={{ color: '#047857' }}>
          <CheckCircle2 className="w-4 h-4"/>
          <span className="text-sm">{empty}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-2xl border bg-white p-5" style={{ borderColor: '#D4C7AB' }}>
      <div className="text-[10px] mb-1" style={{ color: iconColor, letterSpacing: '0.25em', fontWeight: 700 }}>
        {kicker} · {entries.length}
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
                  <div style={{ fontWeight: 700, color: '#1F1B16', fontSize: '15px' }}>
                    {entry.employee.name}
                    <span className="text-xs font-normal ml-2" style={{ color: '#1F1B16' }}>
                      · {entry.employee.id || entry.employee.psn || ''} · {entry.employee.department || ''}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 text-xs" style={{ color: '#1F1B16' }}>
                    {entry.metaIcon} {entry.detail}
                  </div>
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

function RowButton({ onClick, onMarkSent, sent, logged, label }) {
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
