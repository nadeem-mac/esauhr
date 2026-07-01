// =============================================================================
// ShiftPlanReminder.jsx
//
// End-of-month banner shown on the manager's dashboard reminding them
// to plan upcoming shifts before the new month rolls over. Active
// during two windows:
//
//   • Day 25-31 of any month  →  remind about NEXT month's plan
//   • Day  1- 3 of any month  →  still grace period for THIS month
//                                (in case the late-month nudge was missed)
//
// Outside those windows the banner is silent. Inside them it checks the
// monthly_shift_plans tracker for each direct report — if any report is
// missing a saved plan for the target month, the banner shows.
//
// DISMISS BEHAVIOR
//   The X dismisses for the current calendar day only. Saved to
//   localStorage with the date in the key, so tomorrow's sign-in
//   shows the banner again if the manager still hasn't planned. This
//   matches the spec: "repeats until manager saves plan."
//
// ACTION
//   The "Open Planner" button calls the onOpenPlanner callback passed
//   in by ManagerDashboard, which AppShell wires up to switch the
//   manager's view to the Shifts tab. The target month is included in
//   the callback payload so the planner can preselect it.
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { Calendar, X, ArrowRight, Loader2 } from 'lucide-react';
import { directGet } from '../supabaseClient.js';

// Local YYYY-MM-DD without timezone offset surprises.
function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function ShiftPlanReminder({ me, directReports = [], onOpenPlanner }) {
  // ─── Window check ───────────────────────────────────────────────────
  // Decide whether today falls inside the reminder window AND which
  // month we should be nudging the manager about.
  const { inWindow, target } = useMemo(() => {
    const now = new Date();
    const day = now.getDate();
    // Fire whenever a plan is missing — any day, not only month-end.
    // From day 25 onward we nudge the NEXT month (plan ahead); earlier
    // in the month we nudge the CURRENT month so gaps are chased down
    // as soon as they exist. The banner still only renders when the
    // tracker shows a report with no saved plan (missing.length > 0).
    const t = day >= 25
      ? new Date(now.getFullYear(), now.getMonth() + 1, 1)
      : new Date(now.getFullYear(), now.getMonth(), 1);
    return { inWindow: true, target: t };
  }, []);

  const targetKey   = target ? ymd(target) : null;
  const targetLabel = target
    ? target.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    : '';

  // ─── Tracker fetch ──────────────────────────────────────────────────
  // For every direct report, check whether the manager has committed
  // a plan for the target month. The tracker is keyed by
  // (manager_id, employee_id, plan_month) so a single query covers
  // the whole team.
  const reportIds = directReports.map(r => r.id);
  const reportIdsKey = reportIds.join(',');
  const [missing, setMissing] = useState(null); // null = still loading
  useEffect(() => {
    if (!inWindow || !me?.id || reportIds.length === 0 || !targetKey) {
      setMissing([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'monthly_shift_plans',
          `select=employee_id` +
          `&manager_id=eq.${encodeURIComponent(me.id)}` +
          `&plan_month=eq.${targetKey}` +
          `&employee_id=in.(${encodeURIComponent(reportIdsKey)})`,
          { timeoutMs: 6000 }
        );
        if (cancelled) return;
        const planned = new Set((rows || []).map(r => r.employee_id));
        const m = directReports.filter(r => !planned.has(r.id));
        setMissing(m);
      } catch {
        // Non-fatal — if the fetch fails, hide the banner rather than
        // showing a broken state. Manager can still plan via the Shifts
        // tab manually.
        if (!cancelled) setMissing([]);
      }
    })();
    return () => { cancelled = true; };
    // reportIdsKey intentionally captures the joined PSN list so the
    // effect refires when the team membership changes.
  }, [inWindow, me?.id, targetKey, reportIdsKey, directReports]);

  // ─── Per-day dismiss state ─────────────────────────────────────────
  // Key includes today's local date so dismissing on Tuesday doesn't
  // suppress Wednesday's reminder.
  const dismissKey = useMemo(() => {
    const today = ymd(new Date());
    return `esau:shift-plan-reminder:dismissed:${targetKey || 'na'}:${today}`;
  }, [targetKey]);

  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(dismissKey) === '1'; }
    catch { return false; }
  });

  function handleDismiss() {
    setDismissed(true);
    try { localStorage.setItem(dismissKey, '1'); } catch {}
  }

  // ─── Render gate ────────────────────────────────────────────────────
  if (!inWindow) return null;
  if (dismissed) return null;
  if (missing === null) {
    // Still loading — render nothing rather than flashing a banner
    // and immediately hiding it. Quick fetch (<1s in normal cases).
    return null;
  }
  if (missing.length === 0) return null;

  // ─── Render ─────────────────────────────────────────────────────────
  const allMissing = missing.length === directReports.length;
  const pluralReports = missing.length === 1 ? 'report' : 'reports';
  const headlineLine = allMissing
    ? `No shifts planned for ${targetLabel} yet.`
    : `${missing.length} of your ${directReports.length} direct ${pluralReports} ${missing.length === 1 ? 'has' : 'have'} no plan for ${targetLabel}.`;

  return (
    <div
      className="rounded-xl flex items-start gap-3 p-4"
      style={{
        background: '#FFFBEB',
        border: '1px solid #FCD34D',
        color: '#1F1B16',
      }}
      role="status"
      aria-live="polite"
    >
      <div
        className="flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center"
        style={{ background: '#FCD34D', color: '#854F0B' }}
      >
        <Calendar className="w-5 h-5" />
      </div>

      <div className="flex-1 min-w-0">
        <div style={{ fontWeight: 700, fontSize: 14, color: '#1F1B16' }}>
          Plan {targetLabel} shifts
        </div>
        <div style={{ fontSize: 12, color: '#1F1B16', marginTop: 2 }}>
          {headlineLine}
          {missing.length > 0 && missing.length <= 4 && (
            <>
              {' '}
              <span style={{ opacity: 0.75 }}>
                Missing: {missing.map(r => r.name?.split(' ')?.[0] || r.id).join(', ')}.
              </span>
            </>
          )}
        </div>
        <div style={{ fontSize: 11, color: '#1F1B16', opacity: 0.65, marginTop: 4 }}>
          Enter shifts in the system so attendance is captured against the correct schedule. Staff must attend the shift you assign; no acknowledgment is required.
        </div>
      </div>

      <div className="flex-shrink-0 flex items-center gap-2">
        {onOpenPlanner && (
          <button
            onClick={() => onOpenPlanner({
              year:     target.getFullYear(),
              monthIdx: target.getMonth(),
            })}
            className="text-[12px] px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
            style={{
              background: '#0F4C2A',
              color: '#FFFFFF',
              fontWeight: 600,
              border: '1px solid #0F4C2A',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            Open Planner <ArrowRight className="w-3 h-3" />
          </button>
        )}
        <button
          onClick={handleDismiss}
          aria-label="Dismiss for today"
          title="Dismiss until tomorrow"
          className="w-7 h-7 rounded-full inline-flex items-center justify-center"
          style={{
            background: 'transparent',
            color: '#1F1B16',
            opacity: 0.55,
            border: 'none',
            cursor: 'pointer',
          }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
