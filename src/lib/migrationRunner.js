// =============================================================================
// migrationRunner.js
//
// Client-side glue for the schema migration runner. Bundles every
// supabase/migration_*.sql file at build time via Vite's
// import.meta.glob, then provides helpers to:
//   • List bundled migrations
//   • Compare against schema_migrations table to find pending ones
//   • Run a single migration via the run_schema_migration RPC
//
// The actual SQL execution happens server-side inside the RPC, which
// is SECURITY DEFINER and gates on is_admin in the employees table.
// =============================================================================

import { supabase, directGet } from '../supabaseClient.js';

// Vite bundles the contents of every migration file at build time.
// Eager loading means the strings are inlined into the bundle — no
// runtime fetch needed. Path is relative to this file.
const migrationModules = import.meta.glob(
  '../../supabase/migration_*.sql',
  { query: '?raw', import: 'default', eager: true }
);

/**
 * The list of bundled migrations, in alphabetical order by file name.
 * Each entry has:
 *   • name    — bare file name (e.g. 'migration_rejection_reasons.sql')
 *   • sql     — the file contents
 *   • sha256  — hex digest of the SQL text (computed lazily on demand)
 */
export const BUNDLED_MIGRATIONS = Object.entries(migrationModules)
  .map(([path, sql]) => {
    const name = path.split('/').pop();
    return { name, sql, path };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * SHA-256 of a string, returned as 64-char lowercase hex.
 * Used as a sanity check that the SQL we execute matches what the
 * schema_migrations row recorded — if a migration file's contents
 * change after a successful run, the hash will differ and we can
 * surface that to the admin (with a 're-run anyway?' option).
 */
export async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Fetch the full history of migration runs from the schema_migrations
 * table. Returns the list ordered by applied_at desc, most recent first.
 */
export async function fetchMigrationHistory() {
  try {
    return await directGet(
      'schema_migrations',
      'select=*&order=applied_at.desc&limit=500',
      { timeoutMs: 8000 }
    );
  } catch (err) {
    // The schema_migrations table doesn't exist until the
    // migration_schema_runner.sql migration itself has been run.
    // Surface that explicitly so the UI can show a setup prompt
    // instead of a generic error.
    const msg = String(err?.message || err);
    if (/relation .*schema_migrations.* does not exist/i.test(msg)) {
      const e = new Error('Migration runner not yet installed.');
      e.code = 'RUNNER_NOT_INSTALLED';
      throw e;
    }
    throw err;
  }
}

/**
 * Returns a list of bundled migrations augmented with their last
 * known status:
 *   • status        — 'never_run' | 'success' | 'failed' | 'changed'
 *   • lastRun       — timestamp of last attempt, or null
 *   • lastBy        — PSN of last runner, or null
 *   • lastError     — error message of last failed attempt, or null
 *   • currentSha    — sha of bundled SQL
 *   • lastSha       — sha recorded for the last successful run
 *
 * 'changed' means a successful run is on file but the SQL hash now
 * differs from what was recorded — the file in the repo has been
 * edited since it was last applied. The admin can choose to re-run.
 */
export async function listMigrationsWithStatus() {
  const history = await fetchMigrationHistory().catch((err) => {
    if (err.code === 'RUNNER_NOT_INSTALLED') return null;
    throw err;
  });

  // history === null means the runner table doesn't exist yet —
  // every bundled migration is treated as 'never_run'. Caller can
  // detect this via the second return value.
  const installed = history !== null;

  // Group history by name; pick the most recent successful run per
  // migration (failed runs don't establish the 'lastSha' baseline,
  // so a re-run after a fix shows up cleanly).
  const lastSuccessByName = new Map();
  const lastAttemptByName = new Map();
  if (installed) {
    for (const row of history) {
      if (!lastAttemptByName.has(row.name)) {
        lastAttemptByName.set(row.name, row);
      }
      if (row.status === 'success' && !lastSuccessByName.has(row.name)) {
        lastSuccessByName.set(row.name, row);
      }
    }
  }

  // Compute SHAs for everything in parallel.
  const withShas = await Promise.all(
    BUNDLED_MIGRATIONS.map(async (m) => ({ ...m, sha256: await sha256Hex(m.sql) }))
  );

  return {
    installed,
    items: withShas.map((m) => {
      const lastSuccess = lastSuccessByName.get(m.name);
      const lastAttempt = lastAttemptByName.get(m.name);
      let status;
      if (!lastSuccess && !lastAttempt) {
        status = 'never_run';
      } else if (lastAttempt && lastAttempt.status === 'failed' && (!lastSuccess || lastAttempt.applied_at > lastSuccess.applied_at)) {
        status = 'failed';
      } else if (lastSuccess && lastSuccess.sql_sha256 !== m.sha256) {
        status = 'changed';
      } else {
        status = 'success';
      }
      return {
        name:       m.name,
        sql:        m.sql,
        currentSha: m.sha256,
        lastSha:    lastSuccess?.sql_sha256 || null,
        lastRun:    lastAttempt?.applied_at || null,
        lastBy:     lastAttempt?.applied_by || null,
        lastError:  lastAttempt?.error_message || null,
        durationMs: lastAttempt?.duration_ms ?? null,
        status,
      };
    }),
  };
}

/**
 * Run a single migration. Returns the JSON envelope from the RPC:
 *   { ok, status, error_message, duration_ms, applied_at, name }
 *
 * The caller's PSN is passed in explicitly (the RPC uses it to gate
 * on is_admin). On failure, the row is still recorded — the function
 * always logs the attempt.
 */
export async function runMigration({ name, sql, callerPsn }) {
  if (!supabase) throw new Error('Supabase client not configured');
  if (!name) throw new Error('Migration name is required');
  if (!sql) throw new Error('Migration SQL is empty');
  if (!callerPsn) throw new Error('Caller PSN is required');

  const sha = await sha256Hex(sql);

  const { data, error } = await supabase.rpc('run_schema_migration', {
    p_caller_psn: callerPsn,
    p_name:       name,
    p_sql_sha256: sha,
    p_sql:        sql,
  });

  if (error) {
    // Network / RPC-level error (e.g. function doesn't exist yet).
    return {
      ok: false,
      status: 'rpc_error',
      error_message: error.message || String(error),
      name,
    };
  }
  return data;
}

/**
 * Convenience: bytes count of the SQL, for the UI's compact size
 * display.
 */
export function sqlByteSize(sql) {
  return new Blob([sql || '']).size;
}
