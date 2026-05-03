import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Plane, Sunrise, Sunset, ChevronRight, HeartPulse, AlertTriangle, Upload } from 'lucide-react';

// =============================================================================
// RequestTypePicker
//
// One-stop entry for staff submitting any new request. The "+ New request"
// button used to open NewRequestModal directly, which only handles
// vacation-style leave (annual / emergency / sick / etc.). Staff who wanted
// a permission (late arrival or early leave) had to know to click one of
// the colored tiles on the dashboard — discoverable for power users, but
// confusing for everyone else and easy to miss.
//
// Now the same "+ New request" entry opens this picker first, and the
// staff member explicitly chooses the kind of request they're making. Each
// option carries a one-liner so there's no ambiguity about which form
// applies to their situation.
//
// Choice routes:
//   'leave'        → NewRequestModal (vacation/emergency/hajj/etc.)
//   'sick'         → NewRequestModal pre-locked to 'sick' (Sehhaty flow,
//                    no substitute step)
//   'late_arrival' → PermissionRequestModal with type='late_arrival'
//   'early_leave'  → PermissionRequestModal with type='early_leave'
//
// Sick leave gets its own top-level slot because the workflow is
// fundamentally different — Sehhaty service code is mandatory,
// substitutes are skipped entirely, and the request goes straight to
// the manager. Hiding it inside 'Vacation or leave' made it hard to
// discover and didn't reflect how distinct the flow is.
//
// The picker itself is intentionally small and visual — large option
// cards in a single column so it works well on phones, where the
// staff are most likely to be submitting requests in the moment.
// =============================================================================

export default function RequestTypePicker({ onPick, onClose, blockingDeclaration = null }) {
  const options = [
    {
      // Sick leave — promoted to the top of the picker. Sick days
      // are time-sensitive (staff often submit while still feeling
      // unwell, want the fewest taps to complete) and they're the
      // most frequent leave type by submission volume. Putting them
      // first reduces friction for the most common urgent case.
      //
      // Single unified entry for ALL sick-leave scenarios. Internal
      // toggle (inside SickLeaveModal) decides whether the staff is
      // declaring without a certificate yet ("Not yet") or submitting
      // a Sehhaty certificate they already have ("Yes, I have it").
      //
      // Two paths, one tile — the previous design had a "Submit sick
      // leave" tile sitting next to "I'm sick today" and the difference
      // was easy to miss. Folding both into a single entry, with the
      // path selection happening as the FIRST question in the modal,
      // makes the consequence of each choice impossible to overlook.
      id: 'sick_unified',
      icon: HeartPulse,
      title: 'Sick leave — I am sick today or I have a Sehhaty Certificate',
      titleArabic: 'إجازة مرضية — أنا مريض اليوم أو لدي شهادة صحتي',
      description: 'Declare a sick day with or without a Sehhaty certificate. The form will guide you.',
      iconBg: '#FEE2E2',
      iconColor: '#B91C1C',
      borderColor: '#FCA5A5',
    },
    {
      id: 'leave',
      icon: Plane,
      title: 'Vacation or leave',
      description: 'Full or half-day requests — annual, emergency, hajj, maternity, etc.',
      iconBg: 'var(--evergreen-100)',
      iconColor: 'var(--evergreen-600)',
      borderColor: 'var(--evergreen-200)',
    },
    {
      id: 'late_arrival',
      icon: Sunrise,
      title: 'Late arrival permission',
      description: 'You expect to arrive after 08:00 on a specific day. 1–3 hours.',
      iconBg: '#FEF3C7',
      iconColor: '#A16207',
      borderColor: '#FDE68A',
    },
    {
      id: 'early_leave',
      icon: Sunset,
      title: 'Early leave permission',
      description: 'You need to leave before your normal end time. 1–3 hours.',
      iconBg: '#FCE7F3',
      iconColor: '#BE185D',
      borderColor: '#FBCFE8',
    },
  ];

  // Lock body scroll while open + portal-mount on document.body so the
  // picker is fully isolated from any parent's render cycle.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px', overflowY: 'auto',
      }}
    >
      <div
        className="w-full max-w-md rounded-2xl border"
        style={{
          borderColor: 'var(--border-soft)',
          background: '#FFFDF7',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        {/* Header */}
        <div className="flex items-baseline justify-between px-6 py-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div>
            <h2 className="serif text-lg" style={{ fontWeight: 500, color: '#1F1B16' }}>
              New request
            </h2>
            <div className="text-xs mt-1" style={{ color: '#1F1B16' }}>
              Pick the kind of request you'd like to submit.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" style={{ color: '#1F1B16' }} />
          </button>
        </div>

        {/* Soft pressure block — visible only when the staff has at
            least one pending_certificate row that's overdue. The banner
            disables every option except the cert-upload escape hatch
            (which routes to SickLeaveModal Path B with the Path picker
            skipped). Mirrors the DB trigger's logic so the messaging
            matches what would be enforced server-side.
            See getBlockingDeclarations in lib/sickDeclaration.js. */}
        {blockingDeclaration && (
          <div className="mx-4 mt-4 mb-2 rounded-xl px-4 py-3 border flex items-start gap-3"
               style={{ background: '#FEE2E2', borderColor: '#FCA5A5' }}>
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: '#991B1B' }} />
            <div className="text-[12px] flex-1" style={{ color: '#0A0A0A' }}>
              <div className="font-semibold mb-1">
                Submit your Sehhaty certificate first
              </div>
              <div style={{ opacity: 0.85 }}>
                You declared sick on {blockingDeclaration.start_date}
                {blockingDeclaration.end_date && blockingDeclaration.end_date !== blockingDeclaration.start_date
                  ? ` (through ${blockingDeclaration.end_date})`
                  : ''}
                {' '}and the cert is overdue. New requests are blocked until you upload it.
              </div>
            </div>
          </div>
        )}

        {/* Options */}
        <div className="p-4 space-y-2.5">
          {/* When blocked: show ONE prominent action — Submit certificate
              — instead of the full option list. Tapping it opens the
              SickLeaveModal directly to Path B (cert upload), skipping
              the path picker. The escape hatch keeps the staff from
              being stuck with a useless picker. */}
          {blockingDeclaration ? (
            <button
              type="button"
              onClick={() => onPick('sick_unified_cert_only')}
              className="w-full text-left flex items-center gap-3 p-4 rounded-xl border transition-colors hover:bg-white/60 group"
              style={{ borderColor: '#0F4C2A', background: '#F0FDF4' }}
            >
              <div
                className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                style={{ background: '#DCFCE7', color: '#0F4C2A', border: '1px solid #0F4C2A' }}
              >
                <Upload className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold" style={{ color: '#0F4C2A' }}>
                  Submit Sehhaty certificate
                </div>
                <div className="text-[11px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.85 }}>
                  Upload the cert PDF and the system will attach it to your declaration.
                </div>
              </div>
              <ChevronRight
                className="w-4 h-4 flex-shrink-0 opacity-50 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all"
                style={{ color: '#0F4C2A' }}
              />
            </button>
          ) : (
            options.map(opt => {
              const Icon = opt.icon;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => onPick(opt.id)}
                  className="w-full text-left flex items-center gap-3 p-3.5 rounded-xl border transition-colors hover:bg-white/60 group"
                  style={{ borderColor: opt.borderColor, background: '#FFFFFF' }}
                >
                  <div
                    className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
                    style={{ background: opt.iconBg, color: opt.iconColor, border: `1px solid ${opt.borderColor}` }}
                  >
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
                      {opt.title}
                    </div>
                    {opt.titleArabic && (
                      <div className="text-[12px] mt-0.5" dir="rtl"
                        style={{ color: '#1F1B16', fontWeight: 500 }}>
                        {opt.titleArabic}
                      </div>
                    )}
                    <div className="text-[11px] mt-0.5" style={{ color: '#1F1B16' }}>
                      {opt.description}
                    </div>
                  </div>
                  <ChevronRight
                    className="w-4 h-4 flex-shrink-0 opacity-30 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all"
                    style={{ color: '#1F1B16' }}
                />
              </button>
            );
          })
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
