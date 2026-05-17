import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Shield, ChevronDown, ChevronRight, Mail, Loader2, RefreshCw,
  TrendingUp, AlertTriangle, X, Copy,
} from 'lucide-react';
import { directGet, supabase } from '../supabaseClient.js';
import {
  summariseViolations, zoneForDeduction,
  ZONE_COLOR, ZONE_LABEL, REVIEW_THRESHOLD, WATCH_LOWER, BASE_SCORE,
} from '../lib/evaluationWeights.js';
import { salutationFor } from '../lib/salutations.js';
import { renderHrSignature, renderHrSignatureHtml } from '../lib/emailTemplates.js';

// =============================================================================
// TeamAttendanceCard
//
// Build 3 of the EVALUATION FLAG rework (Nadeem 2026-05-17).
//
// PURPOSE
//   Line manager (Sharique, Sonnie, Sadakathullah, Zaher, ...) gets a
//   real-time view of every direct report's attendance trajectory. The
//   point is to give them a coaching window BEFORE Bashaier's monthly
//   HR escalation lands. By the time HR escalates the manager has
//   already had three chances to read this card.
//
// LAYOUT
//   Header  · TEAM ATTENDANCE — MAY 2026 · refresh button
//   Body    · one row per direct report with:
//             - Avatar + name + PSN + department
//             - Current-month zone pill (clean / watch / review)
//             - Score chip (SCORE 87 / 100)
//             - 6-month sparkline of monthly deductions
//             - 'Coach now' pill on watch / review rows — opens
//               a preview modal with a friendly email draft (CC
//               Bashaier so HR knows the manager coached).
//
// DATA
//   Pulls 6 months of attendance_violations for every direct report,
//   filtered to cleared_at IS NULL. Uses the shared
//   summariseViolations()/zoneForDeduction() helpers so the math is
//   identical to Bashaier's panel and the staff's own tile.
//
// REALTIME
//   Subscribed to attendance_violations changes. Same lightweight
//   channel pattern PendingSubstitutionsCard uses.
//
// SCOPE
//   Manager-only. Hidden when the manager has no direct reports.
// =============================================================================

// ─── helpers ──────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

function fmtMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// Compute 'YYYY-MM' strings for the trailing N months including the
// current one. The widget displays last 6 months by default — wide
// enough to spot a pattern but short enough to read at a glance.
function trailingMonths(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    out.push(ym);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
  }
  return out.reverse(); // chronological order — oldest left, newest right
}

// ─── coaching email composer ──────────────────────────────────────────────

const HR_EMAIL = 'bashaier.alsubaie@evergreen-shipping.com.sa';

function buildCoachingEmail({ staff, manager, summary, zone, monthLabel }) {
  const subject = `Friendly check-in — ${monthLabel} attendance`;

  // Staff salutation goes through the shared helper.
  const greeting = `Dear ${salutationFor(staff)},`;
  const mgrName  = manager?.name || 'Your manager';

  // Adjust tone with severity. Always supportive, never punitive.
  // 'watch' = "let's tidy up before month-end" · 'review' = "we should
  // talk now because the formal threshold is hit / about to be hit".
  const opener = zone === 'review'
    ? `I wanted to reach out about your attendance this month. The system shows you have ${summary.deduction} severity-weighted points against you for ${monthLabel}, which crosses our internal review threshold. I'd like to understand what's been happening before this is formalised with HR.`
    : `I wanted to flag something I noticed in your attendance for ${monthLabel}. You currently have ${summary.deduction} points against you, which puts you in our 'watch' zone — you're ${REVIEW_THRESHOLD - summary.deduction} more away from a formal HR review.`;

  // Per-type breakdown so they know exactly what landed on the card.
  // Only list categories that actually fired.
  const sev = summary.severityBreakdown || {};
  const lines = [];
  if (summary.absenceCount) lines.push(`• ${summary.absenceCount} unauthorized absence${summary.absenceCount === 1 ? '' : 's'}`);
  if (sev.missedOut)         lines.push(`• ${sev.missedOut} day${sev.missedOut === 1 ? '' : 's'} with no punch-out`);
  if (sev.missedIn)          lines.push(`• ${sev.missedIn} day${sev.missedIn === 1 ? '' : 's'} with no punch-in`);
  if (sev.lateHeavy)         lines.push(`• ${sev.lateHeavy} late arrival${sev.lateHeavy === 1 ? '' : 's'} over 30 min`);
  if (sev.lateMedium)        lines.push(`• ${sev.lateMedium} late arrival${sev.lateMedium === 1 ? '' : 's'} 15-30 min`);
  if (sev.earlyHeavy)        lines.push(`• ${sev.earlyHeavy} early departure${sev.earlyHeavy === 1 ? '' : 's'} over 30 min`);
  if (sev.earlyLight)        lines.push(`• ${sev.earlyLight} early departure${sev.earlyLight === 1 ? '' : 's'} 15-30 min`);

  const closingAsk = zone === 'review'
    ? `Could we have a brief one-on-one this week? If there are circumstances I should know about — health, family, transport — I want to support you on those rather than just see the numbers stack up.`
    : `Could you let me know what's been happening on these days? If there's a fix we can put in place together — schedule change, transport, whatever — I'd rather we sort it out now than have this become a formal record.`;

  const bodyPlain = [
    greeting,
    '',
    opener,
    '',
    'Specifically:',
    ...lines,
    '',
    closingAsk,
    '',
    `Thanks,`,
    `${(mgrName || '').split(' ')[0] || mgrName}`,
  ].join('\n');

  const bodyHtml = `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#0A0A0A;line-height:1.5;max-width:760px">
  <p style="margin:0 0 12px 0">${escapeHtml(greeting)}</p>
  <p style="margin:0 0 12px 0">${escapeHtml(opener)}</p>
  <p style="margin:0 0 6px 0"><strong>Specifically:</strong></p>
  <ul style="margin:0 0 12px 18px;padding:0;font-size:14px;color:#1F2937">
    ${lines.map(l => `<li>${escapeHtml(l.replace(/^•\s*/, ''))}</li>`).join('')}
  </ul>
  <p style="margin:0 0 14px 0">${escapeHtml(closingAsk)}</p>
  <p style="margin:14px 0 4px 0">Thanks,</p>
  <p style="margin:0;color:#0A0A0A"><strong>${escapeHtml((mgrName || '').split(' ')[0] || mgrName)}</strong></p>
</div>`;

  const cc = HR_EMAIL;  // Bashaier always cc'd so HR sees the coaching trail.
  const to = staff.email || '';
  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', bodyPlain);
  const mailto = `mailto:${encodeURIComponent(to)}?${params.toString().replace(/\+/g, '%20')}`;

  return { subject, bodyPlain, bodyHtml, mailto, to, cc };
}

// ─── preview modal (mirrors ShiftComplianceCard) ──────────────────────────

function CoachingPreviewModal({ payload, staffName, onClose }) {
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
      try { await navigator.clipboard.writeText(payload.bodyPlain); setCopied('plain'); setTimeout(() => setCopied(''), 2500); } catch {}
    }
  };
  const copyPlain = async () => {
    try { await navigator.clipboard.writeText(payload.bodyPlain); setCopied('plain'); setTimeout(() => setCopied(''), 2500); } catch {}
  };
  const compose = () => { if (payload.mailto) window.location.href = payload.mailto; };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
         style={{ background: 'rgba(20,30,25,0.55)', backdropFilter: 'blur(2px)' }}
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8"
           onClick={(e) => e.stopPropagation()}>
        <div className="px-5 sm:px-6 py-4 sticky top-0 z-10 rounded-t-2xl flex items-start justify-between gap-3"
             style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] opacity-80 mb-1">— COACHING EMAIL</div>
            <h2 className="text-xl font-serif">Friendly check-in · {staffName}</h2>
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
            {copied === 'html' ? 'Copied formatted' : 'Copy formatted (paste in Outlook)'}
          </button>
          <button onClick={copyPlain}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
                  style={{
                    background: copied === 'plain' ? '#DCFCE7' : 'transparent',
                    color: '#0A0A0A',
                    border: '1px solid var(--border-soft, #E8E5D8)',
                  }}>
            <Copy className="w-3.5 h-3.5" />
            {copied === 'plain' ? 'Copied plain' : 'Copy plain text'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── sparkline ────────────────────────────────────────────────────────────

function Sparkline({ months }) {
  // months: array of { ym, deduction } in chronological order.
  if (!months || months.length === 0) return null;
  const values = months.map(m => Math.max(0, m.deduction || 0));
  const max = Math.max(REVIEW_THRESHOLD, ...values); // cap floor at the threshold so 1-pt months don't fill the chart
  const W = 130, H = 28, pad = 2;
  const stepX = (W - pad * 2) / Math.max(1, months.length - 1);
  // Threshold line position (10 pts on the y-axis).
  const thresholdY = H - pad - (REVIEW_THRESHOLD / max) * (H - pad * 2);

  // Polyline points.
  const points = values.map((v, i) => {
    const x = pad + i * stepX;
    const y = H - pad - (v / max) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // Last-point dot — colour matches the latest month's zone.
  const lastZone = zoneForDeduction(values[values.length - 1]);
  const lastFg   = ZONE_COLOR[lastZone].fg;
  const lastX = pad + (values.length - 1) * stepX;
  const lastY = H - pad - (values[values.length - 1] / max) * (H - pad * 2);

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ flexShrink: 0 }}>
      {/* Threshold line (10 pts) — dashed grey */}
      <line x1={pad} x2={W - pad} y1={thresholdY} y2={thresholdY}
            stroke="#D1D5DB" strokeWidth="1" strokeDasharray="2,2" />
      {/* Series */}
      <polyline fill="none" stroke="#2D5F3F" strokeWidth="1.5" points={points} />
      {/* Last-point dot */}
      <circle cx={lastX} cy={lastY} r="2.5" fill={lastFg} />
    </svg>
  );
}

// ─── card ─────────────────────────────────────────────────────────────────

export default function TeamAttendanceCard({ me, directReports = [] }) {
  const reportIds = useMemo(() => directReports.map(e => e.id).filter(Boolean), [directReports]);
  const month     = useMemo(() => trailingMonths(1)[0], []);
  const monthLabel = useMemo(() => fmtMonth(month), [month]);
  const months6   = useMemo(() => trailingMonths(6), []);
  const windowStart = months6[0] + '-01';

  const [violations, setViolations] = useState([]);
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState('');
  const [expanded,   setExpanded]   = useState({});
  const [refresh,    setRefresh]    = useState(0);
  const [preview,    setPreview]    = useState(null); // { payload, staffName }

  const load = useCallback(async () => {
    if (reportIds.length === 0) { setViolations([]); return; }
    setLoading(true);
    setError('');
    try {
      const list = reportIds.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
      const rows = await directGet(
        'attendance_violations',
        `select=id,employee_id,violation_type,violation_date,minutes_off,cleared_at`
        + `&employee_id=in.(${list})`
        + `&violation_date=gte.${windowStart}`
        + `&cleared_at=is.null`
        + `&order=violation_date`,
        { timeoutMs: 12000 },
      ).catch(() => []);
      setViolations(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.warn('[team attendance] load failed:', e);
      setError(e?.message || String(e));
      setViolations([]);
    } finally {
      setLoading(false);
    }
  }, [reportIds, windowStart]);

  useEffect(() => { load(); }, [load, refresh]);

  // Realtime — refetch when any direct report's violations change.
  useEffect(() => {
    if (!me?.id || reportIds.length === 0) return undefined;
    const ch = supabase.channel(`mgr-team-attn-${me.id}`)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'attendance_violations' },
          () => setRefresh(t => t + 1))
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [me?.id, reportIds.length]);

  // Per-employee summary across the 6-month window.
  const perEmployee = useMemo(() => {
    const out = [];
    const byEmp = new Map();
    for (const v of violations) {
      if (!v?.employee_id) continue;
      if (!byEmp.has(v.employee_id)) byEmp.set(v.employee_id, []);
      byEmp.get(v.employee_id).push(v);
    }
    for (const emp of directReports) {
      const rows = byEmp.get(emp.id) || [];
      // Current month
      const thisMonth = rows.filter(r => String(r.violation_date).startsWith(month));
      const summary   = summariseViolations(thisMonth);
      const zone      = zoneForDeduction(summary.deduction);
      // Per-month deductions across 6 months (chronological)
      const perMonth = months6.map(ym => {
        const list = rows.filter(r => String(r.violation_date).startsWith(ym));
        const s = summariseViolations(list);
        return { ym, deduction: s.deduction, count: s.totalCount };
      });
      out.push({
        emp,
        thisMonth: summary,
        zone,
        perMonth,
        anyActivity: perMonth.some(m => m.count > 0),
      });
    }
    // Sort: review first, then watch, then clean. Within each zone,
    // by current-month deduction desc so the manager sees the
    // sharpest cases at the top.
    const ZONE_ORDER = { review: 0, watch: 1, clean: 2 };
    out.sort((a, b) => {
      const z = ZONE_ORDER[a.zone] - ZONE_ORDER[b.zone];
      if (z !== 0) return z;
      return b.thisMonth.deduction - a.thisMonth.deduction;
    });
    return out;
  }, [violations, directReports, month, months6]);

  // Top-line counts for the header.
  const counts = useMemo(() => {
    const c = { review: 0, watch: 0, clean: 0 };
    for (const row of perEmployee) c[row.zone] = (c[row.zone] || 0) + 1;
    return c;
  }, [perEmployee]);

  if (reportIds.length === 0) return null;

  return (
    <>
      <div className="rounded-xl border"
           style={{ background: '#FFFFFF', borderColor: 'var(--border-soft, #E8E5D8)' }}>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b"
             style={{ borderColor: '#F4F4EE' }}>
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4" style={{ color: counts.review > 0 ? '#7F1D1D' : counts.watch > 0 ? '#92400E' : '#0F4C2A' }}/>
            <div className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
              TEAM ATTENDANCE · {monthLabel.toUpperCase()}
            </div>
            <div className="flex items-center gap-1.5 ml-1">
              {counts.review > 0 && (
                <span style={{ background: '#FEE2E2', color: '#7F1D1D', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                  {counts.review} review
                </span>
              )}
              {counts.watch > 0 && (
                <span style={{ background: '#FEF3C7', color: '#92400E', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                  {counts.watch} watch
                </span>
              )}
              {counts.review === 0 && counts.watch === 0 && (
                <span style={{ background: '#DCFCE7', color: '#14532D', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                  clean
                </span>
              )}
            </div>
          </div>
          <button type="button"
                  onClick={() => setRefresh(t => t + 1)}
                  disabled={loading}
                  className="text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded-full border opacity-80 hover:opacity-100"
                  style={{ borderColor: 'var(--border-soft, #E8E5D8)', background: '#FFFFFF', color: '#1F1B16' }}>
            {loading ? <Loader2 className="w-3 h-3 animate-spin"/> : <RefreshCw className="w-3 h-3"/>}
            REFRESH
          </button>
        </div>

        {error && (
          <div className="px-4 py-3 text-[11px]" style={{ color: '#7F1D1D' }}>
            <AlertTriangle className="w-3.5 h-3.5 inline mr-1"/> {error}
          </div>
        )}

        {/* Rows */}
        {!error && perEmployee.length === 0 && !loading && (
          <div className="px-4 py-6 text-center text-[11px]" style={{ color: '#0A0A0A', opacity: 0.65 }}>
            No team data yet.
          </div>
        )}

        {!error && perEmployee.map(({ emp, thisMonth, zone, perMonth, anyActivity }) => {
          const zc = ZONE_COLOR[zone];
          const open = !!expanded[emp.id];
          const score = Math.max(0, BASE_SCORE - thisMonth.deduction);
          const initials = (emp.name || emp.id || '?').split(/\s+/).map(s => s[0]).filter(Boolean).slice(0,2).join('').toUpperCase();
          return (
            <div key={emp.id} style={{ borderBottom: '1px solid #F4F4EE' }}>
              <div className="flex items-center gap-3 px-4 py-2.5">
                {/* Avatar */}
                <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0"
                     style={{ background: '#F4F4EE', color: '#0A0A0A', fontSize: 10, fontWeight: 700 }}>
                  {initials}
                </div>
                {/* Name + dept */}
                <div className="flex-1 min-w-0">
                  <button type="button"
                          onClick={() => setExpanded(prev => ({ ...prev, [emp.id]: !prev[emp.id] }))}
                          className="flex items-center gap-1 text-left">
                    {open ? <ChevronDown className="w-3.5 h-3.5" style={{ color: '#0A0A0A' }}/> : <ChevronRight className="w-3.5 h-3.5" style={{ color: '#0A0A0A' }}/>}
                    <span style={{ color: '#0A0A0A', fontWeight: 600, fontSize: 12 }}>{emp.name}</span>
                    <span style={{ color: '#1F1B16', opacity: 0.55, fontSize: 10, marginLeft: 4 }}>{emp.id}</span>
                  </button>
                </div>
                {/* Zone pill + score chip */}
                <span style={{
                  background: zc.bg, color: zc.fg, fontWeight: 700,
                  padding: '2px 8px', borderRadius: 999, fontSize: 10,
                  letterSpacing: '0.04em', whiteSpace: 'nowrap',
                }}>
                  {ZONE_LABEL[zone].toUpperCase()}
                </span>
                <span style={{
                  color: zc.fg, fontWeight: 700, fontSize: 11, whiteSpace: 'nowrap',
                  minWidth: 56, textAlign: 'right',
                }}>
                  {score}/{BASE_SCORE}
                </span>
                {/* Sparkline */}
                <Sparkline months={perMonth}/>
                {/* Coach action — only on watch / review */}
                {zone !== 'clean' && (
                  <button type="button"
                          onClick={() => {
                            const payload = buildCoachingEmail({
                              staff: emp, manager: me, summary: thisMonth, zone, monthLabel,
                            });
                            setPreview({ payload, staffName: emp.name || emp.id });
                          }}
                          disabled={!emp.email}
                          title={emp.email ? `Draft a coaching email to ${emp.name}` : 'No email on file'}
                          className="text-[10px] inline-flex items-center gap-1 px-2.5 py-1 rounded-full border font-medium"
                          style={{
                            borderColor: zone === 'review' ? '#FCA5A5' : '#FCD34D',
                            background: '#FFFFFF',
                            color:       zone === 'review' ? '#7F1D1D' : '#92400E',
                            opacity:     emp.email ? 1 : 0.5,
                            cursor:      emp.email ? 'pointer' : 'not-allowed',
                          }}>
                    <Mail className="w-3 h-3"/> Coach now
                  </button>
                )}
              </div>

              {/* Expanded per-month detail */}
              {open && (
                <div className="px-4 pb-3 pt-1" style={{ background: '#FCFCF9' }}>
                  <div className="flex flex-wrap gap-2 text-[10px]">
                    {perMonth.map((m, i) => {
                      const z = zoneForDeduction(m.deduction);
                      const c = ZONE_COLOR[z];
                      const isCurrent = i === perMonth.length - 1;
                      return (
                        <div key={m.ym}
                             className="rounded px-2 py-1.5 border"
                             style={{
                               borderColor: isCurrent ? c.border : 'var(--border-soft, #E8E5D8)',
                               background: isCurrent ? c.bg : '#FFFFFF',
                               minWidth: 70,
                             }}>
                          <div style={{ color: '#0A0A0A', opacity: 0.65, fontSize: 9, letterSpacing: '0.06em', fontWeight: 700 }}>
                            {fmtMonth(m.ym).slice(0, 3).toUpperCase()} {m.ym.slice(2,4)}
                          </div>
                          <div style={{ color: c.fg, fontSize: 13, fontWeight: 700 }}>
                            {m.deduction === 0 ? '—' : `-${m.deduction}`}
                          </div>
                          <div style={{ color: '#0A0A0A', opacity: 0.55, fontSize: 9 }}>
                            {m.count} incident{m.count === 1 ? '' : 's'}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {!anyActivity && (
                    <div className="mt-2 text-[10px]" style={{ color: '#0A0A0A', opacity: 0.55 }}>
                      No attendance incidents recorded in the last 6 months.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        <div className="px-4 py-2 text-[10px]" style={{ color: '#0A0A0A', opacity: 0.55, background: '#FCFCF9' }}>
          Deduction line ({REVIEW_THRESHOLD} pts) shown on each sparkline. Watch ≥ {WATCH_LOWER} pts · Review ≥ {REVIEW_THRESHOLD} pts. Coaching emails CC HR so the trail is visible to Bashaier.
        </div>
      </div>

      {preview && (
        <CoachingPreviewModal
          payload={preview.payload}
          staffName={preview.staffName}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
