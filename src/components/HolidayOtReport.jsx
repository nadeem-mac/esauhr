// ──────────────────────────────────────────────────────────────────────
//  HolidayOtReport — Phase 6 of the holiday-OT module
//
//  The closing piece. Replaces the Excel Bashaier currently sends to
//  payroll after each Eid window. Compares approved holiday_shifts
//  against actual attendance_daily punches with strict (no-grace)
//  comparison, then exports an Excel matching the SAJED template.
//
//  Lives as a modal opened from HolidayShifts via a "Report" button —
//  not its own sidebar tab. Visible to managers (own team), HR, admin.
//
//  Strict comparison logic (Nadeem 2026-05-21, 'no grace period'):
//    late_minutes   = max(0, actual_in − scheduled_in)
//    early_minutes  = max(0, scheduled_out − actual_out)
//    worked_hours   = max(0, min(actual_out, scheduled_out)
//                              − max(actual_in, scheduled_in)) / 60
//    no_show        = actual_in IS NULL
//
//  The worked_hours formula is the conservative one — late arrivals
//  AND early departures both shrink the figure. If they punched in
//  10 min late AND left 5 min early on a 3h shift, they get credit
//  for 2h 45m, not the full 3h.
//
//  Nadeem 2026-05-21.
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useMemo } from 'react';
import { directGet } from '../supabaseClient.js';
import {
  X, Download, Loader2, AlertCircle, Clock, FileText,
  CheckCircle2, AlertTriangle, MinusCircle,
} from 'lucide-react';

const fmtDayDate = (d) => new Date(d).toLocaleDateString('en-GB', {
  weekday: 'short', day: '2-digit', month: 'short',
});

const fmtTime = (t) => t ? (t || '').slice(0, 5) : '—';

// time → minutes since midnight, null-safe
const toMins = (t) => {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};


export default function HolidayOtReport({ period, employees = [], me, onClose }) {
  const [shifts, setShifts]       = useState([]);
  const [attendance, setAttendance] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [err, setErr]             = useState(null);
  const [exporting, setExporting] = useState(false);

  // ── Load approved shifts + matching attendance ────────────────────
  useEffect(() => {
    if (!period?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        // Approved holiday_shifts for this period
        const sRows = await directGet('holiday_shifts',
          `select=*&holiday_period_id=eq.${period.id}&status=eq.approved`
          + `&order=shift_date.asc,employee_id.asc`,
          { timeoutMs: 12000 });
        const shiftRows = sRows || [];
        if (cancelled) return;
        setShifts(shiftRows);

        // attendance_daily rows for the same staff + dates
        if (shiftRows.length === 0) {
          setAttendance([]);
        } else {
          const psnSet  = [...new Set(shiftRows.map(s => s.employee_id))];
          const dateSet = [...new Set(shiftRows.map(s => s.shift_date))];
          const psnList  = psnSet.map(p => `"${p}"`).join(',');
          const dateMin = dateSet.reduce((a, b) => a < b ? a : b);
          const dateMax = dateSet.reduce((a, b) => a > b ? a : b);
          const aRows = await directGet('attendance_daily',
            `select=employee_id,attendance_date,first_punch,last_punch,punch_count,status`
            + `&employee_id=in.(${psnList})`
            + `&attendance_date=gte.${dateMin}`
            + `&attendance_date=lte.${dateMax}`
            + `&limit=1000`,
            { timeoutMs: 12000 });
          if (!cancelled) setAttendance(aRows || []);
        }
      } catch (e) {
        if (!cancelled) setErr(e?.message || 'Failed to load report data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [period?.id]);

  // ── Compute report rows (one per shift) ───────────────────────────
  const rows = useMemo(() => {
    return shifts.map(s => {
      const emp = employees.find(e => e.id === s.employee_id);
      const att = attendance.find(a =>
        a.employee_id === s.employee_id &&
        a.attendance_date === s.shift_date
      );
      const schedIn  = toMins(s.clock_in_time);
      const schedOut = toMins(s.clock_out_time);
      const actIn    = toMins(att?.first_punch);
      const actOut   = toMins(att?.last_punch);

      // Strict comparison (no grace)
      const noShow      = actIn == null;
      const late        = !noShow ? Math.max(0, actIn  - schedIn)  : 0;
      const earlyOut    = !noShow && actOut != null
                           ? Math.max(0, schedOut - actOut) : 0;
      const workedMins  = !noShow && actOut != null
                           ? Math.max(0, Math.min(actOut, schedOut) - Math.max(actIn, schedIn))
                           : 0;
      // Raw presence time — full span from first to last punch,
      // NOT capped to the schedule. Nadeem 2026-05-26: 'show the
      // total time of worked as per check in / out time'. Useful
      // when staff work beyond their assigned window (this figure
      // can exceed Worked Hrs); managers see true time on site.
      const actualMins  = !noShow && actOut != null
                           ? Math.max(0, actOut - actIn)
                           : 0;
      const expectedMins = schedOut - schedIn;

      return {
        shift: s,
        employee: emp,
        actual_in:  att?.first_punch || null,
        actual_out: att?.last_punch || null,
        late_minutes:  late,
        early_minutes: earlyOut,
        worked_hours:  Math.round((workedMins / 60) * 100) / 100,
        actual_hours:  Math.round((actualMins / 60) * 100) / 100,
        expected_hours: Math.round((expectedMins / 60) * 100) / 100,
        worked_pct: expectedMins > 0
                     ? Math.round((workedMins / expectedMins) * 100)
                     : 0,
        no_show: noShow,
        status: noShow ? 'no_show'
              : (late === 0 && earlyOut === 0) ? 'on_time'
              : 'deviation',
      };
    });
  }, [shifts, attendance, employees]);

  const summary = useMemo(() => {
    const totalScheduled = rows.reduce((s, r) => s + r.expected_hours, 0);
    const totalWorked    = rows.reduce((s, r) => s + r.worked_hours, 0);
    return {
      totalShifts: rows.length,
      onTime: rows.filter(r => r.status === 'on_time').length,
      deviation: rows.filter(r => r.status === 'deviation').length,
      noShow: rows.filter(r => r.no_show).length,
      totalScheduled,
      totalWorked,
      lostHours: Math.round((totalScheduled - totalWorked) * 100) / 100,
    };
  }, [rows]);

  // ── Sort + date colouring ─────────────────────────────────────────
  //  Nadeem 2026-05-26: 'sorted by date, then day, then by location
  //  then by department, then by staff id'. Date is primary, so each
  //  date's rows are contiguous and the per-date tint reads as a clean
  //  band. (Day-of-week is derived from the date, so it's a no-op
  //  tiebreaker after date — included to honour the stated order.)
  const sortedRows = useMemo(() => {
    const copy = [...rows];
    const dow = (d) => new Date(d).getDay(); // 0=Sun … 6=Sat
    copy.sort((a, b) => {
      const dt = String(a.shift.shift_date).localeCompare(String(b.shift.shift_date));
      if (dt !== 0) return dt;
      const dy = dow(a.shift.shift_date) - dow(b.shift.shift_date);
      if (dy !== 0) return dy;
      const la = (a.employee?.location || '').localeCompare(b.employee?.location || '');
      if (la !== 0) return la;
      const de = (a.employee?.department || '').localeCompare(b.employee?.department || '');
      if (de !== 0) return de;
      return String(a.employee_id || a.shift.employee_id)
        .localeCompare(String(b.employee_id || b.shift.employee_id));
    });
    return copy;
  }, [rows]);

  // Soft tint palette keyed to each distinct shift_date (sorted).
  // {hex} for HTML/CSS + {argb} (no #) for Excel fills.
  const dateColors = useMemo(() => {
    const palette = [
      'EFF6FF', 'F0FDF4', 'FFFBEB', 'FDF4FF', 'FEF2F2', 'F0FDFA', 'FFF7ED', 'F5F3FF',
    ];
    const dates = [...new Set(rows.map(r => r.shift.shift_date))].sort();
    const map = {};
    dates.forEach((d, i) => { map[d] = palette[i % palette.length]; });
    return map;
  }, [rows]);

  // ── Excel export — styled to match the HTML report ────────────────
  //  Uses xlsx-js-style (drop-in fork of SheetJS with cell styling).
  //  Nadeem 2026-05-26: 'I want the same color styled when I export
  //  in excel'. Brand-green header, status-coloured cells, tinted
  //  totals — mirrors the HTML export's palette.
  const exportExcel = async () => {
    setExporting(true);
    try {
      const XLSX = await import('xlsx-js-style');

      // Style helpers ----------------------------------------------------
      const GREEN = '0F4C2A';
      const border = {
        top:    { style: 'thin', color: { rgb: 'E5E7EB' } },
        bottom: { style: 'thin', color: { rgb: 'E5E7EB' } },
        left:   { style: 'thin', color: { rgb: 'E5E7EB' } },
        right:  { style: 'thin', color: { rgb: 'E5E7EB' } },
      };
      const headerStyle = {
        font:      { bold: true, color: { rgb: 'FFFFFF' }, sz: 10 },
        fill:      { fgColor: { rgb: GREEN } },
        alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        border,
      };
      const cell = (extra = {}) => ({
        font: { sz: 10, color: { rgb: '1F1B16' } },
        alignment: { vertical: 'center' },
        border,
        ...extra,
      });
      const statusFill = {
        'NO SHOW':   { bg: 'FEE2E2', fg: '991B1B' },
        'DEVIATION': { bg: 'FEF3C7', fg: '854F0B' },
        'ON TIME':   { bg: 'D1FAE5', fg: '065F46' },
      };

      const headers = ['PSN ID', 'Employee Name', 'Department', 'Location', 'Date', 'Day',
        'Sched In', 'Sched Out', 'Actual In', 'Actual Out',
        'Late (min)', 'Early Out (min)',
        'Expected Hrs', 'Worked Hrs', 'Worked Time', '% Worked', 'Status', 'Notes'];

      const aoa = [headers];
      // Track which date each output row belongs to (for fill banding)
      // and which rows deviated (for red Worked Hrs text).
      const rowDate = [null];       // header row → no date
      const rowDeviation = [false];
      for (const r of sortedRows) {
        const statusLabel = r.status === 'no_show' ? 'NO SHOW'
          : r.status === 'deviation' ? 'DEVIATION' : 'ON TIME';
        aoa.push([
          r.shift.employee_id,
          r.employee?.name || '',
          r.employee?.department || '',
          r.employee?.location || '',
          r.shift.shift_date,
          new Date(r.shift.shift_date).toLocaleDateString('en-GB', { weekday: 'long' }),
          fmtTime(r.shift.clock_in_time),
          fmtTime(r.shift.clock_out_time),
          fmtTime(r.actual_in),
          fmtTime(r.actual_out),
          r.late_minutes,
          r.early_minutes,
          r.expected_hours,
          r.worked_hours,
          r.actual_hours,
          r.worked_pct,
          statusLabel,
          r.shift.notes || '',
        ]);
        rowDate.push(r.shift.shift_date);
        rowDeviation.push(r.status === 'deviation');
      }
      // Blank + totals row
      aoa.push([]);
      rowDate.push(null); rowDeviation.push(false);
      aoa.push([
        'TOTAL', '', '', '', '', '', '', '', '', '', '', '',
        summary.totalScheduled,
        summary.totalWorked,
        Math.round(sortedRows.reduce((s, r) => s + (r.actual_hours || 0), 0) * 100) / 100,
        summary.totalScheduled > 0
          ? Math.round((summary.totalWorked / summary.totalScheduled) * 100)
          : 0,
        `${summary.onTime} on-time / ${summary.deviation} dev / ${summary.noShow} no-show`,
        '',
      ]);
      rowDate.push(null); rowDeviation.push(false);

      const ws = XLSX.utils.aoa_to_sheet(aoa);

      // Apply styles cell-by-cell ---------------------------------------
      const range = XLSX.utils.decode_range(ws['!ref']);
      const statusCol = 16; // 0-indexed 'Status' column
      const totalRowIdx = aoa.length - 1;
      for (let R = range.s.r; R <= range.e.r; R++) {
        for (let C = range.s.c; C <= range.e.c; C++) {
          const addr = XLSX.utils.encode_cell({ r: R, c: C });
          if (!ws[addr]) continue;
          if (R === 0) {
            ws[addr].s = headerStyle;
          } else if (R === totalRowIdx) {
            // Totals row — bold, light-grey fill
            ws[addr].s = cell({
              font: { bold: true, sz: 10, color: { rgb: '0A0A0A' } },
              fill: { fgColor: { rgb: 'F3F4F6' } },
              alignment: { vertical: 'center',
                horizontal: (C >= 12 && C <= 15) ? 'right' : 'left' },
            });
          } else {
            // Body cell
            const numericRight = (C >= 10 && C <= 15);
            const dateFill = rowDate[R] ? dateColors[rowDate[R]] : null;
            let style = cell({
              alignment: { vertical: 'center',
                horizontal: numericRight ? 'right'
                  : (C >= 6 && C <= 9) ? 'center' : 'left' },
              ...(dateFill ? { fill: { fgColor: { rgb: dateFill } } } : {}),
            });
            // Worked Hrs column (C===13) → red bold text on deviation rows
            if (C === 13 && rowDeviation[R]) {
              style = cell({
                font: { bold: true, sz: 10, color: { rgb: 'DC2626' } },
                alignment: { horizontal: 'right', vertical: 'center' },
                ...(dateFill ? { fill: { fgColor: { rgb: dateFill } } } : {}),
              });
            }
            // Colour the Status cell to match the HTML pills (overrides date fill)
            if (C === statusCol) {
              const label = ws[addr].v;
              const sc = statusFill[label];
              if (sc) {
                style = cell({
                  font: { bold: true, sz: 10, color: { rgb: sc.fg } },
                  fill: { fgColor: { rgb: sc.bg } },
                  alignment: { horizontal: 'center', vertical: 'center' },
                });
              }
            }
            ws[addr].s = style;
          }
        }
      }

      // Column widths
      ws['!cols'] = [
        { wch: 9 },  { wch: 26 }, { wch: 12 }, { wch: 9 },  { wch: 11 }, { wch: 10 },
        { wch: 9 },  { wch: 9 },  { wch: 9 },  { wch: 10 }, { wch: 9 },  { wch: 12 },
        { wch: 11 }, { wch: 10 }, { wch: 11 }, { wch: 9 },  { wch: 11 }, { wch: 40 },
      ];
      // Freeze header row
      ws['!freeze'] = { xSplit: 0, ySplit: 1 };

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, period.name.slice(0, 31));
      const fileName = `OT_${period.name.replace(/[^a-z0-9]+/gi, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, fileName);
    } catch (e) {
      setErr(e?.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  // ── HTML clean-style export ────────────────────────────────────────
  //
  //  Opens a print-ready report in a new browser tab. Same content
  //  shape as the Excel — summary cards, full per-shift table — but
  //  styled like the Staff Attendance Report (Calibri, neutral
  //  palette, ESAU letterhead) so it prints cleanly for management
  //  sign-off or PDF archival. Nadeem 2026-05-26: 'should also have
  //  option for HTML clean style export'.
  //
  const exportHtml = () => {
    try {
      const esc = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const fmtDate = (d) => {
        if (!d) return '—';
        const dt = new Date(d);
        return dt.toLocaleDateString('en-GB', {
          weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        });
      };
      const statusPill = (s) => {
        const map = {
          on_time:   { bg: '#D1FAE5', fg: '#065F46', label: 'ON TIME' },
          deviation: { bg: '#FEF3C7', fg: '#854F0B', label: 'DEVIATION' },
          no_show:   { bg: '#FEE2E2', fg: '#991B1B', label: 'NO SHOW' },
        };
        const p = map[s] || map.on_time;
        return `<span style="background:${p.bg};color:${p.fg};padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.04em">${p.label}</span>`;
      };
      // Date colour legend + flat table sorted Location → Dept → Date
      // → Name. Each row tinted by its date so the date dimension stays
      // visible despite the location/department ordering.
      const dateLegend = Object.entries(dateColors)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([d, hex]) =>
          `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:12px">
             <span style="width:12px;height:12px;border-radius:2px;background:#${hex};border:1px solid rgba(0,0,0,0.1)"></span>
             ${esc(fmtDate(d))}
           </span>`).join('');

      const tableRows = sortedRows.map(r => {
        const tint = dateColors[r.shift.shift_date] || 'FFFFFF';
        const workedColor = r.status === 'deviation' ? '#DC2626' : '#1F1B16';
        return `
          <tr style="background:#${tint}">
            <td>${esc(fmtDate(r.shift.shift_date))}</td>
            <td>${esc(r.employee?.name || r.shift.employee_id)}<br/>
              <span style="color:#555;font-size:10px">${esc(r.shift.employee_id)} · ${esc(r.employee?.department || '')}${r.employee?.location ? ' · ' + esc(r.employee.location) : ''}</span></td>
            <td style="text-align:center">${esc(fmtTime(r.shift.clock_in_time))}–${esc(fmtTime(r.shift.clock_out_time))}</td>
            <td style="text-align:center">${r.actual_in
              ? `${esc(fmtTime(r.actual_in))}–${r.actual_out ? esc(fmtTime(r.actual_out)) : '<span style="color:#991B1B">missing</span>'}`
              : '<span style="color:#991B1B">—</span>'}</td>
            <td style="text-align:right;font-variant-numeric:tabular-nums">${r.late_minutes > 0 ? '<strong style="color:#B45309">' + r.late_minutes + 'm</strong>' : '—'}</td>
            <td style="text-align:right;font-variant-numeric:tabular-nums">${r.early_minutes > 0 ? '<strong style="color:#B45309">' + r.early_minutes + 'm</strong>' : '—'}</td>
            <td style="text-align:right;font-variant-numeric:tabular-nums">${Number(r.expected_hours).toFixed(1)}h</td>
            <td style="text-align:right;font-variant-numeric:tabular-nums"><strong style="color:${workedColor}">${Number(r.worked_hours).toFixed(1)}h</strong></td>
            <td style="text-align:right;font-variant-numeric:tabular-nums">${r.no_show ? '<span style="color:#991B1B">—</span>' : Number(r.actual_hours).toFixed(1) + 'h'}</td>
            <td style="text-align:center">${statusPill(r.status)}</td>
            <td style="font-size:10px;color:#555">${esc(r.shift.notes || '')}</td>
          </tr>
        `;
      }).join('');

      const dateSections = `
        <div class="legend">Dates: ${dateLegend}</div>
        <table>
          <thead>
            <tr>
              <th style="width:10%">Date</th>
              <th style="width:18%">Employee</th>
              <th style="width:9%">Scheduled</th>
              <th style="width:9%">Actual</th>
              <th style="width:6%;text-align:right">Late</th>
              <th style="width:6%;text-align:right">Early</th>
              <th style="width:8%;text-align:right">Sched Hrs</th>
              <th style="width:8%;text-align:right">Worked Hrs</th>
              <th style="width:8%;text-align:right">Worked Time</th>
              <th style="width:8%;text-align:center">Status</th>
              <th>Task</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      `;
      const totalPct = summary.totalScheduled > 0
        ? Math.round((summary.totalWorked / summary.totalScheduled) * 100)
        : 0;
      const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>OT Report — ${esc(period.name)}</title>
<style>
  @page { size: A4 landscape; margin: 14mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Calibri', 'Segoe UI', sans-serif; color: #1F1B16; font-size: 11px; margin: 0; padding: 20px; background: #fff; }
  .report-header { border-bottom: 2px solid #0F4C2A; padding-bottom: 12px; margin-bottom: 16px; }
  .kicker { font-size: 9px; letter-spacing: .3em; color: #0F4C2A; font-weight: 700; text-transform: uppercase; }
  h1 { font-size: 22px; margin: 4px 0 2px; color: #0A0A0A; }
  .sub { font-size: 11px; color: #555; }
  .meta { display: flex; gap: 18px; margin-top: 8px; font-size: 10px; color: #1F1B16; }
  .meta strong { color: #0A0A0A; }
  .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
  .card { border: 1px solid rgba(0,0,0,0.08); border-radius: 6px; padding: 8px 10px; }
  .card .lbl { font-size: 9px; letter-spacing: .15em; color: #555; text-transform: uppercase; }
  .card .val { font-size: 18px; font-weight: 700; margin-top: 2px; color: #0A0A0A; }
  .card .sub-val { font-size: 10px; color: #666; margin-top: 1px; }
  .card.bad   { border-color: #FCA5A5; background: #FEF2F2; }
  .card.warn  { border-color: #FCD34D; background: #FFFBEB; }
  .card.ok    { border-color: #A7F3D0; background: #F0FDF4; }
  .card.info  { border-color: #BFDBFE; background: #EFF6FF; }
  .lost-banner { background: #FEF2F2; border-left: 4px solid #DC2626; padding: 8px 12px; margin-bottom: 16px; font-size: 11px; }
  .legend { font-size: 10px; color: #444; margin-bottom: 10px; display: flex; flex-wrap: wrap; align-items: center; }
  section.day { page-break-inside: avoid; margin-bottom: 18px; }
  section.day h3 { font-size: 13px; margin: 12px 0 6px; color: #0F4C2A; border-bottom: 1px solid #D1D5DB; padding-bottom: 4px; }
  section.day h3 .count { font-size: 10px; color: #666; font-weight: 400; margin-left: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th { background: #F3F4F6; padding: 6px 8px; text-align: left; border-bottom: 1px solid #D1D5DB; font-weight: 700; color: #0A0A0A; font-size: 10px; letter-spacing: .04em; text-transform: uppercase; }
  td { padding: 6px 8px; border-bottom: 1px solid #F3F4F6; vertical-align: top; }
  tr:hover td { background: #FAFAFA; }
  .footer { margin-top: 20px; padding-top: 10px; border-top: 1px solid #D1D5DB; font-size: 9px; color: #666; display: flex; justify-content: space-between; }
  @media print { .no-print { display: none !important; } body { padding: 0; } }
  .print-bar { position: sticky; top: 0; background: #fff; padding: 10px 0; margin-bottom: 10px; border-bottom: 1px solid #E5E7EB; }
  .print-btn { background: #0F4C2A; color: #fff; padding: 6px 14px; border: 0; border-radius: 4px; cursor: pointer; font-size: 12px; font-weight: 600; }
</style>
</head>
<body>
  <div class="print-bar no-print">
    <button class="print-btn" onclick="window.print()">Print / Save as PDF</button>
  </div>
  <header class="report-header">
    <div class="kicker">Evergreen Shipping Agency Saudi Co. (L.L.C) · ESAU HR</div>
    <h1>OT Report — ${esc(period.name)}</h1>
    <div class="sub">Strict comparison · no grace period · ${esc(fmtDate(period.start_date))} → ${esc(fmtDate(period.end_date))}</div>
    <div class="meta">
      <span><strong>Generated:</strong> ${esc(new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</span>
      <span><strong>Shifts:</strong> ${rows.length}</span>
      <span><strong>Unique staff:</strong> ${new Set(rows.map(r => r.shift.employee_id)).size}</span>
    </div>
  </header>

  <div class="summary">
    <div class="card ok">
      <div class="lbl">On time</div>
      <div class="val">${summary.onTime}</div>
      <div class="sub-val">of ${rows.length} shifts</div>
    </div>
    <div class="card warn">
      <div class="lbl">Deviation</div>
      <div class="val">${summary.deviation}</div>
      <div class="sub-val">late or early-out</div>
    </div>
    <div class="card bad">
      <div class="lbl">No show</div>
      <div class="val">${summary.noShow}</div>
      <div class="sub-val">no punch recorded</div>
    </div>
    <div class="card info">
      <div class="lbl">Worked / scheduled</div>
      <div class="val">${summary.totalWorked.toFixed(1)}h / ${summary.totalScheduled.toFixed(1)}h</div>
      <div class="sub-val">${totalPct}% of scheduled</div>
    </div>
  </div>

  ${(summary.deviation + summary.noShow) > 0 && (summary.totalScheduled - summary.totalWorked) > 0 ? `
  <div class="lost-banner">
    <strong>Lost hours:</strong> ${(summary.totalScheduled - summary.totalWorked).toFixed(1)}h
    (from deviation + no-show). Payroll-relevant figure.
  </div>
  ` : ''}

  ${dateSections}

  <div class="footer">
    <span>OT Report · ${esc(period.name)} · generated from ESAU HR portal</span>
    <span>Strict-comparison formula · matches OT Report Excel export</span>
  </div>
</body>
</html>`;
      const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
      const url  = URL.createObjectURL(blob);
      const w    = window.open(url, '_blank');
      if (!w) {
        // Pop-up blocked — fall back to direct download
        const a = document.createElement('a');
        a.href = url;
        a.download = `OT_${period.name.replace(/[^a-z0-9]+/gi, '_')}_${new Date().toISOString().slice(0, 10)}.html`;
        a.click();
      }
      // Revoke the URL after the new tab has had a chance to load
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      setErr(e?.message || 'HTML export failed');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto">
      <div className="rounded-xl bg-white w-full max-w-5xl shadow-2xl my-8">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
          <div>
            <h3 className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
              OT Report · {period.name}
            </h3>
            <p className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
              Strict comparison · no grace period · {fmtDayDate(period.start_date)} → {fmtDayDate(period.end_date)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={exportHtml} disabled={rows.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded border disabled:opacity-50"
              style={{ borderColor: '#0F4C2A', color: '#0F4C2A', background: '#FFFFFF' }}
              title="Open in a new tab — print or save as PDF">
              <FileText size={12} /> Export HTML
            </button>
            <button
              onClick={exportExcel} disabled={exporting || rows.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded text-white disabled:opacity-50"
              style={{ background: '#0F4C2A' }}>
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
              {exporting ? 'Exporting…' : 'Export Excel'}
            </button>
            <button onClick={onClose} className="p-2 rounded hover:bg-black/[0.05]">
              <X size={16} style={{ color: '#1F1B16', opacity: 0.6 }} />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center gap-2 text-xs" style={{ color: '#1F1B16', opacity: 0.7 }}>
              <Loader2 size={12} className="animate-spin" /> Computing report…
            </div>
          ) : err ? (
            <div className="flex items-center gap-2 text-xs rounded px-3 py-2"
                 style={{ background: '#FEF2F2', color: '#991B1B' }}>
              <AlertCircle size={12} /> {err}
            </div>
          ) : rows.length === 0 ? (
            <div className="text-center py-8 text-sm" style={{ color: '#1F1B16', opacity: 0.65 }}>
              No approved shifts for this period yet.
            </div>
          ) : (
            <>
              {/* Summary */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <SummaryCell label="ON TIME"      count={summary.onTime}    bg="#D1FAE5" fg="#065F46" />
                <SummaryCell label="DEVIATION"    count={summary.deviation} bg="#FEF3C7" fg="#854F0B" />
                <SummaryCell label="NO SHOW"      count={summary.noShow}    bg="#FEE2E2" fg="#991B1B" />
                <SummaryCell label="WORKED / SCHED"
                             count={`${summary.totalWorked.toFixed(1)} / ${summary.totalScheduled.toFixed(1)}h`}
                             bg="#DBEAFE" fg="#1D4ED8" />
              </div>

              {summary.lostHours > 0 && (
                <div className="text-xs px-3 py-2 rounded"
                     style={{ background: '#FEF3C7', color: '#854F0B' }}>
                  <strong>Lost hours: {summary.lostHours.toFixed(1)}h</strong> (deviation + no-show).
                  Payroll-relevant figure.
                </div>
              )}

              {/* Table */}
              <div className="overflow-x-auto rounded border" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
                <table className="w-full text-xs">
                  <thead style={{ background: '#FAFAF6' }}>
                    <tr>
                      <Th>Date</Th>
                      <Th>Employee</Th>
                      <Th>Sched</Th>
                      <Th>Actual</Th>
                      <Th>Late</Th>
                      <Th>Early</Th>
                      <Th>Worked</Th>
                      <Th>Worked Time</Th>
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((r, i) => (
                      <tr key={i} className="border-t"
                          style={{
                            borderColor: 'rgba(0,0,0,0.05)',
                            background: `#${dateColors[r.shift.shift_date] || 'FFFFFF'}`,
                          }}>
                        <Td>{fmtDayDate(r.shift.shift_date)}</Td>
                        <Td>
                          <div className="font-medium" style={{ color: '#1F1B16' }}>{r.employee?.name || r.shift.employee_id}</div>
                          <div style={{ color: '#1F1B16', opacity: 0.55 }}>{r.shift.employee_id} · {r.employee?.department || ''}{r.employee?.location ? ' · ' + r.employee.location : ''}</div>
                        </Td>
                        <Td className="font-mono">
                          {fmtTime(r.shift.clock_in_time)}–{fmtTime(r.shift.clock_out_time)}
                          <div style={{ opacity: 0.6 }}>{r.expected_hours.toFixed(1)}h</div>
                        </Td>
                        <Td className="font-mono">
                          {r.no_show ? <span style={{ color: '#991B1B' }}>—</span> : `${fmtTime(r.actual_in)}–${fmtTime(r.actual_out)}`}
                        </Td>
                        <Td>
                          {r.late_minutes > 0
                            ? <span style={{ color: '#B45309', fontWeight: 700 }}>{r.late_minutes}m</span>
                            : <span style={{ color: '#1F1B16', opacity: 0.4 }}>—</span>}
                        </Td>
                        <Td>
                          {r.early_minutes > 0
                            ? <span style={{ color: '#B45309', fontWeight: 700 }}>{r.early_minutes}m</span>
                            : <span style={{ color: '#1F1B16', opacity: 0.4 }}>—</span>}
                        </Td>
                        <Td className="font-mono">
                          {/* Red when this shift deviated (late/early-out) */}
                          <strong style={{ color: r.status === 'deviation' ? '#DC2626' : '#1F1B16' }}>
                            {r.worked_hours.toFixed(2)}h
                          </strong>
                          <span style={{ opacity: 0.5 }}> / {r.expected_hours.toFixed(1)}</span>
                        </Td>
                        <Td className="font-mono">
                          {r.no_show
                            ? <span style={{ color: '#991B1B' }}>—</span>
                            : <span>{r.actual_hours.toFixed(2)}h</span>}
                        </Td>
                        <Td>
                          <StatusBadge status={r.status} />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.55 }}>
                Worked hrs = max(0, min(actual_out, sched_out) − max(actual_in, sched_in)) — strict, capped to schedule.
                Worked Time = full span first → last punch (can exceed Worked hrs when staff stay beyond the window).
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SummaryCell({ label, count, bg, fg }) {
  return (
    <div className="rounded px-3 py-2 text-center" style={{ background: bg }}>
      <div className="text-[9px] font-bold tracking-wider" style={{ color: fg, opacity: 0.85 }}>
        {label}
      </div>
      <div className="text-base font-bold" style={{ color: fg }}>
        {count}
      </div>
    </div>
  );
}

const Th = ({ children }) => (
  <th className="px-2 py-1.5 text-left text-[10px] font-bold tracking-wider"
      style={{ color: '#0A0A0A', opacity: 0.7 }}>
    {children}
  </th>
);
const Td = ({ children, className = '' }) => (
  <td className={`px-2 py-1.5 align-top ${className}`} style={{ color: '#1F1B16' }}>
    {children}
  </td>
);

function StatusBadge({ status }) {
  const map = {
    on_time:   { bg: '#D1FAE5', fg: '#065F46', label: 'ON TIME',   Icon: CheckCircle2 },
    deviation: { bg: '#FEF3C7', fg: '#854F0B', label: 'DEVIATION', Icon: AlertTriangle },
    no_show:   { bg: '#FEE2E2', fg: '#991B1B', label: 'NO SHOW',   Icon: MinusCircle },
  };
  const s = map[status] || map.on_time;
  const Icon = s.Icon;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold text-[9px]"
          style={{ background: s.bg, color: s.fg, letterSpacing: '0.04em' }}>
      <Icon size={9} /> {s.label}
    </span>
  );
}
