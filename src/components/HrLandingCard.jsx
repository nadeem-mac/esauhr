import React, { useEffect, useMemo, useState } from 'react';
import {
  Cake, Award, Plane, CalendarCheck, AlertCircle, ClipboardList,
  Heart, FileWarning, ShieldAlert, TrendingUp, ArrowRight, Sparkles,
  Loader2, MapPin, Inbox, Palmtree,
} from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import { monthsOfService, fmtDateShort } from '../lib/leaveLogic.js';
import { salutationFor } from '../lib/salutations.js';

// =============================================================================
// HrLandingCard
//
// Bashaier's editorial daily-digest card. Sits below the hero on the
// HR/admin Dashboard view and consolidates the three things she
// reaches for first every morning:
//
//   1. THIS WEEK     — human moments to acknowledge (anniversaries,
//                      public holidays, leave returns) so HR feels
//                      like HR, not a ticket queue
//   2. NEEDS ATTENTION — concrete action counts with click-through
//                      to the surface that owns each task (decisions,
//                      sick certs, evaluation escalations, compliance)
//   3. INSIGHTS      — last 7 days at a glance (decisions made,
//                      shift compliance trajectory, evaluation
//                      zone distribution)
//
// Designed as a single SCROLLABLE card with three internal sections,
// not three separate cards, so it reads as one cohesive briefing.
//
// Data sources (all kept lazy — load happens on mount, in parallel):
//   • employees       (passed in)
//   • leave_requests   (fetched here, this week's returns + starts)
//   • attendance_violations  (count for evaluation watch/review zones)
//   • leave_requests of stage='pending_certificate' (sick certs outstanding)
//
// Visual language: editorial. Serif headings, italic captions, generous
// whitespace, dept-accent dots only where they earn attention. No
// heavy gradient strips, no flat grids of identical tiles. Matches
// the rest of Bashaier's hero aesthetic. Nadeem 2026-05-17.
// =============================================================================

// KSA public holidays for 2026. Hardcoded because there's no single
// authoritative API for Saudi holidays and the official MoHRSD calendar
// is published as PDF. Eid dates are estimates pending moon-sighting;
// the actual dates are confirmed about a week out by Umm al-Qura.
// Update annually; the card filters to upcoming-only so past entries
// are silently dropped.
const KSA_HOLIDAYS_2026 = [
  { date: '2026-02-22', name: 'Founding Day',          ar: 'يوم التأسيس' },
  { date: '2026-03-20', name: 'Eid al-Fitr (est.)',    ar: 'عيد الفطر',     est: true },
  { date: '2026-05-27', name: 'Eid al-Adha (est.)',    ar: 'عيد الأضحى',    est: true },
  { date: '2026-09-23', name: 'Saudi National Day',    ar: 'اليوم الوطني' },
];

// Add 2027 candidates so countdown still works in late Dec.
const KSA_HOLIDAYS_2027 = [
  { date: '2027-02-22', name: 'Founding Day',          ar: 'يوم التأسيس' },
  { date: '2027-03-09', name: 'Eid al-Fitr (est.)',    ar: 'عيد الفطر',     est: true },
];

const ALL_HOLIDAYS = [...KSA_HOLIDAYS_2026, ...KSA_HOLIDAYS_2027];

function startOfWeek(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  // ISO Sunday-week (Saudi work week starts Sun). Sunday = 0.
  x.setDate(x.getDate() - x.getDay());
  return x;
}

function endOfWeek(d) {
  const s = startOfWeek(d);
  const e = new Date(s);
  e.setDate(e.getDate() + 6);
  return e;
}

function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

// Reuse a single 'today midnight' so all the proximity comparisons
// in this card use the same reference point (otherwise '5 days from
// now' could land on the wrong calendar day when we cross midnight
// mid-render).
function todayMidnight() {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

// Build the list of anniversaries falling between today and `daysAhead`
// days from now. Returns rows enriched with { employee, milestone,
// daysFromNow } sorted ascending so 'today' rows surface first.
function anniversariesInRange(employees, daysAhead = 14) {
  const t = todayMidnight();
  const horizon = new Date(t);
  horizon.setDate(horizon.getDate() + daysAhead);

  const rows = [];
  for (const emp of (employees || [])) {
    if (!emp?.join_date) continue;
    const j = new Date(emp.join_date);
    if (isNaN(j)) continue;
    // The anniversary this calendar year, or next if it's already passed.
    const anniv = new Date(t.getFullYear(), j.getMonth(), j.getDate());
    if (anniv < t) anniv.setFullYear(t.getFullYear() + 1);
    if (anniv > horizon) continue;

    const yearsCompleted = anniv.getFullYear() - j.getFullYear();
    // Skip the first year — that's 'just joined', not an anniversary
    // worth celebrating yet. From year 1 onward we count it.
    if (yearsCompleted < 1) continue;

    rows.push({
      employee: emp,
      yearsCompleted,
      anniversaryDate: anniv,
      daysFromNow: daysBetween(t, anniv),
      // 5-year and 10-year are special — annual leave bumps at 5 (21 → 30)
      // and 10 is long-service. Highlight those in the UI.
      milestone: yearsCompleted === 5 || yearsCompleted === 10 || yearsCompleted % 5 === 0,
    });
  }
  rows.sort((a, b) => a.daysFromNow - b.daysFromNow);
  return rows;
}

// Upcoming holidays. Returns those within `daysAhead`, but always
// surfaces at least the next one so the card never falsely reads
// "None" when the next holiday is just beyond the window.
function upcomingHolidays(daysAhead = 120) {
  const t = todayMidnight();
  const horizon = new Date(t);
  horizon.setDate(horizon.getDate() + daysAhead);
  const future = ALL_HOLIDAYS
    .map(h => ({ ...h, dateObj: new Date(h.date), daysFromNow: daysBetween(t, new Date(h.date)) }))
    .filter(h => h.dateObj >= t)
    .sort((a, b) => a.daysFromNow - b.daysFromNow);
  const within = future.filter(h => h.dateObj <= horizon);
  return within.length ? within : future.slice(0, 1);
}

// ─── card ─────────────────────────────────────────────────────────────

export default function HrLandingCard({
  me,
  employees = [],
  requests = [],
  permissions = [],
  leaveTypes = [],
  headcount = null,
  onGoToReviews,
  onGoToAttendance,
}) {
  // Internal fetches — kept lazy so the page hero paints first.
  const [pendingCertCount, setPendingCertCount]   = useState(null);
  const [evalZoneCounts, setEvalZoneCounts]       = useState(null);
  const [loading, setLoading]                     = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const month = new Date().toISOString().slice(0, 7);
        const [certs, viols] = await Promise.all([
          directGet('leave_requests',
            `select=id,employee_id&stage=eq.pending_certificate`,
            { timeoutMs: 8000 }).catch(() => []),
          directGet('attendance_violations',
            `select=employee_id,violation_type,minutes_off`
            + `&violation_date=gte.${month}-01&cleared_at=is.null`,
            { timeoutMs: 10000 }).catch(() => []),
        ]);
        if (cancelled) return;
        setPendingCertCount(Array.isArray(certs) ? certs.length : 0);

        // Roll up violations into evaluation zones (mirrors the
        // BashaierTasksCard logic — same source of truth). Computed
        // inline because we only need counts here, not the full
        // per-employee breakdown.
        if (Array.isArray(viols)) {
          const byEmp = new Map();
          for (const v of viols) {
            if (!v?.employee_id) continue;
            const arr = byEmp.get(v.employee_id) || [];
            arr.push(v);
            byEmp.set(v.employee_id, arr);
          }
          let watch = 0, review = 0, chronic = 0; // chronic future-proofing
          for (const [, rows] of byEmp) {
            // Lightweight version of summariseViolations to avoid an
            // extra import — same weight table.
            let d = 0;
            for (const v of rows) {
              const m = Math.abs(Number(v.minutes_off) || 0);
              if (v.violation_type === 'unauthorized_absence') d += 5;
              else if (v.violation_type === 'missed_out')      d += 3;
              else if (v.violation_type === 'missed_in')       d += 2;
              else if (v.violation_type === 'late')            d += m > 30 ? 3 : 2;
              else if (v.violation_type === 'early' || v.violation_type === 'early_leave') d += m > 30 ? 3 : 1;
              else                                              d += 1;
            }
            if (d >= 10)     review += 1;
            else if (d >= 5) watch += 1;
          }
          setEvalZoneCounts({ watch, review, chronic });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Derived rows (cheap — memoised so a parent re-render doesn't churn).
  const anniversaries = useMemo(() => anniversariesInRange(employees, 14), [employees]);
  const holidays      = useMemo(() => upcomingHolidays(60), []);

  // Leave returns this week (people coming back) + starts this week.
  // We re-derive from the passed-in requests array so the card sees
  // exactly the same data the rest of the dashboard does — no extra
  // round-trip, no risk of drift between two views.
  // Leave returns + starts in the next 14 days (matches the anniversaries
  // window) so the card shows upcoming moments, not just the tail of the
  // current week. (Nadeem 2026-06-12)
  const { returnsThisWeek, startsThisWeek } = useMemo(() => {
    const today = todayMidnight();
    const windowEnd = new Date(today);
    windowEnd.setDate(windowEnd.getDate() + 14);
    const r = [];
    const s = [];
    for (const req of (requests || [])) {
      if (req.stage !== 'approved') continue;
      const start = req.start_date ? new Date(req.start_date) : null;
      const end   = req.end_date   ? new Date(req.end_date)   : start;
      if (!start) continue;
      // 'Returning' = still out, ends within the window AND not yet rejoined.
      if (end >= today && end <= windowEnd && req.return_stage !== 'approved') {
        r.push({ req, returnDate: new Date(new Date(end).getTime() + 86400000) });
      }
      if (start >= today && start <= windowEnd) {
        s.push({ req, startDate: start });
      }
    }
    return {
      returnsThisWeek: r.sort((a,b) => a.returnDate - b.returnDate),
      startsThisWeek:  s.sort((a,b) => a.startDate  - b.startDate),
    };
  }, [requests]);

  // Lookup for nice leave-type names + colours (the standalone "Out of
  // office today" tile used to own this; folded in here so it lives once).
  const typeMap = useMemo(() => {
    const m = {};
    for (const t of (leaveTypes || [])) m[t.id] = t;
    return m;
  }, [leaveTypes]);

  // Who is out RIGHT NOW (approved leave spanning today, not yet rejoined).
  // This is the one piece the old three-tile strip had that Moments didn't.
  const outToday = useMemo(() => {
    const today = todayMidnight();
    const rows = [];
    for (const req of (requests || [])) {
      if (req.stage !== 'approved') continue;
      if (req.return_stage === 'approved') continue;       // already back
      const start = req.start_date ? new Date(req.start_date) : null;
      const end   = req.end_date   ? new Date(req.end_date)   : start;
      if (!start || !end) continue;
      if (start <= today && end >= today) {
        const emp = (employees || []).find(e => e.id === req.employee_id);
        const tp  = typeMap[req.leave_type_id];
        rows.push({
          key: req.id,
          emp: emp || { id: req.employee_id, name: req.employee_id },
          typeName: tp?.name || req.leave_type_id || 'Leave',
          color: tp?.color || '#0E7490',
          endDate: end,
        });
      }
    }
    return rows.sort((a, b) => a.endDate - b.endDate);
  }, [requests, employees, typeMap]);

  // Pending decision count — same source as the hero's pending count
  // for consistency. Filtered to actual approval-required stages so
  // 'pending_certificate' (which is its own queue) doesn't double-count.
  const pendingDecisions = useMemo(() => {
    return (requests || []).filter(r =>
      r.stage === 'pending' ||
      r.stage === 'pending_manager' ||
      r.stage === 'pending_hr'
    ).length;
  }, [requests]);

  // Full list behind the PENDING chip — revealed inline when she taps it.
  const pendingList = useMemo(() => {
    return (requests || [])
      .filter(r => r.stage === 'pending' || r.stage === 'pending_manager' || r.stage === 'pending_hr')
      .map(r => {
        const emp = (employees || []).find(e => e.id === r.employee_id);
        const tp  = typeMap[r.leave_type_id];
        return {
          key: r.id,
          name: emp?.name || r.employee_id,
          typeName: tp?.name || r.leave_type_id || 'Leave',
          color: tp?.color || '#C2410C',
          days: r.days,
          date: r.start_date ? fmtDateShort(r.start_date) : '',
          stageLabel: r.stage === 'pending_manager' ? 'Manager' : r.stage === 'pending_hr' ? 'HR' : 'New',
        };
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [requests, employees, typeMap]);
  const [showPending, setShowPending] = useState(false);

  // Empty-state shorthand — when there's literally nothing in any of
  // the four life-event categories AND no actions, we collapse the
  // card to a single warm line rather than show a wall of zero rows.
  const hasLifeEvents = anniversaries.length > 0 || holidays.length > 0
                      || returnsThisWeek.length > 0 || startsThisWeek.length > 0;
  const hasActions    = pendingDecisions > 0
                      || (pendingCertCount ?? 0) > 0
                      || (evalZoneCounts?.watch || 0) + (evalZoneCounts?.review || 0) > 0;

  // ─── render ────────────────────────────────────────────────────────
  return (
    <section
      className="rounded-2xl"
      style={{
        background: '#FFFFFF',
        border: '1px solid var(--border-soft, #E8E5D8)',
        padding: 0,
        overflow: 'hidden',
      }}
    >
      {/* ── THIS WEEK ─────────────────────────────────────────────── */}
      <div className="px-6 py-5 sm:px-8 sm:py-6" style={{ borderBottom: '1px solid #F4F4EE' }}>
        <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
          <div>
            <div className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.3em', fontWeight: 700 }}>
              — THIS WEEK
            </div>
            <h2 className="serif" style={{
              fontSize: '22px', color: '#1F1B16', marginTop: '4px',
              fontWeight: 500, letterSpacing: '-0.01em',
            }}>
              Moments to acknowledge
            </h2>
          </div>
          {hasLifeEvents && (
            <div className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
              {[
                anniversaries.length > 0   && `${anniversaries.length} anniversar${anniversaries.length === 1 ? 'y' : 'ies'}`,
                holidays.length > 0        && `${holidays.length} upcoming holiday${holidays.length === 1 ? '' : 's'}`,
                returnsThisWeek.length > 0 && `${returnsThisWeek.length} return${returnsThisWeek.length === 1 ? '' : 's'}`,
                startsThisWeek.length > 0  && `${startsThisWeek.length} leave start${startsThisWeek.length === 1 ? '' : 's'}`,
              ].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>

        {!hasLifeEvents ? (
          <p className="text-[13px]" style={{ color: '#1F1B16', opacity: 0.7, fontStyle: 'italic' }}>
            A quiet week. No anniversaries, returns, or holidays in the next seven days — a good window to catch up on the things that always wait.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <LifeEventColumn
              icon={Award}
              accent="#A16207"
              label="ANNIVERSARIES"
              empty="None this week"
              items={anniversaries.slice(0, 3).map(a => ({
                key:   a.employee.id,
                title: salutationFor(a.employee),
                sub:   a.yearsCompleted === 5
                          ? `5 years on ${fmtDateShort(a.anniversaryDate)} · leave bumps to 30 days`
                          : a.yearsCompleted === 10
                            ? `10 years on ${fmtDateShort(a.anniversaryDate)} · long-service milestone`
                            : `${a.yearsCompleted} years on ${fmtDateShort(a.anniversaryDate)}`,
                badge: a.daysFromNow === 0 ? 'TODAY' : a.daysFromNow === 1 ? 'TOMORROW' : `IN ${a.daysFromNow}D`,
                special: a.milestone,
              }))}
            />
            <LifeEventColumn
              icon={CalendarCheck}
              accent="#0E7490"
              label="NEXT HOLIDAY"
              empty="None scheduled"
              items={holidays.slice(0, 1).map(h => ({
                key:   h.date,
                title: h.name,
                sub:   `${new Date(h.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}${h.est ? ' · pending moon-sighting' : ''}`,
                badge: h.daysFromNow === 0 ? 'TODAY' : `IN ${h.daysFromNow}D`,
              }))}
            />
            <LifeEventColumn
              icon={Plane}
              accent="#0F4C2A"
              label="RETURNING"
              empty="No one returning"
              items={returnsThisWeek.slice(0, 3).map(r => {
                const emp = (employees || []).find(e => e.id === r.req.employee_id);
                return {
                  key:   r.req.id,
                  title: salutationFor(emp || { name: r.req.employee_id }),
                  sub:   `Back ${fmtDateShort(r.returnDate)} · ${r.req.leave_type_id || 'leave'}`,
                  badge: daysBetween(todayMidnight(), r.returnDate) === 0 ? 'TODAY' :
                         daysBetween(todayMidnight(), r.returnDate) === 1 ? 'TOMORROW' :
                         `IN ${daysBetween(todayMidnight(), r.returnDate)}D`,
                };
              })}
            />
            <LifeEventColumn
              icon={Sparkles}
              accent="#7C2D12"
              label="LEAVE STARTING"
              empty="No leaves starting"
              items={startsThisWeek.slice(0, 3).map(s => {
                const emp = (employees || []).find(e => e.id === s.req.employee_id);
                const d = daysBetween(todayMidnight(), s.startDate);
                return {
                  key:   s.req.id,
                  title: salutationFor(emp || { name: s.req.employee_id }),
                  sub:   `Out ${fmtDateShort(s.startDate)} · ${s.req.leave_type_id || 'leave'} · ${s.req.days || '?'}d`,
                  badge: d === 0 ? 'TODAY' : d === 1 ? 'TOMORROW' : `IN ${d}D`,
                };
              })}
            />
          </div>
        )}
      </div>

      {/* ── OUT OF OFFICE TODAY ───────────────────────────────────── */}
      {outToday.length > 0 && (
        <div className="px-6 py-4 sm:px-8 sm:py-5" style={{ borderBottom: '1px solid #F4F4EE' }}>
          <div className="flex items-center gap-2 mb-3">
            <Palmtree className="w-3.5 h-3.5" style={{ color: '#0E7490' }} />
            <span className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.18em', fontWeight: 700 }}>
              OUT OF OFFICE TODAY
            </span>
            <span className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.5 }}>
              · {outToday.length} {outToday.length === 1 ? 'person' : 'people'}
            </span>
          </div>
          {outToday.length > 4 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {outToday.map(o => (
                <div
                  key={o.key}
                  title={`${o.emp.name} · ${o.typeName} · until ${fmtDateShort(o.endDate)}`}
                  className="flex-shrink-0 rounded-full flex items-center justify-center transition-transform hover:-translate-y-0.5"
                  style={{ width: 32, height: 32, background: '#FBEAF0', color: '#993556', fontSize: 11, fontWeight: 600, cursor: 'default' }}
                >
                  {initials(o.emp.name)}
                </div>
              ))}
            </div>
          ) : (
            <ul className="space-y-1">
              {outToday.map(o => <OutTodayRow key={o.key} o={o} />)}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// ─── sub-components ───────────────────────────────────────────────────

function LifeEventColumn({ icon: Icon, accent, label, empty, items }) {
  return (
    <div
      className="rounded-xl p-3.5 transition-all hover:-translate-y-0.5"
      style={{ background: '#FFFFFF', border: '1px solid #ECEAE0' }}
    >
      <div className="flex items-center gap-2 mb-2.5">
        <span
          className="flex items-center justify-center rounded-lg flex-shrink-0"
          style={{ width: 24, height: 24, background: `${accent}14` }}
        >
          <Icon className="w-3.5 h-3.5" style={{ color: accent }} />
        </span>
        <span className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.14em', fontWeight: 700 }}>
          {label}
        </span>
      </div>
      {items.length === 0 ? (
        <div className="text-[12px]" style={{ color: '#1F1B16', opacity: 0.45, fontStyle: 'italic' }}>
          {empty}
        </div>
      ) : (
        <ul className="space-y-2.5">
          {items.map(it => (
            <li key={it.key}>
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-[13px] truncate" style={{ color: '#1F1B16', fontWeight: 500 }}>
                  {it.title}
                </div>
                <div className="text-[9px] flex-shrink-0"
                     style={{
                       color: accent,
                       background: it.special ? `${accent}1A` : 'transparent',
                       padding: it.special ? '1px 6px' : 0,
                       borderRadius: 999,
                       fontWeight: 700,
                       letterSpacing: '0.06em',
                     }}>
                  {it.badge}
                </div>
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.7 }}>
                {it.sub}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActionPill({ label, count, loading, icon: Icon, accentDark, accentTint, caption, onClick }) {
  const isZero = count === 0;
  const isPending = loading && (count === null || count === undefined);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isZero || isPending}
      className={`text-left rounded-xl p-4 transition-all ${(count === 0) ? '' : 'hover:-translate-y-0.5'}`}
      style={{
        background: isZero ? '#F8F8F2' : accentTint,
        border: `1px solid ${isZero ? 'var(--border-soft, #E8E5D8)' : accentDark}33`,
        cursor: (isZero || isPending) ? 'default' : 'pointer',
        opacity: isPending ? 0.6 : 1,
      }}
    >
      <div className="flex items-start justify-between mb-2">
        <Icon className="w-4 h-4" style={{ color: isZero ? '#9CA3AF' : accentDark }} />
        {!isZero && !isPending && onClick && (
          <ArrowRight className="w-3.5 h-3.5" style={{ color: accentDark, opacity: 0.7 }} />
        )}
      </div>
      <div className="text-[10px]" style={{
        color: '#1F1B16', letterSpacing: '0.16em', fontWeight: 700,
      }}>
        {label}
      </div>
      <div className="serif mt-1" style={{
        fontSize: '32px', lineHeight: 1, color: isZero ? '#9CA3AF' : accentDark,
        fontWeight: 500, letterSpacing: '-0.02em',
      }}>
        {isPending ? <Loader2 className="w-7 h-7 animate-spin inline" style={{ color: accentDark }} /> : (count ?? 0)}
      </div>
      <div className="text-[11px] mt-1" style={{ color: '#1F1B16', opacity: 0.7 }}>
        {caption}
      </div>
    </button>
  );
}

// ─── glance + out-today sub-components ─────────────────────────────────
function initials(name) {
  const p = String(name || '').trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || '?';
}

// Compact stat chip for the AT A GLANCE strip. Lifts + greens its border
// on hover; shows a count, an optional caption, and either navigates or
// (for PENDING) toggles an inline list. linkOnly chips show an arrow
// instead of a number (e.g. SHIFT → open Attendance).
function GlanceChip({ value, label, color, caption, onClick, active, loading, linkOnly }) {
  const isNull = value === null || value === undefined;
  const isZero = value === 0;
  const tone   = (!linkOnly && (isZero || (isNull && !loading))) ? '#9CA3AF' : color;
  return (
    <button
      type="button"
      onClick={onClick}
      className="text-left rounded-xl px-3 py-2.5 border transition-all hover:-translate-y-0.5 hover:bg-[#F6FAF4]"
      style={{
        background: active ? '#F6FAF4' : '#FFFFFF',
        borderColor: active ? '#0F4C2A' : '#E8E5D8',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div className="flex items-center gap-1.5" style={{ minHeight: 22 }}>
        {linkOnly ? (
          <ArrowRight className="w-5 h-5" style={{ color }} />
        ) : loading ? (
          <Loader2 className="w-4 h-4 animate-spin" style={{ color }} />
        ) : (
          <span className="serif" style={{ fontSize: '21px', lineHeight: 1, fontWeight: 600, color: tone }}>
            {isNull ? '–' : value}
          </span>
        )}
      </div>
      <div className="text-[10px] mt-1" style={{ color: '#1F1B16', letterSpacing: '0.08em', fontWeight: 700 }}>
        {label}
      </div>
      {caption && (
        <div className="text-[10px] mt-0.5 truncate" style={{ color: '#1F1B16', opacity: 0.55 }}>
          {caption}
        </div>
      )}
    </button>
  );
}

// One person currently on leave — initials avatar, name, dept·loc, and a
// type pill with the return date. Row highlights on hover.
function OutTodayRow({ o }) {
  return (
    <li className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-[#F4F4EE]">
      <div
        className="flex-shrink-0 rounded-full flex items-center justify-center"
        style={{ width: 28, height: 28, background: '#FBEAF0', color: '#993556', fontSize: 11, fontWeight: 600 }}
      >
        {initials(o.emp.name)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] truncate" style={{ color: '#1F1B16', fontWeight: 500 }}>{o.emp.name}</div>
        <div className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
          {[o.emp.department, o.emp.location].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="text-right flex-shrink-0">
        <span
          className="text-[10px]"
          style={{ fontWeight: 600, color: o.color, background: `${o.color}1A`, padding: '2px 8px', borderRadius: 999 }}
        >
          {o.typeName}
        </span>
        <div className="text-[11px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.6 }}>
          until {fmtDateShort(o.endDate)}
        </div>
      </div>
    </li>
  );
}
