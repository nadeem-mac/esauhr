import React, { useEffect, useState } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, RefreshCw, Activity } from 'lucide-react';
import { supabase, supabaseConfigured, SUPABASE_URL, probeSupabase, directGet, directPost } from '../supabaseClient.js';
import { Card } from './Dashboard.jsx';

const TABLES = ['employees', 'leave_types', 'leave_requests', 'leave_balances', 'public_holidays', 'audit_log'];

export default function ConnectivityTest() {
  const [results, setResults] = useState([]);
  const [running, setRunning] = useState(false);

  const run = async () => {
    setRunning(true);
    const r = [];
    // Push a check + immediately push to UI state so the user sees progress
    // as the run goes, instead of an empty page until the very end.
    const push = (entry) => { r.push(entry); setResults([...r]); };

    // Race a promise against a timeout so a wedged supabase-js call never
    // hangs the whole diagnostics. The rest of the app uses directGet/Post
    // for exactly this reason; here we apply the same pattern.
    const withTimeout = (promise, ms, label) => Promise.race([
      Promise.resolve(promise),
      new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' timed out after ' + ms + 'ms')), ms)),
    ]);

    // 1. Env vars
    push({
      name: 'Environment variables',
      detail: 'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY',
      ok: supabaseConfigured,
      message: supabaseConfigured ? 'Configured' : 'Missing — set them in Netlify or .env.local',
    });

    if (!supabaseConfigured) { setRunning(false); return; }

    // 2. Reach Supabase — probeSupabase uses supabase.from() under the hood,
    // which can wedge. Wrap it.
    let probe;
    try {
      probe = await withTimeout(probeSupabase(), 8000, 'Supabase probe');
    } catch (e) {
      probe = { ok: false, message: e.message || 'Probe failed' };
    }
    push({
      name: 'Supabase reachable',
      detail: SUPABASE_URL,
      ok: probe.ok,
      message: probe.ok ? `Connected in ${probe.elapsed} ms` : probe.message,
    });

    if (!probe.ok) { setRunning(false); return; }

    // 3. Auth session — getSession() acquires a Web Lock and can stall on
    // some sessions (the gotrue-js wedge). Wrap it.
    let sess = { session: null };
    try {
      const out = await withTimeout(supabase.auth.getSession(), 5000, 'getSession');
      sess = out?.data || { session: null };
    } catch (e) {
      console.warn('Diagnostics: getSession timed out:', e.message);
    }
    push({
      name: 'Authentication',
      detail: sess.session ? `Signed in as ${sess.session.user.email}` : 'No active session',
      ok: !!sess.session,
      message: sess.session ? 'Active session' : 'No active session — sign in to write data',
    });

    // 4. Each table check — use directGet (raw fetch with timeout).
    // Read 1 row to confirm the table is reachable; we don't need exact counts.
    for (const tbl of TABLES) {
      const t0 = performance.now();
      try {
        await directGet(tbl, 'select=*&limit=1', { timeoutMs: 6000 });
        const elapsed = Math.round(performance.now() - t0);
        push({
          name: `Table · ${tbl}`,
          detail: 'reachable',
          ok: true,
          message: `OK in ${elapsed} ms`,
        });
      } catch (err) {
        push({
          name: `Table · ${tbl}`,
          detail: err.message || 'failed',
          ok: false,
          message: err.message || 'Failed',
        });
      }
    }

    // 5. Write probe via audit_log
    if (sess.session) {
      const t0 = performance.now();
      // Live audit_log schema (verified by direct DB probe):
      //   id, actor_user_id, actor_psn, actor_name, action,
      //   target_type, target_id, target_label, details, created_at, user_agent
      try {
        await directPost('audit_log', {
          action: 'connectivity_test',
          target_type: 'system',
          actor_user_id: sess.session.user.id || null,
          actor_psn:     null,
          actor_name:    sess.session.user.email || null,
          details:       { ts: new Date().toISOString() },
          user_agent:    typeof navigator !== 'undefined' ? navigator.userAgent : null,
        }, { timeoutMs: 6000 });
        const elapsed = Math.round(performance.now() - t0);
        push({
          name: 'Write access',
          detail: 'audit_log insert',
          ok: true,
          message: `Wrote test row in ${elapsed} ms`,
        });
      } catch (err) {
        push({
          name: 'Write access',
          detail: 'audit_log insert',
          ok: false,
          message: err.message || 'Failed',
        });
      }
    }

    // 6. Realtime channel test
    try {
      const channel = supabase.channel('diagnostics-' + Date.now());
      const sub = await new Promise((resolve) => {
        const t = setTimeout(() => resolve('timeout'), 4000);
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') { clearTimeout(t); resolve('ok'); }
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { clearTimeout(t); resolve(status); }
        });
      });
      supabase.removeChannel(channel);
      push({
        name: 'Realtime',
        detail: 'WebSocket subscription',
        ok: sub === 'ok',
        message: sub === 'ok' ? 'Subscribed and unsubscribed cleanly' : `Status: ${sub}`,
      });
    } catch (e) {
      push({
        name: 'Realtime',
        detail: 'WebSocket subscription',
        ok: false,
        message: e.message || 'Failed',
      });
    }

    setRunning(false);
  };

  useEffect(() => { run(); }, []);

  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  const failures = results.filter(r => !r.ok).length;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <div className="text-[10px] tracking-[0.25em] opacity-50 mb-2">DIAGNOSTICS</div>
          <h1 className="serif text-4xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>Connectivity test</h1>
          <p className="text-sm opacity-70 mt-2">Verifies the connection between this app and your Supabase project.</p>
        </div>
        <button onClick={run} disabled={running}
          className="flex items-center gap-2 px-4 py-2 rounded-full text-sm border disabled:opacity-50"
          style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
          <RefreshCw className={`w-4 h-4 ${running ? 'animate-spin' : ''}`}/>
          {running ? 'Running…' : 'Run again'}
        </button>
      </div>

      <Card title={`${passed} of ${total} checks passed`}
            subtitle={failures === 0 ? 'All systems nominal' : `${failures} failure${failures === 1 ? '' : 's'}`}
            accent={failures === 0 ? 'var(--evergreen-500)' : 'var(--clay)'}>
        {results.length === 0 ? (
          <div className="py-8 text-center opacity-60">
            <Activity className="w-6 h-6 mx-auto mb-2"/>
            <div className="text-sm">Running diagnostics…</div>
          </div>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
            {results.map((r, i) => (
              <li key={i} className="flex items-start gap-3 py-3">
                <div className="flex-shrink-0 mt-0.5">
                  {r.ok ? (
                    r.warn
                      ? <AlertTriangle className="w-5 h-5" style={{ color: 'var(--copper)' }}/>
                      : <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--evergreen-500)' }}/>
                  ) : (
                    <XCircle className="w-5 h-5" style={{ color: 'var(--clay)' }}/>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm" style={{ fontWeight: 500 }}>{r.name}</div>
                  <div className="text-xs opacity-70 mt-0.5 mono break-all">{r.detail}</div>
                  <div className="text-xs mt-1" style={{ color: r.ok ? (r.warn ? 'var(--copper)' : 'var(--evergreen-700)') : 'var(--clay)' }}>
                    {r.warn && '⚠ '}{r.message}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="What this checks">
        <ul className="text-sm opacity-80 space-y-1.5 leading-relaxed">
          <li><span className="opacity-60 mono mr-2">1</span>Environment variables are set at build time.</li>
          <li><span className="opacity-60 mono mr-2">2</span>The Supabase URL responds to API requests.</li>
          <li><span className="opacity-60 mono mr-2">3</span>You have an active authenticated session.</li>
          <li><span className="opacity-60 mono mr-2">4</span>Each of the six tables exists and is readable.</li>
          <li><span className="opacity-60 mono mr-2">5</span>You can insert a row (RLS policies allow writes).</li>
          <li><span className="opacity-60 mono mr-2">6</span>Realtime subscriptions are working.</li>
        </ul>
      </Card>
    </div>
  );
}
