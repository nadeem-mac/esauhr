// PSN-based auth helpers
// We store users in Supabase auth.users with a synthetic email:
//   {PSN}@leavedesk.invalid
// .invalid is an RFC-reserved TLD so this can never collide with real emails.

import { createClient } from '@supabase/supabase-js';

export const PSN_EMAIL_DOMAIN = 'leavedesk.invalid';

export function psnToEmail(psn) {
  return `${String(psn).trim().toUpperCase()}@${PSN_EMAIL_DOMAIN}`;
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
