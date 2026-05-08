import React, { useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Bell, Mail, X } from 'lucide-react';

// =============================================================================
// GetWellSoonOverlay
//
// Full-screen success overlay shown after a staff member successfully
// declares sick via the QuickSickConfirm bottom sheet.
//
// IMPORTANT: This component lives in AppShell (rendered from there), not
// inside QuickSickConfirm. Showing it inline inside the bottom sheet hit
// a parent re-render bug that remounted the sheet back to its 'confirm'
// phase. Rendering at AppShell sidesteps the modal lifecycle entirely.
//
// Behavior change (per Nadeem):
//   The overlay no longer auto-dismisses. It stays open until the user
//   either taps the close button OR taps the primary action — which
//   opens a prefilled email to HR (Bashaier) so they're informed by
//   email as well as via the portal record. CC's the staff member's
//   direct manager.
// =============================================================================

// Hardcoded recipient. Bashaier is the HR/SUP supervisor and the
// designated contact for sick leave notifications across all branches.
// If/when Badria gets HR access, this could fan out to a small list,
// but for now Bashaier alone is the right destination.
const HR_EMAIL = 'bashaier.alsubaie@evergreen-shipping.com.sa';

export default function GetWellSoonOverlay({ open, me, employees = [], onClose }) {
  // Lock body scroll while open so background content doesn't shift.
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  // Build the prefilled mailto URL once we have a context. The user
  // taps the action button → their default mail app opens with TO,
  // CC, subject and body already filled in. They just hit Send.
  //
  // NOTE on encoding: mailto: URLs need %20 for spaces, not '+'.
  // URLSearchParams encodes spaces as '+' which Apple Mail / Outlook
  // sometimes render literally. We build the query string by hand
  // with encodeURIComponent which gives %20.
  const mailtoHref = useMemo(() => {
    if (!me) return null;
    const today = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
    const manager = (employees || []).find(e => e.id === me.manager_id);
    const managerEmail = manager?.email || '';
    const subject = `Sick Leave — ${today} — ${me.name || ''} — ${me.id || ''}`;
    const body = [
      'Dear HR,',
      '',
      `This is to inform you that I will be on sick leave today, ${today}.`,
      '',
      'I have already recorded my sick leave in the Evergreen HR portal. I will submit my Sehhaty certificate within 24 hours.',
      '',
      'Best regards,',
      `${me.name || ''} - ${me.id || ''}`,
    ].join('\n');
    const parts = [];
    if (managerEmail) parts.push(`cc=${encodeURIComponent(managerEmail)}`);
    parts.push(`subject=${encodeURIComponent(subject)}`);
    parts.push(`body=${encodeURIComponent(body)}`);
    return `mailto:${HR_EMAIL}?${parts.join('&')}`;
  }, [me, employees]);

  if (!open) return null;

  return createPortal(
    <div
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
        style={{
          width: '100%', maxWidth: 380,
          background: '#FFFFFF',
          borderRadius: 20,
          padding: '28px 24px 22px',
          boxShadow: '0 16px 60px rgba(31,27,22,0.20)',
          textAlign: 'center',
          animation: 'pop 0.35s cubic-bezier(0.4, 0, 0.2, 1)',
          position: 'relative',
        }}
      >
        {/* Top-right close button. The overlay no longer auto-dismisses,
            so the user needs an explicit way out if they don't want to
            send the email. */}
        <button
          type="button"
          onClick={() => onClose && onClose()}
          aria-label="Close"
          className="absolute"
          style={{
            top: 12, right: 12,
            width: 30, height: 30,
            borderRadius: '50%',
            background: 'transparent',
            border: 'none',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer',
          }}
        >
          <X className="w-4 h-4" style={{ color: '#1F1B16', opacity: 0.5 }} />
        </button>

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
          Send HR a quick email to formalise.
        </div>

        {/* Primary action — opens prefilled email. The mail app handles
            the actual send; we just hand it the recipient, CC, subject,
            and body. After the user sends or cancels, they can close
            the overlay manually with the X button. */}
        <a
          href={mailtoHref || '#'}
          onClick={(e) => {
            if (!mailtoHref) {
              e.preventDefault();
              return;
            }
            // Don't auto-close. The user might cancel composing the
            // email and want to send it again, or they might want to
            // dismiss only after the mail app actually opens.
          }}
          className="inline-flex items-center justify-center gap-2 w-full mt-5"
          style={{
            padding: '12px',
            background: '#0F4C2A',
            color: '#FFFFFF',
            borderRadius: 12,
            fontSize: 14,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          <Mail className="w-4 h-4" />
          Open email to HR/SUP
        </a>

        {/* Reminders block — what happens next.
            Note: a second hint about a magic-link in the cert reminder
            email used to live here. Removed because the magic-link
            upload page hasn't been built yet — promising it would
            mislead the staff. The cert-reminder cron itself is still
            on the roadmap; once shipped, we can bring this back. */}
        <div className="mt-4 flex flex-col gap-2">
          <Hint icon={Bell}>
            Reminder tomorrow at 9:24 AM to upload your Sehhaty cert
          </Hint>
        </div>

        {/* Secondary dismiss action — for users who don't want to send
            an email. Can also dismiss with the X button. */}
        <button
          type="button"
          onClick={() => onClose && onClose()}
          style={{
            marginTop: 14,
            padding: 9,
            background: 'transparent',
            color: '#7A7A7A',
            border: 'none',
            fontSize: 11,
            cursor: 'pointer',
            width: '100%',
          }}
        >
          Skip — close
        </button>
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
