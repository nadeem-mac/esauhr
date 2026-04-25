import React, { useEffect, useState, useCallback, useRef } from 'react';
import { supabase, supabaseConfigured } from './supabaseClient.js';
import { emailToPsn } from './lib/psnAuth.js';
import { logAction } from './lib/audit.js';
import Landing from './components/Landing.jsx';
import Auth from './components/Auth.jsx';
import AppShell from './components/AppShell.jsx';
import ConfigMissing from './components/ConfigMissing.jsx';
import EvergreenLogo from './components/EvergreenLogo.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [me, setMe]           = useState(null);
  const [view, setView]       = useState('landing');
  const [ready, setReady]     = useState(false);
  const lastSignInUser = useRef(null);  // de-dupe SIGNED_IN events (mount + actual login)

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

    // Hard guard — never let the splash hang for more than 3 seconds, even if the
    // Supabase auth lock can't resolve. Session/me will fill in once they resolve.
    const splashGuard = setTimeout(() => setReady(true), 3000);

    supabase.auth.getSession().then(({ data }) => {
      clearTimeout(splashGuard);
      setSession(data.session);
      if (data.session) setView('app');
      setReady(true);
      resolveMe(data.session);
    }).catch(() => { clearTimeout(splashGuard); setReady(true); });

    const { data: sub } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s);
      const meRow = await resolveMe(s);
      if (s) {
        setView('app');
        if (event === 'SIGNED_IN' && meRow && lastSignInUser.current !== s.user.id) {
          lastSignInUser.current = s.user.id;
          logAction(meRow, 'sign_in', { details: { email: s.user.email } });
        }
      } else {
        if (event === 'SIGNED_OUT' && me) {
          logAction(me, 'sign_out');
        }
        lastSignInUser.current = null;
        setView('landing');
      }
    });
    return () => { clearTimeout(splashGuard); sub.subscription.unsubscribe(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveMe]);

  if (!supabaseConfigured) return <ConfigMissing />;
  if (!ready) return <SplashLoader />;

  if (view === 'app' && session) {
    return <AppShell session={session} me={me} onRefreshMe={() => resolveMe(session)} />;
  }
  if (view === 'auth') return <Auth onBack={() => setView('landing')} />;
  return <Landing onEnter={() => setView('auth')} />;
}

function SplashLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center"
         style={{ background: 'var(--evergreen-900)', color: '#F4EEDF' }}>
      <div className="text-center">
        <EvergreenLogo variant="stack" size="lg" />
        <div className="text-[10px] tracking-[0.3em] opacity-50 mt-6">LOADING</div>
      </div>
    </div>
  );
}
