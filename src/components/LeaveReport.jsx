// ──────────────────────────────────────────────────────────────────────
//  LeaveReport — monthly "who is on leave + who took permissions" report
//
//  Nadeem 2026-05-29. Main purpose: at a glance, who is on leave during
//  the selected month (and by extension who is available). Enriched with
//  the late / early permissions taken that month.
//
//  Decisions (Nadeem 2026-05-29):
//    • Approved leave only (stage='approved')
//    • A leave counts for the month if it OVERLAPS the month (even if it
//      starts/ends outside) — a 27 May→05 Jun leave shows in both May
//      and June reports
//    • Days = total calendar days in the range (incl. weekends)
//    • Sort: Location → Department → Staff
//    • Per-staff rollup at the bottom (total leave days + permission count)
//    • No "available today" section
//    • Three surfaces: on-screen interactive, HTML export, styled Excel
//
//  Scope:
//    • HR + admin  → all staff
//    • Manager     → direct reports + same dept/location
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useMemo } from 'react';
import {
  Plane, Clock, Download, FileText, ChevronLeft, ChevronRight, Users,
} from 'lucide-react';

// ── date helpers ──────────────────────────────────────────────────────
const MONTHS = ['January','February','March','April','May','June',
  'July','August','September','October','November','December'];

const ymd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};
const fmtDate = (s) => {
  if (!s) return '—';
  const d = new Date(s + (s.length === 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtShort = (s) => {
  if (!s) return '—';
  const d = new Date(s + (s.length === 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};
const fmtTime = (t) => t ? String(t).slice(0, 5) : '—';

// Inclusive calendar-day count between two YYYY-MM-DD strings
const dayCount = (from, to) => {
  if (!from || !to) return 0;
  const a = new Date(from + 'T00:00:00');
  const b = new Date(to + 'T00:00:00');
  return Math.max(1, Math.round((b - a) / 86400000) + 1);
};

// Leave-type colour dot (for legend + rows)
const LEAVE_TINT = {
  annual:      '#3B82F6',
  sick:        '#EF4444',
  emergency:   '#F59E0B',
  hajj:        '#10B981',
  maternity:   '#EC4899',
  paternity:   '#8B5CF6',
  marriage:    '#14B8A6',
  bereavement: '#6B7280',
  unpaid:      '#9CA3AF',
};
const tintFor = (id) => LEAVE_TINT[id] || '#3B82F6';

export default function LeaveReport({
  me, employees = [], leaveTypes = [], requests = [], permissions = [],
  isAdmin = false, isHrReviewer = false,
}) {
  const now = new Date();
  const [year, setYear]   = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth()); // 0-indexed

  // Month boundaries as YYYY-MM-DD
  const monthStart = ymd(new Date(year, month, 1));
  const monthEnd   = ymd(new Date(year, month + 1, 0));
  const todayStr   = ymd(now);

  // Employee lookup + scope -------------------------------------------------
  const empById = useMemo(() => {
    const m = {};
    for (const e of employees) m[e.id] = e;
    return m;
  }, [employees]);

  // Manager scope: direct reports + same dept/location. HR + admin: all.
  const inScope = useMemo(() => {
    if (isAdmin || isHrReviewer) return () => true;
    const myDept = empById[me?.id]?.department;
    const myLoc  = empById[me?.id]?.location;
    const reportIds = new Set(
      employees.filter(e => e.manager_id === me?.id).map(e => e.id)
    );
    return (psn) => {
      if (psn === me?.id) return true;
      if (reportIds.has(psn)) return true;
      const e = empById[psn];
      return e && e.department === myDept && e.location === myLoc;
    };
  }, [employees, empById, me?.id, isAdmin, isHrReviewer]);

  const leaveTypeName = (id) => {
    const t = leaveTypes.find(x => x.id === id);
    return t?.label || t?.name || (id ? id.charAt(0).toUpperCase() + id.slice(1) : '—');
  };

  // ── Leave rows for the month ───────────────────────────────────────
  const leaveRows = useMemo(() => {
    const out = [];
    for (const r of requests) {
      const stage = r.stage || r.status;
      if (stage !== 'approved') continue;            // approved only
      if (!r.start_date || !r.end_date) continue;
      // Overlap test: leave overlaps the month if start <= monthEnd
      // AND end >= monthStart
      if (!(r.start_date <= monthEnd && r.end_date >= monthStart)) continue;
      if (!inScope(r.employee_id)) continue;
      const e = empById[r.employee_id];
      const status = r.end_date < todayStr ? 'returned'
                   : r.start_date > todayStr ? 'upcoming'
                   : 'now';
      out.push({
        psn: r.employee_id,
        name: e?.name || r.employee_id,
        dept: e?.department || '',
        loc:  e?.location || '',
        typeId: r.leave_type_id,
        typeName: leaveTypeName(r.leave_type_id),
        from: r.start_date,
        to: r.end_date,
        days: dayCount(r.start_date, r.end_date),
        isHalf: !!r.is_half_day,
        status,
      });
    }
    // Sort: Location → Department → Staff name
    out.sort((a, b) =>
      a.loc.localeCompare(b.loc) ||
      a.dept.localeCompare(b.dept) ||
      a.name.localeCompare(b.name));
    return out;
  }, [requests, monthStart, monthEnd, todayStr, inScope, empById, leaveTypes]);

  // ── Permission rows for the month ──────────────────────────────────
  const permRows = useMemo(() => {
    const out = [];
    // For quota: order each staff's approved permissions in the month
    // chronologically and number them.
    const byStaff = {};
    const approved = permissions
      .filter(p => (p.stage || p.status) === 'approved')
      .filter(p => p.permission_date >= monthStart && p.permission_date <= monthEnd)
      .filter(p => inScope(p.employee_id))
      .sort((a, b) => String(a.permission_date).localeCompare(String(b.permission_date)));
    for (const p of approved) {
      byStaff[p.employee_id] = (byStaff[p.employee_id] || 0) + 1;
      const seq = byStaff[p.employee_id];
      const e = empById[p.employee_id];
      const isLate = (p.type || '').includes('late');
      out.push({
        psn: p.employee_id,
        name: e?.name || p.employee_id,
        dept: e?.department || '',
        loc:  e?.location || '',
        date: p.permission_date,
        type: isLate ? 'LATE' : 'EARLY',
        from: p.time_from,
        to: p.time_to,
        mins: (() => {
          const tm = (t) => { if (!t) return null; const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
          const a = tm(p.time_from), b = tm(p.time_to);
          return (a != null && b != null) ? Math.max(0, b - a) : (p.hours ? Math.round(p.hours * 60) : 0);
        })(),
        reason: p.reason || '',
        seq,
        overQuota: seq > 3 || !!p.exceeds_quota,
      });
    }
    // Sort: Location → Dept → Staff → Date
    out.sort((a, b) =>
      a.loc.localeCompare(b.loc) ||
      a.dept.localeCompare(b.dept) ||
      a.name.localeCompare(b.name) ||
      String(a.date).localeCompare(String(b.date)));
    return out;
  }, [permissions, monthStart, monthEnd, inScope, empById]);

  // ── Per-staff rollup ───────────────────────────────────────────────
  const rollup = useMemo(() => {
    const m = {};
    for (const r of leaveRows) {
      if (!m[r.psn]) m[r.psn] = { psn: r.psn, name: r.name, dept: r.dept, loc: r.loc, leaveDays: 0, leaveCount: 0, perms: 0 };
      m[r.psn].leaveDays += r.days;
      m[r.psn].leaveCount += 1;
    }
    for (const p of permRows) {
      if (!m[p.psn]) m[p.psn] = { psn: p.psn, name: p.name, dept: p.dept, loc: p.loc, leaveDays: 0, leaveCount: 0, perms: 0 };
      m[p.psn].perms += 1;
    }
    return Object.values(m).sort((a, b) =>
      a.loc.localeCompare(b.loc) || a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name));
  }, [leaveRows, permRows]);

  // ── Summary ────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    const onLeaveStaff = new Set(leaveRows.map(r => r.psn));
    const outToday = leaveRows.filter(r => r.status === 'now').length;
    const latePerms = permRows.filter(p => p.type === 'LATE').length;
    const earlyPerms = permRows.filter(p => p.type === 'EARLY').length;
    const overQuota = permRows.filter(p => p.overQuota).length;
    const scopeTotal = (isAdmin || isHrReviewer)
      ? employees.length
      : employees.filter(e => inScope(e.id)).length;
    return {
      onLeaveStaff: onLeaveStaff.size,
      leaveRequests: leaveRows.length,
      outToday,
      available: Math.max(0, scopeTotal - outToday),
      scopeTotal,
      latePerms, earlyPerms, overQuota,
      permStaff: new Set(permRows.map(p => p.psn)).size,
    };
  }, [leaveRows, permRows, employees, inScope, isAdmin, isHrReviewer]);

  const periodLabel = `${MONTHS[month]} ${year}`;
  const scopeLabel = (isAdmin || isHrReviewer) ? 'All staff' : 'My team + department';

  const prevMonth = () => {
    if (month === 0) { setMonth(11); setYear(y => y - 1); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setMonth(0); setYear(y => y + 1); }
    else setMonth(m => m + 1);
  };

  // ── HTML export ────────────────────────────────────────────────────
  const exportHtml = () => {
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const statusPill = (st) => {
      const m = {
        now:      { bg: '#FEE2E2', fg: '#991B1B', label: 'OUT NOW' },
        upcoming: { bg: '#DBEAFE', fg: '#1D4ED8', label: 'UPCOMING' },
        returned: { bg: '#D1FAE5', fg: '#065F46', label: 'RETURNED' },
      }[st] || {};
      return `<span style="background:${m.bg};color:${m.fg};padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700">${m.label}</span>`;
    };
    const leaveTbody = leaveRows.map(r => `
      <tr${r.status === 'now' ? ' style="background:#FEF2F2"' : r.status === 'returned' ? ' style="opacity:.72"' : ''}>
        <td>${esc(r.psn)}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.dept)}</td>
        <td>${esc(r.loc)}</td>
        <td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${tintFor(r.typeId)};margin-right:5px"></span>${esc(r.typeName)}</td>
        <td>${esc(fmtShort(r.from))}</td>
        <td>${esc(fmtShort(r.to))}</td>
        <td style="text-align:right">${r.days}${r.isHalf ? ' <span style="background:#FEF3C7;color:#854F0B;padding:1px 4px;border-radius:2px;font-size:8px;font-weight:700">½</span>' : ''}</td>
        <td>${statusPill(r.status)}</td>
      </tr>`).join('');
    const permTbody = permRows.map(p => `
      <tr${p.overQuota ? ' style="background:#FEF2F2"' : ''}>
        <td>${esc(p.psn)}</td>
        <td>${esc(p.name)}</td>
        <td>${esc(p.dept)}</td>
        <td>${esc(p.loc)}</td>
        <td>${esc(fmtShort(p.date))}</td>
        <td><span style="background:${p.type === 'LATE' ? '#FFEDD5' : '#E0E7FF'};color:${p.type === 'LATE' ? '#9A3412' : '#3730A3'};padding:2px 6px;border-radius:3px;font-size:9px;font-weight:700">${p.type}</span></td>
        <td>${esc(fmtTime(p.from))}–${esc(fmtTime(p.to))}</td>
        <td style="text-align:right">${p.mins}</td>
        <td>${esc(p.reason)}</td>
        <td${p.overQuota ? ' style="color:#991B1B;font-weight:700"' : ''}>${p.seq} of 3${p.overQuota ? ' ⚠' : ''}</td>
      </tr>`).join('');
    const rollupTbody = rollup.map(r => `
      <tr>
        <td>${esc(r.psn)}</td>
        <td>${esc(r.name)}</td>
        <td>${esc(r.dept)}</td>
        <td>${esc(r.loc)}</td>
        <td style="text-align:right">${r.leaveDays}</td>
        <td style="text-align:right">${r.leaveCount}</td>
        <td style="text-align:right">${r.perms}</td>
      </tr>`).join('');

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>Leave & Availability — ${esc(periodLabel)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family:'Calibri','Segoe UI',sans-serif; color:#1F1B16; font-size:10px; margin:0; padding:20px; }
  .report-header { border-bottom:2px solid #0F4C2A; padding-bottom:12px; margin-bottom:16px; }
  .kicker { font-size:9px; letter-spacing:.3em; color:#0F4C2A; font-weight:700; text-transform:uppercase; }
  h1 { font-size:22px; margin:4px 0 2px; color:#0A0A0A; }
  .sub { font-size:11px; color:#555; }
  .meta { display:flex; gap:18px; margin-top:8px; font-size:10px; }
  .meta strong { color:#0A0A0A; }
  .summary { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-bottom:18px; }
  .card { border:1px solid rgba(0,0,0,.08); border-radius:6px; padding:8px 10px; }
  .card .lbl { font-size:9px; letter-spacing:.12em; color:#555; text-transform:uppercase; }
  .card .val { font-size:20px; font-weight:700; margin-top:2px; color:#0A0A0A; }
  .card .sv { font-size:9px; color:#666; }
  h2 { font-size:13px; margin:18px 0 6px; color:#0F4C2A; }
  table { width:100%; border-collapse:collapse; font-size:10px; margin-bottom:6px; }
  th { background:#0F4C2A; color:#fff; padding:4px 7px; text-align:left; font-size:9px; text-transform:uppercase; letter-spacing:.03em; white-space:nowrap; }
  td { padding:3px 7px; border-bottom:1px solid #F3F4F6; white-space:nowrap; }
  .no-print { } @media print { .no-print { display:none !important; } body { padding:0; } }
  .pbtn { background:#0F4C2A; color:#fff; padding:6px 14px; border:0; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600; }
  .footer { margin-top:20px; padding-top:10px; border-top:1px solid #D1D5DB; font-size:9px; color:#666; display:flex; justify-content:space-between; }
</style></head><body>
  <div class="no-print" style="margin-bottom:10px"><button class="pbtn" onclick="window.print()">Print / Save as PDF</button></div>
  <header class="report-header">
    <div class="kicker">Evergreen Shipping Agency Saudi Co. (L.L.C) · ESAU HR</div>
    <h1>Leave &amp; Availability — ${esc(periodLabel)}</h1>
    <div class="sub">Who is on leave this month, plus late / early permissions taken</div>
    <div class="meta">
      <span><strong>Generated:</strong> ${esc(new Date().toLocaleString('en-GB', { day:'numeric', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }))}</span>
      <span><strong>Scope:</strong> ${esc(scopeLabel)} (${summary.scopeTotal})</span>
    </div>
  </header>
  <div class="summary">
    <div class="card" style="border-color:#FCD34D;background:#FFFBEB"><div class="lbl">On leave (month)</div><div class="val">${summary.onLeaveStaff}</div><div class="sv">${summary.leaveRequests} requests</div></div>
    <div class="card" style="border-color:#FCA5A5;background:#FEF2F2"><div class="lbl">Out today</div><div class="val" style="color:#991B1B">${summary.outToday}</div><div class="sv">${esc(fmtShort(todayStr))}</div></div>
    <div class="card" style="border-color:#A7F3D0;background:#F0FDF4"><div class="lbl">Available now</div><div class="val" style="color:#065F46">${summary.available}</div><div class="sv">of ${summary.scopeTotal}</div></div>
    <div class="card" style="border-color:#BFDBFE;background:#EFF6FF"><div class="lbl">Late permissions</div><div class="val">${summary.latePerms}</div><div class="sv">${summary.overQuota} over quota</div></div>
    <div class="card" style="border-color:#FBCFE8;background:#FDF4FF"><div class="lbl">Early permissions</div><div class="val">${summary.earlyPerms}</div><div class="sv">${summary.permStaff} staff total</div></div>
  </div>
  <h2>Staff on leave this month (${leaveRows.length})</h2>
  <table><thead><tr><th>Staff ID</th><th>Name</th><th>Dept</th><th>Loc</th><th>Leave Type</th><th>From</th><th>To</th><th style="text-align:right">Days</th><th>Status</th></tr></thead>
    <tbody>${leaveTbody || '<tr><td colspan="9" style="padding:8px;color:#999;font-style:italic">No approved leave overlapping this month.</td></tr>'}</tbody></table>
  <h2>Late &amp; early permissions this month (${permRows.length})</h2>
  <table><thead><tr><th>Staff ID</th><th>Name</th><th>Dept</th><th>Loc</th><th>Date</th><th>Type</th><th>Window</th><th style="text-align:right">Mins</th><th>Reason</th><th>Quota</th></tr></thead>
    <tbody>${permTbody || '<tr><td colspan="10" style="padding:8px;color:#999;font-style:italic">No approved permissions this month.</td></tr>'}</tbody></table>
  <h2>Per-staff summary (${rollup.length})</h2>
  <table><thead><tr><th>Staff ID</th><th>Name</th><th>Dept</th><th>Loc</th><th style="text-align:right">Leave Days</th><th style="text-align:right">Leave Reqs</th><th style="text-align:right">Permissions</th></tr></thead>
    <tbody>${rollupTbody || '<tr><td colspan="7" style="padding:8px;color:#999;font-style:italic">No activity this month.</td></tr>'}</tbody></table>
  <div class="footer"><span>Leave &amp; Availability · ${esc(periodLabel)} · ESAU HR portal</span><span>Approved leave overlapping the month · calendar days</span></div>
</body></html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) {
      const a = document.createElement('a');
      a.href = url; a.download = `Leave_${periodLabel.replace(/\s+/g, '_')}.html`; a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  // ── Excel export ───────────────────────────────────────────────────
  const exportExcel = async () => {
    const XLSX = await import('xlsx-js-style');
    const GREEN = '0F4C2A';
    const border = { top:{style:'thin',color:{rgb:'E5E7EB'}}, bottom:{style:'thin',color:{rgb:'E5E7EB'}}, left:{style:'thin',color:{rgb:'E5E7EB'}}, right:{style:'thin',color:{rgb:'E5E7EB'}} };
    const hStyle = { font:{bold:true,color:{rgb:'FFFFFF'},sz:10}, fill:{fgColor:{rgb:GREEN}}, alignment:{horizontal:'center',vertical:'center',wrapText:true}, border };
    const c = (extra={}) => ({ font:{sz:10,color:{rgb:'1F1B16'}}, alignment:{vertical:'center'}, border, ...extra });

    const wb = XLSX.utils.book_new();

    // Sheet 1 — On leave
    const leaveAoa = [['Staff ID','Name','Department','Location','Leave Type','From','To','Days','Half','Status']];
    for (const r of leaveRows) {
      leaveAoa.push([r.psn, r.name, r.dept, r.loc, r.typeName, r.from, r.to, r.days, r.isHalf ? 'Half' : '', r.status.toUpperCase()]);
    }
    const ws1 = XLSX.utils.aoa_to_sheet(leaveAoa);
    styleSheet(XLSX, ws1, leaveAoa, hStyle, c, 9 /*status col*/, {
      now: { bg:'FEE2E2', fg:'991B1B' }, upcoming: { bg:'DBEAFE', fg:'1D4ED8' }, returned: { bg:'D1FAE5', fg:'065F46' },
    });
    ws1['!cols'] = [{wch:9},{wch:28},{wch:12},{wch:9},{wch:14},{wch:12},{wch:12},{wch:7},{wch:7},{wch:11}];
    XLSX.utils.book_append_sheet(wb, ws1, 'On Leave');

    // Sheet 2 — Permissions
    const permAoa = [['Staff ID','Name','Department','Location','Date','Type','From','To','Mins','Reason','Quota','Over?']];
    for (const p of permRows) {
      permAoa.push([p.psn, p.name, p.dept, p.loc, p.date, p.type, fmtTime(p.from), fmtTime(p.to), p.mins, p.reason, `${p.seq} of 3`, p.overQuota ? 'OVER' : '']);
    }
    const ws2 = XLSX.utils.aoa_to_sheet(permAoa);
    styleSheet(XLSX, ws2, permAoa, hStyle, c, 5 /*type col*/, {
      LATE: { bg:'FFEDD5', fg:'9A3412' }, EARLY: { bg:'E0E7FF', fg:'3730A3' },
    });
    ws2['!cols'] = [{wch:9},{wch:28},{wch:12},{wch:9},{wch:12},{wch:8},{wch:8},{wch:8},{wch:7},{wch:24},{wch:9},{wch:7}];
    XLSX.utils.book_append_sheet(wb, ws2, 'Permissions');

    // Sheet 3 — Per-staff summary
    const rollAoa = [['Staff ID','Name','Department','Location','Leave Days','Leave Reqs','Permissions']];
    for (const r of rollup) rollAoa.push([r.psn, r.name, r.dept, r.loc, r.leaveDays, r.leaveCount, r.perms]);
    const ws3 = XLSX.utils.aoa_to_sheet(rollAoa);
    styleSheet(XLSX, ws3, rollAoa, hStyle, c, -1, {});
    ws3['!cols'] = [{wch:9},{wch:28},{wch:12},{wch:9},{wch:11},{wch:11},{wch:12}];
    XLSX.utils.book_append_sheet(wb, ws3, 'Summary');

    XLSX.writeFile(wb, `Leave_${periodLabel.replace(/\s+/g, '_')}.xlsx`);
  };

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header + controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold flex items-center gap-2" style={{ color: '#0A0A0A' }}>
            <Plane size={18} style={{ color: '#0F4C2A' }} /> Leave &amp; Availability
          </h2>
          <p className="text-xs mt-0.5" style={{ color: '#1F1B16', opacity: 0.65 }}>
            Who is on leave this month, plus late / early permissions · {scopeLabel}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border px-1" style={{ borderColor: 'rgba(0,0,0,0.12)' }}>
            <button onClick={prevMonth} className="p-1.5 rounded hover:bg-black/[0.05]"><ChevronLeft size={15} /></button>
            <span className="text-sm font-semibold px-2 min-w-[120px] text-center" style={{ color: '#0A0A0A' }}>{periodLabel}</span>
            <button onClick={nextMonth} className="p-1.5 rounded hover:bg-black/[0.05]"><ChevronRight size={15} /></button>
          </div>
          <button onClick={exportHtml}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded border"
            style={{ borderColor: '#0F4C2A', color: '#0F4C2A', background: '#FFFFFF' }}>
            <FileText size={12} /> HTML
          </button>
          <button onClick={exportExcel}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded text-white"
            style={{ background: '#0F4C2A' }}>
            <Download size={12} /> Excel
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        <SummaryCard label="On leave (month)" val={summary.onLeaveStaff} sub={`${summary.leaveRequests} requests`} bg="#FFFBEB" border="#FCD34D" />
        <SummaryCard label="Out today" val={summary.outToday} sub={fmtShort(todayStr)} bg="#FEF2F2" border="#FCA5A5" fg="#991B1B" />
        <SummaryCard label="Available now" val={summary.available} sub={`of ${summary.scopeTotal}`} bg="#F0FDF4" border="#A7F3D0" fg="#065F46" />
        <SummaryCard label="Late permissions" val={summary.latePerms} sub={`${summary.overQuota} over quota`} bg="#EFF6FF" border="#BFDBFE" />
        <SummaryCard label="Early permissions" val={summary.earlyPerms} sub={`${summary.permStaff} staff`} bg="#FDF4FF" border="#FBCFE8" />
      </div>

      {/* Section 1 — On leave */}
      <Section title="Staff on leave this month" count={leaveRows.length} icon={Plane}>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ background: '#0F4C2A' }}>
              {['Staff ID','Name','Dept','Loc','Leave Type','From','To','Days','Status'].map((h, i) => (
                <th key={i} className="px-2 py-1.5 text-left text-white text-[10px] uppercase tracking-wide whitespace-nowrap"
                    style={{ textAlign: h === 'Days' ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {leaveRows.length === 0 ? (
              <tr><td colSpan={9} className="px-3 py-4 text-center" style={{ color: '#1F1B16', opacity: 0.5 }}>No approved leave overlapping {periodLabel}.</td></tr>
            ) : leaveRows.map((r, i) => (
              <tr key={i} className="border-t" style={{
                borderColor: 'rgba(0,0,0,0.05)',
                background: r.status === 'now' ? '#FEF2F2' : 'transparent',
                opacity: r.status === 'returned' ? 0.72 : 1,
              }}>
                <td className="px-2 py-1 font-mono">{r.psn}</td>
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1">{r.dept}</td>
                <td className="px-2 py-1">{r.loc}</td>
                <td className="px-2 py-1">
                  <span className="inline-block w-2 h-2 rounded-sm mr-1.5 align-middle" style={{ background: tintFor(r.typeId) }}></span>
                  {r.typeName}
                </td>
                <td className="px-2 py-1 whitespace-nowrap">{fmtShort(r.from)}</td>
                <td className="px-2 py-1 whitespace-nowrap">{fmtShort(r.to)}</td>
                <td className="px-2 py-1 text-right">
                  {r.days}{r.isHalf && <span className="ml-1 text-[8px] px-1 py-0.5 rounded font-bold" style={{ background: '#FEF3C7', color: '#854F0B' }}>½</span>}
                </td>
                <td className="px-2 py-1"><StatusPill status={r.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Section 2 — Permissions */}
      <Section title="Late & early permissions this month" count={permRows.length} icon={Clock}>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ background: '#0F4C2A' }}>
              {['Staff ID','Name','Dept','Loc','Date','Type','Window','Mins','Reason','Quota'].map((h, i) => (
                <th key={i} className="px-2 py-1.5 text-left text-white text-[10px] uppercase tracking-wide whitespace-nowrap"
                    style={{ textAlign: h === 'Mins' ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {permRows.length === 0 ? (
              <tr><td colSpan={10} className="px-3 py-4 text-center" style={{ color: '#1F1B16', opacity: 0.5 }}>No approved permissions in {periodLabel}.</td></tr>
            ) : permRows.map((p, i) => (
              <tr key={i} className="border-t" style={{ borderColor: 'rgba(0,0,0,0.05)', background: p.overQuota ? '#FEF2F2' : 'transparent' }}>
                <td className="px-2 py-1 font-mono">{p.psn}</td>
                <td className="px-2 py-1">{p.name}</td>
                <td className="px-2 py-1">{p.dept}</td>
                <td className="px-2 py-1">{p.loc}</td>
                <td className="px-2 py-1 whitespace-nowrap">{fmtShort(p.date)}</td>
                <td className="px-2 py-1">
                  <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                        style={p.type === 'LATE' ? { background: '#FFEDD5', color: '#9A3412' } : { background: '#E0E7FF', color: '#3730A3' }}>
                    {p.type}
                  </span>
                </td>
                <td className="px-2 py-1 font-mono whitespace-nowrap">{fmtTime(p.from)}–{fmtTime(p.to)}</td>
                <td className="px-2 py-1 text-right">{p.mins}</td>
                <td className="px-2 py-1">{p.reason}</td>
                <td className="px-2 py-1" style={p.overQuota ? { color: '#991B1B', fontWeight: 700 } : {}}>
                  {p.seq} of 3{p.overQuota ? ' ⚠' : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>

      {/* Section 3 — Per-staff rollup */}
      <Section title="Per-staff summary" count={rollup.length} icon={Users}>
        <table className="w-full text-xs">
          <thead>
            <tr style={{ background: '#0F4C2A' }}>
              {['Staff ID','Name','Dept','Loc','Leave Days','Leave Reqs','Permissions'].map((h, i) => (
                <th key={i} className="px-2 py-1.5 text-white text-[10px] uppercase tracking-wide whitespace-nowrap"
                    style={{ textAlign: i >= 4 ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rollup.length === 0 ? (
              <tr><td colSpan={7} className="px-3 py-4 text-center" style={{ color: '#1F1B16', opacity: 0.5 }}>No activity this month.</td></tr>
            ) : rollup.map((r, i) => (
              <tr key={i} className="border-t" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
                <td className="px-2 py-1 font-mono">{r.psn}</td>
                <td className="px-2 py-1">{r.name}</td>
                <td className="px-2 py-1">{r.dept}</td>
                <td className="px-2 py-1">{r.loc}</td>
                <td className="px-2 py-1 text-right font-semibold">{r.leaveDays}</td>
                <td className="px-2 py-1 text-right">{r.leaveCount}</td>
                <td className="px-2 py-1 text-right">{r.perms}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
    </div>
  );
}

// ── Excel sheet styling helper ──────────────────────────────────────────
function styleSheet(XLSX, ws, aoa, hStyle, c, pillCol, pillMap) {
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let R = range.s.r; R <= range.e.r; R++) {
    for (let C = range.s.c; C <= range.e.c; C++) {
      const addr = XLSX.utils.encode_cell({ r: R, c: C });
      if (!ws[addr]) continue;
      if (R === 0) { ws[addr].s = hStyle; continue; }
      let style = c({ alignment: { vertical: 'center', horizontal: 'left' } });
      if (C === pillCol) {
        const sc = pillMap[ws[addr].v];
        if (sc) style = c({ font: { bold: true, sz: 10, color: { rgb: sc.fg } }, fill: { fgColor: { rgb: sc.bg } }, alignment: { horizontal: 'center', vertical: 'center' } });
      }
      ws[addr].s = style;
    }
  }
}

// ── Small presentational components ─────────────────────────────────────
function SummaryCard({ label, val, sub, bg, border, fg = '#0A0A0A' }) {
  return (
    <div className="rounded-lg border p-2.5" style={{ background: bg, borderColor: border }}>
      <div className="text-[9px] uppercase tracking-wider" style={{ color: '#1F1B16', opacity: 0.6 }}>{label}</div>
      <div className="text-xl font-bold mt-0.5" style={{ color: fg }}>{val}</div>
      <div className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.55 }}>{sub}</div>
    </div>
  );
}

function Section({ title, count, icon: Icon, children }) {
  return (
    <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ borderColor: 'rgba(0,0,0,0.06)', background: '#FAFAF9' }}>
        {Icon && <Icon size={14} style={{ color: '#0F4C2A' }} />}
        <span className="text-xs font-bold uppercase tracking-wide" style={{ color: '#0A0A0A' }}>{title}</span>
        <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: '#F3F4F6', color: '#1F1B16' }}>{count}</span>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </div>
  );
}

function StatusPill({ status }) {
  const m = {
    now:      { bg: '#FEE2E2', fg: '#991B1B', label: 'OUT NOW' },
    upcoming: { bg: '#DBEAFE', fg: '#1D4ED8', label: 'UPCOMING' },
    returned: { bg: '#D1FAE5', fg: '#065F46', label: 'RETURNED' },
  }[status] || {};
  return <span className="text-[9px] px-1.5 py-0.5 rounded font-bold" style={{ background: m.bg, color: m.fg }}>{m.label}</span>;
}
