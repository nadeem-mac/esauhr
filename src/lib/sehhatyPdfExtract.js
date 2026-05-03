// =============================================================================
// sehhatyPdfExtract.js
//
// PDF → structured Sehhaty fields. Used by Path B of SickLeaveModal when the
// staff uploads their Sehhaty leave certificate.
//
// TWO-STAGE PIPELINE
//
//   STAGE 1 — text-layer extraction (preferred, fast, accurate)
//
//   Sehhaty PDFs are generated server-side by Seha.sa as searchable PDFs
//   with a real text layer (not scanned images). We read this layer
//   directly via pdfjs-dist's getTextContent() — no OCR needed, runs in
//   ~200ms for a single-page certificate.
//
//   Output: a single string with the page's text in roughly-natural
//   reading order, which we then feed into the same regex pipeline used
//   for the screenshot-OCR flow (extractFieldsFromText from sehhatyOcr.js).
//
//   STAGE 2 — render-to-image + OCR fallback (when text layer is empty)
//
//   In rare cases — older PDFs, scanned receipts forwarded by clinics that
//   re-print on Seha letterhead, badly-exported documents — the text layer
//   is empty or unreliable. Fallback: render the first page to a high-DPI
//   canvas and run Tesseract on the resulting bitmap, just like a paste.
//   Slower (~3-5s) but covers the long tail.
//
// VALIDATION
//
//   The extractor does not just return whatever it found. It validates that
//   the document looks like a Sehhaty certificate by requiring AT LEAST a
//   leave ID matching the standard Sehhaty pattern (3-letter prefix +
//   10+ alphanumerics — covers GSL, PSL, and any future prefixes Seha
//   adds without code changes). If that's missing, we treat the upload
//   as "not a Sehhaty PDF" and surface a clear error to the staff.
//
// LAZY-LOADED
//
//   pdfjs-dist is ~400kb minified+gzipped. We import it dynamically inside
//   the extract function so it's only fetched when the staff actually
//   chooses Path B in SickLeaveModal. Keeps the initial bundle small.
//
// PRIVACY
//
//   Per user direction in the design discussion: PDFs are read in the
//   browser, fields are extracted, and the file is discarded. We do NOT
//   upload the PDF anywhere — the staff's Sehhaty document never leaves
//   their device. Only the structured fields (leave ID, dates, days,
//   doctor name, etc.) are sent to the database.
// =============================================================================

import { extractFieldsFromText } from './sehhatyOcr.js';

/**
 * Main entry point. Takes a File (from <input type=file> or drag-drop) and
 * returns the extracted Sehhaty fields, or throws with a clear error if the
 * file isn't a recognisable Sehhaty certificate.
 *
 * @param {File} file
 * @returns {Promise<{
 *   leaveId:   string,
 *   idNumber:  string|null,
 *   startDate: string|null,
 *   endDate:   string|null,
 *   days:      number|null,
 *   issueDate: string|null,
 *   name:      string|null,
 *   doctor:    string|null,
 *   specialty: string|null,
 *   source:    'text_layer'|'ocr_fallback',
 *   rawText:   string,
 * }>}
 *
 * @throws {Error} with .code:
 *   'NOT_PDF'           — file's mime type or magic bytes don't match
 *   'PDF_PARSE_FAILED'  — pdfjs couldn't read the document
 *   'NOT_SEHHATY'       — text extracted but no leave ID found
 *                          (no match for Sehhaty's standard prefix +
 *                          digits pattern; covers GSL, PSL, etc.)
 */
export async function extractFromPdf(file) {
  // Sanity check. Browsers report `application/pdf` for valid PDFs;
  // some browsers may report '' for files that lack the extension.
  // We check the mime type first and fall back to magic bytes.
  if (file.type && file.type !== 'application/pdf') {
    const err = new Error('Please upload a PDF file (the Sehhaty certificate from Seha.sa).');
    err.code = 'NOT_PDF';
    throw err;
  }

  // Read the bytes once and pass them to pdfjs as a Uint8Array. This avoids
  // pdfjs needing to fetch a URL and avoids re-reading from the File object
  // multiple times.
  const buffer = await file.arrayBuffer();
  const bytes  = new Uint8Array(buffer);

  // Magic-bytes sanity check — a PDF file always starts with "%PDF-".
  // Catches the case where the file extension is .pdf but the contents
  // are something else entirely (a Word doc renamed, an image, etc.).
  if (!(bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46)) {
    const err = new Error("This file doesn't look like a valid PDF. Please upload your Sehhaty certificate as a PDF.");
    err.code = 'NOT_PDF';
    throw err;
  }

  const pdfjs = await loadPdfjs();

  let pdf;
  try {
    pdf = await pdfjs.getDocument({ data: bytes }).promise;
  } catch (e) {
    const err = new Error("Couldn't read this PDF. The file may be corrupted or password-protected.");
    err.code = 'PDF_PARSE_FAILED';
    err.cause = e;
    throw err;
  }

  // STAGE 1 — text layer extraction.
  // Walk every page (Sehhaty certs are usually 1 page; we handle 2+ defensively
  // because some clinics print the cert + a header page together) and concat
  // the text content with newlines between pages.
  let aggregateText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      // Each item is { str, transform, ... }. We concatenate the strings
      // with spaces, inserting a newline when the y-coordinate (transform[5])
      // changes meaningfully — this gives us roughly the same paragraph
      // structure the user sees on screen, which the regex pipeline expects.
      const pageText = stitchTextItems(content.items);
      aggregateText += pageText + '\n';
    } catch (e) {
      // If a single page fails to extract, we still try the others. Empty
      // string concat is a no-op.
      console.warn(`pdf page ${pageNum} text extract failed:`, e);
    }
  }

  // Run the regex pipeline on the aggregated text.
  let fields = extractFieldsFromText(aggregateText);
  let source = 'text_layer';

  // STAGE 2 — OCR fallback if text layer didn't yield a leave ID.
  // The leave ID is the strongest signal that this is actually a Sehhaty
  // doc; if we can't find it from the text layer, we render the first
  // page to a canvas and run Tesseract on the bitmap.
  if (!fields.leaveId) {
    try {
      const ocrText = await renderPageAndOcr(pdf, 1);
      const ocrFields = extractFieldsFromText(ocrText);
      // Merge: take any non-null OCR field over the (probably-empty) text-
      // layer fields. The text-layer pass might have caught some things
      // even without the leave ID, so we don't blindly overwrite.
      fields = mergeFields(fields, ocrFields);
      aggregateText = aggregateText + '\n--- OCR ---\n' + ocrText;
      source = 'ocr_fallback';
    } catch (e) {
      console.warn('pdf OCR fallback failed:', e);
      // fall through — fields.leaveId will still be null and we'll
      // throw NOT_SEHHATY below.
    }
  }

  // Final validation. Without a leave ID, we can't responsibly create
  // a sick leave row from this document. Surface a clear error so the
  // staff knows to re-upload the original Sehhaty PDF.
  if (!fields.leaveId) {
    const err = new Error("Couldn't read this as a Sehhaty certificate. Please ensure the PDF is the original from Seha.sa, not a forwarded photo or screenshot.");
    err.code = 'NOT_SEHHATY';
    err.aggregateText = aggregateText;
    throw err;
  }

  return {
    ...fields,
    source,
    rawText: aggregateText,
  };
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

let pdfjsCache = null;

/**
 * Lazy-load pdfjs-dist. The main library bundle stays small until Path B
 * actually fires. We use the legacy build (smaller, no worker thread
 * support needed) and configure the workerSrc to a CDN URL so we don't
 * need to wire up a separate worker bundle through Vite.
 */
async function loadPdfjs() {
  if (pdfjsCache) return pdfjsCache;
  // legacy build is smaller and works without a separate worker
  // bundle in browsers that don't expose Web Workers from blob URLs.
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // Configure workerSrc to a hosted CDN matching the installed version.
  // Vite would otherwise try to bundle the worker as a regular dep,
  // which fails on the legacy build. Pinning to the same version we
  // installed avoids API mismatches.
  pdfjs.GlobalWorkerOptions.workerSrc =
    `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.mjs`;
  pdfjsCache = pdfjs;
  return pdfjs;
}

/**
 * Stitch pdfjs text items into a single string, preserving line breaks
 * where the y-coordinate jumps. Sehhaty PDFs have a fairly clean layout
 * but Arabic and Latin glyphs in the same row of a bilingual table can
 * have slightly different y-coordinates (one at 520.3, another at
 * 519.6) due to font metric differences. Strict integer rounding
 * splits them into separate "lines" which breaks downstream line-
 * based field extraction.
 *
 * Solution: tolerance-based bucketing. Two items are considered to be
 * on the same line if their y-coordinates differ by less than
 * Y_TOLERANCE.
 *
 * Tolerance value (1.5) is calibrated to:
 *   • Absorb sub-pixel font-metric drift between Arabic and Latin
 *     glyphs in the SAME row (typically < 1 unit difference)
 *   • NOT merge adjacent rows of the table — Sehhaty's row spacing
 *     is ~16-20 points, so tolerance well below that is safe
 *
 * Earlier value of 3 was too aggressive — it merged the doctor row's
 * wrap line with the specialty row when the wrap text was close.
 */
const Y_TOLERANCE = 1.5;

function stitchTextItems(items) {
  if (!items || !items.length) return '';
  // Sort items by y descending first (PDF coords are bottom-up; we
  // want top-down reading order). Then walk through and bucket
  // consecutive items into lines if their y-coordinates are within
  // Y_TOLERANCE of the bucket's anchor.
  const itemsWithStr = items.filter(it => it.str);
  const sorted = [...itemsWithStr].sort((a, b) => b.transform[5] - a.transform[5]);

  const lines = [];
  let currentBucket = null;
  let currentY = null;
  for (const item of sorted) {
    const y = item.transform[5];
    const x = item.transform[4];
    if (currentBucket && Math.abs(currentY - y) <= Y_TOLERANCE) {
      currentBucket.push({ x, str: item.str });
    } else {
      currentBucket = [{ x, str: item.str }];
      lines.push(currentBucket);
      currentY = y;
    }
  }

  // Within each line, sort items by x ascending so words appear in
  // visual left-to-right order. Note that for RTL Arabic text, the
  // visual reading order IS right-to-left, but the joined string
  // still reads correctly because the regex extractors treat each
  // word as a unit (their internal character order is preserved by
  // pdfjs).
  return lines
    .map(line => line.sort((a, b) => a.x - b.x).map(it => it.str).join(' '))
    .join('\n');
}

/**
 * Merge text-layer and OCR field results, preferring the OCR value when
 * the text-layer field was null/empty. Used in the fallback path.
 */
function mergeFields(textLayer, ocr) {
  const out = { ...textLayer };
  for (const k of Object.keys(ocr)) {
    if ((out[k] === null || out[k] === undefined || out[k] === '') && ocr[k] != null) {
      out[k] = ocr[k];
    }
  }
  return out;
}

/**
 * Render a PDF page to a canvas at high DPI and run Tesseract on the
 * bitmap. Used only when text-layer extraction failed.
 */
async function renderPageAndOcr(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  // 2.5x scale gives Tesseract dense glyph data (Arabic OCR likes this).
  const viewport = page.getViewport({ scale: 2.5 });
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  // Convert canvas to a Blob and feed it to the existing OCR pipeline.
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  // Reuse the existing image OCR helper (handles preprocessing internally).
  const { extractFromImage } = await import('./sehhatyOcr.js');
  const result = await extractFromImage(blob);
  return result.rawText || '';
}
