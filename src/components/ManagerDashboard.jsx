import React, { useEffect, useState, useMemo, useCallback } from 'react';
import { directGet, supabase } from '../supabaseClient.js';
import {
  Users, Plane, Clock, AlertTriangle, CheckCircle2, ChevronRight, Calendar,
} from 'lucide-react';
import { fmtDate, fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';

// ────────────────────────────────────────────────────────────────────────────
// ManagerDashboard
// Shown to anyone who has direct reports (employees with manager_id === me.id)
// AND is not admin / HR-reviewer. Same shell for every manager — Sadakathullah,
// Zaher, Mohammad Sharique, Haider, Fahad. They each see only the team that
// reports to them, never the full company.
//
// What the manager sees:
//   • A greeting with their first name
//   • Their team list (direct reports) with avatars and departments
//   • Pending intermediate approvals — leave requests at stage='pending_manager'
//     from a direct report. Clicking takes them to the Reviews tab where the
//     existing ReviewerPanel handles the actual approve/reject action.
//   • Out-of-office today — direct reports currently on approved leave
//   • Upcoming leaves — next 8 approved leaves of direct reports
//
// What the manager DOES NOT see:
//   • Full company headcount, other departments, all-staff leave totals
//   • The HR-only Bashaier tasks card, evaluation deductions, etc.
//   • Admin actions (PIN reset, employee management, system settings)
// ────────────────────────────────────────────────────────────────────────────

export default function ManagerDashboard({ me, employees, onGoToReviews, onGoToRequests }) {
  const [requests, setRequests] = useState([]);
  const [shifts, setShifts]     = useState([]);
  const [loading, setLoading]   = useState(true);

  // Direct reports — the team this manager owns
  const directReports = useMemo(
    () => (employees || []).filter(e => e.manager_id === me?.id),
    [employees, me?.id]
  );
  const reportIds = useMemo(() => directReports.map(e => e.id), [directReports]);

  const load = useCallback(async () => {
    if (!me?.id || reportIds.length === 0) {
      setRequests([]);
      setShifts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      // Pull every leave request whose employee_id is one of this manager's
      // direct reports. We keep them all (any status/stage) and filter
      // client-side so the dashboard can show pending, on-leave-today,
      // and upcoming approved in one shot.
      // Also pull every shift this manager has assigned (set_by=me.id) so
      // the SHIFT STATUS tile can show pending/accepted/declined counts.
      const list = reportIds.map(id => `"${id}"`).join(',');
      const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
      const cutoffISO = cutoff.toISOString().slice(0, 10);
      const [rows, shiftRows] = await Promise.all([
        directGet(
          'leave_requests',
          `select=*&employee_id=in.(${list})&order=start_date.desc&limit=100`,
          { timeoutMs: 10000 }
        ).catch(() => []),
        directGet(
          'employee_shifts',
          `select=id,employee_id,shift_date,status&set_by=eq.${encodeURIComponent(me.id)}&shift_date=gte.${cutoffISO}`,
          { timeoutMs: 10000 }
        ).catch(() => []),
      ]);
      setRequests(Array.isArray(rows) ? rows : []);
      setShifts(Array.isArray(shiftRows) ? shiftRows : []);
    } catch (err) {
      console.warn('ManagerDashboard load failed:', err);
      setRequests([]);
      setShifts([]);
    } finally {
      setLoading(false);
    }
  }, [me?.id, reportIds.join(',')]);

  useEffect(() => { load(); }, [load]);

  // Realtime — when a staff member acknowledges a shift this manager assigned,
  // the SHIFT STATUS tile must reflect that without a manual refresh. Filter
  // on set_by so we only get events for shifts this manager set.
  useEffect(() => {
    if (!me?.id || !supabase) return;
    const channel = supabase
      .channel(`mgr-dash-shifts-${me.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'employee_shifts', filter: `set_by=eq.${me.id}` },
        () => load()
      )
      .subscribe();
    return () => { try { supabase.removeChannel(channel); } catch {} };
  }, [me?.id, load]);

  // ── Derived slices ──────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);

  const pendingMine = useMemo(
    () => requests.filter(r => r.stage === 'pending_manager'),
    [requests]
  );

  const onLeaveToday = useMemo(
    () => requests.filter(r =>
      (r.status === 'approved' || r.stage === 'approved') &&
      r.start_date <= today && r.end_date >= today
    ),
    [requests, today]
  );

  const upcomingApproved = useMemo(() => {
    return requests
      .filter(r => (r.status === 'approved' || r.stage === 'approved') && r.start_date > today)
      .sort((a, b) => a.start_date.localeCompare(b.start_date))
      .slice(0, 8);
  }, [requests, today]);

  // Counts for the SHIFT STATUS tile. The tile primary number shows the
  // TOTAL number of shifts this manager has assigned for the current
  // calendar week (Sun–Sat containing today) — pending + accepted +
  // declined combined. We still derive pending/accepted/declined for
  // the secondary subtitle, but the headline is the activity volume.
  // Tap the tile → jump to Requests tab where the editor and the full
  // per-shift status breakdown live.
  const shiftCounts = useMemo(() => {
    // Compute Sun..Sat containing today, in ISO date strings.
    const t = new Date();
    const day = t.getDay(); // 0 = Sunday
    const sunday = new Date(t); sunday.setDate(t.getDate() - day);
    const saturday = new Date(sunday); saturday.setDate(sunday.getDate() + 6);
    const sundayISO   = sunday.toISOString().slice(0, 10);
    const saturdayISO = saturday.toISOString().slice(0, 10);

    const inThisWeek = (d) => d >= sundayISO && d <= saturdayISO;
    const c = { pending: 0, accepted: 0, declined: 0, total: 0 };
    shifts.forEach(s => {
      if (!inThisWeek(s.shift_date)) return;
      c.total++;
      if (s.status === 'pending')  c.pending++;
      else if (s.status === 'accepted') c.accepted++;
      else if (s.status === 'declined') c.declined++;
    });
    return c;
  }, [shifts]);

  const empById = useMemo(() => {
    const m = {};
    (employees || []).forEach(e => { m[e.id] = e; });
    return m;
  }, [employees]);

  const firstName = (me?.name || '').split(' ')[0] || 'there';
  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    return 'Good evening';
  })();

  const todayLong = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="fade-in space-y-6">
      {/* Greeting */}
      <div>
        <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#1F1B16', fontWeight: 700 }}>
          — {todayLong.toUpperCase()}
        </div>
        <h1 style={{ fontFamily: 'Georgia, serif', fontSize: '40px', color: '#1F1B16', lineHeight: 1.1 }}>
          {greeting}, {firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase()}.
        </h1>
        <div className="text-sm mt-2" style={{ color: '#1F1B16' }}>
          {pendingMine.length > 0
            ? <><strong>{pendingMine.length}</strong> {pendingMine.length === 1 ? 'request needs' : 'requests need'} your review.</>
            : 'Your queue is clear. Nothing pending from your team.'}
        </div>
      </div>

      {/* Stat strip — 4 tiles. SHIFT STATUS sits next to ON LEAVE TODAY
          and surfaces the count of shifts waiting for staff acknowledgment.
          Tapping the tile jumps to the Requests tab where the editor and
          per-shift breakdown live. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="YOUR TEAM"
          value={directReports.length}
          icon={<Users className="w-5 h-5" />}
          accent="#0F4C2A"
          subtitle={directReports.length === 0 ? 'No direct reports' : 'Direct reports'}
        />
        <StatCard
          label="PENDING APPROVAL"
          value={pendingMine.length}
          icon={<Clock className="w-5 h-5" />}
          accent="#C97A4F"
          subtitle="Awaiting your decision"
          actionLabel={pendingMine.length > 0 ? 'Review →' : undefined}
          onAction={pendingMine.length > 0 ? onGoToReviews : undefined}
        />
        <StatCard
          label="ON LEAVE TODAY"
          value={onLeaveToday.length}
          icon={<Plane className="w-5 h-5" />}
          accent="#5A8A9A"
          subtitle={onLeaveToday.length === 1 ? 'Team member out' : 'Team members out'}
        />
        <StatCard
          label="SHIFT STATUS"
          value={shiftCounts.total}
          icon={<Calendar className="w-5 h-5" />}
          accent={shiftCounts.declined > 0 ? '#B91C1C' : (shiftCounts.pending > 0 ? '#A16207' : '#0F4C2A')}
          subtitle={
            shiftCounts.total === 0
              ? 'No shifts this week'
              : shiftCounts.declined > 0
                ? `This week · ${shiftCounts.declined} declined · ${shiftCounts.pending} waiting`
                : shiftCounts.pending > 0
                  ? `This week · ${shiftCounts.pending} waiting · ${shiftCounts.accepted} accepted`
                  : `This week · all ${shiftCounts.accepted} accepted`
          }
          actionLabel={typeof onGoToRequests === 'function' ? 'Open →' : undefined}
          onAction={typeof onGoToRequests === 'function' ? onGoToRequests : undefined}
          onClick={typeof onGoToRequests === 'function' ? onGoToRequests : undefined}
        />
      </div>

      {/* Pending approvals & Upcoming leaves */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Pending approvals" subtitle="Requests at your stage" empty={pendingMine.length === 0 ? 'Nothing pending — nice.' : null}>
          {pendingMine.length > 0 && (
            <div className="space-y-2">
              {pendingMine.map(r => {
                const emp = empById[r.employee_id];
                return (
                  <button key={r.id} onClick={onGoToReviews}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-white hover:bg-black/5 transition-colors text-left"
                    style={{ borderColor: 'var(--border-soft)' }}>
                    <Avatar name={emp?.name || r.employee_id} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                        {emp?.name || r.employee_id}
                      </div>
                      <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                        {fmtDateShort(r.start_date)} → {fmtDateShort(r.end_date)} · {r.reason || r.leave_type_id}
                      </div>
                    </div>
                    <ChevronRight className="w-4 h-4" style={{ color: '#1F1B16' }} />
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card title="Upcoming leaves" subtitle={`Next ${Math.min(8, upcomingApproved.length)} approved`} empty={upcomingApproved.length === 0 ? 'No upcoming approved leaves.' : null}>
          {upcomingApproved.length > 0 && (
            <div className="space-y-2">
              {upcomingApproved.map(r => {
                const emp = empById[r.employee_id];
                const d = new Date(r.start_date);
                return (
                  <div key={r.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border bg-white" style={{ borderColor: 'var(--border-soft)' }}>
                    <div className="text-center w-10 flex-shrink-0">
                      <div className="text-base font-semibold" style={{ color: '#1F1B16' }}>{d.getDate()}</div>
                      <div className="text-[10px] tracking-wider" style={{ color: '#1F1B16', fontWeight: 700 }}>
                        {d.toLocaleDateString('en-GB', { month: 'short' }).toUpperCase()}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>{emp?.name || r.employee_id}</div>
                      <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                        {fmtDateShort(r.start_date)} → {fmtDateShort(r.end_date)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Direct reports list */}
      <Card title="Your team" subtitle={`${directReports.length} ${directReports.length === 1 ? 'person reports' : 'people report'} to you`} empty={directReports.length === 0 ? 'No one is set as your direct report yet.' : null}>
        {directReports.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {directReports.map(e => (
              <div key={e.id} className="flex items-center gap-3 px-3 py-2 rounded-lg border bg-white" style={{ borderColor: 'var(--border-soft)' }}>
                <Avatar name={e.name} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>{e.name}</div>
                  <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                    {e.id} · {e.department || '—'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Shift cards moved out: the editor (ManagerShiftCard) and the
          per-day status breakdown (ManagerShiftStatusCard) now live in the
          Requests tab. The dashboard SHIFT STATUS tile above links there. */}

      {loading && (
        <div className="text-center text-xs opacity-50 py-2">Loading team data…</div>
      )}
    </div>
  );
}

// ── Helper components ──────────────────────────────────────────────────────

function StatCard({ label, value, icon, accent, subtitle, actionLabel, onAction, onClick }) {
  // If onClick is provided, the entire tile becomes clickable. The inner
  // action button (if present) calls stopPropagation so it doesn't fire
  // twice when both onClick and onAction land on the same tile.
  const Wrapper = onClick ? 'button' : 'div';
  const wrapperProps = onClick
    ? { type: 'button', onClick, 'aria-label': `${label} — open` }
    : {};
  return (
    <Wrapper
      {...wrapperProps}
      className={
        'rounded-2xl border bg-white p-4 flex items-center gap-4 text-left w-full ' +
        (onClick ? 'transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2' : '')
      }
      style={{
        borderColor: 'var(--border-soft)',
        boxShadow: '0 1px 2px rgba(31,27,22,0.04), 0 4px 14px rgba(31,27,22,0.06)',
        cursor: onClick ? 'pointer' : 'default',
      }}
    >
      <div className="w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0"
           style={{ background: `${accent}15`, color: accent, border: `1px solid ${accent}30` }}>
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[10px] tracking-[0.25em]" style={{ color: '#1F1B16', fontWeight: 700 }}>{label}</div>
        <div className="flex items-baseline gap-2">
          <div style={{ fontFamily: 'Georgia, serif', fontSize: '28px', color: '#1F1B16', fontWeight: 600 }}>{value}</div>
        </div>
        <div className="text-[11px]" style={{ color: '#1F1B16' }}>{subtitle}</div>
      </div>
      {actionLabel && onAction && (
        <span
          onClick={(e) => { e.stopPropagation(); onAction(e); }}
          className="text-xs px-3 py-1.5 rounded-full border flex-shrink-0"
          style={{ borderColor: accent, color: accent, fontWeight: 600 }}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onAction(e); } }}
        >
          {actionLabel}
        </span>
      )}
    </Wrapper>
  );
}

function Card({ title, subtitle, empty, children }) {
  return (
    <div className="rounded-2xl border bg-white p-5"
         style={{ borderColor: 'var(--border-soft)', boxShadow: '0 1px 2px rgba(31,27,22,0.04), 0 4px 14px rgba(31,27,22,0.06)' }}>
      <div className="flex items-baseline justify-between mb-4">
        <div style={{ fontFamily: 'Georgia, serif', fontSize: '20px', color: '#1F1B16' }}>{title}</div>
        {subtitle && <div className="text-[11px]" style={{ color: '#1F1B16' }}>{subtitle}</div>}
      </div>
      {empty ? (
        <div className="flex items-center gap-2 text-sm py-3" style={{ color: '#1F1B16' }}>
          <CheckCircle2 className="w-4 h-4" style={{ color: '#0F4C2A' }} />
          {empty}
        </div>
      ) : children}
    </div>
  );
}

function Avatar({ name }) {
  const initials = getInitials(name || '');
  const color    = avatarColor(name || '');
  return (
    <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-white text-xs font-semibold"
         style={{ background: color }}>
      {initials}
    </div>
  );
}
