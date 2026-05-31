// =============================================================================
// AttendanceMonthGrid.jsx
//
// Monthly calendar view of recorded attendance. Reads from
// attendance_daily and renders a per-employee row of status-coded
// chips, one column per calendar day.
//
// Visual language matches ShiftMonthGrid (the manager's shift
// calendar) so Bashaier sees the same row/column structure she
// already knows from that view, just in a different domain.
//
// STATUS PALETTE
//   present       → green chip with first/last punch times
//   late          → amber chip with "+Nm late" + punch times
//   short         → orange chip with "−Nm" + punch times
//   absent        → red empty chip
//   annual_leave  → teal chip with "AL"
//   sick_leave    → purple chip with "SL"
//   off_roster    → navy chip with "OFF·R" (worked outside roster)
//   off_day       → light navy "OFF" (deliberate off-day, no work)
//   no record yet → blank cell
//   weekend       → beige tint (KSA Fri/Sat) when no record
//   future        → tinted gray (date hasn't happened yet)
//
// Hover any cell with data → richer tooltip rendered as a fixed-
// position panel above the cell, showing employee name, full date,
// status, punch times, schedule (if any), and computed late/early
// minutes.
//
// LIVE UPDATES
//   Subscribes to attendance_daily realtime changes — Bashaier
//   uploading a fresh file mid-view propagates new rows into the
//   grid immediately.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, RefreshCcw, Loader2, Search, X, Download, AlertTriangle } from 'lucide-react';
import { directGet, directPatch, supabase } from '../supabaseClient.js';

// Auto-fit text helper — CSS-only. No hooks. Uses container queries
// + clamp on font-size based on text length to shrink long names so
// they fit on a single line without ellipsis truncation. Conservative
// floor at 9px so it stays legible.
function FitText({ text, style = {}, className }) {
  const length = (text || '').length;
  // Heuristic font size: longer names get smaller font.
  // 200px column ≈ ~22 chars at 11px, ~30 chars at 9px.
  const fontSize =
    length <= 16 ? 12 :
    length <= 20 ? 11 :
    length <= 24 ? 10 :
    length <= 28 ? 9.5 : 9;
  return (
    <div
      className={className}
      style={{
        ...style,
        fontSize,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
      title={text}
    >
      {text}
    </div>
  );
}

// Local YYYY-MM-DD without timezone surprises.
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayYmd() { return ymd(new Date()); }
// 'YYYY-MM-DD' → 'DD/MM' for compact anomaly listing
function fmtShort(s) { const p = String(s).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}` : s; }

// ─── Status → visual style mapping ───────────────────────────────────
// Each entry returns the chip style + a 2-3 char label. Returning
// inline lets the cell renderer keep one switch and stay readable.
//
// A second optional parameter (notes) lets us distinguish present
// rows that were originally late or early but downgraded to present
// because an approved permission covered the punch. Per Nadeem
// (2026-05-06): on the monthly grid, those should look distinct
// from "naturally on time" so HR can tell at a glance which days
// were permission-covered. We detect via the note text the backfill
// stamps when applying coverage ("late arrival covered by..." /
// "early leave covered by...").
function styleForStatus(status, notes) {
  if (status === 'present' && typeof notes === 'string') {
    if (/late arrival covered by approved permission/i.test(notes)) {
      return { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '✓LP' };
    }
    if (/early leave covered by approved permission/i.test(notes)) {
      return { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '✓EP' };
    }
  }
  switch (status) {
    case 'present':
      return { bg: '#ECFDF5', fg: '#0F4C2A', border: '#A7F3D0', label: '✓' };
    case 'late':
      return { bg: '#FEF3C7', fg: '#854F0B', border: '#FCD34D', label: 'LT' };
    case 'short':
      return { bg: '#FED7AA', fg: '#7C2D12', border: '#FB923C', label: 'SH' };
    case 'absent':
      return { bg: '#FEE2E2', fg: '#991B1B', border: '#FCA5A5', label: 'AB' };
    case 'annual_leave':
      return { bg: '#CCFBF1', fg: '#115E59', border: '#5EEAD4', label: 'AL' };
    case 'sick_leave':
      return { bg: '#EDE9FE', fg: '#5B21B6', border: '#C4B5FD', label: 'SL' };
    case 'maternity_leave':
      return { bg: '#FCE7F3', fg: '#9D174D', border: '#F9A8D4', label: '✓ML' };
    case 'paternity_leave':
      return { bg: '#E0F2FE', fg: '#075985', border: '#7DD3FC', label: '✓PL' };
    case 'hajj_leave':
      return { bg: '#FEF3C7', fg: '#854F0B', border: '#FCD34D', label: '✓HJ' };
    case 'emergency_leave':
      return { bg: '#FEE2E2', fg: '#7F1D1D', border: '#FCA5A5', label: '✓EL' };
    case 'unpaid_leave':
      return { bg: '#F3F4F6', fg: '#374151', border: '#D1D5DB', label: '✓UL' };
    case 'off_roster':
      return { bg: '#DBEAFE', fg: '#1E3A8A', border: '#93C5FD', label: 'OR' };
    case 'off_day':
      return { bg: '#EEF0FA', fg: '#3B4279', border: '#C7CFE5', label: 'OF' };
    default:
      return { bg: '#F5F5F5', fg: '#525252', border: '#D4D4D4', label: '?' };
  }
}

function readableStatus(status) {
  return ({
    present: 'Present',
    late: 'Late',
    short: 'Short shift',
    absent: 'Absent',
    annual_leave: 'Annual leave',
    sick_leave: 'Sick leave',
    maternity_leave: 'Maternity leave',
    paternity_leave: 'Paternity leave',
    hajj_leave: 'Hajj leave',
    emergency_leave: 'Emergency leave',
    unpaid_leave: 'Unpaid leave',
    off_roster: 'Worked off-roster',
    off_day: 'Off-day',
  })[status] || status;
}

// Phase B + C: external refresh trigger.
//   • refreshTick — integer that bumps externally (from AttendanceView)
//     after a re-evaluation completes, so the grid refetches its rows
//     without the user having to navigate away and back. Per Decision
//     #3 / option A: single refetch at session end, no live updates
//     during the upload to avoid scroll/flicker.
export default function AttendanceMonthGrid({ employees, onEmployeeClick, refreshTick = 0 }) {
  const today = useMemo(() => new Date(), []);
  const [year, setYear]   = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [records, setRecords] = useState([]);
  const recordsRef = useRef([]);   // last-good records, for transient-error guard in refetch
  // Public / government holidays for the visible month (date -> name).
  // Used to tint those columns distinctly and to exclude them from the
  // "missing working days" coverage check. Nadeem 2026-05-31.
  const [holidayMap, setHolidayMap] = useState(() => new Map());
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'public_holidays',
          `select=date,name&date=gte.${ymd(firstDay)}&date=lte.${ymd(lastDay)}&order=date`,
          { timeoutMs: 8000 }
        );
        if (cancelled) return;
        const m = new Map();
        (Array.isArray(rows) ? rows : []).forEach(h => {
          if (h?.date) m.set(String(h.date).slice(0, 10), h.name || 'Public holiday');
        });
        setHolidayMap(m);
      } catch { /* non-fatal — table may be empty/absent */ }
    })();
    return () => { cancelled = true; };
  }, [firstDay, lastDay]);
  const [loading, setLoading] = useState(false);
  const [fetchErr, setFetchErr] = useState(null);   // surfaced on-screen
  const [lastCount, setLastCount] = useState(null);  // rows from last fetch
  const [hoverTip, setHoverTip] = useState(null);
  // Search filter — Bashaier types a name fragment / PSN / dept and
  // the grid narrows to matching staff. Empty string = no filter.
  // Match is case-insensitive, substring across name, id, department,
  // location, designation — whichever fields the employees row carries.
  const [search, setSearch] = useState('');

  const firstDay = useMemo(() => new Date(year, month, 1), [year, month]);
  const lastDay  = useMemo(() => new Date(year, month + 1, 0), [year, month]);
  const days = useMemo(() => {
    const arr = [];
    const total = lastDay.getDate();
    for (let d = 1; d <= total; d++) arr.push(new Date(year, month, d));
    return arr;
  }, [year, month, lastDay]);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      // PostgREST caps a single response at 1000 rows. A full month for
      // ~60 staff is ~1800 rows, so a single request silently returned
      // only the first 1000 (the earliest dates, since we order asc) —
      // which dropped the last third of the month off the grid entirely
      // (Nadeem 2026-05-31: 26–31 May showed empty while 1000 rows
      // loaded). Paginate with limit/offset until a short page comes
      // back. A stable secondary sort (employee_id) keeps offset paging
      // deterministic. select=* so a drifted column can't 400 the read.
      const PAGE = 1000;
      let all = [];
      let offset = 0;
      for (;;) {
        const page = await directGet(
          'attendance_daily',
          `select=*` +
          `&attendance_date=gte.${ymd(firstDay)}` +
          `&attendance_date=lte.${ymd(lastDay)}` +
          `&order=attendance_date.asc,employee_id.asc` +
          `&limit=${PAGE}&offset=${offset}`,
          { timeoutMs: 12000 }
        );
        const arr = Array.isArray(page) ? page : [];
        all = all.concat(arr);
        if (arr.length < PAGE) break;
        offset += PAGE;
        if (offset > 100000) break; // hard safety stop
      }
      setRecords(all);
      recordsRef.current = all;
      setLastCount(all.length);
      setFetchErr(null);
    } catch (e) {
      console.warn('attendance_daily fetch failed:', e);
      // A background refresh (realtime / re-eval tick) that errors out
      // must NOT wipe a good view — otherwise the coverage banner and
      // grid blank out for no reason. Keep the last-good data and stay
      // quiet; only surface the error on a true cold load. Nadeem.
      if (recordsRef.current && recordsRef.current.length) {
        // keep existing records, lastCount, no error banner
      } else {
        setRecords([]);
        setLastCount(null);
        setFetchErr(e?.message || String(e) || 'fetch failed');
      }
    } finally {
      setLoading(false);
    }
  }, [firstDay, lastDay]);
  useEffect(() => { recordsRef.current = []; }, [firstDay, lastDay]);
  useEffect(() => { refetch(); }, [refetch]);

  // External refresh — bumps when AttendanceView's re-evaluation
  // pipeline completes. Skips the initial mount (refetch above
  // already covers that) by gating on tick > 0.
  useEffect(() => {
    if (refreshTick > 0) refetch();
  }, [refreshTick, refetch]);

  // Debounced realtime — bursts of upserts during an upload settle
  // into a single refetch.
  const debounceRef = useRef(null);
  useEffect(() => {
    if (!supabase) return;
    const trigger = () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        refetch();
      }, 800);
    };
    const ch = supabase
      .channel('attendance-month-grid')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'attendance_daily' },
        () => trigger()
      )
      .subscribe();
    return () => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      try { supabase.removeChannel(ch); } catch {}
    };
  }, [refetch]);

  // Index records by (employee_id, date) for O(1) cell lookup.
  const recordIndex = useMemo(() => {
    const idx = new Map();
    records.forEach(r => idx.set(`${r.employee_id}|${r.attendance_date}`, r));
    return idx;
  }, [records]);

  // Diagnostic — how many loaded records' employee_id actually match a
  // directory employee id (the exact string the cell lookup uses), plus
  // a sample row. If matched=0 while records>0, the cells will all be
  // empty because the keys don't line up (e.g. PSN written without the
  // 'H' prefix). Surfaced in the status line. Nadeem 2026-05-31.
  const recordDiag = useMemo(() => {
    if (!records.length) return null;
    const ids = new Set((employees || []).map(e => String(e?.id)));
    let matched = 0;
    for (const r of records) if (ids.has(String(r.employee_id))) matched++;
    const s = records[0] || {};
    return {
      matched, total: records.length,
      sampleId: s.employee_id, sampleDate: s.attendance_date, sampleStatus: s.status,
    };
  }, [records, employees]);

  // Include ALL active staff — not just those with records this
  // month. Staff on long-term leave or new hires who haven't been
  // in any time-card upload yet would otherwise disappear from the
  // grid, making the count diverge from the directory and from the
  // export report. Showing them with empty cells (or leave-seeded
  // chips) keeps the on-screen view authoritative.
  const tracked = useMemo(() => {
    const all = (employees || [])
      .filter(e => e?.id && !e.terminated && e.is_active !== false && e.status !== 'inactive')
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter(e => {
      const haystack = [
        e.name, e.id, e.department, e.location,
        e.designation, e.email,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [employees, search]);

  // Total tracked count (before search filter) — all active staff in
  // the directory. Used in the result counter when search is active.
  const trackedTotalCount = useMemo(() => {
    return (employees || []).filter(e =>
      e?.id && !e.terminated && e.is_active !== false && e.status !== 'inactive'
    ).length;
  }, [employees]);

  function nav(delta) {
    let m = month + delta;
    let y = year;
    if (m < 0) { m = 11; y -= 1; }
    if (m > 11) { m = 0;  y += 1; }
    setMonth(m);
    setYear(y);
  }

  const monthLabel = firstDay.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const todayStr = todayYmd();

  // ── Coverage ───────────────────────────────────────────────────
  // Which calendar dates in the visible month actually have attendance
  // data loaded. Empty cells otherwise look identical to a real day
  // off, so without this you can't tell "no shift" from "not uploaded
  // yet". Working days (Sun–Thu) up to today are expected; weekends and
  // future dates aren't flagged. A public holiday may also be
  // legitimately empty — noted in the label. Declared after todayStr so
  // the memo never reads it before initialization. Nadeem 2026-05-31.
  const coverage = useMemo(() => {
    const covered = new Set(records.map(r => r.attendance_date));
    const expected = days.filter(d => ymd(d) <= todayStr);
    // Working days = Sun–Thu, excluding public holidays (a holiday can
    // legitimately have no punches and must not show as "missing").
    const workExpected = expected.filter(d => {
      const w = d.getDay();
      return w !== 5 && w !== 6 && !holidayMap.has(ymd(d));
    });
    const missing = workExpected.filter(d => !covered.has(ymd(d)));
    return {
      coveredSet: covered,
      expectedCount: workExpected.length,
      loadedCount: workExpected.length - missing.length,
      missing,
      complete: workExpected.length > 0 && missing.length === 0,
      anyExpected: workExpected.length > 0,
    };
  }, [records, days, todayStr, holidayMap]);

  // ── Anomaly list ───────────────────────────────────────────────
  // Surfaces exactly what HR should review/correct this month, drawn
  // from the loaded records: single-punch days (ambiguous — sign-on vs
  // sign-off), unapproved absences, and chronically late staff.
  const anomalies = useMemo(() => {
    const empById = new Map((employees || []).map(e => [String(e.id), e]));
    const singlePunch = [];     // { emp, dateStr, r }
    const absences = [];        // { emp, dateStr }
    const lateByEmp = new Map();
    for (const r of records) {
      const st = r.status;
      if (typeof st === 'string' && (st.includes('leave') || st === 'off_day' || st === 'off_roster')) continue;
      const hasF = !!r.first_punch, hasL = !!r.last_punch;
      if ((hasF && !hasL) || (!hasF && hasL)) {
        singlePunch.push({ emp: empById.get(String(r.employee_id)), id: r.employee_id, dateStr: r.attendance_date, r });
      }
      if (st === 'absent') absences.push({ emp: empById.get(String(r.employee_id)), id: r.employee_id, dateStr: r.attendance_date });
      if (st === 'late') lateByEmp.set(r.employee_id, (lateByEmp.get(r.employee_id) || 0) + 1);
    }
    const chronicLate = [...lateByEmp.entries()]
      .filter(([, n]) => n >= 3)
      .map(([id, n]) => ({ emp: empById.get(String(id)), id, count: n }))
      .sort((a, b) => b.count - a.count);
    singlePunch.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    absences.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
    return { singlePunch, absences, chronicLate,
      total: singlePunch.length + absences.length + chronicLate.length };
  }, [records, employees]);
  const [showAnomalies, setShowAnomalies] = useState(false);

  // ── Single-punch HR override ───────────────────────────────────
  // A single-punch day is ambiguous: the device stream doesn't label
  // in vs out. This lets HR mark which it was; the row's punch fields
  // and status are corrected and `manual_override` is set so the
  // re-evaluation leaves the row alone. Nadeem 2026-05-31.
  const [overrideCell, setOverrideCell] = useState(null);   // { id(rowId), empId, dateStr, x, y } or null
  const [savingOverride, setSavingOverride] = useState(false);
  const applyOverride = useCallback(async (rowId, kind) => {
    // kind: 'sign_in' (the punch was a clock-IN, sign-off missing) or
    //       'sign_out' (the punch was a clock-OUT, sign-on missing)
    const rec = records.find(r => r.id === rowId);
    if (!rec) { setOverrideCell(null); return; }
    const onlyPunch = rec.first_punch || rec.last_punch || null;
    setSavingOverride(true);
    try {
      const patch = kind === 'sign_in'
        ? { first_punch: onlyPunch, last_punch: null, status: 'short' }     // in only → forgot sign-off
        : { first_punch: null, last_punch: onlyPunch, status: 'late' };     // out only → forgot sign-on
      // Always correct the punch/status (works regardless of schema).
      await directPatch('attendance_daily', 'id', rowId, patch, { timeoutMs: 10000 });
      // Best-effort: flag manual_override so re-eval skips it. If the
      // column isn't there yet (migration not run), this no-ops.
      try { await directPatch('attendance_daily', 'id', rowId, { manual_override: true }, { timeoutMs: 8000 }); }
      catch { /* column may not exist yet — correction above still applied */ }
      setOverrideCell(null);
      await refetch();
    } catch (e) {
      console.warn('override failed:', e);
    } finally {
      setSavingOverride(false);
    }
  }, [records, refetch]);

  // ─── Row stats — present/absent/leave counts per employee ────────
  const statsByEmp = useMemo(() => {
    const m = new Map();
    records.forEach(r => {
      const cur = m.get(r.employee_id) || { present: 0, late: 0, short: 0, absent: 0, leave: 0, off: 0 };
      if (r.status === 'present') cur.present++;
      else if (r.status === 'late') cur.late++;
      else if (r.status === 'short') cur.short++;
      else if (r.status === 'absent') cur.absent++;
      else if (r.status === 'annual_leave' || r.status === 'sick_leave'
            || r.status === 'maternity_leave' || r.status === 'paternity_leave'
            || r.status === 'hajj_leave' || r.status === 'emergency_leave'
            || r.status === 'unpaid_leave') cur.leave++;
      else if (r.status === 'off_day' || r.status === 'off_roster') cur.off++;
      m.set(r.employee_id, cur);
    });
    return m;
  }, [records]);

  // ─── Hover-tooltip handlers ──────────────────────────────────────
  const handleEnter = useCallback((e, payload) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setHoverTip({
      x: rect.left + rect.width / 2,
      yTop: rect.top, yBottom: rect.bottom,
      ...payload,
    });
  }, []);
  const handleLeave = useCallback(() => setHoverTip(null), []);

  // ── Monthly attendance export ──────────────────────────────────
  // The on-screen grid as an Excel sheet: rows = staff, columns = each
  // day with the status code, plus per-employee summary counts. For
  // records / MOL. Nadeem 2026-05-31.
  const [exportingMonth, setExportingMonth] = useState(false);
  const exportMonth = useCallback(async () => {
    try {
      setExportingMonth(true);
      const XLSX = await import('xlsx-js-style');
      const GREEN = '0F4C2A';
      const dayHdr = days.map(d => `${d.getDate()}\n${['Su','Mo','Tu','We','Th','Fr','Sa'][d.getDay()]}`);
      const headers = ['PSN', 'Employee', 'Department', 'Location', ...dayHdr, 'P', 'LT', 'SH', 'AB', 'LV'];
      const aoa = [[`MONTHLY ATTENDANCE \u2014 ${monthLabel}`], [], headers];
      const kind = ['title', 'blank', 'header'];
      tracked.forEach(emp => {
        const s = statsByEmp.get(emp.id) || {};
        const cells = days.map(d => {
          const r = recordIndex.get(`${emp.id}|${ymd(d)}`);
          if (!r) return '';
          return styleForStatus(r.status, r.notes).label.replace('✓', 'P');
        });
        aoa.push([emp.id, emp.name || emp.id, emp.department || '', emp.location || '',
          ...cells, s.present || 0, s.late || 0, s.short || 0, s.absent || 0, s.leave || 0]);
        kind.push('data');
      });
      aoa.push([]);
      aoa.push([`Working days only count toward totals. Coverage: ${coverage.loadedCount}/${coverage.expectedCount} working days loaded${coverage.missing.length ? ` (missing ${coverage.missing.map(d => d.getDate()).join(', ')})` : ''}.`]);
      kind.push('blank'); kind.push('note');

      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const dayStart = 4, dayEnd = 4 + days.length - 1;
      const isWknd = (C) => C >= dayStart && C <= dayEnd && [5, 6].includes(days[C - dayStart].getDay());
      const border = { top: { style: 'thin', color: { rgb: 'E5E7EB' } }, bottom: { style: 'thin', color: { rgb: 'E5E7EB' } }, left: { style: 'thin', color: { rgb: 'E5E7EB' } }, right: { style: 'thin', color: { rgb: 'E5E7EB' } } };
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let R = range.s.r; R <= range.e.r; R++) for (let C = range.s.c; C <= range.e.c; C++) {
        const a = XLSX.utils.encode_cell({ r: R, c: C }); if (!ws[a]) continue;
        const k = kind[R];
        if (k === 'title') ws[a].s = { font: { bold: true, sz: 14, color: { rgb: GREEN } } };
        else if (k === 'note') ws[a].s = { font: { sz: 10, color: { rgb: '0A0A0A' } }, alignment: { wrapText: true } };
        else if (k === 'header') ws[a].s = { font: { bold: true, sz: 9, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: isWknd(C) ? '0A3A20' : GREEN } }, alignment: { horizontal: C >= 2 ? 'center' : 'left', vertical: 'center', wrapText: true }, border };
        else if (k === 'data') ws[a].s = { font: { sz: 9, color: { rgb: '0A0A0A' } }, fill: isWknd(C) ? { fgColor: { rgb: 'F3F4F6' } } : undefined, alignment: { horizontal: C >= 4 ? 'center' : 'left', vertical: 'center' }, border };
      }
      ws['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 12 }, { wch: 8 }, ...days.map(() => ({ wch: 4.5 })), { wch: 4 }, { wch: 4 }, { wch: 4 }, { wch: 4 }, { wch: 4 }];
      ws['!rows'] = [{ hpt: 20 }, {}, { hpt: 26 }];
      ws['!freeze'] = { xSplit: 2, ySplit: 3 };
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: headers.length - 1 } }];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, monthLabel.slice(0, 31));
      XLSX.writeFile(wb, `ATTENDANCE_${monthLabel.replace(/[^a-z0-9]+/gi, '_')}.xlsx`);
    } catch (e) {
      console.error('Monthly export failed:', e);
    } finally {
      setExportingMonth(false);
    }
  }, [days, tracked, statsByEmp, recordIndex, monthLabel, coverage]);

  return (
    <div className="rounded-2xl border bg-white p-3 sm:px-4 sm:py-3" style={{ borderColor: '#D4D4D4' }}>
      <div className="flex items-center justify-between gap-3 flex-wrap mb-2">
        <div>
          <div className="flex items-baseline gap-3">
            <span style={{
              fontFamily: 'inherit',
              fontSize: 22,
              fontWeight: 700,
              color: '#1F1B16',
              letterSpacing: '-0.01em',
            }}>
              {monthLabel}
            </span>
            <span className="text-[10px]" style={{ color: '#7A7A7A', letterSpacing: '0.18em', fontWeight: 700, textTransform: 'uppercase' }}>
              Monthly attendance
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap" style={{ flex: '1 1 auto', justifyContent: 'flex-end' }}>
          {/* Search box — inline with title bar nav. Has clear border
              so it visually reads as a search input. */}
          {trackedTotalCount > 0 && (
            <div
              style={{
                position: 'relative',
                flex: '0 1 280px',
                minWidth: 200,
              }}
            >
              <Search
                className="w-3.5 h-3.5"
                style={{
                  position: 'absolute',
                  left: 10, top: '50%',
                  transform: 'translateY(-50%)',
                  color: '#0A0A0A',
                  opacity: 0.5,
                  pointerEvents: 'none',
                }}
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name, PSN, department…"
                aria-label="Search staff in monthly attendance"
                style={{
                  width: '100%',
                  padding: '6px 30px 6px 30px',
                  border: '1.5px solid #C7C2B6',
                  borderRadius: 8,
                  fontSize: 12,
                  fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
                  background: '#FFFFFF',
                  color: '#1F1B16',
                  outline: 'none',
                }}
                onFocus={(e) => { e.target.style.borderColor = '#0F4C2A'; }}
                onBlur={(e) => { e.target.style.borderColor = '#C7C2B6'; }}
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  aria-label="Clear search"
                  style={{
                    position: 'absolute',
                    right: 4, top: '50%',
                    transform: 'translateY(-50%)',
                    width: 22, height: 22,
                    borderRadius: 999,
                    border: 'none',
                    background: '#F5F5F5',
                    color: '#0A0A0A',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          )}
          {/* Staff count — inline with search/nav. */}
          {trackedTotalCount > 0 && (
            <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7, fontWeight: 500, whiteSpace: 'nowrap' }}>
              {search
                ? `${tracked.length} / ${trackedTotalCount}`
                : `${trackedTotalCount} staff`}
            </div>
          )}
          <button
            onClick={() => nav(-1)}
            className="w-8 h-8 rounded-full inline-flex items-center justify-center"
            style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', cursor: 'pointer' }}
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button
            onClick={() => { setMonth(today.getMonth()); setYear(today.getFullYear()); }}
            className="text-[11px] px-3 py-1.5 rounded-full"
            style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', cursor: 'pointer', fontWeight: 600 }}
          >
            Today
          </button>
          <button
            onClick={() => nav(1)}
            className="w-8 h-8 rounded-full inline-flex items-center justify-center"
            style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', cursor: 'pointer' }}
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
          {anomalies.total > 0 && (
            <button
              onClick={() => setShowAnomalies(v => !v)}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-full"
              style={{ border: '1px solid #FDE68A', background: showAnomalies ? '#FEF3C7' : '#FFFBEB', color: '#92400E', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
              title="Review attendance issues to correct"
            >
              <AlertTriangle className="w-3.5 h-3.5" /> {anomalies.total} to review
            </button>
          )}
          <button
            onClick={exportMonth}
            disabled={exportingMonth || (lastCount || 0) === 0}
            className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-full disabled:opacity-50"
            style={{ border: '1px solid #0F4C2A', background: '#0F4C2A', color: '#FFFFFF', cursor: 'pointer', fontWeight: 700, whiteSpace: 'nowrap' }}
            title="Export this month to Excel"
          >
            {exportingMonth ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Export
          </button>
          <button
            onClick={refetch}
            className="w-8 h-8 rounded-full inline-flex items-center justify-center"
            style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', cursor: 'pointer' }}
            aria-label="Refresh"
            title="Refresh"
          >
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin"/> : <RefreshCcw className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Fetch diagnostic — surfaces what the attendance_daily read
          actually returned so an empty grid is never a silent mystery.
          Shows the error in red if the read failed, otherwise the row
          count + the exact date range queried. */}
      {fetchErr ? (
        <div className="text-[11px] mb-2 px-2 py-1 rounded"
             style={{ background: '#FEF2F2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
          Couldn’t load attendance for {ymd(firstDay)} → {ymd(lastDay)}: {fetchErr}
        </div>
      ) : lastCount != null && (
        <div className="text-[11px] mb-2" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          {lastCount} record{lastCount === 1 ? '' : 's'} loaded for {ymd(firstDay)} → {ymd(lastDay)}
          {recordDiag && recordDiag.matched === 0 && recordDiag.total > 0 && (
            <span style={{ color: '#991B1B', fontWeight: 600 }}>
              {' · '}none of the loaded records match a known employee — check the PSN format in the upload
            </span>
          )}
        </div>
      )}

      {/* Coverage indicator — at a glance, is this month's attendance
          actually loaded? Green when every working day up to today has
          data; amber listing the dates still missing otherwise. */}
      {!fetchErr && coverage.anyExpected && (
        <div className="text-[11px] mb-2 px-2.5 py-1.5 rounded flex items-start gap-2 flex-wrap"
             style={{
               background: coverage.complete ? '#ECFDF5' : '#FFFBEB',
               border: `1px solid ${coverage.complete ? '#A7F3D0' : '#FDE68A'}`,
               color: '#0A0A0A',
             }}>
          <span style={{ fontWeight: 700, color: coverage.complete ? '#065F46' : '#92400E' }}>
            {coverage.complete ? '✓ Data loaded' : 'Data incomplete'}
          </span>
          <span style={{ fontWeight: 600 }}>
            {coverage.loadedCount} / {coverage.expectedCount} working days
          </span>
          {!coverage.complete && coverage.missing.length > 0 && (
            <span style={{ color: '#92400E' }}>
              · Missing: {coverage.missing.map(d => d.getDate()).join(', ')}
              <span style={{ opacity: 0.7 }}> (upload these dates, or ignore if a public holiday)</span>
            </span>
          )}
          <span style={{ opacity: 0.55, marginLeft: 'auto' }}>weekends &amp; future dates excluded</span>
        </div>
      )}

      {/* Anomaly review panel — what HR should check/correct this month. */}
      {showAnomalies && anomalies.total > 0 && (
        <div className="text-[11px] mb-2 px-3 py-2.5 rounded" style={{ background: '#FFFBEB', border: '1px solid #FDE68A', color: '#0A0A0A' }}>
          <div style={{ fontWeight: 700, color: '#92400E', marginBottom: 4 }}>Needs review</div>
          {anomalies.singlePunch.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600 }}>Single-punch days ({anomalies.singlePunch.length}) — only one punch; tap the chip in the grid to mark sign-on vs sign-off:</div>
              <div style={{ opacity: 0.85 }}>
                {anomalies.singlePunch.slice(0, 12).map((a, i) => (
                  <span key={i}>{i > 0 ? ' · ' : ''}{(a.emp?.name || a.id)} {fmtShort(a.dateStr)}</span>
                ))}
                {anomalies.singlePunch.length > 12 && <span> · +{anomalies.singlePunch.length - 12} more</span>}
              </div>
            </div>
          )}
          {anomalies.absences.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: 600, color: '#991B1B' }}>Unapproved absences ({anomalies.absences.length}):</div>
              <div style={{ opacity: 0.85 }}>
                {anomalies.absences.slice(0, 12).map((a, i) => (
                  <span key={i}>{i > 0 ? ' · ' : ''}{(a.emp?.name || a.id)} {fmtShort(a.dateStr)}</span>
                ))}
                {anomalies.absences.length > 12 && <span> · +{anomalies.absences.length - 12} more</span>}
              </div>
            </div>
          )}
          {anomalies.chronicLate.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, color: '#854F0B' }}>Chronic lateness (3+ late days):</div>
              <div style={{ opacity: 0.85 }}>
                {anomalies.chronicLate.map((a, i) => (
                  <span key={i}>{i > 0 ? ' · ' : ''}{(a.emp?.name || a.id)} ({a.count})</span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {trackedTotalCount > 0 && tracked.length === 0 && search ? (
        <div className="text-center py-8" style={{ color: '#0A0A0A', opacity: 0.55 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>No staff match &ldquo;{search}&rdquo;.</div>
          <button
            onClick={() => setSearch('')}
            className="text-[11px] mt-2 px-3 py-1.5 rounded-full"
            style={{
              background: '#FFFFFF',
              color: '#1F1B16',
              border: '1px solid #D4D4D4',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
            }}
          >
            Clear search
          </button>
        </div>
      ) : null}

      {trackedTotalCount === 0 ? (
        <div className="text-center py-10" style={{ color: '#0A0A0A', opacity: 0.5 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>No attendance records yet for {monthLabel}.</div>
          <div className="text-xs mt-1">Upload an attendance file above and the calendar will start filling in.</div>
        </div>
      ) : tracked.length === 0 ? null : (
        <>
        {/* Legend — sits above the grid in a single horizontal line.
            Set to nowrap so all items stay on one row; if the viewport
            is too narrow, horizontal scroll appears (cleaner than
            wrapping into multiple rows). */}
        <div className="text-[11px] mb-2 flex gap-2 items-center"
          style={{
            color: '#0A0A0A',
            padding: '8px 12px',
            background: '#FAFAF9',
            border: '1px solid #EEEAE0',
            borderRadius: 8,
            overflowX: 'auto',
            whiteSpace: 'nowrap',
            flexWrap: 'nowrap',
          }}>
          {[
            { st: 'present',      lbl: 'Present' },
            { st: 'present',      lbl: 'Late — permitted', overrideStyle: { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '✓LP' } },
            { st: 'present',      lbl: 'Early — permitted', overrideStyle: { bg: '#EFF6FF', fg: '#1E40AF', border: '#93C5FD', label: '✓EP' } },
            { st: 'late',         lbl: 'Late' },
            { st: 'short',        lbl: 'Short' },
            { st: 'absent',       lbl: 'Absent' },
            { st: 'annual_leave', lbl: 'Annual leave' },
            { st: 'sick_leave',   lbl: 'Sick leave' },
            { st: 'maternity_leave', lbl: 'Maternity' },
            { st: 'paternity_leave', lbl: 'Paternity' },
            { st: 'hajj_leave',      lbl: 'Hajj' },
            { st: 'emergency_leave', lbl: 'Emergency' },
            { st: 'unpaid_leave',    lbl: 'Unpaid' },
            { st: 'off_roster',   lbl: 'Off-roster' },
            { st: 'off_day',      lbl: 'Off-day' },
            { st: 'present',      lbl: 'Shift day', overrideStyle: { bg: '#F8FAFC', fg: '#1F2937', border: '#CBD5E1', label: '🌙' } },
          ].map(({ st, lbl, overrideStyle }, idx) => {
            const sty = overrideStyle || styleForStatus(st);
            return (
              <span key={`${st}-${idx}`} className="inline-flex items-center gap-1" style={{ flex: '0 0 auto' }}>
                <span style={{
                  background: sty.bg,
                  color: sty.fg,
                  border: `1px solid ${sty.border}`,
                  borderRadius: 3,
                  fontSize: 9,
                  padding: '1px 5px',
                  fontWeight: 700,
                  letterSpacing: '0.04em',
                }}>{sty.label}</span>
                <span style={{ fontSize: 10, color: '#0A0A0A' }}>{lbl}</span>
              </span>
            );
          })}
          {/* Single-punch marker — dashed border + "1" badge. Clickable. */}
          <span className="inline-flex items-center gap-1" style={{ flex: '0 0 auto' }}>
            <span style={{
              position: 'relative',
              background: '#FFFFFF',
              color: '#7C2D12',
              border: '1px dashed #C026D3',
              borderRadius: 3,
              fontSize: 9,
              padding: '1px 5px',
              fontWeight: 700,
              letterSpacing: '0.04em',
            }}>
              SH
              <span aria-hidden style={{ position: 'absolute', top: -6, right: -6, minWidth: 12, height: 12, padding: '0 2px', borderRadius: 999, background: '#C026D3', color: '#FFFFFF', fontSize: 7, fontWeight: 800, lineHeight: '12px', textAlign: 'center' }}>1</span>
            </span>
            <span style={{ fontSize: 10, color: '#0A0A0A' }}>Single punch — click to fix</span>
          </span>
          {/* Public / government holiday column marker */}
          <span className="inline-flex items-center gap-1" style={{ flex: '0 0 auto' }}>
            <span style={{
              background: '#EDE9FE',
              color: '#5B21B6',
              border: '1px solid #A78BFA',
              borderRadius: 3,
              fontSize: 9,
              padding: '1px 5px',
              fontWeight: 800,
              letterSpacing: '0.04em',
            }}>H</span>
            <span style={{ fontSize: 10, color: '#0A0A0A' }}>Public holiday</span>
          </span>
        </div>
        <div style={{ overflowX: 'visible', overflowY: 'auto', maxHeight: '72vh', maxWidth: '100%', boxSizing: 'border-box' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: `190px repeat(${days.length}, minmax(0, 1fr))`,
            gap: 3,
            width: '100%',
            boxSizing: 'border-box',
          }}>
            {/* Header — sticky so the day/date row stays visible while
                scrolling down the employee list. Nadeem 2026-05-31. */}
            <div style={{ position: 'sticky', top: 0, zIndex: 3, background: '#FAFAFA', padding: '6px 8px', fontSize: 10, fontWeight: 700, color: '#0A0A0A', letterSpacing: '0.05em' }}>
              EMPLOYEE
            </div>
            {days.map(d => {
              const dStr = ymd(d);
              const dow = d.getDay();
              const isWeekend = dow === 5 || dow === 6;
              const isToday = dStr === todayStr;
              const holidayName = holidayMap.get(dStr);
              const isHoliday = !!holidayName;
              // Working day, on/before today, with no attendance loaded:
              // flag the column so a gap in the upload is obvious. A
              // public holiday is never flagged as missing.
              const noData = !isWeekend && !isHoliday && dStr <= todayStr && !coverage.coveredSet.has(dStr);
              return (
                <div
                  key={dStr}
                  title={isHoliday ? `Public holiday: ${holidayName}` : (noData ? 'No attendance data loaded for this date' : undefined)}
                  style={{
                    position: 'sticky',
                    top: 0,
                    zIndex: 2,
                    background: isToday
                      ? '#E3EDE7'   // opaque so scrolled rows don't show through
                      : isHoliday
                        ? '#EDE9FE'  // violet-100 — public / government holiday
                      : isWeekend
                        ? '#FEF3C7'  // amber-50 — clearly distinguishable from working days
                        : noData
                          ? '#FEECEC'  // light red — no data loaded for this working day
                          : '#FAFAFA',
                    padding: '4px 0',
                    fontSize: 9,
                    fontWeight: 700,
                    color: isHoliday ? '#5B21B6' : (isWeekend ? '#854F0B' : (noData ? '#B91C1C' : '#0A0A0A')),
                    textAlign: 'center',
                    borderTop: isToday ? '2px solid #0F4C2A' : (isHoliday ? '2px solid #A78BFA' : (isWeekend ? '2px solid #FCD34D' : (noData ? '2px solid #FCA5A5' : '1px solid transparent'))),
                    borderBottom: isHoliday ? '1px solid #A78BFA' : (isWeekend ? '1px solid #FCD34D' : (noData ? '1px solid #FCA5A5' : 'none')),
                  }}
                >
                  <div style={{ fontSize: 8, opacity: (isWeekend || isHoliday) ? 0.95 : 0.6, fontWeight: (isWeekend || isHoliday) ? 700 : 600, letterSpacing: (isWeekend || isHoliday) ? '0.05em' : 0 }}>
                    {['Su','Mo','Tu','We','Th','Fr','Sa'][dow]}
                  </div>
                  <div>{d.getDate()}</div>
                  {isHoliday && <div style={{ fontSize: 7, lineHeight: 1, marginTop: 1, fontWeight: 800 }}>H</div>}
                  {!isHoliday && noData && <div style={{ fontSize: 7, lineHeight: 1, marginTop: 1 }}>•</div>}
                </div>
              );
            })}

            {/* Body — one row per employee */}
            {tracked.map(emp => {
              const stats = statsByEmp.get(emp.id) || {};
              return (
                <React.Fragment key={emp.id}>
                  <button
                    type="button"
                    onClick={onEmployeeClick ? () => onEmployeeClick(emp) : undefined}
                    disabled={!onEmployeeClick}
                    title={onEmployeeClick ? `Open ${emp.name || emp.id}'s attendance detail` : (emp.name || emp.id)}
                    style={{
                      background: '#FFFFFF',
                      padding: '6px 8px',
                      borderTop: '1px solid var(--border-soft, #EFEFEF)',
                      borderRight: 'none', borderLeft: 'none', borderBottom: 'none',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'center',
                      textAlign: 'left',
                      cursor: onEmployeeClick ? 'pointer' : 'default',
                      transition: 'background 0.15s ease',
                      width: '100%',
                    }}
                    onMouseEnter={(e) => {
                      if (onEmployeeClick) e.currentTarget.style.background = '#F8F8F4';
                    }}
                    onMouseLeave={(e) => {
                      if (onEmployeeClick) e.currentTarget.style.background = '#FFFFFF';
                    }}
                  >
                    <FitText
                      text={emp.name || emp.id}
                      style={{
                        fontWeight: 600,
                        color: '#0A0A0A',
                        lineHeight: 1.2,
                        textDecoration: onEmployeeClick ? 'underline' : 'none',
                        textDecorationColor: 'rgba(15,76,42,0.25)',
                        textUnderlineOffset: 2,
                      }}
                    />
                    <div style={{ fontSize: 9, color: '#0A0A0A', opacity: 0.6, marginTop: 1 }}>
                      {emp.id} · {emp.department || '—'}
                    </div>
                    <div style={{ fontSize: 9, color: '#0A0A0A', opacity: 0.7, marginTop: 2, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {stats.present > 0 && <span style={{ color: '#0F4C2A' }}>✓{stats.present}</span>}
                      {stats.late    > 0 && <span style={{ color: '#854F0B' }}>LT{stats.late}</span>}
                      {stats.short   > 0 && <span style={{ color: '#7C2D12' }}>SH{stats.short}</span>}
                      {stats.absent  > 0 && <span style={{ color: '#991B1B' }}>AB{stats.absent}</span>}
                      {stats.leave   > 0 && <span style={{ color: '#115E59' }}>LV{stats.leave}</span>}
                    </div>
                  </button>
                  {days.map(d => {
                    const dStr = ymd(d);
                    const dow = d.getDay();
                    const isWeekend = dow === 5 || dow === 6;
                    const isToday = dStr === todayStr;
                    const isFuture = dStr > todayStr;
                    const isHoliday = holidayMap.has(dStr);
                    const r = recordIndex.get(`${emp.id}|${dStr}`);
                    const cellBg = isToday ? 'rgba(15,76,42,0.04)'
                                 : isFuture ? '#FAFAFA'
                                 : isHoliday ? '#F5F3FF'   // violet-50 — public holiday column
                                 : isWeekend ? '#FEF8E1' : 'transparent';
                    if (!r) {
                      return (
                        <div
                          key={dStr}
                          style={{
                            background: cellBg,
                            borderTop: '1px solid var(--border-soft, #EFEFEF)',
                            borderLeft: '1px solid var(--border-soft, #EFEFEF)',
                          }}
                        />
                      );
                    }
                    const sty = styleForStatus(r.status, r.notes);
                    // Missed-punch indicator — small magenta dot on the
                    // chip when first or last punch is missing. Same
                    // visual language as the tooltip's ⚠ marker.
                    const hasFirst = !!r.first_punch;
                    const hasLast  = !!r.last_punch;
                    const missedPunch = (hasFirst && !hasLast) || (!hasFirst && hasLast);
                    // Shift-day indicator — moon icon shown alongside
                    // the status chip when this row was evaluated
                    // against a manager-assigned shift schedule (the
                    // notes carry the "Shift (HH:MM-HH:MM)" or
                    // "Overnight Shift (...)" marker the backfill
                    // stamps). Per Nadeem (2026-05-06): staff assigned
                    // a shift during the month should have a small 🌙
                    // alongside their daily status chip.
                    const isShiftDay = typeof r.notes === 'string' &&
                      /(?:^|\s)(?:Overnight\s+)?Shift\s*\(\d{2}:\d{2}-\d{2}:\d{2}\)/i.test(r.notes);
                    return (
                      <div
                        key={dStr}
                        style={{
                          background: cellBg,
                          borderTop: '1px solid var(--border-soft, #EFEFEF)',
                          borderLeft: '1px solid var(--border-soft, #EFEFEF)',
                          padding: '5px 4px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        onMouseEnter={(e) => handleEnter(e, { record: r, employee: emp, dateStr: dStr, weekday: ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow] })}
                        onMouseLeave={handleLeave}
                      >
                        <div
                          onClick={missedPunch ? (e) => {
                            e.stopPropagation();
                            const rect = e.currentTarget.getBoundingClientRect();
                            setOverrideCell({ id: r.id, empId: emp.id, name: emp.name || emp.id, dateStr: dStr, x: rect.left, y: rect.bottom });
                          } : undefined}
                          title={missedPunch ? 'Single punch — click to mark sign-on or sign-off' : undefined}
                          style={{
                            position: 'relative',
                            background: sty.bg,
                            color: sty.fg,
                            border: missedPunch ? '1px dashed #C026D3' : `1px solid ${sty.border}`,
                            borderRadius: 4,
                            width: '100%',
                            minHeight: 28,
                            padding: '3px 3px',
                            fontSize: 10,
                            fontWeight: 700,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 2,
                            letterSpacing: '0.02em',
                            cursor: missedPunch ? 'pointer' : 'default',
                          }}
                        >
                          {sty.label}
                          {isShiftDay && (
                            <span
                              aria-hidden
                              title="Shift day"
                              style={{
                                marginLeft: 1,
                                fontSize: 10,
                                lineHeight: 1,
                              }}
                            >🌙</span>
                          )}
                          {missedPunch && (
                            <span
                              aria-hidden
                              title="Single punch only"
                              style={{
                                position: 'absolute',
                                top: -5,
                                right: -5,
                                minWidth: 13,
                                height: 13,
                                padding: '0 2px',
                                borderRadius: 999,
                                background: '#C026D3',
                                color: '#FFFFFF',
                                fontSize: 8,
                                fontWeight: 800,
                                lineHeight: '13px',
                                textAlign: 'center',
                                boxShadow: '0 0 0 1.5px ' + sty.bg,
                              }}
                            >1</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </div>
        </div>
        </>
      )}

      {/* Hover tooltip */}
      {hoverTip && <HoverTooltip {...hoverTip} />}

      {/* Single-punch override popover */}
      {overrideCell && (
        <>
          <div onClick={() => !savingOverride && setOverrideCell(null)}
               style={{ position: 'fixed', inset: 0, zIndex: 60 }} />
          <div style={{
            position: 'fixed',
            left: Math.min(overrideCell.x, (typeof window !== 'undefined' ? window.innerWidth : 1000) - 280),
            top: overrideCell.y + 6,
            zIndex: 61,
            width: 268,
            background: '#FFFFFF',
            border: '1px solid #D4D4D4',
            borderRadius: 10,
            boxShadow: '0 8px 28px rgba(0,0,0,0.18)',
            padding: 12,
          }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#0A0A0A' }}>{overrideCell.name}</div>
            <div style={{ fontSize: 11, color: '#0A0A0A', opacity: 0.7, marginBottom: 8 }}>
              {fmtShort(overrideCell.dateStr)} · only one punch recorded. What was it?
            </div>
            <button
              onClick={() => applyOverride(overrideCell.id, 'sign_in')}
              disabled={savingOverride}
              className="w-full text-left text-[12px] px-2.5 py-2 rounded mb-1.5 disabled:opacity-50"
              style={{ border: '1px solid #FB923C', background: '#FFF7ED', color: '#7C2D12', cursor: 'pointer', fontWeight: 600 }}
            >
              Clock-IN — they forgot to sign off <span style={{ opacity: 0.7, fontWeight: 400 }}>(marks Short)</span>
            </button>
            <button
              onClick={() => applyOverride(overrideCell.id, 'sign_out')}
              disabled={savingOverride}
              className="w-full text-left text-[12px] px-2.5 py-2 rounded disabled:opacity-50"
              style={{ border: '1px solid #FCD34D', background: '#FEF9C3', color: '#854F0B', cursor: 'pointer', fontWeight: 600 }}
            >
              Clock-OUT — they forgot to sign on <span style={{ opacity: 0.7, fontWeight: 400 }}>(marks Late)</span>
            </button>
            <button
              onClick={() => setOverrideCell(null)}
              disabled={savingOverride}
              className="w-full text-[11px] mt-2 px-2 py-1 rounded disabled:opacity-50"
              style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#0A0A0A', cursor: 'pointer' }}
            >
              {savingOverride ? 'Saving…' : 'Cancel'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Hover-tooltip panel ─────────────────────────────────────────────
function HoverTooltip({ x, yTop, yBottom, record, employee, dateStr, weekday }) {
  // Position above the cell when there's room, otherwise below
  const flipBelow = yTop < 140;
  const sty = styleForStatus(record.status, record.notes);
  const label = readableStatus(record.status);
  const punch = (record.first_punch || record.last_punch)
    ? `${record.first_punch ? record.first_punch.slice(0,5) : '—'} → ${record.last_punch ? record.last_punch.slice(0,5) : '—'}`
    : null;
  const sched = (record.expected_start || record.expected_end)
    ? `Scheduled ${record.expected_start ? record.expected_start.slice(0,5) : '?'}–${record.expected_end ? record.expected_end.slice(0,5) : '?'}`
    : null;

  const minutesLine = record.late_minutes > 0
    ? `${record.late_minutes} min late`
    : record.early_leave_minutes > 0
      ? `Left ${record.early_leave_minutes} min early`
      : null;

  // Permission-coverage line — shown when the row was downgraded
  // from late/short to present because an approved permission
  // covered the punch. The blue chip on the cell uses the LP/EP
  // label; the tooltip explains it in words.
  const isLatePermitted  = typeof record.notes === 'string' && /late arrival covered by approved permission/i.test(record.notes);
  const isEarlyPermitted = typeof record.notes === 'string' && /early leave covered by approved permission/i.test(record.notes);
  const coveredLine = isLatePermitted
    ? 'Late arrival — covered by approved permission'
    : isEarlyPermitted
      ? 'Early leave — covered by approved permission'
      : null;
  // Shift-day indicator on the tooltip — extracts the schedule
  // label from the notes so HR can see exactly which shift was
  // assigned ("Shift (20:00-05:00)") on hover.
  const shiftMatch = typeof record.notes === 'string'
    ? record.notes.match(/(?:Overnight\s+)?Shift\s*\((\d{2}:\d{2}-\d{2}:\d{2})\)/i)
    : null;
  const shiftLine = shiftMatch ? `🌙 Shift day — ${shiftMatch[1]}` : null;

  // Detect missing punches — surfaces the data-quality issue clearly
  // rather than hiding it inside the notes field. A row is "missed
  // in" if it has a last_punch but no first_punch (staff left, but
  // we don't have proof of arrival time), and "missed out" the
  // converse.
  const hasFirst = !!record.first_punch;
  const hasLast  = !!record.last_punch;
  const missedLine = (!hasFirst && hasLast)
    ? 'No clock-in recorded'
    : (hasFirst && !hasLast)
      ? 'No clock-out recorded'
      : null;

  const style = {
    position: 'fixed',
    left: x,
    top: flipBelow ? yBottom + 6 : yTop - 6,
    transform: flipBelow ? 'translateX(-50%)' : 'translate(-50%, -100%)',
    zIndex: 60,
    background: '#1F1B16',
    color: '#FFFFFF',
    padding: '8px 10px',
    borderRadius: 8,
    fontSize: 11,
    minWidth: 180,
    maxWidth: 260,
    boxShadow: '0 10px 24px rgba(0,0,0,0.25)',
    pointerEvents: 'none',
  };
  return (
    <div style={style}>
      <div style={{ fontSize: 9, opacity: 0.7, letterSpacing: '0.06em' }}>{(employee?.id || '').toString()}</div>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 2 }}>{employee?.name || record.employee_id}</div>
      <div style={{ fontSize: 10, opacity: 0.85, marginBottom: 4 }}>{weekday}, {dateStr}</div>
      <div style={{ display: 'inline-block', background: sty.bg, color: sty.fg, border: `1px solid ${sty.border}`, padding: '1px 6px', borderRadius: 3, fontSize: 9, fontWeight: 700, letterSpacing: '0.04em', marginBottom: 4 }}>
        {label.toUpperCase()}
      </div>
      {punch && <div style={{ fontSize: 10.5 }}>Punched: {punch}</div>}
      {sched && <div style={{ fontSize: 10.5, opacity: 0.85 }}>{sched}</div>}
      {missedLine && <div style={{ fontSize: 10.5, color: '#F0ABFC', marginTop: 2, fontWeight: 700 }}>⚠ {missedLine}</div>}
      {minutesLine && <div style={{ fontSize: 10.5, color: '#FCD34D', marginTop: 2 }}>{minutesLine}</div>}
      {coveredLine && <div style={{ fontSize: 10.5, color: '#93C5FD', marginTop: 2, fontWeight: 700 }}>✓ {coveredLine}</div>}
      {shiftLine && <div style={{ fontSize: 10.5, color: '#CBD5E1', marginTop: 2, fontWeight: 600 }}>{shiftLine}</div>}
      {record.notes && <div style={{ fontSize: 10, opacity: 0.85, marginTop: 4, fontStyle: 'italic' }}>{record.notes}</div>}
    </div>
  );
}
