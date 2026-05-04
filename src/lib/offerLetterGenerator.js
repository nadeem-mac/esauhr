// =============================================================================
// offerLetterGenerator.js
//
// Builds two artefacts for an offer letter:
//
//   1. The offer letter PDF — a single-page A4 document with Evergreen
//      branding, candidate name + offer terms, and a signature block
//      pulled from the chosen signatory.
//
//   2. An .eml file — a fully-formed email message Bashaier can
//      double-click to open in Outlook. The PDF is embedded as a
//      base64 attachment so when Outlook opens the .eml, the PDF is
//      already attached. She reviews, hits Send, and the offer goes
//      from her real evergreen-shipping mailbox.
//
// This avoids the SendGrid / Resend / DNS path entirely. The portal
// generates the artefacts, she reviews and sends through her actual
// Outlook. Same workflow she already uses for attendance reports.
//
// Why .eml instead of mailto:
//   mailto: cannot attach files — browsers block it for security.
//   .eml is a complete RFC 822 email file. Outlook (and Apple Mail)
//   open .eml files natively into a draft window with the attachment
//   already populated. One click instead of "download PDF, open
//   Outlook, drag in PDF, type body".
// =============================================================================

// ─── Constants ────────────────────────────────────────────────────

// SAR currency. Could become a parameter later if Evergreen ever
// issues offers in USD or another currency. Kept as a const for
// readability of the template.
const CURRENCY_LABEL = 'SAR';

// Letterhead colours match the portal brand (evergreen + ink).
const BRAND_GREEN = [15, 76, 42];      // #0F4C2A
const INK         = [15, 23, 42];      // #0F172A
const MUTED       = [115, 115, 115];   // #737373

// ─── PDF: offer letter ────────────────────────────────────────────

/**
 * Generate the offer letter PDF as a Blob.
 *
 * @param {Object} offer            — offer_letters row data
 * @param {Object} offer.candidateName
 * @param {Object} offer.positionTitle
 * @param {Object} offer.department
 * @param {Object} offer.proposedJoinDate  (YYYY-MM-DD)
 * @param {Object} offer.salaryAmount      (number)
 * @param {Object} signatory       — chosen signatory (name, title, signature_image_path)
 * @param {Object} options
 * @param {string} [options.companyName='Evergreen Shipping Agency Saudi Co. (LLC)']
 * @returns {Promise<Blob>}
 */
export async function generateOfferLetterPDF(offer, signatory, options = {}) {
  const { jsPDF } = await import('jspdf');

  const companyName = options.companyName || 'Evergreen Shipping Agency Saudi Co. (LLC)';
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  // Page geometry — A4 = 595 x 842 pt
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 56; // ~20mm

  let y = 80;

  // ─── Letterhead band ───────────────────────────────────────────
  // Subtle thick green bar at the top — instantly readable as a
  // formal company document without requiring a logo image
  // (we'll add a real logo later via options.logoDataUrl).
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 0, pageW, 6, 'F');

  // Company name in the title position
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...BRAND_GREEN);
  doc.text(companyName.toUpperCase(), margin, y);

  y += 16;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('HR Department · Dammam · Kingdom of Saudi Arabia', margin, y);

  // Divider
  y += 14;
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageW - margin, y);

  // ─── Letter heading ─────────────────────────────────────────────
  y += 32;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...INK);

  // Date in formal full format
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  doc.text(dateStr, margin, y);

  // Subject line — bold, centred
  y += 32;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('LETTER OF OFFER', pageW / 2, y, { align: 'center' });

  // Candidate addressing
  y += 30;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text('Dear ' + (offer.candidateName || ''), margin, y);
  doc.text(',', margin + doc.getTextWidth('Dear ' + (offer.candidateName || '')), y);

  // Body paragraph — formal but clear
  y += 24;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK);

  const intro =
    'We are pleased to offer you the position detailed below at ' + companyName + '. ' +
    'This offer is contingent upon your acceptance of the terms outlined and the ' +
    'successful completion of all pre-employment checks, including verification of ' +
    'documents and onboarding through the SOL system.';

  const introLines = doc.splitTextToSize(intro, pageW - margin * 2);
  doc.text(introLines, margin, y);
  y += introLines.length * 13 + 14;

  // ─── Offer terms ────────────────────────────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.text('Position Details', margin, y);
  y += 6;
  doc.setDrawColor(15, 76, 42);
  doc.setLineWidth(1);
  doc.line(margin, y, margin + 80, y);
  y += 18;

  // Two-column key/value layout
  const labelX = margin;
  const valueX = margin + 140;
  doc.setFontSize(10);

  const drawRow = (label, value) => {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(label, labelX, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(String(value || '—'), valueX, y);
    y += 18;
  };

  drawRow('Position',      offer.positionTitle || '—');
  drawRow('Department',    offer.department || '—');
  drawRow('Office',        offer.location || '—');
  drawRow('Reporting to',  offer.managerName || '—');
  drawRow('Joining date',  formatDateLong(offer.proposedJoinDate));
  const salaryStr = offer.salaryAmount
    ? `${CURRENCY_LABEL} ${Number(offer.salaryAmount).toLocaleString('en-GB')} per month`
    : '—';
  drawRow('Monthly salary', salaryStr);
  drawRow('Working hours',  '40 hours per week, Sunday to Thursday');
  drawRow('Probation',      '90 days from joining date');

  // ─── Acceptance instruction ─────────────────────────────────────
  y += 14;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK);

  const acceptText =
    'To accept this offer, please use the secure acceptance link sent in the ' +
    'covering email. The link is valid for 14 days from the date of this letter. ' +
    'If you have any questions or need to discuss any of the terms above, please ' +
    'reply to the email and we will be pleased to assist.';
  const acceptLines = doc.splitTextToSize(acceptText, pageW - margin * 2);
  doc.text(acceptLines, margin, y);
  y += acceptLines.length * 13 + 28;

  // Closing
  doc.setFont('helvetica', 'normal');
  doc.text('We look forward to welcoming you to the team.', margin, y);
  y += 22;
  doc.text('Yours sincerely,', margin, y);

  // Signature block
  y += 50;
  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.5);
  doc.line(margin, y, margin + 200, y);
  y += 14;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK);
  doc.text(signatory?.name || '—', margin, y);
  y += 14;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text(signatory?.title || '—', margin, y);
  y += 12;
  doc.text(companyName, margin, y);

  // ─── Footer band ────────────────────────────────────────────────
  const footerY = doc.internal.pageSize.getHeight() - 36;
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(margin, footerY - 12, pageW - margin, footerY - 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(
    'This document is confidential and addressed solely to the named candidate.',
    pageW / 2, footerY, { align: 'center' }
  );

  return doc.output('blob');
}

// ─── Helper: format ISO date as "1 June 2026" ─────────────────────
function formatDateLong(yyyymmdd) {
  if (!yyyymmdd) return '—';
  const [y, m, d] = String(yyyymmdd).split('-').map(Number);
  if (!y || !m || !d) return yyyymmdd;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ─── .eml generation ──────────────────────────────────────────────

/**
 * Build the email body Bashaier sends to the candidate. Plain text;
 * Outlook will auto-link the URL.
 *
 * @param {Object} offer
 * @param {string} acceptanceUrl
 * @param {Object} sender — { name, email }
 */
export function buildOfferEmailBody(offer, acceptanceUrl, sender) {
  const candidate = offer.candidateName || 'Candidate';
  const position = offer.positionTitle || 'the role';

  return [
    `Dear ${candidate},`,
    ``,
    `We are pleased to extend an offer for the position of ${position} at Evergreen Shipping Agency Saudi Co. (LLC).`,
    ``,
    `Please find the formal offer letter attached. The letter contains the full details of the position, salary, joining date, and other terms.`,
    ``,
    `To accept this offer, please click the secure acceptance link below:`,
    ``,
    `  ${acceptanceUrl}`,
    ``,
    `The link is valid for 14 days. After accepting, we will proceed with onboarding through the SOL system and issue your Personal Service Number (PSN).`,
    ``,
    `If you have any questions or wish to discuss any of the terms, please reply to this email — I will be happy to help.`,
    ``,
    `We look forward to welcoming you to the team.`,
    ``,
    `Best regards,`,
    `${sender.name}`,
    `Evergreen Shipping Agency Saudi Co. (LLC)`,
    `${sender.email}`,
  ].join('\r\n');
}

/**
 * Build a complete RFC 822 .eml message with the offer letter PDF
 * embedded as a base64 attachment. Returns a Blob suitable for
 * triggering a browser download.
 *
 * Outlook (Windows + Mac), Apple Mail, and most webmail clients
 * open .eml files into a draft window with the attachment already
 * populated. The user reviews, optionally edits the body, hits
 * Send. The email goes from their real mailbox so the candidate
 * can reply directly to them.
 *
 * @param {Object} args
 * @param {string} args.fromName     — e.g. "BASHAIER ALSUBAIE"
 * @param {string} args.fromEmail    — e.g. "bashaier.alsubaie@evergreen-shipping.com.sa"
 * @param {string} args.toEmail      — candidate's personal email
 * @param {string} args.toName       — candidate's name
 * @param {string} args.subject
 * @param {string} args.body         — plain text email body
 * @param {Blob}   args.pdfBlob      — PDF attachment
 * @param {string} args.pdfFilename
 * @returns {Promise<Blob>} an .eml Blob ready for download
 */
export async function buildEmlMessage(args) {
  const {
    fromName, fromEmail, toEmail, toName,
    subject, body, pdfBlob, pdfFilename,
  } = args;

  // Convert the PDF blob to base64. The .eml format requires
  // attachments to be base64-encoded with line breaks every 76
  // characters (RFC 2045).
  const pdfBase64 = await blobToBase64(pdfBlob);
  const wrappedBase64 = wrapLine(pdfBase64, 76);

  // Multipart MIME boundary — must not appear anywhere in the
  // message body or attachment data. Generate a random one.
  const boundary = 'evergreen-offer-' + Math.random().toString(36).slice(2, 10);

  // Date in RFC 2822 format
  const dateHeader = new Date().toUTCString().replace('GMT', '+0000');

  const fromHeader = `${escapeHeader(fromName)} <${fromEmail}>`;
  const toHeader   = toName ? `${escapeHeader(toName)} <${toEmail}>` : toEmail;

  // Build the .eml message. Headers + multipart body + boundary
  // separators. CRLF line endings throughout — required by RFC 822.
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

// ─── Helper: blob → base64 string ─────────────────────────────────
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // result is a data: URL like "data:application/pdf;base64,JVBERi0..."
      const dataUrl = String(reader.result);
      const base64 = dataUrl.split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ─── Helper: wrap a long string into N-char lines ─────────────────
function wrapLine(s, width) {
  if (!s) return '';
  const lines = [];
  for (let i = 0; i < s.length; i += width) {
    lines.push(s.slice(i, i + width));
  }
  return lines.join('\r\n');
}

// ─── Helper: escape a header value ────────────────────────────────
// If the value contains any non-ASCII or special chars, wrap in
// quotes. For simplicity we wrap everything in quotes that contains
// non-alphanumeric chars beyond spaces and basic punctuation.
function escapeHeader(s) {
  const str = String(s || '');
  // Use quoted-string format if the value has any special chars
  if (/[^\x20-\x7E]/.test(str) || /["\\]/.test(str)) {
    // Encode as RFC 2047 base64 if there's non-ASCII
    const b64 = btoa(unescape(encodeURIComponent(str)));
    return `=?UTF-8?B?${b64}?=`;
  }
  return str;
}

// ─── Helper: quoted-printable encode the body ─────────────────────
// Required because the body may contain non-ASCII (Arabic candidate
// names, accents, etc.). quoted-printable encodes those as =XX
// sequences while preserving most of the readability.
function quotedPrintableEncode(text) {
  if (!text) return '';
  // Encode UTF-8 bytes
  const bytes = new TextEncoder().encode(text);
  let out = '';
  let lineLen = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let chunk;
    if (b === 0x0d) {
      // skip lone CR
      continue;
    } else if (b === 0x0a) {
      // newline — flush
      out += '\r\n';
      lineLen = 0;
      continue;
    } else if (b === 0x3d) {
      // = → =3D
      chunk = '=3D';
    } else if (b >= 0x20 && b <= 0x7e) {
      // printable ASCII
      chunk = String.fromCharCode(b);
    } else {
      // anything else → =XX hex
      chunk = '=' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    if (lineLen + chunk.length > 75) {
      out += '=\r\n';
      lineLen = 0;
    }
    out += chunk;
    lineLen += chunk.length;
  }
  return out;
}

// ─── Convenience: trigger a browser download for a Blob ───────────
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

// ─── Token generator for offer_token ──────────────────────────────
// 32 chars URL-safe base64 from 24 random bytes. Used as the
// public acceptance link's secret. Cryptographically random via
// crypto.getRandomValues — far stronger than Math.random.
export function generateOfferToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
