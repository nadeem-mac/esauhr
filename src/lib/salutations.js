// =============================================================================
// salutations.js
//
// Per-employee salutation overrides for auto-drafted emails. The default
// behaviour ('Dear ${firstName},') doesn't always fit — some people in
// the org go by a title + short name (e.g. 'Capt. Sharique' for Capt.
// MOHAMMAD SHARIQUE MOHAMMAD YAQUB), and shouting their first registered
// name back at them in every email reads as cold and impersonal.
//
// Use the helper everywhere a salutation is composed:
//
//   import { salutationFor } from '../lib/salutations.js';
//   const greeting = `Dear ${salutationFor(employee)},`;
//
// To add a new override, drop a row in OVERRIDES below keyed by PSN
// (upper-cased). The helper falls back to a title-cased first name
// for anyone not listed.
// =============================================================================

// Per-PSN salutation overrides. PSN is the canonical identifier so a
// name change (marriage, transliteration update, etc.) doesn't break
// the mapping.
const OVERRIDES = {
  // Capt. MOHAMMAD SHARIQUE MOHAMMAD YAQUB — line manager, BIZ/CSD/OPS
  // KSA. Nadeem 2026-05-17: 'when its addressed to MOHAMMAD SHARIQUE
  // MOHAMMAD YAQUB, it should always say as Dear Capt. Sharique'.
  H94460: 'Capt. Sharique',
};

/**
 * Return the friendly form of an employee's name suitable to drop
 * directly after 'Dear ' in an email greeting.
 *
 * Resolution order:
 *   1. Per-PSN override in OVERRIDES.
 *   2. Title-cased first token of the employee's `name`.
 *   3. The literal string 'Colleague' as a last-ditch fallback so
 *      we never produce a 'Dear ,' or 'Dear undefined,' greeting.
 *
 * @param {Object|null|undefined} employee  Plain employee row, expected
 *   to have at least `id` (PSN) and `name`. Both fields are optional
 *   — the helper degrades gracefully when either is missing.
 * @returns {string} Name + optional title, without 'Dear ' / trailing
 *   punctuation. Caller is responsible for wrapping it in the greeting.
 */
export function salutationFor(employee) {
  if (!employee) return 'Colleague';
  const id = String(employee.id || employee.psn || '').toUpperCase();
  if (id && OVERRIDES[id]) return OVERRIDES[id];
  const raw = String(employee.name || '').trim();
  if (!raw) return 'Colleague';
  // Take the first whitespace-delimited token. For employees whose
  // legal records use ALL-CAPS (most ESAU rows do), normalise to
  // Title Case so the greeting doesn't shout.
  const first = raw.split(/\s+/)[0];
  if (!first) return 'Colleague';
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

/**
 * Convenience wrapper that returns the full greeting prefix —
 * 'Dear ${salutation},'. Some composers (especially HTML email
 * builders) prefer to drop a ready-made greeting in rather than
 * concatenating piece by piece.
 *
 * @param {Object|null|undefined} employee  See salutationFor().
 * @returns {string} 'Dear <salutation>,'
 */
export function greetingFor(employee) {
  return `Dear ${salutationFor(employee)},`;
}
