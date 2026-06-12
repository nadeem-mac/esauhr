import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { Check, Copy, ArrowRight, Palmtree, Calendar, KeyRound, Mail, AlertCircle, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '../supabaseClient.js';
import { todayISO, fmtDateShort, getInitials, avatarColor, isActiveEmployee } from '../lib/leaveLogic.js';
import { summariseMonth } from '../lib/permissionLogic.js';
import { parseEmailAddress } from '../lib/emailTemplates.js';
import { salutationFor } from '../lib/salutations.js';
import BashaierTasksCard from './BashaierTasksCard.jsx';
import PendingShiftApprovalsCard from './PendingShiftApprovalsCard.jsx';
import HrShiftMonthCard from './HrShiftMonthCard.jsx';

// Shared female-name fallback used when an employee's gender isn't set
// explicitly. Kept module-level so headcount cross-tabs and the dept
// breakdown classify gender identically.
const FEMALE_FIRST_NAMES = new Set(['BASHAIER','BADRIA','SHAHAD','AMNA','AMINAH','NORA','NORAH','NOURA','LAYLA','SARA','SARAH','MARIA','JOAN','JOY','GRACE','AISHA','AMINA','FATIMA','KHADIJA','MARIAM','MARYAM','ZAINAB','HAYA','REEM','REEMA','RANA','DANA','LINA','NADA','WAFA','AYESHA','PRINCESS','JESSICA','JENNIFER','ANNA','HANNAH','LISA','EMMA','OLIVIA','SOPHIA','PRIYA','NEHA','SAFIA','SAFIYA']);
function isFemaleEmployee(e) {
  const g = (e?.gender || '').toLowerCase();
  if (g === 'female' || g === 'f') return true;
  if (g === 'male' || g === 'm') return false;
  const first = (e?.name || '').split(/\s+/)[0].toUpperCase();
  return FEMALE_FIRST_NAMES.has(first);
}

// HQ "Personnel Statistic" — budgeted headcount per location/department,
// set by HQ. Order matters (mirrors the official sheet). Current M/F/T is
// computed live from the roster; balance = current − budget.
const HQ_PERSONNEL = [
  { key: 'MGT',     label: 'MGT',        budget: 1  },
  { key: 'SUP',     label: 'SUP',        budget: 4  },
  { key: 'FIN',     label: 'FIN',        budget: 8  },
  { key: 'BIZ',     label: 'BIZ',        budget: 7  },
  { key: 'CSD',     label: 'CSD',        budget: 10 },
  { key: 'LOG',     label: 'LOG',        budget: 8  },
  { key: 'JED',     label: 'JED',        budget: 2  },
  { key: 'JED-SUP', label: 'JED-SUP',    budget: 1  },
  { key: 'JED-BIZ', label: 'JED-BIZ',    budget: 6  },
  { key: 'JED-CSD', label: 'JED-CSD',    budget: 11 },
  { key: 'JED-LOG', label: 'JED-LOG',    budget: 8  },
  { key: 'RYD',     label: 'RYD Office', budget: 7  },
];
const DMM_DEPTS = new Set(['SUP', 'FIN', 'BIZ', 'CSD', 'LOG']);
const JED_DEPTS = new Set(['SUP', 'BIZ', 'CSD', 'LOG']);
// Which HQ category an active employee falls into.
function personnelCategory(e) {
  const loc = e?.location;
  const dept = e?.department;
  if (loc === 'RYD') return 'RYD';
  if (loc === 'JED') return JED_DEPTS.has(dept) ? `JED-${dept}` : 'JED';
  if (loc === 'DMM') return DMM_DEPTS.has(dept) ? dept : 'MGT';
  return null;
}

// Minimal table cells for the headcount tile — hairline rules, muted
// uppercase headers, right-aligned figures. No fills, no gradients.
const HCol = ({ children, left }) => (
  <th className={`text-[10px] uppercase tracking-wider font-bold pb-2 whitespace-nowrap ${left ? 'text-left pr-4' : 'text-right pl-5'}`}
      style={{ color: '#1F1B16', opacity: 0.5, borderBottom: '1px solid #E5E5E5' }}>{children}</th>
);
const DCell = ({ children, left, strong, danger, top }) => (
  <td className={`text-[13px] py-2 whitespace-nowrap ${left ? 'text-left pr-4' : 'text-right pl-5'} ${strong ? 'font-semibold' : ''}`}
      style={{ color: danger ? '#B91C1C' : '#1F1B16', borderBottom: '1px solid #F2F2F2', borderTop: top ? '1px solid #D4D4D4' : undefined }}>{children}</td>
);
const DEPT_DOT = { CSD: '#1D4ED8', LOG: '#047857', BIZ: '#D97706', FIN: '#6D28D9', SUP: '#C2410C', MGT: '#0F4C2A' };

// ── Modern headcount visuals ──────────────────────────────────────────
const HcStat = ({ label, value, accent }) => (
  <div className="transition-all hover:-translate-y-0.5"
       style={{ background: '#FAFAF7', border: '1px solid #ECEAE0', borderRadius: 12, padding: '12px 14px' }}>
    <div style={{ fontSize: 24, fontWeight: 600, color: accent, letterSpacing: '-0.01em', lineHeight: 1 }}>{value}</div>
    <div className="mt-1" style={{ fontSize: 10, letterSpacing: '0.1em', fontWeight: 700, color: '#1F1B16', opacity: 0.6, textTransform: 'uppercase' }}>{label}</div>
  </div>
);

// Horizontal stacked proportion bar with a small legend underneath.
const SplitBar = ({ title, segs }) => {
  const total = segs.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div>
      <div className="text-[10px] uppercase font-bold mb-2" style={{ color: '#1F1B16', letterSpacing: '0.18em', opacity: 0.7 }}>{title}</div>
      <div className="flex w-full overflow-hidden" style={{ height: 12, borderRadius: 999, background: '#F0EFEA' }}>
        {segs.map(s => (
          <div key={s.label} title={`${s.label}: ${s.value}`} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
        {segs.map(s => (
          <div key={s.label} className="flex items-center gap-1.5">
            <span className="inline-block rounded-full" style={{ width: 8, height: 8, background: s.color }} />
            <span style={{ fontSize: 11.5, color: '#1F1B16' }}>
              <strong style={{ fontWeight: 600 }}>{s.value}</strong> {s.label}
              <span style={{ opacity: 0.5 }}> · {Math.round((s.value / total) * 100)}%</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

// Vacancy/over-budget balance chip.
const BalancePill = ({ v }) => {
  const neg = v < 0, zero = v === 0;
  return (
    <span className="inline-block ml-2" style={{
      fontSize: 10.5, fontWeight: 700, letterSpacing: '0.02em',
      padding: '1px 7px', borderRadius: 999,
      color: zero ? '#0F4C2A' : neg ? '#9A3412' : '#1D4ED8',
      background: zero ? '#ECFDF5' : neg ? '#FFF7ED' : '#EFF6FF',
    }}>{v > 0 ? `+${v}` : v}</span>
  );
};

import HrLandingCard from './HrLandingCard.jsx';
import QuickActionsCard from './QuickActionsCard.jsx';
import PendingSubstitutionsCard from './PendingSubstitutionsCard.jsx';
import MyApplicationsCard from './MyApplicationsCard.jsx';

export default function Dashboard({ me, employees, requests, typeMap, empMap, permissions, leaveTypes, onGoToRequests, onGoToReviews, onNewRequest, onOpenOrgChart, onUploadCert }) {
  // Personalised greeting — fully inline to eliminate any minifier scope issues.
  const _hr = new Date().getHours();
  const _period = _hr < 12 ? 'morning' : _hr < 17 ? 'afternoon' : 'evening';
  const _parts = String(me?.name || '').trim().split(/\s+/).filter(Boolean);
  const _skip = ['MOHAMMED','MOHAMMAD','MUHAMMAD','MOHD','ABDULLAH','ABDUL','ABDULRAHMAN','AHMED','AHMAD'];
  const _pickIdx = (_parts.length >= 2 && _skip.includes(_parts[0].toUpperCase())) ? 1 : 0;
  const _pick = _parts[_pickIdx] || '';
  const _display = _pick ? _pick.charAt(0).toUpperCase() + _pick.slice(1).toLowerCase() : '';
  const greeting = _display ? `Good ${_period}, ${_display}.` : `Good ${_period}.`;
  const today = todayISO();

  const onLeaveToday = useMemo(
    () => requests.filter(r => r.status === 'approved' && r.start_date <= today && r.end_date >= today),
    [requests, today]
  );

  // Pending decisions waiting on the viewing user. Combines leave requests,
  // permission requests, AND rejoining requests so the PENDING APPROVAL
  // tile + 'Pending requests' card reflect everything Bashaier (or any
  // reviewer) needs to act on. Each item is tagged with _kind so the
  // rendering in the 'Pending requests' card below can branch correctly.
  //
  // For HR (Bashaier): leaves at stage='pending_hr' + permissions at
  // stage='pending_hr' + rejoinings at return_stage='pending_hr'. For
  // admins: same — admins see the same final-tier queue plus per-stage
  // breakdowns elsewhere if needed.
  //
  // Rejoining is a sub-state of an approved leave row (return_stage
  // column). The parent leave is fully approved, so it has
  // status='approved' — the standard 'pending' filter would miss it.
  // We project a separate 'rejoin' item from any leave row whose
  // return_stage is awaiting HR action.
  const pending = useMemo(() => {
    const leaves = (requests || [])
      .filter(r => r.status === 'pending')
      .map(r => ({ ...r, _kind: 'leave' }));
    const perms = (permissions || [])
      .filter(p => p.status === 'pending')
      .map(p => ({ ...p, _kind: 'permission' }));
    const rejoins = (requests || [])
      .filter(r => r.return_stage === 'pending_hr')
      .map(r => ({ ...r, _kind: 'rejoin' }));
    return [...leaves, ...perms, ...rejoins].sort((a, b) => {
      const aTs = a._kind === 'rejoin'
        ? new Date(a.return_manager_decided_at || a.return_submitted_at || 0)
        : new Date(a.requested_at || a.created_at || 0);
      const bTs = b._kind === 'rejoin'
        ? new Date(b.return_manager_decided_at || b.return_submitted_at || 0)
        : new Date(b.requested_at || b.created_at || 0);
      return bTs - aTs;
    });
  }, [requests, permissions]);

  const upcoming = useMemo(() => {
    return requests
      .filter(r => r.status === 'approved' && r.start_date > today)
      .sort((a,b) => a.start_date.localeCompare(b.start_date))
      .slice(0, 8);
  }, [requests, today]);

  const approvedThisMonth = useMemo(() => {
    const now = new Date();
    return requests.filter(r => {
      if (r.status !== 'approved') return false;
      const d = new Date(r.start_date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
  }, [requests]);

  // Active employees only — excludes anyone marked 'inactive',
  // 'departed', or 'terminated' (the soft-delete states). Every count
  // and breakdown on this dashboard reads from this filtered list so
  // archived staff don't inflate "active staff" or skew the
  // dept/location/gender splits. Inactive staff stay viewable through
  // the Employees tab's "Show inactive" toggle. Nadeem 2026-05-17.
  const activeEmployees = useMemo(
    () => (employees || []).filter(isActiveEmployee),
    [employees]
  );

  const byLocation = useMemo(() => {
    const m = { DMM: 0, JED: 0, RYD: 0 };
    activeEmployees.forEach(e => { m[e.location] = (m[e.location] || 0) + 1; });
    return m;
  }, [activeEmployees]);

  const byDept = useMemo(() => {
    const m = {};
    activeEmployees.forEach(e => { m[e.department] = (m[e.department] || 0) + 1; });
    return Object.entries(m).sort((a,b) => b[1] - a[1]);
  }, [activeEmployees]);

  const byNationality = useMemo(() => {
    let saudi = 0, expat = 0;
    activeEmployees.forEach(e => {
      if (e.nationality === 'saudi') saudi++;
      else if (e.nationality === 'expat') expat++;
    });
    return { saudi, expat };
  }, [activeEmployees]);

  const byGender = useMemo(() => {
    const FEM_FIRST = new Set(['BASHAIER','BADRIA','SHAHAD','AMNA','AMINAH','NORA','NORAH','NOURA','LAYLA','SARA','SARAH','MARIA','JOAN','JOY','GRACE','AISHA','AMINA','FATIMA','KHADIJA','MARIAM','MARYAM','ZAINAB','HAYA','REEM','REEMA','RANA','DANA','LINA','NADA','WAFA','AYESHA','PRINCESS','JESSICA','JENNIFER','ANNA','HANNAH','LISA','EMMA','OLIVIA','SOPHIA','PRIYA','NEHA','SAFIA','SAFIYA']);
    let male = 0, female = 0;
    activeEmployees.forEach(e => {
      const g = (e.gender || '').toLowerCase();
      if (g === 'female' || g === 'f') female++;
      else if (g === 'male' || g === 'm') male++;
      else {
        const first = (e.name || '').split(/\s+/)[0].toUpperCase();
        if (FEM_FIRST.has(first)) female++;
        else male++;
      }
    });
    return { male, female };
  }, [activeEmployees]);

  // Per-department gender breakdown — used to render badges showing how many
  // men and women are in each department.
  const byDeptGender = useMemo(() => {
    const FEM_FIRST = new Set(['BASHAIER','BADRIA','SHAHAD','AMNA','AMINAH','NORA','NORAH','NOURA','LAYLA','SARA','SARAH','MARIA','JOAN','JOY','GRACE','AISHA','AMINA','FATIMA','KHADIJA','MARIAM','MARYAM','ZAINAB','HAYA','REEM','REEMA','RANA','DANA','LINA','NADA','WAFA','AYESHA','PRINCESS','JESSICA','JENNIFER','ANNA','HANNAH','LISA','EMMA','OLIVIA','SOPHIA','PRIYA','NEHA','SAFIA','SAFIYA']);
    const isFemale = (e) => {
      const g = (e.gender || '').toLowerCase();
      if (g === 'female' || g === 'f') return true;
      if (g === 'male' || g === 'm') return false;
      const first = (e.name || '').split(/\s+/)[0].toUpperCase();
      return FEM_FIRST.has(first);
    };
    const m = {};
    activeEmployees.forEach(e => {
      const dept = e.department || 'OTHER';
      if (!m[dept]) m[dept] = { male: 0, female: 0 };
      if (isFemale(e)) m[dept].female++;
      else m[dept].male++;
    });
    return m;
  }, [activeEmployees]);

  // Saudi vs Non-Saudi per department (Non-Saudi = anyone not flagged
  // 'saudi', so the columns always sum to the dept total). Powers the
  // copy-for-email headcount table. (Nadeem 2026-06-12)
  const byDeptNat = useMemo(() => {
    const m = {};
    activeEmployees.forEach(e => {
      const dept = e.department || 'OTHER';
      if (!m[dept]) m[dept] = { saudi: 0, nonSaudi: 0, total: 0 };
      if (e.nationality === 'saudi') m[dept].saudi++;
      else m[dept].nonSaudi++;
      m[dept].total++;
    });
    return m;
  }, [activeEmployees]);

  // Approved/budgeted headcount. Not stored anywhere, so it lives here —
  // update the number if the budget changes.
  const HEADCOUNT_BUDGET = 73;
  const [hcCopied, setHcCopied] = useState(false);

  // Nationality × gender cross-tab (overall). Lets the summary show how
  // many of the Saudi staff are male/female, and likewise for Non-Saudi —
  // clearer than parallel Saudi and Male columns. (Nadeem 2026-06-12)
  const natGender = useMemo(() => {
    const m = { saudiMale: 0, saudiFemale: 0, nonSaudiMale: 0, nonSaudiFemale: 0 };
    activeEmployees.forEach(e => {
      const saudi = e.nationality === 'saudi';
      const female = isFemaleEmployee(e);
      if (saudi) female ? m.saudiFemale++ : m.saudiMale++;
      else       female ? m.nonSaudiFemale++ : m.nonSaudiMale++;
    });
    return m;
  }, [activeEmployees]);

  // Copy the headcount tables as rich HTML (so they paste as real tables
  // into Outlook/Gmail) with a tab-separated plain-text fallback.
  const copyHeadcount = async () => {
    const total = activeEmployees.length || 0;
    const saudi = byNationality.saudi;
    const nonSaudi = total - saudi;
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    const depts = byDept.map(([d]) => d);

    const th = (t, al = 'left') => `<th style="background:#0F4C2A;color:#fff;padding:5px 10px;text-align:${al};font:600 13px Calibri,Arial,sans-serif;border:1px solid #0F4C2A">${t}</th>`;
    const cell = (t, al = 'left', bold = false, bg = '#FFFFFF') => `<td style="padding:4px 10px;text-align:${al};font:${bold ? '700' : '400'} 13px Calibri,Arial,sans-serif;border:1px solid #D1D5DB;color:#1F2937;background:${bg}">${t}</td>`;

    const deptRows = depts.map((d, i) => {
      const n = byDeptNat[d] || { saudi: 0, nonSaudi: 0, total: 0 };
      const g = byDeptGender[d] || { male: 0, female: 0 };
      const bg = i % 2 ? '#F3F4F6' : '#FFFFFF';
      return `<tr>${cell(d, 'left', true, bg)}${cell(n.saudi, 'right', false, bg)}${cell(n.nonSaudi, 'right', false, bg)}${cell(g.male, 'right', false, bg)}${cell(g.female, 'right', false, bg)}${cell(n.total, 'right', true, bg)}</tr>`;
    }).join('');
    const deptTable = `<table style="border-collapse:collapse;margin:0 0 14px"><thead><tr>${th('Department')}${th('Saudi', 'right')}${th('Non-Saudi', 'right')}${th('Male', 'right')}${th('Female', 'right')}${th('Total', 'right')}</tr></thead><tbody>${deptRows}<tr>${cell('TOTAL', 'left', true, '#ECFDF5')}${cell(saudi, 'right', true, '#ECFDF5')}${cell(nonSaudi, 'right', true, '#ECFDF5')}${cell(byGender.male, 'right', true, '#ECFDF5')}${cell(byGender.female, 'right', true, '#ECFDF5')}${cell(total, 'right', true, '#ECFDF5')}</tr></tbody></table>`;

    // Saudization × gender cross-tab + a budget/vacancy line.
    const g = natGender;
    const saudiT = g.saudiMale + g.saudiFemale;
    const nsT    = g.nonSaudiMale + g.nonSaudiFemale;
    const maleT  = g.saudiMale + g.nonSaudiMale;
    const femaleT = g.saudiFemale + g.nonSaudiFemale;
    const grand  = saudiT + nsT;
    const vacant = Math.max(0, HEADCOUNT_BUDGET - grand);
    const sumRow = (label, m, f, t, share, bg) =>
      `<tr>${cell(label, 'left', true, bg)}${cell(m, 'right', false, bg)}${cell(f, 'right', false, bg)}${cell(t, 'right', true, bg)}${cell(share, 'right', false, bg)}</tr>`;
    const sumTable = `<table style="border-collapse:collapse"><thead><tr>${th('Category')}${th('Male', 'right')}${th('Female', 'right')}${th('Total', 'right')}${th('Share', 'right')}</tr></thead><tbody>`
      + sumRow('Saudi',     g.saudiMale,    g.saudiFemale,    saudiT, pct(saudiT) + '%', '#FFFFFF')
      + sumRow('Non-Saudi', g.nonSaudiMale, g.nonSaudiFemale, nsT,    pct(nsT) + '%',    '#F3F4F6')
      + sumRow('Total',     maleT,          femaleT,          grand,  '100%',            '#ECFDF5')
      + `</tbody></table>`;
    const budgetLine = `<div style="margin-top:8px;font:600 12px Calibri,Arial,sans-serif;color:#1F2937">Budget ${HEADCOUNT_BUDGET} &middot; Filled ${grand} &middot; Vacant ${vacant}</div>`;

    const html = `<div style="font-family:Calibri,Arial,sans-serif">${deptTable}${sumTable}${budgetLine}</div>`;
    const plain = [
      'Headcount by department',
      'Department\tSaudi\tNon-Saudi\tMale\tFemale\tTotal',
      ...depts.map(d => { const n = byDeptNat[d] || {}; const gg = byDeptGender[d] || {}; return `${d}\t${n.saudi || 0}\t${n.nonSaudi || 0}\t${gg.male || 0}\t${gg.female || 0}\t${n.total || 0}`; }),
      `TOTAL\t${saudi}\t${nonSaudi}\t${byGender.male}\t${byGender.female}\t${total}`,
      '',
      'Category\tMale\tFemale\tTotal\tShare',
      `Saudi\t${g.saudiMale}\t${g.saudiFemale}\t${saudiT}\t${pct(saudiT)}%`,
      `Non-Saudi\t${g.nonSaudiMale}\t${g.nonSaudiFemale}\t${nsT}\t${pct(nsT)}%`,
      `Total\t${maleT}\t${femaleT}\t${grand}\t100%`,
      '',
      `Budget ${HEADCOUNT_BUDGET} · Filled ${grand} · Vacant ${vacant}`,
    ].join('\n');

    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([html],  { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]);
    } catch {
      try { await navigator.clipboard.writeText(plain); } catch { /* ignore */ }
    }
    setHcCopied(true);
    setTimeout(() => setHcCopied(false), 2000);
  };

  // HQ Personnel Statistic — budget vs current, per location/department.
  const [psCopied, setPsCopied] = useState(false);
  const personnel = useMemo(() => {
    const rows = HQ_PERSONNEL.map(r => ({ ...r, male: 0, female: 0, total: 0 }));
    const byKey = {}; rows.forEach(r => { byKey[r.key] = r; });
    activeEmployees.forEach(e => {
      const k = personnelCategory(e);
      const row = byKey[k];
      if (!row) return;
      if (isFemaleEmployee(e)) row.female++; else row.male++;
      row.total++;
    });
    rows.forEach(r => { r.balance = r.total - r.budget; });
    const gt = rows.reduce((a, r) => ({
      budget: a.budget + r.budget, male: a.male + r.male, female: a.female + r.female, total: a.total + r.total,
    }), { budget: 0, male: 0, female: 0, total: 0 });
    gt.balance = gt.total - gt.budget;
    return { rows, gt };
  }, [activeEmployees]);

  const copyPersonnel = async () => {
    const { rows, gt } = personnel;
    const statusDate = new Date().toISOString().slice(0, 10).replace(/-/g, '.');
    const th = (t, al = 'center', span) => `<th${span ? ` colspan="${span}"` : ''} style="background:#0F4C2A;color:#fff;padding:5px 9px;text-align:${al};font:600 12px Calibri,Arial,sans-serif;border:1px solid #0F4C2A">${t}</th>`;
    const cl = (t, al = 'center', bold = false, bg = '#FFFFFF') => `<td style="padding:4px 9px;text-align:${al};font:${bold ? '700' : '400'} 12px Calibri,Arial,sans-serif;border:1px solid #D1D5DB;color:#1F2937;background:${bg}">${t}</td>`;
    const body = rows.map((r, i) => {
      const bg = i % 2 ? '#F3F4F6' : '#FFFFFF';
      const balColor = r.balance < 0 ? 'color:#B91C1C;' : 'color:#1F2937;';
      return `<tr>${cl(r.label, 'left', true, bg)}${cl(r.budget, 'center', false, bg)}${cl(r.male, 'center', false, bg)}${cl(r.female, 'center', false, bg)}${cl(r.total, 'center', true, bg)}<td style="padding:4px 9px;text-align:center;font:700 12px Calibri,Arial,sans-serif;border:1px solid #D1D5DB;background:${bg};${balColor}">${r.balance}</td>${cl('', 'left', false, bg)}</tr>`;
    }).join('');
    const gtBal = gt.balance < 0 ? 'color:#B91C1C;' : 'color:#1F2937;';
    const html = `<div style="font-family:Calibri,Arial,sans-serif">`
      + `<div style="font:700 14px Calibri,Arial,sans-serif;color:#0F4C2A">THE PERSONNEL STATISTIC OF ESAU</div>`
      + `<div style="font:600 12px Calibri,Arial,sans-serif;color:#1F2937;margin:2px 0 6px">STATUS: ${statusDate}</div>`
      + `<table style="border-collapse:collapse">`
      + `<thead><tr>${th('DEPT.', 'left')}${th('BUDGET')}${th('CURRENT PERSONNEL', 'center', 3)}${th('BALANCE')}${th('REMARKS')}</tr>`
      + `<tr>${th('')}${th('')}${th('MALE')}${th('FEMALE')}${th('TOTAL')}${th('')}${th('')}</tr></thead>`
      + `<tbody>${body}`
      + `<tr>${cl('GRAND TOTAL', 'left', true, '#ECFDF5')}${cl(gt.budget, 'center', true, '#ECFDF5')}${cl(gt.male, 'center', true, '#ECFDF5')}${cl(gt.female, 'center', true, '#ECFDF5')}${cl(gt.total, 'center', true, '#ECFDF5')}<td style="padding:4px 9px;text-align:center;font:700 12px Calibri,Arial,sans-serif;border:1px solid #D1D5DB;background:#ECFDF5;${gtBal}">${gt.balance}</td>${cl('', 'left', true, '#ECFDF5')}</tr>`
      + `</tbody></table></div>`;
    const plain = [
      'THE PERSONNEL STATISTIC OF ESAU',
      `STATUS: ${statusDate}`,
      'DEPT.\tBUDGET\tMALE\tFEMALE\tTOTAL\tBALANCE\tREMARKS',
      ...rows.map(r => `${r.label}\t${r.budget}\t${r.male}\t${r.female}\t${r.total}\t${r.balance}\t`),
      `GRAND TOTAL\t${gt.budget}\t${gt.male}\t${gt.female}\t${gt.total}\t${gt.balance}\t`,
    ].join('\n');
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html':  new Blob([html],  { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]);
    } catch {
      try { await navigator.clipboard.writeText(plain); } catch { /* ignore */ }
    }
    setPsCopied(true);
    setTimeout(() => setPsCopied(false), 2000);
  };
  // greeting + monthly task reminder modal with the 🧚 fairy emoji).
  // These are scoped to Bashaier (H94830) specifically, NOT all HR
  // reviewers. Other HR reviewers (Badria once she has access) see
  // the neutral generic hero — they don't get the personalised
  // affirmation messages or the fairy task nudges.
  // For the broader "HR reviewer privileges" behaviours (e.g. seeing
  // your own applications card), use me?.is_hr_reviewer directly.
  const bashaierMode = me?.id === 'H94830';

  // PIN requests modal — badge in the stat row opens this; always-mounted
  // card fetches its own data so the count stays live.
  const [pinModalOpen, setPinModalOpen] = useState(false);
  const [pinReqCount,  setPinReqCount]  = useState(0);
  // Freshness tracker — "Live · updated 2m ago"-style badge at the
  // top of the dashboard. AppShell already subscribes to leave_requests,
  // employees, and leave_types via supabase realtime channels, so the
  // data flowing in via props is auto-refreshing. We just need to
  // surface that fact to the user. The timestamp resets to "now" any
  // time the props array reference changes (i.e. AppShell re-fetched).
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    setLastUpdated(Date.now());
  }, [requests, employees, permissions]);
  useEffect(() => {
    // Tick once a minute so the relative-time label updates even
    // when no realtime event has arrived. 60s is fine — we don't
    // need second-level precision for "5m ago".
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const updatedRel = useMemo(() => {
    const diffSec = Math.max(0, Math.floor((nowTick - lastUpdated) / 1000));
    if (diffSec < 10)  return 'just now';
    if (diffSec < 60)  return `${diffSec}s ago`;
    const min = Math.floor(diffSec / 60);
    if (min < 60)      return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24)       return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
  }, [nowTick, lastUpdated]);
  const canSeePinReqs = !!(me?.is_admin || me?.is_hr_reviewer);

  // Report-reminder modal (the 🧚 popup) has been retired. Bashaier
  // asked to remove it from login flow and surface the monthly reports
  // as a calm persistent card on the Reviews tab instead. See
  // src/components/MonthlyReportsCard.jsx for the new home. The
  // localStorage keys are preserved so any task marked sent under the
  // old flow stays marked sent under the new one. Nadeem 2026-05-17.

  // Rotating bilingual hero message — picks a random one on every login. Each
  // entry is { lang, text }; the JSX below handles RTL direction + signature.
  const heroMessage = useMemo(() => {
    // Warm, self-affirming messages chosen to support self-confidence and
    // counter inner self-criticism. Each one is short enough to fit on one
    // line alongside the trailing fairy emoji. A random pick runs once per
    // page load (one per login).
    const messages = [
      // English — focused on inherent worth, gentleness, validation
      { lang: 'en', text: 'You are enough, exactly as you are right now' },
      { lang: 'en', text: 'Your sensitivity is a strength, not a flaw' },
      { lang: 'en', text: 'You don\'t have to be perfect to be valued' },
      { lang: 'en', text: 'Be gentle with yourself today — you deserve it' },
      { lang: 'en', text: 'Your worth isn\'t measured by what you achieve' },
      { lang: 'en', text: 'You belong here, just as you are' },
      { lang: 'en', text: 'Every feeling you have is valid' },
      { lang: 'en', text: 'You are stronger than you think you are' },
      { lang: 'en', text: 'Your light is real, even on the dim days' },
      { lang: 'en', text: 'You don\'t need to earn your place — it is already yours' },
      { lang: 'en', text: 'The world is softer because you are in it' },
      { lang: 'en', text: 'You are doing better than you give yourself credit for' },
      { lang: 'en', text: 'Your kindness leaves a mark wherever you go' },
      { lang: 'en', text: 'Today, choose softness over self-criticism' },
      { lang: 'en', text: 'You are loved, even on the days you doubt it' },
      { lang: 'en', text: 'Rest is not weakness — it is wisdom' },
      { lang: 'en', text: 'You are allowed to take up space and be heard' },
      // Arabic — same warm, anchoring tone in the user\'s language
      { lang: 'ar', text: 'أنتِ كافية، تماماً كما أنتِ' },
      { lang: 'ar', text: 'حساسيتك قوة، وليست ضعفاً' },
      { lang: 'ar', text: 'كوني لطيفة مع نفسك، أنتِ تستحقين ذلك' },
      { lang: 'ar', text: 'قيمتك لا تقاس بإنجازاتك' },
      { lang: 'ar', text: 'أنتِ تنتمين هنا، تماماً كما أنتِ' },
      { lang: 'ar', text: 'كل مشاعرك صحيحة ومستحقة' },
      { lang: 'ar', text: 'أنتِ أقوى مما تظنين' },
      { lang: 'ar', text: 'نورك حقيقي حتى في الأيام الباهتة' },
      { lang: 'ar', text: 'أنتِ تقومين بعمل أفضل مما تدركين' },
      { lang: 'ar', text: 'العالم أجمل لأنكِ فيه' },
      { lang: 'ar', text: 'اختاري اللطف مع نفسك اليوم' },
      { lang: 'ar', text: 'أنتِ محبوبة، حتى في الأيام التي تشككين فيها' },
    ];
    return messages[Math.floor(Math.random() * messages.length)];
  }, []);


  return (
    <div className="space-y-8">
      {/* Substitution requests — Bashaier or Nadeem might be picked as a
          substitute by another staff member. The card hides itself when
          there's nothing to act on, so it's safe to mount here even
          though most days it'll render nothing. */}
      <PendingSubstitutionsCard me={me} empMap={empMap} />

      {/* Hover-lift styles for badges across the dashboard. Inline boxShadow on
          each badge is overridden on :hover with !important so the lift looks
          consistent. Added gentle transition + tiny scale on the colored rail. */}
      <style>{`
        .esau-badge { transition: transform 220ms cubic-bezier(0.4, 0, 0.2, 1), box-shadow 220ms ease, border-color 220ms ease; }
        .esau-badge:hover { transform: translateY(-3px); box-shadow: 0 6px 16px rgba(31,27,22,0.08), 0 20px 38px rgba(31,27,22,0.14) !important; border-color: #D4D4D4 !important; }
        .esau-badge:active { transform: translateY(-1px); box-shadow: 0 2px 6px rgba(31,27,22,0.06), 0 8px 18px rgba(31,27,22,0.10) !important; }
        /* Live indicator — tiny pulsing green dot to signal the dashboard
           is wired to realtime updates. */
        @keyframes esau-live-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.5); }
          70%      { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0); }
        }
        .esau-live-dot {
          width: 7px; height: 7px; border-radius: 50%;
          background: #10B981;
          animation: esau-live-pulse 1.6s ease-in-out infinite;
        }
        /* Pending-approval pulse — soft red ring around the count badge
           on the PENDING APPROVAL tile when count > 0, drawing the eye
           to action items. */
        @keyframes esau-pending-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(220, 38, 38, 0.35); }
          70%      { box-shadow: 0 0 0 8px rgba(220, 38, 38, 0); }
        }
        .esau-pending-pulse { animation: esau-pending-pulse 1.8s ease-in-out infinite; }
      `}</style>

      {/* Live header bar — sits above the hero. Shows today's date on
          the left and a live-data freshness indicator on the right.
          The pulsing green dot signals that the dashboard is wired
          to Supabase realtime, so admin knows the numbers are
          current without having to manually refresh. The relative
          time auto-updates every minute. */}
      <div className="flex items-center justify-between gap-3 flex-wrap pb-1"
           style={{ fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif' }}>
        <div className="text-[10px]" style={{ color: '#9D6B53', letterSpacing: '0.3em', fontWeight: 600 }}>
          {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()}
        </div>
        <div className="inline-flex items-center gap-2">
          {/* Org chart trigger — admin (Nadeem) and HR reviewer
              (Bashaier) only. Opens the OrgChartView modal that
              renders the live tree from employees.manager_id and
              offers Summary/Full toggle plus standalone HTML export. */}
          {onOpenOrgChart && (me?.is_admin || me?.is_hr_reviewer) && (
            <button
              onClick={onOpenOrgChart}
              title="Generate the company organization chart"
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full"
              style={{
                background: '#FFFFFF',
                border: '1px solid #C49B61',
                fontSize: 10,
                letterSpacing: '0.16em',
                color: '#8B5A1F',
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              <span aria-hidden="true">🏢</span>
              <span>ORG CHART</span>
            </button>
          )}
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full"
               title={`Last refreshed at ${new Date(lastUpdated).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}
               style={{
                 background: '#ECFDF5',
                 border: '1px solid #A7F3D0',
                 fontSize: '10px',
                 letterSpacing: '0.16em',
                 color: '#0F4C2A',
                 fontWeight: 700,
               }}>
            <span className="esau-live-dot" aria-hidden="true"/>
            <span>LIVE</span>
            <span style={{ opacity: 0.5 }}>·</span>
            <span style={{ letterSpacing: '0.04em', fontWeight: 600 }}>updated {updatedRel}</span>
          </div>
        </div>
      </div>

      {/* Hero — Editorial Minimal (Option 1): cream background, serif typography, italic quote.
          Bashaier sees her name + heroMessage as the italic quote; everyone else sees the
          plain greeting. No tiles, no gradients. */}
      {bashaierMode ? (
        <div className="pb-8" style={{ borderBottom: '1px solid #E5E5E5' }}>
          <h1 className="leading-[1] mb-4" style={{ fontFamily: 'inherit', fontSize: 'clamp(2.2rem, 5vw, 3.5rem)', color: '#1F1B16', fontWeight: 400, letterSpacing: '-0.02em' }}>
            Good {_period}, Bashaier.
          </h1>
          <p className="mb-3" style={{
              fontFamily: heroMessage.lang === 'ar' ? '"Segoe UI", "Tahoma", Georgia, serif' : 'inherit',
              fontStyle: 'italic',
              color: '#1F1B16',
              fontSize: '1.15rem',
              maxWidth: '40rem',
              lineHeight: 1.5,
              direction: heroMessage.lang === 'ar' ? 'rtl' : 'ltr',
              textAlign:  heroMessage.lang === 'ar' ? 'right' : 'left',
            }}>
            "{heroMessage.text}" 🧚
          </p>
          <p className="text-sm" style={{ color: '#1F1B16', margin: 0 }}>
            {pending.length > 0
              ? <>You have <span style={{ fontWeight: 600, color: '#1F1B16' }}>{pending.length} pending {pending.length === 1 ? 'request' : 'requests'}</span> waiting on your decision, and <span style={{ fontWeight: 600, color: '#1F1B16' }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
              : <>Your queue is clear. <span style={{ fontWeight: 600, color: '#1F1B16' }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
            }
          </p>
        </div>
      ) : (
      <div className="pb-8" style={{ borderBottom: '1px solid #E5E5E5' }}>
        <h1 className="leading-[1]" style={{ fontFamily: 'inherit', fontSize: 'clamp(2.5rem, 5vw, 3.8rem)', color: '#1F1B16', fontWeight: 400, letterSpacing: '-0.02em' }}>
          {greeting}
        </h1>
        <p className="text-base mt-4 max-w-xl" style={{ color: '#1F1B16' }}>
          {pending.length > 0
            ? <>You have <span style={{ color: '#C97A4F', fontWeight: 600 }}>{pending.length} pending {pending.length === 1 ? 'request' : 'requests'}</span> waiting on your decision, and <span style={{ fontWeight: 600, color: '#1F1B16' }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
            : <>Your queue is clear. <span style={{ fontWeight: 600, color: '#1F1B16' }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
          }
        </p>
      </div>
      )}

      {/* QUICK ACTIONS removed per Nadeem 2026-06-12 — the shortcuts
          (apply leave, review queue, print form, sick cert, org chart)
          duplicated entry points already reachable from the nav and the
          consolidated HrLandingCard hub below. */}

      {/* HR daily-digest card — Bashaier's editorial 'This Week' +
          'Needs Your Attention' surface. Consolidates the human
          moments (anniversaries, returns, public holidays) with the
          action queue (decisions, sick certs, evaluation flags) so
          her morning briefing is one card instead of four scattered
          surfaces. Only shown to Bashaier (warmer copy, italic
          captions) — admin Nadeem sees the existing minimal strip
          below. Nadeem 2026-05-17. */}
      {bashaierMode && (
        <HrLandingCard
          me={me}
          employees={employees}
          requests={requests}
          permissions={permissions}
          leaveTypes={leaveTypes}
          onGoToReviews={onGoToReviews || onGoToRequests}
          onGoToAttendance={() => { /* parent doesn't wire this yet; safe no-op until they do */ }}
        />
      )}

      {/* MINIMAL stat surface — replaces the four-tile strip Bashaier
          had before. Only PENDING APPROVAL keeps a tile (it's the one
          actionable count and it pulses when items wait on her). The
          other three counts collapse into a single muted strip below.
          PIN REQUESTS stays as a small chip on the right when relevant.
          Nadeem 2026-05-17: 'make it minimal'. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 items-stretch"
           style={{ fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif' }}>
        {/* PENDING — primary action tile (pulses when count > 0) */}
        <Tile label="PENDING APPROVAL" sublabel="Awaiting your decision" count={pending.length}
              pulse={pending.length > 0}
              accentDark="#C2410C" accentTint="#FFFBEB" onClick={onGoToReviews || onGoToRequests}>
          <div className="text-[20px]">⏳</div>
        </Tile>

        {/* AT-A-GLANCE — the three secondary counts in one compact card */}
        <div className="sm:col-span-2 rounded-xl border p-5 esau-card"
             style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
          <div className="flex items-center gap-2 mb-3">
            <div className="w-1.5 h-1.5 rounded-full" style={{ background: '#1F1B16' }}/>
            <span className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.18em', fontWeight: 700 }}>
              AT A GLANCE
            </span>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="serif text-2xl leading-none" style={{ color: '#1F1B16', fontWeight: 500 }}>{activeEmployees.length}</div>
              <div className="text-[11px] mt-1" style={{ color: '#1F1B16' }}>active staff</div>
              <div className="text-[10px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.6 }}>
                {byLocation.DMM || 0} DMM · {byLocation.JED || 0} JED · {byLocation.RYD || 0} RYD
              </div>
            </div>
            <div>
              <div className="serif text-2xl leading-none" style={{ color: onLeaveToday.length > 0 ? '#0E7490' : '#1F1B16', fontWeight: 500 }}>
                {onLeaveToday.length}
              </div>
              <div className="text-[11px] mt-1" style={{ color: '#1F1B16' }}>on leave today</div>
              <div className="text-[10px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.6 }}>
                {onLeaveToday.length === 0 ? 'full house' : `out of ${activeEmployees.length}`}
              </div>
            </div>
            <div>
              <div className="serif text-2xl leading-none" style={{ color: '#1F1B16', fontWeight: 500 }}>{approvedThisMonth}</div>
              <div className="text-[11px] mt-1" style={{ color: '#1F1B16' }}>approved this month</div>
              <div className="text-[10px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.6 }}>
                {new Date().toLocaleDateString('en-GB', { month: 'long' })}
              </div>
            </div>
          </div>
          {canSeePinReqs && pinReqCount > 0 && (
            <button onClick={() => setPinModalOpen(true)}
              className="mt-3 inline-flex items-center gap-2 text-[10px] px-3 py-1.5 rounded-full"
              style={{ background: '#F1F5F9', color: '#334155', fontWeight: 700, letterSpacing: '0.06em' }}>
              🔑 {pinReqCount} PIN REQUEST{pinReqCount === 1 ? '' : 'S'} · CLICK TO REVIEW
            </button>
          )}
          {/* Always mount PinRequestsCard so the realtime subscription
              keeps the count current — kept in a hidden tree (display:none)
              while the modal is closed. Same pattern as before. */}
        </div>
      </div>

      {/* Headcount — collapsed by default to keep the landing minimal.
          The summary line in the header carries the most useful info at
          a glance (active count, Saudi/expat split, gender). Bashaier
          opens the dept-by-dept breakdown only when she actually needs
          it. Nadeem 2026-05-17: 'make it minimal, more organized'. */}
      <details className="pt-7 group" style={{ borderTop: '1px solid #E5E5E5' }}>
        <summary className="flex items-baseline justify-between flex-wrap gap-3 mb-5 cursor-pointer list-none"
                 style={{ userSelect: 'none' }}>
          <div className="flex items-baseline gap-3">
            <div>
              <div className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.3em', fontWeight: 700 }}>PEOPLE AT ESAU</div>
              <h2 style={{ fontFamily: 'inherit', fontSize: '26px', color: '#1F1B16', marginTop: '4px', fontWeight: 400 }}>
                Headcount by department
                <span className="ml-3 text-[14px]" style={{ color: '#1F1B16', opacity: 0.5, fontWeight: 400 }}>
                  <span className="group-open:hidden">▸ click to open</span>
                  <span className="hidden group-open:inline">▾ click to close</span>
                </span>
              </h2>
            </div>
          </div>
          <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.7, fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif' }}>
            {activeEmployees.length} active · {byNationality.saudi} Saudi · {activeEmployees.length - byNationality.saudi} Non-Saudi · {byGender.male} men · {byGender.female} women
          </div>
        </summary>

      <div className="space-y-7 pt-1" style={{ fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif' }}>

        {/* Metric cards */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          <HcStat label="Active"      value={activeEmployees.length} accent="#1F1B16" />
          <HcStat label="Saudi"       value={byNationality.saudi} accent="#0F4C2A" />
          <HcStat label="Non-Saudi"   value={activeEmployees.length - byNationality.saudi} accent="#475569" />
          <HcStat label="Men"         value={byGender.male} accent="#1D4ED8" />
          <HcStat label="Women"       value={byGender.female} accent="#BE3A6B" />
          <HcStat label="Saudization" value={`${activeEmployees.length ? Math.round((byNationality.saudi / activeEmployees.length) * 100) : 0}%`} accent="#0F4C2A" />
        </div>

        {/* Split bars */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <SplitBar title="Nationality" segs={[
            { label: 'Saudi',     value: byNationality.saudi, color: '#0F4C2A' },
            { label: 'Non-Saudi', value: activeEmployees.length - byNationality.saudi, color: '#9AA3A0' },
          ]} />
          <SplitBar title="Gender" segs={[
            { label: 'Men',   value: byGender.male, color: '#1D4ED8' },
            { label: 'Women', value: byGender.female, color: '#BE3A6B' },
          ]} />
        </div>

        {/* By department — proportion bars (green = Saudi share, length = headcount) */}
        <section>
          <div className="flex items-center justify-between mb-3">
            <div className="text-[10px] uppercase font-bold" style={{ color: '#1F1B16', letterSpacing: '0.22em' }}>By department</div>
            <button type="button" onClick={copyHeadcount}
              className="inline-flex items-center gap-1.5 text-[11px]"
              style={{ color: hcCopied ? '#0F4C2A' : '#1F1B16', opacity: hcCopied ? 1 : 0.65, fontWeight: 600, cursor: 'pointer' }}>
              {hcCopied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
            </button>
          </div>
          <div className="space-y-2.5">
            {(() => {
              const maxDept = Math.max(1, ...byDept.map(([, c]) => c));
              return byDept.map(([dept, count]) => {
                const n = byDeptNat[dept] || { saudi: 0, nonSaudi: 0, total: 0 };
                const g = byDeptGender[dept] || { male: 0, female: 0 };
                const trackW = (count / maxDept) * 100;
                const saudiShare = count ? (n.saudi / count) * 100 : 0;
                return (
                  <div key={dept} className="flex items-center gap-3 group/row">
                    <div className="flex items-center gap-2 flex-shrink-0" style={{ width: 70 }}>
                      <span className="inline-block rounded-full" style={{ width: 7, height: 7, background: DEPT_DOT[dept] || '#475569' }} />
                      <span style={{ fontSize: 13, fontWeight: 600, color: '#1F1B16' }}>{dept}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="overflow-hidden transition-all group-hover/row:opacity-90"
                           style={{ height: 12, borderRadius: 999, background: '#EAE8E0', width: `${trackW}%`, minWidth: 30 }}>
                        <div style={{ height: '100%', width: `${saudiShare}%`, background: '#0F4C2A' }} />
                      </div>
                    </div>
                    <div className="flex-shrink-0 text-right" style={{ width: 150, fontSize: 12, color: '#1F1B16' }}>
                      <strong style={{ fontWeight: 700 }}>{count}</strong>
                      <span style={{ opacity: 0.55 }}> · {n.saudi} SA · {g.male}M / {g.female}W</span>
                    </div>
                  </div>
                );
              });
            })()}
          </div>
          <div className="flex flex-wrap items-center gap-4 mt-3">
            <div className="flex items-center gap-1.5"><span className="inline-block rounded-full" style={{ width: 8, height: 8, background: '#0F4C2A' }} /><span style={{ fontSize: 11, color: '#1F1B16', opacity: 0.6 }}>Saudi share</span></div>
            <div className="flex items-center gap-1.5"><span className="inline-block rounded-full" style={{ width: 8, height: 8, background: '#EAE8E0' }} /><span style={{ fontSize: 11, color: '#1F1B16', opacity: 0.6 }}>Non-Saudi · bar length = headcount</span></div>
          </div>
        </section>

        {/* Personnel Statistic — budget fill + balance pill */}
        <section>
          <div className="flex items-center justify-between mb-1">
            <div className="text-[10px] uppercase font-bold" style={{ color: '#1F1B16', letterSpacing: '0.22em' }}>Personnel Statistic &middot; HQ Budget</div>
            <button type="button" onClick={copyPersonnel}
              className="inline-flex items-center gap-1.5 text-[11px]"
              style={{ color: psCopied ? '#0F4C2A' : '#1F1B16', opacity: psCopied ? 1 : 0.65, fontWeight: 600, cursor: 'pointer' }}>
              {psCopied ? <><Check className="w-3.5 h-3.5" /> Copied</> : <><Copy className="w-3.5 h-3.5" /> Copy</>}
            </button>
          </div>
          <div className="text-[11px] mb-3" style={{ color: '#1F1B16', opacity: 0.5 }}>
            Status {new Date().toISOString().slice(0, 10).replace(/-/g, '.')} &middot; bar = filled vs budget &middot; balance = current &minus; budget
          </div>
          <div className="space-y-2.5">
            {personnel.rows.map(r => {
              const fill = r.budget ? Math.min(100, (r.total / r.budget) * 100) : 0;
              const under = r.balance < 0;
              return (
                <div key={r.key} className="flex items-center gap-3">
                  <div className="flex-shrink-0" style={{ width: 92, fontSize: 13, fontWeight: 600, color: '#1F1B16' }}>{r.label}</div>
                  <div className="flex-1 min-w-0">
                    <div className="overflow-hidden" style={{ height: 12, borderRadius: 999, background: '#EAE8E0' }}>
                      <div style={{ height: '100%', width: `${fill}%`, background: under ? '#D97706' : '#0F4C2A' }} />
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right" style={{ width: 170, fontSize: 12, color: '#1F1B16' }}>
                    <span style={{ opacity: 0.55 }}>{r.male}M/{r.female}W · </span>
                    <strong style={{ fontWeight: 700 }}>{r.total}</strong>
                    <span style={{ opacity: 0.5 }}>/{r.budget}</span>
                    <BalancePill v={r.balance} />
                  </div>
                </div>
              );
            })}
            <div className="flex items-center gap-3 pt-2" style={{ borderTop: '1px solid #E5E5E5' }}>
              <div className="flex-shrink-0" style={{ width: 92, fontSize: 13, fontWeight: 700, color: '#1F1B16' }}>Grand total</div>
              <div className="flex-1" />
              <div className="flex-shrink-0 text-right" style={{ width: 170, fontSize: 12, color: '#1F1B16' }}>
                <span style={{ opacity: 0.55 }}>{personnel.gt.male}M/{personnel.gt.female}W · </span>
                <strong style={{ fontWeight: 700 }}>{personnel.gt.total}</strong>
                <span style={{ opacity: 0.5 }}>/{personnel.gt.budget}</span>
                <BalancePill v={personnel.gt.balance} />
              </div>
            </div>
          </div>
        </section>
      </div>
      </details>

      {/* Three column summary — for Bashaier this is folded into the
          consolidated HrLandingCard hub above (Out today / Pending /
          Upcoming all live there once), so it only renders for admin. */}
      {!bashaierMode && (
      <div className="grid lg:grid-cols-3 gap-5">
        <Card title="Out of office today" subtitle={`${onLeaveToday.length} ${onLeaveToday.length === 1 ? 'person' : 'people'}`}>
          {onLeaveToday.length === 0 ? (
            <Empty icon={Palmtree} message="Full house — nobody on leave today."/>
          ) : (
            <ul className="space-y-3">
              {onLeaveToday.map(r => {
                const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                if (!emp) return null;
                return (
                  <li key={r.id} className="flex items-center gap-3">
                    <Avatar id={emp.id} name={emp.name}/>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                      <div className="text-xs opacity-60">{emp.department} · {emp.location}</div>
                    </div>
                    <div className="text-right">
                      <Pill color={tp?.color}>{tp?.name || r.leave_type_id}</Pill>
                      <div className="text-xs opacity-60 mt-1">until {fmtDateShort(r.end_date)}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Pending requests" subtitle={pending.length > 0 ? 'Needs action' : 'Queue is empty'} accent="var(--clay)">
          {pending.length === 0 ? (
            <Empty icon={Check} message="Nothing to approve — nice."/>
          ) : (
            <ul className="space-y-3">
              {pending.slice(0, 5).map(r => {
                const emp = empMap[r.employee_id];
                if (!emp) return null;
                // Per-kind row shape — leaves and rejoinings both come
                // from leave_requests, but the rejoining is the return
                // event so its meaningful date is actual_return_date,
                // not start_date. Permissions render their own date too.
                if (r._kind === 'rejoin') {
                  return (
                    <li key={`rejoin-${r.id}`} className="flex items-center gap-3">
                      <Avatar id={emp.id} name={emp.name}/>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                        <div className="text-xs opacity-60">Rejoining · returned {fmtDateShort(r.actual_return_date)}</div>
                      </div>
                      <div className="text-[10px] px-1.5 py-0.5 rounded-full font-bold tracking-wider"
                           style={{ background: '#ECFDF5', color: '#0F4C2A' }}>
                        REJOIN
                      </div>
                    </li>
                  );
                }
                if (r._kind === 'permission') {
                  return (
                    <li key={`perm-${r.id}`} className="flex items-center gap-3">
                      <Avatar id={emp.id} name={emp.name}/>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                        <div className="text-xs opacity-60">
                          {r.type === 'late_arrival' ? 'Late arrival' : 'Early leave'} · {Number(r.hours)}h
                        </div>
                      </div>
                      <div className="text-xs opacity-60">{fmtDateShort(r.permission_date)}</div>
                    </li>
                  );
                }
                const tp = typeMap[r.leave_type_id];
                return (
                  <li key={`leave-${r.id}`} className="flex items-center gap-3">
                    <Avatar id={emp.id} name={emp.name}/>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                      <div className="text-xs opacity-60">{tp?.name} · {r.days} {Number(r.days) === 1 ? 'day' : 'days'}</div>
                    </div>
                    <div className="text-xs opacity-60">{fmtDateShort(r.start_date)}</div>
                  </li>
                );
              })}
              {pending.length > 5 && (
                <li>
                  <button onClick={onGoToReviews || onGoToRequests} className="text-xs flex items-center gap-1 opacity-70 hover:opacity-100">
                    See {pending.length - 5} more <ArrowRight className="w-3 h-3"/>
                  </button>
                </li>
              )}
            </ul>
          )}
        </Card>

        <Card title="Upcoming leaves" subtitle="Next 8 approved">
          {upcoming.length === 0 ? (
            <Empty icon={Calendar} message="Nothing on the calendar yet."/>
          ) : (
            <ul className="space-y-3">
              {upcoming.map(r => {
                const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                if (!emp) return null;
                return (
                  <li key={r.id} className="flex items-center gap-3">
                    <div className="w-10 text-center flex-shrink-0">
                      <div className="serif text-lg leading-none" style={{ fontWeight: 500 }}>
                        {new Date(r.start_date).getDate()}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider opacity-50 mt-0.5">
                        {new Date(r.start_date).toLocaleDateString('en-GB', { month: 'short' })}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                      <div className="text-xs opacity-60">{tp?.name} · {r.days}d</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
      )}

      {/* Pending shift approvals — Bashaier-only Card. Self-hides when the
          queue is empty so it never shows a stale 0-state. Sits between the
          leave/permission cards above and the monthly-report tasks below
          because conceptually it's a third "things to approve" surface,
          parallel to leave approvals — not a sibling of report drafting. */}
      {/* PendingShiftApprovalsCard removed: per Nadeem, shift
          acknowledgment is now between the manager and the staff
          member directly. Once staff accepts, the shift is final and
          locked — no SUP/HR approval step. The component file is
          left in the tree for now in case of audit needs but is no
          longer mounted. The HrShiftMonthCard below is the new
          HR-side view for monitoring shifts (read-only, no approvals). */}

      {/* Personal applications card — shown to anyone viewing this
          dashboard (admin Nadeem, HR reviewer Bashaier). Both submit
          their own leaves/permissions just like regular staff and
          need to see their own application status here. Per Nadeem:
          "I also need to see the status of my own application, it's
          not appearing in my dashboard." MyApplicationsCard auto-
          hides itself when the viewer has no applications, so it
          doesn't clutter Nadeem's screen when he's empty-handed. */}
      {(me?.is_hr_reviewer || me?.is_admin) && (
        <MyApplicationsCard
          me={me}
          requests={requests}
          permissions={permissions}
          empMap={empMap}
          leaveTypes={leaveTypes}
          onUploadCert={onUploadCert}
        />
      )}

      {/* HR/SUP full-fleet shift overview — month grid, grouped by
          location, every employee with a shift this month. Hidden for
          regular managers (they get TeamShiftMonthCard on the Shifts
          tab). Auto-hides if there are no shifts in the visible month.
          The shift EDITOR (ManagerShiftCard) is intentionally NOT
          mounted here — per Nadeem, dispatching shifts is a manager
          function. Bashaier and admin see the read-only month grid
          for monitoring; managers go to the Shifts tab to assign. */}
      {(me?.is_admin || me?.is_hr_reviewer) && (
        <HrShiftMonthCard me={me} employees={employees} />
      )}

      {/* PIN Requests — moved to modal triggered by the PIN REQUESTS badge.
           Card is always mounted (display:none on the modal wrapper hides it
           visually but keeps React's tree intact, so the realtime channel
           subscription runs and the badge count stays live). */}
      {canSeePinReqs && (
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setPinModalOpen(false); }}
          style={{
            display: pinModalOpen ? 'flex' : 'none',
            position: 'fixed', inset: 0, zIndex: 90,
            background: 'rgba(15, 23, 42, 0.55)',
            backdropFilter: 'blur(2px)',
            alignItems: 'flex-start', justifyContent: 'center',
            padding: '40px 16px', overflowY: 'auto',
          }}>
          <div style={{ width: '100%', maxWidth: '720px', position: 'relative' }}>
            <button onClick={() => setPinModalOpen(false)}
                    aria-label="Close"
                    style={{
                      position: 'absolute', top: '-44px', right: 0,
                      background: 'rgba(255,255,255,0.95)', border: 'none',
                      borderRadius: '50%', width: '36px', height: '36px',
                      fontSize: '18px', cursor: 'pointer', color: '#1F1B16',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                    }}>✕</button>
            <PinRequestsCard me={me} employees={employees} onCountChange={setPinReqCount} />
          </div>
        </div>
      )}
      {/* Report-reminder popup REMOVED. The three Mr-John monthly tasks
          now live as a persistent card on the Reviews tab — see
          MonthlyReportsCard.jsx. Nadeem 2026-05-17: 'remove the
          reminder on login, just put it in review tab'. */}

      {/* (Headcount block has moved up — see new colored block right after Stat cards.) */}
    </div>
  );
}

/* ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ small UI primitives shared across pages ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ */
export function Card({ title, subtitle, children, accent }) {
  return (
    <div
      className="rounded-xl border p-5 esau-card"
      style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}
    >
      {(title || subtitle) && (
        <div className="flex items-baseline justify-between mb-4 pb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2">
            {accent && <div className="w-1.5 h-1.5 rounded-full" style={{ background: accent }}/>}
            <h3 className="serif text-lg" style={{ fontWeight: 500 }}>{title}</h3>
          </div>
          {subtitle && <div className="text-xs opacity-60">{subtitle}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

// KPI Tile — small canonical-chrome card with a colored count pill on the
// right and an optional accent dot in the header. Used for the strip of stat
// tiles at the top of the admin dashboard (TOTAL STAFF / ON LEAVE TODAY /
// PENDING APPROVAL / etc.) and also for the dept-headcount badges below.
// Earlier these were each rendered inline with a colored 5px gradient side
// rail + bg-white + bespoke box-shadow — visually distinct enough from the
// info cards (Out of office today, Pending requests, Upcoming leaves) that
// the page didn't read as one family. Tile gives them the canonical paper
// chrome (#FFFFFF + border-soft + esau-card hover) while preserving the
// dept-color identity through the small accent dot and the tinted count
// pill on the right.
export function Tile({ label, sublabel, count, accentDark, accentTint, onClick, children, pulse }) {
  const Tag = onClick ? 'button' : 'div';
  const tagProps = onClick ? { onClick, type: 'button' } : {};
  return (
    <Tag {...tagProps}
         className={`text-left rounded-xl border p-5 esau-card w-full ${onClick ? 'cursor-pointer' : ''}`}
         style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
      <div className="flex items-start justify-between pb-3 mb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
        <div className="flex items-center gap-2 min-w-0">
          {accentDark && <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: accentDark }} />}
          <div className="min-w-0">
            <div className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.18em', fontWeight: 700 }}>
              {label}
            </div>
            {sublabel && (
              <div className="text-[11px]" style={{ color: '#1F1B16', marginTop: '2px' }}>
                {sublabel}
              </div>
            )}
          </div>
        </div>
        {(count !== undefined && count !== null) && (
          /* Count badge — bumped to 24px (was 20px) so the headline number
             dominates the tile. Optional `pulse` flag adds a soft red ring
             that pulses when the count needs admin attention (e.g. PENDING
             APPROVAL with queue > 0). Pulse is OFF by default so it doesn't
             distract on tiles where the number is informational only. */
          <div className={`rounded-full px-3.5 py-1 flex-shrink-0 ${pulse ? 'esau-pending-pulse' : ''}`}
               style={{
                 background: accentTint || '#F2F2F2',
                 color: accentDark || '#1F1B16',
                 fontSize: '24px',
                 fontWeight: 700,
                 lineHeight: 1,
                 minWidth: '40px',
                 textAlign: 'center',
               }}>
            {count}
          </div>
        )}
      </div>
      {children}
    </Tag>
  );
}

export function StatCard({ label, value, sub, accent = 'var(--ink)', onClick }) {
  // Editorial Minimal (Option 1): plain typography, no tiles, no gradients.
  // The "Your Tasks" tile gets a single warm-orange left rule + matching label
  // colour so it stands out for HR reviewers without breaking the calm.
  const isYourTasks = label === 'Your Tasks';
  const Tag = onClick ? 'button' : 'div';
  const labelColor = isYourTasks ? '#C97A4F' : '#9D6B53';
  return (
    <Tag onClick={onClick}
      className={`text-left block w-full transition-opacity hover:opacity-80 ${onClick ? 'cursor-pointer' : ''}`}
      style={{
        paddingLeft:  isYourTasks ? '16px' : '0',
        borderLeft:   isYourTasks ? '2px solid #C97A4F' : 'none',
        background:   'transparent',
        border:       isYourTasks ? '' : 'none',
        minHeight:    '88px',
      }}>
      <div className="text-[10px]" style={{ color: labelColor, letterSpacing: '0.2em', fontWeight: 500 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontFamily: 'inherit', fontSize: '42px', color: '#1F1B16', lineHeight: 1, margin: '8px 0 4px', fontWeight: 400 }}>
        {value}
      </div>
      {sub && <div className="text-[11px]" style={{ color: '#1F1B16' }}>{sub}</div>}
    </Tag>
  );
}

export function Avatar({ id, name, size = 'md' }) {
  const dim = { sm: 'w-7 h-7 text-[10px]', md: 'w-9 h-9 text-xs', lg: 'w-11 h-11 text-sm', xl: 'w-16 h-16 text-lg' }[size];
  return (
    <div className={`${dim} rounded-full flex items-center justify-center flex-shrink-0`}
         style={{ background: avatarColor(id), color: '#F2F2F2', fontWeight: 600, letterSpacing: '0.05em' }}>
      {getInitials(name)}
    </div>
  );
}

export function Pill({ color = 'var(--evergreen-500)', children }) {
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full inline-block"
          style={{ background: `${color}18`, color, fontWeight: 500 }}>
      {children}
    </span>
  );
}

export function Empty({ icon: Icon, message }) {
  return (
    <div className="text-center py-8 opacity-50">
      <Icon className="w-6 h-6 mx-auto mb-2"/>
      <div className="text-sm">{message}</div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────
   PinRequestsCard
   ─────────────────────────────────────────────────────────────────
   Shows pending registration_requests rows joined to the employees
   directory. Admin (Nadeem) AND reviewers (Bashaier) can issue PINs.

   Click "Generate & Email" → generates random 6-digit PIN →
   calls admin_reset_pin RPC → marks request fulfilled →
   opens user's mail client with PIN pre-filled.

   If the staff already has a PIN (auth_user_id is not null), the
   button is disabled and shows "Already has PIN — use Reset PIN".
   ───────────────────────────────────────────────────────────────── */
function PinRequestsCard({ me, employees, onCountChange }) {
  const [requests, setRequests] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [busyId,   setBusyId]   = useState(null);
  const [error,    setError]    = useState('');
  const [info,     setInfo]     = useState('');

  const empById = useMemo(
    () => Object.fromEntries(employees.map(e => [e.id, e])),
    [employees]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('registration_requests')
        .select('*')
        .eq('status', 'pending')
        .order('requested_at', { ascending: true });
      if (error) throw error;
      const list = data || [];
      setRequests(list);
      if (typeof onCountChange === 'function') onCountChange(list.length);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime: refresh when a new request comes in
  useEffect(() => {
    const ch = supabase.channel('pin-requests-feed')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'registration_requests' },
        load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const generateAndEmail = async (req) => {
    setError(''); setInfo(''); setBusyId(req.id);
    try {
      const emp = empById[req.psn];
      if (!emp) throw new Error('Employee record not found for ' + req.psn);

      // Block if already has a PIN — admin/reviewer should use Reset PIN instead
      if (emp.auth_user_id) {
        setError(`${emp.name} already has a PIN. Use the Reset PIN button on their employee card instead.`);
        return;
      }

      // Random 6-digit PIN
      const pin = String(Math.floor(100000 + Math.random() * 900000));

      // Issue via admin_reset_pin RPC (creates auth user using employees.email)
      const { data, error: rpcErr } = await supabase.rpc('admin_reset_pin', {
        target_psn: req.psn, new_pin: pin
      });
      if (rpcErr) throw rpcErr;
      if (!data?.ok) throw new Error(data?.error || 'PIN issue failed');

      // Mark request fulfilled
      await supabase.from('registration_requests')
        .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString(), fulfilled_by: me?.auth_user_id || null })
        .eq('id', req.id);

      // Open mail client with pre-filled message
      const subject = encodeURIComponent('Your Evergreen HR PIN');
      const body = encodeURIComponent(
        `Dear ${salutationFor(emp)},\n\n` +
        `Your Evergreen HR PIN has been generated.\n\n` +
        `PSN ID: ${emp.id}\n` +
        `PIN: ${pin}\n\n` +
        `Please sign in at https://esauhr.netlify.app and keep this PIN confidential.\n\n` +
        `Best regards,\n${me?.name?.split(' ').slice(0, 2).join(' ') || 'HR'}\n` +
        `Evergreen Shipping Agency Saudi Co. (LLC)`
      );
      // Strip any 'NAME <addr>' wrapping from a messy spreadsheet
      // import. Without this the mailto: encodes the whole string
      // and mail clients render the recipient mangled.
      const to = parseEmailAddress(emp.email || '');
      window.location.href = `mailto:${encodeURIComponent(to)}?subject=${subject}&body=${body}`;

      setInfo(`PIN ${pin} issued to ${emp.name}. Mail draft opened.`);
      await load();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (req) => {
    setBusyId(req.id);
    try {
      await supabase.from('registration_requests')
        .update({ status: 'rejected', fulfilled_at: new Date().toISOString(), fulfilled_by: me?.auth_user_id || null })
        .eq('id', req.id);
      await load();
    } finally { setBusyId(null); }
  };

  return (
    <Card title="PIN requests" subtitle={loading ? 'Loading…' : (requests.length === 0 ? 'No pending requests.' : `${requests.length} pending`)}>
      {error && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
          style={{ background: 'rgba(184,74,62,0.10)', color: 'var(--clay)' }}>
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
        </div>
      )}
      {info && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
          style={{ background: 'rgba(45,95,63,0.10)', color: 'var(--evergreen-500)' }}>
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" /> {info}
        </div>
      )}
      {!loading && requests.length === 0 ? (
        <div className="py-6 text-center opacity-50 text-sm">
          <KeyRound className="w-5 h-5 mx-auto mb-2" />
          Queue is clear.
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
          {requests.map(req => {
            const emp = empById[req.psn];
            const hasPin = emp?.auth_user_id;
            return (
              <li key={req.id} className="py-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-white text-xs font-bold"
                  style={{ background: emp ? avatarColor(req.psn) : '#999' }}>
                  {emp ? getInitials(emp.name) : '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate" style={{ fontWeight: 500 }}>
                    {emp?.name || `Unknown PSN ${req.psn}`}
                  </div>
                  <div className="text-xs opacity-60">
                    {req.psn}{emp?.department ? ' · ' + emp.department : ''}
                    {hasPin ? ' · already has PIN' : ''}
                  </div>
                </div>
                <button onClick={() => reject(req)} disabled={busyId === req.id}
                  className="text-[10px] tracking-wider px-2.5 py-1 rounded-md opacity-60 hover:opacity-100">
                  Reject
                </button>
                <button onClick={() => generateAndEmail(req)} disabled={busyId === req.id || hasPin}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full"
                  style={hasPin
                    ? { background: '#ddd', color: '#888' }
                    : { background: 'linear-gradient(135deg, #FF8A4D 0%, #FF4E6A 100%)', color: '#fff' }}>
                  {busyId === req.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                  {hasPin ? 'Reset PIN instead' : (busyId === req.id ? 'Issuing…' : 'Generate & Email')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// =============================================================================

function DigestStat({ label, primary, secondary, color }) {
  return (
    <div className="rounded-xl p-3" style={{ background: 'var(--paper-soft, #F4F4EE)' }}>
      <div className="text-[10px] tracking-[0.2em] opacity-60 mb-1">{label.toUpperCase()}</div>
      <div className="text-sm font-semibold" style={{ color }}>{primary}</div>
      <div className="text-[10px] opacity-60 mt-0.5">{secondary}</div>
    </div>
  );
}
