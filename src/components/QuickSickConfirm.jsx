import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { HeartPulse, X, Loader2, CheckCircle2 } from 'lucide-react';
import { initialApprovalStage } from '../lib/leaveLogic.js';

// =============================================================================
// QuickSickConfirm
//
// Bottom-sheet confirm for the "I'm sick today" flow on the staff
// dashboard. Skips the SickLeaveModal entirely for the simplest
// case: a single-day, same-day declaration with no cert attached.
// The cert is collected later via the magic-link upload page or by
// the staff returning to the portal.
//
// What this component handles:
//   • Same-day enforcement (start_date = today, end_date = today)
//   • Single-day declarations only (multi-day flows go via the full
//     SickLeaveModal which has the >3-day cert hard-block logic)
//   • Auto-routes to manager for approval (initialApprovalStage)
//   • Records `declared_via='staff'` and `cert_received=false`
//   • Shows the "Get well soon" success state on completion
//
// Two states:
//   1. confirm — sheet rises, shows date/manager/notify/cert deadline
//   2. done    — green checkmark, "Get well soon", auto-closes after 4s
// =============================================================================

export default function QuickSickConfirm({ me, employees = [], onSubmit, onClose }) {
  const [phase, setPhase]   = useState('confirm');   // 'confirm' | 'done'
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');

  // Lock body scroll while open + portal-mount on document.body so the
  // sheet is fully isolated from any parent's render cycle.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Auto-close after the success state has been shown for ~4s. Gives
  // staff a moment to read the "Get well soon" message before the
  // sheet retracts and they land back on the dashboard.
  useEffect(() => {
    if (phase !== 'done') return undefined;
    const t = setTimeout(() => onClose && onClose(), 4000);
    return () => clearTimeout(t);
  }, [phase, onClose]);

  const today      = new Date().toISOString().slice(0, 10);
  const tomorrow   = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const certDue    = tomorrow.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const todayLabel = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Manager name for the confirm panel — pulled from the employees
  // directory passed in. Falls back to '—' if missing so the sheet
  // never renders an undefined string.
  const manager = (employees || []).find(e => e.id === me?.manager_id);
  const managerName = manager?.name || '—';

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      // Build the leave-request payload. Stage routing follows the
      // existing rule: pending_manager unless the requester is their
      // own manager (in which case it goes straight to pending_hr).
      // The DB trigger sync_leave_status_with_stage will derive
      // `status` from `stage` automatically.
      const stage = initialApprovalStage(me, employees);
      const certDeadlineAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      await onSubmit({
        employee_id:        me.id,
        leave_type_id:      'sick',
        start_date:         today,
        end_date:           today,
        days:               1,
        stage,
        is_half_day:        false,
        // New cert-tracking columns (see migration_sick_cert_tracking.sql)
        cert_received:      false,
        cert_deadline_at:   certDeadlineAt,
        declared_via:       'staff',
        // Notes field captures the declaration channel for the audit
        // trail — useful for HR when reconciling against punch records.
        notes:              'Declared via dashboard quick-sick tile (same-day).',
      });
      setPhase('done');
    } catch (e) {
      setError((e && (e.message || e.toString())) || 'Could not submit. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose && onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 110,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        animation: 'fadein 0.2s ease',
      }}
    >
      <style>{`
        @keyframes fadein { from { opacity: 0 } to { opacity: 1 } }
        @keyframes rise { from { transform: translateY(100%) } to { transform: translateY(0) } }
      `}</style>
      <div
        className="w-full"
        style={{
          maxWidth: 480,
          background: '#FFFFFF',
          borderRadius: '20px 20px 0 0',
          padding: '20px 22px 22px',
          boxShadow: '0 -10px 40px rgba(31,27,22,0.15)',
          animation: 'rise 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Pull-handle so it reads as a sheet, not a flat dialog. */}
        <div style={{ width: 36, height: 4, background: '#E5E5DD', borderRadius: 99, margin: '0 auto 14px' }} />

        {phase === 'confirm' && (
          <>
            <button
              type="button"
              onClick={() => onClose && onClose()}
              aria-label="Close"
              disabled={busy}
              className="absolute right-4 top-4 p-1 rounded-full hover:bg-black/5 disabled:opacity-40"
              style={{ position: 'absolute', right: 16, top: 16 }}
            >
              <X className="w-4 h-4" style={{ color: '#1F1B16' }} />
            </button>

            {/* Icon */}
            <div className="mx-auto mb-3 flex items-center justify-center"
              style={{ width: 52, height: 52, background: '#FEE2E2', borderRadius: 14 }}>
              <HeartPulse className="w-7 h-7" style={{ color: '#B91C1C' }} />
            </div>

            <div className="text-center" style={{ fontSize: 17, fontWeight: 700, color: '#1F1B16' }}>
              Declare sick today?
            </div>
            <div className="text-center" style={{ fontSize: 14, fontWeight: 600, color: '#B91C1C', marginTop: 4, marginBottom: 16 }}>
              {todayLabel}
            </div>

            {/* Detail rows */}
            <div className="rounded-xl overflow-hidden" style={{ background: '#FAFAF9', border: '1px solid var(--border-soft)' }}>
              <Row k="Manager"        v={managerName} />
              <Row k="Notify"         v="Manager + HR" />
              <Row k="Cert deadline"  v={certDue} valueColor="#B91C1C" last />
            </div>

            <div className="mt-3 text-[11px] text-center" style={{ color: '#1F1B16', opacity: 0.7 }}>
              Upload your Sehhaty certificate when you have it — we'll send a one-tap link to your email tomorrow.
            </div>

            {error && (
              <div className="mt-3 px-3 py-2 rounded-md text-[12px] flex items-start gap-2"
                style={{ background: '#FEE2E2', color: '#0A0A0A', border: '1px solid #FECACA' }}>
                {error}
              </div>
            )}

            <button
              type="button"
              onClick={handleConfirm}
              disabled={busy}
              className="w-full mt-4 inline-flex items-center justify-center gap-2 disabled:opacity-50"
              style={{
                padding: '12px',
                background: '#B91C1C',
                color: '#FFFFFF',
                border: 'none',
                borderRadius: 12,
                fontSize: 14,
                fontWeight: 600,
              }}
            >
              {busy ? (<><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>) : 'Yes, I\'m sick today'}
            </button>
            <button
              type="button"
              onClick={() => onClose && onClose()}
              disabled={busy}
              className="w-full mt-1.5 disabled:opacity-50"
              style={{
                padding: 9, background: 'transparent', color: '#7A7A7A',
                border: 'none', fontSize: 12, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
          </>
        )}

        {phase === 'done' && (
          <div className="text-center py-3">
            <div className="mx-auto mb-3 flex items-center justify-center"
              style={{ width: 64, height: 64, background: '#DCFCE7', borderRadius: '50%' }}>
              <CheckCircle2 className="w-9 h-9" style={{ color: '#0F4C2A' }} />
            </div>
            <div style={{ fontSize: 18, fontWeight: 700, color: '#0F4C2A' }}>
              Get well soon
            </div>
            <div className="mt-1 text-[12px]" style={{ color: '#1F1B16', opacity: 0.7, lineHeight: 1.5 }}>
              Your sick leave is recorded for today.<br />
              Manager &amp; HR have been notified.
            </div>
            <div className="mt-3 mx-auto inline-flex items-start gap-2 px-3 py-2 rounded-lg text-left"
              style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', maxWidth: 320 }}>
              <span className="text-[11px]" style={{ color: '#065F46' }}>
                We'll remind you tomorrow to upload your Sehhaty certificate. The reminder email has a one-tap link — no need to log in.
              </span>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// Single detail row in the confirm sheet's info card.
function Row({ k, v, last, valueColor }) {
  return (
    <div className="flex items-center justify-between"
      style={{
        padding: '10px 13px',
        borderBottom: last ? 'none' : '1px solid #F1F0EC',
        fontSize: 12,
      }}>
      <span style={{ color: '#7A7A7A', fontWeight: 500 }}>{k}</span>
      <span style={{ color: valueColor || '#1F1B16', fontWeight: 600 }}>{v}</span>
    </div>
  );
}
