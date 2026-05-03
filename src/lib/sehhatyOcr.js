// =============================================================================
// sehhatyOcr.js
//
// OCR layer for the Sehhaty inquiry result screenshot. Bashaier
// pastes or drops the screenshot into the cross-check modal; this
// module reads the image client-side using Tesseract.js and returns
// the structured fields needed to auto-fill the cross-check form.
//
// Why client-side OCR (not a vision API):
//   • Employee health data never leaves the browser. The Sehhaty
//     screenshot contains medical/leave info and a national ID
//     number; sending it to a third-party API would require new
//     compliance review.
//   • No API key to manage or rotate.
//   • Works offline once the language model is cached by the
//     browser (~4MB one-time download, persists).
//
// Parsing strategy:
//   The Sehhaty result page is digital text rendered as an image
//   (not a photo or scan), so OCR is highly reliable for the
//   numeric and Latin-character fields we care about most:
//     • Leave ID (Latin prefix + digits, e.g. GSL26042340605, PSL260430135678)
//     • National ID / Iqama (10 digits)
//     • Dates (YYYY-MM-DD)
//     • Day count (single digit usually)
//
//   We use Tesseract with English + Arabic so we can also pick
//   up the patient name, doctor name, and specialty in raw form.
//   These are stored as 'seen_*' values for the audit record but
//   the cross-check doesn't require them to match — Bashaier
//   confirms visually that the right person is on the screen.
//
// Public API:
//   loadOcrEngine()              — preload the worker (optional)
//   extractFromImage(blobOrFile) — runs OCR + parsing, returns
//                                  { leaveId, idNumber, startDate,
//                                    endDate, days, issueDate,
//                                    name, doctor, specialty,
//                                    confidence, rawText }
// =============================================================================

// Lazy-loaded Tesseract worker. Held as a singleton so successive
// pastes within the same session reuse the loaded language model.
// The model is ~4MB — not free to redownload.
let _workerPromise = null;

/**
 * Get (or create) the Tesseract worker. Called by extractFromImage
 * but also exported separately so the modal can warm it up while
 * Bashaier is still typing, hiding the cold-start delay.
 */
export async function loadOcrEngine() {
  if (_workerPromise) return _workerPromise;
  _workerPromise = (async () => {
    // Dynamic import so Tesseract isn't pulled into the main bundle
    // — only loaded the first time someone opens the cross-check
    // modal and uses the OCR feature. Keeps the rest of the app fast.
    const Tesseract = (await import('tesseract.js')).default;
    // English + Arabic. Both models load from the CDN and are cached
    // by the browser after first download. createWorker takes a
    // string or array of language codes.
    const worker = await Tesseract.createWorker(['eng', 'ara']);
    return worker;
  })();
  return _workerPromise;
}

/**
 * Run OCR on a Blob/File, parse the recognized text into structured
 * Sehhaty fields, and return the result. The full OCR text is also
 * returned (rawText) so the UI can show a fallback if parsing fails
 * to find a particular field.
 *
 * @param {Blob|File|string} imageInput — image to read. Accepts a
 *   Blob (from clipboard paste), a File (from drag-drop), or a
 *   data-URL / object-URL string.
 * @returns {Promise<{
 *   leaveId, idNumber, startDate, endDate, days, issueDate,
 *   name, doctor, specialty, confidence, rawText
 * }>}
 */
export async function extractFromImage(imageInput) {
  const worker = await loadOcrEngine();
  // Preprocess the image before OCR. Two transforms applied:
  //   1. Scale up to ~2x if the source is small (<1500px wide).
  //      Tesseract's accuracy on Arabic glyphs degrades sharply
  //      below ~30px per character; scaling up a tight Sehhaty
  //      screenshot to roughly print-quality resolution gives the
  //      OCR engine more pixels per glyph to work with.
  //   2. Convert to greyscale and slightly increase contrast.
  //      Removes Sehhaty's faint blue/grey backdrop and makes the
  //      black-on-white text crisper.
  // If preprocessing fails for any reason (e.g. the image input
  // is already a string URL we can't process), we fall back to
  // recognising the original input directly.
  let inputForOcr = imageInput;
  try {
    inputForOcr = await preprocessImage(imageInput);
  } catch {
    // fall through to raw input
  }
  const result = await worker.recognize(inputForOcr);
  const text = result?.data?.text || '';
  const confidence = result?.data?.confidence ?? 0;

  return {
    ...extractFieldsFromText(text),
    confidence,
    rawText: text,
  };
}

/**
 * Pure text-to-fields extractor. Takes raw text (from any source —
 * Tesseract OCR, PDF text-layer extraction, paste-from-clipboard) and
 * runs the same regex pipeline. Returns the same field shape as
 * extractFromImage minus confidence/rawText (which are OCR-specific).
 *
 * Exported so the PDF extractor (sehhatyPdfExtract.js) can reuse the
 * same matchers without duplicating the patterns. Single source of
 * truth for "what does a Sehhaty cert look like as text".
 */
export function extractFieldsFromText(text) {
  return {
    leaveId:    matchLeaveId(text),
    idNumber:   matchIdNumber(text),
    startDate:  matchStartDate(text),
    endDate:    matchEndDate(text),
    days:       matchDays(text),
    issueDate:  matchIssueDate(text),
    name:       matchPatientName(text),
    doctor:     matchDoctorName(text),
    specialty:  matchSpecialty(text),
  };
}

/**
 * Preprocess a Blob/File for OCR.
 *   • Loads the image into a canvas
 *   • Scales up if narrower than 1500px (target ~2x source width
 *     up to a 3000px ceiling; bigger doesn't help and just slows
 *     OCR down)
 *   • Greyscales each pixel and applies a mild contrast bump
 *     (multiply around mid-grey) so faint text gets pulled toward
 *     pure black and faint backdrop tints get pushed toward white.
 *   • Returns a Blob (PNG) ready for tesseract.recognize.
 *
 * Runs entirely on the canvas — no server round-trip, no extra
 * libraries.
 */
async function preprocessImage(blob) {
  if (typeof blob === 'string') return blob; // already a data URL
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    // Target width: 2x source, capped at 3000px, but never less
    // than the source. Small screenshots benefit most from
    // upscaling; a 2400px source gets passed through unchanged.
    const targetW = Math.min(3000, Math.max(img.naturalWidth, img.naturalWidth * 2));
    const scale = targetW / img.naturalWidth;
    const targetH = Math.round(img.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    // imageSmoothingEnabled with 'high' quality scales bicubically
    // — preserves glyph shapes much better than nearest-neighbor
    // for Arabic, which has a lot of curved strokes.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, targetW, targetH);
    ctx.drawImage(img, 0, 0, targetW, targetH);

    // Greyscale + contrast bump. The contrast curve here is a
    // simple linear push around midpoint:
    //   out = clamp(((in - 128) * 1.4) + 128, 0, 255)
    // with a slightly lower midpoint pivot (110) so light-grey
    // backdrop pushes white faster than dark text pushes black.
    const data = ctx.getImageData(0, 0, targetW, targetH);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      // luma weights — keeps Arabic glyphs more uniform than a
      // simple average since Arabic ink is typically pure black
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      let v = (lum - 110) * 1.4 + 128;
      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      px[i] = v; px[i + 1] = v; px[i + 2] = v;
    }
    ctx.putImageData(data, 0, 0);

    // Return as Blob — Tesseract can take any of (Blob, File,
    // canvas, dataURL, ImageData), but Blob is the lightest path.
    return await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b || blob), 'image/png')
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ─── Field extractors ─────────────────────────────────────────────────────────
//
// Each helper returns the matched value or null. We're forgiving
// about whitespace and trailing punctuation since OCR can introduce
// stray characters around words.

/**
 * Sehhaty leave-ID prefix taxonomy.
 *
 * Sehhaty assigns DIFFERENT 3-letter Latin prefixes depending on
 * the leave type and the issuing clinic class. Sehhaty's prefix
 * list is not publicly documented — we maintain this list based
 * on real-world certs we've validated end-to-end against the Seha
 * platform. Add a prefix here only after seeing a valid cert with
 * that prefix.
 *
 * Adding new prefixes:
 *   1. A staff member uploads a PDF whose leave ID has an unknown
 *      prefix (something other than the entries below).
 *   2. The matcher still extracts it (we accept any 3-letter Latin
 *      prefix to be forgiving — see `matchLeaveId` below) but
 *      console-warns 'Sehhaty leave-ID prefix not in known list'.
 *   3. Bashaier verifies the cert is real on Seha.sa.
 *   4. If real, add the prefix to this list with a comment about
 *      what kind of cert it came from.
 *
 * Known prefixes (verified against real certs):
 *   GSL — General Sick Leave (typical case from public hospitals)
 *   PSL — Private Sick Leave (private clinics, e.g. dental)
 *
 * Suspected but not yet verified (do NOT add until a real cert is seen):
 *   MSL — likely maternity leave
 *   CSL — likely companion / accompanying patient leave
 *   ESL — likely emergency or extended sick leave
 *   These suspicions come from Sehhaty's leave-type listings; they
 *   haven't crossed our desk yet so we don't claim knowledge of them.
 *   The matcher will still accept these (and any other 3-letter
 *   prefix) and log a warning — adding them here only happens after
 *   we've validated end-to-end.
 */
export const SEHHATY_KNOWN_PREFIXES = ['GSL', 'PSL'];

/** Sehhaty leave ID matcher.
 *
 *  Pattern: 3 Latin letters + optional hyphen + 10-16 alphanumerics.
 *  Why no space: real Sehhaty IDs are always one contiguous token,
 *  so allowing 'A space B' would let any English 3-letter word next
 *  to a long number falsely match (e.g. 'THE 12345678901234' on a
 *  PDF that happens to have those words near each other).
 *
 *  Forgiveness vs. strictness:
 *  We accept ANY 3-letter prefix here — we don't restrict to the
 *  known list above — because Sehhaty silently introduces new
 *  prefixes for new leave types and we don't want to break on
 *  something like a future MSL cert. Instead, when an extracted
 *  ID's prefix isn't in SEHHATY_KNOWN_PREFIXES, we log a warning
 *  to the console so we can spot the new prefix and add it after
 *  Bashaier validates a sample. Bashaier's manual cross-check on
 *  Seha.sa is the actual source of truth — the regex's job is
 *  just to pull the candidate out of the text stream.
 *
 *  Example matches:
 *    GSL26042340605       → {GSL: known}
 *    PSL260430135678      → {PSL: known}
 *    GSL-26042340605      → {GSL: known}, hyphen tolerated
 *    psl260430135678      → {PSL: known}, lowercased input
 *    XYZ26042340605       → extracted, console-warns "unknown prefix" */
function matchLeaveId(text) {
  const m = text.match(/\b([A-Z]{3}-?[A-Z0-9]{10,16})\b/i);
  if (!m) return null;
  const normalised = m[1].replace(/[\s-]/g, '').toUpperCase();
  // Tag the candidate prefix as known/unknown so callers (and us
  // looking at the console while we expand the system) can spot
  // any new Sehhaty prefix before it surprises us in production.
  const prefix = normalised.slice(0, 3);
  if (!SEHHATY_KNOWN_PREFIXES.includes(prefix)) {
    // eslint-disable-next-line no-console
    console.warn(
      `[sehhaty] Extracted a leave ID with unknown prefix "${prefix}" (full: ${normalised}). ` +
      `If this turns out to be a valid cert, add the prefix to SEHHATY_KNOWN_PREFIXES in sehhatyOcr.js.`
    );
  }
  return normalised;
}

/** Saudi national ID / Iqama — 10 digits. The Sehhaty page shows it
 *  in its own row right under the leave ID. We pick the first
 *  10-digit run that isn't part of a date. */
function matchIdNumber(text) {
  // Strip dates (YYYY-MM-DD AND DD-MM-YYYY AND Hijri YYYY-MM-DD with leading 14)
  // so they don't get mis-matched as IDs. Hijri years are 14xx;
  // Gregorian dates here are 20xx.
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{2}-\d{2}-\d{4}\b/g, '')
    .replace(/\b\d{2}-\d{2}-14\d{2}\b/g, '')   // Hijri DD-MM-YYYY
    .replace(/\b14\d{2}-\d{2}-\d{2}\b/g, '');  // Hijri YYYY-MM-DD
  const m = cleaned.match(/\b(\d{10})\b/);
  return m ? m[1] : null;
}

/** Sehhaty issues two distinct cert layouts that we need to handle:
 *
 *  LAYOUT A — the inquiry-result page on Seha.sa (what Bashaier sees
 *    when she pastes a screenshot).
 *    Arabic labels:
 *      تبدأ من               → start
 *      وحتى                  → end
 *      تاريخ إصدار تقرير الإجازة  → issue
 *
 *  LAYOUT B — the actual sick-leave certificate PDF (what staff
 *    upload via Path B).
 *    Arabic labels:
 *      تاريخ الدخول           → admission/start
 *      تاريخ الخروج           → discharge/end
 *      تاريخ إصدار التقرير    → issue
 *    English labels (right column of bilingual table):
 *      Admission Date        → start
 *      Discharge Date        → end
 *      Issue Date            → issue
 *
 *  Each matcher tries the labels FIRST (most reliable — anchors the
 *  date to its semantic role) and falls back to date-position
 *  heuristics only if no label is found. The English-label fallback
 *  helps when Tesseract's Arabic OCR confidence is low or the PDF's
 *  text-layer extraction stitched things in an order that makes the
 *  Arabic regex miss. */

/** Find a YYYY-MM-DD date that follows one of the given Arabic or
 *  English labels, scanning a 200-char window after the label. */
function findDateAfterLabel(text, labels) {
  for (const label of labels) {
    const idx = text.search(label);
    if (idx < 0) continue;
    const window = text.slice(idx, idx + 200);
    // Prefer Gregorian (20xx) — Hijri dates (14xx) are present in
    // the same window on the bilingual PDF and we don't want them.
    const greg = window.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
    if (greg) return greg[1];
    // Fall back to DD-MM-YYYY format if that's how the cert phrases it.
    const ddmmyyyy = window.match(/\b(\d{2}-\d{2}-20\d{2})\b/);
    if (ddmmyyyy) {
      // Convert to ISO YYYY-MM-DD for consistency with the rest of
      // the system.
      const [d, m, y] = ddmmyyyy[1].split('-');
      return `${y}-${m}-${d}`;
    }
  }
  return null;
}

/** Start date — first try labels, then fall back to date-position. */
function matchStartDate(text) {
  // Layout A (screenshot): تبدأ من
  // Layout B (PDF):        تاريخ الدخول / Admission Date
  const fromLabel = findDateAfterLabel(text, [
    /تبدأ\s*من/,
    /تاريخ\s*الدخول/,
    /Admission\s*Date/i,
    /Date\s*Admission/i,  // bilingual stitch order
  ]);
  if (fromLabel) return fromLabel;

  // Fallback — use position heuristics for plain date lists.
  const dates = (text.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || []);
  if (dates.length >= 3) return dates[1];
  if (dates.length >= 1) return dates[0];
  return null;
}

/** End date — first try labels, then fall back to date-position. */
function matchEndDate(text) {
  // Layout A: وحتى    Layout B: تاريخ الخروج / Discharge Date
  const fromLabel = findDateAfterLabel(text, [
    /وحتى/,
    /تاريخ\s*الخروج/,
    /Discharge\s*Date/i,
    /Date\s*Discharge/i,
  ]);
  if (fromLabel) return fromLabel;

  const dates = (text.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || []);
  if (dates.length >= 3) return dates[2];
  if (dates.length === 2) return dates[1];
  if (dates.length === 1) return dates[0];
  return null;
}

/** Issue date — first try labels, then fall back to date-position. */
function matchIssueDate(text) {
  // Layout A: تاريخ إصدار تقرير الإجازة
  // Layout B: تاريخ إصدار التقرير / Issue Date / Date Issue
  const fromLabel = findDateAfterLabel(text, [
    /تاريخ\s*إصدار\s*تقرير\s*الإجازة/,
    /تاريخ\s*إصدار\s*التقرير/,
    /Issue\s*Date/i,
    /Date\s*Issue/i,
  ]);
  if (fromLabel) return fromLabel;

  const dates = (text.match(/\b20\d{2}-\d{2}-\d{2}\b/g) || []);
  return dates[0] || null;
}

/** Days count. Most reliable: anchor to the 'المدة بالأيام' label
 *  (Layout A) or the 'Leave Duration' label / '1 day (...)' format
 *  (Layout B) and grab the very next 1-3 digit number. */
function matchDays(text) {
  // Layout B PDF format: '1 day ( 30-04-2026 to 30-04-2026 )' or
  //                      '1 يوم (...)'. We catch both.
  let m = text.match(/(\d{1,3})\s*(?:day|days|يوم|أيام)\b/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 365) return n;
  }

  // Layout A direct label match: 'المدة بالأيام: 1'
  m = text.match(/المدة\s*بالأيام\s*[:：]?\s*(\d{1,3})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 365) return n;
  }

  // Layout A label-window scan
  const labelIdx = text.search(/المدة\s*بالأيام/);
  if (labelIdx >= 0) {
    const after = text.slice(labelIdx, labelIdx + 200)
      .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
      .replace(/\b\d{2}-\d{2}-\d{4}\b/g, '')
      .replace(/\b\d{10}\b/g, '');
    const dm = after.match(/\b(\d{1,3})\b/);
    if (dm) {
      const n = parseInt(dm[1], 10);
      if (n >= 1 && n <= 365) return n;
    }
  }

  // Layout B English label variants
  m = text.match(/(?:Days?|Duration|Period|Leave\s*Duration)\s*[:：]?\s*(\d{1,3})/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 365) return n;
  }

  // Last-resort fallback — first standalone small integer that isn't
  // part of any date or 10-digit ID or leave code.
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b\d{2}-\d{2}-\d{4}\b/g, '')
    .replace(/\b\d{10}\b/g, '')
    .replace(/[A-Z]{3}-?[A-Z0-9]{10,16}/gi, '');
  const candidates = [...cleaned.matchAll(/\b(\d{1,3})\b/g)]
    .map(m => parseInt(m[1], 10))
    .filter(n => n >= 1 && n <= 365);
  if (!candidates.length) return null;
  const small = candidates.find(n => n <= 30);
  return small ?? candidates[0];
}

/** Patient name — Arabic text after 'الاسم:' label.
 *  Robustness work:
 *    • Allow whitespace OR a colon-like character (Arabic colon
 *      '：', Latin ':', or none) between label and value.
 *    • Allow the value to span newlines — Tesseract often inserts
 *      a line break between label and value.
 *    • Accept Arabic letters AND the special hamza/ligature codepoints
 *      that fall outside U+0600-U+06FF (e.g. ﺍ, ﺑ — presentation forms).
 *    • Strip trailing label-like text that may have been over-captured. */
/** Patient name. Two layouts to handle:
 *
 *  Layout A (screenshot): 'الاسم: <Arabic name>'
 *
 *  Layout B (PDF bilingual table):
 *    'الاسم   <Arabic name>   <English name>   Name'
 *  i.e. the value is sandwiched between Arabic and English labels.
 *  The Arabic label sometimes OCRs/extracts as 'الاسم' (correct)
 *  or 'االسم' (with an extra alif from text-layer stitching) so we
 *  match either.
 *
 *  Strategy:
 *  1. Find Arabic value via Arabic label
 *  2. Find Latin value via English 'Name' label
 *  3. Return BOTH joined with em-dash when both present, else
 *     whichever is found.
 *  Showing both gives the staff member the option of recognising
 *  whichever script they prefer, and gives Bashaier the same
 *  transliteration that's on the cert for her cross-check. */
// ─────────────────────────────────────────────────────────────────────
// Bilingual field matchers — patient name, doctor, specialty
//
// Sehhaty PDFs are bilingual tables. Each row is one field, with the
// Arabic label on the right, Arabic value, Latin value, and English
// label on the left:
//
//   [Arabic label]  [Arabic value]  [Latin value]  [English label]
//   ─────────────────────────────────────────────────────────────────
//   الاسم            حسان صالح ...   HASSAN SALEH …  Name
//   رقم الهوية       —               1108624873      Iqama / ID
//   اسم الممارس     عبدالله محمد …   ABDULLAH ...     Practitioner Name
//
// pdfjs's text-extraction (in stitchTextItems) groups items by their
// y-coordinate so each row of the table comes out as ONE line in
// the joined text. So the right strategy is:
//   1. Find the LINE containing the field's English (or Arabic)
//      label.
//   2. Within that line, extract Arabic word runs and Latin word
//      runs separately, filtering out known LABEL words from each.
//   3. Return the values as { arabic, latin }.
//
// The previous regex-on-whole-blob approach was fragile because it
// would over-capture across line boundaries — a 'next field's
// label leaked into prior field's value' problem we kept patching
// with stop-words. Line-based extraction sidesteps the whole issue.
// ─────────────────────────────────────────────────────────────────────

/** Set of Arabic label tokens that should NEVER be returned as a
 *  field value. Used by extractValuesFromLine to filter Arabic
 *  word-runs found on a line. Includes both Sehhaty layouts. */
const ARABIC_LABEL_TOKENS = new Set([
  // patient name
  'الاسم', 'الإسم', 'االسم',
  // iqama
  'رقم', 'الهوية', 'الإقامة', 'اإلقامة',
  // dates
  'تاريخ', 'الدخول', 'الخروج', 'إصدار', 'التقرير', 'تبدأ', 'من', 'وحتى', 'إصدار', 'تقرير', 'الإجازة', 'اإلجازة',
  // duration
  'المدة', 'بالأيام', 'يوم', 'أيام',
  // doctor
  'اسم', 'الطبيب', 'الممارس',
  // specialty / position
  'المسمى', 'الوظيفي', 'الوظيفى',
  // nationality / employer (between fields on PDFs)
  'الجنسية', 'السعودية', 'جهة', 'العمل',
  // misc artifacts
  'رمز', 'مدة', 'اىل', 'الى',
]);

/** Set of English label tokens to filter out of Latin word-runs. */
const ENGLISH_LABEL_TOKENS = new Set([
  'NAME', 'PATIENT', 'IQAMA', 'ID', 'NATIONAL', 'NATIONALITY',
  'SAUDI', 'ARABIA', 'EMPLOYER', 'PRACTITIONER', 'DOCTOR',
  'POSITION', 'SPECIALTY', 'SPECIALITY', 'DATE', 'ADMISSION',
  'DISCHARGE', 'ISSUE', 'LEAVE', 'DURATION', 'PERIOD',
  'KINGDOM', 'OF',
]);

/** Find the FIRST line in the text that matches the predicate.
 *  Returns the line string, or null. */
function findLine(text, predicate) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (predicate(line)) return line;
  }
  return null;
}

/** Extract Arabic and Latin value runs from a single field line.
 *  Filters out known label tokens from each script.
 *  Returns { arabic, latin } with each being a space-joined string
 *  of value words, or null if no values found. */
function extractValuesFromLine(line) {
  if (!line) return { arabic: null, latin: null };

  // Arabic: collect runs of Arabic letters, drop any that are
  // pure label tokens.
  const arabicRuns = [];
  const arabicRe = /[\u0600-\u06FF\uFB50-\uFEFC]+/g;
  let m;
  while ((m = arabicRe.exec(line)) !== null) {
    if (!ARABIC_LABEL_TOKENS.has(m[0])) {
      arabicRuns.push(m[0]);
    }
  }
  const arabic = arabicRuns.length >= 2 ? arabicRuns.join(' ') : null;

  // Latin: collect uppercase or capitalised word runs, filter
  // labels, require at least 2 word tokens.
  // Pattern accepts ALL CAPS (HASSAN), all-caps with single-letter
  // initials (SALEH I ALTASSAN), and Title Case (Senior Registrar).
  const latinTokens = [];
  const latinRe = /\b([A-Z][A-Za-z]*)\b/g;
  while ((m = latinRe.exec(line)) !== null) {
    const tok = m[1];
    if (!ENGLISH_LABEL_TOKENS.has(tok.toUpperCase())) {
      latinTokens.push(tok);
    }
  }
  const latin = latinTokens.length >= 2 ? latinTokens.join(' ') : null;

  return { arabic, latin };
}

/** Patient name. */
function matchPatientName(text) {
  // Find the line that contains the 'Name' English label OR the
  // 'الاسم' Arabic label (any alif-variant). The two are usually
  // on the same line in the bilingual table — finding one finds
  // the row.
  const line = findLine(text, l =>
    /\bName\b/.test(l) ||
    /[\u0627\u0623\u0625\u0622]{1,3}\u0644\u0627?\u0633\u0645/.test(l)
  );
  if (!line) return null;

  // Skip if this line is actually 'Practitioner Name' / 'Doctor Name'
  // — those should match matchDoctorName, not matchPatientName.
  if (/Practitioner|Doctor|اسم\s*الممارس|اسم\s*الطبيب/.test(line)) {
    return null;
  }

  const { arabic, latin } = extractValuesFromLine(line);
  return joinBilingualName(arabic, latin);
}

/** Doctor / practitioner name. */
function matchDoctorName(text) {
  // The doctor row uses 'Practitioner Name' (English) or
  // 'اسم الطبيب' / 'اسم الممارس' (Arabic) labels. The doctor name
  // sometimes wraps onto a 2nd line in tight PDF layouts (a long
  // Saudi name plus 'Practitioner Name' label can exceed the
  // text-box width), so we also collect words from the line
  // immediately following the labelled line.
  const lines = text.split('\n');
  let labelIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/Practitioner\s*Name|Doctor\s*Name|اسم\s*الممارس|اسم\s*الطبيب/.test(lines[i])) {
      labelIdx = i;
      break;
    }
  }
  if (labelIdx < 0) return null;

  // Combine the label line + next line (the wrap, if any). The
  // next line's content stops contributing if it looks like a new
  // labelled row (contains 'Position', 'Specialty', 'المسمى', etc.).
  let combined = lines[labelIdx];
  if (labelIdx + 1 < lines.length) {
    const next = lines[labelIdx + 1];
    if (!/Position|Specialty|Speciality|المسمى/.test(next)) {
      combined += ' ' + next;
    }
  }

  const { arabic, latin } = extractValuesFromLine(combined);
  return joinBilingualName(arabic, latin);
}

/** Specialty / position. */
function matchSpecialty(text) {
  const line = findLine(text, l =>
    /\b(?:Position|Specialty|Speciality)\b/i.test(l) ||
    /المسمى\s*الوظيف[يى]/.test(l)
  );
  if (!line) return null;

  const { arabic, latin } = extractValuesFromLine(line);
  return joinBilingualName(arabic, latin);
}

/** Combine an Arabic and a Latin variant of the same value into a
 *  single display string. Format: 'Latin\nArabic' (English on top,
 *  Arabic below) when both exist, otherwise whichever is non-null.
 *  The newline lets the UI render the two scripts as stacked lines
 *  with `white-space: pre-line` rather than running them inline.
 *  Returns null if neither is present. */
function joinBilingualName(arabic, latin) {
  if (arabic && latin) return `${latin}\n${arabic}`;
  return arabic || latin || null;
}

/** Shared cleanup for any captured Arabic value:
 *    • Trim leading/trailing whitespace
 *    • Collapse internal whitespace runs (Tesseract sometimes inserts
 *      newlines mid-word)
 *    • Cut at the first occurrence of a known label fragment, in
 *      case the regex over-captured into the next field. */
function cleanArabicValue(raw) {
  if (!raw) return null;
  let v = raw.trim().replace(/\s+/g, ' ');
  // If the next field's label leaked in (e.g. captured 'دانه ... المسمى الوظيفي'),
  // truncate before the label. Covers labels from BOTH Layout A
  // (screenshot UI) and Layout B (certificate PDF).
  const stopLabels = [
    // Layout A
    'تاريخ', 'تبدأ', 'وحتى', 'المدة', 'اسم الطبيب', 'المسمى', 'الوظيفي', 'الوظيفى',
    // Layout B PDF additions
    'تاريخ الدخول', 'تاريخ الخروج', 'تاريخ إصدار',
    'اسم الممارس', 'رقم الهوية', 'الإقامة', 'الجنسية', 'جهة العمل',
    // English labels often appear adjacent in the bilingual PDF
    'Name', 'Position', 'Practitioner', 'Date', 'Iqama', 'Nationality',
    'Employer',
  ];
  for (const lbl of stopLabels) {
    const idx = v.indexOf(lbl);
    if (idx > 0) {
      v = v.slice(0, idx).trim();
    }
  }
  return v || null;
}

/**
 * Convenience: clean up the OCR worker. Call when navigating away
 * from any page that uses OCR if you want to free the ~4MB worker
 * memory. Optional — most users keep the modal open briefly.
 */
export async function disposeOcrEngine() {
  if (!_workerPromise) return;
  try {
    const worker = await _workerPromise;
    await worker.terminate();
  } catch { /* ignore */ }
  _workerPromise = null;
}
