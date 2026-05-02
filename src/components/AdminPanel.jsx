import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient.js';
import {
  ShieldCheck, Clock, CheckCircle2, XCircle, Copy, RefreshCw, Mail, Loader2, AlertCircle, KeyRound, UserCheck, FileEdit, Save
} from 'lucide-react';
import { psnToEmail, generatePin, getAdminParallelClient } from '../lib/psnAuth.js';
import { logAction, formatAction, actionCategory } from '../lib/audit.js';
import { loadTemplates, saveTemplates, DEFAULT_TEMPLATES, invalidate as invalidateTemplates } from '../lib/emailTemplates.js';

// Admin panel: review pending PSN registration requests, generate PIN, create auth user,
// link to employee, mark request approved. Surfaces PIN to admin so they can share it
// with the employee out-of-band (email/WhatsApp/etc.) until automated email is wired up.

export default function AdminPanel({ session, me, onRefreshMe }) {
  const [pending, setPending] = useState([]);
  const [recent, setRecent]   = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [auditFilter, setAuditFilter] = useState('all'); // 'all' | psn
  // Category filter for the activity log — chips above the list let
  // admin narrow to e.g. just leave decisions or just attendance work.
  // Categories are derived from the action slug via actionCategory().
  const [auditCategory, setAuditCategory] = useState('all');
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

      {/* ─────────── SIGN-IN ACTIVITY (admin-only) ─────────── */}
      <SignInActivity auditLog={auditLog} loading={auditLoading} onRefresh={loadAudit} />

      {/* ─────────── EMAIL TEMPLATES (admin-only) ─────────── */}
      <EmailTemplatesPanel me={me} />

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

        {/* Category chips — narrow the activity feed to one of the
            high-level activity buckets. Derived from the action slug
            via actionCategory(). 'All' is always present; the rest
            only render if there's at least one log row in that
            category, so the chip row stays compact in light usage. */}
        {auditLog.length > 0 && (() => {
          const presentCats = new Set(auditLog.map(l => actionCategory(l.action)));
          const orderedCats = ['all', 'leave', 'permission', 'rejoining', 'attendance', 'shift', 'org', 'access', 'auth', 'other'];
          const visible = orderedCats.filter(c => c === 'all' || presentCats.has(c));
          return (
            <div className="flex items-center gap-1.5 mb-3 flex-wrap">
              {visible.map(c => (
                <button key={c} onClick={() => setAuditCategory(c)}
                  className="text-[10px] tracking-wider font-bold px-2.5 py-1 rounded-full border transition-colors"
                  style={{
                    borderColor: auditCategory === c ? 'rgba(244,238,223,0.5)' : 'rgba(244,238,223,0.15)',
                    background:  auditCategory === c ? 'rgba(244,238,223,0.12)' : 'transparent',
                    color:       auditCategory === c ? '#FAF7F0' : 'rgba(244,238,223,0.65)',
                  }}>
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
          );
        })()}

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
              .filter(l => auditCategory === 'all' || actionCategory(l.action) === auditCategory)
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

// ─────────────────────────────────────────────────────────────────────────────
// SignInActivity — paired sign-in / sign-out times per user, sorted by most
// recent. Built from audit_log rows where action ∈ {sign_in, sign_out}.
// Admin-only — gated by the audit_log RLS policy + AdminPanel admin gate.
// ─────────────────────────────────────────────────────────────────────────────
function SignInActivity({ auditLog, loading, onRefresh }) {
  const events = (auditLog || []).filter(l => l.action === 'sign_in' || l.action === 'sign_out');
  const byUser = {};
  events.forEach(e => {
    const key = e.actor_psn || e.actor_user_id || 'unknown';
    if (!byUser[key]) byUser[key] = [];
    byUser[key].push(e);
  });
  // Build session rows: walk each user's events in reverse-chrono order
  // (which is how they arrive from the DB), pairing each sign_in with the
  // most recent sign_out that came after it.
  const sessions = [];
  Object.entries(byUser).forEach(([key, evts]) => {
    let pendingOut = null;
    for (let i = 0; i < evts.length; i++) {
      const e = evts[i];
      if (e.action === 'sign_out') {
        pendingOut = e;
      } else if (e.action === 'sign_in') {
        sessions.push({
          actor_psn:    e.actor_psn,
          actor_name:   e.actor_name,
          signedInAt:   e.created_at,
          signedOutAt:  pendingOut ? pendingOut.created_at : null,
          email:        e.details?.email || null,
        });
        pendingOut = null;
      }
    }
  });
  sessions.sort((a, b) => (b.signedInAt || '').localeCompare(a.signedInAt || ''));

  const fmt = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('en-GB', {
      day: '2-digit', month: 'short',
      hour: '2-digit', minute: '2-digit',
      hour12: false,
    });
  };
  const duration = (a, b) => {
    if (!a || !b) return null;
    const ms = new Date(b).getTime() - new Date(a).getTime();
    if (ms < 0 || !isFinite(ms)) return null;
    const mins = Math.round(ms / 60000);
    if (mins < 60) return mins + 'm';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h + 'h ' + (m ? m + 'm' : '');
  };

  return (
    <section className="pt-8 border-t" style={{ borderColor: 'rgba(244,238,223,0.08)' }}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h3 className="text-xs tracking-[0.25em] opacity-60">SIGN-IN ACTIVITY</h3>
          <p className="text-xs opacity-50 mt-1">
            When each user signed in and out. Latest 30 sessions across all staff.
          </p>
        </div>
        <button onClick={onRefresh}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs border opacity-70 hover:opacity-100"
          style={{ borderColor: 'rgba(244,238,223,0.2)' }}>
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="opacity-60 text-sm flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading sign-in activity…
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-xl p-6 text-center text-sm opacity-60"
          style={{ background: 'rgba(244,238,223,0.03)', border: '1px solid rgba(244,238,223,0.08)' }}>
          No sign-in activity recorded yet. New sign-ins from now on will appear here.
        </div>
      ) : (
        <div className="rounded-xl overflow-hidden"
          style={{ background: 'rgba(244,238,223,0.03)', border: '1px solid rgba(244,238,223,0.08)' }}>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: 'rgba(244,238,223,0.04)' }}>
                <th className="text-left px-4 py-2.5 tracking-[0.15em] opacity-60 font-normal">PSN</th>
                <th className="text-left px-4 py-2.5 tracking-[0.15em] opacity-60 font-normal">NAME</th>
                <th className="text-left px-4 py-2.5 tracking-[0.15em] opacity-60 font-normal">SIGNED IN</th>
                <th className="text-left px-4 py-2.5 tracking-[0.15em] opacity-60 font-normal">SIGNED OUT</th>
                <th className="text-left px-4 py-2.5 tracking-[0.15em] opacity-60 font-normal">DURATION</th>
              </tr>
            </thead>
            <tbody>
              {sessions.slice(0, 30).map((s, i) => {
                const isActive = !s.signedOutAt;
                return (
                  <tr key={i} style={{ borderTop: '1px solid rgba(244,238,223,0.06)' }}>
                    <td className="px-4 py-2.5 font-mono opacity-70">{s.actor_psn || '—'}</td>
                    <td className="px-4 py-2.5 truncate" style={{ maxWidth: 220 }}>{s.actor_name || '—'}</td>
                    <td className="px-4 py-2.5 opacity-90">{fmt(s.signedInAt)}</td>
                    <td className="px-4 py-2.5">
                      {isActive ? (
                        <span className="text-[10px] px-2 py-0.5 rounded-full"
                          style={{ background: 'rgba(143,179,154,0.2)', color: '#BFD5C4', fontWeight: 700, letterSpacing: '0.1em' }}>
                          ACTIVE
                        </span>
                      ) : (
                        <span className="opacity-90">{fmt(s.signedOutAt)}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 opacity-70">
                      {duration(s.signedInAt, s.signedOutAt) || (isActive ? 'in progress' : '—')}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ─── EmailTemplatesPanel ────────────────────────────────────────────────
// Admin-editable customisation surface for the values currently
// hardcoded across the email-builder libraries. Today wires:
//   • HR signature block (name, email, phone, WhatsApp, etc.)
//   • Subject prefixes for the various email types
// More fields can be added incrementally — the storage shape (a single
// JSON value in app_settings.key='email_templates') accommodates new
// keys without schema migration.
//
// Reads via loadTemplates(); saves via saveTemplates() with cache
// invalidation so consumers (permissionLetter, rejoiningReport, etc.)
// pick up the new values on their next read. Defaults fall through
// when a leaf is empty so partial edits work cleanly.
function EmailTemplatesPanel({ me }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');
  const [saved, setSaved]     = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        invalidateTemplates(); // force fresh read on panel open
        const t = await loadTemplates();
        if (!cancelled) setData(t);
      } catch (e) {
        if (!cancelled) {
          setData({ ...DEFAULT_TEMPLATES });
          setError('Could not load saved templates — showing defaults. Run migration_app_settings.sql to enable saving.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const updateSig = (field, value) => {
    setData(d => ({ ...d, hr_signature: { ...d.hr_signature, [field]: value } }));
    setSaved(false);
  };
  const updateSubject = (key, value) => {
    setData(d => ({ ...d, subject_prefixes: { ...d.subject_prefixes, [key]: value } }));
    setSaved(false);
  };
  const resetField = (section, field) => {
    setData(d => ({ ...d, [section]: { ...d[section], [field]: DEFAULT_TEMPLATES[section][field] } }));
    setSaved(false);
  };

  const handleSave = async () => {
    setBusy(true); setError(''); setSaved(false);
    try {
      await saveTemplates(data, me?.id);
      // Re-hydrate cache from DB so we're sure what was actually saved
      // is what consumers will read.
      invalidateTemplates();
      const fresh = await loadTemplates();
      setData(fresh);
      setSaved(true);
      try { logAction(me, 'email_template_update', { targetType: 'app_settings', targetId: 'email_templates' }); } catch (_) {}
    } catch (e) {
      setError(e?.message || 'Could not save changes — try again or run migration_app_settings.sql.');
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <section className="pt-8 border-t" style={{ borderColor: 'rgba(244,238,223,0.08)' }}>
        <h3 className="text-xs tracking-[0.25em] opacity-60 mb-3">EMAIL TEMPLATES</h3>
        <div className="opacity-60 text-sm flex items-center gap-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin"/> Loading templates…
        </div>
      </section>
    );
  }

  return (
    <section className="pt-8 border-t" style={{ borderColor: 'rgba(244,238,223,0.08)' }}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
        <div>
          <h3 className="text-xs tracking-[0.25em] opacity-60 inline-flex items-center gap-2">
            <FileEdit className="w-3.5 h-3.5"/> EMAIL TEMPLATES
          </h3>
          <p className="text-xs opacity-50 mt-1">
            Override the values used in generated permission, rejoining, and attendance emails. Empty fields fall back to defaults.
          </p>
        </div>
        <button onClick={handleSave} disabled={busy}
          className="text-xs inline-flex items-center gap-1.5 px-4 py-2 rounded-full disabled:opacity-50"
          style={{ background: 'var(--evergreen-500)', color: 'var(--paper)', fontWeight: 600 }}>
          {busy ? <><Loader2 className="w-3.5 h-3.5 animate-spin"/> Saving…</> : <><Save className="w-3.5 h-3.5"/> Save changes</>}
        </button>
      </div>

      {error && (
        <div className="rounded-lg p-3 text-xs mb-3 flex items-start gap-2"
          style={{ background: 'rgba(184,74,62,0.1)', border: '1px solid rgba(184,74,62,0.3)', color: '#FAF7F0' }}>
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"/> {error}
        </div>
      )}
      {saved && (
        <div className="rounded-lg p-3 text-xs mb-3 inline-flex items-center gap-2"
          style={{ background: 'rgba(143,179,154,0.15)', border: '1px solid rgba(143,179,154,0.4)', color: '#BFD5C4' }}>
          <CheckCircle2 className="w-3.5 h-3.5"/> Saved. New emails will use the updated values.
        </div>
      )}

      {/* HR Signature block */}
      <div className="rounded-xl p-4 mb-4"
        style={{ background: 'rgba(244,238,223,0.03)', border: '1px solid rgba(244,238,223,0.08)' }}>
        <div className="text-[10px] tracking-widest opacity-60 mb-3" style={{ fontWeight: 700 }}>
          HR SIGNATURE
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            ['name',     'Name'],
            ['email',    'Email'],
            ['tel',      'Phone'],
            ['whatsapp', 'WhatsApp'],
            ['unit',     'Unit'],
            ['address',  'Address'],
            ['company',  'Company'],
          ].map(([f, label]) => (
            <SettingField key={f}
              label={label}
              value={data?.hr_signature?.[f] ?? ''}
              defaultValue={DEFAULT_TEMPLATES.hr_signature[f]}
              onChange={v => updateSig(f, v)}
              onReset={() => resetField('hr_signature', f)} />
          ))}
        </div>
      </div>

      {/* Subject prefixes */}
      <div className="rounded-xl p-4"
        style={{ background: 'rgba(244,238,223,0.03)', border: '1px solid rgba(244,238,223,0.08)' }}>
        <div className="text-[10px] tracking-widest opacity-60 mb-3" style={{ fontWeight: 700 }}>
          SUBJECT PREFIXES
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[
            ['permission_letter', 'Permission letter'],
            ['rejoining_letter',  'Rejoining letter'],
            ['attendance_late',   'Lateness notice'],
            ['attendance_early',  'Early departure notice'],
            ['attendance_missed', 'Punch reminder'],
          ].map(([k, label]) => (
            <SettingField key={k}
              label={label}
              value={data?.subject_prefixes?.[k] ?? ''}
              defaultValue={DEFAULT_TEMPLATES.subject_prefixes[k]}
              onChange={v => updateSubject(k, v)}
              onReset={() => resetField('subject_prefixes', k)} />
          ))}
        </div>
      </div>

      <div className="text-[11px] opacity-50 mt-4">
        Note: these overrides take effect for newly-generated emails. Already-sent drafts in your mail client are unaffected.
      </div>
    </section>
  );
}

function SettingField({ label, value, defaultValue, onChange, onReset }) {
  const isCustomised = value !== defaultValue && value !== '' && value !== undefined && value !== null;
  return (
    <label className="block">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] tracking-wider opacity-60" style={{ fontWeight: 600 }}>
          {label.toUpperCase()}
          {isCustomised && (
            <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full"
              style={{ background: '#9D6B53' }}
              title="Customised — different from default"/>
          )}
        </span>
        {isCustomised && (
          <button type="button" onClick={onReset}
            className="text-[10px] opacity-40 hover:opacity-100 underline"
            title={`Reset to default: ${defaultValue}`}>
            reset
          </button>
        )}
      </div>
      <input type="text" value={value ?? ''} onChange={e => onChange(e.target.value)}
        placeholder={defaultValue}
        className="w-full px-3 py-2 rounded-md text-sm font-mono"
        style={{
          background: 'rgba(244,238,223,0.05)',
          border: '1px solid rgba(244,238,223,0.15)',
          color: '#FAF7F0',
        }}/>
    </label>
  );
}
