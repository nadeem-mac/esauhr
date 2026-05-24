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
  X, Download, Loader2, AlertCircle, Clock,
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
      const expectedMins = schedOut - schedIn;

      return {
        shift: s,
        employee: emp,
        actual_in:  att?.first_punch || null,
        actual_out: att?.last_punch || null,
        late_minutes:  late,
        early_minutes: earlyOut,
        worked_hours:  Math.round((workedMins / 60) * 100) / 100,
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

  // ── Excel export — matches SAJED template shape ───────────────────
  const exportExcel = async () => {
    setExporting(true);
    try {
      const XLSX = await import('xlsx');
      const sheet = [
        ['PSN ID', 'Employee Name', 'Department', 'Date', 'Day',
         'Sched In', 'Sched Out', 'Actual In', 'Actual Out',
         'Late (min)', 'Early Out (min)',
         'Expected Hrs', 'Worked Hrs', '% Worked', 'Status', 'Notes'],
      ];
      for (const r of rows) {
        sheet.push([
          r.shift.employee_id,
          r.employee?.name || '',
          r.employee?.department || '',
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
          r.worked_pct,
          r.status === 'no_show'   ? 'NO SHOW'
          : r.status === 'deviation' ? 'DEVIATION'
          : 'ON TIME',
          r.shift.notes || '',
        ]);
      }
      // Totals row
      sheet.push([]);
      sheet.push([
        '', '', '', '', '', '', '', '', '', '', 'TOTAL',
        summary.totalScheduled,
        summary.totalWorked,
        summary.totalScheduled > 0
          ? Math.round((summary.totalWorked / summary.totalScheduled) * 100)
          : 0,
        `${summary.onTime} on-time / ${summary.deviation} deviation / ${summary.noShow} no-show`,
        '',
      ]);

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(sheet);
      XLSX.utils.book_append_sheet(wb, ws, period.name.slice(0, 31));

      const fileName = `OT_${period.name.replace(/[^a-z0-9]+/gi, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
      XLSX.writeFile(wb, fileName);
    } catch (e) {
      setErr(e?.message || 'Export failed');
    } finally {
      setExporting(false);
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
                      <Th>Status</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-t" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
                        <Td>{fmtDayDate(r.shift.shift_date)}</Td>
                        <Td>
                          <div className="font-medium" style={{ color: '#1F1B16' }}>{r.employee?.name || r.shift.employee_id}</div>
                          <div style={{ color: '#1F1B16', opacity: 0.55 }}>{r.shift.employee_id} · {r.employee?.department}</div>
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
                          <strong>{r.worked_hours.toFixed(2)}h</strong>
                          <span style={{ opacity: 0.5 }}> / {r.expected_hours.toFixed(1)}</span>
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
                Worked hrs = max(0, min(actual_out, sched_out) − max(actual_in, sched_in)).
                Strict, no grace. Late arrival AND early departure both reduce the figure.
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
