import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  LayoutDashboard, ClipboardList, Users, Calendar as CalIcon, Settings,
  Plus, LogOut, Activity, ShieldCheck, RefreshCw
, Clock , BarChart3 } from 'lucide-react';
import { supabase, directGet, directPatch } from '../supabaseClient.js';
import { loadTemplates as loadEmailTemplates } from '../lib/emailTemplates.js';
import Dashboard from './Dashboard.jsx';
import Requests from './Requests.jsx';
import ManagerShiftCard from './ManagerShiftCard.jsx';
import ManagerShiftStatusCard from './ManagerShiftStatusCard.jsx';
import Employees from './Employees.jsx';
import CalendarView from './CalendarView.jsx';
import SettingsView from './SettingsView.jsx';
import ConnectivityTest from './ConnectivityTest.jsx';
import NewRequestModal from './NewRequestModal.jsx';
import RequestTypePicker from './RequestTypePicker.jsx';
import PermissionRequestModal from './PermissionRequestModal.jsx';
import EmployeeDetailModal from './EmployeeDetailModal.jsx';
import ShiftAcknowledgmentModal from './ShiftAcknowledgmentModal.jsx';
import InsightsView from './InsightsView.jsx';
import AdminPanel from './AdminPanel.jsx';
import PersonalDashboard from './PersonalDashboard.jsx';
import ManagerDashboard  from './ManagerDashboard.jsx';
import ReviewerPanel from './ReviewerPanel.jsx';
import EvergreenLogo from './EvergreenLogo.jsx';
import AttendanceView from './AttendanceView.jsx';
import RefreshOverlay from './RefreshOverlay.jsx';
import { logAction } from '../lib/audit.js';
import { fmtDate } from '../lib/leaveLogic.js';

function buildTabs({ isAdmin, isReviewer, isManager, isHrReviewer, me }) {
  // Tab visibility rules:
  //   Regular staff   → Dashboard, Requests, Calendar (no Employees, Settings, Diagnostics)
  //   Reviewer/Manager → adds Reviews + Attendance, hides Diagnostics
  //   Admin            → everything including Employees, Settings, Admin, Diagnostics
  const base = [
    { id: 'dashboard',  label: 'Dashboard', icon: LayoutDashboard },
    { id: 'requests',   label: 'Requests',  icon: ClipboardList },
  ];

  // Employees tab — admin and HR-reviewer (Bashaier) only. Managers do NOT
  // see the company directory; their dashboard already surfaces their direct
  // reports, and the Employees tab would expose the full 61-person list which
  // contradicts the org-chart-scoped access rule. Regular staff also don't
  // get this tab.
  if (isAdmin || isHrReviewer) {
    base.push({ id: 'employees', label: 'Employees', icon: Users });
  }

  // Calendar — everyone
  base.push({ id: 'calendar', label: 'Calendar', icon: CalIcon });

  // Settings — admin only
  if (isAdmin) {
    base.push({ id: 'settings', label: 'Settings', icon: Settings });
  }

  // Insights — admin and HR reviewer (Bashaier) only — full reports + exports
  if (isAdmin || isHrReviewer) {
    base.push({ id: 'insights', label: 'Insights', icon: BarChart3 });
  }

  // Diagnostics — admin only (Bashaier and staff don't see it)
  if (isAdmin) {
    base.push({ id: 'diagnostics', label: 'Diagnostics', icon: Activity });
  }

  // Reviews — for reviewers/managers who aren't admin
  if ((isReviewer || isManager) && !isAdmin) {
    base.splice(2, 0, { id: 'reviews', label: 'Reviews',  icon: ShieldCheck });
  }

  // Shifts — manager-only workspace for assigning per-day hours to direct
  // reports and tracking acknowledgment + SUP approval state. Splits cleanly
  // out of the Requests tab so Requests can go back to being leave-only.
  // Excludes admin and HR-reviewer (Bashaier) — they manage shifts from
  // their own dashboards. Spliced AFTER Reviews so it lands at index 2,
  // pushing Reviews down by one (final order: Dashboard, Requests, Shifts,
  // Reviews, Calendar).
  if (isManager && !isAdmin && !isHrReviewer) {
    base.splice(2, 0, { id: 'shifts', label: 'Shifts', icon: CalIcon });
  }

  // Attendance — visibility driven by can_view_attendance flag on the
  // employee record (default false). Bashaier + Nadeem are seeded true
  // by the role-flags migration. The flag, not the PSN, controls the
  // tab — safer as the team grows or roles change.
  if (me?.can_view_attendance) {
    const insertIdx = base.findIndex(t => t.id === 'calendar');
    base.splice(insertIdx >= 0 ? insertIdx + 1 : base.length, 0, { id: 'attendance', label: 'Attendance', icon: Clock });
  }
  if (isAdmin) {
    // Admin tab is admin-only (Nadeem). Bashaier (HR reviewer) does
    // her work through Reviews + Employees + Attendance — the Admin
    // tab surfaces are reserved for the universal admin: PSN access
    // requests, sign-in activity, full audit log.
    base.splice(5, 0, { id: 'admin', label: 'Admin', icon: ShieldCheck });
  }
  return base;
}

export default function AppShell({ session, me, onRefreshMe }) {
  // State declarations come FIRST so derived flags can read 'employees'.
  const [pendingRegCount, setPendingRegCount] = useState(0);
  // Active tab — persisted in sessionStorage so a browser refresh keeps
  // the user on whatever view they were looking at (Shifts, Reviews,
  // Calendar, etc.) instead of bouncing them back to Dashboard. Per-tab
  // session storage so different browser tabs can hold different views.
  const [tab, setTab] = useState(() => {
    try {
      return sessionStorage.getItem('esauhr.tab') || 'dashboard';
    } catch { return 'dashboard'; }
  });
  // Wrap setter so every tab change writes back to sessionStorage. Defining
  // the wrapper inline keeps every existing setTab call site unchanged.
  const setTabPersistent = (next) => {
    setTab(next);
    try { sessionStorage.setItem('esauhr.tab', next); } catch {}
  };
  const [employees, setEmployees]       = useState([]);
  const [leaveTypes, setLeaveTypes]     = useState([]);
  const [requests, setRequests]         = useState([]);
  const [permissions, setPermissions]   = useState([]);
  const [balances, setBalances]         = useState([]);
  const [holidays, setHolidays]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [refreshing, setRefreshing]     = useState(false);
  const [error, setError]               = useState('');
  // Request flow — what the "+ New request" button opens. Used to be a single
  // boolean that opened NewRequestModal directly (vacation/leave only). Staff
  // who needed a permission (late arrival / early leave) had to find the
  // colored dashboard tile, which was easy to miss. Now the entry opens a
  // type picker first, and the picker routes to the right form.
  //
  // States: null = closed, 'pick' = picker visible, 'leave' = vacation form,
  //         'late_arrival' / 'early_leave' = permission form
  const [requestFlow, setRequestFlow] = useState(null);
  // Backwards-compatible alias so existing call sites (`onNewRequest`,
  // `onOpenNewRequest`) still open the picker. Internal callers can call
  // setRequestFlow(...) directly to skip the picker (e.g. dashboard
  // shortcuts that already know the type).
  const showNewRequest = requestFlow === 'pick' || requestFlow === 'leave'; // legacy reads
  const setShowNewRequest = (v) => setRequestFlow(v ? 'pick' : null);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [pendingShifts, setPendingShifts] = useState([]);
  // Modal visibility for the shift acknowledgment dialog. Default is closed —
  // staff are no longer ambushed on sign-in. Instead a "Shift schedule" card
  // appears on PersonalDashboard whenever pendingShifts is non-empty, and
  // tapping that card flips this flag to open the modal.
  const [shiftAckOpen, setShiftAckOpen] = useState(false);

  // Derived flags — must be AFTER all useState() so employees is in scope.
  const isAdmin    = Boolean(me?.is_admin);
  const isReviewer = Boolean(me?.can_review_leave || me?.can_review_permissions);
  const isHrReviewer = Boolean(me?.is_hr_reviewer);
  const isManager  = useMemo(
    () => (employees || []).some(e => e.manager_id === me?.id),
    [employees, me?.id]
  );
  const TABS = useMemo(
    () => buildTabs({ isAdmin, isReviewer, isManager, isHrReviewer, me }),
    [isAdmin, isReviewer, isManager, isHrReviewer, me?.id, me?.psn]
  );

  const loadAll = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      // Use directGet (raw fetch with timeout) instead of the supabase-js builder
      // to avoid the gotrue-js Web Lock wedge that intermittently hangs the first
      // query after sign-in. Each call has a hard timeout; failures degrade to [].
      const safe = (p) => p.catch((err) => { console.warn('load failed:', err); return []; });
      const [e, t, r, b, h, p] = await Promise.all([
        safe(directGet('employees',           'select=*&order=name',                  { timeoutMs: 12000 })),
        safe(directGet('leave_types',         'select=*&order=sort_order',            { timeoutMs: 8000  })),
        safe(directGet('leave_requests',      'select=*&order=requested_at.desc',     { timeoutMs: 12000 })),
        safe(directGet('leave_balances',      'select=*',                             { timeoutMs: 8000  })),
        safe(directGet('public_holidays',     'select=*&order=date',                  { timeoutMs: 8000  })),
        safe(directGet('permission_requests', 'select=*&order=permission_date.desc',  { timeoutMs: 8000  })),
      ]);

      setEmployees(Array.isArray(e) ? e : []);
      setLeaveTypes(Array.isArray(t) ? t : []);
      setRequests(Array.isArray(r) ? r : []);
      setBalances(Array.isArray(b) ? b : []);
      setHolidays(Array.isArray(h) ? h : []);
      setPermissions(Array.isArray(p) ? p : []);

      // ── Auto-expire stale pending permissions ─────────────────────────
      // Rows still in pending_manager / pending_hr whose permission_date
      // is in the past can never be acted on — mark them 'expired' so
      // the dashboards stop counting them and the queue stays clean.
      // Sweeps quietly in the background; failures are non-blocking.
      try {
        const today = new Date().toISOString().slice(0, 10);
        const stale = (Array.isArray(p) ? p : []).filter(row =>
          (row.stage === 'pending_manager' || row.stage === 'pending_hr')
          && row.permission_date && row.permission_date < today
        );
        if (stale.length) {
          await Promise.allSettled(stale.map(row => directPatch(
            'permission_requests', 'id', row.id,
            { stage: 'expired', status: 'expired' },
            { timeoutMs: 8000 },
          )));
          // Patch the in-memory list too so the UI reflects it
          // immediately without waiting for the next reload.
          setPermissions(prev => prev.map(row => stale.some(s => s.id === row.id)
            ? { ...row, stage: 'expired', status: 'expired' }
            : row,
          ));
          console.log(`[expire-sweep] marked ${stale.length} stale permission(s) as expired`);
        }
      } catch (err) {
        console.warn('[expire-sweep] failed (non-blocking):', err);
      }
    } catch (err) {
      setError(err.message || 'Failed to load data');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Hydrate email-template overrides at app start. Fire-and-forget —
  // every consumer falls back to defaults if this never resolves
  // (table missing, slow network, etc.). Refreshes happen via the
  // Email Templates admin panel after a save.
  useEffect(() => { loadEmailTemplates(); }, []);

  // Pending registration count (admin badge)
  useEffect(() => {
    if (!isAdmin) { setPendingRegCount(0); return; }
    let mounted = true;
    const refresh = async () => {
      const { count } = await supabase.from('registration_requests')
        .select('id', { count: 'exact', head: true }).eq('status', 'pending');
      if (mounted) setPendingRegCount(count || 0);
    };
    refresh();
    const ch = supabase.channel('reg-req-count')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'registration_requests' }, refresh)
      .subscribe();
    return () => { mounted = false; supabase.removeChannel(ch); };
  }, [isAdmin]);

  // Pending shift acknowledgments — every signed-in user fetches any rows
  // in employee_shifts where employee_id = me.id AND status = 'pending'.
  // The fairy modal (ShiftAcknowledgmentModal) renders if the result is
  // non-empty and the user has not dismissed it for the current session.
  useEffect(() => {
    if (!me?.id) { setPendingShifts([]); return; }
    let mounted = true;
    const refresh = async () => {
      try {
        const rows = await directGet(
          'employee_shifts',
          `select=*&employee_id=eq.${encodeURIComponent(me.id)}&status=eq.pending&order=shift_date`,
          { timeoutMs: 8000 }
        );
        if (mounted) setPendingShifts(Array.isArray(rows) ? rows : []);
      } catch {
        if (mounted) setPendingShifts([]);
      }
    };
    refresh();
    const ch = supabase.channel(`pending-shifts-${me.id}`)
      .on('postgres_changes', {
        event: '*', schema: 'public', table: 'employee_shifts',
        filter: `employee_id=eq.${me.id}`,
      }, refresh)
      .subscribe();
    return () => { mounted = false; supabase.removeChannel(ch); };
  }, [me?.id]);

  // Realtime subscription — updates when anyone in the team changes data.
  // Multiple changes in quick succession (e.g. bulk status updates) used to
  // trigger N copies of loadAll concurrently, each firing 6 parallel queries.
  // We coalesce within a 400ms window so the worst case is one refresh.
  useEffect(() => {
    let pending = null;
    const debouncedLoad = () => {
      if (pending) return;
      pending = setTimeout(() => { pending = null; loadAll(); }, 400);
    };
    const channel = supabase.channel('leave-desk-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_requests' }, debouncedLoad)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employees' }, debouncedLoad)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_types' }, debouncedLoad)
      .subscribe();
    return () => {
      if (pending) clearTimeout(pending);
      supabase.removeChannel(channel);
    };
  }, [loadAll]);

  const typeMap = useMemo(() => Object.fromEntries(leaveTypes.map(t => [t.id, t])), [leaveTypes]);
  const empMap  = useMemo(() => Object.fromEntries(employees.map(e => [e.id, e])), [employees]);

  // Pending badge in the Requests tab — same scope as the tab content
  // itself (per the access-control overhaul, regular staff/managers/HR
  // see only their own rows in Requests; admin sees the full table).
  // Without this scoping the badge counts every pending row in the
  // database including peers' requests, which leaks 'something is
  // happening somewhere' to users who shouldn't have visibility.
  const pendingCount = useMemo(() => {
    const scoped = isAdmin ? requests : requests.filter(r => r.employee_id === me?.id);
    return scoped.filter(r => r.status === 'pending').length;
  }, [requests, isAdmin, me?.id]);

  // Count of items waiting for THIS user's review action — drives the
  // notification badge on the Reviews tab. Each role sees its own
  // queue:
  //   • HR reviewer (Bashaier) → leave + permission + rejoining at
  //                              their final stage (pending_hr)
  //   • Dept manager           → leave + permission + rejoining at
  //                              the manager stage for direct reports
  //                              (pending_manager)
  //   • Admin (Nadeem)         → everything at any pending stage
  // Reads only the in-memory requests + permissions arrays already
  // populated for the dashboard, so the badge updates live with the
  // realtime subscription — no extra fetch.
  const reviewQueueCount = useMemo(() => {
    if (!me) return 0;
    const directReportIds = new Set(
      (employees || []).filter(e => e.manager_id === me.id).map(e => e.id)
    );
    let count = 0;

    if (isAdmin) {
      count += (requests    || []).filter(r => /^pending/.test(r.stage || '')).length;
      count += (permissions || []).filter(p => /^pending/.test(p.stage || '')).length;
      count += (requests    || []).filter(r => r.return_stage === 'pending_hr' || r.return_stage === 'pending_manager').length;
    } else if (isHrReviewer) {
      count += (requests    || []).filter(r => r.stage === 'pending_hr').length;
      count += (permissions || []).filter(p => p.stage === 'pending_hr').length;
      // Bashaier sees pending_hr rejoinings as actionable AND
      // pending_manager rejoinings as informational (per the
      // landing-page card design). The badge surfaces both so she
      // never misses the new ones rolling in.
      count += (requests    || []).filter(r => r.return_stage === 'pending_hr' || r.return_stage === 'pending_manager').length;
    } else if (directReportIds.size > 0) {
      // Manager — only their direct reports' pending_manager rows
      count += (requests    || []).filter(r => r.stage === 'pending_manager' && directReportIds.has(r.employee_id)).length;
      count += (permissions || []).filter(p => p.stage === 'pending_manager' && directReportIds.has(p.employee_id)).length;
      count += (requests    || []).filter(r => r.return_stage === 'pending_manager' && directReportIds.has(r.employee_id)).length;
    }
    return count;
  }, [requests, permissions, employees, me, isAdmin, isHrReviewer]);

  // Today-on-calendar count for the badge on the Calendar tab. Counts
  // distinct people with any approved event happening today — leaves
  // covering today, permissions filed for today, shifts assigned to
  // today. Surfaces 'how many staff are doing something out-of-the-
  // ordinary right now' in a single number, so the calendar pulls
  // attention only on busy days.
  // Scoped to the user's view: admin/HR see everyone; staff see
  // themselves only (mirrors CalendarView's role gating).
  const calendarTodayCount = useMemo(() => {
    if (!me) return 0;
    const today = new Date().toISOString().slice(0, 10);
    const canSeeAll = isAdmin || isHrReviewer;
    const peopleToday = new Set();
    (requests || []).forEach(r => {
      if (r.status !== 'approved') return;
      if (r.start_date > today || r.end_date < today) return;
      if (!canSeeAll && r.employee_id !== me.id) return;
      peopleToday.add(r.employee_id);
    });
    (permissions || []).forEach(p => {
      if (p.stage !== 'approved') return;
      if (p.permission_date !== today) return;
      if (!canSeeAll && p.employee_id !== me.id) return;
      peopleToday.add(p.employee_id);
    });
    return peopleToday.size;
  }, [requests, permissions, me, isAdmin, isHrReviewer]);

  const signOut = async () => {
    // Bulletproof sign-out: clear local/session storage, race the supabase API
    // against a 3s timeout, then hard-reload back to the login screen. This
    // guarantees the user always returns to /login even if the gotrue-js client
    // is wedged or the network call hangs.
    try {
      Object.keys(localStorage).forEach((k) => {
        if (k.startsWith('sb-') || k.startsWith('supabase.')) localStorage.removeItem(k);
      });
      Object.keys(sessionStorage).forEach((k) => {
        if (k.startsWith('sb-') || k.startsWith('supabase.')) sessionStorage.removeItem(k);
      });
    } catch (_) { /* storage may be unavailable in private mode */ }
    try {
      await Promise.race([
        supabase.auth.signOut(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('signOut timeout')), 3000)),
      ]);
    } catch (e) {
      console.warn('signOut: API did not respond, forcing reload anyway:', e?.message || e);
    }
    // Hard-redirect to the root — App.jsx will see no session and render <Auth />.
    window.location.href = '/';
  };

  const createRequest = async (payload) => {
    // The payload now carries: substitute_ids, substitute_decisions, stage='pending_substitutes'.
    // The DB trigger sync_leave_status_with_stage auto-derives status from stage,
    // so we don't pass status here.
    const { data, error } = await supabase.from('leave_requests').insert({
      ...payload,
      requested_by: session.user.email,
    }).select().single();
    if (error) throw error;
    const empName = empMap[payload.employee_id]?.name || payload.employee_id;
    const typeName = typeMap[payload.leave_type_id]?.name || payload.leave_type_id;
    logAction(me, 'leave_request_create', {
      targetType: 'leave_request',
      targetId: data?.id,
      targetLabel: `${empName} · ${typeName} · ${payload.start_date} ÃÂ¢ÃÂÃÂ ${payload.end_date}`,
      details: { employee_id: payload.employee_id, leave_type_id: payload.leave_type_id, days: payload.days },
    });
    await loadAll();
  };

  const decideRequest = async (id, status, note) => {
    // Stage-aware decision. The legacy caller (Requests.jsx) used to
    // pass status='approved'|'rejected' as a single-step decision, which
    // bypassed the manager → HR multi-stage flow. After the access-control
    // overhaul, every decision must advance one stage at a time:
    //   pending_substitutes → pending_manager  (substitute path)
    //   pending_manager     → pending_hr OR rejected_by_manager
    //   pending_hr          → approved OR rejected_by_hr
    // The DB trigger keeps the legacy `status` column synced from `stage`.
    // Only admin (Nadeem) can call this directly now; everyone else uses
    // ReviewerPanel which already does this correctly. We keep the function
    // for admin emergency use and for backwards compat with anything that
    // might still call it.
    const req = requests.find(r => r.id === id);
    if (!req) throw new Error('Request not found in local cache');
    const isApprove = status === 'approved';
    let nextStage = null;
    const patch = {};
    const now = new Date().toISOString();
    if (req.stage === 'pending_manager') {
      nextStage = isApprove ? 'pending_hr' : 'rejected_by_manager';
      patch.manager_decided_at = now;
      patch.manager_decided_by = me?.auth_user_id || null;
      if (note) patch.manager_note = note;
    } else if (req.stage === 'pending_hr') {
      nextStage = isApprove ? 'approved' : 'rejected_by_hr';
      patch.hr_decided_at = now;
      patch.hr_decided_by = me?.auth_user_id || null;
    } else {
      throw new Error('Cannot decide a request at stage "' + req.stage + '" from this view. Use the Reviews tab.');
    }
    patch.stage = nextStage;
    const { error } = await supabase.from('leave_requests').update(patch).eq('id', id);
    if (error) throw error;
    const empName = empMap[req.employee_id]?.name || req.employee_id;
    logAction(me, 'leave_request_decide', {
      targetType: 'leave_request',
      targetId: id,
      targetLabel: `${empName} · ${nextStage}`,
      details: { stage: nextStage, note: note || null },
    });
    await loadAll();
  };

  const deleteRequest = async (id) => {
    const req = requests.find(r => r.id === id);
    const empName = req ? (empMap[req.employee_id]?.name || req.employee_id) : '';
    const { error } = await supabase.from('leave_requests').delete().eq('id', id);
    if (error) throw error;
    logAction(me, 'leave_request_delete', {
      targetType: 'leave_request',
      targetId: id,
      targetLabel: empName,
    });
    await loadAll();
  };

  const updateLeaveType = async (id, patch) => {
    const { error } = await supabase.from('leave_types').update(patch).eq('id', id);
    if (error) throw error;
    logAction(me, 'leave_type_update', {
      targetType: 'leave_type',
      targetId: id,
      targetLabel: typeMap[id]?.name || id,
      details: patch,
    });
    await loadAll();
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 rounded-full animate-spin mx-auto mb-3"
            style={{ borderColor: 'var(--evergreen-200)', borderTopColor: 'var(--evergreen-500)' }}/>
          <div className="text-xs tracking-widest opacity-60">LOADING</div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* Refresh overlay — fades in over the whole UI while the global
          refresh button is in flight. Shows the Evergreen ship animation
          + 'Refreshing your dashboard…' caption so the user has clear
          feedback that data is being pulled (and that they're NOT being
          signed out). Driven entirely by AppShell's `refreshing` state
          so the overlay's lifecycle exactly matches the data fetch. */}
      <RefreshOverlay open={refreshing} />

      {/* Header */}
      <header className="border-b" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper)' }}>
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <EvergreenLogo variant="full" size="md" />
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right hidden md:block">
              <div className="text-[11px] tracking-[0.2em] opacity-70 font-bold">TODAY</div>
              <div className="serif text-base font-semibold">{fmtDate(new Date())}</div>
            </div>
            <div className="hidden sm:block w-px h-8" style={{ background: 'var(--border-soft)' }}/>
            <div className="text-right hidden sm:block">
              <div className="text-[11px] tracking-[0.2em] opacity-70 font-bold">SIGNED IN</div>
              {me ? (
                <>
                  <div className="text-base font-bold leading-tight" style={{ color: 'var(--ink)' }}>
                    {me.name}
                  </div>
                  <div className="text-xs tracking-wider opacity-80 mt-1 flex items-center gap-1.5 justify-end font-semibold">
                    <span className="font-mono">{me.id}</span>
                    {isAdmin && (
                      <span className="text-[9px] tracking-widest px-1.5 py-0.5 rounded-full font-medium"
                        style={{ background: 'var(--evergreen-800)', color: 'var(--paper)' }}>ADMIN</span>
                    )}
                  </div>
                </>
              ) : (
                <div className="text-base font-semibold truncate max-w-[180px]">{session.user.email}</div>
              )}
            </div>
            <button onClick={() => setShowNewRequest(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-full text-sm"
              style={{ background: 'var(--ink)', color: 'var(--paper)' }}>
              <Plus className="w-4 h-4" /><span className="hidden sm:inline">New request</span>
            </button>
            <button
              onClick={async () => {
                // Hard refresh — reload the page so the user always gets
                // the latest deployed bundle. Steps:
                //   1. Show the overlay
                //   2. Run cleanup (SW + caches) in background
                //   3. Hold for at least 3 seconds so the user can enjoy
                //      the ship animation (it's beautiful, give it space)
                //   4. Reload with cache bypass
                if (refreshing) return;
                setRefreshing(true);

                // Cleanup runs in parallel with the 3-second hold.
                // Failures are non-blocking — the reload below still runs.
                const cleanup = (async () => {
                  if ('serviceWorker' in navigator) {
                    try {
                      const regs = await navigator.serviceWorker.getRegistrations();
                      await Promise.all(regs.map(r => r.unregister().catch(() => {})));
                    } catch {}
                  }
                  if (typeof caches !== 'undefined' && caches?.keys) {
                    try {
                      const keys = await caches.keys();
                      await Promise.all(keys.map(k => caches.delete(k).catch(() => {})));
                    } catch {}
                  }
                })();

                // Minimum 3-second hold so the ship animation is visible.
                const minHold = new Promise(r => setTimeout(r, 3000));

                // Wait for whichever finishes LAST — cleanup OR the 3s
                // hold — so we never reload before the animation has had
                // its moment.
                await Promise.all([cleanup, minHold]);

                // Cache-bust query so the browser must re-fetch index.html
                // and pull the newest hashed asset bundles.
                const url = new URL(window.location.href);
                url.searchParams.set('_r', Date.now().toString());
                window.location.replace(url.toString());
              }}
              disabled={refreshing}
              className="p-2.5 rounded-full border esau-refresh-btn disabled:opacity-60"
              title="Refresh — reload the latest version of the site"
              aria-label="Refresh"
              style={{ borderColor: 'var(--border-soft)' }}>
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={signOut}
              className="p-2.5 rounded-full border"
              title="Sign out"
              aria-label="Sign out"
              style={{ borderColor: 'var(--border-soft)' }}>
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-7xl mx-auto px-3 sm:px-6 flex gap-1 overflow-x-auto">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTabPersistent(t.id)}
              className="relative flex items-center gap-2 px-4 py-3 text-sm whitespace-nowrap transition-colors"
              style={{
                color: tab === t.id ? 'var(--ink)' : 'var(--ink-soft)',
                opacity: tab === t.id ? 1 : 0.65,
                borderBottom: tab === t.id ? '2px solid var(--evergreen-500)' : '2px solid transparent',
                marginBottom: '-1px',
              }}>
              <t.icon className="w-4 h-4" />
              {t.label}
              {t.id === 'requests' && pendingCount > 0 && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{ background: 'var(--clay)', color: 'var(--paper)' }}>
                  {pendingCount}
                </span>
              )}
              {t.id === 'reviews' && reviewQueueCount > 0 && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                  style={{ background: '#DC2626', color: '#FFFFFF', minWidth: '18px', textAlign: 'center' }}
                  title={`${reviewQueueCount} request${reviewQueueCount === 1 ? '' : 's'} awaiting your review`}>
                  {reviewQueueCount}
                </span>
              )}
              {t.id === 'admin' && pendingRegCount > 0 && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{ background: 'var(--clay)', color: 'var(--paper)' }}>
                  {pendingRegCount}
                </span>
              )}
              {t.id === 'calendar' && calendarTodayCount > 0 && (
                // Calendar 'today' badge — green pill matching the
                // brand colour. Distinct from the red 'urgent' tones
                // used on Reviews/Requests so it reads as 'fyi' not
                // 'action needed'.
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                  style={{ background: '#0F4C2A', color: '#FFFFFF', minWidth: '18px', textAlign: 'center' }}
                  title={`${calendarTodayCount} ${calendarTodayCount === 1 ? 'person has' : 'people have'} an event today`}>
                  {calendarTodayCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto px-3 sm:px-6 mt-4">
          <div className="p-3 rounded-lg text-sm" style={{ background: 'rgba(184,74,62,0.1)', color: 'var(--clay)' }}>
            {error}
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-3 sm:px-6 py-6 sm:py-8 fade-in" key={tab}>
        {tab === 'dashboard' && (
          (isAdmin || isHrReviewer) ? (
            // Admin Dashboard: Nadeem (admin) and Bashaier (HR reviewer) only.
            // Dept heads who used to have can_review_leave=true are routed to
            // ManagerDashboard below — they should never see the company-wide view.
            <Dashboard
              me={me}
              employees={employees} leaveTypes={leaveTypes} requests={requests}
              balances={balances} holidays={holidays}
              typeMap={typeMap} empMap={empMap}
              permissions={permissions}
              onGoToRequests={() => setTabPersistent("requests")}
              onGoToReviews={() => setTabPersistent("reviews")}
              onNewRequest={() => setShowNewRequest(true)}
            />
          ) : isManager ? (
            // ManagerDashboard: any user who has direct reports (manager_id===me.id
            // for some employee) but is not admin/HR. Same component for every
            // manager; data is scoped to their own direct reports.
            <ManagerDashboard
              me={me}
              employees={employees}
              onGoToReviews={() => setTabPersistent("reviews")}
              onGoToRequests={() => setTabPersistent("requests")}
              onGoToShifts={() => setTabPersistent("shifts")}
            />
          ) : (
            <PersonalDashboard
              me={me}
              leaveTypes={leaveTypes}
              empMap={empMap}
              // Pass AppShell's authoritative requests + permissions so
              // the refresh button + realtime subscription on AppShell
              // propagate to MyApplicationsCard. Without this, the card
              // reads PersonalDashboard's local fetch state which only
              // updates on mount.
              requests={requests}
              permissions={permissions}
              pendingShifts={pendingShifts}
              onOpenShiftAck={() => setShiftAckOpen(true)}
              onOpenNewRequest={() => setShowNewRequest(true)}
            />
          )
        )}
        {tab === 'reviews' && (
          <ReviewerPanel me={me} />
        )}
        {tab === 'attendance' && (() => {
          // Defense in depth: even if someone forces tab='attendance' via URL or
          // dev tools, the Attendance feature only renders for users with the
          // can_view_attendance flag — OR for the universal admin (Nadeem),
          // who always has access regardless of which feature flags happen
          // to be set on his employee record.
          if (!me?.can_view_attendance && !me?.is_admin) return null;
          return <AttendanceView me={me} employees={employees} />;
        })()}
        {tab === 'requests' && (
          <Requests
            // Strict isolation per role:
            //   • admin (Nadeem) — sees the full company table; needed
            //     for cross-team auditing, payroll exports, the
            //     'reassign manager' surface that exists in AdminPanel
            //   • everyone else (regular staff, managers, HR) — sees
            //     ONLY their own requests in this tab
            //
            // Reviewers don't lose visibility into team activity — that
            // moves to the dedicated Reviews tab where it belongs (with
            // approve/reject actions, pending-stage filters, and the
            // letter/email surface). Mixing 'my own' and 'my team' in
            // one list was confusing and leaked staff requests across
            // peers.
            requests={isAdmin ? requests : requests.filter(r => r.employee_id === me.id)}
            leaveTypes={leaveTypes}
            typeMap={typeMap} empMap={empMap}
            me={me}
            onDecide={decideRequest} onDelete={deleteRequest}
            onNewRequest={() => setShowNewRequest(true)}
          />
        )}
        {tab === 'shifts' && isManager && !isAdmin && !isHrReviewer && (
          // Manager-only shift workspace. The editor lets the manager assign
          // per-day shifts to direct reports; the status panel below shows
          // live acknowledgment state plus SUP approval for every shift on
          // file. Defense-in-depth route guard mirrors the buildTabs gate so
          // a forced ?tab=shifts URL from a non-manager renders nothing.
          <div className="space-y-6">
            <ManagerShiftCard me={me} employees={employees} />
            <ManagerShiftStatusCard me={me} employees={employees} />
          </div>
        )}
        {tab === 'employees' && (isAdmin || isHrReviewer) && (
          <Employees
            employees={employees} leaveTypes={leaveTypes}
            requests={requests} balances={balances}
            onSelect={setSelectedEmployee}
          />
        )}
        {tab === 'calendar' && (
          <CalendarView
            me={me}
            requests={requests} permissions={permissions}
            empMap={empMap} typeMap={typeMap} holidays={holidays}
          />
        )}
        {tab === 'settings' && isAdmin && (
          <SettingsView
            leaveTypes={leaveTypes}
            onUpdateType={updateLeaveType}
            employees={employees} requests={requests} holidays={holidays}
            me={me}
          />
        )}
        {tab === 'insights' && (isAdmin || isHrReviewer) && (
          <InsightsView
            me={me}
            employees={employees}
            leaveTypes={leaveTypes}
            requests={requests}
            balances={balances}
            permissions={permissions}
            empMap={empMap}
          />
        )}
        {tab === 'diagnostics' && isAdmin && (
          <ConnectivityTest />
        )}
        {tab === 'admin' && isAdmin && (
          <AdminPanel session={session} me={me} onRefreshMe={onRefreshMe} />
        )}
      </main>

      {/* Request flow router — picker first, then either the leave form or
          the permission form depending on what the staff member chose. */}
      {requestFlow === 'pick' && (
        <RequestTypePicker
          onClose={() => setRequestFlow(null)}
          onPick={(type) => setRequestFlow(type)}
        />
      )}
      {(requestFlow === 'leave' || requestFlow === 'sick') && (
        <NewRequestModal
          me={me}
          employees={employees} leaveTypes={leaveTypes}
          requests={requests} balances={balances} holidays={holidays}
          // When the picker route is 'sick', the leave-type field is
          // pre-set and locked. Picking 'Sick leave' from the menu is
          // a commitment — the user shouldn't be able to swap to
          // annual mid-form. For the regular 'leave' route the
          // selector behaves as before with annual as default.
          lockedLeaveType={requestFlow === 'sick' ? 'sick' : null}
          onClose={() => setRequestFlow(null)}
          onSubmit={async (payload) => {
            await createRequest(payload);
            setRequestFlow(null);
          }}
        />
      )}
      {(requestFlow === 'late_arrival' || requestFlow === 'early_leave') && (
        <PermissionRequestModal
          me={me}
          type={requestFlow}
          monthRows={(() => {
            // Filter the global permissions list down to this user's
            // current-month rows, which is what the modal needs for its
            // quota math (summariseMonth + checkExceeds). RLS already
            // restricts non-admin/HR users to their own rows; we still
            // narrow by employee_id defensively.
            const m = new Date().toISOString().slice(0, 7); // YYYY-MM
            return (permissions || []).filter(p =>
              p.employee_id === me?.id &&
              String(p.permission_date || '').startsWith(m)
            );
          })()}
          onClose={() => setRequestFlow(null)}
          onSubmitted={() => setRequestFlow(null)}
        />
      )}

      {selectedEmployee && (
        <EmployeeDetailModal
          employee={selectedEmployee}
          employees={employees}
          empMap={empMap}
          leaveTypes={leaveTypes}
          requests={requests.filter(r => r.employee_id === selectedEmployee.id)}
          balances={balances.filter(b => b.employee_id === selectedEmployee.id)}
          typeMap={typeMap}
          me={me}
          // After Bashaier saves, refresh the directory so other tabs
          // (Attendance, the employees grid behind the modal, the
          // PSN/dept lookups everywhere) reflect the change. loadAll
          // does a silent re-fetch.
          onSaved={(updated) => {
            setSelectedEmployee(updated);
            loadAll({ silent: true });
          }}
          onClose={() => setSelectedEmployee(null)}
        />
      )}

      {shiftAckOpen && pendingShifts.length > 0 && (
        <ShiftAcknowledgmentModal
          me={me}
          pendingShifts={pendingShifts}
          employees={employees}
          onClose={() => setShiftAckOpen(false)}
          onResolved={() => setShiftAckOpen(false)}
        />
      )}
    </div>
  );
}

function LeafMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 32 32">
      <path d="M16 5 C 9 10, 9 20, 16 27 C 23 20, 23 10, 16 5 Z"
            fill="none" stroke="#8FB39A" strokeWidth="1.5" strokeLinejoin="round"/>
      <line x1="16" y1="5" x2="16" y2="27" stroke="#8FB39A" strokeWidth="1.3"/>
    </svg>
  );
}
