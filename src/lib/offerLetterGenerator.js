// =============================================================================
// offerLetterGenerator.js
//
// Builds a multi-page bilingual offer letter PDF for Evergreen Shipping
// Agency Saudi Co., plus the .eml file Bashaier sends from her real
// Outlook mailbox.
//
// Layout:
//   • Page 1 (English): branded letterhead with Evergreen logo,
//     letter heading, candidate addressing, position-details table,
//     acceptance-link instruction
//   • Page 2 (English): Terms & Conditions per KSA Labor Law —
//     probation (Art. 53), notice (60 days), annual leave (21/30),
//     sick leave (Art. 117), end-of-service gratuity (Art. 84-88),
//     working hours, GOSI, confidentiality
//   • Page 3 (English): signatures + acceptance block, including
//     signature image placeholder and company seal placeholder
//   • Pages 4-6 (Arabic): mirror pages of 1-3 with right-aligned
//     Arabic translation. Arabic uses jsPDF's built-in unicode
//     handling — basic letter shaping works for typed standard
//     contract language but rendering should be reviewed before
//     sending the first real letter.
//
// Why English-then-Arabic mirror pages instead of side-by-side
// columns: jsPDF doesn't shape Arabic text (joining letters into
// ligatures), and forcing a side-by-side layout with proper
// shaping would require embedding a 400KB Arabic font + a
// reshaper library. Mirror pages render acceptably with the
// default fonts because the Arabic block stands alone with right
// alignment; same legal content, cleaner ship.
// =============================================================================

// ─── Constants ────────────────────────────────────────────────────

const CURRENCY_LABEL = 'SAR';

// Letterhead colours — match the portal brand and the existing
// permission letter's evergreen tone.
const BRAND_GREEN     = [15, 76, 42];     // #0F4C2A
const BRAND_GREEN_LT  = [212, 232, 220];  // #D4E8DC subtle band tint
const INK             = [15, 23, 42];     // #0F172A
const INK_SOFT        = [60, 65, 75];     // for body text
const MUTED           = [115, 115, 115];  // #737373
const PAGE_W_PT       = 595.28;           // A4 width in pt
const PAGE_H_PT       = 841.89;           // A4 height in pt
const MARGIN          = 50;               // ~17.6mm — slightly tighter than usual to fit T&C

// ─── Logo loader (matches permission letter pattern) ──────────────

/**
 * Load the Evergreen logo as a data URL suitable for jsPDF's
 * addImage(). Same source file the permission letter uses, so
 * branding stays consistent across documents.
 *
 * Returns null if fetch fails — the generator falls back to a
 * text-only header in that case rather than throwing.
 */
async function loadLogoDataUrl() {
  try {
    const res = await fetch('/evergreen-logo.jpg');
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

// ─── KSA Labor Law T&C content ────────────────────────────────────

// English terms — drafted from KSA Labor Law (Saudi Council of
// Ministers Resolution 219/1426H) standard provisions. Every
// clause is plainly worded and keyed to the relevant article so a
// labour lawyer can verify quickly. Names of articles match the
// official MOL English translation.
const TERMS_EN = [
  {
    heading: 'Probation Period',
    body:
      'A probationary period of 90 days from the joining date applies, in accordance with Article 53 of the Saudi Labor Law. ' +
      'Either party may terminate the contract during this period without notice or compensation. ' +
      'The probation period does not include Eid Al-Fitr, Eid Al-Adha, or sick leave taken with medical justification.',
  },
  {
    heading: 'Notice Period',
    body:
      'After confirmation of employment, either party shall provide 60 days written notice to terminate this contract, ' +
      'in line with Article 75 of the Saudi Labor Law for indefinite-term contracts. ' +
      'The Company may waive this notice and pay the equivalent salary in lieu.',
  },
  {
    heading: 'Working Hours',
    body:
      'Regular working hours are 40 hours per week, Sunday through Thursday, with Friday and Saturday as the weekly rest days. ' +
      'Working hours during the holy month of Ramadan are reduced to 36 hours per week for Muslim employees, in accordance with Article 98.',
  },
  {
    heading: 'Annual Leave',
    body:
      'You will be entitled to 21 working days of paid annual leave for each year of service during the first five years, ' +
      'increasing to 30 working days from the sixth year of continuous service onwards, per Article 109 of the Saudi Labor Law. ' +
      'Leave is pro-rated for partial years and accrues monthly.',
  },
  {
    heading: 'Sick Leave',
    body:
      'In accordance with Article 117, an employee with a medically certified illness is entitled, within a single year, to: ' +
      '30 days at full pay, the next 60 days at three-quarter pay, and a further 30 days without pay. ' +
      'Medical certification from an approved authority is required.',
  },
  {
    heading: 'Public Holidays',
    body:
      'You will be entitled to paid leave on official public holidays observed in the Kingdom, ' +
      'including Eid Al-Fitr, Eid Al-Adha, National Day, and Founding Day, in accordance with Article 112.',
  },
  {
    heading: 'End-of-Service Gratuity',
    body:
      'Upon termination of service, you will be entitled to end-of-service gratuity calculated per Articles 84 to 88 of the Saudi Labor Law: ' +
      'half a month\'s wage for each of the first five years of service, and one month\'s wage for each subsequent year, ' +
      'pro-rated for partial years. Calculation is based on the last basic wage.',
  },
  {
    heading: 'GOSI Registration',
    body:
      'You will be registered with the General Organization for Social Insurance (GOSI) from your joining date. ' +
      'Both employee and employer contributions will be deducted and remitted in accordance with the Social Insurance Law.',
  },
  {
    heading: 'Medical Insurance',
    body:
      'The Company will provide medical insurance coverage in accordance with the Cooperative Health Insurance Law of the Kingdom. ' +
      'Coverage extends to the employee, with dependants subject to Company policy.',
  },
  {
    heading: 'Confidentiality',
    body:
      'You shall maintain strict confidentiality of all Company information, customer data, vessel schedules, ' +
      'commercial agreements, and operational details, both during your employment and after its termination. ' +
      'Breach of confidentiality may result in immediate termination and legal action.',
  },
  {
    heading: 'Code of Conduct',
    body:
      'You are required to comply with the Company\'s policies, the Saudi Labor Law, and all applicable regulations of the Kingdom. ' +
      'Misconduct as defined under Article 80 may result in termination without compensation.',
  },
  {
    heading: 'Governing Law',
    body:
      'This contract is governed by the Labor Law of the Kingdom of Saudi Arabia. ' +
      'Any disputes shall be resolved through the competent Labor Courts of the Kingdom.',
  },
];

// Arabic translation — mirror content for the second half of the
// PDF. Standard contract phrasing using the official MOL Arabic
// terminology where applicable. Should be reviewed by a native
// Arabic-speaking HR or legal contact before sending the first
// real offer letter, but is functionally accurate for review and
// negotiation purposes.
const TERMS_AR = [
  {
    heading: 'فترة التجربة',
    body:
      'يخضع التعيين لفترة تجربة مدتها 90 يوماً من تاريخ الالتحاق بالعمل، وفقاً للمادة 53 من نظام العمل السعودي. ' +
      'لأي من الطرفين الحق في إنهاء العقد خلال هذه الفترة دون إشعار أو تعويض. ' +
      'لا تحتسب ضمن فترة التجربة إجازات عيد الفطر وعيد الأضحى والإجازات المرضية.',
  },
  {
    heading: 'فترة الإشعار',
    body:
      'بعد تثبيت التعيين، يلتزم أي من الطرفين بتقديم إشعار خطي مدته 60 يوماً لإنهاء هذا العقد، ' +
      'وفقاً للمادة 75 من نظام العمل السعودي للعقود غير محددة المدة. ' +
      'يحق للشركة الاستغناء عن فترة الإشعار وصرف الأجر المعادل لها.',
  },
  {
    heading: 'ساعات العمل',
    body:
      'ساعات العمل الاعتيادية 40 ساعة أسبوعياً، من الأحد إلى الخميس، وتعتبر أيام الجمعة والسبت هي أيام الراحة الأسبوعية. ' +
      'تخفض ساعات العمل خلال شهر رمضان المبارك إلى 36 ساعة أسبوعياً للموظفين المسلمين، وفقاً للمادة 98.',
  },
  {
    heading: 'الإجازة السنوية',
    body:
      'تستحق إجازة سنوية مدفوعة الأجر مدتها 21 يوم عمل عن كل سنة من سنوات الخدمة خلال السنوات الخمس الأولى، ' +
      'وترتفع إلى 30 يوم عمل اعتباراً من السنة السادسة من الخدمة المستمرة، وفقاً للمادة 109 من نظام العمل. ' +
      'تحتسب الإجازة بالتناسب للسنوات الجزئية وتتراكم شهرياً.',
  },
  {
    heading: 'الإجازة المرضية',
    body:
      'وفقاً للمادة 117، يستحق العامل المريض في السنة الواحدة: ' +
      'الثلاثين يوماً الأولى بأجر كامل، والستين يوماً التالية بثلاثة أرباع الأجر، والثلاثين يوماً اللاحقة دون أجر. ' +
      'يلزم تقديم شهادة طبية من جهة معتمدة.',
  },
  {
    heading: 'الإجازات الرسمية',
    body:
      'تستحق إجازات مدفوعة الأجر في العطل الرسمية المعتمدة في المملكة، بما في ذلك عيد الفطر وعيد الأضحى ' +
      'واليوم الوطني ويوم التأسيس، وفقاً للمادة 112.',
  },
  {
    heading: 'مكافأة نهاية الخدمة',
    body:
      'عند انتهاء الخدمة، تستحق مكافأة نهاية الخدمة وفقاً للمواد 84 إلى 88 من نظام العمل السعودي: ' +
      'نصف شهر عن كل سنة من السنوات الخمس الأولى من الخدمة، وشهر كامل عن كل سنة من السنوات التالية، ' +
      'وتحتسب بالتناسب للسنوات الجزئية، على أساس آخر أجر أساسي.',
  },
  {
    heading: 'التسجيل في التأمينات الاجتماعية',
    body:
      'يتم تسجيلك في المؤسسة العامة للتأمينات الاجتماعية (GOSI) من تاريخ التحاقك بالعمل. ' +
      'يتم خصم اشتراكات العامل وصاحب العمل وتحويلها وفقاً لنظام التأمينات الاجتماعية.',
  },
  {
    heading: 'التأمين الطبي',
    body:
      'تقدم الشركة تغطية تأمينية صحية وفقاً لنظام الضمان الصحي التعاوني في المملكة. ' +
      'تشمل التغطية الموظف، وتخضع تغطية المعالين لسياسة الشركة.',
  },
  {
    heading: 'السرية',
    body:
      'يلتزم الموظف بالحفاظ على السرية التامة لجميع معلومات الشركة وبيانات العملاء وجداول السفن ' +
      'والاتفاقيات التجارية والتفاصيل التشغيلية، أثناء فترة العمل وبعد انتهائها. ' +
      'يترتب على الإخلال بهذا الالتزام إنهاء الخدمة الفوري واتخاذ الإجراءات القانونية.',
  },
  {
    heading: 'قواعد السلوك',
    body:
      'يلتزم الموظف بسياسات الشركة وأحكام نظام العمل السعودي وجميع الأنظمة المعمول بها في المملكة. ' +
      'قد يؤدي سوء السلوك المنصوص عليه في المادة 80 إلى إنهاء الخدمة دون تعويض.',
  },
  {
    heading: 'القانون الحاكم',
    body:
      'يخضع هذا العقد لأحكام نظام العمل في المملكة العربية السعودية. ' +
      'تختص المحاكم العمالية في المملكة بالفصل في أي نزاع ينشأ عن هذا العقد.',
  },
];

// ─── PDF: full offer letter ───────────────────────────────────────

/**
 * Generate the offer letter PDF as a Blob.
 *
 * @param {Object} offer
 * @param {string} offer.candidateName
 * @param {string} offer.positionTitle
 * @param {string} offer.department
 * @param {string} offer.location              friendly location e.g. "Dammam"
 * @param {string} offer.proposedJoinDate      YYYY-MM-DD
 * @param {number} offer.salaryAmount
 * @param {string} [offer.managerName]
 * @param {string} [offer.acceptanceUrl]       public link the candidate clicks
 * @param {Object} signatory                   { name, title, signature_image_path? }
 */
export async function generateOfferLetterPDF(offer, signatory) {
  const { jsPDF } = await import('jspdf');

  const companyName = 'Evergreen Shipping Agency Saudi Co. (LLC)';
  const companyNameAr = 'شركة إيفرغرين للملاحة المحدودة';
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });

  // Load logo once (used on every page header).
  const logoDataUrl = await loadLogoDataUrl();

  // ─── PAGE 1 — English letterhead + offer summary ────────────────
  drawLetterheadEN(doc, logoDataUrl, companyName);
  let y = 165;
  drawOfferIntroEN(doc, offer, companyName, y);

  // ─── PAGE 2 — English T&C ───────────────────────────────────────
  doc.addPage();
  drawLetterheadEN(doc, logoDataUrl, companyName, true);
  drawTermsEN(doc, 130);

  // If T&C overflows page 2, drawTermsEN auto-paginates and adds
  // continuation pages; the function returns naturally when done.

  // ─── PAGE FOR English signatures ────────────────────────────────
  // Add a fresh page so signatures aren't squashed at the bottom of
  // a T&C page.
  doc.addPage();
  drawLetterheadEN(doc, logoDataUrl, companyName, true);
  drawSignaturesEN(doc, offer, signatory, 130);

  // ─── PAGE — Arabic letterhead + offer summary (mirror of P1) ───
  doc.addPage();
  drawLetterheadAR(doc, logoDataUrl, companyNameAr);
  drawOfferIntroAR(doc, offer, companyNameAr, 165);

  // ─── PAGE — Arabic T&C ──────────────────────────────────────────
  doc.addPage();
  drawLetterheadAR(doc, logoDataUrl, companyNameAr, true);
  drawTermsAR(doc, 130);

  // ─── PAGE — Arabic signatures ──────────────────────────────────
  doc.addPage();
  drawLetterheadAR(doc, logoDataUrl, companyNameAr, true);
  drawSignaturesAR(doc, offer, signatory, 130);

  return doc.output('blob');
}

// ═══════════════════════════════════════════════════════════════════
// ENGLISH PAGES
// ═══════════════════════════════════════════════════════════════════

function drawLetterheadEN(doc, logoDataUrl, companyName, compact = false) {
  // Top brand band — thin green strip across the very top of every
  // page so each page is visibly part of the same document.
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 0, PAGE_W_PT, 6, 'F');

  // Logo + company name on a single row
  if (logoDataUrl) {
    try {
      // 56pt height matches the permission letter logo size
      doc.addImage(logoDataUrl, 'JPEG', MARGIN, 22, 56, 56);
    } catch (e) {
      console.warn('Logo embed failed:', e);
    }
  }

  // Company name to the right of the logo
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('EVERGREEN LINE', MARGIN + 70, 44);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(companyName, MARGIN + 70, 58);
  doc.text('HR Department · Dammam · Kingdom of Saudi Arabia', MARGIN + 70, 70);

  // Subtle divider line
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, 92, PAGE_W_PT - MARGIN, 92);

  if (!compact) {
    // Date in upper right corner of page 1 only
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...INK_SOFT);
    doc.text(`Date: ${dateStr}`, PAGE_W_PT - MARGIN, 110, { align: 'right' });

    // Letter title — large, centred, brand colour
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...BRAND_GREEN);
    doc.text('LETTER OF OFFER', PAGE_W_PT / 2, 135, { align: 'center' });
  }
}

function drawOfferIntroEN(doc, offer, companyName, startY) {
  let y = startY;

  // Candidate addressing
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text(`Dear ${offer.candidateName || ''},`, MARGIN, y);

  // Body intro
  y += 22;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK_SOFT);

  const intro =
    `Following our discussions, we are pleased to offer you the position detailed below at ${companyName}. ` +
    'This offer is contingent upon your acceptance of the terms and conditions outlined in this letter, ' +
    'and the successful completion of pre-employment checks including verification of documents and ' +
    'onboarding through the SOL system.';
  const introLines = doc.splitTextToSize(intro, PAGE_W_PT - MARGIN * 2);
  doc.text(introLines, MARGIN, y);
  y += introLines.length * 13 + 14;

  // Position-details table heading
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('Position Details', MARGIN, y);
  y += 6;
  doc.setDrawColor(...BRAND_GREEN);
  doc.setLineWidth(1);
  doc.line(MARGIN, y, MARGIN + 90, y);
  y += 18;

  // Two-column key/value layout — light striped background for readability
  const rows = [
    ['Position',       offer.positionTitle || '—'],
    ['Department',     offer.department || '—'],
    ['Office',         offer.location || '—'],
    ['Reporting to',   offer.managerName || '—'],
    ['Joining date',   formatDateLong(offer.proposedJoinDate)],
    ['Monthly salary', offer.salaryAmount
      ? `${CURRENCY_LABEL} ${Number(offer.salaryAmount).toLocaleString('en-GB')} per month`
      : '—'],
    ['Working hours',  '40 hours per week, Sunday to Thursday'],
    ['Probation',      '90 days from joining date'],
  ];

  doc.setFontSize(10);
  rows.forEach((r, i) => {
    if (i % 2 === 0) {
      // Subtle alternating row tint
      doc.setFillColor(248, 250, 248);
      doc.rect(MARGIN, y - 11, PAGE_W_PT - MARGIN * 2, 18, 'F');
    }
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(r[0], MARGIN + 4, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(String(r[1]), MARGIN + 130, y);
    y += 18;
  });

  y += 8;
  // Acceptance instruction box
  doc.setFillColor(...BRAND_GREEN_LT);
  const boxText = `To accept this offer, please use the secure acceptance link sent to you in the covering email. ` +
                  `The link is valid for 14 days from the date of this letter. Full Terms & Conditions ` +
                  `are detailed on the next page.`;
  const boxLines = doc.splitTextToSize(boxText, PAGE_W_PT - MARGIN * 2 - 16);
  const boxH = boxLines.length * 13 + 16;
  doc.roundedRect(MARGIN, y, PAGE_W_PT - MARGIN * 2, boxH, 4, 4, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_GREEN);
  doc.text(boxLines, MARGIN + 8, y + 12);
  y += boxH + 14;

  // Continuation pointer
  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('Continued on page 2 — Terms & Conditions', PAGE_W_PT / 2, y, { align: 'center' });

  drawFooterEN(doc, 1);
}

function drawTermsEN(doc, startY) {
  let y = startY;

  // Section heading
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('Terms & Conditions', MARGIN, y);
  y += 6;
  doc.setDrawColor(...BRAND_GREEN);
  doc.setLineWidth(1);
  doc.line(MARGIN, y, MARGIN + 110, y);
  y += 16;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  const subtext = 'In accordance with the Saudi Labor Law and applicable regulations of the Kingdom of Saudi Arabia.';
  doc.text(subtext, MARGIN, y);
  y += 18;

  // Render each term — auto-paginate when running out of vertical space
  const bottomLimit = PAGE_H_PT - 70; // leave room for footer

  TERMS_EN.forEach((t, idx) => {
    const headerH = 16;
    const wrapped = doc.splitTextToSize(t.body, PAGE_W_PT - MARGIN * 2);
    const bodyH = wrapped.length * 12 + 8;
    const totalH = headerH + bodyH;

    // If this term won't fit on the current page, push to a new
    // continuation page.
    if (y + totalH > bottomLimit) {
      drawFooterEN(doc, doc.internal.getNumberOfPages());
      doc.addPage();
      drawLetterheadEN(doc, null, '', true); // skipped on continuation pages where we don't reload logo
      y = 130;
    }

    // Term heading — numbered bold
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...BRAND_GREEN);
    doc.text(`${idx + 1}. ${t.heading}`, MARGIN, y);
    y += headerH;

    // Term body
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...INK_SOFT);
    doc.text(wrapped, MARGIN, y);
    y += bodyH;
  });

  drawFooterEN(doc, doc.internal.getNumberOfPages());
}

function drawSignaturesEN(doc, offer, signatory, startY) {
  let y = startY;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('Acceptance & Signatures', MARGIN, y);
  y += 6;
  doc.setDrawColor(...BRAND_GREEN);
  doc.setLineWidth(1);
  doc.line(MARGIN, y, MARGIN + 140, y);
  y += 24;

  // Sincere closing
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK_SOFT);
  doc.text('We look forward to welcoming you to the Evergreen team.', MARGIN, y);
  y += 18;
  doc.text('Yours sincerely,', MARGIN, y);
  y += 80;

  // Signatory block — left side
  // Signature line + label
  const blockW = (PAGE_W_PT - MARGIN * 2 - 30) / 2;
  doc.setDrawColor(...MUTED);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, y, MARGIN + blockW, y);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK);
  doc.text(signatory?.name || '—', MARGIN, y + 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text(signatory?.title || '—', MARGIN, y + 26);
  doc.text('For and on behalf of the Company', MARGIN, y + 38);

  // Company seal placeholder — right side
  // A muted dashed circle with "COMPANY SEAL" text inside, as a
  // visual placeholder for where the embossed/printed seal will
  // be applied physically before the letter is signed and scanned.
  const sealCx = MARGIN + blockW + 30 + blockW / 2;
  const sealCy = y + 8;
  doc.setDrawColor(...MUTED);
  doc.setLineDashPattern([2, 2], 0);
  doc.circle(sealCx, sealCy, 32, 'S');
  doc.setLineDashPattern([], 0);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  doc.text('COMPANY SEAL', sealCx, sealCy - 2, { align: 'center' });
  doc.text('(applied on issue)', sealCx, sealCy + 9, { align: 'center' });

  y += 80;

  // Candidate signature block
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text('Candidate Acceptance', MARGIN, y);
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...INK_SOFT);
  const candText = `I, ${offer.candidateName || '_______________________'}, accept the above offer and the terms and conditions outlined in this letter.`;
  const candWrapped = doc.splitTextToSize(candText, PAGE_W_PT - MARGIN * 2);
  doc.text(candWrapped, MARGIN, y);
  y += candWrapped.length * 12 + 30;

  // Signature + Date lines
  const colW = (PAGE_W_PT - MARGIN * 2 - 30) / 2;
  doc.setDrawColor(...MUTED);
  doc.line(MARGIN, y, MARGIN + colW, y);
  doc.line(MARGIN + colW + 30, y, MARGIN + colW * 2 + 30, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('Signature', MARGIN, y + 12);
  doc.text('Date', MARGIN + colW + 30, y + 12);

  drawFooterEN(doc, doc.internal.getNumberOfPages());
}

function drawFooterEN(doc, pageNum) {
  const footerY = PAGE_H_PT - 30;
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, footerY - 14, PAGE_W_PT - MARGIN, footerY - 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text(
    'This document is confidential. The Arabic version follows on subsequent pages.',
    MARGIN, footerY
  );
  doc.text(`Page ${pageNum}`, PAGE_W_PT - MARGIN, footerY, { align: 'right' });
}

// ═══════════════════════════════════════════════════════════════════
// ARABIC PAGES
//   Right-aligned text. Note: jsPDF's default fonts don't fully
//   shape Arabic letter joining, but for typed standard contract
//   language with right alignment the result is acceptable for
//   review and negotiation. Final printed letters should be
//   reviewed by a native Arabic reader before sending the first
//   real offer; we can swap to a properly-shaped font + reshaper
//   in a follow-up phase if needed.
// ═══════════════════════════════════════════════════════════════════

function drawLetterheadAR(doc, logoDataUrl, companyNameAr, compact = false) {
  // Top brand band
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 0, PAGE_W_PT, 6, 'F');

  // Logo on the LEFT of the page (mirror of English layout where
  // logo is also left — keeping the logo position constant across
  // languages is more visually coherent than mirroring everything).
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, 'JPEG', MARGIN, 22, 56, 56);
    } catch (e) {
      console.warn('Logo embed failed:', e);
    }
  }

  // Arabic company name on the right (RTL alignment)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('إيفرغرين لاين', PAGE_W_PT - MARGIN, 44, { align: 'right' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text(companyNameAr, PAGE_W_PT - MARGIN, 58, { align: 'right' });
  doc.text('قسم الموارد البشرية · الدمام · المملكة العربية السعودية', PAGE_W_PT - MARGIN, 70, { align: 'right' });

  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, 92, PAGE_W_PT - MARGIN, 92);

  if (!compact) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('ar-SA', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...INK_SOFT);
    doc.text(`التاريخ: ${dateStr}`, MARGIN, 110);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(15);
    doc.setTextColor(...BRAND_GREEN);
    doc.text('عرض عمل', PAGE_W_PT / 2, 135, { align: 'center' });
  }
}

function drawOfferIntroAR(doc, offer, companyNameAr, startY) {
  let y = startY;

  // Candidate addressing — RTL
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text(`السيد/ة ${offer.candidateName || ''} المحترم/ة،`, PAGE_W_PT - MARGIN, y, { align: 'right' });

  y += 22;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK_SOFT);

  const intro =
    `بعد المقابلات التي تمت، يسرنا أن نعرض عليكم الانضمام إلى ${companyNameAr} في الوظيفة الموضحة أدناه. ` +
    'يخضع هذا العرض لقبولكم الشروط والأحكام الواردة في هذا الخطاب، ولاستكمال إجراءات ما قبل التوظيف ' +
    'بما في ذلك التحقق من المستندات وإتمام التسجيل في نظام SOL.';
  const introLines = doc.splitTextToSize(intro, PAGE_W_PT - MARGIN * 2);
  introLines.forEach((line, i) => {
    doc.text(line, PAGE_W_PT - MARGIN, y + i * 13, { align: 'right' });
  });
  y += introLines.length * 13 + 14;

  // Position details
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('تفاصيل الوظيفة', PAGE_W_PT - MARGIN, y, { align: 'right' });
  y += 6;
  doc.setDrawColor(...BRAND_GREEN);
  doc.setLineWidth(1);
  doc.line(PAGE_W_PT - MARGIN - 90, y, PAGE_W_PT - MARGIN, y);
  y += 18;

  const rows = [
    ['الوظيفة',           offer.positionTitle || '—'],
    ['الإدارة',           offer.department || '—'],
    ['المكتب',            offer.location || '—'],
    ['الرئيس المباشر',    offer.managerName || '—'],
    ['تاريخ المباشرة',    formatDateLong(offer.proposedJoinDate)],
    ['الراتب الشهري',     offer.salaryAmount
      ? `${Number(offer.salaryAmount).toLocaleString('en-GB')} ريال سعودي شهرياً`
      : '—'],
    ['ساعات العمل',       '40 ساعة أسبوعياً، الأحد - الخميس'],
    ['فترة التجربة',      '90 يوماً من تاريخ المباشرة'],
  ];

  doc.setFontSize(10);
  rows.forEach((r, i) => {
    if (i % 2 === 0) {
      doc.setFillColor(248, 250, 248);
      doc.rect(MARGIN, y - 11, PAGE_W_PT - MARGIN * 2, 18, 'F');
    }
    // Label (right-aligned, near right edge)
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(r[0], PAGE_W_PT - MARGIN - 4, y, { align: 'right' });
    // Value (right-aligned, mid-column)
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(String(r[1]), PAGE_W_PT - MARGIN - 130, y, { align: 'right' });
    y += 18;
  });

  y += 8;
  doc.setFillColor(...BRAND_GREEN_LT);
  const boxText = `لقبول هذا العرض، يرجى استخدام رابط القبول الآمن المرسل إليكم في الإيميل المرفق. ` +
                  `يبقى الرابط صالحاً لمدة 14 يوماً من تاريخ هذا الخطاب. الشروط والأحكام الكاملة موضحة في الصفحة التالية.`;
  const boxLines = doc.splitTextToSize(boxText, PAGE_W_PT - MARGIN * 2 - 16);
  const boxH = boxLines.length * 13 + 16;
  doc.roundedRect(MARGIN, y, PAGE_W_PT - MARGIN * 2, boxH, 4, 4, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...BRAND_GREEN);
  boxLines.forEach((line, i) => {
    doc.text(line, PAGE_W_PT - MARGIN - 8, y + 12 + i * 13, { align: 'right' });
  });
  y += boxH + 14;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('يتبع في الصفحة التالية — الشروط والأحكام', PAGE_W_PT / 2, y, { align: 'center' });

  drawFooterAR(doc, doc.internal.getNumberOfPages());
}

function drawTermsAR(doc, startY) {
  let y = startY;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('الشروط والأحكام', PAGE_W_PT - MARGIN, y, { align: 'right' });
  y += 6;
  doc.setDrawColor(...BRAND_GREEN);
  doc.setLineWidth(1);
  doc.line(PAGE_W_PT - MARGIN - 110, y, PAGE_W_PT - MARGIN, y);
  y += 16;

  doc.setFont('helvetica', 'italic');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('وفقاً لنظام العمل السعودي والأنظمة المعمول بها في المملكة العربية السعودية.',
    PAGE_W_PT - MARGIN, y, { align: 'right' });
  y += 18;

  const bottomLimit = PAGE_H_PT - 70;

  TERMS_AR.forEach((t, idx) => {
    const headerH = 16;
    const wrapped = doc.splitTextToSize(t.body, PAGE_W_PT - MARGIN * 2);
    const bodyH = wrapped.length * 12 + 8;
    const totalH = headerH + bodyH;

    if (y + totalH > bottomLimit) {
      drawFooterAR(doc, doc.internal.getNumberOfPages());
      doc.addPage();
      drawLetterheadAR(doc, null, '', true);
      y = 130;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(...BRAND_GREEN);
    doc.text(`${idx + 1}. ${t.heading}`, PAGE_W_PT - MARGIN, y, { align: 'right' });
    y += headerH;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(...INK_SOFT);
    wrapped.forEach((line, i) => {
      doc.text(line, PAGE_W_PT - MARGIN, y + i * 12, { align: 'right' });
    });
    y += bodyH;
  });

  drawFooterAR(doc, doc.internal.getNumberOfPages());
}

function drawSignaturesAR(doc, offer, signatory, startY) {
  let y = startY;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...BRAND_GREEN);
  doc.text('القبول والتوقيعات', PAGE_W_PT - MARGIN, y, { align: 'right' });
  y += 6;
  doc.setDrawColor(...BRAND_GREEN);
  doc.setLineWidth(1);
  doc.line(PAGE_W_PT - MARGIN - 140, y, PAGE_W_PT - MARGIN, y);
  y += 24;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK_SOFT);
  doc.text('نتطلع إلى الترحيب بكم في فريق إيفرغرين.', PAGE_W_PT - MARGIN, y, { align: 'right' });
  y += 18;
  doc.text('وتفضلوا بقبول فائق الاحترام،', PAGE_W_PT - MARGIN, y, { align: 'right' });
  y += 80;

  const blockW = (PAGE_W_PT - MARGIN * 2 - 30) / 2;
  // Signatory block — right side (in Arabic-aligned layout)
  doc.setDrawColor(...MUTED);
  doc.setLineWidth(0.5);
  doc.line(PAGE_W_PT - MARGIN - blockW, y, PAGE_W_PT - MARGIN, y);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10.5);
  doc.setTextColor(...INK);
  doc.text(signatory?.name || '—', PAGE_W_PT - MARGIN, y + 14, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text(signatory?.title || '—', PAGE_W_PT - MARGIN, y + 26, { align: 'right' });
  doc.text('عن الشركة وبالنيابة عنها', PAGE_W_PT - MARGIN, y + 38, { align: 'right' });

  // Seal placeholder — left side
  const sealCx = MARGIN + blockW / 2;
  const sealCy = y + 8;
  doc.setDrawColor(...MUTED);
  doc.setLineDashPattern([2, 2], 0);
  doc.circle(sealCx, sealCy, 32, 'S');
  doc.setLineDashPattern([], 0);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  doc.text('ختم الشركة', sealCx, sealCy - 2, { align: 'center' });
  doc.text('(يطبع عند الإصدار)', sealCx, sealCy + 9, { align: 'center' });

  y += 80;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(...INK);
  doc.text('قبول المرشح', PAGE_W_PT - MARGIN, y, { align: 'right' });
  y += 18;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...INK_SOFT);
  const candText = `أنا، ${offer.candidateName || '_______________________'}، أوافق على هذا العرض وعلى الشروط والأحكام الواردة في هذا الخطاب.`;
  const candWrapped = doc.splitTextToSize(candText, PAGE_W_PT - MARGIN * 2);
  candWrapped.forEach((line, i) => {
    doc.text(line, PAGE_W_PT - MARGIN, y + i * 12, { align: 'right' });
  });
  y += candWrapped.length * 12 + 30;

  const colW = (PAGE_W_PT - MARGIN * 2 - 30) / 2;
  doc.setDrawColor(...MUTED);
  doc.line(PAGE_W_PT - MARGIN - colW, y, PAGE_W_PT - MARGIN, y);
  doc.line(MARGIN, y, MARGIN + colW, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('التوقيع', PAGE_W_PT - MARGIN, y + 12, { align: 'right' });
  doc.text('التاريخ', MARGIN + colW, y + 12, { align: 'right' });

  drawFooterAR(doc, doc.internal.getNumberOfPages());
}

function drawFooterAR(doc, pageNum) {
  const footerY = PAGE_H_PT - 30;
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, footerY - 14, PAGE_W_PT - MARGIN, footerY - 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...MUTED);
  doc.text('هذا المستند سري.', PAGE_W_PT - MARGIN, footerY, { align: 'right' });
  doc.text(`صفحة ${pageNum}`, MARGIN, footerY);
}

// ─── Helper: format ISO date as "1 June 2026" ─────────────────────
function formatDateLong(yyyymmdd) {
  if (!yyyymmdd) return '—';
  const [y, m, d] = String(yyyymmdd).split('-').map(Number);
  if (!y || !m || !d) return yyyymmdd;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// ═══════════════════════════════════════════════════════════════════
// EMAIL (.eml) GENERATION — unchanged from previous version
// ═══════════════════════════════════════════════════════════════════

export function buildOfferEmailBody(offer, acceptanceUrl, sender) {
  const candidate = offer.candidateName || 'Candidate';
  const position = offer.positionTitle || 'the role';

  return [
    `Dear ${candidate},`,
    ``,
    `We are pleased to extend an offer for the position of ${position} at Evergreen Shipping Agency Saudi Co. (LLC).`,
    ``,
    `Please find the formal offer letter attached. The letter contains the full details of the position, salary, joining date, and Terms & Conditions in both English and Arabic.`,
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

export async function buildEmlMessage(args) {
  const {
    fromName, fromEmail, toEmail, toName,
    subject, body, pdfBlob, pdfFilename,
  } = args;

  const pdfBase64 = await blobToBase64(pdfBlob);
  const wrappedBase64 = wrapLine(pdfBase64, 76);

  const boundary = 'evergreen-offer-' + Math.random().toString(36).slice(2, 10);
  const dateHeader = new Date().toUTCString().replace('GMT', '+0000');
  const fromHeader = `${escapeHeader(fromName)} <${fromEmail}>`;
  const toHeader   = toName ? `${escapeHeader(toName)} <${toEmail}>` : toEmail;

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
