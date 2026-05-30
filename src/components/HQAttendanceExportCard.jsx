// ──────────────────────────────────────────────────────────────────────
//  HQAttendanceExportCard
//
//  Produces Evergreen Taiwan HQ's annual attendance summary workbook
//  ("ESAU HQ REPORT") — one row per employee, aggregating the year's
//  leave / lateness / early-leave / missed-punch / absence figures into
//  the exact bilingual (中文 / English) column layout HQ expects.
//
//  Source of truth for the schema is the live DB as exercised by the
//  rest of the app (per CLAUDE.md: trust the writes, not the migration
//  files). The CONFIG block below names every table + column this card
//  reads, plus the category→leave_type mapping and the hour-conversion
//  assumptions. If HQ's mapping ever changes, edit CONFIG only — the
//  aggregation + export read everything from it.
//
//  Gated to admin / HR reviewer on the Dashboard.
// ──────────────────────────────────────────────────────────────────────

import React, { useState } from 'react';
import { Download, Loader2, FileSpreadsheet } from 'lucide-react';
import { directGet } from '../supabaseClient.js';

// ════════════════════════════════════════════════════════════════════
//  CONFIG — table + column names matched to the REAL Supabase schema
//  (verified against migration_attendance_daily.sql + the leave/
//  permission code paths). Adjust here if the schema or HQ's category
//  mapping changes.
// ════════════════════════════════════════════════════════════════════
const CONFIG = {
  // ── Tables ────────────────────────────────────────────────────────
  tables: {
    attendanceDaily: 'attendance_daily',   // per-day punch + status rows
    leaveRequests:   'leave_requests',      // formal leave (day-based)
    employees:       'employees',           // roster + name/dept/location
  },

  // ── attendance_daily columns ──────────────────────────────────────
  //  status check (live): present | late | short | absent |
  //                       annual_leave | sick_leave | off_day | off_roster
  attendance: {
    employeeId:        'employee_id',
    date:              'attendance_date',
    status:            'status',
    firstPunch:        'first_punch',
    lastPunch:         'last_punch',
    punchCount:        'punch_count',
    lateMinutes:       'late_minutes',
    earlyLeaveMinutes: 'early_leave_minutes',
    // status values that drive the HQ counters
    statusLate:    'late',
    statusAbsent:  'absent',
    statusPresent: 'present',
    statusShort:   'short',
  },

  // ── leave_requests columns ────────────────────────────────────────
  leave: {
    employeeId:  'employee_id',
    typeId:      'leave_type_id',
    startDate:   'start_date',
    endDate:     'end_date',
    days:        'days',          // real column (Number(r.days))
    isHalfDay:   'is_half_day',
    // approval lives in stage (new) with status as legacy fallback
    stage:       'stage',
    status:      'status',
    approvedValue: 'approved',
  },

  // ── employees columns ─────────────────────────────────────────────
  employee: {
    id:         'id',             // e.g. 'H94076'
    name:       'name',
    department: 'department',     // BIZ / CSD / FIN / LOG / SUP
    location:   'location',       // DMM / JED / RYD
    psnPrefix:  'H',              // stripped for HQ's numeric PSN column
  },

  // ── HQ leave-category → our leave_type_id mapping ─────────────────
  //  HQ's annual sheet splits leave into four buckets. Our leave_type
  //  ids are: annual, sick, emergency, hajj, maternity, paternity,
  //  marriage, bereavement, unpaid. The mapping below is the closest
  //  defensible fit; tweak if HQ classifies differently.
  leaveCategory: {
    personal: ['emergency'],                 // 事假 Personal Leave
    sickPaid: ['sick'],                       // 病假 Sick Leave w/ Pay
    annual:   ['annual'],                     // 特休 Annual Leave
    sickUnpaid: ['unpaid'],                   // 無給住院病假 Sick Leave w/o Pay
    // (hajj / maternity / paternity / marriage / bereavement are not in
    //  HQ's sheet; left out of all buckets by design.)
  },

  // ── Conversions / assumptions ─────────────────────────────────────
  //  HQ reports leave in HOURS (Taiwan is hours-based); our leave is
  //  day-based, so hours = days × workdayHours. Absence hours use the
  //  same factor. A half-day counts as 0.5 day. Adjust workdayHours if
  //  HQ expects a different standard day.
  workdayHours: 8,
};

// ── helpers ─────────────────────────────────────────────────────────
const isApprovedLeave = (r) =>
  (r[CONFIG.leave.stage] || r[CONFIG.leave.status]) === CONFIG.leave.approvedValue;

const leaveDays = (r) => {
  const d = Number(r[CONFIG.leave.days] || 0);
  if (d > 0) return d;
  // fallback: inclusive calendar-day span
  const a = r[CONFIG.leave.startDate], b = r[CONFIG.leave.endDate];
  if (!a || !b) return 0;
  const span = Math.round((new Date(b) - new Date(a)) / 86400000) + 1;
  return r[CONFIG.leave.isHalfDay] ? 0.5 : Math.max(1, span);
};

const round1 = (n) => Math.round(n * 10) / 10;

// HQ column layout — exact bilingual headers, in order.
const HQ_HEADERS = [
  '勤惰所屬年度\nYear',
  'name',
  '人事代號\nPSN No.',
  '公司代碼\nCompany',
  '事假次數\n整數位3碼\nPersonal Leave (Times)',
  '事假時數\n整數位4碼 小數位1碼\nPersonal Leave (Hours)',
  '病假次數\n整數位3碼\nSick Leave w/ Pay (Times)',
  '病假時數\n整數位4碼 小數位1碼\nSick Leave w/ Pay (Hours)',
  '遲到次數\n整數位3碼\nLateness (Times)',
  '遲到分數\n整數位4碼\nLateness (Minutes)',
  '早退次數\n整數位3碼\nEarly Leave (Times)',
  '早退分數\n整數位3碼\nEarly Leave (Minutes)',
  '忘刷上班卡次數\n整數位3碼\nForget to sign-on (Times)',
  '忘刷下班卡次數\n整數位3碼\nForget to sign-off (Times)',
  '曠職次數\n整數位3碼\nAbsence w/o Approval (Times)',
  '曠職時數\n整數位3碼 小數位1碼\nAbsence w/o Approval (Hours)',
  '特休次數\n整數位3碼\nAnnual Leave (Times)',
  '特休天數\n整數位2碼 小數位1碼\nAnnual Leave (Days)',
  '無給住院病假次數\n整數位3碼\nSick Leave w/o Pay (Times)',
  '無給住院病假時數\n整數位4碼 小數位1碼\nSick Leave w/o Pay (Hours)',
];

export default function HQAttendanceExportCard({ me, employees = [] }) {
  // Default to the current "Sep→Sep" HQ fiscal year label
  const now = new Date();
  const fyStart = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1; // Sep = month 8
  const [fromYear, setFromYear] = useState(fyStart);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // HQ fiscal year runs 01 Sep → 31 Aug
  const periodFrom = `${fromYear}-09-01`;
  const periodTo   = `${fromYear + 1}-08-31`;
  const yearLabel  = `${fromYear}-${fromYear + 1}`;

  const C = CONFIG;
  const empById = React.useMemo(() => {
    const m = {};
    for (const e of employees) m[e[C.employee.id]] = e;
    return m;
  }, [employees]);

  const buildAndExport = async () => {
    setBusy(true); setErr('');
    try {
      const XLSX = await import('xlsx-js-style');

      // ── Pull attendance_daily for the fiscal year ──────────────────
      const att = await directGet(
        C.tables.attendanceDaily,
        `select=${C.attendance.employeeId},${C.attendance.date},${C.attendance.status},`
        + `${C.attendance.firstPunch},${C.attendance.lastPunch},${C.attendance.punchCount},`
        + `${C.attendance.lateMinutes},${C.attendance.earlyLeaveMinutes}`
        + `&${C.attendance.date}=gte.${periodFrom}`
        + `&${C.attendance.date}=lte.${periodTo}`,
        { timeoutMs: 20000 }
      );

      // ── Pull approved leave overlapping the fiscal year ────────────
      const lv = await directGet(
        C.tables.leaveRequests,
        `select=${C.leave.employeeId},${C.leave.typeId},${C.leave.startDate},`
        + `${C.leave.endDate},${C.leave.days},${C.leave.isHalfDay},`
        + `${C.leave.stage},${C.leave.status}`
        + `&${C.leave.startDate}=lte.${periodTo}`
        + `&${C.leave.endDate}=gte.${periodFrom}`,
        { timeoutMs: 20000 }
      );

      // ── Aggregate per employee ─────────────────────────────────────
      const agg = {}; // psn -> counters
      const blank = () => ({
        personalTimes: 0, personalHours: 0,
        sickPaidTimes: 0, sickPaidHours: 0,
        lateTimes: 0, lateMinutes: 0,
        earlyTimes: 0, earlyMinutes: 0,
        forgetOn: 0, forgetOff: 0,
        absenceTimes: 0, absenceHours: 0,
        annualTimes: 0, annualDays: 0,
        sickUnpaidTimes: 0, sickUnpaidHours: 0,
      });
      const get = (psn) => (agg[psn] = agg[psn] || blank());

      // Attendance-derived counters
      for (const r of (att || [])) {
        const psn = r[C.attendance.employeeId];
        if (!psn) continue;
        const a = get(psn);
        const st = r[C.attendance.status];
        const lateMin  = Number(r[C.attendance.lateMinutes] || 0);
        const earlyMin = Number(r[C.attendance.earlyLeaveMinutes] || 0);

        if (st === C.attendance.statusLate || lateMin > 0) {
          a.lateTimes += 1; a.lateMinutes += lateMin;
        }
        if (earlyMin > 0) {
          a.earlyTimes += 1; a.earlyMinutes += earlyMin;
        }
        if (st === C.attendance.statusAbsent) {
          a.absenceTimes += 1;
          a.absenceHours += C.workdayHours;
        }
        // Missed punches: a worked day with one side of the punch pair
        // missing. Only meaningful on days the person was expected in
        // (present/late/short), not on leave/off rows.
        const worked = [C.attendance.statusPresent, C.attendance.statusLate, C.attendance.statusShort].includes(st);
        if (worked) {
          if (!r[C.attendance.firstPunch]) a.forgetOn += 1;
          if (!r[C.attendance.lastPunch])  a.forgetOff += 1;
        }
      }

      // Leave-derived counters
      const catOf = (typeId) => {
        for (const [cat, ids] of Object.entries(C.leaveCategory)) {
          if (ids.includes(typeId)) return cat;
        }
        return null;
      };
      for (const r of (lv || [])) {
        if (!isApprovedLeave(r)) continue;
        const psn = r[C.leave.employeeId];
        if (!psn) continue;
        const a = get(psn);
        const days = leaveDays(r);
        const cat = catOf(r[C.leave.typeId]);
        if (cat === 'personal')   { a.personalTimes += 1; a.personalHours += days * C.workdayHours; }
        else if (cat === 'sickPaid')   { a.sickPaidTimes += 1; a.sickPaidHours += days * C.workdayHours; }
        else if (cat === 'annual')     { a.annualTimes += 1; a.annualDays += days; }
        else if (cat === 'sickUnpaid') { a.sickUnpaidTimes += 1; a.sickUnpaidHours += days * C.workdayHours; }
      }

      // ── Build rows (one per employee that has any activity OR exists
      //    in the roster). We include every active employee so HQ gets a
      //    complete sheet; zero-activity rows are all zeros. ───────────
      const psnPrefix = C.employee.psnPrefix;
      const stripPrefix = (id) => (psnPrefix && String(id).startsWith(psnPrefix))
        ? String(id).slice(psnPrefix.length) : String(id);

      const rowsFor = employees.length
        ? employees.map(e => e[C.employee.id])
        : Object.keys(agg);

      const aoa = [HQ_HEADERS];
      for (const psn of rowsFor) {
        const e = empById[psn] || {};
        const a = agg[psn] || blank();
        const company = [e[C.employee.location], e[C.employee.department]]
          .filter(Boolean).join('-');
        aoa.push([
          yearLabel,
          e[C.employee.name] || psn,
          stripPrefix(psn),
          company,
          a.personalTimes,           round1(a.personalHours),
          a.sickPaidTimes,           round1(a.sickPaidHours),
          a.lateTimes,               Math.round(a.lateMinutes),
          a.earlyTimes,              Math.round(a.earlyMinutes),
          a.forgetOn,                a.forgetOff,
          a.absenceTimes,            round1(a.absenceHours),
          a.annualTimes,             round1(a.annualDays),
          a.sickUnpaidTimes,         round1(a.sickUnpaidHours),
        ]);
      }

      // ── Style + write ──────────────────────────────────────────────
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const GREEN = '0F4C2A';
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let Ci = range.s.c; Ci <= range.e.c; Ci++) {
        const addr = XLSX.utils.encode_cell({ r: 0, c: Ci });
        if (ws[addr]) ws[addr].s = {
          font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 9 },
          fill: { fgColor: { rgb: GREEN } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        };
      }
      ws['!cols'] = HQ_HEADERS.map((_, i) => ({ wch: i === 1 ? 34 : i === 3 ? 12 : 11 }));
      ws['!rows'] = [{ hpt: 56 }];

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'ESAU HQ REPORT');
      XLSX.writeFile(wb, `ESAU_HQ_ATTENDANCE_${yearLabel}.xlsx`);
    } catch (e) {
      console.error('HQ export failed:', e);
      setErr(e?.message || 'Export failed. Check the console for details.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border p-5 esau-card"
         style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 rounded-lg p-2" style={{ background: 'rgba(15,76,42,0.08)' }}>
          <FileSpreadsheet size={18} style={{ color: '#0F4C2A' }} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="font-serif text-lg" style={{ color: '#0A0A0A' }}>HQ Attendance Export</h3>
          <p className="text-xs mt-0.5" style={{ color: '#1F1B16' }}>
            Annual attendance summary for Evergreen HQ (Sep → Aug) — leave, lateness,
            early-leave, missed punches and absence, in HQ's bilingual format.
          </p>

          <div className="flex flex-wrap items-center gap-2 mt-3">
            <label className="text-xs" style={{ color: '#1F1B16' }}>Fiscal year:</label>
            <select
              value={fromYear}
              onChange={(e) => setFromYear(Number(e.target.value))}
              className="text-sm rounded border px-2 py-1"
              style={{ borderColor: 'var(--border-soft)', background: '#FFF', color: '#0A0A0A' }}>
              {Array.from({ length: 5 }, (_, i) => fyStart - i + 1).map(y => (
                <option key={y} value={y}>{y}-{y + 1} (Sep {y} → Aug {y + 1})</option>
              ))}
            </select>

            <button
              onClick={buildAndExport}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded text-white disabled:opacity-60"
              style={{ background: '#0F4C2A' }}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {busy ? 'Building…' : 'Export Excel'}
            </button>
          </div>

          {err && (
            <p className="text-xs mt-2" style={{ color: '#B83A2E' }}>{err}</p>
          )}
          <p className="text-[11px] mt-2" style={{ color: '#1F1B16' }}>
            Period: {periodFrom} → {periodTo}. Leave hours = days × {CONFIG.workdayHours}.
            Personal = emergency leave; Sick w/ pay = sick; Annual = annual; Sick w/o pay = unpaid.
          </p>
        </div>
      </div>
    </div>
  );
}
