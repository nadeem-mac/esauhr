import React, { useState } from 'react';
import { supabase } from '../supabaseClient.js';
import { psnToEmail } from '../lib/psnAuth.js';
import { ArrowLeft, ArrowRight, User, Lock, AlertCircle, CheckCircle2 } from 'lucide-react';
import EvergreenLogo from './EvergreenLogo.jsx';

// PSN-based auth.
//   'signin'  : PSN + PIN  (returning users)
//   'request' : PSN only   (first-time staff request access; admin issues PIN)

export default function Auth({ onBack }) {
  const [mode, setMode] = useState('signin');
  const [psn, setPsn] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setMessage(''); setBusy(true);

    try {
      const cleanPsn = psn.trim().toUpperCase();
      if (!cleanPsn) throw new Error('Enter your PSN');

      if (mode === 'request') {
        const { data: emp, error: lookupErr } = await supabase
          .from('employees')
          .select('id, name')
          .eq('id', cleanPsn)
          .maybeSingle();

        if (lookupErr) throw lookupErr;
        if (!emp) throw new Error(`PSN "${cleanPsn}" is not in the directory. Please contact HR.`);

        const { error: insErr } = await supabase
          .from('registration_requests')
          .insert({ psn: cleanPsn, status: 'pending' });
        if (insErr) throw insErr;

        setMessage(`Request received for ${emp.name}. The admin will issue your PIN shortly.`);
        setPsn('');
        return;
      }

      if (!pin) throw new Error('Enter your PIN');
      const email = psnToEmail(cleanPsn);
      const { error: signErr } = await supabase.auth.signInWithPassword({ email, password: pin });
      if (signErr) throw new Error('PSN or PIN is incorrect.');
    } catch (err) {
      setError(err.message || 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col relative" style={{ background: 'var(--evergreen-900)', color: '#F4EEDF' }}>
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-40" preserveAspectRatio="none" viewBox="0 0 1440 900">
        <path d="M -100,500 C 400,350 800,650 1540,450" fill="none" stroke="#8FB39A" strokeOpacity="0.3" strokeWidth="1"/>
        <path d="M -100,600 C 400,450 800,750 1540,550" fill="none" stroke="#8FB39A" strokeOpacity="0.2" strokeWidth="1"/>
      </svg>

      <div className="relative z-10 max-w-md w-full mx-auto flex-1 flex flex-col justify-center px-6 py-12">
        <div className="absolute top-6 left-6">
          <EvergreenLogo variant="full" size="sm" />
        </div>

        <button onClick={onBack}
          className="inline-flex items-center gap-2 text-sm opacity-60 hover:opacity-100 mb-10">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>

        <div className="mb-8">
          <div className="flex items-center gap-2 mb-4 text-xs tracking-[0.25em] opacity-60">
            <div className="w-8 h-px" style={{ background: '#8FB39A' }} />
            {mode === 'request' ? 'REQUEST ACCESS' : 'WELCOME BACK'}
          </div>
          <h1 className="serif text-5xl leading-[1.02]" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
            {mode === 'request' ? (
              <>Ask HR for<br /><span className="italic" style={{ color: 'var(--evergreen-300)' }}>your PIN.</span></>
            ) : (
              <>Sign in to<br /><span className="italic" style={{ color: 'var(--evergreen-300)' }}>your desk.</span></>
            )}
          </h1>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Field label="PSN ID" icon={User}>
            <input type="text" required value={psn}
              onChange={e => setPsn(e.target.value)}
              placeholder="e.g. H94152"
              autoCapitalize="characters"
              autoComplete="username"
              className="w-full bg-transparent border-0 outline-none py-2.5 text-base tracking-wider"
              style={{ color: '#F4EEDF', textTransform: 'uppercase' }}/>
          </Field>

          {mode === 'signin' && (
            <Field label="PIN" icon={Lock}>
              <input type="password" required value={pin}
                onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Numeric PIN from HR"
                inputMode="numeric"
                autoComplete="current-password"
                className="w-full bg-transparent border-0 outline-none py-2.5 text-base tracking-widest"
                style={{ color: '#F4EEDF' }}/>
            </Field>
          )}

          {error && (
            <div className="flex items-start gap-2 text-sm p-3 rounded-lg" style={{ background: 'rgba(184,74,62,0.2)', color: '#F4D5CD' }}>
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {error}
            </div>
          )}
          {message && (
            <div className="flex items-start gap-2 text-sm p-3 rounded-lg" style={{ background: 'rgba(143,179,154,0.2)', color: '#BFD5C4' }}>
              <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
              {message}
            </div>
          )}

          <button type="submit" disabled={busy}
            className="w-full flex items-center justify-center gap-2 px-6 py-3.5 rounded-full text-base transition-all disabled:opacity-60"
            style={{ background: '#F4EEDF', color: 'var(--evergreen-900)', fontWeight: 500 }}>
            {busy ? 'Working…' : (mode === 'request' ? 'Send request to HR' : 'Sign in')}
            {!busy && <ArrowRight className="w-4 h-4" />}
          </button>
        </form>

        <div className="mt-8 text-center text-sm opacity-70">
          {mode === 'request' ? (
            <>Already have a PIN?{' '}
              <button onClick={() => { setMode('signin'); setError(''); setMessage(''); }} className="underline hover:no-underline">Sign in</button>
            </>
          ) : (
            <>No PIN yet?{' '}
              <button onClick={() => { setMode('request'); setError(''); setMessage(''); }} className="underline hover:no-underline">Request access</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, icon: Icon, children }) {
  return (
    <div>
      <label className="text-[10px] tracking-[0.2em] opacity-60 block mb-2">{label}</label>
      <div className="flex items-center gap-3 px-4 py-0.5 rounded-lg border" style={{ borderColor: 'rgba(244,238,223,0.2)', background: 'rgba(244,238,223,0.04)' }}>
        <Icon className="w-4 h-4 opacity-60 flex-shrink-0" />
        {children}
      </div>
    </div>
  );
}
