import React, { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient.js';
import {
  ShieldCheck, Clock, CheckCircle2, XCircle, Copy, RefreshCw, Mail, Loader2, AlertCircle, KeyRound, UserCheck
} from 'lucide-react';
import { psnToEmail, generatePin, getAdminParallelClient } from '../lib/psnAuth.js';
import { logAction, formatAction, actionCategory } from '../lib/audit.js';
import GovernmentDataSync from './GovernmentDataSync.jsx';

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
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 text-xs tracking-[0.25em] mb-2" style={{ color: '#0A0A0A' }}>
            <ShieldCheck className="w-3.5 h-3.5" /> ADMIN · ACCESS CONTROL
          </div>
          <h2 className="serif text-3xl" style={{ fontWeight: 500, color: '#0A0A0A' }}>
            Pending requests
          </h2>
          <p className="text-sm mt-1" style={{ color: '#0A0A0A' }}>
            Review staff who asked to join. Approve to generate their PIN and link their account.
          </p>
        </div>
        <button onClick={load}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border"
          style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A', background: '#FFFFFF' }}>
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </header>

      {error && (
        <div className="flex items-start gap-2 text-sm p-3 rounded-lg"
          style={{ background: '#FEE2E2', border: '1px solid #FECACA', color: '#0A0A0A' }}>
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#991B1B' }}/> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm" style={{ color: '#0A0A0A' }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : pending.length === 0 ? (
        <div className="rounded-2xl p-6 text-center"
          style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
          <UserCheck className="w-7 h-7 mx-auto mb-2" style={{ color: '#0A0A0A', opacity: 0.5 }}/>
          <p className="text-sm" style={{ color: '#0A0A0A', fontWeight: 500 }}>No pending requests right now.</p>
          <p className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            Staff who use "Request access" on the sign-in screen will appear here.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {pending.map(req => {
            const issued = issuedPins[req.id];
            return (
              <li key={req.id} className="rounded-2xl p-4 sm:p-5"
                style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div>
                    <div className="text-xs tracking-widest font-mono" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                      {req.psn}
                    </div>
                    <div className="serif text-xl mt-0.5" style={{ fontWeight: 500, color: '#0A0A0A' }}>
                      {req.employee?.name || <span style={{ opacity: 0.6 }}>Unknown employee</span>}
                    </div>
                    {req.employee && (
                      <div className="text-xs mt-1" style={{ color: '#0A0A0A' }}>
                        {req.employee.location} · {req.employee.department}
                        {req.employee.email && <> · {req.employee.email}</>}
                      </div>
                    )}
                    <div className="text-xs mt-2 flex items-center gap-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                      <Clock className="w-3 h-3" /> {new Date(req.requested_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => approve(req)}
                      disabled={busyId === req.id || !req.employee}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-sm font-medium transition disabled:opacity-50"
                      style={{ background: '#0F4C2A', color: '#FFFFFF' }}>
                      {busyId === req.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
                      Approve & generate PIN
                    </button>
                    <button onClick={() => reject(req)}
                      disabled={busyId === req.id}
                      className="inline-flex items-center gap-1.5 px-3 py-2 rounded-full text-sm border"
                      style={{ borderColor: '#FECACA', color: '#991B1B', background: '#FFFFFF' }}>
                      <XCircle className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                </div>

                {issued && (
                  <div className="mt-4 p-4 rounded-xl"
                    style={{ background: '#ECFDF5', border: '1px solid #A7F3D0' }}>
                    <div className="flex items-center gap-2 text-xs tracking-widest mb-3" style={{ color: '#0A0A0A', fontWeight: 700 }}>
                      <CheckCircle2 className="w-3.5 h-3.5" style={{ color: '#047857' }}/> ACCOUNT CREATED · SHARE THESE WITH {issued.name.toUpperCase()}
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <CopyRow label="PSN" value={issued.psn} onCopy={copyToClipboard} />
                      <CopyRow label="PIN" value={issued.pin} onCopy={copyToClipboard} mono />
                    </div>
                    {issued.email && (
                      <div className="mt-3 text-xs flex items-center gap-1.5" style={{ color: '#0A0A0A' }}>
                        <Mail className="w-3 h-3" /> Send to <span style={{ fontWeight: 600 }}>{issued.email}</span>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Two-column: Recent decisions + Sign-in activity side by side
          on wide screens so the dead space below the empty pending
          state collapses. Stacks on mobile. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* RECENT DECISIONS */}
        <section className="rounded-2xl p-4 sm:p-5"
          style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
          <h3 className="text-xs tracking-[0.25em] mb-3" style={{ color: '#0A0A0A', fontWeight: 700 }}>
            RECENT DECISIONS · {recent.length}
          </h3>
          {recent.length === 0 ? (
            <p className="text-xs" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              No registration decisions yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {recent.slice(0, 6).map(req => {
                const isApproved = req.status === 'approved';
                return (
                  <li key={req.id} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg flex-wrap"
                    style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="text-[11px] font-mono" style={{ color: '#0A0A0A', opacity: 0.75 }}>{req.psn}</span>
                      <span className="text-sm truncate" style={{ color: '#0A0A0A', fontWeight: 500 }}>
                        {req.employee?.name || '—'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wider"
                        style={
                          isApproved
                            ? { background: '#ECFDF5', color: '#047857', border: '1px solid #A7F3D0' }
                            : { background: '#FEE2E2', color: '#991B1B', border: '1px solid #FECACA' }
                        }>
                        {req.status.toUpperCase()}
                      </span>
                      <span className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                        {req.approved_at ? new Date(req.approved_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : ''}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* SIGN-IN ACTIVITY */}
        <SignInActivity auditLog={auditLog} loading={auditLoading} onRefresh={loadAudit} />
      </div>

      {/* ─────────── GOVERNMENT DATA SYNC (admin-only) ─────────── */}
      <GovernmentDataSync me={me} />

      {/* ─────────── ACTIVITY LOG (admin-only) ─────────── */}
      <section className="rounded-2xl p-4 sm:p-5"
        style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
          <div>
            <h3 className="text-xs tracking-[0.25em]" style={{ color: '#0A0A0A', fontWeight: 700 }}>ACTIVITY LOG</h3>
            <p className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              Every meaningful action across the platform.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={auditFilter}
              onChange={e => setAuditFilter(e.target.value)}
              className="text-xs px-3 py-1.5 rounded-full border"
              style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A', background: '#FFFFFF' }}>
              <option value="all">All users</option>
              {[...new Set(auditLog.map(l => l.actor_psn).filter(Boolean))].map(psn => (
                <option key={psn} value={psn}>{psn}</option>
              ))}
            </select>
            <button onClick={loadAudit}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs border"
              style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A', background: '#FFFFFF' }}>
              <RefreshCw className="w-3 h-3" /> Refresh
            </button>
          </div>
        </div>

        {/* Category chips */}
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
                    borderColor: auditCategory === c ? '#0A0A0A' : 'var(--border-soft)',
                    background:  auditCategory === c ? '#0A0A0A' : '#FFFFFF',
                    color:       auditCategory === c ? '#FFFFFF' : '#0A0A0A',
                  }}>
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
          );
        })()}

        {auditLoading ? (
          <div className="text-sm flex items-center gap-2" style={{ color: '#0A0A0A' }}>
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading activity…
          </div>
        ) : auditLog.length === 0 ? (
          <div className="rounded-xl p-5 text-center text-sm"
            style={{ background: '#FFFFFF', border: '1px dashed var(--border-soft)', color: '#0A0A0A' }}>
            No activity recorded yet. Run <code className="font-mono px-1 py-0.5 rounded" style={{ background: '#F4F4EE' }}>migration_audit_log.sql</code> in Supabase to enable logging.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {auditLog
              .filter(l => auditFilter === 'all' || l.actor_psn === auditFilter)
              .filter(l => auditCategory === 'all' || actionCategory(l.action) === auditCategory)
              .slice(0, 60)
              .map(log => (
                <li key={log.id}
                  className="flex items-start justify-between gap-3 px-3 py-2 rounded-lg text-xs flex-wrap"
                  style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                      <span className="font-mono text-[10px]" style={{ color: '#0A0A0A', opacity: 0.75 }}>{log.actor_psn || '—'}</span>
                      <span className="truncate" style={{ color: '#0A0A0A', fontWeight: 500 }}>{log.actor_name || 'unknown'}</span>
                      <span className="text-[10px] tracking-wider px-1.5 py-0.5 rounded-full font-bold"
                        style={{ background: '#ECFDF5', color: '#047857', border: '1px solid #A7F3D0' }}>
                        {formatAction(log.action)}
                      </span>
                    </div>
                    {log.target_label && (
                      <div className="truncate" style={{ color: '#0A0A0A', opacity: 0.85 }}>{log.target_label}</div>
                    )}
                  </div>
                  <div className="text-[10px] whitespace-nowrap" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                    {new Date(log.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
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
      <div className="text-[10px] tracking-[0.2em] mb-1" style={{ color: '#0A0A0A', fontWeight: 700 }}>{label}</div>
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg"
        style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
        <span className={`flex-1 ${mono ? 'font-mono tracking-widest' : ''}`}
          style={{ fontSize: mono ? '1.1rem' : '0.95rem', color: '#0A0A0A', fontWeight: 600 }}>
          {value}
        </span>
        <button onClick={async () => { await onCopy(value); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
          style={{ color: copied ? '#047857' : '#0A0A0A', opacity: copied ? 1 : 0.7 }}>
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
    <section className="rounded-2xl p-4 sm:p-5"
      style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-3">
        <div>
          <h3 className="text-xs tracking-[0.25em]" style={{ color: '#0A0A0A', fontWeight: 700 }}>
            SIGN-IN ACTIVITY · {sessions.length}
          </h3>
          <p className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            Latest 30 sessions across all staff.
          </p>
        </div>
        <button onClick={onRefresh}
          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs border"
          style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A', background: '#FFFFFF' }}>
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-sm flex items-center gap-2" style={{ color: '#0A0A0A' }}>
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading sign-in activity…
        </div>
      ) : sessions.length === 0 ? (
        <div className="rounded-xl p-5 text-center text-sm"
          style={{ background: '#FFFFFF', border: '1px dashed var(--border-soft)', color: '#0A0A0A' }}>
          No sign-in activity recorded yet. New sign-ins from now on will appear here.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {sessions.slice(0, 8).map((s, i) => {
            const isActive = !s.signedOutAt;
            const dur = duration(s.signedInAt, s.signedOutAt);
            return (
              <li key={i} className="rounded-lg px-3 py-2 flex items-center justify-between gap-3 flex-wrap"
                style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)' }}>
                <div className="flex items-center gap-3 min-w-0">
                  <span className="text-[11px] font-mono" style={{ color: '#0A0A0A', opacity: 0.75 }}>
                    {s.actor_psn || '—'}
                  </span>
                  <span className="text-sm truncate" style={{ color: '#0A0A0A', fontWeight: 500 }}>
                    {s.actor_name || '—'}
                  </span>
                  {isActive && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full font-bold tracking-wider"
                      style={{ background: '#ECFDF5', color: '#047857', border: '1px solid #A7F3D0' }}>
                      ACTIVE
                    </span>
                  )}
                </div>
                <div className="text-[11px] flex items-center gap-2" style={{ color: '#0A0A0A' }}>
                  <span>{fmt(s.signedInAt)}</span>
                  <span style={{ opacity: 0.4 }}>→</span>
                  <span>{isActive ? 'now' : fmt(s.signedOutAt)}</span>
                  {dur && <span style={{ opacity: 0.7 }}>· {dur}</span>}
                </div>
              </li>
            );
          })}
          {sessions.length > 8 && (
            <li className="text-[11px] text-center pt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              + {sessions.length - 8} more sessions
            </li>
          )}
        </ul>
      )}
    </section>
  );
}
