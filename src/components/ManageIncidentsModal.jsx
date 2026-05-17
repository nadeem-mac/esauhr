import React, { useState, useEffect, useCallback } from 'react';
import {
  X, ShieldCheck, MessageSquare, AlertTriangle, Loader2, Check, Clock,
} from 'lucide-react';
import { directPatch } from '../supabaseClient.js';
import {
  weightForViolation, VERDICT_LABEL,
} from '../lib/evaluationWeights.js';

// =============================================================================
// ManageIncidentsModal
//
// Build 4 of the EVALUATION FLAG rework (Nadeem 2026-05-17).
//
// PURPOSE
//   When Bashaier reviews an escalation row, she sometimes knows context
//   that justifies clearing a specific incident (Fahad had a flat tire
//   on the 5th, Jassim had a family emergency on the 12th). Before this
//   modal, the system stacked the violations regardless — no way to
//   honour known-good reasons without skipping the whole escalation.
//
//   This modal opens per employee from the formal-escalation panel
//   and lists every incident driving the deduction. For each row
//   Bashaier can:
//     • Read the staff's dispute / explanation if they filed one
//     • Excuse the incident with a reason (clears it from the
//       deduction immediately)
//     • Leave it as-is
//
//   Excused incidents stamp cleared_at + cleared_by + cleared_reason
//   on attendance_violations. They drop out of every queue that filters
//   cleared_at IS NULL (HR panel, staff tile, manager card, sparklines)
//   but stay in the table for the audit trail.
//
// SCHEMA REFERENCE (from migration_evaluation_excuse_dispute.sql)
//   attendance_violations.cleared_at       — already existed
//   attendance_violations.cleared_by       — already existed
//   attendance_violations.cleared_reason   — new (text, optional)
//   attendance_violations.dispute_text     — new (text, set by staff)
//   attendance_violations.dispute_at       — new (timestamptz)
//
// SAFETY
//   Each excuse is a single-row PATCH. No bulk ops, so a network blip
//   doesn't half-excuse a batch. Each row tracks its own optimistic
//   state — the others on the modal stay clickable while one is
//   saving.
// =============================================================================

// Per-type display tokens — match the colors used everywhere else
// (BashaierTasksCard escalation pills, TeamAttendanceCard, ShiftCompliance).
const TYPE_BADGE = {
  unauthorized_absence: { label: 'Absence',       fg: '#7F1D1D', bg: '#FEE2E2' },
  missed_out:           { label: 'No punch-out',  fg: '#7F1D1D', bg: '#FEE2E2' },
  missed_in:            { label: 'No punch-in',   fg: '#92400E', bg: '#FEF3C7' },
  late:                 { label: 'Late',          fg: '#92400E', bg: '#FEF3C7' },
  early:                { label: 'Early out',     fg: '#92400E', bg: '#FEF3C7' },
  early_leave:          { label: 'Early out',     fg: '#92400E', bg: '#FEF3C7' },
};

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short',
    });
  } catch {
    return iso;
  }
}

function fmtTime(iso) {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export default function ManageIncidentsModal({ row, me, onClose, onChange }) {
  // Per-row state. `rows` mirrors the incoming violations array but
  // tracks optimistic excused / saving / error for each one so the
  // modal updates immediately without waiting for a parent refetch.
  const [rows, setRows] = useState(() =>
    (row?.violations || []).map(v => ({ ...v, _saving: false, _error: null }))
  );

  // Inline reason input — keyed by violation id so we don't get a
  // single shared input box across all rows.
  const [reasonDraft, setReasonDraft] = useState({}); // { [id]: 'text' }
  const [openReasonFor, setOpenReasonFor] = useState(null); // id of the row whose reason input is open

  useEffect(() => {
    setRows((row?.violations || []).map(v => ({ ...v, _saving: false, _error: null })));
  }, [row?.employeeId, row?.violations]);

  // Keyboard close (Escape).
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const excuse = useCallback(async (vid, reason) => {
    setRows(prev => prev.map(r => r.id === vid ? { ...r, _saving: true, _error: null } : r));
    try {
      await directPatch(
        'attendance_violations', 'id', vid,
        {
          cleared_at:     new Date().toISOString(),
          cleared_by:     me?.id || 'H94830',
          cleared_reason: (reason || '').trim() || 'Excused by HR (no reason recorded)',
        },
        { timeoutMs: 10000 },
      );
      setRows(prev => prev.map(r => r.id === vid ? {
        ...r,
        cleared_at: new Date().toISOString(),
        cleared_by: me?.id || 'H94830',
        cleared_reason: reason,
        _saving: false,
      } : r));
      setOpenReasonFor(null);
      setReasonDraft(prev => { const c = { ...prev }; delete c[vid]; return c; });
      // Tell the parent to refresh — they'll re-pull attendance_violations
      // and the realtime channel will fire anyway, but a direct nudge
      // makes the panel update feel instant.
      onChange?.();
    } catch (e) {
      setRows(prev => prev.map(r => r.id === vid ? {
        ...r,
        _saving: false,
        _error: e?.message || 'Save failed',
      } : r));
    }
  }, [me?.id, onChange]);

  if (!row) return null;

  // Recompute the live deduction from the in-modal rows so Bashaier
  // sees the new total IMMEDIATELY when she excuses an incident.
  // Filter out cleared ones — they no longer contribute.
  const liveRows = rows.filter(r => !r.cleared_at);
  const liveDeduction = liveRows.reduce((sum, r) => sum + weightForViolation(r), 0);
  const liveScore = Math.max(0, 100 - liveDeduction);
  const liveCount = liveRows.length;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:p-6 overflow-y-auto"
         style={{ background: 'rgba(20,30,25,0.55)', backdropFilter: 'blur(2px)' }}
         onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl my-8"
           onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="px-5 sm:px-6 py-4 sticky top-0 z-10 rounded-t-2xl flex items-start justify-between gap-3"
             style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
          <div>
            <div className="text-[10px] tracking-[0.25em] opacity-80 mb-1">— MANAGE INCIDENTS</div>
            <h2 className="text-xl font-serif">{row.employeeName}</h2>
            <div className="text-[11px] opacity-90 mt-1">
              {liveCount} active incident{liveCount === 1 ? '' : 's'} · <strong>{liveDeduction} pts deducted</strong> · score <strong>{liveScore}/100</strong>
              {liveDeduction !== row.deduction && (
                <span style={{ opacity: 0.8, marginLeft: 6 }}>(was {row.deduction})</span>
              )}
            </div>
          </div>
          <button onClick={onClose}
                  className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-white/20 transition-colors flex-shrink-0"
                  style={{ color: '#fff' }} aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Per-incident list */}
        <div className="px-5 sm:px-6 py-4 max-h-[60vh] overflow-y-auto" style={{ background: '#FFFFFF' }}>
          <div className="space-y-2">
            {rows.length === 0 && (
              <div className="text-[12px] text-center py-6" style={{ color: '#0A0A0A', opacity: 0.5 }}>
                No incidents recorded.
              </div>
            )}
            {rows.map((v) => {
              const badge = TYPE_BADGE[v.violation_type] || { label: v.violation_type, fg: '#1F1B16', bg: '#F4F4EE' };
              const isCleared = !!v.cleared_at;
              const weight = weightForViolation(v);
              const minutes = Math.abs(Number(v.minutes_off) || 0);
              const detail = (v.violation_type === 'late' || v.violation_type === 'early' || v.violation_type === 'early_leave')
                ? `${minutes} min`
                : null;
              const reasonOpen = openReasonFor === v.id;
              return (
                <div key={v.id}
                     className="rounded-lg border p-3"
                     style={{
                       borderColor: isCleared ? '#D1D5DB' : 'var(--border-soft, #E8E5D8)',
                       background: isCleared ? '#F9FAFB' : '#FFFFFF',
                       opacity: isCleared ? 0.7 : 1,
                     }}>
                  <div className="flex items-center gap-3">
                    {/* Date column */}
                    <div style={{ minWidth: 92 }}>
                      <div style={{ color: '#0A0A0A', fontWeight: 600, fontSize: 12 }}>
                        {fmtDate(v.violation_date)}
                      </div>
                      <div style={{ color: '#0A0A0A', opacity: 0.55, fontSize: 10 }}>
                        {v.violation_date}
                      </div>
                    </div>
                    {/* Type pill */}
                    <span style={{
                      background: badge.bg, color: badge.fg,
                      padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                      letterSpacing: '0.04em', whiteSpace: 'nowrap',
                    }}>
                      {badge.label.toUpperCase()}{detail ? ` · ${detail}` : ''}
                    </span>
                    {/* Weight */}
                    <span style={{
                      color: isCleared ? '#0A0A0A' : '#7F1D1D',
                      fontWeight: 700, fontSize: 12,
                      textDecoration: isCleared ? 'line-through' : 'none',
                    }}>
                      −{weight} pt{weight === 1 ? '' : 's'}
                    </span>
                    <div className="flex-1"/>
                    {/* Action area */}
                    {isCleared ? (
                      <span className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-full"
                            style={{ background: '#DCFCE7', color: '#14532D', fontWeight: 700, letterSpacing: '0.04em' }}>
                        <Check className="w-3 h-3"/> EXCUSED
                      </span>
                    ) : (
                      <button type="button"
                              onClick={() => setOpenReasonFor(reasonOpen ? null : v.id)}
                              disabled={v._saving}
                              className="text-[10px] inline-flex items-center gap-1 px-2.5 py-1 rounded-full border font-medium"
                              style={{
                                borderColor: '#86EFAC', background: '#FFFFFF',
                                color: '#0F4C2A', cursor: 'pointer',
                              }}>
                        {v._saving ? <Loader2 className="w-3 h-3 animate-spin"/> : <ShieldCheck className="w-3 h-3"/>}
                        Excuse
                      </button>
                    )}
                  </div>

                  {/* Dispute / explanation from the staff (Build 4 staff side).
                      Always visible when present so Bashaier reads it BEFORE
                      she decides to excuse or stand firm. */}
                  {v.dispute_text && (
                    <div className="mt-2 rounded p-2 flex items-start gap-2"
                         style={{ background: '#DBEAFE', border: '1px solid #93C5FD' }}>
                      <MessageSquare className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#1E40AF' }}/>
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px]" style={{ color: '#1E40AF', fontWeight: 700, letterSpacing: '0.04em', marginBottom: 2 }}>
                          STAFF EXPLAINED · {fmtTime(v.dispute_at)}
                        </div>
                        <div className="text-[12px]" style={{ color: '#1E3A8A', whiteSpace: 'pre-wrap' }}>
                          {v.dispute_text}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Excuse reason — captured at clear-time, shown below
                      after the clear lands. */}
                  {isCleared && v.cleared_reason && (
                    <div className="mt-2 text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                      <strong>Reason:</strong> {v.cleared_reason}
                    </div>
                  )}

                  {/* Inline reason input — appears when Excuse is clicked
                      on a not-yet-cleared row. Saves on confirm; cancels
                      on Escape or by clicking Excuse again. */}
                  {reasonOpen && !isCleared && (
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="text"
                        autoFocus
                        placeholder="Why is this excused? (e.g. medical, family emergency)"
                        maxLength={200}
                        value={reasonDraft[v.id] || ''}
                        onChange={(e) => setReasonDraft(prev => ({ ...prev, [v.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') excuse(v.id, reasonDraft[v.id] || '');
                          if (e.key === 'Escape') setOpenReasonFor(null);
                        }}
                        className="flex-1 text-[12px] px-2 py-1 rounded border"
                        style={{ borderColor: 'var(--border-soft, #E8E5D8)', background: '#FFFFFF', color: '#0A0A0A' }}
                      />
                      <button type="button"
                              onClick={() => excuse(v.id, reasonDraft[v.id] || '')}
                              disabled={v._saving}
                              className="text-[10px] inline-flex items-center gap-1 px-3 py-1.5 rounded-full font-medium"
                              style={{
                                background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)',
                                color: '#fff',
                              }}>
                        {v._saving ? <Loader2 className="w-3 h-3 animate-spin"/> : <Check className="w-3 h-3"/>}
                        Confirm
                      </button>
                    </div>
                  )}

                  {v._error && (
                    <div className="mt-2 text-[11px] flex items-center gap-1"
                         style={{ color: '#7F1D1D' }}>
                      <AlertTriangle className="w-3 h-3"/> {v._error}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer note */}
        <div className="px-5 sm:px-6 py-3 border-t text-[11px] sticky bottom-0 bg-white rounded-b-2xl"
             style={{ borderColor: 'var(--border-soft, #E8E5D8)', color: '#0A0A0A', opacity: 0.75 }}>
          Excused incidents are removed from the deduction immediately. They stay in the audit trail with your name + reason attached. Close this modal to return to the escalation list — if the live score is back above the threshold the row stays; if it's below, the row drops out and no formal email is needed.
        </div>
      </div>
    </div>
  );
}
