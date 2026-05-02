import React, { useEffect, useState, useCallback, useRef } from 'react';
import { supabase, supabaseConfigured, directGet, directPatchQuery } from './supabaseClient.js';
import { emailToPsn } from './lib/psnAuth.js';
import { logAction } from './lib/audit.js';
import Auth from './components/Auth.jsx';
import AppShell from './components/AppShell.jsx';
import ConfigMissing from './components/ConfigMissing.jsx';
import EvergreenLogo from './components/EvergreenLogo.jsx';
import VerifyPage from './components/VerifyPage.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [me, setMe]           = useState(null);
  const [ready, setReady]     = useState(false);
  const lastSignInUser = useRef(null);

  const resolveMe = useCallback(async (s) => {
    if (!s?.user) { setMe(null); return null; }
    try {
      // Use directGet (raw fetch + timeout) instead of supabase.from().select().
      // The lazy supabase-js builder wedges on some sessions — when it does,
      // resolveMe never resolves, which means anything awaiting onRefreshMe()
      // (i.e. the header refresh button) hangs forever despite the actual
      // data fetches having succeeded.
      const byAuth = await directGet(
        'employees',
        `select=*&auth_user_id=eq.${encodeURIComponent(s.user.id)}&limit=1`,
        { timeoutMs: 8000 }
      );
      if (Array.isArray(byAuth) && byAuth[0]) {
        setMe(byAuth[0]);
        return byAuth[0];
      }

      const psn = emailToPsn(s.user.email);
      if (!psn) { setMe(null); return null; }

      const byPsn = await directGet(
        'employees',
        `select=*&id=eq.${encodeURIComponent(psn)}&limit=1`,
        { timeoutMs: 8000 }
      );
      if (!Array.isArray(byPsn) || !byPsn[0]) { setMe(null); return null; }

      // Backfill auth_user_id on first match. Best-effort — a failure here
      // doesn't block sign-in; the user is just unlinked until next try.
      try {
        await directPatchQuery(
          'employees',
          `id=eq.${encodeURIComponent(psn)}&auth_user_id=is.null`,
          { auth_user_id: s.user.id },
          { timeoutMs: 6000 }
        );
      } catch (err) {
        console.warn('auth_user_id backfill failed:', err?.message || err);
      }

      const linked = { ...byPsn[0], auth_user_id: s.user.id };
      setMe(linked);
      return linked;
    } catch (err) {
      console.error('Could not resolve employee:', err);
      setMe(null);
      return null;
    }
  }, []);

  useEffect(() => {
    if (!supabaseConfigured) { setReady(true); return; }

    // Single source of truth: onAuthStateChange fires INITIAL_SESSION on mount with the
    // existing session (if any), then SIGNED_IN/SIGNED_OUT events on changes.
    // We deliberately do NOT also call getSession() — concurrent calls contend for the
    // gotrue-js Web Lock and cause the "lock was released because another request stole it"
    // error and a wedged sign-in UI.
    const splashGuard = setTimeout(() => setReady(true), 3000);

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, s) => {
      clearTimeout(splashGuard);
      setSession(s);
      setReady(true);

      const meRow = await resolveMe(s);

      if (s) {
        if (event === 'SIGNED_IN' && meRow && lastSignInUser.current !== s.user.id) {
          lastSignInUser.current = s.user.id;
          logAction(meRow, 'sign_in', { details: { email: s.user.email } });
        }
      } else {
        if (event === 'SIGNED_OUT' && me) logAction(me, 'sign_out');
        lastSignInUser.current = null;
      }
    });
    return () => { clearTimeout(splashGuard); sub.subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveMe]);

  if (!supabaseConfigured) return <ConfigMissing />;

  // Public verify routes — anyone with the printed letter (and the QR
  // code on it) lands here. No auth needed; the page does a sanitized
  // RPC lookup on the request id and shows the current state. Bypasses
  // session/loading flow entirely.
  //
  //   /verify/<integer>          permission_requests   (integer id)
  //   /verify-leave/<uuid>       leave_requests        (uuid id, leave view)
  //   /verify-rejoin/<uuid>      leave_requests        (uuid id, rejoining view)
  //
  // All three render the same VerifyPage component, which branches on
  // `mode` for the RPC name, ref label, and field set. The /verify-leave
  // and /verify-rejoin routes hit the SAME RPC (verify_leave) but render
  // different cards — leave focuses on the original absence; rejoining
  // focuses on the return-from-leave + payroll resumption.
  const verifyMatch = typeof window !== 'undefined'
    ? window.location.pathname.match(/^\/verify\/(\d+)\/?$/)
    : null;
  if (verifyMatch) {
    return <VerifyPage requestId={Number(verifyMatch[1])} mode="permission" />;
  }
  const verifyLeaveMatch = typeof window !== 'undefined'
    ? window.location.pathname.match(/^\/verify-leave\/([0-9a-f-]{8,36})\/?$/i)
    : null;
  if (verifyLeaveMatch) {
    return <VerifyPage requestId={verifyLeaveMatch[1]} mode="leave" />;
  }
  const verifyRejoinMatch = typeof window !== 'undefined'
    ? window.location.pathname.match(/^\/verify-rejoin\/([0-9a-f-]{8,36})\/?$/i)
    : null;
  if (verifyRejoinMatch) {
    return <VerifyPage requestId={verifyRejoinMatch[1]} mode="rejoin" />;
  }

  if (!ready) return <SplashLoader />;

  // Signed in → app shell. Signed out → straight to sign-in (no marketing landing).
  if (session) {
    return <AppShell session={session} me={me} onRefreshMe={() => resolveMe(session)} />;
  }
  return <Auth />;
}

function SplashLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center"
         style={{ background: 'var(--evergreen-900)', color: '#F4EEDF' }}>
      <EvergreenLogo variant="stack" size="lg" />
    </div>
  );
}
