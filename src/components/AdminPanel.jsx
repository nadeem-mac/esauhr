import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient.js';
import {
  ShieldCheck, Clock, CheckCircle2, XCircle, Copy, RefreshCw, Mail, Loader2, AlertCircle, KeyRound, UserCheck
} from 'lucide-react';
import { psnToEmail, generatePin, getAdminParallelClient } from '../lib/psnAuth.js';
import { logAction, formatAction } from '../lib/audit.js';

// Admin panel: review pending PSN registration requests, generate PIN, create auth user,
// link to employee, mark request approved. Surfaces PIN to admin so they can share it
// with the employee out-of-band (email/WhatsApp/etc.) until automated email is wired up.

export default function AdminPanel({ session, me, onRefreshMe }) {
  const [pending, setPending] = useState([]);
  const [recent, setRecent]   = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [auditFilter, setAuditFilter] = useState('all'); // 'all' | psn
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(true);
  const [error, setError]     = useState('');
  const [busyId, setBusyId]   = useState(null);
  const [issuedPins, setIssuedPins] = useState({}); // { request_id: { pin, name, psn, email } }

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [p, r] = await Promise.all([
        supabase.from('registration_requests').select('*').eq('status', 'pending').order('requested_at', { ascending: false }),
        supabase.from('registration_requests').select('*').neq('status', 'pending').order('approved_at', { ascending: false }).limit(20),
      ]);
      if (p.error) throw p.error;
      if (r.error) throw r.error;

      // Hydrate with employee details
      const allPsns = [...(p.data || []), ...(r.data || [])].map(x => x.psn);
      const empMap = {};
      if (allPsns.length) {
        const { data: emps } = await supabase.from('employees').select('id, name, location, department, email, auth_user_id').in('id', allPsns);
        (emps || []).forEach(e => { empMap[e.id] = e; });
      }
      const hydrate = arr => (arr || []).map(req => ({ ...req, employee: empMap[req.psn] || null }));
      setPending(hydrate(p.data));
      setRecent(hydrate(r.data));
    } catch (err) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Load recent audit log entries (admin-only RLS)
  const loadAudit = useCallback(async () => {
    setAuditLoading(true);
    try {
      const { data, error } = await supabase
        .from('audit_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      setAuditLog(data || []);
    } catch (err) {
      // RLS-denied means migration hasn't run yet — fail silently for v1.
      setAuditLog([]);
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => { loadAudit(); }, [loadAudit]);

  // Realtime updates
  useEffect(() => {
    const ch = supabase.channel('admin-reg-requests')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'registration_requests' }, load)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_log' }, loadAudit)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load, loadAudit]);

  async function approve(req) {
    setBusyId(req.id);
    setError('');
    try {
      if (!req.employee) {
        throw new Error(`No employee record for PSN ${req.psn}. Add them to the directory first.`);
      }
      if (req.employee.auth_user_id) {
        throw new Error(`${req.employee.name} already has an account. If they lost their PIN, reset it from the Employees tab.`);
      }

      const pin = generatePin(6);
      const email = psnToEmail(req.psn);

      // Use parallel client so admin's session is preserved
      const adminClient = getAdminParallelClient();
      const { data: signUpData, error: signErr } = await adminClient.auth.signUp({
        email,
        password: pin,
        options: {
          data: { psn: req.psn, name: req.employee.name },
          emailRedirectTo: undefined,
        },
      });
      if (signErr) throw new Error('Could not create auth user: ' + signErr.message);

      const newUserId = signUpData.user?.id;
      if (!newUserId) throw new Error('Auth user was not returned after signUp');

      // Link auth user to employee record
      const { error: linkErr } = await supabase
        .from('employees')
        .update({ auth_user_id: newUserId, pin_set_at: new Date().toISOString() })
        .eq('id', req.psn);
      if (linkErr) throw new Error('Could not link employee: ' + linkErr.message);

      // Mark request approved
      const { error: reqErr } = await supabase
        .from('registration_requests')
        .update({
          status: 'approved',
          approved_at: new Date().toISOString(),
          approved_by: session.user.id,
          pin_generated_at: new Date().toISOString(),
        })
        .eq('id', req.id);
      if (reqErr) throw new Error('Could not mark approved: ' + reqErr.message);

      // Surface PIN to admin
      setIssuedPins(prev => ({
        ...prev,
        [req.id]: { pin, name: req.employee.name, psn: req.psn, email: req.employee.email },
      }));

      // Audit
      logAction(me, 'request_approve', {
        targetType: 'registration_request',
        targetId: req.id,
        targetLabel: `${req.employee.name} (${req.psn})`,
      });

      // Sign out the parallel client (so it doesn't keep that session in memory)
      try { await adminClient.auth.signOut(); } catch {}

      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function reject(req) {
    setBusyId(req.id);
    setError('');
    try {
      const { error: e } = await supabase.from('registration_requests')
        .update({ status: 'rejected', approved_at: new Date().toISOString(), approved_by: session.user.id })
        .eq('id', req.id);
      if (e) throw e;
      logAction(me, 'request_reject', {
        targetType: 'registration_request',
        targetId: req.id,
        targetLabel: `${req.employee?.name || ''} (${req.psn})`,
      });
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); } catch {}
  }

  return (
    <div className="space-y-8">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-xs tracking-[0.25em] opacity-60 mb-2">
            <ShieldCheck className="w-3.5 h-3.5" /> ADMIN · ACCESS CONTROL
          </div>
          <h2 className="serif text-3xl" style={{ fontWeight: 500 }}>
            Pending requests
          </h2>
          <p className="text-sm opacity-70 mt-1">
            Review staff who asked to join. Approve to generate their PIN and link their account.
          </p>
        </div>
        <button onClick={load} className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border opacity-80 hover:opacity-100"
          style={{ borderColor: 'rgba(244,238,223,0.25)' }}>
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </header>

      {error && (
        <div className="flex items-start gap-2 text-sm p-3 rounded-lg" style={{ background: 'rgba(184,74,62,0.2)', color: '#F4D5CD' }}>
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 opacity-70 text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</div>
      ) : pending.length === 0 ? (
        <div className="rounded-2xl p-8 text-center" style={{ background: 'rgba(244,238,223,0.04)', border: '1px solid rgba(244,238,223,0.1)' }}>
          <UserCheck className="w-8 h-8 mx-auto opacity-40 mb-3" />
          <p className="text-sm opacity-70">No pending requests right now.</p>
          <p className="text-xs opacity-50 mt-1">Staff who use "Request access" on the sign-in screen will appear here.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {pending.map(req => {
            const issued = issuedPins[req.id];
            return (
              <li key={req.id} className="rounded-2xl p-5"
                style={{ background: 'rgba(244,238,223,0.04)', border: '1px solid rgba(244,238,223,0.1)' }}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <div className="text-xs tracking-widest opacity-50">{req.psn}</div>
                    <div className="serif text-xl mt-0.5" style={{ fontWeight: 500 }}>
                      {req.employee?.name || <span className="opacity-50">Unknown employee</span>}
                    </div>
                    {req.employee && (
                      <div className="text-xs opacity-60 mt-1">
                        {req.employee.location} · {req.employee.department}
                        {req.employee.email && <> · {req.employee.email}</>}
                      </div>
                    )}
                    <div className="text-xs opacity-40 mt-2 flex items-center gap-1">
                      <Clock className="w-3 h-3" /> {new Date(req.requested_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => approve(req)}
                      disabled={busyId === req.id || !req.employee}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium transition disabled:opacity-50"
                      style={{ background: '#F4EEDF', color: 'var(--evergreen-900)' }}>
                      {busyId === req.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                      Approve & generate PIN
                    </button>
                    <button onClick={() => reject(req)}
                      disabled={busyId === req.id}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm border opacity-70 hover:opacity-100"
                      style={{ borderColor: 'rgba(244,238,223,0.25)' }}>
                      <XCircle className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                </div>

                {issued && (
                  <div className="mt-4 p-4 rounded-xl" style={{ background: 'rgba(143,179,154,0.12)', border: '1px solid rgba(143,179,154,0.3)' }}>
                    <div className="flex items-center gap-2 text-xs tracking-widest opacity-70 mb-3">
                      <CheckCircle2 className="w-3.5 h-3.5" /> ACCOUNT CREATED · SHARE THESE WITH {issued.name.toUpperCase()}
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <CopyRow label="PSN" value={issued.psn} onCopy={copyToClipboard} />
                      <CopyRow label="PIN" value={issued.pin} onCopy={copyToClipboard} mono />
                    </div>
                    {issued.email && (
                      <div className="mt-3 text-xs opacity-70 flex items-center gap-1.5">
                        <Mail className="w-3 h-3" /> Send to <span className="opacity-100">{issued.email}</span>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {recent.length > 0 && (
        <section className="pt-6">
          <h3 className="text-xs tracking-[0.25em] opacity-60 mb-3">RECENT DECISIONS</h3>
          <ul className="space-y-2">
            {recent.map(req => (
              <li key={req.id} className="flex items-center justify-between px-4 py-3 rounded-xl text-sm"
                style={{ background: 'rgba(244,238,223,0.03)', border: '1px solid rgba(244,238,223,0.08)' }}>
                <div className="flex items-center gap-3">
                  <span className="text-xs opacity-50 w-20">{req.psn}</span>
                  <span>{req.employee?.name || '—'}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${req.status === 'approved' ? 'bg-emerald-900/30 text-emerald-200' : 'bg-rose-900/30 text-rose-200'}`}>
                    {req.status}
                  </span>
                  <span className="text-xs opacity-40">
                    {req.approved_at ? new Date(req.approved_at).toLocaleDateString() : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ─────────── ACTIVITY LOG (admin-only) ─────────── */}
      <section className="pt-8 border-t" style={{ borderColor: 'rgba(244,238,223,0.08)' }}>
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <div>
            <h3 className="text-xs tracking-[0.25em] opacity-60">ACTIVITY LOG</h3>
            <p className="text-xs opacity-50 mt-1">
              Every meaningful action across the platform. Visible only to admins.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={auditFilter}
              onChange={e => setAuditFilter(e.target.value)}
              className="text-xs px-3 py-1.5 rounded-full border bg-transparent"
              style={{ borderColor: 'rgba(244,238,223,0.2)', color: 'inherit' }}>
              <option value="all" style={{ background: 'var(--evergreen-900)' }}>All users</option>
              {[...new Set(auditLog.map(l => l.actor_psn).filter(Boolean))].map(psn => (
                <option key={psn} value={psn} style={{ background: 'var(--evergreen-900)' }}>{psn}</option>
              ))}
            </select>
            <button onClick={loadAudit}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs border opacity-70 hover:opacity-100"
              style={{ borderColor: 'rgba(244,238,223,0.2)' }}>
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
        </div>

        {auditLoading ? (
          <div className="opacity-60 text-sm flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading activity…
          </div>
        ) : auditLog.length === 0 ? (
          <div className="rounded-xl p-6 text-center text-sm opacity-60"
            style={{ background: 'rgba(244,238,223,0.03)', border: '1px solid rgba(244,238,223,0.08)' }}>
            No activity recorded yet. Run <code className="font-mono opacity-80">migration_audit_log.sql</code> in Supabase to enable logging.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {auditLog
              .filter(l => auditFilter === 'all' || l.actor_psn === auditFilter)
              .slice(0, 60)
              .map(log => (
                <li key={log.id}
                  className="flex items-start justify-between gap-3 px-4 py-2.5 rounded-lg text-xs"
                  style={{ background: 'rgba(244,238,223,0.03)', border: '1px solid rgba(244,238,223,0.06)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="font-mono opacity-60 text-[10px]">{log.actor_psn || '—'}</span>
                      <span className="opacity-90 truncate">{log.actor_name || 'unknown'}</span>
                      <span className="text-[10px] tracking-widest px-1.5 py-0.5 rounded-full opacity-80"
                        style={{ background: 'rgba(143,179,154,0.15)', color: '#BFD5C4' }}>
                        {formatAction(log.action)}
                      </span>
                    </div>
                    {log.target_label && (
                      <div className="opacity-70 truncate">{log.target_label}</div>
                    )}
                  </div>
                  <div className="text-[10px] opacity-40 whitespace-nowrap text-right">
                    {new Date(log.created_at).toLocaleString()}
                  </div>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function CopyRow({ label, value, onCopy, mono }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[10px] tracking-[0.2em] opacity-60 mb-1">{label}</div>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg"
        style={{ background: 'rgba(15,40,24,0.5)', border: '1px solid rgba(244,238,223,0.1)' }}>
        <span className={`flex-1 ${mono ? 'font-mono tracking-widest' : ''}`} style={{ fontSize: mono ? '1.1rem' : '0.95rem' }}>
          {value}
        </span>
        <button onClick={async () => { await onCopy(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
          className="opacity-60 hover:opacity-100">
          {copied ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
}
