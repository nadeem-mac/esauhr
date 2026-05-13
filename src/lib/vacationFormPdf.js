// =============================================================================
// vacationFormPdf.js
//
// Generates the OFFICIAL vacation form as a non-editable PDF.
//
// IMPORTANT — what changed (2026-05-10 Nadeem):
//
// The first cut of this module built a custom HTML template that
// LOOKED like the docx form but was a from-scratch rebuild. Nadeem
// rejected that approach — the existing docx layout is ESAU's
// validated standard (used officially across the company, audited
// for content, signed off by management). The HTML rebuild
// inevitably drifted from the canonical layout.
//
// The fix: use the existing generateVacationFormBlob() to produce
// the actual docx, then render that docx in the browser using
// docx-preview and rasterise the rendered output to PDF. The
// PDF content is therefore visually faithful to the canonical
// form Bashaier has been issuing; only the file format flips
// from docx (editable) to PDF (locked image).
//
// PIPELINE
//   1. Call generateVacationFormBlob() from vacationForm.js — same
//      generator used everywhere else, no fork or rebuild.
//   2. Pass the docx blob to docx-preview's renderAsync(), which
//      reads the OOXML and renders it into a hidden DOM container
//      as HTML with faithful styling (tables, borders, fonts,
//      bilingual text, embedded images including the QR code).
//   3. Wait for any images inside the rendered output to finish
//      loading so html2canvas captures them properly.
//   4. Use html2canvas-pro to rasterise the rendered container at
//      2x scale.
//   5. Use jsPDF to wrap the canvas as A4 portrait pages (multi-
//      page split happens automatically if content overflows).
//   6. Return the PDF as a Blob with type 'application/pdf'.
//
// CALLER COMPATIBILITY
//   Same export name (generateVacationFormPdfBlob) and same args
//   as the previous version, so HrApprovalModal and
//   downloadVacationFormForRequest don't need any changes.
//
// TRADE-OFFS
//   • Output is a rasterised image — recipients can't copy/paste
//     individual fields. This is the point: locked form.
//   • File size ~250 KB versus ~30 KB for docx. Acceptable for
//     email and printing.
//   • Slightly slower than direct HTML rendering because we
//     generate docx then re-parse it — but only a second or two,
//     and the user's already waiting for the download click.
//   • docx-preview honours most Word formatting but not every
//     edge case. The generator produces simple table-based layout
//     that renders faithfully.
// =============================================================================

import jsPDF from 'jspdf';
import html2canvas from 'html2canvas-pro';
import { generateVacationFormBlob } from './vacationForm.js';

/**
 * Build the official vacation form as a PDF Blob.
 *
 * Internally generates the canonical docx via vacationForm.js, then
 * renders + rasterises it. The PDF content IS the docx — just locked.
 *
 * @param {object} args             — passed through to generateVacationFormBlob
 * @param {object} args.employee
 * @param {object} args.request
 * @param {object} args.manager
 * @param {object} args.hrApprover
 * @param {Array}  args.substitutes
 * @returns {Promise<Blob>} PDF blob with type 'application/pdf'
 */
export async function generateVacationFormPdfBlob(args) {
  // ── 1. Generate the canonical docx (existing standard) ────────────────────
  const docxBlob = await generateVacationFormBlob(args);

  // ── 2. Render docx into a hidden DOM container via docx-preview ───────────
  // docx-preview is the cleanest way to faithfully render a Word doc
  // in the browser — it reads the OOXML zip and produces HTML+CSS
  // that mirrors the source styling closely.
  //
  // Dynamic import keeps the library (and its jszip dep) out of the
  // initial bundle; only loaded when someone actually clicks Download.
  const { renderAsync } = await import('docx-preview');

  const container = document.createElement('div');
  // Let docx-preview decide page width from the docx itself — don't
  // force 794px. The previous attempt clamped to 96-DPI A4 width but
  // docx-preview renders at the document's native page size (with
  // internal margins from the docx), and forcing a narrower container
  // caused text reflow that didn't match Word's layout. Now we just
  // make the container off-screen and let it lay out naturally.
  container.style.cssText = `
    position: absolute;
    left: -9999px;
    top: 0;
    background: #FFFFFF;
  `;
  document.body.appendChild(container);

  try {
    await renderAsync(docxBlob, container, null, {
      className: 'esau-docx-render',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: false,
      trimXmlDeclaration: true,
      useBase64URL: true,        // embed images as data URLs (essential
                                  // for the QR code + logo to capture
                                  // correctly via html2canvas)
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      debug: false,
    });

    // ── 3. Wait for embedded images to finish loading ───────────────────────
    // The docx may contain the EVERGREEN logo + the QR code as embedded
    // images. docx-preview emits them as <img> tags with data URLs
    // (because useBase64URL=true), which should be instant — but we
    // still wait a tick to be safe, in case any external resources
    // were referenced.
    await waitForImages(container, 2500);

    // ── 4. Rasterise the rendered PAGE — not the wrapper ────────────────────
    // docx-preview produces: .docx-wrapper > section.docx (one per
    // page). The wrapper adds its own padding/background for the
    // preview UX; the section IS the page (A4-sized, with the docx's
    // own margins). Capturing the section directly gives us the
    // actual page bounds — no extra whitespace around it.
    const pageSection = container.querySelector('.docx-wrapper section.docx, .docx-wrapper > section, .docx-wrapper > div, section.docx');
    const renderRoot = pageSection || container.querySelector('.docx-wrapper') || container;

    // Use the rendered element's actual computed dimensions. These
    // come from the docx (A4 portrait = ~794×1123px @ 96 DPI), not
    // from a hard-coded value. If the docx uses Letter or any other
    // size, we honour it.
    const rect = renderRoot.getBoundingClientRect();
    const renderedWidthPx  = rect.width  || renderRoot.scrollWidth  || 794;
    const renderedHeightPx = rect.height || renderRoot.scrollHeight || 1123;

    const canvas = await html2canvas(renderRoot, {
      scale: 2,                       // 2x for crisp print quality
      backgroundColor: '#FFFFFF',
      useCORS: true,
      logging: false,
      width:  renderedWidthPx,
      height: renderedHeightPx,
      windowWidth:  renderedWidthPx,
      windowHeight: renderedHeightPx,
    });

    // ── 5. Wrap the canvas as a SINGLE-PAGE A4 PDF — FILL the page ──────────
    // Nadeem 2026-05-10: the PDF MUST fit on exactly one page AND
    // make full use of the page (no whitespace strips, no
    // letterboxing). We stretch the canvas to fill A4 portrait
    // exactly: 210mm × 297mm. Since docx-preview already rendered
    // the docx at its native A4 ratio, this stretch is effectively
    // a no-op in shape — but it guarantees zero gap between the
    // page bounds and the form content.
    const pdf = new jsPDF({
      orientation: 'portrait',
      unit: 'mm',
      format: 'a4',
      compress: true,
    });

    const pageWidthMm  = 210;
    const pageHeightMm = 297;

    const imgData = canvas.toDataURL('image/jpeg', 0.95);
    pdf.addImage(imgData, 'JPEG', 0, 0, pageWidthMm, pageHeightMm, undefined, 'FAST');

    // ── 6. Metadata + return ────────────────────────────────────────────────
    pdf.setProperties({
      title:    `Vacation Form ${shortRef(args.request?.id)}`,
      subject:  `Approved leave for ${args.employee?.name || args.request?.employee_id}`,
      author:   'ESAU HR · esauhr.netlify.app',
      creator:  'ESAU HR Portal',
      keywords: 'vacation,leave,esau,evergreen,hr',
    });

    return pdf.output('blob');
  } finally {
    // Always clean up the offscreen node, even on errors.
    if (container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }
}

// ─── helpers ───────────────────────────────────────────────────────────────

// Resolve when every <img> inside `root` has either loaded or errored,
// or after `timeoutMs` — whichever happens first. Prevents the
// rasterisation step from capturing half-loaded images.
function waitForImages(root, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const imgs = Array.from(root.querySelectorAll('img'));
    if (imgs.length === 0) return resolve();

    let pending = imgs.length;
    const done = () => { if (--pending <= 0) resolve(); };

    imgs.forEach((img) => {
      if (img.complete) return done();
      img.addEventListener('load',  done, { once: true });
      img.addEventListener('error', done, { once: true });
    });

    // Safety net — if an image is stuck loading we don't want to
    // hang the download forever.
    setTimeout(resolve, timeoutMs);
  });
}

// Same shortRef helper as in vacationForm.js — duplicated here so
// we don't reach into the docx generator's privates.
function shortRef(id) {
  const s = String(id ?? '');
  const hex = s.replace(/-/g, '');
  if (hex.length > 8 && /^[0-9a-f]+$/i.test(hex)) {
    return `LV-${hex.slice(0, 8).toUpperCase()}`;
  }
  return `LV-${s.padStart(5, '0')}`;
}

// Small helper kept here so callers don't need to import a second
// module just to trigger a download. Mirrors the export shape the
// previous version had.
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
