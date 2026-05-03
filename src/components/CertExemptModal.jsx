// =============================================================================
// CertExemptModal
//
// Bashaier-only action surface for marking a sick declaration as
// "cert exempt" — staff doesn't need to provide a Sehhaty certificate
// because the situation falls into a known exemption category.
//
// WHEN IT FIRES
//   Bashaier taps the "EXEMPT" button on a row in PendingSickCertsCard.
//
// WHAT IT DOES
//   1. Asks Bashaier to choose a categorized reason (CERT_EXEMPT_CATEGORIES
//      from sickDeclaration.js):
//        - Single-day minor illness (no clinic visit)
//        - Hospital admission (cert provided directly to HR)
//        - Cert lost or staff abroad
//        - Other (note required)
//   2. Optional free-text note (mandatory for "Other").
//   3. PATCHes the leave_request row with:
//        sick_cert_exempt        = true
//        sick_cert_exempt_by     = me.id
//        sick_cert_exempt_reason = "<category id>: <free-text note>"
//        sick_cert_exempt_at     = now
//        stage                   = 'approved' (cert exempt = no further
//                                              cert checks; we approve
//                                              the underlying sick day
//                                              directly so the row leaves
//                                              pending_certificate)
//   4. Logs the action via logAction so the audit trail captures who
//      exempted what and why.
//
// CATEGORIES NOTE
//   Free-text notes are a maintenance burden — they don't aggregate
//   well in reports and create review fatigue. The categories are
//   the structured signal; the free-text is for the rare case where
//   "Other" is needed. Bashaier should reach for "Other" only when
//   none of the four pre-defined categories fit.
// =============================================================================

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { directPatch } from '../supabaseClient.js';
import { CERT_EXEMPT_CATEGORIES } from '../lib/sickDeclaration.js';
import { logAction } from '../lib/audit.js';

export default function CertExemptModal({ request, employee, me, onClose, onCompleted }) {
  const [categoryId, setCategoryId] = useState('');
  const [note, setNote]             = useState('');
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState('');

  // The "Other" category requires a note — the categorized buckets are
  // there to keep the audit data structured. If Bashaier reaches for
  // "Other", we want to know why.
  const noteRequired = categoryId === 'other';
  const canSubmit = !!categoryId && !busy && (!noteRequired || note.trim().length >= 3);

  async function handleSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError('');
    try {
      // Compose the audit-friendly reason string. Stored verbatim in
      // sick_cert_exempt_reason for compactness while keeping the
      // category id (machine-readable) and the optional free text
      // (human-readable) both available.
      const cat = CERT_EXEMPT_CATEGORIES.find(c => c.id === categoryId);
      const reasonText = note.trim()
        ? `${categoryId}: ${cat?.label || categoryId} — ${note.trim()}`
        : `${categoryId}: ${cat?.label || categoryId}`;

      await directPatch('leave_requests', 'id', request.id, {
        sick_cert_exempt:         true,
        sick_cert_exempt_by:      me.id,
        sick_cert_exempt_reason:  reasonText,
        sick_cert_exempt_at:      new Date().toISOString(),
        // Move the row OUT of pending_certificate stage. Cert exempt
        // means we accept the declaration as-is — the underlying sick
        // day is approved without a Sehhaty cert. This unblocks the
        // staff for any future submissions and removes the row from
        // PendingSickCertsCard.
        //
        // Stamp hr_decided_at / hr_decided_by — the canonical approval
        // columns used elsewhere in the codebase (HrApprovalModal,
        // ReviewerPanel, recent-decisions history). The legacy column
        // names approved_at / approved_by do NOT exist on
        // leave_requests; using them caused PGRST204 'Could not find
        // the approved_at column' on every exempt action.
        stage:                    'approved',
        hr_decided_at:            new Date().toISOString(),
        hr_decided_by:            me?.auth_user_id || me?.id || null,
      }, { timeoutMs: 12000 });

      // Audit. Captures who, when, why, and on whose behalf.
      logAction(me, 'sick_cert_exempt', {
        targetType: 'leave_request',
        targetId:   request.id,
        targetLabel: `${employee?.name || request.employee_id} · ${request.start_date} · cert exempt`,
        meta: {
          category_id:  categoryId,
          category_lbl: cat?.label || null,
          note:         note.trim() || null,
        },
      });

      onCompleted?.();
    } catch (e) {
      setError(e?.message || 'Could not mark this declaration as cert-exempt. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '5vh 16px',
        overflowY: 'auto',
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border"
        style={{
          background: 'var(--paper)',
          borderColor: 'var(--border-soft)',
          maxWidth: 480,
        }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between gap-3 px-6 py-4 border-b"
          style={{ borderColor: 'var(--border-soft)' }}
        >
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" style={{ color: '#0F4C2A' }} />
            <div>
              <div className="text-[10px] tracking-[0.25em] opacity-60">— MARK CERT EXEMPT</div>
              <div className="text-sm" style={{ fontWeight: 600, color: '#0A0A0A' }}>
                {employee?.name || request.employee_id}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors disabled:opacity-40"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {/* Context line — what's being exempted. */}
          <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.75 }}>
            Marking this declaration as cert-exempt will approve the sick day(s)
            without a Sehhaty certificate and remove this row from the pending
            list. Staff will be unblocked for future submissions.
          </div>

          {/* Category select — radio rather than dropdown so the four
              choices and their consequences are visible without an extra
              click. */}
          <div>
            <div className="text-[10px] tracking-wider font-bold mb-2" style={{ color: '#0A0A0A' }}>
              REASON CATEGORY
            </div>
            <div className="space-y-1.5">
              {CERT_EXEMPT_CATEGORIES.map(cat => (
                <label
                  key={cat.id}
                  className="flex items-start gap-2.5 px-3 py-2 rounded-lg border cursor-pointer hover:bg-black/[0.02]"
                  style={{
                    borderColor: categoryId === cat.id ? '#0F4C2A' : 'var(--border-soft)',
                    background:  categoryId === cat.id ? '#F0FDF4' : '#FFFFFF',
                  }}
                >
                  <input
                    type="radio"
                    name="exempt-category"
                    value={cat.id}
                    checked={categoryId === cat.id}
                    onChange={() => setCategoryId(cat.id)}
                    style={{ accentColor: '#0F4C2A', marginTop: 2 }}
                  />
                  <span className="text-[12px]" style={{ color: '#0A0A0A' }}>
                    {cat.label}
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Note field — required for "Other", optional otherwise. */}
          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <span className="text-[10px] tracking-wider font-bold" style={{ color: '#0A0A0A' }}>
                NOTE {noteRequired && <span style={{ color: '#B91C1C' }}>*</span>}
              </span>
              {!noteRequired && (
                <span className="text-[9px]" style={{ color: '#0A0A0A', opacity: 0.55 }}>
                  Optional
                </span>
              )}
            </div>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder={noteRequired
                ? 'Briefly describe why this case is exempt (required for "Other")…'
                : 'Add any context that helps the audit trail…'}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border text-[12px]"
              style={{
                borderColor: 'var(--border-soft)',
                background: '#FFFFFF',
                color: '#0A0A0A',
                resize: 'vertical',
              }}
            />
          </div>

          {error && (
            <div className="rounded-lg p-3 text-[11px] flex items-start gap-2"
                 style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <div>{error}</div>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex flex-col-reverse sm:flex-row gap-2.5">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="flex-1 px-4 py-3 rounded-xl border text-sm transition-colors disabled:opacity-50"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
            style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 600 }}
          >
            {busy
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Marking exempt…</>
              : <><ShieldCheck className="w-4 h-4" /> Mark cert exempt</>}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
