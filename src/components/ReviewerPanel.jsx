import React, { useEffect, useState, useCallback } from 'react';
import { supabase, directPatch } from '../supabaseClient.js';
import { CheckCircle2, XCircle, Clock, Loader2, AlertTriangle, Sunrise, Sunset, Calendar, RefreshCw } from 'lucide-react';
import { logAction } from '../lib/audit.js';
import HrApprovalModal from './HrApprovalModal.jsx';
import { fmtDate } from '../lib/leaveLogic.js';
import { PERMISSION_TYPES, summariseMonth } from '../lib/permissionLogic.js';

// Visible to anyone with can_review_leave OR can_review_permissions OR is_admin.
// Shows pending items in two stacks: leave requests and permission requests.

export default function ReviewerPanel({ me }) {
  const [leave, setLeave]             = useState([]);
  const [perms, setPerms]             = useState([]);
  const [empMap, setEmpMap]           = useState({});
  const [loading, setLoading]         = useState(true);
  const [busyId, setBusyId]           = useState(null);
  const [hrModalReq, setHrModalReq]   = useState(null);

  // Role flags for stage-based routing
  // - is_admin (Nadeem): sees both pending_manager and pending_hr
  // - is_hr_reviewer (Bashaier, Nadeem): sees pending_hr only (final HR approval)
  // - can_review_leave but NOT is_hr_reviewer (5 dept heads): sees pending_manager
  //   filtered to requests from staff in their own department
  const isAdmin       = !!me?.is_admin;
  const isHrReviewer  = !!me?.is_hr_reviewer;
  const isDeptManager = !!me?.can_review_leave && !isHrReviewer;
  const canLeave      = isAdmin || isHrReviewer || isDeptManager;
  const canPerm       = isAdmin || me?.can_review_permissions;

  // Helper: race a Supabase query against a timeout so the UI doesn't hang forever
  const withTimeout = (p, ms = 10000, label = 'query') => Promise.race([
    Promise.resolve(p).then(r => r),
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
  ]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Fetch all employees so we can build the directory + filter by department
      const { data: emps } = await withTimeout(
        supabase.from('employees').select('id, name, location, department, manager_id, email, join_date'),
        10000, 'employees'
      );
      const map = {};
      (emps || []).forEach(e => { map[e.id] = e; });
      setEmpMap(map);

      // For dept managers we need the IDs of staff in their department
      const myDept = me?.department;
      const deptStaffIds = (emps || [])
        .filter(e => e.department === myDept && e.id !== me?.id)
        .map(e => e.id);

      // Build the leave queue query based on role.
      // Admin sees everything in pending_manager + pending_hr.
      // HR reviewer sees pending_hr only.
      // Dept manager sees pending_manager filtered by department.
      let leaveQuery = null;
      if (isAdmin) {
        leaveQuery = supabase.from('leave_requests')
          .select('*')
          .in('stage', ['pending_manager', 'pending_hr'])
          .order('requested_at', { ascending: false });
      } else if (isHrReviewer) {
        leaveQuery = supabase.from('leave_requests')
          .select('*')
          .eq('stage', 'pending_hr')
          .order('requested_at', { ascending: false });
      } else if (isDeptManager && deptStaffIds.length > 0) {
        leaveQuery = supabase.from('leave_requests')
          .select('*')
          .eq('stage', 'pending_manager')
          .in('employee_id', deptStaffIds)
          .order('requested_at', { ascending: false });
      }

      // Permission requests still use the simpler status='pending' model for now
      const buildPermQuery = () => {
        if (!canPerm && !isDeptManager) return Promise.resolve({ data: [] });
        let q = supabase.from('permission_requests').select('*').eq('status', 'pending').order('requested_at', { ascending: false });
        if (!canPerm && isDeptManager) q = q.in('employee_id', deptStaffIds);
        return q;
      };

      // Run leave + permission queries sequentially with timeouts so a hang in one
      // doesn't spin the UI forever.
      const lr = leaveQuery
        ? await withTimeout(leaveQuery, 10000, 'leave_requests')
        : { data: [] };
      const pr = await withTimeout(buildPermQuery(), 10000, 'permission_requests');

      setLeave(lr.data || []);
      setPerms(pr.data || []);
    } catch (err) {
      console.warn('ReviewerPanel load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [me?.id, me?.department, isAdmin, isHrReviewer, isDeptManager, canPerm]);

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
      nextStage = action === 'approved' ? 'pending_hr' : 'rejected_by_manager';
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

  async function decidePerm(req, status) {
    setBusyId(`perm-${req.id}`);
    try {
      const { error } = await supabase.from('permission_requests').update({
        status,
        reviewed_at: new Date().toISOString(),
        reviewed_by: me.id,
      }).eq('id', req.id);
      if (error) throw error;
      logAction(me, 'permission_decide', {
        targetType: 'permission_request',
        targetId: req.id,
        targetLabel: `${empMap[req.employee_id]?.name || req.employee_id} · ${PERMISSION_TYPES[req.type]?.label} · ${status}`,
        details: { status, exceeds_quota: req.exceeds_quota },
      });
      await load();
    } catch (err) { alert(err.message); }
    finally       { setBusyId(null); }
  }

  if (!canLeave && !canPerm) return null;

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="text-xs tracking-[0.25em] opacity-60">— REVIEW QUEUE</div>
          <h2 className="serif text-3xl mt-1" style={{ fontWeight: 500 }}>Pending decisions</h2>
          <p className="text-xs opacity-60 mt-1">
            {canLeave && canPerm ? 'You review leave + permission requests.'
             : canLeave         ? 'You review leave requests.'
             :                    'You review permission requests.'}
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
          {canPerm && (
            <section>
              <h3 className="text-[10px] tracking-[0.25em] opacity-60 mb-3">PERMISSION REQUESTS · {perms.length}</h3>
              {perms.length === 0 ? (
                <EmptyState text="No pending permission requests." />
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
                              <div className="text-xs opacity-60 mt-1">
                                Cover: {req.substitute_ids.map(sid => empMap[sid]?.name || sid).join(', ')}
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
