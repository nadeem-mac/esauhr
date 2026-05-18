// =============================================================================
// formCore.js — shared building blocks for the ESAU HR form suite
//
// Purpose: every HR form (vacation / joining / permission / etc.) shares
// the same brand header, section bands, label-value tables, signature
// grid, and bottom stamp. Putting them here means each new form module
// is small and visual consistency is enforced by construction. No more
// drift between forms.
//
// 2026-05-10 (Nadeem): 'do all the forms including permission, sick
// leave, maternity leave, hajj, study, all of it'.
// =============================================================================

import jsPDF from 'jspdf';
import QRCode from 'qrcode';

// ─── shared constants ──────────────────────────────────────────────────────

export const VERIFY_BASE_URL = (typeof window !== 'undefined' && window.location?.origin)
  ? window.location.origin
  : 'https://esauhr.netlify.app';

export const DEPT_NAMES = {
  BIZ: 'Business',
  CSD: 'Customer Service',
  FIN: 'Finance',
  LOG: 'Logistics',
  SUP: 'Supervisory',
  'RYD OFFICE': 'Riyadh Office',
};
export const LOC_NAMES = { DMM: 'Dammam', JED: 'Jeddah', RYD: 'Riyadh' };

export const CEO_NAME      = 'JOHN HO';
export const CEO_TITLE_EN  = 'Country Head / CEO';
export const HR_DEFAULT    = 'BASHAIER ALI ALSUBAIE';

// Brand palette — same across every form.
export const C = {
  text:    [31, 27, 22],
  muted:   [115, 110, 100],
  copper:  [157, 107, 83],
  brand:   [45, 95, 63],
  border:  [220, 213, 195],
  banner:  [248, 245, 235],
  labelBg: [252, 250, 244],
  accent:  [232, 240, 233],
};

export const PAGE_W    = 210;
export const PAGE_H    = 297;
export const MARGIN_X  = 14;
export const MARGIN_T  = 5;
export const CONTENT_W = PAGE_W - (MARGIN_X * 2);

// ─── formatters ────────────────────────────────────────────────────────────

export function fmtDateLong(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
}

export function fmtDateShort(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

export function fmtStampCompact(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

export function shortRef(id, prefix = 'LV') {
  const s = String(id ?? '').trim();
  // If the id already starts with the desired prefix (e.g. caller
  // passed a human-readable 'LV-61F7EA2F'), don't double-prefix it.
  const upperPrefix = `${prefix}-`.toUpperCase();
  if (s.toUpperCase().startsWith(upperPrefix)) {
    return s.toUpperCase();
  }
  const hex = s.replace(/-/g, '');
  if (hex.length > 8 && /^[0-9a-f]+$/i.test(hex)) {
    return `${prefix}-${hex.slice(0, 8).toUpperCase()}`;
  }
  return `${prefix}-${s.padStart(5, '0')}`;
}

export function fmtSAR(amount) {
  if (amount == null || amount === '') return '—';
  const n = Number(amount);
  if (isNaN(n)) return String(amount);
  return `SAR ${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

// ─── asset loading ─────────────────────────────────────────────────────────

let logoDataUrl = null;
export async function loadLogoDataUrl() {
  if (logoDataUrl) return logoDataUrl;
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    const blob = await res.blob();
    logoDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return logoDataUrl;
  } catch {
    return null;
  }
}

export async function generateQRCode(verifyPath) {
  const url = `${VERIFY_BASE_URL}${verifyPath}`;
  return QRCode.toDataURL(url, { margin: 0, width: 180, errorCorrectionLevel: 'M' });
}

// ─── drawing primitives ────────────────────────────────────────────────────

export function drawText(pdf, text, x, y, opts = {}) {
  if (!text && text !== 0) return;
  pdf.setFont(opts.font || 'helvetica', opts.style || 'normal');
  pdf.setFontSize(opts.size || 10);
  if (opts.color) pdf.setTextColor(...opts.color);
  pdf.text(String(text), x, y, opts);
}

export function drawRect(pdf, x, y, w, h, opts = {}) {
  if (opts.fill) {
    pdf.setFillColor(...opts.fill);
    if (opts.stroke) {
      pdf.setDrawColor(...opts.stroke);
      pdf.setLineWidth(opts.strokeWidth || 0.2);
      pdf.rect(x, y, w, h, 'FD');
    } else {
      pdf.rect(x, y, w, h, 'F');
    }
  } else if (opts.stroke) {
    pdf.setDrawColor(...opts.stroke);
    pdf.setLineWidth(opts.strokeWidth || 0.2);
    pdf.rect(x, y, w, h, 'S');
  }
}

export function drawLine(pdf, x1, y1, x2, y2, opts = {}) {
  pdf.setDrawColor(...(opts.color || C.border));
  pdf.setLineWidth(opts.width || 0.2);
  pdf.line(x1, y1, x2, y2);
}

export function drawTickbox(pdf, x, y, checked) {
  const size = 2.8;
  if (checked) {
    pdf.setFillColor(...C.brand);
    pdf.setDrawColor(...C.brand);
    pdf.setLineWidth(0.3);
    pdf.rect(x, y - size + 0.4, size, size, 'FD');
    pdf.setDrawColor(255, 255, 255);
    pdf.setLineWidth(0.5);
    pdf.line(x + 0.7, y - size / 2 + 0.4, x + 1.2, y - 0.2);
    pdf.line(x + 1.2, y - 0.2,            x + 2.2, y - size + 0.9);
  } else {
    pdf.setDrawColor(...C.border);
    pdf.setLineWidth(0.3);
    pdf.rect(x, y - size + 0.4, size, size, 'S');
  }
}

// ─── high-level building blocks ───────────────────────────────────────────

// Brand header — logo, wordmark, date, reference, QR. 28mm tall.
export function drawHeader(pdf, y, { logoUrl, qrDataUrl, request, refPrefix = 'LV' }) {
  const h = 28;
  drawLine(pdf, MARGIN_X, y + h, MARGIN_X + CONTENT_W, y + h,
    { color: C.brand, width: 0.6 });

  if (logoUrl) {
    try { pdf.addImage(logoUrl, 'JPEG', MARGIN_X, y + 1, 24, 24); } catch {}
  } else {
    // Logo placeholder — text mark only when the image isn't available
    drawRect(pdf, MARGIN_X, y + 1, 24, 24, { stroke: C.brand, strokeWidth: 0.3 });
    drawText(pdf, 'EVG', MARGIN_X + 8, y + 15, {
      size: 13, color: C.brand, style: 'bold',
    });
  }

  drawText(pdf, 'EVERGREEN LINE', MARGIN_X + 28, y + 9, {
    size: 16, color: C.brand, style: 'bold',
  });
  drawText(pdf, 'Evergreen Shipping Agency Saudi Co. (L.L.C)', MARGIN_X + 28, y + 14.5, {
    size: 9, color: C.muted, style: 'italic',
  });
  drawText(pdf, 'ESAU · SADMN SUP / HR Department', MARGIN_X + 28, y + 19, {
    size: 8.5, color: C.muted,
  });

  const qrSize = 22;
  const qrX = PAGE_W - MARGIN_X - qrSize;
  const refX = qrX - 50;
  drawText(pdf, 'DATE', refX, y + 5, { size: 7, color: C.muted, style: 'bold' });
  drawText(pdf, fmtDateShort(new Date().toISOString()), refX, y + 10, {
    size: 11, color: C.text, style: 'bold',
  });
  drawText(pdf, 'REFERENCE', refX, y + 16, { size: 7, color: C.muted, style: 'bold' });
  drawText(pdf, shortRef(request.id, refPrefix), refX, y + 21, {
    size: 11, color: C.text, font: 'courier', style: 'bold',
  });

  if (qrDataUrl) {
    pdf.addImage(qrDataUrl, 'PNG', qrX, y + 2, qrSize, qrSize);
    drawText(pdf, 'Scan to verify', qrX + qrSize / 2, y + 26.5, {
      size: 6.5, color: C.muted, align: 'center',
    });
  }
  return y + h;
}

// Centered form title with brand-coloured underline. Sized to match
// the Permission Request — Late Arrival title style (20pt centered
// brand-green with a 0.5mm brand-coloured underline). All forms now
// use this exact treatment so the title reads with the same authority
// across leave applications, permissions, rejoining reports, and
// joining reports. Nadeem 2026-05-18.
export function drawTitle(pdf, y, titleText) {
  drawText(pdf, titleText, PAGE_W / 2, y + 7, {
    size: 20, color: C.brand, style: 'bold', align: 'center',
  });
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(20);
  const tw = pdf.getTextWidth(titleText);
  drawLine(pdf, (PAGE_W - tw) / 2, y + 10, (PAGE_W + tw) / 2, y + 10,
    { color: C.brand, width: 0.5 });
  return y + 12;
}

// Section header — full-width green-tinted band with a thicker brand-
// coloured left stripe. Promoted from permissionRequestPdf.js so every
// form uses the same visual treatment. Nadeem 2026-05-18: 'I really
// like the clean structure in Permission Request — Late Arrival.'
//
// Why these dimensions: 9mm tall + 2.2mm left stripe reads as a
// genuine section break at print size — small enough to not dominate
// the page, big enough to be unmistakable. The 11pt brand-green label
// sits comfortably inside with breathing room on every side.
export function drawSectionHeader(pdf, y, text) {
  const h = 7.5;
  drawRect(pdf, MARGIN_X, y, CONTENT_W, h, { fill: C.accent });
  drawRect(pdf, MARGIN_X, y, 2.2, h, { fill: C.brand });
  drawText(pdf, text, MARGIN_X + 7, y + 5.2, {
    size: 10.5, color: C.brand, style: 'bold',
  });
  return y + h + 1;
}

// Single info row — label on the left (muted), value on the right (text
// color). The clean form-style row used throughout permission PDFs and
// now adopted across every form. Returns the y position after the row,
// including the closing hairline divider. Promoted from
// permissionRequestPdf.js so every form generator can use the same
// pattern. Nadeem 2026-05-18.
export function drawSingleRow(pdf, y, label, value, { emphasis = false } = {}) {
  const labelW  = 60;
  const valueW  = CONTENT_W - labelW - 4;
  const wrapped = pdf.splitTextToSize(String(value ?? '—'), valueW);
  const lineCount = Array.isArray(wrapped) ? wrapped.length : 1;
  const rowH = Math.max(7, lineCount * 4.2 + 2);
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.2 });
  drawText(pdf, label, MARGIN_X + 3, y + 5, {
    size: 9.5, color: C.muted, style: 'bold',
  });
  pdf.setFont('helvetica', emphasis ? 'bold' : 'normal');
  pdf.setFontSize(10.5);
  pdf.setTextColor(...C.text);
  pdf.text(wrapped, MARGIN_X + labelW + 2, y + 5);
  drawLine(pdf, MARGIN_X, y + rowH, MARGIN_X + CONTENT_W, y + rowH,
    { color: C.border, width: 0.2 });
  return y + rowH;
}

// Two-column label-value table. Each row is [[labelA, valueA], [labelB, valueB]];
// either side can be null to leave that half empty.
export function drawTwoColTable(pdf, startY, rows) {
  const colW   = CONTENT_W / 2;
  const labelW = 32;
  const valueW = colW - labelW - 4;
  let y = startY;
  for (const row of rows) {
    const [left, right] = row;
    const leftLines  = left  ? pdf.splitTextToSize(String(left[1]  || '—'), valueW) : [''];
    const rightLines = right ? pdf.splitTextToSize(String(right[1] || '—'), valueW) : [''];
    const lineCount  = Math.max(leftLines.length, rightLines.length, 1);
    const rowH       = Math.max(6, lineCount * 4 + 2);

    if (y > startY) {
      drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
        { color: C.border, width: 0.15 });
    }
    drawLine(pdf, MARGIN_X + colW, y, MARGIN_X + colW, y + rowH,
      { color: C.border, width: 0.15 });

    if (left) {
      drawText(pdf, left[0], MARGIN_X + 1, y + 4.2, {
        size: 7.5, color: C.muted, style: 'bold',
      });
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(...C.text);
      pdf.text(leftLines, MARGIN_X + labelW + 2, y + 4.2);
    }
    if (right) {
      drawText(pdf, right[0], MARGIN_X + colW + 2, y + 4.2, {
        size: 7.5, color: C.muted, style: 'bold',
      });
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(...C.text);
      pdf.text(rightLines, MARGIN_X + colW + labelW + 3, y + 4.2);
    }
    y += rowH;
  }
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  return y;
}

// Single-column label/value (use when value is long and needs full width).
//
// Refined editorial treatment (Nadeem 2026-05-17): label sits ABOVE the
// value rather than to the left, uppercase tracking-wide kicker style,
// value renders in a slightly larger weight beneath. Reads as a
// magazine info-card rather than a Word form table. Generates more
// vertical rhythm and removes the visual noise of column dividers.
//
// Callers that want the OLD two-column layout (label left, value right)
// can use drawTwoColTable instead — kept for backward compatibility.
export function drawLabelValueTable(pdf, startY, rows) {
  let y = startY + 0.5;
  for (const [label, value] of rows) {
    const wrapped   = pdf.splitTextToSize(String(value || '—'), CONTENT_W - 2);
    const lineCount = Array.isArray(wrapped) ? wrapped.length : 1;
    // Row = small label line (3mm) + value line(s) + bottom padding (2mm)
    const rowH = 2.8 + (lineCount * 4.2) + 2;
    // Faint divider before subsequent rows
    if (y > startY + 1) {
      drawLine(pdf, MARGIN_X, y - 0.5, MARGIN_X + CONTENT_W, y - 0.5,
        { color: C.border, width: 0.12 });
    }
    drawText(pdf, label.toUpperCase(), MARGIN_X + 1, y + 2.4, {
      size: 6.5, color: C.muted, style: 'bold',
    });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(...C.text);
    pdf.text(wrapped, MARGIN_X + 1, y + 7);
    y += rowH;
  }
  return y + 0.5;
}

// Bulleted policy list. Caller passes the list of bullet strings.
export function drawPolicyBullets(pdf, y, bullets) {
  const lineH = 3.4;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(...C.text);
  bullets.forEach((b, i) => {
    const num = `${(i + 1).toString().padStart(2, '0')}.`;
    drawText(pdf, num, MARGIN_X + 4, y + 3.2, {
      size: 7.5, color: C.brand, style: 'bold',
    });
    const wrapped = pdf.splitTextToSize(b, CONTENT_W - 16);
    pdf.text(wrapped, MARGIN_X + 12, y + 3.2);
    y += wrapped.length * lineH + 0.3;
  });
  return y;
}

// Four-cell signature grid. Names auto-fit (9pt→8pt→7pt) and wrap to
// two lines if even 7pt overflows the cell width. Label, name, and
// subtitle are all centered horizontally within each cell.
export function drawSignatures(pdf, y, cells) {
  const cellW  = CONTENT_W / 4;
  const cellH  = 35.4;
  const innerW = cellW - 4;
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.3 });
  for (let i = 0; i < cells.length; i++) {
    const cx = MARGIN_X + i * cellW;
    const cellCenterX = cx + cellW / 2;
    if (i > 0) {
      drawLine(pdf, cx, y, cx, y + cellH, { color: C.border, width: 0.15 });
    }
    drawText(pdf, cells[i].label, cellCenterX, y + 4.5, {
      size: 8, color: C.muted, style: 'bold', align: 'center',
    });
    const lineY = y + cellH - 11;
    drawLine(pdf, cx + 2, lineY, cx + cellW - 2, lineY,
      { color: C.text, width: 0.3 });

    let nameSize = 9;
    let nameLines = [cells[i].name || '_________________'];
    let fitOnOneLine = false;
    pdf.setFont('helvetica', 'bold');
    for (const sz of [9, 8, 7]) {
      pdf.setFontSize(sz);
      if (pdf.getTextWidth(nameLines[0]) <= innerW) {
        nameSize = sz; fitOnOneLine = true; break;
      }
      nameSize = sz;
    }
    if (!fitOnOneLine) {
      pdf.setFontSize(nameSize);
      nameLines = pdf.splitTextToSize(cells[i].name || '_________________', innerW).slice(0, 2);
    }
    const lineH = nameSize * 0.45;
    // Stack name lines BELOW the signature underline (not centred
    // around it). For single-line names, the name sits at lineY+4 just
    // under the line. For multi-line names (long manager names like
    // 'SADAKATHULLAH SHADULY PALAYAM MEERA SAHIB' that need to wrap),
    // subsequent lines push DOWN from the first, never up onto the
    // line itself — which previously produced a strikethrough effect
    // where the signature line cut through the first line of the name.
    nameLines.forEach((ln, idx) => {
      drawText(pdf, ln, cellCenterX,
        lineY + 4 + (idx * lineH),
        { size: nameSize, color: C.text, style: 'bold', align: 'center' });
    });
    drawText(pdf, cells[i].subtitle, cellCenterX,
      lineY + 4 + (nameLines.length * lineH) + 1.5, {
      size: 7.5, color: C.muted, style: 'italic', align: 'center',
    });
  }
  drawLine(pdf, MARGIN_X, y + cellH, MARGIN_X + CONTENT_W, y + cellH,
    { color: C.border, width: 0.3 });
  return y + cellH;
}

// Rotated "Generated on" stamp along the right edge — present on every
// form for audit. Same exact positioning across the suite for consistency.
export function drawGeneratedStamp(pdf, generatedBy) {
  const stamp = `Generated on ${fmtStampCompact(new Date().toISOString())}  ·  ${generatedBy || HR_DEFAULT}`;
  pdf.setFont('helvetica', 'italic');
  pdf.setFontSize(7);
  pdf.setTextColor(...C.muted);
  pdf.text(stamp, PAGE_W - 3, PAGE_H - 8, { angle: 90 });
}

// ──────────────────────────────────────────────────────────────────────
//  Checkbox primitive — draws a small box at (x, y) with optional check
//  mark, then renders a label to the right. Used by the leave-application
//  PDF to render checkbox-style rows (leave type, half-day, notice) per
//  the Vacation_Sample.docx template. Returns the x position where the
//  next checkbox should start (label width + padding).
//
//  Unicode glyphs like ☑/☐ render unreliably in Helvetica so we draw the
//  actual rectangle + a small bold check inside instead.
// ──────────────────────────────────────────────────────────────────────
export function drawCheckbox(pdf, x, y, label, checked, opts = {}) {
  const boxSize = opts.size || 3;
  const labelSize = opts.labelSize || 9;
  const labelGap = 1.5;
  // Outer square
  drawRect(pdf, x, y, boxSize, boxSize, {
    stroke: checked ? C.text : C.border,
    strokeWidth: checked ? 0.5 : 0.3,
  });
  if (checked) {
    // Small filled inner square — reads as 'checked' at print size and
    // doesn't depend on glyph support.
    drawRect(pdf, x + 0.7, y + 0.7, boxSize - 1.4, boxSize - 1.4,
      { fill: C.text });
  }
  // Label
  pdf.setFont('helvetica', checked ? 'bold' : 'normal');
  pdf.setFontSize(labelSize);
  pdf.setTextColor(...(checked ? C.text : (opts.unselectedColor || C.muted)));
  pdf.text(label, x + boxSize + labelGap, y + boxSize - 0.6);
  // Return the x-coord where the NEXT chip should start
  const labelWidth = pdf.getStringUnitWidth(label) * labelSize / pdf.internal.scaleFactor;
  return x + boxSize + labelGap + labelWidth + (opts.gap || 3.5);
}

// Draws an arbitrary number of checkboxes in a horizontal row, wrapping
// to the next line when the row width is exceeded. Used for the leave-
// type row (10 types in one row).
export function drawCheckboxRow(pdf, x, y, items, opts = {}) {
  const maxX = opts.maxX || (MARGIN_X + CONTENT_W - 2);
  const lineGap = opts.lineGap || 5;
  let cx = x;
  let cy = y;
  let lineCount = 1;
  for (const it of items) {
    const labelWidth = pdf.getStringUnitWidth(it.label) * (opts.labelSize || 9)
                       / pdf.internal.scaleFactor;
    const chipWidth = 3 /* box */ + 1.5 /* gap */ + labelWidth + 3.5 /* trailing gap */;
    if (cx + chipWidth > maxX && cx > x) {
      cx = x;
      cy += lineGap;
      lineCount++;
    }
    cx = drawCheckbox(pdf, cx, cy, it.label, !!it.checked, opts);
  }
  return { y: cy, lineCount };
}

// ──────────────────────────────────────────────────────────────────────
//  Refined section header — minimal kicker style.
//
//  Replaces the bordered green bar with a lighter editorial treatment:
//  a single brand-green left rule + small tracking-wide label + faint
//  hairline on the right that runs to the edge. Reads as a magazine
//  section break rather than a Word-style highlighted bar. Much less
//  visual weight per section so the whole form can breathe.
//
//  The 'ar' arg is accepted but ignored — kept for backward compatibility
//  with earlier code paths. English-only is the canonical look now.
// ──────────────────────────────────────────────────────────────────────
export function drawBilingualSectionHeader(pdf, y, en /* ar ignored */) {
  const padTop = 4;
  y += padTop;
  // Small filled square as the kicker anchor (left)
  drawRect(pdf, MARGIN_X, y - 2.5, 2.2, 2.2, { fill: C.brand });
  // Section label — tracking-wide caps, brand green
  drawText(pdf, en, MARGIN_X + 4.5, y - 0.5, {
    size: 8.5, color: C.brand, style: 'bold',
  });
  // Hairline rule to the right edge — subtle horizontal stroke
  // anchored after the label runs out, fading the line of sight to
  // the next content row.
  const labelW = pdf.getStringUnitWidth(en) * 8.5 / pdf.internal.scaleFactor;
  const ruleX = MARGIN_X + 4.5 + labelW + 4;
  drawLine(pdf, ruleX, y - 1.4, MARGIN_X + CONTENT_W, y - 1.4,
    { color: C.border, width: 0.3 });
  return y + 1.5;
}

// Create a fresh A4 PDF instance — single point of jsPDF config so
// every form is set up identically.
export function newPdf() {
  return new jsPDF({ unit: 'mm', format: 'a4', compress: true });
}
