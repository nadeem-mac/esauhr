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
//     • GSL leave ID (Latin + digits)
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

/** GSL26042340605, GSL-26042340605, etc. — the Sehhaty leave ID. */
function matchLeaveId(text) {
  const m = text.match(/\b(GSL[-\s]?[A-Z0-9]{10,16})\b/i);
  if (!m) return null;
  return m[1].replace(/[\s-]/g, '').toUpperCase();
}

/** Saudi national ID / Iqama — 10 digits. The Sehhaty page shows it
 *  in its own row right under the GSL number. We pick the first
 *  10-digit run that isn't part of a date. */
function matchIdNumber(text) {
  // Strip dates (YYYY-MM-DD) so they don't get mis-matched as IDs.
  const cleaned = text.replace(/\d{4}-\d{2}-\d{2}/g, '');
  const m = cleaned.match(/\b(\d{10})\b/);
  return m ? m[1] : null;
}

/** First YYYY-MM-DD in the document — Sehhaty puts the start date
 *  ('تبدأ من') first in the usual layout. */
function matchStartDate(text) {
  const dates = (text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []);
  // Layout order observed: report-issue, start, end (RTL flow).
  // After OCR linearises the page, the first date in the cleaned
  // text is usually report-issue, then start, then end. We try
  // the second-occurring date as start; falls back to the first
  // if only one or two were detected.
  if (dates.length >= 3) return dates[1];
  if (dates.length >= 1) return dates[0];
  return null;
}

/** End date — third date in OCR order in the typical layout. */
function matchEndDate(text) {
  const dates = (text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []);
  if (dates.length >= 3) return dates[2];
  if (dates.length === 2) return dates[1];
  if (dates.length === 1) return dates[0];
  return null;
}

/** Issue date — first date in the page's flow. */
function matchIssueDate(text) {
  const dates = (text.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []);
  return dates[0] || null;
}

/** Days count. Most reliable: anchor to the 'المدة بالأيام' label
 *  and grab the very next 1-3 digit number. Tesseract sometimes
 *  picks up a stray digit elsewhere on the page (e.g. mistakes a
 *  letter shape for '4'), so the standalone-integer fallback is
 *  vulnerable to false positives. The label-anchored search is
 *  much more accurate because the only digit that can legitimately
 *  appear right after 'بالأيام:' is the day count itself. */
function matchDays(text) {
  // Pattern 1 — direct label match: 'المدة بالأيام: 1'
  let m = text.match(/المدة\s*بالأيام\s*[:：]?\s*(\d{1,3})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 365) return n;
  }

  // Pattern 2 — label and digit may be separated by a line break
  // or other Arabic/Latin text in OCR output. Find the label, then
  // search a 200-char window after it for the first small integer
  // that isn't part of a date or a 10-digit ID.
  const labelIdx = text.search(/المدة\s*بالأيام/);
  if (labelIdx >= 0) {
    const after = text.slice(labelIdx, labelIdx + 200)
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      .replace(/\d{4}\/\d{2}\/\d{2}/g, '')
      .replace(/\b\d{10}\b/g, '');
    const dm = after.match(/\b(\d{1,3})\b/);
    if (dm) {
      const n = parseInt(dm[1], 10);
      if (n >= 1 && n <= 365) return n;
    }
  }

  // Pattern 3 — also accept English label variants ('Days', 'Duration')
  // in case the OCR confidence on Arabic text was low.
  m = text.match(/(?:Days|Duration|Period)\s*[:：]?\s*(\d{1,3})/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 365) return n;
  }

  // Fallback — first standalone small integer in the document that
  // isn't part of a date/ID/leave code. Less reliable than the
  // label-anchored matches above but better than returning null.
  const cleaned = text
    .replace(/\d{4}-\d{2}-\d{2}/g, '')
    .replace(/\d{4}\/\d{2}\/\d{2}/g, '')
    .replace(/\b\d{10}\b/g, '')
    .replace(/GSL[A-Z0-9]+/gi, '');
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
function matchPatientName(text) {
  // The label can OCR as 'الاسم' or with ﻻ ligatures or with stray
  // characters. We anchor on the consonant skeleton 'الاسم'.
  const m = text.match(/الاسم[:：\s]*\n?[\s]*([\u0600-\u06FF\uFB50-\uFEFC\s]{3,120})/);
  if (!m) return null;
  return cleanArabicValue(m[1]);
}

/** Doctor name — 'اسم الطبيب' label.
 *  Fixes for the user-reported 'doctor name was missing' miss:
 *    • Tolerate the label spelling variants Tesseract produces
 *      ('اسم الطبيب', 'اسم الطبيب:', 'اسم الطبيب :', 'اسم الطبيب\n')
 *    • Allow newlines between label and value
 *    • Accept Arabic presentation forms (U+FB50-U+FEFC range) — Tesseract
 *      sometimes outputs these instead of the basic Arabic block.
 *    • Length cap raised from 80 to 120 — Saudi doctor names are often
 *      4-5 words ('دانه محمد بن عبدالله الغامدي') and the previous cap
 *      was clipping them. */
function matchDoctorName(text) {
  const m = text.match(/اسم\s*الطبيب[:：\s]*\n?[\s]*([\u0600-\u06FF\uFB50-\uFEFC\s]{3,120})/);
  if (!m) return null;
  return cleanArabicValue(m[1]);
}

/** Specialty — 'المسمى الوظيفي' label. Often 'طب بشري' (Human
 *  Medicine), 'طب الأسنان', 'طب الأطفال', etc. */
function matchSpecialty(text) {
  const m = text.match(/المسمى\s*الوظيفي[:：\s]*\n?[\s]*([\u0600-\u06FF\uFB50-\uFEFC\s]{2,60})/);
  if (!m) return null;
  return cleanArabicValue(m[1]);
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
  // truncate before the label.
  const stopLabels = ['تاريخ', 'تبدأ', 'وحتى', 'المدة', 'اسم الطبيب', 'المسمى', 'الوظيفي'];
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
