// =============================================================================
// EmployeeAttendanceDetailPanel.jsx
//
// Right-side slide-in drawer launched when Bashaier clicks an employee
// row in the Monthly Overview calendar. Shows that employee's full
// attendance history (Jan 1 of the current year through today) and
// can switch to a Leave view via the in-panel tab.
//
// LAYOUT
//   Container is fixed to the right edge of the viewport, ~520px on
//   desktop (full-width on mobile). Spring-bounces in from the right
//   on mount; backdrop fades in. ESC or backdrop-click closes; close
//   animates out by reversing the slide.
//
// TABS
//   • Attendance — every recorded attendance_daily row from Jan 1
//                  to today, grouped by month with summary stats.
//   • Leave      — every leave_request whose [start, end] overlaps
//                  the same window, with type, dates, status, reason.
//
// EXPORT
//   Each tab's view exports as a standalone HTML report (opens in a
//   new tab and immediately presents the print dialog). Reports use
//   the same visual language as the weekend attendance report so
//   anything Bashaier sends out looks like it came from the same
//   system.
//
// FETCH
//   Single fetch on mount per tab — attendance_daily rows + leave
//   requests. Both queries are date-range bounded so the payload
//   stays small. The caller passes `employee` so we already have
//   name/dept/id for headers.
// =============================================================================

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  X, Download, Loader2, Calendar as CalIcon,
  CheckCircle2, AlertCircle, Clock, FileSpreadsheet, ChevronRight,
} from 'lucide-react';
import { directGet } from '../supabaseClient.js';

// ─── Inline keyframes ────────────────────────────────────────────────
// Plain ease — bounces removed per Nadeem's feedback.
const ANIM_CSS = `
@keyframes detail-backdrop-in {
  0%   { opacity: 0; }
  100% { opacity: 1; }
}
@keyframes detail-panel-in {
  0%   { transform: translateX(100%); opacity: 0; }
  100% { transform: translateX(0); opacity: 1; }
}
@keyframes detail-fade-in {
  0%   { opacity: 0; transform: translateY(2px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes detail-row-in {
  0%   { opacity: 0; transform: translateX(4px); }
  100% { opacity: 1; transform: translateX(0); }
}
`;

// ─── Helpers ─────────────────────────────────────────────────────────
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function trimTime(t) {
  if (!t) return '';
  return String(t).slice(0, 5);
}

const STATUS_META = {
  present:      { bg: '#ECFDF5', fg: '#0F4C2A', border: '#A7F3D0', label: 'Present',      icon: '✓'  },
  late:         { bg: '#FEF3C7', fg: '#854F0B', border: '#FCD34D', label: 'Late',         icon: 'LT' },
  short:        { bg: '#FED7AA', fg: '#7C2D12', border: '#FB923C', label: 'Left early',   icon: 'SH' },
  absent:       { bg: '#FEE2E2', fg: '#991B1B', border: '#FCA5A5', label: 'Absent',       icon: 'AB' },
  annual_leave: { bg: '#CCFBF1', fg: '#115E59', border: '#5EEAD4', label: 'Annual leave', icon: 'AL' },
  sick_leave:   { bg: '#EDE9FE', fg: '#5B21B6', border: '#C4B5FD', label: 'Sick leave',   icon: 'SL' },
  off_roster:   { bg: '#DBEAFE', fg: '#1E3A8A', border: '#93C5FD', label: 'Off-roster',   icon: 'OR' },
  off_day:      { bg: '#EEF0FA', fg: '#3B4279', border: '#C7CFE5', label: 'Off-day',      icon: 'OF' },
};

function statusMeta(s, notes) {
  // Permission-coverage variants — when a 'present' row was actually
  // late or early but downgraded because an approved permission
  // covered the punch, show a distinct blue chip with a tick.
  // Per Nadeem (2026-05-06): the tick signals "complete with permit",
  // distinguishing LP/EP from naturally-on-time presents.
  if (s === 'present' && typeof notes === 'string') {
    if (/late arrival covered by approved permission/i.test(notes)) {
      return { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: 'Late — permitted',  icon: '✓LP' };
    }
    if (/early leave covered by approved permission/i.test(notes)) {
      return { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: 'Early — permitted', icon: '✓EP' };
    }
  }
  return STATUS_META[s] || { bg: '#F5F5F5', fg: '#525252', border: '#D4D4D4', label: s, icon: '?' };
}

const MONTH_NAMES = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];

function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

function fmtRangeShort(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// HTML escape
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;'
  ));
}

// =============================================================================

export default function EmployeeAttendanceDetailPanel({ employee, onClose }) {
  const [closing, setClosing] = useState(false);
  const [attRows, setAttRows] = useState(null); // null = loading
  const [leaveRows, setLeaveRows] = useState(null);
  const [leaveTypes, setLeaveTypes] = useState([]);

  // Range: Jan 1 of CURRENT YEAR → today (local).
  const range = useMemo(() => {
    const today = new Date();
    const from  = new Date(today.getFullYear(), 0, 1);
    return { from: ymd(from), to: ymd(today), todayDate: today, fromDate: from };
  }, []);

  // ─── Close machinery — animate out, then call parent's onClose ──
  const requestClose = useCallback(() => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => onClose?.(), 220);
  }, [onClose, closing]);

  // ESC key + backdrop click
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') requestClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [requestClose]);

  // Lock body scroll while panel open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // ─── Fetch attendance ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!employee?.id) return;
    (async () => {
      try {
        const data = await directGet(
          'attendance_daily',
          `select=attendance_date,status,first_punch,last_punch,punch_count,` +
          `expected_start,expected_end,late_minutes,early_leave_minutes,notes` +
          `&employee_id=eq.${encodeURIComponent(employee.id)}` +
          `&attendance_date=gte.${range.from}&attendance_date=lte.${range.to}` +
          `&order=attendance_date.asc`,
          { timeoutMs: 12000 }
        );
        if (!cancelled) setAttRows(data || []);
      } catch (e) {
        if (!cancelled) setAttRows([]);
      }
    })();
    return () => { cancelled = true; };
  }, [employee?.id, range.from, range.to]);

  // ─── Fetch leave ──────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    if (!employee?.id) return;
    (async () => {
      try {
        // Pull every leave_request that overlaps the window. The
        // overlap test is "start <= range.to AND end >= range.from"
        // — covers single-day, multi-day, and ongoing leaves.
        const leaves = await directGet(
          'leave_requests',
          `select=id,start_date,end_date,leave_type_id,status,reason,decided_at` +
          `&employee_id=eq.${encodeURIComponent(employee.id)}` +
          `&start_date=lte.${range.to}` +
          `&end_date=gte.${range.from}` +
          `&order=start_date.asc`,
          { timeoutMs: 12000 }
        );
        // Pull the leave-types lookup once so we can resolve names.
        const types = await directGet(
          'leave_types',
          `select=id,name,code`,
          { timeoutMs: 6000 }
        ).catch(() => []);
        if (!cancelled) {
          setLeaveRows(leaves || []);
          setLeaveTypes(types || []);
        }
      } catch (e) {
        if (!cancelled) {
          setLeaveRows([]);
          setLeaveTypes([]);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [employee?.id, range.from, range.to]);

  // ─── Derived: monthly groups + summary counts ─────────────────────
  const monthly = useMemo(() => {
    if (!Array.isArray(attRows)) return [];
    const groups = new Map();
    for (const r of attRows) {
      const [y, m] = r.attendance_date.split('-').map(n => parseInt(n, 10));
      const key = `${y}-${String(m).padStart(2, '0')}`;
      if (!groups.has(key)) groups.set(key, { year: y, month: m - 1, rows: [] });
      groups.get(key).rows.push(r);
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      return a.month - b.month;
    });
  }, [attRows]);

  // Rich per-employee aggregate over the visible date range.
  // Drives the summary tiles at the top of the Attendance tab.
  // Keeps the legacy shape (status-keyed counts) intact for the
  // export functions, and adds:
  //   • totalLateMinutes / totalEarlyMinutes — useful for HR
  //     to see the magnitude, not just the count of incidents
  //   • missedInCount / missedOutCount — data-quality signal
  //   • leaveByType — Map of leave_type_id → { name, days, requests }
  //     so each leave type (annual, sick, emergency, unpaid, ...)
  //     gets its own tile instead of being collapsed into one
  //     generic "leave" number
  const summary = useMemo(() => {
    if (!Array.isArray(attRows)) return null;
    const counts = {};
    let totalLateMinutes  = 0;
    let totalEarlyMinutes = 0;
    let missedInCount  = 0;
    let missedOutCount = 0;
    for (const r of attRows) {
      counts[r.status] = (counts[r.status] || 0) + 1;
      if (r.status === 'late')  totalLateMinutes  += (r.late_minutes || 0);
      if (r.status === 'short') totalEarlyMinutes += (r.early_leave_minutes || 0);
      // Missed-punch detection — same convention as the calendar grid
      const hasFirst = !!r.first_punch;
      const hasLast  = !!r.last_punch;
      if (!hasFirst && hasLast) missedInCount++;
      if (hasFirst && !hasLast) missedOutCount++;
    }

    // Per-leave-type breakdown. Only requests with status='approved'
    // count toward "days off taken" — pending/declined are noise here.
    // Each entry tracks request count + total approved days.
    const leaveByType = new Map();
    if (Array.isArray(leaveRows)) {
      for (const lr of leaveRows) {
        if (lr.status !== 'approved') continue;
        const tid = lr.leave_type_id;
        if (!tid) continue;
        const tname = (leaveTypes.find(t => t.id === tid))?.name || 'Leave';
        const tcode = (leaveTypes.find(t => t.id === tid))?.code || null;
        const s = new Date(lr.start_date + 'T00:00:00');
        const e = new Date(lr.end_date   + 'T00:00:00');
        const days = Math.max(1, Math.floor((e - s) / 86400000) + 1);
        const cur = leaveByType.get(tid) || { id: tid, name: tname, code: tcode, days: 0, requests: 0 };
        cur.days     += days;
        cur.requests += 1;
        leaveByType.set(tid, cur);
      }
    }

    return {
      ...counts,
      totalLateMinutes,
      totalEarlyMinutes,
      missedInCount,
      missedOutCount,
      leaveByType,
    };
  }, [attRows, leaveRows, leaveTypes]);

  const leaveTypeName = useCallback((id) => {
    const t = leaveTypes.find(x => x.id === id);
    return t?.name || 'Leave';
  }, [leaveTypes]);

  // ─── HTML export ──────────────────────────────────────────────────
  // Single combined report — attendance calendar + the per-leave-type
  // breakdown that's now baked into the summary tiles. The previous
  // "Leave" report is folded into this one.
  //
  // Wrapped in try/catch so any error in the report builder surfaces
  // to the user instead of silently failing on click — the previous
  // bug ("Export button does nothing") was hard to diagnose because
  // every error was swallowed.
  const exportHtml = useCallback(() => {
    try {
      exportAttendanceHtml(employee, range, monthly, summary || {}, leaveRows || [], leaveTypeName);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Export HTML failed:', err);
      try {
        // eslint-disable-next-line no-alert
        alert('Could not generate the report: ' + (err?.message || err));
      } catch {}
    }
  }, [employee, range, monthly, summary, leaveRows, leaveTypeName]);

  if (!employee) return null;

  return (
    <>
      <style>{ANIM_CSS}</style>

      {/* Backdrop */}
      <div
        onClick={requestClose}
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(31, 27, 22, 0.45)',
          zIndex: 70,
          animation: closing
            ? 'detail-backdrop-in 0.18s ease-out reverse'
            : 'detail-backdrop-in 0.22s ease-out',
          opacity: closing ? 0 : 1,
          transition: closing ? 'opacity 0.18s ease-out' : 'none',
        }}
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Attendance detail for ${employee.name || employee.id}`}
        style={{
          position: 'fixed',
          top: 0, right: 0, bottom: 0,
          width: 'min(560px, 100vw)',
          background: '#FAFAF6',
          zIndex: 71,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-12px 0 32px rgba(0,0,0,0.18)',
          // Calibri throughout the panel — Bashaier prefers it over
          // the serif we were using before. Cascades down so every
          // label/heading inside picks it up unless explicitly overridden.
          fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
          animation: closing
            ? 'detail-panel-in 0.22s cubic-bezier(0.4, 0, 0.6, 1) reverse forwards'
            : 'detail-panel-in 0.42s ease-out',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 20px 14px',
            background: 'linear-gradient(180deg, #FFFFFF 0%, #FAFAF6 100%)',
            borderBottom: '1px solid #E5E5E5',
            position: 'relative',
          }}
        >
          <button
            onClick={requestClose}
            aria-label="Close panel"
            style={{
              position: 'absolute',
              top: 12, right: 12,
              width: 32, height: 32,
              borderRadius: 999,
              border: '1px solid #E5E5E5',
              background: '#FFFFFF',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#0A0A0A',
              transition: 'all 0.2s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = '#F5F5F5'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = '#FFFFFF'; }}
          >
            <X className="w-4 h-4" />
          </button>

          <div className="text-[10px]" style={{ color: '#0F4C2A', fontWeight: 700, letterSpacing: '0.25em' }}>
            STAFF ATTENDANCE DETAIL
          </div>
          <h2
            style={{
              fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
              fontSize: 24,
              color: '#1F1B16',
              marginTop: 2,
              lineHeight: 1.15,
              fontWeight: 700,
              paddingRight: 36,
            }}
          >
            {employee.name || employee.id}
          </h2>
          <div className="text-[12px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            {employee.id}
            {employee.department ? ` · ${employee.department}` : ''}
            {employee.location ? ` · ${employee.location}` : ''}
          </div>
          <div className="text-[11px] mt-1.5 inline-flex items-center gap-1.5"
            style={{ color: '#0A0A0A', opacity: 0.6 }}>
            <CalIcon className="w-3 h-3" />
            {fmtRangeShort(range.from)} &ndash; {fmtRangeShort(range.to)}
          </div>
        </div>

        {/* Pinned summary band — sits between the staff-name header
            and the scrollable calendar so the totals stay visible
            while Bashaier scrolls through months. The band has its
            own bottom border + tinted background so it reads as a
            separate region rather than blending into the calendar. */}
        {attRows !== null && summary && (
          <div
            style={{
              padding: '8px 16px 10px',
              background: '#FAFAF6',
              borderBottom: '1px solid #E5E5E5',
              flexShrink: 0,
              maxHeight: '38vh',
              overflowY: 'auto',
            }}
          >
            <AttendanceSummaryPinned summary={summary} />
          </div>
        )}

        {/* Body — scrollable. Calendar grids only; the summary
            stays pinned above. */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px 20px' }}>
          <AttendanceCalendarBody
            loading={attRows === null}
            monthly={monthly}
          />
        </div>

        {/* Footer — actions */}
        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid #E5E5E5',
            background: '#FFFFFF',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>
            Press <kbd style={{ fontFamily: 'inherit', background: '#F5F5F5', padding: '1px 5px', borderRadius: 3, border: '1px solid #E5E5E5' }}>Esc</kbd> to close
          </div>
          <button
            onClick={exportHtml}
            disabled={attRows === null}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[12px]"
            style={{
              background: '#0F4C2A',
              color: '#FFFFFF',
              border: 'none',
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(15,76,42,0.18)',
              transition: 'all 0.2s ease-out',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 6px 16px rgba(15,76,42,0.28)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 2px 6px rgba(15,76,42,0.18)';
            }}
          >
            <Download className="w-3.5 h-3.5" />
            Export HTML
          </button>
        </div>
      </div>
    </>
  );
}

// ─── SummaryTile ─────────────────────────────────────────────────────
// Single stat card used in the Attendance tab's summary header. Shows
// a big serif-style number, an uppercase label below, and an optional
// sub-line for finer-grained context (e.g. "183 min total" under the
// Late count, or "3 requests" under a leave-type tile).
//
// `meta` = { bg, fg, border } matches the statusMeta shape so any
// new chip palette can be slotted in without code changes.
//
// `muted=true` renders a desaturated variant — used when a 0-value
// tile is shown for visual symmetry but shouldn't draw attention.
function SummaryTile({ label, value, sub, meta, delay = 0, muted = false }) {
  const m = meta || { bg: '#FFFFFF', fg: '#1F1B16', border: '#E5E5E5' };
  return (
    <div
      style={{
        background: muted ? '#FAFAF6' : '#FFFFFF',
        border: `1px solid ${muted ? '#E5E5E5' : m.border}`,
        borderRadius: 8,
        padding: '6px 6px 5px',
        textAlign: 'center',
        animation: `detail-fade-in 0.4s ease-out ${delay}ms both`,
        opacity: muted ? 0.55 : 1,
        minWidth: 0,
      }}
    >
      <div
        style={{
          fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
          fontSize: 18,
          color: muted ? '#737373' : m.fg,
          fontWeight: 700,
          lineHeight: 1,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontSize: 9,
          marginTop: 3,
          color: '#0A0A0A',
          opacity: 0.75,
          fontWeight: 700,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          // Tight 2-line cap so longer leave-type names ("Emergency
          // leave", "Compassionate") still fit without truncation
          lineHeight: 1.15,
        }}
      >
        {label}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 9,
            marginTop: 1,
            color: muted ? '#737373' : m.fg,
            opacity: 0.85,
            fontWeight: 500,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

// ─── SectionLabel ────────────────────────────────────────────────────
// Small uppercase kicker that introduces a group of summary tiles.
// `mt` adds a top margin so it visually separates from the previous
// section without leaning on padding hacks.
function SectionLabel({ children, mt }) {
  return (
    <div
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.2em',
        color: '#1F1B16',
        opacity: 0.6,
        marginTop: mt ? 8 : 0,
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  );
}

// ─── leaveMetaFor ────────────────────────────────────────────────────
// Picks a chip palette for a given leave-type entry. The convention:
//   • `code` is the canonical machine-friendly identifier on the
//     leave_types row ('SICK', 'EMERGENCY', 'ANNUAL', etc.). When
//     present, it drives the color so the same type always renders
//     consistently across UIs.
//   • Falls back to a name-based heuristic for legacy types without
//     a code.
//   • Final fallback is a neutral teal so unknown types still look
//     intentional rather than broken.
function leaveMetaFor(entry) {
  const codeOrName = String(entry?.code || entry?.name || '').toUpperCase();
  if (/SICK/.test(codeOrName))      return { bg:'#EDE9FE', fg:'#5B21B6', border:'#C4B5FD' };
  if (/EMERG/.test(codeOrName))     return { bg:'#FEE2E2', fg:'#991B1B', border:'#FCA5A5' };
  if (/UNPAID/.test(codeOrName))    return { bg:'#F5F5F5', fg:'#525252', border:'#A3A3A3' };
  if (/MATERNIT/.test(codeOrName))  return { bg:'#FCE7F3', fg:'#9D174D', border:'#F9A8D4' };
  if (/PATERNIT/.test(codeOrName))  return { bg:'#DBEAFE', fg:'#1E3A8A', border:'#93C5FD' };
  if (/HAJJ/.test(codeOrName))      return { bg:'#FEF3C7', fg:'#854F0B', border:'#FCD34D' };
  if (/COMPASS|BEREAVE/.test(codeOrName)) return { bg:'#E0E7FF', fg:'#3730A3', border:'#A5B4FC' };
  if (/ANNUAL/.test(codeOrName))    return { bg:'#CCFBF1', fg:'#115E59', border:'#5EEAD4' };
  return { bg:'#CCFBF1', fg:'#115E59', border:'#5EEAD4' };
}

// ─── TabButton ───────────────────────────────────────────────────────
function TabButton({ active, onClick, icon, label, count }) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px]"
      style={{
        background: active ? '#1F1B16' : 'transparent',
        color: active ? '#FFFFFF' : '#1F1B16',
        border: '1px solid ' + (active ? '#1F1B16' : '#E5E5E5'),
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        transition: 'all 0.2s ease-out',
      }}
    >
      {icon}
      {label}
      {count != null && count > 0 && (
        <span style={{
          background: active ? 'rgba(255,255,255,0.2)' : '#F5F5F5',
          color: active ? '#FFFFFF' : '#1F1B16',
          padding: '0 6px',
          borderRadius: 999,
          fontSize: 10,
          fontWeight: 700,
        }}>
          {count}
        </span>
      )}
    </button>
  );
}

// ─── AttendanceSummaryPinned ─────────────────────────────────────────
// The summary tiles that pin to the top of the detail panel — stays
// visible regardless of how far Bashaier scrolls the calendar below.
// Two sections of tiles:
//   • ATTENDANCE — Present / Late / Left early on row 1; second row
//     for Absent / No clock-in / No clock-out only when any are
//     non-zero (otherwise hidden to keep the band compact).
//   • LEAVE      — one tile per leave_type the employee actually
//     used in the range, hidden entirely if no approved leaves.
// ─── ALL_LEAVE_TYPE_KEYS ──────────────────────────────────────────────
// Canonical set of leave-type keys that should render a tile for
// EVERY staff member, regardless of whether they've taken that
// leave in the visible range. Bashaier asked for "all box appear
// for all staff" so absent leave counts are still shown (with a 0,
// muted) — gives a consistent visual scan across staff.
//
// Code-based matching here uses the same pattern as leaveMetaFor()
// so the tile's color is consistent. Display name is best-guess
// for when no DB row exists yet; the real leave_types row's name
// overrides this when present.
const FALLBACK_LEAVE_TYPES = [
  { code: 'ANNUAL',     name: 'Annual leave' },
  { code: 'SICK',       name: 'Sick leave' },
  { code: 'EMERGENCY',  name: 'Emergency leave' },
  { code: 'UNPAID',     name: 'Unpaid leave' },
  { code: 'MATERNITY',  name: 'Maternity leave' },
  { code: 'PATERNITY',  name: 'Paternity leave' },
  { code: 'HAJJ',       name: 'Hajj leave' },
  { code: 'COMPASSIONATE', name: 'Compassionate leave' },
];

function AttendanceSummaryPinned({ summary }) {
  if (!summary) return null;
  const counts = summary;

  // Build the leave tiles list — merge actual usage from
  // summary.leaveByType with the canonical fallback set so a tile
  // appears for every leave type even when the staff hasn't used
  // it in the range. Used types win on the (matched) code so the
  // DB-driven `name` and `id` survive.
  const usedByCode = new Map();
  if (summary.leaveByType) {
    for (const entry of summary.leaveByType.values()) {
      const k = String(entry.code || entry.name || '').toUpperCase();
      usedByCode.set(k, entry);
    }
  }
  const leaveTiles = FALLBACK_LEAVE_TYPES.map(fb => {
    // Try to find a matching used entry by code or name partial
    const fbKey = fb.code.toUpperCase();
    let used = null;
    for (const [k, v] of usedByCode) {
      if (k.includes(fbKey) || fbKey.includes(k)) { used = v; break; }
    }
    if (used) {
      return { ...used, _fallback: false };
    }
    return {
      id: `fallback-${fb.code}`,
      name: fb.name,
      code: fb.code,
      days: 0,
      requests: 0,
      _fallback: true,
    };
  });

  return (
    <div>
      <SectionLabel>ATTENDANCE</SectionLabel>
      <div className="grid grid-cols-3 gap-1.5 mb-1.5">
        <SummaryTile
          label="Present"
          value={counts.present || 0}
          meta={statusMeta('present')}
          muted={(counts.present || 0) === 0}
        />
        <SummaryTile
          label="Late"
          value={counts.late || 0}
          sub={(summary.totalLateMinutes || 0) > 0 ? `${summary.totalLateMinutes} min` : null}
          meta={statusMeta('late')}
          muted={(counts.late || 0) === 0}
        />
        <SummaryTile
          label="Left early"
          value={counts.short || 0}
          sub={(summary.totalEarlyMinutes || 0) > 0 ? `${summary.totalEarlyMinutes} min` : null}
          meta={statusMeta('short')}
          muted={(counts.short || 0) === 0}
        />
      </div>

      {/* Quality row — always rendered so the panel layout is
          consistent across staff. Zero-value tiles render in muted
          variant. */}
      <div className="grid grid-cols-3 gap-1.5">
        <SummaryTile
          label="Absent"
          value={counts.absent || 0}
          meta={statusMeta('absent')}
          muted={(counts.absent || 0) === 0}
        />
        <SummaryTile
          label="No clock-in"
          value={summary.missedInCount || 0}
          meta={{ bg:'#FCE7F3', fg:'#86198F', border:'#F0ABFC' }}
          muted={(summary.missedInCount || 0) === 0}
        />
        <SummaryTile
          label="No clock-out"
          value={summary.missedOutCount || 0}
          meta={{ bg:'#E0E7FF', fg:'#3730A3', border:'#A5B4FC' }}
          muted={(summary.missedOutCount || 0) === 0}
        />
      </div>

      <SectionLabel mt>LEAVE</SectionLabel>
      <div
        className="grid gap-1.5"
        style={{
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
        }}
      >
        {leaveTiles.map((entry) => (
          <SummaryTile
            key={entry.id}
            label={entry.name}
            value={entry.days}
            sub={entry.requests > 0 ? `${entry.requests} req` : null}
            meta={leaveMetaFor(entry)}
            muted={entry.days === 0}
          />
        ))}
      </div>
    </div>
  );
}

// ─── AttendanceCalendarBody ──────────────────────────────────────────
// Just the month-by-month calendar grids. Renders inside the panel's
// scrollable region; the summary stays pinned above.
function AttendanceCalendarBody({ loading, monthly }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-sm" style={{ color: '#0A0A0A', opacity: 0.6 }}>
        <Loader2 className="w-4 h-4 animate-spin" /> Loading attendance…
      </div>
    );
  }

  return (
    <div>
      {monthly.length === 0 && (
        <div
          className="rounded-xl p-5 text-center"
          style={{ background: '#FFFFFF', border: '1px dashed #E5E5E5', color: '#0A0A0A', opacity: 0.6 }}
        >
          <FileSpreadsheet className="w-6 h-6 mx-auto mb-2" />
          <div className="text-sm">No attendance records in this range yet.</div>
          <div className="text-[11px] mt-1">As daily files are uploaded, days populate here.</div>
        </div>
      )}

      {/* Monthly calendar grids — one per month with data */}
      {monthly.map((g) => (
        <MonthCalendar
          key={`${g.year}-${g.month}`}
          year={g.year}
          monthIdx={g.month}
          rows={g.rows}
        />
      ))}
    </div>
  );
}

// ─── MonthCalendar ──────────────────────────────────────────────────
// Renders a single month as a 7-column wall-calendar grid. Each cell
// shows the day number plus a status chip when there's an
// attendance_daily record for that date. The cell background is
// faintly tinted with the status color, the chip carries the icon
// (P / LT / AB / AL / etc.), and a tiny line of punch times sits
// underneath when room allows.
//
// Layout details:
//   • 7 columns, 5–6 rows depending on month
//   • Day-of-week header row (S M T W T F S)
//   • Sun-first (matches Saudi week orientation, Saturday end)
//   • KSA weekend (Fri+Sat) gets a faint beige tint when empty
//   • Today's column gets a green outline
//   • Future days (after today) are dimmed
//   • Hover any cell with data → native title tooltip with full detail
function MonthCalendar({ year, monthIdx, rows }) {
  const firstOfMonth = new Date(year, monthIdx, 1);
  const lastOfMonth  = new Date(year, monthIdx + 1, 0);
  const daysInMonth  = lastOfMonth.getDate();
  // Pad cells before day 1 so day 1 lands in the right weekday column.
  // Sun=0, Mon=1, ..., Sat=6.
  const padBefore = firstOfMonth.getDay();

  // Index records by day-of-month (1..31)
  const byDay = new Map();
  for (const r of rows) {
    const day = parseInt(r.attendance_date.slice(8, 10), 10);
    byDay.set(day, r);
  }

  // Per-month chip-strip counts. Permission-covered presents are
  // tracked separately under synthetic keys 'present_lp' / 'present_ep'
  // so the chip strip can show them distinctly from naturally-on-time
  // presents. The DB still stores them as status='present' — these
  // synthetic keys are UI-only.
  const monthCounts = rows.reduce((acc, r) => {
    let key = r.status;
    if (r.status === 'present' && typeof r.notes === 'string') {
      if (/late arrival covered by approved permission/i.test(r.notes))   key = 'present_lp';
      else if (/early leave covered by approved permission/i.test(r.notes)) key = 'present_ep';
    }
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  // Today / future cutoff
  const today = new Date();
  const isCurrentMonth = today.getFullYear() === year && today.getMonth() === monthIdx;
  const todayDay = isCurrentMonth ? today.getDate() : null;

  return (
    <div style={{ marginBottom: 22 }}>
      {/* Month title + record count */}
      <div className="flex items-baseline justify-between mb-2">
        <div
          style={{
            fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
            fontSize: 17,
            color: '#1F1B16',
            fontWeight: 700,
            letterSpacing: '-0.005em',
          }}
        >
          {MONTH_NAMES[monthIdx]} {year}
        </div>
        <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.55 }}>
          {rows.length} {rows.length === 1 ? 'record' : 'records'}
        </div>
      </div>

      {/* Mini chip strip */}
      <div className="flex flex-wrap gap-1 mb-2">
        {Object.entries(monthCounts).map(([k, v]) => {
          // Synthetic keys 'present_lp' / 'present_ep' get their own
          // blue tick chips. Otherwise fall through to statusMeta.
          let meta;
          if (k === 'present_lp') {
            meta = { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: 'Late — permitted',  icon: '✓LP' };
          } else if (k === 'present_ep') {
            meta = { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: 'Early — permitted', icon: '✓EP' };
          } else {
            meta = statusMeta(k);
          }
          return (
            <span
              key={k}
              style={{
                background: meta.bg,
                color:      meta.fg,
                border:     `1px solid ${meta.border}`,
                fontSize: 10, padding: '1px 6px', borderRadius: 999, fontWeight: 700,
              }}
            >
              {meta.label}: {v}
            </span>
          );
        })}
      </div>

      {/* Calendar grid */}
      <div
        style={{
          background: '#FFFFFF',
          border: '1px solid #E5E5E5',
          borderRadius: 12,
          padding: 8,
          overflow: 'hidden',
        }}
      >
        {/* Weekday header */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
          {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((label, i) => (
            <div
              key={i}
              style={{
                textAlign: 'center',
                padding: '4px 0',
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: '0.16em',
                color: '#0A0A0A',
                opacity: (i === 5 || i === 6) ? 0.5 : 0.7,
                background: (i === 5 || i === 6) ? '#FAF5EE' : 'transparent',
                borderRadius: 4,
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Day cells */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
          {Array.from({ length: padBefore }).map((_, i) => (
            <div key={`pad-${i}`} />
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => i + 1).map(day => {
            const r = byDay.get(day);
            const dt = new Date(year, monthIdx, day);
            const dow = dt.getDay();
            const isWeekend = dow === 5 || dow === 6;
            const isToday = todayDay === day;
            const isFuture = dt > today && !isToday;
            const meta = r ? statusMeta(r.status, r.notes) : null;
            // Missed-punch flag — shows on the cell as a small magenta
            // dot and in the hover tooltip. Same convention as the
            // Monthly Overview calendar.
            const hasFirstP = r ? !!r.first_punch : false;
            const hasLastP  = r ? !!r.last_punch : false;
            const missedPunch = r && ((hasFirstP && !hasLastP) || (!hasFirstP && hasLastP));
            const missedKind = missedPunch
              ? (hasFirstP ? 'No clock-out recorded' : 'No clock-in recorded')
              : null;
            // Tooltip — full detail for hover
            const tipParts = [];
            tipParts.push(dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }));
            if (r) {
              tipParts.push(meta.label);
              // Permission-coverage callout — use the meta.label
              // we set above and add a "✓ Covered by..." line so
              // the hover tooltip echoes the same blue-tick story
              // shown on the cell chip.
              const isLP = meta.icon === '✓LP';
              const isEP = meta.icon === '✓EP';
              if (isLP) tipParts.push('✓ Late arrival covered by approved permission');
              if (isEP) tipParts.push('✓ Early leave covered by approved permission');
              if (missedKind) tipParts.push('⚠ ' + missedKind);
              if (r.status === 'late' && r.late_minutes != null && r.late_minutes > 0)
                tipParts.push(`${r.late_minutes} min late`);
              else if (r.status === 'short' && r.early_leave_minutes != null && r.early_leave_minutes > 0)
                tipParts.push(`${r.early_leave_minutes} min early out`);
              if (r.first_punch || r.last_punch)
                tipParts.push(`${trimTime(r.first_punch) || '—'} → ${trimTime(r.last_punch) || '—'}`);
              if (r.notes) tipParts.push(r.notes);
            }
            return (
              <div
                key={day}
                title={tipParts.join('\n')}
                style={{
                  position: 'relative',
                  background: r
                    ? meta.bg
                    : isToday
                      ? 'rgba(15,76,42,0.04)'
                      : isWeekend ? '#FAF5EE' : '#FFFFFF',
                  border: '1px solid ' + (
                    isToday ? '#0F4C2A' : (r ? meta.border : '#F0F0F0')
                  ),
                  borderRadius: 8,
                  minHeight: 60,
                  padding: 5,
                  fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
                  cursor: r ? 'help' : 'default',
                  opacity: isFuture ? 0.4 : 1,
                  display: 'flex',
                  flexDirection: 'column',
                  transition: 'transform 0.15s ease',
                }}
                onMouseEnter={(e) => { if (r) e.currentTarget.style.transform = 'scale(1.04)'; }}
                onMouseLeave={(e) => { if (r) e.currentTarget.style.transform = 'scale(1)'; }}
              >
                {/* Day number — top-right */}
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: isToday ? 800 : 600,
                    color: r ? meta.fg : (isToday ? '#0F4C2A' : '#1F1B16'),
                    textAlign: 'right',
                    lineHeight: 1,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {day}
                </div>

                {r && (
                  <>
                    {/* Missed-punch dot — top-left corner of the cell.
                        Magenta to stand out against any status palette. */}
                    {missedPunch && (
                      <span
                        aria-hidden
                        title={missedKind}
                        style={{
                          position: 'absolute',
                          top: 4,
                          left: 4,
                          width: 8,
                          height: 8,
                          borderRadius: 999,
                          background: '#C026D3',
                          boxShadow: '0 0 0 2px #FFFFFF',
                          zIndex: 1,
                        }}
                      />
                    )}
                    {/* Status chip — middle */}
                    <div
                      style={{
                        flex: 1,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginTop: 2,
                      }}
                    >
                      <div
                        style={{
                          background: '#FFFFFF',
                          color: meta.fg,
                          border: `1px solid ${meta.border}`,
                          borderRadius: 4,
                          fontSize: 10,
                          fontWeight: 700,
                          padding: '1px 4px',
                          letterSpacing: '0.04em',
                          minWidth: 18,
                          textAlign: 'center',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {meta.icon}
                      </div>
                    </div>

                    {/* Tiny punch summary — bottom. Always show
                        whichever punch is available (even just one),
                        and mark the missing one with a dash so the
                        hole is visible at a glance. */}
                    {(r.first_punch || r.last_punch) && (
                      <div
                        style={{
                          fontSize: 8.5,
                          color: meta.fg,
                          opacity: 0.85,
                          textAlign: 'center',
                          fontVariantNumeric: 'tabular-nums',
                          lineHeight: 1.15,
                          marginTop: 2,
                          fontWeight: 600,
                        }}
                      >
                        {r.first_punch ? trimTime(r.first_punch) : (
                          <span style={{ color: '#C026D3' }}>—:—</span>
                        )}
                        <br/>
                        <span style={{ opacity: r.last_punch ? 0.6 : 1, color: r.last_punch ? meta.fg : '#C026D3' }}>
                          {r.last_punch ? trimTime(r.last_punch) : '—:—'}
                        </span>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── LeaveTab ────────────────────────────────────────────────────────
function LeaveTab({ loading, rows, leaveTypeName }) {
  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-sm" style={{ color: '#0A0A0A', opacity: 0.6 }}>
        <Loader2 className="w-4 h-4 animate-spin" /> Loading leave…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div
        className="rounded-xl p-5 text-center"
        style={{ background: '#FFFFFF', border: '1px dashed #E5E5E5', color: '#0A0A0A', opacity: 0.6 }}
      >
        <CalIcon className="w-6 h-6 mx-auto mb-2" />
        <div className="text-sm">No leave records in this range.</div>
      </div>
    );
  }

  // Compute total leave days (sum of inclusive-day counts per row)
  const totalDays = rows.reduce((sum, r) => {
    const s = new Date(r.start_date + 'T00:00:00');
    const e = new Date(r.end_date   + 'T00:00:00');
    const days = Math.floor((e - s) / 86400000) + 1;
    return sum + (days > 0 ? days : 1);
  }, 0);

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 mb-4">
        <div
          style={{
            background: '#FFFFFF', border: '1.5px solid #5EEAD4', borderRadius: 12,
            padding: '10px 8px', textAlign: 'center',
            animation: 'detail-fade-in 0.5s ease-out 0ms both',
          }}
        >
          <div style={{ fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif', fontSize: 24, color: '#115E59', fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {rows.length}
          </div>
          <div className="text-[10px] mt-1" style={{ color: '#0A0A0A', opacity: 0.7, fontWeight: 600, letterSpacing: '0.08em' }}>
            REQUESTS
          </div>
        </div>
        <div
          style={{
            background: '#FFFFFF', border: '1.5px solid #5EEAD4', borderRadius: 12,
            padding: '10px 8px', textAlign: 'center',
            animation: 'detail-fade-in 0.5s ease-out 50ms both',
          }}
        >
          <div style={{ fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif', fontSize: 24, color: '#115E59', fontWeight: 700, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
            {totalDays}
          </div>
          <div className="text-[10px] mt-1" style={{ color: '#0A0A0A', opacity: 0.7, fontWeight: 600, letterSpacing: '0.08em' }}>
            TOTAL DAYS
          </div>
        </div>
      </div>

      <div style={{ background: '#FFFFFF', border: '1px solid #E5E5E5', borderRadius: 10, overflow: 'hidden' }}>
        {rows.map((r, ri) => {
          const isApproved = r.status === 'approved';
          const isDeclined = r.status === 'rejected' || r.status === 'declined';
          const tone = isApproved ? '#0F4C2A' : isDeclined ? '#991B1B' : '#854F0B';
          const toneBg = isApproved ? '#ECFDF5' : isDeclined ? '#FEF2F2' : '#FEF3C7';
          return (
            <div
              key={r.id}
              style={{
                padding: '10px 12px',
                borderTop: ri === 0 ? 'none' : '1px solid #F0F0F0',
                animation: `detail-row-in 0.32s ease-out ${Math.min(ri * 30, 240)}ms both`,
              }}
            >
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <div className="text-[12px]" style={{ color: '#1F1B16', fontWeight: 700 }}>
                  {leaveTypeName(r.leave_type_id)}
                </div>
                <span style={{
                  background: toneBg, color: tone, fontSize: 10,
                  padding: '1px 8px', borderRadius: 999, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                }}>
                  {r.status}
                </span>
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.75 }}>
                {fmtRangeShort(r.start_date)} {r.start_date !== r.end_date ? `\u2192 ${fmtRangeShort(r.end_date)}` : ''}
              </div>
              {r.reason && (
                <div
                  className="text-[11px] mt-1"
                  style={{ color: '#0A0A0A', opacity: 0.7, fontStyle: 'italic' }}
                >
                  &ldquo;{r.reason}&rdquo;
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// HTML EXPORT
// ═══════════════════════════════════════════════════════════════════════

const REPORT_STYLES = `
:root {
  --green:      #0F4C2A;
  --green-soft: #E8F5E9;
  --green-mid:  #BBDEC0;
  --cream:      #FAFAF6;
  --beige:      #E5E5E5;
  --ink:        #0A0A0A;
  --ink-mute:   #555555;
  --rule:       #F0F0F0;
}
* { box-sizing: border-box; }
html, body {
  margin: 0; padding: 0;
  background: #F0F0F0;
  color: var(--ink);
  /* Calibri throughout — matches what's on screen so the PDF/print
     output looks like a continuation of the in-app panel rather
     than a separate document. */
  font-family: Calibri, 'Segoe UI', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  font-size: 11px; line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

/* A4 page sizing — each .page renders at the size of one A4 sheet
   in portrait. On screen they're displayed as a stack of "sheets"
   with a small grey gutter between, mimicking what print preview
   shows. When printing, @page rules + page-break boundaries put
   each .page on its own physical sheet so layouts look identical
   on screen and on paper. */
@page {
  size: A4;
  margin: 12mm 14mm;
}
.page {
  width: 210mm;
  min-height: 297mm;
  margin: 12px auto;
  padding: 14mm 16mm;
  background: #FFFFFF;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  page-break-after: always;
}
.page:last-of-type { page-break-after: auto; margin-bottom: 0; }
header.report-header {
  border-bottom: 2px solid var(--green);
  padding-bottom: 10px;
  margin-bottom: 14px;
}
.kicker {
  font-size: 9px; letter-spacing: 0.24em;
  color: var(--green); font-weight: 700;
  text-transform: uppercase; margin-bottom: 4px;
}
h1 {
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 19px; line-height: 1.15;
  margin: 0 0 3px; font-weight: 700; color: var(--ink);
  letter-spacing: -0.005em;
}
.sub { color: var(--ink-mute); font-size: 11px; }
.meta {
  display: flex; gap: 14px; flex-wrap: wrap;
  margin-top: 8px; font-size: 10px; color: var(--ink-mute);
}
.meta strong { color: var(--ink); }
.summary {
  display: grid; grid-template-columns: repeat(4, 1fr);
  gap: 6px; margin-bottom: 6px;
}
/* TILES — palette-driven so the printed report inherits the same
   visual language Bashaier sees on screen. Each tile gets one of
   the .tile.* color classes; the base .tile rule sets layout, the
   modifier rules set bg / fg / border. Print-color-adjust forces
   browsers to keep the colors in printed output (most default to
   stripping backgrounds when printing). */
.tile {
  border-radius: 6px; padding: 6px 7px 5px;
  border: 1px solid var(--rule);
  background: var(--cream);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.tile .v {
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 17px; font-weight: 700;
  color: inherit; line-height: 1; font-variant-numeric: tabular-nums;
}
.tile .l {
  font-size: 8.5px; letter-spacing: 0.1em;
  font-weight: 700; text-transform: uppercase;
  margin-top: 3px; opacity: 0.85;
  line-height: 1.15;
}
.tile .s {
  font-size: 9px;
  margin-top: 1px;
  font-weight: 500;
  opacity: 0.75;
  font-variant-numeric: tabular-nums;
}
/* Color modifiers — matched to the on-screen palettes */
.tile.t-present     { background: #ECFDF5; color: #0F4C2A; border-color: #A7F3D0; }
.tile.t-late        { background: #FEF3C7; color: #854F0B; border-color: #FCD34D; }
.tile.t-short       { background: #FED7AA; color: #7C2D12; border-color: #FB923C; }
.tile.t-absent      { background: #FEE2E2; color: #991B1B; border-color: #FCA5A5; }
.tile.t-missin      { background: #FCE7F3; color: #86198F; border-color: #F0ABFC; }
.tile.t-missout     { background: #E0E7FF; color: #3730A3; border-color: #A5B4FC; }
.tile.t-annual      { background: #CCFBF1; color: #115E59; border-color: #5EEAD4; }
.tile.t-sick        { background: #EDE9FE; color: #5B21B6; border-color: #C4B5FD; }
.tile.t-emergency   { background: #FEE2E2; color: #991B1B; border-color: #FCA5A5; }
.tile.t-unpaid      { background: #F5F5F5; color: #525252; border-color: #A3A3A3; }
.tile.t-maternity   { background: #FCE7F3; color: #9D174D; border-color: #F9A8D4; }
.tile.t-paternity   { background: #DBEAFE; color: #1E3A8A; border-color: #93C5FD; }
.tile.t-hajj        { background: #FEF3C7; color: #854F0B; border-color: #FCD34D; }
.tile.t-compassion  { background: #E0E7FF; color: #3730A3; border-color: #A5B4FC; }
/* Muted variant — for zero-value tiles when shown for layout
   symmetry. Slightly desaturated against the base background. */
.tile.muted {
  background: #FAFAF6 !important;
  color: #737373 !important;
  border-color: #E5E5E5 !important;
}
.summary + .summary { margin-top: 0; }
h2.section-h2 {
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 11px; font-weight: 700;
  color: var(--ink); margin: 10px 0 4px; padding-bottom: 3px;
  border-bottom: 1px solid var(--rule);
  letter-spacing: 0.08em; text-transform: uppercase;
}
section.month {
  margin-bottom: 10px;
  break-inside: avoid;
  page-break-inside: avoid;
}
section.month h2 {
  font-family: Calibri, 'Segoe UI', sans-serif;
  font-size: 13px; font-weight: 700;
  color: var(--ink); margin: 0 0 4px;
  letter-spacing: -0.005em;
}
section.month h2 .count {
  font-weight: 400; font-size: 10px; color: var(--ink-mute);
  margin-left: 6px;
}
table {
  width: 100%; border-collapse: collapse;
  background: #FFFFFF; border: 1px solid var(--rule);
  border-radius: 6px; overflow: hidden;
  table-layout: fixed;
}
thead th {
  background: var(--green-soft); color: var(--green);
  font-size: 9px; letter-spacing: 0.1em; text-transform: uppercase;
  text-align: left; padding: 4px 7px; font-weight: 700;
  border-bottom: 1px solid var(--green-mid);
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
tbody td {
  padding: 3px 7px; font-size: 10px; border-top: 1px solid var(--rule);
  vertical-align: top;
  line-height: 1.3;
}
tbody tr:first-child td { border-top: none; }
.chip {
  display: inline-block;
  padding: 0 6px; border-radius: 999px;
  font-size: 9px; font-weight: 700;
  letter-spacing: 0.04em;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.chip.present      { background: #ECFDF5; color: #0F4C2A; border: 1px solid #A7F3D0; }
.chip.late         { background: #FEF3C7; color: #854F0B; border: 1px solid #FCD34D; }
.chip.short        { background: #FED7AA; color: #7C2D12; border: 1px solid #FB923C; }
.chip.absent       { background: #FEE2E2; color: #991B1B; border: 1px solid #FCA5A5; }
.chip.annual_leave { background: #CCFBF1; color: #115E59; border: 1px solid #5EEAD4; }
.chip.sick_leave   { background: #EDE9FE; color: #5B21B6; border: 1px solid #C4B5FD; }
.chip.off_roster   { background: #DBEAFE; color: #1E3A8A; border: 1px solid #93C5FD; }
.chip.off_day      { background: #EEF0FA; color: #3B4279; border: 1px solid #C7CFE5; }
.chip.approved     { background: #ECFDF5; color: #0F4C2A; border: 1px solid #A7F3D0; }
.chip.pending      { background: #FEF3C7; color: #854F0B; border: 1px solid #FCD34D; }
.chip.rejected,
.chip.declined     { background: #FEE2E2; color: #991B1B; border: 1px solid #FCA5A5; }
footer.report-footer {
  margin-top: 14px; padding-top: 8px;
  border-top: 1px solid var(--rule);
  font-size: 9px; color: var(--ink-mute);
  display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap;
}
.page-num {
  font-variant-numeric: tabular-nums;
}
@media print {
  html, body { background: #FFFFFF; }
  .page {
    margin: 0;
    box-shadow: none;
    width: auto;
    min-height: auto;
    padding: 0;
  }
  .no-print { display: none !important; }
}
`;

function statusLabelFor(s) {
  return statusMeta(s).label;
}

function exportAttendanceHtml(employee, range, monthly, summary, leaveRows, leaveTypeName) {
  const counts = summary || {};
  const totalRecords = Object.values(counts).reduce((a, b) => a + b, 0);

  // Tile renderer with optional sub-line for context (e.g. total
  // minutes under a Late count, or "3 requests" under a leave-type
  // tile). Sub is rendered inline below the value so the printed
  // report carries the same magnitude information as the on-screen
  // panel.
  // Colored tile renderer. `tone` is the modifier suffix that maps to
  // a .tile.t-* class in REPORT_STYLES; `muted` adds the .muted
  // override for zero-value cells. Mirrors the SummaryTile component
  // on screen so the printed report carries the same visual language.
  const tile = (count, label, sub, tone, muted) => `
    <div class="tile t-${tone}${muted ? ' muted' : ''}">
      <div class="v">${count}</div>
      <div class="l">${esc(label)}</div>
      ${sub ? `<div class="s">${esc(sub)}</div>` : ''}
    </div>
  `;

  // Tone for each leave type — same code-pattern matching as the
  // on-screen leaveMetaFor() helper, here just translated to a CSS
  // class suffix.
  const leaveTone = (entry) => {
    const k = String(entry?.code || entry?.name || '').toUpperCase();
    if (/SICK/.test(k))             return 'sick';
    if (/EMERG/.test(k))            return 'emergency';
    if (/UNPAID/.test(k))           return 'unpaid';
    if (/MATERNIT/.test(k))         return 'maternity';
    if (/PATERNIT/.test(k))         return 'paternity';
    if (/HAJJ/.test(k))             return 'hajj';
    if (/COMPASS|BEREAVE/.test(k))  return 'compassion';
    return 'annual';
  };

  const lateMins  = summary?.totalLateMinutes  || 0;
  const earlyMins = summary?.totalEarlyMinutes || 0;
  const missedIn  = summary?.missedInCount     || 0;
  const missedOut = summary?.missedOutCount    || 0;

  // Attendance row — three primary tiles always render. Zero-value
  // tiles use the muted variant for layout symmetry, matching the
  // on-screen treatment.
  const attendanceTilesHtml = `
    <div class="summary" style="grid-template-columns: repeat(3, 1fr);">
      ${tile(counts.present || 0, 'Present',    null,                                            'present',  (counts.present || 0) === 0)}
      ${tile(counts.late    || 0, 'Late',       lateMins  > 0 ? `${lateMins} min total`  : null, 'late',     (counts.late    || 0) === 0)}
      ${tile(counts.short   || 0, 'Left early', earlyMins > 0 ? `${earlyMins} min total` : null, 'short',    (counts.short   || 0) === 0)}
    </div>
    <div class="summary" style="grid-template-columns: repeat(3, 1fr);">
      ${tile(counts.absent  || 0, 'Absent',       null, 'absent',  (counts.absent || 0) === 0)}
      ${tile(missedIn,            'No clock-in',  null, 'missin',  missedIn === 0)}
      ${tile(missedOut,           'No clock-out', null, 'missout', missedOut === 0)}
    </div>
  `;

  // Leave breakdown — always show the canonical 8 types so every
  // report has the same shape. Used types from summary.leaveByType
  // win when matched; unused types render as 0/muted.
  const FALLBACK_LEAVE_TYPES = [
    { code: 'ANNUAL',        name: 'Annual leave' },
    { code: 'SICK',          name: 'Sick leave' },
    { code: 'EMERGENCY',     name: 'Emergency leave' },
    { code: 'UNPAID',        name: 'Unpaid leave' },
    { code: 'MATERNITY',     name: 'Maternity leave' },
    { code: 'PATERNITY',     name: 'Paternity leave' },
    { code: 'HAJJ',          name: 'Hajj leave' },
    { code: 'COMPASSIONATE', name: 'Compassionate leave' },
  ];
  const usedByCode = new Map();
  if (summary?.leaveByType) {
    for (const entry of summary.leaveByType.values()) {
      const k = String(entry.code || entry.name || '').toUpperCase();
      usedByCode.set(k, entry);
    }
  }
  const leaveTilesList = FALLBACK_LEAVE_TYPES.map(fb => {
    const fbKey = fb.code.toUpperCase();
    let used = null;
    for (const [k, v] of usedByCode) {
      if (k.includes(fbKey) || fbKey.includes(k)) { used = v; break; }
    }
    return used
      ? { ...used, _fallback: false }
      : { id: `fb-${fb.code}`, name: fb.name, code: fb.code, days: 0, requests: 0, _fallback: true };
  });
  const leaveTilesHtml = `
    <h2 class="section-h2">Leave breakdown</h2>
    <div class="summary" style="grid-template-columns: repeat(4, 1fr);">
      ${leaveTilesList.map(entry =>
        tile(
          entry.days,
          entry.name,
          entry.requests > 0 ? `${entry.requests} request${entry.requests === 1 ? '' : 's'}` : null,
          leaveTone(entry),
          entry.days === 0
        )
      ).join('')}
    </div>
  `;

  // Combined summary block — used on page 1 only (continuation pages
  // skip the summary to maximize their row capacity).
  const summaryTiles = attendanceTilesHtml + leaveTilesHtml;

  // ─── Pagination ─────────────────────────────────────────────────
  // Each .page renders at A4 size. Page 1 holds the header + summary
  // tiles + as many month sections as fit. Continuation pages hold
  // additional months. We pack month sections into pages by their
  // approximate row count so each page is full but never overflows.
  //
  // Estimated rows-per-A4-page after the header / summary block:
  //   • Page 1 (with summary header + 6 attendance tiles + 8 leave
  //     tiles + monthly heading) — about 22 attendance rows fit
  //   • Continuation pages — about 50 rows fit
  //
  // Each "month" section is treated as atomic (page-break-inside:
  // avoid), so a month with many rows just gets its own page even
  // if it's not full — better than splitting a calendar month
  // across two pages.

  const PAGE1_CAPACITY  = 22;
  const PAGEN_CAPACITY  = 50;

  const monthSections = monthly.map(g => ({
    g,
    rowCount: g.rows.length,
  }));

  // Re-serialize per month — we need them as individual strings, not
  // one big concatenation, to distribute across pages.
  const renderMonth = (g) => {
    const rowsHtml = g.rows.map(r => {
      const hasFirst = !!r.first_punch;
      const hasLast  = !!r.last_punch;
      const isMissedIn  = !hasFirst && hasLast;
      const isMissedOut = hasFirst && !hasLast;
      const detail = isMissedIn
        ? '<strong style="color:#86198F">⚠ No clock-in recorded</strong>'
        : isMissedOut
          ? '<strong style="color:#3730A3">⚠ No clock-out recorded</strong>'
          : r.status === 'late' && r.late_minutes > 0
            ? `${r.late_minutes} min late`
            : r.status === 'short' && r.early_leave_minutes > 0
              ? `${r.early_leave_minutes} min early out`
              : r.status === 'absent'
                ? 'No punches recorded'
                : '—';
      const punch = (hasFirst || hasLast)
        ? `${hasFirst ? trimTime(r.first_punch) : '<span style="color:#C026D3">—:—</span>'} → ${hasLast ? trimTime(r.last_punch) : '<span style="color:#C026D3">—:—</span>'}`
        : '—';
      const sched = (r.expected_start || r.expected_end)
        ? `${trimTime(r.expected_start) || '?'}–${trimTime(r.expected_end) || '?'}`
        : '—';
      return `
        <tr>
          <td>${esc(fmtDate(r.attendance_date))}</td>
          <td><span class="chip ${esc(r.status)}">${esc(statusLabelFor(r.status))}</span></td>
          <td>${punch}</td>
          <td>${esc(sched)}</td>
          <td>${detail}</td>
        </tr>
      `;
    }).join('');
    return `
      <section class="month">
        <h2>${esc(MONTH_NAMES[g.month])} ${g.year}<span class="count">${g.rows.length} record${g.rows.length === 1 ? '' : 's'}</span></h2>
        <table>
          <thead>
            <tr>
              <th style="width:24%">Date</th>
              <th style="width:14%">Status</th>
              <th style="width:18%">Punches</th>
              <th style="width:18%">Schedule</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </section>
    `;
  };

  // Pack months into pages by row capacity
  const pages = [];
  let currentPage = { months: [], used: 0 };
  let capacity = PAGE1_CAPACITY;
  for (const sec of monthSections) {
    // If adding this month would overflow AND the page already has
    // something, start a new page. Single oversized months still get
    // their own page (better than dropping them).
    if (currentPage.months.length > 0 && currentPage.used + sec.rowCount > capacity) {
      pages.push(currentPage);
      currentPage = { months: [], used: 0 };
      capacity = PAGEN_CAPACITY;
    }
    currentPage.months.push(sec.g);
    currentPage.used += sec.rowCount;
  }
  if (currentPage.months.length > 0) pages.push(currentPage);
  if (pages.length === 0) pages.push({ months: [], used: 0 });

  const totalPages = pages.length;
  const headerHtml = `
    <header class="report-header">
      <div class="kicker">Staff attendance report</div>
      <h1>${esc(employee.name || employee.id)}</h1>
      <div class="sub">${esc(employee.id)}${employee.department ? ' · ' + esc(employee.department) : ''}${employee.location ? ' · ' + esc(employee.location) : ''}</div>
      <div class="meta">
        <span><strong>Range:</strong> ${esc(fmtRangeShort(range.from))} – ${esc(fmtRangeShort(range.to))}</span>
        <span><strong>Records:</strong> ${totalRecords}</span>
        <span><strong>Generated:</strong> ${esc(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>
      </div>
    </header>
  `;
  const continuationHeaderHtml = `
    <header class="report-header">
      <div class="kicker">${esc(employee.name || employee.id)} · ${esc(employee.id)} · ${esc(fmtRangeShort(range.from))} – ${esc(fmtRangeShort(range.to))}</div>
    </header>
  `;
  const footerHtml = (n) => `
    <footer class="report-footer">
      <span>Generated by ESAU HR Portal</span>
      <span class="page-num">Page ${n} of ${totalPages}</span>
    </footer>
  `;

  const pagesHtml = pages.map((p, idx) => {
    const isFirst = idx === 0;
    const monthsHtml = p.months.length > 0
      ? p.months.map(renderMonth).join('')
      : (isFirst ? '<p style="color:var(--ink-mute);">No attendance records in this range.</p>' : '');
    return `
      <div class="page">
        ${isFirst ? headerHtml : continuationHeaderHtml}
        ${isFirst ? summaryTiles : ''}
        ${monthsHtml}
        ${footerHtml(idx + 1)}
      </div>
    `;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Attendance Report — ${esc(employee.name || employee.id)}</title>
<style>${REPORT_STYLES}</style>
</head>
<body>
${pagesHtml}
  <script>setTimeout(() => window.print(), 600);</script>
</body>
</html>`;

  openHtml(html, `attendance_${(employee.id || 'staff').toLowerCase()}.html`);
}

function exportLeaveHtml(employee, range, leaveRows, leaveTypeName) {
  const totalDays = leaveRows.reduce((sum, r) => {
    const s = new Date(r.start_date + 'T00:00:00');
    const e = new Date(r.end_date   + 'T00:00:00');
    const days = Math.floor((e - s) / 86400000) + 1;
    return sum + (days > 0 ? days : 1);
  }, 0);

  const rowsHtml = leaveRows.map(r => `
    <tr>
      <td>${esc(leaveTypeName(r.leave_type_id))}</td>
      <td>${esc(fmtRangeShort(r.start_date))}${r.start_date !== r.end_date ? ' → ' + esc(fmtRangeShort(r.end_date)) : ''}</td>
      <td><span class="chip ${esc(r.status)}">${esc(r.status)}</span></td>
      <td>${esc(r.reason || '—')}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Leave Report — ${esc(employee.name || employee.id)}</title>
<style>${REPORT_STYLES}</style>
</head>
<body>
  <div class="page">
    <header class="report-header">
      <div class="kicker">Staff leave report</div>
      <h1>${esc(employee.name || employee.id)}</h1>
      <div class="sub">${esc(employee.id)}${employee.department ? ' · ' + esc(employee.department) : ''}</div>
      <div class="meta">
        <span><strong>Range:</strong> ${esc(fmtRangeShort(range.from))} – ${esc(fmtRangeShort(range.to))}</span>
        <span><strong>Requests:</strong> ${leaveRows.length}</span>
        <span><strong>Total days:</strong> ${totalDays}</span>
        <span><strong>Generated:</strong> ${esc(new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>
      </div>
    </header>

    ${leaveRows.length === 0 ? '<p style="color:var(--ink-mute);">No leave records in this range.</p>' : `
      <table>
        <thead>
          <tr>
            <th style="width:22%">Type</th>
            <th style="width:30%">Period</th>
            <th style="width:14%">Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `}

    <footer class="report-footer">
      <span>Generated by ESAU HR Portal</span>
      <span>Confidential — for internal use</span>
    </footer>
  </div>
  <script>setTimeout(() => window.print(), 600);</script>
</body>
</html>`;

  openHtml(html, `leave_${(employee.id || 'staff').toLowerCase()}.html`);
}

function openHtml(html, filename) {
  // Render the report in a new tab. The previous implementation used
  // document.write() which has been deprecated and is now blocked by
  // some browsers' Trusted Types / sandbox rules — that was the cause
  // of the "Export HTML button does nothing" report.
  //
  // Strategy now:
  //   1. Build a Blob URL (text/html). Always works, no popup-blocker
  //      heuristic ambiguity, no document.write edge cases.
  //   2. Try to open it in a new tab via window.open with the URL.
  //      If the popup-blocker allows, the browser navigates the new
  //      tab to the HTML directly — same result as before, more
  //      reliable.
  //   3. If window.open returns null (popup blocker), fall through
  //      to a hidden anchor's `download` attribute so the user gets
  //      the report as a saved file instead of silent failure.
  try {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);

    // Try popup. Pop-up blockers usually return null (no exception).
    const w = window.open(url, '_blank');
    if (w) {
      // Set a friendly title once the document is ready. If we can't
      // touch the new doc (cross-origin sandbox quirk), this just
      // throws and the URL remains valid — the file viewer will use
      // its own default title.
      try {
        w.addEventListener('load', () => {
          try { w.document.title = filename.replace(/\.html$/, ''); } catch {}
        });
      } catch {}
      // Revoke the URL after the new tab has had time to load. Doing
      // it too early kills the page; too late leaks memory. 30s is a
      // safe middle ground given typical report sizes.
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 30000);
      return;
    }

    // Pop-up blocked — fall back to download
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { URL.revokeObjectURL(url); } catch {}
      try { a.remove(); } catch {}
    }, 0);
    // Tell the user explicitly so they don't think it failed —
    // this branch is rare but the download might land in the
    // browser's downloads folder without an obvious notification.
    try {
      // eslint-disable-next-line no-alert
      alert('Pop-ups are blocked, so the report was downloaded as a file instead. Open it from your downloads folder.');
    } catch {}
  } catch (err) {
    // Surface any unexpected error so it doesn't silently disappear.
    // Console for the developer, alert for the user.
    // eslint-disable-next-line no-console
    console.error('Failed to open HTML report:', err);
    try {
      // eslint-disable-next-line no-alert
      alert('Could not open the report: ' + (err?.message || err));
    } catch {}
  }
}
