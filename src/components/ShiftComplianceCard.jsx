import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  AlertTriangle, ChevronDown, ChevronRight, Mail, Loader2, RefreshCw,
  ShieldAlert, X, Copy,
} from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import {
  summarizeShiftCompliance, VERDICT_LABEL, VERDICT_COLOR,
} from '../lib/shiftCompliance.js';
import {
  renderHrSignature, renderHrSignatureHtml, DEFAULT_TEMPLATES,
} from '../lib/emailTemplates.js';

// =============================================================================
// ShiftComplianceCard
//
// Bashaier's monthly catch-and-report surface for shift staff who were
// assigned shifts but did NOT perform them correctly. Groups issues by
// manager so a single email goes to each manager covering all their
// staff's problems for the month, instead of one-per-incident noise.
//
// Two emails:
//   • Manager digest — one HTML email per manager, table per staff
//   • Staff clarification — per-staff email with the issue list
//
// Each opens in a preview modal with three actions:
//   • Open in mail client  → mailto with plain-text body
//   • Copy formatted       → HTML + plain into the clipboard; user
//                            pastes into Outlook/Gmail to get the
//                            styled table (Calibri, brand-green
//                            header, zebra-striped rows)
//   • Copy plain text      → fallback
//
// Sits below the Roster Gaps card. Scope: month-start through the
// latest uploaded attendance date (endDate prop) — future-dated
// shifts aren't evaluated yet (Nadeem 2026-05-17).
//
// Signature is sourced from src/lib/emailTemplates.js so any change
// Bashaier makes there propagates here automatically (Nadeem
// 2026-05-17).
// =============================================================================

// HR signature email = canonical 'from' for HR comms; always cc'd
// on outgoing manager/staff notifications.
const HR_EMAIL  = DEFAULT_TEMPLATES.hr_signature.email;
const SONNIE_PSN = 'H94226';

// ─── helpers ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

function fmtDayLabel(iso) {
  return new Date(iso).toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short',
  });
}

function fmtTime(t) {
  return t ? String(t).slice(0, 5) : '—';
}

const HTML_VERDICT_STYLE = {
  LATE:          { fg: '#92400E', bg: '#FEF3C7' },
  EARLY_OUT:     { fg: '#92400E', bg: '#FEF3C7' },
  NO_PUNCH_OUT:  { fg: '#7F1D1D', bg: '#FEE2E2' },
  ABSENT:        { fg: '#7F1D1D', bg: '#FEE2E2' },
  WRONG_WINDOW:  { fg: '#7F1D1D', bg: '#FEE2E2' },
};

// ─── manager digest ───────────────────────────────────────────────────────

function staffTableHtml(staff) {
  const rows = staff.issueDays.map((d, i) => {
    const bg = i % 2 === 0 ? '#FFFFFF' : '#F8F8F2';
    const v = HTML_VERDICT_STYLE[d.verdict] || { fg: '#1F2937', bg: '#E5E7EB' };
    const pill = `<span style="display:inline-block;background:${v.bg};color:${v.fg};font-weight:700;font-size:11px;padding:2px 8px;border-radius:999px;letter-spacing:0.04em;white-space:nowrap">${escapeHtml((VERDICT_LABEL[d.verdict] || d.verdict).toUpperCase())}</span>`;
    return `<tr>
  <td style="padding:3px 8px;border:1px solid #D1D5DB;color:#1F2937;font-size:13px;background:${bg};white-space:nowrap;font-weight:600">${escapeHtml(fmtDayLabel(d.date))}</td>
  <td style="padding:3px 8px;border:1px solid #D1D5DB;color:#1F2937;font-size:13px;background:${bg};white-space:nowrap">${escapeHtml(fmtTime(d.shift.start_time))} → ${escapeHtml(fmtTime(d.shift.end_time))}</td>
  <td style="padding:3px 8px;border:1px solid #D1D5DB;color:#1F2937;font-size:13px;background:${bg}">${escapeHtml(d.detail)}</td>
  <td style="padding:3px 8px;border:1px solid #D1D5DB;font-size:13px;background:${bg};text-align:right">${pill}</td>
</tr>`;
  }).join('');

  return `<div style="margin:18px 0 6px 0">
  <div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#0A0A0A;margin-bottom:6px">
    <strong>${escapeHtml(staff.empName)}</strong>
    <span style="color:#6B7280">&nbsp;(${escapeHtml(staff.empId)})</span>
    <span style="color:#6B7280">&nbsp;·&nbsp;${staff.assigned} assigned · ${staff.clean} clean · <strong style="color:#7F1D1D">${staff.issueDays.length} issue${staff.issueDays.length === 1 ? '' : 's'}</strong></span>
  </div>
  <table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif">
    <thead>
      <tr>
        <th style="background:#2D5F3F;color:#fff;padding:5px 8px;text-align:left;font-weight:600;font-size:13px;border:1px solid #1F4530">Date</th>
        <th style="background:#2D5F3F;color:#fff;padding:5px 8px;text-align:left;font-weight:600;font-size:13px;border:1px solid #1F4530">Assigned shift</th>
        <th style="background:#2D5F3F;color:#fff;padding:5px 8px;text-align:left;font-weight:600;font-size:13px;border:1px solid #1F4530">What was recorded</th>
        <th style="background:#2D5F3F;color:#fff;padding:5px 8px;text-align:right;font-weight:600;font-size:13px;border:1px solid #1F4530">Verdict</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

function buildManagerDigest({ manager, monthLabel, rangeLabel, sonnieEmail }) {
  const totalIssues = manager.totalIssues;
  const staffCount  = manager.staff.length;
  const subject = `Shift compliance — your team — ${monthLabel} (${staffCount} staff, ${totalIssues} issue${totalIssues === 1 ? '' : 's'})`;

  const plainStaffBlock = (s) => {
    const lines = [`${s.empName} (${s.empId}) — ${s.issueDays.length} issue${s.issueDays.length === 1 ? '' : 's'}`];
    for (const d of s.issueDays) {
      const shiftLabel = `Assigned ${fmtTime(d.shift.start_time)} → ${fmtTime(d.shift.end_time)}`;
      const verdictLabel = (VERDICT_LABEL[d.verdict] || d.verdict).toUpperCase();
      lines.push(`  ${fmtDayLabel(d.date)}  ${shiftLabel}  ·  ${d.detail}  ·  ${verdictLabel}`);
    }
    return lines.join('\n');
  };

  const bodyPlain = [
    `Dear ${(manager.managerName || '').split(' ')[0] || 'Manager'},`,
    '',
    `As part of HR's monthly shift-compliance review, please find below the consolidated issues across your ${staffCount === 1 ? 'shift-staff direct report' : `${staffCount} shift-staff direct reports`} for ${rangeLabel}. Each row lists an assigned shift day where the actual attendance did not meet the policy (15-min grace on either side of the assigned start/end, both punches required).`,
    '',
    ...manager.staff.map(s => plainStaffBlock(s) + '\n'),
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
    renderHrSignature(),
  ].join('\n');

  const tables = manager.staff.map(staffTableHtml).join('');
  const bodyHtml = `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#0A0A0A;line-height:1.5;max-width:780px">
  <p style="margin:0 0 12px 0">Dear ${escapeHtml((manager.managerName || '').split(' ')[0] || 'Manager')},</p>
  <p style="margin:0 0 12px 0">As part of HR's monthly shift-compliance review, please find below the consolidated issues across your <strong>${staffCount}</strong> shift-staff direct report${staffCount === 1 ? '' : 's'} for <strong>${escapeHtml(rangeLabel)}</strong>. Each row lists an assigned shift day where the actual attendance did not meet the policy (15-min grace on either side of the assigned start/end, both punches required).</p>
  ${tables}
  <div style="margin:18px 0 8px 0;padding:10px 14px;background:#FFFBEB;border:1px solid #FCD34D;border-radius:6px">
    <div style="font-weight:700;font-size:13px;color:#7C2D12;letter-spacing:0.04em;margin-bottom:6px">POLICY REMINDER</div>
    <ol style="margin:0;padding-left:18px;font-size:13px;color:#1F2937">
      <li style="margin-bottom:4px">Each assigned shift must be punched IN within 15 min of start time and punched OUT within 15 min of end time. Missing either punch blocks the day from payroll until clarified in writing.</li>
      <li style="margin-bottom:4px">Repeated no-punch-out occurrences for the same staff in one month constitute a pattern issue and will be escalated to executive management.</li>
      <li>Late / early / absent days without an approved permission or leave on file will not be processed in payroll.</li>
    </ol>
  </div>
  <p style="margin:14px 0 8px 0">Please clarify the rows above with the staff and reply to this email confirming, per row, whether the day should be:</p>
  <ul style="margin:0 0 12px 18px;padding:0;font-size:14px;color:#1F2937">
    <li>Processed (with a written explanation), <strong>or</strong></li>
    <li>Held from payroll for this cycle.</li>
  </ul>
  <p style="margin:0 0 14px 0;color:#7F1D1D"><strong>Unresolved rows by month-end will default to HELD.</strong></p>
  ${renderHrSignatureHtml()}
</div>`;

  const cc = [HR_EMAIL, sonnieEmail].filter(Boolean).filter(e => e !== manager.managerEmail).join(',');
  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', bodyPlain);
  const mailto = `mailto:${encodeURIComponent(manager.managerEmail || '')}?${params.toString().replace(/\+/g, '%20')}`;

  return { subject, bodyPlain, bodyHtml, mailto, to: manager.managerEmail || '', cc };
}

// ─── staff clarification ──────────────────────────────────────────────────

function buildStaffEmail({ staff, manager, monthLabel, rangeLabel }) {
  const subject = `Shift attendance — clarification needed — ${monthLabel}`;

  const dateLines = staff.issueDays.map(d => {
    const dateLabel = new Date(d.date).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
    return `  • ${dateLabel}   Assigned ${fmtTime(d.shift.start_time)} → ${fmtTime(d.shift.end_time)}   ${d.detail}   [${(VERDICT_LABEL[d.verdict] || d.verdict).toUpperCase()}]`;
  });

  const bodyPlain = [
    `Dear ${(staff.empName || '').split(' ')[0] || 'Colleague'},`,
    '',
    `As part of HR's monthly shift-attendance review for ${rangeLabel}, the following days from your assigned roster did not meet the standard policy (15-min grace on either side of your assigned start/end, both punches required):`,
    '',
    ...dateLines,
    '',
    `Please reply to this email confirming, for each day above, what actually happened — late arrival reason, missed punch-out reason, or any approved permission you may have on file that we should match against.`,
    '',
    `Days that remain unclarified by month-end will NOT be processed in payroll for this cycle, per the standing policy.`,
    '',
    `If you believe any of the above is a system error (the assigned times were wrong, the punches were wrong, you were on leave that day), please flag it in your reply so we can correct the record.`,
    '',
    renderHrSignature(),
  ].join('\n');

  const rows = staff.issueDays.map((d, i) => {
    const bg = i % 2 === 0 ? '#FFFFFF' : '#F8F8F2';
    const v = HTML_VERDICT_STYLE[d.verdict] || { fg: '#1F2937', bg: '#E5E7EB' };
    const pill = `<span style="display:inline-block;background:${v.bg};color:${v.fg};font-weight:700;font-size:11px;padding:2px 8px;border-radius:999px;letter-spacing:0.04em;white-space:nowrap">${escapeHtml((VERDICT_LABEL[d.verdict] || d.verdict).toUpperCase())}</span>`;
    return `<tr>
  <td style="padding:3px 8px;border:1px solid #D1D5DB;color:#1F2937;font-size:13px;background:${bg};white-space:nowrap;font-weight:600">${escapeHtml(fmtDayLabel(d.date))}</td>
  <td style="padding:3px 8px;border:1px solid #D1D5DB;color:#1F2937;font-size:13px;background:${bg};white-space:nowrap">${escapeHtml(fmtTime(d.shift.start_time))} → ${escapeHtml(fmtTime(d.shift.end_time))}</td>
  <td style="padding:3px 8px;border:1px solid #D1D5DB;color:#1F2937;font-size:13px;background:${bg}">${escapeHtml(d.detail)}</td>
  <td style="padding:3px 8px;border:1px solid #D1D5DB;font-size:13px;background:${bg};text-align:right">${pill}</td>
</tr>`;
  }).join('');

  const bodyHtml = `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#0A0A0A;line-height:1.5;max-width:780px">
  <p style="margin:0 0 12px 0">Dear ${escapeHtml((staff.empName || '').split(' ')[0] || 'Colleague')},</p>
  <p style="margin:0 0 12px 0">As part of HR's monthly shift-attendance review for <strong>${escapeHtml(rangeLabel)}</strong>, the following days from your assigned roster did not meet the standard policy (15-min grace on either side of your assigned start/end, both punches required):</p>
  <table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;margin:12px 0">
    <thead>
      <tr>
        <th style="background:#2D5F3F;color:#fff;padding:5px 8px;text-align:left;font-weight:600;font-size:13px;border:1px solid #1F4530">Date</th>
        <th style="background:#2D5F3F;color:#fff;padding:5px 8px;text-align:left;font-weight:600;font-size:13px;border:1px solid #1F4530">Assigned shift</th>
        <th style="background:#2D5F3F;color:#fff;padding:5px 8px;text-align:left;font-weight:600;font-size:13px;border:1px solid #1F4530">What was recorded</th>
        <th style="background:#2D5F3F;color:#fff;padding:5px 8px;text-align:right;font-weight:600;font-size:13px;border:1px solid #1F4530">Verdict</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <p style="margin:14px 0 8px 0">Please reply to this email confirming, for each day above, what actually happened — late arrival reason, missed punch-out reason, or any approved permission you may have on file that we should match against.</p>
  <p style="margin:0 0 12px 0;color:#7F1D1D"><strong>Days that remain unclarified by month-end will not be processed in payroll for this cycle.</strong></p>
  <p style="margin:0 0 14px 0">If you believe any of the above is a system error (the assigned times were wrong, the punches were wrong, you were on leave that day), please flag it in your reply so we can correct the record.</p>
  ${renderHrSignatureHtml()}
</div>`;

  const cc = [HR_EMAIL, manager?.managerEmail].filter(Boolean).filter(e => e !== staff.empEmail).join(',');
  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', bodyPlain);
  const mailto = `mailto:${encodeURIComponent(staff.empEmail || '')}?${params.toString().replace(/\+/g, '%20')}`;

  return { subject, bodyPlain, bodyHtml, mailto, to: staff.empEmail || '', cc };
}

// ─── preview modal ────────────────────────────────────────────────────────

function EmailPreviewModal({ payload, kind, onClose }) {
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const copyHtml = async () => {
    try {
      const blobHtml  = new Blob([payload.bodyHtml],  { type: 'text/html'  });
      const blobPlain = new Blob([payload.bodyPlain], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobPlain }),
      ]);
      setCopied('html');
      setTimeout(() => setCopied(''), 2500);
    } catch (e) {
      try {
        await navigator.clipboard.writeText(payload.bodyPlain);
        setCopied('plain');
        setTimeout(() => setCopied(''), 2500);
      } catch {}
    }
  };

  const copyPlain = async () => {
    try {
      await navigator.clipboard.writeText(payload.bodyPlain);
      setCopied('plain');
      setTimeout(() => setCopied(''), 2500);
    } catch {}
  };

  const compose = () => {
    if (payload.mailto) window.location.href = payload.mailto;
  };

  const title = kind === 'manager'
    ? 'Manager digest — shift compliance'
    : 'Staff clarification — shift attendance';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
         style={{ background: 'rgba(20,30,25,0.55)', backdropFilter: 'blur(2px)' }}
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl my-8"
           onClick={(e) => e.stopPropagation()}>
        <div className="px-5 sm:px-6 py-4 sticky top-0 z-10 rounded-t-2xl flex items-start justify-between gap-3"
             style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] opacity-80 mb-1">— EMAIL PREVIEW</div>
            <h2 className="text-xl font-serif">{title}</h2>
          </div>
          <button onClick={onClose}
                  className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors flex-shrink-0"
                  style={{ color: '#fff' }} aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 sm:px-6 py-3 border-b text-xs space-y-1"
             style={{ borderColor: 'var(--border-soft, #E8E5D8)', background: '#FBFAF6' }}>
          <div><strong className="opacity-60 inline-block w-14">To:</strong> {payload.to || '—'}</div>
          <div><strong className="opacity-60 inline-block w-14">Cc:</strong> {payload.cc || '—'}</div>
          <div><strong className="opacity-60 inline-block w-14">Subject:</strong> {payload.subject}</div>
        </div>

        <div className="px-5 sm:px-6 py-4 max-h-[55vh] overflow-y-auto" style={{ background: '#FFFFFF' }}>
          <div dangerouslySetInnerHTML={{ __html: payload.bodyHtml }} />
        </div>

        <div className="px-5 sm:px-6 py-4 border-t flex flex-wrap items-center gap-2 sticky bottom-0 bg-white rounded-b-2xl"
             style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
          <button onClick={compose}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
                  style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
            <Mail className="w-3.5 h-3.5" /> Open in mail client
          </button>
          <button onClick={copyHtml}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
                  style={{
                    background: copied === 'html' ? '#DCFCE7' : 'rgba(45,95,63,0.08)',
                    color: '#2D5F3F',
                    border: '1px solid rgba(45,95,63,0.3)',
                  }}>
            <Copy className="w-3.5 h-3.5" />
            {copied === 'html' ? 'Copied with formatting' : 'Copy formatted (paste in Outlook)'}
          </button>
          <button onClick={copyPlain}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
                  style={{
                    background: copied === 'plain' ? '#DCFCE7' : 'transparent',
                    color: '#0A0A0A',
                    border: '1px solid var(--border-soft, #E8E5D8)',
                  }}>
            <Copy className="w-3.5 h-3.5" />
            {copied === 'plain' ? 'Copied plain text' : 'Copy plain text'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── card ─────────────────────────────────────────────────────────────────

function ManagerDigestLine({ verdict, date, detail, shift }) {
  const tone = VERDICT_COLOR[verdict] || { fg: '#1F1B16', bg: '#F4F4EE' };
  const dateLabel = fmtDayLabel(date);
  return (
    <div className="flex items-center gap-2 py-1.5 px-2 text-[11px]" style={{ borderBottom: '1px solid #F4F4EE' }}>
      <span style={{ color: '#0A0A0A', fontWeight: 600, minWidth: 70 }}>{dateLabel}</span>
      <span style={{
        background: tone.bg, color: tone.fg, fontWeight: 700,
        padding: '1px 6px', borderRadius: 999, fontSize: 9,
        letterSpacing: '0.04em', whiteSpace: 'nowrap',
      }}>
        {(VERDICT_LABEL[verdict] || verdict).toUpperCase()}
      </span>
      <span style={{ color: '#0A0A0A', opacity: 0.7 }}>
        Assigned {fmtTime(shift.start_time)} → {fmtTime(shift.end_time)}
      </span>
      <span style={{ color: '#0A0A0A', flex: 1, textAlign: 'right' }}>{detail}</span>
    </div>
  );
}

export default function ShiftComplianceCard({ employees = [], me, monthKey = null, endDate = null }) {
  const month = useMemo(() => {
    if (monthKey && /^\d{4}-\d{2}$/.test(monthKey)) return monthKey;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }, [monthKey]);

  // Cap the evaluation window at the latest attendance upload date.
  // Future-dated shifts aren't violations — they haven't happened yet.
  const monthRange = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    const monthStart = `${y}-${String(m).padStart(2,'0')}-01`;
    const lastDay    = new Date(y, m, 0).getDate();
    const monthEndFull = `${y}-${String(m).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    let effectiveEnd = monthEndFull;
    if (endDate && /^\d{4}-\d{2}-\d{2}/.test(endDate)) {
      const ed = endDate.slice(0,10);
      if (ed >= monthStart && ed <= monthEndFull) effectiveEnd = ed;
    }
    return { monthStart, monthEnd: effectiveEnd, fullMonthEnd: monthEndFull };
  }, [month, endDate]);

  const monthLabel = useMemo(() => {
    const [y, m] = month.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }, [month]);

  const rangeLabel = useMemo(() => {
    const { monthStart, monthEnd, fullMonthEnd } = monthRange;
    if (monthEnd === fullMonthEnd) return monthLabel;
    const startD = new Date(monthStart).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    const endD   = new Date(monthEnd).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    return `${startD} – ${endD}`;
  }, [monthRange, monthLabel]);

  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState('');
  const [refresh,  setRefresh]  = useState(0);
  const [summary,  setSummary]  = useState({ totalIssues: 0, byManager: [] });
  const [expanded, setExpanded] = useState({});
  const [preview,  setPreview]  = useState(null);

  const empByIdMap = useMemo(() => {
    const m = new Map();
    for (const e of employees || []) {
      if (e?.id) m.set(String(e.id).toUpperCase(), e);
      if (e?.psn) m.set(String(e.psn).toUpperCase(), e);
    }
    return m;
  }, [employees]);

  const sonnieEmail = empByIdMap.get(SONNIE_PSN)?.email || null;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { monthStart, monthEnd } = monthRange;
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
        empById: empByIdMap,
      });
      setSummary(s);
    } catch (e) {
      console.warn('[shift compliance] load failed:', e);
      setError(e?.message || String(e));
      setSummary({ totalIssues: 0, byManager: [] });
    } finally {
      setLoading(false);
    }
  }, [monthRange, empByIdMap]);

  useEffect(() => { load(); }, [load, refresh]);

  const toggleManager = (mid) => setExpanded(prev => ({ ...prev, [mid]: !prev[mid] }));

  const openManagerPreview = (mgr) => {
    const payload = buildManagerDigest({
      manager: mgr, monthLabel, rangeLabel, sonnieEmail,
    });
    setPreview({ payload, kind: 'manager' });
  };

  const openStaffPreview = (staff, mgr) => {
    const payload = buildStaffEmail({
      staff, manager: mgr, monthLabel, rangeLabel,
    });
    setPreview({ payload, kind: 'staff' });
  };

  if (loading && summary.byManager.length === 0) {
    return (
      <div className="rounded-xl border p-4 text-[11px]"
        style={{ background: '#FFFFFF', borderColor: 'var(--border-soft, #E8E5D8)' }}>
        <div className="flex items-center gap-2" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading shift compliance for {rangeLabel}…
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="rounded-xl border"
        style={{ background: '#FFFFFF', borderColor: 'var(--border-soft, #E8E5D8)' }}>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b" style={{ borderColor: '#F4F4EE' }}>
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4" style={{ color: summary.totalIssues > 0 ? '#B91C1C' : '#0F4C2A' }} />
            <div className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
              SHIFT COMPLIANCE · {rangeLabel.toUpperCase()}
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

        {error && (
          <div className="px-4 py-3 text-[11px]" style={{ color: '#7F1D1D' }}>
            <AlertTriangle className="w-3.5 h-3.5 inline mr-1" /> {error}
          </div>
        )}

        {!error && summary.totalIssues === 0 && (
          <div className="px-4 py-6 text-center text-[11px]" style={{ color: '#0A0A0A', opacity: 0.65 }}>
            No shift-compliance issues for {rangeLabel}. Every assigned shift was punched correctly.
          </div>
        )}

        {!error && summary.byManager.map((mgr) => {
          const mid = mgr.managerId || '__UNASSIGNED__';
          const open = !!expanded[mid];
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
                    onClick={() => openManagerPreview(mgr)}
                    disabled={!mgr.managerEmail}
                    title={mgr.managerEmail ? `Preview digest email to ${mgr.managerName}` : 'No email on file for this manager'}
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
                  {mgr.staff.map((s) => (
                    <div key={s.empId} className="rounded-lg border" style={{ borderColor: '#F4F4EE', background: '#FFFFFF' }}>
                      <div className="flex items-center gap-2 px-3 py-2" style={{ borderBottom: '1px solid #F4F4EE' }}>
                        <span style={{ color: '#0A0A0A', fontWeight: 600, fontSize: 12 }}>{s.empName}</span>
                        <span style={{ color: '#1F1B16', opacity: 0.6, fontSize: 10 }}>{s.empId}</span>
                        <span style={{ color: '#1F1B16', opacity: 0.65, fontSize: 10 }}>
                          · {s.assigned} assigned · {s.clean} clean · {s.issueDays.length} issue{s.issueDays.length === 1 ? '' : 's'}
                        </span>
                        <button
                          type="button"
                          onClick={() => openStaffPreview(s, mgr)}
                          disabled={!s.empEmail}
                          title={s.empEmail ? `Preview clarification to ${s.empName}` : 'No email on file for this staff'}
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
                  ))}
                </div>
              )}
            </div>
          );
        })}

        <div className="px-4 py-2 text-[10px]" style={{ color: '#0A0A0A', opacity: 0.55, background: '#FCFCF9' }}>
          Evaluated from 1 {monthLabel.split(' ')[0]} through the latest attendance upload date. Verdicts use a 15-min grace on either side of the assigned start/end. Approved leaves and approved late/early permissions are excluded from issue counts.
        </div>
      </div>

      {preview && (
        <EmailPreviewModal
          payload={preview.payload}
          kind={preview.kind}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
