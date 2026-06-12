// =============================================================================
// emailTemplates.js
//
// Lightweight loader + cache for editable email-template overrides stored in
// app_settings(key='email_templates'). Used by:
//   • EmailTemplatesPanel (admin UI) — reads + writes the row
//   • permissionLetter.js / rejoiningReport.js — read-only consumers; if the
//     override exists, use it, otherwise fall back to hardcoded defaults
//
// The cache hydrates lazily on first load and refreshes when the panel
// saves. Modules that need fresh data after an edit can call invalidate().
// Everything degrades silently — if the table doesn't exist, missing migration,
// timeout, etc. — every consumer falls back to its built-in defaults.
// =============================================================================

import { directGet, directPost } from '../supabaseClient.js';

// In-memory cache. Populated by loadTemplates(); read by getTemplateSync().
let cache = null;
let inFlight = null;

// Hardcoded defaults — must match what existed before the override system.
// Consumers receive these merged with whatever the DB row holds, with DB
// values taking precedence on a per-leaf basis.
export const DEFAULT_TEMPLATES = {
  hr_signature: {
    name:     'BASHAIER ALI',
    company:  'Evergreen Shipping Agency Saudi Co.,(L.L.C)',
    unit:     'ESAU - SADMN SUP/ HR DEPT',
    address:  'P.O.Box : 1008,  DAMMAM – 31431, K.S.A',
    whatsapp: '966-54 320 9694',
    tel:      '966-013 813 8563 – Ext 8543',
    email:    'bashaier.alsubaie@evergreen-shipping.com.sa',
  },
  subject_prefixes: {
    permission_letter: '[Permission Letter]',
    rejoining_letter:  '[Rejoining Letter]',
    attendance_late:   '[Lateness Notice]',
    attendance_early:  '[Early Departure Notice]',
    attendance_missed: '[Punch Reminder]',
  },
};

/**
 * Deep-merge two simple objects (one level of nesting). DB values overlay
 * defaults on a per-key basis so partial customisations work correctly —
 * e.g. admin edits only the WhatsApp number; the rest of the signature
 * still falls back to the hardcoded defaults.
 */
function merge(defaults, override) {
  if (!override || typeof override !== 'object') return defaults;
  const out = { ...defaults };
  Object.keys(override).forEach(k => {
    const dv = defaults[k];
    const ov = override[k];
    if (dv && typeof dv === 'object' && ov && typeof ov === 'object') {
      out[k] = { ...dv, ...ov };
    } else if (ov !== undefined && ov !== null && ov !== '') {
      out[k] = ov;
    }
  });
  return out;
}

/** Fetch the row from app_settings and merge with defaults. Cached. */
export async function loadTemplates() {
  if (cache) return cache;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const rows = await directGet(
        'app_settings?select=value&key=eq.email_templates&limit=1',
        '',
        { timeoutMs: 6000 }
      );
      const dbValue = (rows && rows[0] && rows[0].value) || {};
      cache = {
        hr_signature:     merge(DEFAULT_TEMPLATES.hr_signature,     dbValue.hr_signature),
        subject_prefixes: merge(DEFAULT_TEMPLATES.subject_prefixes, dbValue.subject_prefixes),
      };
    } catch (e) {
      // Table doesn't exist (migration not run), timeout, network error —
      // any failure falls through to defaults.
      cache = { ...DEFAULT_TEMPLATES };
    } finally {
      inFlight = null;
    }
    return cache;
  })();
  return inFlight;
}

/**
 * Synchronous read for code paths that can't await (e.g. inside a docx
 * generator that builds objects synchronously after data is loaded).
 * Returns defaults until the async load completes; consumers that need
 * fresh data should call loadTemplates() up front.
 */
export function getTemplateSync() {
  return cache || DEFAULT_TEMPLATES;
}

/**
 * Write a new templates object to app_settings. Uses upsert via PostgREST's
 * Prefer: resolution=merge-duplicates header through directPost on the
 * key column. Returns true on success.
 */
export async function saveTemplates(value, actorPsn) {
  // Normalise — strip empties so the cleared field falls back to default
  // rather than overriding with ''.
  const clean = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    Object.entries(obj).forEach(([k, v]) => {
      if (v === '' || v === undefined || v === null) return;
      if (typeof v === 'object') out[k] = clean(v);
      else                       out[k] = v;
    });
    return out;
  };
  const cleaned = clean(value);
  // Upsert via on_conflict
  await directPost('app_settings?on_conflict=key', {
    key: 'email_templates',
    value: cleaned,
    updated_by: actorPsn || null,
    updated_at: new Date().toISOString(),
  }, {
    timeoutMs: 8000,
    headers: { 'Prefer': 'resolution=merge-duplicates' },
  });
  // Invalidate so next consumer reads fresh
  cache = null;
  return true;
}

/** Force a cache refresh — used by the admin panel after a save. */
export function invalidate() {
  cache = null;
}

/**
 * Render the HR signature as a plain-text block ready to drop into
 * an email body. Uses the canonical format Bashaier specified for
 * all auto-generated emails:
 *
 *   Thanks and regards,
 *
 *   BASHAIER ALI
 *   Evergreen Shipping Agency Saudi Co.,(L.L.C)
 *   ESAU - SADMN SUP/ HR DEPT
 *   Whatsapp: 966-54 320 9694
 *   Tel: 966-013 813 8563 – Ext 8543
 *   Email:bashaier.alsubaie@evergreen-shipping.com.sa
 *
 * If `sig` is not passed, falls back to the cached templates (or
 * defaults if the cache hasn't been hydrated yet). All consumers
 * are encouraged to call this rather than rolling their own
 * formatting so any future change to Bashaier's signature
 * propagates through the entire app in one place.
 *
 * @param {Object} [sig] - Optional signature object. If omitted,
 *                         uses the cached `hr_signature` from the
 *                         email_templates row, falling back to
 *                         DEFAULT_TEMPLATES.hr_signature.
 * @returns {string} Multi-line plain-text signature block, ready
 *                   to concatenate into an email body. No leading
 *                   or trailing newline — caller controls that.
 */
export function renderHrSignature(sig) {
  const s = sig || (cache && cache.hr_signature) || DEFAULT_TEMPLATES.hr_signature;
  return [
    'Thanks and regards,',
    s.name,
    s.company,
    s.unit,
    `Whatsapp: ${s.whatsapp}`,
    `Tel: ${s.tel}`,
    `Email:${s.email}`,
  ].join('\n');
}

/**
 * Render the HR signature as an HTML block for emails that paste into
 * Outlook/Gmail with formatting. Same content + structure as
 * renderHrSignature() but uses inline-styled <p>/<a> tags so the
 * 'Thanks and regards' lead-in and the signature block render
 * correctly in HTML-aware clients.
 *
 * Inline styles only (no <style>, no external CSS) so it survives
 * email-client sanitisation.
 *
 * @param {Object} [sig] - Optional signature object; falls back to
 *                         the cached templates / defaults.
 * @returns {string} HTML fragment ending with the signature block.
 *                   No outer wrapper — caller can drop it directly
 *                   into the email body.
 */
export function renderHrSignatureHtml(sig) {
  const s = sig || (cache && cache.hr_signature) || DEFAULT_TEMPLATES.hr_signature;
  const esc = (str) => String(str ?? '').replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  return [
    `<p style="margin:14px 0 4px 0;font-family:Calibri,Arial,sans-serif;font-size:14px;color:#0A0A0A">Thanks and regards,</p>`,
    `<p style="margin:14px 0 0 0;font-family:Calibri,Arial,sans-serif;font-size:14px;color:#0A0A0A"><strong>${esc(s.name)}</strong></p>`,
    `<p style="margin:0;font-family:Calibri,Arial,sans-serif;font-size:13px;color:#1F1B16">${esc(s.company)}</p>`,
    `<p style="margin:0;font-family:Calibri,Arial,sans-serif;font-size:13px;color:#1F1B16">${esc(s.unit)}</p>`,
    `<p style="margin:0;font-family:Calibri,Arial,sans-serif;font-size:13px;color:#1F1B16">Whatsapp: ${esc(s.whatsapp)}</p>`,
    `<p style="margin:0;font-family:Calibri,Arial,sans-serif;font-size:13px;color:#1F1B16">Tel: ${esc(s.tel)}</p>`,
    `<p style="margin:0;font-family:Calibri,Arial,sans-serif;font-size:13px;color:#1F1B16">Email:<a href="mailto:${esc(s.email)}" style="color:#2D5F3F;text-decoration:none">${esc(s.email)}</a></p>`,
  ].join('');
}

// =============================================================================
// parseEmailAddress
//
// Defensive helper that extracts the bare email address from values that
// might be stored as 'NAME <address@domain>' or '"NAME" <address@domain>'
// instead of just 'address@domain'. Returns the canonical lowercase
// address, or empty string when nothing usable is found.
//
// Why this exists:
//   The 2026 employee spreadsheet import stored some emails in the
//   'NAME <addr>' display format. Building a mailto: link with that
//   whole string as the recipient produces malformed URLs that some
//   mail clients (notably Apple Mail on iOS) render as
//   'Name. Surname @domain' with weird spacing and dots. Always pipe
//   employee.email values through this helper before constructing a
//   mailto: link, building a Resend `to:` array, or otherwise relying
//   on the string being a clean RFC 5322 addr-spec.
//
// The fix at the data layer is to clean the rows in employees.email
// (e.g. UPDATE employees SET email = lower(...) WHERE email LIKE '%<%').
// This helper is belt-and-suspenders so future bad imports don't
// resurface the bug.
// =============================================================================
export function parseEmailAddress(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Format: 'NAME <addr@domain>' or '"NAME" <addr@domain>'.
  // Capture whatever sits inside the angle brackets.
  const angleMatch = trimmed.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angleMatch && angleMatch[1]) return angleMatch[1].trim().toLowerCase();
  // Format: bare email — could still have stray spaces or tabs.
  // Pull the first whitespace-separated token that looks like an
  // address. Catches 'addr@domain extra junk' edge cases.
  const tokenMatch = trimmed.match(/[^\s<>,;]+@[^\s<>,;]+/);
  if (tokenMatch && tokenMatch[0]) return tokenMatch[0].trim().toLowerCase();
  return '';
}
