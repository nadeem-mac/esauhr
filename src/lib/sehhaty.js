// =============================================================================
// sehhaty.js
//
// Helpers for the Sehhaty (صحتي / Saudi MOH) sick-leave workflow.
//
// Background: since 2022, all sick leaves in Saudi Arabia are issued
// digitally through the Sehhaty platform. Paper certificates are no
// longer accepted by HR. Each certificate carries a unique service
// code (also called the leave ID or verification code) that HR uses
// to confirm the certificate is real. The code starts with a 3-letter
// prefix that varies by leave type (GSL = General Sick Leave,
// PSL = Private Sick Leave, etc.) followed by 10-16 alphanumerics.
// See SEHHATY_KNOWN_PREFIXES in sehhatyOcr.js for the maintained list.
//
// There is no public REST API for verification — HR enters the
// service code on Sehhaty's website manually. This module's job is
// to:
//   • Validate the code format on entry
//   • Build the verification URL so 'Verify on Sehhaty' opens
//     the right page in a new tab
//   • Compute the Saudi Labour Law pay bracket given a sick-day
//     running total
// =============================================================================

// Direct entry to the Seha inquiry form where HR types the
// leave ID and ID number to verify a Sehhaty-issued sick leave.
// This is the closest single URL to a 'verify form' — drops
// Bashaier straight on the input page rather than the homepage.
//
// Caveat: Sehha periodically reorganises the inquiry routes;
// if this 404s in future, this is the single line to update.
export const SEHHATY_VERIFY_URL = 'https://www.seha.sa/#/inquiries/slenquiry';
// Alternative for sick leaves issued ABROAD (foreign certificates
// must be uploaded through the SEHA platform after diplomatic
// attestation). We don't do this flow today but the URL is
// captured so we can wire it in later when the need arises.
export const SEHA_FOREIGN_URL  = 'https://www.moh.gov.sa/en/eServices/Pages/Sick-Leaves.aspx';

// Saudi Labour Law sick-leave brackets (Article 117). Values are
// inclusive day-count thresholds, in order. The first bracket the
// running total fits into is the active one.
//   • 1–30   : 100% of basic salary
//   • 31–90  : 75%
//   • 91–120 : 0% (unpaid)
//   • 121+   : entitlement exhausted; HR may invoke termination
//              under Art. 82 after consulting the employee.
export const SICK_LEAVE_BRACKETS = [
  { upTo: 30,  pay: 1.00, label: 'Full pay',     color: '#047857' },
  { upTo: 90,  pay: 0.75, label: '75% pay',      color: '#A16207' },
  { upTo: 120, pay: 0.00, label: 'Unpaid',       color: '#B91C1C' },
  { upTo: Infinity, pay: 0.00, label: 'Quota exceeded', color: '#7F1D1D' },
];

/**
 * Given the year-to-date sick-day count BEFORE this request, and the
 * number of days in this request, return the bracket that applies to
 * the new days plus a friendly warning if the request crosses a
 * bracket boundary (so HR can flag the pay change to payroll).
 */
export function classifySickLeaveBracket(yearToDate, requestDays) {
  const startTotal = Number(yearToDate) || 0;
  const endTotal   = startTotal + (Number(requestDays) || 0);
  const bracketAt = (n) => SICK_LEAVE_BRACKETS.find(b => n <= b.upTo);
  const startBracket = bracketAt(startTotal + 1); // first new day's bracket
  const endBracket   = bracketAt(endTotal);
  return {
    startTotal,
    endTotal,
    quotaCap: 120,
    daysRemaining: Math.max(0, 120 - endTotal),
    startBracket,
    endBracket,
    crossesBoundary: startBracket && endBracket && startBracket.label !== endBracket.label,
    overQuota: endTotal > 120,
  };
}

/**
 * Light-touch validation on the service code as the user types.
 * Sehhaty codes are typically 8–14 digits depending on the issuing
 * source, sometimes preceded by a Sehhaty prefix like 'GSL', 'PSL',
 * etc. We don't reject
 * anything — just normalise (strip spaces, uppercase) so the stored
 * value is consistent.
 */
export function normaliseSehhatyCode(input) {
  return String(input || '').trim().toUpperCase().replace(/\s+/g, '');
}

/** Loose 'looks like a code' check — anything 4+ alphanumerics. */
export function looksLikeSehhatyCode(input) {
  const norm = normaliseSehhatyCode(input);
  return /^[A-Z0-9-]{4,}$/.test(norm);
}

/**
 * Cross-check the Sehhaty inquiry result against what the staff
 * submitted on the leave request. The Sehhaty page returns
 * structured fields (name, dates, day count, issue date, doctor,
 * specialty) — we compare each one to the corresponding value on
 * the leave request and surface mismatches.
 *
 * Inputs:
 *   request    — the leave_request row
 *   employee   — the employee row (for name comparison)
 *   seen       — what HR typed in from the Sehhaty result:
 *     { name, start, end, days, issueDate, doctor, specialty, idNumber }
 *
 * Returns:
 *   {
 *     allOk,           // boolean — every required field matched
 *     mismatches: [],  // array of { field, requested, seen, severity }
 *     notes: [],       // any fields that were skipped because the
 *                      // staff value isn't on file (e.g. doctor name
 *                      // — staff doesn't supply it, only HR sees it
 *                      // on Sehhaty)
 *   }
 *
 * Severity levels:
 *   'block'  — refuse to verify (e.g. dates don't match, day count
 *              wildly off). Cannot bypass.
 *   'warn'   — discrepancy worth flagging but allowed (e.g. issue
 *              date is one day before start; common when the
 *              certificate is issued the morning of the leave).
 */
export function crossCheckSehhaty({ request, employee, seen }) {
  const mismatches = [];
  const notes = [];

  if (!seen) {
    return {
      allOk: false,
      mismatches: [{ field: 'all', requested: '—', seen: '—', severity: 'block' }],
      notes: ['No verification data entered yet.'],
    };
  }

  // Helper — normalise dates to YYYY-MM-DD strings
  const isoDate = (v) => {
    if (!v) return null;
    if (typeof v === 'string') return v.slice(0, 10);
    try { return new Date(v).toISOString().slice(0, 10); } catch { return null; }
  };

  // Start date — must match exactly. If the certificate's start
  // date doesn't match the leave's start date, we're verifying the
  // wrong certificate.
  const reqStart  = isoDate(request.start_date);
  const seenStart = isoDate(seen.start);
  if (seenStart && reqStart !== seenStart) {
    mismatches.push({
      field: 'Start date',
      requested: reqStart,
      seen: seenStart,
      severity: 'block',
    });
  }

  // End date — same rule.
  const reqEnd  = isoDate(request.end_date);
  const seenEnd = isoDate(seen.end);
  if (seenEnd && reqEnd !== seenEnd) {
    mismatches.push({
      field: 'End date',
      requested: reqEnd,
      seen: seenEnd,
      severity: 'block',
    });
  }

  // Day count — must match. The Sehhaty cert is the source of truth
  // on how many days were actually certified by the doctor.
  const reqDays  = Number(request.days) || 0;
  const seenDays = Number(seen.days);
  if (Number.isFinite(seenDays) && seenDays > 0 && reqDays !== seenDays) {
    mismatches.push({
      field: 'Days',
      requested: reqDays,
      seen: seenDays,
      severity: 'block',
    });
  }

  // Name — soft check. Sehhaty stores Arabic; the leave system
  // stores English/transliterated. We can't enforce equality; HR's
  // visual confirmation that 'this is the right person' is the
  // real check. We just record what was seen.
  if (!seen.name || !seen.name.trim()) {
    notes.push('No name from Sehhaty entered — HR should confirm visually.');
  }

  // Issue date — typically same day as start or 1 day before. Flag
  // if more than 7 days before the leave starts (unusual for a
  // legitimate same-illness certificate).
  const seenIssue = isoDate(seen.issueDate);
  if (seenIssue && reqStart) {
    const issueMs = new Date(seenIssue).getTime();
    const startMs = new Date(reqStart).getTime();
    const dayDiff = Math.round((startMs - issueMs) / 86_400_000);
    if (dayDiff > 7) {
      mismatches.push({
        field: 'Issue date',
        requested: `before ${reqStart}`,
        seen: `${seenIssue} (${dayDiff} days earlier)`,
        severity: 'warn',
      });
    }
    if (dayDiff < -1) {
      // Issue date is AFTER the leave start. Possible (cert issued
      // mid-illness when patient saw a doctor a few days in), but
      // worth flagging.
      mismatches.push({
        field: 'Issue date',
        requested: `near ${reqStart}`,
        seen: `${seenIssue} (after leave started)`,
        severity: 'warn',
      });
    }
  }

  // Doctor and specialty — staff doesn't submit these, so they're
  // record-only. We just take what HR typed in. No comparison.
  if (!seen.doctor || !seen.doctor.trim()) {
    notes.push('Doctor name not recorded — useful for the audit trail.');
  }

  // Iqama / National ID — must match employee.iqama_id when both are
  // present. A mismatch here means the screenshot is for a different
  // person (e.g. Bashaier pasted the wrong window), which is the
  // single most dangerous form of cross-verification error. Treat
  // as a hard block.
  const empIqama = (employee?.iqama_id || '').toString().replace(/\s+/g, '');
  const seenIq   = (seen.idNumber       || '').toString().replace(/\s+/g, '');
  if (empIqama && seenIq && empIqama !== seenIq) {
    mismatches.push({
      field: 'Iqama / National ID',
      requested: empIqama,
      seen: seenIq,
      severity: 'block',
      message: `Iqama on the screenshot (${seenIq}) does not match the employee's record (${empIqama}). Wrong person?`,
    });
  }

  const blockers = mismatches.filter(m => m.severity === 'block');
  return {
    allOk: blockers.length === 0,
    mismatches,
    notes,
  };
}

/**
 * Detailed validation with diagnostic output. Used by the HR
 * verification modal to give Bashaier a clear picture of what's
 * suspicious about a code before she has to make the call.
 *
 * Returns an object with:
 *   • severity   — 'ok' | 'warn' | 'error'
 *   • messages   — array of human-readable issues
 *   • normalised — the code as it'll be stored
 *
 * The severity ladder:
 *   'error' — the code is unusable (empty, way too short, illegal
 *             characters, or pure repetition like '0000'). Verify
 *             button is hard-disabled at this level.
 *   'warn'  — the code is technically usable but has features
 *             that look suspicious (very short, looks like a
 *             phone number, common test pattern). Verify is still
 *             allowed but Bashaier sees a yellow flag.
 *   'ok'    — looks like a normal Sehhaty code.
 *
 * This is ONLY a format check. The actual truthfulness of the code
 * — whether it matches a real certificate on Sehhaty — can only be
 * confirmed by Bashaier on the MOH portal.
 */
export function diagnoseSehhatyCode(input) {
  const messages = [];
  let severity = 'ok';
  const norm = normaliseSehhatyCode(input);

  if (!norm) {
    return { severity: 'error', messages: ['No code provided.'], normalised: '' };
  }

  // Hard format errors — code is unusable as a Sehhaty reference.
  if (norm.length < 4) {
    severity = 'error';
    messages.push(`Too short — only ${norm.length} character${norm.length === 1 ? '' : 's'}. Sehhaty codes are usually 8+.`);
  }
  if (!/^[A-Z0-9-]+$/.test(norm)) {
    severity = 'error';
    messages.push('Contains characters that aren\'t allowed (only letters, digits, and hyphens).');
  }
  if (/^(.)\1+$/.test(norm)) {
    // All same character — '0000', 'AAAA' etc.
    severity = 'error';
    messages.push('Looks like a placeholder (all same character).');
  }

  // Soft warnings — code might be valid but worth a second look.
  if (severity !== 'error') {
    if (norm.length >= 4 && norm.length < 8) {
      severity = 'warn';
      messages.push(`Code is ${norm.length} characters — Sehhaty codes are usually 8 or more.`);
    }
    if (/^(?:0?5|\+?9665)\d{8}$/.test(norm.replace(/-/g, ''))) {
      severity = 'warn';
      messages.push('Looks like a Saudi mobile number rather than a Sehhaty code.');
    }
    if (/^(0?1|0?2|0?3)\d{6,}$/.test(norm.replace(/-/g, ''))) {
      severity = 'warn';
      messages.push('Looks like an Iqama/National ID rather than a Sehhaty code.');
    }
    if (/^(?:1234|0000|TEST|DEMO|ABCD)/.test(norm)) {
      severity = 'warn';
      messages.push('Pattern looks like a test value, not a real certificate.');
    }
  }

  if (messages.length === 0) {
    messages.push('Format looks plausible. Verify the certificate on Sehhaty before approving.');
  }

  return { severity, messages, normalised: norm };
}
