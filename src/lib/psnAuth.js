// PSN-based auth helpers
// Each staff has a Supabase auth user. The auth email mirrors the staff's
// real evergreen-shipping address when we have one; otherwise we fall back
// to a synthetic {PSN}@leavedesk.invalid placeholder so they can still sign
// in. The login flow asks the database for the right email by PSN.

import { createClient } from '@supabase/supabase-js';
import { supabase } from '../supabaseClient.js';

export const PSN_EMAIL_DOMAIN = 'leavedesk.invalid';

// Synthetic fallback only — used when the DB lookup fails (offline,
// transient error, or staff that genuinely have no auth user yet).
export function psnToEmail(psn) {
  return `${String(psn).trim().toLowerCase()}@${PSN_EMAIL_DOMAIN}`;
}

// Look up the real sign-in email for this PSN. Returns null if not found.
// Backed by the public psn_signin_email RPC (security definer, no auth needed).
export async function resolvePsnSigninEmail(psn) {
  const cleaned = String(psn).trim().toUpperCase();
  if (!cleaned) return null;
  try {
    const { data, error } = await supabase.rpc('psn_signin_email', { target_psn: cleaned });
    if (error) {
      console.warn('psn_signin_email lookup failed:', error.message);
      return null;
    }
    return data || null;
  } catch (e) {
    console.warn('psn_signin_email threw:', e?.message);
    return null;
  }
}

export function emailToPsn(email) {
  if (!email) return null;
  const m = email.match(/^([^@]+)@leavedesk\.invalid$/i);
  return m ? m[1].toUpperCase() : null;
}

export function generatePin(digits = 6) {
  // 6-digit numeric PIN, always padded.
  const max = Math.pow(10, digits);
  const n = Math.floor(Math.random() * max);
  return String(n).padStart(digits, '0');
}

// Build a parallel Supabase client that does NOT share session storage with
// the main one. Used by admins to create staff auth users without getting
// kicked out of their own session.
let _adminClient = null;
export function getAdminParallelClient() {
  if (_adminClient) return _adminClient;
  const url = import.meta.env.VITE_SUPABASE_URL;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  _adminClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'leave-desk-admin-create',
    },
  });
  return _adminClient;
}
