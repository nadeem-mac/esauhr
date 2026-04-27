import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Informative flag the app can read â so it can show a helpful screen
// instead of just crashing when env vars are missing.
export const supabaseConfigured = Boolean(url && key);

export const supabase = supabaseConfigured
  ? createClient(url, key, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        // Skip the Web Lock â Leave Desk is a single-tab app and the lock just
        // adds 5+ second delays on parallel queries when it gets orphaned.
        lock: (name, acquireTimeout, fn) => fn(),
      },
    })
  : null;

export const SUPABASE_URL = url || '';
export const SUPABASE_ANON_KEY = key || '';

// Helper that bypasses supabase-js for critical writes that have been observed to
// wedge the JS client. Performs a direct PATCH to the PostgREST endpoint with the
// current session's access token. Falls back to anon key for unauthenticated ops.
export async function directPatch(table, idColumn, idValue, patch, options = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const timeoutMs = options.timeoutMs || 12000;
  // Try to grab the active session token; fall back to anon if missing
  let accessToken = key;
  try {
    const { data: { session } } = await Promise.race([
      supabase.auth.getSession(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('getSession timed out')), 3000)),
    ]);
    if (session?.access_token) accessToken = session.access_token;
  } catch { /* fall back to anon key */ }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/rest/v1/${table}?${idColumn}=eq.${encodeURIComponent(idValue)}`, {
      method: 'PATCH',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(patch),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${errText || r.statusText}`);
    }
    return await r.json();
  } finally { clearTimeout(timer); }
}

// Read counterpart of directPatch — performs a direct GET to PostgREST with the
// active session token, falling back to anon key. Filters/ordering passed via
// the queryString param (PostgREST syntax). Returns parsed JSON array.
export async function directGet(table, queryString, options = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const timeoutMs = options.timeoutMs || 10000;
  let accessToken = key;
  try {
    const { data: { session } } = await Promise.race([
      supabase.auth.getSession(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('getSession timed out')), 3000)),
    ]);
    if (session?.access_token) accessToken = session.access_token;
  } catch { /* fall back to anon key */ }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const url2 = `${url}/rest/v1/${table}${queryString ? '?' + queryString : ''}`;
    const r = await fetch(url2, {
      method: 'GET',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${errText || r.statusText}`);
    }
    return await r.json();
  } finally { clearTimeout(timer); }
}

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
