// ──────────────────────────────────────────────────────────────────────
//  StaffRosterCard
//
//  Admin/HR headcount export: the full active staff roster split into
//  SAUDI vs NON-SAUDI, sorted by gender then name, with full details
//  (PSN, nationality, gender, department, location, join date, email,
//  status). Reads the live `employees` roster passed from AppShell, so
//  the counts always reflect the current headcount.
//
//  Gated to Bashaier (H94830) and Nadeem (H94152) on the attendance view.
//  (Nadeem 2026-06-08)
// ──────────────────────────────────────────────────────────────────────

import React, { useMemo, useState } from 'react';
import { FileSpreadsheet, Loader2, Users } from 'lucide-react';
import ExcelJS from 'exceljs';
import { isActiveEmployee } from '../lib/leaveLogic.js';

const fmtDate = (d) => {
  if (!d) return '';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d).slice(0, 10);
  return dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const isSaudi = (nat) => /saudi/i.test(String(nat || ''));
const genderOf = (g) => {
  const s = String(g || '').trim().toLowerCase();
  if (s.startsWith('f')) return 'Female';
  if (s.startsWith('m')) return 'Male';
  return 'Unspecified';
};

export default function StaffRosterCard({ employees = [], me }) {
  const [busy, setBusy] = useState(false);

  // Active roster only (drops inactive/departed/terminated + pre-joining).
  const roster = useMemo(() => {
    return (employees || [])
      .filter(e => e && e.id && e.name)
      .filter(e => isActiveEmployee(e) && e.status !== 'pre_joining')
      .map(e => ({
        id: e.id,
        name: String(e.name || '').replace(/\s+/g, ' ').trim(),
        nationality: e.nationality_full || e.nationality || '—',
        gender: genderOf(e.gender),
        department: e.department || '—',
        location: e.location || '—',
        join_date: e.join_date || '',
        email: e.email || '',
        status: e.status || 'active',
        saudi: isSaudi(e.nationality_full || e.nationality),
      }));
  }, [employees]);

  const groups = useMemo(() => {
    const order = ['Female', 'Male', 'Unspecified'];
    const byLocDeptName = (a, b) =>
      String(a.location || '').localeCompare(String(b.location || '')) ||
      String(a.department || '').localeCompare(String(b.department || '')) ||
      a.name.localeCompare(b.name);
    const bucket = (saudi) => order
      .map(g => ({ gender: g, list: roster.filter(r => r.saudi === saudi && r.gender === g).sort(byLocDeptName) }))
      .filter(b => b.list.length);
    const saudi = bucket(true);
    const nonSaudi = bucket(false);
    const count = (bs) => bs.reduce((n, b) => n + b.list.length, 0);
    return {
      saudi, nonSaudi,
      saudiCount: count(saudi), nonSaudiCount: count(nonSaudi),
      saudiF: roster.filter(r => r.saudi && r.gender === 'Female').length,
      saudiM: roster.filter(r => r.saudi && r.gender === 'Male').length,
      nonF: roster.filter(r => !r.saudi && r.gender === 'Female').length,
      nonM: roster.filter(r => !r.saudi && r.gender === 'Male').length,
      total: roster.length,
    };
  }, [roster]);

  async function handleExport() {
    setBusy(true);
    try {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Staff Roster', { views: [{ state: 'frozen', ySplit: 4 }] });
      const HEADERS = ['#', 'Employee name', 'PSN', 'Nationality', 'Gender', 'Department', 'Location', 'Joined', 'Email', 'Status'];
      const NCOL = HEADERS.length;

      const GREEN = 'FF0F4C2A', GREEN_LT = 'FFDCFCE7', AMBER = 'FFD97706', AMBER_LT = 'FFFEF3C7';
      const border = { top: { style: 'thin', color: { argb: 'FFE5E7EB' } }, bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } }, left: { style: 'thin', color: { argb: 'FFE5E7EB' } }, right: { style: 'thin', color: { argb: 'FFE5E7EB' } } };

      // Title
      ws.mergeCells(1, 1, 1, NCOL);
      const t = ws.getCell(1, 1);
      t.value = `ESAU Staff Roster — Nationality & Gender   ·   ${fmtDate(new Date())}`;
      t.font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
      t.alignment = { horizontal: 'center', vertical: 'middle' };
      t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
      ws.getRow(1).height = 26;

      // Summary
      ws.mergeCells(2, 1, 2, NCOL);
      const sm = ws.getCell(2, 1);
      sm.value = `Total active: ${groups.total}    |    Saudi: ${groups.saudiCount} (F ${groups.saudiF} / M ${groups.saudiM})    |    Non-Saudi: ${groups.nonSaudiCount} (F ${groups.nonF} / M ${groups.nonM})`;
      sm.font = { bold: true, size: 11, color: { argb: 'FF1F1B16' } };
      sm.alignment = { horizontal: 'center' };
      sm.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F4F6' } };
      ws.getRow(2).height = 20;
      ws.getRow(3).height = 6; // spacer

      // Column header (row 4 — frozen)
      const hr = ws.getRow(4);
      HEADERS.forEach((h, i) => {
        const c = hr.getCell(i + 1);
        c.value = h;
        c.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
        c.alignment = { horizontal: i === 1 || i === 8 ? 'left' : 'center', vertical: 'middle' };
        c.border = border;
      });
      hr.height = 20;

      let r = 5; let seq = 0;
      const sectionBand = (label, fill) => {
        ws.mergeCells(r, 1, r, NCOL);
        const c = ws.getCell(r, 1);
        c.value = label;
        c.font = { bold: true, size: 11, color: { argb: 'FFFFFFFF' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        c.alignment = { horizontal: 'left', vertical: 'middle' };
        ws.getRow(r).height = 18;
        r += 1;
      };
      const genderBand = (label, fill) => {
        ws.mergeCells(r, 1, r, NCOL);
        const c = ws.getCell(r, 1);
        c.value = label;
        c.font = { bold: true, size: 10, color: { argb: 'FF1F1B16' } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        c.alignment = { horizontal: 'left' };
        r += 1;
      };
      const writeRows = (list) => {
        for (const e of list) {
          seq += 1;
          const vals = [seq, e.name, e.id, String(e.nationality || '—').toUpperCase(), e.gender, e.department, e.location, fmtDate(e.join_date), e.email, e.status];
          const row = ws.getRow(r);
          vals.forEach((v, i) => {
            const c = row.getCell(i + 1);
            c.value = v;
            c.alignment = { horizontal: i === 1 || i === 8 ? 'left' : 'center', vertical: 'middle' };
            c.border = border;
            c.font = { size: 10, color: { argb: 'FF1F1B16' } };
          });
          if (seq % 2 === 0) row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFAFAF9' } }; });
          r += 1;
        }
      };

      sectionBand(`SAUDI NATIONALS  (${groups.saudiCount})`, GREEN);
      for (const b of groups.saudi) { genderBand(`${b.gender} (${b.list.length})`, GREEN_LT); writeRows(b.list); }
      r += 1;
      sectionBand(`NON-SAUDI  (${groups.nonSaudiCount})`, AMBER);
      for (const b of groups.nonSaudi) { genderBand(`${b.gender} (${b.list.length})`, AMBER_LT); writeRows(b.list); }

      // Column widths (auto-fit-ish)
      const widths = [5, 34, 9, 14, 11, 14, 12, 13, 38, 11];
      widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ESAU_Staff_Roster_Nationality_${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (e) {
      console.error('Roster export failed', e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border bg-white p-4" style={{ borderColor: 'var(--border-soft)' }}>
      <div className="flex items-center gap-2 mb-1">
        <Users className="w-4 h-4" style={{ color: '#0F4C2A' }} />
        <h3 className="text-sm font-semibold" style={{ color: '#1F1B16' }}>Staff roster — nationality &amp; gender</h3>
      </div>
      <p className="text-xs mb-3" style={{ color: '#1F1B16' }}>
        Active headcount: <strong>{groups.total}</strong> &nbsp;·&nbsp;
        Saudi <strong>{groups.saudiCount}</strong> (F {groups.saudiF} / M {groups.saudiM}) &nbsp;·&nbsp;
        Non-Saudi <strong>{groups.nonSaudiCount}</strong> (F {groups.nonF} / M {groups.nonM})
      </p>
      <button
        type="button"
        onClick={handleExport}
        disabled={busy || groups.total === 0}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold transition disabled:opacity-50"
        style={{ background: '#107C41', color: '#FFFFFF' }}>
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
        Export roster (Excel)
      </button>
    </div>
  );
}
