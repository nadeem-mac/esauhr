import React, { useEffect, useState, useCallback, useRef } from 'react';
import { supabase, supabaseConfigured } from './supabaseClient.js';
import { emailToPsn } from './lib/psnAuth.js';
import { logAction } from './lib/audit.js';
import Auth from './components/Auth.jsx';
import AppShell from './components/AppShell.jsx';
import ConfigMissing from './components/ConfigMissing.jsx';
import EvergreenLogo from './components/EvergreenLogo.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [me, setMe]           = useState(null);
  const [ready, setReady]     = useState(false);
  const lastSignInUser = useRef(null);

  const resolveMe = useCallback(async (s) => {
    if (!s?.user) { setMe(null); return null; }
    try {
      let { data: byAuth } = await supabase
        .from('employees').select('*')
        .eq('auth_user_id', s.user.id).maybeSingle();
      if (byAuth) { setMe(byAuth); return byAuth; }

      const psn = emailToPsn(s.user.email);
      if (!psn) { setMe(null); return null; }

      const { data: byPsn } = await supabase
        .from('employees').select('*')
        .eq('id', psn).maybeSingle();
      if (!byPsn) { setMe(null); return null; }

      await supabase.from('employees')
        .update({ auth_user_id: s.user.id }).eq('id', psn).is('auth_user_id', null);

      const linked = { ...byPsn, auth_user_id: s.user.id };
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
