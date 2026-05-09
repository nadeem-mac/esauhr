// =============================================================================
// daily-cert-chase.mjs — Netlify Scheduled Function
//
// Runs at 21:05 UTC daily, which is 00:05 KSA the next day. Five
// minutes after daily-reeval so any attendance reclassifications
// have settled before we evaluate cert pressure.
//
// WHAT IT DOES
// -------------
// Walks every sick_leave declaration that is missing a Sehhaty
// certificate, classifies how overdue the cert is, and sends a
// reminder email through Resend (https://resend.com). The reminder
// cadence matches the existing Bashaier-driven manual flow:
//
//   gentle_24h   — sent ~1 day after end_date passed
//   firmer_72h   — sent ~3 days after end_date passed
//   final_5d     — sent ~5 days after end_date passed
//
// Each kind is sent at most ONCE per declaration. The cron consults
// sick_reminders (existing table) to confirm a kind hasn't already
// been dispatched. Bashaier-sent reminders count toward the same
// dedup; the cron picks up only what's still outstanding.
//
// CC POLICY (matches sickReminderEmail.js)
// -----------------------------------------
//   gentle_24h → staff only
//   firmer_72h → staff + line manager
//   final_5d   → staff + line manager + HR (Bashaier)
//
// EMAIL DELIVERY
// --------------
// Uses Resend (https://resend.com). Requires RESEND_API_KEY in the
// Netlify env. Sender: noreply@evergreen-shipping.com.sa — needs DNS
// verification on Resend. Until both are configured, the function
// gracefully no-ops the actual send (logs what it would have sent),
// the dedup log isn't written, and Bashaier's manual REMIND button
// remains the operative path.
//
// Env vars expected:
//   VITE_SUPABASE_URL       Supabase project URL
//   VITE_SUPABASE_ANON_KEY  Anon key (RLS-permissive on these tables)
//   RESEND_API_KEY          Resend API key (re_*) — optional during setup
//   CERT_CHASE_FROM         From: header (default: noreply@evergreen-shipping.com.sa)
//   CERT_CHASE_HR_EMAIL     HR fallback CC (default: bashaier.alsubaie@evergreen-shipping.com.sa)
// =============================================================================

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_HEADER    = process.env.CERT_CHASE_FROM || 'Evergreen HR <noreply@evergreen-shipping.com.sa>';
const HR_EMAIL       = process.env.CERT_CHASE_HR_EMAIL || 'bashaier.alsubaie@evergreen-shipping.com.sa';

const SUPABASE_HEADERS = SUPABASE_KEY ? {
  'apikey':         SUPABASE_KEY,
  'Authorization':  'Bearer ' + SUPABASE_KEY,
  'Content-Type':   'application/json',
  'Prefer':         'return=representation',
} : null;

// ── Email address sanitisation ──────────────────────────────────────
// Mirror of parseEmailAddress() from src/lib/emailTemplates.js. Inlined
// here because Netlify Functions can't import from the React bundle at
// runtime. Strips 'NAME <addr>' display-name wrapping that some rows
// in employees.email accidentally hold from the 2026 spreadsheet
// import. Without this, Resend rejects the message (invalid To: header)
// or the recipient address gets mangled at the mail-client end.

function parseEmailAddress(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const angleMatch = trimmed.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angleMatch && angleMatch[1]) return angleMatch[1].trim().toLowerCase();
  const tokenMatch = trimmed.match(/[^\s<>,;]+@[^\s<>,;]+/);
  if (tokenMatch && tokenMatch[0]) return tokenMatch[0].trim().toLowerCase();
  return '';
}

// ── Audit table helpers (mirrors daily-reeval) ──────────────────────

async function logRunStart() {
  try {
    const res = await fetch(SUPABASE_URL + '/rest/v1/cron_runs', {
      method: 'POST', headers: SUPABASE_HEADERS,
      body: JSON.stringify({
        job_name:   'daily-cert-chase',
        started_at: new Date().toISOString(),
        status:     'running',
      }),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows[0]?.id ? rows[0].id : null;
  } catch { return null; }
}

async function logRunFinish(runId, patch) {
  if (!runId) return;
  try {
    await fetch(SUPABASE_URL + '/rest/v1/cron_runs?id=eq.' + runId, {
      method: 'PATCH', headers: SUPABASE_HEADERS,
      body: JSON.stringify({ finished_at: new Date().toISOString(), ...patch }),
    });
  } catch { /* swallow */ }
}

// ── Working-day arithmetic (KSA: Sun-Thu working, Fri-Sat weekend) ──

function workingDaysSince(endDateIso) {
  // Returns the count of KSA working days strictly AFTER endDateIso
  // up to and including today. A leave ending Sunday means Monday
  // is day 1 late if today >= Monday.
  if (!endDateIso) return 0;
  const start = new Date(endDateIso + 'T00:00:00Z');
  start.setUTCDate(start.getUTCDate() + 1); // day after end_date
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  if (start > today) return 0;
  let count = 0;
  const cursor = new Date(start);
  while (cursor <= today) {
    const dow = cursor.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
    if (dow !== 5 && dow !== 6) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

// ── Reminder kind selection ─────────────────────────────────────────

function pickReminderKind(workingDaysLate, alreadySent) {
  // Highest tier first — final supersedes firmer supersedes gentle.
  if (workingDaysLate >= 5 && !alreadySent.has('final_5d'))   return 'final_5d';
  if (workingDaysLate >= 3 && !alreadySent.has('firmer_72h')) return 'firmer_72h';
  if (workingDaysLate >= 1 && !alreadySent.has('gentle_24h')) return 'gentle_24h';
  return null;
}

// ── Email rendering — HTML versions of sickReminderEmail.js bodies ──

const POLICY_LINE = 'Per Evergreen Line HR policy, the Sehhaty certificate must be submitted within 48 hours of returning from sick leave.';

function fmtDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

const SIGNATURE_HTML = `
  <p style="margin-top:24px; color:#1F1B16;">
    Thanks and regards,<br/>
    <strong>HR Department</strong><br/>
    Evergreen Shipping Agency Saudi Co. (LLC)<br/>
    P.O. Box 1008, Dammam 31431<br/>
    Tel: (013) 8333566 · Fax: (013) 8341182<br/>
    <a href="mailto:esau@evergreen-shipping.com.sa" style="color:#0F4C2A;">esau@evergreen-shipping.com.sa</a>
  </p>
`;

function renderEmail(kind, { declaration, employee }) {
  const firstName = (employee?.name || '').split(' ')[0] || 'Colleague';
  const dr = declaration.start_date === declaration.end_date || !declaration.end_date
    ? fmtDate(declaration.start_date)
    : `${fmtDate(declaration.start_date)} → ${fmtDate(declaration.end_date)}`;

  // Subject convention (set 2026-05-09):
  //   TYPE: PSN — NAME — DATE_RANGE
  // Three escalation tiers prepend their own qualifier so HR can
  // sort by urgency at a glance, but the trailing identifiers stay
  // identical across kinds so threading by employee+date works.
  const idTail = `${employee?.id || ''} — ${employee?.name || ''} — ${dr}`;

  let subject, intro, bodyExtras = '';
  switch (kind) {
    case 'gentle_24h':
      subject = `SEHHATY CERTIFICATE REMINDER: ${idTail}`;
      intro = `This is a friendly reminder to upload your Sehhaty certificate for the sick leave you declared on <strong>${dr}</strong>.`;
      bodyExtras = `<p style="color:#1F1B16;">You can upload it via the HR portal — Sick leave → "Yes, I have it" — and it will attach automatically to your declaration.</p>`;
      break;
    case 'firmer_72h':
      subject = `SEHHATY CERTIFICATE OVERDUE — ACTION NEEDED: ${idTail}`;
      intro = `Your Sehhaty certificate for the sick leave on <strong>${dr}</strong> is now more than 72 hours overdue.`;
      bodyExtras =
        `<p style="color:#1F1B16;">${POLICY_LINE}</p>` +
        `<p style="color:#1F1B16;">Please upload it as soon as possible via the HR portal. New leave or permission requests are blocked until it is submitted.</p>`;
      break;
    case 'final_5d':
      subject = `SEHHATY CERTIFICATE — FINAL NOTICE: ${idTail}`;
      intro = `This is a final reminder regarding the Sehhaty certificate for your sick leave on <strong>${dr}</strong>, which has been outstanding for five working days.`;
      bodyExtras =
        `<p style="color:#7F1D1D;"><strong>Without the certificate, the affected days will be recorded as unauthorized absence and may be deducted from your salary.</strong> ${POLICY_LINE}</p>` +
        `<p style="color:#1F1B16;">Please submit the certificate today, or contact HR if there is a documented reason it cannot be provided.</p>`;
      break;
    default:
      subject = `SEHHATY CERTIFICATE FOLLOW-UP: ${idTail}`;
      intro = `Following up on the Sehhaty certificate for your sick leave on <strong>${dr}</strong>.`;
      bodyExtras = `<p style="color:#1F1B16;">You can upload it via the HR portal at your earliest convenience.</p>`;
  }

  const html = `
    <div style="font-family:Calibri,'Segoe UI',Arial,sans-serif; font-size:14px; line-height:1.55; color:#1F1B16; max-width:560px;">
      <p>Dear ${firstName},</p>
      <p>${intro}</p>
      ${bodyExtras}
      ${SIGNATURE_HTML}
    </div>
  `.trim();

  return { subject, html };
}

// ── Resend dispatch ─────────────────────────────────────────────────

async function sendViaResend({ to, cc, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn('[cert-chase] RESEND_API_KEY not set — skipping send. Would have sent to:', to, 'subject:', subject);
    return { ok: false, skipped: true };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        from:    FROM_HEADER,
        to:      Array.isArray(to) ? to : [to],
        cc:      cc && cc.length ? cc : undefined,
        subject: subject,
        html:    html,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.error('[cert-chase] Resend send failed:', res.status, txt);
      return { ok: false, status: res.status, error: txt };
    }
    const j = await res.json();
    return { ok: true, id: j?.id || null };
  } catch (e) {
    console.error('[cert-chase] Resend fetch threw:', e);
    return { ok: false, error: String(e?.message || e) };
  }
}

// ── Main ────────────────────────────────────────────────────────────

export default async (req, context) => {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return new Response(JSON.stringify({ error: 'Missing Supabase env vars' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  const runId = await logRunStart();
  const summary = { evaluated: 0, sent: 0, skipped_no_resend: 0, errors: 0, by_kind: { gentle_24h: 0, firmer_72h: 0, final_5d: 0 } };

  try {
    // 1) Pull the candidate set: sick leaves missing a Sehhaty cert,
    // not exempted, not rejected/cancelled, end_date in the past.
    // We deliberately include both pending and approved stages —
    // approved+exempt rows still owe a cert; pending_certificate
    // rows are the original Path A declarations.
    const todayIso = new Date().toISOString().slice(0, 10);
    const candUrl = SUPABASE_URL + '/rest/v1/leave_requests' +
      '?select=id,employee_id,start_date,end_date,status,stage,sehhaty_code,sick_cert_exempt,sick_declared_at' +
      '&leave_type_id=eq.sick' +
      '&sehhaty_code=is.null' +
      `&end_date=lt.${todayIso}` +
      '&status=in.(pending,approved)';
    const candRes = await fetch(candUrl, { headers: SUPABASE_HEADERS });
    if (!candRes.ok) throw new Error('Candidate fetch failed: ' + candRes.status);
    const candidates = (await candRes.json()) || [];
    // Drop fully-exempt rows (cert obligation already waived).
    const eligible = candidates.filter(r => r.sick_cert_exempt !== true);

    if (eligible.length === 0) {
      await logRunFinish(runId, { status: 'no_op', details: summary });
      return new Response(JSON.stringify({ ok: true, ...summary }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // 2) Bulk-fetch existing reminders so we can dedup per declaration.
    const ids = eligible.map(r => r.id);
    const remRes = await fetch(
      SUPABASE_URL + '/rest/v1/sick_reminders?select=request_id,reminder_kind' +
      `&request_id=in.(${ids.join(',')})`,
      { headers: SUPABASE_HEADERS }
    );
    const reminders = remRes.ok ? (await remRes.json()) || [] : [];
    const sentByRequest = new Map();
    for (const r of reminders) {
      if (!sentByRequest.has(r.request_id)) sentByRequest.set(r.request_id, new Set());
      sentByRequest.get(r.request_id).add(r.reminder_kind);
    }

    // 3) Pull the employee directory in one shot for name + email +
    // manager lookups.
    const empIds = Array.from(new Set(eligible.map(r => r.employee_id))).filter(Boolean);
    const empUrl = SUPABASE_URL + '/rest/v1/employees' +
      '?select=id,name,email,manager_id' +
      `&id=in.(${empIds.map(id => `"${id}"`).join(',')})`;
    const empRes = await fetch(empUrl, { headers: SUPABASE_HEADERS });
    const employees = empRes.ok ? (await empRes.json()) || [] : [];
    const empById = new Map(employees.map(e => [e.id, e]));
    // Manager set for second-degree lookup
    const mgrIds = Array.from(new Set(employees.map(e => e.manager_id).filter(Boolean)));
    let mgrById = new Map();
    if (mgrIds.length) {
      const mgrUrl = SUPABASE_URL + '/rest/v1/employees' +
        '?select=id,name,email' +
        `&id=in.(${mgrIds.map(id => `"${id}"`).join(',')})`;
      const mgrRes = await fetch(mgrUrl, { headers: SUPABASE_HEADERS });
      const mgrs = mgrRes.ok ? (await mgrRes.json()) || [] : [];
      mgrById = new Map(mgrs.map(m => [m.id, m]));
    }

    // 4) Walk each candidate, decide reminder kind, send, log.
    for (const decl of eligible) {
      summary.evaluated++;
      const emp = empById.get(decl.employee_id);
      // Clean both the staff and manager emails before any send /
      // CC computation — see parseEmailAddress comment above.
      const cleanEmpEmail = parseEmailAddress(emp?.email || '');
      if (!emp || !cleanEmpEmail) {
        console.warn('[cert-chase] no usable email for', decl.employee_id, '(raw:', emp?.email, ')');
        continue;
      }
      const wdLate = workingDaysSince(decl.end_date);
      const already = sentByRequest.get(decl.id) || new Set();
      const kind = pickReminderKind(wdLate, already);
      if (!kind) continue;

      const mgr = emp.manager_id ? mgrById.get(emp.manager_id) : null;
      const cleanMgrEmail = parseEmailAddress(mgr?.email || '');
      const cc = [];
      if ((kind === 'firmer_72h' || kind === 'final_5d') && cleanMgrEmail) cc.push(cleanMgrEmail);
      if (kind === 'final_5d' && HR_EMAIL && HR_EMAIL !== cleanEmpEmail) cc.push(HR_EMAIL);

      const { subject, html } = renderEmail(kind, { declaration: decl, employee: emp });
      const result = await sendViaResend({ to: cleanEmpEmail, cc, subject, html });

      if (result.ok) {
        summary.sent++;
        summary.by_kind[kind]++;
        // Insert dedup row so we don't re-send this kind tomorrow.
        try {
          await fetch(SUPABASE_URL + '/rest/v1/sick_reminders', {
            method: 'POST', headers: SUPABASE_HEADERS,
            body: JSON.stringify({
              request_id:    decl.id,
              sent_at:       new Date().toISOString(),
              sent_by:       null, // null = system-auto, per schema comment
              channel:       'email',
              reminder_kind: kind,
              note:          `Auto-sent by daily-cert-chase. Resend id: ${result.id || '—'}`,
            }),
          });
        } catch (e) {
          console.warn('[cert-chase] dedup insert failed:', e);
        }
      } else if (result.skipped) {
        summary.skipped_no_resend++;
      } else {
        summary.errors++;
      }
    }

    await logRunFinish(runId, {
      status:         summary.sent > 0 ? 'success' : (summary.errors > 0 ? 'error' : 'no_op'),
      rows_processed: summary.evaluated,
      rows_updated:   summary.sent,
      details:        summary,
    });

    return new Response(JSON.stringify({ ok: true, ...summary }),
      { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    const msg = String(err?.message || err);
    console.error('[cert-chase] failed:', msg);
    await logRunFinish(runId, { status: 'error', error: msg, details: summary });
    return new Response(JSON.stringify({ error: msg, summary }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
};

// 5 minutes after daily-reeval so attendance reclassification settles
// before we evaluate cert pressure. 21:05 UTC = 00:05 KSA.
export const config = {
  schedule: '5 21 * * *',
};
