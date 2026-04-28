import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Download, FileSpreadsheet, FileText, Search, Users, BarChart3,
  CalendarDays, Coffee, TrendingUp, AlertCircle, CheckCircle2, Clock,
  Plane, Sparkles, Filter as FilterIcon, MapPin, Building2, X,
  ChevronRight, ChevronLeft, History, Calendar
} from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import {
  calculateBalance, yearsOfService, monthsOfService,
  fmtDate, fmtDateShort, getInitials, avatarColor, LOCATION_LABELS
} from '../lib/leaveLogic.js';
import { PERMISSION_QUOTA, PERMISSION_TYPES, summariseMonth } from '../lib/permissionLogic.js';

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_FULL   = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// Status helpers ────────────────────────────────────────────────────────────
function utilisationStatus(used, ent) {
  if (!ent) return { label: 'No data', color: '#9CA3AF', bg: '#F3F4F6', tone: 'neutral' };
  const pct = (used / ent) * 100;
  if (pct >= 90) return { label: 'Critical', color: '#B83A2E', bg: '#FEE2E2', tone: 'critical' };
  if (pct >= 60) return { label: 'Watch',    color: '#92400E', bg: '#FEF3C7', tone: 'warn' };
  return { label: 'Healthy', color: '#15803D', bg: '#DCFCE7', tone: 'ok' };
}
function quotaStatus(monthSummary) {
  if (monthSummary.overQuota) return { label: 'Over quota', color: '#B83A2E', bg: '#FEE2E2', tone: 'critical' };
  if (monthSummary.atQuota)   return { label: 'At quota',   color: '#92400E', bg: '#FEF3C7', tone: 'warn' };
  if (monthSummary.occurrences === 0) return { label: 'Untouched', color: '#6B7280', bg: '#F3F4F6', tone: 'neutral' };
  return { label: 'Within quota', color: '#15803D', bg: '#DCFCE7', tone: 'ok' };
}
function leaveStatusPill(status) {
  if (status === 'approved')              return { label: 'Approved', color: '#15803D', bg: '#DCFCE7' };
  if (status === 'pending')               return { label: 'Pending',  color: '#92400E', bg: '#FEF3C7' };
  if (status === 'rejected')              return { label: 'Rejected', color: '#B83A2E', bg: '#FEE2E2' };
  if (status === 'pending_substitutes')   return { label: 'Awaiting cover', color: '#6B5BA8', bg: '#EDE9FE' };
  if (status === 'pending_manager')       return { label: 'Awaiting manager', color: '#C97A4F', bg: '#FFEDD5' };
  if (status === 'pending_hr')            return { label: 'Awaiting HR',     color: '#5A8A9A', bg: '#DBEAFE' };
  if (status === 'rejected_by_substitute')return { label: 'Cover declined',  color: '#B83A2E', bg: '#FEE2E2' };
  if (status === 'rejected_by_manager')   return { label: 'Mgr rejected',    color: '#B83A2E', bg: '#FEE2E2' };
  if (status === 'rejected_by_hr')        return { label: 'HR rejected',     color: '#B83A2E', bg: '#FEE2E2' };
  return { label: status || '—', color: '#6B7280', bg: '#F3F4F6' };
}
function permStatusPill(status) {
  if (status === 'approved') return { label: 'Approved', color: '#15803D', bg: '#DCFCE7' };
  if (status === 'pending')  return { label: 'Pending',  color: '#92400E', bg: '#FEF3C7' };
  if (status === 'rejected') return { label: 'Rejected', color: '#B83A2E', bg: '#FEE2E2' };
  return { label: status || '—', color: '#6B7280', bg: '#F3F4F6' };
}

// Calendar-overlap helper: how many of req.days fall inside the given (year, month).
// Uses a simple proportional split on calendar overlap; sufficient for reporting.
function leaveDaysInMonth(req, year, monthNum) {
  if (!req?.start_date || !req?.end_date) return 0;
  const monthStart = new Date(year, monthNum - 1, 1);
  const monthEnd   = new Date(year, monthNum, 0); // last day of month
  const reqStart   = new Date(req.start_date);
  const reqEnd     = new Date(req.end_date);
  if (reqEnd < monthStart || reqStart > monthEnd) return 0;
  const overlapStart = reqStart > monthStart ? reqStart : monthStart;
  const overlapEnd   = reqEnd   < monthEnd   ? reqEnd   : monthEnd;
  const dayMs = 86400000;
  const overlapDays = Math.round((overlapEnd - overlapStart) / dayMs) + 1;
  const totalDays   = Math.round((reqEnd     - reqStart)     / dayMs) + 1;
  if (totalDays <= 0) return 0;
  return Number(req.days || 0) * (overlapDays / totalDays);
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================
export default function InsightsView({ me, employees, leaveTypes, requests, balances, empMap, permissions: passedPerms }) {
  const [view, setView]               = useState('leave');
  const [year, setYear]               = useState(new Date().getFullYear());
  const [month, setMonth]             = useState('all');
  const [dept, setDept]               = useState('all');
  const [loc, setLoc]                 = useState('all');
  const [search, setSearch]           = useState('');
  const [permissions, setPermissions] = useState(passedPerms || []);
  const [permLoading, setPermLoading] = useState(false);
  const [exporting, setExporting]     = useState('');
  const [viewedEmpId, setViewedEmpId] = useState(null);

  useEffect(() => {
    if (passedPerms && passedPerms.length >= 0) { setPermissions(passedPerms); return; }
    let mounted = true;
    setPermLoading(true);
    (async () => {
      try {
        const rows = await directGet('permission_requests',
          `select=*&order=permission_date.desc`, { timeoutMs: 15000 });
        if (mounted) setPermissions(rows || []);
      } catch (e) {
        console.warn('permissions fetch failed', e);
        if (mounted) setPermissions([]);
      } finally { if (mounted) setPermLoading(false); }
    })();
    return () => { mounted = false; };
  }, [passedPerms]);

  // Sort: location → department → name
  const filteredEmps = useMemo(() => {
    return (employees || []).filter(e => {
      if (dept !== 'all' && e.department !== dept) return false;
      if (loc  !== 'all' && e.location   !== loc)  return false;
      if (search) {
        const q = search.toLowerCase();
        if (!e.name?.toLowerCase().includes(q) && !e.id?.toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort((a, b) => {
      const la = a.location || ''; const lb = b.location || '';
      if (la !== lb) return la.localeCompare(lb);
      const da = a.department || ''; const db = b.department || '';
      if (da !== db) return da.localeCompare(db);
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [employees, dept, loc, search]);

  const departments = useMemo(() => Array.from(new Set((employees || []).map(e => e.department).filter(Boolean))).sort(), [employees]);
  const locations   = useMemo(() => Array.from(new Set((employees || []).map(e => e.location).filter(Boolean))).sort(),   [employees]);
  const years       = useMemo(() => { const n = new Date().getFullYear(); return [n+1, n, n-1, n-2]; }, []);
  const annualType  = useMemo(() => leaveTypes?.find(t => t.id === 'annual') || leaveTypes?.[0], [leaveTypes]);

  const isMonthMode = month !== 'all';
  const monthNum    = isMonthMode ? Number(month) : null;
  const monthLabel  = isMonthMode ? `${MONTH_FULL[monthNum-1]} ${year}` : null;

  // Leave rows — month-aware
  const leaveRows = useMemo(() => {
    if (!annualType) return [];
    const all = filteredEmps.map(emp => {
      const adj = (balances || []).find(b => b.employee_id === emp.id && b.leave_type_id === annualType.id && b.year === year) || {};
      const bal = calculateBalance({ employee: emp, leaveType: annualType, year, requests: requests || [], adjustments: adj });
      const empReqs = (requests || []).filter(r => r.employee_id === emp.id && new Date(r.start_date).getFullYear() === year);
      const lastApproved = empReqs.filter(r => r.status === 'approved').sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0];
      const yrs = emp.join_date ? yearsOfService(emp.join_date) : 0;
      const mth = emp.join_date ? monthsOfService(emp.join_date) % 12 : 0;
      let monthDays = 0, monthApprovedReqs = [], monthPendingReqs = [];
      if (isMonthMode) {
        monthApprovedReqs = empReqs.filter(r => r.status === 'approved' && leaveDaysInMonth(r, year, monthNum) > 0);
        monthPendingReqs  = empReqs.filter(r => (r.status === 'pending' || r.status?.startsWith('pending_')) && leaveDaysInMonth(r, year, monthNum) > 0);
        monthDays = monthApprovedReqs.reduce((s, r) => s + leaveDaysInMonth(r, year, monthNum), 0);
      }
      return { emp, bal, lastApproved, yrs, mth, monthDays, monthApprovedReqs, monthPendingReqs };
    });
    if (isMonthMode) return all.filter(r => r.monthApprovedReqs.length > 0 || r.monthPendingReqs.length > 0);
    return all;
  }, [filteredEmps, annualType, year, balances, requests, isMonthMode, monthNum]);

  // Permission rows — month-aware
  const permRows = useMemo(() => {
    const now = new Date();
    const currentMs = String(now.getMonth() + 1).padStart(2, '0');
    const isCurrentYear = year === now.getFullYear();
    const all = filteredEmps.map(emp => {
      const empPerms = (permissions || []).filter(p => p.employee_id === emp.id && new Date(p.permission_date).getFullYear() === year);
      const counted  = empPerms.filter(p => p.status === 'approved' || p.status === 'pending');
      const lateApps  = counted.filter(p => p.type === 'late_arrival');
      const earlyApps = counted.filter(p => p.type === 'early_leave');
      const lateHours  = lateApps.reduce((s, r) => s + Number(r.hours || 0), 0);
      const earlyHours = earlyApps.reduce((s, r) => s + Number(r.hours || 0), 0);
      const totalHours = lateHours + earlyHours;
      const lastPerm = counted.sort((a, b) => new Date(b.permission_date) - new Date(a.permission_date))[0];
      const currentMonthRows = isCurrentYear ? counted.filter(p => p.permission_date?.startsWith(`${year}-${currentMs}`)) : [];
      const monthSummary = summariseMonth(currentMonthRows);
      let monthPerms = [];
      if (isMonthMode) {
        const ms = String(monthNum).padStart(2, '0');
        monthPerms = counted.filter(p => p.permission_date?.startsWith(`${year}-${ms}`));
      }
      return {
        emp, lateApps, earlyApps, lateCount: lateApps.length, earlyCount: earlyApps.length,
        totalCount: counted.length, lateHours, earlyHours, totalHours,
        lastPerm, monthSummary, monthPerms,
      };
    });
    if (isMonthMode) return all.filter(r => r.monthPerms.length > 0);
    return all;
  }, [filteredEmps, permissions, year, isMonthMode, monthNum]);

  // Aggregates — month-aware
  const leaveAgg = useMemo(() => {
    if (isMonthMode) {
      const monthDays  = leaveRows.reduce((s, r) => s + r.monthDays, 0);
      const monthApps  = leaveRows.reduce((s, r) => s + r.monthApprovedReqs.length, 0);
      const monthPend  = leaveRows.reduce((s, r) => s + r.monthPendingReqs.length, 0);
      return { totalStaff: leaveRows.length, monthDays, monthApps, monthPendingApps: monthPend, avgPerPerson: leaveRows.length > 0 ? monthDays / leaveRows.length : 0 };
    }
    const totalEnt  = leaveRows.reduce((s, r) => s + (r.bal?.entitlement || 0), 0);
    const totalUsed = leaveRows.reduce((s, r) => s + (r.bal?.used || 0), 0);
    const totalPend = leaveRows.reduce((s, r) => s + (r.bal?.pending || 0), 0);
    const totalRem  = leaveRows.reduce((s, r) => s + (r.bal?.available || 0), 0);
    return { totalStaff: leaveRows.length, totalEnt, totalUsed, totalPend, totalRem };
  }, [leaveRows, isMonthMode]);

  const permAgg = useMemo(() => {
    const empIds = new Set(filteredEmps.map(e => e.id));
    const allYear = (permissions || []).filter(p =>
      (p.status === 'approved' || p.status === 'pending') &&
      new Date(p.permission_date).getFullYear() === year &&
      empIds.has(p.employee_id)
    );
    if (isMonthMode) {
      const ms = String(monthNum).padStart(2, '0');
      const monthRows = allYear.filter(p => p.permission_date?.startsWith(`${year}-${ms}`));
      const monthPeople = new Set(monthRows.map(p => p.employee_id)).size;
      const monthHours  = monthRows.reduce((s, r) => s + Number(r.hours || 0), 0);
      const lateCount   = monthRows.filter(p => p.type === 'late_arrival').length;
      const earlyCount  = monthRows.filter(p => p.type === 'early_leave').length;
      return { monthApps: monthRows.length, monthPeople, monthHours, lateCount, earlyCount };
    }
    const cms = String(new Date().getMonth() + 1).padStart(2, '0');
    const isCurrentYear = year === new Date().getFullYear();
    const monthRows = isCurrentYear ? allYear.filter(p => p.permission_date?.startsWith(`${year}-${cms}`)) : [];
    const monthPeople = new Set(monthRows.map(p => p.employee_id)).size;
    const monthHours  = monthRows.reduce((s, r) => s + Number(r.hours || 0), 0);
    const yearPeople  = new Set(allYear.map(p => p.employee_id)).size;
    const yearHours   = allYear.reduce((s, r) => s + Number(r.hours || 0), 0);
    return { monthApps: monthRows.length, monthPeople, monthHours, yearApps: allYear.length, yearPeople, yearHours };
  }, [permissions, year, filteredEmps, isMonthMode, monthNum]);

  const monthlyCounts = useMemo(() => {
    const buckets = Array(12).fill(0);
    const empIds = new Set(filteredEmps.map(e => e.id));
    (permissions || []).forEach(p => {
      if (p.status !== 'approved' && p.status !== 'pending') return;
      if (!empIds.has(p.employee_id)) return;
      const d = new Date(p.permission_date);
      if (d.getFullYear() !== year) return;
      const m = d.getMonth();
      if (m >= 0 && m < 12) buckets[m]++;
    });
    return buckets;
  }, [permissions, year, filteredEmps]);

  const topUsers = useMemo(
    () => [...permRows].sort((a, b) => b.totalCount - a.totalCount).filter(r => r.totalCount > 0).slice(0, 5),
    [permRows]
  );

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

  // ===== EXPORT FUNCTIONS =====
  const exportLeavePdf = useCallback(async () => {
    setExporting('pdf');
    try {
      const { jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();
      doc.setFillColor(45, 95, 63); doc.rect(0, 0, W, 64, 'F');
      doc.setTextColor(255); doc.setFontSize(18); doc.setFont('helvetica', 'bold');
      doc.text(isMonthMode ? `Leave — ${monthLabel}` : 'Annual Leave Summary', 40, 32);
      doc.setFontSize(11); doc.setFont('helvetica', 'normal');
      doc.text(isMonthMode ? `Staff who applied for leave in ${monthLabel}` : `${year}`, 40, 50);
      doc.setFontSize(9);
      doc.text('Evergreen Shipping Agency Saudi · HR Department', W - 40, 50, { align: 'right' });
      doc.setTextColor(60, 60, 60);
      doc.text(`Generated ${new Date().toLocaleString()}`, W - 40, 32, { align: 'right' });

      doc.setTextColor(45, 95, 63); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
      const summary = isMonthMode
        ? `Staff in month: ${leaveAgg.totalStaff}    ·    Total leave days: ${leaveAgg.monthDays.toFixed(1)}    ·    Approved applications: ${leaveAgg.monthApps}    ·    Pending: ${leaveAgg.monthPendingApps}`
        : `Staff: ${leaveAgg.totalStaff}    ·    Total entitlement: ${leaveAgg.totalEnt.toFixed(1)}d    ·    Used: ${leaveAgg.totalUsed.toFixed(1)}d    ·    Pending: ${leaveAgg.totalPend.toFixed(1)}d    ·    Remaining: ${leaveAgg.totalRem.toFixed(1)}d`;
      doc.text(summary, 40, 86);

      const filterStr = [
        dept !== 'all' ? `Dept: ${dept}` : null,
        loc  !== 'all' ? `Location: ${LOCATION_LABELS[loc] || loc}` : null,
        search ? `Search: "${search}"` : null,
      ].filter(Boolean).join('   ·   ') || 'All staff';
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(110, 110, 110);
      doc.text(`Filter: ${filterStr}`, 40, 102);

      const head = isMonthMode
        ? [['#','PSN','Name','Loc','Dept','Days in month','Approved apps','Pending apps','Last leave']]
        : [['#','PSN','Name','Loc','Dept','Joined','YOS','Entitle','Used','Pending','Remain','Last leave','Status']];
      const body = isMonthMode
        ? leaveRows.map((r, i) => [
            i + 1, r.emp.id, r.emp.name, LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
            r.emp.department || '—',
            r.monthDays.toFixed(1), r.monthApprovedReqs.length, r.monthPendingReqs.length,
            r.lastApproved ? fmtDateShort(r.lastApproved.start_date) : '—',
          ])
        : leaveRows.map((r, i) => {
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

      doc.autoTable({
        startY: 116, head, body,
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9, fontStyle: 'bold' },
        bodyStyles: { fontSize: 8, textColor: 50 },
        alternateRowStyles: { fillColor: [248, 248, 245] },
        columnStyles: { 0: { halign: 'right', cellWidth: 22 } },
        margin: { left: 40, right: 40 },
        didDrawPage: () => {
          const p = doc.internal.getCurrentPageInfo().pageNumber;
          doc.setFontSize(8); doc.setTextColor(150);
          doc.text(`Page ${p}`, W / 2, doc.internal.pageSize.getHeight() - 16, { align: 'center' });
        },
      });

      const fname = isMonthMode
        ? `Leave_${MONTH_LABELS[monthNum-1]}_${year}.pdf`
        : `Annual_Leave_Summary_${year}.pdf`;
      doc.save(fname);
    } catch (e) { console.error(e); alert('PDF export failed: ' + (e.message || e)); }
    finally { setExporting(''); }
  }, [leaveRows, leaveAgg, year, dept, loc, search, isMonthMode, monthNum, monthLabel]);

  const exportLeaveXlsx = useCallback(async () => {
    setExporting('xlsx');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      let headers, rows;
      if (isMonthMode) {
        headers = ['#','PSN','Name','Location','Department','Days in month','Approved apps','Pending apps','Last leave'];
        rows = leaveRows.map((r, i) => [
          i + 1, r.emp.id, r.emp.name, LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
          r.emp.department || '—',
          Number(r.monthDays.toFixed(2)), r.monthApprovedReqs.length, r.monthPendingReqs.length,
          r.lastApproved ? r.lastApproved.start_date : '—',
        ]);
      } else {
        headers = ['#','PSN','Name','Location','Department','Joined','Years of Service','Entitlement','Used','Pending','Remaining','Last leave','Status'];
        rows = leaveRows.map((r, i) => [
          i + 1, r.emp.id, r.emp.name, LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
          r.emp.department || '—', r.emp.join_date || '—', `${r.yrs}y ${r.mth}m`,
          Number((r.bal?.entitlement ?? 0).toFixed(2)),
          Number((r.bal?.used        ?? 0).toFixed(2)),
          Number((r.bal?.pending     ?? 0).toFixed(2)),
          Number((r.bal?.available   ?? 0).toFixed(2)),
          r.lastApproved ? r.lastApproved.start_date : '—',
          utilisationStatus(r.bal?.used || 0, r.bal?.entitlement || 0).label,
        ]);
      }
      const totalsRow = isMonthMode
        ? ['', '', `TOTAL (${leaveRows.length} staff)`, '', '',
           Number(leaveAgg.monthDays.toFixed(2)), leaveAgg.monthApps, leaveAgg.monthPendingApps, '']
        : ['', '', `TOTAL (${leaveRows.length} staff)`, '', '', '', '',
           Number(leaveAgg.totalEnt.toFixed(2)),
           Number(leaveAgg.totalUsed.toFixed(2)),
           Number(leaveAgg.totalPend.toFixed(2)),
           Number(leaveAgg.totalRem.toFixed(2)), '', ''];
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows, [], totalsRow]);
      ws['!cols'] = headers.map(h => ({ wch: Math.max(10, h.length + 2) }));
      ws['!cols'][2] = { wch: 32 };
      XLSX.utils.book_append_sheet(wb, ws, isMonthMode ? `${MONTH_LABELS[monthNum-1]} ${year}` : 'Annual Leave');

      if (!isMonthMode && deptBreakdown.length > 0) {
        const ws2 = XLSX.utils.aoa_to_sheet([
          ['Department', 'Staff', 'Total Entitle', 'Used', 'Remaining'],
          ...deptBreakdown.map(d => [d.dept, d.staff, Number(d.ent.toFixed(2)), Number(d.used.toFixed(2)), Number(d.rem.toFixed(2))]),
        ]);
        XLSX.utils.book_append_sheet(wb, ws2, 'By Department');
      }
      const fname = isMonthMode
        ? `Leave_${MONTH_LABELS[monthNum-1]}_${year}.xlsx`
        : `Annual_Leave_Summary_${year}.xlsx`;
      XLSX.writeFile(wb, fname);
    } catch (e) { console.error(e); alert('Excel export failed: ' + (e.message || e)); }
    finally { setExporting(''); }
  }, [leaveRows, leaveAgg, deptBreakdown, year, isMonthMode, monthNum]);

  const exportPermPdf = useCallback(async () => {
    setExporting('pdf');
    try {
      const { jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();
      doc.setFillColor(45, 95, 63); doc.rect(0, 0, W, 64, 'F');
      doc.setTextColor(255); doc.setFontSize(18); doc.setFont('helvetica', 'bold');
      doc.text(isMonthMode ? `Permissions — ${monthLabel}` : 'Permissions Summary', 40, 32);
      doc.setFontSize(11); doc.setFont('helvetica', 'normal');
      doc.text(isMonthMode ? `Permissions applied in ${monthLabel}` : `${year}`, 40, 50);
      doc.setFontSize(9);
      doc.text('Evergreen Shipping Agency Saudi · HR Department', W - 40, 50, { align: 'right' });
      doc.setTextColor(60, 60, 60);
      doc.text(`Generated ${new Date().toLocaleString()}`, W - 40, 32, { align: 'right' });
      doc.setTextColor(45, 95, 63); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
      const summary = isMonthMode
        ? `${permAgg.monthApps} applications · ${permAgg.monthPeople} people · ${permAgg.monthHours.toFixed(1)}h    Late: ${permAgg.lateCount}    Early: ${permAgg.earlyCount}`
        : `This month: ${permAgg.monthApps} apps · ${permAgg.monthPeople} ppl · ${permAgg.monthHours.toFixed(1)}h    YTD: ${permAgg.yearApps} apps · ${permAgg.yearPeople} ppl · ${permAgg.yearHours.toFixed(1)}h`;
      doc.text(summary, 40, 86);

      if (!isMonthMode) {
        doc.setFontSize(10); doc.text('Monthly Breakdown', 40, 116);
        doc.autoTable({
          startY: 124, head: [MONTH_LABELS], body: [monthlyCounts],
          headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
          bodyStyles: { fontSize: 9, halign: 'center' }, margin: { left: 40, right: 40 },
        });
      }
      const detailY = isMonthMode ? 110 : doc.lastAutoTable.finalY + 24;
      doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text(isMonthMode ? 'Applications' : 'Per-Employee Detail', 40, detailY - 6);
      doc.autoTable({
        startY: detailY,
        head: [['#','PSN','Name','Loc','Dept','Late','Late hrs','Early','Early hrs','Total apps','Total hrs','Last']],
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
      const fname = isMonthMode
        ? `Permissions_${MONTH_LABELS[monthNum-1]}_${year}.pdf`
        : `Permissions_Summary_${year}.pdf`;
      doc.save(fname);
    } catch (e) { console.error(e); alert('PDF export failed: ' + (e.message || e)); }
    finally { setExporting(''); }
  }, [permRows, permAgg, monthlyCounts, year, isMonthMode, monthNum, monthLabel]);

  const exportPermXlsx = useCallback(async () => {
    setExporting('xlsx');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const headers = ['#','PSN','Name','Location','Department','Late count','Late hours','Early count','Early hours','Total apps','Total hours','Last permission'];
      const rows = permRows.map((r, i) => [
        i + 1, r.emp.id, r.emp.name, LOCATION_LABELS[r.emp.location] || r.emp.location || '—',
        r.emp.department || '—', r.lateCount, Number(r.lateHours.toFixed(2)),
        r.earlyCount, Number(r.earlyHours.toFixed(2)),
        r.totalCount, Number(r.totalHours.toFixed(2)),
        r.lastPerm ? r.lastPerm.permission_date : '—',
      ]);
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      XLSX.utils.book_append_sheet(wb, ws, isMonthMode ? `${MONTH_LABELS[monthNum-1]} ${year}` : 'Permissions');
      if (!isMonthMode) {
        const ws2 = XLSX.utils.aoa_to_sheet([
          ['Month', 'Applications'],
          ...MONTH_LABELS.map((m, i) => [m, monthlyCounts[i]]), [],
          ['TOTAL', monthlyCounts.reduce((s, n) => s + n, 0)],
        ]);
        XLSX.utils.book_append_sheet(wb, ws2, 'Monthly');
      }
      const fname = isMonthMode
        ? `Permissions_${MONTH_LABELS[monthNum-1]}_${year}.xlsx`
        : `Permissions_Summary_${year}.xlsx`;
      XLSX.writeFile(wb, fname);
    } catch (e) { console.error(e); alert('Excel export failed: ' + (e.message || e)); }
    finally { setExporting(''); }
  }, [permRows, monthlyCounts, year, isMonthMode, monthNum]);

  // ===== RENDER =====
  const exportPdf  = view === 'leave' ? exportLeavePdf  : exportPermPdf;
  const exportXlsx = view === 'leave' ? exportLeaveXlsx : exportPermXlsx;

  return (
    <div className="fade-in">
      <div className="mb-5 sm:mb-6">
        <div className="text-[10px] tracking-[0.25em] opacity-60 mb-1">— INSIGHTS</div>
        <h1 className="text-3xl sm:text-4xl font-serif" style={{ color: 'var(--ink)' }}>Reports & Analytics</h1>
        <p className="text-sm opacity-70 mt-1">Live snapshots of leave usage and permission quotas across the organisation.</p>
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
                style={{
                  borderColor: isMonthMode ? '#2D5F3F' : 'var(--border-soft)',
                  background: isMonthMode ? 'rgba(45,95,63,0.06)' : 'transparent',
                  color: isMonthMode ? '#2D5F3F' : 'inherit',
                  fontWeight: isMonthMode ? 600 : 400,
                }}>
          <option value="all">All months</option>
          {MONTH_LABELS.map((m, i) => <option key={i+1} value={String(i+1)}>{MONTH_FULL[i]} {year}</option>)}
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
        <div className="rounded-xl px-4 py-2 mb-4 flex items-center justify-between gap-3 text-sm"
             style={{ background: 'linear-gradient(135deg, rgba(45,95,63,0.08) 0%, rgba(45,95,63,0.02) 100%)', border: '1px solid rgba(45,95,63,0.2)' }}>
          <div className="flex items-center gap-2" style={{ color: '#2D5F3F' }}>
            <Calendar className="w-4 h-4" />
            <span className="font-semibold">{monthLabel}</span>
            <span className="opacity-70">·</span>
            <span className="opacity-80">{view === 'leave' ? 'Showing staff who applied for leave touching this month' : 'Showing staff who applied for permission this month'}</span>
          </div>
          <button onClick={() => setMonth('all')}
                  className="text-xs font-semibold px-2 py-1 rounded-lg hover:bg-white/40"
                  style={{ color: '#2D5F3F' }}>
            Clear ✕
          </button>
        </div>
      )}

      {view === 'leave' ? (
        <LeaveSummary
          year={year} monthLabel={monthLabel} isMonthMode={isMonthMode}
          leaveRows={leaveRows} leaveAgg={leaveAgg} deptBreakdown={deptBreakdown}
          onSelectEmp={setViewedEmpId}
        />
      ) : (
        <PermissionsSummary
          year={year} monthLabel={monthLabel} isMonthMode={isMonthMode}
          permRows={permRows} permAgg={permAgg}
          monthlyCounts={monthlyCounts} topUsers={topUsers}
          permLoading={permLoading}
          onSetMonth={(m) => setMonth(String(m))}
          onSelectEmp={setViewedEmpId}
        />
      )}

      {viewedEmpId && (
        <EmployeeHistoryModal
          empId={viewedEmpId}
          empMap={empMap}
          year={year}
          requests={requests}
          permissions={permissions}
          leaveTypes={leaveTypes}
          balances={balances}
          onClose={() => setViewedEmpId(null)}
        />
      )}
    </div>
  );
}

// =============================================================================
// LEAVE SUMMARY
// =============================================================================
function LeaveSummary({ year, monthLabel, isMonthMode, leaveRows, leaveAgg, deptBreakdown, onSelectEmp }) {
  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
        {isMonthMode ? (
          <>
            <HeroCard
              gradient="linear-gradient(135deg, #2D5F3F 0%, #4A8060 100%)"
              icon={<Users className="w-4 h-4" />}
              label={`STAFF IN ${monthLabel?.toUpperCase()}`}
              value={leaveAgg.totalStaff}
              unit={leaveAgg.totalStaff === 1 ? 'person' : 'people'}
              caption="Applied or had approved leave"
            />
            <HeroCard
              gradient="linear-gradient(135deg, #C97A4F 0%, #E0A079 100%)"
              icon={<CalendarDays className="w-4 h-4" />}
              label="DAYS THIS MONTH"
              value={leaveAgg.monthDays.toFixed(1)}
              unit="days"
              caption="Calendar overlap with month"
            />
            <HeroCard
              gradient="linear-gradient(135deg, #5A8A9A 0%, #7BA9B9 100%)"
              icon={<CheckCircle2 className="w-4 h-4" />}
              label="APPROVED"
              value={leaveAgg.monthApps}
              unit={`+ ${leaveAgg.monthPendingApps} pending`}
              caption="Applications touching month"
            />
            <HeroCard
              gradient="linear-gradient(135deg, #6B5BA8 0%, #8B7BC8 100%)"
              icon={<TrendingUp className="w-4 h-4" />}
              label="AVG PER PERSON"
              value={leaveAgg.avgPerPerson.toFixed(1)}
              unit="days"
              caption="Across staff with activity"
            />
          </>
        ) : (
          <>
            <HeroCard gradient="linear-gradient(135deg, #2D5F3F 0%, #4A8060 100%)"
              icon={<Users className="w-4 h-4" />} label="TOTAL STAFF"
              value={leaveAgg.totalStaff} unit="people" caption={`Filtered view · year ${year}`} />
            <HeroCard gradient="linear-gradient(135deg, #5A8A9A 0%, #7BA9B9 100%)"
              icon={<CalendarDays className="w-4 h-4" />} label="TOTAL ENTITLEMENT"
              value={leaveAgg.totalEnt.toFixed(0)} unit="days" caption="Sum of all annual quotas" />
            <HeroCard gradient="linear-gradient(135deg, #C97A4F 0%, #E0A079 100%)"
              icon={<TrendingUp className="w-4 h-4" />} label="DAYS USED"
              value={leaveAgg.totalUsed.toFixed(1)}
              unit={`+ ${leaveAgg.totalPend.toFixed(1)} pending`}
              caption={`${leaveAgg.totalEnt > 0 ? Math.round((leaveAgg.totalUsed / leaveAgg.totalEnt) * 100) : 0}% of total entitlement`} />
            <HeroCard gradient="linear-gradient(135deg, #6B5BA8 0%, #8B7BC8 100%)"
              icon={<Sparkles className="w-4 h-4" />} label="DAYS REMAINING"
              value={leaveAgg.totalRem.toFixed(1)} unit="days" caption="Available across all staff" />
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
                <div key={d.dept} className="rounded-xl p-3"
                     style={{ background: 'var(--paper-soft, #F8F8F2)', border: '1px solid var(--border-soft)' }}>
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
          <div className="text-[10px] tracking-[0.25em] opacity-60">
            STAFF DETAIL · {leaveRows.length} {leaveRows.length === 1 ? 'PERSON' : 'PEOPLE'}
            {isMonthMode && <span className="ml-2 opacity-80">· {monthLabel}</span>}
          </div>
          <div className="text-[10px] opacity-50">Click any row for full history</div>
        </div>
        {leaveRows.length === 0 ? (
          <EmptyState text={isMonthMode ? `No leave activity in ${monthLabel}.` : 'No staff match the current filters.'} icon={<Users className="w-5 h-5" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] tracking-[0.15em] opacity-60" style={{ borderBottom: '1px solid var(--border-soft)' }}>
                  <th className="text-left px-5 py-2.5 font-semibold">EMPLOYEE</th>
                  <th className="text-left px-3 py-2.5 font-semibold">LOC</th>
                  <th className="text-left px-3 py-2.5 font-semibold">DEPT</th>
                  {!isMonthMode && <th className="text-left px-3 py-2.5 font-semibold">TENURE</th>}
                  {!isMonthMode && <th className="text-left px-3 py-2.5 font-semibold">UTILISATION</th>}
                  {isMonthMode && <th className="text-right px-3 py-2.5 font-semibold">DAYS IN MONTH</th>}
                  {isMonthMode && <th className="text-right px-3 py-2.5 font-semibold">APPS</th>}
                  {!isMonthMode && <th className="text-right px-3 py-2.5 font-semibold">ENTITLE</th>}
                  {!isMonthMode && <th className="text-right px-3 py-2.5 font-semibold">USED</th>}
                  {!isMonthMode && <th className="text-right px-3 py-2.5 font-semibold">PENDING</th>}
                  {!isMonthMode && <th className="text-right px-3 py-2.5 font-semibold">REMAIN</th>}
                  <th className="text-left px-3 py-2.5 font-semibold">LAST LEAVE</th>
                  {!isMonthMode && <th className="text-left px-3 py-2.5 font-semibold">STATUS</th>}
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
                    <tr key={r.emp.id}
                        onClick={() => onSelectEmp(r.emp.id)}
                        className="cursor-pointer group hover:bg-[var(--paper-soft,#F8F8F2)] transition-colors"
                        style={{ borderBottom: idx < leaveRows.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                               style={{ background: avatarColor(r.emp.id) }}>
                            {getInitials(r.emp.name)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium truncate" style={{ color: 'var(--ink)' }}>{r.emp.name}</div>
                            <div className="text-[10px] opacity-60 font-mono">{r.emp.id}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                              style={{ background: 'rgba(90,138,154,0.08)', color: '#5A8A9A', border: '1px solid rgba(90,138,154,0.25)' }}>
                          <MapPin className="w-3 h-3" />
                          {LOCATION_LABELS[r.emp.location] || r.emp.location || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <span className="inline-block px-2 py-0.5 rounded-full"
                              style={{ background: 'rgba(45,95,63,0.08)', color: '#2D5F3F', border: '1px solid rgba(45,95,63,0.2)' }}>
                          {r.emp.department || '—'}
                        </span>
                      </td>
                      {!isMonthMode && <td className="px-3 py-3 text-xs opacity-80">{r.yrs}y {r.mth}m</td>}
                      {!isMonthMode && (
                        <td className="px-3 py-3 min-w-[120px]">
                          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#E5E7EB' }}>
                            <div className="h-full transition-all"
                                 style={{ width: `${pct}%`,
                                   background: st.tone === 'critical' ? 'linear-gradient(90deg, #EF4444, #B83A2E)'
                                     : st.tone === 'warn' ? 'linear-gradient(90deg, #F59E0B, #D97706)'
                                     : 'linear-gradient(90deg, #2D5F3F, #4A8060)' }} />
                          </div>
                          <div className="text-[10px] opacity-60 mt-1">{Math.round(pct)}%</div>
                        </td>
                      )}
                      {isMonthMode && <td className="px-3 py-3 text-right tabular-nums font-semibold" style={{ color: '#2D5F3F' }}>{r.monthDays.toFixed(1)}</td>}
                      {isMonthMode && (
                        <td className="px-3 py-3 text-right text-xs">
                          <div className="tabular-nums font-semibold" style={{ color: '#2D5F3F' }}>{r.monthApprovedReqs.length}</div>
                          {r.monthPendingReqs.length > 0 && <div className="text-[10px] opacity-60">+{r.monthPendingReqs.length} pending</div>}
                        </td>
                      )}
                      {!isMonthMode && <td className="px-3 py-3 text-right tabular-nums">{ent.toFixed(1)}</td>}
                      {!isMonthMode && <td className="px-3 py-3 text-right tabular-nums font-semibold">{used.toFixed(1)}</td>}
                      {!isMonthMode && <td className="px-3 py-3 text-right tabular-nums opacity-70">{(r.bal?.pending || 0).toFixed(1)}</td>}
                      {!isMonthMode && <td className="px-3 py-3 text-right tabular-nums font-semibold" style={{ color: '#2D5F3F' }}>{(r.bal?.available || 0).toFixed(1)}</td>}
                      <td className="px-3 py-3 text-xs opacity-80">
                        {r.lastApproved ? fmtDateShort(r.lastApproved.start_date) : <span className="opacity-50">Never</span>}
                      </td>
                      {!isMonthMode && (
                        <td className="px-3 py-3">
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                style={{ background: st.bg, color: st.color }}>
                            {st.tone === 'ok'       && <CheckCircle2 className="w-3 h-3" />}
                            {st.tone === 'warn'     && <AlertCircle  className="w-3 h-3" />}
                            {st.tone === 'critical' && <AlertCircle  className="w-3 h-3" />}
                            {st.label}
                          </span>
                        </td>
                      )}
                      <td className="px-2 py-3">
                        <ChevronRight className="w-4 h-4 opacity-30 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
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

// =============================================================================
// PERMISSIONS SUMMARY
// =============================================================================
function PermissionsSummary({ year, monthLabel, isMonthMode, permRows, permAgg, monthlyCounts, topUsers, permLoading, onSetMonth, onSelectEmp }) {
  const maxCount = Math.max(1, ...monthlyCounts);
  const currentMonth = new Date().getMonth();
  const isCurrentYear = year === new Date().getFullYear();

  return (
    <>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
        {isMonthMode ? (
          <>
            <HeroCard gradient="linear-gradient(135deg, #C97A4F 0%, #E0A079 100%)"
              icon={<Coffee className="w-4 h-4" />} label={`APPS IN ${monthLabel?.toUpperCase()}`}
              value={permAgg.monthApps} unit={permAgg.monthApps === 1 ? 'application' : 'applications'}
              caption={`${permAgg.monthPeople} ${permAgg.monthPeople === 1 ? 'person' : 'people'}`} />
            <HeroCard gradient="linear-gradient(135deg, #5A8A9A 0%, #7BA9B9 100%)"
              icon={<Clock className="w-4 h-4" />} label="HOURS"
              value={permAgg.monthHours.toFixed(1)} unit="hours" caption="Total time used in month" />
            <HeroCard gradient="linear-gradient(135deg, #92400E 0%, #B45309 100%)"
              icon={<Clock className="w-4 h-4" />} label="LATE ARRIVALS"
              value={permAgg.lateCount} unit="apps" caption="Late arrival permissions" />
            <HeroCard gradient="linear-gradient(135deg, #6B5BA8 0%, #8B7BC8 100%)"
              icon={<Clock className="w-4 h-4" />} label="EARLY LEAVES"
              value={permAgg.earlyCount} unit="apps" caption="Early leave permissions" />
          </>
        ) : (
          <>
            <HeroCard gradient="linear-gradient(135deg, #C97A4F 0%, #E0A079 100%)"
              icon={<Coffee className="w-4 h-4" />} label="THIS MONTH"
              value={permAgg.monthApps} unit={permAgg.monthApps === 1 ? 'application' : 'applications'}
              caption={`${permAgg.monthPeople} unique ${permAgg.monthPeople === 1 ? 'person' : 'people'}`} />
            <HeroCard gradient="linear-gradient(135deg, #5A8A9A 0%, #7BA9B9 100%)"
              icon={<Clock className="w-4 h-4" />} label="HOURS THIS MONTH"
              value={permAgg.monthHours.toFixed(1)} unit="hours"
              caption={`Out of ${PERMISSION_QUOTA.monthlyHours}h × ${permAgg.monthPeople || 0} = ${(PERMISSION_QUOTA.monthlyHours * (permAgg.monthPeople || 0)).toFixed(0)}h cap`} />
            <HeroCard gradient="linear-gradient(135deg, #2D5F3F 0%, #4A8060 100%)"
              icon={<BarChart3 className="w-4 h-4" />} label={`${year} TOTAL`}
              value={permAgg.yearApps} unit={permAgg.yearApps === 1 ? 'application' : 'applications'}
              caption={`${permAgg.yearPeople} unique ${permAgg.yearPeople === 1 ? 'person' : 'people'}`} />
            <HeroCard gradient="linear-gradient(135deg, #6B5BA8 0%, #8B7BC8 100%)"
              icon={<TrendingUp className="w-4 h-4" />} label={`${year} HOURS`}
              value={permAgg.yearHours.toFixed(1)} unit="hours" caption="Total time across all permissions" />
          </>
        )}
      </div>

      {!isMonthMode && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 mb-5">
          <div className="lg:col-span-2 rounded-2xl border bg-white p-4 sm:p-5" style={{ borderColor: 'var(--border-soft)' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] tracking-[0.25em] opacity-60">MONTHLY APPLICATIONS · {year}</div>
              <div className="text-[10px] opacity-50">Click a bar to filter</div>
            </div>
            <div className="flex items-end gap-1.5 sm:gap-2 h-44">
              {monthlyCounts.map((count, i) => {
                const h = (count / maxCount) * 100;
                const isCurrent = isCurrentYear && i === currentMonth;
                return (
                  <button key={i} onClick={() => onSetMonth(i + 1)}
                    className="flex-1 flex flex-col items-center justify-end h-full gap-1.5 group cursor-pointer hover:scale-105 transition-transform">
                    <div className="text-[10px] font-bold tabular-nums opacity-80 group-hover:opacity-100"
                         style={{ color: count > 0 ? '#2D5F3F' : '#9CA3AF' }}>
                      {count > 0 ? count : ''}
                    </div>
                    <div className="w-full rounded-t-md transition-all duration-300"
                         style={{
                           height: `${Math.max(2, h)}%`,
                           background: isCurrent ? 'linear-gradient(180deg, #C97A4F 0%, #B86A3F 100%)'
                             : count > 0 ? 'linear-gradient(180deg, #4A8060 0%, #2D5F3F 100%)' : '#E5E7EB',
                           boxShadow: isCurrent ? '0 4px 12px rgba(201,122,79,0.35)' : 'none',
                         }} />
                    <div className="text-[10px] opacity-60 font-medium">{MONTH_LABELS[i]}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="rounded-2xl border bg-white p-4 sm:p-5" style={{ borderColor: 'var(--border-soft)' }}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[10px] tracking-[0.25em] opacity-60">TOP REQUESTERS · {year}</div>
              {topUsers.length > 0 && <div className="text-[10px] opacity-50">Click for history</div>}
            </div>
            {topUsers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 opacity-50">
                <Sparkles className="w-5 h-5 mb-2" />
                <div className="text-xs">No permission requests yet this year.</div>
              </div>
            ) : (
              <ul className="space-y-2">
                {topUsers.map((r, i) => (
                  <li key={r.emp.id}>
                    <button onClick={() => onSelectEmp(r.emp.id)}
                      className="w-full flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-[var(--paper-soft,#F8F8F2)] transition-colors text-left">
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                           style={{ background: i === 0 ? '#FEF3C7' : 'var(--paper-soft, #F4F4EE)', color: i === 0 ? '#92400E' : 'var(--ink)' }}>
                        {i + 1}
                      </div>
                      <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                           style={{ background: avatarColor(r.emp.id) }}>{getInitials(r.emp.name)}</div>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate" style={{ color: 'var(--ink)' }}>{r.emp.name}</div>
                        <div className="text-[10px] opacity-60">{r.emp.department} · {r.totalCount} apps · {r.totalHours.toFixed(1)}h</div>
                      </div>
                      <ChevronRight className="w-3.5 h-3.5 opacity-30" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      <div className="rounded-2xl border bg-white overflow-hidden" style={{ borderColor: 'var(--border-soft)' }}>
        <div className="px-5 py-3 flex items-center justify-between"
             style={{ borderBottom: '1px solid var(--border-soft)', background: 'var(--paper-soft, #FBFAF6)' }}>
          <div className="text-[10px] tracking-[0.25em] opacity-60">
            STAFF DETAIL · {permRows.length} {permRows.length === 1 ? 'PERSON' : 'PEOPLE'}
            {isMonthMode && <span className="ml-2 opacity-80">· {monthLabel}</span>}
          </div>
          <div className="text-[10px] opacity-50">Click any row for full history</div>
        </div>
        {permLoading ? (
          <EmptyState text="Loading permissions…" icon={<Clock className="w-5 h-5 animate-spin" />} />
        ) : permRows.length === 0 ? (
          <EmptyState text={isMonthMode ? `No permission applications in ${monthLabel}.` : 'No staff match the current filters.'} icon={<Users className="w-5 h-5" />} />
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
                  <th className="text-right px-3 py-2.5 font-semibold">{isMonthMode ? 'IN MONTH' : 'TOTAL APPS'}</th>
                  <th className="text-right px-3 py-2.5 font-semibold">{isMonthMode ? 'HOURS' : 'TOTAL HOURS'}</th>
                  <th className="text-left px-3 py-2.5 font-semibold">LAST</th>
                  {!isMonthMode && <th className="text-left px-3 py-2.5 font-semibold">THIS MONTH</th>}
                  <th className="px-2"></th>
                </tr>
              </thead>
              <tbody>
                {permRows.map((r, idx) => {
                  const qs = quotaStatus(r.monthSummary);
                  const monthLate  = r.monthPerms.filter(p => p.type === 'late_arrival').length;
                  const monthEarly = r.monthPerms.filter(p => p.type === 'early_leave').length;
                  const monthHours = r.monthPerms.reduce((s, p) => s + Number(p.hours || 0), 0);
                  const lateCount  = isMonthMode ? monthLate : r.lateCount;
                  const earlyCount = isMonthMode ? monthEarly : r.earlyCount;
                  const totalCount = isMonthMode ? r.monthPerms.length : r.totalCount;
                  const totalHours = isMonthMode ? monthHours : r.totalHours;
                  const lateHrsForCol  = isMonthMode ? r.monthPerms.filter(p => p.type === 'late_arrival').reduce((s, p) => s + Number(p.hours || 0), 0) : r.lateHours;
                  const earlyHrsForCol = isMonthMode ? r.monthPerms.filter(p => p.type === 'early_leave').reduce((s, p) => s + Number(p.hours || 0), 0) : r.earlyHours;
                  return (
                    <tr key={r.emp.id}
                        onClick={() => onSelectEmp(r.emp.id)}
                        className="cursor-pointer group hover:bg-[var(--paper-soft,#F8F8F2)] transition-colors"
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
                              style={{ background: 'rgba(90,138,154,0.08)', color: '#5A8A9A', border: '1px solid rgba(90,138,154,0.25)' }}>
                          <MapPin className="w-3 h-3" />
                          {LOCATION_LABELS[r.emp.location] || r.emp.location || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <span className="inline-block px-2 py-0.5 rounded-full"
                              style={{ background: 'rgba(45,95,63,0.08)', color: '#2D5F3F', border: '1px solid rgba(45,95,63,0.2)' }}>
                          {r.emp.department || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-xs">
                        <div className="tabular-nums font-semibold" style={{ color: lateCount > 0 ? '#92400E' : '#9CA3AF' }}>{lateCount}</div>
                        <div className="text-[10px] opacity-60 tabular-nums">{lateHrsForCol.toFixed(1)}h</div>
                      </td>
                      <td className="px-3 py-3 text-right text-xs">
                        <div className="tabular-nums font-semibold" style={{ color: earlyCount > 0 ? '#92400E' : '#9CA3AF' }}>{earlyCount}</div>
                        <div className="text-[10px] opacity-60 tabular-nums">{earlyHrsForCol.toFixed(1)}h</div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-bold" style={{ color: 'var(--ink)' }}>{totalCount}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-semibold" style={{ color: '#2D5F3F' }}>{totalHours.toFixed(1)}h</td>
                      <td className="px-3 py-3 text-xs opacity-80">
                        {r.lastPerm ? fmtDateShort(r.lastPerm.permission_date) : <span className="opacity-50">Never</span>}
                      </td>
                      {!isMonthMode && (
                        <td className="px-3 py-3">
                          {isCurrentYear ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                  style={{ background: qs.bg, color: qs.color }}>{qs.label}</span>
                          ) : <span className="text-[10px] opacity-50">—</span>}
                        </td>
                      )}
                      <td className="px-2 py-3">
                        <ChevronRight className="w-4 h-4 opacity-30 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all" />
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

// =============================================================================
// EMPLOYEE HISTORY MODAL — drill-down view + per-employee exports
// =============================================================================
function EmployeeHistoryModal({ empId, empMap, year, requests, permissions, leaveTypes, balances, onClose }) {
  const emp = empMap?.[empId];
  const [exporting, setExporting] = useState('');

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const annualType = leaveTypes?.find(t => t.id === 'annual') || leaveTypes?.[0];
  const adj = (balances || []).find(b => emp && b.employee_id === emp.id && b.leave_type_id === annualType?.id && b.year === year) || {};
  const bal = useMemo(
    () => (emp && annualType) ? calculateBalance({ employee: emp, leaveType: annualType, year, requests: requests || [], adjustments: adj }) : null,
    [emp, annualType, year, requests, adj]
  );

  const empReqs = useMemo(() => (requests || [])
    .filter(r => emp && r.employee_id === emp.id && new Date(r.start_date).getFullYear() === year)
    .sort((a, b) => new Date(b.start_date) - new Date(a.start_date)), [requests, emp, year]);

  const empPerms = useMemo(() => (permissions || [])
    .filter(p => emp && p.employee_id === emp.id && new Date(p.permission_date).getFullYear() === year)
    .sort((a, b) => new Date(b.permission_date) - new Date(a.permission_date)), [permissions, emp, year]);

  const yrs = emp?.join_date ? yearsOfService(emp.join_date) : 0;
  const mth = emp?.join_date ? monthsOfService(emp.join_date) % 12 : 0;

  // Monthly timeline: leave days + permission breakdown per month
  const timeline = useMemo(() => {
    return Array.from({ length: 12 }, (_, i) => {
      const monthNum = i + 1;
      const ms = String(monthNum).padStart(2, '0');
      const monthLeaves   = empReqs.filter(r => r.status === 'approved' && leaveDaysInMonth(r, year, monthNum) > 0);
      const monthLeaveDays = monthLeaves.reduce((s, r) => s + leaveDaysInMonth(r, year, monthNum), 0);
      const monthPerms = empPerms.filter(p => p.permission_date?.startsWith(`${year}-${ms}`) && (p.status === 'approved' || p.status === 'pending'));
      const lateCount  = monthPerms.filter(p => p.type === 'late_arrival').length;
      const earlyCount = monthPerms.filter(p => p.type === 'early_leave').length;
      const permHours  = monthPerms.reduce((s, p) => s + Number(p.hours || 0), 0);
      return { month: monthNum, label: MONTH_LABELS[i], full: MONTH_FULL[i],
               leaveDays: monthLeaveDays, leaves: monthLeaves, perms: monthPerms,
               lateCount, earlyCount, permHours };
    });
  }, [empReqs, empPerms, year]);

  const permsCount = empPerms.filter(p => p.status === 'approved' || p.status === 'pending').length;
  const permsHours = empPerms.filter(p => p.status === 'approved' || p.status === 'pending').reduce((s, p) => s + Number(p.hours || 0), 0);

  // Per-employee PDF export
  const exportEmpPdf = useCallback(async () => {
    if (!emp) return;
    setExporting('pdf');
    try {
      const { jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();

      // Header banner
      doc.setFillColor(45, 95, 63); doc.rect(0, 0, W, 70, 'F');
      doc.setTextColor(255); doc.setFontSize(18); doc.setFont('helvetica', 'bold');
      doc.text(emp.name, 40, 32);
      doc.setFontSize(10); doc.setFont('helvetica', 'normal');
      doc.text(`${emp.id} · ${emp.department || '—'} · ${LOCATION_LABELS[emp.location] || emp.location || '—'} · ${yrs}y ${mth}m`, 40, 50);
      doc.setFontSize(9);
      doc.text(`Year ${year} history`, W - 40, 32, { align: 'right' });
      doc.text(`Generated ${new Date().toLocaleString()}`, W - 40, 50, { align: 'right' });

      // KPI band
      doc.setTextColor(45, 95, 63); doc.setFontSize(10); doc.setFont('helvetica', 'bold');
      doc.text('SUMMARY', 40, 96);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(60, 60, 60);
      const kpiY = 112;
      const kpis = [
        { l: 'Annual entitlement', v: `${(bal?.entitlement ?? 0).toFixed(1)} d` },
        { l: 'Used YTD',           v: `${(bal?.used        ?? 0).toFixed(1)} d` },
        { l: 'Pending',            v: `${(bal?.pending     ?? 0).toFixed(1)} d` },
        { l: 'Remaining',          v: `${(bal?.available   ?? 0).toFixed(1)} d` },
        { l: 'Permissions',        v: `${permsCount} apps · ${permsHours.toFixed(1)}h` },
      ];
      const colW = (W - 80) / 5;
      kpis.forEach((k, i) => {
        const x = 40 + i * colW;
        doc.setFillColor(248, 248, 245); doc.rect(x, kpiY, colW - 6, 44, 'F');
        doc.setTextColor(110, 110, 110); doc.setFontSize(8);
        doc.text(k.l, x + 8, kpiY + 14);
        doc.setTextColor(45, 95, 63); doc.setFontSize(11); doc.setFont('helvetica', 'bold');
        doc.text(k.v, x + 8, kpiY + 32);
        doc.setFont('helvetica', 'normal');
      });

      // Monthly breakdown
      doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(45, 95, 63);
      doc.text('MONTHLY BREAKDOWN', 40, kpiY + 76);
      doc.autoTable({
        startY: kpiY + 84,
        head: [['Month', 'Leave days', 'Approved leaves', 'Late arrivals', 'Early leaves', 'Total perm hrs']],
        body: timeline.map(m => [
          m.full,
          m.leaveDays > 0 ? m.leaveDays.toFixed(1) : '—',
          m.leaves.length > 0 ? m.leaves.length : '—',
          m.lateCount > 0 ? m.lateCount : '—',
          m.earlyCount > 0 ? m.earlyCount : '—',
          m.permHours > 0 ? m.permHours.toFixed(1) : '—',
        ]),
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 8, halign: 'center' },
        alternateRowStyles: { fillColor: [248, 248, 245] },
        columnStyles: { 0: { halign: 'left', fontStyle: 'bold' } },
        margin: { left: 40, right: 40 },
      });

      // Leave list
      let y2 = doc.lastAutoTable.finalY + 16;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(45, 95, 63);
      doc.text(`LEAVE REQUESTS (${empReqs.length})`, 40, y2);
      doc.autoTable({
        startY: y2 + 6,
        head: [['#', 'Type', 'From', 'To', 'Days', 'Status', 'Reason']],
        body: empReqs.length === 0 ? [['—', 'No leave taken in ' + year, '', '', '', '', '']] :
          empReqs.map((r, i) => [
            i + 1,
            (leaveTypes?.find(t => t.id === r.leave_type_id)?.name) || r.leave_type_id || '—',
            fmtDateShort(r.start_date), fmtDateShort(r.end_date),
            (Number(r.days) || 0).toFixed(1),
            leaveStatusPill(r.stage || r.status).label,
            (r.reason || '').slice(0, 80),
          ]),
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 248, 245] },
        columnStyles: { 0: { halign: 'right', cellWidth: 22 }, 4: { halign: 'right' }, 6: { cellWidth: 180 } },
        margin: { left: 40, right: 40 },
      });

      // Permissions list
      let y3 = doc.lastAutoTable.finalY + 16;
      if (y3 > doc.internal.pageSize.getHeight() - 100) { doc.addPage(); y3 = 40; }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(45, 95, 63);
      doc.text(`PERMISSIONS (${empPerms.length})`, 40, y3);
      doc.autoTable({
        startY: y3 + 6,
        head: [['#', 'Date', 'Type', 'Hours', 'Status', 'Reason']],
        body: empPerms.length === 0 ? [['—', 'No permissions used in ' + year, '', '', '', '']] :
          empPerms.map((p, i) => [
            i + 1,
            fmtDateShort(p.permission_date),
            PERMISSION_TYPES[p.type]?.label || p.type || '—',
            (Number(p.hours) || 0).toFixed(1),
            permStatusPill(p.status).label,
            (p.reason || '').slice(0, 80),
          ]),
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 248, 245] },
        columnStyles: { 0: { halign: 'right', cellWidth: 22 }, 3: { halign: 'right' }, 5: { cellWidth: 200 } },
        margin: { left: 40, right: 40 },
      });

      // Footer
      const pageCount = doc.internal.getNumberOfPages();
      for (let p = 1; p <= pageCount; p++) {
        doc.setPage(p);
        doc.setFontSize(8); doc.setTextColor(150);
        doc.text(`${emp.name} · Year ${year} · Page ${p} of ${pageCount}`,
          W / 2, doc.internal.pageSize.getHeight() - 16, { align: 'center' });
      }

      const safeName = (emp.name || emp.id).replace(/[^A-Za-z0-9]+/g, '_');
      doc.save(`History_${safeName}_${year}.pdf`);
    } catch (e) { console.error(e); alert('PDF export failed: ' + (e.message || e)); }
    finally { setExporting(''); }
  }, [emp, bal, year, timeline, empReqs, empPerms, leaveTypes, yrs, mth, permsCount, permsHours]);

  // Per-employee Excel export — 4 sheets
  const exportEmpXlsx = useCallback(async () => {
    if (!emp) return;
    setExporting('xlsx');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();

      // Sheet 1: Summary
      const summary = [
        ['Employee', emp.name],
        ['PSN', emp.id],
        ['Department', emp.department || '—'],
        ['Location', LOCATION_LABELS[emp.location] || emp.location || '—'],
        ['Joined', emp.join_date || '—'],
        ['Years of service', `${yrs}y ${mth}m`],
        ['Year', year],
        [],
        ['Annual entitlement (days)', Number((bal?.entitlement ?? 0).toFixed(2))],
        ['Used YTD (days)',           Number((bal?.used        ?? 0).toFixed(2))],
        ['Pending (days)',            Number((bal?.pending     ?? 0).toFixed(2))],
        ['Remaining (days)',          Number((bal?.available   ?? 0).toFixed(2))],
        [],
        ['Permission applications',   permsCount],
        ['Permission hours used',     Number(permsHours.toFixed(2))],
      ];
      const ws1 = XLSX.utils.aoa_to_sheet(summary);
      ws1['!cols'] = [{ wch: 28 }, { wch: 32 }];
      XLSX.utils.book_append_sheet(wb, ws1, 'Summary');

      // Sheet 2: Leave requests
      const leaveHeaders = ['#','Type','From','To','Days','Status','Reason','Decided at','Decided by','Substitutes'];
      const leaveBody = empReqs.map((r, i) => [
        i + 1,
        (leaveTypes?.find(t => t.id === r.leave_type_id)?.name) || r.leave_type_id || '—',
        r.start_date, r.end_date,
        Number((Number(r.days) || 0).toFixed(2)),
        r.stage || r.status,
        r.reason || '',
        r.hr_decided_at || r.manager_decided_at || '',
        r.hr_decided_by || r.manager_decided_by || '',
        Array.isArray(r.substitute_ids) ? r.substitute_ids.join(', ') : '',
      ]);
      const ws2 = XLSX.utils.aoa_to_sheet([leaveHeaders, ...leaveBody]);
      ws2['!cols'] = [{ wch: 4 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 6 }, { wch: 14 }, { wch: 32 }, { wch: 22 }, { wch: 38 }, { wch: 22 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Leave Requests');

      // Sheet 3: Permissions
      const permHeaders = ['#','Date','Type','Hours','Status','Reason'];
      const permBody = empPerms.map((p, i) => [
        i + 1, p.permission_date,
        PERMISSION_TYPES[p.type]?.label || p.type || '—',
        Number((Number(p.hours) || 0).toFixed(2)),
        p.status, p.reason || '',
      ]);
      const ws3 = XLSX.utils.aoa_to_sheet([permHeaders, ...permBody]);
      ws3['!cols'] = [{ wch: 4 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 12 }, { wch: 32 }];
      XLSX.utils.book_append_sheet(wb, ws3, 'Permissions');

      // Sheet 4: Monthly breakdown
      const monthlyHeaders = ['Month','Leave days','Approved leaves','Late arrivals','Early leaves','Permission hours'];
      const monthlyBody = timeline.map(m => [
        m.full,
        Number(m.leaveDays.toFixed(2)),
        m.leaves.length, m.lateCount, m.earlyCount,
        Number(m.permHours.toFixed(2)),
      ]);
      const ws4 = XLSX.utils.aoa_to_sheet([monthlyHeaders, ...monthlyBody]);
      ws4['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws4, 'Monthly');

      const safeName = (emp.name || emp.id).replace(/[^A-Za-z0-9]+/g, '_');
      XLSX.writeFile(wb, `History_${safeName}_${year}.xlsx`);
    } catch (e) { console.error(e); alert('Excel export failed: ' + (e.message || e)); }
    finally { setExporting(''); }
  }, [emp, bal, timeline, empReqs, empPerms, leaveTypes, year, yrs, mth, permsCount, permsHours]);

  if (!emp) return null;
  const maxLeaveDays = Math.max(0.1, ...timeline.map(m => m.leaveDays));
  const maxPermHours = Math.max(0.1, ...timeline.map(m => m.permHours));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
         style={{ background: 'rgba(20,30,25,0.55)', backdropFilter: 'blur(2px)' }}
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl my-8" onClick={(e) => e.stopPropagation()}
           style={{ borderColor: 'var(--border-soft)' }}>
        {/* HEADER */}
        <div className="px-5 sm:px-6 py-4 sticky top-0 z-10 rounded-t-2xl"
             style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0">
              <div className="w-12 h-12 sm:w-14 sm:h-14 rounded-full flex items-center justify-center text-base sm:text-lg font-bold flex-shrink-0"
                   style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', border: '2px solid rgba(255,255,255,0.3)' }}>
                {getInitials(emp.name)}
              </div>
              <div className="min-w-0">
                <div className="text-[10px] tracking-[0.25em] opacity-80 mb-1">— EMPLOYEE HISTORY · {year}</div>
                <h2 className="text-xl sm:text-2xl font-serif">{emp.name}</h2>
                <div className="flex flex-wrap gap-1.5 mt-2 text-xs">
                  <span className="font-mono opacity-80">{emp.id}</span>
                  <span className="opacity-50">·</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.18)' }}>
                    <MapPin className="w-3 h-3" />{LOCATION_LABELS[emp.location] || emp.location || '—'}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.18)' }}>
                    <Building2 className="w-3 h-3" />{emp.department || '—'}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full" style={{ background: 'rgba(255,255,255,0.18)' }}>
                    <Clock className="w-3 h-3" />{yrs}y {mth}m
                  </span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <button onClick={exportEmpPdf} disabled={!!exporting}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
                      style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}>
                <FileText className="w-3.5 h-3.5" /> {exporting === 'pdf' ? 'Generating…' : 'PDF'}
              </button>
              <button onClick={exportEmpXlsx} disabled={!!exporting}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg disabled:opacity-50"
                      style={{ background: 'rgba(255,255,255,0.18)', color: '#fff', border: '1px solid rgba(255,255,255,0.3)' }}>
                <FileSpreadsheet className="w-3.5 h-3.5" /> {exporting === 'xlsx' ? 'Generating…' : 'Excel'}
              </button>
              <button onClick={onClose}
                      className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors"
                      style={{ color: '#fff' }} aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>

        {/* KPI CARDS */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 px-5 sm:px-6 py-4">
          <KpiCard label="Annual entitlement" value={(bal?.entitlement ?? 0).toFixed(1)} unit="days" tone="ink" />
          <KpiCard label="Used YTD"           value={(bal?.used        ?? 0).toFixed(1)} unit="days" tone="warn" />
          <KpiCard label="Pending"            value={(bal?.pending     ?? 0).toFixed(1)} unit="days" tone="info" />
          <KpiCard label="Remaining"          value={(bal?.available   ?? 0).toFixed(1)} unit="days" tone="ok" />
          <KpiCard label="Permissions"        value={permsCount} unit={`apps · ${permsHours.toFixed(1)}h`} tone="purple" />
        </div>

        {/* MONTHLY TIMELINE */}
        <div className="px-5 sm:px-6 py-3">
          <div className="text-[10px] tracking-[0.25em] opacity-60 mb-3">MONTHLY TIMELINE · {year}</div>
          <div className="grid grid-cols-6 md:grid-cols-12 gap-1.5">
            {timeline.map(m => {
              const hasActivity = m.leaveDays > 0 || m.lateCount > 0 || m.earlyCount > 0;
              const leaveBarH = m.leaveDays > 0 ? (m.leaveDays / maxLeaveDays) * 50 : 0;
              const permBarH = m.permHours > 0 ? (m.permHours / maxPermHours) * 50 : 0;
              return (
                <div key={m.month} className="rounded-lg p-2 text-center"
                     style={{
                       background: hasActivity ? 'var(--paper-soft, #FBFAF6)' : 'transparent',
                       border: '1px solid ' + (hasActivity ? 'rgba(45,95,63,0.2)' : 'var(--border-soft)'),
                       opacity: hasActivity ? 1 : 0.55,
                     }}>
                  <div className="text-[10px] font-bold opacity-70 mb-1">{m.label}</div>
                  <div className="flex items-end justify-center gap-1 h-14">
                    <div className="flex flex-col items-center justify-end" title={`Leave: ${m.leaveDays.toFixed(1)} days`}>
                      {m.leaveDays > 0 && <div className="text-[9px] tabular-nums font-bold" style={{ color: '#2D5F3F' }}>{m.leaveDays.toFixed(1)}d</div>}
                      <div className="w-2.5 rounded-t-sm transition-all"
                           style={{ height: `${Math.max(2, leaveBarH)}px`, background: m.leaveDays > 0 ? 'linear-gradient(180deg, #4A8060, #2D5F3F)' : '#E5E7EB' }} />
                    </div>
                    <div className="flex flex-col items-center justify-end" title={`Permissions: ${m.lateCount + m.earlyCount} apps · ${m.permHours.toFixed(1)}h`}>
                      {m.permHours > 0 && <div className="text-[9px] tabular-nums font-bold" style={{ color: '#C97A4F' }}>{m.permHours.toFixed(1)}h</div>}
                      <div className="w-2.5 rounded-t-sm transition-all"
                           style={{ height: `${Math.max(2, permBarH)}px`, background: m.permHours > 0 ? 'linear-gradient(180deg, #E0A079, #C97A4F)' : '#E5E7EB' }} />
                    </div>
                  </div>
                  {(m.lateCount > 0 || m.earlyCount > 0) && (
                    <div className="text-[9px] mt-1 opacity-70">
                      {m.lateCount > 0 && <span>L:{m.lateCount}</span>}
                      {m.lateCount > 0 && m.earlyCount > 0 && ' '}
                      {m.earlyCount > 0 && <span>E:{m.earlyCount}</span>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-3 text-[10px] opacity-70">
            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-sm" style={{ background: 'linear-gradient(180deg, #4A8060, #2D5F3F)' }} /> Leave days</div>
            <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-sm" style={{ background: 'linear-gradient(180deg, #E0A079, #C97A4F)' }} /> Permission hours</div>
            <div className="opacity-60">L = late arrivals · E = early leaves</div>
          </div>
        </div>

        {/* LEAVE REQUESTS LIST */}
        <div className="px-5 sm:px-6 py-3">
          <div className="text-[10px] tracking-[0.25em] opacity-60 mb-2">LEAVE REQUESTS · {empReqs.length}</div>
          {empReqs.length === 0 ? (
            <div className="rounded-xl border bg-white px-4 py-6 text-center text-xs opacity-60"
                 style={{ borderColor: 'var(--border-soft)' }}>
              <Plane className="w-5 h-5 mx-auto mb-2 opacity-50" />
              No leave taken in {year}.
            </div>
          ) : (
            <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-soft)' }}>
              <table className="w-full text-xs">
                <thead style={{ background: 'var(--paper-soft, #FBFAF6)' }}>
                  <tr className="text-[10px] tracking-[0.15em] opacity-60">
                    <th className="text-left px-3 py-2 font-semibold">TYPE</th>
                    <th className="text-left px-3 py-2 font-semibold">DATES</th>
                    <th className="text-right px-3 py-2 font-semibold">DAYS</th>
                    <th className="text-left px-3 py-2 font-semibold">STATUS</th>
                    <th className="text-left px-3 py-2 font-semibold">REASON</th>
                  </tr>
                </thead>
                <tbody>
                  {empReqs.map((r, idx) => {
                    const sp = leaveStatusPill(r.stage || r.status);
                    return (
                      <tr key={r.id} style={{ borderTop: idx > 0 ? '1px solid var(--border-soft)' : 'none' }}>
                        <td className="px-3 py-2 font-medium">{leaveTypes?.find(t => t.id === r.leave_type_id)?.name || r.leave_type_id || '—'}</td>
                        <td className="px-3 py-2">{fmtDateShort(r.start_date)} → {fmtDateShort(r.end_date)}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{(Number(r.days) || 0).toFixed(1)}</td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                style={{ background: sp.bg, color: sp.color }}>{sp.label}</span>
                        </td>
                        <td className="px-3 py-2 opacity-80 max-w-md truncate">{r.reason || <span className="opacity-50">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* PERMISSIONS LIST */}
        <div className="px-5 sm:px-6 py-3 pb-6">
          <div className="text-[10px] tracking-[0.25em] opacity-60 mb-2">PERMISSIONS · {empPerms.length}</div>
          {empPerms.length === 0 ? (
            <div className="rounded-xl border bg-white px-4 py-6 text-center text-xs opacity-60"
                 style={{ borderColor: 'var(--border-soft)' }}>
              <Coffee className="w-5 h-5 mx-auto mb-2 opacity-50" />
              No permissions used in {year}.
            </div>
          ) : (
            <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-soft)' }}>
              <table className="w-full text-xs">
                <thead style={{ background: 'var(--paper-soft, #FBFAF6)' }}>
                  <tr className="text-[10px] tracking-[0.15em] opacity-60">
                    <th className="text-left px-3 py-2 font-semibold">DATE</th>
                    <th className="text-left px-3 py-2 font-semibold">TYPE</th>
                    <th className="text-right px-3 py-2 font-semibold">HOURS</th>
                    <th className="text-left px-3 py-2 font-semibold">STATUS</th>
                    <th className="text-left px-3 py-2 font-semibold">REASON</th>
                  </tr>
                </thead>
                <tbody>
                  {empPerms.map((p, idx) => {
                    const sp = permStatusPill(p.status);
                    return (
                      <tr key={p.id} style={{ borderTop: idx > 0 ? '1px solid var(--border-soft)' : 'none' }}>
                        <td className="px-3 py-2 font-medium">{fmtDateShort(p.permission_date)}</td>
                        <td className="px-3 py-2">{PERMISSION_TYPES[p.type]?.label || p.type || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold">{(Number(p.hours) || 0).toFixed(1)}h</td>
                        <td className="px-3 py-2">
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                style={{ background: sp.bg, color: sp.color }}>{sp.label}</span>
                        </td>
                        <td className="px-3 py-2 opacity-80 max-w-md truncate">{p.reason || <span className="opacity-50">—</span>}</td>
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
  );
}

// =============================================================================
// SHARED COMPONENTS
// =============================================================================
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
  const tones = {
    ok:     { bg: 'rgba(21,128,61,0.08)',  bd: 'rgba(21,128,61,0.25)',  fg: '#15803D' },
    warn:   { bg: 'rgba(146,64,14,0.08)',  bd: 'rgba(146,64,14,0.25)',  fg: '#92400E' },
    info:   { bg: 'rgba(90,138,154,0.08)', bd: 'rgba(90,138,154,0.25)', fg: '#5A8A9A' },
    purple: { bg: 'rgba(107,91,168,0.08)', bd: 'rgba(107,91,168,0.25)', fg: '#6B5BA8' },
    ink:    { bg: 'rgba(45,95,63,0.08)',   bd: 'rgba(45,95,63,0.25)',   fg: '#2D5F3F' },
  };
  const t = tones[tone] || tones.ink;
  return (
    <div className="rounded-xl p-3 sm:p-4" style={{ background: t.bg, border: '1px solid ' + t.bd }}>
      <div className="text-[10px] tracking-[0.2em] opacity-60 mb-1">{label.toUpperCase()}</div>
      <div className="flex items-baseline gap-1.5">
        <div className="text-xl sm:text-2xl font-bold tabular-nums" style={{ color: t.fg }}>{value}</div>
        <div className="text-[10px] opacity-70">{unit}</div>
      </div>
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
