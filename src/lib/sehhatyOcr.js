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
  const result = await worker.recognize(imageInput);
  const text = result?.data?.text || '';
  const confidence = result?.data?.confidence ?? 0;

  // Field-by-field regex extraction. The Sehhaty layout is fixed
  // and the labels are predictable, so regex is more reliable than
  // a heuristic. Each field is independently optional — if the
  // regex doesn't match, we return null for that field rather than
  // failing the whole extraction.
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
    confidence,
    rawText:    text,
  };
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

/** Patient name — Arabic text after 'الاسم:' label. We grab the
 *  3-5 Arabic words that follow. Approximate; Bashaier reviews. */
function matchPatientName(text) {
  // Look for the Arabic label 'الاسم' then capture the next line of
  // Arabic content. Tesseract may render the label as 'الاسم' or
  // close variants depending on font confidence.
  const m = text.match(/الاسم[:：]?\s*([\u0600-\u06FF\s]{3,80})/);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

/** Doctor name — 'اسم الطبيب' label. */
function matchDoctorName(text) {
  const m = text.match(/اسم\s*الطبيب[:：]?\s*([\u0600-\u06FF\s]{3,80})/);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
}

/** Specialty — 'المسمى الوظيفي' label. Often 'طب بشري' (Human
 *  Medicine), 'طب الأسنان', 'طب الأطفال', etc. */
function matchSpecialty(text) {
  const m = text.match(/المسمى\s*الوظيفي[:：]?\s*([\u0600-\u06FF\s]{2,40})/);
  return m ? m[1].trim().replace(/\s+/g, ' ') : null;
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
