import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  LayoutDashboard, ClipboardList, Users, Calendar as CalIcon, Settings,
  Plus, LogOut, Activity, ShieldCheck, RefreshCw
, Clock , BarChart3 } from 'lucide-react';
import { supabase, directGet } from '../supabaseClient.js';
import Dashboard from './Dashboard.jsx';
import Requests from './Requests.jsx';
import Employees from './Employees.jsx';
import CalendarView from './CalendarView.jsx';
import SettingsView from './SettingsView.jsx';
import ConnectivityTest from './ConnectivityTest.jsx';
import NewRequestModal from './NewRequestModal.jsx';
import EmployeeDetailModal from './EmployeeDetailModal.jsx';
import ShiftAcknowledgmentModal from './ShiftAcknowledgmentModal.jsx';
import InsightsView from './InsightsView.jsx';
import AdminPanel from './AdminPanel.jsx';
import PersonalDashboard from './PersonalDashboard.jsx';
import ManagerDashboard  from './ManagerDashboard.jsx';
import ReviewerPanel from './ReviewerPanel.jsx';
import EvergreenLogo from './EvergreenLogo.jsx';
import AttendanceView from './AttendanceView.jsx';
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

  // Employees tab — admin and reviewers only (Bashaier needs to see the directory).
  // Regular staff don't get this tab.
  if (isAdmin || isReviewer || isManager) {
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

  // Attendance — exclusively Bashaier (H94830) and Nadeem (H94152). Even other
  // HR reviewers do NOT see this tab. Per Nadeem's directive: the daily time-card
  // review, lateness emails, and the future evaluation-scoring escalation must be
  // visible only to him and Bashaier.
  const ATTENDANCE_PSNS = new Set(['H94830', 'H94152']);
  const myPsn = String(me?.id || me?.psn || '').toUpperCase();
  if (ATTENDANCE_PSNS.has(myPsn)) {
    const insertIdx = base.findIndex(t => t.id === 'calendar');
    base.splice(insertIdx >= 0 ? insertIdx + 1 : base.length, 0, { id: 'attendance', label: 'Attendance', icon: Clock });
  }
  if (isAdmin) {
    base.splice(5, 0, { id: 'admin', label: 'Admin', icon: ShieldCheck });
  }
  return base;
}

export default function AppShell({ session, me, onRefreshMe }) {
  // State declarations come FIRST so derived flags can read 'employees'.
  const [pendingRegCount, setPendingRegCount] = useState(0);
  const [tab, setTab] = useState('dashboard');
  const [employees, setEmployees]       = useState([]);
  const [leaveTypes, setLeaveTypes]     = useState([]);
  const [requests, setRequests]         = useState([]);
  const [permissions, setPermissions]   = useState([]);
  const [balances, setBalances]         = useState([]);
  const [holidays, setHolidays]         = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState('');
  const [showNewRequest, setShowNewRequest] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [pendingShifts, setPendingShifts] = useState([]);
  const [shiftAckDismissed, setShiftAckDismissed] = useState(false);

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

  const loadAll = useCallback(async () => {
    setLoading(true);
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
    } catch (err) {
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

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

  const pendingCount = useMemo(() => requests.filter(r => r.status === 'pending').length, [requests]);

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
      {/* Header */}
      <header className="border-b" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper)' }}>
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between gap-4">
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
              onClick={() => {
                // Hard refresh — bust HTTP cache so the browser re-fetches the
                // JS bundle and the app re-runs all data loads. Use the URL
                // constructor so the nc= param is replaced (not duplicated)
                // when it's already present in the search string.
                try {
                  const url = new URL(window.location.href);
                  url.searchParams.set('nc', Date.now().toString());
                  window.location.replace(url.toString());
                } catch {
                  window.location.reload();
                }
              }}
              className="p-2.5 rounded-full border esau-refresh-btn"
              title="Refresh — fetch the latest data"
              aria-label="Refresh"
              style={{ borderColor: 'var(--border-soft)' }}>
              <RefreshCw className="w-4 h-4" />
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
        <div className="max-w-7xl mx-auto px-6 flex gap-1 overflow-x-auto">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
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
              {t.id === 'admin' && pendingRegCount > 0 && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full"
                  style={{ background: 'var(--clay)', color: 'var(--paper)' }}>
                  {pendingRegCount}
                </span>
              )}
            </button>
          ))}
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto px-6 mt-4">
          <div className="p-3 rounded-lg text-sm" style={{ background: 'rgba(184,74,62,0.1)', color: 'var(--clay)' }}>
            {error}
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-8 fade-in" key={tab}>
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
              onGoToRequests={() => setTab('requests')}
              onNewRequest={() => setShowNewRequest(true)}
            />
          ) : isManager ? (
            // ManagerDashboard: any user who has direct reports (manager_id===me.id
            // for some employee) but is not admin/HR. Same component for every
            // manager; data is scoped to their own direct reports.
            <ManagerDashboard
              me={me}
              employees={employees}
              onGoToReviews={() => setTab('reviews')}
            />
          ) : (
            <PersonalDashboard
              me={me}
              leaveTypes={leaveTypes}
              empMap={empMap}
              onOpenNewRequest={() => setShowNewRequest(true)}
            />
          )
        )}
        {tab === 'reviews' && (
          <ReviewerPanel me={me} />
        )}
        {tab === 'attendance' && (() => {
          // Defense in depth: even if someone forces tab='attendance' via URL or
          // dev tools, the Attendance feature only renders for the allowlisted PSNs.
          const _psn = String(me?.id || me?.psn || '').toUpperCase();
          if (!new Set(['H94830', 'H94152']).has(_psn)) return null;
          return <AttendanceView me={me} employees={employees} />;
        })()}
        {tab === 'requests' && (
          <Requests
            requests={requests} leaveTypes={leaveTypes}
            typeMap={typeMap} empMap={empMap}
            onDecide={decideRequest} onDelete={deleteRequest}
            onNewRequest={() => setShowNewRequest(true)}
          />
        )}
        {tab === 'employees' && (isAdmin || isReviewer || isManager) && (
          <Employees
            employees={employees} leaveTypes={leaveTypes}
            requests={requests} balances={balances}
            onSelect={setSelectedEmployee}
          />
        )}
        {tab === 'calendar' && (
          <CalendarView
            requests={requests} empMap={empMap} typeMap={typeMap} holidays={holidays}
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

      {showNewRequest && (
        <NewRequestModal
          me={me}
          employees={employees} leaveTypes={leaveTypes}
          requests={requests} balances={balances} holidays={holidays}
          onClose={() => setShowNewRequest(false)}
          onSubmit={async (payload) => {
            await createRequest(payload);
            setShowNewRequest(false);
          }}
        />
      )}

      {selectedEmployee && (
        <EmployeeDetailModal
          employee={selectedEmployee}
          leaveTypes={leaveTypes}
          requests={requests.filter(r => r.employee_id === selectedEmployee.id)}
          balances={balances.filter(b => b.employee_id === selectedEmployee.id)}
          typeMap={typeMap}
          me={me}
          onClose={() => setSelectedEmployee(null)}
        />
      )}

      {pendingShifts.length > 0 && !shiftAckDismissed && (
        <ShiftAcknowledgmentModal
          me={me}
          pendingShifts={pendingShifts}
          employees={employees}
          onClose={() => setShiftAckDismissed(true)}
          onResolved={() => setShiftAckDismissed(true)}
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
