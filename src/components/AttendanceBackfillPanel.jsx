// =============================================================================
// AttendanceBackfillPanel.jsx
//
// One-shot historical backfill UI inside AttendanceView's Zone 3.
// Bashaier uses this once to import months of attendance that
// predate the daily-flow rollout, then never touches it again.
//
// VISUAL DESIGN
//   The panel is the most "decorative" element of the Attendance page
//   on purpose — it's the rare, optional flow, so it benefits from
//   pulling visual weight to itself when expanded. Subtle gradients,
//   spring animations, and confident typography differentiate it
//   from the more transactional daily-upload area above.
//
// FLOW STATES
//   1. Collapsed (default)
//        Compact header card. Click to expand. Icon pulses gently to
//        suggest interactivity.
//   2. Expanded — empty
//        Large dashed dropzone-style file picker with hover lift.
//   3. Parsing
//        Spinner over the picker.
//   4. Preview
//        Three stat tiles (rows, staff, date range) bouncing in with
//        staggered delays. Optional overwrite warning. Big import
//        button + Cancel.
//   5. Importing
//        Progress bar with shimmer animation, count + percentage.
//   6. Done
//        Green pop-in confirmation with spring scale entrance.
//
// IMPLEMENTATION
//   All animations are CSS keyframes inlined into the component so
//   there's no global stylesheet coupling. State transitions use
//   `key` props on animated nodes to force re-mount and replay the
//   animation each time the state advances.
// =============================================================================

import React, { useCallback, useState } from 'react';
import {
  Upload, ChevronDown, AlertTriangle, CheckCircle2, Loader2,
  FileSpreadsheet, Calendar, Users, Layers, RefreshCw, Sparkles,
} from 'lucide-react';
import {
  parseBackfillXlsx,
  buildBackfillRows,
  previewOverwrites,
  recordBackfillRows,
  fetchShiftEmployeeIds,
  fetchMawaniDays,
  reevaluateBackfillRows,
} from '../lib/attendanceBackfill.js';
import { TimeCardParseError } from '../lib/timeCard.js';

// ─── Inline keyframes ────────────────────────────────────────────────
// Plain ease transitions — bounces removed per Nadeem's feedback.
//   backfill-fade-in  — small upward slide + opacity
//   backfill-shimmer  — moving sheen across the active progress bar
const ANIM_CSS = `
@keyframes backfill-fade-in {
  0%   { opacity: 0; transform: translateY(2px); }
  100% { opacity: 1; transform: translateY(0); }
}
@keyframes backfill-shimmer {
  0%   { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
`;

export default function AttendanceBackfillPanel({ me, employees, embedded = false }) {
  // When embedded inside the AttendanceView sidebar layout the panel
  // is always "open" — there's no point in collapsing it since the
  // user already chose to navigate here. The header chrome (decorative
  // gradient + chevron) is also stripped in embed mode.
  const [expanded, setExpanded]     = useState(embedded);
  const [parseErr, setParseErr]     = useState(null);
  const [preview, setPreview]       = useState(null);
  const [parsing, setParsing]       = useState(false);
  const [importing, setImporting]   = useState(false);
  const [progress, setProgress]     = useState({ written: 0, total: 0 });
  const [done, setDone]             = useState(null);
  const [overrideWarn, setOverride] = useState(false);

  // Re-evaluation flow — separate state so it doesn't conflict with
  // the file-import flow. The user can run this without uploading
  // anything to re-classify rows that were imported before the
  // late/short evaluation logic existed.
  const [reevaluating, setReevaluating] = useState(false);
  const [reevalProgress, setReevalProgress] = useState({ phase: '', processed: 0, total: 0 });
  const [reevalDone, setReevalDone] = useState(null);

  const reset = useCallback(() => {
    setParseErr(null);
    setPreview(null);
    setParsing(false);
    setImporting(false);
    setProgress({ written: 0, total: 0 });
    setDone(null);
    setOverride(false);
    setReevaluating(false);
    setReevalProgress({ phase: '', processed: 0, total: 0 });
    setReevalDone(null);
  }, []);

  const handleReevaluate = useCallback(async () => {
    setReevaluating(true);
    setReevalDone(null);
    setReevalProgress({ phase: 'starting', processed: 0, total: 0 });
    try {
      const result = await reevaluateBackfillRows(
        (p) => setReevalProgress(p),
        { employees }
      );
      setReevalDone(result);
    } catch (e) {
      setParseErr(`Re-evaluation failed: ${e?.message || e}`);
    } finally {
      setReevaluating(false);
    }
  }, [employees]);

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    reset();
    setParsing(true);
    try {
      const parsedFile = await parseBackfillXlsx(file);
      // Fetch shift-worker IDs + Mawani-visit days in parallel with
      // parsing — both are quick queries. Used by buildBackfillRows
      // to apply the right policy per employee/date.
      const [shiftEmployeeIds, mawaniDays] = await Promise.all([
        fetchShiftEmployeeIds(),
        fetchMawaniDays(),
      ]);
      const built = buildBackfillRows({
        parsedRows: parsedFile.rows,
        employees,
        recordedBy: me?.id || null,
        shiftEmployeeIds,
        mawaniDays,
      });
      const overwrites = await previewOverwrites(built.rows);
      setPreview({ rows: built.rows, summary: built.summary, overwrites, fileName: file.name });
    } catch (e) {
      setParseErr(e instanceof TimeCardParseError ? e.message : String(e?.message || e));
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
      day: 'numeric', month: 'short', year: 'numeric',
    });
  };

  const pct = progress.total > 0 ? Math.round((progress.written / progress.total) * 100) : 0;

  // Determine which sub-state to render so each one can have its
  // own `key` for animation replay. Order matters: error > done >
  // importing > preview > parsing > re-evaluating > re-eval done > empty.
  const subState = parseErr      ? 'error'
                : done           ? 'done'
                : importing      ? 'importing'
                : preview        ? 'preview'
                : parsing        ? 'parsing'
                : reevaluating   ? 'reevaluating'
                : reevalDone     ? 'reeval-done'
                : 'empty';

  return (
    <div
      className="rounded-2xl overflow-hidden relative"
      style={{
        // Embedded mode: plain white card matching the rest of the
        // sidebar-driven layout. Standalone mode keeps the warm
        // gradient as a one-shot visual cue.
        background: embedded
          ? '#FFFFFF'
          : 'linear-gradient(135deg, #FFFBEB 0%, #FFF7E0 100%)',
        border: '1px solid ' + (embedded ? '#E5E5E5' : '#FCD34D'),
        boxShadow: embedded
          ? 'none'
          : (expanded ? '0 8px 24px rgba(133, 79, 11, 0.12)' : '0 1px 2px rgba(0,0,0,0.04)'),
        transition: 'box-shadow 0.2s ease',
        fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
      }}
    >
      {/* Embed keyframes locally so the component is self-contained. */}
      <style>{ANIM_CSS}</style>

      {/* Decorative corner blur — only in standalone mode. */}
      {!embedded && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            right: -40, top: -40,
            width: 160, height: 160,
            background: 'radial-gradient(circle at center, rgba(252,211,77,0.35) 0%, transparent 70%)',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      )}

      {/* Header — clickable to expand/collapse. Hidden in embed mode
          (the sidebar already provides the section heading). */}
      {!embedded && (
        <button
          onClick={() => setExpanded(v => !v)}
          className="w-full flex items-center justify-between gap-3 relative"
          style={{
            cursor: 'pointer', background: 'transparent', border: 'none',
            padding: '16px 18px', textAlign: 'left', zIndex: 1,
            fontFamily: 'inherit',
          }}
          aria-expanded={expanded}
        >
          <div className="flex items-center gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{
                background: '#FCD34D',
                color: '#854F0B',
              }}
            >
              <FileSpreadsheet className="w-5 h-5" />
            </div>
            <div>
              <div
                className="text-[10px]"
                style={{ color: '#854F0B', fontWeight: 700, letterSpacing: '0.22em' }}
              >
                ONE-SHOT
              </div>
              <div
                style={{
                  fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
                  fontSize: 18,
                  color: '#1F1B16',
                  lineHeight: 1.2,
                  fontWeight: 700,
                }}
              >
                Historical backfill
              </div>
              <div className="text-[12px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                Import a multi-month xlsx to populate the calendar for periods before daily uploads were active.
              </div>
            </div>
          </div>
          <ChevronDown
            className="w-5 h-5 flex-shrink-0"
            style={{
              color: '#854F0B',
              transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s ease',
            }}
          />
        </button>
      )}

      {/* Embedded heading — short, no chevron, sits above the body */}
      {embedded && (
        <div style={{ padding: '16px 18px 0' }}>
          <div className="text-[10px]" style={{ color: '#854F0B', fontWeight: 700, letterSpacing: '0.22em' }}>
            ONE-SHOT
          </div>
          <div
            style={{
              fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
              fontSize: 18,
              color: '#1F1B16',
              lineHeight: 1.2,
              fontWeight: 700,
              marginTop: 2,
            }}
          >
            Historical backfill
          </div>
          <div className="text-[12px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            Import a multi-month xlsx to populate the calendar for periods before daily uploads were active.
          </div>
        </div>
      )}

      {/* Expanded body */}
      {expanded && (
        <div
          style={{
            position: 'relative', zIndex: 1,
            padding: '4px 18px 18px',
            borderTop: '1px solid rgba(252,211,77,0.5)',
            animation: 'backfill-fade-in 0.5s ease-out',
          }}
        >
          {/* ── EMPTY STATE — File picker + re-evaluate action ────── */}
          {subState === 'empty' && (
            <div
              key="empty"
              style={{
                animation: 'backfill-fade-in 0.45s ease-out',
                paddingTop: 14,
              }}
            >
              <FilePickerHero onFile={handleFile} />
              <div
                className="text-[11px] mt-3"
                style={{ color: '#0A0A0A', opacity: 0.7, maxWidth: 600, lineHeight: 1.55 }}
              >
                Same Time Card xlsx format as the daily upload, but covering a longer date range.
                Office staff are evaluated against standard 08:00&ndash;17:00 office hours
                (15-min grace). Shift workers (with saved schedules) and KSA weekend punches
                are recorded as &lsquo;present&rsquo; without late/short evaluation since their
                historical schedules aren&rsquo;t recoverable.
              </div>

              {/* Divider with label */}
              <div className="flex items-center gap-3 my-4">
                <div style={{ flex: 1, height: 1, background: 'rgba(252,211,77,0.5)' }} />
                <span className="text-[10px]" style={{ color: '#854F0B', fontWeight: 700, letterSpacing: '0.22em' }}>
                  OR
                </span>
                <div style={{ flex: 1, height: 1, background: 'rgba(252,211,77,0.5)' }} />
              </div>

              {/* Re-evaluate card — secondary action for already-imported rows.
                  This is the "I've already imported, just re-classify" path —
                  no file required, no overwrite warning, just runs the eval
                  against existing source='backfill' rows in-place. */}
              <ReevaluateCard onClick={handleReevaluate} />
            </div>
          )}

          {/* ── RE-EVALUATING STATE ─────────────────────────────────── */}
          {subState === 'reevaluating' && (
            <div
              key="reevaluating"
              className="space-y-3 py-2"
              style={{ animation: 'backfill-fade-in 0.4s ease-out' }}
            >
              <div className="inline-flex items-center gap-2" style={{ color: '#854F0B' }}>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span style={{ fontSize: 13, fontWeight: 700 }}>
                  {reevalProgress.phase === 'shifts'   ? 'Identifying shift workers\u2026' :
                   reevalProgress.phase === 'fetching' ? 'Loading existing rows\u2026' :
                   reevalProgress.phase === 'writing'  ? 'Updating classifications\u2026' :
                   'Working\u2026'}
                </span>
              </div>
              {reevalProgress.phase === 'writing' && reevalProgress.total > 0 && (
                <>
                  <div className="relative h-2.5 rounded-full overflow-hidden" style={{ background: 'rgba(133, 79, 11, 0.12)' }}>
                    <div
                      className="absolute left-0 top-0 h-full rounded-full"
                      style={{
                        background: 'linear-gradient(90deg, #FCD34D 0%, #F59E0B 100%)',
                        width: `${Math.round((reevalProgress.processed / reevalProgress.total) * 100)}%`,
                        transition: 'width 0.3s cubic-bezier(0.4, 0.0, 0.2, 1)',
                      }}
                    />
                    <div
                      aria-hidden
                      className="absolute top-0 left-0 h-full"
                      style={{
                        width: '40%',
                        background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)',
                        animation: 'backfill-shimmer 1.6s linear infinite',
                      }}
                    />
                  </div>
                  <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                    {reevalProgress.processed.toLocaleString()} of {reevalProgress.total.toLocaleString()} rows
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── RE-EVAL DONE STATE ─────────────────────────────────── */}
          {subState === 'reeval-done' && (
            <div
              key="reeval-done"
              className="rounded-xl p-4"
              style={{
                background: '#FFFFFF',
                border: '1.5px solid #10B981',
                animation: 'backfill-fade-in 0.6s ease-out',
              }}
            >
              <div className="flex items-start gap-3">
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: '#10B981', color: '#FFFFFF' }}
                >
                  <CheckCircle2 className="w-7 h-7" />
                </div>
                <div className="flex-1 min-w-0">
                  <div
                    style={{
                      fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
                      fontSize: 19, color: '#065F46', lineHeight: 1.15, fontWeight: 700,
                    }}
                  >
                    Re-evaluation complete
                  </div>
                  <div className="text-[12px] mt-1" style={{ color: '#065F46', lineHeight: 1.55 }}>
                    Scanned <strong>{reevalDone.scanned.toLocaleString()}</strong> backfilled row{reevalDone.scanned === 1 ? '' : 's'}.{' '}
                    {reevalDone.changed > 0 ? (
                      <>Updated <strong>{reevalDone.changed.toLocaleString()}</strong> row{reevalDone.changed === 1 ? '' : 's'} with new classifications.</>
                    ) : (
                      <>No rows changed &mdash; everything already matches the current rules.</>
                    )}
                  </div>
                  {/* Breakdown chips — gives Bashaier the late count
                      she's been waiting to see */}
                  <div className="flex flex-wrap gap-2 mt-2.5">
                    <EvalChip bg="#ECFDF5" fg="#0F4C2A" border="#A7F3D0" label="Present" count={reevalDone.presentCount} />
                    {reevalDone.lateCount > 0 && (
                      <EvalChip bg="#FEF3C7" fg="#854F0B" border="#FCD34D" label="Late" count={reevalDone.lateCount} />
                    )}
                    {reevalDone.shortCount > 0 && (
                      <EvalChip bg="#FED7AA" fg="#7C2D12" border="#FB923C" label="Left early" count={reevalDone.shortCount} />
                    )}
                  </div>
                  <button
                    onClick={reset}
                    className="text-[11px] mt-3 px-3 py-1.5 rounded-full transition-all"
                    style={{
                      background: '#FFFFFF', color: '#065F46',
                      border: '1.5px solid #10B981', fontWeight: 700, cursor: 'pointer',
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.background = '#ECFDF5'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.background = '#FFFFFF'; }}
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── PARSING STATE ─────────────────────────────────────── */}
          {subState === 'parsing' && (
            <div
              key="parsing"
              className="flex items-center gap-3 py-6 justify-center"
              style={{
                animation: 'backfill-fade-in 0.4s ease-out',
                color: '#854F0B',
              }}
            >
              <Loader2 className="w-5 h-5 animate-spin" />
              <span style={{ fontSize: 14, fontWeight: 600 }}>Reading the file…</span>
            </div>
          )}

          {/* ── PREVIEW STATE ─────────────────────────────────────── */}
          {subState === 'preview' && (
            <div
              key="preview"
              className="space-y-3"
              style={{ animation: 'backfill-fade-in 0.45s ease-out' }}
            >
              <div
                className="text-[11px] mb-1 inline-flex items-center gap-1.5"
                style={{ color: '#854F0B', fontWeight: 700, letterSpacing: '0.18em' }}
              >
                READY · {preview.fileName}
              </div>

              {/* Three stat tiles, staggered */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <StatTile
                  delay={0}
                  icon={<Layers className="w-4 h-4" />}
                  label="Rows to write"
                  value={preview.summary.rows.toLocaleString()}
                />
                <StatTile
                  delay={80}
                  icon={<Users className="w-4 h-4" />}
                  label="Employees"
                  value={preview.summary.employees.size}
                />
                <StatTile
                  delay={160}
                  icon={<Calendar className="w-4 h-4" />}
                  label="Date range"
                  value={
                    <span style={{ fontSize: 13, fontWeight: 700 }}>
                      {formatDate(preview.summary.minDate)}<br/>
                      <span style={{ opacity: 0.55, fontWeight: 500, fontSize: 11 }}>to</span><br/>
                      {formatDate(preview.summary.maxDate)}
                    </span>
                  }
                />
              </div>

              {/* Evaluation breakdown — shows the late/short/present
                  split before commit so the user knows what to expect
                  in the calendar. Mirrors the daily flow's evaluation
                  rules so backfilled office staff get classified the
                  same way they would by a daily upload of the same
                  schedule. */}
              {(preview.summary.lateCount > 0 || preview.summary.shortCount > 0 ||
                preview.summary.presentCount > 0 || preview.summary.missedInCount > 0 ||
                preview.summary.missedOutCount > 0 || preview.summary.mawaniDayCount > 0) && (
                <div className="flex flex-wrap gap-2 mt-1">
                  {preview.summary.presentCount > 0 && (
                    <EvalChip
                      bg="#ECFDF5" fg="#0F4C2A" border="#A7F3D0"
                      label="Present"
                      count={preview.summary.presentCount}
                    />
                  )}
                  {preview.summary.lateCount > 0 && (
                    <EvalChip
                      bg="#FEF3C7" fg="#854F0B" border="#FCD34D"
                      label="Late"
                      count={preview.summary.lateCount}
                    />
                  )}
                  {preview.summary.shortCount > 0 && (
                    <EvalChip
                      bg="#FED7AA" fg="#7C2D12" border="#FB923C"
                      label="Left early"
                      count={preview.summary.shortCount}
                    />
                  )}
                  {preview.summary.missedInCount > 0 && (
                    <EvalChip
                      bg="#FCE7F3" fg="#86198F" border="#F0ABFC"
                      label="No clock-in"
                      count={preview.summary.missedInCount}
                    />
                  )}
                  {preview.summary.missedOutCount > 0 && (
                    <EvalChip
                      bg="#E0E7FF" fg="#3730A3" border="#A5B4FC"
                      label="No clock-out"
                      count={preview.summary.missedOutCount}
                    />
                  )}
                  {preview.summary.mawaniDayCount > 0 && (
                    <EvalChip
                      bg="#CCFBF1" fg="#115E59" border="#5EEAD4"
                      label="Mawani duty"
                      count={preview.summary.mawaniDayCount}
                    />
                  )}
                </div>
              )}

              {/* Skipped + unmatched secondary numbers */}
              {(preview.summary.skipped > 0 || preview.summary.unmatched > 0 || preview.summary.shiftWorkerSkipped > 0) && (
                <div className="flex flex-wrap gap-3 text-[11px]" style={{ color: '#0A0A0A', opacity: 0.65 }}>
                  {preview.summary.skipped > 0 && (
                    <span>{preview.summary.skipped} row{preview.summary.skipped === 1 ? '' : 's'} skipped (no punches)</span>
                  )}
                  {preview.summary.unmatched > 0 && (
                    <span>{preview.summary.unmatched} unmatched PSN{preview.summary.unmatched === 1 ? '' : 's'} (recorded as-is)</span>
                  )}
                  {preview.summary.shiftWorkerSkipped > 0 && (
                    <span title="Shift workers' historical schedules aren't available — left as 'present' without late/short evaluation">
                      {preview.summary.shiftWorkerSkipped} shift-worker row{preview.summary.shiftWorkerSkipped === 1 ? '' : 's'} not evaluated
                    </span>
                  )}
                </div>
              )}

              {/* Overwrite warning */}
              {preview.overwrites.existingCount > 0 && (
                <div
                  className="rounded-xl p-3.5"
                  style={{
                    background: '#FEF3C7',
                    border: '1.5px solid #F59E0B',
                    animation: 'backfill-fade-in 0.45s ease-out',
                  }}
                >
                  <div className="flex items-start gap-2.5">
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#92400E' }} />
                    <div className="text-[12px]" style={{ color: '#7C2D12', lineHeight: 1.55 }}>
                      <strong>{preview.overwrites.existingCount}</strong> existing row{preview.overwrites.existingCount === 1 ? '' : 's'} will be overwritten with the freshly-evaluated backfill version.
                      Backfill applies the full late/short rules, missed-punch detection, SUP-team hours, and Mawani-visit handling &mdash;
                      same logic as the daily flow. The two should usually agree, but any manual edits to the existing rows will be lost.
                      <label className="inline-flex items-center gap-2 cursor-pointer mt-2.5">
                        <input
                          type="checkbox"
                          checked={overrideWarn}
                          onChange={(e) => setOverride(e.target.checked)}
                          style={{ accentColor: '#92400E' }}
                        />
                        <span style={{ fontWeight: 600 }}>I understand and want to proceed.</span>
                      </label>
                    </div>
                  </div>
                </div>
              )}

              {/* Action row */}
              <div className="flex items-center gap-2 flex-wrap pt-1">
                <ImportButton
                  disabled={preview.summary.rows === 0 || (preview.overwrites.existingCount > 0 && !overrideWarn)}
                  onClick={handleImport}
                  count={preview.summary.rows}
                />
                <button
                  onClick={reset}
                  className="px-4 py-2.5 rounded-full text-[12px] transition-all"
                  style={{
                    background: 'rgba(255,255,255,0.6)',
                    color: '#0A0A0A',
                    border: '1px solid rgba(0,0,0,0.1)',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = '#FFFFFF'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.6)'}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* ── IMPORTING STATE ─────────────────────────────────────── */}
          {subState === 'importing' && (
            <div
              key="importing"
              className="space-y-3 py-2"
              style={{ animation: 'backfill-fade-in 0.4s ease-out' }}
            >
              <div className="flex items-baseline justify-between">
                <div className="inline-flex items-center gap-2" style={{ color: '#854F0B' }}>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span style={{ fontSize: 13, fontWeight: 700 }}>Writing rows…</span>
                </div>
                <div style={{ color: '#1F1B16' }}>
                  <span style={{ fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 700 }}>{pct}</span>
                  <span style={{ fontSize: 13, opacity: 0.55, marginLeft: 2 }}>%</span>
                </div>
              </div>

              {/* Progress bar with shimmer */}
              <div
                className="relative h-2.5 rounded-full overflow-hidden"
                style={{ background: 'rgba(133, 79, 11, 0.12)' }}
              >
                <div
                  className="absolute left-0 top-0 h-full rounded-full"
                  style={{
                    background: 'linear-gradient(90deg, #FCD34D 0%, #F59E0B 100%)',
                    width: `${pct}%`,
                    transition: 'width 0.3s cubic-bezier(0.4, 0.0, 0.2, 1)',
                  }}
                />
                <div
                  aria-hidden
                  className="absolute top-0 left-0 h-full"
                  style={{
                    width: '40%',
                    background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.5) 50%, transparent 100%)',
                    animation: 'backfill-shimmer 1.6s linear infinite',
                  }}
                />
              </div>

              <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                {progress.written.toLocaleString()} of {progress.total.toLocaleString()} rows
              </div>
            </div>
          )}

          {/* ── DONE STATE ────────────────────────────────────────── */}
          {subState === 'done' && (
            <div
              key="done"
              className="rounded-xl p-4 flex items-start gap-3"
              style={{
                background: '#FFFFFF',
                border: '1.5px solid #10B981',
                animation: 'backfill-fade-in 0.6s ease-out',
              }}
            >
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: '#10B981', color: '#FFFFFF' }}
              >
                <CheckCircle2 className="w-7 h-7" />
              </div>
              <div className="flex-1 min-w-0">
                <div
                  style={{
                    fontFamily: 'Georgia, serif', fontSize: 20, color: '#065F46',
                    lineHeight: 1.15, fontWeight: 700,
                  }}
                >
                  Import complete
                </div>
                <div className="text-[12px] mt-1" style={{ color: '#065F46', lineHeight: 1.55 }}>
                  <strong>{done.written.toLocaleString()}</strong> attendance row{done.written === 1 ? '' : 's'} written for{' '}
                  <strong>{done.summary.employees.size}</strong> employee{done.summary.employees.size === 1 ? '' : 's'} from{' '}
                  <strong>{formatDate(done.summary.minDate)}</strong> to{' '}
                  <strong>{formatDate(done.summary.maxDate)}</strong>. The Monthly Overview above has refreshed.
                </div>
                <button
                  onClick={reset}
                  className="text-[11px] mt-2.5 px-3 py-1.5 rounded-full transition-all"
                  style={{
                    background: '#FFFFFF', color: '#065F46',
                    border: '1.5px solid #10B981', fontWeight: 700, cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = '#ECFDF5'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#FFFFFF'; }}
                >
                  Import another file
                </button>
              </div>
            </div>
          )}

          {/* ── ERROR STATE ──────────────────────────────────────── */}
          {subState === 'error' && (
            <div
              key="error"
              className="rounded-xl p-3.5 flex items-start gap-3"
              style={{
                background: '#FEF2F2',
                border: '1.5px solid #FCA5A5',
                animation: 'backfill-fade-in 0.4s ease-out',
              }}
            >
              <AlertTriangle className="w-5 h-5 flex-shrink-0" style={{ color: '#991B1B', marginTop: 2 }} />
              <div className="flex-1">
                <div
                  className="text-[11px]"
                  style={{ color: '#991B1B', fontWeight: 700, letterSpacing: '0.16em' }}
                >
                  IMPORT FAILED
                </div>
                <div className="text-[12px] mt-1" style={{ color: '#991B1B' }}>
                  {parseErr}
                </div>
                <button
                  onClick={reset}
                  className="text-[11px] mt-2 px-3 py-1 rounded-full"
                  style={{
                    background: '#991B1B', color: '#FFFFFF',
                    border: 'none', fontWeight: 600, cursor: 'pointer',
                  }}
                >
                  Start over
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── FilePickerHero ───────────────────────────────────────────────────
// Big, inviting drop-target style file input. Hovering lifts the whole
// thing slightly and brightens the gradient — the goal is for Bashaier
// to feel "I can drop something here."
function FilePickerHero({ onFile }) {
  const [hover, setHover] = useState(false);
  const [dragOver, setDrag] = useState(false);
  const onDrop = (e) => {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) onFile(f);
  };
  return (
    <label
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={onDrop}
      className="relative block rounded-2xl text-center cursor-pointer"
      style={{
        background: dragOver
          ? '#FFFFFF'
          : 'linear-gradient(180deg, rgba(255,255,255,0.85) 0%, rgba(255,251,235,0.6) 100%)',
        border: '2px dashed ' + (dragOver ? '#10B981' : (hover ? '#F59E0B' : '#FCD34D')),
        padding: '26px 18px',
        transform: (hover || dragOver) ? 'translateY(-2px)' : 'translateY(0)',
        boxShadow: (hover || dragOver) ? '0 6px 18px rgba(133,79,11,0.15)' : 'none',
        transition: 'transform 0.25s ease-out, box-shadow 0.25s ease, border-color 0.2s ease, background 0.2s ease',
      }}
    >
      <div
        className="w-14 h-14 rounded-full mx-auto flex items-center justify-center"
        style={{
          background: dragOver ? '#ECFDF5' : '#FCD34D',
          color: dragOver ? '#065F46' : '#854F0B',
          transition: 'all 0.2s ease',
          transform: hover && !dragOver ? 'rotate(-6deg)' : 'rotate(0deg)',
        }}
      >
        <Upload className="w-6 h-6" />
      </div>
      <div
        className="mt-3"
        style={{
          fontFamily: 'Georgia, serif',
          fontSize: 17,
          color: '#1F1B16',
          lineHeight: 1.2,
        }}
      >
        {dragOver ? 'Drop to upload' : 'Choose backfill xlsx file'}
      </div>
      <div className="text-[12px] mt-1" style={{ color: '#0A0A0A', opacity: 0.65 }}>
        or drag &amp; drop here
      </div>
      <input
        type="file"
        accept=".xlsx"
        className="sr-only"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />
    </label>
  );
}

// ─── StatTile ─────────────────────────────────────────────────────────
// Bordered tile with icon + label + big serif value. Staggered into
// view via the `delay` prop so the three tiles feel like they're
// arriving one after another.
function StatTile({ icon, label, value, delay = 0 }) {
  return (
    <div
      className="rounded-xl p-3"
      style={{
        background: '#FFFFFF',
        border: '1px solid rgba(133,79,11,0.18)',
        animation: `backfill-fade-in 0.55s ease-out ${delay}ms both`,
      }}
    >
      <div className="inline-flex items-center gap-1.5 text-[10px]" style={{ color: '#854F0B', fontWeight: 700, letterSpacing: '0.18em' }}>
        <span style={{ opacity: 0.85 }}>{icon}</span>
        {label.toUpperCase()}
      </div>
      <div
        style={{
          fontFamily: 'Georgia, serif',
          fontSize: 28,
          color: '#1F1B16',
          marginTop: 4,
          lineHeight: 1.1,
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
    </div>
  );
}

// ─── ImportButton ─────────────────────────────────────────────────────
// Primary CTA. Has its own hover lift + the count is rendered with
// tabular numerics so the digits don't shift on width.
function ImportButton({ disabled, onClick, count }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="px-5 py-2.5 rounded-full inline-flex items-center gap-2 text-[13px]"
      style={{
        background: disabled ? '#E5E5E5' : (hover ? '#0F4C2A' : '#137A41'),
        color: disabled ? '#737373' : '#FFFFFF',
        fontWeight: 700,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: 'none',
        boxShadow: disabled
          ? 'none'
          : (hover ? '0 6px 16px rgba(15,76,42,0.28)' : '0 2px 6px rgba(15,76,42,0.18)'),
        transform: (!disabled && hover) ? 'translateY(-1px)' : 'translateY(0)',
        transition: 'all 0.2s ease-out',
      }}
    >
      <Upload className="w-4 h-4" />
      Import <span style={{ fontVariantNumeric: 'tabular-nums' }}>{count.toLocaleString()}</span> row{count === 1 ? '' : 's'}
    </button>
  );
}

// ─── EvalChip ────────────────────────────────────────────────────────
// Small status-colored pill used in the preview to show the late/
// short/present breakdown before commit. Same palette as the
// AttendanceMonthGrid chips so the visual language stays consistent.
function EvalChip({ bg, fg, border, label, count }) {
  return (
    <span
      style={{
        background: bg,
        color: fg,
        border: `1px solid ${border}`,
        fontSize: 11,
        padding: '3px 9px',
        borderRadius: 999,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        animation: 'backfill-fade-in 0.45s ease-out both',
      }}
    >
      {label}: <span style={{ fontVariantNumeric: 'tabular-nums' }}>{count.toLocaleString()}</span>
    </span>
  );
}

// ─── ReevaluateCard ───────────────────────────────────────────────────
// Secondary action shown in the empty state. Re-runs the late/short
// evaluation against existing source='backfill' rows in attendance_daily
// without requiring a re-upload. Useful when the eval rules changed
// after the initial import (which is exactly what happened here).
function ReevaluateCard({ onClick }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="w-full text-left rounded-xl flex items-start gap-3 cursor-pointer"
      style={{
        background: hover ? '#FFFFFF' : 'rgba(255,255,255,0.7)',
        border: '1px solid ' + (hover ? '#F59E0B' : 'rgba(252,211,77,0.6)'),
        padding: '14px 16px',
        transform: hover ? 'translateY(-1px)' : 'translateY(0)',
        boxShadow: hover ? '0 6px 18px rgba(133,79,11,0.15)' : 'none',
        transition: 'all 0.25s ease-out',
      }}
    >
      <div
        className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
        style={{
          background: '#FEF3C7',
          color: '#854F0B',
          transform: hover ? 'rotate(-30deg)' : 'rotate(0deg)',
          transition: 'transform 0.4s ease-out',
        }}
      >
        <RefreshCw className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="inline-flex items-center gap-1.5"
          style={{
            fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
            fontSize: 15,
            color: '#1F1B16',
            fontWeight: 700,
            lineHeight: 1.2,
          }}
        >
          Re-evaluate all attendance rows
          <Sparkles className="w-3.5 h-3.5" style={{ color: '#F59E0B' }} />
        </div>
        <div className="text-[12px] mt-1" style={{ color: '#0A0A0A', opacity: 0.7, lineHeight: 1.5 }}>
          Re-classify every existing attendance row using current SUP-team / standard
          working hours and the active Mawani visit log. Use this after marking new SUP
          staff or logging Mawani days &mdash; existing rows reclassify in place.
          Daily-flow rows for shift workers and on-leave dates are preserved.
        </div>
      </div>
    </button>
  );
}
