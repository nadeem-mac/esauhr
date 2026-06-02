import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Upload, FileText, Clock, AlertTriangle, Mail, CheckCircle2,
  X, Calendar, Briefcase, Users, Send, Sparkles, Anchor, FileSpreadsheet,
  ShieldAlert,
} from 'lucide-react';
import { directGet, directPost } from '../supabaseClient.js';
import { parseTimeCardXlsx, TimeCardParseError } from '../lib/timeCard.js';
import { buildAttendanceRows, recordAttendanceRows } from '../lib/attendanceRecorder.js';
// Phase A re-eval entry point — used by Phase C for the post-upload
// trigger, the manual "re-evaluate last 7 days" button, and the
// stale-check on mount. The full backfill pipeline stays on its own
// page; this helper bounds the scan to a tight 7-day window so the
// daily flow's re-eval is fast and predictable.
import { reevaluateLastNDays } from '../lib/attendanceBackfill.js';
import { localDateString, todayLocal, monthStart as monthStartIso, monthEnd as monthEndIso, addDaysIso } from '../lib/dateUtils.js';
import AttendanceMonthGrid from './AttendanceMonthGrid.jsx';
import AttendanceBackfillPanel from './AttendanceBackfillPanel.jsx';
import WorkingHoursManager from './WorkingHoursManager.jsx';
import EmployeeAttendanceDetailPanel from './EmployeeAttendanceDetailPanel.jsx';
import RepeatOffendersCard from './RepeatOffendersCard.jsx';
import ManagerRollupCard from './ManagerRollupCard.jsx';
import EvaluationExplainModal from './EvaluationExplainModal.jsx';
import SilentAbsencesCard from './SilentAbsencesCard.jsx';
import ShiftStaffAttendanceReportCard from './ShiftStaffAttendanceReportCard.jsx';
import ShiftComplianceCard from './ShiftComplianceCard.jsx';
import HolidayShiftDefaultersCard from './HolidayShiftDefaultersCard.jsx';
import HQAttendanceExportCard from './HQAttendanceExportCard.jsx';

// ─── Error Boundary for AttendanceView sections ───────────────────────
// Without this, a render-time exception anywhere in the tree under
// AttendanceView (a bad accessor in AttendanceMonthGrid on fresh
// data, a malformed shift row from the planner, an undefined
// memo) would unmount the whole page — Bashaier sees a blank
// screen with no recourse but to refresh.
//
// The boundary catches the error, displays the message in red, and
// keeps the rest of the page (upload area, processed report,
// weekend section) usable. Console gets the full stack trace for
// debugging.
import { reportClientError } from '../lib/clientErrors.js';

class AttendanceErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, sessionId: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // Tier 2 fix (#5 / item 1) — pipe the boundary catch through the
    // central reporter so we get a session-tagged paper trail in
    // console + localStorage. Capture the returned sessionId so the
    // user-visible message can quote it for support.
    const sessionId = reportClientError({
      kind: 'boundary',
      label: this.props.label || 'AttendanceView',
      error,
      info,
    });
    // Pull the first ~600 chars of the component stack so we can
    // surface WHICH component is throwing (especially useful for
    // hook-order errors like #310 where the inner component is the
    // culprit but the boundary label is generic).
    const componentStack = (info?.componentStack || '').split('\n').slice(0, 8).join('\n');
    this.setState({ sessionId, componentStack });
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border p-4"
          style={{ borderColor: '#FCA5A5', background: '#FEF2F2', color: '#991B1B' }}>
          <div className="text-[10px] tracking-widest font-bold mb-1">
            {this.props.label ? `${this.props.label.toUpperCase()} FAILED TO RENDER` : 'SECTION FAILED TO RENDER'}
          </div>
          <div className="text-xs font-mono break-all">
            {String(this.state.error?.message || this.state.error)}
          </div>
          {this.state.componentStack && (
            <pre className="text-[10px] mt-2 p-2 rounded font-mono whitespace-pre-wrap"
              style={{ background: '#FFFFFF', border: '1px solid #FCA5A5', color: '#7F1D1D', maxHeight: 200, overflow: 'auto' }}>
              {this.state.componentStack}
            </pre>
          )}
          <div className="text-[10px] mt-2 opacity-70">
            Open the browser DevTools console for the full stack trace. The rest of the page remains usable.
            {this.state.sessionId && (
              <> &middot; Session id: <code style={{ background: '#FFF', padding: '0 4px', borderRadius: 3 }}>{this.state.sessionId}</code></>
            )}
          </div>
          <button
            onClick={() => this.setState({ error: null, sessionId: null, componentStack: null })}
            className="text-[11px] mt-2 px-3 py-1 rounded-full"
            style={{ background: '#991B1B', color: '#FFFFFF', fontWeight: 600 }}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── AttendanceSidebar ────────────────────────────────────────────────
// Vertical nav sidebar that drives the Attendance page's master/detail
// layout. Lists the discrete functions Bashaier uses (calendar,
// daily upload, schedules, Mawani, backfill); clicking sets activeView
// in the parent so the right pane renders the matching content.
//
// Layout:
//   • Desktop: 220px-wide column on the left, sticky to the top so it
//     stays in view when the right-pane content scrolls.
//   • Narrow viewports: collapses to a horizontal pill bar that wraps.
//     The wrap fallback keeps nav reachable on phones without forcing
//     a hamburger menu — Bashaier opens this on her work laptop most
//     of the time.
//
// Visual:
//   • Subtle paper-white card with light border; no decorative
//     gradients (Nadeem asked to remove the bouncy/decorative
//     treatments).
//   • Active item: solid ink-dark background, white text.
//   • Idle items: muted text on transparent bg, light hover.
//   • Each item has a tiny icon + the label.
function AttendanceSidebar({ activeView, setActiveView, setupComplete, escapeHatchActive }) {
  const allItems = [
    // Phase B (Decision #6 / option A): the previously-separate
    // "Monthly overview" and "Daily upload" entries are merged into a
    // single "Attendance" workspace. Calendar memory and daily action
    // now live on the same page — top: upload bar, middle: action
    // dashboard, bottom: calendar. Maintains a single sidebar id of
    // 'attendance' (the legacy 'calendar' and 'daily' ids both route
    // here for back-compat with deep links).
    { id: 'attendance', icon: <Calendar className="w-4 h-4" />,        label: 'Attendance',           hint: 'Calendar + daily upload' },
    // Working hours and Mawani visits moved to per-employee context
    // (employee detail card) — they were rarely-used global views and
    // belonged better alongside the staff record they describe.
    { id: 'backfill',   icon: <FileSpreadsheet className="w-4 h-4" />,  label: 'Historical backfill',  hint: 'Sep last year → Sep this year' },
  ];
  const items = allItems.filter(it => !it.hidden);
  return (
    <nav
      aria-label="Attendance sections"
      style={{
        flex: '0 0 220px',
        minWidth: 220,
        maxWidth: '100%',
        background: '#FFFFFF',
        border: '1px solid #E5E5E5',
        borderRadius: 12,
        padding: 8,
        position: 'sticky',
        top: 12,
        alignSelf: 'flex-start',
        fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.22em',
          color: '#1F1B16',
          fontWeight: 700,
          padding: '8px 10px 6px',
          opacity: 0.65,
        }}
      >
        ATTENDANCE
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {items.map(it => {
          const active = activeView === it.id;
          return (
            <li key={it.id} style={{ marginBottom: 2 }}>
              <button
                onClick={() => setActiveView(it.id)}
                aria-current={active ? 'page' : undefined}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: active ? '#1F1B16' : 'transparent',
                  color: active ? '#FFFFFF' : '#1F1B16',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 13,
                  fontWeight: active ? 700 : 500,
                  textAlign: 'left',
                  transition: 'background 0.15s ease, color 0.15s ease',
                }}
                onMouseEnter={(e) => {
                  if (!active) e.currentTarget.style.background = '#F5F5F5';
                }}
                onMouseLeave={(e) => {
                  if (!active) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{ flexShrink: 0, opacity: active ? 1 : 0.75 }}>{it.icon}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block' }}>{it.label}</span>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 10,
                      fontWeight: 400,
                      opacity: active ? 0.8 : 0.55,
                      marginTop: 1,
                    }}
                  >
                    {it.hint}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ─── ZoneHeader ───────────────────────────────────────────────────────
// Visual divider used at the top of each of AttendanceView's three
// zones. Gives Bashaier a clear "you are now in [zone]" beat so the
// page reads as three distinct flows rather than one wall of widgets:
//
//   Zone 1 — SEE                  the monthly overview / dashboard
//   Zone 2 — DO EVERY DAY         the daily upload + results
//   Zone 3 — ONE-TIME SETUP       the historical backfill panel
//
// Visual: a numbered circle on the left (the zone number, dimmed),
// a kicker label above the title (e.g. "DO EVERY DAY"), the title
// itself in serif, and a one-paragraph explainer underneath. The
// `accent` prop tints the kicker + circle border so each zone has
// its own subtle color.
function ZoneHeader({ number, kicker, title, body, accent = '#1F1B16' }) {
  return (
    <div
      className="flex items-start gap-3 mt-2"
      style={{ paddingTop: 14, borderTop: '1px solid #E5E5E5' }}
    >
      <div
        className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
        style={{
          background: '#FFFFFF',
          border: `1.5px solid ${accent}`,
          color: accent,
          fontFamily: 'inherit',
          fontSize: 16,
          fontWeight: 700,
          marginTop: 2,
        }}
        aria-hidden
      >
        {number}
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-[10px] mb-1"
          style={{ color: accent, letterSpacing: '0.25em', fontWeight: 700 }}
        >
          {kicker}
        </div>
        <div
          style={{
            fontFamily: 'inherit',
            fontSize: 22,
            color: '#1F1B16',
            lineHeight: 1.15,
          }}
        >
          {title}
        </div>
        {body && (
          <p
            className="text-sm mt-1.5 max-w-3xl"
            style={{ color: '#0A0A0A', opacity: 0.78, lineHeight: 1.5 }}
          >
            {body}
          </p>
        )}
      </div>
    </div>
  );
}

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
const LATE_CUTOFF      = '08:15';   // after this = late (15-min arrival grace preserved)
const SUP_END          = '16:00';   // SUP team scheduled end (4 PM)
const SUP_EARLY_CUTOFF = '16:00';   // strict — any departure before 16:00 = early
const STD_END          = '17:00';   // other depts scheduled end (5 PM)
const STD_EARLY_CUTOFF = '17:00';   // strict — any departure before 17:00 = early
// Note (Nadeem 2026-05-10): early-departure has no grace window.
// Check-out time is enforced strictly — leaving even one minute
// before scheduled end is flagged. Late arrival keeps its 15-min
// grace at LATE_CUTOFF; only the departure side is strict.

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

// Helper — formats the staff's full month of manager-assigned shifts
// as a plain-text block for inclusion in violation emails. Per Nadeem
// (2026-05-06): "shift staff when there is an email, they must be
// shown what dates and days their managers have approved for them".
// The violationDate (YYYY-MM-DD) is highlighted with a ▶ marker so the
// staff sees exactly which row this email is about within the full
// schedule. Returns empty string if list is empty.
function buildAssignedShiftsBlock(shifts, violationDate, divider) {
  if (!Array.isArray(shifts) || shifts.length === 0) return '';
  const dayName = (dStr) => {
    try {
      const [y, m, d] = String(dStr).split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short' });
    } catch { return ''; }
  };
  const dayLong = (dStr) => {
    try {
      const [y, m, d] = String(dStr).split('-').map(Number);
      return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    } catch { return dStr; }
  };
  const lines = shifts.map(s => {
    const isViolation = String(s.date) === String(violationDate);
    const overnight = s.startStr && s.endStr && s.startStr > s.endStr;
    const timeStr = (s.startStr || '') + ' \u2192 ' + (s.endStr || '') + (overnight ? ' (overnight)' : '');
    const marker = isViolation ? '\u25B6' : '\u2022';
    const suffix = isViolation ? '   \u2190 THIS DATE' : '';
    return marker + ' ' + dayName(s.date) + ', ' + dayLong(s.date) + '  \u2014  ' + timeStr + suffix;
  });
  // Try to extract the YYYY-MM from the first shift to title the
  // block with the actual month — falls back to a generic title.
  let monthLabel = 'this month';
  try {
    const first = shifts[0]?.date;
    if (first) {
      const [y, m] = first.split('-').map(Number);
      monthLabel = new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    }
  } catch { /* ignore */ }
  return 'YOUR ASSIGNED SHIFTS — ' + monthLabel.toUpperCase() + ' (set by your line manager):\n'
    + divider + '\n'
    + lines.join('\n') + '\n'
    + divider + '\n\n';
}

function lateEmailContent({ employee, dateLong, punchInStr, minutesLate, scheduledStart, lateCutoff, isCustomShift, scheduleLabel, isNightShiftStart, assignedBy, assignedAt, managerName, assignedShifts, violationDate, staffHasShifts }) {
  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  // Shift staff get a distinct subject prefix so the inbox makes
  // it obvious this is a shift-attendance violation, not the
  // standard 8 AM office one. Per Nadeem (2026-05-06): shift staff
  // need the same email mechanism as office staff but with their
  // own title.
  // Treat the staff as on shift-flow when EITHER the specific row was
  // evaluated as a shift OR they are on the monthly shift roster (so
  // shift workers feel acknowledged even on dates the manager hadn'''t
  // explicitly assigned). Wording that describes what was actually
  // measured (shift-IN vs punch-in, 8:00 AM bullet) stays gated on
  // the narrower isCustomShift.
  const isShiftFlow = !!(isCustomShift || staffHasShifts);
  const subjectPrefix = isShiftFlow
    ? (isNightShiftStart ? 'Shift Late Arrival Notice (Night Shift)' : 'Shift Late Arrival Notice')
    : 'Late Arrival Notice';
  const subject = subjectPrefix + ' — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  // Policy bullets — bullet 1+2 swap for shift staff so the email
  // references their actual scheduled start instead of the standard
  // 8:00 AM office time. Bullet 3 (3 permissions/month entitlement)
  // applies to everyone uniformly.
  const startStr12h = scheduledStart ? fmtTime12h(scheduledStart) : '8:00 AM';
  const cutoffStr12h = lateCutoff ? fmtTime12h(lateCutoff) : '8:15 AM';
  const policyBullets = isCustomShift
    ? [
        '\u2022 Your scheduled shift start is ' + startStr12h + (isNightShiftStart ? ' (overnight shift to next morning)' : '') + '.',
        '\u2022 A 15-minute grace period is allowed; arrivals after ' + cutoffStr12h + ' are recorded as late.',
        '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
      ]
    : [
        '\u2022 The official clock-in time is 8:00 AM on regular working days.',
        '\u2022 A 15-minute grace period is allowed; arrivals after 8:15 AM are recorded as late.',
        '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
      ];

  const divider = '='.repeat(71);

  // Body — for shift staff, mention the assigned shift label so they
  // see exactly which shift was missed. The opening sentence wording
  // adapts: office uses "punch-in", shift uses "shift-IN punch".
  const punchPhrase = isCustomShift ? 'shift-IN punch' : 'punch-in';
  const shiftContext = isCustomShift && scheduleLabel
    ? ' Your assigned ' + scheduleLabel.toLowerCase() + ' begins at ' + startStr12h + '.'
    : '';
  // Manager attribution paragraph — shown only for shift entries.
  // Tells the staff member exactly who set their shift schedule and
  // when, so they understand why the violation is being flagged.
  // Per Nadeem (2026-05-06): "remind the staff this manager has
  // assigned the days and time".
  const assignmentPara = (isCustomShift && (managerName || assignedBy))
    ? 'This shift schedule (start ' + startStr12h + (isNightShiftStart ? ', overnight' : '') + ') was set by your line manager'
      + (assignedAt ? ' on ' + new Date(assignedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
      + ' through the ESAU HR Portal. Your acknowledgment of the shift is on file in the same system.\n\n'
    : '';

  // No-assignment clarifier — only fires when the staff is on the
  // monthly shift roster (staffHasShifts) but the SPECIFIC date in
  // question had no shift on file (so isCustomShift came through
  // false and the row fell back to office-hours evaluation). This
  // explains to the staff why their email looks office-style even
  // though they're a shift worker, and points them at the roster
  // block to verify their schedule.
  // No-assignment clarifier — fires when the staff is on a shift
  // roster (staffHasShifts) but the SPECIFIC date had no shift on
  // file. Two sub-cases:
  //   (a) staff has OTHER shifts in the month → ask them to verify
  //       with their manager and reference the roster block below
  //   (b) staff is on monthly_shift_plans roster but NO specific
  //       per-date entries yet → ask them to chase their manager
  //       to enter the schedule (Jasim's case, 2026-05-07)
  const hasAnyMonthShifts = Array.isArray(assignedShifts) && assignedShifts.length > 0;
  const noAssignmentNote = (staffHasShifts && !isCustomShift)
    ? (hasAnyMonthShifts
        ? 'Note: you are on the shift roster for this month (see the schedule below). However, no specific shift was assigned for ' + dateLong + ' in the ESAU HR Portal, so the punches for this date were evaluated against the standard office-hours window. If a shift should have been assigned for this date, please raise it with your line manager so the schedule can be corrected.\n\n'
        : 'Note: you are flagged as a shift worker on this month\u2019s roster, but your line manager has not yet entered specific shift dates and times for you in the ESAU HR Portal. Without an entered schedule, the system cannot evaluate your punches against your actual shift hours \u2014 please coordinate with your line manager so the schedule can be entered, after which the attendance log can be re-evaluated.\n\n')
    : '';
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows your ' + punchPhrase + ' at ' + punchInStr + ', ' + minutesLate + ' minutes past the 15-minute grace period and with no approved permission on file. This is recorded as a late-arrival violation.' + shiftContext + '\n\n' +
    assignmentPara +
    noAssignmentNote +
    buildAssignedShiftsBlock(assignedShifts, violationDate, divider) +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    policyBullets.join('\n') + '\n' +
    divider + '\n\n' +
    'You are still required to submit a late-arrival permission request via the ESAU HR Portal (esauhr.netlify.app \u2192 New Request \u2192 Permission) for today\u2019s ' + punchPhrase + '. Submitting it after the fact lets HR record the reason and consider it against your monthly entitlement. Without an approved permission, the day stands as an unexcused violation on your evaluation record.\n\n' +
    'For exceptional cases (medical, official, or other documented emergencies that go beyond the monthly entitlement), please reply to this email within two working days with the supporting details.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

function earlyLeaveEmailContent({ employee, dateLong, punchOutStr, scheduledEnd, minutesEarly, isCustomShift, scheduleLabel, isNightShiftEnd, scheduledStart, assignedBy, assignedAt, managerName, assignedShifts, violationDate, staffHasShifts }) {
  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  const isShiftFlow = !!(isCustomShift || staffHasShifts);
  const subjectPrefix = isShiftFlow
    ? (isNightShiftEnd ? 'Shift Early Departure Notice (Night Shift)' : 'Shift Early Departure Notice')
    : 'Early Departure Notice';
  const subject = subjectPrefix + ' — ' + psn + ' ' + fullName + ' — ' + dateLong;
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

  // Policy bullets — bullet 1+2 personalized to the staff's actual
  // scheduled clock-out time and grace cutoff. For shift staff,
  // the wording shifts from "regular working days" to the assigned
  // shift label so it matches how their schedule was set.
  const policyBullets = isCustomShift
    ? [
        '\u2022 Your scheduled shift end is ' + endStr12h + (isNightShiftEnd ? ' (overnight shift completed in the morning)' : '') + '.',
        '\u2022 Any departure before ' + endStr12h + ' is recorded as early leave \u2014 no grace period applies on the clock-out side.',
        '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
      ]
    : [
        '\u2022 Your scheduled clock-out time is ' + endStr12h + ' on regular working days.',
        '\u2022 Any departure before ' + endStr12h + ' is recorded as early leave \u2014 no grace period applies on the clock-out side.',
        '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
      ];

  // Divider — 71 equals signs, character + count both confirmed by
  // Nadeem against the late-arrival email's rendering in his actual
  // mail client. Re-test in production if the bullets are rewritten
  // and the visual fit looks off.
  const divider = '='.repeat(71);

  // Body — for shift staff, mention the assigned shift label in the
  // opening so they see exactly which shift they left early on.
  const punchPhrase = isCustomShift ? 'shift-OUT punch' : 'punch-out';
  const shiftContext = isCustomShift && scheduleLabel
    ? ' Your assigned ' + scheduleLabel.toLowerCase() + ' ends at ' + endStr12h + '.'
    : '';
  const assignmentPara = (isCustomShift && (managerName || assignedBy))
    ? 'This shift schedule (end ' + endStr12h + (isNightShiftEnd ? ', overnight completing today' : '') + ') was set by your line manager'
      + (assignedAt ? ' on ' + new Date(assignedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
      + ' through the ESAU HR Portal. Your acknowledgment of the shift is on file in the same system.\n\n'
    : '';

  // No-assignment clarifier — only fires when the staff is on the
  // monthly shift roster (staffHasShifts) but the SPECIFIC date in
  // question had no shift on file (so isCustomShift came through
  // false and the row fell back to office-hours evaluation). This
  // explains to the staff why their email looks office-style even
  // though they're a shift worker, and points them at the roster
  // block to verify their schedule.
  // No-assignment clarifier — fires when the staff is on a shift
  // roster (staffHasShifts) but the SPECIFIC date had no shift on
  // file. Two sub-cases:
  //   (a) staff has OTHER shifts in the month → ask them to verify
  //       with their manager and reference the roster block below
  //   (b) staff is on monthly_shift_plans roster but NO specific
  //       per-date entries yet → ask them to chase their manager
  //       to enter the schedule (Jasim's case, 2026-05-07)
  const hasAnyMonthShifts = Array.isArray(assignedShifts) && assignedShifts.length > 0;
  const noAssignmentNote = (staffHasShifts && !isCustomShift)
    ? (hasAnyMonthShifts
        ? 'Note: you are on the shift roster for this month (see the schedule below). However, no specific shift was assigned for ' + dateLong + ' in the ESAU HR Portal, so the punches for this date were evaluated against the standard office-hours window. If a shift should have been assigned for this date, please raise it with your line manager so the schedule can be corrected.\n\n'
        : 'Note: you are flagged as a shift worker on this month\u2019s roster, but your line manager has not yet entered specific shift dates and times for you in the ESAU HR Portal. Without an entered schedule, the system cannot evaluate your punches against your actual shift hours \u2014 please coordinate with your line manager so the schedule can be entered, after which the attendance log can be re-evaluated.\n\n')
    : '';
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows your ' + punchPhrase + ' at ' + punchOutStr + ', ' + minutesEarly + ' minutes before your scheduled ' + endStr12h + (isCustomShift ? ' shift end' : ' clock-out time') + ' and with no approved permission on file. This is recorded as an early-departure violation.' + shiftContext + '\n\n' +
    assignmentPara +
    noAssignmentNote +
    buildAssignedShiftsBlock(assignedShifts, violationDate, divider) +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    policyBullets.join('\n') + '\n' +
    divider + '\n\n' +
    'You are still required to submit an early-departure permission request via the ESAU HR Portal (esauhr.netlify.app \u2192 New Request \u2192 Permission) for today\u2019s ' + punchPhrase + '. Submitting it after the fact lets HR record the reason and consider it against your monthly entitlement. Without an approved permission, the day stands as an unexcused violation on your evaluation record.\n\n' +
    'For exceptional cases (medical, official, or other documented emergencies that go beyond the monthly entitlement), please reply to this email within two working days with the supporting details.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

function missedPunchEmailContent({ employee, dateLong, missingType, isCustomShift, scheduleLabel, scheduledStart, scheduledEnd, isNightShiftStart, isNightShiftEnd, assignedBy, assignedAt, managerName, assignedShifts, violationDate, staffHasShifts, isShiftAbsence }) {
  // missingType: 'in' | 'out' | 'both'
  // Wording variants for the violation summary line and the action
  // paragraph. Both have to agree on which punch(es) are missing —
  // kept as a single switch so future edits don't drift.
  // For shift staff the noun "punch" is replaced with "shift-IN
  // punch" / "shift-OUT punch" so the email matches how their
  // manager-assigned schedule is described elsewhere in the portal.
  const inLabel  = isCustomShift ? 'shift-IN punch'  : 'punch-in';
  const outLabel = isCustomShift ? 'shift-OUT punch' : 'punch-out';
  const missingPhrase = missingType === 'in'
    ? 'your ' + inLabel
    : missingType === 'out'
    ? 'your ' + outLabel
    : 'both your ' + inLabel + ' and ' + outLabel;
  const actualTimesPhrase = missingType === 'in'
    ? (isCustomShift ? 'your actual shift-IN time' : 'your actual arrival time')
    : missingType === 'out'
    ? (isCustomShift ? 'your actual shift-OUT time' : 'your actual departure time')
    : (isCustomShift ? 'your actual shift-IN and shift-OUT times' : 'your actual arrival and departure times');

  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  // Shift staff get a distinct subject prefix so the inbox makes
  // it obvious this is a shift-attendance issue.
  const isShiftFlow = !!(isCustomShift || staffHasShifts);
  // Subject prefix — shift absence (#4) gets the strongest framing
  // since it represents an unexcused no-show on a manager-assigned
  // shift, distinct from a missed-punch correction. Falls through to
  // standard shift / office wording for everything else.
  const subjectPrefix = isShiftAbsence
    ? ((isNightShiftStart || isNightShiftEnd) ? 'Shift Absence Notice (Night Shift)' : 'Shift Absence Notice')
    : (isShiftFlow
        ? ((isNightShiftStart || isNightShiftEnd) ? 'Shift Missing Punch Notice (Night Shift)' : 'Shift Missing Punch Notice')
        : 'Missing Punch Notice');
  const subject = subjectPrefix + ' — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  // Policy bullets — different shape from the late/early emails
  // because missed punches aren't a "you exceeded your quota"
  // situation. The framing is: a complete record is required, the
  // gap has real downstream consequences (payroll, overtime,
  // Saudi labor compliance), and the correction must come through
  // the line manager within a 2-day window. For shift staff, the
  // first bullet is rewritten to reference the assigned shift
  // window instead of "every working day".
  const startStr12h = scheduledStart ? fmtTime12h(scheduledStart) : null;
  const endStr12h   = scheduledEnd   ? fmtTime12h(scheduledEnd)   : null;
  const policyBullets = isCustomShift
    ? [
        '\u2022 A complete shift-IN and shift-OUT punch is required on every assigned shift'
          + (startStr12h && endStr12h ? ' (' + startStr12h + ' \u2192 ' + endStr12h + ((isNightShiftStart || isNightShiftEnd) ? ', overnight' : '') + ').' : '.'),
        '\u2022 Missing punches affect payroll, overtime, and Saudi labor law compliance.',
        '\u2022 Missed shift punches must be reported and confirmed by your line manager within two working days.',
      ]
    : [
        '\u2022 A complete punch-in and punch-out is required on every working day.',
        '\u2022 Missing punches affect payroll, overtime, and Saudi labor law compliance.',
        '\u2022 Missed punches must be reported and confirmed by your manager within two working days.',
      ];

  // Same 71-char "=" divider as the late/early emails (visual fit
  // confirmed in production mail-client rendering by Nadeem).
  const divider = '='.repeat(71);

  // Manager attribution — same wording shape as the late/early
  // shift emails so the staff sees who set their schedule and when.
  const assignmentPara = (isCustomShift && (managerName || assignedBy))
    ? 'This shift schedule'
      + (startStr12h && endStr12h
          ? ' (' + startStr12h + ' \u2192 ' + endStr12h + ((isNightShiftStart || isNightShiftEnd) ? ', overnight' : '') + ')'
          : '')
      + ' was set by your line manager'
      + (assignedAt ? ' on ' + new Date(assignedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
      + ' through the ESAU HR Portal. Your acknowledgment of the shift is on file in the same system.\n\n'
    : '';

  // No-assignment clarifier — only fires when the staff is on the
  // monthly shift roster (staffHasShifts) but the SPECIFIC date in
  // question had no shift on file (so isCustomShift came through
  // false and the row fell back to office-hours evaluation). This
  // explains to the staff why their email looks office-style even
  // though they're a shift worker, and points them at the roster
  // block to verify their schedule.
  // No-assignment clarifier — fires when the staff is on a shift
  // roster (staffHasShifts) but the SPECIFIC date had no shift on
  // file. Two sub-cases:
  //   (a) staff has OTHER shifts in the month → ask them to verify
  //       with their manager and reference the roster block below
  //   (b) staff is on monthly_shift_plans roster but NO specific
  //       per-date entries yet → ask them to chase their manager
  //       to enter the schedule (Jasim's case, 2026-05-07)
  const hasAnyMonthShifts = Array.isArray(assignedShifts) && assignedShifts.length > 0;
  const noAssignmentNote = (staffHasShifts && !isCustomShift)
    ? (hasAnyMonthShifts
        ? 'Note: you are on the shift roster for this month (see the schedule below). However, no specific shift was assigned for ' + dateLong + ' in the ESAU HR Portal, so the punches for this date were evaluated against the standard office-hours window. If a shift should have been assigned for this date, please raise it with your line manager so the schedule can be corrected.\n\n'
        : 'Note: you are flagged as a shift worker on this month\u2019s roster, but your line manager has not yet entered specific shift dates and times for you in the ESAU HR Portal. Without an entered schedule, the system cannot evaluate your punches against your actual shift hours \u2014 please coordinate with your line manager so the schedule can be entered, after which the attendance log can be re-evaluated.\n\n')
    : '';

  // Shift context line — reinforces in the opening paragraph that
  // the missed punches relate to a specific assigned shift, not a
  // generic working day.
  const shiftContext = isCustomShift && scheduleLabel
    ? ' Your assigned ' + scheduleLabel.toLowerCase() + ' covers '
      + (startStr12h || '?') + ' \u2192 ' + (endStr12h || '?')
      + ((isNightShiftStart || isNightShiftEnd) ? ' (overnight)' : '') + '.'
    : '';

  // Body — HR-Department voice. Action paragraph routes the
  // correction through the line manager (who is already CC'd on
  // this email by the AttendanceView build): staff discusses the
  // actual times with their manager, manager replies to confirm,
  // HR updates the log. Removed the previous "device fault /
  // operations team" exception paragraph per Nadeem's instruction
  // — manager-confirmation now covers all legitimate correction
  // cases including faulty terminal readings. For shift staff the
  // full month roster + attribution paragraph are inserted between
  // the violation summary and the policy bullets so they see the
  // schedule context for the missing day.
  // Opener and closer adapt for shift absence (#4 — Phase 1) — the
  // wording shifts from "this is incomplete, please correct" to "this
  // is logged as an unexcused absence on a manager-assigned shift".
  // Manager-confirmation route is still offered as the resolution
  // path, but the framing makes clear this is a more serious flag
  // than a routine missed-punch correction.
  const opener = isShiftAbsence
    ? 'HR\u2019s daily attendance review for ' + dateLong + ' shows neither a shift-IN nor a shift-OUT punch on record for your manager-assigned ' + (scheduleLabel || 'shift') + '. As no leave or permission is on file for this date, this is logged as an unexcused absence on an assigned shift.'
    : 'HR\u2019s daily attendance review for ' + dateLong + ' shows ' + missingPhrase + ' missing from the time card. This leaves the day\u2019s record incomplete and cannot be processed for payroll until corrected.';
  const closer = isShiftAbsence
    ? 'If you were present for this shift but the terminal failed to register your punches, please coordinate with your direct manager (copied on this email) within two working days so the absence can be reclassified. Without timely manager confirmation, this stands on your record as an unexcused shift absence and may carry implications for your evaluation and payroll.'
    : 'Please discuss ' + actualTimesPhrase + ' for ' + dateLong + ' with your direct manager (copied on this email). Your manager must then reply confirming the times within two working days, after which the attendance log will be updated. Without manager confirmation, the day stands as incomplete on your record.';
  const body =
    'Dear ' + greetName + ',\n\n' +
    opener + shiftContext + '\n\n' +
    assignmentPara +
    noAssignmentNote +
    buildAssignedShiftsBlock(assignedShifts, violationDate, divider) +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    policyBullets.join('\n') + '\n' +
    divider + '\n\n' +
    closer + '\n\n' +
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

function lateEmailContentTemp({ employee, dateLong, punchInStr, minutesLate, scheduledStart, lateCutoff, isCustomShift, scheduleLabel, isNightShiftStart, assignedBy, assignedAt, managerName, assignedShifts, violationDate, staffHasShifts }) {
  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  // Treat the staff as on shift-flow when EITHER the specific row was
  // evaluated as a shift OR they are on the monthly shift roster (so
  // shift workers feel acknowledged even on dates the manager hadn'''t
  // explicitly assigned). Wording that describes what was actually
  // measured (shift-IN vs punch-in, 8:00 AM bullet) stays gated on
  // the narrower isCustomShift.
  const isShiftFlow = !!(isCustomShift || staffHasShifts);
  const subjectPrefix = isShiftFlow
    ? (isNightShiftStart ? 'Shift Late Arrival Notice (Night Shift)' : 'Shift Late Arrival Notice')
    : 'Late Arrival Notice';
  const subject = subjectPrefix + ' — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  const startStr12h = scheduledStart ? fmtTime12h(scheduledStart) : '8:00 AM';
  const cutoffStr12h = lateCutoff ? fmtTime12h(lateCutoff) : '8:15 AM';
  const policyBullets = isCustomShift
    ? [
        '\u2022 Your scheduled shift start is ' + startStr12h + (isNightShiftStart ? ' (overnight shift to next morning)' : '') + '.',
        '\u2022 A 15-minute grace period is allowed; arrivals after ' + cutoffStr12h + ' are recorded as late.',
        '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
      ]
    : [
        '\u2022 The official clock-in time is 8:00 AM on regular working days.',
        '\u2022 A 15-minute grace period is allowed; arrivals after 8:15 AM are recorded as late.',
        '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
      ];

  const divider = '='.repeat(71);

  const punchPhrase = isCustomShift ? 'shift-IN punch' : 'punch-in';
  const shiftContext = isCustomShift && scheduleLabel
    ? ' Your assigned ' + scheduleLabel.toLowerCase() + ' begins at ' + startStr12h + '.'
    : '';
  const assignmentPara = (isCustomShift && (managerName || assignedBy))
    ? 'This shift schedule (start ' + startStr12h + (isNightShiftStart ? ', overnight' : '') + ') was set by your line manager'
      + (assignedAt ? ' on ' + new Date(assignedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
      + ' through the ESAU HR Portal. Your acknowledgment of the shift is on file in the same system.\n\n'
    : '';

  // No-assignment clarifier — only fires when the staff is on the
  // monthly shift roster (staffHasShifts) but the SPECIFIC date in
  // question had no shift on file (so isCustomShift came through
  // false and the row fell back to office-hours evaluation). This
  // explains to the staff why their email looks office-style even
  // though they're a shift worker, and points them at the roster
  // block to verify their schedule.
  // No-assignment clarifier — fires when the staff is on a shift
  // roster (staffHasShifts) but the SPECIFIC date had no shift on
  // file. Two sub-cases:
  //   (a) staff has OTHER shifts in the month → ask them to verify
  //       with their manager and reference the roster block below
  //   (b) staff is on monthly_shift_plans roster but NO specific
  //       per-date entries yet → ask them to chase their manager
  //       to enter the schedule (Jasim's case, 2026-05-07)
  const hasAnyMonthShifts = Array.isArray(assignedShifts) && assignedShifts.length > 0;
  const noAssignmentNote = (staffHasShifts && !isCustomShift)
    ? (hasAnyMonthShifts
        ? 'Note: you are on the shift roster for this month (see the schedule below). However, no specific shift was assigned for ' + dateLong + ' in the ESAU HR Portal, so the punches for this date were evaluated against the standard office-hours window. If a shift should have been assigned for this date, please raise it with your line manager so the schedule can be corrected.\n\n'
        : 'Note: you are flagged as a shift worker on this month\u2019s roster, but your line manager has not yet entered specific shift dates and times for you in the ESAU HR Portal. Without an entered schedule, the system cannot evaluate your punches against your actual shift hours \u2014 please coordinate with your line manager so the schedule can be entered, after which the attendance log can be re-evaluated.\n\n')
    : '';
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows your ' + punchPhrase + ' at ' + punchInStr + ', ' + minutesLate + ' minutes past the 15-minute grace period and with no approved permission on file. This is recorded as a late-arrival violation.' + shiftContext + '\n\n' +
    assignmentPara +
    noAssignmentNote +
    buildAssignedShiftsBlock(assignedShifts, violationDate, divider) +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    policyBullets.join('\n') + '\n' +
    divider + '\n\n' +
    'If you had a valid reason for this lateness (medical, official, or other documented circumstances), please reply to this email within two working days with the supporting details so HR can record it on file. Your line manager is copied on this email and may be consulted as part of the review.\n\n' +
    HR_SIGNATURE;
  return { subject, body };
}

function earlyLeaveEmailContentTemp({ employee, dateLong, punchOutStr, scheduledEnd, minutesEarly, isCustomShift, scheduleLabel, isNightShiftEnd, assignedBy, assignedAt, managerName, assignedShifts, violationDate, staffHasShifts }) {
  const psn = String(employee.id || employee.psn || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  const isShiftFlow = !!(isCustomShift || staffHasShifts);
  const subjectPrefix = isShiftFlow
    ? (isNightShiftEnd ? 'Shift Early Departure Notice (Night Shift)' : 'Shift Early Departure Notice')
    : 'Early Departure Notice';
  const subject = subjectPrefix + ' — ' + psn + ' ' + fullName + ' — ' + dateLong;
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  const endStr12h    = fmtTime12h(scheduledEnd);
  const cutoffStr    = addMinutesToTime(scheduledEnd, -15);
  const cutoffStr12h = fmtTime12h(cutoffStr);

  const policyBullets = isCustomShift
    ? [
        '\u2022 Your scheduled shift end is ' + endStr12h + (isNightShiftEnd ? ' (overnight shift completed in the morning)' : '') + '.',
        '\u2022 Any departure before ' + endStr12h + ' is recorded as early leave \u2014 no grace period applies on the clock-out side.',
        '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
      ]
    : [
        '\u2022 Your scheduled clock-out time is ' + endStr12h + ' on regular working days.',
        '\u2022 Any departure before ' + endStr12h + ' is recorded as early leave \u2014 no grace period applies on the clock-out side.',
        '\u2022 Each staff is entitled to 3 permissions per month (late or early), 1 hour each, 3 times only.',
      ];

  const divider = '='.repeat(71);

  const punchPhrase = isCustomShift ? 'shift-OUT punch' : 'punch-out';
  const shiftContext = isCustomShift && scheduleLabel
    ? ' Your assigned ' + scheduleLabel.toLowerCase() + ' ends at ' + endStr12h + '.'
    : '';
  const assignmentPara = (isCustomShift && (managerName || assignedBy))
    ? 'This shift schedule (end ' + endStr12h + (isNightShiftEnd ? ', overnight completing today' : '') + ') was set by your line manager'
      + (assignedAt ? ' on ' + new Date(assignedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '')
      + ' through the ESAU HR Portal. Your acknowledgment of the shift is on file in the same system.\n\n'
    : '';

  // No-assignment clarifier — only fires when the staff is on the
  // monthly shift roster (staffHasShifts) but the SPECIFIC date in
  // question had no shift on file (so isCustomShift came through
  // false and the row fell back to office-hours evaluation). This
  // explains to the staff why their email looks office-style even
  // though they're a shift worker, and points them at the roster
  // block to verify their schedule.
  // No-assignment clarifier — fires when the staff is on a shift
  // roster (staffHasShifts) but the SPECIFIC date had no shift on
  // file. Two sub-cases:
  //   (a) staff has OTHER shifts in the month → ask them to verify
  //       with their manager and reference the roster block below
  //   (b) staff is on monthly_shift_plans roster but NO specific
  //       per-date entries yet → ask them to chase their manager
  //       to enter the schedule (Jasim's case, 2026-05-07)
  const hasAnyMonthShifts = Array.isArray(assignedShifts) && assignedShifts.length > 0;
  const noAssignmentNote = (staffHasShifts && !isCustomShift)
    ? (hasAnyMonthShifts
        ? 'Note: you are on the shift roster for this month (see the schedule below). However, no specific shift was assigned for ' + dateLong + ' in the ESAU HR Portal, so the punches for this date were evaluated against the standard office-hours window. If a shift should have been assigned for this date, please raise it with your line manager so the schedule can be corrected.\n\n'
        : 'Note: you are flagged as a shift worker on this month\u2019s roster, but your line manager has not yet entered specific shift dates and times for you in the ESAU HR Portal. Without an entered schedule, the system cannot evaluate your punches against your actual shift hours \u2014 please coordinate with your line manager so the schedule can be entered, after which the attendance log can be re-evaluated.\n\n')
    : '';
  const body =
    'Dear ' + greetName + ',\n\n' +
    'HR\u2019s daily attendance review for ' + dateLong + ' shows your ' + punchPhrase + ' at ' + punchOutStr + ', ' + minutesEarly + ' minutes before your scheduled ' + endStr12h + (isCustomShift ? ' shift end' : ' clock-out time') + ' and with no approved permission on file. This is recorded as an early-departure violation.' + shiftContext + '\n\n' +
    assignmentPara +
    noAssignmentNote +
    buildAssignedShiftsBlock(assignedShifts, violationDate, divider) +
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
// Outer wrapper — wraps the heavy AttendanceView inner component in
// the error boundary so a render crash anywhere shows a useful red
// box instead of blanking the page. Bashaier was hitting this:
// "When I upload a file the screen goes blank." With the boundary
// in place, she'll see the actual error message and can copy it
// for debugging.
export default function AttendanceView(props) {
  return (
    <AttendanceErrorBoundary label="Attendance">
      <AttendanceViewInner {...props} />
    </AttendanceErrorBoundary>
  );
}

function AttendanceViewInner({ me, employees, leaveTypes = [] }) {
  // The xlsx ingestion replaces the legacy CSV path entirely. We hold
  // the parsed result rather than the raw text — there's no use case
  // for re-parsing on the fly the way the CSV path was wired.
  const [xlsxFileName, setXlsxFileName] = useState('');

  // Side-panel state — set to an employee object when Bashaier clicks
  // a name in the Monthly Overview calendar; rendered as a slide-in
  // drawer with that employee's full Jan-1-to-today attendance + leave
  // history. null means the drawer is closed.
  const [detailEmployee, setDetailEmployee] = useState(null);

  // ─── Sidebar navigation ──────────────────────────────────────────
  // The Attendance page is a master-detail layout: a left sidebar
  // lists the discrete functions and the right pane shows whichever
  // one Bashaier clicked. Lands on 'calendar' (Monthly Overview) by
  // default — that's the most-glance-worthy summary.
  // Phase B (Decision #6 / option A): unified attendance workspace.
  // Old 'calendar' and 'daily' both map to 'attendance'. Legacy ids
  // remain accepted by the dispatch below for back-compat with any
  // deep links or saved bookmarks.
  const [activeView, setActiveView] = useState('attendance');

  // Phase D (Decision #2 / option A) — Setup-complete gate.
  //
  // The "Historical backfill" page is meant for first-time data
  // import. Once Bashaier has begun running daily uploads, backfill
  // is no longer the right tool — running it after live operation
  // could overwrite real evaluated rows with re-derived values. We
  // detect the transition from setup-mode to live-mode and hide the
  // backfill sidebar entry once it's crossed.
  //
  // Detection rule: setup is complete when at least one row exists
  // in attendance_uploads. That table only gets a row when Bashaier
  // acts on a daily-flow file (the lazy upload-recorded write fires
  // on first violation log, not on parse). It's a clean signal:
  //   • zero rows → never started daily flow → backfill is the right tool
  //   • ≥1 row    → daily flow is in use → backfill should be hidden
  //
  // Escape hatch: visiting the page with `?admin=backfill` in the
  // URL re-exposes the sidebar entry for the current session. Useful
  // for one-off corrective backfills after setup. The flag is held
  // in component state and cleared on next reload — so no permanent
  // override, no UI change for end users, no DB writes.
  const [setupComplete, setSetupComplete] = useState(false);
  const [escapeHatchActive, setEscapeHatchActive] = useState(false);

  // Setup-complete probe — one-time check on mount. Cheap query
  // (count-only, limit 1). Failure is non-fatal: we default to false
  // (= sidebar shows backfill), which is the safe direction. The
  // worst case of a stale read is "backfill is visible when it
  // shouldn't be" — recoverable. The opposite ("hidden when it
  // should be visible") would block first-time setup, which is
  // unacceptable.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet('attendance_uploads', 'select=id&limit=1', { timeoutMs: 6000 });
        if (!cancelled) setSetupComplete(Array.isArray(rows) && rows.length > 0);
      } catch {
        if (!cancelled) setSetupComplete(false); // safe default
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Escape-hatch detection — on mount, parse the URL for
  // `?admin=backfill` and flip the flag. Not persisted; a fresh tab
  // without the param goes back to the locked-down view.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get('admin') === 'backfill') {
        setEscapeHatchActive(true);
        // Auto-route into the backfill view so the admin doesn't have
        // to click around looking for the (now-visible) entry.
        setActiveView('backfill');
      }
    } catch {}
  }, []);

  // Phase C (Decisions #3 + #5 — calendar refresh + re-eval triggers).
  //   • calendarRefreshTick — bumped after every successful re-eval
  //     so the AttendanceMonthGrid can refetch its rows. Single
  //     integer tick is the cheapest cross-component signal.
  //   • reevalState — surfaces the in-progress / last-completed state
  //     of the re-eval pipeline so the manual button + status pill
  //     can render consistently. Shape:
  //       { running: bool, lastRunAt: ISO | null, summary: object | null,
  //         error: string | null }
  const [calendarRefreshTick, setCalendarRefreshTick] = useState(0);
  const [reevalState, setReevalState] = useState({
    running: false,
    lastRunAt: null,
    summary: null,
    error: null,
  });

  // Tier 2 fix (#7) — System health: track when the most recent
  // attendance upload landed, so the health pill can tell Bashaier at
  // a glance whether the system is "fresh" (uploaded today) or stale
  // (no upload in days). Combined with reevalState.lastRunAt, gives
  // her a quick read on whether the data she's looking at is current.
  // Refreshes whenever the calendar refresh tick bumps so it stays
  // current after Save & Close. Declared AFTER calendarRefreshTick
  // because the deps array references it — declaring it earlier
  // caused a TDZ error: "can't access lexical declaration 'g' before
  // initialization" (where 'g' was the minified calendarRefreshTick).
  const [lastUploadAt, setLastUploadAt] = useState(null);
  // Tracks the most recent successful daily-reeval cron run. Surfaces
  // in the system-health pill tooltip so Bashaier can verify the
  // overnight job ran. Pulled from cron_runs (see migration_cron_
  // reevaluate.sql). Refreshes alongside lastUploadAt.
  const [lastCronAt, setLastCronAt] = useState(null);

  // Which notification chip is currently expanded (string id or null).
  // Used by the notifications row next to the system health pill —
  // clicking a chip toggles its detail card. One open at a time.
  const [openNotice, setOpenNotice] = useState(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'attendance_uploads',
          'select=uploaded_at&order=uploaded_at.desc&limit=1',
          { timeoutMs: 6000 }
        );
        if (!cancelled && Array.isArray(rows) && rows[0]?.uploaded_at) {
          setLastUploadAt(rows[0].uploaded_at);
        }
      } catch { /* non-fatal */ }
      try {
        const cronRows = await directGet(
          'cron_runs',
          'select=finished_at,status,rows_updated&job_name=eq.daily-reeval&status=in.(success,no_op)&order=finished_at.desc&limit=1',
          { timeoutMs: 6000 }
        );
        if (!cancelled && Array.isArray(cronRows) && cronRows[0]?.finished_at) {
          setLastCronAt(cronRows[0]);
        }
      } catch { /* non-fatal — table may not exist yet pre-migration */ }
    })();
    return () => { cancelled = true; };
  }, [calendarRefreshTick]);

  // Phase D — if the user lands on `activeView === 'backfill'` (e.g.
  // via a stale bookmark or a reload) but setup is complete and the
  // escape hatch isn't active, kick them back to the main Attendance
  // workspace. Without this, the backfill panel would render with no
  // sidebar entry to navigate away from — a dead-end UI state.
  useEffect(() => {
    if (activeView === 'backfill' && setupComplete && !escapeHatchActive) {
      setActiveView('attendance');
    }
  }, [activeView, setupComplete, escapeHatchActive]);

  // Re-eval trigger — central function called by:
  //   • Save & Close on the daily upload (Decision #4 / option C)
  //   • Stale-check on mount (Decision #5 / option C — the "B"
  //     leg, implemented as a localStorage-gated app-load trigger
  //     rather than an external cron, to avoid the infrastructure
  //     overhead for a small ops team)
  //   • Manual "Re-evaluate last 7 days" button on the page header
  //
  // Window: last 7 calendar days inclusive of today (Decision #1 /
  // option A). The reevaluateLastNDays helper handles the date math
  // in local time so the window matches Bashaier's perception of
  // "this week" rather than UTC days.
  // Tier 3 fix (#3 / item 3) — race guard: triggerReevaluation (below)
  // needs to read the current bulkSession without re-creating its
  // callback on every change. A ref kept in sync gives the callback
  // live access without dependency churn. The re-eval bails when a
  // bulk-send is mid-flight to avoid clobbering the rows being
  // emailed against. Must be declared BEFORE triggerReevaluation
  // (the callback's closure references it lexically — declaring it
  // after caused a TDZ minification error: "can't access lexical
  // declaration 'g' before initialization").
  const bulkSessionRef = useRef(null);

  const triggerReevaluation = useCallback(async (opts = {}) => {
    const { silent = false, days = 7 } = opts;
    if (reevalState.running) return null; // already running — bail
    // Tier 3 fix (#3 / item 3) — race guard: don't re-evaluate while
    // a bulk-send session is open. Bulk-send walks the queue using
    // entry rows captured at session start; if re-eval reclassifies
    // them mid-walk, the email body data and the audit row data
    // diverge. The re-eval will fire after the bulk session closes
    // (via the next Save & Close, or the 24h stale-check on next
    // load), so nothing is lost — just deferred.
    if (bulkSessionRef.current) {
      if (!silent) {
        try {
          window.dispatchEvent(new CustomEvent('esauhr_toast', { detail: {
            kind: 'warning',
            title: 'Re-evaluation deferred',
            body: 'Bulk send is active. Re-evaluation will run automatically after the bulk session closes.',
          }}));
        } catch {}
      }
      return null;
    }
    setReevalState(s => ({ ...s, running: true, error: null }));
    try {
      const summary = await reevaluateLastNDays(days);
      const nowIso = new Date().toISOString();
      // Persist the timestamp so the stale-check on next load knows
      // when re-eval last completed. localStorage is per-browser,
      // which is fine for the single-HR-reviewer model — Bashaier
      // is the only one running re-evals in practice.
      try { localStorage.setItem('esauhr_last_reeval_at', nowIso); } catch {}
      setReevalState({ running: false, lastRunAt: nowIso, summary, error: null });
      // Bump the calendar's refresh tick so it picks up the changes
      // (Decision #3 / option A — single refetch after session ends,
      // no live updates during the upload flow to avoid scroll
      // disruption).
      setCalendarRefreshTick(t => t + 1);
      return summary;
    } catch (err) {
      const msg = err?.message || 'Re-evaluation failed';
      setReevalState(s => ({ ...s, running: false, error: msg }));
      if (!silent) {
        try { console.error('Re-eval failed:', err); } catch {}
      }
      return null;
    }
  }, [reevalState.running]);

  // Save & Close — explicit handoff that finalises the upload session
  // and triggers the 7-day re-evaluation pass. After the re-evaluation
  // returns, also calls reset() so the upload form clears back to its
  // 'no file loaded' state — the user can move on to the next thing
  // without an obsolete file summary lingering on screen. The toast
  // gives them confirmation of what just ran. Phase B+C / Decision #4
  // option C, with the close-the-form behaviour added per Nadeem
  // 2026-05-10 (the previous version triggered re-eval but left the
  // page exactly as it was, which was confusing for a button labelled
  // 'Save & Close').
  const handleSaveAndClose = useCallback(async () => {
    if (reevalState.running) {
      // A re-eval is already mid-flight (it will bump the tick itself on
      // completion). Still honour the close + a refresh so the grid
      // picks up the just-written rows, and don't trap the user.
      setCalendarRefreshTick(t => t + 1);
      setDailyReviewOpen(false);
      return;
    }
    let summary = null;
    try {
      summary = await triggerReevaluation({ silent: false });
    } catch (e) {
      // A re-eval failure must NOT trap the user — log and still close.
      console.error('Save & Close re-evaluation failed:', e);
    }
    // ALWAYS refresh the calendar grid so the dates that were just
    // uploaded show up — independent of whether the re-eval returned a
    // summary or threw. triggerReevaluation only bumps the tick on
    // success; this guarantees the grid refetches attendance_daily every
    // time. (Nadeem 2026-05-31: grid wasn't updating after Save & Close.)
    setCalendarRefreshTick(t => t + 1);
    try {
      const evt = new CustomEvent('esauhr_toast', { detail: summary ? {
        kind: 'success',
        title: 'Upload session closed',
        body: `Re-evaluated ${summary.scanned || 0} ${summary.scanned === 1 ? 'row' : 'rows'} · ${summary.changed || 0} updated. Calendar refreshed.`,
      } : {
        kind: 'success',
        title: 'Upload session closed',
        body: 'Calendar refreshed.',
      }});
      window.dispatchEvent(evt);
    } catch {}
    // Close the daily-review modal but KEEP the loaded file. We do NOT
    // reset() here: clearing xlsxFileName hides the '📋 Today's review'
    // button (gated on hasFile), which is the button Nadeem wants left
    // available after closing so he can reopen and see the update. The
    // explicit way to clear for a fresh day is the 'Upload different
    // file' control. (Nadeem 2026-05-31: 'today's report button does not
    // come to see the update'.)
    setDailyReviewOpen(false);
  }, [reevalState.running, triggerReevaluation]);

  // Stale-check on mount (Decision #5 / option C — the "B" leg).
  // If the last successful re-eval was more than 24h ago (or never),
  // fire a silent re-eval so the calendar reflects late-arriving
  // permissions and corrections that landed since Bashaier's last
  // visit. This replaces the "midnight cron" idea with a cheaper
  // app-load trigger that doesn't require external infrastructure.
  // Runs once per page load. Silent — errors don't surface unless
  // the user opens DevTools.
  useEffect(() => {
    let lastIso = null;
    try { lastIso = localStorage.getItem('esauhr_last_reeval_at'); } catch {}
    const STALE_MS = 24 * 60 * 60 * 1000; // 24h
    const isStale = !lastIso || (Date.now() - new Date(lastIso).getTime() > STALE_MS);
    if (isStale) {
      // Defer slightly so the page can render first — re-eval kicks
      // off after the initial paint, doesn't block first interaction.
      const t = setTimeout(() => { triggerReevaluation({ silent: true }); }, 1500);
      return () => clearTimeout(t);
    }
    // Hydrate the lastRunAt state from localStorage so the manual
    // button shows the correct "last ran X minutes ago" pill on
    // first paint, even when no re-eval was triggered this session.
    setReevalState(s => ({ ...s, lastRunAt: lastIso }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Delta from the most recent recordAttendanceRows() call — describes
  // which (employee, date) rows the upload added vs updated vs left
  // alone. Used by the re-upload banner so Bashaier can see at a glance
  // whether her 4pm re-upload caught new late-arrivals beyond what
  // her 10am upload saw. Nadeem 2026-05-17.
  // Shape: { newRows: [], updatedRows: [], unchangedRows: [],
  //          changedFields: {first_punch, last_punch, status, total_minutes},
  //          total } — or null when no upload has been processed yet.
  const [uploadDelta, setUploadDelta] = useState(null);

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
  // Sync the bulkSession state into bulkSessionRef (declared earlier).
  // The ref is what triggerReevaluation reads to detect "is a bulk
  // send active right now?" without taking a dependency on the state.
  useEffect(() => { bulkSessionRef.current = bulkSession; }, [bulkSession]);

  // Tile drill-down state — which kind's panel is currently expanded
  // inside the FileSummary card. Lifted from FileSummary so the
  // action panels (built below) can be constructed alongside the
  // email handlers and shared state, then passed down. Resets to
  // null whenever a new file is loaded so the next session starts
  // clean.
  const [drillKind, setDrillKind] = useState(null);

  // Which help tile is currently expanded. null = nothing open
  // (the default — most days Bashaier knows the workflow and the
  // upload box should be the first thing she sees). Setting this
  // to one of 'workflow' | 'shift' | 'leave' | 'mail' opens that
  // tile's content panel below the grid with a bounce animation.
  // Clicking the active tile a second time closes it.
  const [activeHelpTile, setActiveHelpTile] = useState(null);

  // View mode is no longer needed — the 2-day workflow runs both
  // morning (today's late + missed-in) and end-of-day (yesterday's
  // early + missed-out) checks simultaneously off a single upload.
  // The previous viewMode + viewModeOverride state was retired when
  // the workflow shifted; one upload now covers both passes.

  const [approvedLeaves, setApprovedLeaves]       = useState([]);
  const [approvedPermissions, setApprovedPerms]   = useState([]); // for the data date
  const [acceptedShifts, setAcceptedShifts]       = useState([]);
  // Mawani visits indexed as `${empId}|${YYYY-MM-DD}` for O(1) lookup
  // during row classification. Fetched for the CSV's month so partial-
  // year files don't pull more than needed.
  const [mawaniDays, setMawaniDays]               = useState(() => new Set());
  const [sentMarkers, setSentMarkers]             = useState({}); // key: row.id → true
  const [loggedMarkers, setLoggedMarkers]         = useState({}); // key: 'empId:type' → true

  // Explain-modal state — when a user clicks "Why?" on any violation
  // row, we stash { entry, kind } here and render the modal.
  // Single-instance — only one explain open at a time.
  const [explainPayload, setExplainPayload] = useState(null);

  // Historical-backfill modal — opened by the "Historical backfill"
  // button in the Monthly Overview header. Wraps AttendanceBackfillPanel
  // with a date-window banner so Bashaier knows the allowed range.
  const [backfillModalOpen, setBackfillModalOpen] = useState(false);

  // Daily-review modal — opens automatically when a time card finishes
  // parsing and shows the entire detection workspace (action tiles, file
  // summary, banners) overlaid on the calendar so Bashaier can act on
  // the day's findings without losing the calendar context. She can
  // close anytime; reopen via the "📋 Today's review" button that
  // appears once a file is parsed.
  const [dailyReviewOpen, setDailyReviewOpen] = useState(false);
  // Shift Staff Attendance report — toggleable panel that appears
  // right under the Upload Time Card button when open. Closed by
  // default so the page chrome stays clean for the daily upload flow.
  const [shiftReportOpen, setShiftReportOpen] = useState(false);
  const [hqExportOpen, setHqExportOpen] = useState(false);
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

  // ─── Export monthly report ─────────────────────────────────────────
  // Generates a printable A4 HTML report of the month's attendance.
  // Pulls fresh data from attendance_daily for the relevant month,
  // sorts staff by location → name (so the printed report groups
  // rows by office naturally), and renders each row as a table of
  // status chips that mirror the on-screen calendar's visual
  // language. The report is fully self-contained — no CSS bundle
  // dependency — and is opened in a new window with @page A4 print
  // rules. The print dialog auto-prompts so it's one click from
  // button to PDF/paper.
  //
  // Why we don't clone the on-screen DOM: the grid uses horizontal
  // scrolling, fixed-position tooltips, and React-rendered names
  // that can be off-screen — a screenshot-style clone misses cells
  // and labels. Re-rendering from data is more work but produces a
  // complete, correctly-sorted, identically-styled report.
  const exportMonthReport = useCallback(async () => {
    // Status palette (mirrors AttendanceMonthGrid's styleForStatus).
    // Kept in sync visually — if that file changes its colours,
    // update here too.
    const STATUS = {
      present:        { bg: '#ECFDF5', fg: '#0F4C2A', border: '#A7F3D0', label: '\u2713' },
      late:           { bg: '#FEF3C7', fg: '#854F0B', border: '#FCD34D', label: 'LT' },
      short:          { bg: '#FED7AA', fg: '#7C2D12', border: '#FB923C', label: 'SH' },
      absent:         { bg: '#FEE2E2', fg: '#991B1B', border: '#FCA5A5', label: 'AB' },
      annual_leave:   { bg: '#CCFBF1', fg: '#115E59', border: '#5EEAD4', label: 'AL' },
      sick_leave:     { bg: '#EDE9FE', fg: '#5B21B6', border: '#C4B5FD', label: 'SL' },
      maternity_leave:{ bg: '#FCE7F3', fg: '#9D174D', border: '#F9A8D4', label: '\u2713ML' },
      paternity_leave:{ bg: '#E0F2FE', fg: '#075985', border: '#7DD3FC', label: '\u2713PL' },
      hajj_leave:     { bg: '#FEF3C7', fg: '#854F0B', border: '#FCD34D', label: '\u2713HJ' },
      emergency_leave:{ bg: '#FEE2E2', fg: '#7F1D1D', border: '#FCA5A5', label: '\u2713EL' },
      unpaid_leave:   { bg: '#F3F4F6', fg: '#374151', border: '#D1D5DB', label: '\u2713UL' },
      off_roster:     { bg: '#DBEAFE', fg: '#1E3A8A', border: '#93C5FD', label: 'OR' },
      off_day:        { bg: '#EEF0FA', fg: '#3B4279', border: '#C7CFE5', label: 'OF' },
    };
    const presentLP = { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '\u2713LP' };
    const presentEP = { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '\u2713EP' };

    function ymd(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }
    function pickStyle(status, notes) {
      if (status === 'present' && typeof notes === 'string') {
        if (/late arrival covered by approved permission/i.test(notes)) return presentLP;
        if (/early leave covered by approved permission/i.test(notes))  return presentEP;
      }
      return STATUS[status] || { bg: '#F5F5F5', fg: '#525252', border: '#D4D4D4', label: '?' };
    }

    // Resolve target month — anchored to csvDate (the file being
    // worked on) so "Export" always reflects the month Bashaier is
    // looking at, not whatever month the calendar's nav state is on.
    const ref = csvDate ? new Date(csvDate + 'T00:00:00') : new Date();
    const year = ref.getFullYear();
    const month = ref.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay  = new Date(year, month + 1, 0);
    const monthLabel = firstDay.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const generatedAt = new Date().toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    // Pull the same shape AttendanceMonthGrid uses so this report
    // shows identical content. The fetch is small (1 month × ~150
    // staff = ~3000 rows tops) so we don't need pagination here.
    let records = [];
    try {
      records = await directGet(
        'attendance_daily',
        'select=employee_id,attendance_date,status,first_punch,last_punch,'
        + 'expected_start,expected_end,late_minutes,early_leave_minutes,notes'
        + '&attendance_date=gte.' + ymd(firstDay)
        + '&attendance_date=lte.' + ymd(lastDay)
        + '&order=attendance_date.asc',
        { timeoutMs: 15000 }
      );
    } catch (e) {
      alert('Could not load this month\u2019s data — ' + (e?.message || e));
      return;
    }

    // Filter the directory — by default include ALL staff (so absent
    // staff appear too, with empty cells indicating no records). Sort
    // by location → department → name so the printed report groups
    // first by office, then by team within an office. Empty locations
    // and departments sort to the end.
    const sortedEmps = (employees || [])
      .filter(e => e?.id && !e.terminated && e.is_active !== false && e.status !== 'inactive')
      .sort((a, b) => {
        const locA = String(a.location   || '\uFFFF').toLowerCase();
        const locB = String(b.location   || '\uFFFF').toLowerCase();
        if (locA !== locB) return locA.localeCompare(locB);
        const depA = String(a.department || '\uFFFF').toLowerCase();
        const depB = String(b.department || '\uFFFF').toLowerCase();
        if (depA !== depB) return depA.localeCompare(depB);
        return String(a.name || '').localeCompare(String(b.name || ''));
      });

    if (sortedEmps.length === 0) {
      alert('No active staff in the directory yet.');
      return;
    }

    // records[empId][dateStr] → record. Lookup table for cell render.
    const byEmp = {};
    (records || []).forEach(r => {
      if (!byEmp[r.employee_id]) byEmp[r.employee_id] = {};
      byEmp[r.employee_id][r.attendance_date] = r;
    });

    // Build day list for the month, including weekday labels.
    const days = [];
    for (let d = 1; d <= lastDay.getDate(); d++) {
      const dt = new Date(year, month, d);
      days.push({
        date: dt,
        dateStr: ymd(dt),
        dayNum: d,
        dow: dt.getDay(),
        dowLabel: ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dt.getDay()],
        isWeekend: dt.getDay() === 5 || dt.getDay() === 6,  // KSA Fri/Sat
      });
    }

    // Build rows. Each cell is a small chip showing the status label
    // plus first/last punch. Empty cells stay blank (no record) — for
    // absent-all-month staff this means a row of empty cells, which
    // is itself useful information at a glance.
    // Weekends are tinted so the visual rhythm matches on-screen.
    const tbody = sortedEmps.map((emp, idx) => {
      const cells = days.map(day => {
        const rec = byEmp[emp.id]?.[day.dateStr];
        const weekendStyle = day.isWeekend
          ? 'background:#FAF6E8;'
          : '';
        if (!rec) {
          return '<td class="cell" style="' + weekendStyle + '"></td>';
        }
        const palette = pickStyle(rec.status, rec.notes);
        let mainLabel = palette.label;
        if (rec.status === 'late' && rec.late_minutes) {
          mainLabel = '+' + rec.late_minutes + 'm';
        } else if (rec.status === 'short' && rec.early_leave_minutes) {
          mainLabel = '\u2212' + rec.early_leave_minutes + 'm';
        }
        const fp = rec.first_punch ? String(rec.first_punch).slice(0, 5) : '';
        const lp = rec.last_punch  ? String(rec.last_punch).slice(0, 5)  : '';
        const showLp = lp && lp !== fp;
        return '<td class="cell">'
          + '<div class="chip" style="background:' + palette.bg
          + ';color:' + palette.fg
          + ';border:1px solid ' + palette.border + '">'
          + '<div class="chip-label">' + escapeHtml(mainLabel) + '</div>'
          + (fp ? '<div class="chip-time">' + escapeHtml(fp) + '</div>' : '')
          + (showLp ? '<div class="chip-time">' + escapeHtml(lp) + '</div>' : '')
          + '</div></td>';
      }).join('');

      return '<tr>'
        + '<td class="sn-cell">' + (idx + 1) + '</td>'
        + '<th class="emp-cell">'
        +   '<div class="emp-name">' + escapeHtml(emp.name || '') + '</div>'
        +   '<div class="emp-meta">' + escapeHtml(emp.id || '')
        +     (emp.department ? ' \u00b7 ' + escapeHtml(emp.department) : '')
        +     '</div>'
        +   (emp.location ? '<div class="emp-loc">' + escapeHtml(emp.location) + '</div>' : '')
        + '</th>'
        + cells
        + '</tr>';
    }).join('');

    // Day-header columns. Two rows: weekday label + day number,
    // weekends tinted. Format mirrors the on-screen month grid.
    const dayHeader = days.map(day => {
      const tint = day.isWeekend ? 'background:#FAF6E8;' : '';
      return '<th class="day-head" style="' + tint + '">'
        + '<div class="dow">' + day.dowLabel + '</div>'
        + '<div class="dnum">' + day.dayNum + '</div>'
        + '</th>';
    }).join('');

    // Group-by-location summary banner. Shows how many staff per
    // location. Helps the print reader orient quickly.
    const locCounts = {};
    sortedEmps.forEach(e => {
      const loc = e.location || 'Unspecified';
      locCounts[loc] = (locCounts[loc] || 0) + 1;
    });
    const locSummary = Object.entries(locCounts)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([loc, n]) => '<span class="loc-pill">' + escapeHtml(loc) + ' \u00b7 ' + n + '</span>')
      .join('');

    const html = '<!DOCTYPE html>\n'
+ '<html><head><meta charset="utf-8">'
+ '<title>Monthly Attendance \u2014 ' + escapeHtml(monthLabel) + '</title>'
+ '<style>'
+ '@page { size: A4 landscape; margin: 0.8cm; }'
+ 'html, body { background: #FFFFFF; margin: 0; padding: 0; '
+ '  font-family: Calibri, "Segoe UI", Arial, sans-serif; color: #1F1B16; }'
+ 'body { padding: 14px 16px; }'
+ '.export-header { display: flex; justify-content: space-between; align-items: flex-end; '
+ '  margin-bottom: 10px; padding-bottom: 8px; border-bottom: 2px solid #0F4C2A; }'
+ '.export-title { font-size: 20px; font-weight: 700; color: #0F4C2A; margin: 0; }'
+ '.export-subtitle { font-size: 10px; color: #5F5E5A; margin: 3px 0 0; }'
+ '.export-meta { font-size: 9px; color: #5F5E5A; text-align: right; line-height: 1.4; }'
+ '.info-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; '
+ '  margin: 6px 0 10px; font-size: 9px; color: #5F5E5A; }'
+ '.info-bar .group-label { font-size: 8px; font-weight: 700; '
+ '  color: #5F5E5A; letter-spacing: 0.05em; text-transform: uppercase; '
+ '  margin-right: 2px; }'
+ '.loc-pill { display: inline-block; padding: 2px 8px; '
+ '  border: 1px solid #E5E5E5; border-radius: 999px; background: #FAFAF9; }'
+ '.ll { display: inline-block; padding: 1px 6px; border-radius: 3px; '
+ '  font-weight: 700; font-size: 8px; }'
+ '.info-divider { width: 1px; height: 14px; background: #D4D4D4; margin: 0 4px; }'
+ 'table.grid { border-collapse: collapse; width: 100%; table-layout: fixed; '
+ '  font-size: 8px; }'
+ 'table.grid th, table.grid td { border: 1px solid #EEEAE0; padding: 0; '
+ '  vertical-align: middle; }'
+ '.sn-head, .sn-cell { width: 24px; text-align: center; '
+ '  background: #FAFAF9; font-size: 8px; font-weight: 600; color: #6B6B6B; '
+ '  padding: 2px 0 !important; }'
+ '.sn-cell { color: #0A0A0A; font-weight: 700; }'
+ '.emp-cell { width: 130px; padding: 4px 6px !important; text-align: left; '
+ '  background: #FAFAF9; vertical-align: middle; }'
+ '.emp-name { font-size: 9px; font-weight: 600; color: #0A0A0A; line-height: 1.2; }'
+ '.emp-meta { font-size: 7.5px; color: #6B6B6B; line-height: 1.2; margin-top: 1px; '
+ '  font-family: "SFMono-Regular", monospace; }'
+ '.emp-loc  { font-size: 7.5px; color: #0F4C2A; line-height: 1.2; margin-top: 1px; '
+ '  font-style: italic; }'
+ '.day-head { font-size: 7.5px; padding: 2px 0 !important; text-align: center; '
+ '  background: #FAFAF9; }'
+ '.dow { color: #6B6B6B; font-weight: 500; }'
+ '.dnum { color: #0A0A0A; font-weight: 700; font-size: 9px; }'
+ '.cell { width: auto; height: 28px; padding: 1px !important; text-align: center; }'
+ '.chip { display: flex; flex-direction: column; align-items: center; '
+ '  justify-content: center; padding: 2px 1px; border-radius: 3px; height: 100%; '
+ '  line-height: 1.05; }'
+ '.chip-label { font-size: 8px; font-weight: 700; }'
+ '.chip-time  { font-size: 6.5px; opacity: 0.85; '
+ '  font-family: "SFMono-Regular", monospace; }'
+ '.print-btn { position: fixed; bottom: 12px; right: 12px; padding: 8px 16px; '
+ '  background: #0F4C2A; color: white; border: none; border-radius: 6px; '
+ '  font-size: 12px; font-weight: 600; cursor: pointer; '
+ '  box-shadow: 0 2px 8px rgba(0,0,0,0.2); }'
+ '@media print { .print-btn { display: none !important; } '
+ '  .export-header { page-break-after: avoid; } '
+ '  tr { page-break-inside: avoid; } }'
+ '</style></head><body>'
+ '<div class="export-header">'
+   '<div>'
+     '<h1 class="export-title">Monthly Attendance \u2014 ' + escapeHtml(monthLabel) + '</h1>'
+     '<div class="export-subtitle">Evergreen Shipping Agency Saudi Co. (L.L.C) \u00b7 ESAU HR Portal</div>'
+   '</div>'
+   '<div class="export-meta">'
+     'Generated ' + escapeHtml(generatedAt) + '<br>'
+     'ESAU HR Department<br>'
+     sortedEmps.length + ' staff \u00b7 sorted by location \u2192 department \u2192 name'
+   '</div>'
+ '</div>'
+ '<div class="info-bar">'
+   '<span class="group-label">Locations:</span>'
+   locSummary
+   '<span class="info-divider"></span>'
+   '<span class="group-label">Legend:</span>'
+   '<span class="ll" style="background:#ECFDF5;color:#0F4C2A">\u2713 Present</span>'
+   '<span class="ll" style="background:#EFF6FF;color:#1E40AF">\u2713LP / \u2713EP Permission-covered</span>'
+   '<span class="ll" style="background:#FEF3C7;color:#854F0B">LT Late</span>'
+   '<span class="ll" style="background:#FED7AA;color:#7C2D12">SH Short</span>'
+   '<span class="ll" style="background:#FEE2E2;color:#991B1B">AB Absent</span>'
+   '<span class="ll" style="background:#CCFBF1;color:#115E59">AL Annual</span>'
+   '<span class="ll" style="background:#EDE9FE;color:#5B21B6">SL Sick</span>'
+   '<span class="ll" style="background:#FCE7F3;color:#9D174D">\u2713ML Maternity</span>'
+   '<span class="ll" style="background:#E0F2FE;color:#075985">\u2713PL Paternity</span>'
+   '<span class="ll" style="background:#FEF3C7;color:#854F0B">\u2713HJ Hajj</span>'
+   '<span class="ll" style="background:#FEE2E2;color:#7F1D1D">\u2713EL Emergency</span>'
+   '<span class="ll" style="background:#F3F4F6;color:#374151">\u2713UL Unpaid</span>'
+   '<span class="ll" style="background:#DBEAFE;color:#1E3A8A">OR Off-roster</span>'
+   '<span class="ll" style="background:#EEF0FA;color:#3B4279">OF Off-day</span>'
+ '</div>'
+ '<table class="grid">'
+   '<thead><tr>'
+     '<th class="sn-head">#</th>'
+     '<th class="emp-cell">Employee</th>'
+     dayHeader
+   '</tr></thead>'
+   '<tbody>' + tbody + '</tbody>'
+ '</table>'
+ '<button class="print-btn" onclick="window.print()">\ud83d\udda8 Print / Save as PDF</button>'
+ '<script>window.addEventListener("load", () => setTimeout(() => { try { window.print(); } catch (e) {} }, 600));</script>'
+ '</body></html>';

    const win = window.open('', '_blank', 'width=1400,height=900');
    if (!win) {
      alert('Pop-up blocked \u2014 allow pop-ups for this site to use the export feature.');
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
  }, [csvDate, employees]);

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
  //
  // BUG FIX (Nadeem 2026-05-10): Aminah's approved maternity leave
  // wasn't being picked up by the daily attendance recorder — she
  // showed as 'absent' on the uploaded day even though her ML
  // (01–31 May 2026) was fully approved through manager + HR. Root
  // cause: this query filtered on `status=eq.approved`, but the
  // current approval pipeline writes the authoritative state to the
  // `stage` column (legacy `status` lags or doesn't sync on some
  // code paths). Aminah's row had stage='approved' but status='pending'.
  //
  // Fix: filter with PostgREST OR — match EITHER stage='approved'
  // (new pipeline, canonical) OR status='approved' (legacy rows
  // approved before the stage column existed or via paths that
  // still write the old column). Catches both, ignores nothing.
  useEffect(() => {
    if (!csvDate) { setApprovedLeaves([]); return; }
    let cancelled = false;
    const windowStart = yesterdayDate || csvDate;
    (async () => {
      try {
        const data = await directGet(
          'leave_requests?select=id,employee_id,start_date,end_date,status,stage,leave_type_id,is_half_day,half_day_period'
          + '&or=(stage.eq.approved,status.eq.approved)'
          + '&start_date=lte.' + csvDate
          + '&end_date=gte.' + windowStart
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

  // P4: fetch employee_shifts the staff have accepted for a 3-day
  // window: day-before-yesterday, yesterday, and today. Three dates
  // because the night-shift bridge below maps a shift's start day
  // to its end day (start + 1). For the bridge to fire correctly
  // on YESTERDAY's row (when the previous day's shift bled into
  // yesterday morning), we need that previous day's shift in the
  // override index. Ditto today's row — needs yesterday's shift to
  // recognise a Y→T overnight.
  //
  // Only status='accepted' rows are honoured — pending/declined
  // fall back to the defaults so an unconfirmed manager schedule
  // never affects HR. The shiftOverrideById memo below indexes by
  // (employee_id, shift_date) so multiple dates' overrides don't
  // clobber each other in the lookup map.
  // ─────────────────────────────────────────────────────────────────
  // Shift-aware attendance — fetch the month's shifts for the CSV date
  //
  // The attendance evaluator needs two things from the shift table:
  //
  //   1. A per-(employee, date) schedule override for days where the
  //      employee has been assigned a shift. Used to set the right
  //      lateness / early-leave cutoffs (e.g. FAHAD's Saturday shift
  //      is 13:00-22:00, not the standard 08:00-17:00).
  //
  //   2. A way to detect "this person is shift staff for the month
  //      but has no shift TODAY" — that's their off-day per their
  //      manager's plan, not absence. Without this, FAHAD's Sun-Fri
  //      off-days get scored against the standard schedule and he
  //      shows up late/absent on every off-day.
  //
  // To answer #2 we have to fetch the WHOLE month's shifts, not just
  // the CSV day + neighbors. A row for the CSV date alone wouldn't
  // tell us whether the employee is on a roster.
  //
  // Both PENDING and ACCEPTED shifts count as schedule — the manager
  // has assigned them; staff acknowledgment is a separate workflow.
  // If we waited for acceptance, an unacknowledged shift would
  // default to 08:00-17:00 evaluation, which is exactly wrong for
  // shift staff on their day off.

  // Refresh tick — incremented by the "Refresh from database" pill on
  // the roster gaps card. Both this acceptedShifts hook and the
  // shiftRosterStaff hook below depend on it, so a single click
  // re-pulls live shift data + off-pattern without forcing the user
  // to re-upload the attendance file. Declared up here so both hooks
  // can list it in their deps array without TDZ trouble.
  const [rosterRefreshTick, setRosterRefreshTick] = useState(0);

  useEffect(() => {
    if (!csvDate) { setAcceptedShifts([]); return; }
    let cancelled = false;
    (async () => {
      try {
        // First and last day of the CSV's month — captures all
        // shifts whose date falls in that month, regardless of
        // CSV day or weekend.
        const [yy, mm] = csvDate.split('-').map(Number);
        const monthStart = `${yy}-${String(mm).padStart(2, '0')}-01`;
        const lastDay = new Date(yy, mm, 0).getDate();
        const monthEnd = `${yy}-${String(mm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

        // Note: column is `set_at` (not `created_at`) — the latter
        // doesn't exist on employee_shifts. PostgREST silently returns
        // null for missing columns, which had the assignment-attribution
        // line in emails dropping the date. Confirmed against the
        // information_schema (2026-05-07).
        const data = await directGet(
          `employee_shifts?select=employee_id,shift_date,start_time,end_time,status,set_by,set_at` +
          `&status=in.(pending,accepted)` +
          `&shift_date=gte.${monthStart}&shift_date=lte.${monthEnd}`
        );
        if (!cancelled) setAcceptedShifts(data || []);
      } catch (e) {
        console.warn('Could not fetch month shifts:', e);
        if (!cancelled) setAcceptedShifts([]);
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate, yesterdayDate, rosterRefreshTick]);

  // Roster-level shift plan fetch — captures staff who are flagged
  // as "shift-eligible" for the month in monthly_shift_plans, even
  // when their manager hasn't yet created specific per-date entries
  // in employee_shifts. Without this, a night-shift staff whose
  // manager hasn't entered the daily schedule looks like office
  // staff to the email engine — generic policy bullets, no shift
  // mention, no manager attribution. Combining both sources ensures
  // we treat them as shift-flow as soon as they're on any month's
  // roster (Nadeem 2026-05-07: "the email does not mention his
  // staff time" for Jasim was caused by exactly this gap).
  const [shiftRosterStaff, setShiftRosterStaff] = useState(new Set());
  // Per-employee off-day pattern from monthly_shift_plans.off_weekdays.
  // Map: empKey (uppercase PSN) → Set<number> of weekday integers
  // (0=Sun … 6=Sat) that the manager has explicitly marked as off-days.
  // Loaded alongside shiftRosterStaff so the roster gap detector below
  // can skip off-pattern weekdays — manager-marked off-days were
  // previously being counted as gaps because the detector only looked
  // at employee_shifts (working assignments), not off_weekdays
  // (deliberate planned-off pattern). Per Nadeem 2026-05-10 report:
  // Fahad's 5 OFF-days in May were all flagged as gaps. Bug.
  const [offWeekdaysByEmp, setOffWeekdaysByEmp] = useState(new Map());
  useEffect(() => {
    if (!csvDate) { setShiftRosterStaff(new Set()); setOffWeekdaysByEmp(new Map()); return; }
    let cancelled = false;
    (async () => {
      try {
        const [yy, mm] = csvDate.split('-').map(Number);
        const planMonth = `${yy}-${String(mm).padStart(2, '0')}-01`;
        const data = await directGet(
          `monthly_shift_plans?select=employee_id,off_weekdays&plan_month=eq.${planMonth}&shifts_count=gt.0`
        );
        if (!cancelled) {
          const s = new Set();
          const offMap = new Map();
          (data || []).forEach(r => {
            if (!r?.employee_id) return;
            const key = String(r.employee_id).toUpperCase();
            s.add(key);
            // off_weekdays is a Postgres integer[] column → returns as
            // a JS array, or null if never set. Guard for both.
            if (Array.isArray(r.off_weekdays) && r.off_weekdays.length) {
              offMap.set(key, new Set(r.off_weekdays.map(Number)));
            }
          });
          setShiftRosterStaff(s);
          setOffWeekdaysByEmp(offMap);
        }
      } catch (e) {
        console.warn('Could not fetch monthly shift roster:', e);
        if (!cancelled) {
          setShiftRosterStaff(new Set());
          setOffWeekdaysByEmp(new Map());
        }
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate, rosterRefreshTick]);

  // Mawani visits for the CSV's month. The classifier short-circuits
  // any (employee, date) pair that's a logged Mawani visit — the
  // staff is on official duty, so any punch-in/out pattern is
  // acceptable and shouldn't trigger late/early/missed classification.
  // Cancelled visits are excluded server-side.
  useEffect(() => {
    if (!csvDate) { setMawaniDays(new Set()); return; }
    let cancelled = false;
    (async () => {
      try {
        const [yy, mm] = csvDate.split('-').map(Number);
        const monthStart = `${yy}-${String(mm).padStart(2, '0')}-01`;
        const lastDay = new Date(yy, mm, 0).getDate();
        const monthEnd = `${yy}-${String(mm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        const data = await directGet(
          `mawani_visits?select=employee_id,visit_date` +
          `&status=neq.cancelled` +
          `&visit_date=gte.${monthStart}&visit_date=lte.${monthEnd}`
        );
        if (cancelled) return;
        const s = new Set();
        (data || []).forEach(r => {
          if (r?.employee_id && r?.visit_date) {
            s.add(`${String(r.employee_id).toUpperCase()}|${r.visit_date}`);
          }
        });
        setMawaniDays(s);
      } catch (e) {
        // Table may not exist yet — degrade silently to "no Mawani
        // visits known" so the rest of the daily flow keeps working
        // until the migration runs.
        if (!cancelled) setMawaniDays(new Set());
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate, yesterdayDate]);

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
        // Tier 1 fix (#2 / item 1 — UTC drift): use local-time helpers
        // so month bounds match Bashaier's local view of the month.
        const monthStart = monthStartIso(csvDate);
        const monthEnd   = monthEndIso(csvDate);
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

  // Half-day leave lookup. Returns the matching leave row when the
  // employee is on HALF-day leave for this date — null otherwise.
  // Used to relax late/early/missed evaluations on half-day staff:
  //   • morning leave  → punches expected only in the afternoon (~13:00–17:00)
  //   • afternoon leave → punches expected only in the morning   (~08:00–12:00)
  // Without this, a staff on morning leave who punches in at 13:00
  // would be flagged as "late by 5 hours" — clearly wrong since the
  // morning was approved leave.
  const halfDayLeaveOnDate = useCallback((empId, dateStr) => {
    if (!dateStr) return null;
    const row = approvedLeaves.find(l =>
      String(l.employee_id) === String(empId)
      && l.start_date <= dateStr
      && l.end_date   >= dateStr
      && l.is_half_day === true
    );
    return row || null;
  }, [approvedLeaves]);

  // P4: fast lookup of accepted-shift override for the current csvDate, keyed
  // by employee_id (uppercased). Stored as { startStr, endStr } — the time
  // strings are normalised to 'HH:MM' (Postgres returns 'HH:MM:SS').
  // Index of accepted shifts keyed by (employee_id, shift_date) so
  // detection can pick the right override for the row it's looking
  // at. If we keyed by employee_id alone, today's shift would
  // overwrite yesterday's (or vice versa) and the wrong cutoff
  // would apply to one of the two dates.
  const shiftOverrideById = useMemo(() => {
    const m = {};
    (acceptedShifts || []).forEach(s => {
      if (!s?.employee_id || !s?.start_time || !s?.end_time || !s?.shift_date) return;
      // Defensive slice to first 10 chars: shift_date is a DATE column
      // and PostgREST should return YYYY-MM-DD, but if anything ever
      // returns a timestamp ('2026-05-03T00:00:00…') the gap detector
      // key would silently miss. Slicing keeps both formats matching.
      const datePart = String(s.shift_date).slice(0, 10);
      const key = `${String(s.employee_id).toUpperCase()}|${datePart}`;
      m[key] = {
        startStr: String(s.start_time).slice(0, 5),
        endStr:   String(s.end_time).slice(0, 5),
        status:   s.status, // 'pending' or 'accepted' — kept for surfacing in the UI
        // Manager attribution — surfaces in the violation email so the
        // staff sees who assigned the shift and when. Per Nadeem
        // (2026-05-06): "remind the staff this manager has assigned
        // the days and time".
        setBy:    s.set_by || null,
        assignedAt: s.set_at || null,
      };
    });
    return m;
  }, [acceptedShifts]);

  // Set of employees who are on a shift roster THIS MONTH. If an
  // employee has any shift assigned (pending or accepted) for any
  // day in the CSV's month, they're treated as shift staff for the
  // whole month. This drives the "off-day" detection: a shift staff
  // member with no shift on the CSV's date is on their planned
  // off-day, NOT absent or late.
  //
  // Stored as a Set of uppercase PSNs. acceptedShifts already covers
  // the whole month (the fetch above expanded the window), so a
  // single pass populates it.
  const shiftStaffThisMonth = useMemo(() => {
    const s = new Set();
    // Source A: staff with at least one specific shift entry in
    // employee_shifts (any status not declined/cancelled).
    (acceptedShifts || []).forEach(row => {
      if (row?.employee_id) s.add(String(row.employee_id).toUpperCase());
    });
    // Source B: staff flagged on the monthly_shift_plans roster
    // for the month, even if the manager hasn't yet created daily
    // shift entries. Critical for early-month uploads or weeks
    // where shifts get assigned only when needed — without B, the
    // email engine wrongly treats them as office staff and skips
    // shift-aware wording.
    shiftRosterStaff.forEach(empKey => s.add(empKey));
    return s;
  }, [acceptedShifts, shiftRosterStaff]);

  // Per-employee monthly shift list — used by the off-roster
  // diagnostic to show, for each employee in the off-roster
  // bucket, the FULL set of dates the manager has planned for
  // them this month plus each shift's status. Lets Bashaier
  // (and Nadeem) immediately spot whether a gap is a missing
  // plan, a declined shift, or a partial save.
  //
  // Map shape: empKey → Array<{ date, startStr, endStr, status }>
  // sorted ascending by date.
  const monthlyShiftsByEmp = useMemo(() => {
    const m = {};
    (acceptedShifts || []).forEach(row => {
      if (!row?.employee_id) return;
      const k = String(row.employee_id).toUpperCase();
      if (!m[k]) m[k] = [];
      m[k].push({
        date:     row.shift_date,
        startStr: String(row.start_time || '').slice(0, 5),
        endStr:   String(row.end_time || '').slice(0, 5),
        status:   row.status || 'pending',
      });
    });
    Object.values(m).forEach(arr => arr.sort((a, b) => a.date.localeCompare(b.date)));
    return m;
  }, [acceptedShifts]);


  // ── Night-shift bridge ────────────────────────────────────────────
  // Maps the END day of a night shift back to its START day. Keyed
  // by `${employee}|${endDate}` where endDate = startDate + 1 day,
  // valued by the original night shift { startDate, startStr, endStr }.
  //
  // Why this exists: the fingerprint export aggregates punches by
  // calendar day. A staff member working 23:00 → 07:00 next day
  // shows up in the export as TWO single-punch rows:
  //
  //   Day 1 (start day): First Punch 23:00, Last Punch 23:00 (or empty)
  //   Day 2 (end day):   First Punch 07:00, Last Punch 07:00 (or empty)
  //
  // Without bridging, both rows look like missed-punch days. With the
  // bridge index, detection can recognise the END-day row as the
  // second half of yesterday's night shift and score the punch-out
  // against yesterday's end_time — and conversely, recognise the
  // START-day row as a night-shift-start and score the punch-in
  // against tonight's start_time.
  const nightShiftBridge = useMemo(() => {
    const m = {};
    Object.entries(shiftOverrideById).forEach(([key, ov]) => {
      if (!ov?.startStr || !ov?.endStr) return;
      // Night shift = start time later than end time (e.g. 23:00 > 07:00)
      if (ov.startStr <= ov.endStr) return;
      const [empKey, startDate] = key.split('|');
      // Compute next-day date string (locally — no UTC drift)
      const [y, mo, d] = startDate.split('-').map(Number);
      const nextDt = new Date(y, mo - 1, d + 1);
      const yy = nextDt.getFullYear();
      const mm = String(nextDt.getMonth() + 1).padStart(2, '0');
      const dd = String(nextDt.getDate()).padStart(2, '0');
      const endDate = `${yy}-${mm}-${dd}`;
      m[`${empKey}|${endDate}`] = {
        startDate,
        startStr: ov.startStr,
        endStr:   ov.endStr,
        setBy:    ov.setBy || null,
        assignedAt: ov.assignedAt || null,
      };
    });
    return m;
  }, [shiftOverrideById]);

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

  // ── Roster gap detection (#2 — Phase 1) ──────────────────────────
  // Surfaces working days for shift staff where the manager has not
  // assigned a shift in employee_shifts. The point: convert silent
  // fallback-to-office-hours into a visible roster-completion signal
  // so managers can fill gaps before HR violation emails go out
  // against staff for dates that should have been shift days.
  //
  // What counts as a gap, for each employee in shiftStaffThisMonth:
  //   - Date is within the current month (1st through today)
  //   - No employee_shifts row for {empId, date} (status pending OR
  //     accepted both count as "assigned"; only the absence is a gap)
  //   - Not a Saudi weekend (Fri = 5, Sat = 6) — we don't expect
  //     managers to assign weekends by default; weekend shifts are
  //     opt-in and surface separately via the weekend bucket
  //   - Employee is not on approved leave that day
  //   - Date is not a designated Mawani-visit day (BIZ-team trips
  //     scheduled portal-side)
  //
  // Output: array of manager groups, each carrying their direct
  // reports' gap dates. Sorted by gap count descending so the worst
  // offenders surface first.
  const rosterGaps = useMemo(() => {
    if (!csvDate) return { totalGaps: 0, totalStaff: 0, byManager: [] };
    // The month under review = the month of the file's csvDate. This
    // matches the rest of the page's monthly framing (acceptedShifts,
    // monthlyShiftsByEmp, etc.) — single source of truth.
    const [yStr, mStr] = csvDate.split('-');
    const year  = Number(yStr);
    const month = Number(mStr); // 1–12
    const today = new Date();
    const isSameMonth = (today.getFullYear() === year && today.getMonth() + 1 === month);
    // For the current month, only check up to today. For a past
    // month being reviewed, check the entire month.
    const daysInMonth = new Date(year, month, 0).getDate();
    const lastDay = isSameMonth ? today.getDate() : daysInMonth;

    // Per-staff gap counts — only employees who are on the monthly
    // shift roster (i.e. have at least one shift assignment this
    // month) are evaluated. Office-only staff are out of scope.
    const staffGaps = {}; // empKey → { empId, name, managerId, gapDates: [] }

    shiftStaffThisMonth.forEach(empKey => {
      const emp = empById[empKey];
      if (!emp) return;
      // SUP-team staff (Bashaier marked them as office hours) are
      // skipped — Bashaier's marker overrides any shift assignment,
      // so a shift gap is meaningless for them.
      const isSup = String(emp.department || '').toUpperCase() === 'SUP';
      if (isSup) return;

      const gapDates = [];
      // Per-employee off-pattern (from monthly_shift_plans.off_weekdays).
      // Empty Set when none configured. Manager-marked off-weekdays
      // are NOT gaps — they're deliberately planned non-working days,
      // same as Fri/Sat. Pre-fix, Fahad's 4 OFF days in week 1 of
      // May (Sun/Tue/Wed/Thu, all manager-stamped OFF) were every
      // single one being counted as an unassigned gap. Now skipped.
      const offSet = offWeekdaysByEmp.get(empKey) || null;
      for (let d = 1; d <= lastDay; d++) {
        const dt = new Date(year, month - 1, d);
        const dow = dt.getDay(); // 0=Sun ... 5=Fri, 6=Sat
        if (dow === 5 || dow === 6) continue; // Saudi weekend
        if (offSet && offSet.has(dow)) continue; // manager-marked off-day for this staff

        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

        // Gap conditions
        if (shiftOverrideById[`${empKey}|${dateStr}`]) continue; // shift assigned (pending or accepted)
        if (mawaniDays.has(dateStr)) continue;                   // Mawani-visit day (no shift expected)
        if (onLeaveOnDate(emp.id, dateStr)) continue;            // approved leave covers this day

        gapDates.push(dateStr);
      }
      if (gapDates.length > 0) {
        staffGaps[empKey] = {
          empId: emp.id,
          name: emp.name || '',
          managerId: emp.manager_id || null,
          gapDates,
        };
      }
    });

    // Group by managerId
    const byManagerMap = {};
    Object.values(staffGaps).forEach(s => {
      const mid = String(s.managerId || '').toUpperCase() || '__UNASSIGNED__';
      if (!byManagerMap[mid]) {
        const mgr = empById[mid];
        byManagerMap[mid] = {
          managerId: mid === '__UNASSIGNED__' ? null : mid,
          managerName: mgr?.name || (mid === '__UNASSIGNED__' ? '— No manager on file —' : mid),
          staff: [],
          totalGaps: 0,
        };
      }
      byManagerMap[mid].staff.push(s);
      byManagerMap[mid].totalGaps += s.gapDates.length;
    });

    const byManager = Object.values(byManagerMap)
      .map(g => ({ ...g, staff: g.staff.sort((a, b) => b.gapDates.length - a.gapDates.length) }))
      .sort((a, b) => b.totalGaps - a.totalGaps);

    const totalGaps  = byManager.reduce((sum, g) => sum + g.totalGaps, 0);
    const totalStaff = Object.keys(staffGaps).length;
    // totalShiftStaff = how many staff are on the shift roster this
    // month (regardless of whether they have gaps). Used by the card
    // to decide whether to show at all — when there are zero shift
    // staff for the month, the card is meaningless and stays hidden.
    let totalShiftStaff = 0;
    shiftStaffThisMonth.forEach(empKey => {
      const emp = empById[empKey];
      if (!emp) return;
      const isSup = String(emp.department || '').toUpperCase() === 'SUP';
      if (!isSup) totalShiftStaff++;
    });
    return { totalGaps, totalStaff, totalShiftStaff, byManager };
  }, [csvDate, shiftStaffThisMonth, shiftOverrideById, empById, mawaniDays, onLeaveOnDate, offWeekdaysByEmp]);

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
      shiftOffDay: [],   // shift staff who showed up on their planned off-day
      shiftAbsent: [],   // shift staff with assigned shift, zero punches, no leave (#4)
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
      // Skip if on approved leave for THAT specific date. Half-day
      // leaves still skip the row from late/early/missed checks (a
      // half-day staff who punches IN at 13:30 because they had a
      // morning leave should not be flagged as 5 hours late), but the
      // entry carries the half-day metadata so downstream consumers
      // (report cards, calendar tooltips) can label them correctly.
      // Future improvement: split into a separate halfDayLeave bucket
      // and run a relaxed-cutoff late/early check using only the
      // working half of the day. For now the minimum-viable behaviour
      // is "fully suppress flags on half-day leave dates" — same as
      // full-day leave — which avoids false positives.
      const halfDay = halfDayLeaveOnDate(emp.id, rowDate);
      if (onLeaveOnDate(emp.id, rowDate)) {
        if (!out.onLeave.some(x => x.employee?.id === emp.id)) {
          out.onLeave.push({
            id: 'row-' + idx,
            employee: emp,
            isHalfDay: !!halfDay,
            halfDayPeriod: halfDay?.half_day_period || null,
          });
        }
        return;
      }
      // Mawani-visit short-circuit. If the staff member is on a logged
      // Mawani (or other duty) visit for this exact date, they're
      // officially out of office — any punch-in/punch-out pattern is
      // acceptable. Push to onTime so the row downstream gets recorded
      // as 'present' without late/early/missed classification.
      if (mawaniDays.has(`${String(emp.id).toUpperCase()}|${rowDate}`)) {
        const punchInStr  = (row['First Punch'] || '').trim();
        const punchOutStr = (row['Last Punch']  || '').trim();
        out.onTime.push({
          id: 'row-' + idx,
          employee: emp,
          punchInStr,
          punchOutStr,
          dateLabel: rowDate,
          isMawaniVisit: true,  // surfaced in result tile / report
        });
        return;
      }
      const empKey = String(emp.id || '').toUpperCase();
      // Look up the override by (employee, row's date). Each row in
      // a 2-day file may have its own accepted shift — yesterday's
      // override doesn't bleed into today's detection and vice versa.
      const override = shiftOverrideById[`${empKey}|${rowDate}`];
      // Bridge from yesterday: is this row the END of a night shift
      // that STARTED on the previous day? If so, the punch-out check
      // uses the previous day's end_time, and the missed-punch-in
      // check is suppressed (correct: there isn't a fresh punch-in).
      const bridgeFromPrev = nightShiftBridge[`${empKey}|${rowDate}`];

      // ── EXPLICIT SUP-TEAM DESIGNATION OVERRIDES SHIFT STATUS ─────────
      // If Bashaier has marked this employee as 'sup_team' working
      // hours, that's authoritative — they're treated as office staff
      // on 08:00-16:00 regardless of any lingering monthly_shift_plans
      // entries or per-date shift overrides. This protects against
      // stale shift data flagging a SUP employee as off-roster or
      // forcing them onto a custom 13:00-22:00 schedule when they
      // should be evaluated against 16:00 close time.
      const isSupTeamForceOffice = isSupTeam(emp);

      // ── SHIFT-STAFF OFF-DAY ─────────────────────────────────────────
      // If the employee is on a shift roster THIS MONTH but has no
      // shift assigned for this specific date AND no night-shift end
      // bridging from yesterday, they're on their planned off-day.
      // Per the manager's plan that's their weekend equivalent — we
      // skip the standard 08:00-17:00 evaluation entirely.
      //
      // We still surface the row in a dedicated bucket so Bashaier
      // sees that they showed up on an off-day (could be a quirk to
      // note) but it does NOT count as late or absent.
      const isShiftStaffOnRoster = !isSupTeamForceOffice && shiftStaffThisMonth.has(empKey);
      if (isShiftStaffOnRoster && !override && !bridgeFromPrev) {
        out.shiftOffDay.push({
          id: 'row-' + idx,
          row,
          employee: emp,
          dateLabel: rowDate,
          punchInStr:  (row['First Punch'] || '').trim(),
          punchOutStr: (row['Last Punch']  || '').trim(),
        });
        return;
      }

      // Is the override for THIS row a night shift (start > end)?
      // Skip override entirely for SUP-team staff — Bashaier marked
      // them as office hours and that wins over any shift assignment.
      const effectiveOverride = isSupTeamForceOffice ? null : override;
      const isNightShiftStart = !!effectiveOverride && effectiveOverride.startStr > effectiveOverride.endStr;
      const isNightShiftEnd   = !!bridgeFromPrev && !isSupTeamForceOffice;
      const sched = effectiveOverride
        ? {
            startStr: effectiveOverride.startStr,
            endStr:   effectiveOverride.endStr,
            lateCutoffStr:  addMinutesToTime(effectiveOverride.startStr,  +15),
            // Early departure on shifts: strict, no grace. Per Nadeem
            // 2026-05-10 — same rule for office and shift staff. If the
            // shift ends at 17:00, leaving at 16:59 is early. The
            // late-arrival side keeps its +15 minute grace above; only
            // departure is strict.
            earlyCutoffStr: effectiveOverride.endStr,
            label: isNightShiftStart
              ? 'Night shift (' + effectiveOverride.startStr + ' → ' + effectiveOverride.endStr + ' next day)'
              : 'Custom shift (' + effectiveOverride.startStr + '–' + effectiveOverride.endStr + ')',
            isCustom: true,
            isNightShift: isNightShiftStart,
            // Manager who assigned this shift, plus when. Threaded
            // through to the violation email so the staff sees the
            // attribution.
            assignedBy:   effectiveOverride.setBy || null,
            assignedAt:   effectiveOverride.assignedAt || null,
          }
        : scheduleFor(emp);
      const lateCutoffMin   = timeToMinutes(sched.lateCutoffStr);
      const earlyCutoffMin  = timeToMinutes(sched.earlyCutoffStr);
      const scheduledEndMin = timeToMinutes(sched.endStr);
      const punchInStr  = (row['First Punch'] || '').trim();
      const punchOutStr = (row['Last Punch']  || '').trim();
      const punchInMin  = timeToMinutes(punchInStr);
      const punchOutMin = timeToMinutes(punchOutStr);

      // ── NIGHT-SHIFT BRIDGE — END DAY ──────────────────────────────────
      // This row's date is the END of a night shift that started
      // on the previous day. The relevant punch is the morning
      // clock-out. We score it against the previous day's accepted
      // end_time, and SUPPRESS the standard late/missed-punch-in
      // check that would otherwise fire on this date.
      if (isNightShiftEnd) {
        const endStr      = bridgeFromPrev.endStr;
        // Strict — early departure means any time before scheduled end
        // (Nadeem 2026-05-10). Same rule applied across office, SUP,
        // shift, and night-shift end-day check.
        const endCutoffStr = endStr;
        const endCutoffMin = timeToMinutes(endCutoffStr);
        const endMin       = timeToMinutes(endStr);
        // The morning clock-out shows in punchInStr (only punch of
        // the day if no other shifts that date). Fall through to
        // punchOutStr if punchInStr is empty for any reason.
        const outStr = punchInStr || punchOutStr;
        const outMin = timeToMinutes(outStr);
        if (!outMin) {
          // No morning punch found at all — actual missed punch-out
          // on the night shift. Surface as missedOut on the END date,
          // referencing the bridged shift label so the email body
          // and panel header explain the night-shift context.
          out.missedOut.push({
            id: 'row-' + idx, employee: emp, row,
            missingType: 'out',
            punchInStr, punchOutStr,
            scheduledStart: bridgeFromPrev.startStr,
            scheduledEnd:   endStr,
            lateCutoff: addMinutesToTime(bridgeFromPrev.startStr, +15),
            scheduleLabel: 'Night shift (' + bridgeFromPrev.startStr + ' → ' + endStr + ' next day, completed today)',
            isCustomShift: true,
            staffHasShifts: shiftStaffThisMonth.has(empKey),
            assignedBy: bridgeFromPrev.setBy || null,
            assignedAt: bridgeFromPrev.assignedAt || null,
            dateLabel: rowDate,
            isNightShiftEnd: true,
          });
          return;
        }
        if (outMin < endCutoffMin) {
          // Early departure on the night-shift end day. Permission
          // index uses the END date for the early_leave check.
          const permKey = String(emp.id).toUpperCase() + '|early_leave|' + rowDate;
          const perm = permIndex.get(permKey) || null;
          let permStatus = 'EARLY_NO_PERMISSION';
          let minutesBeyond = null;
          if (perm) {
            const permStartMin = timeToMinutes(String(perm.time_from || '').slice(0, 5));
            if (Number.isFinite(permStartMin) && outMin < permStartMin) {
              permStatus = 'EARLY_BEYOND';
              minutesBeyond = permStartMin - outMin;
            } else {
              permStatus = 'EARLY_PERMITTED';
            }
          }
          out.early.push({
            id: 'row-' + idx, employee: emp, row,
            punchOutStr: outStr, punchOutMin: outMin,
            scheduledStart: bridgeFromPrev.startStr,
            scheduledEnd:   endStr,
            lateCutoff: addMinutesToTime(bridgeFromPrev.startStr, +15),
            earlyCutoff: endCutoffStr,
            scheduleLabel: 'Night shift (' + bridgeFromPrev.startStr + ' → ' + endStr + ' next day, completed today)',
            isCustomShift: true,
            staffHasShifts: shiftStaffThisMonth.has(empKey),
            assignedBy: bridgeFromPrev.setBy || null,
            assignedAt: bridgeFromPrev.assignedAt || null,
            minutesEarly: endMin - outMin,
            isSup: isSupTeam(emp),
            permission: perm, permStatus, minutesBeyond,
            dateLabel: rowDate,
            isNightShiftEnd: true,
          });
          return;
        }
        // Worked the full night shift through to (or beyond) the
        // scheduled end time. No violation. Don't add to onTime —
        // that's reserved for fresh-day punch-ins, and a 07:00
        // night-shift end isn't a "first punch in" of the day.
        return;
      }

      // ── TODAY's rows: Late arrival + Missed punch-in ─────────────────
      if (isToday) {
        // Missed punch-in: no first punch on file. Treat as the bigger
        // problem and skip the late check (we don't know when they
        // arrived). Includes "both missing" (probably absent).
        // Exception: night-shift START — we still check late arrival
        // below, and don't expect a punch-out (it'll be tomorrow).
        if (!punchInMin) {
          // SHIFT-DAY ABSENT (#4 — Phase 1): when a shift was
          // explicitly assigned for this date AND zero punches landed
          // AND no leave covers the day, this is no longer a "missed
          // punch" (which suggests staff was at work but the terminal
          // missed it) — it's an unexcused absence on a manager-set
          // shift. Routes to a separate bucket so HR can apply the
          // sterner email tone and so the dashboard counts this
          // distinctly from genuine missed-punch corrections.
          if (sched.isCustom && !punchInMin && !punchOutMin) {
            out.shiftAbsent.push({
              id: 'row-' + idx, employee: emp, row,
              punchInStr, punchOutStr,
              scheduledStart: sched.startStr,
              scheduledEnd: sched.endStr,
              scheduleLabel: sched.label,
              isCustomShift: true,
              isNightShiftStart: !!isNightShiftStart,
              staffHasShifts: shiftStaffThisMonth.has(empKey),
              missingType: 'both',
              isShiftAbsence: true,
              assignedBy: sched.assignedBy || null,
              assignedAt: sched.assignedAt || null,
              dateLabel: rowDate,
            });
            return;
          }
          out.missedIn.push({
            id: 'row-' + idx, employee: emp, row,
            // For night shifts, "missing both" still means absent —
            // they didn't show up for the start of their overnight.
            missingType: !punchOutMin ? 'both' : 'in',
            punchInStr, punchOutStr,
            scheduledStart: sched.startStr,
            scheduledEnd: sched.endStr,
            lateCutoff: sched.lateCutoffStr,
            scheduleLabel: sched.label,
            isCustomShift: !!sched.isCustom,
            staffHasShifts: shiftStaffThisMonth.has(empKey),
            assignedBy: sched.assignedBy || null,
            assignedAt: sched.assignedAt || null,
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
            staffHasShifts: shiftStaffThisMonth.has(empKey),
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
      // SPECIAL CASE — night-shift START on yesterday:
      //   The shift runs 23:00 yesterday → 07:00 today. Yesterday's
      //   relevant punch is the START punch-in (not punch-out — that
      //   lives on today's row, handled by the bridge block above).
      //   We score punch-in for late arrival, and SUPPRESS the
      //   missed-punch-out / early-departure check that would
      //   otherwise fire (correct: there's no punch-out expected
      //   on yesterday's row for an overnight shift).
      if (isYesterday && isNightShiftStart) {
        // For night-shift-START on yesterday's row, the shift-IN
        // punch is the LATEST punch of the day (around shift_start),
        // not the first_punch. The first_punch is typically the
        // end of the PREVIOUS night shift (e.g. ~05:00 from Mon's
        // shift bleeding into Tue's row). Per Nadeem (2026-05-06):
        // overnight shifts span two calendar dates and the punches
        // need to be paired to the correct shift before evaluation.
        //
        // Rule: shiftInStr = last_punch || first_punch.
        //   • Two punches (typical): use last_punch (the 20:00ish entry)
        //   • One punch: that's the only signal — use it
        const shiftInStr = punchOutStr || punchInStr;
        const shiftInMin = timeToMinutes(shiftInStr);
        if (!shiftInMin) {
          // SHIFT-ABSENT on night-shift START: yesterday's row has
          // zero punches, so the staff didn't even start the assigned
          // overnight shift. Sterner classification than missed-punch.
          out.shiftAbsent.push({
            id: 'row-' + idx, employee: emp, row,
            punchInStr, punchOutStr,
            scheduledStart: sched.startStr,
            scheduledEnd:   sched.endStr,
            scheduleLabel: sched.label,
            isCustomShift: true,
            isNightShiftStart: true,
            staffHasShifts: shiftStaffThisMonth.has(empKey),
            missingType: 'both',
            isShiftAbsence: true,
            assignedBy: sched.assignedBy || null,
            assignedAt: sched.assignedAt || null,
            dateLabel: rowDate,
          });
          return;
        }
        if (shiftInMin > lateCutoffMin) {
          const permKey = String(emp.id).toUpperCase() + '|late_arrival|' + rowDate;
          const perm = permIndex.get(permKey) || null;
          let permStatus = 'LATE_NO_PERMISSION';
          let minutesBeyond = null;
          if (perm) {
            const permEndMin = timeToMinutes(String(perm.time_to || '').slice(0, 5));
            if (Number.isFinite(permEndMin) && shiftInMin > permEndMin) {
              permStatus = 'LATE_BEYOND';
              minutesBeyond = shiftInMin - permEndMin;
            } else {
              permStatus = 'LATE_PERMITTED';
            }
          }
          out.late.push({
            id: 'row-' + idx, employee: emp, row,
            // Display the actual shift-IN punch so reports/emails
            // make sense to the staff member ("you punched 21:30,
            // 90 min past 20:00").
            punchInStr: shiftInStr, punchInMin: shiftInMin,
            minutesLate: shiftInMin - lateCutoffMin,
            scheduledStart: sched.startStr,
            scheduledEnd: sched.endStr,
            lateCutoff: sched.lateCutoffStr,
            scheduleLabel: sched.label,
            isCustomShift: true,
            staffHasShifts: shiftStaffThisMonth.has(empKey),
            assignedBy: sched.assignedBy || null,
            assignedAt: sched.assignedAt || null,
            permission: perm, permStatus, minutesBeyond,
            dateLabel: rowDate,
            isNightShiftStart: true,
          });
          return;
        }
        // Arrived within grace on the night shift start. The
        // punch-out check happens tomorrow (on today's row, via
        // the night-shift-end bridge block). Done.
        return;
      }

      if (isYesterday) {
        // Missed punch-out: had a punch-in but no punch-out by EOD.
        // Could be a real missed punch (forgot to clock out) or rare
        // device sync issue. Either way, actionable.
        if (!punchOutMin) {
          // SHIFT-ABSENT (#4): same logic as the today block above —
          // a shift assigned for yesterday with zero punches is an
          // unexcused shift absence, not a missed punch.
          if (sched.isCustom && !punchInMin && !punchOutMin) {
            out.shiftAbsent.push({
              id: 'row-' + idx, employee: emp, row,
              punchInStr, punchOutStr,
              scheduledStart: sched.startStr,
              scheduledEnd: sched.endStr,
              scheduleLabel: sched.label,
              isCustomShift: true,
              staffHasShifts: shiftStaffThisMonth.has(empKey),
              missingType: 'both',
              isShiftAbsence: true,
              assignedBy: sched.assignedBy || null,
              assignedAt: sched.assignedAt || null,
              dateLabel: rowDate,
            });
            return;
          }
          out.missedOut.push({
            id: 'row-' + idx, employee: emp, row,
            missingType: !punchInMin ? 'both' : 'out',
            punchInStr, punchOutStr,
            scheduledStart: sched.startStr,
            scheduledEnd: sched.endStr,
            lateCutoff: sched.lateCutoffStr,
            scheduleLabel: sched.label,
            isCustomShift: !!sched.isCustom,
            staffHasShifts: shiftStaffThisMonth.has(empKey),
            assignedBy: sched.assignedBy || null,
            assignedAt: sched.assignedAt || null,
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
            staffHasShifts: shiftStaffThisMonth.has(empKey),
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
    out.shiftOffDay.sort(byName);
    out.shiftAbsent.sort(byName);
    // weekend already sorted (location → dept → check-in) by the
    // weekendSorted memo downstream — leave the raw out.weekend in
    // file order so the memo's sort owns the canonical order.

    return out;
  }, [parsed.rows, parsed.weekendRows, csvDate, yesterdayDate, empById, empByDigits, onLeaveOnDate, shiftOverrideById, shiftStaffThisMonth, nightShiftBridge, permIndex, mawaniDays]);

  // ─── Silent absences ───────────────────────────────────────────────
  // Staff who are NOT in today's file at all (zero punches, no row)
  // but who exist in the employee directory. Gets categorized into:
  //   - onLeave    — approved leave covers today (no action needed)
  //   - onMawani   — Mawani visit on today (no action needed)
  //   - unexplained — neither, so the absence has no excuse on file
  //
  // Without this view, a staff member who simply never punched today
  // is silently invisible — no row in any detection bucket. Bashaier
  // could only catch them by manually cross-referencing employees vs
  // the file, which isn't scalable. The unexplained list surfaces
  // them so they can be investigated (genuine absence? sick? not
  // enrolled in biometric?) before payroll runs.
  //
  // Limited to today (csvDate). Yesterday's silent absences are also
  // useful but already partially covered by the "no punch in by EOD"
  // missed-out detection on shift staff and the on-leave reconciliation
  // pass; expanding this to yesterday adds noise without much gain.
  const silentAbsences = useMemo(() => {
    const out = { onLeave: [], onMawani: [], unexplained: [] };
    if (!csvDate || csvIsWeekend || !empById) return out;

    // Build the set of staff who have ANY row for today, regardless
    // of whether their punches were complete. Anyone in this set is
    // not silent — they're already in another detection bucket.
    const punchedToday = new Set();
    (parsed.rows || []).forEach(r => {
      if (r.date !== csvDate) return;
      const idRaw = r['Employee ID'] || r.employee_id || r.EmployeeID || r.ID || '';
      const id    = String(idRaw).trim().toUpperCase();
      if (!id) return;
      const norm = id.startsWith('H') ? id : 'H' + id;
      punchedToday.add(norm);
    });

    // Iterate the employee directory. Skip terminated/inactive flags
    // if present on the record so we don't surface ex-employees.
    Object.values(empById).forEach(emp => {
      if (!emp?.id) return;
      if (emp.terminated || emp.is_active === false || emp.status === 'inactive') return;
      const empId = String(emp.id).toUpperCase();
      if (punchedToday.has(empId)) return;

      // Approved leave covers today?
      if (onLeaveOnDate(emp.id, csvDate)) {
        const halfDay = halfDayLeaveOnDate(emp.id, csvDate);
        out.onLeave.push({
          ...emp,
          isHalfDay: !!halfDay,
          halfDayPeriod: halfDay?.half_day_period || null,
        });
        return;
      }

      // Mawani visit on today? mawaniDays is keyed by 'EMPID|DATE'.
      if (mawaniDays && mawaniDays.has(empId + '|' + csvDate)) {
        out.onMawani.push(emp);
        return;
      }

      // Otherwise — unexplained. Could be: sick (no leave logged),
      // not enrolled in biometric, terminated but still on roster,
      // or a genuine no-show. Bashaier reviews and decides.
      out.unexplained.push(emp);
    });

    // Stable sort by name so the list is consistent across renders.
    const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
    out.onLeave.sort(byName);
    out.onMawani.sort(byName);
    out.unexplained.sort(byName);
    return out;
  }, [csvDate, csvIsWeekend, empById, parsed.rows, onLeaveOnDate, halfDayLeaveOnDate, mawaniDays]);

  // ─── Persist daily attendance to attendance_daily ──────────────────
  // Every successful parse triggers a write of one row per
  // (employee, date) to attendance_daily. Re-uploads upsert on the
  // (employee_id, attendance_date) unique key, so fixing a mistake
  // just means re-uploading the corrected file.
  //
  // Powers the AttendanceMonthGrid calendar — Bashaier sees a
  // rolling month-view of who was present / late / absent / on leave
  // accumulating as she processes each day's file.
  //
  // Per-leave-type lookup: the recorder needs to know whether an
  // approved leave is annual vs sick to set the right status.
  const leaveTypesById = useMemo(() => {
    const m = new Map();
    (leaveTypes || []).forEach(t => { if (t?.id) m.set(t.id, t); });
    return m;
  }, [leaveTypes]);

  // empId|date → { type, typeId, requestId } — only for dates inside the
  // upload window. Used by buildAttendanceRows to set the per-leave-type
  // status (annual_leave / sick_leave / maternity_leave / etc.) correctly.
  // typeId is the canonical leave_type_id; typeName is human-readable.
  const leaveByEmpDateMap = useMemo(() => {
    const m = new Map();
    (approvedLeaves || []).forEach(l => {
      const t = leaveTypesById.get(l.leave_type_id);
      const typeName = t?.name || '';
      // Walk every date in the leave's [start, end] range so a
      // multi-day leave can be looked up per-date without runtime
      // iteration. Capped at 60 days to defend against bad data.
      const start = new Date(l.start_date + 'T00:00:00');
      const end   = new Date(l.end_date   + 'T00:00:00');
      for (let i = 0; i < 60; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        if (d > end) break;
        const k = `${l.employee_id}|${localDateString(d)}`;
        m.set(k, {
          type:      typeName,
          typeId:    l.leave_type_id,    // canonical id for per-type status mapping
          requestId: l.id,
        });
      }
    });
    return m;
  }, [approvedLeaves, leaveTypesById]);

  // Last-recorded fingerprint, so the same parse doesn't re-record
  // on every render. Re-record only fires when csvDate changes or
  // the bucket counts shift (i.e. a new file was uploaded).
  const lastRecordedRef = useRef('');
  useEffect(() => {
    if (!csvDate || !parsed.rows?.length) return;
    // Defensive: detection may be undefined for a tick during the
    // state transition right after a new file is parsed. Bail out
    // until the detection memo has resolved — we'll re-run via the
    // dep array when it does.
    if (!detection || !Array.isArray(detection.late)) return;
    const fingerprint = [
      csvDate, yesterdayDate || '',
      detection.late.length, detection.early.length, detection.onTime.length,
      detection.onLeave.length, detection.shiftOffDay.length,
      detection.missedIn.length, detection.missedOut.length,
      parsed.rows.length,
    ].join(':');
    if (lastRecordedRef.current === fingerprint) return;
    lastRecordedRef.current = fingerprint;

    // Wrap the WHOLE setup + dispatch in a try/catch so any
    // synchronous exception (a malformed parsed.rows entry, an
    // unexpected shiftOverrideById key shape, etc.) is logged
    // instead of bubbling up to React and unmounting the tree.
    try {

    // Build per-date sets of employees who appeared in the file +
    // employees who had a shift, so the recorder can detect pure
    // absences (had shift, no row in file, not on leave).
    const fileEmpIdsByDate = new Map(); // date → Set<empId>
    parsed.rows.forEach(r => {
      const dateK = r['Date'];
      if (!dateK) return;
      const psn = String(r['Employee ID'] || '').toUpperCase();
      if (!psn) return;
      // Resolve to canonical PSN via empByDigits (handles 5-digit
      // exports without the H prefix)
      const emp = empById.get(psn) || empByDigits.get(psn);
      const empId = emp?.id || psn;
      if (!fileEmpIdsByDate.has(dateK)) fileEmpIdsByDate.set(dateK, new Set());
      fileEmpIdsByDate.get(dateK).add(empId);
    });

    // empId|date → { start, end } for shift lookup in the recorder
    const shiftMapForRecorder = new Map();
    Object.entries(shiftOverrideById).forEach(([k, v]) => {
      const [empId, date] = k.split('|');
      shiftMapForRecorder.set(`${empId}|${date}`, { start: v.startStr, end: v.endStr });
    });

    // Collect dates to record — typically today + yesterday
    const dates = [csvDate, yesterdayDate].filter(Boolean);

    (async () => {
      try {
        const allRows = [];
        for (const date of dates) {
          // Wrap shiftMapForRecorder to be a date-scoped lookup
          const shiftByEmp = new Map();
          for (const [k, v] of shiftMapForRecorder) {
            const [eid, d] = k.split('|');
            if (d === date) shiftByEmp.set(eid, v);
          }
          // Wrap leave map to be date-scoped
          const leaveByEmp = new Map();
          for (const [k, v] of leaveByEmpDateMap) {
            const [eid, d] = k.split('|');
            if (d === date) leaveByEmp.set(eid, v);
          }
          // Shift-staff list for absence detection
          const shiftEmpsForDate = (employees || []).filter(emp =>
            shiftByEmp.has(emp.id)
          );
          const fileEmpIds = fileEmpIdsByDate.get(date) || new Set();

          const rows = buildAttendanceRows({
            date,
            buckets: detection,
            shiftByEmpDate: shiftByEmp,
            leaveByEmpDate: leaveByEmp,
            fileEmpIds,
            shiftEmployees: shiftEmpsForDate,
            recordedBy: me?.id || null,
          });
          allRows.push(...rows);
        }
        if (allRows.length > 0) {
          const delta = await recordAttendanceRows(allRows);
          // Store the delta in component state so the UI can render
          // the 'what changed in this upload' banner — Bashaier needs
          // to know if her 4pm re-upload caught new late-arrivals
          // beyond what her 10am upload saw. Nadeem 2026-05-17.
          setUploadDelta(delta);
          // Toast summary for the close action. The banner stays
          // until the next upload or reset, so she can read it at
          // her own pace; the toast is the immediate confirmation.
          try {
            const newCount   = delta.newRows.length;
            const updCount   = delta.updatedRows.length;
            const unchanged  = delta.unchangedRows.length;
            const isReupload = (newCount + updCount) > 0 && unchanged > 0;
            const evt = new CustomEvent('esauhr_toast', { detail: {
              kind: isReupload ? 'info' : 'success',
              title: isReupload
                ? 'Re-upload processed'
                : 'Attendance recorded',
              body: isReupload
                ? `${newCount} new · ${updCount} updated · ${unchanged} unchanged.`
                : `${delta.total} ${delta.total === 1 ? 'row' : 'rows'} written to attendance master.`,
            }});
            window.dispatchEvent(evt);
          } catch {}
        }
      } catch (e) {
        console.warn('attendance_daily recording failed (non-fatal):', e);
      }
    })();
    } catch (outerErr) {
      // Synchronous setup error — log and bail. Critically, we do
      // NOT rethrow: the recorder is best-effort, the calendar
      // refilling on a future upload is preferable to crashing
      // the whole AttendanceView with a blank screen.
      console.error('attendance_daily recorder setup failed:', outerErr);
    }
  }, [csvDate, yesterdayDate, detection, parsed.rows, employees, empById, empByDigits, shiftOverrideById, leaveByEmpDateMap, me?.id]);

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
      // Clear the delta from any previous upload — the banner should
      // only reflect the file currently being processed.
      setUploadDelta(null);
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

  // Phase C (Decision #4 / option C + Decision #5 / option C):
  //   • reset() is the close action that ends the upload session.
  //     Before clearing parse state, snapshot whether there was a
  //     csvDate (i.e. an actual file was loaded) so we know whether
  //     to fire re-eval. We don't trigger on a "reset before any
  //     file uploaded" — that's just clearing the picker.
  //   • Re-eval runs in the background (fire-and-forget). The user's
  //     close action is instant; the re-eval pipeline does its work
  //     asynchronously and updates the calendar via the refresh tick
  //     when it finishes. Decision #4 / option C: "saves are durable
  //     and incremental, but the close action is the clear handoff
  //     that triggers re-evaluation + calendar refresh".
  const reset = () => {
    const hadActiveSession = !!csvDate;
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
    if (hadActiveSession) {
      // Fire-and-forget — UI doesn't block on this. Errors are
      // captured in reevalState for surfacing later. The calendar
      // refresh tick bumps when the pipeline returns.
      triggerReevaluation({ silent: true });
    }
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

  // ── Tier 1 fix (#4 / item 1): Email idempotency guard ──────────────
  //
  // Prevents accidental double-sends from rapid clicks, network hangs
  // that prompt a retry, or bulk-send race conditions. Each violation
  // entry+mode pair has a 5-minute cooldown after the first send.
  // Within the window, subsequent send attempts no-op and surface a
  // brief toast so the user knows the request was deliberately
  // ignored.
  //
  // State lives in a useRef Map (in-memory, session-scoped) keyed by
  // `${entry.id}|${mode}`. Reloading the page clears it — that's fine,
  // a fresh session can legitimately re-send. The cooldown protects
  // against double-clicks within the same session.
  const emailSendCooldownRef = useRef(new Map());
  const EMAIL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
  const checkEmailCooldown = useCallback((entryId, mode) => {
    const key = `${entryId}|${mode}`;
    const lastAt = emailSendCooldownRef.current.get(key);
    const now = Date.now();
    if (lastAt && (now - lastAt) < EMAIL_COOLDOWN_MS) {
      const minsAgo = Math.max(1, Math.floor((now - lastAt) / 60000));
      try {
        window.dispatchEvent(new CustomEvent('esauhr_toast', { detail: {
          kind: 'warning',
          title: 'Email already sent',
          body: `This notice was sent ${minsAgo} ${minsAgo === 1 ? 'minute' : 'minutes'} ago. Wait 5 minutes before re-sending if needed.`,
        }}));
      } catch {}
      return false; // blocked
    }
    emailSendCooldownRef.current.set(key, now);
    return true; // ok to send
  }, []);

  // mode: 'live' (production wording, references the ESAU HR Portal)
  //     | 'test' (pre-launch wording, drops portal references and asks
  //               for an email-reply explanation instead)
  // Default is 'live' so any caller that doesn't pass the param gets
  // the production behaviour. The per-row Test buttons explicitly pass
  // mode='test'.
  const handleEmailLate = (entry, mode = 'live') => {
    if (!checkEmailCooldown(entry.id, mode)) return;
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
      isCustomShift: !!entry.isCustomShift,
      scheduleLabel: entry.scheduleLabel || null,
      isNightShiftStart: !!entry.isNightShiftStart,
      assignedBy: entry.assignedBy || null,
      assignedAt: entry.assignedAt || null,
      managerName: (entry.assignedBy
        && String(entry.assignedBy).toUpperCase() === String(entry.employee?.manager_id || '').toUpperCase())
        ? (empById[String(entry.assignedBy).toUpperCase()]?.name || null)
        : null,
      // staffHasShifts — true when the staff member is on the monthly
      // shift roster, even if THIS specific date was not assigned a
      // shift. Lets the email apply shift-aware wording, bullets, and
      // attribution for shift workers caught on unassigned dates,
      // instead of falling back to office-hours phrasing.
      staffHasShifts: !!entry.staffHasShifts,
      // Always pass the staff's full month roster — buildAssignedShiftsBlock
      // returns '' when empty, so office staff get nothing extra. Per Nadeem
      // (2026-05-07): shift staff should see their assigned roster even if
      // the violation row itself wasn't classified as a shift day (e.g. a
      // missed-OUT on a date the manager hadn't yet assigned, or any row
      // where override detection didn't fire).
      assignedShifts: monthlyShiftsByEmp[String(entry.employee.id).toUpperCase()] || [],
      violationDate: entry.dateLabel || csvDate,
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
    if (!checkEmailCooldown(entry.id, mode)) return;
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
      isCustomShift: !!entry.isCustomShift,
      scheduleLabel: entry.scheduleLabel || null,
      isNightShiftEnd: !!entry.isNightShiftEnd,
      scheduledStart: entry.scheduledStart,
      assignedBy: entry.assignedBy || null,
      assignedAt: entry.assignedAt || null,
      managerName: (entry.assignedBy
        && String(entry.assignedBy).toUpperCase() === String(entry.employee?.manager_id || '').toUpperCase())
        ? (empById[String(entry.assignedBy).toUpperCase()]?.name || null)
        : null,
      // staffHasShifts — true when the staff member is on the monthly
      // shift roster, even if THIS specific date was not assigned a
      // shift. Lets the email apply shift-aware wording, bullets, and
      // attribution for shift workers caught on unassigned dates,
      // instead of falling back to office-hours phrasing.
      staffHasShifts: !!entry.staffHasShifts,
      // Always pass the staff's full month roster — buildAssignedShiftsBlock
      // returns '' when empty, so office staff get nothing extra. Per Nadeem
      // (2026-05-07): shift staff should see their assigned roster even if
      // the violation row itself wasn't classified as a shift day (e.g. a
      // missed-OUT on a date the manager hadn't yet assigned, or any row
      // where override detection didn't fire).
      assignedShifts: monthlyShiftsByEmp[String(entry.employee.id).toUpperCase()] || [],
      violationDate: entry.dateLabel || csvDate,
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
    if (!checkEmailCooldown(entry.id, mode)) return;
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
      isShiftAbsence: !!entry.isShiftAbsence,
      isCustomShift: !!entry.isCustomShift,
      scheduleLabel: entry.scheduleLabel || null,
      scheduledStart: entry.scheduledStart || null,
      scheduledEnd: entry.scheduledEnd || null,
      isNightShiftStart: !!entry.isNightShiftStart,
      isNightShiftEnd:   !!entry.isNightShiftEnd,
      assignedBy: entry.assignedBy || null,
      assignedAt: entry.assignedAt || null,
      managerName: (entry.assignedBy
        && String(entry.assignedBy).toUpperCase() === String(entry.employee?.manager_id || '').toUpperCase())
        ? (empById[String(entry.assignedBy).toUpperCase()]?.name || null)
        : null,
      // staffHasShifts — true when the staff member is on the monthly
      // shift roster, even if THIS specific date was not assigned a
      // shift. Lets the email apply shift-aware wording, bullets, and
      // attribution for shift workers caught on unassigned dates,
      // instead of falling back to office-hours phrasing.
      staffHasShifts: !!entry.staffHasShifts,
      // Always pass the staff's full month roster — buildAssignedShiftsBlock
      // returns '' when empty, so office staff get nothing extra. Per Nadeem
      // (2026-05-07): shift staff should see their assigned roster even if
      // the violation row itself wasn't classified as a shift day (e.g. a
      // missed-OUT on a date the manager hadn't yet assigned, or any row
      // where override detection didn't fire).
      assignedShifts: monthlyShiftsByEmp[String(entry.employee.id).toUpperCase()] || [],
      violationDate: entry.dateLabel || csvDate,
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

  // No-show email — sent TO the line manager (CC the staff member and
  // the fixed execs). The manager is asked to provide the reason for
  // the absence, since neither a punch nor a leave request is on file.
  // Reversed recipients vs the late/early/missed emails (those go TO
  // the staff). Nadeem 2026-06-02.
  const handleEmailNoShow = (entry, mode = 'live') => {
    if (!checkEmailCooldown(entry.id, mode)) return;
    const emp = entry.employee;
    const dateLong = formatDateLong(entry.dateLabel || csvDate);
    const mgrEmail = getManagerEmail(emp);
    const mgr = emp.manager_id ? empById[String(emp.manager_id).toUpperCase()] : null;
    const mgrName = mgr?.name || 'Manager';
    const testTag = mode === 'test' ? '[TEST] ' : '';
    const subject = `${testTag}Attendance — ${emp.name} (${emp.id}) absent on ${dateLong}, reason required`;
    const body =
      `Dear ${mgrName},\n\n` +
      `Our daily attendance review for ${dateLong} shows no sign-in on record for ${emp.name} (${emp.id}), ` +
      `and there is no approved leave or permission request on file for this date. The day is therefore recorded as an unexplained absence.\n\n` +
      `Kindly confirm the reason for the absence with the staff member and advise HR accordingly. If the absence was for an approved reason (medical, emergency, etc.), please ensure the appropriate leave request is submitted through the ESAU HR Portal (esauhr.netlify.app) so the record can be updated. Otherwise it will stand as an unexcused absence on the evaluation record.\n\n` +
      `${emp.name}, you are copied for your awareness and to provide your reason.\n\n` +
      `Thanks and regards,\n` +
      `BASHAIER ALI\n` +
      `ESAU - SADMN SUP / HR DEPT`;
    const cc = [emp.email, ...FIXED_CC].filter(Boolean);
    const url = buildMailto({ to: mgrEmail || emp.email, cc, subject, body });
    if (mode !== 'test') {
      logViolation({
        entry,
        violationType: 'absent',
        minutesOff: null,
        scheduledStart: entry.scheduledStart || '08:00',
        scheduledEnd: entry.scheduledEnd,
      });
    }
    window.location.href = url;
  };

  // ─── Render ────────────────────────────────────────────────────────────
  const hasFile = !!xlsxFileName;

  // Auto-open the daily-review modal as soon as a file is parsed.
  // Triggered on the transition from no-file to has-file so we don't
  // re-open if Bashaier has already closed it.
  const lastHasFileRef = useRef(false);
  useEffect(() => {
    if (hasFile && !lastHasFileRef.current) {
      setDailyReviewOpen(true);
    }
    lastHasFileRef.current = hasFile;
  }, [hasFile]);

  // Date sanity flags — surface as a banner above the count summary.
  // These detect the most common upload mistakes:
  //   • TODAY  — file is for today's date; staff haven't punched out
  //              yet, so most rows will look INCOMPLETE
  //   • STALE  — file is for a date >7 days old; possibly the wrong file
  //   • FUTURE — file is for a date after today; almost certainly a
  //              wrong export or device clock drift
  const dateSanity = useMemo(() => {
    if (!csvDate) return null;
    const todayIso = todayLocal();
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
    const cutoffIso = localDateString(cutoff);
    directGet(
      'attendance_review_log',
      'select=review_date,morning_at,eod_at'
        + '&review_date=gte.' + cutoffIso
        + '&order=review_date.desc',
      { timeoutMs: 6000 }
    )
      .then(rows => {
        if (cancelled) return;
        const today = todayLocal();
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

  // File-volume sanity — biometric hardware occasionally has partial
  // outages (cards not registering, terminal restarts mid-day, network
  // issues uploading some staff's punches). When this happens the file
  // arrives looking normal in shape but with 30-50% fewer rows than a
  // healthy day for the same weekday. Without a check, the system
  // would generate dozens of "missed punch" violations against staff
  // whose terminals just didn't record. Bashaier could end up emailing
  // half the company for someone else's IT problem.
  //
  // The check compares THIS file's unique-staff count (number of staff
  // with at least one punch) to the median of the last 4 same-weekday
  // uploads. We use median (not mean) so a single previous outage
  // doesn't drag the baseline down. Threshold: <60% of baseline = red
  // flag, 60-80% = amber, >=80% = OK.
  //
  // Skip the check on weekends (low-volume by design) and when there
  // aren't enough prior uploads to establish a baseline.
  const [fileVolumeSanity, setFileVolumeSanity] = useState(null);
  useEffect(() => {
    if (!csvDate || csvIsWeekend || !parsedData?.rows?.length) {
      setFileVolumeSanity(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Today's unique-staff count.
        const todayStaff = new Set(parsedData.rows.map(r => r.psn).filter(Boolean)).size;
        if (todayStaff === 0) { setFileVolumeSanity(null); return; }

        // Compute the same weekday across the last 5 weeks (so we have
        // up to 5 same-DOW samples, take the most recent 4 with row
        // count > 0). PostgreSQL DATE arithmetic isn't available via
        // PostgREST query string, so we filter client-side.
        const todayMs = new Date(csvDate + 'T00:00:00Z').getTime();
        const dow     = new Date(csvDate + 'T00:00:00Z').getUTCDay();
        const since = new Date(todayMs - 35 * 86_400_000).toISOString().slice(0, 10);

        const recent = await directGet(
          'attendance_uploads',
          'select=data_date,row_count'
            + '&data_date=gte.' + since
            + '&data_date=lt.'  + csvDate
            + '&order=data_date.desc&limit=20',
          { timeoutMs: 6000 }
        );
        if (cancelled) return;

        const sameDow = (recent || [])
          .filter(r => r?.data_date && typeof r.row_count === 'number' && r.row_count > 0)
          .filter(r => new Date(r.data_date + 'T00:00:00Z').getUTCDay() === dow)
          .map(r => r.row_count)
          .slice(0, 4);

        if (sameDow.length < 2) {
          // Not enough history to make a reliable comparison.
          setFileVolumeSanity(null);
          return;
        }

        // Median of the historical samples (order-statistic, not mean).
        const sorted = [...sameDow].sort((a, b) => a - b);
        const baseline = sorted.length % 2 === 1
          ? sorted[(sorted.length - 1) / 2]
          : Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);

        // Today's file's row_count (parser-level — equivalent to what
        // attendance_uploads.row_count will store on commit).
        const todayRows = parsedData.rows.length;
        const ratio = baseline > 0 ? todayRows / baseline : 1;

        if (ratio < 0.6) {
          setFileVolumeSanity({
            kind: 'PARTIAL_OUTAGE',
            ratio,
            todayRows,
            baseline,
            sampleCount: sameDow.length,
            message: `This file has ${todayRows} rows for ${todayStaff} staff. The recent ` +
                     `${sameDow.length}-${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]} median is ${baseline}. ` +
                     `That's ${Math.round(ratio * 100)}% of the typical volume — likely a partial biometric outage. ` +
                     `Verify with the device admin before sending any missed-punch emails; many "missed" punches may be ` +
                     `unrecorded due to the outage rather than real absences.`,
          });
        } else if (ratio < 0.8) {
          setFileVolumeSanity({
            kind: 'LOW_VOLUME',
            ratio,
            todayRows,
            baseline,
            sampleCount: sameDow.length,
            message: `This file has ${todayRows} rows. The recent ` +
                     `${sameDow.length}-${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][dow]} median is ${baseline} ` +
                     `(${Math.round(ratio * 100)}%). The shortfall could be a normal low-attendance day or a partial ` +
                     `biometric issue — review counts before bulk-emailing.`,
          });
        } else {
          setFileVolumeSanity(null);
        }
      } catch (e) {
        if (!cancelled) setFileVolumeSanity(null);
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate, csvIsWeekend, parsedData]);

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
  const buildLatePanel = (opts = {}) => {
    const { shiftMode = false } = opts;
    const filteredEntries = (detection.late || []).filter(e =>
      shiftMode ? !!e.isCustomShift : !e.isCustomShift
    );
    return (
    <FlaggedSection
      title={shiftMode ? 'Shift staff — Late arrivals' : 'Late arrivals'}
      kicker={shiftMode ? 'BEYOND SHIFT START + 15 MIN GRACE' : 'AFTER ' + LATE_CUTOFF + ' · TODAY'}
      iconColor="#BE123C"
      barFrom="#FB7185" barTo="#BE123C"
      empty={shiftMode ? 'No shift staff flagged for late shift-IN.' : 'Nobody arrived late today — well done team.'}
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'late', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      onExplain={(entry) => setExplainPayload({ entry, kind: 'late' })}
      entries={filteredEntries.map(e => {
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
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E5E5' }}
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
  };
  const buildMissedInPanel = () => (
    <FlaggedSection
      title="Missed punch-in"
      kicker="NO CLOCK-IN ON RECORD · TODAY"
      iconColor="#4338CA"
      barFrom="#818CF8" barTo="#4338CA"
      empty="Every staff member has a punch-in on record for today."
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'missedIn', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      onExplain={(entry) => setExplainPayload({ entry, kind: 'missedIn' })}
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
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E5E5' }}>
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

  // ── SHIFT ABSENCE panel (#4 — Phase 1) ─────────────────────────────
  // Distinct from missed-punch: shift was assigned, no punches landed,
  // no leave on file. The most serious daily-attendance flag we
  // surface. Reuses handleEmailMissed under the hood (same plumbing,
  // sentMarkers, logged state) but renders with a stern subject and
  // tone via the isShiftAbsence flag we set on each entry.
  const buildShiftAbsentPanel = () => (
    <FlaggedSection
      title="Shift absences"
      kicker="ASSIGNED SHIFT · NO PUNCHES · NO LEAVE"
      iconColor="#991B1B"
      barFrom="#F87171" barTo="#991B1B"
      empty="No shift absences flagged."
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'shiftAbsent', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      onExplain={(entry) => setExplainPayload({ entry, kind: 'shiftAbsent' })}
      entries={detection.shiftAbsent.map(e => {
        const types = ['missed_in', 'missed_out'];
        const allLogged = types.every(t => loggedMarkers[e.employee.id + ':' + t]);
        const sentTimestamp = types
          .map(t => loggedMarkers[e.employee.id + ':' + t])
          .find(v => typeof v === 'string') || null;
        return ({
          ...e,
          detail: 'Did not punch in or out on assigned ' + (e.scheduleLabel || 'shift')
            + (e.isNightShiftStart ? ' (overnight start)' : ''),
          metaIcon: <AlertTriangle className="w-4 h-4"/>,
          logged: allLogged,
          actionable: true,
          emailSentAt: sentTimestamp,
          monthlyCount: monthlyCounts[e.employee.id] || 0,
        });
      })}
      renderButton={(entry) => !actionsEnabled ? (
        <span className="text-[10px] tracking-wider font-semibold px-2 py-1 rounded-md"
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E5E5' }}>
          READ-ONLY
        </span>
      ) : (
        <RowButton
          onClick={() => setConfirmEntry({ entry, kind: 'shiftAbsent', mode: 'live' })}
          onClickTest={() => setConfirmEntry({ entry, kind: 'shiftAbsent', mode: 'test' })}
          onMarkSent={() => markSent(entry.id)}
          sent={!!sentMarkers[entry.id]}
          logged={entry.logged}
          emailSentAt={entry.emailSentAt}
          label="Email shift absence notice"
        />
      )}
    />
  );

  // ── NO-SHOW panel — office staff absent without leave ──────────────
  // silentAbsences.unexplained = staff in the directory with no punch
  // today and no approved leave / Mawani on file. Distinct from shift
  // absences (those had an assigned shift). The email goes TO the line
  // manager (CC the staff member) asking them to provide the reason.
  // Nadeem 2026-06-02.
  const buildNoShowPanel = () => (
    <FlaggedSection
      title="Absent (without Notice)"
      kicker="NO SIGN-IN · NO LEAVE REQUEST · TODAY"
      iconColor="#9D174D"
      barFrom="#F472B6" barTo="#9D174D"
      empty="Everyone expected today either punched in or has approved leave."
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'noShow', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      onExplain={(entry) => setExplainPayload({ entry, kind: 'noShow' })}
      entries={(silentAbsences.unexplained || []).map(emp => ({
        id: 'noshow-' + emp.id,
        employee: emp,
        dateLabel: csvDate,
        detail: 'No sign-in recorded for ' + (csvDate || 'today') + ' and no approved leave request on file',
        metaIcon: <AlertTriangle className="w-4 h-4" />,
        logged: !!loggedMarkers[emp.id + ':no_show'],
        actionable: true,
        emailSentAt: (typeof loggedMarkers[emp.id + ':no_show'] === 'string') ? loggedMarkers[emp.id + ':no_show'] : null,
        monthlyCount: monthlyCounts[emp.id] || 0,
      }))}
      renderButton={(entry) => !actionsEnabled ? (
        <span className="text-[10px] tracking-wider font-semibold px-2 py-1 rounded-md"
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E5E5' }}>
          READ-ONLY
        </span>
      ) : (
        <RowButton
          onClick={() => setConfirmEntry({ entry, kind: 'noShow', mode: 'live' })}
          onClickTest={() => setConfirmEntry({ entry, kind: 'noShow', mode: 'test' })}
          onMarkSent={() => markSent(entry.id)}
          sent={!!sentMarkers[entry.id]}
          logged={entry.logged}
          emailSentAt={entry.emailSentAt}
          label="Email manager for reason"
        />
      )}
    />
  );

  const buildEarlyPanel = (opts = {}) => {
    const { shiftMode = false } = opts;
    const filteredEntries = (detection.early || []).filter(e =>
      shiftMode ? !!e.isCustomShift : !e.isCustomShift
    );
    return (
    <FlaggedSection
      title={shiftMode ? 'Shift staff — Early departures' : 'Early departures'}
      kicker={shiftMode ? 'LEFT BEFORE SHIFT END − 15 MIN GRACE' : 'LEFT BEFORE GRACE WINDOW · YESTERDAY'}
      iconColor="#A16207"
      barFrom="#FACC15" barTo="#A16207"
      empty={shiftMode ? 'No shift staff flagged for early shift-OUT.' : 'Nobody left early yesterday — full day attendance recorded.'}
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'early', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      onExplain={(entry) => setExplainPayload({ entry, kind: 'early' })}
      entries={filteredEntries.map(e => {
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
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E5E5' }}>
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
  };
  const buildMissedOutPanel = () => (
    <FlaggedSection
      title="Missed punch-out"
      kicker="NO CLOCK-OUT ON RECORD · YESTERDAY"
      iconColor="#7E22CE"
      barFrom="#C084FC" barTo="#7E22CE"
      empty="Every staff member has a punch-out on record for yesterday."
      onBulk={actionsEnabled ? (rows) => setBulkSession({ kind: 'missedOut', queue: rows, sentIds: new Set(), mode: 'live' }) : null}
      onExplain={(entry) => setExplainPayload({ entry, kind: 'missedOut' })}
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
          style={{ background: '#F4F4EE', color: '#0A0A0A', border: '1px solid #E5E5E5' }}>
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
    // Window dates — driven by the SELECTED weekend's actual Friday
    // and Saturday, not the daily-upload window. The daily window
    // could be Sun→Mon (after a Sunday absence) or anything else
    // that wraps around the weekend, but the report itself is about
    // the weekend, so the header should read "Friday X to Saturday Y"
    // every time. Fall back to the daily window only if we somehow
    // don't have a selected weekend in scope (shouldn't happen, but
    // safe).
    const activeWeekend = availableWeekends.find(w => w.key === selectedWeekendKey)
                       || availableWeekends[0]
                       || null;
    const yDate = activeWeekend ? formatDateLong(activeWeekend.fridayKey)   : formatDateLong(yesterdayDate);
    const tDate = activeWeekend ? formatDateLong(activeWeekend.saturdayKey) : formatDateLong(csvDate);
    const fnameFrom = activeWeekend ? activeWeekend.fridayKey   : yesterdayDate;
    const fnameTo   = activeWeekend ? activeWeekend.saturdayKey : csvDate;

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
    --cream:       #F7F7F7;
    --beige:       #E5E5E5;
    --ink:         #0A0A0A;
    --ink-mute:    #555555;
    --rule:        #F0F0F0;
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
    a.download = `Weekend_Attendance_${fnameFrom}_to_${fnameTo}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [weekendSorted, csvDate, yesterdayDate, me, availableWeekends, selectedWeekendKey]);

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
    // Window — the SELECTED weekend's actual Friday and Saturday, not
    // the daily upload window (same logic as exportWeekendHtml).
    const activeWeekend = availableWeekends.find(w => w.key === selectedWeekendKey)
                       || availableWeekends[0]
                       || null;
    const yDate = activeWeekend ? formatDateLong(activeWeekend.fridayKey)   : formatDateLong(yesterdayDate);
    const tDate = activeWeekend ? formatDateLong(activeWeekend.saturdayKey) : formatDateLong(csvDate);
    const subjFrom = activeWeekend ? activeWeekend.fridayKey   : yesterdayDate;
    const subjTo   = activeWeekend ? activeWeekend.saturdayKey : csvDate;
    const subject = `Weekend Attendance Report \u2014 ${subjFrom} to ${subjTo}`;

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
  }, [weekendSorted, csvDate, yesterdayDate, availableWeekends, selectedWeekendKey]);

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
      <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: '#D4D4D4' }}>
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <div className="text-[10px] mb-1" style={{ color: '#0A0A0A', letterSpacing: '0.25em', fontWeight: 700 }}>
              WEEKEND ATTENDANCE
            </div>
            <div style={{ fontFamily: 'inherit', fontSize: '20px', color: '#0A0A0A' }}>
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
                background: weekendSorted.length ? '#0F4C2A' : '#E5E5E5',
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
                background: weekendSorted.length ? '#FFFFFF' : '#F7F7F7',
                color: weekendSorted.length ? '#0F4C2A' : '#0A0A0A',
                border: '1px solid ' + (weekendSorted.length ? '#0F4C2A' : '#E5E5E5'),
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
                      border: isSel ? '2px solid #0F4C2A' : '0.5px solid #D4D4D4',
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
          <div className="rounded-xl p-6 text-center text-sm" style={{ background: '#F7F7F7', color: '#0A0A0A', opacity: 0.75 }}>
            No staff attended on this weekend.
          </div>
        ) : (
          <div className="space-y-4">
            {[...byDate.entries()].map(([date, rows]) => (
              <div key={date}>
                <div className="text-[10px] mb-2" style={{ color: '#0A0A0A', letterSpacing: '0.25em', fontWeight: 700 }}>
                  {formatDateLong(date).toUpperCase()} &middot; {rows.length} STAFF
                </div>
                <div className="rounded-lg border overflow-hidden" style={{ borderColor: '#E5E5E5' }}>
                  <table className="w-full text-xs" style={{ color: '#0A0A0A' }}>
                    <thead style={{ background: '#F7F7F7' }}>
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
                        <tr key={e.id} style={{ background: i % 2 ? '#FFFFFF' : '#FFFFFF', borderTop: '1px solid #F0F0F0' }}>
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
    ...(dailyPanelsOk && parsed.hasTodayData     ? { late:      buildLatePanel({ shiftMode: false }) }      : {}),
    ...(dailyPanelsOk && parsed.hasTodayData     ? { missedIn:  buildMissedInPanel() }  : {}),
    ...(dailyPanelsOk && parsed.hasYesterdayData ? { early:     buildEarlyPanel({ shiftMode: false }) }     : {}),
    ...(dailyPanelsOk && parsed.hasYesterdayData ? { missedOut: buildMissedOutPanel() } : {}),
    // Shift-staff panels — populated when there's at least one
    // shift-tagged entry. Shifts can fire for either today (night
    // shift START flagged late) or yesterday (early shift-OUT), so
    // we include them whenever the daily window is valid.
    ...(dailyPanelsOk && (detection.late || []).some(e => e.isCustomShift)
      ? { shiftLate:  buildLatePanel({ shiftMode: true }) }  : {}),
    ...(dailyPanelsOk && (detection.early || []).some(e => e.isCustomShift)
      ? { shiftEarly: buildEarlyPanel({ shiftMode: true }) } : {}),
    // Shift absence panel (#4 — Phase 1) — fires whenever there's a
    // manager-assigned shift with zero punches. Distinct from missed
    // punch (which assumes the staff was at work but the terminal
    // dropped a read).
    ...(dailyPanelsOk && detection.shiftAbsent.length
      ? { shiftAbsent: buildShiftAbsentPanel() } : {}),
    // UNIFIED SHIFT STAFF panel — single drilldown surfacing every
    // shift-related signal (gaps, late, early, absences, off-roster)
    // in one place. Per Nadeem (2026-05-07): "shift cases should have
    // one tile as SHIFT STAFF and all activity for them appears when
    // their card is clicked". Each sub-section is read-only here for
    // visibility — emails for late/early/absent still fire from their
    // own panels via the shiftLate/shiftEarly/shiftAbsent kinds, which
    // the per-row buttons inside this unified view link to.
    shiftStaff: (
      <UnifiedShiftStaffPanel
        rosterGaps={rosterGaps}
        empById={empById}
        detection={detection}
        latePanel={dailyPanelsOk ? buildLatePanel({ shiftMode: true }) : null}
        earlyPanel={dailyPanelsOk ? buildEarlyPanel({ shiftMode: true }) : null}
        absentPanel={dailyPanelsOk && detection.shiftAbsent.length ? buildShiftAbsentPanel() : null}
        offRosterCount={(detection.shiftOffDay || []).length}
        offRosterEntries={detection.shiftOffDay || []}
        monthlyShiftsByEmp={monthlyShiftsByEmp}
        onRosterRefresh={() => setRosterRefreshTick(t => t + 1)}
        me={me}
        csvDate={csvDate}
      />
    ),
    ...(dailyPanelsOk && parsed.hasTodayData && (silentAbsences.unexplained || []).length
      ? { noShow: buildNoShowPanel() } : {}),
    ...(detection.weekend.length ? { weekend: buildWeekendPanel() } : {}),
  };

  return (
    <div className="space-y-2" style={{ fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif' }}>
      {/* Removed: large "Attendance." heading + intro paragraph + four
          help tiles. The page is now task-focused — system health pill
          + notifications, then straight to the workspace. */}
      <div>
        {/* Tier 2 fix (#7) — System health pill + notifications row.
            Health pill on the left (always present); notification
            chips on the right when there are warnings. Replaces the
            previous full-width banner cards (dateSanity, anomaly,
            sheetSanity) — those messages are still surfaced, but as
            click-to-expand chips. The detail card slides down below
            this row when a chip is open. */}
        {(() => {
          const now = Date.now();
          const uploadMs = lastUploadAt ? (now - new Date(lastUploadAt).getTime()) : null;
          const reevalMs = reevalState.lastRunAt ? (now - new Date(reevalState.lastRunAt).getTime()) : null;
          const dayMs = 24 * 60 * 60 * 1000;
          let healthState, healthLabel, dotColor, bg, border, fg;
          if (uploadMs == null) {
            healthState = 'unknown';
            healthLabel = 'No uploads yet';
            dotColor = '#9CA3AF'; bg = '#F4F4EE'; border = '#D4D4D4'; fg = '#1F1B16';
          } else if (uploadMs <= dayMs) {
            healthState = 'fresh';
            healthLabel = 'System current';
            dotColor = '#10B981'; bg = '#F0FDF4'; border = '#BBF7D0'; fg = '#064E3B';
          } else if (uploadMs <= 3 * dayMs) {
            healthState = 'aging';
            healthLabel = 'Last upload aging';
            dotColor = '#F59E0B'; bg = '#FFFBEB'; border = '#FDE68A'; fg = '#78350F';
          } else {
            healthState = 'stale';
            healthLabel = 'System stale';
            dotColor = '#DC2626'; bg = '#FEF2F2'; border = '#FCA5A5'; fg = '#7F1D1D';
          }
          const fmtRel = (ms) => {
            if (ms == null) return '—';
            const mins = Math.floor(ms / 60000);
            if (mins < 1) return 'just now';
            if (mins < 60) return `${mins} min ago`;
            const hrs = Math.floor(mins / 60);
            if (hrs < 24) return `${hrs} h ago`;
            return `${Math.floor(hrs / 24)} d ago`;
          };
          const cronMs = lastCronAt?.finished_at ? (now - new Date(lastCronAt.finished_at).getTime()) : null;
          const tooltipParts = [
            `Last upload: ${fmtRel(uploadMs)}`,
            `Last re-evaluation: ${fmtRel(reevalMs)}`,
            cronMs != null
              ? `Last overnight cron: ${fmtRel(cronMs)}${lastCronAt?.rows_updated ? ` (${lastCronAt.rows_updated} rows updated)` : ''}`
              : null,
            healthState === 'stale' ? 'Upload today\'s time card to refresh.' : null,
            healthState === 'aging' ? 'Consider uploading a fresh time card.' : null,
          ].filter(Boolean);

          // Build the active notifications list. Each entry has:
          //   id      — unique string for openNotice state
          //   label   — 1-word chip text
          //   tone    — 'amber' | 'red' (drives chip color)
          //   title   — bold heading inside the expanded card
          //   body    — paragraph text inside the expanded card
          const notifications = [];
          if (hasFile && dateSanity) {
            notifications.push({
              id: 'date',
              label: dateSanity.kind === 'TODAY' ? 'Today' : dateSanity.kind === 'FUTURE' ? 'Future date' : 'Stale date',
              tone: dateSanity.kind === 'FUTURE' ? 'red' : 'amber',
              title: dateSanity.label + '.',
              body: dateSanity.kind === 'TODAY'
                ? "This file is for today — staff who haven't punched out yet will appear as Incomplete. Wait until end of day for a complete picture."
                : dateSanity.kind === 'FUTURE'
                  ? `The data date (${formatDateLong(csvDate)}) is in the future. Likely the wrong file — please verify before sending notices.`
                  : `The data date (${formatDateLong(csvDate)}) is ${dateSanity.ageDays} days old. Make sure this is the file you intended to process.`,
            });
          }
          if (hasFile && !csvIsWeekend && anomaly?.kind === 'MOSTLY_INCOMPLETE') {
            notifications.push({
              id: 'incomplete',
              label: 'Incomplete',
              tone: 'amber',
              title: 'Most rows look incomplete.',
              body: anomaly.message,
            });
          }
          if (hasFile && sheetSanity) {
            notifications.push({
              id: 'sheet',
              label: 'Sheet name',
              tone: sheetSanity.kind === 'SHEET_BEFORE_DATA' ? 'red' : 'amber',
              title: sheetSanity.kind === 'SHEET_BEFORE_DATA' ? 'Sheet name pre-dates the data.' : 'Sheet name far from data date.',
              body: sheetSanity.message,
            });
          }
          if (hasFile && fileVolumeSanity) {
            notifications.push({
              id: 'volume',
              label: fileVolumeSanity.kind === 'PARTIAL_OUTAGE' ? 'Possible outage' : 'Low volume',
              tone: fileVolumeSanity.kind === 'PARTIAL_OUTAGE' ? 'red' : 'amber',
              title: fileVolumeSanity.kind === 'PARTIAL_OUTAGE'
                ? 'Possible biometric outage detected.'
                : 'File volume below typical.',
              body: fileVolumeSanity.message,
            });
          }

          const toneStyles = {
            amber: { chipBg: '#FFFBEB', chipBorder: '#FDE68A', chipFg: '#78350F', dot: '#F59E0B', cardBg: '#FFFBEB', cardBorder: '#F59E0B' },
            red:   { chipBg: '#FEF2F2', chipBorder: '#FCA5A5', chipFg: '#7F1D1D', dot: '#DC2626', cardBg: '#FEF2F2', cardBorder: '#DC2626' },
          };

          const openNotif = notifications.find(n => n.id === openNotice);

          return (
            <div className="mt-3">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Standalone health pill removed — the same status now
                    appears inline in the Monthly Overview buttons row
                    (more compact, single update line). */}
                {notifications.map(n => {
                  const t = toneStyles[n.tone];
                  const isOpen = openNotice === n.id;
                  return (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => setOpenNotice(isOpen ? null : n.id)}
                      className="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-full transition-all hover:-translate-y-0.5"
                      style={{
                        background: t.chipBg,
                        border: `1px solid ${t.chipBorder}`,
                        color: t.chipFg,
                        fontWeight: 600,
                        boxShadow: isOpen ? `0 0 0 2px ${t.cardBorder}` : undefined,
                        cursor: 'pointer',
                      }}
                      aria-expanded={isOpen}
                      title={`${n.title} Click to ${isOpen ? 'hide' : 'see'} details.`}>
                      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: t.dot }} />
                      <span>{n.label}</span>
                      <span style={{ opacity: 0.6, fontSize: '10px', marginLeft: 1 }}>{isOpen ? '▾' : '▸'}</span>
                    </button>
                  );
                })}
              </div>
              {openNotif && (() => {
                const t = toneStyles[openNotif.tone];
                return (
                  <div className="mt-2 rounded-xl border p-3 sm:p-4 flex items-start gap-3"
                       style={{ borderColor: t.cardBorder, background: t.cardBg }}>
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: t.cardBorder }} />
                    <div className="text-sm flex-1" style={{ color: '#0A0A0A' }}>
                      <div className="font-bold mb-1">{openNotif.title}</div>
                      <div style={{ lineHeight: 1.5 }}>{openNotif.body}</div>
                    </div>
                    <button type="button" onClick={() => setOpenNotice(null)}
                            className="text-[11px] px-2 py-0.5 rounded-full flex-shrink-0"
                            style={{ color: t.chipFg, background: 'rgba(255,255,255,0.5)', border: `0.5px solid ${t.chipBorder}` }}
                            title="Dismiss">
                      Close
                    </button>
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* Help tiles + content panels removed — the page is
            self-explanatory enough without the verbose explainer. */}
      </div>

      {/* ─── Master/detail layout ────────────────────────────────────
          Left sidebar = list of discrete functions; right pane = the
          selected function's content. Replaces the previous vertical
          stack of zones so Bashaier sees one focused workspace at a
          time instead of scrolling past everything to find what she
          needs. The sidebar collapses to a horizontal pill bar on
          narrow viewports. */}
      {/* Sidebar removed — we're already on the attendance page so a
          sidebar entry that just says "Attendance" was redundant.
          Historical backfill moved to a button in the header below. */}
      <div style={{ flex: '1 1 0', minWidth: 0 }}>

      {/* UNIFIED ATTENDANCE VIEW — daily upload workflow + monthly
          calendar on a single page. */}
      <></>{/* gate kept for diff stability */}
      <></>

      <></>{/* daily zone */}
      <></>
      <></>
      <></>
      <></>
      <></>
      <></>
      <></>
      <></>
      <></>{/* end unified attendance view */}

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
      {/* EOD-pending banner hidden per Nadeem 2026-05-31. The pending-EOD
          reminder is suppressed; pendingEodDates is still computed (cheap)
          but never rendered. Flip `false` back to show it again. */}
      {false && pendingEodDates.length > 0 && (
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

      {/* Hidden file input — controlled by the Upload button in the
          Monthly Overview header. Stays mounted at root level so the
          input is always available regardless of modal state. */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="hidden"
        onChange={onPick}
      />
      {!hasFile && parseError && (
        <div className="text-sm px-3 py-2 mb-3 rounded-md" style={{ color: '#BE123C', background: '#FEF2F2', maxWidth: '480px' }}>{parseError}</div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          DAILY REVIEW MODAL — overlay that wraps the entire daily-detection
          workspace (action tiles, file summary, banners). Opens
          automatically on first parse, closes via the X button or "Save
          & Close". The calendar stays in the background; closing the
          modal returns Bashaier to it without losing the parsed file —
          she can reopen via the "📋 Today's review" button.
          ═══════════════════════════════════════════════════════════════ */}
      {hasFile && dailyReviewOpen && (
        <div className="fixed inset-0 z-40 flex items-start justify-center p-2 sm:p-4 overflow-y-auto"
          style={{ background: 'rgba(31,27,22,0.55)' }}
          onClick={() => setDailyReviewOpen(false)}>
          <div className="rounded-xl shadow-lg w-full max-w-7xl my-4 overflow-hidden flex flex-col"
            style={{ background: '#FFFFFF', border: '1px solid #EEEAE0', maxHeight: 'calc(100vh - 32px)' }}
            onClick={(e) => e.stopPropagation()}>
            {/* Modal header */}
            <div className="px-5 py-3 flex items-center justify-between flex-shrink-0"
              style={{ borderBottom: '1px solid #EEEAE0', background: '#FAFAF9' }}>
              <div>
                <div className="text-[10px]" style={{ color: '#0F4C2A', letterSpacing: '0.18em', fontWeight: 700 }}>
                  📋 DAILY REVIEW
                </div>
                <div className="text-[15px] mt-0.5" style={{ color: '#0A0A0A', fontWeight: 700 }}>
                  {csvDate ? formatDateLong(csvDate) : 'Today\u2019s file'}
                  {xlsxFileName && (
                    <span className="text-[11px] ml-2" style={{ color: '#7A7A7A', fontWeight: 500 }}>
                      · {xlsxFileName}
                    </span>
                  )}
                </div>
              </div>
              <button onClick={() => setDailyReviewOpen(false)}
                className="p-1.5 rounded hover:bg-[#EEEAE0] flex-shrink-0"
                style={{ color: '#1F1B16' }}
                title="Close — your data stays loaded; reopen via the calendar header.">
                <X className="w-4 h-4"/>
              </button>
            </div>
            {/* Modal body — scrollable */}
            <div className="p-4 sm:p-5 overflow-y-auto flex-1" style={{ background: '#FFFFFF' }}>

      {windowMismatch ? (
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
        <>
          {/* RepeatOffendersCard, ManagerRollupCard, SilentAbsencesCard
              removed at user request — the daily review modal is now
              just FileSummary + the original tile system (Late, Early,
              Missed in, Missed out, Shift staff) with email buttons
              per row when a tile is expanded. Cleaner, faster, matches
              what was working well before. */}
          <FileSummary
            fileName={xlsxFileName}
            csvDate={csvDate}
            isWeekend={csvIsWeekend}
            totalRows={parsed.rows.length}
            offDateCount={parsed.offDateCount}
          counts={{
            late:           detection.late.filter(e => !e.isCustomShift).length,
            missedIn:       detection.missedIn.filter(e => !e.isCustomShift).length,
            early:          detection.early.filter(e => !e.isCustomShift).length,
            missedOut:      detection.missedOut.filter(e => !e.isCustomShift).length,
            // Shift staff defaulters — split out so Bashaier sees them
            // in a dedicated section with their own email flow. Per
            // Nadeem (2026-05-06): "shift staff will have their own
            // tile". The same emails fire (with shift-flavoured subject
            // and body), but the counts surface separately to keep the
            // dashboard clean.
            shiftLate:      detection.late.filter(e => !!e.isCustomShift).length,
            shiftEarly:     detection.early.filter(e => !!e.isCustomShift).length,
            shiftMissedIn:  detection.missedIn.filter(e => !!e.isCustomShift).length,
            shiftMissedOut: detection.missedOut.filter(e => !!e.isCustomShift).length,
            shiftAbsent:    detection.shiftAbsent.length,
            onTime:      detection.onTime.length,
            onLeave:     detection.onLeave.length,
            unknown:     detection.unknownEmp.length,
            weekend:     detection.weekend.length,
            shiftOffDay: detection.shiftOffDay.length,
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
          monthlyShiftsByEmp={monthlyShiftsByEmp}
          rosterGaps={rosterGaps}
          empById={empById}
          onSaveAndClose={handleSaveAndClose}
          savingClose={reevalState.running}
        />
        {/* Holiday-shift defaulters — sits next to the existing
            late/early/missed tiles when the viewed date falls inside
            an active holiday period. Self-contained: own data fetch,
            renders nothing on normal working days. Nadeem 2026-05-21:
            'when the daily attendance is uploaded it should check
            these cases and a tile for Holiday assigned staff'. */}
        <HolidayShiftDefaultersCard
          csvDate={csvDate}
          empById={empById}
        />
        </>
      )}

      {/* INTEGRITY BANNERS — surface upload sanity issues prominently
          before any actions are taken. Each is independent; multiple
          can show at once. Order: most critical first. */}

      {/* Duplicate-upload notice — same file content for the same
          data date has been processed before. Cheap dedupe via
          SHA-256 hash. Doesn't block re-processing — just informs.
          When duplicate is detected, actionsEnabled auto-flips to
          false (read-only) so the user doesn't accidentally re-send
          notice emails to people who already received them. The
          banner now explains that explicitly and offers a one-click
          override so the user isn't left wondering why the email
          buttons disappeared (Nadeem 2026-05-10 report:
          'After i select tiles and click the email button, it does
          not function' — turns out the buttons were rendered as
          READ-ONLY badges in this state, which wasn't connected
          back to the duplicate banner above for the user). */}
      {hasFile && existingUpload && (
        <div className="rounded-2xl border p-4 flex items-start gap-3"
             style={{ borderColor: '#A16207', background: '#FEFCE8' }}>
          <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#A16207' }}/>
          <div className="text-sm flex-1 min-w-0" style={{ color: '#0A0A0A' }}>
            <div className="font-bold mb-1">This file was processed before.</div>
            <div>
              The same content (identical SHA-256) was uploaded for {formatDateLong(csvDate)} on{' '}
              <strong>{new Date(existingUpload.uploaded_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</strong>
              {' '}({existingUpload.row_count} rows).
              {!actionsEnabled && (
                <>
                  {' '}<strong>Email buttons are hidden</strong> below as a guard against
                  re-sending notices to people who already got them. Click
                  <strong> "Enable actions"</strong> to override and send anyway.
                </>
              )}
            </div>
            {!actionsEnabled && (
              <button type="button"
                onClick={() => setActionsEnabled(true)}
                className="mt-2.5 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full"
                style={{
                  background: '#A16207',
                  color: '#FFFFFF',
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer',
                }}>
                Enable actions anyway
              </button>
            )}
          </div>
        </div>
      )}

      {/* Re-upload delta banner — shows what THIS upload changed vs
          the previous one for the same dates. Triggered when the
          recorder finds existing attendance_daily rows that this
          upload either added to or modified. The 'unchanged' count
          is the proof that the system is comparing — if every row is
          unchanged we don't show the banner (nothing actionable).
          Nadeem 2026-05-17 — surfaces the difference between her
          10am vs 4pm uploads so she can see new late-arrivals etc. */}
      {hasFile && uploadDelta && (uploadDelta.newRows.length > 0 || uploadDelta.updatedRows.length > 0) && (
        <div className="rounded-2xl border p-4 flex items-start gap-3"
             style={{ borderColor: '#2D5F3F', background: '#F0FDF4' }}>
          <ShieldAlert className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#2D5F3F' }}/>
          <div className="text-sm flex-1 min-w-0" style={{ color: '#0A0A0A' }}>
            <div className="font-bold mb-1">
              {uploadDelta.unchangedRows.length > 0
                ? 'Re-upload processed — here\'s what changed'
                : 'Attendance recorded'}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px]">
              <span><strong style={{ color: '#0F4C2A' }}>{uploadDelta.newRows.length}</strong> new {uploadDelta.newRows.length === 1 ? 'entry' : 'entries'}</span>
              <span><strong style={{ color: '#A16207' }}>{uploadDelta.updatedRows.length}</strong> updated</span>
              {uploadDelta.unchangedRows.length > 0 && (
                <span style={{ color: '#0A0A0A', opacity: 0.65 }}>
                  {uploadDelta.unchangedRows.length} unchanged
                </span>
              )}
            </div>
            {uploadDelta.updatedRows.length > 0 && (
              <div className="mt-2 text-[11px]" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                Changed fields:{' '}
                {uploadDelta.changedFields.first_punch > 0 && (
                  <span style={{ marginRight: 10 }}><strong>{uploadDelta.changedFields.first_punch}</strong> first-punch</span>
                )}
                {uploadDelta.changedFields.last_punch > 0 && (
                  <span style={{ marginRight: 10 }}><strong>{uploadDelta.changedFields.last_punch}</strong> last-punch</span>
                )}
                {uploadDelta.changedFields.status > 0 && (
                  <span style={{ marginRight: 10 }}><strong>{uploadDelta.changedFields.status}</strong> status</span>
                )}
                {uploadDelta.changedFields.total_minutes > 0 && (
                  <span><strong>{uploadDelta.changedFields.total_minutes}</strong> worked-minutes</span>
                )}
              </div>
            )}
            {/* Sample affected rows so Bashaier can verify the changes
                target the staff she expected (especially for late-
                arrival check-ins on a re-upload). Capped at 6 so the
                banner doesn't become a wall — full breakdown is in
                the calendar grid. */}
            {(uploadDelta.newRows.length + uploadDelta.updatedRows.length) > 0 && (
              <div className="mt-2 text-[11px]" style={{ color: '#0A0A0A' }}>
                {(() => {
                  const all = [
                    ...uploadDelta.newRows.map(r => ({ ...r, _kind: 'new' })),
                    ...uploadDelta.updatedRows.map(r => ({ ...r, _kind: 'updated' })),
                  ];
                  const sample = all.slice(0, 6);
                  return sample.map((r, i) => {
                    const emp = empById[r.employee_id];
                    const name = emp?.name || r.employee_id;
                    const tag = r._kind === 'new' ? 'NEW' : 'UPD';
                    const tagColor = r._kind === 'new' ? '#0F4C2A' : '#A16207';
                    return (
                      <span key={i} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
                        <span style={{ color: tagColor, fontWeight: 700, marginRight: 4, fontSize: 9 }}>{tag}</span>
                        {name} · {String(r.attendance_date).slice(5)}
                      </span>
                    );
                  }).concat(all.length > 6 ? [
                    <span key="more" style={{ opacity: 0.6 }}>
                      … and {all.length - 6} more
                    </span>,
                  ] : []);
                })()}
              </div>
            )}
          </div>
        </div>
      )}

      {/* dateSanity / anomaly / sheetSanity banners moved into the
          notification chips next to the system health pill at the top
          of the page — see the IIFE above. The chips replace these
          full-width cards; click a chip to expand the message. */}

      {/* Sections — only show if file uploaded and not weekend */}
      {hasFile && csvIsWeekend && (
        <div className="rounded-2xl border p-6 text-center" style={{ borderColor: '#D4D4D4', background: '#F7F7F7' }}>
          <Calendar className="w-8 h-8 mx-auto mb-3" style={{ color: '#1F1B16' }}/>
          <div style={{ fontFamily: 'inherit', fontSize: '18px', color: '#1F1B16' }}>This was a weekend day.</div>
          <div className="text-sm mt-2" style={{ color: '#0A0A0A' }}>
            {formatDateLong(csvDate)} is a Friday or Saturday — no detection runs on KSA weekends.
          </div>
        </div>
      )}

            </div>{/* end modal body */}
          </div>{/* end modal card */}
        </div>
      )}{/* end daily review modal */}

      {/* Confirm-before-send modal — every email button routes through
          here for an extra check. The mailto: link only fires after
          explicit confirmation. */}
      {confirmEntry && (
        <ConfirmEmailModal
          confirm={confirmEntry}
          csvDate={csvDate}
          getManagerEmail={getManagerEmail}
          empById={empById}
          monthlyShiftsByEmp={monthlyShiftsByEmp}
          onCancel={() => setConfirmEntry(null)}
          onConfirm={() => {
            const { entry, kind, mode = 'live' } = confirmEntry;
            setConfirmEntry(null);
            if (kind === 'late')   handleEmailLate(entry, mode);
            else if (kind === 'early')  handleEmailEarly(entry, mode);
            else if (kind === 'noShow') handleEmailNoShow(entry, mode);
            else if (kind === 'missed' || kind === 'missedIn' || kind === 'missedOut' || kind === 'shiftAbsent') handleEmailMissed(entry, mode);
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
      {/* Explain modal — opens when any FlaggedSection's "Why?"
          button is clicked. Shows the full evaluation chain (punches,
          schedule, comparison, permission, classification) so disputes
          can be settled in one place. */}
      {explainPayload && (
        <AttendanceErrorBoundary label="Explain modal">
          <EvaluationExplainModal
            entry={explainPayload.entry}
            kind={explainPayload.kind}
            onClose={() => setExplainPayload(null)}
          />
        </AttendanceErrorBoundary>
      )}

      {/* Historical backfill modal — opens on "📚 Historical backfill"
          click. Allowed date range is Sep 1 of last year through today;
          a banner inside reminds the user of that window. The actual
          per-file upload UI is the existing AttendanceBackfillPanel,
          rendered inside the modal so it inherits the same styling. */}
      {backfillModalOpen && (() => {
        const today = new Date();
        const allowedStart = `${today.getFullYear() - 1}-09-01`;
        const allowedEnd   = today.toISOString().slice(0, 10);
        return (
          <div className="fixed inset-0 z-50 flex items-start justify-center p-4 overflow-y-auto"
            style={{ background: 'rgba(31,27,22,0.5)' }}
            onClick={() => setBackfillModalOpen(false)}>
            <div className="rounded-xl shadow-lg w-full max-w-5xl my-8 overflow-hidden"
              style={{ background: '#FFFFFF', border: '1px solid #EEEAE0' }}
              onClick={(e) => e.stopPropagation()}>
              <div className="px-5 py-4 flex items-start justify-between"
                style={{ borderBottom: '1px solid #EEEAE0' }}>
                <div>
                  <div className="text-[10px]" style={{ color: '#5B21B6', letterSpacing: '0.08em', fontWeight: 700 }}>
                    📚 HISTORICAL BACKFILL
                  </div>
                  <div className="text-[15px] mt-0.5" style={{ color: '#0A0A0A', fontWeight: 700 }}>
                    Bulk import past attendance
                  </div>
                  <div className="text-[11px] mt-1" style={{ color: '#7A7A7A' }}>
                    Allowed window: <strong style={{ color: '#0A0A0A' }}>{allowedStart}</strong> → <strong style={{ color: '#0A0A0A' }}>{allowedEnd}</strong> (Sep 1 last year through today). Files outside this window will be rejected.
                  </div>
                </div>
                <button onClick={() => setBackfillModalOpen(false)}
                  className="p-1.5 rounded hover:bg-[#FAFAF9] flex-shrink-0"
                  style={{ color: '#7A7A7A' }}>
                  <X className="w-4 h-4"/>
                </button>
              </div>
              <div className="p-5 max-h-[75vh] overflow-y-auto">
                <AttendanceErrorBoundary label="Historical backfill">
                  <AttendanceBackfillPanel
                    me={me}
                    employees={employees}
                    embedded
                    allowedStart={allowedStart}
                    allowedEnd={allowedEnd}
                    onChanged={() => setCalendarRefreshTick(t => t + 1)}
                  />
                </AttendanceErrorBoundary>
              </div>
            </div>
          </div>
        );
      })()}

      {bulkSession && (
        <BulkActionModal
          session={bulkSession}
          csvDate={csvDate}
          getManagerEmail={getManagerEmail}
          onClose={() => setBulkSession(null)}
          onSetMode={(nextMode) => setBulkSession(prev => prev ? { ...prev, mode: nextMode } : prev)}          onOpenDraft={(entry) => {
            const k = bulkSession.kind;
            const m = bulkSession.mode || 'live';
            if (k === 'late')   handleEmailLate(entry, m);
            else if (k === 'early')  handleEmailEarly(entry, m);
            else if (k === 'noShow') handleEmailNoShow(entry, m);
            else if (k === 'missed' || k === 'missedIn' || k === 'missedOut' || k === 'shiftAbsent') handleEmailMissed(entry, m);
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

      {/* MONTHLY CALENDAR — anchors the bottom of the unified
          attendance workspace. Read-only overview that picks up
          changes whenever the daily upload's re-evaluation completes
          (Phase C wires this). Sits below the daily action zone so
          Bashaier finishes her uploads at the top of the page and
          scrolls down to confirm the calendar reflects the day's
          work. The 24-line spacer keeps the visual handoff clear
          between "action" (above) and "memory" (below). */}
      <div style={{ marginTop: 0 }}>
        <AttendanceErrorBoundary label="Action bar">
        {/* Single-row layout: action buttons (centered) with the
            compact status pill as the leading item. Everything sits
            on one line. */}
        <div className="flex items-center justify-center mb-2" style={{ flexWrap: 'wrap', gap: 10 }}>
          {/* Compact status — small dot + brief text. */}
          {(() => {
            const now = Date.now();
            const uploadMs = lastUploadAt ? (now - new Date(lastUploadAt).getTime()) : null;
            const reevalMs = reevalState.lastRunAt ? (now - new Date(reevalState.lastRunAt).getTime()) : null;
            const dayMs = 24 * 60 * 60 * 1000;
            const dot =
              uploadMs == null ? '#9CA3AF' :
              uploadMs <= dayMs ? '#10B981' :
              uploadMs <= 3 * dayMs ? '#F59E0B' : '#DC2626';
            const fmt = (ms) => {
              if (ms == null) return '—';
              const mins = Math.floor(ms / 60000);
              if (mins < 1)  return 'now';
              if (mins < 60) return `${mins}m`;
              const hrs = Math.floor(mins / 60);
              if (hrs < 24)  return `${hrs}h`;
              return `${Math.floor(hrs / 24)}d`;
            };
            return (
              <>
              <div className="inline-flex items-center gap-1.5 text-[11px]"
                style={{ color: '#0A0A0A', fontWeight: 500 }}
                title={[
                  lastUploadAt ? `Last upload: ${new Date(lastUploadAt).toLocaleString('en-GB')}` : 'No uploads yet',
                  reevalState.lastRunAt ? `Last re-eval: ${new Date(reevalState.lastRunAt).toLocaleString('en-GB')}` : null,
                ].filter(Boolean).join('\n')}>
                <span className="inline-block w-2 h-2 rounded-full" style={{ background: dot }} />
                <span style={{ opacity: 0.85 }}>
                  {uploadMs == null ? 'No uploads' : `Uploaded ${fmt(uploadMs)} ago`}
                  {reevalMs != null && <span style={{ opacity: 0.6 }}> · re-eval {fmt(reevalMs)}</span>}
                </span>
                {reevalState.error && (
                  <span style={{ color: '#991B1B', marginLeft: 4 }}>· failed</span>
                )}
              </div>
              {/* Full re-eval error shown inline (no tap needed) so the
                  exact failure is always visible. Nadeem 2026-05-31. */}
              {reevalState.error && (
                <div className="text-[11px] mt-1 px-2 py-1 rounded"
                     style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FCA5A5', maxWidth: 560, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  Re-evaluation error: {String(reevalState.error)}
                </div>
              )}
              </>
            );
          })()}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="text-[11px] px-3 py-1.5 rounded-full flex items-center gap-1.5"
              style={{
                background: '#0F4C2A',
                color: '#FFFFFF',
                fontWeight: 600,
                border: '1px solid #0F4C2A',
              }}
              title="Upload the Time Card .xlsx export from the fingerprint device."
            >
              ⬆ Upload Time Card
            </button>
            {/* Shift Staff Attendance — sits next to Upload Time Card.
                Toggles a panel further down the page (rendered just
                above the monthly grid) that shows the report for
                manager-flagged shift staff. Closed by default.
                Colour: deep slate-blue (#1E40AF) so it reads as a
                first-class action on a landing page that's otherwise
                cream/amber/green — the previous cream-on-cream variant
                looked washed out next to the bold green 'Upload Time
                Card'. */}
            <button
              type="button"
              onClick={() => setShiftReportOpen(v => !v)}
              className="text-[11px] px-3 py-1.5 rounded-full flex items-center gap-1.5"
              style={{
                background: shiftReportOpen ? '#1E3A8A' : '#1E40AF',
                color:      '#FFFFFF',
                fontWeight: 600,
                border:     `1px solid ${shiftReportOpen ? '#1E3A8A' : '#1E40AF'}`,
                boxShadow:  shiftReportOpen
                  ? 'inset 0 1px 3px rgba(0,0,0,0.25)'
                  : '0 1px 2px rgba(30,64,175,0.25)',
              }}
              title="Show in/out punches and total worked hours for staff flagged as shift workers by their managers."
            >
              🕐 Shift staff attendance {shiftReportOpen ? '·  hide' : ''}
            </button>
            {hasFile && !dailyReviewOpen && (
              <button
                type="button"
                onClick={() => setDailyReviewOpen(true)}
                className="text-[11px] px-3 py-1.5 rounded-full flex items-center gap-1.5"
                style={{
                  background: '#FEF3C7',
                  color: '#854F0B',
                  fontWeight: 600,
                  border: '1px solid #FCD34D',
                }}
                title="Reopen the daily review for the loaded time card."
              >
                📋 Today's review · {csvDate ? new Date(csvDate + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : ''}
              </button>
            )}
            <button
              type="button"
              onClick={() => triggerReevaluation({ silent: false })}
              disabled={reevalState.running}
              className="text-[11px] px-3 py-1.5 rounded-full flex items-center gap-1.5"
              style={{
                background: reevalState.running ? '#F4F4EE' : '#1E40AF',
                color: reevalState.running ? '#A1A1AA' : '#FFFFFF',
                border: '1px solid ' + (reevalState.running ? '#D4D4D4' : '#1E40AF'),
                cursor: reevalState.running ? 'wait' : 'pointer',
                fontWeight: 600,
              }}
              title="Re-scan the last 7 days against current permissions, leaves, and shift assignments. Catches retroactive corrections."
            >
              {reevalState.running ? 'Re-evaluating…' : '↻ Re-evaluate last 7 days'}
            </button>
            {/* Full-month re-eval — Phase C / Decision #5 manual leg.
                Uses the month boundaries of csvDate (or today, if no
                file is uploaded) and runs the same pipeline against
                a wider window. Slower than the 7-day scan but the
                right tool when corrections may have landed earlier
                in the month — e.g., a leave approved retroactively
                for a date 20 days back. */}
            <button
              type="button"
              onClick={() => {
                const ref = csvDate ? new Date(csvDate) : new Date();
                const yy = ref.getFullYear();
                const mm = String(ref.getMonth() + 1).padStart(2, '0');
                const lastDay = new Date(yy, ref.getMonth() + 1, 0).getDate();
                const startDate = `${yy}-${mm}-01`;
                const endDate   = `${yy}-${mm}-${String(lastDay).padStart(2, '0')}`;
                // Reuse the same plumbing as the 7-day button but with
                // a wider window. The pipeline accepts arbitrary date
                // ranges via reevaluateDateRange — we route through the
                // existing triggerReevaluation by temporarily swapping
                // its days param into a date-range call.
                (async () => {
                  if (reevalState.running) return;
                  setReevalState(s => ({ ...s, running: true, error: null }));
                  try {
                    const { reevaluateDateRange } = await import('../lib/attendanceBackfill.js');
                    const summary = await reevaluateDateRange(startDate, endDate);
                    const nowIso = new Date().toISOString();
                    try { localStorage.setItem('esauhr_last_reeval_at', nowIso); } catch {}
                    setReevalState({ running: false, lastRunAt: nowIso, summary, error: null });
                    setCalendarRefreshTick(t => t + 1);
                  } catch (err) {
                    setReevalState(s => ({ ...s, running: false, error: err?.message || 'Re-eval failed' }));
                  }
                })();
              }}
              disabled={reevalState.running}
              className="text-[11px] px-3 py-1.5 rounded-full flex items-center gap-1.5"
              style={{
                background: reevalState.running ? '#F4F4EE' : '#7C3AED',
                color: reevalState.running ? '#A1A1AA' : '#FFFFFF',
                border: '1px solid ' + (reevalState.running ? '#D4D4D4' : '#7C3AED'),
                cursor: reevalState.running ? 'wait' : 'pointer',
                fontWeight: 600,
              }}
              title="Re-scan the entire month against current permissions, leaves, and shift assignments. Use after retroactive corrections that landed earlier in the month."
            >
              {reevalState.running ? '…' : '↻ Re-evaluate this month'}
            </button>
            <button
              type="button"
              onClick={() => setBackfillModalOpen(true)}
              className="text-[11px] px-3 py-1.5 rounded-full flex items-center gap-1.5"
              style={{
                background: '#5B21B6',
                color: '#FFFFFF',
                border: '1px solid #5B21B6',
                fontWeight: 600,
              }}
              title="Import historical attendance — Sep 1 last year through today. One-shot bulk import for catching up on past months."
            >
              📚 Historical backfill
            </button>
            {/* Export to HTML — print-friendly report of the on-screen
                month grid. Clones the calendar's DOM, inlines all
                stylesheets, and opens in a new window with @page A4
                print rules. The new window auto-triggers print so the
                user can save as PDF or send to printer in one click.
                Bashaier can also print directly to physical paper. */}
            <button
              type="button"
              onClick={exportMonthReport}
              className="text-[11px] px-3 py-1.5 rounded-full flex items-center gap-1.5"
              style={{
                background: '#854F0B',
                color: '#FFFFFF',
                border: '1px solid #854F0B',
                fontWeight: 600,
              }}
              title="Generate a printable A4 report of the monthly attendance grid as it appears on screen."
            >
              📄 Export report
            </button>
            {/* HQ Report — special-styled button (gradient + glow) for
                the Evergreen HQ annual attendance workbook. Last in the
                row, Bashaier + Nadeem only. Toggles the export card
                (with its fiscal-year selector) open. */}
            {['H94830', 'H94152'].includes(me?.id) && (
              <button
                type="button"
                onClick={() => setHqExportOpen(v => !v)}
                className="text-[11px] px-3.5 py-1.5 rounded-full flex items-center gap-1.5"
                style={{
                  background: hqExportOpen
                    ? 'linear-gradient(135deg, #0F4C2A 0%, #14663a 60%, #B8860B 130%)'
                    : 'linear-gradient(135deg, #0F4C2A 0%, #1a7a47 55%, #C8A024 120%)',
                  color: '#FFFFFF',
                  border: '1px solid rgba(200,160,36,0.55)',
                  fontWeight: 700,
                  letterSpacing: '0.02em',
                  boxShadow: '0 1px 2px rgba(15,76,42,0.35), inset 0 1px 0 rgba(255,255,255,0.18)',
                }}
                title="Evergreen HQ annual attendance summary (Sep→Aug), working days only, in HQ's bilingual format. Bashaier & Nadeem only."
              >
                <span style={{ filter: 'saturate(1.3)' }}>✦</span> HQ Report{hqExportOpen ? '  ·  hide' : ''}
              </button>
            )}
        </div>
        </AttendanceErrorBoundary>
        {shiftReportOpen && (
          <AttendanceErrorBoundary label="Shift staff attendance report">
            <ShiftStaffAttendanceReportCard
              employees={employees}
              me={me}
            />
          </AttendanceErrorBoundary>
        )}

        {/* HQ annual attendance export — Evergreen Taiwan HQ summary
            workbook (Sep→Aug). Restricted to Bashaier (H94830) and
            Nadeem (H94152), toggled by the special HQ Report button
            above. Working days only; HQ bilingual format. */}
        {hqExportOpen && ['H94830', 'H94152'].includes(me?.id) && (
          <AttendanceErrorBoundary label="HQ attendance export">
            <HQAttendanceExportCard me={me} employees={employees} />
          </AttendanceErrorBoundary>
        )}

        <AttendanceErrorBoundary label="Monthly attendance calendar">
          <div data-month-export-target>
          <AttendanceMonthGrid
            employees={employees}
            onEmployeeClick={setDetailEmployee}
            refreshTick={calendarRefreshTick}
          />
          </div>
        </AttendanceErrorBoundary>
      </div>

      {/* end unified attendance view */}

      {/* schedules / mawani views removed from here — moving to
          per-employee context (employee detail card) in a follow-up.
          Historical backfill is opened via a modal triggered by the
          button in the header. */}

        </div>{/* end content pane */}

      {/* Slide-in detail drawer — opens when an employee row in the
          Monthly Overview calendar is clicked. Rendered at the root
          of AttendanceView so its fixed-position chrome (backdrop +
          panel) sits above all other UI. Self-closes on Esc, backdrop
          click, or its own X button. */}
      {detailEmployee && (
        <AttendanceErrorBoundary label="Employee detail">
          <EmployeeAttendanceDetailPanel
            employee={detailEmployee}
            onClose={() => setDetailEmployee(null)}
          />
        </AttendanceErrorBoundary>
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
          <div style={{ fontFamily: 'inherit', fontSize: '20px', color: '#0A0A0A', lineHeight: 1.3 }}>
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
        <div className="rounded-xl p-3 border" style={{ background: '#FFFFFF', borderColor: '#E5E5E5' }}>
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

// ─── HelpTile ──────────────────────────────────────────────────────────
// Compact card used in the page-header help grid. Idle: pale tint with
// an accent border. Hover: lifts + scales subtly. Active: filled accent
// background, replays a quick pop animation each time it becomes
// active so Bashaier sees the visual feedback when she clicks.
//
// All 4 tiles use the same component, just different accent colours
// and labels — keeps the grid visually consistent while letting each
// tile have its own identity (greenfor workflow, navy for shift,
// amber for leave, purple for mail).
function HelpTile({ id, label, sub, icon, accent, tint, isActive, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={isActive}
      aria-controls={`help-panel-${id}`}
      className="text-left rounded-lg p-3 transition-all"
      style={{
        background: isActive ? tint : '#FFFFFF',
        border: '1.5px solid ' + (isActive ? accent : '#E5E5DD'),
        cursor: 'pointer',
        // Lift + scale on hover via CSS hover (Tailwind-free for
        // precision). A soft shadow comes in alongside the lift.
        // The active state replays the help-tile-pop keyframe via
        // the `key` swap on the wrapper if needed; for now a static
        // active visual is enough since the panel itself bounces.
        boxShadow: isActive
          ? `0 2px 12px ${accent}25`
          : '0 1px 3px rgba(0,0,0,0.04)',
        transform: 'scale(1)',
        animation: isActive ? 'help-tile-pop 0.32s ease-out' : 'none',
        // Hover effect — handled inline so we don't need a global
        // stylesheet rule. The :hover pseudo can't be expressed in
        // a style prop, so we use CSS via a class. Tailwind's
        // hover:scale and hover:shadow utilities cover it nicely.
      }}
      onMouseEnter={e => {
        if (!isActive) {
          e.currentTarget.style.transform = 'scale(1.025)';
          e.currentTarget.style.boxShadow = `0 4px 14px ${accent}20`;
        }
      }}
      onMouseLeave={e => {
        if (!isActive) {
          e.currentTarget.style.transform = 'scale(1)';
          e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.04)';
        }
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span
          className="inline-flex items-center justify-center rounded-md"
          style={{
            width: 26, height: 26,
            background: tint,
            color: accent,
            border: '1px solid ' + accent + '30',
          }}
        >
          {icon}
        </span>
        <span
          className="text-[10px] tracking-[0.15em]"
          style={{ color: accent, fontWeight: 700 }}
        >
          {label}
        </span>
      </div>
      <div className="text-[12px]" style={{ color: '#0A0A0A', opacity: 0.78, lineHeight: 1.45 }}>
        {sub}
      </div>
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// UnifiedShiftStaffPanel
// ─────────────────────────────────────────────────────────────────────
// Single drilldown surface for all shift-related daily activity. Stacks
// the roster gaps card + late + early + absence + off-roster sections
// in priority order (most actionable first). Per Nadeem (2026-05-07):
// "shift cases should have one tile as SHIFT STAFF and all activity
// for them appears when their card is clicked".
function UnifiedShiftStaffPanel({
  rosterGaps, empById, detection,
  latePanel, earlyPanel, absentPanel,
  offRosterCount, offRosterEntries,
  monthlyShiftsByEmp,
  onRosterRefresh,
  me, csvDate,
}) {
  const lateCount   = (detection.late  || []).filter(e => !!e.isCustomShift).length;
  const earlyCount  = (detection.early || []).filter(e => !!e.isCustomShift).length;
  const absentCount = (detection.shiftAbsent || []).length;
  const hasGaps     = !!(rosterGaps && rosterGaps.totalGaps > 0);
  const hasShiftStaff = !!(rosterGaps && rosterGaps.totalShiftStaff > 0);

  // Helper: render a labelled section header with count chip.
  const SectionHeader = ({ icon, label, count, tone }) => (
    <div className="flex items-baseline gap-2 mb-2">
      <span style={{ fontSize: 14 }} aria-hidden>{icon}</span>
      <span className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
        {label}
      </span>
      {count > 0 && (
        <span style={{
          background: tone?.bg || '#F4F4EE',
          color: tone?.fg || '#0A0A0A',
          padding: '1px 6px',
          borderRadius: 999,
          fontSize: 10,
          fontWeight: 700,
        }}>
          {count}
        </span>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      {/* 1. Roster Gaps — manager-side completion check, top of stack
          since fixing gaps prevents downstream violations. */}
      {hasShiftStaff && (
        <div>
          <div className="flex items-baseline gap-2 mb-2">
            <span style={{ fontSize: 14 }} aria-hidden>📋</span>
            <span className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
              ROSTER COMPLETION
            </span>
            {hasGaps && (
              <span style={{
                background: '#FEF3C7', color: '#78350F',
                padding: '1px 6px', borderRadius: 999,
                fontSize: 10, fontWeight: 700,
              }}>
                {rosterGaps.totalGaps}
              </span>
            )}
            {!hasGaps && (
              <span style={{
                background: '#DCFCE7', color: '#14532D',
                padding: '1px 6px', borderRadius: 999,
                fontSize: 10, fontWeight: 700,
              }}>
                0
              </span>
            )}
            {/* Refresh pill — re-pulls live shift data + off-pattern
                from the database without needing a CSV re-upload.
                Per Nadeem 2026-05-10: the gap count was based on a
                snapshot taken at upload time, so any shift assigned
                afterwards wasn't reflected. This button bumps the
                rosterRefreshTick state in the parent, which re-runs
                both the acceptedShifts fetch and the shiftRosterStaff
                fetch (which now also pulls off_weekdays). */}
            {typeof onRosterRefresh === 'function' && (
              <button
                type="button"
                onClick={onRosterRefresh}
                className="ml-auto text-[10px] tracking-wider px-2.5 py-1 rounded-full border inline-flex items-center gap-1.5"
                style={{
                  borderColor: '#D4D4D4',
                  background: '#FFFFFF',
                  color: '#0A0A0A',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
                title="Re-pull live shift data + off-day patterns from the database. Use this if you've assigned shifts on the Shifts tab since uploading the file.">
                ↻ REFRESH
              </button>
            )}
          </div>
          <RosterGapsCard
            rosterGaps={rosterGaps}
            empById={empById}
            isOpen={true}
            onToggle={() => {}}
          />
        </div>
      )}

      {/* 1b. Shift compliance — monthly catch-and-report for staff who
          WERE assigned but did not perform correctly (late, no
          punch-out, absent, early, wrong window). Sits between the
          roster card (manager did not assign) and the daily late /
          early / absent cards (today's misses) — same scope, monthly
          rollup, with per-manager and per-staff email composers.
          Evaluation window: 1st of month through csvDate (the latest
          upload date) so future-dated shifts don't count. */}
      {hasShiftStaff && (
        <ShiftComplianceCard
          employees={Object.values(empById).filter(e => e && e.id)}
          me={me}
          monthKey={csvDate ? csvDate.slice(0, 7) : null}
          endDate={csvDate}
        />
      )}

      {/* 2. Shift absence — most serious; full-day no-show on an
          assigned shift. */}
      {absentCount > 0 && absentPanel && (
        <div>
          <SectionHeader
            icon="🚨"
            label="SHIFT ABSENCE"
            count={absentCount}
            tone={{ bg: '#FEE2E2', fg: '#7F1D1D' }}
          />
          {absentPanel}
        </div>
      )}

      {/* 3. Late shift-IN. */}
      {lateCount > 0 && latePanel && (
        <div>
          <SectionHeader
            icon="🌙"
            label="SHIFT LATE ARRIVAL"
            count={lateCount}
            tone={{ bg: '#EEF2FF', fg: '#3730A3' }}
          />
          {latePanel}
        </div>
      )}

      {/* 4. Early shift-OUT. */}
      {earlyCount > 0 && earlyPanel && (
        <div>
          <SectionHeader
            icon="⏰"
            label="SHIFT EARLY DEPARTURE"
            count={earlyCount}
            tone={{ bg: '#F5F3FF', fg: '#5B21B6' }}
          />
          {earlyPanel}
        </div>
      )}

      {/* 5. Off-roster work — informational, not a violation. */}
      {offRosterCount > 0 && (
        <div>
          <SectionHeader
            icon="🗓️"
            label="WORKED OFF-ROSTER"
            count={offRosterCount}
            tone={{ bg: '#EEF0FA', fg: '#3B4279' }}
          />
          <div style={{
            background: '#F8FAFC',
            border: '1px solid #E2E8F0',
            borderRadius: 8,
            padding: '10px 14px',
          }}>
            <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7, marginBottom: 8 }}>
              Punched in on a date with no shift planned. Informational only — not counted as a violation.
            </div>
            {offRosterEntries.map((e) => (
              <div key={e.id} className="flex items-baseline gap-2" style={{ paddingTop: 4, paddingBottom: 4 }}>
                <span className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
                  {e.employee?.name || ''}
                </span>
                <span className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                  ({e.employee?.id || ''})
                </span>
                <span className="text-[11px]" style={{ color: '#1F1B16' }}>
                  {e.dateLabel} &middot; {e.punchInStr || '—'} → {e.punchOutStr || '—'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state — nothing to show but card was opened. */}
      {!hasGaps && absentCount === 0 && lateCount === 0 && earlyCount === 0 && offRosterCount === 0 && (
        <div style={{
          padding: '24px 16px',
          textAlign: 'center',
          color: '#0A0A0A',
          opacity: 0.7,
          fontSize: 13,
        }}>
          ✓ No shift activity to flag for this period — roster complete and all assigned shifts attended on time.
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// RosterGapsCard (#2 — Phase 1)
// ─────────────────────────────────────────────────────────────────────
// Surfaces working days for shift staff where the manager has not yet
// assigned a shift in employee_shifts. Grouped by line manager so each
// supervisor can see their own outstanding work. Designed to nudge
// managers to complete their roster BEFORE HR violation emails fire on
// dates that should have been shifts.
//
// Click the card header to expand. Each manager group then shows the
// staff under them with the specific gap dates listed compactly.
function RosterGapsCard({ rosterGaps, empById, isOpen, onToggle }) {
  if (!rosterGaps) return null;
  const { totalGaps, totalStaff, totalShiftStaff, byManager } = rosterGaps;
  const isAllAssigned = totalGaps === 0;

  const fmtDate = (iso) => {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  };

  // Colour state — amber when gaps exist, green when fully assigned.
  // Both are calm, neither is alarming — this is an operational
  // dashboard signal, not a violation flag.
  const palette = isAllAssigned
    ? { bg: '#F0FDF4', border: '#BBF7D0', accentBg: '#86EFAC', accentFg: '#064E3B', icon: '✓' }
    : { bg: '#FFFBEB', border: '#FDE68A', accentBg: '#FCD34D', accentFg: '#78350F', icon: '📋' };

  return (
    <div
      style={{
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        borderRadius: 10,
        padding: 0,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={isAllAssigned ? undefined : onToggle}
        disabled={isAllAssigned}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          background: 'transparent',
          border: 'none',
          textAlign: 'left',
          cursor: isAllAssigned ? 'default' : 'pointer',
        }}
      >
        <div className="flex items-center gap-3" style={{ minWidth: 0 }}>
          <span style={{ fontSize: 18 }} aria-hidden>{palette.icon}</span>
          <div style={{ minWidth: 0 }}>
            <div className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
              ROSTER {isAllAssigned ? 'COMPLETE' : 'GAPS'}
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: '#0A0A0A' }}>
              {isAllAssigned
                ? <>All <strong>{totalShiftStaff}</strong> shift {totalShiftStaff === 1 ? 'staff member has' : 'staff have'} their roster assigned through today.</>
                : <><strong>{totalGaps}</strong> unassigned working {totalGaps === 1 ? 'day' : 'days'} across <strong>{totalStaff}</strong> shift {totalStaff === 1 ? 'staff' : 'staff'} this month</>
              }
            </div>
          </div>
        </div>
        {!isAllAssigned && (
          <span style={{ fontSize: 18, color: '#0A0A0A', opacity: 0.5 }}>{isOpen ? '−' : '+'}</span>
        )}
      </button>

      {isOpen && !isAllAssigned && (
        <div style={{ borderTop: `1px solid ${palette.border}`, padding: '8px 16px 14px' }}>
          {byManager.map((g) => {
            const mgrInitial = (g.managerName || '?').charAt(0).toUpperCase();
            return (
              <div key={g.managerId || '__unassigned__'} style={{ marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${palette.border}` }}>
                <div className="flex items-baseline gap-2 mb-2">
                  <div style={{
                    width: 22, height: 22, borderRadius: '50%',
                    background: palette.accentBg, color: palette.accentFg,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700,
                  }}>
                    {mgrInitial}
                  </div>
                  <div className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 700 }}>
                    {g.managerName}
                  </div>
                  <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                    {g.totalGaps} {g.totalGaps === 1 ? 'gap' : 'gaps'} &middot; {g.staff.length} {g.staff.length === 1 ? 'staff' : 'staff'}
                  </div>
                </div>
                <div style={{ paddingLeft: 30 }}>
                  {g.staff.map((s) => (
                    <div key={s.empId} style={{ marginBottom: 6 }}>
                      <div className="text-[11px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
                        {s.name}
                        <span style={{ marginLeft: 6, opacity: 0.6, fontWeight: 500 }}>
                          ({s.empId}) &middot; {s.gapDates.length} unassigned
                        </span>
                      </div>
                      <div className="text-[11px] mt-0.5" style={{ color: '#1F1B16', lineHeight: 1.5 }}>
                        {s.gapDates.map(d => fmtDate(d)).join('  ·  ')}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
          <div className="text-[11px] mt-3" style={{ color: '#0A0A0A', opacity: 0.65, fontStyle: 'italic' }}>
            Managers can fill these in via the Shifts tab on the ESAU HR Portal. Gaps clear automatically once a shift is assigned for the date.
          </div>
        </div>
      )}
    </div>
  );
}

function FileSummary({
  fileName, csvDate, isWeekend, totalRows, offDateCount = 0,
  counts, dates, windowAvail, detection, progressByKind,
  drillKind, setDrillKind, actionPanels,
  actionsEnabled, onToggleActions, isDuplicate, onReset,
  monthlyShiftsByEmp, rosterGaps, empById,
  onSaveAndClose, savingClose,
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
    <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: '#D4D4D4' }}>
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>
            UPLOADED FILE
          </div>
          <div className="flex items-center gap-2" style={{ fontFamily: 'inherit', fontSize: '20px', color: '#1F1B16' }}>
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
                borderColor: actionsEnabled ? '#0F4C2A' : '#D4D4D4',
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
              {isDuplicate && (
                <span className="text-[9px] px-1 py-0.5 rounded font-bold tracking-wider"
                  style={{ background: '#FDE68A', color: '#92400E' }}>
                  DUPLICATE
                </span>
              )}
            </button>
          )}
          {/* Save & Close (Phase B+C / Decision #4 option C) — explicit
              handoff button. Persists the upload session as "done" and
              triggers a 7-day re-evaluation pass that refreshes the
              calendar below. Distinct from "Upload different file"
              which resets the form to start over. Only renders when
              there's an active uploaded file with actions enabled. */}
          {onSaveAndClose && actionsEnabled && (
            <button
              onClick={onSaveAndClose}
              disabled={savingClose}
              className="text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5"
              style={{
                borderColor: savingClose ? '#A7F3D0' : '#10B981',
                color: savingClose ? '#047857' : '#FFFFFF',
                background: savingClose ? '#ECFDF5' : '#10B981',
                fontWeight: 600,
                cursor: savingClose ? 'wait' : 'pointer',
              }}
              title="Mark this upload's review as complete. Triggers a re-evaluation against current permissions, leaves, and shift assignments — calendar will refresh below.">
              {savingClose ? '… Saving' : '✓ Save & Close'}
            </button>
          )}
          <button
            onClick={onReset}
            className="text-xs px-3 py-1.5 rounded-full border flex items-center gap-1.5"
            style={{ borderColor: '#D4D4D4', color: '#1F1B16' }}>
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
                <span className="text-[11px]" style={{ fontWeight: 600, color: '#1F1B16' }}>
                  Today
                </span>
                <span className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
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
                <span className="text-[11px]" style={{ fontWeight: 600, color: '#1F1B16' }}>
                  Yesterday
                </span>
                <span className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
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

          {/* (Roster gaps are now surfaced inside the SHIFT STAFF
              drill panel below — the standalone amber card was
              consolidated into the unified shift tile per Nadeem
              2026-05-07.) */}

          {/* SHIFT STAFF — separate dashboard for shift-roster
              defaulters. Same email function as office staff,
              but the tiles surface independently so Bashaier
              can see "shift-night-start late" and "shift-end
              early" without them being mixed into the office
              attendance counts. Per Nadeem (2026-05-06): "shift
              staff will have their own tile". Renders only when
              there's at least one shift defaulter to avoid
              taking up vertical space when there's nothing
              actionable. */}
          {/* SHIFT STAFF — single tile entry point. All shift-related
              activity (roster gaps, late, early, absences, off-roster
              work) lives behind this one tile. Clicking expands into
              a stacked panel showing each sub-category — Bashaier
              gets the full shift picture in one place rather than
              having to scan multiple separate tiles. Per Nadeem
              (2026-05-07): "shift cases should have one tile as
              SHIFT STAFF and all activity for them appears when
              their card is clicked". */}
          {(() => {
            const shiftTotal =
              (counts.shiftLate || 0) +
              (counts.shiftEarly || 0) +
              (counts.shiftAbsent || 0) +
              (counts.shiftOffDay || 0);
            const hasGaps = !!(rosterGaps && rosterGaps.totalGaps > 0);

            // Tile renders ALWAYS once a file is uploaded — even when
            // there's nothing to flag. Per Nadeem (2026-05-07): the
            // SHIFT STAFF tile is the single entry point for all
            // shift-related activity, so it needs to be visible on
            // every uploaded-file view so Bashaier can confirm the
            // system has checked. The colour and subtext shift to
            // tell the story:
            //   - red    → absences flagged
            //   - indigo → late/early/gaps to action
            //   - green  → roster complete, no defaulters

            // Subtext mirrors the most prominent finding so the tile
            // tells the story at a glance even before being opened.
            // Priority: absences > gaps > late/early > off-roster.
            let subtext;
            if (counts.shiftAbsent > 0) {
              subtext = `${counts.shiftAbsent} ${counts.shiftAbsent === 1 ? 'absence' : 'absences'} flagged`;
            } else if (hasGaps) {
              subtext = `${rosterGaps.totalGaps} roster ${rosterGaps.totalGaps === 1 ? 'gap' : 'gaps'} this month`;
            } else if (counts.shiftLate > 0 || counts.shiftEarly > 0) {
              const parts = [];
              if (counts.shiftLate > 0)  parts.push(`${counts.shiftLate} late`);
              if (counts.shiftEarly > 0) parts.push(`${counts.shiftEarly} early`);
              subtext = parts.join(' · ');
            } else if (counts.shiftOffDay > 0) {
              subtext = `${counts.shiftOffDay} worked off-roster`;
            } else if (rosterGaps && rosterGaps.totalShiftStaff > 0) {
              subtext = `roster complete · ${rosterGaps.totalShiftStaff} shift ${rosterGaps.totalShiftStaff === 1 ? 'staff' : 'staff'} on schedule`;
            } else {
              subtext = 'no shift staff on the monthly roster';
            }

            const palette = (counts.shiftAbsent > 0)
              ? { color: '#991B1B', tint: '#FEF2F2' }
              : (shiftTotal > 0 || hasGaps)
                ? { color: '#3730A3', tint: '#EEF2FF' }
                : { color: '#15803D', tint: '#F0FDF4' };

            return (
              <div>
                <div className="flex items-baseline gap-2 mb-2">
                  <span className="text-[11px]" style={{ fontWeight: 600, color: '#1F1B16' }}>
                    Shift staff
                  </span>
                  <span className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
                    Manager-assigned schedule &middot; click for details
                  </span>
                </div>
                <CountPill
                  kind="shiftStaff"
                  icon="🌙"
                  label="Shift staff activity"
                  count={shiftTotal || (hasGaps ? rosterGaps.totalGaps : 0)}
                  color={palette.color}
                  tint={palette.tint}
                  subtext={subtext}
                  isOpen={drillKind === 'shiftStaff'}
                  onClick={() => setDrillKind(drillKind === 'shiftStaff' ? null : 'shiftStaff')}
                />
              </div>
            );
          })()}

          {/* (Worked off-roster — now consolidated into the SHIFT
              STAFF drill panel above. Counts still tracked, panel
              still renders inside the unified shift drill.) */}

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
              monthlyShiftsByEmp={monthlyShiftsByEmp}
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
  // actionable and at least one email has been sent today. In the B3
  // single-line layout we surface progress as a tiny status string
  // on the right rather than the previous progress-bar block — keeps
  // the tile to one row while still telling Bashaier where she is.
  const showProgress = !!progress && progress.total > 0;
  const allDone = showProgress && progress.sent >= progress.total;
  const progressText = showProgress
    ? (allDone ? `✓ all ${progress.total} sent` : `${progress.sent}/${progress.total} sent`)
    : null;
  // Right-side status text — progress wins when present, otherwise
  // fall back to the static subtext (e.g. "by 8:15", "approved leave
  // on file"). This collapses two separate UI rows into one.
  const statusText = progressText || subtext;
  return (
    <Tag
      type={isInteractive ? 'button' : undefined}
      onClick={isInteractive ? onClick : undefined}
      className={
        'rounded-lg text-left transition-all w-full flex items-center gap-2 '
        + (isInteractive
            ? 'cursor-pointer hover:-translate-y-0.5 active:translate-y-0 focus:outline-none focus:ring-2 focus:ring-offset-1'
            : 'cursor-default')
      }
      style={{
        background: tint,
        padding: '7px 11px',
        outlineColor: color,
        boxShadow: isOpen ? `0 0 0 2px ${color}, 0 2px 8px rgba(31,27,22,0.06)` : undefined,
      }}
      title={isInteractive ? `Click to ${isOpen ? 'collapse' : 'expand'} the list of ${count} ${label.toLowerCase()} below` : undefined}>
      {/* Count — leftmost, prominent */}
      <span style={{ fontSize: '18px', fontWeight: 700, color, lineHeight: 1.1, minWidth: '22px' }}>{count}</span>
      {/* Label — sentence-case, mid-weight, takes available space */}
      <span style={{ fontSize: '12px', fontWeight: 600, color, whiteSpace: 'nowrap' }}>{label}</span>
      {/* Status text — right-aligned, smaller, lighter */}
      {statusText && (
        <span style={{
          fontSize: '10px',
          color: allDone ? '#047857' : color,
          opacity: 0.75,
          fontWeight: allDone ? 600 : 500,
          marginLeft: 'auto',
          textAlign: 'right',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}>
          {statusText}
        </span>
      )}
      {/* Open-state chevron — only shows when clickable + has count.
          ▾ when expanded, ▸ when collapsed. Tiny so it doesn't
          dominate the right side. */}
      {isInteractive && (
        <span style={{ fontSize: '10px', color, opacity: 0.55, fontWeight: 600, marginLeft: statusText ? '6px' : 'auto' }}>
          {isOpen ? '▾' : '▸'}
        </span>
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
function BreakdownPanel({ kind, detection, onClose, monthlyShiftsByEmp }) {
  const config = {
    onTime:    { title: 'On time',         accent: '#047857', tint: '#ECFDF5', icon: '✓',  empty: 'No on-time entries.' },
    late:      { title: 'Late arrival',    accent: '#BE123C', tint: '#FFF1F2', icon: '⚠',  empty: 'Nobody arrived late — well done team.' },
    missedIn:  { title: 'Missed punch-in', accent: '#4338CA', tint: '#EEF2FF', icon: '🚫', empty: 'All staff have a punch-in on record.' },
    early:     { title: 'Early departure', accent: '#A16207', tint: '#FEFCE8', icon: '⏰', empty: 'Nobody left early.' },
    missedOut: { title: 'Missed punch-out',accent: '#7E22CE', tint: '#FAF5FF', icon: '🚪', empty: 'All staff have a punch-out on record.' },
    onLeave:   { title: 'On leave',        accent: '#0E7490', tint: '#ECFEFF', icon: '🌴', empty: 'Nobody on approved leave today.' },
    unknown:   { title: 'Unrecognised',    accent: '#991B1B', tint: '#FEF2F2', icon: '?',  empty: 'No unrecognised employees in the file.' },
    shiftOffDay: { title: 'Shift staff working off-roster', accent: '#3B4279', tint: '#EEF0FA', icon: '🗓️', empty: 'No shift staff worked outside their roster.' },
  };
  const cfg = config[kind] || config.late;
  // Map kind → detection bucket key (unknown is stored under unknownEmp).
  const bucketKey = kind === 'unknown' ? 'unknownEmp' : kind;
  const entries = detection[bucketKey] || [];

  // Format a YYYY-MM-DD as e.g. "Mon, 4 May 2026" so the row is
  // immediately readable (the raw ISO string is hard to parse at
  // a glance — Bashaier shouldn't have to mentally translate
  // "2026-05-04" into a weekday).
  const fmtDateWithWeekday = (ymd) => {
    if (!ymd) return '';
    const [y, m, d] = String(ymd).split('-').map(n => parseInt(n, 10));
    if (!y || !m || !d) return ymd;
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString('en-GB', {
      weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    });
  };

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
    if (kind === 'shiftOffDay') {
      // Phrasing chosen to be unambiguous: tells Bashaier (1) what
      // they punched, (2) that there's no shift on file for the
      // date, and (3) explicitly that this is NOT a violation.
      const inOut = `Punched ${e.punchInStr || '—'} → ${e.punchOutStr || '—'}`;
      return `${inOut} · No shift planned for this date — not flagged as late or absent`;
    }
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
        <>
          {/* Per-kind guidance note. Currently used only for
              shiftOffDay because that bucket is the most likely to
              be misunderstood — Bashaier might think these rows
              indicate a violation. The note explicitly says they
              don't, and points at the manager's plan as the
              source of truth so she knows where to investigate. */}
          {kind === 'shiftOffDay' && (
            <div
              className="m-2 p-3 rounded-md text-[12px] leading-relaxed"
              style={{
                background: cfg.tint,
                border: `1px solid ${cfg.accent}30`,
                color: '#0A0A0A',
              }}
            >
              <div className="text-[10px] tracking-[0.18em] mb-1" style={{ color: cfg.accent, fontWeight: 700 }}>
                WHAT THIS MEANS
              </div>
              <p style={{ margin: 0 }}>
                These employees punched in on a date with <strong>no shift assigned</strong> in the system.
                They are <strong>not late or absent</strong> — the schedule check is skipped because the manager has
                not planned a shift here.
              </p>
              <p style={{ margin: '6px 0 0 0' }}>
                If you expected a shift on this date, ask the manager to update their plan in <em>Shifts → Monthly Planner</em>.
                If the employee voluntarily came in for cover or extra hours, this is informational only.
              </p>
            </div>
          )}
          <ul className="p-2 space-y-1.5 max-h-[40vh] overflow-y-auto">
          {entries.map((e, i) => (
            <li key={e.id || `entry-${i}`}
                className="rounded-md px-3 py-2 border"
                style={{ background: '#FFFFFF', borderColor: '#E5E5E5' }}>
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
                    {fmtDateWithWeekday(e.dateLabel)}
                  </span>
                )}
              </div>
              <div className="text-xs mt-0.5" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                {detailFor(e)}
              </div>

              {/* Roster diagnostic — only for off-roster rows.
                  Shows the FULL set of dates this employee has
                  planned in the month plus each shift's status,
                  so the discrepancy ("plan looks right but May 4
                  is missing") becomes immediately visible. Without
                  this, Bashaier and Nadeem have to either query
                  the DB directly or trust the system's word that
                  there's no shift — neither is satisfying. */}
              {kind === 'shiftOffDay' && monthlyShiftsByEmp && (
                <RosterDiagnostic
                  empKey={String(e.employee?.id || '').toUpperCase()}
                  flaggedDate={e.dateLabel}
                  monthShifts={monthlyShiftsByEmp[String(e.employee?.id || '').toUpperCase()] || []}
                />
              )}
            </li>
          ))}
        </ul>
        </>
      )}
    </div>
  );
}

// ─── RosterDiagnostic ─────────────────────────────────────────────────
// Renders a compact summary of an employee's full monthly shift plan
// inside the off-roster breakdown row. Lets Bashaier (and Nadeem)
// instantly verify whether the manager's plan actually covers the
// flagged date, or whether there's a real gap.
//
// What it shows:
//   • Total shifts planned this month
//   • Per-status breakdown (pending / accepted / declined)
//   • Compact list of dates with weekday-letter headers, the
//     flagged date highlighted in red so the gap is obvious
//
// Three signal patterns to look for:
//   1. Plan looks complete but the flagged date is missing
//      → manager forgot a date; ask them to update
//   2. All shifts say 'declined'
//      → staff declined; off-day flag is correct
//   3. Plan has fewer dates than expected
//      → manager save was incomplete
function RosterDiagnostic({ empKey, flaggedDate, monthShifts }) {
  if (!monthShifts || monthShifts.length === 0) {
    return (
      <div
        className="mt-1.5 rounded text-[11px] px-2 py-1.5"
        style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#7F1D1D' }}
      >
        <strong>No shifts on file</strong> for this employee in the month — this row should
        have been evaluated against the standard schedule, not flagged as off-roster.
        Refresh the page; if the gap persists, the data fetch may have hit a transient error.
      </div>
    );
  }

  // Status counts.
  const counts = monthShifts.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  const statusBits = [];
  if (counts.pending)  statusBits.push(`${counts.pending} pending`);
  if (counts.accepted) statusBits.push(`${counts.accepted} accepted`);
  if (counts.declined) statusBits.push(`${counts.declined} declined`);
  const monthLabel = (() => {
    const d = monthShifts[0]?.date;
    if (!d) return '';
    const [y, m] = d.split('-').map(n => parseInt(n, 10));
    return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  })();

  return (
    <div
      className="mt-1.5 rounded px-2 py-2"
      style={{ background: '#F8FAFC', border: '1px solid #CBD5E1', fontSize: 11, lineHeight: 1.45 }}
    >
      <div style={{ color: '#1E293B', fontWeight: 600, marginBottom: 4 }}>
        Roster: {monthShifts.length} {monthShifts.length === 1 ? 'shift' : 'shifts'} planned in {monthLabel}
        {statusBits.length > 0 && (
          <span style={{ fontWeight: 400, opacity: 0.75 }}> · {statusBits.join(' · ')}</span>
        )}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {monthShifts.map(s => {
          const isFlagged = s.date === flaggedDate;
          const [y, m, d] = s.date.split('-').map(n => parseInt(n, 10));
          const dt = new Date(y, m - 1, d);
          // 2-letter codes so the weekdays are unambiguous. Single-
          // letter codes were ambiguous (T = Tue or Thu? S = Sun or
          // Sat?) which made the chip strip impossible to decode at
          // a glance.
          const dowFull  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][dt.getDay()];
          const dowShort = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][dt.getDay()];
          // Status colour: pending=amber, accepted=green, declined=red.
          const statusColor = s.status === 'declined' ? '#991B1B'
                            : s.status === 'accepted' ? '#0F4C2A'
                            : '#854F0B';
          const statusBg = s.status === 'declined' ? '#FEF2F2'
                         : s.status === 'accepted' ? '#ECFDF3'
                         : '#FEF6E2';
          return (
            <span
              key={s.date}
              title={`${dowFull} ${d} · ${s.startStr}–${s.endStr} · ${s.status}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 3,
                padding: '2px 6px',
                borderRadius: 4,
                background: isFlagged ? '#FFFFFF' : statusBg,
                color: isFlagged ? '#BE123C' : statusColor,
                border: isFlagged ? '1.5px solid #BE123C' : `1px solid ${statusColor}40`,
                fontWeight: isFlagged ? 700 : 500,
                fontFamily: 'ui-monospace, SFMono-Regular, monospace',
                fontSize: 10.5,
              }}
            >
              <span style={{ fontSize: 9, opacity: 0.7 }}>{dowShort}</span>
              {d}
            </span>
          );
        })}
      </div>
      <div style={{ marginTop: 6, fontSize: 10.5, color: '#64748B' }}>
        Flagged date <strong style={{ color: '#BE123C' }}>{flaggedDate}</strong> is not in the planned dates above.
        {counts.declined === monthShifts.length && (
          <> All planned shifts are <strong>declined</strong> — that's why no schedule applied.</>
        )}
      </div>
    </div>
  );
}


function FlaggedSection({ title, kicker, iconColor, barFrom, barTo, entries, empty, renderButton, onBulk, onExplain }) {
  if (!entries.length) {
    return (
      <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: '#D4D4D4' }}>
        <div className="text-[10px] mb-1" style={{ color: '#1F1B16', letterSpacing: '0.25em', fontWeight: 700 }}>{kicker}</div>
        <div style={{ fontFamily: 'inherit', fontSize: '20px', color: '#1F1B16' }}>{title}</div>
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
    <div className="rounded-2xl border bg-white p-3 sm:p-5" style={{ borderColor: '#D4D4D4' }}>
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
      <div className="mb-4" style={{ fontFamily: 'inherit', fontSize: '22px', color: '#1F1B16' }}>{title}</div>
      <div className="space-y-3">
        {entries.map(entry => (
          <div key={entry.id} className="rounded-xl border bg-white relative overflow-hidden esau-badge"
               style={{ borderColor: '#E5E5E5', boxShadow: '0 1px 2px rgba(31,27,22,0.04), 0 4px 14px rgba(31,27,22,0.06)' }}>
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
                          style={{ background: '#F4F4EE', border: '1px solid #E5E5E5' }}>
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
                {onExplain && (
                  <button onClick={() => onExplain(entry)}
                    className="text-[10px] px-2 py-1 rounded inline-flex items-center gap-1 hover:bg-[#FAFAF9]"
                    style={{
                      border: '1px solid #EEEAE0',
                      color: '#7A7A7A',
                      background: '#FFFFFF',
                    }}
                    title="Show the full evaluation chain — punches, schedule, comparison, permission lookup, classification.">
                    Why?
                  </button>
                )}
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
          style={{ borderColor: '#D4D4D4', color: '#0A0A0A', background: '#FFFFFF' }}
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
        style={{ borderColor: '#D4D4D4', color: '#1F1B16' }}
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
function ConfirmEmailModal({ confirm, csvDate, getManagerEmail, empById, monthlyShiftsByEmp, onCancel, onConfirm }) {
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
      isCustomShift: !!entry.isCustomShift,
      scheduleLabel: entry.scheduleLabel || null,
      isNightShiftStart: !!entry.isNightShiftStart,
      assignedBy: entry.assignedBy || null,
      assignedAt: entry.assignedAt || null,
      managerName: (entry.assignedBy && empById
        && String(entry.assignedBy).toUpperCase() === String(entry.employee?.manager_id || '').toUpperCase())
        ? (empById[String(entry.assignedBy).toUpperCase()]?.name || null)
        : null,
      staffHasShifts: !!entry.staffHasShifts,
      assignedShifts: monthlyShiftsByEmp
        ? (monthlyShiftsByEmp[String(entry.employee.id).toUpperCase()] || [])
        : [],
      violationDate: entry.dateLabel || csvDate,
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
      isCustomShift: !!entry.isCustomShift,
      scheduleLabel: entry.scheduleLabel || null,
      isNightShiftEnd: !!entry.isNightShiftEnd,
      scheduledStart: entry.scheduledStart,
      assignedBy: entry.assignedBy || null,
      assignedAt: entry.assignedAt || null,
      managerName: (entry.assignedBy && empById
        && String(entry.assignedBy).toUpperCase() === String(entry.employee?.manager_id || '').toUpperCase())
        ? (empById[String(entry.assignedBy).toUpperCase()]?.name || null)
        : null,
      staffHasShifts: !!entry.staffHasShifts,
      assignedShifts: monthlyShiftsByEmp
        ? (monthlyShiftsByEmp[String(entry.employee.id).toUpperCase()] || [])
        : [],
      violationDate: entry.dateLabel || csvDate,
    });
    subject = c.subject;
    summary = `Early departure on ${dateLong} — punched out ${entry.punchOutStr}, ${entry.minutesEarly} min before scheduled ${entry.scheduledEnd}.`;
  } else if (kind === 'missed' || kind === 'missedIn' || kind === 'missedOut' || kind === 'shiftAbsent') {
    const fn = mode === 'test' ? missedPunchEmailContentTemp : missedPunchEmailContent;
    const c = fn({
      employee: entry.employee, dateLong, missingType: entry.missingType,
      isShiftAbsence: !!entry.isShiftAbsence,
      isCustomShift: !!entry.isCustomShift,
      scheduleLabel: entry.scheduleLabel || null,
      scheduledStart: entry.scheduledStart || null,
      scheduledEnd: entry.scheduledEnd || null,
      isNightShiftStart: !!entry.isNightShiftStart,
      isNightShiftEnd:   !!entry.isNightShiftEnd,
      assignedBy: entry.assignedBy || null,
      assignedAt: entry.assignedAt || null,
      managerName: (entry.assignedBy && empById
        && String(entry.assignedBy).toUpperCase() === String(entry.employee?.manager_id || '').toUpperCase())
        ? (empById[String(entry.assignedBy).toUpperCase()]?.name || null)
        : null,
      staffHasShifts: !!entry.staffHasShifts,
      assignedShifts: monthlyShiftsByEmp
        ? (monthlyShiftsByEmp[String(entry.employee.id).toUpperCase()] || [])
        : [],
      violationDate: entry.dateLabel || csvDate,
    });
    subject = c.subject;
    summary = `Missing punch on ${dateLong} — ${entry.missingType === 'both' ? 'both in and out' : entry.missingType === 'in' ? 'punch-in' : 'punch-out'} not recorded.`;
  }

  // Test-mode banner copy varies by kind. For missed-punch the test
  // wording is identical to live (the live version doesn't reference
  // the portal anyway), so we surface that fact rather than implying
  // a difference that isn't there.
  const testBannerCopy = (kind === 'missed' || kind === 'missedIn' || kind === 'missedOut' || kind === 'shiftAbsent')
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
          borderColor: '#D4D4D4',
          background: '#FFFFFF',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b" style={{ borderColor: '#E5E5E5' }}>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                 style={{
                   background: mode === 'test' ? '#FEF3C7' : '#FEF3C7',
                   border:     mode === 'test' ? '1px solid #FDE68A' : '1px solid #FDE68A',
                 }}>
              <Mail className="w-5 h-5" style={{ color: mode === 'test' ? '#92400E' : '#A16207' }}/>
            </div>
            <div>
              <h2 style={{ fontFamily: 'inherit', fontSize: '18px', color: '#0A0A0A', fontWeight: 500 }}>
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
               style={{ borderColor: '#E5E5E5', background: '#FFFBEB', color: '#92400E', lineHeight: 1.5 }}>
            <strong style={{ letterSpacing: '0.1em', fontWeight: 700 }}>{testBannerCopy.split(' — ')[0]}</strong>
            {' — '}
            {testBannerCopy.split(' — ').slice(1).join(' — ')}
          </div>
        )}

        {/* Recipient + subject preview */}
        <div className="px-6 py-4 border-b text-xs" style={{ borderColor: '#E5E5E5', color: '#0A0A0A' }}>
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
            style={{ background: '#FFFFFF', borderColor: '#D4D4D4', color: '#0A0A0A', fontWeight: 500 }}>
            Cancel
          </button>
          <button type="button" onClick={onConfirm} disabled={!entry.employee.email}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
            style={mode === 'test'
              ? { background: '#92400E', color: '#FFFFFF', fontWeight: 500 }
              : { background: '#0A0A0A', color: '#FFFFFF', fontWeight: 500 }}>
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
    if (kind === 'missed' || kind === 'missedIn' || kind === 'missedOut' || kind === 'shiftAbsent') {
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
  const headerKickerFg = isTest ? '#92400E' : '#FFFFFF';
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
          borderColor: '#D4D4D4',
          background: '#FFFFFF',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b" style={{ borderColor: '#E5E5E5' }}>
          <div className="min-w-0 flex-1">
            <div className="inline-flex items-center gap-2 mb-2">
              <span className="text-[10px] tracking-[0.25em] px-2 py-0.5 rounded-full"
                    style={{ fontWeight: 700, background: headerKickerBg, color: headerKickerFg }}>
                BULK · {heading.toUpperCase()} · {isTest ? 'TEST' : 'LIVE'}
              </span>
            </div>
            <h2 style={{ fontFamily: 'inherit', fontSize: '20px', color: '#0A0A0A', fontWeight: 500 }}>
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
              <div className="inline-flex rounded-full overflow-hidden border" style={{ borderColor: '#D4D4D4', background: '#FFFFFF' }}>
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
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#E5E5E5' }}>
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
                    borderColor: sent ? '#A7F3D0' : '#E5E5E5',
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
             style={{ borderColor: '#E5E5E5', background: '#F7F7F7' }}>
          <div className="text-[11px]" style={{ color: '#0A0A0A' }}>
            Each click opens a draft in your mail client. You still send each one manually.
          </div>
          <button type="button" onClick={onClose}
            className="text-xs px-4 py-2 rounded-full"
            style={{ background: '#0A0A0A', color: '#FFFFFF', fontWeight: 500 }}>
            {remaining.length === 0 ? 'Done' : `Stop (${remaining.length} remaining)`}
          </button>
        </div>
      </div>
    </div>
  );
}
