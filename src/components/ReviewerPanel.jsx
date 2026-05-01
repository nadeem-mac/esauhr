import React, { useEffect, useState, useCallback } from 'react';
import { supabase, directPatch, directGet } from '../supabaseClient.js';
import { CheckCircle2, XCircle, Clock, Loader2, AlertTriangle, Sunrise, Sunset, Calendar, RefreshCw } from 'lucide-react';
import { logAction } from '../lib/audit.js';
import HrApprovalModal from './HrApprovalModal.jsx';
import PermissionApprovedModal from './PermissionApprovedModal.jsx';
import { fmtDate } from '../lib/leaveLogic.js';
import { PERMISSION_TYPES, summariseMonth } from '../lib/permissionLogic.js';

// Visible to anyone with can_review_leave OR can_review_permissions OR is_admin
// OR is a manager (has someone whose manager_id === me.id). After the dept-head
// flag revoke, "manager" is now derived from the org chart, not from a flag.

export default function ReviewerPanel({ me }) {
  const [leave, setLeave]             = useState([]);
  const [perms, setPerms]             = useState([]);
  const [empMap, setEmpMap]           = useState({});
  // After Bashaier issues the FINAL HR approval on a permission, this holds
  // the freshly-approved row so PermissionApprovedModal opens with the
  // download letter / open email draft actions.
  const [approvedPermission, setApprovedPermission] = useState(null);
  // History of permission decisions made by THIS HR reviewer in the last
  // 30 days. Surfaces below the active queue so Bashaier can review her
  // own decisions, re-open the timeline for context, and re-download
  // the letter / re-open the email draft if she missed it the first time.
  const [recentDecisions, setRecentDecisions] = useState([]);
  const [isManager, setIsManager]     = useState(false);
  const [loading, setLoading]         = useState(true);
  const [busyId, setBusyId]           = useState(null);
  const [hrModalReq, setHrModalReq]   = useState(null);

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
      const deptStaffIds = (emps || [])
        .filter(e => e.manager_id === me?.id)
        .map(e => e.id);
      // Mirror the derived isManager flag at component scope so other parts
      // of the panel (button gating, decideLeave's stage check) can read it.
      const hasDirectReports = deptStaffIds.length > 0;
      setIsManager(hasDirectReports);
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

      // History pull — only HR/admin reviewers (managers don't get a
      // 'recent decisions' view because their volume is tiny per person
      // and the manager dashboard already surfaces it via Pending
      // approvals card). 30-day window keyed by hr_decided_at, includes
      // both approved and rejected_by_hr rows.
      if (canPerm) {
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffISO = cutoff.toISOString();
        const histQs = `select=*&hr_decided_by=eq.${encodeURIComponent(me.id)}&hr_decided_at=gte.${cutoffISO}&order=hr_decided_at.desc`;
        try {
          const hist = await directGet('permission_requests', histQs, { timeoutMs: 10000 });
          setRecentDecisions(Array.isArray(hist) ? hist : []);
        } catch {
          setRecentDecisions([]);
        }
      } else {
        setRecentDecisions([]);
      }
    } catch (err) {
      console.warn('ReviewerPanel load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [me?.id, isAdmin, isHrReviewer, canPerm]);

  useEffect(() => { load(); }, [load]);

  // No realtime channel. The websocket subscription was causing the supabase-js
  // client to wedge after the first load. Reviewers click the Refresh button, or
  // the queue auto-refreshes when they re-enter the tab (handled by load() rerun).

  // Stage-aware decision: figures out the next stage from the current one and the action.
  // The status<->stage trigger keeps the legacy status column synced automatically.
  async function decideLeave(req, action) {
    setBusyId(`leave-${req.id}`);
    const now = new Date().toISOString();
    let nextStage, patch = {};

    if (req.stage === 'pending_manager') {
      // Self-approval guard (see decidePerm above for full rationale)
      const requester = empMap[req.employee_id];
      const requesterIsHr = !!requester?.is_hr_reviewer;
      if (action === 'approved') {
        nextStage = requesterIsHr ? 'approved' : 'pending_hr';
        if (requesterIsHr) {
          patch.hr_decided_at = now;
          patch.hr_decided_by = me.auth_user_id || null;
        }
      } else {
        nextStage = 'rejected_by_manager';
      }
      patch.manager_decided_at = now;
      patch.manager_decided_by = me.auth_user_id || null;
    } else if (req.stage === 'pending_hr') {
      nextStage = action === 'approved' ? 'approved' : 'rejected_by_hr';
      patch.hr_decided_at = now;
      patch.hr_decided_by = me.auth_user_id || null;
    } else {
      alert('Unexpected request stage: ' + req.stage);
      setBusyId(null);
      return;
    }
    patch.stage = nextStage;

    try {
      // Use directPatch (raw fetch) instead of supabase-js — the JS client
      // builder occasionally wedges and never sends the request.
      await directPatch('leave_requests', 'id', req.id, patch, { timeoutMs: 15000 });
      logAction(me, 'leave_request_decide', {
        targetType: 'leave_request',
        targetId: req.id,
        targetLabel: `${empMap[req.employee_id]?.name || req.employee_id} · ${nextStage}`,
        details: { stage: nextStage, action },
      });
      await load();
    } catch (err) { alert(err.message); }
    finally       { setBusyId(null); }
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

      {loading ? (
        <div className="opacity-60 text-sm flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading queue…
        </div>
      ) : (
        <>
          {canSeePerm && (
            <section>
              <h3 className="text-[10px] tracking-[0.25em] opacity-60 mb-3">
                {canPermAsManager && !canPerm ? 'DEPARTMENT PERMISSIONS · ' : 'PERMISSION REQUESTS · '}{perms.length}
              </h3>
              {perms.length === 0 ? (
                <EmptyState text={canPermAsManager && !canPerm
                  ? 'No pending permission requests from your direct reports.'
                  : 'No pending permission requests.'} />
              ) : (
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
                              <div className="text-sm">
                                <span className="opacity-50 font-mono mr-2">{req.employee_id}</span>
                                {emp?.name || '(unknown)'}
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
              )}
            </section>
          )}

          {canLeave && (
            <section>
              <h3 className="text-[10px] tracking-[0.25em] opacity-60 mb-3">
                {isHrReviewer && !isAdmin ? 'HR FINAL APPROVAL · ' : isDeptManager ? 'DEPARTMENT APPROVAL · ' : 'LEAVE REQUESTS · '}
                {leave.length}
              </h3>
              {leave.length === 0 ? (
                <EmptyState text="No pending leave requests." />
              ) : (
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
                          <button onClick={() => decideLeave(req, 'rejected')}
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
              )}
            </section>
          )}

          {/* HR-only — recent decisions made by this reviewer in the last
              30 days. Lets Bashaier see what she's already acted on,
              re-open the timeline for context, and re-trigger the
              download letter / email draft if she missed it. Hidden for
              managers (their volume is too small to warrant a separate
              section, and ManagerDashboard's Pending approvals already
              shows their recent activity). */}
          {canPerm && recentDecisions.length > 0 && (
            <section>
              <h3 className="text-[10px] tracking-[0.25em] opacity-60 mb-3">
                MY RECENT DECISIONS · {recentDecisions.length}
              </h3>
              <ul className="space-y-2">
                {recentDecisions.map(req => {
                  const emp = empMap[req.employee_id];
                  const TypeIcon = req.type === 'late_arrival' ? Sunrise : Sunset;
                  const wasApproved = req.stage === 'approved';
                  return (
                    <li key={req.id} className="rounded-xl px-4 py-2.5 border flex items-center gap-3"
                      style={{ background: '#FFFDF7', borderColor: 'var(--border-soft)' }}>
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0"
                        style={{ background: req.type === 'early_leave' ? '#FCE7F3' : '#FEF3C7',
                                 color:      req.type === 'early_leave' ? '#BE185D' : '#A16207' }}>
                        <TypeIcon className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                            {emp?.name || req.employee_id}
                          </span>
                          <span className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
                            · {PERMISSION_TYPES[req.type]?.label} · {Number(req.hours)}h · {fmtDate(req.permission_date)}
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
                          Decided {new Date(req.hr_decided_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </div>
                      </div>
                      {/* Re-open the post-approval modal so Bashaier can
                          re-download the .docx letter or re-open the
                          email draft. Only useful for approved rows. */}
                      {wasApproved && (
                        <button
                          type="button"
                          onClick={() => setApprovedPermission(req)}
                          className="text-[11px] px-3 py-1.5 rounded-full border opacity-80 hover:opacity-100 whitespace-nowrap"
                          style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }}
                          title="Re-open letter and email draft"
                        >
                          Letter / email
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
          {hrModalReq && (
        <HrApprovalModal
          request={hrModalReq}
          employee={empMap[hrModalReq.employee_id]}
          manager={empMap[empMap[hrModalReq.employee_id]?.manager_id]}
          substitutes={(hrModalReq.substitute_ids || []).map(sid => empMap[sid]).filter(Boolean)}
          me={me}
          onClose={() => setHrModalReq(null)}
          onApproved={() => { setHrModalReq(null); load(); }}
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
