import React, { useEffect, useState, useCallback } from 'react';
import { supabase, supabaseConfigured } from './supabaseClient.js';
import { emailToPsn } from './lib/psnAuth.js';
import Landing from './components/Landing.jsx';
import Auth from './components/Auth.jsx';
import AppShell from './components/AppShell.jsx';
import ConfigMissing from './components/ConfigMissing.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [me, setMe]           = useState(null);
  const [view, setView]       = useState('landing');
  const [ready, setReady]     = useState(false);

  const resolveMe = useCallback(async (s) => {
    if (!s?.user) { setMe(null); return; }
    try {
      let { data: byAuth } = await supabase
        .from('employees').select('*')
        .eq('auth_user_id', s.user.id).maybeSingle();
      if (byAuth) { setMe(byAuth); return; }

      const psn = emailToPsn(s.user.email);
      if (!psn) { setMe(null); return; }

      const { data: byPsn } = await supabase
        .from('employees').select('*')
        .eq('id', psn).maybeSingle();
      if (!byPsn) { setMe(null); return; }

      await supabase.from('employees')
        .update({ auth_user_id: s.user.id }).eq('id', psn).is('auth_user_id', null);

      setMe({ ...byPsn, auth_user_id: s.user.id });
    } catch (err) {
      console.error('Could not resolve employee:', err);
      setMe(null);
    }
  }, []);

  useEffect(() => {
    if (!supabaseConfigured) { setReady(true); return; }
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      await resolveMe(data.session);
      if (data.session) setView('app');
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, s) => {
      setSession(s);
      await resolveMe(s);
      if (s) setView('app');
      else setView('landing');
    });
    return () => sub.subscription.unsubscribe();
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
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="w-10 h-10 rounded-xl mx-auto mb-3 flex items-center justify-center"
             style={{ background: 'var(--evergreen-800)' }}>
          <svg viewBox="0 0 32 32" className="w-6 h-6">
            <path d="M16 6 C 10 10, 10 18, 16 26 C 22 18, 22 10, 16 6 Z"
                  fill="none" stroke="#8FB39A" strokeWidth="1.5"/>
            <line x1="16" y1="6" x2="16" y2="26" stroke="#8FB39A" strokeWidth="1.5"/>
          </svg>
        </div>
        <div className="text-xs tracking-widest opacity-50">LOADING</div>
      </div>
    </div>
  );
}
