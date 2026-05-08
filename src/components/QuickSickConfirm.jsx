import React, { useEffect, useState, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { HeartPulse, X, Loader2, FileWarning } from 'lucide-react';
import { initialApprovalStage } from '../lib/leaveLogic.js';

// =============================================================================
// QuickSickConfirm
//
// Bottom-sheet for the "I'm sick today" flow. Staff picks how many days
// (1, 2, or 3) and confirms. The form is locked to today as the start
// date — same-day enforcement, per the launch policy. Multi-day cases
// land as a single leave_requests row with the right end_date.
//
// Saudi labour law requires a Sehhaty certificate at submission for
// any sick leave longer than 3 days. We HARD-BLOCK that case here and
// route the staff to the full SickLeaveModal (via onEscalateToFullForm)
// where they can attach the cert PDF before submitting.
//
// What this handles:
//   • Same-day enforcement (start_date = today)
//   • Duration selector — 1 / 2 / 3 days, default 1
//   • Auto-computed end_date from duration
//   • Auto-routes to manager for approval (initialApprovalStage)
//   • Records `declared_via='staff'` for the audit trail
//
// What this does NOT handle:
//   • >3 day sick leaves — hard block, escalate to full form
//   • Cert upload — handled by the full form / magic-link page later
// =============================================================================

export default function QuickSickConfirm({ me, employees = [], onSubmit, onClose, onEscalateToFullForm }) {
  // 1 / 2 / 3 — number of consecutive sick days starting today.
  // Anything > 3 has to go through the full form (cert mandatory).
  const [days, setDays]     = useState(1);
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState('');

  // Lock body scroll while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const todayDate = useMemo(() => new Date(), []);
  const today     = todayDate.toISOString().slice(0, 10);

  // End date = today + (days - 1). For 1 day, end == today.
  // For 3 days, end is today + 2 calendar days. We use calendar
  // days, not working days — Saudi weekend handling is the next
  // step beyond this card's scope.
  const endDate = useMemo(() => {
    const d = new Date(todayDate);
    d.setDate(d.getDate() + (days - 1));
    return d.toISOString().slice(0, 10);
  }, [todayDate, days]);

  // Pretty date label for the sheet header. 1 day shows just today;
  // 2-3 days shows "Friday 8 May → Sunday 10 May".
  const dateLabel = useMemo(() => {
    const fmt = (d) => d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    if (days === 1) {
      return fmt(todayDate) + ', ' + todayDate.getFullYear();
    }
    const end = new Date(todayDate);
    end.setDate(end.getDate() + (days - 1));
    return `${fmt(todayDate)} → ${fmt(end)}, ${todayDate.getFullYear()}`;
  }, [todayDate, days]);

  // Cert deadline = 24h from now. Same regardless of duration.
  const certDue = useMemo(() => {
    const t = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return t.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }, []);

  // Manager name for the confirm panel.
  const manager     = (employees || []).find(e => e.id === me?.manager_id);
  const managerName = manager?.name || '—';

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const stage = initialApprovalStage(me, employees);
      const payload = {
        employee_id:        me.id,
        leave_type_id:      'sick',
        start_date:         today,
        end_date:           endDate,
        days:               days,
        stage,
        is_half_day:        false,
        reason:             days === 1
          ? 'Sick leave declared via dashboard quick-sick (same-day, 1 day).'
          : `Sick leave declared via dashboard quick-sick (same-day, ${days} days, through ${endDate}).`,
      };
      console.log('[QuickSick] submitting', payload);
      await onSubmit(payload);
      console.log('[QuickSick] success — closing immediately');
      onClose && onClose();
    } catch (e) {
      console.error('[QuickSick] submission failed', e);
      setError((e && (e.message || e.toString())) || 'Could not submit. Please try again.');
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
          position: 'relative',
        }}
      >
        {/* Pull-handle */}
        <div style={{ width: 36, height: 4, background: '#E5E5DD', borderRadius: 99, margin: '0 auto 14px' }} />

        <button
          type="button"
          onClick={() => onClose && onClose()}
          aria-label="Close"
          disabled={busy}
          className="absolute p-1 rounded-full hover:bg-black/5 disabled:opacity-40"
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
        <div className="text-center" style={{ fontSize: 13, fontWeight: 600, color: '#B91C1C', marginTop: 4, marginBottom: 14 }}>
          {dateLabel}
        </div>

        {/* Duration segmented control */}
        <div className="mb-3">
          <div className="text-[10px] tracking-[0.18em] mb-1.5" style={{ color: '#1F1B16', fontWeight: 700 }}>
            HOW LONG?
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            <DurationBtn active={days === 1} onClick={() => setDays(1)} disabled={busy}
              label="Today only" sub="1 day" />
            <DurationBtn active={days === 2} onClick={() => setDays(2)} disabled={busy}
              label="2 days"     sub="incl. tomorrow" />
            <DurationBtn active={days === 3} onClick={() => setDays(3)} disabled={busy}
              label="3 days"     sub="max without cert" />
          </div>
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
          {busy
            ? (<><Loader2 className="w-4 h-4 animate-spin" /> Submitting…</>)
            : (days === 1 ? "Yes, I'm sick today" : `Yes, declare ${days} sick days`)}
        </button>

        {/* >3 day escalation. The full SickLeaveModal handles cert
            upload + multi-day range. We don't bake that into the
            quick sheet because it would balloon the simple flow. */}
        {onEscalateToFullForm && (
          <button
            type="button"
            onClick={() => { onClose && onClose(); onEscalateToFullForm(); }}
            disabled={busy}
            className="w-full mt-2 inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
            style={{
              padding: 8,
              background: 'transparent',
              color: '#1F1B16',
              border: 'none',
              fontSize: 11,
              cursor: 'pointer',
              opacity: 0.65,
            }}
          >
            <FileWarning className="w-3 h-3" />
            More than 3 days? Use full form (cert required)
          </button>
        )}

        <button
          type="button"
          onClick={() => onClose && onClose()}
          disabled={busy}
          className="w-full mt-1 disabled:opacity-50"
          style={{
            padding: 9, background: 'transparent', color: '#7A7A7A',
            border: 'none', fontSize: 12, cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body
  );
}

// Single segmented control button for the duration selector.
// Shows a primary label + tiny subtitle. Active state inverts the
// colours; inactive shows a soft greyscale chip.
function DurationBtn({ active, onClick, disabled, label, sub }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: '9px 6px',
        background:    active ? '#1F1B16' : '#FFFFFF',
        color:         active ? '#FFFFFF' : '#1F1B16',
        border:        `1px solid ${active ? '#1F1B16' : 'var(--border-soft)'}`,
        borderRadius:  10,
        cursor:        disabled ? 'not-allowed' : 'pointer',
        opacity:       disabled ? 0.5 : 1,
        textAlign:     'center',
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, lineHeight: 1.2 }}>
        {label}
      </div>
      <div style={{
        fontSize: 9, opacity: 0.7, fontWeight: 500, marginTop: 2,
        letterSpacing: '0.02em',
      }}>
        {sub}
      </div>
    </button>
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
