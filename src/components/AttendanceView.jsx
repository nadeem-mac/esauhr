import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Upload, FileText, Clock, AlertTriangle, Mail, CheckCircle2,
  X, Calendar, Briefcase, Users, Send, Sparkles
} from 'lucide-react';
import { directGet } from '../supabaseClient.js';

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

const HR_SIGNATURE = 'Bashaier Ali Alsubaie\\nHR Department\\nEvergreen Shipping Agency Saudi';

// ────────────────────────────────────────────────────────────────────────
// CSV parsing — handles quoted fields, returns array of row-objects keyed
// by header. Tolerant of trailing whitespace, BOM, mixed line endings.
// ────────────────────────────────────────────────────────────────────────
function parseCsv(text) {
  // Strip BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const lines = text.split(/\\r\\n|\\n|\\r/).filter(l => l.trim().length > 0);
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
  const m = trimmed.match(/^(\\d{1,2}):(\\d{2})(?::\\d{2})?\\s*(AM|PM|am|pm)?$/);
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

// Department check — SUP team has 8-4 hours.
function isSupDept(dept) {
  return /^sup/i.test((dept || '').trim());
}

// Lookup the schedule for an employee based on their department.
function scheduleFor(dept) {
  if (isSupDept(dept)) {
    return { startStr: OFFICIAL_START, endStr: SUP_END, lateCutoffStr: LATE_CUTOFF, earlyCutoffStr: SUP_EARLY_CUTOFF };
  }
  return { startStr: OFFICIAL_START, endStr: STD_END, lateCutoffStr: LATE_CUTOFF, earlyCutoffStr: STD_EARLY_CUTOFF };
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
  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(s)) return s;
  // DD/MM/YYYY or DD-MM-YYYY
  let m = s.match(/^(\\d{1,2})[\\/\\-](\\d{1,2})[\\/\\-](\\d{4})$/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  // YYYY/MM/DD
  m = s.match(/^(\\d{4})[\\/\\-](\\d{1,2})[\\/\\-](\\d{1,2})$/);
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
function lateEmailContent({ employee, dateLong, punchInStr, minutesLate }) {
  const subject = 'Late Arrival Notice — ' + dateLong + ' — ' + (employee.name || '');
  const body =
    'Dear ' + (employee.first_name || employee.name?.split(' ')[0] || '') + ',\\n\\n' +
    'This is a formal notice regarding your late arrival on ' + dateLong + '.\\n\\n' +
    'Per ESAU policy, the official clock-in time is 08:00 with a grace period until 08:15. ' +
    'Our records show that you punched in at ' + punchInStr + ' — ' + minutesLate + ' minutes after the grace period.\\n\\n' +
    'Please ensure timely attendance going forward. Repeated lateness without prior approval ' +
    'may be reflected in your performance evaluation.\\n\\n' +
    'If there were extenuating circumstances on this day, please reply with an explanation so we can update our records.\\n\\n' +
    'Best regards,\\n' + HR_SIGNATURE;
  return { subject, body };
}

function earlyLeaveEmailContent({ employee, dateLong, punchOutStr, scheduledEnd, minutesEarly }) {
  const subject = 'Early Departure Notice — ' + dateLong + ' — ' + (employee.name || '');
  const body =
    'Dear ' + (employee.first_name || employee.name?.split(' ')[0] || '') + ',\\n\\n' +
    'This is a formal notice regarding your early departure on ' + dateLong + '.\\n\\n' +
    'Per your scheduled working hours (08:00 to ' + scheduledEnd + '), employees are expected ' +
    'to remain at work until the end of the day unless prior approval has been obtained. ' +
    'Our records show that you punched out at ' + punchOutStr + ', which is ' + minutesEarly + ' minutes earlier than your scheduled end time.\\n\\n' +
    'Please ensure that any early departure is approved in advance by your direct manager and ' +
    'recorded as a permission request in the HR system.\\n\\n' +
    'If this departure was approved or there were extenuating circumstances, please reply with the relevant context.\\n\\n' +
    'Best regards,\\n' + HR_SIGNATURE;
  return { subject, body };
}

function missedPunchEmailContent({ employee, dateLong, missingType }) {
  // missingType: 'in' | 'out' | 'both'
  const what = missingType === 'in'   ? 'a punch-in entry'
            : missingType === 'out'  ? 'a punch-out entry'
            : 'both punch-in and punch-out entries';
  const subject = 'Reminder: Time Card Punch Missing — ' + dateLong + ' — ' + (employee.name || '');
  const body =
    'Dear ' + (employee.first_name || employee.name?.split(' ')[0] || '') + ',\\n\\n' +
    'We noticed that your time card for ' + dateLong + ' is missing ' + what + '.\\n\\n' +
    'A reminder from HR: timely punch-in and punch-out are required for accurate attendance ' +
    'records, payroll, and overtime tracking. We rely on these records as part of our compliance ' +
    'with company policy and Saudi labor regulations.\\n\\n' +
    'Please make sure to punch in and out every working day. If your card or terminal had issues ' +
    'on ' + dateLong + ', please reply with the actual times so we can correct the record.\\n\\n' +
    'If missed punches continue, this may be escalated to a formal evaluation warning per HR procedure.\\n\\n' +
    'We are here to help — please reach out if you need any support.\\n\\n' +
    'Best regards,\\n' + HR_SIGNATURE;
  return { subject, body };
}

// Build a mailto: URL with the proper TO + CC + subject + body.
function buildMailto({ to, cc, subject, body }) {
  const params = new URLSearchParams();
  params.set('cc', cc.filter(Boolean).join(','));
  params.set('subject', subject);
  params.set('body', body);
  return 'mailto:' + (to || '') + '?' + params.toString();
}

// ────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ────────────────────────────────────────────────────────────────────────
export default function AttendanceView({ me, employees }) {
  const [csvText, setCsvText] = useState('');
  const [csvFileName, setCsvFileName] = useState('');
  const [parseError, setParseError] = useState(null);
  const [approvedLeaves, setApprovedLeaves] = useState([]);
  const [sentMarkers, setSentMarkers] = useState({}); // key: row.id → true
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

  const onLeaveOnDate = useCallback((empId) => {
    return approvedLeaves.some(l => String(l.employee_id) === String(empId));
  }, [approvedLeaves]);

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

    const lateCutoffMin = timeToMinutes(LATE_CUTOFF);

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
      const sched = scheduleFor(dept);
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
          scheduledEnd: sched.endStr,
          minutesEarly: scheduledEndMin - punchOutMin,
          isSup: isSupDept(dept),
        });
        flagged = true;
      }
      if (!flagged) {
        out.onTime.push({ id: 'row-' + idx, employee: emp, punchInStr, punchOutStr });
      }
    });
    return out;
  }, [parsed.rows, empById, onLeaveOnDate, csvIsWeekend]);

  // File handling
  const handleFile = useCallback((file) => {
    setParseError(null);
    if (!file) return;
    if (!/\\.csv$/i.test(file.name) && !/\\.cvs$/i.test(file.name)) {
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
  const handleEmailLate = (entry) => {
    const dateLong = formatDateLong(csvDate);
    const { subject, body } = lateEmailContent({
      employee: entry.employee,
      dateLong,
      punchInStr: entry.punchInStr,
      minutesLate: entry.minutesLate + 15, // total minutes after 08:00
    });
    const cc = [getManagerEmail(entry.employee), ...FIXED_CC].filter(Boolean);
    const url = buildMailto({ to: entry.employee.email, cc, subject, body });
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
              detail: 'Punched in at ' + e.punchInStr + ' — ' + e.minutesLate + ' min after grace period',
              metaIcon: <Clock className="w-4 h-4"/>,
            }))}
            renderButton={(entry) => (
              <RowButton
                onClick={() => handleEmailLate(entry)}
                onMarkSent={() => markSent(entry.id)}
                sent={!!sentMarkers[entry.id]}
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
              detail: 'Punched out at ' + e.punchOutStr + ' — ' + e.minutesEarly + ' min before scheduled ' + e.scheduledEnd + (e.isSup ? ' (SUP team)' : ''),
              metaIcon: <Briefcase className="w-4 h-4"/>,
            }))}
            renderButton={(entry) => (
              <RowButton
                onClick={() => handleEmailEarly(entry)}
                onMarkSent={() => markSent(entry.id)}
                sent={!!sentMarkers[entry.id]}
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
            entries={detection.missed.map(e => ({
              ...e,
              detail: e.missingType === 'in'  ? 'Missing punch-in (no first-punch on record)'
                    : e.missingType === 'out' ? 'Missing punch-out (no last-punch on record)'
                    : 'Missing both punch-in and punch-out',
              metaIcon: <AlertTriangle className="w-4 h-4"/>,
            }))}
            renderButton={(entry) => (
              <RowButton
                onClick={() => handleEmailMissed(entry)}
                onMarkSent={() => markSent(entry.id)}
                sent={!!sentMarkers[entry.id]}
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

function RowButton({ onClick, onMarkSent, sent, label }) {
  if (sent) {
    return (
      <div className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-full" style={{ background: '#ECFDF5', color: '#047857', fontWeight: 700 }}>
        <CheckCircle2 className="w-4 h-4"/> Email Sent
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
    </div>
  );
}
