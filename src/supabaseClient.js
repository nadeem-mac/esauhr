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

// ── Cached access token ────────────────────────────────────────────────────
// Every direct* helper used to call supabase.auth.getSession() and race it
// against a 3-second timeout BEFORE every single fetch. With ~6 queries on
// load (and more on every realtime tick) that's 6x getSession() overhead per
// burst. We instead grab the token once at startup and refresh it via the
// onAuthStateChange listener, so each fetch is a single network call.
let _cachedToken = key;
let _tokenInitPromise = null;

async function refreshTokenOnce() {
  if (!supabase) return key;
  try {
    const { data: { session } } = await Promise.race([
      supabase.auth.getSession(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('init getSession timeout')), 1500)),
    ]);
    _cachedToken = session?.access_token || key;
  } catch {
    _cachedToken = key;
  }
  return _cachedToken;
}

if (supabase) {
  // Kick off the initial fetch but don't block the module load on it.
  _tokenInitPromise = refreshTokenOnce();
  supabase.auth.onAuthStateChange((_event, session) => {
    _cachedToken = session?.access_token || key;
  });
}

// Helpers wait at most a short time for the initial token fetch, then proceed
// with whatever's cached (anon key if init hasn't finished).
async function getActiveToken() {
  if (_tokenInitPromise) {
    try {
      await Promise.race([
        _tokenInitPromise,
        new Promise(res => setTimeout(res, 300)),
      ]);
    } catch { /* fall through to cached */ }
  }
  return _cachedToken;
}

// Helper that bypasses supabase-js for critical writes that have been observed to
// wedge the JS client. Performs a direct PATCH to the PostgREST endpoint with the
// current session's access token. Falls back to anon key for unauthenticated ops.
export async function directPatch(table, idColumn, idValue, patch, options = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const timeoutMs = options.timeoutMs || 12000;
  const accessToken = await getActiveToken();

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
  const accessToken = await getActiveToken();

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
// POST counterpart of directPatch — performs a direct INSERT to PostgREST.
// Set options.upsert = true to use ON CONFLICT DO UPDATE semantics
// (the table's unique constraint will silently dedupe).
export async function directPost(table, row, options = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const timeoutMs = options.timeoutMs || 12000;
  const accessToken = await getActiveToken();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Prefer': options.upsert
          ? 'return=representation,resolution=merge-duplicates'
          : 'return=representation',
      },
      body: JSON.stringify(row),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${errText || r.statusText}`);
    }
    return await r.json();
  } finally { clearTimeout(timer); }
}

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

// DELETE counterpart of directPatch — performs a direct DELETE to PostgREST.
// Filter is supplied as a PostgREST query string fragment (e.g.
// "employee_id=eq.H94830&shift_date=in.(2026-04-29,2026-04-30)").
export async function directDelete(table, queryString, options = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const timeoutMs = options.timeoutMs || 12000;
  const accessToken = await getActiveToken();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/rest/v1/${table}?${queryString}`, {
      method: 'DELETE',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${accessToken}`,
      },
      signal: ctrl.signal,
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status}: ${errText || r.statusText}`);
    }
    return true;
  } finally { clearTimeout(timer); }
}

// Bulk-PATCH variant of directPatch. The filter is supplied as a PostgREST
// query string fragment (e.g. "id=in.(uuid1,uuid2,uuid3)") so callers can
// update an arbitrary set of rows in one round trip without going through
// the wedge-prone supabase-js .update().in() path.
export async function directPatchQuery(table, queryString, patch, options = {}) {
  if (!supabase) throw new Error('Supabase not configured');
  const timeoutMs = options.timeoutMs || 12000;
  const accessToken = await getActiveToken();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${url}/rest/v1/${table}?${queryString}`, {
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
