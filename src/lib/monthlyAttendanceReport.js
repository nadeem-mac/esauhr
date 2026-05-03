// =============================================================================
// monthlyAttendanceReport.js
//
// Generates a single-page .docx attendance summary for one employee
// for one calendar month. Used by HR (Bashaier / admin) to:
//   • Document the month's attendance for the employee's HR file
//   • Hand to the employee at evaluation time
//   • Attach to a manager email when escalating a pattern
//
// Pulls data from attendance_violations for the employee + month
// window. Produces a .docx with:
//   • Letterhead-style header (company, period, employee details)
//   • Summary stats tile (total incidents, late, early, missed)
//   • Per-day timeline table (date | weekday | type | minutes | punch)
//   • Notes section + signatures block
//
// Schema-clean: reads only the columns we know exist on
// attendance_violations and tolerates nulls (e.g. missing punch_in_time
// on missed_in rows).
// =============================================================================

import {
  Document, Packer, Paragraph, TextRun,
  Table, TableRow, TableCell,
  AlignmentType, WidthType, BorderStyle, HeightRule,
  VerticalAlign, ShadingType, HeadingLevel,
} from 'docx';
import { directGet } from '../supabaseClient.js';

const C_INK    = '1F1B16';
const C_PAPER  = 'FFFDF7';
const C_BORDER = 'D4C7AB';
const C_BRAND  = '0F4C2A';
const C_CLAY   = 'B84A3E';
const C_AMBER  = 'A16207';

const TYPE_LABELS = {
  late:        'Late arrival',
  early_leave: 'Early departure',
  missed_in:   'Missing punch-in',
  missed_out:  'Missing punch-out',
};

const MONTH_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
};

const fmtDate = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const weekdayShort = (iso) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short' });
};

const trimSec = (t) => {
  const m = /^(\d{2}):(\d{2})/.exec(String(t || ''));
  return m ? `${m[1]}:${m[2]}` : '—';
};

const cell = ({ text, bold, color, fill, width, align, children }) => new TableCell({
  width: width ? { size: width, type: WidthType.DXA } : undefined,
  margins: { top: 80, bottom: 80, left: 120, right: 120 },
  shading: fill ? { type: ShadingType.CLEAR, fill, color: 'auto' } : undefined,
  verticalAlign: VerticalAlign.CENTER,
  borders: {
    top:    { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
    bottom: { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
    left:   { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
    right:  { style: BorderStyle.SINGLE, size: 4, color: C_BORDER },
  },
  children: children || [new Paragraph({
    alignment: align || AlignmentType.LEFT,
    children: [new TextRun({ text: String(text ?? ''), bold, color: color || C_INK, size: 20 })],
  })],
});

// ─── Main entrypoint ─────────────────────────────────────────────────────────

/**
 * Fetch attendance_violations for one employee + month and produce a
 * downloadable .docx summary. Triggered from a button in HR-only UI.
 *
 * @param {Object}  args
 * @param {Object}  args.employee     — { id, name, department, location, manager_id, ... }
 * @param {Object}  args.empMap       — full directory keyed by id (for manager name)
 * @param {string}  args.monthStart   — ISO 'YYYY-MM-01'
 * @param {Object}  [args.preparedBy] — defaults to BASHAIER ALI
 */
export async function downloadMonthlyAttendanceReport({ employee, empMap = {}, monthStart, preparedBy }) {
  if (!employee?.id) throw new Error('Employee required.');
  if (!monthStart || !/^\d{4}-\d{2}-01$/.test(monthStart)) {
    throw new Error('monthStart must be ISO YYYY-MM-01.');
  }

  // Compute month range
  const start = new Date(monthStart + 'T00:00:00Z');
  const monthEndDate = new Date(start.getFullYear(), start.getMonth() + 1, 0);
  const monthEnd = monthEndDate.toISOString().slice(0, 10);
  const monthLabel = `${MONTH_LONG[start.getMonth()]} ${start.getFullYear()}`;

  // Fetch this employee's violations in window
  let rows = [];
  try {
    rows = await directGet(
      'attendance_violations?select=violation_date,violation_type,minutes_off,punch_in_time,punch_out_time,scheduled_start,scheduled_end,recorded_at'
      + '&employee_id=eq.' + encodeURIComponent(employee.id)
      + '&violation_date=gte.' + monthStart
      + '&violation_date=lte.' + monthEnd
      + '&cleared_at=is.null'
      + '&order=violation_date.asc'
    );
  } catch (e) {
    console.warn('Could not fetch violations for report:', e?.message || e);
    rows = [];
  }

  const tally = {
    late: rows.filter(r => r.violation_type === 'late').length,
    early_leave: rows.filter(r => r.violation_type === 'early_leave').length,
    missed_in:  rows.filter(r => r.violation_type === 'missed_in').length,
    missed_out: rows.filter(r => r.violation_type === 'missed_out').length,
  };
  const total = rows.length;
  // Distinct days with at least one incident — drives the
  // 5-per-month review threshold note at the bottom.
  const distinctDays = new Set(rows.map(r => r.violation_date)).size;
  const overThreshold = distinctDays >= 5;

  const manager = employee.manager_id ? empMap[employee.manager_id] : null;
  const sig = preparedBy || {
    name:    'BASHAIER ALI',
    title:   'HR Department',
    company: 'Evergreen Shipping Agency Saudi Co., (L.L.C)',
  };

  // ─── Build paragraphs ─────────────────────────────────────────────────────

  const head = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 60 },
      children: [new TextRun({
        text: 'EVERGREEN SHIPPING AGENCY SAUDI CO., (L.L.C)',
        bold: true, size: 28, color: C_BRAND,
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 0, after: 280 },
      children: [new TextRun({
        text: 'MONTHLY ATTENDANCE SUMMARY',
        bold: true, size: 22, color: C_INK,
      })],
    }),
  ];

  // Employee details table
  const empDetailsTable = new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [
      new TableRow({ height: { value: 380, rule: HeightRule.ATLEAST }, children: [
        cell({ text: 'EMPLOYEE',     bold: true, fill: C_PAPER, width: 1800 }),
        cell({ text: employee.name || '—',                width: 2700 }),
        cell({ text: 'PERIOD',       bold: true, fill: C_PAPER, width: 1800 }),
        cell({ text: monthLabel,                          width: 2700, bold: true }),
      ]}),
      new TableRow({ height: { value: 380, rule: HeightRule.ATLEAST }, children: [
        cell({ text: 'PSN',          bold: true, fill: C_PAPER, width: 1800 }),
        cell({ text: employee.id || '—', width: 2700 }),
        cell({ text: 'DEPARTMENT',   bold: true, fill: C_PAPER, width: 1800 }),
        cell({ text: employee.department || '—',          width: 2700 }),
      ]}),
      new TableRow({ height: { value: 380, rule: HeightRule.ATLEAST }, children: [
        cell({ text: 'MANAGER',      bold: true, fill: C_PAPER, width: 1800 }),
        cell({ text: manager?.name || '—',                width: 2700 }),
        cell({ text: 'LOCATION',     bold: true, fill: C_PAPER, width: 1800 }),
        cell({ text: employee.location || '—',            width: 2700 }),
      ]}),
    ],
  });

  // Summary tile
  const summaryTable = new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [
      new TableRow({ height: { value: 320, rule: HeightRule.ATLEAST }, children: [
        cell({ text: 'TOTAL INCIDENTS',  bold: true, fill: C_PAPER, width: 2250, align: AlignmentType.CENTER }),
        cell({ text: 'LATE ARRIVAL',     bold: true, fill: C_PAPER, width: 2250, align: AlignmentType.CENTER }),
        cell({ text: 'EARLY DEPARTURE', bold: true, fill: C_PAPER, width: 2250, align: AlignmentType.CENTER }),
        cell({ text: 'MISSED PUNCH',    bold: true, fill: C_PAPER, width: 2250, align: AlignmentType.CENTER }),
      ]}),
      new TableRow({ height: { value: 600, rule: HeightRule.ATLEAST }, children: [
        cell({ children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: String(total), bold: true, size: 48, color: overThreshold ? C_CLAY : C_INK })],
        })]}),
        cell({ children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: String(tally.late), bold: true, size: 48, color: C_CLAY })],
        })]}),
        cell({ children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: String(tally.early_leave), bold: true, size: 48, color: C_AMBER })],
        })]}),
        cell({ children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: String(tally.missed_in + tally.missed_out), bold: true, size: 48, color: '1D4ED8' })],
        })]}),
      ]}),
    ],
  });

  // Daily timeline table
  let timelineRows = [
    new TableRow({ tableHeader: true, height: { value: 320, rule: HeightRule.ATLEAST }, children: [
      cell({ text: 'DATE',     bold: true, fill: C_PAPER, width: 1500 }),
      cell({ text: 'DAY',      bold: true, fill: C_PAPER, width: 900 }),
      cell({ text: 'TYPE',     bold: true, fill: C_PAPER, width: 2400 }),
      cell({ text: 'MIN OFF', bold: true, fill: C_PAPER, width: 1100, align: AlignmentType.CENTER }),
      cell({ text: 'PUNCH',    bold: true, fill: C_PAPER, width: 1300 }),
      cell({ text: 'SCHEDULED', bold: true, fill: C_PAPER, width: 1800 }),
    ]}),
  ];

  if (rows.length === 0) {
    timelineRows.push(new TableRow({ height: { value: 600, rule: HeightRule.ATLEAST }, children: [
      cell({
        width: 9000,
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({
            text: 'No attendance incidents recorded for this period — clean record.',
            italics: true, color: C_BRAND, size: 22,
          })],
        })],
      }),
    ]}));
  } else {
    rows.forEach(r => {
      const punch = r.violation_type === 'late' ? trimSec(r.punch_in_time)
                  : r.violation_type === 'early_leave' ? trimSec(r.punch_out_time)
                  : '—';
      const sched = r.scheduled_start ? `${trimSec(r.scheduled_start)} → ${trimSec(r.scheduled_end)}` : '—';
      timelineRows.push(new TableRow({ height: { value: 320, rule: HeightRule.ATLEAST }, children: [
        cell({ text: fmtDate(r.violation_date), width: 1500 }),
        cell({ text: weekdayShort(r.violation_date), width: 900 }),
        cell({ text: TYPE_LABELS[r.violation_type] || r.violation_type, width: 2400 }),
        cell({ text: r.minutes_off ? String(r.minutes_off) : '—', width: 1100, align: AlignmentType.CENTER }),
        cell({ text: punch, width: 1300 }),
        cell({ text: sched, width: 1800 }),
      ]}));
    });
  }
  const timelineTable = new Table({ width: { size: 9000, type: WidthType.DXA }, rows: timelineRows });

  // Notes block
  const notes = [
    new Paragraph({
      spacing: { before: 320, after: 80 },
      children: [new TextRun({
        text: 'NOTES',
        bold: true, color: C_INK, size: 20,
      })],
    }),
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({
        text: overThreshold
          ? `This employee has reached the company review threshold (5 distinct days with attendance incidents in a calendar month). The case is referred for HR review and may affect the monthly attendance evaluation score.`
          : (total > 0
              ? `Total of ${total} incident${total === 1 ? '' : 's'} across ${distinctDays} day${distinctDays === 1 ? '' : 's'} this month — within the ESAU monthly threshold of 5 days. Continued monitoring.`
              : `Clean attendance record for this period.`),
        size: 20, color: C_INK,
      })],
    }),
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({
        text: `Per ESAU policy: a maximum of 3 permissions per calendar month is allowed (late arrival or early departure combined). Each request shall not exceed 60 minutes. Repeated unpermitted incidents are subject to HR review.`,
        size: 18, italics: true, color: C_INK,
      })],
    }),
  ];

  // Signature row
  const sigRow = new Table({
    width: { size: 9000, type: WidthType.DXA },
    rows: [
      new TableRow({ children: [
        cell({ text: 'PREPARED BY · HR',          bold: true, fill: C_PAPER, width: 3000, align: AlignmentType.CENTER }),
        cell({ text: 'EMPLOYEE ACKNOWLEDGEMENT',  bold: true, fill: C_PAPER, width: 3000, align: AlignmentType.CENTER }),
        cell({ text: 'MANAGER',                   bold: true, fill: C_PAPER, width: 3000, align: AlignmentType.CENTER }),
      ]}),
      new TableRow({ height: { value: 1300, rule: HeightRule.ATLEAST }, children: [
        cell({ children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '', size: 18 })]}),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 800 }, children: [new TextRun({ text: sig.name,    bold: true, size: 20 })]}),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: sig.title || 'HR Department', size: 16, color: C_INK })]}),
        ]}),
        cell({ children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '', size: 18 })]}),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 800 }, children: [new TextRun({ text: employee.name || '—', bold: true, size: 20 })]}),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: employee.id || '—', size: 16, color: C_INK })]}),
        ]}),
        cell({ children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '', size: 18 })]}),
          new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 800 }, children: [new TextRun({ text: manager?.name || '—', bold: true, size: 20 })]}),
          new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: manager?.id || '', size: 16, color: C_INK })]}),
        ]}),
      ]}),
    ],
  });

  // ─── Assemble document ───────────────────────────────────────────────────

  const doc = new Document({
    styles: {
      default: { document: { run: { font: 'Calibri', size: 20 } } },
    },
    sections: [{
      properties: { page: { margin: { top: 720, bottom: 720, left: 720, right: 720 } } },
      children: [
        ...head,
        empDetailsTable,
        new Paragraph({ spacing: { before: 200, after: 80 }, children: [new TextRun({ text: 'SUMMARY', bold: true, color: C_INK, size: 20 })] }),
        summaryTable,
        new Paragraph({ spacing: { before: 240, after: 80 }, children: [new TextRun({ text: 'DAILY TIMELINE', bold: true, color: C_INK, size: 20 })] }),
        timelineTable,
        ...notes,
        new Paragraph({ spacing: { before: 320, after: 0 }, children: [new TextRun({ text: '' })] }),
        sigRow,
      ],
    }],
  });

  const blob = await Packer.toBlob(doc);
  const safeName = String(employee.name || 'staff').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const fname = `Attendance_${safeName}_${monthLabel.replace(' ', '_')}.docx`;
  downloadBlob(blob, fname);
  return { rowCount: rows.length, distinctDays, overThreshold };
}
