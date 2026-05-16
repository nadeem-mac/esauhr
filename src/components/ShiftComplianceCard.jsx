import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight, Mail, Loader2, RefreshCw, ShieldAlert,
} from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import {
  summarizeShiftCompliance, VERDICT_LABEL, VERDICT_COLOR,
} from '../lib/shiftCompliance.js';

// =============================================================================
// ShiftComplianceCard
//
// Bashaier's monthly catch-and-report surface for shift staff who were
// assigned shifts but did NOT perform them correctly. Groups issues by
// manager so a single email goes to each manager covering all their
// staff's problems for the month, instead of one-per-incident noise.
//
// Sits below the Roster Gaps card. The two answer different questions:
//   • Roster Gaps     — manager didn't assign these days at all
//   • Shift Compliance — manager assigned the day, staff didn't show
//                        / was late / forgot to punch out / etc.
//
// Verdict logic lives in src/lib/shiftCompliance.js (pure). This file
// just renders + composes the email drafts.
// =============================================================================

const HR_EMAIL  = 'bashaier.alsubaie@evergreen-shipping.com.sa';
const SONNIE_PSN = 'H94226';  // line-manager peer in Jeddah; cc'd on manager digests so the policy stays consistent

function ManagerDigestLine({ verdict, date, detail, shift }) {
  const tone = VERDICT_COLOR[verdict] || { fg: '#1F1B16', bg: '#F4F4EE' };
  const dateLabel = new Date(date).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 text-[11px]" style={{ borderBottom: '1px solid #F4F4EE' }}>
      <span style={{ color: '#0A0A0A', fontWeight: 600, minWidth: 70 }}>{dateLabel}</span>
      <span style={{
        background: tone.bg, color: tone.fg, fontWeight: 700,
        padding: '1px 6px', borderRadius: 999, fontSize: 9,
        letterSpacing: '0.04em', whiteSpace: 'nowrap',
      }}>
        {VERDICT_LABEL[verdict].toUpperCase()}
      </span>
      <span style={{ color: '#0A0A0A', opacity: 0.7 }}>
        Assigned {shift.start_time?.slice(0,5)} → {shift.end_time?.slice(0,5)}
      </span>
      <span style={{ color: '#0A0A0A', flex: 1, textAlign: 'right' }}>{detail}</span>
    </div>
  );
}

// Format a single staff's issue list as a plain-text block for the
// manager digest email. Each line: date · verdict · detail.
function formatStaffBlockForEmail(staff) {
  const lines = [];
  lines.push(`${staff.empName} (${staff.empId}) — ${staff.issueDays.length} issue${staff.issueDays.length === 1 ? '' : 's'}`);
  for (const d of staff.issueDays) {
    const dateLabel = new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
    const shiftLabel = `Assigned ${d.shift.start_time?.slice(0,5)} → ${d.shift.end_time?.slice(0,5)}`;
    const verdictLabel = (VERDICT_LABEL[d.verdict] || d.verdict).toUpperCase();
    lines.push(`  ${dateLabel}  ${shiftLabel}  ·  ${d.detail}  ·  ${verdictLabel}`);
  }
  return lines.join('\n');
}

function buildManagerDigestEmail({ manager, monthLabel, sonnieEmail, hrName }) {
  const totalIssues = manager.totalIssues;
  const staffCount  = manager.staff.length;
  const subject = `Shift compliance — your team — ${monthLabel} (${staffCount} staff, ${totalIssues} issue${totalIssues === 1 ? '' : 's'})`;

  const body = [
    `Dear ${(manager.managerName || '').split(' ')[0] || 'Manager'},`,
    '',
    `As part of HR's monthly shift-compliance review, please find below the consolidated issues across your ${staffCount === 1 ? 'shift-staff direct report' : `${staffCount} shift-staff direct reports`} for ${monthLabel}. Each row lists an assigned shift day where the actual attendance did not meet the policy (15-min grace on either side of the assigned start/end, both punches required).`,
    '',
    ...manager.staff.map(s => formatStaffBlockForEmail(s) + '\n'),
    'POLICY REMINDER',
    `01. Each assigned shift must be punched IN within 15 min of start time and punched OUT within 15 min of end time. Missing either punch blocks the day from payroll until clarified in writing.`,
    `02. Repeated no-punch-out occurrences for the same staff in one month constitute a pattern issue and will be escalated to executive management.`,
    `03. Late / early / absent days without an approved permission or leave on file will not be processed in payroll.`,
    '',
    `Please clarify the rows above with the staff and reply to this email confirming, per row, whether the day should be:`,
    `   - Processed (with a written explanation), or`,
    `   - Held from payroll for this cycle.`,
    '',
    `Unresolved rows by month-end will default to HELD.`,
    '',
    `Thanks and regards,`,
    '',
    hrName || 'BASHAIER ALI ALSUBAIE',
    `Evergreen Shipping Agency Saudi Co. (L.L.C)`,
    `ESAU · SADMN SUP / HR Department`,
  ].join('\n');

  const cc = [HR_EMAIL, sonnieEmail].filter(Boolean).filter(e => e !== manager.managerEmail).join(',');
  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', body);
  const mailto = `mailto:${encodeURIComponent(manager.managerEmail || '')}?${params.toString().replace(/\+/g, '%20')}`;
  return { subject, body, mailto, to: manager.managerEmail || '', cc };
}

function buildStaffEmail({ staff, manager, monthLabel, hrName }) {
  const subject = `Shift attendance — clarification needed — ${monthLabel}`;
  const dateLines = staff.issueDays.map(d => {
    const dateLabel = new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    const shiftLabel = `${d.shift.start_time?.slice(0,5)} → ${d.shift.end_time?.slice(0,5)}`;
    const verdictLabel = (VERDICT_LABEL[d.verdict] || d.verdict).toUpperCase();
    return `  • ${dateLabel}   Assigned ${shiftLabel}   ${d.detail}   [${verdictLabel}]`;
  });
  const body = [
    `Dear ${(staff.empName || '').split(' ')[0] || 'Colleague'},`,
    '',
    `As part of HR's monthly shift-attendance review for ${monthLabel}, the following days from your assigned roster did not meet the standard policy (15-min grace on either side of your assigned start/end, both punches required):`,
    '',
    ...dateLines,
    '',
    `Please reply to this email confirming, for each day above, what actually happened — late arrival reason, missed punch-out reason, or any approved permission you may have on file that we should match against.`,
    '',
    `Days that remain unclarified by month-end will NOT be processed in payroll for this cycle, per the standing policy.`,
    '',
    `If you believe any of the above is a system error (the assigned times were wrong, the punches were wrong, you were on leave that day), please flag it in your reply so we can correct the record.`,
    '',
    `Thanks and regards,`,
    '',
    hrName || 'BASHAIER ALI ALSUBAIE',
    `Evergreen Shipping Agency Saudi Co. (L.L.C)`,
    `ESAU · SADMN SUP / HR Department`,
  ].join('\n');
  const cc = [HR_EMAIL, manager?.managerEmail].filter(Boolean).filter(e => e !== staff.empEmail).join(',');
  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', body);
  const mailto = `mailto:${encodeURIComponent(staff.empEmail || '')}?${params.toString().replace(/\+/g, '%20')}`;
  return { subject, body, mailto, to: staff.empEmail || '', cc };
}

export default function ShiftComplianceCard({ employees = [], me, monthKey = null }) {
  // monthKey is 'YYYY-MM'. Falls back to current month.
  const month = useMemo(() => {
    if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) return monthKey;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, [monthKey]);

  const monthLabel = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }, [month]);

  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [refresh,  setRefresh]  = useState(0);
  const [summary,  setSummary]  = useState({ totalIssues: 0, byManager: [] });
  const [expanded, setExpanded] = useState({});

  const empById = useMemo(() => {
    const m = new Map();
    for (const e of employees || []) {
      if (e?.id) m.set(String(e.id).toUpperCase(), e);
      if (e?.psn) m.set(String(e.psn).toUpperCase(), e);
    }
    return m;
  }, [employees]);

  const sonnieEmail = empById.get(SONNIE_PSN)?.email || null;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [y, m] = month.split('-').map(Number);
      const monthStart = `${y}-${String(m).padStart(2,'0')}-01`;
      const lastDay    = new Date(y, m, 0).getDate();
      const monthEnd   = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

      // Parallel fetch — four independent sources.
      const [shifts, attendance, leaves, permissions] = await Promise.all([
        directGet(
          'employee_shifts',
          `select=employee_id,shift_date,start_time,end_time,status` +
          `&status=in.(pending,accepted)` +
          `&shift_date=gte.${monthStart}&shift_date=lte.${monthEnd}`,
          { timeoutMs: 12000 },
        ).catch(() => []),
        directGet(
          'attendance_daily',
          `select=employee_id,attendance_date,first_punch,last_punch,expected_start,expected_end,status,leave_request_id` +
          `&attendance_date=gte.${monthStart}&attendance_date=lte.${monthEnd}`,
          { timeoutMs: 15000 },
        ).catch(() => []),
        directGet(
          'leave_requests',
          `select=employee_id,start_date,end_date,stage,leave_type_id` +
          `&stage=eq.approved` +
          `&start_date=lte.${monthEnd}&end_date=gte.${monthStart}`,
          { timeoutMs: 12000 },
        ).catch(() => []),
        directGet(
          'permission_requests',
          `select=employee_id,permission_date,type,stage` +
          `&stage=eq.approved` +
          `&permission_date=gte.${monthStart}&permission_date=lte.${monthEnd}`,
          { timeoutMs: 12000 },
        ).catch(() => []),
      ]);

      const s = summarizeShiftCompliance({
        shifts: Array.isArray(shifts) ? shifts : [],
        attendance: Array.isArray(attendance) ? attendance : [],
        leaves: Array.isArray(leaves) ? leaves : [],
        permissions: Array.isArray(permissions) ? permissions : [],
        empById,
      });
      setSummary(s);
    } catch (e) {
      console.warn('[shift compliance] load failed:', e);
      setError(e?.message || String(e));
      setSummary({ totalIssues: 0, byManager: [] });
    } finally {
      setLoading(false);
    }
  }, [month, empById]);

  useEffect(() => { load(); }, [load, refresh]);

  const toggleManager = (mid) => setExpanded(prev => ({ ...prev, [mid]: !prev[mid] }));

  const openMailto = (mailto) => {
    if (!mailto) return;
    window.location.href = mailto;
  };

  // ── render ────────────────────────────────────────────────────────────
  if (loading && summary.byManager.length === 0) {
    return (
      <div className="rounded-xl border p-4 text-[11px]"
        style={{ background: '#FFFFFF', borderColor: 'var(--border-soft, #E8E5D8)' }}>
        <div className="flex items-center gap-2" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading shift compliance for {monthLabel}…
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border"
      style={{ background: '#FFFFFF', borderColor: 'var(--border-soft, #E8E5D8)' }}>
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b" style={{ borderColor: '#F4F4EE' }}>
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4" style={{ color: summary.totalIssues > 0 ? '#B91C1C' : '#0F4C2A' }} />
          <div className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
            SHIFT COMPLIANCE · {monthLabel.toUpperCase()}
          </div>
          {summary.totalIssues > 0 ? (
            <span style={{ background: '#FEE2E2', color: '#7F1D1D', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
              {summary.totalIssues}
            </span>
          ) : (
            <span style={{ background: '#DCFCE7', color: '#14532D', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
              clean
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setRefresh(t => t + 1)}
          disabled={loading}
          className="text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded-full border opacity-80 hover:opacity-100"
          style={{ borderColor: 'var(--border-soft, #E8E5D8)', background: '#FFFFFF', color: '#1F1B16' }}
        >
          {loading ? <Loader2 className="w-3 h-3 animate-spin"/> : <RefreshCw className="w-3 h-3"/>}
          REFRESH
        </button>
      </div>

      {/* Body */}
      {error && (
        <div className="px-4 py-3 text-[11px]" style={{ color: '#7F1D1D' }}>
          <AlertTriangle className="w-3.5 h-3.5 inline mr-1" /> {error}
        </div>
      )}

      {!error && summary.totalIssues === 0 && (
        <div className="px-4 py-6 text-center text-[11px]" style={{ color: '#0A0A0A', opacity: 0.65 }}>
          No shift-compliance issues for {monthLabel}. Every assigned shift was punched correctly.
        </div>
      )}

      {!error && summary.byManager.map((mgr) => {
        const mid = mgr.managerId || '__UNASSIGNED__';
        const open = !!expanded[mid];
        const digest = buildManagerDigestEmail({
          manager: mgr,
          monthLabel,
          sonnieEmail,
          hrName: me?.name,
        });
        return (
          <div key={mid} style={{ borderBottom: '1px solid #F4F4EE' }}>
            <div className="flex items-center gap-2 px-4 py-2.5">
              <button
                type="button"
                onClick={() => toggleManager(mid)}
                className="flex items-center gap-1.5 text-[11px]"
                style={{ color: '#0A0A0A', fontWeight: 700 }}
              >
                {open ? <ChevronDown className="w-3.5 h-3.5"/> : <ChevronRight className="w-3.5 h-3.5"/>}
                {mgr.managerName}
              </button>
              <span style={{ color: '#1F1B16', opacity: 0.6, fontSize: 11 }}>
                · {mgr.totalIssues} issue{mgr.totalIssues === 1 ? '' : 's'} across {mgr.staff.length} staff
              </span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => openMailto(digest.mailto)}
                  disabled={!mgr.managerEmail}
                  title={mgr.managerEmail ? `Open digest email to ${mgr.managerName}` : 'No email on file for this manager'}
                  className="text-[10px] inline-flex items-center gap-1 px-3 py-1.5 rounded-full border font-medium"
                  style={{
                    borderColor: '#86EFAC',
                    background: '#FFFFFF',
                    color: 'var(--evergreen-500)',
                    opacity: mgr.managerEmail ? 1 : 0.5,
                    cursor: mgr.managerEmail ? 'pointer' : 'not-allowed',
                  }}
                >
                  <Mail className="w-3 h-3"/> Email manager
                </button>
              </div>
            </div>

            {open && (
              <div className="px-4 pb-3 space-y-3" style={{ background: '#FCFCF9' }}>
                {mgr.staff.map((s) => {
                  const staffMail = buildStaffEmail({
                    staff: s,
                    manager: mgr,
                    monthLabel,
                    hrName: me?.name,
                  });
                  return (
                    <div key={s.empId} className="rounded-lg border" style={{ borderColor: '#F4F4EE', background: '#FFFFFF' }}>
                      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid #F4F4EE' }}>
                        <span style={{ color: '#0A0A0A', fontWeight: 600, fontSize: 12 }}>{s.empName}</span>
                        <span style={{ color: '#1F1B16', opacity: 0.6, fontSize: 10 }}>{s.empId}</span>
                        <span style={{ color: '#1F1B16', opacity: 0.65, fontSize: 10 }}>
                          · {s.assigned} assigned · {s.clean} clean · {s.issueDays.length} issue{s.issueDays.length === 1 ? '' : 's'}
                        </span>
                        <button
                          type="button"
                          onClick={() => openMailto(staffMail.mailto)}
                          disabled={!s.empEmail}
                          title={s.empEmail ? `Open clarification email to ${s.empName}` : 'No email on file for this staff'}
                          className="ml-auto text-[10px] inline-flex items-center gap-1 px-2.5 py-1 rounded-full border font-medium"
                          style={{
                            borderColor: '#FCD34D',
                            background: '#FFFFFF',
                            color: '#92400E',
                            opacity: s.empEmail ? 1 : 0.5,
                            cursor: s.empEmail ? 'pointer' : 'not-allowed',
                          }}
                        >
                          <Mail className="w-3 h-3"/> Email staff
                        </button>
                      </div>
                      <div>
                        {s.issueDays.map((d) => (
                          <ManagerDigestLine key={d.date}
                            verdict={d.verdict} date={d.date} detail={d.detail} shift={d.shift}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div className="px-4 py-2 text-[10px]" style={{ color: '#0A0A0A', opacity: 0.55, background: '#FCFCF9' }}>
        Verdicts use a 15-min grace on either side of the assigned start/end. Approved leaves and approved late/early permissions are excluded from issue counts. Click any manager row to drill in.
      </div>
    </div>
  );
}
