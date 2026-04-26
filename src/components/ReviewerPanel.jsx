import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient.js';
import { CheckCircle2, XCircle, Clock, Loader2, AlertTriangle, Sunrise, Sunset, Calendar, RefreshCw } from 'lucide-react';
import { logAction } from '../lib/audit.js';
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

  const canLeave = me?.is_admin || me?.can_review_leave;
  const canPerm  = me?.is_admin || me?.can_review_permissions;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // First fetch all employees so we can derive direct reports
      const { data: emps } = await supabase
        .from('employees')
        .select('id, name, location, department, manager_id');
      const map = {};
      (emps || []).forEach(e => { map[e.id] = e; });
      setEmpMap(map);

      // Direct reports: staff whose manager_id === me.id
      const reportIds = (emps || [])
        .filter(e => e.manager_id === me?.id)
        .map(e => e.id);
      const showAll      = canLeave || canPerm;        // Bashaier / admin / any reviewer
      const showAsMgrOnly = !showAll && reportIds.length > 0;

      const buildQuery = (table, allowed) => {
        if (!allowed && !showAsMgrOnly) return Promise.resolve({ data: [] });
        let q = supabase.from(table).select('*').eq('status', 'pending').order('requested_at', { ascending: false });
        if (!showAll) q = q.in('employee_id', reportIds);
        return q;
      };

      const [lr, pr] = await Promise.all([
        buildQuery('leave_requests',      canLeave),
        buildQuery('permission_requests', canPerm),
      ]);

      setLeave(lr.data || []);
      setPerms(pr.data || []);
    } catch (err) {
      console.warn('ReviewerPanel load failed:', err);
    } finally {
      setLoading(false);
    }
  }, [me?.id, canLeave, canPerm]);

  useEffect(() => { load(); }, [load]);

  // Realtime
  useEffect(() => {
    const ch = supabase.channel('reviewer-feed')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leave_requests' }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'permission_requests' }, load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  async function decideLeave(req, status) {
    setBusyId(`leave-${req.id}`);
    try {
      const { error } = await supabase.from('leave_requests').update({
        status,
        decided_at: new Date().toISOString(),
        decided_by: me.id,
      }).eq('id', req.id);
      if (error) throw error;
      logAction(me, 'leave_request_decide', {
        targetType: 'leave_request',
        targetId: req.id,
        targetLabel: `${empMap[req.employee_id]?.name || req.employee_id} · ${status}`,
        details: { status },
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
              <h3 className="text-[10px] tracking-[0.25em] opacity-60 mb-3">LEAVE REQUESTS · {leave.length}</h3>
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
                            <div className="text-sm">
                              <span className="opacity-50 font-mono mr-2">{req.employee_id}</span>
                              {emp?.name || '(unknown)'}
                            </div>
                            <div className="text-xs opacity-70 mt-0.5">
                              {fmtDate(new Date(req.start_date))} → {fmtDate(new Date(req.end_date))} · {req.days} day{req.days !== 1 ? 's' : ''}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button onClick={() => decideLeave(req, 'approved')}
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
