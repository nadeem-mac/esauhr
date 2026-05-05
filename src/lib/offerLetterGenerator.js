// =============================================================================
// offerLetterGenerator.js
//
// Generates a corporate-style bilingual offer letter as a single A4
// page PDF. Rendered as HTML in the browser, captured with
// html2canvas-pro, wrapped as A4 by jsPDF — so Arabic uses the OS's
// native Arabic-capable font with proper RTL bidi and letter
// joining (Helvetica embedded in jsPDF can't shape Arabic).
//
// Document structure (top to bottom):
//
//   ┌─ LETTERHEAD ────────────────────────────────────────────┐
//   │  Logo │ Company EN + corporate details │ Company AR     │
//   │       │ Branch · CR · Tel · Email      │ (mirrored RTL) │
//   ├─ Reference & date row ──────────────────────────────────┤
//   ├─ TITLE: LETTER OF OFFER · عرض عمل ──────────────────────┤
//   ├─ Intro paragraph (EN left ‖ AR right) ──────────────────┤
//   ├─ POSITION & COMPENSATION (band) ────────────────────────┤
//   │  Position table (EN label, AR below in black, value)    │
//   │  Salary breakdown table (same EN/AR stacking, amounts)  │
//   ├─ KEY TERMS · أهم البنود (band) ─────────────────────────┤
//   │  7 KSA-Labor-Law clauses, EN ‖ AR side-by-side          │
//   ├─ ⚠ 7-DAY VALIDITY CALLOUT (red accent, prominent) ─────┤
//   ├─ Acceptance instruction ────────────────────────────────┤
//   │                                                         │
//   │              (flex spacer — pushes ↓ down)              │
//   │                                                         │
//   ├─ SIGNATURES (bottom of page) ───────────────────────────┤
//   │  ┌─ For Evergreen ──┐  ┌─ Seal ─┐  ┌─ Candidate ─┐      │
//   │  │ Sig line         │  │  ⊕     │  │ Sig line    │      │
//   │  │ JOHN HO          │  └────────┘  │ [Name]      │      │
//   │  │ Country Head     │              │ Date        │      │
//   │  │ Company name     │                                   │
//   │  │ Branch Office    │                                   │
//   │  │ CR # · Tel · Email                                   │
//   ├─ Confidentiality footer ───────────────────────────────┤
//
// Per Nadeem's review of an earlier version: the "Reporting to"
// row was removed from the letter (manager_id is still saved on
// the offer record for internal tracking, just not displayed).
// =============================================================================

import { renderHrSignature } from './emailTemplates.js';

const A4_W_PX = 794;
const A4_H_PX = 1123;
const RENDER_SCALE = 2;

// Company contact details — single source of truth for the
// letterhead and the corporate signature block. If any of these
// change (new branch office, phone number, etc.) update them here.
const COMPANY = {
  nameFullEn:  'Evergreen Shipping Agency Saudi Co. (LLC)',
  nameFullAr:  'شركة إيفرغرين للملاحة المحدودة',
  brandEn:     'EVERGREEN LINE',
  brandAr:     'خط إيفرغرين',
  branchEn:    'Branch Office: P.O. Box 1008, Dammam 31431, KSA',
  branchAr:    'فرع المكتب: ص.ب 1008، الدمام 31431، المملكة العربية السعودية',
  cr:          'C.R. 2050145335',
  computerNo:  'Computer No. 7023475051',
  tel:         '(013) 8333566',
  fax:         '(013) 8341182',
  email:       'esau@evergreen-shipping.com.sa',
  hrDeptEn:    'HR Department · Dammam',
  hrDeptAr:    'إدارة الموارد البشرية · الدمام',
};

// ─── PDF: HTML → canvas → A4 PDF ──────────────────────────────────

// ─── PRINT-TO-PDF: opens a new window with the offer letter HTML
//                  and auto-triggers the browser's print dialog.
//                  User saves as PDF via 'Save as PDF' destination.
//
// Why this approach:
//   The previous approach used html2canvas-pro to rasterize the
//   DOM into a canvas, then jsPDF to wrap that canvas as A4.
//   That broke Arabic letter joining because html2canvas
//   reimplements text rendering in JS and doesn't run the
//   browser's HarfBuzz text shaper — every Arabic letter rendered
//   as standalone glyphs instead of cursive ligatures.
//
//   Print-to-PDF uses the BROWSER'S NATIVE PRINT PIPELINE which is
//   guaranteed to render Arabic correctly (it's the same renderer
//   you see on screen). Trade-off: user clicks Print in the browser
//   dialog and chooses 'Save as PDF' destination. One extra step
//   per offer in exchange for guaranteed correct Arabic forever.
//
// Flow from NewOfferModal:
//   1. Form validates → offer_letters row inserted
//   2. openOfferLetterPrintWindow() is called → new tab opens with
//      letter HTML + auto-print
//   3. Bashaier picks 'Save as PDF' from the print dialog → file
//      saves to her downloads
//   4. Separately the .eml downloads with the email body and
//      acceptance link (no PDF attachment because we don't have
//      the saved file). She attaches the saved PDF manually in
//      Outlook before sending.
// ─────────────────────────────────────────────────────────────────

/**
 * Open a new browser window/tab containing the offer letter
 * formatted for A4 printing, then trigger the browser's print
 * dialog. The user picks 'Save as PDF' from the destination
 * dropdown to save a perfect-quality PDF.
 *
 * @param {Object} offer
 * @param {Object} signatory
 * @returns {Promise<void>} Resolves once the print dialog has
 *                          been opened. Doesn't wait for the user
 *                          to actually save — there's no API for that.
 */
export async function openOfferLetterPrintWindow(offer, signatory) {
  // Open the new tab early. Most browsers block window.open if it's
  // called too long after the user's click event — opening synchronously
  // here means it's still tied to the same gesture that triggered the
  // form submit.
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('The print window was blocked. Please allow pop-ups for esauhr.netlify.app and try again.');
  }

  const safeName = (offer.candidateName || 'Candidate')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '_');
  const filename = `Offer_Letter_${safeName}`;

  // Build the document HTML. We embed the letter HTML, plus a small
  // print-toolbar at the very top that disappears when printing.
  // @page rule sets A4 paper size and zero margins so the letter
  // fills the page edge-to-edge.
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(filename)}</title>
  <style>
    /* Print rules — paper size + zero margins so the letter
       layout (which already has its own internal padding)
       sits flush with the page edge. */
    @page {
      size: A4 portrait;
      margin: 0;
    }
    @media print {
      body { margin: 0; }
      .print-toolbar { display: none !important; }
      .print-tip { display: none !important; }
    }

    html, body {
      margin: 0;
      padding: 0;
      background: #f5f5f5;
      font-family: 'Helvetica Neue', Arial, sans-serif;
    }

    /* On-screen toolbar — only visible before printing */
    .print-toolbar {
      position: sticky;
      top: 0;
      background: #0F4C2A;
      color: #fff;
      padding: 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      z-index: 10;
      box-shadow: 0 2px 6px rgba(0,0,0,0.15);
    }
    .print-toolbar .title {
      font-size: 14px;
      font-weight: 500;
    }
    .print-toolbar .filename {
      font-size: 12px;
      opacity: 0.85;
      margin-top: 2px;
    }
    .print-toolbar button {
      background: #fff;
      color: #0F4C2A;
      border: none;
      padding: 8px 16px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border-radius: 4px;
      letter-spacing: 0.3px;
    }
    .print-toolbar button:hover {
      background: #ECFDF3;
    }

    .print-tip {
      max-width: 794px;
      margin: 16px auto 0;
      padding: 12px 16px;
      background: #FEF6E2;
      border: 1px solid #E8C896;
      border-radius: 4px;
      font-size: 13px;
      color: #854F0B;
      line-height: 1.5;
    }
    .print-tip strong { color: #663D08; }

    /* Letter container — A4 dimensions, centered on screen */
    .letter-host {
      max-width: 794px;
      margin: 16px auto 32px;
      background: #fff;
      box-shadow: 0 4px 24px rgba(0,0,0,0.12);
    }
    @media print {
      .letter-host {
        margin: 0;
        box-shadow: none;
        max-width: none;
      }
    }
  </style>
</head>
<body>
  <div class="print-toolbar">
    <div>
      <div class="title">Offer Letter — ready to save as PDF</div>
      <div class="filename">${escapeHtml(filename)}.pdf</div>
    </div>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>

  <div class="print-tip">
    <strong>To save as PDF:</strong>
    <ol style="margin: 6px 0 0 18px; padding: 0;">
      <li>Click <strong>Print / Save as PDF</strong> above (or press Ctrl+P / Cmd+P).</li>
      <li>Set <strong>Destination → Save as PDF</strong>.</li>
      <li>Set <strong>Paper size → A4</strong> and <strong>Margins → None</strong> (under "More settings"). This keeps the letter on a single page.</li>
      <li>Click <strong>Save</strong>. The PDF lands in your Downloads.</li>
    </ol>
    After saving, return to the Hiring tab — your Outlook draft (.eml) has already been downloaded for you to attach the PDF.
  </div>

  <div class="letter-host">
    ${buildLetterHtml(offer, signatory)}
  </div>

  <script>
    // Auto-trigger print once all images (logo + company seal) have
    // loaded. If any image fails or takes too long, the safety
    // timeout still opens the dialog so the user isn't stuck.
    (function() {
      var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
      var pending = imgs.filter(function(i) { return !i.complete; }).length;
      var triggered = false;
      function go() {
        if (triggered) return;
        triggered = true;
        // Small delay so layout fully settles before the dialog
        // captures it.
        setTimeout(function() { window.print(); }, 250);
      }
      if (pending === 0) {
        go();
      } else {
        imgs.forEach(function(i) {
          if (i.complete) return;
          var done = function() {
            pending--;
            if (pending <= 0) go();
          };
          i.addEventListener('load', done);
          i.addEventListener('error', done);
        });
        setTimeout(go, 3500); // safety fallback if any image hangs
      }
    })();
  </script>
</body>
</html>`;

  win.document.open();
  win.document.write(html);
  win.document.close();
}

// ─── HTML BUILDER ──────────────────────────────────────────────────

// Builds the bilingual offer letter HTML (string). Exported so the
// public acceptance page can render the same letter the candidate
// received via PDF — they see exactly what they're agreeing to.
export function buildLetterHtml(offer, signatory) {
  const dateEN = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const dateAR = new Date().toLocaleDateString('ar-SA', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  // Compute the offer-expiry date (today + 7 days). Used to make
  // the validity callout concrete with a real deadline rather than
  // just saying "7 days".
  const expiry = new Date();
  expiry.setDate(expiry.getDate() + 7);
  const expiryEN = expiry.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const expiryAR = expiry.toLocaleDateString('ar-SA', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  // Reference number — short, human-readable. First 6 chars of the
  // offer token make a workable identifier (collision-free in
  // practice for HR's volume).
  const refToken = (offer.offerToken || '').slice(0, 6).toUpperCase();
  const yearShort = new Date().getFullYear();
  const ref = `ESAU/HR/${yearShort}/${refToken || 'XXXXXX'}`;

  const sar = (v) => `SAR ${Number(v || 0).toLocaleString('en-GB')}`;
  const e = escapeHtml;

  return `
    <style>
      .offer-letter, .offer-letter * { box-sizing: border-box; }
      .offer-letter {
        font-family: 'Helvetica Neue', 'Arial', sans-serif;
        color: #0F172A;
        line-height: 1.35;
        padding: 18px 28px 12px;
        font-size: 10.5px;
        width: ${A4_W_PX}px;
        height: ${A4_H_PX}px;
        background: #FFFFFF;
        position: relative;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      /* Print rule: keep the A4 height locked during print so the
         flex spacer can correctly push signatures to the bottom.
         page-break-inside: avoid prevents Chromium from splitting
         the letter across two pages even if rendering rounds up
         the height by a pixel or two. */
      @media print {
        .offer-letter {
          page-break-inside: avoid;
          break-inside: avoid;
        }
        .offer-letter * {
          page-break-inside: avoid;
          break-inside: avoid;
        }
      }
      .offer-letter .ar {
        font-family: 'Tahoma', 'Geeza Pro', 'Arial Unicode MS', 'Segoe UI', sans-serif !important;
        direction: rtl !important;
        text-align: right;
        /* CRITICAL: letter-spacing breaks Arabic letter joining.
           Even 0.5px between glyphs prevents the cursive
           ligatures Arabic requires (letters appear as
           disconnected stand-alone glyphs instead of joined
           words). Force 0 to override any parent rule
           (e.g. .band has letter-spacing:0.5px). */
        letter-spacing: 0 !important;
        /* isolate is the modern correct value — treats this
           element as a self-contained bidi region, preventing
           neutral characters (parens, hyphens, numbers) at the
           boundary from being pulled by surrounding LTR context. */
        unicode-bidi: isolate;
      }
      /* Top brand band */
      .offer-letter .brand-band {
        position: absolute;
        top: 0; left: 0; right: 0;
        height: 5px;
        background: #0F4C2A;
      }

      /* ─── LETTERHEAD ─── */
      .offer-letter .letterhead {
        display: grid;
        grid-template-columns: 80px 1fr 1fr;
        gap: 14px;
        align-items: center;
        margin-top: 6px;
        flex-shrink: 0;
      }
      .offer-letter .letterhead img.evg-logo {
        width: 70px;
        height: 70px;
        object-fit: contain;
      }
      .offer-letter .letterhead .h1 {
        font-size: 15px;
        color: #0F4C2A;
        font-weight: 700;
        margin: 0 0 3px;
        letter-spacing: 0.3px;
      }
      .offer-letter .letterhead .company-name {
        font-size: 10px;
        color: #0F172A;
        font-weight: 600;
        line-height: 1.35;
      }
      .offer-letter .letterhead .corp-detail {
        font-size: 8.5px;
        color: #525252;
        line-height: 1.45;
      }

      /* ─── REFERENCE & DATE ROW ─── */
      .offer-letter .ref-date {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 9.5px;
        color: #0F172A;
        margin: 8px 0 6px;
        padding: 5px 0;
        border-top: 1px solid #E5E5E5;
        border-bottom: 1px solid #E5E5E5;
        flex-shrink: 0;
      }
      .offer-letter .ref-date strong { color: #0F4C2A; }

      /* ─── TITLE ─── */
      .offer-letter h2.title {
        text-align: center;
        font-size: 18px;
        color: #0F4C2A;
        font-weight: 700;
        margin: 6px 0 8px;
        letter-spacing: 1.5px;
        flex-shrink: 0;
      }
      .offer-letter h2.title .title-sep {
        margin: 0 12px;
        color: #0F4C2A;
        font-weight: 400;
        opacity: 0.5;
      }
      .offer-letter h2.title .title-ar {
        font-family: 'Tahoma', 'Geeza Pro', 'Arial Unicode MS', 'Segoe UI', sans-serif;
        direction: rtl;
        unicode-bidi: isolate;
        font-size: 19px;
        letter-spacing: 0;
        font-weight: 700;
      }

      /* ─── INTRO ─── */
      .offer-letter .intro {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
        margin-bottom: 6px;
        flex-shrink: 0;
      }
      .offer-letter .intro p {
        margin: 0 0 3px;
        line-height: 1.4;
        font-size: 10px;
      }
      .offer-letter .intro strong { color: #0F172A; font-weight: 700; }

      /* ─── SECTION BANDS ─── */
      .offer-letter .band {
        background: #D4E8DC;
        padding: 4px 10px;
        font-weight: 700;
        color: #0F4C2A;
        font-size: 10.5px;
        display: flex;
        justify-content: space-between;
        margin: 4px 0 4px;
        letter-spacing: 0.5px;
        flex-shrink: 0;
      }

      /* ─── POSITION & COMPENSATION ─── */
      .offer-letter .pos-comp {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
        margin-bottom: 6px;
        flex-shrink: 0;
      }

      /* Position table — English labels only (left side stays EN-only) */
      .offer-letter .pos-table {
        width: 100%;
      }
      .offer-letter .pos-table .row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        padding: 5px 0;
        border-bottom: 1px solid #EAEAEA;
        align-items: center;
      }
      .offer-letter .pos-table .row:last-child { border-bottom: none; }
      .offer-letter .pos-table .label {
        color: #0F172A;
        font-weight: 600;
        font-size: 10.5px;
      }
      .offer-letter .pos-table .value {
        color: #0F172A;
        font-weight: 700;
        font-size: 11px;
        text-align: right;
        white-space: nowrap;
      }

      /* Salary table — English labels only */
      .offer-letter .sal-table {
        width: 100%;
        border-collapse: collapse;
      }
      .offer-letter .sal-table thead th {
        background: #0F4C2A;
        color: #FFFFFF;
        font-size: 10px;
        font-weight: 700;
        padding: 6px 8px;
        text-align: left;
        letter-spacing: 0.4px;
      }
      .offer-letter .sal-table thead th.amount-col {
        text-align: right;
      }
      .offer-letter .sal-table tbody tr:nth-child(even) {
        background: #F8FAF8;
      }
      .offer-letter .sal-table tbody td {
        padding: 6px 8px;
        vertical-align: middle;
      }
      .offer-letter .sal-table tbody .label {
        color: #0F172A;
        font-weight: 600;
        font-size: 10.5px;
      }
      .offer-letter .sal-table tbody .amount {
        text-align: right;
        font-weight: 700;
        color: #0F172A;
        font-size: 11.5px;
        white-space: nowrap;
      }
      .offer-letter .sal-table tfoot td {
        background: #0F4C2A;
        color: #FFFFFF;
        font-weight: 700;
        padding: 6px 8px;
        vertical-align: middle;
      }
      .offer-letter .sal-table tfoot .total-en {
        font-size: 12px;
        line-height: 1.25;
        letter-spacing: 0.3px;
      }
      .offer-letter .sal-table tfoot td.amount {
        text-align: right;
        font-size: 13px;
        white-space: nowrap;
        vertical-align: middle;
      }

      /* ─── KEY TERMS ─── */
      .offer-letter .terms-list {
        list-style: none;
        padding: 0;
        margin: 0 0 4px;
        flex-shrink: 0;
      }
      .offer-letter .terms-list li {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 14px;
        padding: 6px 0;
        white-space: nowrap;
        border-bottom: 1px solid #F4F4F4;
      }
      .offer-letter .terms-list li:last-child {
        border-bottom: none;
      }
      .offer-letter .terms-list .term-en,
      .offer-letter .terms-list .term-ar {
        font-size: 9.5px;
        line-height: 1.4;
      }
      .offer-letter .terms-list .term-en::before {
        content: '◆ ';
        color: #0F4C2A;
        font-weight: 700;
        font-size: 7.5px;
      }
      .offer-letter .terms-list .term-ar::before {
        content: '◆ ';
        color: #0F4C2A;
        font-weight: 700;
        font-size: 7.5px;
      }

      /* ─── 7-DAY VALIDITY CALLOUT (prominent) ─── */
      .offer-letter .validity-callout {
        background: linear-gradient(to right, #FEF2F2 0%, #FEF6E2 100%);
        border: 1.5px solid #DC2626;
        border-left: 5px solid #DC2626;
        border-radius: 4px;
        padding: 5px 10px;
        margin: 4px 0 3px;
        flex-shrink: 0;
      }
      .offer-letter .validity-callout .row {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 18px;
        align-items: center;
      }
      .offer-letter .validity-callout .head {
        font-size: 10.5px;
        font-weight: 700;
        color: #991B1B;
        margin-bottom: 1px;
        letter-spacing: 0.3px;
      }
      .offer-letter .validity-callout .head.ar { font-size: 11px; }
      .offer-letter .validity-callout .deadline {
        font-size: 9.5px;
        color: #0F172A;
        font-weight: 600;
      }
      .offer-letter .validity-callout .deadline strong { color: #991B1B; }

      /* ─── ACCEPTANCE NOTE ─── */
      .offer-letter .accept-note {
        font-size: 9px;
        color: #525252;
        margin: 3px 0;
        padding: 0 2px;
        line-height: 1.4;
        flex-shrink: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 16px;
      }

      /* ─── SPACER — pushes signatures all the way to the bottom
         of the A4 page. flex:1 takes whatever vertical space is
         left after the fixed-height content above (header +
         intro + tables + terms + callout + acceptance) and the
         fixed-height content below (signatures + footer). The
         .offer-letter container is locked to A4 height (1123px)
         and overflow:hidden, so the spacer can't grow past the
         page boundary — content always stays on one page.

         No max-height cap: the user wants signatures pushed to
         the very end of the page to make full use of A4. The
         page-break-inside: avoid rule (in @media print) is the
         safety net — if rendering rounds up by a pixel or two,
         Chromium will shrink-to-fit rather than split. */
      .offer-letter .spacer {
        flex: 1 1 auto;
        min-height: 0;
      }

      /* ─── SIGNATURES ─── */
      .offer-letter .signatures {
        display: grid;
        grid-template-columns: 1fr 130px 1fr;
        gap: 14px;
        margin-top: 8px;
        /* Center each column's content vertically so the seal sits
           in the middle of the row rather than the top. The company
           column (which has the longest content — name, title,
           corporate footer) defines the row height; without
           align-items:center the seal would stick to the top edge. */
        align-items: center;
        flex-shrink: 0;
      }
      .offer-letter .sig-company,
      .offer-letter .sig-candidate {
        display: flex;
        flex-direction: column;
        font-size: 9.5px;
        /* Stretch to fill the row so the signature LINE sits at the
           same vertical position on both sides — the line is
           anchored by its position in the column, not by alignment. */
        align-self: stretch;
      }
      .offer-letter .sig-label {
        font-size: 8px;
        color: #525252;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 6px;
        font-weight: 600;
      }
      .offer-letter .sig-line {
        border-top: 1px solid #525252;
        margin-bottom: 4px;
        height: 0;
      }
      .offer-letter .sig-name {
        font-size: 11px;
        color: #0F172A;
        font-weight: 700;
        letter-spacing: 0.3px;
      }
      .offer-letter .sig-title {
        font-size: 9.5px;
        color: #525252;
        margin-top: 1px;
        margin-bottom: 4px;
      }
      .offer-letter .corp-block {
        margin-top: 2px;
        padding-top: 3px;
        border-top: 1px dashed #D5D5D5;
        font-size: 7.5px;
        line-height: 1.4;
        color: #0F172A;
      }
      .offer-letter .corp-block .corp-line { color: #525252; }
      .offer-letter .corp-block .corp-name {
        font-weight: 700;
        color: #0F4C2A;
        font-size: 8.5px;
        letter-spacing: 0.2px;
      }

      /* Real company seal — applied as a slightly rotated PNG with
         authentic blue-stamp transparency. The slight rotation
         (-4deg) and reduced opacity (0.88) mimic ink-on-paper:
         a hand-applied stamp is never perfectly axis-aligned and
         the ink density varies across the impression. */
      .offer-letter .seal {
        width: 130px;
        height: 130px;
        /* Center inside the signatures grid cell. With the parent
           grid using align-items:center, this self-centers both
           horizontally (margin auto) and vertically (the parent
           takes care of vertical alignment). */
        margin: 0 auto;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .offer-letter .seal img.seal-img {
        width: 100%;
        height: 100%;
        object-fit: contain;
        /* Slight rotation only — looks like a hand-applied stamp.
           NO opacity / mix-blend-mode / filter properties: those
           force Chromium's print engine to rasterize the entire
           page (text becomes pixels instead of vectors), so the
           saved PDF loses sharpness. The seal PNG is already
           transparent-background and pre-shaded the right blue
           tone, so it lays on white paper cleanly without needing
           any blend tricks. */
        transform: rotate(-4deg);
      }

      .offer-letter .candidate-confirm {
        margin-top: 3px;
        font-size: 7.5px;
        color: #525252;
        line-height: 1.35;
        font-style: italic;
      }

      /* ─── CONFIDENTIALITY FOOTER ─── */
      .offer-letter .foot {
        margin-top: 6px;
        padding-top: 4px;
        border-top: 1px solid #E5E5E5;
        font-size: 7px;
        color: #999;
        display: flex;
        justify-content: space-between;
        flex-shrink: 0;
      }
    </style>

    <div class="offer-letter">
      <div class="brand-band"></div>

      <!-- LETTERHEAD with full corporate contact details -->
      <div class="letterhead">
        <div><img class="evg-logo" src="/evergreen-logo.jpg" alt="" /></div>
        <div>
          <div class="h1">${e(COMPANY.brandEn)}</div>
          <div class="company-name">${e(COMPANY.nameFullEn)}</div>
          <div class="corp-detail">${e(COMPANY.branchEn)}</div>
          <div class="corp-detail">${e(COMPANY.cr)} · ${e(COMPANY.computerNo)}</div>
          <div class="corp-detail">Tel: ${e(COMPANY.tel)} · Fax: ${e(COMPANY.fax)}</div>
          <div class="corp-detail">Email: ${e(COMPANY.email)}</div>
        </div>
        <div class="ar">
          <div class="h1">${e(COMPANY.brandAr)}</div>
          <div class="company-name">${e(COMPANY.nameFullAr)}</div>
          <div class="corp-detail">${e(COMPANY.branchAr)}</div>
          <div class="corp-detail">${e(COMPANY.cr)} · ${e(COMPANY.computerNo)}</div>
          <div class="corp-detail">هاتف: ${e(COMPANY.tel)} · فاكس: ${e(COMPANY.fax)}</div>
          <div class="corp-detail">البريد الإلكتروني: ${e(COMPANY.email)}</div>
        </div>
      </div>

      <!-- REFERENCE & DATE -->
      <div class="ref-date">
        <span><strong>Ref:</strong> ${e(ref)}</span>
        <span><strong>Date · التاريخ:</strong> ${e(dateEN)} · ${e(dateAR)}</span>
      </div>

      <!-- TITLE -->
      <h2 class="title">
        LETTER OF OFFER
        <span class="title-sep">·</span>
        <span class="title-ar">خطاب عرض عمل</span>
      </h2>

      <!-- INTRO -->
      <div class="intro">
        <div>
          <p><strong>Dear ${e(offer.candidateName || '')},</strong></p>
          <p>We are pleased to extend you a formal offer of employment to join ${e(COMPANY.nameFullEn)} on the terms and conditions set out below. Acceptance is subject to your agreement to these Terms and successful onboarding through the SOL system.</p>
        </div>
        <div class="ar">
          <p><strong>السيد/ة الفاضل/ة ${e(offer.candidateName || '')}،</strong></p>
          <p>تحية طيبة وبعد،</p>
          <p>يسرنا أن نتقدم إليكم بعرض عمل رسمي للانضمام إلى ${e(COMPANY.nameFullAr)}، وذلك وفقاً للشروط والأحكام المبينة أدناه. يخضع هذا العرض لقبولكم بهذه الشروط ولاستيفاء إجراءات الالتحاق عبر نظام SOL.</p>
        </div>
      </div>

      <!-- POSITION & COMPENSATION BAND -->
      <div class="band">
        <span>POSITION &amp; COMPENSATION DETAILS</span>
        <span class="ar">تفاصيل الوظيفة والراتب</span>
      </div>

      <!-- POSITION + SALARY (side by side) -->
      <div class="pos-comp">
        <!-- Position table — English labels only -->
        <div class="pos-table">
          ${posRow('Position', offer.positionTitle)}
          ${posRow('Department', offer.department)}
          ${posRow('Office', offer.location)}
          ${posRow('Joining Date', formatDateLong(offer.proposedJoinDate))}
          ${posRow('Working Hours', '40 hr/week · Sun-Thu')}
          ${posRow('PROBATION PERIOD', '90 days')}
        </div>

        <!-- Salary table — English labels only -->
        <table class="sal-table">
          <thead>
            <tr>
              <th>SALARY BREAKDOWN</th>
              <th class="amount-col">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${salRow('Basic Salary', sar(offer.salaryBasic))}
            ${salRow('Housing Allowance', sar(offer.salaryHousing))}
            ${salRow('Transportation Allowance', sar(offer.salaryTransport))}
            ${salRow('Other Allowance', sar(offer.salaryOther))}
          </tbody>
          <tfoot>
            <tr>
              <td>
                <div class="total-en">TOTAL MONTHLY SALARY</div>
              </td>
              <td class="amount">${sar(offer.salaryTotal)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <!-- KEY TERMS BAND -->
      <div class="band">
        <span>KEY TERMS — Per KSA Labor Law</span>
        <span class="ar">الشروط الأساسية — وفقاً لنظام العمل السعودي</span>
      </div>

      <ul class="terms-list">
        ${termRow('Probation: 90 days from joining (Article 53)', 'فترة التجربة: تسعون يوماً من تاريخ المباشرة (المادة 53)')}
        ${termRow('Notice period: 60 days written (Article 75)', 'مهلة الإخطار: ستون يوماً بإشعار خطي (المادة 75)')}
        ${termRow('Annual leave: 21 days (yr 1–5), 30 days from yr 6', 'الإجازة السنوية: 21 يوماً (السنوات 1-5)، 30 يوماً اعتباراً من السنة السادسة')}
        ${termRow('Sick leave: 30 full + 60 at 75% + 30 unpaid (Art. 117)', 'الإجازة المرضية: 30 يوماً بأجر كامل + 60 يوماً بثلاثة أرباع الأجر + 30 يوماً بدون أجر (المادة 117)')}
        ${termRow('End-of-service gratuity per Articles 84–88', 'مكافأة نهاية الخدمة وفقاً لأحكام المواد 84-88')}
        ${termRow('GOSI registration + medical insurance from joining', 'التسجيل لدى التأمينات الاجتماعية والتأمين الصحي من تاريخ المباشرة')}
        ${termRow('Confidentiality of Company info during &amp; after work', 'الالتزام بسرية معلومات الشركة أثناء العمل وبعد انتهائه')}
      </ul>

      <!-- 7-DAY VALIDITY CALLOUT (prominent, red accent) -->
      <div class="validity-callout">
        <div class="row">
          <div>
            <div class="head">⏱  THIS OFFER IS VALID FOR 7 DAYS ONLY</div>
            <div class="deadline">Please accept by <strong>${e(expiryEN)}</strong>. After this date the offer expires automatically.</div>
          </div>
          <div class="ar">
            <div class="head ar">⏱  هذا العرض ساري المفعول لمدة 7 أيام فقط</div>
            <div class="deadline ar">يُرجى القبول قبل تاريخ <strong>${e(expiryAR)}</strong>. وفي حال انقضاء هذه المدة دون قبول، يُعدّ العرض لاغياً تلقائياً.</div>
          </div>
        </div>
      </div>

      <!-- ACCEPTANCE INSTRUCTION -->
      <div class="accept-note">
        <div>To accept, please use the secure acceptance link sent in the covering email. After acceptance, HR will register you in SOL and issue your Personal Service Number (PSN).</div>
        <div class="ar">للقبول، يُرجى استخدام رابط القبول الآمن المرسل في خطاب البريد الإلكتروني المرفق. بعد القبول، تتولى إدارة الموارد البشرية تسجيلكم في نظام SOL وإصدار رقم الخدمة الشخصي الخاص بكم.</div>
      </div>

      <!-- SPACER pushing signatures to bottom -->
      <div class="spacer"></div>

      <!-- SIGNATURES at bottom of page -->
      <div class="signatures">
        <!-- LEFT: Company side, full corporate signature -->
        <div class="sig-company">
          <div class="sig-label">For and on behalf of · بالنيابة عن الشركة</div>
          <div class="sig-line"></div>
          <div class="sig-name">${e((signatory?.name || '—').toUpperCase())}</div>
          <div class="sig-title">${e(signatory?.title || '—')}</div>
          <div class="corp-block">
            <div class="corp-name">${e(COMPANY.nameFullEn)}</div>
            <div class="corp-line">${e(COMPANY.branchEn)}</div>
            <div class="corp-line">${e(COMPANY.cr)}</div>
            <div class="corp-line">Tel: ${e(COMPANY.tel)} · Fax: ${e(COMPANY.fax)}</div>
            <div class="corp-line">${e(COMPANY.email)}</div>
          </div>
        </div>

        <!-- MIDDLE: Company seal — actual stamped image -->
        <div class="seal">
          <img class="seal-img" src="/company-seal.png" alt="Company Seal · ختم الشركة" />
        </div>

        <!-- RIGHT: Candidate signature -->
        <div class="sig-candidate">
          <div class="sig-label">Candidate Acceptance · موافقة المرشح</div>
          <div class="sig-line"></div>
          <div class="sig-name">${e((offer.candidateName || '—').toUpperCase())}</div>
          <div class="sig-title">Signature &amp; Date · التوقيع والتاريخ</div>
          <div class="candidate-confirm">By signing, I accept the offer above and the Terms set out in this letter.<br><span class="ar" style="display:block;margin-top:3px;">أُقرّ بقبولي العرض المذكور أعلاه والشروط الواردة في هذا الخطاب.</span></div>
        </div>
      </div>

      <!-- CONFIDENTIALITY FOOTER -->
      <div class="foot">
        <span>Confidential · addressed solely to the named candidate.</span>
        <span class="ar">وثيقة سرية · موجهة إلى المرشح المسمى حصراً.</span>
      </div>
    </div>
  `;
}

// ─── HTML helper templates ─────────────────────────────────────────

function posRow(label, value) {
  const e = escapeHtml;
  return `
    <div class="row">
      <div class="label">${e(label)}</div>
      <div class="value">${e(value || '—')}</div>
    </div>
  `;
}

function salRow(label, amount) {
  const e = escapeHtml;
  return `
    <tr>
      <td class="label">${e(label)}</td>
      <td class="amount">${e(amount)}</td>
    </tr>
  `;
}

function termRow(en, ar) {
  const e = escapeHtml;
  return `
    <li>
      <span class="term-en">${e(en)}</span>
      <span class="term-ar ar">${e(ar)}</span>
    </li>
  `;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDateLong(yyyymmdd) {
  if (!yyyymmdd) return '—';
  const [y, m, d] = String(yyyymmdd).split('-').map(Number);
  if (!y || !m || !d) return yyyymmdd;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ═══════════════════════════════════════════════════════════════════
// EMAIL (.eml) GENERATION — unchanged
// ═══════════════════════════════════════════════════════════════════

export function buildOfferEmailBody(offer, acceptanceUrl, sender) {
  const candidate = offer.candidateName || 'Candidate';
  const position = offer.positionTitle || 'the role';

  // Body lines, joined with \r\n at the end. The signature block
  // is rendered from emailTemplates.renderHrSignature() so we
  // share one canonical signature across every email the portal
  // generates on Bashaier's behalf — change in one place,
  // propagates everywhere.
  const body = [
    `Dear ${candidate},`,
    ``,
    `We are pleased to extend an offer for the position of ${position} at Evergreen Shipping Agency Saudi Co. (LLC).`,
    ``,
    `Please find the formal offer letter attached. The letter contains the full details of the position, salary breakdown, joining date, and key terms in both English and Arabic.`,
    ``,
    `To accept this offer, please click the secure acceptance link below:`,
    ``,
    `  ${acceptanceUrl}`,
    ``,
    `IMPORTANT: This offer is valid for 7 days only. Please accept within this period or the offer will expire automatically.`,
    ``,
    `After accepting, we will proceed with onboarding through the SOL system and issue your Personal Service Number (PSN).`,
    ``,
    `If you have any questions or wish to discuss any of the terms, please reply to this email — I will be happy to help.`,
    ``,
    `We look forward to welcoming you to the team.`,
    ``,
    renderHrSignature(),  // canonical signature block
  ].join('\r\n');

  return body;
}

export async function buildEmlMessage(args) {
  const {
    fromName, fromEmail, toEmail, toName,
    subject, body, pdfBlob, pdfFilename,
  } = args;

  const dateHeader = new Date().toUTCString().replace('GMT', '+0000');
  const fromHeader = `${escapeHeader(fromName)} <${fromEmail}>`;
  const toHeader   = toName ? `${escapeHeader(toName)} <${toEmail}>` : toEmail;

  // ─── Body-only mode ────────────────────────────────────────────
  // When pdfBlob is null/undefined we emit a simple plain-text
  // email with no multipart MIME structure. Used by the new
  // print-to-PDF flow where Bashaier saves the PDF separately
  // and attaches it to the Outlook draft manually before sending.
  if (!pdfBlob) {
    const lines = [
      `From: ${fromHeader}`,
      `To: ${toHeader}`,
      `Subject: ${escapeHeader(subject)}`,
      `Date: ${dateHeader}`,
      `MIME-Version: 1.0`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: quoted-printable`,
      ``,
      quotedPrintableEncode(body),
      ``,
    ];
    const eml = lines.join('\r\n');
    return new Blob([eml], { type: 'message/rfc822' });
  }

  // ─── Multipart with PDF attachment (legacy path, kept for
  // future use if we revisit auto-attach) ─────────────────────────
  const pdfBase64 = await blobToBase64(pdfBlob);
  const wrappedBase64 = wrapLine(pdfBase64, 76);

  const boundary = 'evergreen-offer-' + Math.random().toString(36).slice(2, 10);

  const lines = [
    `From: ${fromHeader}`,
    `To: ${toHeader}`,
    `Subject: ${escapeHeader(subject)}`,
    `Date: ${dateHeader}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: quoted-printable`,
    ``,
    quotedPrintableEncode(body),
    ``,
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFilename}"`,
    `Content-Transfer-Encoding: base64`,
    `Content-Disposition: attachment; filename="${pdfFilename}"`,
    ``,
    wrappedBase64,
    ``,
    `--${boundary}--`,
    ``,
  ];

  const eml = lines.join('\r\n');
  return new Blob([eml], { type: 'message/rfc822' });
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const base64 = dataUrl.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function wrapLine(s, width) {
  if (!s) return '';
  const lines = [];
  for (let i = 0; i < s.length; i += width) {
    lines.push(s.slice(i, i + width));
  }
  return lines.join('\r\n');
}

function escapeHeader(s) {
  const str = String(s || '');
  if (/[^\x20-\x7E]/.test(str) || /["\\]/.test(str)) {
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return `=?UTF-8?B?${b64}?=`;
  }
  return str;
}

function quotedPrintableEncode(text) {
  if (!text) return '';
  const bytes = new TextEncoder().encode(text);
  let out = '';
  let lineLen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let chunk;
    if (b === 0x0d) continue;
    if (b === 0x0a) { out += '\r\n'; lineLen = 0; continue; }
    if (b === 0x3d) chunk = '=3D';
    else if (b >= 0x20 && b <= 0x7e) chunk = String.fromCharCode(b);
    else chunk = '=' + b.toString(16).toUpperCase().padStart(2, '0');
    if (lineLen + chunk.length > 75) { out += '=\r\n'; lineLen = 0; }
    out += chunk;
    lineLen += chunk.length;
  }
  return out;
}

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

export function generateOfferToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
