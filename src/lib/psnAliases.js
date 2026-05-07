// ─── PSN aliases ───────────────────────────────────────────────────
//
// Temporary mapping for staff whose biometric terminal exports a PSN
// that doesn't match their record in the employees table. The proper
// fix is for IT to correct the biometric configuration, but until
// that happens we don't want to lose attendance logs for these
// staff. Each entry maps the WRONG ID emitted by the biometric file
// to the CORRECT ID stored in the employees master.
//
// This is parser-level remapping — the alias is applied immediately
// after PSN normalisation, so every downstream consumer (attendance
// rows, violations, manager attribution, calendar cells) sees the
// canonical PSN. The alias is invisible past the parser.
//
// Adding a new alias: just extend the map. Removing one: delete the
// entry — once the biometric is fixed for that person, the row
// emitted by the device will already match the master directly and
// no alias is needed.
//
// Per Nadeem (2026-05-07): two known cases —
//   • Badria Mohammed Ahmad Al Hassan: file emits 4458 → H04458,
//     master has her as H94458.
//   • Musaid AlMuaysib: file emits 94700 → H94700, master has
//     him as H94725.
//
// If the master records get corrected later, just delete that
// alias and re-deploy.

export const PSN_ALIASES = {
  'H04458': 'H94458',  // Badria Mohammed Ahmad Al Hassan
  'H94700': 'H94725',  // Musaid AlMuaysib
};

/**
 * applyPsnAlias — pure helper. Takes a normalised PSN (e.g. 'H04458')
 * and returns either the aliased canonical form or the input
 * unchanged if no alias exists. Safe to call on every PSN; the map
 * lookup is O(1) and the no-alias path is a noop.
 */
export function applyPsnAlias(psn) {
  if (!psn) return psn;
  return PSN_ALIASES[psn] || psn;
}
