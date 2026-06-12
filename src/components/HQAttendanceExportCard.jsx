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
import { directGet, directGetAll } from '../supabaseClient.js';
import { excelHeaderRgb } from '../lib/excelHeader.js';

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
    publicHolidays:  'public_holidays',     // official holiday dates
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

  // ── HQ late / early-leave criteria (THIS REPORT ONLY) ─────────────
  //  Nadeem 2026-05-31: for the HQ report, lateness and early-leave are
  //  computed straight from the uploaded punch history (first_punch /
  //  last_punch) using HQ's own thresholds — NOT from the stored
  //  status / late_minutes (which the daily pipeline derived with a
  //  different, 17:00 standard end). This keeps the HQ definition fixed
  //  and independent of how each row was originally classified.
  //    • Late      = clock-in strictly AFTER 08:15. Minutes measured
  //                  from the scheduled start (08:00), mirroring the
  //                  app's own late-minute convention.
  //    • Early     = clock-out strictly BEFORE the applicable end.
  //                  Minutes measured from that end.
  //        - Standard staff end 16:15.
  //        - SUP team / "safe leaving at 4 PM" staff end 16:00, so a
  //          16:00 departure is NOT early for them.
  hq: {
    scheduledStart: '08:00:00',
    lateCutoff:     '08:15:00',
    endStandard:    '16:15:00',
    endSupFourPm:   '16:00:00',
    // The device exports a raw punch stream with no in/out labels, so a
    // day with only ONE punch is ambiguous. We disambiguate by time of
    // day: a punch before midday is treated as the clock-IN (so the day
    // is "forgot to sign off"); a punch at/after midday is treated as
    // the clock-OUT (so the day is "forgot to sign on"). Without this,
    // every single-punch day collapses to "forgot sign-off" and a lone
    // afternoon punch is wrongly scored as hours late. Nadeem 2026-05-31.
    middayCutoff:   '12:00:00',
  },
  //  Staff whose day ends at 16:00. Primary signal: employees.
  //  working_hours_group === 'sup_team' (fetched fresh at run time).
  //  fourPmExtraPsns is a fallback for any 4-PM staff not tagged
  //  sup_team — edit here if HQ flags more people as safe-at-4-PM.
  supGroupValue: 'sup_team',
  fourPmExtraPsns: ['H94830', 'H94458', 'H94330', 'H94712'],

  // ── Working-days-only filter ──────────────────────────────────────
  //  Nadeem 2026-05-29: the report must count ONLY working days — it
  //  must NOT count the whole month of Ramadan, weekends, or public
  //  holidays. Every counter (lateness, early-leave, absence, missed
  //  punches, and leave day/hour totals) is computed over working days
  //  only. Toggle individual exclusions here.
  exclude: {
    weekends: true,            // KSA weekend = Friday + Saturday
    publicHolidays: true,      // dates in the public_holidays table
    ramadan: true,             // the entire Hijri month of Ramadan
  },
  weekendWeekdays: [5, 6],     // JS getDay(): 5=Fri, 6=Sat
  holidayDateColumn: 'date',   // public_holidays date column
  ramadanHijriMonth: 9,        // Ramadan = 9th month of the Hijri year
};

// ── helpers ─────────────────────────────────────────────────────────
const isApprovedLeave = (r) =>
  (r[CONFIG.leave.stage] || r[CONFIG.leave.status]) === CONFIG.leave.approvedValue;

const round1 = (n) => Math.round(n * 10) / 10;

// 'HH:MM:SS' (or 'HH:MM') → minutes since midnight, seconds included as
// a fraction so rounding is accurate. Returns null for empty/bad input.
function toMin(t) {
  if (!t) return null;
  const parts = String(t).split(':').map(Number);
  if (!parts.length || Number.isNaN(parts[0])) return null;
  const [h, m = 0, s = 0] = parts;
  return h * 60 + m + s / 60;
}

// Hijri month for a Gregorian date via the Umm al-Qura calendar (the
// official KSA calendar) — used to detect Ramadan. Returns 1–12 or null
// if the runtime lacks the islamic-umalqura calendar.
function hijriMonth(dateStr) {
  try {
    return Number(new Intl.DateTimeFormat('en-u-ca-islamic-umalqura',
      { month: 'numeric', timeZone: 'UTC' }).format(new Date(dateStr + 'T12:00:00Z')));
  } catch { return null; }
}

// Iterate each YYYY-MM-DD between two dates (inclusive).
function eachDay(fromStr, toStr, fn) {
  const d = new Date(fromStr + 'T00:00:00Z');
  const end = new Date(toStr + 'T00:00:00Z');
  while (d <= end) {
    fn(d.toISOString().slice(0, 10), d.getUTCDay());
    d.setUTCDate(d.getUTCDate() + 1);
  }
}

// HQ column layout — byte-exact bilingual headers copied verbatim from
// HQ's own "ESAU HQ REPORT" template, so the workbook re-imports cleanly
// on their side. Order is fixed; do not reorder.
const HQ_HEADERS = [
  "勤惰所屬年度 Year",
  "name",
  "人事代號 \nPSN No.",
  "公司代碼 Company",
  "事假次數 整數位3碼  Personal Leave (Times)",
  "事假時數\n整數位4碼\n小數位1碼 Personal Leave\n(Hours)",
  "病假次數\n整數位3碼 Sick Leave w/ Pay\n(Times)",
  "病假時數\n整數位4碼\n小數位1碼 Sick Leave w/ Pay\n(Hours)",
  "遲到次數\n整數位3碼 Lateness\n(Times)",
  "遲到分數\n整數位4碼 Lateness\n(Minutes)",
  "早退次數\n整數位3碼\nEarly Leave\n(Times) ",
  "早退分數\n整數位3碼Early Leave\n(Minutes)",
  "忘刷上班卡次數\n整數位3碼\nForget to sign-on\n(Times) ",
  "忘刷下班卡次數\n整數位3碼\nForget to sign-off\n(Times) ",
  "曠職次數\n整數位3碼 Absence w/o Approval\n(Times) ",
  "曠職時數\n整數位3碼\n小數位1碼 / Absence w/o Approval\n(Hours)",
  "特休次數\n整數位3碼 Annual Leave\n(Times) ",
  "特休天數\n整數位2碼\n小數位1碼Annual Leave\n(Days)",
  "無給住院病假次數\n整數位3碼\nSick Leave w/o Pay\n(Times)",
  "無給住院病假時數\n整數位4碼\n小數位1碼\nSick Leave w/o Pay\n(Hours)",
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
      //  A full year × ~60 staff is ~15k rows — far over PostgREST's
      //  1000-row cap — so this MUST paginate or the totals would be
      //  computed from only the first 1000 rows. Stable order required
      //  for offset paging. Nadeem 2026-05-31.
      const att = await directGetAll(
        C.tables.attendanceDaily,
        `select=${C.attendance.employeeId},${C.attendance.date},${C.attendance.status},`
        + `${C.attendance.firstPunch},${C.attendance.lastPunch},${C.attendance.punchCount},`
        + `${C.attendance.lateMinutes},${C.attendance.earlyLeaveMinutes}`
        + `&${C.attendance.date}=gte.${periodFrom}`
        + `&${C.attendance.date}=lte.${periodTo}`
        + `&order=${C.attendance.date}.asc,${C.attendance.employeeId}.asc`,
        { timeoutMs: 20000 }
      );

      // ── Pull approved leave overlapping the fiscal year ────────────
      const lv = await directGetAll(
        C.tables.leaveRequests,
        `select=${C.leave.employeeId},${C.leave.typeId},${C.leave.startDate},`
        + `${C.leave.endDate},${C.leave.days},${C.leave.isHalfDay},`
        + `${C.leave.stage},${C.leave.status}`
        + `&${C.leave.startDate}=lte.${periodTo}`
        + `&${C.leave.endDate}=gte.${periodFrom}`
        + `&order=${C.leave.employeeId}.asc,${C.leave.startDate}.asc`,
        { timeoutMs: 20000 }
      );

      // ── Pull public holidays for the fiscal year ───────────────────
      let holidays = [];
      if (C.exclude.publicHolidays) {
        holidays = await directGet(
          C.tables.publicHolidays,
          `select=${C.holidayDateColumn}`
          + `&${C.holidayDateColumn}=gte.${periodFrom}`
          + `&${C.holidayDateColumn}=lte.${periodTo}`,
          { timeoutMs: 15000 }
        ) || [];
      }
      const holidaySet = new Set(
        holidays.map(h => String(h[C.holidayDateColumn]).slice(0, 10))
      );

      // ── Non-working days for the whole fiscal year ─────────────────
      //  Working days only: exclude weekends (Fri+Sat), public holidays,
      //  and the entire Hijri month of Ramadan. Built once as a Set so
      //  every counter can do an O(1) membership test.
      const nonWorking = new Set();
      eachDay(periodFrom, periodTo, (iso, dow) => {
        const isWeekend = C.exclude.weekends && C.weekendWeekdays.includes(dow);
        const isHoliday = C.exclude.publicHolidays && holidaySet.has(iso);
        const isRamadan = C.exclude.ramadan && hijriMonth(iso) === C.ramadanHijriMonth;
        if (isWeekend || isHoliday || isRamadan) nonWorking.add(iso);
      });
      const isWorkingDay = (iso) => !nonWorking.has(String(iso).slice(0, 10));

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

      // Staff whose day ends at 16:00 ("safe leaving at 4 PM"): SUP team
      // (working_hours_group === 'sup_team', fetched fresh) plus any
      // configured fallback PSNs. A 16:00 departure is NOT early for them.
      const fourPmSet = new Set(C.fourPmExtraPsns.map(p => String(p).toUpperCase()));
      try {
        const emps = await directGet('employees', 'select=id,working_hours_group', { timeoutMs: 12000 });
        for (const e of (emps || [])) {
          if (e?.id && e.working_hours_group === C.supGroupValue) {
            fourPmSet.add(String(e.id).toUpperCase());
          }
        }
      } catch { /* fall back to the configured PSN set */ }

      // Leave / off statuses carry no late / early / missed-punch meaning.
      const isLeaveOrOff = (st) =>
        typeof st === 'string' &&
        (st.includes('leave') || st === 'off_day' || st === 'off_roster');

      const startMin    = toMin(C.hq.scheduledStart);   // 08:00
      const lateCutMin   = toMin(C.hq.lateCutoff);       // 08:15
      const endStdMin    = toMin(C.hq.endStandard);      // 16:15
      const endFourPmMin  = toMin(C.hq.endSupFourPm);    // 16:00
      const middayMin     = toMin(C.hq.middayCutoff);    // 12:00

      // Attendance-derived counters (working days only). Late / early are
      // computed from the raw punches per HQ criteria, NOT from the
      // stored status / minutes — see CONFIG.hq.
      for (const r of (att || [])) {
        const psn = r[C.attendance.employeeId];
        if (!psn) continue;
        if (!isWorkingDay(r[C.attendance.date])) continue;   // skip Ramadan/weekend/holiday
        const a = get(psn);
        const st = r[C.attendance.status];

        // Unapproved absence — counted, then nothing else applies.
        if (st === C.attendance.statusAbsent) {
          a.absenceTimes += 1;
          a.absenceHours += C.workdayHours;
          continue;
        }
        // Leave / off days — not late, not early, not a missed punch.
        if (isLeaveOrOff(st)) continue;

        // Worked day: evaluate the actual punches against HQ thresholds.
        const fp = toMin(r[C.attendance.firstPunch]);
        const lp = toMin(r[C.attendance.lastPunch]);
        const endMin = fourPmSet.has(String(psn).toUpperCase()) ? endFourPmMin : endStdMin;

        if (fp != null && lp != null) {
          // Both punches present — straightforward.
          if (fp > lateCutMin) {
            a.lateTimes += 1;
            a.lateMinutes += Math.max(0, Math.round(fp - startMin));
          }
          if (lp < endMin) {
            a.earlyTimes += 1;
            a.earlyMinutes += Math.max(0, Math.round(endMin - lp));
          }
        } else if (fp != null || lp != null) {
          // Exactly ONE punch — the device stream doesn't label in vs
          // out, so we can't reliably score both lateness and early
          // leave from it. Disambiguate by time of day for the missed-
          // punch tally only: a punch before midday is treated as the
          // clock-IN (forgot to sign OFF); a punch at/after midday as
          // the clock-OUT (forgot to sign ON). No late/early minutes
          // are charged on single-punch days — those come only from
          // complete (both-punch) days, to avoid speculative figures.
          const only = fp != null ? fp : lp;
          if (only < middayMin) a.forgetOff += 1;   // in only, no out
          else                  a.forgetOn  += 1;   // out only, no in
        }
        // (no punches at all on a worked-status row: nothing to score)
      }

      // Leave-derived counters (working days only, clamped to the FY)
      const catOf = (typeId) => {
        for (const [cat, ids] of Object.entries(C.leaveCategory)) {
          if (ids.includes(typeId)) return cat;
        }
        return null;
      };
      // Count the working days of a leave that fall inside the fiscal
      // year — excludes Ramadan/weekends/holidays. A half-day single-day
      // leave counts 0.5 (only if that day is a working day).
      const workingLeaveDays = (r) => {
        const s = r[C.leave.startDate], e = r[C.leave.endDate];
        if (!s || !e) return 0;
        const from = s < periodFrom ? periodFrom : s;
        const to   = e > periodTo   ? periodTo   : e;
        let n = 0;
        eachDay(from, to, (iso) => { if (isWorkingDay(iso)) n += 1; });
        if (r[C.leave.isHalfDay] && s === e && n === 1) n = 0.5;
        return n;
      };
      for (const r of (lv || [])) {
        if (!isApprovedLeave(r)) continue;
        const psn = r[C.leave.employeeId];
        if (!psn) continue;
        const days = workingLeaveDays(r);
        if (days <= 0) continue;                // leave fell entirely on non-working days
        const a = get(psn);
        const cat = catOf(r[C.leave.typeId]);
        if (cat === 'personal')   { a.personalTimes += 1; a.personalHours += days * C.workdayHours; }
        else if (cat === 'sickPaid')   { a.sickPaidTimes += 1; a.sickPaidHours += days * C.workdayHours; }
        else if (cat === 'annual')     { a.annualTimes += 1; a.annualDays += days; }
        else if (cat === 'sickUnpaid') { a.sickUnpaidTimes += 1; a.sickUnpaidHours += days * C.workdayHours; }
      }

      // ── Build rows, SORTED BY COMPANY ──────────────────────────────
      //  Nadeem 2026-05-29: report sorted by Company (location-dept,
      //  e.g. DMM-BIZ). Every rostered employee gets a row so HQ gets a
      //  complete sheet; zero-activity rows are all zeros.
      const psnPrefix = C.employee.psnPrefix;
      const stripPrefix = (id) => (psnPrefix && String(id).startsWith(psnPrefix))
        ? String(id).slice(psnPrefix.length) : String(id);
      const companyOf = (e) => [e?.[C.employee.location], e?.[C.employee.department]]
        .filter(Boolean).join('-');

      const rowEmps = (employees.length
        ? [...employees]
        : Object.keys(agg).map(psn => empById[psn] || { [C.employee.id]: psn }));
      rowEmps.sort((a, b) =>
        companyOf(a).localeCompare(companyOf(b)) ||
        String(a[C.employee.name] || '').localeCompare(String(b[C.employee.name] || '')));

      const aoa = [HQ_HEADERS];
      for (const e of rowEmps) {
        const psn = e[C.employee.id];
        const a = agg[psn] || blank();
        const company = companyOf(e);
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

      // ── Bilingual footer notes (English + 中文) ─────────────────────
      //  Nadeem 2026-05-29: after the staff rows, spell out exactly what
      //  the report shows and what it deliberately excludes — in English
      //  and Chinese for HQ.
      const noteLines = [
        '',
        ['NOTES'],
        [`\u2022 Reporting period: 01 Sep ${fromYear} \u2013 31 Aug ${fromYear + 1} (${yearLabel}).`],
        ['\u2022 Working days only \u2014 excludes Ramadan, weekends (Fri & Sat), and public holidays.'],
        ['\u2022 Late: clock-in after 08:15 (minutes from 08:00).'],
        ['\u2022 Early leave: clock-out before 16:15 \u2014 before 16:00 for SUP / 4 PM staff (16:00 departure not counted early).'],
        ['\u2022 Forgot sign-on / sign-off: a worked day missing the clock-in or clock-out.'],
        ['\u2022 Single-punch day: a morning punch counts as sign-in (missing sign-off); a midday/afternoon punch as sign-out (missing sign-on).'],
        [`\u2022 Times = occurrences; Minutes = total minutes; Days = working days; leave hours = days \u00d7 ${C.workdayHours}.`],
        [`\u2022 Prepared by: ${me?.name || 'ESAU HR'}  \u00b7  ${new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`],
      ];
      const firstNoteRow = aoa.length;     // 0-based row index where notes start
      for (const ln of noteLines) aoa.push(ln);

      // ── Style + write ──────────────────────────────────────────────
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const GREEN = '0F4C2A';
      const H = excelHeaderRgb(me);  // baby-pink header for Bashaier
      const range = XLSX.utils.decode_range(ws['!ref']);
      for (let Ci = range.s.c; Ci <= range.e.c; Ci++) {
        const addr = XLSX.utils.encode_cell({ r: 0, c: Ci });
        if (ws[addr]) ws[addr].s = {
          font: { bold: true, color: { rgb: H.fg }, sz: 9 },
          fill: { fgColor: { rgb: H.bg } },
          alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
        };
      }
      // Style the footer-note rows: merge across all columns, small
      // near-black text (no italic), the NOTES header in brand green bold.
      const lastCol = HQ_HEADERS.length - 1;
      ws['!merges'] = ws['!merges'] || [];
      for (let i = 0; i < noteLines.length; i++) {
        const R = firstNoteRow + i;
        if (!noteLines[i].length) continue;        // blank spacer row
        ws['!merges'].push({ s: { r: R, c: 0 }, e: { r: R, c: lastCol } });
        const addr = XLSX.utils.encode_cell({ r: R, c: 0 });
        const isHeader = i === 1;                  // 'NOTES'
        if (ws[addr]) ws[addr].s = {
          font: {
            bold: isHeader, italic: false, sz: isHeader ? 10 : 9,
            color: { rgb: isHeader ? GREEN : '0A0A0A' },
          },
          alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
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
            Period: {periodFrom} → {periodTo}. Working days only — excludes Ramadan,
            weekends (Fri/Sat) and public holidays. Sorted by Company. Leave hours = days × {CONFIG.workdayHours}.
          </p>
        </div>
      </div>
    </div>
  );
}
