import React, { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { Upload, AlertCircle, CheckCircle2, Loader2, FileSpreadsheet, Info, ChevronRight, ChevronDown } from 'lucide-react';
import { directGet, directPost, directPatch } from '../supabaseClient.js';

// =============================================================================
// LeaveHistoryImportCard
//
// One-time importer for the legacy "ESAU STAFF LEAVE TRACKER" Excel. Reads the
// "Mark Leave" sheet (one row per staff per leave-day), maps the tracker's
// type codes to our leave_type_ids, skips anything already imported, then
// creates APPROVED leave_requests so the portal "catches" those dates — and
// every balance / report recomputes from them automatically. Preview first;
// nothing is written until the user confirms.
// =============================================================================

// Tracker code → our leave_type_id. HDL = half-day (counts 0.5, annual).
const CODE_MAP = {
  PL:  { id: 'annual',    label: 'Annual (Privilege)' },
  LWP: { id: 'unpaid',    label: 'Unpaid (LWP)' },
  SL:  { id: 'sick',      label: 'Sick' },
  CL:  { id: 'emergency', label: 'Casual → Emergency' },
  ML:  { id: 'maternity', label: 'Maternity' },
  WL:  { id: 'marriage',  label: 'Wedding → Marriage' },
  HDL: { id: 'annual', half: true, label: 'Half-day (Annual)' },
};

const IMPORT_MARK = 'Imported from leave tracker';

const ACCENT = '#0F4C2A';

function toISO(v) {
  // SheetJS (cellDates) gives a Date; strings like '2026-01-05' also handled.
  if (v instanceof Date && !isNaN(v)) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return null;
}

function addDaysISO(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export default function LeaveHistoryImportCard({ me, employees = [], onSaved }) {
  const fileRef = useRef(null);
  const [fileName, setFileName] = useState('');
  const [parsing, setParsing] = useState(false);
  const [plan, setPlan] = useState(null);      // { ranges, byEmp, stats, warnings }
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [msg, setMsg] = useState(null);
  const [adjWarn, setAdjWarn] = useState([]);  // employees with prior migration adjustments
  const [openEmp, setOpenEmp] = useState(() => new Set()); // expanded date lists
  const [clearingAdj, setClearingAdj] = useState(false);

  // Zero out the legacy "migration / pre-portal" balance adjustments now that
  // the real dated leave rows exist — otherwise that usage is counted twice.
  async function clearAdjustments() {
    if (!adjWarn.length || clearingAdj) return;
    setClearingAdj(true);
    const today = new Date().toISOString().slice(0, 10);
    let ok = 0, fail = 0;
    for (const a of adjWarn) {
      try {
        await directPatch('leave_balances', 'id', a.id,
          { adjustment: 0, adjustment_note: `${a.note || ''} · cleared after leave import ${today}`.trim() },
          { timeoutMs: 8000 });
        ok++;
      } catch { fail++; }
    }
    setClearingAdj(false);
    setAdjWarn([]);
    setMsg({ kind: fail ? 'err' : 'ok', text: `Cleared ${ok} migration adjustment(s)${fail ? `; ${fail} failed` : ''}. Balances now count the imported dates only.` });
    onSaved?.();
  }

  const fmtDay = (iso) => {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  };
  const fmtRange = (r) => `${r.start === r.end ? fmtDay(r.start) : `${fmtDay(r.start)} – ${fmtDay(r.end)}`} · ${r.code} · ${Math.round(r.days * 10) / 10}d`;
  const toggleEmp = (psn) => setOpenEmp(prev => { const n = new Set(prev); n.has(psn) ? n.delete(psn) : n.add(psn); return n; });

  const empById = React.useMemo(() => {
    const m = {};
    for (const e of employees) m[String(e.id).toUpperCase()] = e;
    return m;
  }, [employees]);

  async function onFile(file) {
    if (!file) return;
    setParsing(true); setMsg(null); setPlan(null); setProgress({ done: 0, total: 0, failed: 0 });
    setFileName(file.name);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      // Prefer "Mark Leave"; fall back to any sheet with the expected headers.
      let sheetName = wb.SheetNames.find(n => /mark\s*leave/i.test(n))
                   || wb.SheetNames.find(n => /leave[_ ]?history/i.test(n))
                   || wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
      if (!aoa.length) throw new Error('That sheet is empty.');

      // Locate the header row + columns.
      const headerRowIdx = aoa.findIndex(r =>
        (r || []).some(c => /emp\s*id/i.test(String(c))) &&
        (r || []).some(c => /date/i.test(String(c))) &&
        (r || []).some(c => /leave\s*type/i.test(String(c))));
      if (headerRowIdx < 0) throw new Error('Could not find the EMP ID / Date / Leave Type header row.');
      const hdr = aoa[headerRowIdx].map(c => String(c || '').trim().toLowerCase());
      const col = (re) => hdr.findIndex(h => re.test(h));
      const cPsn = col(/emp\s*id/), cName = col(/emp\s*name/), cDate = col(/date/),
            cType = col(/leave\s*type/), cReason = col(/reason/);

      // Parse data rows → per (emp, date, code) entries.
      const seen = new Set();           // dedupe within the file: emp|date
      const entries = [];
      let unknownPsn = 0, unknownCode = 0, badDate = 0, dupInFile = 0;
      for (let i = headerRowIdx + 1; i < aoa.length; i++) {
        const r = aoa[i] || [];
        const rawPsn = String(r[cPsn] || '').trim().toUpperCase();
        if (!rawPsn) continue;
        const iso = toISO(r[cDate]);
        const code = String(r[cType] || '').trim().toUpperCase();
        if (!iso) { badDate++; continue; }
        const map = CODE_MAP[code];
        if (!map) { unknownCode++; continue; }
        if (!empById[rawPsn]) { unknownPsn++; continue; }
        const key = `${rawPsn}|${iso}`;
        if (seen.has(key)) { dupInFile++; continue; }
        seen.add(key);
        entries.push({
          psn: rawPsn, name: r[cName] || empById[rawPsn]?.name || rawPsn,
          iso, code, typeId: map.id, half: !!map.half,
          reason: String(r[cReason] || '').trim(),
        });
      }
      if (!entries.length) throw new Error('No importable leave rows were found.');

      // Skip any date that ALREADY has a leave on record — whether it was
      // logged manually in the Logbook or brought in by a prior import. The
      // importer only ADDS; it never edits or deletes existing entries, and
      // this guard makes sure it never duplicates a day you've already
      // entered. Bound the query to the file's own date span.
      const isoList = entries.map(e => e.iso);
      const minISO = isoList.reduce((m, x) => (x < m ? x : m), isoList[0]);
      const maxISO = isoList.reduce((m, x) => (x > m ? x : m), isoList[0]);
      const covered = new Set();
      let importedCovered = 0;
      const isDead = (row) => /reject|cancel|withdraw/i.test(`${row.status || ''} ${row.stage || ''}`);
      try {
        const existing = await directGet('leave_requests',
          `select=employee_id,start_date,end_date,status,stage,reason`
          + `&end_date=gte.${minISO}&start_date=lte.${maxISO}`,
          { timeoutMs: 12000 });
        for (const row of (existing || [])) {
          if (isDead(row)) continue;                 // rejected/cancelled don't reserve the date
          const wasImport = String(row.reason || '').startsWith(IMPORT_MARK);
          let d = String(row.start_date).slice(0, 10);
          const end = String(row.end_date).slice(0, 10);
          let guard = 0;
          while (d <= end && guard++ < 400) {
            const k = `${String(row.employee_id).toUpperCase()}|${d}`;
            if (!covered.has(k)) { covered.add(k); if (wasImport) importedCovered++; }
            d = addDaysISO(d, 1);
          }
        }
      } catch (e) { /* if this fails we still preview; import will dedupe less */ }

      const fresh = entries.filter(e => !covered.has(`${e.psn}|${e.iso}`));
      const skippedAlready = entries.length - fresh.length;

      // Group consecutive same-type days per employee into ranges. HDL rows
      // stay single (half-day). Each full day = 1, each HDL day = 0.5.
      const byKey = {};
      for (const e of fresh) (byKey[`${e.psn}|${e.code}`] ||= []).push(e);
      const ranges = [];
      for (const [, list] of Object.entries(byKey)) {
        list.sort((a, b) => a.iso.localeCompare(b.iso));
        let run = null;
        const flush = () => { if (run) ranges.push(run); run = null; };
        for (const e of list) {
          if (e.half) { ranges.push({ ...e, start: e.iso, end: e.iso, days: 0.5, count: 1 }); continue; }
          if (run && addDaysISO(run.end, 1) === e.iso) { run.end = e.iso; run.days += 1; run.count += 1; }
          else { flush(); run = { ...e, start: e.iso, end: e.iso, days: 1, count: 1 }; }
        }
        flush();
      }
      ranges.sort((a, b) => a.psn.localeCompare(b.psn) || a.start.localeCompare(b.start));

      // Per-employee + global stats.
      const byEmp = {};
      let totalDays = 0;
      for (const r of ranges) {
        const slot = (byEmp[r.psn] ||= { psn: r.psn, name: r.name, dept: empById[r.psn]?.department, days: 0, rows: 0, types: {}, items: [] });
        slot.days += r.days; slot.rows += 1; slot.types[r.code] = (slot.types[r.code] || 0) + r.days;
        slot.items.push(r);
        totalDays += r.days;
      }

      // Surface prior manual "migration" balance adjustments that would now
      // double-count once these real rows exist.
      try {
        const bals = await directGet('leave_balances',
          'select=id,employee_id,leave_type_id,year,adjustment,adjustment_note&adjustment=neq.0',
          { timeoutMs: 10000 });
        const flagged = (bals || []).filter(b => /migrat|excel|pre-?portal|pre portal/i.test(String(b.adjustment_note || '')));
        setAdjWarn(flagged.map(b => ({
          id: b.id, employee_id: b.employee_id,
          name: empById[String(b.employee_id).toUpperCase()]?.name || b.employee_id,
          type: b.leave_type_id, year: b.year, adjustment: b.adjustment, note: b.adjustment_note,
        })));
      } catch { setAdjWarn([]); }

      setPlan({
        ranges,
        byEmp: Object.values(byEmp).sort((a, b) => a.name.localeCompare(b.name)),
        stats: {
          sheet: sheetName, fileRows: entries.length, skippedAlready,
          employees: Object.keys(byEmp).length, records: ranges.length, totalDays,
          unknownPsn, unknownCode, badDate, dupInFile,
        },
      });
    } catch (err) {
      setMsg({ kind: 'err', text: err?.message || 'Could not read that file.' });
    } finally {
      setParsing(false);
    }
  }

  async function runImport() {
    if (!plan?.ranges?.length || importing) return;
    setImporting(true); setMsg(null);
    const ranges = plan.ranges;
    setProgress({ done: 0, total: ranges.length, failed: 0 });
    let done = 0, failed = 0;
    // Sequential with a tiny concurrency window keeps the anon-key endpoint happy.
    const queue = [...ranges];
    const worker = async () => {
      while (queue.length) {
        const r = queue.shift();
        const startIso = `${r.start}T00:00:00Z`;
        const row = {
          employee_id:        r.psn,
          leave_type_id:      r.typeId,
          start_date:         r.start,
          end_date:           r.end,
          days:               r.days,
          is_half_day:        r.half || null,
          reason:             r.reason ? `${IMPORT_MARK} · ${r.reason}` : IMPORT_MARK,
          stage:              'approved',
          status:             'approved',
          requested_at:       startIso,
          requested_by:       me?.id || null,
          manager_decided_at: startIso,
          hr_decided_at:      startIso,
        };
        try { await directPost('leave_requests', row, { timeoutMs: 12000 }); done++; }
        catch (e) { failed++; }
        setProgress({ done: done + failed, total: ranges.length, failed });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setImporting(false);
    setMsg({
      kind: failed ? 'err' : 'ok',
      text: failed
        ? `Imported ${done} record(s); ${failed} failed. You can re-run — already-imported dates are skipped.`
        : `Imported ${done} leave record(s). Balances and reports now reflect these dates.`,
    });
    if (done) { setPlan(null); onSaved?.(); }
  }

  const s = plan?.stats;

  return (
    <div className="space-y-4">
      <div className="rounded-xl p-4" style={{ background: '#F0FBF4', border: '1px solid #BBE7CC' }}>
        <div className="flex items-start gap-2 text-xs" style={{ color: '#0A0A0A' }}>
          <Info size={14} className="mt-0.5 flex-shrink-0" style={{ color: ACCENT }} />
          <div>
            <strong>One-time leave-history import.</strong> Upload the ESAU Staff Leave Tracker (.xlsx / .xlsm).
            The system reads the <strong>Mark Leave</strong> sheet, creates an approved leave record for each
            date, and recomputes every balance from them. Re-running is safe — dates already imported are skipped.
          </div>
        </div>
      </div>

      {/* Code mapping (so HR can verify before importing) */}
      <div className="text-[11px]" style={{ color: '#1F1B16' }}>
        <span className="opacity-70">Type mapping:</span>{' '}
        {Object.entries(CODE_MAP).map(([code, m], i) => (
          <span key={code}>{i ? ' · ' : ''}<strong>{code}</strong> → {m.label}</span>
        ))}
      </div>

      <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls" className="hidden"
        onChange={e => onFile(e.target.files?.[0])} />
      <div className="flex items-center gap-3">
        <button type="button" onClick={() => fileRef.current?.click()} disabled={parsing || importing}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold text-white disabled:opacity-50"
          style={{ background: ACCENT }}>
          {parsing ? <Loader2 size={15} className="animate-spin" /> : <Upload size={15} />}
          {parsing ? 'Reading…' : 'Choose tracker file'}
        </button>
        {fileName && (
          <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: '#1F1B16' }}>
            <FileSpreadsheet size={13} /> {fileName}
          </span>
        )}
      </div>

      {msg && (
        <div className={`flex items-center gap-2 text-sm rounded px-3 py-2 ${msg.kind === 'ok' ? 'bg-green-50 text-green-900' : 'bg-red-50 text-red-900'}`}>
          {msg.kind === 'ok' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
          {msg.text}
        </div>
      )}

      {/* Preview */}
      {plan && s && (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            {[['Employees', s.employees], ['Leave records', s.records], ['Total days', Math.round(s.totalDays * 10) / 10]].map(([k, v]) => (
              <div key={k} className="rounded-lg px-3 py-2" style={{ background: '#FFFFFF', border: '1px solid rgba(0,0,0,0.1)' }}>
                <div className="text-lg font-bold" style={{ color: ACCENT }}>{v}</div>
                <div className="text-[11px]" style={{ color: '#1F1B16' }}>{k}</div>
              </div>
            ))}
          </div>

          {/* Skips / warnings */}
          {(s.skippedAlready || s.unknownPsn || s.unknownCode || s.badDate || s.dupInFile) ? (
            <div className="rounded px-3 py-2 text-xs" style={{ background: '#FFFBEB', border: '1px solid #FCD34D', color: '#854F0B' }}>
              <strong>From {s.fileRows} parsed rows ({s.sheet}):</strong>{' '}
              {s.skippedAlready ? `${s.skippedAlready} already on record — logbook entry or prior import (skipped); ` : ''}
              {s.unknownPsn ? `${s.unknownPsn} unknown PSN; ` : ''}
              {s.unknownCode ? `${s.unknownCode} unknown leave code; ` : ''}
              {s.badDate ? `${s.badDate} unreadable date; ` : ''}
              {s.dupInFile ? `${s.dupInFile} duplicate in file; ` : ''}
              these are not imported.
            </div>
          ) : null}

          {/* Balance double-count warning */}
          {adjWarn.length > 0 && (
            <div className="rounded px-3 py-2 text-xs" style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}>
              <strong>Heads-up — possible double counting:</strong> {adjWarn.length} staff have a manual
              balance adjustment noted as a prior Excel/migration entry. Once these real leave dates are
              imported, those manual adjustments should be cleared or they'll be counted twice
              ({adjWarn.slice(0, 4).map(a => `${a.name} (${a.type} ${a.year}: ${a.adjustment})`).join(', ')}{adjWarn.length > 4 ? '…' : ''}).
              <div className="mt-2">
                <button type="button" onClick={clearAdjustments} disabled={clearingAdj}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-semibold disabled:opacity-50"
                  style={{ background: '#FFFFFF', color: '#991B1B', border: '1px solid #FCA5A5' }}>
                  {clearingAdj ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  {clearingAdj ? 'Clearing…' : `Clear ${adjWarn.length} migration adjustment(s)`}
                </button>
                <span className="ml-2 opacity-70">Do this after importing.</span>
              </div>
            </div>
          )}

          <div className="max-h-72 overflow-auto rounded border border-black/10">
            <table className="w-full text-xs">
              <thead className="sticky top-0" style={{ background: '#F7F7F5' }}>
                <tr className="text-left" style={{ color: '#1F1B16' }}>
                  <th className="py-2 px-2 font-semibold">Employee</th>
                  <th className="py-2 px-2 font-semibold">Dept</th>
                  <th className="py-2 px-2 font-semibold text-right">Records</th>
                  <th className="py-2 px-2 font-semibold text-right">Days</th>
                  <th className="py-2 px-2 font-semibold">By type</th>
                </tr>
              </thead>
              <tbody>
                {plan.byEmp.map(e => {
                  const open = openEmp.has(e.psn);
                  return (
                    <React.Fragment key={e.psn}>
                      <tr className="border-t border-black/5 cursor-pointer hover:bg-black/[0.02]" onClick={() => toggleEmp(e.psn)}>
                        <td className="py-1.5 px-2">
                          <span className="inline-flex items-center gap-1">
                            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            {e.name} <span className="opacity-50">{e.psn}</span>
                          </span>
                        </td>
                        <td className="py-1.5 px-2">{e.dept || '—'}</td>
                        <td className="py-1.5 px-2 text-right">{e.rows}</td>
                        <td className="py-1.5 px-2 text-right">{Math.round(e.days * 10) / 10}</td>
                        <td className="py-1.5 px-2">{Object.entries(e.types).map(([c, d]) => `${c}:${Math.round(d * 10) / 10}`).join('  ')}</td>
                      </tr>
                      {open && (
                        <tr className="border-t border-black/5" style={{ background: '#FAFAF9' }}>
                          <td colSpan={5} className="py-2 px-2">
                            <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                              <span className="opacity-60">Leave dates taken:</span>
                              <ul className="mt-1 grid sm:grid-cols-2 gap-x-6 gap-y-0.5">
                                {e.items.map((r, i) => (
                                  <li key={i} className="flex items-start gap-1.5">
                                    <span style={{ color: ACCENT }}>•</span>
                                    <span>{fmtRange(r)}{r.reason ? <span className="opacity-50"> — {r.reason}</span> : null}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-xs" style={{ color: '#1F1B16' }}>
              {importing ? `Importing ${progress.done}/${progress.total}${progress.failed ? ` · ${progress.failed} failed` : ''}…` : 'Review above, then import.'}
            </div>
            <button type="button" onClick={runImport} disabled={importing || !plan.records}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: ACCENT }}>
              {importing ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
              {importing ? 'Importing…' : `Import ${s.records} record(s)`}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
