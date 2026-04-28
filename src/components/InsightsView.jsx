import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Download, FileSpreadsheet, FileText, Search, Users, BarChart3,
  CalendarDays, Coffee, TrendingUp, AlertCircle, CheckCircle2, Clock,
  Plane, Sparkles, Filter as FilterIcon, X, ChevronRight, MapPin
} from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import {
  calculateBalance, yearsOfService, monthsOfService,
  fmtDate, fmtDateShort, getInitials, avatarColor, LOCATION_LABELS
} from '../lib/leaveLogic.js';
import { PERMISSION_QUOTA, PERMISSION_TYPES, summariseMonth } from '../lib/permissionLogic.js';

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_FULL   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const ESAU_GREEN = '#2D5F3F';

// Helper: utilisation status — green / amber / red
function utilisationStatus(used, entitlement) {
  if (!entitlement) return { label: 'No data', color: '#9CA3AF', bg: '#F3F4F6', tone: 'neutral' };
  const pct = (used / entitlement) * 100;
  if (pct >= 90) return { label: 'Critical', color: '#B83A2E', bg: '#FEE2E2', tone: 'critical' };
  if (pct >= 60) return { label: 'Watch', color: '#92400E', bg: '#FEF3C7', tone: 'warn' };
  return { label: 'Healthy', color: '#15803D', bg: '#DCFCE7', tone: 'ok' };
}

function quotaStatus(monthSummary) {
  if (monthSummary.overQuota) return { label: 'Over quota', color: '#B83A2E', bg: '#FEE2E2', tone: 'critical' };
  if (monthSummary.atQuota)  return { label: 'At quota',   color: '#92400E', bg: '#FEF3C7', tone: 'warn' };
  if (monthSummary.occurrences === 0) return { label: 'Untouched', color: '#6B7280', bg: '#F3F4F6', tone: 'neutral' };
  return { label: 'Within quota', color: '#15803D', bg: '#DCFCE7', tone: 'ok' };
}

// Compute the days a leave request falls within a specific month (year, month=1-12).
// Uses calendar-day overlap ratio applied to the working-day count.
function leaveDaysInMonth(req, year, month) {
  const start = new Date(req.start_date);
  const end   = new Date(req.end_date);
  const mStart = new Date(year, month - 1, 1);
  const mEnd   = new Date(year, month, 0);
  if (end < mStart || start > mEnd) return 0;
  const oStart = start > mStart ? start : mStart;
  const oEnd   = end   < mEnd   ? end   : mEnd;
  const totalCal   = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  const overlapCal = Math.round((oEnd.getTime() - oStart.getTime()) / 86400000) + 1;
  if (totalCal <= 0) return 0;
  return Number(req.days || 0) * (overlapCal / totalCal);
}

// Status of a leave request — terminal stage labels and colors
function leaveStatusPill(req) {
  const stage = req.stage || req.status;
  if (stage === 'approved') return { label: 'Approved', color: '#15803D', bg: '#DCFCE7' };
  if (stage === 'rejected_by_manager' || stage === 'rejected_by_hr' || stage === 'rejected_by_substitute') {
    return { label: 'Rejected', color: '#B83A2E', bg: '#FEE2E2' };
  }
  if (stage === 'pending_substitutes') return { label: 'Awaiting cover', color: '#92400E', bg: '#FEF3C7' };
  if (stage === 'pending_manager') return { label: 'With manager', color: '#92400E', bg: '#FEF3C7' };
  if (stage === 'pending_hr') return { label: 'With HR', color: '#1E40AF', bg: '#DBEAFE' };
  return { label: req.status || stage, color: '#6B7280', bg: '#F3F4F6' };
}

// Permission status pill
function permStatusPill(p) {
  const s = (p.status || '').toLowerCase();
  if (s === 'approved') return { label: 'Approved', color: '#15803D', bg: '#DCFCE7' };
  if (s === 'rejected') return { label: 'Rejected', color: '#B83A2E', bg: '#FEE2E2' };
  if (s === 'pending')  return { label: 'Pending',  color: '#92400E', bg: '#FEF3C7' };
  return { label: p.status || '—', color: '#6B7280', bg: '#F3F4F6' };
}

// ===========================================================================
// MAIN COMPONENT
// ===========================================================================
export default function InsightsView({ me, employees, leaveTypes, requests, balances, empMap, permissions: passedPerms }) {
  const [view, setView]       = useState('leave');
  const [year, setYear]       = useState(new Date().getFullYear());
  const [month, setMonth]     = useState('all');                 // 'all' | '1'..'12'
  const [dept, setDept]       = useState('all');
  const [loc, setLoc]         = useState('all');
  const [search, setSearch]   = useState('');
  const [permissions, setPermissions] = useState(passedPerms || []);
  const [permLoading, setPermLoading] = useState(false);
  const [exporting, setExporting] = useState('');
  const [viewedEmpId, setViewedEmpId] = useState(null);          // drill-down modal

  useEffect(() => {
    if (passedPerms && passedPerms.length >= 0) {
      setPermissions(passedPerms);
      return;
    }
    let mounted = true;
    setPermLoading(true);
    (async () => {
      try {
        const rows = await directGet('permission_requests', `select=*&order=permission_date.desc`, { timeoutMs: 15000 });
        if (mounted) setPermissions(rows || []);
      } catch (e) {
        console.warn('permissions fetch failed', e);
        if (mounted) setPermissions([]);
      } finally {
        if (mounted) setPermLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, [passedPerms]);

  // ----- Sorted + filtered employees: Location → Department → Name -----
  const filteredEmps = useMemo(() => {
    return (employees || []).filter(e => {
      if (dept !== 'all' && e.department !== dept) return false;
      if (loc  !== 'all' && e.location !== loc) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!e.name?.toLowerCase().includes(q) && !e.id?.toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort((a, b) => {
      const la = a.location || 'zzz';
      const lb = b.location || 'zzz';
      if (la !== lb) return la.localeCompare(lb);
      const da = a.department || 'zzz';
      const db = b.department || 'zzz';
      if (da !== db) return da.localeCompare(db);
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [employees, dept, loc, search]);

  const departments = useMemo(
    () => Array.from(new Set((employees || []).map(e => e.department).filter(Boolean))).sort(),
    [employees]
  );
  const locations = useMemo(
    () => Array.from(new Set((employees || []).map(e => e.location).filter(Boolean))).sort(),
    [employees]
  );
  const years = useMemo(() => {
    const now = new Date().getFullYear();
    return [now + 1, now, now - 1, now - 2];
  }, []);

  const annualType = useMemo(() => leaveTypes?.find(t => t.id === 'annual') || leaveTypes?.[0], [leaveTypes]);
  const monthInt = month === 'all' ? null : Number(month);
  const isMonthMode = monthInt !== null;

  // ----- Leave rows: per-employee snapshot for selected year (and optionally month) -----
  const leaveRows = useMemo(() => {
    if (!annualType) return [];
    return filteredEmps.map(emp => {
      const adj = (balances || []).find(
        b => b.employee_id === emp.id && b.leave_type_id === annualType.id && b.year === year
      ) || {};
      const bal = calculateBalance({ employee: emp, leaveType: annualType, year, requests: requests || [], adjustments: adj });
      const empReqsYear = (requests || []).filter(r =>
        r.employee_id === emp.id && new Date(r.start_date).getFullYear() === year
      );

      // For month mode: count days that fall within selected month
      let monthDays = 0, monthApprovedReqs = 0, monthPendingReqs = 0;
      if (isMonthMode) {
        empReqsYear.forEach(r => {
          const inMonth = leaveDaysInMonth(r, year, monthInt);
          if (inMonth > 0) {
            if (r.status === 'approved') { monthDays += inMonth; monthApprovedReqs++; }
            else if (r.status === 'pending') { monthPendingReqs++; }
          }
        });
      }

      const lastApproved = empReqsYear.filter(r => r.status === 'approved')
        .sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0];
      const yrs = emp.join_date ? yearsOfService(emp.join_date) : 0;
      const mth = emp.join_date ? monthsOfService(emp.join_date) % 12 : 0;
      return { emp, bal, lastApproved, yrs, mth, empReqsYear, monthDays, monthApprovedReqs, monthPendingReqs };
    }).filter(r => isMonthMode ? (r.monthDays > 0 || r.monthApprovedReqs > 0 || r.monthPendingReqs > 0) : true);
  }, [filteredEmps, annualType, year, balances, requests, isMonthMode, monthInt]);

  // ----- Permission rows: per-employee snapshot, filtered by year (and optional month) -----
  const permRows = useMemo(() => {
    const now = new Date();
    return filteredEmps.map(emp => {
      const empPerms = (permissions || []).filter(p =>
        p.employee_id === emp.id &&
        new Date(p.permission_date).getFullYear() === year &&
        (isMonthMode ? (new Date(p.permission_date).getMonth() + 1 === monthInt) : true)
      );
      const counted = empPerms.filter(p => p.status === 'approved' || p.status === 'pending');
      const lateApps  = counted.filter(p => p.type === 'late_arrival');
      const earlyApps = counted.filter(p => p.type === 'early_leave');
      const lateHours  = lateApps.reduce((s, r) => s + Number(r.hours || 0), 0);
      const earlyHours = earlyApps.reduce((s, r) => s + Number(r.hours || 0), 0);
      const totalHours = lateHours + earlyHours;
      const lastPerm = counted.sort((a, b) => new Date(b.permission_date) - new Date(a.permission_date))[0];

      // For "this month" status pill, always look at TODAY's month regardless of month filter
      const todayMs = String(now.getMonth() + 1).padStart(2, '0');
      const todayY  = now.getFullYear();
      const monthRowsToday = empPerms.filter(p =>
        p.permission_date?.startsWith(`${todayY}-${todayMs}`) &&
        (p.status === 'approved' || p.status === 'pending')
      );
      const monthSummary = summariseMonth(monthRowsToday);

      return {
        emp, lateApps, earlyApps, lateCount: lateApps.length, earlyCount: earlyApps.length,
        totalCount: counted.length, lateHours, earlyHours, totalHours,
        lastPerm, monthSummary, allPerms: empPerms,
      };
    }).filter(r => isMonthMode ? r.totalCount > 0 : true);
  }, [filteredEmps, permissions, year, isMonthMode, monthInt]);

  // ----- Aggregates -----
  const leaveAgg = useMemo(() => {
    if (isMonthMode) {
      const monthStaff = leaveRows.length;
      const monthDays  = leaveRows.reduce((s, r) => s + r.monthDays, 0);
      const monthApps  = leaveRows.reduce((s, r) => s + r.monthApprovedReqs + r.monthPendingReqs, 0);
      const totalEnt   = leaveRows.reduce((s, r) => s + (r.bal?.entitlement || 0), 0);
      return {
        totalStaff: filteredEmps.length, monthStaff, monthDays, monthApps,
        totalEnt, totalUsed: 0, totalPend: 0, totalRem: 0,
      };
    }
    const totalEnt   = leaveRows.reduce((s, r) => s + (r.bal?.entitlement || 0), 0);
    const totalUsed  = leaveRows.reduce((s, r) => s + (r.bal?.used || 0), 0);
    const totalPend  = leaveRows.reduce((s, r) => s + (r.bal?.pending || 0), 0);
    const totalRem   = leaveRows.reduce((s, r) => s + (r.bal?.available || 0), 0);
    return { totalStaff: leaveRows.length, totalEnt, totalUsed, totalPend, totalRem };
  }, [leaveRows, isMonthMode, filteredEmps]);

  const permAgg = useMemo(() => {
    const allCounted = (permissions || []).filter(p =>
      (p.status === 'approved' || p.status === 'pending') &&
      new Date(p.permission_date).getFullYear() === year &&
      (isMonthMode ? (new Date(p.permission_date).getMonth() + 1 === monthInt) : true)
    );
    const yearPeople  = new Set(allCounted.map(p => p.employee_id)).size;
    const yearHours   = allCounted.reduce((s, r) => s + Number(r.hours || 0), 0);
    const lateCount   = allCounted.filter(p => p.type === 'late_arrival').length;
    const earlyCount  = allCounted.filter(p => p.type === 'early_leave').length;
    return { yearApps: allCounted.length, yearPeople, yearHours, lateCount, earlyCount };
  }, [permissions, year, isMonthMode, monthInt]);

  // ----- Monthly bar chart breakdown for permissions (always full year) -----
  const monthlyCounts = useMemo(() => {
    const buckets = Array(12).fill(0);
    (permissions || []).forEach(p => {
      if (p.status !== 'approved' && p.status !== 'pending') return;
      const d = new Date(p.permission_date);
      if (d.getFullYear() !== year) return;
      const m = d.getMonth();
      if (m >= 0 && m < 12) buckets[m]++;
    });
    return buckets;
  }, [permissions, year]);

  // Top 5 frequent permission users in the current filter
  const topUsers = useMemo(
    () => [...permRows].sort((a, b) => b.totalCount - a.totalCount).filter(r => r.totalCount > 0).slice(0, 5),
    [permRows]
  );

  // Department breakdown (year mode)
  const deptBreakdown = useMemo(() => {
    if (isMonthMode) return [];
    const map = {};
    leaveRows.forEach(r => {
      const d = r.emp.department || 'Other';
      if (!map[d]) map[d] = { dept: d, staff: 0, ent: 0, used: 0, rem: 0 };
      map[d].staff++;
      map[d].ent  += r.bal?.entitlement || 0;
      map[d].used += r.bal?.used || 0;
      map[d].rem  += r.bal?.available || 0;
    });
    return Object.values(map).sort((a, b) => b.staff - a.staff);
  }, [leaveRows, isMonthMode]);

  // =========================================================================
  // EXPORT FUNCTIONS — Top-level (full filtered list)
  // =========================================================================
  const exportLeavePdf = useCallback(async () => {
    setExporting('pdf');
    try {
      const { jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();
      doc.setFillColor(45, 95, 63);
      doc.rect(0, 0, W, 64, 'F');
      doc.setTextColor(255);
      doc.setFontSize(18); doc.setFont('helvetica', 'bold');
      const title = isMonthMode ? `Leave Summary — ${MONTH_FULL[monthInt - 1]} ${year}` : `Annual Leave Summary — ${year}`;
      doc.text(title, 40, 32);
      doc.setFontSize(11); doc.setFont('helvetica', 'normal');
      doc.text('Evergreen Shipping Agency Saudi · HR Department', W - 40, 32, { align: 'right' });
      doc.setTextColor(60, 60, 60); doc.setFontSize(9);
      doc.text(`Generated ${new Date().toLocaleString()}`, W - 40, 50, { align: 'right' });

      doc.setTextColor(45, 95, 63); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
      const summary = isMonthMode
        ? `Staff with leave this month: ${leaveAgg.monthStaff}    ·    Total days: ${leaveAgg.monthDays.toFixed(1)}    ·    Applications: ${leaveAgg.monthApps}`
        : `Staff: ${leaveAgg.totalStaff}    ·    Entitlement: ${leaveAgg.totalEnt.toFixed(1)}d    ·    Used: ${leaveAgg.totalUsed.toFixed(1)}d    ·    Pending: ${leaveAgg.totalPend.toFixed(1)}d    ·    Remaining: ${leaveAgg.totalRem.toFixed(1)}d`;
      doc.text(summary, 40, 86);

      const filterStr = [
        dept !== 'all' ? `Dept: ${dept}` : null,
        loc  !== 'all' ? `Location: ${LOCATION_LABELS[loc] || loc}` : null,
        search ? `Search: "${search}"` : null,
      ].filter(Boolean).join('   ·   ') || 'All staff';
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(110, 110, 110);
      doc.text(`Filter: ${filterStr}    Sort: Location → Department → Name`, 40, 102);

      let head, body;
      if (isMonthMode) {
        head = [['#', 'PSN', 'Name', 'Loc', 'Dept', 'Joined', 'YOS', 'Days in Month', 'Apps Approved', 'Apps Pending']];
        body = leaveRows.map((r, i) => [
          i + 1, r.emp.id, r.emp.name,
          LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
          r.emp.department || '—',
          r.emp.join_date ? fmtDateShort(r.emp.join_date) : '—',
          `${r.yrs}y ${r.mth}m`,
          r.monthDays.toFixed(2),
          r.monthApprovedReqs, r.monthPendingReqs,
        ]);
      } else {
        head = [['#', 'PSN', 'Name', 'Loc', 'Dept', 'Joined', 'YOS', 'Entitle', 'Used', 'Pending', 'Remain', 'Last leave', 'Status']];
        body = leaveRows.map((r, i) => {
          const st = utilisationStatus(r.bal?.used || 0, r.bal?.entitlement || 0);
          return [
            i + 1, r.emp.id, r.emp.name,
            LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
            r.emp.department || '—',
            r.emp.join_date ? fmtDateShort(r.emp.join_date) : '—',
            `${r.yrs}y ${r.mth}m`,
            (r.bal?.entitlement ?? 0).toFixed(1),
            (r.bal?.used        ?? 0).toFixed(1),
            (r.bal?.pending     ?? 0).toFixed(1),
            (r.bal?.available   ?? 0).toFixed(1),
            r.lastApproved ? fmtDateShort(r.lastApproved.start_date) : '—',
            st.label,
          ];
        });
      }

      doc.autoTable({
        startY: 116, head, body,
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9, fontStyle: 'bold' },
        bodyStyles: { fontSize: 8, textColor: 50 },
        alternateRowStyles: { fillColor: [248, 248, 245] },
        margin: { left: 40, right: 40 },
      });
      doc.save(`Leave_${isMonthMode ? MONTH_LABELS[monthInt-1] + '_' : ''}Summary_${year}.pdf`);
    } catch (e) {
      console.error(e);
      alert('PDF export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [leaveRows, leaveAgg, year, isMonthMode, monthInt, dept, loc, search]);

  const exportLeaveXlsx = useCallback(async () => {
    setExporting('xlsx');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      let headers, rows;
      if (isMonthMode) {
        headers = ['#','PSN','Name','Location','Department','Joined','Years of Service','Days in Month','Approved Apps','Pending Apps'];
        rows = leaveRows.map((r, i) => [
          i + 1, r.emp.id, r.emp.name,
          LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
          r.emp.department || '—',
          r.emp.join_date || '—',
          `${r.yrs}y ${r.mth}m`,
          Number(r.monthDays.toFixed(2)),
          r.monthApprovedReqs, r.monthPendingReqs,
        ]);
      } else {
        headers = ['#','PSN','Name','Location','Department','Joined','Years of Service','Entitlement','Used','Pending','Remaining','Last leave','Status'];
        rows = leaveRows.map((r, i) => [
          i + 1, r.emp.id, r.emp.name,
          LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
          r.emp.department || '—',
          r.emp.join_date || '—',
          `${r.yrs}y ${r.mth}m`,
          Number((r.bal?.entitlement ?? 0).toFixed(2)),
          Number((r.bal?.used        ?? 0).toFixed(2)),
          Number((r.bal?.pending     ?? 0).toFixed(2)),
          Number((r.bal?.available   ?? 0).toFixed(2)),
          r.lastApproved ? r.lastApproved.start_date : '—',
          utilisationStatus(r.bal?.used || 0, r.bal?.entitlement || 0).label,
        ]);
      }
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      ws['!cols'] = headers.map((_, i) => ({ wch: i === 2 ? 32 : 12 }));
      XLSX.utils.book_append_sheet(wb, ws, isMonthMode ? `${MONTH_LABELS[monthInt-1]} ${year}` : 'Annual Leave');

      if (!isMonthMode && deptBreakdown.length > 0) {
        const ws2 = XLSX.utils.aoa_to_sheet([
          ['Department', 'Staff', 'Total Entitle', 'Used', 'Remaining'],
          ...deptBreakdown.map(d => [d.dept, d.staff, Number(d.ent.toFixed(2)), Number(d.used.toFixed(2)), Number(d.rem.toFixed(2))]),
        ]);
        XLSX.utils.book_append_sheet(wb, ws2, 'By Department');
      }
      XLSX.writeFile(wb, `Leave_${isMonthMode ? MONTH_LABELS[monthInt-1] + '_' : ''}Summary_${year}.xlsx`);
    } catch (e) {
      console.error(e);
      alert('Excel export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [leaveRows, deptBreakdown, year, isMonthMode, monthInt]);

  const exportPermPdf = useCallback(async () => {
    setExporting('pdf');
    try {
      const { jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();
      doc.setFillColor(45, 95, 63);
      doc.rect(0, 0, W, 64, 'F');
      doc.setTextColor(255); doc.setFontSize(18); doc.setFont('helvetica', 'bold');
      const title = isMonthMode ? `Permissions — ${MONTH_FULL[monthInt - 1]} ${year}` : `Permissions Summary — ${year}`;
      doc.text(title, 40, 32);
      doc.setFontSize(11); doc.setFont('helvetica', 'normal');
      doc.text('Evergreen Shipping Agency Saudi · HR Department', W - 40, 32, { align: 'right' });
      doc.setTextColor(60, 60, 60); doc.setFontSize(9);
      doc.text(`Generated ${new Date().toLocaleString()}`, W - 40, 50, { align: 'right' });

      doc.setTextColor(45, 95, 63); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
      doc.text(`Applications: ${permAgg.yearApps}    People: ${permAgg.yearPeople}    Hours: ${permAgg.yearHours.toFixed(1)}h    Late: ${permAgg.lateCount}    Early: ${permAgg.earlyCount}`, 40, 86);

      doc.autoTable({
        startY: 116,
        head: [['#', 'PSN', 'Name', 'Loc', 'Dept', 'Late', 'Late hrs', 'Early', 'Early hrs', 'Total apps', 'Total hrs', 'Last permission']],
        body: permRows.map((r, i) => [
          i + 1, r.emp.id, r.emp.name,
          LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
          r.emp.department || '—',
          r.lateCount, r.lateHours.toFixed(1),
          r.earlyCount, r.earlyHours.toFixed(1),
          r.totalCount, r.totalHours.toFixed(1),
          r.lastPerm ? fmtDateShort(r.lastPerm.permission_date) : '—',
        ]),
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 248, 245] },
        margin: { left: 40, right: 40 },
      });
      doc.save(`Permissions_${isMonthMode ? MONTH_LABELS[monthInt-1] + '_' : ''}Summary_${year}.pdf`);
    } catch (e) {
      console.error(e);
      alert('PDF export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [permRows, permAgg, year, isMonthMode, monthInt]);

  const exportPermXlsx = useCallback(async () => {
    setExporting('xlsx');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const headers = ['#','PSN','Name','Location','Department','Late count','Late hours','Early count','Early hours','Total apps','Total hours','Last permission'];
      const rows = permRows.map((r, i) => [
        i + 1, r.emp.id, r.emp.name,
        LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
        r.emp.department || '—',
        r.lateCount, Number(r.lateHours.toFixed(2)),
        r.earlyCount, Number(r.earlyHours.toFixed(2)),
        r.totalCount, Number(r.totalHours.toFixed(2)),
        r.lastPerm ? r.lastPerm.permission_date : '—',
      ]);
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      ws['!cols'] = headers.map((_, i) => ({ wch: i === 2 ? 32 : 12 }));
      XLSX.utils.book_append_sheet(wb, ws, isMonthMode ? `${MONTH_LABELS[monthInt-1]} ${year}` : 'Permissions');

      if (!isMonthMode) {
        const ws2 = XLSX.utils.aoa_to_sheet([
          ['Month', 'Applications'],
          ...MONTH_LABELS.map((m, i) => [m, monthlyCounts[i]]),
          [],
          ['TOTAL', monthlyCounts.reduce((s, n) => s + n, 0)],
        ]);
        XLSX.utils.book_append_sheet(wb, ws2, 'Monthly');
      }
      XLSX.writeFile(wb, `Permissions_${isMonthMode ? MONTH_LABELS[monthInt-1] + '_' : ''}Summary_${year}.xlsx`);
    } catch (e) {
      console.error(e);
      alert('Excel export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [permRows, monthlyCounts, year, isMonthMode, monthInt]);

  const exportPdf  = view === 'leave' ? exportLeavePdf  : exportPermPdf;
  const exportXlsx = view === 'leave' ? exportLeaveXlsx : exportPermXlsx;
  const viewedEmp = viewedEmpId ? (employees || []).find(e => e.id === viewedEmpId) : null;

  // =========================================================================
  // RENDER
  // =========================================================================
  return (
    <div className="fade-in">
      <div className="mb-5 sm:mb-6">
        <div className="text-[10px] tracking-[0.25em] opacity-60 mb-1">— INSIGHTS</div>
        <h1 className="text-3xl sm:text-4xl font-serif" style={{ color: 'var(--ink)' }}>Reports & Analytics</h1>
        <p className="text-sm opacity-70 mt-1">
          Live snapshots of leave usage and permission quotas across the organisation.
          {' '}<span className="opacity-70">Click any staff row to open their full annual history.</span>
        </p>
      </div>

      <div className="inline-flex rounded-full p-1 mb-5 sm:mb-6"
           style={{ background: 'var(--paper-soft, #F4F4EE)', border: '1px solid var(--border-soft)' }}>
        <button onClick={() => setView('leave')}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all"
          style={view === 'leave'
            ? { background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }
            : { background: 'transparent', color: 'var(--ink)' }}>
          <Plane className="w-4 h-4" /> Leave Summary
        </button>
        <button onClick={() => setView('permissions')}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all"
          style={view === 'permissions'
            ? { background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }
            : { background: 'transparent', color: 'var(--ink)' }}>
          <Coffee className="w-4 h-4" /> Permissions Summary
        </button>
      </div>

      <div className="rounded-2xl border bg-white px-4 py-3 mb-5 flex flex-wrap items-center gap-3"
           style={{ borderColor: 'var(--border-soft)' }}>
        <div className="flex items-center gap-2 text-xs font-semibold opacity-70">
          <FilterIcon className="w-3.5 h-3.5" /> FILTERS
        </div>
        <select value={year} onChange={(e) => setYear(Number(e.target.value))}
                className="text-sm rounded-lg px-3 py-1.5 border outline-none cursor-pointer"
                style={{ borderColor: 'var(--border-soft)' }}>
          {years.map(y => <option key={y} value={y}>Year: {y}</option>)}
        </select>
        <select value={month} onChange={(e) => setMonth(e.target.value)}
                className="text-sm rounded-lg px-3 py-1.5 border outline-none cursor-pointer"
                style={{ borderColor: 'var(--border-soft)',
                         background: month !== 'all' ? 'rgba(45,95,63,0.08)' : 'transparent',
                         color: month !== 'all' ? '#2D5F3F' : 'inherit',
                         fontWeight: month !== 'all' ? '600' : 'normal' }}>
          <option value="all">All months</option>
          {MONTH_FULL.map((mn, i) => <option key={i + 1} value={String(i + 1)}>{mn}</option>)}
        </select>
        <select value={dept} onChange={(e) => setDept(e.target.value)}
                className="text-sm rounded-lg px-3 py-1.5 border outline-none cursor-pointer"
                style={{ borderColor: 'var(--border-soft)' }}>
          <option value="all">All departments</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={loc} onChange={(e) => setLoc(e.target.value)}
                className="text-sm rounded-lg px-3 py-1.5 border outline-none cursor-pointer"
                style={{ borderColor: 'var(--border-soft)' }}>
          <option value="all">All locations</option>
          {locations.map(l => <option key={l} value={l}>{LOCATION_LABELS[l] || l}</option>)}
        </select>
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
                 placeholder="Search by name or PSN…"
                 className="w-full text-sm rounded-lg pl-8 pr-3 py-1.5 border outline-none"
                 style={{ borderColor: 'var(--border-soft)' }} />
        </div>
        <button onClick={exportPdf} disabled={!!exporting}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
                style={{ background: 'rgba(184,74,62,0.08)', color: '#B83A2E', border: '1px solid rgba(184,74,62,0.3)' }}>
          <FileText className="w-3.5 h-3.5" /> {exporting === 'pdf' ? 'Generating…' : 'PDF'}
        </button>
        <button onClick={exportXlsx} disabled={!!exporting}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
                style={{ background: 'rgba(34,113,79,0.08)', color: '#15803D', border: '1px solid rgba(34,113,79,0.3)' }}>
          <FileSpreadsheet className="w-3.5 h-3.5" /> {exporting === 'xlsx' ? 'Generating…' : 'Excel'}
        </button>
      </div>

      {isMonthMode && (
        <div className="mb-4 px-4 py-2.5 rounded-xl text-xs flex items-center gap-2"
             style={{ background: 'rgba(45,95,63,0.06)', border: '1px solid rgba(45,95,63,0.2)', color: '#2D5F3F' }}>
          <CalendarDays className="w-3.5 h-3.5" />
          <span><strong>{MONTH_FULL[monthInt - 1]} {year}</strong> view — showing {view === 'leave' ? 'staff with leave activity' : 'staff with permission activity'} during this month.</span>
          <button onClick={() => setMonth('all')} className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-full hover:underline">
            <X className="w-3 h-3" /> Clear
          </button>
        </div>
      )}

      {view === 'leave' ? (
        <LeaveSummary
          year={year} monthInt={monthInt} isMonthMode={isMonthMode}
          leaveRows={leaveRows} leaveAgg={leaveAgg}
          deptBreakdown={deptBreakdown}
          onRowClick={(empId) => setViewedEmpId(empId)}
        />
      ) : (
        <PermissionsSummary
          year={year} monthInt={monthInt} isMonthMode={isMonthMode}
          permRows={permRows} permAgg={permAgg}
          monthlyCounts={monthlyCounts} topUsers={topUsers}
          permLoading={permLoading}
          onRowClick={(empId) => setViewedEmpId(empId)}
          setMonth={setMonth}
        />
      )}

      {viewedEmp && (
        <EmployeeHistoryModal
          employee={viewedEmp} me={me} year={year} annualType={annualType}
          requests={requests || []} permissions={permissions} balances={balances || []}
          empMap={empMap}
          onClose={() => setViewedEmpId(null)}
        />
      )}
    </div>
  );
}

// ===========================================================================
// LEAVE SUMMARY VIEW
// ===========================================================================
function LeaveSummary({ year, monthInt, isMonthMode, leaveRows, leaveAgg, deptBreakdown, onRowClick }) {
  const sectionLabel = isMonthMode
    ? `STAFF WITH LEAVE IN ${MONTH_FULL[monthInt - 1].toUpperCase()} · ${leaveRows.length}`
    : `STAFF DETAIL · ${leaveRows.length}`;

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
        {isMonthMode ? (
          <>
            <HeroCard
              gradient="linear-gradient(135deg, #2D5F3F 0%, #4A8060 100%)"
              icon={<Users className="w-4 h-4" />}
              label={`STAFF IN ${MONTH_FULL[monthInt - 1].toUpperCase()}`}
              value={leaveAgg.monthStaff} unit="people"
              caption={`Out of ${leaveAgg.totalStaff} matching filter`}
            />
            <HeroCard
              gradient="linear-gradient(135deg, #C97A4F 0%, #E0A079 100%)"
              icon={<CalendarDays className="w-4 h-4" />}
              label="DAYS THIS MONTH"
              value={leaveAgg.monthDays.toFixed(1)} unit="days"
              caption="Counted from approved leaves"
            />
            <HeroCard
              gradient="linear-gradient(135deg, #5A8A9A 0%, #7BA9B9 100%)"
              icon={<TrendingUp className="w-4 h-4" />}
              label="APPLICATIONS"
              value={leaveAgg.monthApps} unit={`request${leaveAgg.monthApps === 1 ? '' : 's'}`}
              caption="Approved + pending"
            />
            <HeroCard
              gradient="linear-gradient(135deg, #6B5BA8 0%, #8B7BC8 100%)"
              icon={<Sparkles className="w-4 h-4" />}
              label="AVG PER PERSON"
              value={leaveAgg.monthStaff > 0 ? (leaveAgg.monthDays / leaveAgg.monthStaff).toFixed(1) : '0.0'}
              unit="days" caption="Days per staff this month"
            />
          </>
        ) : (
          <>
            <HeroCard gradient="linear-gradient(135deg, #2D5F3F 0%, #4A8060 100%)" icon={<Users className="w-4 h-4" />}
              label="TOTAL STAFF" value={leaveAgg.totalStaff} unit="people" caption={`Filtered view · year ${year}`} />
            <HeroCard gradient="linear-gradient(135deg, #5A8A9A 0%, #7BA9B9 100%)" icon={<CalendarDays className="w-4 h-4" />}
              label="TOTAL ENTITLEMENT" value={leaveAgg.totalEnt.toFixed(0)} unit="days" caption="Sum of all annual quotas" />
            <HeroCard gradient="linear-gradient(135deg, #C97A4F 0%, #E0A079 100%)" icon={<TrendingUp className="w-4 h-4" />}
              label="DAYS USED" value={leaveAgg.totalUsed.toFixed(1)}
              unit={`+ ${leaveAgg.totalPend.toFixed(1)} pending`}
              caption={`${leaveAgg.totalEnt > 0 ? Math.round((leaveAgg.totalUsed / leaveAgg.totalEnt) * 100) : 0}% of total entitlement`} />
            <HeroCard gradient="linear-gradient(135deg, #6B5BA8 0%, #8B7BC8 100%)" icon={<Sparkles className="w-4 h-4" />}
              label="DAYS REMAINING" value={leaveAgg.totalRem.toFixed(1)} unit="days" caption="Available across all staff" />
          </>
        )}
      </div>

      {!isMonthMode && deptBreakdown.length > 0 && (
        <div className="rounded-2xl border bg-white p-4 sm:p-5 mb-5" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-[10px] tracking-[0.25em] opacity-60 mb-3">BY DEPARTMENT</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {deptBreakdown.map(d => {
              const pct = d.ent > 0 ? Math.round((d.used / d.ent) * 100) : 0;
              return (
                <div key={d.dept} className="rounded-xl p-3" style={{ background: 'var(--paper-soft, #F8F8F2)', border: '1px solid var(--border-soft)' }}>
                  <div className="text-xs font-bold mb-1" style={{ color: 'var(--ink)' }}>{d.dept}</div>
                  <div className="text-xs opacity-70 mb-2">{d.staff} staff · {d.ent.toFixed(0)}d total</div>
                  <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#E5E7EB' }}>
                    <div className="h-full" style={{ width: `${Math.min(100, pct)}%`, background: 'linear-gradient(90deg, #2D5F3F 0%, #4A8060 100%)' }} />
                  </div>
                  <div className="flex items-center justify-between mt-1.5 text-[10px] opacity-70">
                    <span>Used {d.used.toFixed(0)}d</span><span>{pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-2xl border bg-white overflow-hidden" style={{ borderColor: 'var(--border-soft)' }}>
        <div className="px-5 py-3 flex items-center justify-between"
             style={{ borderBottom: '1px solid var(--border-soft)', background: 'var(--paper-soft, #FBFAF6)' }}>
          <div className="text-[10px] tracking-[0.25em] opacity-60">{sectionLabel}</div>
          <div className="text-[10px] opacity-50">Sorted: Location → Department → Name · Click row for full history</div>
        </div>
        {leaveRows.length === 0 ? (
          <EmptyState text={isMonthMode ? `No leave activity in ${MONTH_FULL[monthInt-1]} ${year}.` : 'No staff match the current filters.'} icon={<Users className="w-5 h-5" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] tracking-[0.15em] opacity-60" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                  <th className="text-left px-5 py-2.5 font-semibold">EMPLOYEE</th>
                  <th className="text-left px-3 py-2.5 font-semibold">LOC</th>
                  <th className="text-left px-3 py-2.5 font-semibold">DEPT</th>
                  <th className="text-left px-3 py-2.5 font-semibold">TENURE</th>
                  {isMonthMode ? (
                    <>
                      <th className="text-right px-3 py-2.5 font-semibold">DAYS IN MONTH</th>
                      <th className="text-right px-3 py-2.5 font-semibold">APPROVED</th>
                      <th className="text-right px-3 py-2.5 font-semibold">PENDING</th>
                      <th className="text-right px-3 py-2.5 font-semibold">YR REMAIN</th>
                    </>
                  ) : (
                    <>
                      <th className="text-left px-3 py-2.5 font-semibold">UTILISATION</th>
                      <th className="text-right px-3 py-2.5 font-semibold">ENTITLE</th>
                      <th className="text-right px-3 py-2.5 font-semibold">USED</th>
                      <th className="text-right px-3 py-2.5 font-semibold">PENDING</th>
                      <th className="text-right px-3 py-2.5 font-semibold">REMAIN</th>
                      <th className="text-left px-3 py-2.5 font-semibold">LAST LEAVE</th>
                      <th className="text-left px-3 py-2.5 font-semibold">STATUS</th>
                    </>
                  )}
                  <th className="px-2"></th>
                </tr>
              </thead>
              <tbody>
                {leaveRows.map((r, idx) => {
                  const ent  = r.bal?.entitlement || 0;
                  const used = r.bal?.used || 0;
                  const pct  = ent > 0 ? Math.min(100, (used / ent) * 100) : 0;
                  const st   = utilisationStatus(used, ent);
                  return (
                    <tr key={r.emp.id} onClick={() => onRowClick(r.emp.id)}
                        className="cursor-pointer hover:bg-[var(--paper-soft,#F8F8F2)] transition-colors group"
                        style={{ borderBottom: idx < leaveRows.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                               style={{ background: avatarColor(r.emp.id) }}>{getInitials(r.emp.name)}</div>
                          <div className="min-w-0">
                            <div className="font-medium truncate" style={{ color: 'var(--ink)' }}>{r.emp.name}</div>
                            <div className="text-[10px] opacity-60 font-mono">{r.emp.id}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                              style={{ background: 'rgba(90,138,154,0.1)', color: '#3F6573', border: '1px solid rgba(90,138,154,0.25)' }}>
                          <MapPin className="w-2.5 h-2.5" /> {LOCATION_LABELS[r.emp.location] || r.emp.location || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <span className="inline-block px-2 py-0.5 rounded-full"
                              style={{ background: 'rgba(45,95,63,0.08)', color: '#2D5F3F', border: '1px solid rgba(45,95,63,0.2)' }}>
                          {r.emp.department || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs opacity-80">{r.yrs}y {r.mth}m</td>
                      {isMonthMode ? (
                        <>
                          <td className="px-3 py-3 text-right tabular-nums font-bold" style={{ color: '#C97A4F' }}>{r.monthDays.toFixed(1)}</td>
                          <td className="px-3 py-3 text-right tabular-nums">{r.monthApprovedReqs}</td>
                          <td className="px-3 py-3 text-right tabular-nums opacity-70">{r.monthPendingReqs}</td>
                          <td className="px-3 py-3 text-right tabular-nums" style={{ color: '#2D5F3F' }}>{(r.bal?.available || 0).toFixed(1)}</td>
                        </>
                      ) : (
                        <>
                          <td className="px-3 py-3 min-w-[120px]">
                            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#E5E7EB' }}>
                              <div className="h-full transition-all"
                                   style={{
                                     width: `${pct}%`,
                                     background: st.tone === 'critical' ? 'linear-gradient(90deg, #EF4444, #B83A2E)'
                                       : st.tone === 'warn' ? 'linear-gradient(90deg, #F59E0B, #D97706)'
                                       : 'linear-gradient(90deg, #2D5F3F, #4A8060)',
                                   }} />
                            </div>
                            <div className="text-[10px] opacity-60 mt-1">{Math.round(pct)}%</div>
                          </td>
                          <td className="px-3 py-3 text-right tabular-nums">{ent.toFixed(1)}</td>
                          <td className="px-3 py-3 text-right tabular-nums font-semibold">{used.toFixed(1)}</td>
                          <td className="px-3 py-3 text-right tabular-nums opacity-70">{(r.bal?.pending || 0).toFixed(1)}</td>
                          <td className="px-3 py-3 text-right tabular-nums font-semibold" style={{ color: '#2D5F3F' }}>{(r.bal?.available || 0).toFixed(1)}</td>
                          <td className="px-3 py-3 text-xs opacity-80">
                            {r.lastApproved ? fmtDateShort(r.lastApproved.start_date) : <span className="opacity-50">Never</span>}
                          </td>
                          <td className="px-3 py-3">
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                  style={{ background: st.bg, color: st.color }}>
                              {st.tone === 'ok' && <CheckCircle2 className="w-3 h-3" />}
                              {(st.tone === 'warn' || st.tone === 'critical') && <AlertCircle className="w-3 h-3" />}
                              {st.label}
                            </span>
                          </td>
                        </>
                      )}
                      <td className="px-2 py-3 opacity-30 group-hover:opacity-100 transition-opacity">
                        <ChevronRight className="w-4 h-4" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ===========================================================================
// PERMISSIONS SUMMARY VIEW
// ===========================================================================
function PermissionsSummary({ year, monthInt, isMonthMode, permRows, permAgg, monthlyCounts, topUsers, permLoading, onRowClick, setMonth }) {
  const maxCount = Math.max(1, ...monthlyCounts);
  const currentMonthIdx = new Date().getMonth();
  const isCurrentYear = year === new Date().getFullYear();
  const sectionLabel = isMonthMode
    ? `STAFF WITH PERMISSIONS IN ${MONTH_FULL[monthInt - 1].toUpperCase()} · ${permRows.length}`
    : `STAFF DETAIL · ${permRows.length}`;

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
        <HeroCard
          gradient="linear-gradient(135deg, #C97A4F 0%, #E0A079 100%)"
          icon={<Coffee className="w-4 h-4" />}
          label={isMonthMode ? `${MONTH_FULL[monthInt - 1].toUpperCase()} APPS` : 'YEAR TOTAL'}
          value={permAgg.yearApps}
          unit={`application${permAgg.yearApps === 1 ? '' : 's'}`}
          caption={`${permAgg.yearPeople} unique ${permAgg.yearPeople === 1 ? 'person' : 'people'}`}
        />
        <HeroCard
          gradient="linear-gradient(135deg, #5A8A9A 0%, #7BA9B9 100%)"
          icon={<Clock className="w-4 h-4" />}
          label="HOURS"
          value={permAgg.yearHours.toFixed(1)}
          unit="hours"
          caption={isMonthMode ? `In ${MONTH_FULL[monthInt - 1]}` : 'Total time across permissions'}
        />
        <HeroCard
          gradient="linear-gradient(135deg, #92400E 0%, #B45309 100%)"
          icon={<TrendingUp className="w-4 h-4" />}
          label="LATE ARRIVALS"
          value={permAgg.lateCount}
          unit={`occurrence${permAgg.lateCount === 1 ? '' : 's'}`}
          caption="Type breakdown"
        />
        <HeroCard
          gradient="linear-gradient(135deg, #6B5BA8 0%, #8B7BC8 100%)"
          icon={<TrendingUp className="w-4 h-4 rotate-180" />}
          label="EARLY LEAVES"
          value={permAgg.earlyCount}
          unit={`occurrence${permAgg.earlyCount === 1 ? '' : 's'}`}
          caption="Type breakdown"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 mb-5">
        <div className="lg:col-span-2 rounded-2xl border bg-white p-4 sm:p-5" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] tracking-[0.25em] opacity-60">MONTHLY APPLICATIONS · {year}</div>
            <div className="text-[10px] opacity-50">Click a bar to filter that month</div>
          </div>
          <div className="flex items-end gap-1.5 sm:gap-2 h-44">
            {monthlyCounts.map((count, i) => {
              const h = (count / maxCount) * 100;
              const isCurrent = isCurrentYear && i === currentMonthIdx;
              const isSelected = isMonthMode && (i + 1) === monthInt;
              return (
                <button key={i} onClick={() => setMonth(String(i + 1))}
                        className="flex-1 flex flex-col items-center justify-end h-full gap-1.5 group cursor-pointer">
                  <div className="text-[10px] font-bold tabular-nums opacity-80 group-hover:opacity-100"
                       style={{ color: count > 0 ? '#2D5F3F' : '#9CA3AF' }}>
                    {count > 0 ? count : ''}
                  </div>
                  <div className="w-full rounded-t-md transition-all duration-300 group-hover:opacity-90"
                       style={{
                         height: `${Math.max(2, h)}%`,
                         background: isSelected
                           ? 'linear-gradient(180deg, #1F4530 0%, #14301F 100%)'
                           : isCurrent
                             ? 'linear-gradient(180deg, #C97A4F 0%, #B86A3F 100%)'
                             : count > 0
                               ? 'linear-gradient(180deg, #4A8060 0%, #2D5F3F 100%)'
                               : '#E5E7EB',
                         boxShadow: (isCurrent || isSelected) ? '0 4px 12px rgba(45,95,63,0.35)' : 'none',
                         border: isSelected ? '2px solid #2D5F3F' : 'none',
                       }} />
                  <div className="text-[10px] opacity-60 font-medium">{MONTH_LABELS[i]}</div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-4 sm:p-5" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-[10px] tracking-[0.25em] opacity-60 mb-3">TOP REQUESTERS · {isMonthMode ? MONTH_FULL[monthInt - 1] : year}</div>
          {topUsers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 opacity-50">
              <Sparkles className="w-5 h-5 mb-2" />
              <div className="text-xs">No permission requests yet.</div>
            </div>
          ) : (
            <ul className="space-y-3">
              {topUsers.map((r, i) => (
                <li key={r.emp.id} onClick={() => onRowClick(r.emp.id)}
                    className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                       style={{ background: i === 0 ? '#FEF3C7' : 'var(--paper-soft, #F4F4EE)', color: i === 0 ? '#92400E' : 'var(--ink)' }}>{i + 1}</div>
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                       style={{ background: avatarColor(r.emp.id) }}>{getInitials(r.emp.name)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate" style={{ color: 'var(--ink)' }}>{r.emp.name}</div>
                    <div className="text-[10px] opacity-60">{r.emp.department} · {r.totalCount} apps · {r.totalHours.toFixed(1)}h</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="rounded-2xl border bg-white overflow-hidden" style={{ borderColor: 'var(--border-soft)' }}>
        <div className="px-5 py-3 flex items-center justify-between"
             style={{ borderBottom: '1px solid var(--border-soft)', background: 'var(--paper-soft, #FBFAF6)' }}>
          <div className="text-[10px] tracking-[0.25em] opacity-60">{sectionLabel}</div>
          <div className="text-[10px] opacity-50">Sorted: Location → Department → Name · Click row for full history</div>
        </div>
        {permLoading ? (
          <EmptyState text="Loading permissions…" icon={<Clock className="w-5 h-5 animate-spin" />} />
        ) : permRows.length === 0 ? (
          <EmptyState text={isMonthMode ? `No permission activity in ${MONTH_FULL[monthInt-1]} ${year}.` : 'No staff match the current filters.'} icon={<Users className="w-5 h-5" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] tracking-[0.15em] opacity-60" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                  <th className="text-left px-5 py-2.5 font-semibold">EMPLOYEE</th>
                  <th className="text-left px-3 py-2.5 font-semibold">LOC</th>
                  <th className="text-left px-3 py-2.5 font-semibold">DEPT</th>
                  <th className="text-right px-3 py-2.5 font-semibold">LATE</th>
                  <th className="text-right px-3 py-2.5 font-semibold">EARLY</th>
                  <th className="text-right px-3 py-2.5 font-semibold">TOTAL APPS</th>
                  <th className="text-right px-3 py-2.5 font-semibold">TOTAL HOURS</th>
                  <th className="text-left px-3 py-2.5 font-semibold">LAST</th>
                  <th className="px-2"></th>
                </tr>
              </thead>
              <tbody>
                {permRows.map((r, idx) => (
                  <tr key={r.emp.id} onClick={() => onRowClick(r.emp.id)}
                      className="cursor-pointer hover:bg-[var(--paper-soft,#F8F8F2)] transition-colors group"
                      style={{ borderBottom: idx < permRows.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                             style={{ background: avatarColor(r.emp.id) }}>{getInitials(r.emp.name)}</div>
                        <div className="min-w-0">
                          <div className="font-medium truncate" style={{ color: 'var(--ink)' }}>{r.emp.name}</div>
                          <div className="text-[10px] opacity-60 font-mono">{r.emp.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-xs">
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                            style={{ background: 'rgba(90,138,154,0.1)', color: '#3F6573', border: '1px solid rgba(90,138,154,0.25)' }}>
                        <MapPin className="w-2.5 h-2.5" />{LOCATION_LABELS[r.emp.location] || r.emp.location || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-xs">
                      <span className="inline-block px-2 py-0.5 rounded-full"
                            style={{ background: 'rgba(45,95,63,0.08)', color: '#2D5F3F', border: '1px solid rgba(45,95,63,0.2)' }}>
                        {r.emp.department || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right text-xs">
                      <div className="tabular-nums font-semibold" style={{ color: r.lateCount > 0 ? '#92400E' : '#9CA3AF' }}>{r.lateCount}</div>
                      <div className="text-[10px] opacity-60 tabular-nums">{r.lateHours.toFixed(1)}h</div>
                    </td>
                    <td className="px-3 py-3 text-right text-xs">
                      <div className="tabular-nums font-semibold" style={{ color: r.earlyCount > 0 ? '#92400E' : '#9CA3AF' }}>{r.earlyCount}</div>
                      <div className="text-[10px] opacity-60 tabular-nums">{r.earlyHours.toFixed(1)}h</div>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums font-bold" style={{ color: 'var(--ink)' }}>{r.totalCount}</td>
                    <td className="px-3 py-3 text-right tabular-nums font-semibold" style={{ color: '#2D5F3F' }}>{r.totalHours.toFixed(1)}h</td>
                    <td className="px-3 py-3 text-xs opacity-80">
                      {r.lastPerm ? fmtDateShort(r.lastPerm.permission_date) : <span className="opacity-50">Never</span>}
                    </td>
                    <td className="px-2 py-3 opacity-30 group-hover:opacity-100 transition-opacity">
                      <ChevronRight className="w-4 h-4" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

// ===========================================================================
// EMPLOYEE HISTORY MODAL — drill-down view
// ===========================================================================
function EmployeeHistoryModal({ employee, me, year, annualType, requests, permissions, balances, empMap, onClose }) {
  const [exporting, setExporting] = useState('');

  // ESC closes
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Filter to this employee's year data
  const empReqs = useMemo(() =>
    (requests || []).filter(r =>
      r.employee_id === employee.id &&
      new Date(r.start_date).getFullYear() === year
    ).sort((a, b) => new Date(a.start_date) - new Date(b.start_date)),
    [requests, employee.id, year]
  );
  const empPerms = useMemo(() =>
    (permissions || []).filter(p =>
      p.employee_id === employee.id &&
      new Date(p.permission_date).getFullYear() === year
    ).sort((a, b) => new Date(a.permission_date) - new Date(b.permission_date)),
    [permissions, employee.id, year]
  );

  // Balance summary
  const bal = useMemo(() => {
    if (!annualType) return null;
    const adj = (balances || []).find(b => b.employee_id === employee.id && b.leave_type_id === annualType.id && b.year === year) || {};
    return calculateBalance({ employee, leaveType: annualType, year, requests: requests || [], adjustments: adj });
  }, [employee, annualType, year, requests, balances]);

  // Monthly breakdown — for each month: leave days (approved), permission count, perm hours
  const monthly = useMemo(() => {
    return MONTH_LABELS.map((label, i) => {
      const m = i + 1;
      let leaveDays = 0, leavePending = 0, leaveCount = 0;
      empReqs.forEach(r => {
        const d = leaveDaysInMonth(r, year, m);
        if (d > 0) {
          leaveCount++;
          if (r.status === 'approved') leaveDays += d;
          else if (r.status === 'pending') leavePending += d;
        }
      });
      const monthPerms = empPerms.filter(p => new Date(p.permission_date).getMonth() + 1 === m && (p.status === 'approved' || p.status === 'pending'));
      const permHours = monthPerms.reduce((s, p) => s + Number(p.hours || 0), 0);
      return { label, m, leaveDays, leavePending, leaveCount, permCount: monthPerms.length, permHours };
    });
  }, [empReqs, empPerms, year]);

  const yrs = employee.join_date ? yearsOfService(employee.join_date) : 0;
  const mth = employee.join_date ? monthsOfService(employee.join_date) % 12 : 0;
  const permsCounted = empPerms.filter(p => p.status === 'approved' || p.status === 'pending');
  const permHoursTotal = permsCounted.reduce((s, p) => s + Number(p.hours || 0), 0);

  const maxLeave = Math.max(0.1, ...monthly.map(m => m.leaveDays + m.leavePending));
  const maxPerm  = Math.max(1, ...monthly.map(m => m.permCount));

  // -------- Per-employee PDF export --------
  const exportEmpPdf = useCallback(async () => {
    setExporting('pdf');
    try {
      const { jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();
      // Header banner
      doc.setFillColor(45, 95, 63);
      doc.rect(0, 0, W, 80, 'F');
      doc.setTextColor(255); doc.setFontSize(9);
      doc.text('EVERGREEN SHIPPING AGENCY SAUDI · HR DEPARTMENT', 40, 22);
      doc.setFontSize(20); doc.setFont('helvetica', 'bold');
      doc.text(`Annual History — ${employee.name}`, 40, 48);
      doc.setFontSize(10); doc.setFont('helvetica', 'normal');
      doc.text(`PSN ${employee.id} · ${LOCATION_LABELS[employee.location] || employee.location || '—'} · ${employee.department || '—'} · Tenure ${yrs}y ${mth}m · Year ${year}`, 40, 64);

      // Summary KPIs
      doc.setTextColor(45, 95, 63); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
      doc.text('SUMMARY', 40, 110);
      doc.autoTable({
        startY: 116,
        head: [['Annual Entitlement', 'Used YTD', 'Pending', 'Remaining', 'Permissions YTD', 'Permission Hours']],
        body: [[
          `${(bal?.entitlement ?? 0).toFixed(1)}d`,
          `${(bal?.used ?? 0).toFixed(1)}d`,
          `${(bal?.pending ?? 0).toFixed(1)}d`,
          `${(bal?.available ?? 0).toFixed(1)}d`,
          permsCounted.length,
          `${permHoursTotal.toFixed(1)}h`,
        ]],
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 10, halign: 'center' },
        margin: { left: 40, right: 40 },
      });

      // Monthly breakdown
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(45, 95, 63);
      doc.text('MONTHLY BREAKDOWN', 40, doc.lastAutoTable.finalY + 24);
      doc.autoTable({
        startY: doc.lastAutoTable.finalY + 30,
        head: [['Month', 'Leave days approved', 'Leave days pending', 'Permission applications', 'Permission hours']],
        body: monthly.map(m => [
          `${m.label} ${year}`,
          m.leaveDays > 0 ? m.leaveDays.toFixed(1) : '—',
          m.leavePending > 0 ? m.leavePending.toFixed(1) : '—',
          m.permCount > 0 ? m.permCount : '—',
          m.permHours > 0 ? m.permHours.toFixed(1) + 'h' : '—',
        ]),
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 9 },
        alternateRowStyles: { fillColor: [248, 248, 245] },
        margin: { left: 40, right: 40 },
      });

      // Leave list
      if (empReqs.length > 0) {
        const yPos = doc.lastAutoTable.finalY + 24;
        if (yPos > 720) { doc.addPage(); }
        const startY = yPos > 720 ? 60 : yPos + 6;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(45, 95, 63);
        doc.text(`LEAVE REQUESTS (${empReqs.length})`, 40, yPos > 720 ? 50 : yPos);
        doc.autoTable({
          startY,
          head: [['#', 'Start', 'End', 'Days', 'Type', 'Status', 'Reason']],
          body: empReqs.map((r, i) => [
            i + 1,
            fmtDateShort(r.start_date),
            fmtDateShort(r.end_date),
            r.days,
            r.leave_type_id || '—',
            r.status || '—',
            (r.reason || '').slice(0, 80),
          ]),
          headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
          bodyStyles: { fontSize: 8 },
          alternateRowStyles: { fillColor: [248, 248, 245] },
          margin: { left: 40, right: 40 },
        });
      }

      // Permissions list
      if (empPerms.length > 0) {
        const yPos = doc.lastAutoTable.finalY + 24;
        if (yPos > 720) { doc.addPage(); }
        const startY = yPos > 720 ? 60 : yPos + 6;
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor(45, 95, 63);
        doc.text(`PERMISSION REQUESTS (${empPerms.length})`, 40, yPos > 720 ? 50 : yPos);
        doc.autoTable({
          startY,
          head: [['#', 'Date', 'Type', 'Hours', 'Status', 'Reason']],
          body: empPerms.map((p, i) => [
            i + 1,
            fmtDateShort(p.permission_date),
            (PERMISSION_TYPES[p.type]?.label) || p.type || '—',
            (p.hours || 0).toFixed(1) + 'h',
            p.status || '—',
            (p.reason || '').slice(0, 80),
          ]),
          headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
          bodyStyles: { fontSize: 8 },
          alternateRowStyles: { fillColor: [248, 248, 245] },
          margin: { left: 40, right: 40 },
        });
      }

      // Footer
      const totalPages = doc.internal.getNumberOfPages();
      for (let i = 1; i <= totalPages; i++) {
        doc.setPage(i);
        doc.setFontSize(8); doc.setTextColor(150);
        doc.text(`Generated ${new Date().toLocaleString()} · Page ${i} of ${totalPages}`, W / 2, doc.internal.pageSize.getHeight() - 16, { align: 'center' });
      }

      const safe = (employee.name || employee.id).replace(/[^a-zA-Z0-9]+/g, '_');
      doc.save(`History_${safe}_${year}.pdf`);
    } catch (e) {
      console.error(e);
      alert('PDF export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [employee, year, bal, monthly, empReqs, empPerms, yrs, mth, permsCounted, permHoursTotal]);

  // -------- Per-employee Excel export --------
  const exportEmpXlsx = useCallback(async () => {
    setExporting('xlsx');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();

      // Sheet 1: Summary
      const summary = [
        ['ANNUAL HISTORY · ' + year],
        [],
        ['Employee', employee.name],
        ['PSN', employee.id],
        ['Location', LOCATION_LABELS[employee.location] || employee.location || '—'],
        ['Department', employee.department || '—'],
        ['Tenure', `${yrs} years ${mth} months`],
        ['Joined', employee.join_date || '—'],
        [],
        ['ANNUAL ENTITLEMENT', Number((bal?.entitlement ?? 0).toFixed(2))],
        ['Days used (approved)', Number((bal?.used ?? 0).toFixed(2))],
        ['Days pending', Number((bal?.pending ?? 0).toFixed(2))],
        ['Days remaining', Number((bal?.available ?? 0).toFixed(2))],
        [],
        ['Permissions YTD', permsCounted.length],
        ['Permission hours total', Number(permHoursTotal.toFixed(2))],
      ];
      const ws1 = XLSX.utils.aoa_to_sheet(summary);
      ws1['!cols'] = [{ wch: 24 }, { wch: 30 }];
      XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

      // Sheet 2: Monthly
      const ws2 = XLSX.utils.aoa_to_sheet([
        ['Month', 'Leave days approved', 'Leave days pending', 'Permission apps', 'Permission hours'],
        ...monthly.map(m => [m.label, Number(m.leaveDays.toFixed(2)), Number(m.leavePending.toFixed(2)), m.permCount, Number(m.permHours.toFixed(2))]),
      ]);
      ws2['!cols'] = [{ wch: 8 }, { wch: 18 }, { wch: 18 }, { wch: 16 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Monthly');

      // Sheet 3: Leave Requests
      if (empReqs.length > 0) {
        const ws3 = XLSX.utils.aoa_to_sheet([
          ['#', 'Start date', 'End date', 'Days', 'Type', 'Status', 'Stage', 'Reason'],
          ...empReqs.map((r, i) => [i + 1, r.start_date, r.end_date, r.days, r.leave_type_id || '—', r.status || '—', r.stage || '—', r.reason || '']),
        ]);
        ws3['!cols'] = [{ wch: 4 }, { wch: 12 }, { wch: 12 }, { wch: 6 }, { wch: 12 }, { wch: 14 }, { wch: 18 }, { wch: 50 }];
        XLSX.utils.book_append_sheet(wb, ws3, 'Leave Requests');
      }

      // Sheet 4: Permissions
      if (empPerms.length > 0) {
        const ws4 = XLSX.utils.aoa_to_sheet([
          ['#', 'Date', 'Type', 'Hours', 'Status', 'Reason'],
          ...empPerms.map((p, i) => [i + 1, p.permission_date, PERMISSION_TYPES[p.type]?.label || p.type || '—', Number((p.hours || 0).toFixed(2)), p.status || '—', p.reason || '']),
        ]);
        ws4['!cols'] = [{ wch: 4 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 12 }, { wch: 50 }];
        XLSX.utils.book_append_sheet(wb, ws4, 'Permissions');
      }

      const safe = (employee.name || employee.id).replace(/[^a-zA-Z0-9]+/g, '_');
      XLSX.writeFile(wb, `History_${safe}_${year}.xlsx`);
    } catch (e) {
      console.error(e);
      alert('Excel export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [employee, year, bal, monthly, empReqs, empPerms, yrs, mth, permsCounted, permHoursTotal]);

  return (
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 sm:p-6 overflow-y-auto"
         style={{ background: 'rgba(15, 25, 20, 0.55)', backdropFilter: 'blur(2px)' }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-5xl rounded-2xl bg-white shadow-2xl my-auto" style={{ maxHeight: '92vh', overflow: 'auto' }}>
        {/* HEADER */}
        <div className="px-6 py-5 sm:px-8 sm:py-6 sticky top-0 z-10"
             style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4 min-w-0">
              <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center text-base sm:text-lg font-bold flex-shrink-0"
                   style={{ background: 'rgba(255,255,255,0.18)', border: '2px solid rgba(255,255,255,0.4)' }}>
                {getInitials(employee.name)}
              </div>
              <div className="min-w-0">
                <div className="text-[10px] tracking-[0.25em] opacity-80">— ANNUAL HISTORY · {year}</div>
                <h2 className="text-xl sm:text-2xl font-serif truncate">{employee.name}</h2>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs opacity-90 mt-1">
                  <span className="font-mono">{employee.id}</span>
                  <span className="inline-flex items-center gap-1">
                    <MapPin className="w-3 h-3" /> {LOCATION_LABELS[employee.location] || employee.location || '—'}
                  </span>
                  <span>·</span>
                  <span>{employee.department || '—'}</span>
                  <span>·</span>
                  <span>{yrs}y {mth}m tenure</span>
                </div>
              </div>
            </div>
            <button onClick={onClose}
                    className="p-2 rounded-full transition-colors flex-shrink-0"
                    style={{ background: 'rgba(255,255,255,0.15)', color: '#fff' }}>
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-2 mt-4">
            <button onClick={exportEmpPdf} disabled={!!exporting}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
                    style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}>
              <FileText className="w-3.5 h-3.5" /> {exporting === 'pdf' ? 'Generating PDF…' : 'Export PDF'}
            </button>
            <button onClick={exportEmpXlsx} disabled={!!exporting}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
                    style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}>
              <FileSpreadsheet className="w-3.5 h-3.5" /> {exporting === 'xlsx' ? 'Generating Excel…' : 'Export Excel'}
            </button>
          </div>
        </div>

        {/* BODY */}
        <div className="px-6 py-5 sm:px-8 sm:py-6 space-y-5">
          {/* KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3">
            <KpiCard label="ENTITLEMENT" value={(bal?.entitlement ?? 0).toFixed(1)} unit="days" tone="neutral" />
            <KpiCard label="USED YTD" value={(bal?.used ?? 0).toFixed(1)} unit="days" tone="warm" />
            <KpiCard label="PENDING" value={(bal?.pending ?? 0).toFixed(1)} unit="days" tone="amber" />
            <KpiCard label="REMAINING" value={(bal?.available ?? 0).toFixed(1)} unit="days" tone="green" />
            <KpiCard label="PERMISSIONS" value={permsCounted.length} unit={`${permHoursTotal.toFixed(1)}h`} tone="purple" />
          </div>

          {/* MONTHLY TIMELINE */}
          <div className="rounded-xl border p-4" style={{ borderColor: 'var(--border-soft)' }}>
            <div className="text-[10px] tracking-[0.25em] opacity-60 mb-3">MONTHLY ACTIVITY · {year}</div>
            <div className="space-y-3">
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold mb-1.5" style={{ color: '#2D5F3F' }}>
                  <Plane className="w-3 h-3" /> Leave days
                </div>
                <div className="flex items-end gap-1 h-16">
                  {monthly.map((m, i) => {
                    const total = m.leaveDays + m.leavePending;
                    const h = (total / maxLeave) * 100;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
                        <div className="text-[9px] font-bold tabular-nums" style={{ color: total > 0 ? '#2D5F3F' : '#D1D5DB' }}>
                          {total > 0 ? total.toFixed(1) : ''}
                        </div>
                        <div className="w-full rounded-t flex flex-col-reverse overflow-hidden" style={{ height: `${Math.max(2, h)}%`, minHeight: total > 0 ? 4 : 2 }}>
                          {m.leaveDays > 0 && (
                            <div style={{ height: `${(m.leaveDays / total) * 100}%`, background: 'linear-gradient(180deg, #4A8060 0%, #2D5F3F 100%)' }} />
                          )}
                          {m.leavePending > 0 && (
                            <div style={{ height: `${(m.leavePending / total) * 100}%`, background: '#F59E0B' }} />
                          )}
                          {total === 0 && <div style={{ height: '100%', background: '#E5E7EB' }} />}
                        </div>
                        <div className="text-[9px] opacity-60 font-medium">{m.label}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2 text-xs font-semibold mb-1.5" style={{ color: '#C97A4F' }}>
                  <Coffee className="w-3 h-3" /> Permissions
                </div>
                <div className="flex items-end gap-1 h-12">
                  {monthly.map((m, i) => {
                    const h = (m.permCount / maxPerm) * 100;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center justify-end h-full gap-1">
                        <div className="text-[9px] font-bold tabular-nums" style={{ color: m.permCount > 0 ? '#C97A4F' : '#D1D5DB' }}>
                          {m.permCount > 0 ? m.permCount : ''}
                        </div>
                        <div className="w-full rounded-t" style={{
                          height: `${Math.max(2, h)}%`,
                          background: m.permCount > 0 ? 'linear-gradient(180deg, #E0A079 0%, #C97A4F 100%)' : '#E5E7EB',
                        }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* LEAVE REQUESTS LIST */}
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-soft)' }}>
            <div className="px-4 py-2.5 flex items-center justify-between" style={{ background: 'var(--paper-soft, #FBFAF6)', borderBottom: '1px solid var(--border-soft)' }}>
              <div className="text-[10px] tracking-[0.25em] opacity-60">LEAVE REQUESTS · {empReqs.length}</div>
            </div>
            {empReqs.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs opacity-60">No leave requests in {year}.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] tracking-[0.15em] opacity-60" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                      <th className="text-left px-4 py-2 font-semibold">DATES</th>
                      <th className="text-right px-3 py-2 font-semibold">DAYS</th>
                      <th className="text-left px-3 py-2 font-semibold">TYPE</th>
                      <th className="text-left px-3 py-2 font-semibold">STATUS</th>
                      <th className="text-left px-3 py-2 font-semibold">REASON</th>
                    </tr>
                  </thead>
                  <tbody>
                    {empReqs.map((r, idx) => {
                      const sp = leaveStatusPill(r);
                      return (
                        <tr key={r.id} style={{ borderBottom: idx < empReqs.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                          <td className="px-4 py-2.5 text-xs">
                            <div className="font-medium" style={{ color: 'var(--ink)' }}>
                              {fmtDateShort(r.start_date)} <span className="opacity-50">→</span> {fmtDateShort(r.end_date)}
                            </div>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{r.days}</td>
                          <td className="px-3 py-2.5 text-xs opacity-80">{r.leave_type_id || '—'}</td>
                          <td className="px-3 py-2.5">
                            <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                  style={{ background: sp.bg, color: sp.color }}>{sp.label}</span>
                          </td>
                          <td className="px-3 py-2.5 text-xs opacity-80 max-w-[280px] truncate">{r.reason || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* PERMISSIONS LIST */}
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-soft)' }}>
            <div className="px-4 py-2.5 flex items-center justify-between" style={{ background: 'var(--paper-soft, #FBFAF6)', borderBottom: '1px solid var(--border-soft)' }}>
              <div className="text-[10px] tracking-[0.25em] opacity-60">PERMISSION REQUESTS · {empPerms.length}</div>
            </div>
            {empPerms.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs opacity-60">No permission requests in {year}.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] tracking-[0.15em] opacity-60" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                      <th className="text-left px-4 py-2 font-semibold">DATE</th>
                      <th className="text-left px-3 py-2 font-semibold">TYPE</th>
                      <th className="text-right px-3 py-2 font-semibold">HOURS</th>
                      <th className="text-left px-3 py-2 font-semibold">STATUS</th>
                      <th className="text-left px-3 py-2 font-semibold">REASON</th>
                    </tr>
                  </thead>
                  <tbody>
                    {empPerms.map((p, idx) => {
                      const sp = permStatusPill(p);
                      return (
                        <tr key={p.id} style={{ borderBottom: idx < empPerms.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                          <td className="px-4 py-2.5 text-xs font-medium" style={{ color: 'var(--ink)' }}>{fmtDateShort(p.permission_date)}</td>
                          <td className="px-3 py-2.5 text-xs">
                            <span className="inline-block px-2 py-0.5 rounded-full"
                                  style={{ background: p.type === 'late_arrival' ? 'rgba(245,158,11,0.1)' : 'rgba(107,91,168,0.1)',
                                           color: p.type === 'late_arrival' ? '#92400E' : '#5A4A8A' }}>
                              {PERMISSION_TYPES[p.type]?.label || p.type || '—'}
                            </span>
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums font-semibold">{Number(p.hours || 0).toFixed(1)}h</td>
                          <td className="px-3 py-2.5">
                            <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold"
                                  style={{ background: sp.bg, color: sp.color }}>{sp.label}</span>
                          </td>
                          <td className="px-3 py-2.5 text-xs opacity-80 max-w-[280px] truncate">{p.reason || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ===========================================================================
// SHARED COMPONENTS
// ===========================================================================
function HeroCard({ gradient, icon, label, value, unit, caption }) {
  return (
    <div className="rounded-2xl p-4 sm:p-5 relative overflow-hidden" style={{ background: gradient, color: '#fff' }}>
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full -mr-8 -mt-8" style={{ background: 'rgba(255,255,255,0.1)' }} />
      <div className="absolute bottom-0 right-0 w-16 h-16 rounded-full -mr-4 -mb-4" style={{ background: 'rgba(255,255,255,0.08)' }} />
      <div className="relative">
        <div className="flex items-center gap-2 text-[10px] tracking-[0.2em] opacity-90 mb-2">{icon} {label}</div>
        <div className="flex items-baseline gap-1.5">
          <div className="text-3xl sm:text-4xl font-bold tabular-nums">{value}</div>
          <div className="text-xs opacity-80">{unit}</div>
        </div>
        {caption && <div className="text-[10px] opacity-75 mt-1">{caption}</div>}
      </div>
    </div>
  );
}

function KpiCard({ label, value, unit, tone }) {
  const palettes = {
    neutral: { bg: '#F9FAFB',  border: '#E5E7EB', color: '#374151' },
    warm:    { bg: '#FFF7ED',  border: '#FED7AA', color: '#9A3412' },
    amber:   { bg: '#FFFBEB',  border: '#FCD34D', color: '#92400E' },
    green:   { bg: '#F0FDF4',  border: '#BBF7D0', color: '#166534' },
    purple:  { bg: '#F5F3FF',  border: '#DDD6FE', color: '#6D28D9' },
  };
  const p = palettes[tone] || palettes.neutral;
  return (
    <div className="rounded-xl p-3 sm:p-4 text-center" style={{ background: p.bg, border: '1px solid ' + p.border }}>
      <div className="text-[9px] tracking-[0.2em] font-semibold mb-1" style={{ color: p.color, opacity: 0.7 }}>{label}</div>
      <div className="text-2xl font-bold tabular-nums" style={{ color: p.color }}>{value}</div>
      <div className="text-[10px] opacity-70 mt-0.5" style={{ color: p.color }}>{unit}</div>
    </div>
  );
}

function EmptyState({ text, icon }) {
  return (
    <div className="px-5 py-10 text-center text-xs opacity-60 flex flex-col items-center gap-2">
      <div className="opacity-50">{icon}</div>
      <div>{text}</div>
    </div>
  );
}
