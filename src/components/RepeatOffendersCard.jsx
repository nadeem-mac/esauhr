import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Mail, RefreshCw } from 'lucide-react';
import { loadRepeatOffenders } from '../lib/repeatOffenderDetector.js';

// =============================================================================
// RepeatOffendersCard.jsx
//
// Surfaces staff with 3+ violations in the last 30 days as a single
// "needs HR conversation" tile. Replaces the old workflow of sending
// three or four near-identical individual emails to the same person —
// a pattern email lists every incident in one message and sets a
// clear expectation, which lands harder and creates less email noise.
//
// Lives at the top of the AttendanceView workspace because patterns
// outrank individual incidents in priority. Hidden when there are
// no repeat offenders in the window.
//
// Data source: attendance_violations table (last 30 days, retracted
// and superseded outcomes excluded). Refreshes on mount and via the
// manual refresh button. Auto-refresh on file uploads is handled by
// the parent passing a `refreshTick` prop.
// =============================================================================

// Severity styling — borderless soft pills so the table doesn't
// shout. Colour ramps match the rest of the portal: amber for
// pattern, coral for repeat, red for critical.
const SEVERITY_STYLE = {
  pattern: {
    label: 'Pattern',
    bg: '#FAEEDA', fg: '#854F0B',
    rowAccent: '#FAEEDA',
  },
  repeat: {
    label: 'Repeat',
    bg: '#FAECE7', fg: '#993C1D',
    rowAccent: '#FAECE7',
  },
  critical: {
    label: 'Critical',
    bg: '#FCEBEB', fg: '#A32D2D',
    rowAccent: '#FCEBEB',
  },
};

const TYPE_LABELS = {
  late: 'late arrival',
  early_leave: 'early leave',
  missed_in: 'missed in',
  missed_out: 'missed out',
};

function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtDateLong(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

// Build the type breakdown like "3 late, 1 missed-out" from the byType map.
function fmtTypeBreakdown(byType) {
  const parts = [];
  for (const [k, n] of Object.entries(byType)) {
    if (n > 0) parts.push(`${n} ${TYPE_LABELS[k] || k}`);
  }
  return parts.join(' · ');
}

// Build the consolidated pattern email — one message listing every
// incident with its date and type. Tone is firm but constructive.
// Manager goes on CC so the pattern is visible to them.
function patternEmailContent({ employee, offender, managerName }) {
  const psn = String(employee.id || '').toUpperCase();
  const fullName = String(employee.name || '').toUpperCase();
  const firstName = (employee.first_name || (employee.name || '').split(' ')[0] || '').trim();
  const greetName = firstName
    ? firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()
    : 'colleague';

  const sev = SEVERITY_STYLE[offender.severity] || SEVERITY_STYLE.pattern;
  const subjectPrefix = offender.severity === 'critical'
    ? 'Critical Attendance Pattern'
    : offender.severity === 'repeat'
    ? 'Repeat Attendance Issue'
    : 'Attendance Pattern Notice';
  const subject = subjectPrefix + ' \u2014 ' + psn + ' ' + fullName
    + ' \u2014 ' + offender.totalIncidents + ' incidents in '
    + offender.windowDays + ' days';

  // Per-incident lines, oldest first so the timeline reads naturally.
  const incidentLines = offender.dates.map(inc => {
    const types = Array.from(inc.types).map(t => TYPE_LABELS[t] || t).join(' + ');
    const mins = inc.minutesOff > 0 ? ` (${inc.minutesOff} min)` : '';
    return `\u2022 ${fmtDateLong(inc.date)} \u2014 ${types}${mins}`;
  }).join('\n');

  const divider = '='.repeat(71);
  const breakdown = fmtTypeBreakdown(offender.byType);

  // Tone scales with severity. Pattern = first conversation; repeat =
  // expectation reset with manager loop-in; critical = formal-warning
  // territory but still through manager-confirmation route.
  const opener = offender.severity === 'critical'
    ? `HR\u2019s attendance review identifies a critical pattern on your record. Over the last ${offender.windowDays} days, ${offender.totalIncidents} separate attendance incidents have been logged on your file (${breakdown}). The frequency and recency of these incidents place this on the formal-warning track and require an immediate review with your line manager and HR.`
    : offender.severity === 'repeat'
    ? `HR\u2019s attendance review flags a repeat issue on your record. Over the last ${offender.windowDays} days, ${offender.totalIncidents} attendance incidents have been logged (${breakdown}). The pattern is no longer isolated and requires a coordinated correction with your line manager.`
    : `HR\u2019s attendance review identifies a pattern on your record. Over the last ${offender.windowDays} days, ${offender.totalIncidents} attendance incidents have been logged (${breakdown}). Individual incidents have been emailed previously; this notice consolidates them and sets the expectation going forward.`;

  const closer = offender.severity === 'critical'
    ? 'Your line manager (copied on this email) will arrange a review meeting with HR within the next two working days. Please prepare to discuss each incident listed above and the corrective steps you will take to bring your attendance back into compliance.'
    : offender.severity === 'repeat'
    ? 'Please coordinate with your line manager (copied on this email) on a written correction plan within five working days. HR will follow up if no resolution is reached, and further incidents in this window will move the matter onto the formal-warning track.'
    : 'Please discuss the pattern with your line manager (copied on this email) and confirm the steps you will take to prevent further incidents. HR will continue to monitor the record over the next 30 days; further incidents will trigger a repeat-issue notice and may involve a coordinated correction plan.';

  const body =
    'Dear ' + greetName + ',\n\n' +
    opener + '\n\n' +
    'INCIDENTS LOGGED:\n' +
    divider + '\n' +
    incidentLines + '\n' +
    divider + '\n\n' +
    'As a reminder, according to the ESAU attendance policy:\n\n' +
    divider + '\n' +
    '\u2022 Punctuality and complete punch records are required on every working day.\n' +
    '\u2022 Repeated incidents within a 30-day window are treated as a behavioural pattern, not isolated occurrences.\n' +
    '\u2022 Patterns that do not improve after this notice escalate to formal corrective action.\n' +
    divider + '\n\n' +
    closer;
  return { subject, body };
}

function buildMailto({ to, cc, subject, body }) {
  const params = new URLSearchParams();
  if (cc) params.set('cc', Array.isArray(cc) ? cc.join(',') : cc);
  params.set('subject', subject);
  params.set('body', body);
  return 'mailto:' + (to || '') + '?' + params.toString();
}

export default function RepeatOffendersCard({
  empById,
  refreshTick,
  hrSignature,
  fixedCc = [],
  onLogPatternEmail, // optional — called after the email opens, for audit
}) {
  const [offenders, setOffenders] = useState([]);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState(null);
  const [expanded, setExpanded] = useState({});  // empId → bool
  const [collapsed, setCollapsed] = useState(false); // whole card collapse

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await loadRepeatOffenders({ threshold: 3, windowDays: 30 });
      setOffenders(list);
    } catch (e) {
      setError(String(e?.message || e));
      setOffenders([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshTick]);

  // Hide entirely when empty — no point taking page space for "no
  // repeat offenders this month" since the absence is the good case.
  if (!loading && offenders.length === 0 && !error) return null;

  const counts = useMemo(() => {
    const c = { pattern: 0, repeat: 0, critical: 0 };
    for (const o of offenders) {
      if (c[o.severity] !== undefined) c[o.severity]++;
    }
    return c;
  }, [offenders]);

  return (
    <div className="rounded-xl mb-4"
      style={{
        background: '#FFFFFF',
        border: '1px solid #EEEAE0',
        fontFamily: 'inherit',
      }}>
      {/* Header — title + severity counts + collapse toggle. */}
      <div className="flex items-center justify-between p-3 cursor-pointer"
        onClick={() => setCollapsed(c => !c)}>
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" style={{ color: '#993C1D' }}/>
          <div>
            <div className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
              Repeat offenders
              <span className="ml-2 text-[10px]" style={{ color: '#7A7A7A', fontWeight: 500 }}>
                {offenders.length} staff \u00b7 last 30 days
              </span>
            </div>
            {offenders.length > 0 && (
              <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                {counts.critical > 0 && (
                  <span className="text-[10px] px-1.5 py-px rounded"
                    style={{ background: SEVERITY_STYLE.critical.bg, color: SEVERITY_STYLE.critical.fg, fontWeight: 600 }}>
                    {counts.critical} critical
                  </span>
                )}
                {counts.repeat > 0 && (
                  <span className="text-[10px] px-1.5 py-px rounded"
                    style={{ background: SEVERITY_STYLE.repeat.bg, color: SEVERITY_STYLE.repeat.fg, fontWeight: 600 }}>
                    {counts.repeat} repeat
                  </span>
                )}
                {counts.pattern > 0 && (
                  <span className="text-[10px] px-1.5 py-px rounded"
                    style={{ background: SEVERITY_STYLE.pattern.bg, color: SEVERITY_STYLE.pattern.fg, fontWeight: 600 }}>
                    {counts.pattern} pattern
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); load(); }}
            disabled={loading}
            className="text-[10px] px-2 py-1 rounded transition-colors"
            style={{
              border: '1px solid #EEEAE0',
              color: '#7A7A7A',
              background: '#FFFFFF',
              cursor: loading ? 'wait' : 'pointer',
            }}>
            <RefreshCw className="w-3 h-3 inline-block mr-1" style={{ opacity: loading ? 0.5 : 1 }}/>
            Refresh
          </button>
          {collapsed ? <ChevronRight className="w-4 h-4" style={{ color: '#7A7A7A' }}/> : <ChevronDown className="w-4 h-4" style={{ color: '#7A7A7A' }}/>}
        </div>
      </div>

      {!collapsed && (
        <div style={{ borderTop: '1px solid #EEEAE0' }}>
          {error && (
            <div className="px-3 py-2 text-[11px]" style={{ color: '#A32D2D' }}>
              Could not load: {error}
            </div>
          )}
          {loading && offenders.length === 0 && (
            <div className="px-3 py-3 text-[11px]" style={{ color: '#7A7A7A' }}>
              Loading\u2026
            </div>
          )}
          {offenders.map((o, idx) => {
            const employee = empById[o.employeeId] || { id: o.employeeId, name: o.employeeId };
            const sev = SEVERITY_STYLE[o.severity] || SEVERITY_STYLE.pattern;
            const isExpanded = !!expanded[o.employeeId];
            const managerEmail = empById[String(employee.manager_id || '').toUpperCase()]?.email || null;
            const managerName  = empById[String(employee.manager_id || '').toUpperCase()]?.name  || null;

            return (
              <div key={o.employeeId}
                style={{
                  borderTop: idx === 0 ? 'none' : '1px solid #EEEAE0',
                  borderLeft: '3px solid ' + sev.rowAccent,
                  padding: '10px 12px 10px 9px',
                }}>
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] px-1.5 py-px rounded"
                        style={{ background: sev.bg, color: sev.fg, fontWeight: 600 }}>
                        {sev.label}
                      </span>
                      <span className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
                        {employee.name}
                      </span>
                      <span className="text-[10px]" style={{ color: '#7A7A7A', fontFamily: 'monospace' }}>
                        {o.employeeId}
                      </span>
                    </div>
                    <div className="text-[10px] mt-1" style={{ color: '#0A0A0A' }}>
                      <strong style={{ fontWeight: 600 }}>{o.totalIncidents} incidents</strong>
                      <span style={{ color: '#7A7A7A' }}>
                        {' \u00b7 '}{fmtTypeBreakdown(o.byType)}
                        {' \u00b7 '}{fmtDateShort(o.firstDate)} \u2192 {fmtDateShort(o.lastDate)}
                      </span>
                    </div>
                    {isExpanded && (
                      <ul className="mt-2 space-y-0.5">
                        {o.dates.map(inc => (
                          <li key={inc.date} className="text-[10px]" style={{ color: '#0A0A0A' }}>
                            <span style={{ color: '#7A7A7A' }}>\u2022 </span>
                            {fmtDateLong(inc.date)}
                            <span style={{ color: '#7A7A7A' }}>
                              {' \u2014 '}
                              {Array.from(inc.types).map(t => TYPE_LABELS[t] || t).join(' + ')}
                              {inc.minutesOff > 0 && ` (${inc.minutesOff} min)`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      onClick={() => setExpanded(prev => ({ ...prev, [o.employeeId]: !prev[o.employeeId] }))}
                      className="text-[10px] px-2 py-1 rounded"
                      style={{
                        border: '1px solid #EEEAE0',
                        color: '#7A7A7A',
                        background: '#FFFFFF',
                      }}>
                      {isExpanded ? 'Hide' : 'View dates'}
                    </button>
                    {employee.email && (
                      <button
                        onClick={() => {
                          const { subject, body } = patternEmailContent({ employee, offender: o, managerName });
                          const cc = [managerEmail, ...fixedCc].filter(Boolean);
                          const url = buildMailto({
                            to: employee.email,
                            cc,
                            subject,
                            body: body + '\n\n' + (hrSignature || ''),
                          });
                          window.location.href = url;
                          if (typeof onLogPatternEmail === 'function') {
                            onLogPatternEmail(o);
                          }
                        }}
                        className="text-[10px] px-2 py-1 rounded inline-flex items-center gap-1"
                        style={{
                          background: sev.bg, color: sev.fg, fontWeight: 600,
                          border: 'none', cursor: 'pointer',
                        }}>
                        <Mail className="w-3 h-3"/>
                        Pattern email
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
