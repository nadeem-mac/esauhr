import React, { useEffect, useMemo, useState, useCallback, Suspense, lazy } from 'react';
import {
  LayoutDashboard, ClipboardList, Users, Calendar as CalIcon, Settings,
  Plus, LogOut, Activity, ShieldCheck, RefreshCw
, Clock , BarChart3, UserPlus, Database, Loader2, NotebookPen, CalendarDays } from 'lucide-react';
import { supabase, directGet, directPatch, directPost } from '../supabaseClient.js';
import { loadTemplates as loadEmailTemplates } from '../lib/emailTemplates.js';
// EAGER — landing destinations, must paint immediately after sign-in.
// These are the three dashboards (one of which always renders on first
// load), the Requests tab (a common follow-up navigation), small
// chrome elements, and the success toast.
import Dashboard from './Dashboard.jsx';
import PersonalDashboard from './PersonalDashboard.jsx';
import ManagerDashboard  from './ManagerDashboard.jsx';
import Requests from './Requests.jsx';
import SuccessToast, { bodyForStage } from './SuccessToast.jsx';
import EvergreenLogo from './EvergreenLogo.jsx';
// LAZY — tab pages and modals only loaded on demand. Cuts ~1MB+ from
// the initial bundle. Each becomes its own chunk that fetches when
// the user navigates to that tab or opens that modal. Suspense
// fallbacks below keep the UI responsive during the small fetch.
const ManagerMonthlyPlanner   = lazy(() => import('./ManagerMonthlyPlanner.jsx'));
const ManagerShiftStatusCard  = lazy(() => import('./ManagerShiftStatusCard.jsx'));
const TeamShiftMonthCard      = lazy(() => import('./TeamShiftMonthCard.jsx'));
const Employees               = lazy(() => import('./Employees.jsx'));
const CalendarView            = lazy(() => import('./CalendarView.jsx'));
const SettingsView            = lazy(() => import('./SettingsView.jsx'));
const ConnectivityTest        = lazy(() => import('./ConnectivityTest.jsx'));
const NewRequestModal         = lazy(() => import('./NewRequestModal.jsx'));
const RequestTypePicker       = lazy(() => import('./RequestTypePicker.jsx'));
const QuickSickConfirm        = lazy(() => import('./QuickSickConfirm.jsx'));
const GetWellSoonOverlay      = lazy(() => import('./GetWellSoonOverlay.jsx'));
const SickLeaveModal          = lazy(() => import('./SickLeaveModal.jsx'));
const PermissionRequestModal  = lazy(() => import('./PermissionRequestModal.jsx'));
const EmployeeDetailModal     = lazy(() => import('./EmployeeDetailModal.jsx'));
const ShiftAcknowledgmentModal = lazy(() => import('./ShiftAcknowledgmentModal.jsx'));
const InsightsView            = lazy(() => import('./InsightsView.jsx'));
const AdminPanel              = lazy(() => import('./AdminPanel.jsx'));
const HiringView              = lazy(() => import('./HiringView.jsx'));
const ReviewerPanel           = lazy(() => import('./ReviewerPanel.jsx'));
const MonthlyReportsCard      = lazy(() => import('./MonthlyReportsCard.jsx'));
const BashaierTasksCard       = lazy(() => import('./BashaierTasksCard.jsx'));
const AttendanceView          = lazy(() => import('./AttendanceView.jsx'));
const RefreshOverlay          = lazy(() => import('./RefreshOverlay.jsx'));
const GovernmentDataSync      = lazy(() => import('./GovernmentDataSync.jsx'));
const OrgChartView            = lazy(() => import('./OrgChartView.jsx'));
const Logbook                 = lazy(() => import('./Logbook.jsx'));
const HolidayShifts           = lazy(() => import('./HolidayShifts.jsx'));
import { getBlockingDeclarations, getExtendableDeclaration } from '../lib/sickDeclaration.js';
import { logAction } from '../lib/audit.js';
import { fmtDate } from '../lib/leaveLogic.js';
import { useSessionGuard } from '../lib/sessionGuard.js';

// Fallback shown while a lazy-loaded chunk is in flight. Light-weight
// so it doesn't compete for paint with whatever is about to mount.
function ChunkLoader({ inline = false }) {
  return (
    <div className={inline ? "py-3 flex items-center justify-center" : "py-16 flex items-center justify-center"}>
      <Loader2 className="w-4 h-4 animate-spin" style={{ color: '#0F4C2A', opacity: 0.6 }} />
    </div>
  );
}

function buildTabs({ isAdmin, isReviewer, isManager, isHrReviewer, isHiringViewer, me }) {
  // Tab visibility rules:
  //   Regular staff   → Dashboard, Requests, Calendar (no Employees, Settings, Diagnostics)
  //   Reviewer/Manager → adds Reviews + Attendance, hides Diagnostics
  //   Admin            → everything including Employees, Settings, Admin, Diagnostics
  //
  // Logbook tab is gated separately by exact PSN match — see further
  // down for the constant and rationale.
  const LOGBOOK_PSNS = ['H94830', 'H94152'];   // Bashaier + Nadeem

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

  // Hiring tab — admin and HR-reviewer have full edit rights;
  // hiring-viewer roles (Badria, Fahad SUP, Jaffar) get read-only
  // access to the same pipeline view. Read-only enforcement happens
  // inside HiringView/OffersCard via the readOnly prop, not here —
  // this gate just opens the door.
  if (isAdmin || isHrReviewer || isHiringViewer) {
    base.push({ id: 'hiring', label: 'Hiring', icon: UserPlus });
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

  // Logbook — private manual-entry workspace. Hard-gated by PSN to
  // Bashaier (H94830) and Nadeem (H94152) only. Bashaier uses this
  // to record paper/email leave applications she's still receiving
  // offline — entries write straight into leave_requests as approved.
  // Nadeem 2026-05-21: 'a separate tab which stays exclusively for
  // Bashaier where she can manually enter annual leaves by herself
  // … the data when she enters it gets updated in the master'.
  // No one else sees this tab. If access needs to expand later,
  // add the PSN to LOGBOOK_PSNS below.
  if (LOGBOOK_PSNS.includes(me?.id)) {
    base.push({ id: 'logbook', label: 'Logbook', icon: NotebookPen });
  }

  // MOL · GOSI — government data sync. Admin (Nadeem) and HR reviewer
  // (Bashaier) both manage the periodic MOL/GOSI subscriber-list
  // reconciliation, so both roles get this tab. The label uses the
  // dot separator to mirror the way Saudi government documents
  // typically reference the two systems together.
  if (isAdmin || isHrReviewer) {
    base.push({ id: 'mol_sync', label: 'MOL · GOSI', icon: Database });
  }

  // Diagnostics — admin only (Bashaier and staff don't see it)
  if (isAdmin) {
    base.push({ id: 'diagnostics', label: 'Diagnostics', icon: Activity });
  }

  // Reports — HR-reviewer (Bashaier) only. Replaces the YOUR TASKS
  // tile that used to live on her dashboard, and the REPORTS button
  // that briefly lived in the header. Sits between Requests and
  // Reviews so the queue of "things Bashaier owns end-to-end" reads
  // left-to-right: Requests (raise), Reports (draft), Reviews
  // (approve). Admin doesn't see it (Mr John reports are not in
  // their workflow).
  if (isHrReviewer && !isAdmin) {
    base.splice(2, 0, { id: 'reports', label: 'Reports', icon: ClipboardList });
  }

  // Reviews — for reviewers/managers who aren't admin
  if ((isReviewer || isManager) && !isAdmin) {
    // Insert after Reports if it exists, otherwise at index 2
    const reportsIdx = base.findIndex(t => t.id === 'reports');
    base.splice(reportsIdx >= 0 ? reportsIdx + 1 : 2, 0, { id: 'reviews', label: 'Reviews',  icon: ShieldCheck });
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

  // Holiday Shifts — Eid OT scheduling. Visible to managers, HR
  // reviewer, and admin. Replaces the manager-emailed Excel that
  // currently captures who works during Eid Al Adha / Eid Al Fitr /
  // National Day. Phase 3 of the holiday-OT module. Nadeem
  // 2026-05-21.
  if (isManager || isAdmin || isHrReviewer) {
    base.push({ id: 'holiday_shifts', label: 'Holiday Shifts', icon: CalendarDays });
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
  // Recent 'present' attendance rows — drives the urgent
  // "back-at-work-without-cert" flag for sick-cert chasing. Only
  // present-status rows from the last 60 days; absent/leave rows
  // aren't needed for this signal. Keeps the payload small.
  const [attendancePresent, setAttendancePresent] = useState([]);
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
  // Submission success toast — shown after any leave / permission /
  // sick declaration is submitted. Replaces the silent modal-close
  // UX where the user couldn't tell whether their submission worked.
  // Shape: { title, body, actionLabel, onAction } | null
  // Auto-dismisses after 6s; SuccessToast handles the timer.
  const [submissionToast, setSubmissionToast] = useState(null);
  // Sick-leave success overlay: shows the "Get well soon" full-screen
  // message for ~4s after a successful sick declaration via the
  // QuickSickConfirm bottom sheet. Lives at the AppShell level (not
  // inside the modal) so it survives the modal's remount cycle that
  // happens when the post-insert data refresh fires.
  const [getWellOpen, setGetWellOpen] = useState(false);
  // The actual sick-leave payload that was submitted. Used by the
  // GetWellSoonOverlay to prefill the HR/SUP email with the correct
  // start/end dates + day count. Cleared when the overlay dismisses.
  const [getWellSickPayload, setGetWellSickPayload] = useState(null);
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
  // Org chart modal — opened from the Dashboard via the Generate
  // Org Chart button shown only to admin (Nadeem) and HR reviewer
  // (Bashaier). Closes on backdrop click, X button, or Escape.
  const [orgChartOpen, setOrgChartOpen] = useState(false);

  // Pending migration count — number of bundled SQL migrations that
  // haven't been applied to this database yet (status: never_run) plus
  // ones whose bundled SQL has changed since the last run (status:
  // changed). Surfaced as a badge on the Settings tab + the Migrations
  // sidebar item so Nadeem (admin) sees at a glance when a new
  // migration was added by a deploy.
  //
  // null = not yet loaded; we don't show a 0 badge in that case to
  // avoid flickering. number = actual count (0 means "all up to date").
  const [pendingMigrationCount, setPendingMigrationCount] = useState(null);

  // Derived flags — must be AFTER all useState() so employees is in scope.
  const isAdmin    = Boolean(me?.is_admin);
  const isReviewer = Boolean(me?.can_review_leave || me?.can_review_permissions);
  const isHrReviewer = Boolean(me?.is_hr_reviewer);
  const isManager  = useMemo(
    () => (employees || []).some(e => e.manager_id === me?.id),
    [employees, me?.id]
  );

  // Read-only Hiring viewers — currently EMPTY. Only Nadeem (admin)
  // and Bashaier (HR reviewer) have Hiring access, via their isAdmin
  // and isHrReviewer flags above. The viewer allowlist mechanism is
  // preserved (not deleted) in case HR wants to grant read-only
  // access to others again in future — just add PSN/email entries.
  //
  // History:
  //   2026-05-18  Removed Fahad H94712 per Nadeem
  //   2026-05-18  Removed Badria + Jaffar per Nadeem ('only Bashaier
  //               has the access')
  const HIRING_VIEWER_PSNS = [];
  const HIRING_VIEWER_EMAILS = [];
  const isHiringViewer = Boolean(
    me && (
      HIRING_VIEWER_PSNS.includes(me.id) ||
      HIRING_VIEWER_EMAILS.includes((me.email || '').toLowerCase())
    )
  );

  const TABS = useMemo(
    () => buildTabs({ isAdmin, isReviewer, isManager, isHrReviewer, isHiringViewer, me }),
    [isAdmin, isReviewer, isManager, isHrReviewer, isHiringViewer, me?.id, me?.psn]
  );

  const loadAll = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      // Use directGet (raw fetch with timeout) instead of the supabase-js builder
      // to avoid the gotrue-js Web Lock wedge that intermittently hangs the first
      // query after sign-in. Each call has a hard timeout; failures degrade to [].
      const safe = (p) => p.catch((err) => { console.warn('load failed:', err); return []; });
      // Attendance window for the urgent back-at-work signal — last
      // 60 days is plenty (any sick declaration older than that is
      // either resolved or in admin-cleanup territory).
      const attWindowFrom = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      const [e, t, r, b, h, p, ad] = await Promise.all([
        safe(directGet('employees',           'select=*&order=name',                  { timeoutMs: 12000 })),
        safe(directGet('leave_types',         'select=*&order=sort_order',            { timeoutMs: 8000  })),
        safe(directGet('leave_requests',      'select=*&order=requested_at.desc',     { timeoutMs: 12000 })),
        safe(directGet('leave_balances',      'select=*',                             { timeoutMs: 8000  })),
        safe(directGet('public_holidays',     'select=*&order=date',                  { timeoutMs: 8000  })),
        safe(directGet('permission_requests', 'select=*&order=permission_date.desc',  { timeoutMs: 8000  })),
        safe(directGet('attendance_daily',
          `select=employee_id,attendance_date,status&status=eq.present&attendance_date=gte.${attWindowFrom}`,
          { timeoutMs: 10000 })),
      ]);

      setEmployees(Array.isArray(e) ? e : []);
      setLeaveTypes(Array.isArray(t) ? t : []);
      setRequests(Array.isArray(r) ? r : []);
      setBalances(Array.isArray(b) ? b : []);
      setHolidays(Array.isArray(h) ? h : []);
      setPermissions(Array.isArray(p) ? p : []);
      setAttendancePresent(Array.isArray(ad) ? ad : []);

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

  useEffect(() => {
    // Initial load on mount AND a silent refresh the moment `me`
    // first becomes available. Without this dual trigger, AppShell
    // sometimes mounted with me=null (parent hadn't finished its
    // auth fetch yet), did its initial loadAll(), then the dashboards
    // rendered with whatever data had landed before me arrived. The
    // landing page would look incomplete and a tab click was needed
    // to remount and recover. This keeps the visible flow clean:
    //   • silent=false on the very first call (shows spinner)
    //   • silent=true once me is truthy (no second spinner flash)
    if (!me?.id) {
      loadAll();
    } else {
      loadAll(true);
    }
  }, [loadAll, me?.id]);

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

  // Pending schema migrations badge (admin only).
  //
  // A bundled migration is "pending" if its status is 'never_run' or
  // 'changed' — i.e. either has never been applied to this DB, or was
  // applied previously but the SQL has been edited since (so re-running
  // would reveal a delta). Both cases warrant attention.
  //
  // We only fetch once per Settings-tab visit + on the initial admin
  // session — no realtime subscription needed because migrations are
  // ALWAYS applied via Bashaier/Nadeem clicking Run, not by an
  // out-of-band process. The MigrationsPanel's own Refresh button +
  // post-run reload cover the cases where the count changes.
  //
  // refreshMigrationCount is exposed via callback so MigrationsPanel
  // can trigger a recount after a successful run (drops the badge
  // back to 0 without forcing a page reload).
  const refreshMigrationCount = useCallback(async () => {
    if (!isAdmin) { setPendingMigrationCount(null); return; }
    try {
      // Lazy import — keeps the migrationRunner code out of the main
      // bundle for non-admins.
      const { listMigrationsWithStatus } = await import('../lib/migrationRunner.js');
      const { items, installed } = await listMigrationsWithStatus();
      // If the runner table doesn't exist yet, every bundled migration
      // is effectively pending. We surface the same count as if they
      // were all 'never_run'; the panel itself will tell Nadeem to run
      // the bootstrap SQL first.
      if (!installed) { setPendingMigrationCount(items.length); return; }
      const pending = items.filter(m => m.status === 'never_run' || m.status === 'changed').length;
      setPendingMigrationCount(pending);
    } catch (err) {
      console.warn('Migration count load failed:', err?.message || err);
      // On error, hide the badge entirely rather than show a wrong
      // number. Nadeem will see the actual state when he opens the
      // Migrations panel.
      setPendingMigrationCount(null);
    }
  }, [isAdmin]);

  useEffect(() => { refreshMigrationCount(); }, [refreshMigrationCount]);

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
      pending = setTimeout(() => { pending = null; loadAll({ silent: true }); }, 400);
    };
    const channel = supabase.channel('leave-desk-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_requests' }, debouncedLoad)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'permission_requests' }, debouncedLoad)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employees' }, debouncedLoad)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_types' }, debouncedLoad)
      .subscribe();
    return () => {
      if (pending) clearTimeout(pending);
      supabase.removeChannel(channel);
    };
  }, [loadAll]);

  // Live-update fallback — interval polling + window-focus refetch.
  // Per Nadeem (2026-05-06): "the system is not live updating soon as
  // Nadeem applying his request, sadakath has to refresh his screen
  // only then he can see Nadeem's request, and once sadakath approves
  // it should go to Bashaier for final approval it should happen
  // instant and live." The Supabase realtime channel above is best-
  // effort — the project's known supabase-js wedging issue means it
  // sometimes silently drops events. This polling layer guarantees
  // every screen catches up within ~20 seconds even when realtime is
  // dead in the water. Focus-refetch makes Alt-Tab feel instant.
  useEffect(() => {
    if (!session) return undefined;
    let intervalId = null;
    const tick = () => {
      if (document.hidden) return; // don't waste cycles on hidden tabs
      loadAll({ silent: true });
    };
    intervalId = setInterval(tick, 20_000);
    const onFocus = () => loadAll({ silent: true });
    const onVisibilityChange = () => {
      if (!document.hidden) loadAll({ silent: true });
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      if (intervalId) clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [loadAll, session]);

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

  // Set of employee_ids who have an active pending_certificate sick
  // declaration AND have shown up to work since their declared
  // start_date — i.e. they're back at the office but haven't uploaded
  // the Sehhaty cert yet. Bashaier gets a visual nudge (red pulsing
  // bell on the row) plus a tab badge bump for these. Recomputed in
  // memory from the data already loaded — no extra fetch.
  const urgentCertEmpIds = useMemo(() => {
    const out = new Set();
    if (!requests?.length || !attendancePresent?.length) return out;
    // Group present-attendance dates by employee for O(1) lookup.
    const presentByEmp = new Map();
    for (const row of attendancePresent) {
      if (!row?.employee_id || !row?.attendance_date) continue;
      if (!presentByEmp.has(row.employee_id)) presentByEmp.set(row.employee_id, []);
      presentByEmp.get(row.employee_id).push(row.attendance_date);
    }
    for (const req of requests) {
      if (req.leave_type_id !== 'sick') continue;
      if (req.stage !== 'pending_certificate') continue;
      if (req.sehhaty_code) continue;
      if (req.sick_cert_exempt) continue;
      const presentDates = presentByEmp.get(req.employee_id);
      if (!presentDates?.length) continue;
      // Back-at-work if any 'present' day falls on or after the
      // declared start_date. Covers both 'returned post-leave' and
      // 'declared sick but actually came in' scenarios.
      const startDate = req.start_date;
      if (!startDate) continue;
      if (presentDates.some(d => d >= startDate)) {
        out.add(req.employee_id);
      }
    }
    return out;
  }, [requests, attendancePresent]);

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
      count += (requests    || []).filter(r => r.leave_type_id !== 'sick' && (r.return_stage === 'pending_hr' || r.return_stage === 'pending_manager')).length;
      // Urgent: pending_certificate sick rows where staff is back at
      // work. These don't show in /^pending/ regex above (pending_hr
      // / pending_manager only) but they need Bashaier's nudge action.
      count += urgentCertEmpIds.size;
    } else if (isHrReviewer) {
      count += (requests    || []).filter(r => r.stage === 'pending_hr').length;
      count += (permissions || []).filter(p => p.stage === 'pending_hr').length;
      // Bashaier sees pending_hr rejoinings as actionable AND
      // pending_manager rejoinings as informational (per the
      // landing-page card design). The badge surfaces both so she
      // never misses the new ones rolling in. Sick rows are excluded —
      // medical absences don't go through the rejoining workflow
      // (Nadeem 2026-05-16).
      count += (requests    || []).filter(r => r.leave_type_id !== 'sick' && (r.return_stage === 'pending_hr' || r.return_stage === 'pending_manager')).length;
      // Urgent back-at-work cert chases — see comment above.
      count += urgentCertEmpIds.size;
    } else if (directReportIds.size > 0) {
      // Manager — only their direct reports' pending_manager rows
      count += (requests    || []).filter(r => r.stage === 'pending_manager' && directReportIds.has(r.employee_id)).length;
      count += (permissions || []).filter(p => p.stage === 'pending_manager' && directReportIds.has(p.employee_id)).length;
      count += (requests    || []).filter(r => r.leave_type_id !== 'sick' && r.return_stage === 'pending_manager' && directReportIds.has(r.employee_id)).length;
    }
    return count;
  }, [requests, permissions, employees, me, isAdmin, isHrReviewer, urgentCertEmpIds]);

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
      // Clear the single-session UUID too so the next login starts clean.
      localStorage.removeItem('esau_session_id');
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

  // Single-session enforcement + 10-min idle auto-logout. Polls every
  // 30s for the server's current_session_id and listens for activity
  // events to reset the idle timer. See src/lib/sessionGuard.js for
  // the mechanism. Nadeem 2026-05-21.
  useSessionGuard(me, signOut);

  // Pending-holiday-shifts badge — HR + admin see a count of nominations
  // awaiting their approval on the Holiday Shifts tab. Refreshes every
  // 60s + after focus, so Bashaier doesn't need to manually re-open
  // the tab to know there's new work. Nadeem 2026-05-21 Phase 4.
  const [pendingHolidayShiftCount, setPendingHolidayShiftCount] = useState(0);
  useEffect(() => {
    if (!(isAdmin || isHrReviewer)) { setPendingHolidayShiftCount(0); return; }
    let cancelled = false;
    const fetchCount = async () => {
      try {
        const rows = await directGet('holiday_shifts',
          'select=id&status=eq.pending&limit=500', { timeoutMs: 6000 });
        if (!cancelled) setPendingHolidayShiftCount((rows || []).length);
      } catch (_) { /* silent — the badge is a nice-to-have */ }
    };
    fetchCount();
    const id = setInterval(fetchCount, 60 * 1000);
    const onFocus = () => fetchCount();
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [isAdmin, isHrReviewer]);

  const createRequest = async (payload) => {
    // CRITICAL — use directPost, not supabase.from().insert(). The
    // supabase-js builder chain silently wedges in this project (see
    // architectural rule). Same fix applied to PermissionRequestModal —
    // intermittent silent insert failures meant requests were never
    // landing in the DB even though the UI said "submitted".
    //
    // The payload carries: substitute_ids, substitute_decisions, stage.
    // The DB trigger sync_leave_status_with_stage auto-derives status
    // from stage, so we don't pass status here.
    const row = {
      ...payload,
      requested_at: new Date().toISOString(),
      requested_by: session.user.email,
    };
    const created = await directPost('leave_requests', row, { timeoutMs: 12000 });
    const data = Array.isArray(created) ? created[0] : created;

    // ── Same-day sick declaration → write the attendance row right away
    //
    // For sick leaves declared TODAY (start_date = today), upsert an
    // attendance_daily row so the grid reflects the absence immediately
    // — without waiting for manager+HR approval. Without this, today's
    // grid cell would show as 'absent' (no punch) until approval lands,
    // which can be hours or days later. That's a record-keeping gap.
    //
    // Future days of a multi-day quick-sick declaration are NOT written
    // here — they get picked up by the existing reevaluateBackfillRows
    // flow once the row hits `status='approved'`. Writing them now would
    // pre-mark days that haven't happened yet, and rejection rollback
    // would be more complex. Today is the only urgent case.
    //
    // If the row is later REJECTED, today's attendance entry still
    // points to the (rejected) leave_request_id. A follow-up cleanup
    // step at reject time can flip the status back to 'absent'. That
    // edge case is not handled yet — flagged for the cert chase /
    // rejection-handling work.
    try {
      const todayIso = new Date().toISOString().slice(0, 10);
      if (
        payload.leave_type_id === 'sick'
        && payload.start_date === todayIso
        && data?.id
      ) {
        const attendanceRow = {
          employee_id:      payload.employee_id,
          attendance_date:  todayIso,
          status:           'sick_leave',
          leave_request_id: data.id,
          source:           'self_declared',
          recorded_by:      session.user.email,
          recorded_at:      new Date().toISOString(),
          notes:            'Same-day sick declaration via quick-sick flow.',
        };
        await directPost('attendance_daily', attendanceRow, {
          upsert:     true,
          onConflict: 'employee_id,attendance_date',
          timeoutMs:  9000,
        });
      }
    } catch (e) {
      // Non-blocking — the leave_request itself is already saved.
      // Worst case the attendance row gets backfilled later by re-eval.
      console.warn('[createRequest] attendance same-day write failed (non-blocking)', e);
    }

    const empName = empMap[payload.employee_id]?.name || payload.employee_id;
    const typeName = typeMap[payload.leave_type_id]?.name || payload.leave_type_id;
    logAction(me, 'leave_request_create', {
      targetType: 'leave_request',
      targetId: data?.id,
      targetLabel: `${empName} · ${typeName} · ${payload.start_date} → ${payload.end_date}`,
      details: { employee_id: payload.employee_id, leave_type_id: payload.leave_type_id, days: payload.days, stage: data?.stage || payload.stage },
    });
    // Show success confirmation. Self-submitted requests get a "track
    // your status" pointer; admin/HR submissions on someone else's behalf
    // get a generic acknowledgement (the staff being submitted FOR isn't
    // the one looking at this dashboard, so the action button would
    // navigate to the wrong place).
    const submittedForSelf = payload.employee_id === me?.id;
    setSubmissionToast({
      title: submittedForSelf ? 'Request submitted' : `Request submitted for ${empName}`,
      body: submittedForSelf
        ? bodyForStage(data?.stage || payload.stage)
        : `${typeName} · ${payload.start_date} → ${payload.end_date}`,
      actionLabel: submittedForSelf ? 'View in your applications' : null,
      onAction: submittedForSelf
        ? () => {
            const el = document.getElementById('your-applications');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        : null,
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

  // Admin-only — wipe a permission request from history. Same shape
  // as deleteRequest above so the Requests tab can call either with
  // a uniform onDelete prop. Per Nadeem: "How I can clear the applied
  // leave of all type for any staff … only my ID has access to do
  // this". The button-level gate lives in Requests.jsx; this server
  // call also fails for non-admins via RLS on permission_requests.
  const deletePermission = async (id) => {
    const req = permissions.find(p => p.id === id);
    const empName = req ? (empMap[req.employee_id]?.name || req.employee_id) : '';
    const { error } = await supabase.from('permission_requests').delete().eq('id', id);
    if (error) throw error;
    logAction(me, 'permission_request_delete', {
      targetType: 'permission_request',
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
      <Suspense fallback={null}>
        <RefreshOverlay open={refreshing} />
      </Suspense>

      {/* Header — sticky so the top brand + tab nav stays visible while
          long pages (Attendance grid, calendar, request lists) are
          scrolled. z-index above page content but below modals. */}
      <header className="border-b sticky top-0 z-30" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper)' }}>
        <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <EvergreenLogo variant="full" size="md" />
          </div>

          <div className="flex items-center gap-4">
            {/* Build timestamp — admin-only. Useful for Nadeem to
                verify a freshly-pushed deploy actually went live, but
                clutter for everyone else. Per Nadeem 2026-05-09:
                hide from regular users. */}
            {isAdmin && (
              <div
                className="hidden md:inline-flex items-center text-[9px] px-2 py-0.5 rounded"
                style={{
                  background: '#F4F4EE',
                  color: '#7A7A7A',
                  border: '1px solid #E5E5DD',
                  letterSpacing: '0.05em',
                  fontFamily: 'monospace',
                }}
                title="Frontend build timestamp — verifies you have the latest deploy after a push"
              >
                build {typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : '—'}
              </div>
            )}
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
            {/* REPORTS button removed from header — now lives as a
                full tab between Requests and Reviews. See buildTabs. */}
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
                //   3. Hold for at least 2 seconds so the user sees the
                //      ship animation play out (Nadeem's call — long
                //      enough to register, short enough not to feel
                //      sluggish)
                //   4. Reload with cache bypass
                if (refreshing) return;
                setRefreshing(true);

                // Per Nadeem: "when you refresh, it should go straight
                // to the landing page with the most updated version".
                // The active tab is persisted in sessionStorage to
                // survive reloads — clear it so the next mount falls
                // back to 'dashboard' (the default landing tab).
                try { sessionStorage.removeItem('esauhr.tab'); } catch {}

                // Cleanup runs in parallel with the 2-second hold.
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

                //   3. Hold for at least 2 seconds so the user sees the
                //      ship animation play out (Nadeem's call — long
                //      enough to register, short enough not to feel
                //      sluggish)
                const minHold = new Promise(r => setTimeout(r, 2000));

                // Wait for whichever finishes LAST — cleanup OR the 2s
                // hold — so we never reload before the animation has had
                // its moment.
                await Promise.all([cleanup, minHold]);

                // Cache-bust query so the browser must re-fetch index.html
                // and pull the newest hashed asset bundles. Strip any
                // existing query params first so we land on the bare home
                // URL (with just the cache-buster) — keeps the post-reload
                // route clean.
                const base = window.location.origin + window.location.pathname.replace(/[?#].*$/, '');
                const fresh = `${base}?_r=${Date.now()}`;
                window.location.replace(fresh);
              }}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border esau-refresh-btn text-[12px]"
              title="Set sail again ⚓ — reload the freshest version of the portal"
              aria-label="Refresh the portal"
              style={{
                /* Default state: brand-green tinted pill so the button
                   reads as an action, not just chrome. Bumped from a
                   tiny icon-only button to a labeled pill per Nadeem:
                   "The refresh button needs to be seen clearly".
                   Active state (refreshing): solid evergreen surface,
                   white icon + label, soft pulsing ring around it —
                   unmistakable that the click registered. */
                background: refreshing ? '#0F4C2A' : '#ECFDF5',
                borderColor: refreshing ? '#0F4C2A' : '#A7F3D0',
                color: refreshing ? '#FFFFFF' : '#0F4C2A',
                fontWeight: 700,
                lineHeight: 1,
                boxShadow: refreshing
                  ? '0 0 0 4px rgba(15, 76, 42, 0.18), 0 2px 8px rgba(15, 76, 42, 0.25)'
                  : 'none',
                transition: 'all 0.2s ease',
                cursor: refreshing ? 'wait' : 'pointer',
              }}>
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>{refreshing ? 'Setting sail…' : 'Refresh'}</span>
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
          {TABS.map(t => {
            const isLogbook = t.id === 'logbook';
            const isActive  = tab === t.id;
            return (
            <button key={t.id} onClick={() => setTabPersistent(t.id)}
              className="relative flex items-center gap-2 px-4 py-3 text-sm whitespace-nowrap transition-colors"
              style={{
                // Logbook gets a distinctive amber treatment — both
                // colour and weight — to mark it as Bashaier's special
                // workspace. Nadeem 2026-05-21: 'highlight the LOGBOOK
                // button to let it appear as special'.
                color: isLogbook
                  ? (isActive ? '#92400E' : '#A16207')
                  : (isActive ? 'var(--ink)' : 'var(--ink-soft)'),
                opacity: isActive ? 1 : (isLogbook ? 0.9 : 0.65),
                fontWeight: isLogbook ? 700 : 400,
                borderBottom: isActive
                  ? (isLogbook ? '2px solid #A16207' : '2px solid var(--evergreen-500)')
                  : '2px solid transparent',
                background: isLogbook
                  ? (isActive
                      ? 'linear-gradient(to bottom, transparent, #FEF3C7 90%)'
                      : 'linear-gradient(to bottom, transparent, rgba(254, 243, 199, 0.5) 90%)')
                  : 'transparent',
                marginBottom: '-1px',
              }}>
              <t.icon className="w-4 h-4" />
              {t.label}
              {/* Logbook sparkle badge — 'PRIVATE' pill so Bashaier
                  knows at a glance this is her dedicated workspace */}
              {isLogbook && (
                <span className="ml-1 text-[9px] px-1.5 py-0.5 rounded-full font-bold tracking-wider"
                      style={{ background: '#A16207', color: '#FFFFFF', letterSpacing: '0.05em' }}>
                  PRIVATE
                </span>
              )}
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
              {/* Holiday Shifts — amber pending count visible only to
                  HR + admin. Reads as 'work for you to action'. */}
              {t.id === 'holiday_shifts' && (isAdmin || isHrReviewer) && pendingHolidayShiftCount > 0 && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                  style={{ background: '#A16207', color: '#FFFFFF', minWidth: '18px', textAlign: 'center' }}
                  title={`${pendingHolidayShiftCount} holiday shift${pendingHolidayShiftCount === 1 ? '' : 's'} awaiting approval`}>
                  {pendingHolidayShiftCount}
                </span>
              )}
              {/* Settings — pending schema migrations badge. Red dot
                  matches the 'action needed' style used on Reviews so
                  Nadeem reads it as "you need to do something" rather
                  than informational. Hidden when count is 0 or null
                  (null = not yet loaded). */}
              {t.id === 'settings' && pendingMigrationCount > 0 && (
                <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                  style={{ background: '#DC2626', color: '#FFFFFF', minWidth: '18px', textAlign: 'center' }}
                  title={`${pendingMigrationCount} schema migration${pendingMigrationCount === 1 ? '' : 's'} pending — open Settings → Migrations to apply`}>
                  {pendingMigrationCount}
                </span>
              )}
            </button>
          );})}
        </div>
      </header>

      {error && (
        <div className="max-w-7xl mx-auto px-3 sm:px-6 mt-4">
          <div className="p-3 rounded-lg text-sm" style={{ background: 'rgba(184,74,62,0.1)', color: 'var(--clay)' }}>
            {error}
          </div>
        </div>
      )}

      <main
        className={`mx-auto fade-in ${tab === 'attendance' ? 'w-full px-4 sm:px-5 py-2 sm:py-3' : 'max-w-7xl px-3 sm:px-6 py-6 sm:py-8'}`}
        key={tab}
      >
        <Suspense fallback={<ChunkLoader />}>
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
              onOpenOrgChart={() => setOrgChartOpen(true)}
              onUploadCert={() => setRequestFlow('sick_unified_cert_only')}
            />
          ) : isManager ? (
            // ManagerDashboard: any user who has direct reports (manager_id===me.id
            // for some employee) but is not admin/HR. Same component for every
            // manager; data is scoped to their own direct reports.
            //
            // We pass AppShell's authoritative requests + permissions so the
            // manager's MyApplicationsCard sees ALL their own activity, not
            // just their reports' rows. ManagerDashboard's internal load()
            // continues to fetch reports-scoped data for the 'Pending approvals'
            // section — that one remains correctly scoped to direct reports.
            <ManagerDashboard
              me={me}
              employees={employees}
              allRequests={requests}
              allPermissions={permissions}
              leaveTypes={leaveTypes}
              onGoToReviews={() => setTabPersistent("reviews")}
              onGoToRequests={() => setTabPersistent("requests")}
              onGoToShifts={() => setTabPersistent("shifts")}
              onUploadCert={() => setRequestFlow('sick_unified_cert_only')}
              onToggleShiftStaff={async (employeeId, nextValue) => {
                // Manager flips employees.is_shift_staff on a direct
                // report. The flag drives the Shift Staff Attendance
                // Report in Bashaier's Attendance tab — only flagged
                // staff appear in the in/out/total-hours summary.
                // We also stamp who set the flag and when, for audit.
                await directPatch('employees', 'id', employeeId, {
                  is_shift_staff:        nextValue,
                  shift_staff_marked_by: me.id,
                  shift_staff_marked_at: new Date().toISOString(),
                });
                // Update local cache so the toggle stays consistent
                // without waiting for the next loadAll() pass.
                setEmployees(prev => prev.map(e =>
                  e.id === employeeId
                    ? { ...e, is_shift_staff: nextValue, shift_staff_marked_by: me.id, shift_staff_marked_at: new Date().toISOString() }
                    : e
                ));
              }}
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
              onUploadCert={() => setRequestFlow('sick_unified_cert_only')}
            />
          )
        )}
        {tab === 'reports' && isHrReviewer && !isAdmin && (
          /* REPORTS tab — Mr John report drafting card. HR-reviewer
             only (Bashaier). Replaces the YOUR TASKS tile that used
             to live on her dashboard, and the brief REPORTS button
             that lived in the header. */
          <BashaierTasksCard employees={employees} requests={requests} permissions={permissions} />
        )}
        {tab === 'reviews' && (
          <>
            {/* Monthly reports for Mr John — replaces the old login-popup
                reminder (🧚). Self-hides into a collapsible card when nothing
                is actionable so it stays calm during the quiet weeks of the
                month and surfaces (default-open) on the 1st / 15th / last-day. */}
            {isHrReviewer && <MonthlyReportsCard />}
            <ReviewerPanel me={me} urgentCertEmpIds={urgentCertEmpIds} onDataChange={() => loadAll({ silent: true })} />
          </>
        )}
        {tab === 'attendance' && (() => {
          // Defense in depth: even if someone forces tab='attendance' via URL or
          // dev tools, the Attendance feature only renders for users with the
          // can_view_attendance flag — OR for the universal admin (Nadeem),
          // who always has access regardless of which feature flags happen
          // to be set on his employee record.
          if (!me?.can_view_attendance && !me?.is_admin) return null;
          return <AttendanceView me={me} employees={employees} leaveTypes={leaveTypes} />;
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
            permissions={isAdmin ? permissions : permissions.filter(p => p.employee_id === me.id)}
            leaveTypes={leaveTypes}
            typeMap={typeMap} empMap={empMap}
            me={me}
            onDecide={decideRequest}
            onDelete={deleteRequest}
            onDeletePermission={deletePermission}
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
            <TeamShiftMonthCard me={me} employees={employees} />
            <ManagerMonthlyPlanner me={me} employees={employees} />
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
        {tab === 'hiring' && (isAdmin || isHrReviewer || isHiringViewer) && (
          <HiringView
            me={me}
            employees={employees}
            readOnly={!isAdmin && !isHrReviewer}
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
            pendingMigrationCount={pendingMigrationCount}
            onMigrationsChanged={refreshMigrationCount}
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
        {tab === 'mol_sync' && (isAdmin || isHrReviewer) && (
          <GovernmentDataSync me={me} />
        )}
        {tab === 'logbook' && ['H94830', 'H94152'].includes(me?.id) && (
          <Logbook
            me={me}
            employees={employees}
            leaveTypes={leaveTypes}
            onSaved={() => loadAll({ silent: true })}
          />
        )}
        {tab === 'holiday_shifts' && (isManager || isAdmin || isHrReviewer) && (
          <HolidayShifts
            me={me}
            employees={employees}
          />
        )}
        {tab === 'admin' && isAdmin && (
          <AdminPanel session={session} me={me} onRefreshMe={onRefreshMe} />
        )}
        </Suspense>
      </main>

      {/* Request flow router — picker first, then either the leave form or
          the permission form depending on what the staff member chose.

          Soft pressure (commit 3) — the picker is block-aware. If the
          staff has any pending_certificate row that's overdue (per the
          DB trigger's logic, mirrored client-side via
          getBlockingDeclarations), the picker hides every option except
          a cert-upload escape hatch. The 'sick_unified_cert_only' route
          is what that escape hatch routes to: opens SickLeaveModal with
          forceCertPath=true so the path picker is skipped.

          Why compute here vs. in a useMemo at the top: this only runs
          while the picker is open, which is rare and cheap. Hoisting
          to a useMemo would couple AppShell's state to a per-render
          filter that 99% of renders don't use. */}
      <Suspense fallback={null}>
      {(() => {
        const myDeclarations = (requests || []).filter(r => r.employee_id === me?.id);
        const blocking = getBlockingDeclarations(myDeclarations);
        const blockingDecl = blocking[0] || null;
        return (
          <>
            {requestFlow === 'pick' && (
              <RequestTypePicker
                onClose={() => setRequestFlow(null)}
                onPick={(type) => setRequestFlow(type)}
                leaveTypes={leaveTypes}
                me={me}
                blockingDeclaration={blockingDecl}
              />
            )}
          </>
        );
      })()}
      {requestFlow === 'quick_sick' && (
        <QuickSickConfirm
          me={me}
          employees={employees}
          onClose={() => setRequestFlow(null)}
          onSubmit={async (payload) => {
            // Insert IS the source of truth for success/failure. If the
            // post-insert loadAll() inside createRequest fails, that's a
            // refresh issue, not a submission issue — don't propagate it
            // up to QuickSickConfirm.
            try {
              await createRequest(payload);
            } catch (e) {
              console.warn('[AppShell] post-insert refresh failed (insert likely succeeded)', e);
              loadAll && loadAll().catch(() => {});
            }
            // Replace the generic submission toast with a dedicated
            // sick-leave overlay. createRequest already set a toast —
            // suppress it now that we're showing the bigger overlay.
            setSubmissionToast(null);
            // Capture the actual submitted payload (with the right
            // start/end dates and day count) so the overlay's email
            // template can describe the leave correctly.
            setGetWellSickPayload(payload);
            setGetWellOpen(true);
          }}
        />
      )}
      {(requestFlow === 'leave' || (typeof requestFlow === 'string' && requestFlow.startsWith('leave:'))) && (
        <NewRequestModal
          me={me}
          employees={employees} leaveTypes={leaveTypes}
          requests={requests} balances={balances} holidays={holidays}
          lockedLeaveType={
            typeof requestFlow === 'string' && requestFlow.startsWith('leave:')
              ? requestFlow.slice('leave:'.length)
              : null
          }
          onClose={() => setRequestFlow(null)}
          onSubmit={async (payload) => {
            await createRequest(payload);
            setRequestFlow(null);
          }}
        />
      )}
      {/* sick_unified → unified sick-leave entry. Internal toggle
          decides whether the staff is declaring without a cert (Path A,
          creates a leave_requests row in pending_certificate stage) or
          submitting a Sehhaty PDF they already have (Path B, sub-commit
          B will add the upload + extraction pipeline).
          Replaces the previous split between 'sick' and 'sick_declare'
          routes — one tile, one modal, two paths.

          sick_unified_cert_only — alternate entry routed FROM
          RequestTypePicker's blocking-state escape hatch. Same modal,
          but forceCertPath=true tells SickLeaveModal to skip the path
          picker and go straight to Path B (cert upload). The user
          arrived because their prior declaration is overdue; they
          can't declare a new sick day, only submit the missing cert.

          Both entries also pass `myDeclarations` so SickLeaveModal can
          surface the extend-by-1-day prompt when there's an extendable
          (still-pending, not-yet-blocking) declaration in the staff's
          recent history. */}
      {(requestFlow === 'sick_unified' || requestFlow === 'sick_unified_cert_only') && (
        <SickLeaveModal
          employee={me}
          employees={employees}
          forceCertPath={requestFlow === 'sick_unified_cert_only'}
          myDeclarations={(requests || []).filter(r => r.employee_id === me?.id)}
          onClose={() => setRequestFlow(null)}
          onCreated={(created) => {
            setRequestFlow(null);
            if (typeof loadAll === 'function') loadAll({ silent: true });
            // Stage-aware confirmation. Path A submissions land in
            // 'pending_certificate' — the toast nudges the staff to
            // submit the Sehhaty cert when they have it. Path B
            // (cert provided up-front) goes to pending_manager
            // and the body reflects that.
            //
            // The extension flow re-uses this onCreated path with
            // _extended=true on the returned row, which we pick up
            // here to render a different toast title.
            if (created?._extended) {
              setSubmissionToast({
                title: 'Sick declaration extended',
                body: `Your declaration now ends ${created.end_date} (${created.days} day${created.days === 1 ? '' : 's'}). Submit your Sehhaty certificate when you receive it.`,
                actionLabel: 'View in your applications',
                onAction: () => {
                  const el = document.getElementById('your-applications');
                  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                },
              });
              return;
            }
            const stage = created?.stage || 'pending_certificate';
            setSubmissionToast({
              title: stage === 'pending_certificate'
                ? 'Sick leave declared'
                : 'Sick leave submitted',
              body: bodyForStage(stage),
              actionLabel: 'View in your applications',
              onAction: () => {
                const el = document.getElementById('your-applications');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              },
            });
          }}
        />
      )}
      {(requestFlow === 'late_arrival' || requestFlow === 'early_leave') && (
        <PermissionRequestModal
          me={me}
          type={requestFlow}
          employees={employees}
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
          onSubmitted={() => {
            setRequestFlow(null);
            if (typeof loadAll === 'function') loadAll({ silent: true });
            // Permissions go straight to pending_manager. Use the
            // generic body for that stage so wording stays consistent
            // with the other submission types.
            setSubmissionToast({
              title: 'Permission requested',
              body: bodyForStage('pending_manager'),
              actionLabel: 'View in your applications',
              onAction: () => {
                const el = document.getElementById('your-applications');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              },
            });
          }}
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
          // After admin/HR-reviewer permanently deletes a staff
          // member from the danger zone, refresh the directory so
          // they vanish from every tab. The modal closes itself
          // immediately after firing this; we just kick a silent
          // reload so the in-memory list stays in sync.
          onDeleted={() => {
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

      {/* Org chart modal — renders the live tree built from
          employees.manager_id and offers a Download HTML option for
          standalone export. Only mounted while open so the lazy
          chunk doesn't load until the user actually opens it. */}
      {orgChartOpen && (
        <OrgChartView
          employees={employees}
          onClose={() => setOrgChartOpen(false)}
        />
      )}

      {/* App-wide submission success toast. Set by createRequest /
          SickLeaveModal.onCreated / PermissionRequestModal.onSubmitted.
          Auto-dismisses after 6s; SuccessToast handles its own timer.
          Single instance — a fresh submission while one is showing
          replaces the prior toast (the timer resets via deps). */}
      {submissionToast && (
        <SuccessToast
          title={submissionToast.title}
          body={submissionToast.body}
          actionLabel={submissionToast.actionLabel}
          onAction={submissionToast.onAction}
          onDismiss={() => setSubmissionToast(null)}
        />
      )}

      {/* Get-well-soon overlay — fires after a successful quick-sick
          declaration. Rendered at AppShell level so the modal lifecycle
          can't reset its state. Stays open until the user dismisses or
          taps the email button. */}
      <GetWellSoonOverlay
        open={getWellOpen}
        me={me}
        employees={employees}
        payload={getWellSickPayload}
        onClose={() => {
          setGetWellOpen(false);
          // Clear the captured payload so the next time the overlay
          // opens it doesn't show stale dates from a previous
          // declaration. Cleared on close, not on open, so the
          // overlay's content stays stable while it's visible.
          setGetWellSickPayload(null);
        }}
      />
      </Suspense>
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
