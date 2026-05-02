import React, { useEffect, useState, useCallback } from 'react';
import { supabase, directPatch, directGet } from '../supabaseClient.js';
import { CheckCircle2, XCircle, Clock, Loader2, AlertTriangle, Sunrise, Sunset, Calendar, RefreshCw, Search, Plane, FileDown, ArrowLeftCircle, Mail } from 'lucide-react';
import { logAction } from '../lib/audit.js';
import HrApprovalModal from './HrApprovalModal.jsx';
import { downloadVacationFormForRequest, buildLeaveRejectionEmailDraft } from '../lib/vacationForm.js';
import PermissionApprovedModal from './PermissionApprovedModal.jsx';
import RejoiningApprovedModal from './RejoiningApprovedModal.jsx';
import { fmtDate, rejectionReasonsForLeaveType, findRejectionReason } from '../lib/leaveLogic.js';
import { PERMISSION_TYPES, summariseMonth } from '../lib/permissionLogic.js';

// Visible to anyone with can_review_leave OR can_review_permissions OR is_admin
// OR is a manager (has someone whose manager_id === me.id). After the dept-head
// flag revoke, "manager" is now derived from the org chart, not from a flag.

// Display label for a leave_type_id. Mirrors the seeded leave_types
// table (schema.sql) so the reviewer sees the same name on the card
// as in the request modal. Falls back to title-casing the id when an
// unknown type appears (e.g. a custom 'other' subtype).
const LEAVE_TYPE_LABELS = {
  annual:      'Annual',
  sick:        'Sick',
  unpaid:      'Unpaid',
  maternity:   'Maternity',
  paternity:   'Paternity',
  bereavement: 'Bereavement',
  hajj:        'Hajj',
  emergency:   'Emergency',
  other:       'Other',
};
const labelForLeave = (id) => {
  if (!id) return 'Leave';
  return LEAVE_TYPE_LABELS[id] || (id.charAt(0).toUpperCase() + id.slice(1));
};

// Brand-aligned colour per leave type — kept in sync with the colours
// seeded in schema.sql leave_types table so chips on the reviewer
// queue match chips in the request modal and elsewhere.
const LEAVE_TYPE_COLOURS = {
  annual:      '#0F4C2A',
  sick:        '#B84A3E',
  unpaid:      '#6B7280',
  maternity:   '#BE185D',
  paternity:   '#1D4ED8',
  bereavement: '#374151',
  hajj:        '#A16207',
  emergency:   '#D97706',
  other:       '#6B7280',
};
const pickLeaveTypeColor = (id) => LEAVE_TYPE_COLOURS[id] || '#6B7280';

export default function ReviewerPanel({ me }) {
  const [leave, setLeave]             = useState([]);
  const [perms, setPerms]             = useState([]);
  const [empMap, setEmpMap]           = useState({});
  // After Bashaier issues the FINAL HR approval on a permission, this holds
  // the freshly-approved row so PermissionApprovedModal opens with the
  // download letter / open email draft actions.
  const [approvedPermission, setApprovedPermission] = useState(null);
  // Same shape for rejoining — opens RejoiningApprovedModal either after
  // a fresh final approve or via the 'Letter / email' button on a row in
  // MY RECENT DECISIONS history.
  const [approvedRejoining,  setApprovedRejoining]  = useState(null);
  // History of permission decisions made by THIS HR reviewer in the last
  // 30 days. Surfaces below the active queue so Bashaier can review her
  // own decisions, re-open the timeline for context, and re-download
  // the letter / re-open the email draft if she missed it the first time.
  const [recentDecisions, setRecentDecisions] = useState([]);
  const [recentLeaveDecisions, setRecentLeaveDecisions] = useState([]);
  // Rejoining requests where Bashaier is the next reviewer
  // (return_stage='pending_hr'). Surfaced with the same urgency as
  // pending leave / permission rows so she sees them in the same
  // queue she already scans every morning.
  const [rejoinQueue, setRejoinQueue] = useState([]);
  // Rejoining decisions she's made in the last 90 days. Mirrors
  // recentLeaveDecisions / recentDecisions — searchable, dismissible,
  // re-downloadable .docx.
  const [recentRejoinDecisions, setRecentRejoinDecisions] = useState([]);
  const [historyQuery, setHistoryQuery] = useState('');
  // Recurring-permission detection. For each (employee_id, type) in
  // the current pending queue, we look up the same employee's last 60
  // days of approved permissions and group by weekday to spot
  // patterns ('every Monday', '3rd Monday in 4 weeks'). Surfaced as
  // an inline badge on the row so Bashaier can use the pattern as
  // context when deciding. Map shape:
  //   key: 'H94590|late_arrival'
  //   value: { count: 3, weekday: 'Mon', label: '3 Mondays in 4 weeks' }
  const [recurringPattern, setRecurringPattern] = useState(new Map());
  // Delegation: which staff in my queue belong to an absent manager
  // (one of my direct reports who is themselves a manager and on
  // approved leave covering today). Used to render a 'DELEGATED' pill
  // on those rows so the acting manager knows the request isn't from
  // someone they directly manage.
  const [delegatedStaffIds, setDelegatedStaffIds] = useState(new Set());
  const [absentManagerNames, setAbsentManagerNames] = useState([]);
  const [isManager, setIsManager]     = useState(false);
  const [loading, setLoading]         = useState(true);
  const [busyId, setBusyId]           = useState(null);
  const [hrModalReq, setHrModalReq]   = useState(null);
  // When set, the rejection modal is open for this leave request.
  // The modal asks the rejector to pick a reason from the dropdown
  // (filtered by the leave type) and optionally add a note. The
  // selected code + note get persisted on rejection so the staff
  // member can see the rejection reason on their My Applications card.
  const [rejectLeaveReq, setRejectLeaveReq] = useState(null);

  // Role flags for stage-based routing
  // - is_admin (Nadeem): sees both pending_manager and pending_hr
  // - is_hr_reviewer (Bashaier, Nadeem): sees pending_hr only (final HR approval)
  // - isManager (derived: has direct reports) AND not HR/admin: sees pending_manager
  //   for their own direct reports only. Replaces the old can_review_leave gate.
  const isAdmin       = !!me?.is_admin;
  const isHrReviewer  = !!me?.is_hr_reviewer;
  const isDeptManager = isManager && !isHrReviewer && !isAdmin;
  const canLeave      = isAdmin || isHrReviewer || isDeptManager;
  // canPerm = sees ALL permission_requests at the HR/admin tier (pending_hr)
  // canPermAsManager = is a regular manager who sees their direct reports'
  //   pending_manager rows. Distinct flag because the queue query, the
  //   header copy, and the empty-state messaging differ between the two
  //   roles. Without this the render was gated on canPerm only and a
  //   manager opened the Reviews tab to find their permission queue
  //   silently hidden, even though the data was fetched.
  const canPerm           = isAdmin || me?.can_review_permissions;
  const canPermAsManager  = isDeptManager;
  const canSeePerm        = canPerm || canPermAsManager;

  // Helper: race a Supabase query against a timeout so the UI doesn't hang forever
  const withTimeout = (p, ms = 10000, label = 'query') => Promise.race([
    Promise.resolve(p).then(r => r),
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
  ]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Use directGet (raw fetch) instead of supabase-js for all reads — the
      // JS client lazy builder occasionally wedges and never sends the query.
      const emps = await directGet('employees',
        'select=id,name,location,department,manager_id,email,join_date',
        { timeoutMs: 10000 });
      const map = {};
      (emps || []).forEach(e => { map[e.id] = e; });
      setEmpMap(map);

      // For dept managers we filter requests to their direct reports — anyone
      // whose manager_id === me.id. This is more accurate than the old
      // department-based filter and matches the org-chart definition of
      // "his own staff".
      const directReportIds = (emps || [])
        .filter(e => e.manager_id === me?.id)
        .map(e => e.id);

      // Delegation — when a direct report of mine is themselves a
      // manager AND they're on approved leave that covers today, their
      // own direct reports' pending requests need to go somewhere. They
      // route to me (the absent manager's manager). Without this the
      // requests would sit until the original manager returns.
      //
      // Find: managers M where M.manager_id === me.id, AND M has an
      // approved leave row whose [start_date, end_date] covers today.
      // Then add M's direct reports' PSNs to the queue.
      const today = new Date().toISOString().slice(0, 10);
      const absentManagerIds = new Set();
      try {
        const myDirectReportManagerIds = directReportIds.filter(id =>
          (emps || []).some(e => e.manager_id === id),
        );
        if (myDirectReportManagerIds.length) {
          const leavesQ = `select=employee_id,start_date,end_date,stage&stage=eq.approved&employee_id=in.(${myDirectReportManagerIds.join(',')})&start_date=lte.${today}&end_date=gte.${today}`;
          const onLeave = await directGet('leave_requests', leavesQ, { timeoutMs: 8000 });
          (onLeave || []).forEach(l => absentManagerIds.add(l.employee_id));
        }
      } catch (err) {
        console.warn('[delegation] absent-manager lookup failed:', err);
      }

      // Staff IDs from absent managers (the people whose pending
      // requests now route up to me)
      const delegatedStaffIds = (emps || [])
        .filter(e => absentManagerIds.has(e.manager_id))
        .map(e => e.id);

      // Combined dept set: my direct reports PLUS the staff of any
      // absent direct-report manager.
      const deptStaffIds = Array.from(new Set([...directReportIds, ...delegatedStaffIds]));

      // Mirror the derived isManager flag at component scope so other parts
      // of the panel (button gating, decideLeave's stage check) can read it.
      const hasDirectReports = deptStaffIds.length > 0;
      setIsManager(hasDirectReports);
      setDelegatedStaffIds(new Set(delegatedStaffIds));
      setAbsentManagerNames(
        Array.from(absentManagerIds).map(id => map[id]?.name || id),
      );
      const localIsDeptManager = hasDirectReports && !isHrReviewer && !isAdmin;

      // Build the leave queue query string based on role.
      let leaveQs = null;
      if (isAdmin) {
        leaveQs = 'select=*&stage=in.(pending_manager,pending_hr)&order=requested_at.desc';
      } else if (isHrReviewer) {
        leaveQs = `select=*&stage=eq.pending_hr&employee_id=neq.${encodeURIComponent(me.id)}&order=requested_at.desc`;
      } else if (localIsDeptManager) {
        leaveQs = `select=*&stage=eq.pending_manager&employee_id=in.(${deptStaffIds.join(',')})&order=requested_at.desc`;
      }

      // Permission requests now use the same stage flow as leave_requests:
      // staff submits → 'pending_manager' (manager reviews) → 'pending_hr'
      // (Bashaier reviews) → 'approved'. Managers see only their direct
      // reports' rows at the manager stage; HR sees only rows that have
      // already cleared the manager step.
      let permQs = null;
      if (canPerm) {
        permQs = `select=*&stage=eq.pending_hr&employee_id=neq.${encodeURIComponent(me.id)}&order=requested_at.desc`;
      } else if (localIsDeptManager) {
        permQs = `select=*&stage=eq.pending_manager&employee_id=in.(${deptStaffIds.join(',')})&order=requested_at.desc`;
      }

      const lr = leaveQs ? await directGet('leave_requests', leaveQs, { timeoutMs: 10000 }) : [];
      const pr = permQs  ? await directGet('permission_requests', permQs, { timeoutMs: 10000 }) : [];

      setLeave(lr || []);
      setPerms(pr || []);

      // History pull — HR/admin reviewers see everything they've decided
      // in the last 90 days, both leave AND permissions. Managers don't
      // get this section (their volume is too small to warrant it; the
      // ManagerDashboard's Pending approvals card already surfaces their
      // recent activity).
      //
      // The hr_decided_by column has historically been stamped with EITHER
      // the PSN (e.g. 'H94830') or the auth_user_id UUID, depending on
      // which code path wrote it (HrApprovalModal uses UUID, ReviewerPanel
      // for permissions uses PSN). The query below uses an OR filter to
      // catch both.
      if (canPerm) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 90);
        const cutoffISO = cutoff.toISOString();
        const psn = encodeURIComponent(me.id);
        const auth = me.auth_user_id ? encodeURIComponent(me.auth_user_id) : null;
        const orFilter = auth
          ? `(hr_decided_by.eq.${psn},hr_decided_by.eq.${auth})`
          : `(hr_decided_by.eq.${psn})`;
        // Manager-stage decisions live on different columns
        // (manager_decided_at / manager_decided_by). Without this
        // second query, items where Bashaier or a manager rejected
        // at pending_manager (or approved at pending_manager and
        // it then went to pending_hr) wouldn't surface in MY RECENT
        // DECISIONS — only HR-stage final decisions would.
        const orFilterMgr = auth
          ? `(manager_decided_by.eq.${psn},manager_decided_by.eq.${auth})`
          : `(manager_decided_by.eq.${psn})`;

        // Permission decisions
        const permHistQs = `select=*&or=${orFilter}&hr_decided_at=gte.${cutoffISO}&order=hr_decided_at.desc`;
        try {
          const hist = await directGet('permission_requests', permHistQs, { timeoutMs: 10000 });
          setRecentDecisions(Array.isArray(hist) ? hist : []);
        } catch {
          setRecentDecisions([]);
        }

        // Leave decisions — merge two queries:
        //  (1) HR-stage final decisions (hr_decided_at >= cutoff)
        //  (2) Manager-stage decisions where the user was the
        //      manager (manager_decided_at >= cutoff). Includes
        //      rejected_by_manager rows AND pending_hr rows that
        //      were approved at manager stage (those still belong
        //      in the user's recent activity feed).
        // Dedup by id so the same row doesn't appear twice when
        // the same user happens to be both manager and HR.
        try {
          const hrLeaveQs = `select=*&or=${orFilter}&hr_decided_at=gte.${cutoffISO}&order=hr_decided_at.desc`;
          const mgrLeaveQs = `select=*&or=${orFilterMgr}&manager_decided_at=gte.${cutoffISO}&order=manager_decided_at.desc`;
          const [lhistHr, lhistMgr] = await Promise.all([
            directGet('leave_requests', hrLeaveQs,  { timeoutMs: 10000 }).catch(() => []),
            directGet('leave_requests', mgrLeaveQs, { timeoutMs: 10000 }).catch(() => []),
          ]);
          const merged = new Map();
          [...(lhistHr || []), ...(lhistMgr || [])].forEach(r => merged.set(r.id, r));
          setRecentLeaveDecisions(Array.from(merged.values()));
        } catch {
          setRecentLeaveDecisions([]);
        }

        // Rejoining queue (pending_hr — manager has approved, awaiting Bashaier)
        try {
          const rq = await directGet(
            'leave_requests',
            `select=*&stage=eq.approved&return_stage=eq.pending_hr&order=return_manager_decided_at.asc&limit=200`,
            { timeoutMs: 10000 },
          );
          setRejoinQueue(Array.isArray(rq) ? rq : []);
        } catch {
          setRejoinQueue([]);
        }

        // Rejoining history (last 90 days, decided by me)
        const rejoinHistQs =
          `select=*&return_stage=eq.approved` +
          `&return_hr_decided_by=eq.${psn}` +
          `&return_hr_decided_at=gte.${cutoffISO}` +
          `&order=return_hr_decided_at.desc&limit=200`;
        try {
          const rhist = await directGet('leave_requests', rejoinHistQs, { timeoutMs: 10000 });
          setRecentRejoinDecisions(Array.isArray(rhist) ? rhist : []);
        } catch {
          setRecentRejoinDecisions([]);
        }
      } else {
        setRecentDecisions([]);
        setRecentLeaveDecisions([]);
        setRejoinQueue([]);
        setRecentRejoinDecisions([]);
      }
    } catch (err) {
      console.warn('ReviewerPanel load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [me?.id, isAdmin, isHrReviewer, canPerm]);

  useEffect(() => { load(); }, [load]);

  // Recurring permission pattern detection. For each unique
  // (employee_id, type) currently pending, fetch the last 60 days of
  // approved permissions of the same type and detect weekday clusters.
  // We flag the pattern when:
  //   • ≥3 occurrences in the window for the same employee+type
  //   • ≥half of those fall on the same weekday
  // Renders as a badge inline on the row. Skipped silently for empty
  // queues — no extra fetches when there's nothing to flag.
  useEffect(() => {
    if (!perms || perms.length === 0) {
      setRecurringPattern(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 60);
        const cutoffIso = cutoff.toISOString().slice(0, 10);
        // Build the unique (employee_id, type) set from pending rows.
        const pairs = new Map();
        perms.forEach(p => {
          const k = p.employee_id + '|' + p.type;
          if (!pairs.has(k)) pairs.set(k, { employee_id: p.employee_id, type: p.type });
        });
        // Single bulk fetch — all approved permissions in window for
        // these employees, then we filter and group client-side.
        const empIds = Array.from(new Set(Array.from(pairs.values()).map(p => p.employee_id)));
        if (empIds.length === 0) {
          if (!cancelled) setRecurringPattern(new Map());
          return;
        }
        const rows = await directGet(
          'permission_requests?select=employee_id,type,permission_date'
          + '&stage=eq.approved'
          + '&permission_date=gte.' + cutoffIso
          + '&employee_id=in.(' + empIds.map(encodeURIComponent).join(',') + ')'
        );
        if (cancelled) return;
        const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const buckets = new Map(); // key: emp|type → Array<rows>
        (rows || []).forEach(r => {
          const k = r.employee_id + '|' + r.type;
          if (!pairs.has(k)) return;
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(r);
        });
        const pattern = new Map();
        buckets.forEach((bucketRows, k) => {
          if (bucketRows.length < 3) return;
          // Count weekdays
          const weekdayCounts = {};
          bucketRows.forEach(r => {
            const wd = new Date(r.permission_date).getDay();
            weekdayCounts[wd] = (weekdayCounts[wd] || 0) + 1;
          });
          // Find dominant weekday
          let topDay = -1, topCount = 0;
          Object.entries(weekdayCounts).forEach(([d, c]) => {
            if (c > topCount) { topCount = c; topDay = Number(d); }
          });
          // Only flag if dominant weekday is at least half of the bucket
          if (topCount >= Math.ceil(bucketRows.length / 2) && topCount >= 2) {
            pattern.set(k, {
              count: topCount,
              total: bucketRows.length,
              weekday: WEEKDAYS[topDay],
              label: `${topCount} ${WEEKDAYS[topDay]}s in last 60d`,
            });
          } else if (bucketRows.length >= 4) {
            // No dominant weekday but high overall frequency — still
            // worth flagging.
            pattern.set(k, {
              count: bucketRows.length,
              total: bucketRows.length,
              weekday: null,
              label: `${bucketRows.length} approved in last 60d`,
            });
          }
        });
        setRecurringPattern(pattern);
      } catch (e) {
        console.warn('Recurring pattern fetch failed:', e?.message || e);
        if (!cancelled) setRecurringPattern(new Map());
      }
    })();
    return () => { cancelled = true; };
  }, [perms]);

  // No realtime channel. The websocket subscription was causing the supabase-js
  // client to wedge after the first load. Reviewers click the Refresh button, or
  // the queue auto-refreshes when they re-enter the tab (handled by load() rerun).

  // Stage-aware decision: figures out the next stage from the current one and the action.
  // The status<->stage trigger keeps the legacy status column synced automatically.
  async function decideLeave(req, action, rejectionReasonCode = null, rejectionReasonNote = null) {
    setBusyId(`leave-${req.id}`);
    const now = new Date().toISOString();
    let nextStage, patch = {};

    // Always write a non-null identifier into the decided_by columns
    // so every decision is attributable. We prefer the Supabase auth
    // UUID for back-compat with rows already in the table, and fall
    // back to the PSN (me.id) when the user account doesn't have an
    // auth UUID yet. Writing null here would make the row invisible
    // to MY RECENT DECISIONS, which queries on hr_decided_by /
    // manager_decided_by — that was the bug.
    const deciderId = me.auth_user_id || me.id;

    if (req.stage === 'pending_manager') {
      // Self-approval guard (see decidePerm above for full rationale)
      const requester = empMap[req.employee_id];
      const requesterIsHr = !!requester?.is_hr_reviewer;
      if (action === 'approved') {
        nextStage = requesterIsHr ? 'approved' : 'pending_hr';
        if (requesterIsHr) {
          patch.hr_decided_at = now;
          patch.hr_decided_by = deciderId;
        }
      } else {
        nextStage = 'rejected_by_manager';
      }
      patch.manager_decided_at = now;
      patch.manager_decided_by = deciderId;
    } else if (req.stage === 'pending_hr') {
      nextStage = action === 'approved' ? 'approved' : 'rejected_by_hr';
      patch.hr_decided_at = now;
      patch.hr_decided_by = deciderId;
    } else {
      alert('Unexpected request stage: ' + req.stage);
      setBusyId(null);
      return;
    }
    patch.stage = nextStage;

    // Persist the rejection reason fields when the action is reject.
    // For approvals these stay null (or get cleared if a previous
    // rejection was overturned, though that path isn't exposed today).
    if (action === 'rejected') {
      patch.rejection_reason_code = rejectionReasonCode || null;
      patch.rejection_reason_note = (rejectionReasonNote && rejectionReasonNote.trim()) || null;
    }

    try {
      // directPatch returns the updated row(s) thanks to
      // Prefer: return=representation. We log the result so a future
      // debug session can confirm which fields actually landed —
      // particularly the decided_by columns, which drive the history
      // visibility.
      const updated = await directPatch('leave_requests', 'id', req.id, patch, { timeoutMs: 15000 });
      if (Array.isArray(updated) && updated.length === 0) {
        // PostgREST returns an empty array when the WHERE clause
        // matched no rows — usually means RLS filtered out the row.
        // We surface this loudly so it doesn't silently disappear.
        throw new Error('Patch returned 0 rows — row may be hidden by RLS, or id mismatch.');
      }
      // eslint-disable-next-line no-console
      console.info('[decideLeave] patched row', {
        id: req.id,
        action,
        stage: nextStage,
        hr_decided_by: updated?.[0]?.hr_decided_by ?? null,
        manager_decided_by: updated?.[0]?.manager_decided_by ?? null,
        rejection_reason_code: updated?.[0]?.rejection_reason_code ?? null,
      });
      logAction(me, 'leave_request_decide', {
        targetType: 'leave_request',
        targetId: req.id,
        targetLabel: `${empMap[req.employee_id]?.name || req.employee_id} · ${nextStage}`,
        details: {
          stage: nextStage,
          action,
          rejection_reason_code: action === 'rejected' ? rejectionReasonCode : undefined,
        },
      });
      await load();
    } catch (err) {
      // Re-throw so callers (e.g. RejectLeaveModal) can surface
      // the error in their own UI. The legacy inline-button path
      // doesn't have a try/catch around decideLeave so we still
      // alert here as a fallback for that path. Modal callers
      // catch first and the alert never fires.
      alert(err.message);
      throw err;
    } finally {
      setBusyId(null);
    }
  }

  async function decidePerm(req, action) {
    setBusyId(`perm-${req.id}`);
    const now = new Date().toISOString();
    let nextStage, patch = {};

    if (req.stage === 'pending_manager') {
      // Self-approval guard: if the requester is themselves an HR
      // reviewer (e.g. Bashaier requesting time off, approved by her
      // manager John Ho), skip the pending_hr stage. Otherwise the
      // request would be stuck — Bashaier can't approve her own request,
      // and the HR queue filter excludes her own rows.
      const requester = empMap[req.employee_id];
      const requesterIsHr = !!requester?.is_hr_reviewer;
      if (action === 'approved') {
        nextStage = requesterIsHr ? 'approved' : 'pending_hr';
        if (requesterIsHr) {
          // John approving Bashaier's request finalises it. Stamp the
          // hr_decided_* fields with the manager's own id so the
          // approval letter footer + audit trail still record an HR
          // approver — semantically John is acting in the HR role here.
          patch.hr_decided_at = now;
          patch.hr_decided_by = me.id;
        }
      } else {
        nextStage = 'rejected_by_manager';
      }
      patch.manager_decided_at = now;
      patch.manager_decided_by = me.id;
    } else if (req.stage === 'pending_hr') {
      nextStage = action === 'approved' ? 'approved' : 'rejected_by_hr';
      patch.hr_decided_at = now;
      patch.hr_decided_by = me.id;
    } else {
      alert('Unexpected request stage: ' + req.stage);
      setBusyId(null);
      return;
    }
    patch.stage = nextStage;
    // Legacy reviewed_by/at columns — kept for backward compat with audit
    // surfaces that haven't been migrated yet. The trigger derives `status`
    // from `stage` so we don't need to touch it.
    patch.reviewed_at = now;
    patch.reviewed_by = me.id;

    try {
      await directPatch('permission_requests', 'id', req.id, patch, { timeoutMs: 10000 });
      logAction(me, 'permission_decide', {
        targetType: 'permission_request',
        targetId: req.id,
        targetLabel: `${empMap[req.employee_id]?.name || req.employee_id} · ${PERMISSION_TYPES[req.type]?.label} · ${nextStage}`,
        details: { stage: nextStage, action, exceeds_quota: req.exceeds_quota },
      });
      // Final HR approval — open the post-approval modal so Bashaier can
      // download the printable .docx letter and open the prefilled email
      // draft (To: staff, CC: manager + executives). The patched fields
      // are merged onto the row so the modal shows the just-stamped
      // hr_decided_at without waiting for the next load() pass.
      if (nextStage === 'approved') {
        setApprovedPermission({ ...req, ...patch });
      }
      await load();
    } catch (err) { alert(err.message); }
    finally       { setBusyId(null); }
  }

  // Bulk approval — only meaningful for managers handling pending_manager
  // requests. HR's pending_hr queue intentionally does NOT support bulk
  // approve because each approval triggers the post-approval modal +
  // letter generation per request. Bulk would skip those.
  async function bulkApproveLeave() {
    const pending = leave.filter(r => r.stage === 'pending_manager');
    if (pending.length === 0) return;
    const confirmed = confirm(
      `Approve all ${pending.length} pending leave request${pending.length === 1 ? '' : 's'}?\n\n` +
      pending.map(r => {
        const emp = empMap[r.employee_id];
        return `  • ${emp?.name || r.employee_id} · ${fmtDate(new Date(r.start_date))}` +
               (r.end_date && r.end_date !== r.start_date ? ` → ${fmtDate(new Date(r.end_date))}` : '');
      }).join('\n')
    );
    if (!confirmed) return;
    setBusyId('bulk-leave');
    try {
      // Serial — each decideLeave call mutates state and runs trigger
      // logic; doing them one at a time keeps the audit log + DB
      // consistent and prevents server-side rate limits.
      for (const req of pending) {
        await decideLeave(req, 'approved');
      }
    } finally {
      setBusyId(null);
    }
  }

  async function bulkApprovePerms() {
    const pending = perms.filter(r => r.stage === 'pending_manager');
    if (pending.length === 0) return;
    const confirmed = confirm(
      `Approve all ${pending.length} pending permission${pending.length === 1 ? '' : 's'}?\n\n` +
      pending.map(r => {
        const emp = empMap[r.employee_id];
        return `  • ${emp?.name || r.employee_id} · ${PERMISSION_TYPES[r.type]?.label}` +
               ` · ${fmtDate(new Date(r.permission_date))} · ${r.hours}h` +
               (r.exceeds_quota ? ' (OVER QUOTA)' : '');
      }).join('\n')
    );
    if (!confirmed) return;
    setBusyId('bulk-perms');
    try {
      for (const req of pending) {
        await decidePerm(req, 'approved');
      }
    } finally {
      setBusyId(null);
    }
  }

  if (!canLeave && !canSeePerm) return null;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs tracking-[0.25em] opacity-60">— REVIEW QUEUE</div>
          <h2 className="serif text-3xl mt-1" style={{ fontWeight: 500 }}>Pending decisions</h2>
          <p className="text-xs opacity-60 mt-1">
            {canLeave && canSeePerm ? 'You review leave + permission requests.'
             : canLeave              ? 'You review leave requests.'
             :                         'You review permission requests.'}
          </p>
        </div>
        <button onClick={load}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs border opacity-70 hover:opacity-100"
          style={{ borderColor: 'var(--border)' }}>
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {/* Pending notification — single line summary of what's waiting
          for HER right now. Sits at the top of the panel so the moment
          she opens the Reviews tab she knows whether there's anything
          to do. Only renders when at least one queue is non-empty.
          Each pill is a soft anchor to its section below: clicking
          scrolls the section into view. Pure read-side; no decisions
          happen here. */}
      {!loading && (() => {
        const leavePending  = leave.filter(r => r.stage === 'pending_hr').length;
        const permPending   = perms.filter(r => r.stage === 'pending_hr').length;
        const rejoinPending = rejoinQueue.length;
        const total = leavePending + permPending + rejoinPending;
        if (total === 0) return null;
        const scrollToSection = (label) => {
          const el = Array.from(document.querySelectorAll('h3'))
            .find(h => h.textContent && h.textContent.includes(label));
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        return (
          <div
            className="rounded-xl px-4 py-3 border flex items-start gap-3"
            style={{
              background: '#FEF3C7',
              borderColor: '#F59E0B',
              color: '#0A0A0A',
            }}
            role="status"
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#92400E' }} />
            <div className="text-xs flex-1">
              <div className="font-semibold mb-1.5">
                {total === 1
                  ? 'You have 1 request awaiting your final approval'
                  : `You have ${total} requests awaiting your final approval`}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {leavePending > 0 && (
                  <button
                    type="button"
                    onClick={() => scrollToSection('LEAVE')}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold cursor-pointer hover:opacity-90"
                    style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #F59E0B' }}>
                    <Plane className="w-3 h-3" /> {leavePending} leave
                  </button>
                )}
                {permPending > 0 && (
                  <button
                    type="button"
                    onClick={() => scrollToSection('PERMISSION')}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold cursor-pointer hover:opacity-90"
                    style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #F59E0B' }}>
                    <Sunrise className="w-3 h-3" /> {permPending} permission
                  </button>
                )}
                {rejoinPending > 0 && (
                  <button
                    type="button"
                    onClick={() => scrollToSection('REJOINING')}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold cursor-pointer hover:opacity-90"
                    style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #F59E0B' }}>
                    <ArrowLeftCircle className="w-3 h-3" /> {rejoinPending} rejoining
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delegation banner — surfaces when one of my direct-report
          managers is on approved leave today and their team's pending
          requests are routing to me. Without this banner the acting
          manager could be confused why staff they don't directly
          manage are appearing in their queue. */}
      {absentManagerNames.length > 0 && (
        <div className="rounded-xl px-4 py-3 border flex items-start gap-3"
             style={{
               background: 'rgba(157,107,83,0.08)',
               borderColor: 'rgba(157,107,83,0.3)',
               color: '#1F1B16',
             }}>
          <Plane className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#9D6B53' }} />
          <div className="text-xs flex-1">
            <div className="font-semibold mb-0.5">
              Acting on behalf of {absentManagerNames.join(', ')}
            </div>
            <div className="opacity-70">
              {absentManagerNames.length === 1 ? 'They are' : 'They are'} on
              approved leave today, so their team's pending requests are routing
              to you. Rows below tagged <span className="inline-block px-1.5 py-0.5 rounded text-[9px] font-bold tracking-wider"
                    style={{ background: '#9D6B53', color: '#FFFDF7' }}>DELEGATED</span> belong
              to that team.
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="opacity-60 text-sm flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading queue…
        </div>
      ) : (() => {
        // Total work waiting on this reviewer right now. When zero, the
        // page collapses to a single peaceful "All caught up" hero
        // instead of three giant empty-state cards stacked vertically.
        // Each role's queues:
        //   • HR reviewer (Bashaier) — perms, leaves, rejoinings
        //   • Manager — perms, leaves (rejoinings handled separately)
        //   • Admin — same as HR plus admin-only rows
        const queueTotal = (canSeePerm ? perms.length : 0)
                         + (canLeave ? leave.length : 0)
                         + (canPerm ? rejoinQueue.length : 0);

        if (queueTotal === 0) {
          return (
            <>
              <AllCaughtUpHero
                recentLeaveDecisions={recentLeaveDecisions}
                recentPermDecisions={recentDecisions}
                recentRejoinDecisions={recentRejoinDecisions}
                showHistory={canPerm}
              />
              {/* Even with an empty queue the reviewer still wants to
                  see her own 90-day decision log — searchable, with
                  re-download / re-email actions on each row. Renders
                  below the hero so the page reads: 'You're done →
                  here's what you've done lately.' */}
              {canPerm && (recentDecisions.length > 0 || recentLeaveDecisions.length > 0 || recentRejoinDecisions.length > 0) && (
                <HistorySection
                  recentLeaveDecisions={recentLeaveDecisions}
                  recentDecisions={recentDecisions}
                  recentRejoinDecisions={recentRejoinDecisions}
                  empMap={empMap}
                  query={historyQuery}
                  setQuery={setHistoryQuery}
                  setApprovedPermission={setApprovedPermission}
                  setApprovedRejoining={setApprovedRejoining}
                  isAdmin={isAdmin}
                />
              )}
            </>
          );
        }

        return (
          <>
          {canSeePerm && perms.length > 0 && (
            <section>
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <h3 className="text-[10px] tracking-[0.25em] opacity-60">
                  {canPermAsManager && !canPerm ? 'DEPARTMENT PERMISSIONS · ' : 'PERMISSION REQUESTS · '}{perms.length}
                </h3>
                {canPermAsManager && perms.filter(r => r.stage === 'pending_manager').length >= 2 && (
                  <button
                    type="button"
                    onClick={bulkApprovePerms}
                    disabled={busyId === 'bulk-perms'}
                    className="text-[11px] px-3 py-1.5 rounded-full inline-flex items-center gap-1.5 disabled:opacity-50"
                    style={{ background: 'var(--evergreen-500)', color: 'var(--paper)' }}
                    title="Approve every pending permission request in your queue"
                  >
                    {busyId === 'bulk-perms'
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> Approving…</>
                      : <><CheckCircle2 className="w-3 h-3" /> Approve all ({perms.filter(r => r.stage === 'pending_manager').length})</>}
                  </button>
                )}
              </div>
              <ul className="space-y-2">
                  {perms.map(req => {
                    const emp = empMap[req.employee_id];
                    const TypeIcon = req.type === 'late_arrival' ? Sunrise : Sunset;
                    return (
                      <li key={req.id} className="rounded-xl px-4 py-3 border"
                        style={{
                          background: req.exceeds_quota ? 'rgba(184,74,62,0.05)' : 'var(--paper-2)',
                          borderColor: req.exceeds_quota ? 'var(--clay)' : 'var(--border-soft)',
                        }}>
                        <div className="flex items-center justify-between gap-3 flex-wrap">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            <TypeIcon className="w-4 h-4 flex-shrink-0 opacity-70" />
                            <div className="flex-1 min-w-0">
                              <div className="text-sm flex items-center gap-2 flex-wrap">
                                <span className="opacity-50 font-mono">{req.employee_id}</span>
                                <span>{emp?.name || '(unknown)'}</span>
                                {delegatedStaffIds.has(req.employee_id) && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded font-bold tracking-wider"
                                        style={{ background: '#9D6B53', color: '#FFFDF7' }}>
                                    DELEGATED
                                  </span>
                                )}
                                {/* Recurring-pattern flag — Bashaier
                                    sees at a glance whether this is the
                                    Nth same-weekday request from the
                                    same person. Helps decide whether
                                    the pattern needs a conversation
                                    rather than another approval. */}
                                {(() => {
                                  const p = recurringPattern.get(req.employee_id + '|' + req.type);
                                  if (!p) return null;
                                  return (
                                    <span className="text-[9px] px-1.5 py-0.5 rounded font-bold tracking-wider inline-flex items-center gap-1"
                                          style={{ background: '#7C2D12', color: '#FFFDF7' }}
                                          title={`Recurring pattern: ${p.label}. Worth a conversation if this continues.`}>
                                      RECURRING · {p.label.toUpperCase()}
                                    </span>
                                  );
                                })()}
                              </div>
                              <div className="text-xs opacity-70 mt-0.5">
                                {PERMISSION_TYPES[req.type]?.label} · {fmtDate(new Date(req.permission_date))} · {req.hours}h
                                {req.exceeds_quota && (
                                  <span className="ml-2 inline-flex items-center gap-1" style={{ color: 'var(--clay)' }}>
                                    <AlertTriangle className="w-3 h-3" /> Over quota — flagged
                                  </span>
                                )}
                              </div>
                              {req.reason && <div className="text-xs opacity-60 mt-1 italic">"{req.reason}"</div>}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button onClick={() => decidePerm(req, 'approved')}
                              disabled={busyId === `perm-${req.id}`}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs disabled:opacity-50"
                              style={{ background: 'var(--evergreen-500)', color: 'var(--paper)' }}>
                              <CheckCircle2 className="w-3 h-3" /> Approve
                            </button>
                            <button onClick={() => decidePerm(req, 'rejected')}
                              disabled={busyId === `perm-${req.id}`}
                              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs border disabled:opacity-50"
                              style={{ borderColor: 'var(--clay)', color: 'var(--clay)' }}>
                              <XCircle className="w-3 h-3" /> Reject
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
            </section>
          )}

          {canLeave && leave.length > 0 && (
            <section>
              <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
                <h3 className="text-[10px] tracking-[0.25em] opacity-60">
                  {isHrReviewer && !isAdmin ? 'HR FINAL APPROVAL · ' : isDeptManager ? 'DEPARTMENT APPROVAL · ' : 'LEAVE REQUESTS · '}
                  {leave.length}
                </h3>
                {isDeptManager && leave.filter(r => r.stage === 'pending_manager').length >= 2 && (
                  <button
                    type="button"
                    onClick={bulkApproveLeave}
                    disabled={busyId === 'bulk-leave'}
                    className="text-[11px] px-3 py-1.5 rounded-full inline-flex items-center gap-1.5 disabled:opacity-50"
                    style={{ background: 'var(--evergreen-500)', color: 'var(--paper)' }}
                    title="Approve every pending leave request from your direct reports"
                  >
                    {busyId === 'bulk-leave'
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> Approving…</>
                      : <><CheckCircle2 className="w-3 h-3" /> Approve all ({leave.filter(r => r.stage === 'pending_manager').length})</>}
                  </button>
                )}
              </div>
              <ul className="space-y-2">
                  {leave.map(req => {
                    const emp = empMap[req.employee_id];
                    return (
                      <li key={req.id} className="rounded-xl px-4 py-3 border flex items-center justify-between gap-3 flex-wrap"
                        style={{ background: 'var(--paper-2)', borderColor: 'var(--border-soft)' }}>
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <Calendar className="w-4 h-4 flex-shrink-0 opacity-70" />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm flex items-center gap-2 flex-wrap">
                              <span className="opacity-50 font-mono">{req.employee_id}</span>
                              <span>{emp?.name || '(unknown)'}</span>
                              {delegatedStaffIds.has(req.employee_id) && (
                                <span className="text-[9px] px-1.5 py-0.5 rounded font-bold tracking-wider"
                                      style={{ background: '#9D6B53', color: '#FFFDF7' }}>
                                  DELEGATED
                                </span>
                              )}
                              {req.stage === 'pending_manager' && (
                                <span className="text-[10px] tracking-wider px-2 py-0.5 rounded-full"
                                      style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }}>
                                  AWAITING MANAGER
                                </span>
                              )}
                              {req.stage === 'pending_hr' && (
                                <span className="text-[10px] tracking-wider px-2 py-0.5 rounded-full"
                                      style={{ background: '#DBEAFE', color: '#1E40AF', border: '1px solid #93C5FD' }}>
                                  HR FINAL APPROVAL
                                </span>
                              )}
                              {/* Leave-type chip — gives the reviewer
                                  the most important piece of context
                                  at a glance. Without this, the
                                  manager only sees dates and a stage
                                  pill and has to open the row to
                                  know whether it's annual / sick /
                                  hajj / etc. The chip uses the same
                                  type-colour palette as elsewhere
                                  (annual=green, sick=red, etc.)
                                  driven by the seeded leave_types
                                  table; we look up via labelForLeave
                                  and pickLeaveTypeColor below the
                                  component. */}
                              <span className="text-[10px] tracking-wider px-2 py-0.5 rounded-full"
                                style={{
                                  background: pickLeaveTypeColor(req.leave_type_id) + '22',
                                  color: pickLeaveTypeColor(req.leave_type_id),
                                  border: '1px solid ' + pickLeaveTypeColor(req.leave_type_id) + '55',
                                  fontWeight: 700,
                                  letterSpacing: '0.06em',
                                }}>
                                {labelForLeave(req.leave_type_id)}
                              </span>
                            </div>
                            <div className="text-xs opacity-70 mt-0.5">
                              {fmtDate(new Date(req.start_date))} → {fmtDate(new Date(req.end_date))} · {req.days} day{req.days !== 1 ? 's' : ''}
                              {req.reason ? ' · ' + req.reason : ''}
                            </div>
                            {req.substitute_ids && req.substitute_ids.length > 0 && (
                              <div className="text-xs mt-1.5 flex items-center gap-1.5 flex-wrap">
                                <span style={{ color: '#1F1B16', fontWeight: 600, letterSpacing: '0.1em', fontSize: '10px' }}>COVER:</span>
                                {req.substitute_ids.map(sid => {
                                  // substitute_decisions can hold either
                                  // { psn: 'accepted' | 'declined' | 'pending' }
                                  // or { psn: { decision, at } } depending on
                                  // when the row was written. Handle both.
                                  const raw = req.substitute_decisions?.[sid];
                                  const dec = !raw ? 'pending' :
                                              typeof raw === 'string' ? raw : (raw.decision || 'pending');
                                  const accepted = dec === 'accepted';
                                  const declined = dec === 'declined';
                                  const bg    = accepted ? '#ECFDF5' : declined ? '#FEE2E2' : '#FEF3C7';
                                  const color = accepted ? '#0F4C2A' : declined ? '#B91C1C' : '#92400E';
                                  const label = accepted ? '✓' : declined ? '✕' : '…';
                                  return (
                                    <span key={sid}
                                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full"
                                      style={{ background: bg, color, fontSize: '11px', fontWeight: 500 }}
                                      title={dec.toUpperCase()}>
                                      <span style={{ fontWeight: 700 }}>{label}</span>
                                      {empMap[sid]?.name || sid}
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => {
                              if (req.stage === 'pending_hr') {
                                setHrModalReq(req);
                              } else {
                                decideLeave(req, 'approved');
                              }
                            }}
                            disabled={busyId === `leave-${req.id}`}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs disabled:opacity-50"
                            style={{ background: 'var(--evergreen-500)', color: 'var(--paper)' }}>
                            <CheckCircle2 className="w-3 h-3" /> Approve
                          </button>
                          <button onClick={() => setRejectLeaveReq(req)}
                            disabled={busyId === `leave-${req.id}`}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs border disabled:opacity-50"
                            style={{ borderColor: 'var(--clay)', color: 'var(--clay)' }}>
                            <XCircle className="w-3 h-3" /> Reject
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
            </section>
          )}

          {/* HR-only — Rejoining queue. Bashaier sees the same urgency
              for rejoining requests as for leaves and permissions: rows
              hit her queue the moment a manager approves them. Mounted
              above HistorySection so she finds them with the rest of
              her morning queue scan. */}
          {canPerm && rejoinQueue.length > 0 && (
            <RejoiningSection
              queue={rejoinQueue}
              empMap={empMap}
              me={me}
              onChanged={load}
              onApproved={(req) => setApprovedRejoining(req)}
            />
          )}

          {/* HR-only — searchable history of every decision this reviewer
              has made in the last 90 days, across BOTH leave and
              permission requests. Lets Bashaier:
                • See her own approvals after she clicks Approve (the
                  request leaves the queue but appears here immediately)
                • Search by employee name to find a past approval
                • Re-download the .docx letter or re-open the email
                  draft for any approved row
              Hidden for managers (their volume is too small to need it). */}
          {canPerm && (recentDecisions.length > 0 || recentLeaveDecisions.length > 0 || recentRejoinDecisions.length > 0) && (
            <HistorySection
              recentLeaveDecisions={recentLeaveDecisions}
              recentDecisions={recentDecisions}
              recentRejoinDecisions={recentRejoinDecisions}
              empMap={empMap}
              query={historyQuery}
              setQuery={setHistoryQuery}
              setApprovedPermission={setApprovedPermission}
              setApprovedRejoining={setApprovedRejoining}
              isAdmin={isAdmin}
            />
          )}
        </>
        );
      })()}
          {hrModalReq && (
        <HrApprovalModal
          request={hrModalReq}
          employee={empMap[hrModalReq.employee_id]}
          manager={empMap[empMap[hrModalReq.employee_id]?.manager_id]}
          substitutes={(hrModalReq.substitute_ids || []).map(sid => empMap[sid]).filter(Boolean)}
          me={me}
          allRequests={leave}
          empMap={empMap}
          onClose={() => setHrModalReq(null)}
          onApproved={() => { setHrModalReq(null); load(); }}
        />
      )}
      {rejectLeaveReq && (
        <RejectLeaveModal
          request={rejectLeaveReq}
          employee={empMap[rejectLeaveReq.employee_id]}
          onClose={() => setRejectLeaveReq(null)}
          onConfirm={async (code, note) => {
            await decideLeave(rejectLeaveReq, 'rejected', code, note);
            setRejectLeaveReq(null);
          }}
        />
      )}
      {approvedPermission && (
        <PermissionApprovedModal
          request={approvedPermission}
          employee={empMap[approvedPermission.employee_id]}
          manager={empMap[empMap[approvedPermission.employee_id]?.manager_id]}
          hrApprover={me}
          employees={Object.values(empMap)}
          onClose={() => setApprovedPermission(null)}
        />
      )}
      {approvedRejoining && (
        <RejoiningApprovedModal
          request={approvedRejoining}
          empMap={empMap}
          onClose={() => setApprovedRejoining(null)}
        />
      )}
    </div>
  );
}

function EmptyState({ text }) {
  return (
    <div className="rounded-xl p-6 text-center text-xs opacity-60 border" style={{ borderColor: 'var(--border-soft)' }}>
      <Clock className="w-4 h-4 mx-auto mb-2 opacity-50" />
      {text}
    </div>
  );
}

// ─── All-caught-up hero ──────────────────────────────────────────────────────
// Shown when no leave / permission / rejoining is waiting on the
// reviewer. Replaces the three vertically stacked empty-state cards
// with one tasteful corporate-style status panel — green check, a
// short message, and a small recent-activity readout so the page
// still feels informative and Bashaier knows the system is alive.
function AllCaughtUpHero({ recentLeaveDecisions = [], recentPermDecisions = [], recentRejoinDecisions = [], showHistory = false }) {
  // 24-hour and 7-day decision counts across all kinds — gives Bashaier
  // a quick "I've been productive" pulse without forcing her to scroll
  // to the history below.
  const now = Date.now();
  const day  = now - 24 * 3_600_000;
  const week = now - 7  * 24 * 3_600_000;

  const tsOf = (r, kind) =>
    new Date(kind === 'rejoin' ? r.return_hr_decided_at : r.hr_decided_at).getTime();

  const all = [
    ...recentLeaveDecisions.map(r  => ({ t: tsOf(r, 'leave'),  kind: 'leave'  })),
    ...recentPermDecisions.map(r   => ({ t: tsOf(r, 'perm'),   kind: 'perm'   })),
    ...recentRejoinDecisions.map(r => ({ t: tsOf(r, 'rejoin'), kind: 'rejoin' })),
  ];
  const decidedToday = all.filter(d => d.t >= day).length;
  const decidedWeek  = all.filter(d => d.t >= week).length;

  const now2 = new Date();
  const greeting = now2.getHours() < 12 ? 'morning'
                : now2.getHours() < 17 ? 'afternoon'
                : 'evening';

  return (
    <div
      className="rounded-2xl border overflow-hidden"
      style={{
        borderColor: 'rgba(15, 76, 42, 0.18)',
        background: 'linear-gradient(135deg, #F0FDF4 0%, #ECFDF5 60%, #FFFDF7 100%)',
      }}
    >
      <div className="px-8 py-10 flex flex-col sm:flex-row items-start sm:items-center gap-6">
        {/* Big status icon */}
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: '#FFFFFF', border: '2px solid #047857' }}
        >
          <CheckCircle2 className="w-9 h-9" style={{ color: '#047857' }} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="text-[10px] tracking-[0.25em] mb-1.5" style={{ color: '#047857', fontWeight: 700 }}>
            ALL CAUGHT UP
          </div>
          <h3 className="serif text-2xl mb-1" style={{ color: '#0A0A0A', fontWeight: 500 }}>
            Nothing waiting on you this {greeting}.
          </h3>
          <p className="text-sm" style={{ color: '#1F1B16', opacity: 0.8 }}>
            Every leave, permission, and rejoining request has been actioned. New submissions will appear here automatically.
          </p>
        </div>
      </div>

      {showHistory && (decidedToday > 0 || decidedWeek > 0) && (
        <div
          className="px-8 py-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs"
          style={{
            borderTop: '1px solid rgba(15, 76, 42, 0.12)',
            background: 'rgba(255, 253, 247, 0.6)',
            color: '#0A0A0A',
          }}
        >
          <div className="text-[10px] tracking-[0.2em] font-semibold opacity-60">
            YOUR ACTIVITY
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold" style={{ fontSize: '14px' }}>{decidedToday}</span>
            <span className="opacity-70">decided in the last 24 hours</span>
          </div>
          <div className="opacity-30">·</div>
          <div className="flex items-center gap-1.5">
            <span className="font-semibold" style={{ fontSize: '14px' }}>{decidedWeek}</span>
            <span className="opacity-70">in the last 7 days</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Rejoining queue (HR final approval) ────────────────────────────────────
// Bashaier sees rows where the manager has already approved and the
// rejoining is awaiting final HR decision. Mirrors the leave / perm
// queue pattern in this same panel — same chrome, same urgency.
function RejoiningSection({ queue, empMap, me, onChanged, onApproved }) {
  const [busyId, setBusyId] = React.useState(null);
  const [openId, setOpenId] = React.useState(null);
  const [reason, setReason] = React.useState('');

  const approve = async (req) => {
    setBusyId(req.id);
    try {
      const patch = {
        return_stage:              'approved',
        return_hr_decided_at:      new Date().toISOString(),
        return_hr_decided_by:      me.id,
        returned_at:               new Date().toISOString(),
        return_confirmed_by:       me.id,
        return_status:             'returned',
        return_rejection_reason:   null,
      };
      // Best-effort early-return credit (mirrors PendingReturnsCard logic).
      try {
        const planned = new Date(req.end_date);
        const actual  = new Date(req.actual_return_date);
        const expectedReturn = new Date(planned); expectedReturn.setDate(expectedReturn.getDate() + 1);
        const daysSaved = Math.max(0, Math.floor((expectedReturn - actual) / 86_400_000));
        if (daysSaved > 0) {
          const yr = new Date(req.start_date).getFullYear();
          const balRows = await directGet(
            'leave_balances',
            `select=id,adjustment,adjustment_note&employee_id=eq.${encodeURIComponent(req.employee_id)}` +
            `&leave_type_id=eq.${encodeURIComponent(req.leave_type_id)}&year=eq.${yr}`,
            { timeoutMs: 6000 },
          );
          if (Array.isArray(balRows) && balRows.length > 0) {
            const cur = balRows[0];
            const newAdj = Number(cur.adjustment || 0) + daysSaved;
            const note = `${cur.adjustment_note ? cur.adjustment_note + ' · ' : ''}` +
                         `+${daysSaved}d credited (early return on rejoining ${new Date().toISOString().slice(0,10)})`;
            await directPatch('leave_balances', 'id', cur.id, { adjustment: newAdj, adjustment_note: note }, { timeoutMs: 6000 });
          }
          patch.balance_after = daysSaved;
        } else {
          patch.balance_after = 0;
        }
      } catch (e) { /* non-fatal */ }
      await directPatch('leave_requests', 'id', req.id, patch, { timeoutMs: 10000 });
      // Open the post-approval modal (Download report + Open email
      // draft) — same flow as permission letter approval.
      onApproved && onApproved({ ...req, ...patch });
      onChanged && onChanged();
    } catch (err) {
      alert('Approve failed: ' + (err.message || err));
    } finally {
      setBusyId(null);
    }
  };

  const sendBack = async (req) => {
    if (!reason.trim()) { alert('Please give a reason so the staff can fix and resubmit.'); return; }
    setBusyId(req.id);
    try {
      await directPatch('leave_requests', 'id', req.id, {
        return_stage:            'rejected_by_hr',
        return_hr_decided_at:    new Date().toISOString(),
        return_hr_decided_by:    me.id,
        return_rejection_reason: reason.trim(),
      }, { timeoutMs: 10000 });
      setOpenId(null); setReason('');
      onChanged && onChanged();
    } catch (err) {
      alert('Send-back failed: ' + (err.message || err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <h3 className="text-[10px] tracking-[0.25em] opacity-60">
          REJOINING · HR FINAL APPROVAL · {queue.length}
        </h3>
      </div>
      {queue.length === 0 ? (
        <EmptyState text="No rejoining requests awaiting your approval." />
      ) : (
        <ul className="space-y-2">
          {queue.map(req => {
            const emp = empMap[req.employee_id];
            const open = openId === req.id;
            const busy = busyId === req.id;
            return (
              <li key={req.id} className="rounded-xl px-4 py-3 border"
                  style={{ background: '#FFFDF7', borderColor: 'var(--border-soft)' }}>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                       style={{ background: '#ECFDF5', color: '#0F4C2A' }}>
                    <ArrowLeftCircle className="w-4 h-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                        {emp?.name || req.employee_id}
                      </span>
                      {emp?.department && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded"
                              style={{ background: 'rgba(0,0,0,0.04)', color: '#1F1B16' }}>
                          {emp.department}
                        </span>
                      )}
                      <span className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.7 }}>
                        · {(req.leave_type_id || 'leave').toUpperCase()} · {fmtDate(req.start_date)} → {fmtDate(req.end_date)} · returned {fmtDate(req.actual_return_date)}
                      </span>
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.7 }}>
                      Manager approved {req.return_manager_decided_at ? new Date(req.return_manager_decided_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'}
                      {req.return_notes ? ` · "${req.return_notes}"` : ''}
                    </div>
                  </div>
                  {!open && (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={async () => {
                          try {
                            const { composeRejoiningEmailForRequest } = await import('../lib/rejoiningReport.js');
                            composeRejoiningEmailForRequest(req, empMap);
                          } catch (err) {
                            alert('Could not compose email: ' + (err.message || err));
                          }
                        }}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                        style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #C9B894' }}
                        title="Open prefilled email — asks staff to print, sign, and submit hard copy">
                        <Mail className="w-3 h-3" /> Email
                      </button>
                      <button
                        onClick={() => approve(req)}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                        style={{ background: '#0F4C2A', color: '#FFFFFF' }}>
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle2 className="w-3 h-3" />}
                        Final approve
                      </button>
                      <button
                        onClick={() => { setOpenId(req.id); setReason(''); }}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                        style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #FCA5A5' }}>
                        Send back
                      </button>
                    </div>
                  )}
                </div>
                {open && (
                  <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-soft)' }}>
                    <input
                      autoFocus
                      type="text"
                      value={reason}
                      onChange={e => setReason(e.target.value)}
                      placeholder="Reason — staff sees this and will resubmit"
                      className="w-full px-2 py-1.5 rounded text-sm mb-2"
                      style={{ border: '1px solid #FCA5A5', background: '#FFFFFF', color: '#0A0A0A' }}
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => sendBack(req)}
                        disabled={busy || !reason.trim()}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                        style={{ background: '#B91C1C', color: '#FFFFFF', opacity: busy || !reason.trim() ? 0.6 : 1 }}>
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                        Confirm send-back
                      </button>
                      <button
                        onClick={() => { setOpenId(null); setReason(''); }}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold"
                        style={{ background: 'transparent', color: '#1F1B16' }}>
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ─── History (recent decisions) ──────────────────────────────────────────────
// Combined searchable history of leave + permission decisions made by this
// reviewer in the last 90 days. Surfaces immediately after Bashaier approves
// something — the row leaves the queue but appears here on the same load.
function HistorySection({
  recentLeaveDecisions, recentDecisions, recentRejoinDecisions = [],
  empMap, query, setQuery, setApprovedPermission, setApprovedRejoining,
}) {
  // Tag each row with kind so the unified list can render appropriately.
  const all = [
    ...recentLeaveDecisions.map(r => ({ ...r, _kind: 'leave',      _decidedAt: r.hr_decided_at })),
    ...recentDecisions.map(r => ({ ...r, _kind: 'permission', _decidedAt: r.hr_decided_at })),
    ...recentRejoinDecisions.map(r => ({ ...r, _kind: 'rejoin',  _decidedAt: r.return_hr_decided_at })),
  ].sort((a, b) =>
    new Date(b._decidedAt || 0).getTime() - new Date(a._decidedAt || 0).getTime(),
  );

  const q = (query || '').trim().toLowerCase();
  const filtered = q
    ? all.filter(r => {
        const emp = empMap[r.employee_id];
        const name = (emp?.name || '').toLowerCase();
        const psn  = (r.employee_id || '').toLowerCase();
        const dept = (emp?.department || '').toLowerCase();
        return name.includes(q) || psn.includes(q) || dept.includes(q);
      })
    : all;

  const leaveCount  = filtered.filter(r => r._kind === 'leave').length;
  const permCount   = filtered.filter(r => r._kind === 'permission').length;
  const rejoinCount = filtered.filter(r => r._kind === 'rejoin').length;

  return (
    <section>
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <h3 className="text-[10px] tracking-[0.25em] opacity-60">
          MY RECENT DECISIONS · LAST 90 DAYS · {filtered.length}
          {filtered.length > 0 && (
            <span className="ml-2 opacity-70 font-normal lowercase tracking-normal">
              ({leaveCount} leave · {permCount} permission · {rejoinCount} rejoining)
            </span>
          )}
        </h3>
        <div className="relative" style={{ width: 220, maxWidth: '100%' }}>
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search by name, PSN, or department"
            className="w-full pl-9 pr-3 py-1.5 rounded-full border text-xs"
            style={{ background: '#FFFDF7', borderColor: 'var(--border-soft)', color: '#1F1B16' }}
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState text={q ? `No matches for "${query}".` : 'No decisions yet in the last 90 days.'} />
      ) : (
        <ul className="space-y-2">
          {filtered.map(req => (
            <HistoryItem
              key={`${req._kind}-${req.id}`}
              req={req}
              empMap={empMap}
              onReopenPermission={() => setApprovedPermission(req)}
              onReopenRejoining={() => setApprovedRejoining(req)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryItem({ req, empMap, onReopenPermission, onReopenRejoining }) {
  const emp = empMap[req.employee_id];
  const isLeave  = req._kind === 'leave';
  const isPerm   = req._kind === 'permission';
  const isRejoin = req._kind === 'rejoin';

  // Approved/rejected status — different field per kind. Rejoining
  // approval lives on return_stage, not stage.
  const wasApproved = isRejoin
    ? req.return_stage === 'approved'
    : req.stage === 'approved';

  // For leaves, the row could have been rejected at either the
  // manager stage (rejected_by_manager) or the HR stage
  // (rejected_by_hr). The decided-at timestamp lives on different
  // columns: manager_decided_at vs hr_decided_at. Pick the right
  // one so the 'Decided …' line below shows the actual decision
  // time, not a missing field.
  const decidedAt = isRejoin
    ? req.return_hr_decided_at
    : isLeave
      ? (req.hr_decided_at || req.manager_decided_at)
      : req.hr_decided_at;

  // Rejected leaves carry a reason code + optional note. Both columns
  // are nullable for backwards compatibility with rejections that
  // pre-date the rejection_reasons migration.
  const rejection = !wasApproved && isLeave
    ? findRejectionReason(req.rejection_reason_code)
    : null;
  const rejectionNote = !wasApproved && isLeave
    ? (req.rejection_reason_note || '').trim()
    : '';

  // Icon: Plane for leave, Sunrise/Sunset for permission, ArrowLeftCircle for rejoining
  const Icon = isLeave  ? Plane
            : isRejoin ? ArrowLeftCircle
            : (req.type === 'late_arrival' ? Sunrise : Sunset);

  const iconBg    = isLeave  ? '#E0F2FE'
                  : isRejoin ? '#ECFDF5'
                  : (req.type === 'early_leave' ? '#FCE7F3' : '#FEF3C7');
  const iconColor = isLeave  ? '#0369A1'
                  : isRejoin ? '#0F4C2A'
                  : (req.type === 'early_leave' ? '#BE185D' : '#A16207');

  const summary = isLeave
    ? `Leave · ${fmtDate(req.start_date)}${req.end_date && req.end_date !== req.start_date ? ` → ${fmtDate(req.end_date)}` : ''}${req.days ? ` · ${req.days}d` : ''}`
    : isRejoin
      ? `Rejoining · returned ${fmtDate(req.actual_return_date)}${req.balance_after > 0 ? ` · +${req.balance_after}d credited` : ''}`
      : `${PERMISSION_TYPES[req.type]?.label || req.type} · ${Number(req.hours)}h · ${fmtDate(req.permission_date)}`;

  async function downloadLeaveLetter() {
    try {
      await downloadVacationFormForRequest(req, empMap);
    } catch (err) {
      console.warn('letter download failed:', err);
      alert('Could not download letter: ' + (err.message || err));
    }
  }

  // Build the rejection-email draft on demand. The email opens
  // pre-filled with the standardised reason label, the free-text
  // note, and (for sick leaves) the Sehhaty leave ID. Lets Bashaier
  // re-send the rejection notice if the staff member missed it.
  function openRejectionEmail() {
    const employee = empMap[req.employee_id];
    const manager  = empMap[employee?.manager_id];
    const draft = buildLeaveRejectionEmailDraft({
      employee,
      request: req,
      manager,
      hrApprover: empMap[req.hr_decided_by] || null,
      reasonLabel: rejection?.label,
      reasonNote: rejectionNote,
    });
    window.location.href = draft.mailto;
  }

  return (
    <li className="rounded-xl px-4 py-2.5 border"
        style={{ background: '#FFFDF7', borderColor: 'var(--border-soft)' }}>
      <div className="flex items-center gap-3">
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: iconBg, color: iconColor }}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium" style={{ color: '#1F1B16' }}>
              {emp?.name || req.employee_id}
            </span>
            {emp?.department && (
              <span className="text-[10px] px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(0,0,0,0.04)', color: '#1F1B16' }}>
                {emp.department}
              </span>
            )}
            <span className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
              · {summary}
            </span>
            <span
              className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1"
              style={{
                background: wasApproved ? '#ECFDF5' : '#FEE2E2',
                color:      wasApproved ? '#0F4C2A' : '#B91C1C',
                fontWeight: 700, letterSpacing: '0.1em',
              }}>
              {wasApproved
                ? <><CheckCircle2 className="w-2.5 h-2.5" /> APPROVED</>
                : <><XCircle className="w-2.5 h-2.5" /> REJECTED</>}
            </span>
          </div>
          <div className="text-[10px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.6 }}>
            Decided {decidedAt ? new Date(decidedAt).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'}
          </div>
        </div>

        {wasApproved && isLeave && (
          <button
            type="button"
            onClick={downloadLeaveLetter}
            className="text-[11px] px-3 py-1.5 rounded-full border opacity-80 hover:opacity-100 whitespace-nowrap inline-flex items-center gap-1"
            style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }}
            title="Re-download the leave application form"
          >
            <FileDown className="w-3 h-3" /> Form
          </button>
        )}
        {!wasApproved && isLeave && (rejection || rejectionNote) && (
          <button
            type="button"
            onClick={openRejectionEmail}
            className="text-[11px] px-3 py-1.5 rounded-full border opacity-80 hover:opacity-100 whitespace-nowrap inline-flex items-center gap-1"
            style={{ borderColor: '#FCA5A5', color: '#B91C1C', background: '#FFFFFF' }}
            title="Open rejection email composer pre-filled with the reason"
          >
            <Mail className="w-3 h-3" /> Letter / email
          </button>
        )}
        {wasApproved && isPerm && (
          <button
            type="button"
            onClick={onReopenPermission}
            className="text-[11px] px-3 py-1.5 rounded-full border opacity-80 hover:opacity-100 whitespace-nowrap"
            style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }}
            title="Re-open letter and email draft"
          >
            Letter / email
          </button>
        )}
        {wasApproved && isRejoin && (
          <button
            type="button"
            onClick={onReopenRejoining}
            className="text-[11px] px-3 py-1.5 rounded-full border opacity-80 hover:opacity-100 whitespace-nowrap"
            style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }}
            title="Re-open report download and email draft"
          >
            Letter / email
          </button>
        )}
      </div>

      {/* Rejection reason banner — surfaces under rejected leaves
          so Bashaier sees what reason she gave + any note she added,
          mirroring what the staff member sees on their My
          Applications card. Hidden for approved decisions and for
          rejections that pre-date the rejection_reasons migration
          (no code or note recorded). */}
      {!wasApproved && isLeave && (rejection || rejectionNote) && (
        <div className="mt-2 ml-11 rounded-lg p-2.5"
          style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
          <div className="text-[10px] tracking-wider font-bold mb-1" style={{ color: '#B91C1C' }}>
            REASON GIVEN
          </div>
          {rejection && (
            <div className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
              {rejection.label}
            </div>
          )}
          {rejectionNote && (
            <div className="text-[11px] mt-1" style={{ color: '#0A0A0A', opacity: 0.85 }}>
              "{rejectionNote}"
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// ─── RejectLeaveModal ───────────────────────────────────────────────────────
// Opens when the rejector clicks 'Reject' on a leave card. Forces an
// explicit reason from a curated dropdown so the staff member sees
// something useful on their My Applications card. Sick-leave-specific
// reasons (e.g. 'Sehhaty leave ID is not valid') appear at the top of
// the dropdown for sick leaves; common reasons appear for any type.
//
// The note field becomes mandatory when the selected reason has
// requiresNote=true (e.g. 'Other reason' or 'Please resubmit with
// corrected details') — those are meaningless without context.
function RejectLeaveModal({ request, employee, onClose, onConfirm }) {
  const reasons = rejectionReasonsForLeaveType(request.leave_type_id);
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const selectedReason = findRejectionReason(code);
  const noteRequired   = !!selectedReason?.requiresNote;
  const canSubmit = !!code && (!noteRequired || note.trim().length > 0);

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await onConfirm(code, note);
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-0 sm:p-4"
         style={{ background: 'rgba(15,31,26,0.55)' }}
         onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-paper rounded-t-2xl sm:rounded-2xl w-full max-w-md fade-in"
        style={{ boxShadow: '0 12px 40px rgba(31,27,22,0.2)' }}>
        <div className="px-5 py-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="text-[10px] tracking-[0.25em] font-bold mb-1" style={{ color: '#B91C1C' }}>
            REJECT LEAVE REQUEST
          </div>
          <h3 className="text-lg" style={{ fontFamily: 'Georgia, serif', color: '#0A0A0A', fontWeight: 500 }}>
            Why are you rejecting?
          </h3>
          <div className="text-[11px] mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            {employee?.name} ({request.employee_id}) · {fmtDate(new Date(request.start_date))} → {fmtDate(new Date(request.end_date))}
          </div>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-[10px] tracking-wider font-bold opacity-70 mb-1 block">
              REASON <span style={{ color: '#B91C1C' }}>*</span>
            </label>
            <select value={code} onChange={e => setCode(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg border text-sm bg-transparent focus:outline-none"
              style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}>
              <option value="">— select a reason —</option>
              {reasons.map(r => (
                <option key={r.code} value={r.code}>{r.label}</option>
              ))}
            </select>
            {selectedReason?.description && (
              <div className="text-[10px] mt-1.5 px-2 py-1 rounded"
                style={{ background: 'rgba(196,155,97,0.10)', color: '#0A0A0A' }}>
                {selectedReason.description}
              </div>
            )}
          </div>

          <div>
            <label className="text-[10px] tracking-wider font-bold opacity-70 mb-1 block">
              NOTE FOR THE STAFF MEMBER {noteRequired && <span style={{ color: '#B91C1C' }}>*</span>}
              {!noteRequired && <span className="opacity-60 font-normal"> (optional)</span>}
            </label>
            <textarea value={note} onChange={e => setNote(e.target.value)}
              rows={3} maxLength={500}
              placeholder={noteRequired
                ? 'Required — explain what needs to change before resubmission.'
                : 'Optional — any additional context the staff member should see.'}
              className="w-full px-3 py-2 rounded-lg border text-sm bg-transparent focus:outline-none resize-none"
              style={{
                borderColor: noteRequired && !note.trim() ? '#FCA5A5' : 'var(--border-soft)',
                color: '#0A0A0A',
              }}/>
            <div className="text-[9px] opacity-50 text-right mt-0.5">
              {note.length}/500
            </div>
          </div>

          <div className="rounded-lg p-2.5 text-[11px]"
            style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }}>
            ℹ The reason and note will be visible to {employee?.name?.split(' ')[0] || 'the staff member'} on their My Applications card.
          </div>

          {error && (
            <div className="rounded-lg p-2.5 text-[11px]"
              style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t flex items-center justify-end gap-2"
          style={{ borderColor: 'var(--border-soft)', background: '#FAF6EC' }}>
          <button onClick={onClose}
            disabled={submitting}
            className="text-[11px] px-3 py-1.5 rounded-full border"
            style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}>
            Cancel
          </button>
          <button onClick={submit}
            disabled={!canSubmit || submitting}
            className="text-[11px] inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full"
            style={{
              background: !canSubmit ? '#9CA3AF' : '#B91C1C',
              color: '#FFFFFF',
              fontWeight: 700,
              cursor: (!canSubmit || submitting) ? 'not-allowed' : 'pointer',
              opacity: (!canSubmit || submitting) ? 0.7 : 1,
            }}>
            {submitting
              ? <>Saving…</>
              : <><XCircle className="w-3 h-3"/> Reject with this reason</>}
          </button>
        </div>
      </div>
    </div>
  );
}
