import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Informative flag the app can read — so it can show a helpful screen
// instead of just crashing when env vars are missing.
export const supabaseConfigured = Boolean(url && key);

export const supabase = supabaseConfigured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Skip the Web Lock — Leave Desk is a single-tab app and the lock just
        // adds 5+ second delays on parallel queries when it gets orphaned.
        lock: (name, acquireTimeout, fn) => fn(),
      },
    })
  : null;

export const SUPABASE_URL = url || '';

// Quick connectivity probe used by the Diagnostics screen
export async function probeSupabase() {
  if (!supabase) {
    return { ok: false, reason: 'missing_env', message: 'VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY is not set.' };
  }
  try {
    const t0 = performance.now();
    const { error } = await supabase.from('leave_types').select('id', { count: 'exact', head: true });
    const elapsed = Math.round(performance.now() - t0);
    if (error) return { ok: false, reason: 'query_error', message: error.message, elapsed };
    return { ok: true, message: 'Reachable', elapsed };
  } catch (e) {
    return { ok: false, reason: 'network', message: e.message || String(e) };
  }
}
