// ─── molSync.js ──────────────────────────────────────────────────────
//
// Parses MOL/GOSI subscriber-list xlsx files and reconciles them
// against the portal's employees table. The MOL file is the
// government's authoritative record of who is officially employed at
// the company — it carries Arabic names, National IDs (Iqama /
// Saudi-resident IDs), DOBs, and GOSI eligibility codes. We mirror
// these into the employees table so the portal can:
//   • Generate Arabic-language letters/forms with the formally
//     correct name (the existing VACATION_FORM.docx is bilingual —
//     before this we had to manually type Arabic names).
//   • Use National ID as a stable cross-system identifier (the
//     portal's PSN is internal; National ID is what banks, GOSI,
//     and the visa system use).
//   • Spot data drift — anyone in the portal not in MOL probably
//     left; anyone in MOL not in the portal is a new hire we
//     haven't onboarded yet.
//
// Initial reconciliation requires manual confirmation per record
// because portal names are English-transliterated and MOL names
// are formal Arabic ("X bin Y bin Z"). After national_id is
// populated, subsequent syncs auto-match on it.
// ───────────────────────────────────────────────────────────────────

import * as XLSX from 'xlsx';

const MOL_HEADER_KEYWORDS = {
  // Maps the Arabic header strings to our canonical field names.
  // The MOL file occasionally re-orders columns or uses minor
  // wording variants, so we identify columns by content rather
  // than position.
  arabic_name:       ['اسم المشترك'],
  national_id:       ['رقم الهوية'],
  nationality:       ['الجنسية'],
  gender:            ['الجنس'],
  date_of_birth:     ['تاريخ الميلاد'],
  arabic_profession: ['المهنة'],
  mol_join_date:     ['تاريخ الإلتحاق', 'تاريخ الالتحاق'],
  gosi_eligibility:  ['الاهلية لنظام التأمينات', 'الأهلية'],
};

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Parses a MOL xlsx ArrayBuffer or File and returns a normalized
 * snapshot. Throws on structurally-invalid files.
 */
export async function parseMolFile(fileOrBuffer) {
  const buffer = fileOrBuffer instanceof File
    ? await fileOrBuffer.arrayBuffer()
    : fileOrBuffer;
  const wb = XLSX.read(buffer, { type: 'array', cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) throw new Error('MOL file has no sheets.');
  const sheet = wb.Sheets[sheetName];
  // header:1 returns a 2D array — easier to find the header row
  // since the MOL file has a few merged/title rows above the data.
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
  if (!rows.length) throw new Error('MOL file is empty.');

  // Find the header row — the one containing 'اسم المشترك'
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const r = rows[i] || [];
    if (r.some(c => typeof c === 'string' && c.includes('اسم المشترك'))) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx < 0) throw new Error('Could not find MOL header row (looking for "اسم المشترك").');

  // Map column index → canonical field
  const headerCells = rows[headerRowIdx] || [];
  const colMap = {};
  for (const [field, keywords] of Object.entries(MOL_HEADER_KEYWORDS)) {
    for (let ci = 0; ci < headerCells.length; ci++) {
      const cell = headerCells[ci];
      if (typeof cell !== 'string') continue;
      if (keywords.some(k => cell.includes(k))) {
        colMap[field] = ci;
        break;
      }
    }
  }
  if (colMap.arabic_name == null || colMap.national_id == null) {
    throw new Error('MOL file is missing required columns (Arabic name, National ID).');
  }

  // Extract establishment ID and subscription number from the
  // top metadata rows (they appear above the header). Best-effort —
  // if we can't find them we leave them null.
  let establishmentName = null;
  let gosiSubscriptionId = null;
  for (let i = 0; i < headerRowIdx; i++) {
    const r = rows[i] || [];
    for (let ci = 0; ci < r.length; ci++) {
      const v = r[ci];
      if (typeof v === 'string' && v.includes('شركة')) {
        establishmentName = v.trim();
      } else if (typeof v === 'number' && v > 100000000 && v < 1000000000) {
        // 9-digit number in the metadata band is almost always the
        // GOSI subscription ID.
        gosiSubscriptionId = String(v);
      }
    }
  }

  // Walk the data rows
  const subscribers = [];
  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const nid = r[colMap.national_id];
    if (nid == null || nid === '') continue;
    const arabic = r[colMap.arabic_name];
    if (!arabic) continue;

    subscribers.push({
      arabic_name:       String(arabic).trim(),
      national_id:       normalizeNationalId(nid),
      nationality_ar:    cellStr(r[colMap.nationality]),
      nationality:       normalizeNationality(r[colMap.nationality]),
      gender:            normalizeGender(r[colMap.gender]),
      date_of_birth:     cellDate(r[colMap.date_of_birth]),
      arabic_profession: cellStr(r[colMap.arabic_profession]),
      mol_join_date:     cellDate(r[colMap.mol_join_date]),
      gosi_eligibility:  cellStr(r[colMap.gosi_eligibility])?.replace(/\s+/g, '') || null,
    });
  }

  return {
    establishmentName,
    gosiSubscriptionId,
    subscribers,
  };
}

/**
 * Builds a reconciliation table by fuzzy-matching each MOL subscriber
 * against the portal's employee list. Returns:
 *   matches[]  — { mol, employee, confidence, reason }
 *   unmatched[] — MOL records with no plausible portal match (likely
 *                 new hires not yet onboarded into the portal)
 *   orphaned[]  — portal employees with no MOL match (likely ex-staff
 *                 still in the system, or stale records)
 *
 * Confidence:
 *   1.0 — National ID match (perfect — the portal already knows this
 *         employee's National ID and it matches MOL exactly)
 *   0.6-0.95 — fuzzy name match (transliteration similarity)
 *   < 0.5 — too weak, listed as unmatched so Nadeem doesn't auto-confirm
 */
export function reconcile(molSubscribers, employees) {
  const matches = [];
  const unmatched = [];
  const employeesById = new Map((employees || []).map(e => [e.id, e]));
  const employeesByNationalId = new Map(
    (employees || [])
      .filter(e => e.national_id)
      .map(e => [String(e.national_id), e])
  );
  const matchedEmpIds = new Set();

  for (const mol of molSubscribers) {
    // Phase 1 — exact National ID match (perfect signal)
    const nidMatch = employeesByNationalId.get(mol.national_id);
    if (nidMatch) {
      matches.push({
        mol,
        employeeId: nidMatch.id,
        confidence: 1.0,
        reason: 'National ID match',
      });
      matchedEmpIds.add(nidMatch.id);
      continue;
    }

    // Phase 2 — fuzzy name match. The MOL Arabic name and portal
    // English name need to be compared via a transliteration-aware
    // similarity score. Strategy:
    //   1. Strip common Arabic name connectors (bin, abdul, al-)
    //   2. Romanize remaining Arabic tokens via a lookup table
    //   3. Token-overlap with portal name
    const candidates = (employees || [])
      .filter(e => !matchedEmpIds.has(e.id))
      .map(e => ({
        emp: e,
        score: nameSimilarity(mol.arabic_name, e.name),
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3); // Top 3 candidates

    if (candidates.length > 0 && candidates[0].score >= 0.5) {
      matches.push({
        mol,
        employeeId: candidates[0].emp.id,
        confidence: candidates[0].score,
        reason: 'Name similarity',
        alternatives: candidates.slice(1).map(c => ({
          employeeId: c.emp.id,
          confidence: c.score,
        })),
      });
      // Don't add to matchedEmpIds yet — these are suggestions,
      // not confirmed matches; user may swap during review
    } else {
      unmatched.push({
        mol,
        suggestions: candidates.map(c => ({
          employeeId: c.emp.id,
          confidence: c.score,
        })),
      });
    }
  }

  // Phase 3 — orphaned portal records. Anyone confirmed-matched is
  // out; the rest may be ex-staff or staff who haven't been
  // registered with MOL yet (rare but possible during onboarding gap).
  // We resolve "confirmed" later when the user clicks Apply. For now,
  // orphaned = portal employees that have NO match suggestion.
  const allSuggestedIds = new Set([
    ...matches.map(m => m.employeeId),
    ...matches.flatMap(m => (m.alternatives || []).map(a => a.employeeId)),
    ...unmatched.flatMap(u => (u.suggestions || []).map(s => s.employeeId)),
  ]);
  const orphaned = (employees || []).filter(e => !allSuggestedIds.has(e.id));

  return { matches, unmatched, orphaned };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function cellStr(v) {
  if (v == null) return null;
  return String(v).trim() || null;
}

function cellDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !isNaN(v)) {
    return v.toISOString().slice(0, 10);
  }
  // Numeric Excel serial?
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) {
      const mm = String(d.m).padStart(2, '0');
      const dd = String(d.d).padStart(2, '0');
      return `${d.y}-${mm}-${dd}`;
    }
  }
  // String like "2023-09-07" or "07/09/2023"?
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  return null;
}

function normalizeNationalId(v) {
  if (v == null) return null;
  if (typeof v === 'number') return String(Math.round(v));
  return String(v).trim().replace(/\s+/g, '');
}

function normalizeNationality(v) {
  // Portal currently uses 'saudi' | 'expat'. The MOL file uses Arabic
  // country names. Saudi citizens are 'saudi'; everyone else 'expat'.
  const s = (v == null ? '' : String(v));
  if (s.includes('السعودي')) return 'saudi';
  return 'expat';
}

function normalizeGender(v) {
  const s = (v == null ? '' : String(v));
  if (s.includes('ذكر')) return 'male';
  if (s.includes('أنثى') || s.includes('انثى')) return 'female';
  return null;
}

// ─── Transliteration & name similarity ──────────────────────────────
//
// The MOL Arabic names follow the formal "X bin Y bin Z al-Family"
// pattern. The portal's English names are typically transliterated
// uppercase ("BASHAIER ALI ALSUBAIE"). To match them, we:
//   1. Strip Arabic name connectors (bin, abu, al-)
//   2. Romanize each Arabic token via a per-letter transliteration
//      table. The table uses the most common transliteration; it
//      won't be perfect but token-overlap tolerates that.
//   3. Compare the romanized MOL name against the portal name as
//      token sets (Jaccard). High overlap = same person.

const ARABIC_CONNECTORS = new Set([
  'بن', 'بنت', 'ابن', 'ابو', 'أبو', 'ام', 'أم', 'ال', 'آل', 'عبد',
  'al', 'bin', 'bint', 'abu', 'um', 'al-', 'el-', 'ibn',
]);

// Letter-by-letter transliteration. Multi-char sequences first.
const AR_TRANS_PAIRS = [
  ['ال',  'al'],   // definite article — often dropped but romanize anyway
  ['آ',   'aa'],
  ['ا',   'a'],   ['أ', 'a'],   ['إ', 'i'],   ['ى', 'a'],
  ['ب',   'b'],
  ['ت',   't'],   ['ث', 'th'],
  ['ج',   'j'],
  ['ح',   'h'],   ['خ', 'kh'],
  ['د',   'd'],   ['ذ', 'dh'],
  ['ر',   'r'],
  ['ز',   'z'],
  ['س',   's'],   ['ش', 'sh'],
  ['ص',   's'],   ['ض', 'd'],
  ['ط',   't'],   ['ظ', 'z'],
  ['ع',   'a'],   // ayn — often invisible in transliteration
  ['غ',   'gh'],
  ['ف',   'f'],
  ['ق',   'q'],   // some transliterate as 'g' (Gulf), but 'q' first
  ['ك',   'k'],
  ['ل',   'l'],
  ['م',   'm'],
  ['ن',   'n'],
  ['ه',   'h'],   ['ة', 'h'],
  ['و',   'w'],   // also 'oo' / 'u' depending on context
  ['ي',   'y'],   ['ئ', 'y'],   ['ؤ', 'w'],
  ['ء',   ''],    // hamza — often dropped
];

function romanizeArabic(text) {
  if (!text) return '';
  let s = String(text);
  // Strip diacritics (tashkeel)
  s = s.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');
  // Apply pairs in order
  for (const [from, to] of AR_TRANS_PAIRS) {
    s = s.split(from).join(to);
  }
  return s;
}

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[-_./()]/g, ' ')
    .split(/\s+/)
    .map(t => t.trim())
    .filter(t => t.length > 1)
    .filter(t => !ARABIC_CONNECTORS.has(t));
}

/**
 * Returns a similarity score 0..1 between an Arabic name and a
 * transliterated English name. Uses Jaccard token overlap on the
 * romanized form.
 */
export function nameSimilarity(arabicName, englishName) {
  if (!arabicName || !englishName) return 0;
  const arRomanized = romanizeArabic(arabicName);
  const arTokens = new Set(tokenize(arRomanized));
  const enTokens = new Set(tokenize(englishName));
  if (!arTokens.size || !enTokens.size) return 0;

  // Token-overlap with prefix tolerance — 'mahmood' and 'mahmoud'
  // shouldn't be punished hard. A token from one set "matches" a
  // token from the other if they share a 3+-char prefix.
  let overlap = 0;
  const seen = new Set();
  for (const at of arTokens) {
    for (const et of enTokens) {
      if (seen.has(et)) continue;
      if (at === et || prefixMatch(at, et, 3)) {
        overlap++;
        seen.add(et);
        break;
      }
    }
  }
  // Jaccard-like: overlap / (smaller set)
  // Using min(set sizes) so a 3-token Arabic name matching 2 of a
  // 4-token English name still scores well.
  return overlap / Math.min(arTokens.size, enTokens.size);
}

function prefixMatch(a, b, k) {
  const m = Math.min(a.length, b.length);
  if (m < k) return false;
  return a.slice(0, k) === b.slice(0, k);
}
