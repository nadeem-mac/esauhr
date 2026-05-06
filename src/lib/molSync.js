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

    const arabicName = String(arabic).trim();
    subscribers.push({
      arabic_name:       arabicName,
      // Pre-computed canonical English form — what the portal's
      // `name` field gets set to on apply. Done here so the UI can
      // preview it in the match list before the user clicks Apply.
      canonical_name:    canonicalEnglishName(arabicName),
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

  // Threshold tuned per Nadeem's request: best-effort matching, so
  // anything plausible surfaces as a "match" (even at low confidence)
  // rather than being marked unmatched. Truly nothing-similar rows
  // still go to unmatched. The auto-sync button only auto-applies
  // ≥0.7 confident matches; lower-confidence ones need a manual
  // tick from admin, which keeps false-positives out of the DB.
  const MATCH_THRESHOLD = 0.18;

  for (const mol of molSubscribers) {
    // Phase 1 — exact National ID match (perfect signal). Once a
    // portal employee has been synced once, their national_id is
    // populated, so this path dominates on subsequent uploads.
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

    // Phase 2 — best-effort name match. Score every portal employee
    // against this MOL record using englishNameSimilarity on the
    // canonical English name (transliterated via the dictionary).
    // This is apples-to-apples Latin-vs-Latin comparison; the legacy
    // arabic-to-romanized comparison was producing false 50% matches
    // because every Arabic name romanizes to tokens like "abdullah",
    // "ahmed", "al-X" that overlap with practically anything.
    //
    // Falls back to the legacy nameSimilarity ONLY if canonical_name
    // is somehow missing (defensive — shouldn't happen since
    // parseMolFile computes it).
    const scored = (employees || [])
      .filter(e => !matchedEmpIds.has(e.id))
      .map(e => ({
        emp: e,
        score: mol.canonical_name
          ? englishNameSimilarity(mol.canonical_name, e.name)
          : nameSimilarity(mol.arabic_name, e.name),
      }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    // Surface up to 5 candidates so the "Change" dropdown has plenty
    // of suggestions even when the top isn't a confident match.
    const candidates = scored.slice(0, 5);

    if (candidates.length > 0 && candidates[0].score >= MATCH_THRESHOLD) {
      matches.push({
        mol,
        employeeId: candidates[0].emp.id,
        confidence: candidates[0].score,
        reason: candidates[0].score >= 0.95 ? 'Strong name match'
              : candidates[0].score >= 0.7  ? 'Name similarity'
              : 'Best-effort name match',
        alternatives: candidates.slice(1).map(c => ({
          employeeId: c.emp.id,
          confidence: c.score,
        })),
      });
      // Note: we still don't claim the empId here. The portal may
      // legitimately have two staff with similar names; admin can
      // swap via the Change dropdown if our top pick is wrong.
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

// ─── English-to-English name similarity ────────────────────────────
//
// Compares two Latin-script names (typically the canonical
// transliteration of the MOL Arabic name vs the portal's existing
// English name). Returns 0..1.
//
// Layered:
//   1. After cleanup (strip punctuation, AL-/AL prefix, BIN
//      connector), compare token sets.
//   2. For each canonical token, find the BEST matching portal
//      token via:
//        • Exact match → 1.0
//        • Prefix match (k=4) → 0.85
//        • Levenshtein distance ≤ 2 normalized to length → 0.7-0.95
//        • Substring match → 0.6
//   3. Final score = sum of best per-token scores / max(token sets)
//      Using max keeps the score honest when one name has more
//      tokens than the other (a 3-token match against a 5-token
//      MOL entry shouldn't max out at 1.0 since 2 tokens are
//      unaccounted for).
//
// Special pattern: portal names sometimes mash a connector into
// the family name ("ALSUBAIE") while MOL canonical separates with
// dash ("AL-SUBAIE"). Tokenize() drops punctuation, and the
// edit-distance fallback handles "ALSUBAIE" vs "ALSUBAIE" easily
// (since dashes are stripped in both).
export function englishNameSimilarity(nameA, nameB) {
  if (!nameA || !nameB) return 0;
  const tokensA = englishTokenize(nameA);
  const tokensB = englishTokenize(nameB);
  if (!tokensA.length || !tokensB.length) return 0;

  // Score each tokenA against best tokenB (greedy, no rematch)
  const usedB = new Set();
  let totalScore = 0;
  let aMatched = 0;
  let bMatchedCount = 0;
  for (const ta of tokensA) {
    let best = 0;
    let bestIdx = -1;
    for (let i = 0; i < tokensB.length; i++) {
      if (usedB.has(i)) continue;
      const s = tokenSimilarity(ta, tokensB[i]);
      if (s > best) { best = s; bestIdx = i; }
    }
    if (bestIdx >= 0 && best > 0.5) {
      usedB.add(bestIdx);
      totalScore += best;
      aMatched++;
    }
  }
  bMatchedCount = usedB.size;

  // Hybrid normalization. The naive "max tokens" denominator
  // punishes the common case where the portal stores a short form
  // ("SADAKATHULLAH") of a long MOL name ("SADAKATHULLAH SHADULY
  // PALAYAM MEERA SAHIB") — the score lands at 0.2 even though it's
  // unambiguously the same person. We lift such cases via a
  // SUBSET BONUS: when ALL tokens of the shorter name are matched
  // strongly in the longer name, bump the final score so the row
  // surfaces as a confident match.
  const lenA = tokensA.length;
  const lenB = tokensB.length;
  const maxLen = Math.max(lenA, lenB);
  const minLen = Math.min(lenA, lenB);
  let score = totalScore / maxLen;

  // Subset bonus — applies when one side is fully (or near-fully)
  // covered by the other. The shorter side IS contained in the
  // longer side. Only applies if all of the smaller set matched
  // and the smaller set is small (≤3 tokens, the common portal-
  // name length).
  //
  // Guard against single-token portal-name false positives: when
  // minLen===1, only apply the bonus if the matched token is at
  // least 6 characters AND the match was strong (≥0.85). This
  // filters out cases like portal "FAHAD" (5 chars, common name)
  // accidentally bonus-promoted against any MOL row containing a
  // distantly-similar token. Long-token single-name portals like
  // "SADAKATHULLAH" (13 chars) still get the full bonus.
  const aFullyMatched = aMatched === lenA;
  const bFullyMatched = bMatchedCount === lenB;
  if ((aFullyMatched || bFullyMatched) && minLen >= 1 && minLen <= 3) {
    let bonusEligible = true;
    if (minLen === 1) {
      // Find the matched token from the shorter side
      const shorterTokens = lenA <= lenB ? tokensA : tokensB;
      const matchedToken = shorterTokens[0];
      // Only allow single-token bonus if the token is long enough
      // to be a meaningful identifier (not common given names like
      // FAHAD, ALI, SAAD, OMAR which would over-match).
      if (!matchedToken || matchedToken.length < 6) {
        bonusEligible = false;
      } else {
        // And require that the average per-token score from the
        // match is high (≥0.85) — for a single matched token, this
        // means the actual token similarity must be strong.
        const avg = totalScore / Math.max(aMatched, 1);
        if (avg < 0.85) bonusEligible = false;
      }
    }
    if (bonusEligible) {
      const minNorm = totalScore / minLen;
      const blend = minLen === 1 ? 0.75 : minLen === 2 ? 0.6 : 0.45;
      score = score * (1 - blend) + minNorm * blend;
    }
  }

  return Math.min(score, 1.0);
}

// Tokenize an English name by stripping punctuation, dashes, and
// known connectors. Uppercased for consistent comparisons.
function englishTokenize(name) {
  if (!name) return [];
  const cleaned = String(name)
    .toUpperCase()
    .replace(/[.,()'"]/g, '')      // strip punctuation
    .replace(/-/g, ' ')            // dash → space ("AL-SUBAIE" → "AL SUBAIE")
    .replace(/\s+/g, ' ')
    .trim();
  const STOP = new Set(['BIN', 'BINT', 'IBN', 'ABU', 'UM', 'AL']);
  return cleaned
    .split(/\s+/)
    .filter(t => t.length > 1)
    .filter(t => !STOP.has(t));
}

// Compute similarity between two single tokens (uppercase Latin).
// Combines exact match, prefix, and edit-distance signals.
function tokenSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1.0;

  // Prefix match — common transliteration variants typically share
  // a long prefix (MOHAMMED / MOHAMMAD / MUHAMMAD all share "MOHAM"
  // or "MUHAM"). 4 chars catches the genuine matches without
  // false-positives on short common roots.
  const minLen = Math.min(a.length, b.length);
  if (minLen >= 4) {
    if (a.slice(0, 4) === b.slice(0, 4)) {
      const common = commonPrefixLength(a, b);
      return Math.min(0.85 + (common / Math.max(a.length, b.length)) * 0.15, 0.97);
    }
  }

  // Edit-distance fallback. Use a RATIO threshold (distance / maxLen
  // ≤ 0.25) rather than absolute distance — distance 2 on a 5-char
  // name (AWAD vs FAHAD) is 40% of length and shouldn't count, but
  // distance 2 on an 8-char name (SUBAIE vs ALSUBAIE) is 25% and
  // should. Distance 1 always counts when both names are ≥4 chars.
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (dist === 1 && maxLen >= 4) {
    return 1.0 - (1 / maxLen) * 0.4;   // 4-char name w/ 1 edit → 0.9
  }
  if (dist >= 2 && maxLen >= 6 && dist / maxLen <= 0.25) {
    return 1.0 - (dist / maxLen) * 0.6;
  }

  // Substring match — portal name might be a partial of MOL or vice
  // versa. Require both ≥ 5 chars to avoid trivial substrings (FAH
  // matching FAHAD inside FAHD-something).
  if (a.length >= 5 && b.length >= 5) {
    if (a.includes(b) || b.includes(a)) return 0.6;
  }

  return 0;
}

function commonPrefixLength(a, b) {
  const m = Math.min(a.length, b.length);
  let i = 0;
  while (i < m && a[i] === b[i]) i++;
  return i;
}

// Standard Levenshtein edit distance, iterative O(n*m) memory.
// For typical name token lengths (5-12 chars) this runs in ~100µs.
function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ac = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
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

// ─── Canonical name builder ─────────────────────────────────────────
//
// Given the raw `arabic_name` field from the MOL file, returns an
// uppercase English-script "canonical" name suitable for the portal's
// `employees.name` column. This is what gets written when admin
// applies a sync — overwriting whatever informal English spelling
// the portal previously held.
//
// Strategy:
//   1. Decide if the name is already Latin-script or Arabic-script.
//      Most non-Arab nationalities (Indian, Pakistani, Filipino,
//      Chinese) already have Latin-script names in the MOL file.
//      Only Arab nationals (Saudi, Egyptian, Sudanese, Palestinian)
//      need Arabic-to-English transliteration.
//   2. For Latin: strip placeholder dashes ("MELVIN - ROMULO" →
//      "MELVIN ROMULO"), collapse whitespace, uppercase.
//   3. For Arabic: tokenize, transliterate each token via a
//      dictionary of common Saudi names (covers ~80% of given
//      names with their preferred English spelling — e.g. "محمد"
//      → "MOHAMMED" not "MHMD"). Fall back to letter-by-letter
//      romanization for unknown tokens. Special handling for
//      compound names (عبد + الله = "ABDULLAH", آل + Family =
//      "AL FAMILY").
export function canonicalEnglishName(arabicOrLatinName) {
  if (!arabicOrLatinName) return null;
  const raw = String(arabicOrLatinName).trim();
  if (!raw) return null;
  // Detect script — if the string contains any Arabic codepoint,
  // treat it as Arabic; otherwise Latin.
  const hasArabic = /[\u0600-\u06FF]/.test(raw);
  if (hasArabic) {
    return transliterateArabicName(raw);
  }
  return formatLatinName(raw);
}

// ─── Latin-name cleanup ─────────────────────────────────────────────
// MOL has names like:
//   "MELVIN - ROMULO MANCENIDO" (dashes used as placeholders for
//                                missing middle names)
//   "KHAJA - - MUJEEBUR RAHMAN" (multiple placeholder dashes)
//   "CHUNG HSING   HO"          (multiple spaces from form input)
// Convert all of these to clean uppercase single-space form.
function formatLatinName(s) {
  return s
    // Replace any run of whitespace + lone dashes + whitespace with
    // a single space. Matches "X - Y", "X - - Y", "X - - - Y" etc.
    .replace(/(\s+-)+\s+/g, ' ')
    // Strip leading/trailing standalone dashes
    .replace(/^[-\s]+|[-\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// ─── Arabic-to-English transliteration ──────────────────────────────
//
// A curated dictionary of common Saudi/Arab given names with their
// preferred English spellings. This is what makes the output read
// naturally — letter-by-letter romanization gives you "MHMD" but
// the dictionary gives you "MOHAMMED".
//
// Pattern: each entry maps an Arabic spelling → preferred English
// spelling in ALL CAPS. The dictionary is consulted token-by-token
// before the rule-based fallback runs.
const ARABIC_NAME_DICT = {
  // ─── Compound names (must be matched as a unit) ─────────────────
  'عبدالله':       'ABDULLAH',
  'عبدالرحمن':    'ABDULRAHMAN',
  'عبدالعزيز':    'ABDULAZIZ',
  'عبدالمحسن':    'ABDULMOHSEN',
  'عبدالكريم':    'ABDULKARIM',
  'عبدالمجيد':    'ABDULMAJEED',
  'عبدالاله':     'ABDULELAH',
  'عبدالإله':     'ABDULELAH',
  'عبدالحميد':    'ABDULHAMID',
  'عبدالرحيم':    'ABDULRAHIM',
  'عبدالغني':     'ABDULGHANI',
  'عبدالحكيم':    'ABDULHAKIM',
  'عبدالقادر':    'ABDULQADER',
  'عبدالرزاق':    'ABDULRAZAQ',
  'عبدالسلام':    'ABDULSALAM',
  'عبدالواحد':    'ABDULWAHID',
  'عبدالناصر':    'ABDULNASSER',

  // ─── Common male given names ─────────────────────────────────────
  'محمد':         'MOHAMMED',
  'مُحَمَّد':       'MOHAMMED',
  'أحمد':         'AHMED',
  'احمد':         'AHMED',
  'محمود':        'MAHMOUD',
  'خالد':         'KHALID',
  'سعيد':         'SAEED',
  'سعد':          'SAAD',
  'سلطان':        'SULTAN',
  'سليمان':       'SULAIMAN',
  'سامي':         'SAMI',
  'صالح':         'SALEH',
  'ابراهيم':      'IBRAHIM',
  'إبراهيم':      'IBRAHIM',
  'يوسف':         'YOUSEF',
  'علي':          'ALI',
  'عمر':          'OMAR',
  'حسن':          'HASSAN',
  'حسين':         'HUSSEIN',
  'طارق':         'TARIQ',
  'ناصر':         'NASSER',
  'ناصير':        'NASIR',
  'نواف':         'NAWAF',
  'فهد':          'FAHD',
  'فيصل':         'FAISAL',
  'بدر':          'BADR',
  'ماجد':         'MAJED',
  'ياسر':         'YASSER',
  'وليد':         'WALID',
  'بسام':         'BASSAM',
  'بشار':         'BASHAR',
  'جاسم':         'JASIM',
  'مساعد':        'MUSAID',
  'مصطفى':        'MUSTAFA',
  'مشعل':         'MISHAL',
  'منصور':        'MANSOUR',
  'موسى':         'MUSA',
  'هاني':         'HANI',
  'هيثم':         'HAITHAM',
  'حمد':          'HAMAD',
  'حمدان':        'HAMDAN',
  'رياض':         'RIYADH',
  'رائد':         'RAED',
  'رامي':         'RAMI',
  'سلمان':        'SALMAN',
  'شاهر':         'SHAHIR',
  'صباح':         'SABAH',
  'طلال':         'TALAL',
  'عادل':         'ADEL',
  'عاصم':         'ASIM',
  'عبدالحفيظ':    'ABDULHAFEZ',
  'عبدالنبي':     'ABDULNABI',
  'عوض':          'AWAD',
  'فايز':         'FAYEZ',
  'كمال':         'KAMAL',
  'مأمون':        'MAMOUN',
  'مازن':         'MAZEN',
  'محسن':         'MOHSIN',
  'مسعود':        'MASOUD',
  'معاذ':         'MUATH',
  'معتز':         'MUTAZ',
  'منير':         'MUNIR',
  'هشام':         'HISHAM',
  'وائل':         'WAEL',
  'يحيى':         'YAHYA',
  'زيد':          'ZAID',
  'شريف':         'SHARIF',
  'فراس':         'FIRAS',
  'طاهر':         'TAHER',
  'ظافر':         'ZAFER',
  'فرج':          'FARAJ',
  'الطيب':        'AL-TAYEB',
  'حذيفة':        'HUDHAIFA',
  'بدريه':        'BADRIAH',
  'بدرية':        'BADRIAH',
  'زكي':          'ZAKI',
  'جعفر':         'JAFAR',
  'درويش':        'DARWISH',
  'عباس':         'ABBAS',
  'عبد':          'ABDUL',
  'حذيفة':        'HUDHAIFA',
  'مسيب':         'MUSAID',
  'مسوي':         'MASOWI',
  'فرحان':        'FARHAN',
  'صفوان':        'SAFWAN',
  'تركي':         'TURKI',
  'ضافي':         'DAFI',
  'وضاح':         'WADDAH',
  'كمال':         'KAMAL',
  'تيسير':        'TAYSIR',
  'ربيع':         'RABEEA',
  'سلامة':        'SALAMA',
  'يعقوب':        'YAQOUB',
  'حذيفه':        'HUDHAIFA',
  'بشائر':        'BASHAIER',
  'بشاير':        'BASHAIER',
  'اريج':         'AREEJ',
  'نوره':         'NORA',
  'نورة':         'NORA',
  'بسمه':         'BASMA',
  'بسمة':         'BASMA',
  'شهد':          'SHAHAD',
  'سحر':          'SAHAR',
  'امينه':        'AMINA',
  'أمينة':        'AMINA',
  'بدور':         'BUDOOR',
  'معالي':        'MAALI',
  'نجود':         'NAJOUD',
  'غلا':          'GHALA',
  'حسان':         'HASSAN',
  'حيدر':         'HAIDER',
  'حبيب':         'HABIB',
  'فردان':        'FARDAN',
  'جواد':         'JAWAD',
  'الشيخ':        'AL-SHEIKH',
  'صادق':         'SADIQ',
  'فؤاد':         'FOUAD',
  'فواد':         'FOUAD',
  'فهيد':         'AL-FAHEED',
  'الفهيد':       'AL-FAHEED',
  'صقر':          'SAQR',
  'الشريف':       'AL-SHARIF',
  'الربيع':       'AL-RABEEA',
  'الناشري':      'AL-NASHRI',
  'الياسي':       'AL-YASI',
  'البراهيم':     'AL-IBRAHIM',
  'الحسين':       'AL-HUSSEIN',
  'الحسن':        'AL-HASSAN',
  'الحربي':       'AL-HARBI',
  'العواد':       'AL-AWAD',
  'المولد':       'AL-MAWLED',
  'الشايجي':      'AL-SHAYJI',
  'المعيصب':      'AL-MUAISEB',
  'الطاسان':      'AL-TASAN',
  'حكمي':         'HAKAMI',
  'قاسمي':        'QASIMI',
  'عبيد':         'OBAID',
  'بالعبيد':      'BAL-OBAID',
  'مبارك':        'MUBARAK',
  'عواد':         'AWWAD',
  'عواجي':        'AWAJI',
  'المنصف':       'AL-MUNSIF',
  'الشرقاوى':     'AL-SHARQAWI',
  'الشرقاوي':     'AL-SHARQAWI',
  'الطيب':        'AL-TAYEB',
  'سدس':          'SADAS',
  'الصقلي':       'AL-SAQILI',
  'كاظم':         'KAZIM',
  'ال':           'AL',
  'منصف':         'MUNSIF',
  'المنصف':       'AL-MUNSIF',
  'عثمان':        'OTHMAN',
  'آل عثمان':     'AL OTHMAN',
  'زاهر':         'ZAHIR',
  'جابر':         'JABER',
  'عابد':         'ABED',
  'النبي':        'AL-NABI',
  'النبى':        'AL-NABI',
  'عبدرب':        'ABDUL-RAB',
  'اليوسف':       'AL-YOUSEF',
  'حذيفة':        'HUDHAIFA',
  'ندى':          'NADA',
  'نضمى':         'NADHMA',
  'شذى':          'SHATHA',
  'شذا':          'SHATHA',
  'شباب':         'SHABAB',

  // ─── Common female given names ───────────────────────────────────
  'بشاير':        'BASHAIER',
  'سارة':         'SARAH',
  'ساره':         'SARAH',
  'عائشة':        'AISHA',
  'فاطمة':        'FATIMA',
  'خديجة':        'KHADIJA',
  'مريم':         'MARIAM',
  'نوال':         'NAWAL',
  'هبة':          'HEBA',
  'سلمى':         'SALMA',
  'مها':          'MAHA',
  'رشا':          'RASHA',
  'ريم':          'REEM',
  'رنا':          'RANA',
  'نور':          'NOOR',
  'هدى':          'HUDA',
  'دلال':         'DALAL',
  'ابتسام':       'IBTISAM',
  'منال':         'MANAL',
  'ليلى':         'LAILA',
  'سعاد':         'SUAD',
  'سميرة':        'SAMIRA',
  'هند':          'HIND',
  'لينا':         'LINA',
  'عبير':         'ABEER',
  'دانة':         'DANA',
  'رهف':          'RAHAF',

  // ─── Common family-name prefixes / tribes ────────────────────────
  'الدوسري':      'AL-DOSARI',
  'الفزيع':       'AL-FAZEEA',
  'الغامدي':      'AL-GHAMDI',
  'القحطاني':     'AL-QAHTANI',
  'الشهراني':     'AL-SHAHRANI',
  'العتيبي':      'AL-OTAIBI',
  'الزهراني':     'AL-ZAHRANI',
  'المالكي':      'AL-MALKI',
  'الحربي':       'AL-HARBI',
  'العنزي':       'AL-ANAZI',
  'القرني':       'AL-QARNI',
  'الشمري':       'AL-SHAMMARI',
  'الرشيدي':      'AL-RASHIDI',
  'المطيري':      'AL-MUTAIRI',
  'البلوي':       'AL-BALAWI',
  'الجهني':       'AL-JOHANI',
  'الفيفي':       'AL-FIFI',
  'الأحمدي':      'AL-AHMADI',
  'الخالدي':      'AL-KHALIDI',
  'السبيعي':      'AL-SUBAIE',
  'السبيهي':      'AL-SUBAIHI',
  'الصاعدي':      'AL-SAEDI',
  'الأكلبي':      'AL-AKLABI',
  'الحارثي':      'AL-HARTHI',
  'الياسي':       'AL-YASI',
  'الشرقاوى':     'AL-SHARQAWI',
  'الشرقاوي':     'AL-SHARQAWI',
  'ابوحوسه':      'ABU-HAWSA',

  // ─── Connectors that should produce an explicit token ────────────
  'بن':           'BIN',
  'ابن':          'BIN',
  'بنت':          'BINT',
  'آل':           'AL',
  'ابو':          'ABU',
  'أبو':          'ABU',
};

/**
 * Transliterate an Arabic-script name to uppercase English.
 * Token-level dictionary lookup with rule-based fallback.
 *
 * Special handling:
 *   • "عبد" followed by a token starting with "ال" is combined
 *     into a single ABDUL-X compound (e.g. "عبد" + "المنصف" →
 *     "ABDULMUNSEF"). MOL data sometimes has these as two tokens.
 *   • Diacritics stripped before dictionary lookup.
 *   • "على" treated as variant of "علي" (Ali).
 */
function transliterateArabicName(arabic) {
  // Strip Arabic diacritics so dictionary keys match
  const stripped = arabic.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');

  // Treat "على" as variant of "علي" (both pronounced Ali in Saudi/
  // Egyptian usage; the MOL file uses both forms inconsistently).
  // No global hamza→alif normalization — that breaks آل lookups
  // since "آل" is a distinct connector ("family of").
  let normalized = stripped.replace(/على(?=\s|$)/g, 'علي');

  let tokens = normalized.split(/\s+/).filter(t => t.length > 0);

  // Combine compound Abdul: when one token is "عبد" and the next
  // starts with "ال", join them. Example: "عبد", "المنصف" →
  // "عبدالمنصف".
  const merged = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === 'عبد' && i + 1 < tokens.length && tokens[i + 1].startsWith('ال')) {
      merged.push(tokens[i] + tokens[i + 1]);
      i++;
    } else {
      merged.push(tokens[i]);
    }
  }

  const englishTokens = merged
    .map(t => {
      // 1. Direct dictionary hit (covers compounds like عبدالله too)
      const dictHit = ARABIC_NAME_DICT[t];
      if (dictHit) return dictHit;
      // 2. Compound abdul not in dictionary — strip "عبدال" prefix,
      //    look up the rest in the dictionary if possible, else
      //    rule-based romanize. Prepend ABDUL-.
      if (t.startsWith('عبدال')) {
        const rest = t.slice(5);
        // Try dictionary on the bare suffix and on the suffix with
        // "ال" prefix (e.g. dict has "المنصف" → "AL-MUNSIF")
        const restDict = ARABIC_NAME_DICT[rest] || ARABIC_NAME_DICT['ال' + rest];
        if (restDict) {
          // Strip any leading "AL-" so we don't end up with
          // ABDULAL-MUNSIF — we want ABDUL-MUNSIF
          return 'ABDUL-' + restDict.replace(/^AL-/, '');
        }
        return 'ABDUL-' + romanizeAndUppercase(rest).replace(/^AL-/, '');
      }
      return romanizeAndUppercase(t);
    })
    .filter(t => t && t.length > 0);

  return englishTokens.join(' ');
}

/**
 * Letter-by-letter Arabic-to-Latin transliteration with a final
 * uppercase pass. Used when no dictionary entry matches.
 * Also inserts a short "A" between consecutive consonants — without
 * this, undiacritized Arabic ("بدريه") romanizes as a stack of
 * consonants ("BDRYH"). Inserting "A" gives "BADRYH" which is much
 * closer to natural English ("BADRIA"). Imperfect but useful for
 * names not in the dictionary.
 */
function romanizeAndUppercase(arabicWord) {
  if (!arabicWord) return '';
  let s = arabicWord;
  // Strip diacritics
  s = s.replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '');
  // Special handling for "ال" prefix → "AL-"
  let prefix = '';
  if (s.startsWith('ال')) {
    prefix = 'AL-';
    s = s.slice(2);
  }
  // Apply transliteration pairs in order (multi-char first)
  for (const [from, to] of AR_TRANS_PAIRS_FINAL) {
    s = s.split(from).join(to);
  }
  // Strip any remaining non-Latin chars
  s = s.replace(/[^a-zA-Z'-]/g, '');
  // Insert short "a" between consonant runs of 3+. Treats vowels
  // as a/e/i/o/u (and 'y' loosely). Three consonants in a row are
  // unpronounceable in English-speaker reading; "BDRYH" → "BADRYH"
  // by splitting after the first consonant.
  s = s.replace(/([bcdfghjklmnpqrstvwxz]{3,})/gi, (m) => {
    let out = '';
    for (let i = 0; i < m.length; i++) {
      out += m[i];
      // Insert vowel between every consecutive pair after position 0
      if (i > 0 && i < m.length - 1) out += 'a';
    }
    return out;
  });
  return (prefix + s).toUpperCase();
}

// Letter-pair table tuned for proper-noun output. Differences from
// the matching-helper table above: prefers naturalistic English
// spellings (e.g. ع → A, not 'a'; ج → J; ق → Q).
const AR_TRANS_PAIRS_FINAL = [
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
  ['ع',   'a'],
  ['غ',   'gh'],
  ['ف',   'f'],
  ['ق',   'q'],
  ['ك',   'k'],
  ['ل',   'l'],
  ['م',   'm'],
  ['ن',   'n'],
  ['ه',   'h'],   ['ة', 'a'],
  ['و',   'w'],
  ['ي',   'y'],   ['ئ', 'y'],   ['ؤ', 'w'],
  ['ء',   ''],
];

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
