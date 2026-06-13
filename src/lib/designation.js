// Single source of truth for an employee's designation label.
//
// When no designation is on file yet, default to 'STAFF' (capitals) — a
// clear placeholder to be updated later once the real job title is known.
// Accepts multiple candidates (e.g. a per-document position override, then
// the employee record) and returns the first non-empty one.
export function designationOf(...candidates) {
  for (const c of candidates) {
    const v = String(c == null ? '' : c).trim();
    if (v) return v;
  }
  return 'STAFF';
}
