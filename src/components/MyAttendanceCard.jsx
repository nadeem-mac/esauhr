import React, { useEffect, useState, useMemo } from 'react';
import { Clock, AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Calendar } from 'lucide-react';
import { directGet } from '../supabaseClient.js';

// ─────────────────────────────────────────────────────────────────────────
// MyAttendanceCard
//
// Self-service attendance view for staff. Pulls violations recorded by
// Bashaier from the attendance_violations table and surfaces them on
// the staff member's personal dashboard so they can:
//   • See their own track record without asking HR
//   • Spot patterns (always Monday, always 5–10 min late)
//   • Recognise when they're approaching the 5-per-month review
//     threshold before HR has to flag it
//
// Read-only — every row is informational. Does not show emails sent
// or expose Bashaier's notes, just the bare facts: date, type,
// minutes off, punch time. Anyone with the attendance escalation
// already has the email; this card is a record reflection.
//
// Visible to all signed-in staff. Auto-hides when there are zero
// violations on file (no signal, no card).
// ─────────────────────────────────────────────────────────────────────────

const TYPE_LABELS = {
  late:        { label: 'Late arrival',         color: '#BE123C', tint: '#FEF2F2', icon: Clock },
  early_leave: { label: 'Early departure',      color: '#A16207', tint: '#FEFCE8', icon: Clock },
  missed_in:   { label: 'Missing punch-in',     color: '#1D4ED8', tint: '#EFF6FF', icon: AlertTriangle },
  missed_out:  { label: 'Missing punch-out',    color: '#1D4ED8', tint: '#EFF6FF', icon: AlertTriangle },
};

export default function MyAttendanceCard({ me }) {
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  // Logged evaluation score for the current calendar month, when one
  // exists. Pulled from the evaluation_scores_final view so the
  // final_score (base_score - attendance_deduction) comes straight
  // from the DB rather than being computed in JS — keeps the UI in
  // sync with whatever math the view is doing.
  const [monthScore, setMonthScore] = useState(null);

  // Pull the current-month evaluation score row, if HR has logged
  // one. Most staff (0–5 incidents) won't have a row — that's the
  // "within policy" case and we don't display anything for it. A
  // row only exists once Bashaier has reviewed and logged a
  // deduction (>5 incidents in the month).
  useEffect(() => {
    if (!me?.id) { setMonthScore(null); return; }
    let cancelled = false;
    const now = new Date();
    const periodYear  = now.getFullYear();
    const periodMonth = now.getMonth() + 1;
    (async () => {
      try {
        const data = await directGet(
          'evaluation_scores_final?select=violation_count,base_score,attendance_deduction,final_score,reviewed_at'
          + '&employee_id=eq.' + encodeURIComponent(me.id)
          + '&period_year=eq.' + periodYear
          + '&period_month=eq.' + periodMonth
          + '&limit=1'
        );
        if (!cancelled) setMonthScore((data && data[0]) || null);
      } catch (e) {
        // View may not exist on older DBs — degrade silently. The
        // attendance pill above still works without it.
        console.warn('[MyAttendance] evaluation_scores_final fetch failed:', e?.message || e);
        if (!cancelled) setMonthScore(null);
      }
    })();
    return () => { cancelled = true; };
  }, [me?.id]);

  // Pull this employee's last 90 days of attendance violations. 90 days
  // gives enough history to spot patterns ('every Monday') without
  // overwhelming the card. Older data is pruned at the eval-deduction
  // monthly cycle anyway.
  useEffect(() => {
    if (!me?.id) { setRows([]); setLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const cutoffIso = cutoff.toISOString().slice(0, 10);
        const data = await directGet(
          'attendance_violations?select=id,violation_date,violation_type,minutes_off,punch_in_time,punch_out_time,scheduled_start,scheduled_end,recorded_at'
          + '&employee_id=eq.' + encodeURIComponent(me.id)
          + '&violation_date=gte.' + cutoffIso
          + '&cleared_at=is.null'
          + '&order=violation_date.desc'
        );
        if (!cancelled) setRows(data || []);
      } catch (e) {
        console.warn('[MyAttendance] fetch failed:', e?.message || e);
        if (!cancelled) setRows([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [me?.id]);

  // This-month summary — gives the staff member a quick "where do I
  // stand against the 5-per-month review threshold" signal. Counts
  // distinct (date) since two flags on the same day = 1 incident.
  const monthSummary = useMemo(() => {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const seenDates = new Set();
    rows.forEach(r => {
      if (r.violation_date >= monthStart) seenDates.add(r.violation_date);
    });
    return {
      count: seenDates.size,
      threshold: 5,
      monthLabel: now.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    };
  }, [rows]);

  // Type tally over the full 90-day window for the summary tiles.
  const typeTally = useMemo(() => {
    const tally = { late: 0, early_leave: 0, missed_in: 0, missed_out: 0 };
    rows.forEach(r => {
      if (tally[r.violation_type] !== undefined) tally[r.violation_type]++;
    });
    return tally;
  }, [rows]);

  // Auto-hide when there are zero rows AND we're not loading — staff
  // with a clean record don't need to see this card. If everything's
  // perfect we just don't add visual noise.
  if (loading) return null;
  if (rows.length === 0) return null;

  const visibleRows = expanded ? rows : rows.slice(0, 3);
  const isOverThreshold = monthSummary.count >= monthSummary.threshold;
  const isApproachingThreshold = monthSummary.count >= 3 && monthSummary.count < monthSummary.threshold;

  return (
    <section className="rounded-2xl border overflow-hidden mb-4"
      style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
      <div className="px-5 py-4 border-b flex items-start justify-between gap-3 flex-wrap"
           style={{ borderColor: 'var(--border-soft)' }}>
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-1" style={{ fontWeight: 700, color: '#0A0A0A' }}>
            MY ATTENDANCE · LAST 90 DAYS
          </div>
          <h3 className="serif" style={{ fontSize: '20px', color: '#0A0A0A', fontWeight: 500 }}>
            Your attendance record
          </h3>
          <div className="text-xs mt-1" style={{ color: '#0A0A0A' }}>
            Recorded by HR. Read-only — talk to HR if anything looks wrong.
          </div>
        </div>

        {/* Month threshold — the big visual cue. Three states:
            • Over: red, 'review threshold reached' wording
            • Approaching: amber, 'close to threshold'
            • Below: green, 'within company policy' */}
        <div className="rounded-xl px-3 py-2 text-right"
          style={{
            background: isOverThreshold ? '#FEE2E2' : isApproachingThreshold ? '#FEF3C7' : '#ECFDF5',
            border: '1px solid ' + (isOverThreshold ? '#FECACA' : isApproachingThreshold ? '#FDE68A' : '#A7F3D0'),
          }}>
          <div className="text-[9px] tracking-wider font-bold opacity-70" style={{ color: '#0A0A0A' }}>
            {monthSummary.monthLabel.toUpperCase()}
          </div>
          <div className="flex items-baseline gap-1 mt-0.5 justify-end">
            <span style={{
              fontSize: '22px', fontWeight: 700,
              color: isOverThreshold ? '#991B1B' : isApproachingThreshold ? '#92400E' : '#047857',
            }}>{monthSummary.count}</span>
            <span className="text-xs opacity-70" style={{ color: '#0A0A0A' }}>
              / {monthSummary.threshold}
            </span>
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.85 }}>
            {isOverThreshold     ? 'review threshold reached'
            : isApproachingThreshold ? 'close to threshold'
            :                          'within policy'}
          </div>
          {/* Logged evaluation score — shown only when HR has actually
              reviewed and recorded a deduction for this month. Reads
              from evaluation_scores_final (which computes
              base_score - attendance_deduction at the DB layer) so
              the staff member sees the same number that's on file.
              When no score row exists, the implied score is 100 and
              this line is suppressed — the threshold pill above
              already conveys the standing. */}
          {monthScore && (
            <div className="mt-1.5 pt-1.5 border-t" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
              <div className="text-[9px] tracking-wider font-bold opacity-70" style={{ color: '#0A0A0A' }}>
                LOGGED SCORE
              </div>
              <div className="flex items-baseline gap-1 mt-0.5 justify-end">
                <span style={{ fontSize: '18px', fontWeight: 700, color: '#0A0A0A' }}>
                  {monthScore.final_score != null
                    ? monthScore.final_score
                    : ((monthScore.base_score ?? 100) - (monthScore.attendance_deduction ?? 0))}
                </span>
                <span className="text-[10px] opacity-70" style={{ color: '#0A0A0A' }}>/ 100</span>
                <span className="text-[10px] ml-1 px-1.5 py-0.5 rounded"
                  style={{ background: '#FEE2E2', color: '#991B1B', fontWeight: 700 }}>
                  &minus;{monthScore.attendance_deduction ?? 0}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Type tiles — small grid showing 90-day breakdown. Hidden when
          all zero (impossible if we got past the early-return above,
          but defensive). */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 px-5 py-3"
        style={{ borderBottom: '1px solid var(--border-soft)' }}>
        {Object.entries(typeTally).map(([k, v]) => {
          const cfg = TYPE_LABELS[k];
          if (!cfg) return null;
          return (
            <div key={k} className="rounded-lg px-3 py-2"
              style={{ background: cfg.tint }}>
              <div className="text-[9px] tracking-wider font-bold opacity-70"
                style={{ color: '#0A0A0A' }}>
                {cfg.label.toUpperCase()}
              </div>
              <div style={{ fontSize: '20px', fontWeight: 700, color: cfg.color }}>{v}</div>
            </div>
          );
        })}
      </div>

      {/* Row list */}
      <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
        {visibleRows.map(r => {
          const cfg = TYPE_LABELS[r.violation_type] || { label: r.violation_type, color: '#1F1B16', icon: Clock };
          const Icon = cfg.icon;
          // Pretty date: 'Mon, 28 Apr 2026'
          const d = new Date(r.violation_date);
          const dateLabel = d.toLocaleDateString('en-GB', {
            weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
          });
          return (
            <li key={r.id} className="px-5 py-3 flex items-center gap-3 flex-wrap">
              <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: cfg.tint || '#F4F4EE' }}>
                <Icon className="w-4 h-4" style={{ color: cfg.color }}/>
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span style={{ fontWeight: 600, fontSize: '14px', color: '#0A0A0A' }}>
                    {dateLabel}
                  </span>
                  <span className="text-[10px] tracking-wider font-bold px-1.5 py-0.5 rounded"
                    style={{ background: cfg.tint, color: cfg.color }}>
                    {cfg.label.toUpperCase()}
                  </span>
                </div>
                <div className="text-xs mt-0.5" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                  {r.violation_type === 'late' && r.punch_in_time && (
                    <>Punched in at <span className="font-mono">{String(r.punch_in_time).slice(0,5)}</span>
                    {r.minutes_off ? ` — ${r.minutes_off} min after grace` : ''}</>
                  )}
                  {r.violation_type === 'early_leave' && r.punch_out_time && (
                    <>Punched out at <span className="font-mono">{String(r.punch_out_time).slice(0,5)}</span>
                    {r.minutes_off ? ` — ${r.minutes_off} min before scheduled end` : ''}</>
                  )}
                  {r.violation_type === 'missed_in'  && <>No punch-in recorded</>}
                  {r.violation_type === 'missed_out' && <>No punch-out recorded</>}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {/* Expand / collapse */}
      {rows.length > 3 && (
        <button type="button" onClick={() => setExpanded(v => !v)}
          className="w-full text-xs py-2.5 flex items-center justify-center gap-1 hover:bg-black/5 transition-colors"
          style={{ color: '#0A0A0A', opacity: 0.7 }}>
          {expanded ? (
            <><ChevronUp className="w-3.5 h-3.5"/> Show less</>
          ) : (
            <><ChevronDown className="w-3.5 h-3.5"/> Show all {rows.length} records</>
          )}
        </button>
      )}
    </section>
  );
}
