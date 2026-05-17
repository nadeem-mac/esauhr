import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Shield, ChevronDown, ChevronRight, Mail, Loader2, RefreshCw,
  AlertTriangle, X, Copy,
} from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import {
  summariseViolations, zoneForDeduction,
  ZONE_LABEL, ZONE_COLOR, REVIEW_THRESHOLD, BASE_SCORE,
} from '../lib/evaluationWeights.js';
import { renderHrSignature, renderHrSignatureHtml } from '../lib/emailTemplates.js';
import { salutationFor } from '../lib/salutations.js';

// =============================================================================
// TeamEvaluationCard
//
// Manager-facing widget showing each direct report's attendance score for
// the current month, plus a sparkline of the last 6 months so the manager
// can spot trend lines (someone slowly drifting from clean → watch → review)
// without waiting for Bashaier's HR escalation email.
//
// Goal: coach proactively. Right now managers learn about their team's
// violation pattern only when HR has already crossed the formal threshold
// (deduction >= 10 → BashaierTasksCard escalation panel). By that time
// the staff member is a step away from a written warning. A manager who
// sees the trajectory in week 2 of the month can have a quiet word and
// course-correct without HR ever needing to draft a manager email.
//
// One-click coaching: each row has a "Send coaching note" button that
// opens a soft, peer-tone email draft addressed to the staff member,
// cc'd to Bashaier so HR knows the manager coached — which factors
// into whether the formal escalation is still warranted at month-end.
//
// Scope: this card ONLY shows the manager's direct reports. It uses the
// same severity-weighted scoring as Bashaier's HR panel (Build 1, in
// src/lib/evaluationWeights.js). Same numbers, same threshold — so the
// manager isn't seeing a different number than HR.
//
// Out of scope (TODO Build 4): excuse / dispute flow — manager can't yet
// mark an incident as excused. For now they can flag context via the
// coaching email, and Bashaier handles the excuse decision HR-side.
// =============================================================================

const BRAND_GREEN = '#2D5F3F';
const BRAND_GREEN_DARK = '#1F4530';

// Six months including the current one. Returns an array of
// { year, month, key, label } where key is 'YYYY-MM' and label is
// short — 'May', 'Apr', etc.
function buildMonthWindow() {
  const out = [];
  const now = new Date();
  for (let i = 5; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    out.push({
      year: y,
      month: m,
      key: `${y}-${String(m).padStart(2,'0')}`,
      label: d.toLocaleDateString('en-GB', { month: 'short' }),
    });
  }
  return out;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])
  );
}

// ─── coaching email composer ──────────────────────────────────────────────

function buildCoachingEmail({ employee, manager, summary, zone, monthLabel, hrEmail }) {
  const subject = `Quick word on attendance — ${monthLabel}`;
  const empGreet = salutationFor(employee);
  const mgrName  = manager?.name || 'Your manager';
  const score    = Math.max(0, BASE_SCORE - summary.deduction);

  // Severity breakdown bullets — only the categories that fired.
  const bullets = [];
  const sb = summary.severityBreakdown || {};
  if (summary.absenceCount)  bullets.push(`${summary.absenceCount} unauthorized absence${summary.absenceCount === 1 ? '' : 's'}`);
  if (sb.missedOut)          bullets.push(`${sb.missedOut} day${sb.missedOut === 1 ? '' : 's'} with no punch-out`);
  if (sb.missedIn)           bullets.push(`${sb.missedIn} day${sb.missedIn === 1 ? '' : 's'} with no punch-in`);
  if (sb.lateHeavy)          bullets.push(`${sb.lateHeavy} late arrival${sb.lateHeavy === 1 ? '' : 's'} over 30 min`);
  if (sb.lateMedium)         bullets.push(`${sb.lateMedium} late arrival${sb.lateMedium === 1 ? '' : 's'} (15-30 min)`);
  if (sb.earlyHeavy)         bullets.push(`${sb.earlyHeavy} early departure${sb.earlyHeavy === 1 ? '' : 's'} over 30 min`);
  if (sb.earlyLight)         bullets.push(`${sb.earlyLight} early departure${sb.earlyLight === 1 ? '' : 's'} (15-30 min)`);
  const breakdown = bullets.length > 0 ? bullets.join(', ') : `${summary.totalCount} incidents`;

  // Tone shifts with zone. 'watch' is gentle; 'review' is firmer
  // (manager is making one last attempt before HR formalises). 'clean'
  // never lands here — clean rows don't get a coach button.
  const toneLine = zone === 'review'
    ? `I want to flag this directly because the deduction has crossed the ${REVIEW_THRESHOLD}-point review threshold for ${monthLabel}, which means HR will be notified at month-end if the pattern doesn't change. I'd rather we close this out between us before then.`
    : `I'd like to flag it before the pattern grows. The current deduction is ${summary.deduction} point${summary.deduction === 1 ? '' : 's'} — still within the watch zone, but close enough that another incident or two would trigger an HR review.`;

  const bodyPlain = [
    `Dear ${empGreet},`,
    '',
    `I'm reaching out about attendance for ${monthLabel}. The system shows ${breakdown}, bringing the attendance score to ${score} out of ${BASE_SCORE} for the month.`,
    '',
    toneLine,
    '',
    `If there's a reason for any of the above that I should know about — health, family, scheduling, anything — please let me know so we can either get it documented properly (medical certificate, approved permission, etc.) or work out a solution together.`,
    '',
    `Otherwise, please make sure each shift is punched in within 15 min of start, punched out at end of day, and that any planned absence has an approved leave or permission on file.`,
    '',
    `Thanks,`,
    '',
    mgrName,
  ].join('\n');

  // HTML version — clean, peer-tone, no shaming pills, no big tables.
  // The whole point is 'a quiet word', not 'a formal notice'.
  const bodyHtml = `<div style="font-family:Calibri,Arial,sans-serif;font-size:14px;color:#0A0A0A;line-height:1.5;max-width:680px">
  <p style="margin:0 0 12px 0">Dear ${escapeHtml(empGreet)},</p>
  <p style="margin:0 0 12px 0">I'm reaching out about attendance for <strong>${escapeHtml(monthLabel)}</strong>. The system shows ${escapeHtml(breakdown)}, bringing the attendance score to <strong>${score} / ${BASE_SCORE}</strong> for the month.</p>
  <p style="margin:0 0 12px 0">${escapeHtml(toneLine)}</p>
  <p style="margin:0 0 12px 0">If there's a reason for any of the above that I should know about — health, family, scheduling, anything — please let me know so we can either get it documented properly (medical certificate, approved permission, etc.) or work out a solution together.</p>
  <p style="margin:0 0 14px 0">Otherwise, please make sure each shift is punched in within 15 min of start, punched out at end of day, and that any planned absence has an approved leave or permission on file.</p>
  <p style="margin:14px 0 4px 0">Thanks,</p>
  <p style="margin:0;color:#0A0A0A"><strong>${escapeHtml(mgrName)}</strong></p>
</div>`;

  const cc = hrEmail ? hrEmail : '';
  const params = new URLSearchParams();
  if (cc) params.set('cc', cc);
  params.set('subject', subject);
  params.set('body', bodyPlain);
  const mailto = `mailto:${encodeURIComponent(employee?.email || '')}?${params.toString().replace(/\+/g, '%20')}`;

  return { subject, bodyPlain, bodyHtml, mailto, to: employee?.email || '', cc };
}

// ─── preview modal ────────────────────────────────────────────────────────

function CoachingPreviewModal({ payload, employee, onClose }) {
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
    } catch {
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

  const compose = () => { if (payload.mailto) window.location.href = payload.mailto; };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
         style={{ background: 'rgba(20,30,25,0.55)', backdropFilter: 'blur(2px)' }}
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8"
           onClick={(e) => e.stopPropagation()}>
        <div className="px-5 sm:px-6 py-4 sticky top-0 z-10 rounded-t-2xl flex items-start justify-between gap-3"
             style={{ background: `linear-gradient(135deg, ${BRAND_GREEN} 0%, ${BRAND_GREEN_DARK} 100%)`, color: '#fff' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] opacity-80 mb-1">— COACHING NOTE</div>
            <h2 className="text-xl font-serif">{employee?.name}</h2>
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
          <div><strong className="opacity-60 inline-block w-14">Cc:</strong> {payload.cc || '—'} <span style={{ opacity: 0.5 }}>(HR — for visibility)</span></div>
          <div><strong className="opacity-60 inline-block w-14">Subject:</strong> {payload.subject}</div>
        </div>

        <div className="px-5 sm:px-6 py-4 max-h-[55vh] overflow-y-auto" style={{ background: '#FFFFFF' }}>
          <div dangerouslySetInnerHTML={{ __html: payload.bodyHtml }} />
        </div>

        <div className="px-5 sm:px-6 py-4 border-t flex flex-wrap items-center gap-2 sticky bottom-0 bg-white rounded-b-2xl"
             style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
          <button onClick={compose}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
                  style={{ background: `linear-gradient(135deg, ${BRAND_GREEN} 0%, ${BRAND_GREEN_DARK} 100%)`, color: '#fff' }}>
            <Mail className="w-3.5 h-3.5" /> Open in mail client
          </button>
          <button onClick={copyHtml}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg"
                  style={{
                    background: copied === 'html' ? '#DCFCE7' : 'rgba(45,95,63,0.08)',
                    color: BRAND_GREEN,
                    border: '1px solid rgba(45,95,63,0.3)',
                  }}>
            <Copy className="w-3.5 h-3.5" />
            {copied === 'html' ? 'Copied with formatting' : 'Copy formatted'}
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

// ─── sparkline ────────────────────────────────────────────────────────────
// 6-month deduction-per-month strip. 6 columns, each ~10px wide. Tallest
// bar = the most severe month in the window (relative scale), with a
// minimum visible bar for any non-zero month so a single 1-pt month
// doesn't disappear next to a 13-pt one.
//
// Colors per zone, no x-axis labels (the column order is implicit: 6
// months ago on the left, current month on the right). Hover title
// shows 'May: 8 pts'.

function Sparkline({ months, monthlyDeductions }) {
  const maxDeduction = Math.max(1, ...monthlyDeductions);
  return (
    <div className="flex items-end gap-[2px]" style={{ height: 24 }}>
      {months.map((m, i) => {
        const d = monthlyDeductions[i] || 0;
        const zone = zoneForDeduction(d);
        const c = ZONE_COLOR[zone];
        const ratio = d / maxDeduction;
        // Minimum bar of 2px when there's any deduction so it stays
        // visible alongside taller bars. Zero stays as a 1px stub at
        // bottom (just a hairline to mark the column).
        const h = d === 0 ? 1 : Math.max(3, Math.round(ratio * 24));
        return (
          <div key={m.key}
               title={`${m.label}: ${d} ${d === 1 ? 'pt' : 'pts'}`}
               style={{
                 width: 8, height: h,
                 background: d === 0 ? '#D1D5DB' : c.fg,
                 borderRadius: 2,
                 transition: 'background 0.2s',
               }}
          />
        );
      })}
    </div>
  );
}

// ─── per-staff row ────────────────────────────────────────────────────────

function StaffRow({ employee, monthlyDeductions, currentSummary, months, onCoach }) {
  const currentZone = zoneForDeduction(currentSummary.deduction);
  const color = ZONE_COLOR[currentZone];
  const score = Math.max(0, BASE_SCORE - currentSummary.deduction);
  const canCoach = currentZone !== 'clean' && !!employee.email;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-white"
         style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span style={{ color: '#0A0A0A', fontWeight: 600, fontSize: 13 }}>{employee.name}</span>
          <span style={{ color: '#1F1B16', opacity: 0.55, fontSize: 10 }}>{employee.id}</span>
          {currentZone !== 'clean' && (
            <span style={{
              background: color.bg, color: color.fg,
              padding: '1px 8px', borderRadius: 999,
              fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
              whiteSpace: 'nowrap',
            }}>
              {ZONE_LABEL[currentZone].toUpperCase()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 text-[11px]" style={{ color: '#0A0A0A' }}>
          <span>
            {currentSummary.totalCount === 0
              ? <span style={{ opacity: 0.6 }}>No incidents this month</span>
              : <>
                  <strong>{currentSummary.totalCount}</strong> incident{currentSummary.totalCount === 1 ? '' : 's'}
                  {' · '}
                  <strong style={{ color: color.fg }}>{currentSummary.deduction} pt{currentSummary.deduction === 1 ? '' : 's'}</strong>
                  {' · '}
                  Score <strong>{score}</strong>/{BASE_SCORE}
                </>
            }
          </span>
        </div>
      </div>

      {/* Sparkline strip — last 6 months including current */}
      <div className="flex-shrink-0 flex flex-col items-center gap-1">
        <Sparkline months={months} monthlyDeductions={monthlyDeductions} />
        <div className="text-[9px]" style={{ color: '#0A0A0A', opacity: 0.55, letterSpacing: '0.05em' }}>
          {months[0].label.toUpperCase()} → {months[months.length - 1].label.toUpperCase()}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onCoach(employee)}
        disabled={!canCoach}
        title={!employee.email
          ? 'No email on file for this staff'
          : currentZone === 'clean'
            ? 'No coaching needed — clean month'
            : `Draft a coaching note to ${employee.name}`}
        className="text-[10px] inline-flex items-center gap-1 px-3 py-1.5 rounded-full border font-medium flex-shrink-0"
        style={{
          borderColor: canCoach ? '#86EFAC' : 'var(--border-soft, #E8E5D8)',
          background: '#FFFFFF',
          color: canCoach ? BRAND_GREEN : '#9CA3AF',
          opacity: canCoach ? 1 : 0.5,
          cursor: canCoach ? 'pointer' : 'not-allowed',
        }}
      >
        <Mail className="w-3 h-3"/> Send coaching note
      </button>
    </div>
  );
}

// ─── card ─────────────────────────────────────────────────────────────────

export default function TeamEvaluationCard({ me, directReports = [] }) {
  const months = useMemo(() => buildMonthWindow(), []);
  const currentMonthKey = months[months.length - 1].key;

  const [violations, setViolations] = useState([]);
  const [loading, setLoading]       = useState(false);
  const [refresh, setRefresh]       = useState(0);
  const [expanded, setExpanded]     = useState(false);
  const [preview,  setPreview]      = useState(null); // { payload, employee }

  const reportIds = useMemo(
    () => directReports.map(e => e.id).filter(Boolean),
    [directReports]
  );

  const load = useCallback(async () => {
    if (reportIds.length === 0) {
      setViolations([]);
      return;
    }
    setLoading(true);
    try {
      const inList = reportIds.map(id => `"${String(id).replace(/"/g, '')}"`).join(',');
      const startKey = months[0].key + '-01';
      const rows = await directGet(
        'attendance_violations',
        `select=employee_id,violation_type,violation_date,minutes_off,cleared_at`
        + `&employee_id=in.(${inList})`
        + `&violation_date=gte.${startKey}`
        + `&cleared_at=is.null`
        + `&order=violation_date.desc`,
        { timeoutMs: 12000 },
      );
      setViolations(Array.isArray(rows) ? rows : []);
    } catch (e) {
      console.warn('[team eval] load failed:', e);
      setViolations([]);
    } finally {
      setLoading(false);
    }
  }, [reportIds, months]);

  useEffect(() => { load(); }, [load, refresh]);

  // Build per-employee monthly deductions for the sparkline + the
  // current-month summary for the score chip.
  const perStaff = useMemo(() => {
    // Bucket violations by (employee_id, YYYY-MM)
    const buckets = new Map();
    for (const v of violations) {
      if (!v?.employee_id || !v?.violation_date) continue;
      const key = `${v.employee_id}|${String(v.violation_date).slice(0,7)}`;
      let arr = buckets.get(key);
      if (!arr) { arr = []; buckets.set(key, arr); }
      arr.push(v);
    }
    // Project onto the manager's full direct-report list (so clean
    // reports still appear with an empty sparkline).
    return directReports.map(emp => {
      const monthlyDeductions = months.map(m => {
        const arr = buckets.get(`${emp.id}|${m.key}`) || [];
        return summariseViolations(arr).deduction;
      });
      const currentArr = buckets.get(`${emp.id}|${currentMonthKey}`) || [];
      const currentSummary = summariseViolations(currentArr);
      return { employee: emp, monthlyDeductions, currentSummary };
    });
  }, [violations, directReports, months, currentMonthKey]);

  // Sort: review first, then watch (by deduction desc), then clean (by
  // name asc) so the manager's eye lands on what needs attention.
  const sortedStaff = useMemo(() => {
    return [...perStaff].sort((a, b) => {
      const az = zoneForDeduction(a.currentSummary.deduction);
      const bz = zoneForDeduction(b.currentSummary.deduction);
      const rank = { review: 0, watch: 1, clean: 2 };
      if (rank[az] !== rank[bz]) return rank[az] - rank[bz];
      if (az !== 'clean') return b.currentSummary.deduction - a.currentSummary.deduction;
      return (a.employee.name || '').localeCompare(b.employee.name || '');
    });
  }, [perStaff]);

  const totals = useMemo(() => {
    let review = 0, watch = 0, clean = 0;
    for (const s of perStaff) {
      const z = zoneForDeduction(s.currentSummary.deduction);
      if (z === 'review') review += 1;
      else if (z === 'watch') watch += 1;
      else clean += 1;
    }
    return { review, watch, clean };
  }, [perStaff]);

  const openCoaching = (employee) => {
    const summary = perStaff.find(s => s.employee.id === employee.id)?.currentSummary;
    if (!summary) return;
    const zone = zoneForDeduction(summary.deduction);
    const monthLabel = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const hrEmail = 'bashaier.alsubaie@evergreen-shipping.com.sa';
    const payload = buildCoachingEmail({
      employee, manager: me, summary, zone, monthLabel, hrEmail,
    });
    setPreview({ payload, employee });
  };

  // Don't render at all if the manager has no reports — keeps the
  // dashboard clean.
  if (directReports.length === 0) return null;

  const monthLabel = new Date().toLocaleDateString('en-GB', { month: 'long' });

  return (
    <>
      <div className="rounded-xl border"
           style={{ background: '#FFFFFF', borderColor: 'var(--border-soft, #E8E5D8)' }}>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b" style={{ borderColor: '#F4F4EE' }}>
          <button
            type="button"
            onClick={() => setExpanded(x => !x)}
            className="flex items-center gap-2 flex-1"
          >
            {expanded ? <ChevronDown className="w-4 h-4" style={{ color: '#0A0A0A' }}/> : <ChevronRight className="w-4 h-4" style={{ color: '#0A0A0A' }}/>}
            <Shield className="w-4 h-4" style={{ color: totals.review > 0 ? '#B91C1C' : totals.watch > 0 ? '#A16207' : '#0F4C2A' }}/>
            <div className="text-[10px] tracking-[0.25em]" style={{ fontWeight: 700, color: '#0A0A0A' }}>
              TEAM ATTENDANCE · {monthLabel.toUpperCase()}
            </div>
            <div className="flex items-center gap-1.5 ml-2">
              {totals.review > 0 && (
                <span style={{ background: ZONE_COLOR.review.bg, color: ZONE_COLOR.review.fg, padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                  {totals.review} review
                </span>
              )}
              {totals.watch > 0 && (
                <span style={{ background: ZONE_COLOR.watch.bg, color: ZONE_COLOR.watch.fg, padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                  {totals.watch} watch
                </span>
              )}
              {totals.review === 0 && totals.watch === 0 && (
                <span style={{ background: ZONE_COLOR.clean.bg, color: ZONE_COLOR.clean.fg, padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
                  all clean
                </span>
              )}
            </div>
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setRefresh(t => t + 1); }}
            disabled={loading}
            className="text-[10px] inline-flex items-center gap-1 px-2 py-1 rounded-full border opacity-80 hover:opacity-100"
            style={{ borderColor: 'var(--border-soft, #E8E5D8)', background: '#FFFFFF', color: '#1F1B16' }}
            title="Refresh"
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin"/> : <RefreshCw className="w-3 h-3"/>}
            REFRESH
          </button>
        </div>

        {expanded && (
          <div className="p-3 space-y-2">
            {loading && sortedStaff.length === 0 && (
              <div className="flex items-center gap-2 py-3 text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                <Loader2 className="w-3.5 h-3.5 animate-spin"/> Loading attendance scores…
              </div>
            )}
            {!loading && sortedStaff.length === 0 && (
              <div className="px-2 py-4 text-center text-[11px]" style={{ color: '#0A0A0A', opacity: 0.6 }}>
                No direct reports on file.
              </div>
            )}
            {sortedStaff.map((s) => (
              <StaffRow
                key={s.employee.id}
                employee={s.employee}
                monthlyDeductions={s.monthlyDeductions}
                currentSummary={s.currentSummary}
                months={months}
                onCoach={openCoaching}
              />
            ))}
            <div className="px-2 pt-2 pb-1 text-[10px]" style={{ color: '#0A0A0A', opacity: 0.55 }}>
              Sparkline shows last 6 months of severity-weighted deductions. Clean &lt; 5 pts · Watch 5-9 pts · Review ≥ {REVIEW_THRESHOLD} pts (formal HR notification at month-end). Coaching notes are cc'd to HR for visibility.
            </div>
          </div>
        )}
      </div>

      {preview && (
        <CoachingPreviewModal
          payload={preview.payload}
          employee={preview.employee}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
