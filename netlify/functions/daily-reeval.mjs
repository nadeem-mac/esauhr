// =============================================================================
// daily-reeval.mjs — Netlify Scheduled Function
//
// Runs at 21:01 UTC daily, which is 00:01 KSA the next day. Triggers
// the cron_reevaluate_yesterday() PostgreSQL function (see
// supabase/migration_cron_reevaluate.sql) and records the result in
// the cron_runs audit table.
//
// Why this exists: the portal's reevaluation pipeline runs only when
// Bashaier opens the page (24h stale-check) or uploads a file. If
// shifts get entered AFTER yesterday's attendance was recorded but
// BEFORE Bashaier's next visit, the rows stay misclassified until
// she's back. This cron closes the gap by re-running the schedule
// lookup automatically every midnight.
//
// Limited scope: handles only the "shift entered retroactively" case.
// Complex cases (overnight bridging, leave overlap, multi-shift days,
// permission coverage) still require the full JS reeval which fires
// on Bashaier's next page load. The cron narrows the gap from "until
// Bashaier returns" to "at most 24 hours late".
//
// Env vars expected (set in Netlify dashboard):
//   VITE_SUPABASE_URL       Supabase project URL
//   VITE_SUPABASE_ANON_KEY  Anon key (same as the frontend uses — the
//                           SQL function is granted EXECUTE to anon)
// =============================================================================

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

const HEADERS = SUPABASE_KEY ? {
  'apikey':         SUPABASE_KEY,
  'Authorization':  'Bearer ' + SUPABASE_KEY,
  'Content-Type':   'application/json',
  'Prefer':         'return=representation',
} : null;

/**
 * Insert a new cron_runs row for this invocation. Returns the row's
 * id so we can patch it on completion. Failures here are non-fatal —
 * we log and proceed with the actual reevaluation; the audit row
 * just won't exist for this run.
 */
async function logRunStart() {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/cron_runs', {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        job_name:   'daily-reeval',
        started_at: new Date().toISOString(),
        status:     'running',
      }),
    });
    if (!res.ok) {
      console.warn('Could not log cron_runs start:', res.status, await res.text());
      return null;
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows[0]?.id ? rows[0].id : null;
  } catch (e) {
    console.warn('Could not log cron_runs start:', e);
    return null;
  }
}

/**
 * Patch a cron_runs row with the final outcome. Best-effort.
 */
async function logRunFinish(runId, patch) {
  if (!runId) return;
  try {
    await fetch(SUPABASE_URL + '/rest/v1/cron_runs?id=eq.' + runId, {
      method: 'PATCH',
      headers: HEADERS,
      body: JSON.stringify({
        finished_at: new Date().toISOString(),
        ...patch,
      }),
    });
  } catch (e) {
    console.warn('Could not log cron_runs finish:', e);
  }
}

export default async (req, context) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(
      JSON.stringify({ error: 'Missing Supabase env vars' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const runId = await logRunStart();

  try {
    const res = await fetch(
      SUPABASE_URL + '/rest/v1/rpc/cron_reevaluate_yesterday',
      {
        method: 'POST',
        headers: HEADERS,
        body: '{}',
      }
    );

    if (!res.ok) {
      const txt = await res.text();
      throw new Error('SQL function failed: ' + res.status + ' ' + txt);
    }

    const result = await res.json();
    const rowsProcessed = result?.rows_processed || 0;
    const rowsUpdated   = result?.rows_updated   || 0;

    await logRunFinish(runId, {
      status:         rowsUpdated > 0 ? 'success' : 'no_op',
      rows_processed: rowsProcessed,
      rows_updated:   rowsUpdated,
      details:        result,
    });

    return new Response(
      JSON.stringify({ ok: true, ...result }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const msg = String(err?.message || err);
    console.error('daily-reeval failed:', msg);
    await logRunFinish(runId, {
      status: 'error',
      error:  msg,
    });
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

// Cron schedule — UTC. 21:01 UTC = 00:01 KSA (UTC+3) the next day.
// Picks up shifts entered late on the previous day and reclassifies
// rows before Bashaier opens the portal in the morning.
export const config = {
  schedule: '1 21 * * *',
};
