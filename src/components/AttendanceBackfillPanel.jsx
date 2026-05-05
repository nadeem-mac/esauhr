// =============================================================================
// AttendanceBackfillPanel.jsx
//
// Collapsible panel inside AttendanceView for one-shot historical
// backfill. Bashaier uses this once to import a multi-month xlsx
// covering the period before the daily-upload flow was active.
//
// Flow:
//   1. Click "Open backfill" — panel expands.
//   2. Choose the multi-month .xlsx file.
//   3. Panel parses, builds preview rows, runs an overwrite check.
//   4. Preview shows: total rows, employees, date range, # overlaps.
//   5. Big amber "Import" button commits the upsert in 100-row chunks
//      with a progress bar. Done state shows the total written.
//
// SAFETY
//   • Overwrite warning if any (employee, date) pair already exists
//     in attendance_daily — typical case is a backfill that overlaps
//     with the daily-flow data Bashaier has already accumulated for
//     May 5+. UI says exactly how many rows will be overwritten and
//     asks for explicit "I understand" confirmation.
//   • Status is always 'present' — the panel is upfront about this:
//     no late/short/absent evaluation, just the punch record.
//   • Status going forward (May 5 onwards) still flows through the
//     daily recorder which DOES evaluate late/short/absent — backfill
//     only fills the gaps before that.
// =============================================================================

import React, { useCallback, useState } from 'react';
import { Upload, ChevronDown, ChevronUp, AlertTriangle, CheckCircle2, Loader2, FileSpreadsheet } from 'lucide-react';
import {
  parseBackfillXlsx,
  buildBackfillRows,
  previewOverwrites,
  recordBackfillRows,
} from '../lib/attendanceBackfill.js';
import { TimeCardParseError } from '../lib/timeCard.js';

export default function AttendanceBackfillPanel({ me, employees }) {
  const [expanded, setExpanded]     = useState(false);
  const [parseErr, setParseErr]     = useState(null);
  const [preview, setPreview]       = useState(null); // { rows, summary, overwrites }
  const [parsing, setParsing]       = useState(false);
  const [importing, setImporting]   = useState(false);
  const [progress, setProgress]     = useState({ written: 0, total: 0 });
  const [done, setDone]             = useState(null);    // { written, summary }
  const [overrideWarn, setOverride] = useState(false);   // user explicitly OK with overwrites

  const reset = useCallback(() => {
    setParseErr(null);
    setPreview(null);
    setParsing(false);
    setImporting(false);
    setProgress({ written: 0, total: 0 });
    setDone(null);
    setOverride(false);
  }, []);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    reset();
    setParsing(true);
    try {
      const parsed = await parseBackfillXlsx(file);
      const built = buildBackfillRows({
        parsedRows: parsed.rows,
        employees,
        recordedBy: me?.id || null,
      });
      const overwrites = await previewOverwrites(built.rows);
      setPreview({ rows: built.rows, summary: built.summary, overwrites, fileName: file.name });
    } catch (e) {
      if (e instanceof TimeCardParseError) {
        setParseErr(e.message);
      } else {
        setParseErr(String(e?.message || e));
      }
    } finally {
      setParsing(false);
    }
  }, [employees, me?.id, reset]);

  const handleImport = useCallback(async () => {
    if (!preview?.rows?.length) return;
    if (preview.overwrites?.existingCount > 0 && !overrideWarn) return;
    setImporting(true);
    setProgress({ written: 0, total: preview.rows.length });
    try {
      const { written } = await recordBackfillRows(preview.rows, (p) => setProgress(p));
      setDone({ written, summary: preview.summary });
      setPreview(null);
    } catch (e) {
      setParseErr(`Import failed: ${e?.message || e}`);
    } finally {
      setImporting(false);
    }
  }, [preview, overrideWarn]);

  const formatDate = (iso) => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
      day: 'numeric', month: 'short', year: 'numeric'
    });
  };

  return (
    <div className="rounded-xl"
      style={{
        background: '#FFFFFF',
        border: '1px solid #E5E5E5',
        padding: 14,
      }}
    >
      {/* Header — clickable to expand/collapse */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-3"
        style={{ cursor: 'pointer', background: 'transparent', border: 'none', padding: 0 }}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-full flex items-center justify-center"
            style={{ background: '#FEF3C7', color: '#854F0B' }}>
            <FileSpreadsheet className="w-4.5 h-4.5" />
          </div>
          <div className="text-left">
            <div className="text-[10px] tracking-wider"
              style={{ color: '#0A0A0A', fontWeight: 700, letterSpacing: '0.2em' }}>
              ONE-SHOT
            </div>
            <div style={{ fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif', fontSize: 14, fontWeight: 700, color: '#0A0A0A' }}>
              Historical attendance backfill
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              Import a multi-month xlsx to populate the calendar for periods before daily uploads were active.
            </div>
          </div>
        </div>
        {expanded
          ? <ChevronUp className="w-4 h-4 flex-shrink-0" style={{ color: '#0A0A0A', opacity: 0.6 }} />
          : <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: '#0A0A0A', opacity: 0.6 }} />
        }
      </button>

      {expanded && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid #F0F0F0' }}>
          {/* Done state */}
          {done && (
            <div className="rounded-lg p-3 mb-3 flex items-start gap-3"
              style={{ background: '#ECFDF5', border: '1px solid #A7F3D0' }}>
              <CheckCircle2 className="w-5 h-5 flex-shrink-0" style={{ color: '#0F4C2A' }} />
              <div>
                <div style={{ fontWeight: 700, color: '#0F4C2A' }}>
                  Import complete
                </div>
                <div className="text-[12px] mt-1" style={{ color: '#0F4C2A' }}>
                  {done.written} attendance row{done.written === 1 ? '' : 's'} written for {done.summary.employees.size} employee{done.summary.employees.size === 1 ? '' : 's'} from {formatDate(done.summary.minDate)} to {formatDate(done.summary.maxDate)}.
                  The Monthly Attendance calendar above has refreshed.
                </div>
                <button onClick={reset}
                  className="text-[11px] mt-2 px-3 py-1 rounded-full"
                  style={{ background: '#FFFFFF', color: '#0F4C2A', border: '1px solid #0F4C2A', fontWeight: 600 }}>
                  Import another file
                </button>
              </div>
            </div>
          )}

          {/* Error */}
          {parseErr && (
            <div className="rounded-lg p-3 mb-3 flex items-start gap-3"
              style={{ background: '#FEF2F2', border: '1px solid #FCA5A5' }}>
              <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: '#991B1B' }} />
              <div className="text-[12px]" style={{ color: '#991B1B' }}>
                {parseErr}
              </div>
            </div>
          )}

          {/* File chooser — hidden when preview/done is shown to keep
              the flow linear */}
          {!preview && !done && (
            <div>
              <label
                className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-[13px] cursor-pointer"
                style={{
                  background: parsing ? '#F5F5F5' : '#0F4C2A',
                  color: parsing ? '#737373' : '#FFFFFF',
                  fontWeight: 600,
                  cursor: parsing ? 'wait' : 'pointer',
                }}
              >
                {parsing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                {parsing ? 'Parsing…' : 'Choose backfill xlsx file'}
                <input
                  type="file"
                  accept=".xlsx"
                  className="sr-only"
                  disabled={parsing}
                  onChange={(e) => handleFile(e.target.files?.[0])}
                />
              </label>
              <div className="text-[11px] mt-2" style={{ color: '#0A0A0A', opacity: 0.7, maxWidth: 560 }}>
                Use the same Time Card xlsx format as the daily upload, but with a longer date range. The importer will write one <code style={{ background: '#F5F5F5', padding: '0 4px', borderRadius: 3 }}>present</code> row per (employee, date) with punches. Late/short/absent evaluation isn't possible for historical dates without shift data — going forward (from when daily uploads start) the proper evaluation continues to apply.
              </div>
            </div>
          )}

          {/* Preview + confirm */}
          {preview && !importing && (
            <div className="space-y-3">
              <div className="rounded-lg p-3" style={{ background: '#F8FAFC', border: '1px solid #CBD5E1' }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: '#0A0A0A' }}>
                  Preview — {preview.fileName}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2 text-[12px]" style={{ color: '#0A0A0A' }}>
                  <div><span style={{ opacity: 0.65 }}>Rows to write:</span> <strong>{preview.summary.rows}</strong></div>
                  <div><span style={{ opacity: 0.65 }}>Employees:</span> <strong>{preview.summary.employees.size}</strong></div>
                  <div><span style={{ opacity: 0.65 }}>Date range:</span> <strong>{formatDate(preview.summary.minDate)} — {formatDate(preview.summary.maxDate)}</strong></div>
                  <div><span style={{ opacity: 0.65 }}>Skipped (no punches):</span> <strong>{preview.summary.skipped}</strong></div>
                  {preview.summary.unmatched > 0 && (
                    <div className="col-span-2"><span style={{ opacity: 0.65 }}>Unmatched PSNs (recorded as-is):</span> <strong>{preview.summary.unmatched}</strong></div>
                  )}
                </div>
              </div>

              {/* Overwrite warning */}
              {preview.overwrites.existingCount > 0 && (
                <div className="rounded-lg p-3" style={{ background: '#FFFBEB', border: '1px solid #FCD34D' }}>
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#854F0B' }} />
                    <div className="text-[12px]" style={{ color: '#854F0B' }}>
                      <strong>{preview.overwrites.existingCount} existing row{preview.overwrites.existingCount === 1 ? '' : 's'} will be overwritten.</strong>
                      {' '}Backfill rows are <code style={{ background: '#FFFFFF', padding: '0 4px', borderRadius: 3 }}>status='present'</code> with no late/short evaluation. If any of these dates already have evaluated rows from daily uploads, those evaluations will be lost.
                      <div className="mt-2">
                        <label className="inline-flex items-center gap-1.5 cursor-pointer">
                          <input type="checkbox"
                            checked={overrideWarn}
                            onChange={(e) => setOverride(e.target.checked)} />
                          <span>I understand and want to proceed.</span>
                        </label>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={handleImport}
                  disabled={preview.summary.rows === 0 || (preview.overwrites.existingCount > 0 && !overrideWarn)}
                  className="px-4 py-2 rounded-full inline-flex items-center gap-1.5 text-[13px]"
                  style={{
                    background: (preview.summary.rows === 0 || (preview.overwrites.existingCount > 0 && !overrideWarn)) ? '#E5E5E5' : '#0F4C2A',
                    color:      (preview.summary.rows === 0 || (preview.overwrites.existingCount > 0 && !overrideWarn)) ? '#737373' : '#FFFFFF',
                    fontWeight: 600,
                    cursor:     (preview.summary.rows === 0 || (preview.overwrites.existingCount > 0 && !overrideWarn)) ? 'not-allowed' : 'pointer',
                    border: 'none',
                  }}>
                  <Upload className="w-4 h-4" />
                  Import {preview.summary.rows} row{preview.summary.rows === 1 ? '' : 's'}
                </button>
                <button onClick={reset}
                  className="px-3 py-2 rounded-full text-[12px]"
                  style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #E5E5E5', fontWeight: 500 }}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Importing — progress bar */}
          {importing && (
            <div className="space-y-2">
              <div className="text-[12px]" style={{ color: '#0A0A0A' }}>
                <Loader2 className="w-4 h-4 inline-block mr-2 animate-spin" />
                Writing {progress.written} of {progress.total} rows…
              </div>
              <div className="h-2 rounded-full" style={{ background: '#F5F5F5' }}>
                <div className="h-full rounded-full" style={{
                  background: '#0F4C2A',
                  width: progress.total > 0 ? `${(progress.written / progress.total) * 100}%` : '0%',
                  transition: 'width 0.2s',
                }} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
