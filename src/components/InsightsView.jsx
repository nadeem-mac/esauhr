import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Download, FileSpreadsheet, FileText, Search, Users, BarChart3,
  CalendarDays, Coffee, TrendingUp, AlertCircle, CheckCircle2, Clock,
  Plane, Sparkles, Filter as FilterIcon
} from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import {
  calculateBalance, yearsOfService, monthsOfService,
  fmtDateShort, getInitials, avatarColor, LOCATION_LABELS
} from '../lib/leaveLogic.js';
import { PERMISSION_QUOTA, PERMISSION_TYPES, summariseMonth } from '../lib/permissionLogic.js';

const MONTH_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ESAU_GREEN = '#2D5F3F';
const ESAU_GREEN_DARK = '#1F4530';

// Helper: utilisation status — green / amber / red
function utilisationStatus(used, entitlement) {
  if (!entitlement) return { label: 'No data', color: '#9CA3AF', bg: '#F3F4F6', tone: 'neutral' };
  const pct = (used / entitlement) * 100;
  if (pct >= 90) return { label: 'Critical', color: '#B83A2E', bg: '#FEE2E2', tone: 'critical' };
  if (pct >= 60) return { label: 'Watch', color: '#92400E', bg: '#FEF3C7', tone: 'warn' };
  return { label: 'Healthy', color: '#15803D', bg: '#DCFCE7', tone: 'ok' };
}

// Helper: permission quota status for a single month
function quotaStatus(monthSummary) {
  if (monthSummary.overQuota) return { label: 'Over quota', color: '#B83A2E', bg: '#FEE2E2', tone: 'critical' };
  if (monthSummary.atQuota) return { label: 'At quota', color: '#92400E', bg: '#FEF3C7', tone: 'warn' };
  if (monthSummary.occurrences === 0) return { label: 'Untouched', color: '#6B7280', bg: '#F3F4F6', tone: 'neutral' };
  return { label: 'Within quota', color: '#15803D', bg: '#DCFCE7', tone: 'ok' };
}

// ===========================================================================
// MAIN COMPONENT
// ===========================================================================
export default function InsightsView({ me, employees, leaveTypes, requests, balances, empMap, permissions: passedPerms }) {
  const [view, setView]       = useState('leave');               // 'leave' | 'permissions'
  const [year, setYear]       = useState(new Date().getFullYear());
  const [dept, setDept]       = useState('all');
  const [loc, setLoc]         = useState('all');
  const [search, setSearch]   = useState('');
  const [permissions, setPermissions] = useState(passedPerms || []);
  const [permLoading, setPermLoading] = useState(false);
  const [exporting, setExporting] = useState('');

  // If parent didn't pass permissions, fetch them ourselves via directGet
  useEffect(() => {
    if (passedPerms && passedPerms.length >= 0) {
      setPermissions(passedPerms);
      return;
    }
    let mounted = true;
    setPermLoading(true);
    (async () => {
      try {
        const rows = await directGet('permission_requests',
          `select=*&order=permission_date.desc`,
          { timeoutMs: 15000 });
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

  // ----- Filter staff list -----
  const filteredEmps = useMemo(() => {
    return (employees || []).filter(e => {
      if (dept !== 'all' && e.department !== dept) return false;
      if (loc !== 'all' && e.location !== loc) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!e.name?.toLowerCase().includes(q) && !e.id?.toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
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

  // ----- Compute leave rows -----
  const leaveRows = useMemo(() => {
    if (!annualType) return [];
    return filteredEmps.map(emp => {
      const adj = (balances || []).find(
        b => b.employee_id === emp.id && b.leave_type_id === annualType.id && b.year === year
      ) || {};
      const bal = calculateBalance({ employee: emp, leaveType: annualType, year, requests: requests || [], adjustments: adj });
      const empReqs = (requests || []).filter(r =>
        r.employee_id === emp.id && new Date(r.start_date).getFullYear() === year
      );
      const lastApproved = empReqs.filter(r => r.status === 'approved')
        .sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0];
      const yrs = emp.join_date ? yearsOfService(emp.join_date) : 0;
      const mth = emp.join_date ? monthsOfService(emp.join_date) % 12 : 0;
      return { emp, bal, lastApproved, yrs, mth };
    });
  }, [filteredEmps, annualType, year, balances, requests]);

  // ----- Compute permission rows -----
  const permRows = useMemo(() => {
    const now = new Date();
    const isCurrentYear = year === now.getFullYear();
    const monthStr = String(now.getMonth() + 1).padStart(2, '0');
    return filteredEmps.map(emp => {
      const empPerms = (permissions || []).filter(p =>
        p.employee_id === emp.id &&
        new Date(p.permission_date).getFullYear() === year
      );
      const counted = empPerms.filter(p => p.status === 'approved' || p.status === 'pending');
      const lateApps  = counted.filter(p => p.type === 'late_arrival');
      const earlyApps = counted.filter(p => p.type === 'early_leave');
      const lateHours  = lateApps.reduce((s, r) => s + Number(r.hours || 0), 0);
      const earlyHours = earlyApps.reduce((s, r) => s + Number(r.hours || 0), 0);
      const totalHours = lateHours + earlyHours;
      const lastPerm = counted.sort((a, b) => new Date(b.permission_date) - new Date(a.permission_date))[0];
      const monthRows = isCurrentYear
        ? counted.filter(p => p.permission_date?.startsWith(`${year}-${monthStr}`))
        : [];
      const monthSummary = summariseMonth(monthRows);
      return {
        emp, lateApps, earlyApps, lateCount: lateApps.length, earlyCount: earlyApps.length,
        totalCount: counted.length, lateHours, earlyHours, totalHours,
        lastPerm, monthSummary,
      };
    });
  }, [filteredEmps, permissions, year]);

  // ----- Aggregate metrics -----
  const leaveAgg = useMemo(() => {
    const totalEnt   = leaveRows.reduce((s, r) => s + (r.bal?.entitlement || 0), 0);
    const totalUsed  = leaveRows.reduce((s, r) => s + (r.bal?.used || 0), 0);
    const totalPend  = leaveRows.reduce((s, r) => s + (r.bal?.pending || 0), 0);
    const totalRem   = leaveRows.reduce((s, r) => s + (r.bal?.remaining || 0), 0);
    const onLeaveNow = leaveRows.filter(r => r.bal?.used > 0).length;
    return { totalStaff: leaveRows.length, totalEnt, totalUsed, totalPend, totalRem, onLeaveNow };
  }, [leaveRows]);

  const permAgg = useMemo(() => {
    const ms = String(new Date().getMonth() + 1).padStart(2, '0');
    const isCurrentYear = year === new Date().getFullYear();
    const allCounted = (permissions || []).filter(p =>
      (p.status === 'approved' || p.status === 'pending') &&
      new Date(p.permission_date).getFullYear() === year
    );
    const monthRows = isCurrentYear
      ? allCounted.filter(p => p.permission_date?.startsWith(`${year}-${ms}`))
      : [];
    const monthPeople = new Set(monthRows.map(p => p.employee_id)).size;
    const monthHours  = monthRows.reduce((s, r) => s + Number(r.hours || 0), 0);
    const yearPeople  = new Set(allCounted.map(p => p.employee_id)).size;
    const yearHours   = allCounted.reduce((s, r) => s + Number(r.hours || 0), 0);
    return {
      monthApps: monthRows.length, monthPeople, monthHours,
      yearApps:  allCounted.length, yearPeople,  yearHours,
    };
  }, [permissions, year]);

  // ----- Monthly breakdown for the bar chart -----
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

  // ----- Top 5 frequent permission users -----
  const topUsers = useMemo(
    () => [...permRows].sort((a, b) => b.totalCount - a.totalCount).filter(r => r.totalCount > 0).slice(0, 5),
    [permRows]
  );

  // ----- Department breakdown (for Leave) -----
  const deptBreakdown = useMemo(() => {
    const map = {};
    leaveRows.forEach(r => {
      const d = r.emp.department || 'Other';
      if (!map[d]) map[d] = { dept: d, staff: 0, ent: 0, used: 0, rem: 0 };
      map[d].staff++;
      map[d].ent  += r.bal?.entitlement || 0;
      map[d].used += r.bal?.used || 0;
      map[d].rem  += r.bal?.remaining || 0;
    });
    return Object.values(map).sort((a, b) => b.staff - a.staff);
  }, [leaveRows]);

  // ===========================================================================
  // EXPORT FUNCTIONS
  // ===========================================================================

  // PDF export (lazy import jsPDF)
  const exportLeavePdf = useCallback(async () => {
    setExporting('pdf');
    try {
      const { jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();
      // Header
      doc.setFillColor(45, 95, 63);
      doc.rect(0, 0, W, 64, 'F');
      doc.setTextColor(255);
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('Annual Leave Summary', 40, 32);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.text(`${year}`, 40, 50);
      doc.setFontSize(9);
      doc.text('Evergreen Shipping Agency Saudi · HR Department', W - 40, 50, { align: 'right' });
      doc.setTextColor(60, 60, 60);
      doc.setFontSize(9);
      doc.text(`Generated ${new Date().toLocaleString()}`, W - 40, 32, { align: 'right' });

      // Aggregates
      doc.setTextColor(45, 95, 63);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text(
        `Staff: ${leaveAgg.totalStaff}    ·    Total entitlement: ${leaveAgg.totalEnt.toFixed(1)}d    ·    Used: ${leaveAgg.totalUsed.toFixed(1)}d    ·    Pending: ${leaveAgg.totalPend.toFixed(1)}d    ·    Remaining: ${leaveAgg.totalRem.toFixed(1)}d`,
        40, 86
      );

      // Filter info
      const filterStr = [
        dept !== 'all' ? `Dept: ${dept}` : null,
        loc  !== 'all' ? `Location: ${LOCATION_LABELS[loc] || loc}` : null,
        search ? `Search: "${search}"` : null,
      ].filter(Boolean).join('   ·   ') || 'All staff';
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9);
      doc.setTextColor(110, 110, 110);
      doc.text(`Filter: ${filterStr}`, 40, 102);

      doc.autoTable({
        startY: 116,
        head: [['#', 'PSN', 'Name', 'Dept', 'Loc', 'Joined', 'YOS', 'Entitle', 'Used', 'Pending', 'Remain', 'Last leave', 'Status']],
        body: leaveRows.map((r, i) => {
          const st = utilisationStatus(r.bal?.used || 0, r.bal?.entitlement || 0);
          return [
            i + 1,
            r.emp.id,
            r.emp.name,
            r.emp.department || '—',
            r.emp.location || '—',
            r.emp.join_date ? fmtDateShort(r.emp.join_date) : '—',
            `${r.yrs}y ${r.mth}m`,
            (r.bal?.entitlement ?? 0).toFixed(1),
            (r.bal?.used        ?? 0).toFixed(1),
            (r.bal?.pending     ?? 0).toFixed(1),
            (r.bal?.remaining   ?? 0).toFixed(1),
            r.lastApproved ? fmtDateShort(r.lastApproved.start_date) : '—',
            st.label,
          ];
        }),
        headStyles:    { fillColor: [45, 95, 63], textColor: 255, fontSize: 9, fontStyle: 'bold' },
        bodyStyles:    { fontSize: 8, textColor: 50 },
        alternateRowStyles: { fillColor: [248, 248, 245] },
        columnStyles:  {
          0: { halign: 'right', cellWidth: 22 },
          6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' },
          9: { halign: 'right' }, 10: { halign: 'right' },
        },
        margin: { left: 40, right: 40 },
        didDrawPage: (data) => {
          const pageNum = doc.internal.getCurrentPageInfo().pageNumber;
          doc.setFontSize(8);
          doc.setTextColor(150);
          doc.text(`Page ${pageNum}`, W / 2, doc.internal.pageSize.getHeight() - 16, { align: 'center' });
        },
      });

      doc.save(`Annual_Leave_Summary_${year}.pdf`);
    } catch (e) {
      console.error(e);
      alert('PDF export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [leaveRows, leaveAgg, year, dept, loc, search]);

  const exportLeaveXlsx = useCallback(async () => {
    setExporting('xlsx');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      // Sheet 1: Detail
      const headers = ['#','PSN','Name','Department','Location','Joined','Years of Service','Entitlement (days)','Used','Pending','Remaining','Last leave','Status'];
      const rows = leaveRows.map((r, i) => [
        i + 1, r.emp.id, r.emp.name, r.emp.department || '—', r.emp.location || '—',
        r.emp.join_date || '—', `${r.yrs}y ${r.mth}m`,
        Number((r.bal?.entitlement ?? 0).toFixed(2)),
        Number((r.bal?.used        ?? 0).toFixed(2)),
        Number((r.bal?.pending     ?? 0).toFixed(2)),
        Number((r.bal?.remaining   ?? 0).toFixed(2)),
        r.lastApproved ? r.lastApproved.start_date : '—',
        utilisationStatus(r.bal?.used || 0, r.bal?.entitlement || 0).label,
      ]);
      const totalsRow = ['', '', `TOTAL (${leaveRows.length} staff)`, '', '', '', '',
        Number(leaveAgg.totalEnt.toFixed(2)),
        Number(leaveAgg.totalUsed.toFixed(2)),
        Number(leaveAgg.totalPend.toFixed(2)),
        Number(leaveAgg.totalRem.toFixed(2)), '', ''];
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows, [], totalsRow]);
      ws['!cols'] = [
        { wch: 4 }, { wch: 8 }, { wch: 32 }, { wch: 8 }, { wch: 8 }, { wch: 12 }, { wch: 14 },
        { wch: 12 }, { wch: 8 }, { wch: 10 }, { wch: 11 }, { wch: 12 }, { wch: 12 },
      ];
      XLSX.utils.book_append_sheet(wb, ws, 'Annual Leave');

      // Sheet 2: Department breakdown
      const ws2 = XLSX.utils.aoa_to_sheet([
        ['Department', 'Staff', 'Total Entitle', 'Used', 'Remaining'],
        ...deptBreakdown.map(d => [d.dept, d.staff, Number(d.ent.toFixed(2)), Number(d.used.toFixed(2)), Number(d.rem.toFixed(2))]),
      ]);
      ws2['!cols'] = [{ wch: 12 }, { wch: 8 }, { wch: 14 }, { wch: 8 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'By Department');

      XLSX.writeFile(wb, `Annual_Leave_Summary_${year}.xlsx`);
    } catch (e) {
      console.error(e);
      alert('Excel export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [leaveRows, leaveAgg, deptBreakdown, year]);

  const exportPermPdf = useCallback(async () => {
    setExporting('pdf');
    try {
      const { jsPDF } = await import('jspdf');
      await import('jspdf-autotable');
      const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
      const W = doc.internal.pageSize.getWidth();

      doc.setFillColor(45, 95, 63);
      doc.rect(0, 0, W, 64, 'F');
      doc.setTextColor(255);
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('Permissions Summary', 40, 32);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'normal');
      doc.text(`${year}`, 40, 50);
      doc.setFontSize(9);
      doc.text('Evergreen Shipping Agency Saudi · HR Department', W - 40, 50, { align: 'right' });
      doc.setTextColor(60, 60, 60);
      doc.text(`Generated ${new Date().toLocaleString()}`, W - 40, 32, { align: 'right' });

      doc.setTextColor(45, 95, 63);
      doc.setFontSize(11);
      doc.setFont('helvetica', 'bold');
      doc.text(`This month: ${permAgg.monthApps} applications · ${permAgg.monthPeople} people · ${permAgg.monthHours.toFixed(1)}h    YTD: ${permAgg.yearApps} applications · ${permAgg.yearPeople} people · ${permAgg.yearHours.toFixed(1)}h`, 40, 86);

      // Monthly breakdown table
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text('Monthly Breakdown', 40, 116);

      doc.autoTable({
        startY: 124,
        head: [MONTH_LABELS],
        body: [monthlyCounts],
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 9, halign: 'center' },
        margin: { left: 40, right: 40 },
      });

      const detailY = doc.lastAutoTable.finalY + 24;
      doc.setFontSize(10);
      doc.setFont('helvetica', 'bold');
      doc.text('Per-Employee Detail', 40, detailY - 6);

      doc.autoTable({
        startY: detailY,
        head: [['#', 'PSN', 'Name', 'Dept', 'Loc', 'Late', 'Late hrs', 'Early', 'Early hrs', 'Total apps', 'Total hrs', 'Last permission']],
        body: permRows.map((r, i) => [
          i + 1, r.emp.id, r.emp.name, r.emp.department || '—', r.emp.location || '—',
          r.lateCount, r.lateHours.toFixed(1),
          r.earlyCount, r.earlyHours.toFixed(1),
          r.totalCount, r.totalHours.toFixed(1),
          r.lastPerm ? fmtDateShort(r.lastPerm.permission_date) : '—',
        ]),
        headStyles: { fillColor: [45, 95, 63], textColor: 255, fontSize: 9 },
        bodyStyles: { fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 248, 245] },
        margin: { left: 40, right: 40 },
        columnStyles: {
          0: { halign: 'right', cellWidth: 22 },
          5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' },
          8: { halign: 'right' }, 9: { halign: 'right' }, 10: { halign: 'right' },
        },
      });

      doc.save(`Permissions_Summary_${year}.pdf`);
    } catch (e) {
      console.error(e);
      alert('PDF export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [permRows, permAgg, monthlyCounts, year]);

  const exportPermXlsx = useCallback(async () => {
    setExporting('xlsx');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      // Sheet 1: detail
      const headers = ['#','PSN','Name','Department','Location','Late count','Late hours','Early count','Early hours','Total apps','Total hours','Last permission'];
      const rows = permRows.map((r, i) => [
        i + 1, r.emp.id, r.emp.name, r.emp.department || '—', r.emp.location || '—',
        r.lateCount, Number(r.lateHours.toFixed(2)),
        r.earlyCount, Number(r.earlyHours.toFixed(2)),
        r.totalCount, Number(r.totalHours.toFixed(2)),
        r.lastPerm ? r.lastPerm.permission_date : '—',
      ]);
      const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
      ws['!cols'] = [{ wch: 4 }, { wch: 8 }, { wch: 32 }, { wch: 8 }, { wch: 8 },
        { wch: 6 }, { wch: 10 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Permissions');

      // Sheet 2: monthly breakdown
      const ws2 = XLSX.utils.aoa_to_sheet([
        ['Month', 'Applications'],
        ...MONTH_LABELS.map((m, i) => [m, monthlyCounts[i]]),
        [],
        ['TOTAL', monthlyCounts.reduce((s, n) => s + n, 0)],
      ]);
      ws2['!cols'] = [{ wch: 10 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, ws2, 'Monthly');

      XLSX.writeFile(wb, `Permissions_Summary_${year}.xlsx`);
    } catch (e) {
      console.error(e);
      alert('Excel export failed: ' + (e.message || e));
    } finally { setExporting(''); }
  }, [permRows, monthlyCounts, year]);

  // ===========================================================================
  // RENDER
  // ===========================================================================
  const exportPdf  = view === 'leave' ? exportLeavePdf  : exportPermPdf;
  const exportXlsx = view === 'leave' ? exportLeaveXlsx : exportPermXlsx;

  return (
    <div className="fade-in">
      {/* HEADER */}
      <div className="mb-5 sm:mb-6">
        <div className="text-[10px] tracking-[0.25em] opacity-60 mb-1">— INSIGHTS</div>
        <h1 className="text-3xl sm:text-4xl font-serif" style={{ color: 'var(--ink)' }}>
          Reports & Analytics
        </h1>
        <p className="text-sm opacity-70 mt-1">
          Live snapshots of leave usage and permission quotas across the organisation.
        </p>
      </div>

      {/* VIEW TOGGLE */}
      <div className="inline-flex rounded-full p-1 mb-5 sm:mb-6"
           style={{ background: 'var(--paper-soft, #F4F4EE)', border: '1px solid var(--border-soft)' }}>
        <button
          onClick={() => setView('leave')}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all"
          style={view === 'leave'
            ? { background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }
            : { background: 'transparent', color: 'var(--ink)' }}
        >
          <Plane className="w-4 h-4" /> Leave Summary
        </button>
        <button
          onClick={() => setView('permissions')}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all"
          style={view === 'permissions'
            ? { background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }
            : { background: 'transparent', color: 'var(--ink)' }}
        >
          <Coffee className="w-4 h-4" /> Permissions Summary
        </button>
      </div>

      {/* FILTER BAR */}
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

      {view === 'leave' ? (
        <LeaveSummary
          year={year} leaveRows={leaveRows} leaveAgg={leaveAgg}
          deptBreakdown={deptBreakdown} empMap={empMap}
        />
      ) : (
        <PermissionsSummary
          year={year} permRows={permRows} permAgg={permAgg}
          monthlyCounts={monthlyCounts} topUsers={topUsers}
          permLoading={permLoading}
        />
      )}
    </div>
  );
}

// ===========================================================================
// LEAVE SUMMARY VIEW
// ===========================================================================
function LeaveSummary({ year, leaveRows, leaveAgg, deptBreakdown }) {
  return (
    <>
      {/* HERO METRIC CARDS */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
        <HeroCard
          gradient="linear-gradient(135deg, #2D5F3F 0%, #4A8060 100%)"
          icon={<Users className="w-4 h-4" />}
          label="TOTAL STAFF"
          value={leaveAgg.totalStaff}
          unit="people"
          caption={`Filtered view · year ${year}`}
        />
        <HeroCard
          gradient="linear-gradient(135deg, #5A8A9A 0%, #7BA9B9 100%)"
          icon={<CalendarDays className="w-4 h-4" />}
          label="TOTAL ENTITLEMENT"
          value={leaveAgg.totalEnt.toFixed(0)}
          unit="days"
          caption="Sum of all annual quotas"
        />
        <HeroCard
          gradient="linear-gradient(135deg, #C97A4F 0%, #E0A079 100%)"
          icon={<TrendingUp className="w-4 h-4" />}
          label="DAYS USED"
          value={leaveAgg.totalUsed.toFixed(1)}
          unit={`+ ${leaveAgg.totalPend.toFixed(1)} pending`}
          caption={`${leaveAgg.totalEnt > 0 ? Math.round((leaveAgg.totalUsed / leaveAgg.totalEnt) * 100) : 0}% of total entitlement`}
        />
        <HeroCard
          gradient="linear-gradient(135deg, #6B5BA8 0%, #8B7BC8 100%)"
          icon={<Sparkles className="w-4 h-4" />}
          label="DAYS REMAINING"
          value={leaveAgg.totalRem.toFixed(1)}
          unit="days"
          caption="Available across all staff"
        />
      </div>

      {/* DEPARTMENT BREAKDOWN STRIP */}
      {deptBreakdown.length > 0 && (
        <div className="rounded-2xl border bg-white p-4 sm:p-5 mb-5"
             style={{ borderColor: 'var(--border-soft)' }}>
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
                    <span>Used {d.used.toFixed(0)}d</span>
                    <span>{pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* DETAIL TABLE */}
      <div className="rounded-2xl border bg-white overflow-hidden"
           style={{ borderColor: 'var(--border-soft)' }}>
        <div className="px-5 py-3 flex items-center justify-between"
             style={{ borderBottom: '1px solid var(--border-soft)', background: 'var(--paper-soft, #FBFAF6)' }}>
          <div className="text-[10px] tracking-[0.25em] opacity-60">
            STAFF DETAIL · {leaveRows.length} {leaveRows.length === 1 ? 'PERSON' : 'PEOPLE'}
          </div>
        </div>
        {leaveRows.length === 0 ? (
          <EmptyState text="No staff match the current filters." icon={<Users className="w-5 h-5" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] tracking-[0.15em] opacity-60"
                    style={{ borderBottom: '1px solid var(--border-soft)' }}>
                  <th className="text-left px-5 py-2.5 font-semibold">EMPLOYEE</th>
                  <th className="text-left px-3 py-2.5 font-semibold">DEPT</th>
                  <th className="text-left px-3 py-2.5 font-semibold">TENURE</th>
                  <th className="text-left px-3 py-2.5 font-semibold">UTILISATION</th>
                  <th className="text-right px-3 py-2.5 font-semibold">ENTITLE</th>
                  <th className="text-right px-3 py-2.5 font-semibold">USED</th>
                  <th className="text-right px-3 py-2.5 font-semibold">PENDING</th>
                  <th className="text-right px-3 py-2.5 font-semibold">REMAIN</th>
                  <th className="text-left px-3 py-2.5 font-semibold">LAST LEAVE</th>
                  <th className="text-left px-3 py-2.5 font-semibold">STATUS</th>
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
                        className="hover:bg-[var(--paper-soft,#F8F8F2)] transition-colors"
                        style={{ borderBottom: idx < leaveRows.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                               style={{ background: avatarColor(r.emp.id) }}>
                            {getInitials(r.emp.name)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium truncate" style={{ color: 'var(--ink)' }}>{r.emp.name}</div>
                            <div className="text-[10px] opacity-60 font-mono">{r.emp.id} · {LOCATION_LABELS[r.emp.location] || r.emp.location}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <span className="inline-block px-2 py-0.5 rounded-full"
                              style={{ background: 'rgba(45,95,63,0.08)', color: '#2D5F3F', border: '1px solid rgba(45,95,63,0.2)' }}>
                          {r.emp.department || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-xs opacity-80">{r.yrs}y {r.mth}m</td>
                      <td className="px-3 py-3 min-w-[120px]">
                        <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#E5E7EB' }}>
                          <div className="h-full transition-all"
                               style={{
                                 width: `${pct}%`,
                                 background: st.tone === 'critical'
                                   ? 'linear-gradient(90deg, #EF4444, #B83A2E)'
                                   : st.tone === 'warn'
                                     ? 'linear-gradient(90deg, #F59E0B, #D97706)'
                                     : 'linear-gradient(90deg, #2D5F3F, #4A8060)',
                               }} />
                        </div>
                        <div className="text-[10px] opacity-60 mt-1">{Math.round(pct)}%</div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">{ent.toFixed(1)}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-semibold">{used.toFixed(1)}</td>
                      <td className="px-3 py-3 text-right tabular-nums opacity-70">{(r.bal?.pending || 0).toFixed(1)}</td>
                      <td className="px-3 py-3 text-right tabular-nums font-semibold" style={{ color: '#2D5F3F' }}>
                        {(r.bal?.remaining || 0).toFixed(1)}
                      </td>
                      <td className="px-3 py-3 text-xs opacity-80">
                        {r.lastApproved ? fmtDateShort(r.lastApproved.start_date) : <span className="opacity-50">Never</span>}
                      </td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                              style={{ background: st.bg, color: st.color }}>
                          {st.tone === 'ok'       && <CheckCircle2 className="w-3 h-3" />}
                          {st.tone === 'warn'     && <AlertCircle  className="w-3 h-3" />}
                          {st.tone === 'critical' && <AlertCircle  className="w-3 h-3" />}
                          {st.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border-soft)', background: 'var(--paper-soft, #FBFAF6)' }}>
                  <td colSpan="4" className="px-5 py-3 text-xs font-bold" style={{ color: 'var(--ink)' }}>
                    TOTAL · {leaveRows.length} staff
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-bold">{leaveAgg.totalEnt.toFixed(1)}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-bold">{leaveAgg.totalUsed.toFixed(1)}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-bold">{leaveAgg.totalPend.toFixed(1)}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-bold" style={{ color: '#2D5F3F' }}>
                    {leaveAgg.totalRem.toFixed(1)}
                  </td>
                  <td colSpan="2"></td>
                </tr>
              </tfoot>
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
function PermissionsSummary({ year, permRows, permAgg, monthlyCounts, topUsers, permLoading }) {
  const maxCount = Math.max(1, ...monthlyCounts);
  const currentMonth = new Date().getMonth();
  const isCurrentYear = year === new Date().getFullYear();

  return (
    <>
      {/* HERO METRIC CARDS */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-5">
        <HeroCard
          gradient="linear-gradient(135deg, #C97A4F 0%, #E0A079 100%)"
          icon={<Coffee className="w-4 h-4" />}
          label="THIS MONTH"
          value={permAgg.monthApps}
          unit={`application${permAgg.monthApps === 1 ? '' : 's'}`}
          caption={`${permAgg.monthPeople} unique ${permAgg.monthPeople === 1 ? 'person' : 'people'}`}
        />
        <HeroCard
          gradient="linear-gradient(135deg, #5A8A9A 0%, #7BA9B9 100%)"
          icon={<Clock className="w-4 h-4" />}
          label="HOURS THIS MONTH"
          value={permAgg.monthHours.toFixed(1)}
          unit="hours"
          caption={`Out of ${PERMISSION_QUOTA.monthlyHours}h × ${permAgg.monthPeople || 0} = ${(PERMISSION_QUOTA.monthlyHours * (permAgg.monthPeople || 0)).toFixed(0)}h cap`}
        />
        <HeroCard
          gradient="linear-gradient(135deg, #2D5F3F 0%, #4A8060 100%)"
          icon={<BarChart3 className="w-4 h-4" />}
          label={`${year} TOTAL`}
          value={permAgg.yearApps}
          unit={`application${permAgg.yearApps === 1 ? '' : 's'}`}
          caption={`${permAgg.yearPeople} unique ${permAgg.yearPeople === 1 ? 'person' : 'people'}`}
        />
        <HeroCard
          gradient="linear-gradient(135deg, #6B5BA8 0%, #8B7BC8 100%)"
          icon={<TrendingUp className="w-4 h-4" />}
          label={`${year} HOURS`}
          value={permAgg.yearHours.toFixed(1)}
          unit="hours"
          caption="Total time across all permissions"
        />
      </div>

      {/* BAR CHART + TOP USERS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 mb-5">
        <div className="lg:col-span-2 rounded-2xl border bg-white p-4 sm:p-5"
             style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-[10px] tracking-[0.25em] opacity-60 mb-3">
            MONTHLY APPLICATIONS · {year}
          </div>
          <div className="flex items-end gap-1.5 sm:gap-2 h-44">
            {monthlyCounts.map((count, i) => {
              const h = (count / maxCount) * 100;
              const isCurrent = isCurrentYear && i === currentMonth;
              return (
                <div key={i} className="flex-1 flex flex-col items-center justify-end h-full gap-1.5 group">
                  <div className="text-[10px] font-bold tabular-nums opacity-80 group-hover:opacity-100"
                       style={{ color: count > 0 ? '#2D5F3F' : '#9CA3AF' }}>
                    {count > 0 ? count : ''}
                  </div>
                  <div className="w-full rounded-t-md transition-all duration-300"
                       style={{
                         height: `${Math.max(2, h)}%`,
                         background: isCurrent
                           ? 'linear-gradient(180deg, #C97A4F 0%, #B86A3F 100%)'
                           : count > 0
                             ? 'linear-gradient(180deg, #4A8060 0%, #2D5F3F 100%)'
                             : '#E5E7EB',
                         boxShadow: isCurrent ? '0 4px 12px rgba(201,122,79,0.35)' : 'none',
                       }} />
                  <div className="text-[10px] opacity-60 font-medium">{MONTH_LABELS[i]}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-2xl border bg-white p-4 sm:p-5"
             style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-[10px] tracking-[0.25em] opacity-60 mb-3">TOP REQUESTERS · {year}</div>
          {topUsers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 opacity-50">
              <Sparkles className="w-5 h-5 mb-2" />
              <div className="text-xs">No permission requests yet this year.</div>
            </div>
          ) : (
            <ul className="space-y-3">
              {topUsers.map((r, i) => (
                <li key={r.emp.id} className="flex items-center gap-3">
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold flex-shrink-0"
                       style={{ background: i === 0 ? '#FEF3C7' : 'var(--paper-soft, #F4F4EE)', color: i === 0 ? '#92400E' : 'var(--ink)' }}>
                    {i + 1}
                  </div>
                  <div className="w-7 h-7 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                       style={{ background: avatarColor(r.emp.id) }}>
                    {getInitials(r.emp.name)}
                  </div>
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

      {/* DETAIL TABLE */}
      <div className="rounded-2xl border bg-white overflow-hidden"
           style={{ borderColor: 'var(--border-soft)' }}>
        <div className="px-5 py-3 flex items-center justify-between"
             style={{ borderBottom: '1px solid var(--border-soft)', background: 'var(--paper-soft, #FBFAF6)' }}>
          <div className="text-[10px] tracking-[0.25em] opacity-60">
            STAFF DETAIL · {permRows.length} {permRows.length === 1 ? 'PERSON' : 'PEOPLE'}
          </div>
        </div>
        {permLoading ? (
          <EmptyState text="Loading permissions…" icon={<Clock className="w-5 h-5 animate-spin" />} />
        ) : permRows.length === 0 ? (
          <EmptyState text="No staff match the current filters." icon={<Users className="w-5 h-5" />} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[10px] tracking-[0.15em] opacity-60"
                    style={{ borderBottom: '1px solid var(--border-soft)' }}>
                  <th className="text-left px-5 py-2.5 font-semibold">EMPLOYEE</th>
                  <th className="text-left px-3 py-2.5 font-semibold">DEPT</th>
                  <th className="text-right px-3 py-2.5 font-semibold">LATE</th>
                  <th className="text-right px-3 py-2.5 font-semibold">EARLY</th>
                  <th className="text-right px-3 py-2.5 font-semibold">TOTAL APPS</th>
                  <th className="text-right px-3 py-2.5 font-semibold">TOTAL HOURS</th>
                  <th className="text-left px-3 py-2.5 font-semibold">LAST</th>
                  <th className="text-left px-3 py-2.5 font-semibold">THIS MONTH</th>
                </tr>
              </thead>
              <tbody>
                {permRows.map((r, idx) => {
                  const qs = quotaStatus(r.monthSummary);
                  return (
                    <tr key={r.emp.id}
                        className="hover:bg-[var(--paper-soft,#F8F8F2)] transition-colors"
                        style={{ borderBottom: idx < permRows.length - 1 ? '1px solid var(--border-soft)' : 'none' }}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0"
                               style={{ background: avatarColor(r.emp.id) }}>
                            {getInitials(r.emp.name)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium truncate" style={{ color: 'var(--ink)' }}>{r.emp.name}</div>
                            <div className="text-[10px] opacity-60 font-mono">{r.emp.id} · {LOCATION_LABELS[r.emp.location] || r.emp.location}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-xs">
                        <span className="inline-block px-2 py-0.5 rounded-full"
                              style={{ background: 'rgba(45,95,63,0.08)', color: '#2D5F3F', border: '1px solid rgba(45,95,63,0.2)' }}>
                          {r.emp.department || '—'}
                        </span>
                      </td>
                      <td className="px-3 py-3 text-right text-xs">
                        <div className="tabular-nums font-semibold" style={{ color: r.lateCount > 0 ? '#92400E' : '#9CA3AF' }}>
                          {r.lateCount}
                        </div>
                        <div className="text-[10px] opacity-60 tabular-nums">{r.lateHours.toFixed(1)}h</div>
                      </td>
                      <td className="px-3 py-3 text-right text-xs">
                        <div className="tabular-nums font-semibold" style={{ color: r.earlyCount > 0 ? '#92400E' : '#9CA3AF' }}>
                          {r.earlyCount}
                        </div>
                        <div className="text-[10px] opacity-60 tabular-nums">{r.earlyHours.toFixed(1)}h</div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-bold" style={{ color: 'var(--ink)' }}>
                        {r.totalCount}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums font-semibold" style={{ color: '#2D5F3F' }}>
                        {r.totalHours.toFixed(1)}h
                      </td>
                      <td className="px-3 py-3 text-xs opacity-80">
                        {r.lastPerm ? fmtDateShort(r.lastPerm.permission_date) : <span className="opacity-50">Never</span>}
                      </td>
                      <td className="px-3 py-3">
                        {isCurrentYear ? (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
                                style={{ background: qs.bg, color: qs.color }}>
                            {qs.label}
                          </span>
                        ) : (
                          <span className="text-[10px] opacity-50">—</span>
                        )}
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
// SHARED COMPONENTS
// ===========================================================================
function HeroCard({ gradient, icon, label, value, unit, caption }) {
  return (
    <div className="rounded-2xl p-4 sm:p-5 relative overflow-hidden"
         style={{ background: gradient, color: '#fff' }}>
      <div className="absolute top-0 right-0 w-24 h-24 rounded-full -mr-8 -mt-8" style={{ background: 'rgba(255,255,255,0.1)' }} />
      <div className="absolute bottom-0 right-0 w-16 h-16 rounded-full -mr-4 -mb-4" style={{ background: 'rgba(255,255,255,0.08)' }} />
      <div className="relative">
        <div className="flex items-center gap-2 text-[10px] tracking-[0.2em] opacity-90 mb-2">
          {icon} {label}
        </div>
        <div className="flex items-baseline gap-1.5">
          <div className="text-3xl sm:text-4xl font-bold tabular-nums">{value}</div>
          <div className="text-xs opacity-80">{unit}</div>
        </div>
        {caption && <div className="text-[10px] opacity-75 mt-1">{caption}</div>}
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
