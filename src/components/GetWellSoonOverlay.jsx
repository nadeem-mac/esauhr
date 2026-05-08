import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Bell, Link as LinkIcon } from 'lucide-react';

// =============================================================================
// GetWellSoonOverlay
//
// Full-screen success overlay shown for ~4 seconds after a staff member
// successfully declares sick via the QuickSickConfirm bottom sheet.
//
// IMPORTANT: This component lives in AppShell (rendered from there), not
// inside QuickSickConfirm. We previously tried to show this state inline
// inside the bottom sheet, but a parent re-render caused by the post-insert
// data refresh was remounting the bottom sheet back to its 'confirm' phase.
// By rendering this overlay independently from AppShell, the modal lifecycle
// can't touch it — it's a sibling component triggered by AppShell state.
//
// Auto-dismisses after 4s. Tap outside to dismiss earlier.
// =============================================================================
export default function GetWellSoonOverlay({ open, onClose }) {
  // Lock body scroll while open so background content doesn't shift.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Auto-dismiss after 4 seconds. Long enough for the user to read the
  // green message + the cert reminder hint, short enough that they're
  // back on the dashboard quickly.
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => onClose && onClose(), 4000);
    return () => clearTimeout(t);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      onClick={() => onClose && onClose()}
      style={{
        position: 'fixed', inset: 0, zIndex: 120,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 20,
        animation: 'fadein 0.25s ease',
      }}
    >
      <style>{`
        @keyframes fadein  { from { opacity: 0 } to { opacity: 1 } }
        @keyframes pop     { from { transform: scale(0.9); opacity: 0 } to { transform: scale(1); opacity: 1 } }
        @keyframes pulse-g { 0% { box-shadow: 0 0 0 0 rgba(15,76,42,0.4) } 70% { box-shadow: 0 0 0 14px rgba(15,76,42,0) } 100% { box-shadow: 0 0 0 0 rgba(15,76,42,0) } }
      `}</style>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 380,
          background: '#FFFFFF',
          borderRadius: 20,
          padding: '32px 24px 28px',
          boxShadow: '0 16px 60px rgba(31,27,22,0.20)',
          textAlign: 'center',
          animation: 'pop 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
        }}
      >
        {/* Green checkmark with subtle pulse animation */}
        <div
          className="mx-auto mb-4 flex items-center justify-center"
          style={{
            width: 76, height: 76,
            background: '#DCFCE7',
            borderRadius: '50%',
            animation: 'pulse-g 1.5s ease-out',
          }}
        >
          <CheckCircle2 className="w-10 h-10" style={{ color: '#0F4C2A' }} />
        </div>

        <div style={{ fontSize: 22, fontWeight: 700, color: '#0F4C2A', letterSpacing: '-0.01em' }}>
          Get well soon
        </div>
        <div dir="rtl" style={{ fontSize: 14, fontWeight: 500, color: '#0F4C2A', opacity: 0.75, marginTop: 4 }}>
          سلامتك
        </div>
        <div style={{ fontSize: 13, color: '#1F1B16', opacity: 0.7, marginTop: 10, lineHeight: 1.55 }}>
          Your sick leave is recorded for today.<br />
          Manager &amp; HR have been notified.
        </div>

        {/* Reminders block — what happens next */}
        <div className="mt-5 flex flex-col gap-2">
          <Hint icon={Bell}>
            Reminder tomorrow at 9:24 AM to upload your Sehhaty cert
          </Hint>
          <Hint icon={LinkIcon}>
            One-tap link in the email — no need to log in again
          </Hint>
        </div>

        <div style={{ fontSize: 10, color: '#1F1B16', opacity: 0.4, marginTop: 16 }}>
          Tap anywhere to dismiss
        </div>
      </div>
    </div>,
    document.body
  );
}

function Hint({ icon: Icon, children }) {
  return (
    <div
      className="flex items-start gap-2 px-3 py-2 rounded-lg"
      style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}
    >
      <Icon className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: '#0F4C2A' }} />
      <span style={{ fontSize: 11, color: '#065F46', textAlign: 'left', lineHeight: 1.5 }}>
        {children}
      </span>
    </div>
  );
}
