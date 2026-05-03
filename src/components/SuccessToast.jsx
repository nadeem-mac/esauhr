// =============================================================================
// SuccessToast
//
// App-wide success confirmation banner shown at the top of the screen after
// a leave / permission / sick declaration is submitted. Replaces the silent
// "modal closes and nothing else happens" UX that left users wondering
// whether their submission worked.
//
// SHAPE
//   { title, body, actionLabel?, onAction?, onDismiss }
//
// BEHAVIOR
//   • Fixed top-center on desktop, full-width top on mobile.
//   • Auto-dismisses after 6 seconds.
//   • Manual dismiss via the close button.
//   • Optional action button (e.g. "View applications") that scrolls
//     the page to a target section. Clicking the action also dismisses.
//   • Subtle slide-down + fade-in entry animation; fade-out on exit.
//
// VISUAL
//   • Evergreen-toned success colour palette to match the rest of the
//     portal (the brand uses #0F4C2A as the primary success / approve
//     colour; we match it here).
//   • Sized to be readable but not blocking — sits above the top nav
//     bar with z-index 80, below modals (which use 100).
// =============================================================================

import React, { useEffect } from 'react';
import { CheckCircle2, X, ArrowDownCircle } from 'lucide-react';

const AUTO_DISMISS_MS = 6000;

export default function SuccessToast({
  title,
  body,
  actionLabel,
  onAction,
  onDismiss,
}) {
  // Auto-dismiss timer. Reset whenever the title/body changes (so a
  // second submission re-arms the timer instead of ticking down on
  // the new toast from the previous one's clock).
  useEffect(() => {
    const t = setTimeout(() => { onDismiss?.(); }, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [title, body, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        top: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 80,
        width: 'min(560px, calc(100vw - 32px))',
        animation: 'esauhr-toast-in 220ms ease-out',
      }}
    >
      <div
        className="rounded-xl border shadow-lg flex items-start gap-3 px-4 py-3"
        style={{
          background: '#F0FDF4',
          borderColor: '#0F4C2A',
          boxShadow: '0 8px 24px rgba(15, 76, 42, 0.18)',
        }}
      >
        <CheckCircle2
          className="flex-shrink-0 mt-0.5"
          style={{ width: 20, height: 20, color: '#0F4C2A' }}
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm" style={{ fontWeight: 600, color: '#0A0A0A' }}>
            {title}
          </div>
          {body && (
            <div className="text-[12px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.85 }}>
              {body}
            </div>
          )}
          {actionLabel && onAction && (
            <button
              type="button"
              onClick={() => { onAction(); onDismiss?.(); }}
              className="mt-2 inline-flex items-center gap-1.5 text-[11px] font-bold tracking-wider hover:opacity-80"
              style={{ color: '#0F4C2A' }}
            >
              <ArrowDownCircle className="w-3.5 h-3.5" />
              {actionLabel}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex-shrink-0 p-1 rounded-full hover:bg-black/5 transition-colors"
          aria-label="Dismiss"
          style={{ color: '#0A0A0A', opacity: 0.5 }}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Slide-down entry animation. Defined inline so the toast is
          fully self-contained — no global CSS dependency. */}
      <style>{`
        @keyframes esauhr-toast-in {
          from { opacity: 0; transform: translateX(-50%) translateY(-12px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
      `}</style>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Submission stage → human-readable next-step copy.
//
// Used by the four submission paths to derive the toast body without each
// caller having to repeat the same logic. Keeps the staff-facing language
// consistent: "your manager", "HR", etc., wording matches the stage pills
// in MyApplicationsCard so the two surfaces don't drift.
// -----------------------------------------------------------------------------
export function bodyForStage(stage) {
  switch (stage) {
    case 'pending_substitutes':
      return 'Substitutes are being notified. You can track its status below.';
    case 'pending_manager':
      return 'Your manager will review it next. Track its status below.';
    case 'pending_hr':
      return 'HR will review it next. Track its status below.';
    case 'pending_certificate':
      return 'Submit your Sehhaty certificate when you receive it. Track its status below.';
    case 'approved':
      return 'Your request has been approved.';
    default:
      return 'Track its status in YOUR APPLICATIONS below.';
  }
}
