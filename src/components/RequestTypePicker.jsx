import React from 'react';
import { X, Plane, Sunrise, Sunset, ChevronRight } from 'lucide-react';

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
//   'leave'        → NewRequestModal (existing flow, unchanged)
//   'late_arrival' → PermissionRequestModal with type='late_arrival'
//   'early_leave'  → PermissionRequestModal with type='early_leave'
//
// The picker itself is intentionally small and visual — three large
// option cards in a single column so it works well on phones, where the
// staff are most likely to be submitting requests in the moment.
// =============================================================================

export default function RequestTypePicker({ onPick, onClose }) {
  const options = [
    {
      id: 'leave',
      icon: Plane,
      title: 'Vacation or leave',
      description: 'Full or half-day requests — annual leave, emergency, sick, hajj, etc.',
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

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 90,
        background: 'rgba(15, 23, 42, 0.55)',
        backdropFilter: 'blur(2px)',
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

        {/* Options */}
        <div className="p-4 space-y-2.5">
          {options.map(opt => {
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
          })}
        </div>
      </div>
    </div>
  );
}
