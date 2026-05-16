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
  const s = String(id ?? '');
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

// Centered form title with brand-coloured underline.
export function drawTitle(pdf, y, titleText) {
  drawText(pdf, titleText, PAGE_W / 2, y + 5, {
    size: 16, color: C.brand, style: 'bold', align: 'center',
  });
  const tw = pdf.getTextWidth(titleText);
  drawLine(pdf, (PAGE_W - tw) / 2, y + 7.5, (PAGE_W + tw) / 2, y + 7.5,
    { color: C.brand, width: 0.4 });
  return y + 8;
}

// Section header — green-tinted band with brand-coloured left edge.
export function drawSectionHeader(pdf, y, text) {
  const h = 7;
  drawRect(pdf, MARGIN_X, y, CONTENT_W, h, { fill: C.accent });
  drawRect(pdf, MARGIN_X, y, 1.5, h, { fill: C.brand });
  drawText(pdf, text, MARGIN_X + 5, y + 4.8, {
    size: 9.5, color: C.brand, style: 'bold',
  });
  return y + h + 1;
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
    const rowH       = Math.max(7, lineCount * 4.3 + 2.5);

    if (y > startY) {
      drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
        { color: C.border, width: 0.15 });
    }
    drawLine(pdf, MARGIN_X + colW, y, MARGIN_X + colW, y + rowH,
      { color: C.border, width: 0.15 });

    if (left) {
      drawText(pdf, left[0], MARGIN_X + 1, y + 4.8, {
        size: 8, color: C.muted, style: 'bold',
      });
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9.5);
      pdf.setTextColor(...C.text);
      pdf.text(leftLines, MARGIN_X + labelW + 2, y + 4.8);
    }
    if (right) {
      drawText(pdf, right[0], MARGIN_X + colW + 2, y + 4.8, {
        size: 8, color: C.muted, style: 'bold',
      });
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9.5);
      pdf.setTextColor(...C.text);
      pdf.text(rightLines, MARGIN_X + colW + labelW + 3, y + 4.8);
    }
    y += rowH;
  }
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  return y;
}

// Single-column label/value (use when value is long and needs full width).
export function drawLabelValueTable(pdf, startY, rows) {
  const labelW = 42;
  const valueW = CONTENT_W - labelW;
  let y = startY;
  for (const [label, value] of rows) {
    const wrapped   = pdf.splitTextToSize(String(value || '—'), valueW - 6);
    const lineCount = Array.isArray(wrapped) ? wrapped.length : 1;
    const rowH      = Math.max(7, lineCount * 4.3 + 2.5);
    if (y > startY) {
      drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
        { color: C.border, width: 0.15 });
    }
    drawText(pdf, label, MARGIN_X + 1, y + 4.8, {
      size: 8.5, color: C.muted, style: 'bold',
    });
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(10);
    pdf.setTextColor(...C.text);
    pdf.text(wrapped, MARGIN_X + labelW + 2, y + 4.8);
    y += rowH;
  }
  drawLine(pdf, MARGIN_X, y, MARGIN_X + CONTENT_W, y,
    { color: C.border, width: 0.15 });
  return y;
}

// Bulleted policy list. Caller passes the list of bullet strings.
export function drawPolicyBullets(pdf, y, bullets) {
  const lineH = 3.8;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(...C.text);
  bullets.forEach((b, i) => {
    const num = `${(i + 1).toString().padStart(2, '0')}.`;
    drawText(pdf, num, MARGIN_X + 4, y + 3.5, {
      size: 8, color: C.brand, style: 'bold',
    });
    const wrapped = pdf.splitTextToSize(b, CONTENT_W - 16);
    pdf.text(wrapped, MARGIN_X + 12, y + 3.5);
    y += wrapped.length * lineH + 0.5;
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
    nameLines.forEach((ln, idx) => {
      drawText(pdf, ln, cellCenterX,
        lineY + 5 - (nameLines.length - 1 - idx) * lineH,
        { size: nameSize, color: C.text, style: 'bold', align: 'center' });
    });
    drawText(pdf, cells[i].subtitle, cellCenterX, lineY + 9, {
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

// Create a fresh A4 PDF instance — single point of jsPDF config so
// every form is set up identically.
export function newPdf() {
  return new jsPDF({ unit: 'mm', format: 'a4', compress: true });
}
