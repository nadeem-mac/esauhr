import React, { useState } from 'react';
import { supabase } from '../supabaseClient.js';
import { psnToEmail, resolvePsnSigninEmail } from '../lib/psnAuth.js';
import { ArrowRight, User, Lock, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';

// Splash-animated PSN sign-in.
// Drifting colour orbs, pulsing rings around the Evergreen mark,
// frosted-glass form card on top.
//
// Modes:
//   'signin'  : PSN + PIN
//   'request' : PSN only (request access — admin then issues a PIN)

export default function Auth() {
  const [mode,    setMode]    = useState('signin');
  const [psn,     setPsn]     = useState('');
  const [pin,     setPin]     = useState('');
  const [busy,    setBusy]    = useState(false);
  const [error,   setError]   = useState('');
  const [message, setMessage] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError(''); setMessage(''); setBusy(true);
    try {
      const cleanPsn = psn.trim().toUpperCase();
      if (!cleanPsn) throw new Error('Enter your PSN');

      if (mode === 'request') {
        const { data: emp, error: lookupErr } = await supabase
          .from('employees').select('id, name').eq('id', cleanPsn).maybeSingle();
        if (lookupErr) throw lookupErr;
        if (!emp) throw new Error(`PSN "${cleanPsn}" is not in the directory. Please contact HR.`);
        const { error: insErr } = await supabase
          .from('registration_requests').insert({ psn: cleanPsn, status: 'pending' });
        if (insErr) throw insErr;
        setMessage(`Request received for ${emp.name}. The admin will issue your PIN shortly.`);
        setPsn('');
        return;
      }

      if (!pin) throw new Error('Enter your PIN');
      // Look up the real sign-in email by PSN. Falls back to .invalid for
      // staff who don't have an auth user yet (which will then fail with
      // "PSN or PIN is incorrect" — they need an admin to issue a PIN).
      const resolved = await resolvePsnSigninEmail(cleanPsn);
      const email = resolved || psnToEmail(cleanPsn);
      const { error: authErr } = await supabase.auth.signInWithPassword({ email, password: pin });
      if (authErr) {
        if (authErr.message?.toLowerCase().includes('invalid'))
          throw new Error('PSN or PIN is incorrect. Need a new PIN? Contact your admin.');
        throw authErr;
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="splash-page">
      {/* Animated background orbs */}
      <div className="orb orb-1" aria-hidden="true" />
      <div className="orb orb-2" aria-hidden="true" />
      <div className="orb orb-3" aria-hidden="true" />

      <div className="splash-stage">
        {/* Logo with pulsing rings */}
        <div className="logo-wrap">
          <div className="ring" />
          <div className="ring" style={{ animationDelay: '1s' }} />
          <div className="ring" style={{ animationDelay: '2s' }} />
          <img className="logo-pulse" src="/evergreen-mark.png" alt="Evergreen" />
        </div>

        {/* Wordmark */}
        <div className="wordmark">
          <h1>Evergreen HR</h1>
          <div className="tag">VACATION · ABSENCE · ACCRUAL</div>
        </div>

        {/* Frosted-glass card */}
        <form onSubmit={submit} className="splash-card">
          <div className="eyebrow">
            {mode === 'request' ? 'REQUEST ACCESS' : 'WELCOME BACK'}
          </div>

          <div className="field">
            <label>PSN ID</label>
            <div className="input-wrap">
              <User className="w-4 h-4 input-icon" />
              <input type="text" value={psn} onChange={e => setPsn(e.target.value)}
                placeholder="e.g. H94152" autoComplete="username" autoFocus />
            </div>
          </div>

          {mode === 'signin' && (
            <div className="field">
              <label>PIN</label>
              <div className="input-wrap">
                <Lock className="w-4 h-4 input-icon" />
                <input type="password" value={pin} onChange={e => setPin(e.target.value)}
                  placeholder="Numeric PIN from HR" autoComplete="current-password" />
              </div>
            </div>
          )}

          {error && (
            <div className="alert alert-error">
              <AlertCircle className="w-4 h-4" /> <span>{error}</span>
            </div>
          )}
          {message && (
            <div className="alert alert-ok">
              <CheckCircle2 className="w-4 h-4" /> <span>{message}</span>
            </div>
          )}

          <button type="submit" disabled={busy} className="signin-btn">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {busy ? 'Working…' : (mode === 'request' ? 'Send request to HR' : 'Sign in')}
            {!busy && <ArrowRight className="w-4 h-4" />}
          </button>

          <div className="switch">
            {mode === 'request' ? (
              <>Already have a PIN? <button type="button" onClick={() => { setMode('signin'); setError(''); setMessage(''); }}>Sign in</button></>
            ) : (
              <>No PIN yet? <button type="button" onClick={() => { setMode('request'); setError(''); setMessage(''); }}>Request access</button></>
            )}
          </div>
        </form>
      </div>

      <div className="footer-strip">ESAU · DAMMAM · JEDDAH · RIYADH</div>
    </div>
  );
}
