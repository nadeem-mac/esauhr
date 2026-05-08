import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Plane, Sunrise, Sunset, HeartPulse, AlertTriangle, Upload, Baby, Heart, Star, Briefcase, Pause, MoreHorizontal, HeartCrack, Flame } from 'lucide-react';

// =============================================================================
// RequestTypePicker — Option B (compact grid layout)
//
// Three sections, each rendered as a compact 2-column tile grid:
//   1. URGENT       → Sick leave (full-width, prominent)
//   2. LEAVE        → Annual, Maternity (female-only), Paternity (male-only),
//                     Hajj, Marriage, Bereavement, Emergency, Unpaid, Other
//   3. PERMISSIONS  → Late arrival, Early leave
//
// Each leave-type tile clicks through to NewRequestModal with that type
// pre-selected (lockedLeaveType). Sick stays urgent at the top with its
// own dedicated full-width tile + bilingual sub-text.
// =============================================================================

const LEAVE_TYPE_VISUAL = {
  annual:      { Icon: Plane,        bg: '#ECFDF5', fg: '#0F4C2A', border: '#86EFAC' },
  maternity:   { Icon: Baby,         bg: '#FCE7F3', fg: '#9D174D', border: '#F9A8D4' },
  paternity:   { Icon: Baby,         bg: '#E0F2FE', fg: '#075985', border: '#7DD3FC' },
  hajj:        { Icon: Star,         bg: '#FEF3C7', fg: '#854F0B', border: '#FCD34D' },
  marriage:    { Icon: Heart,        bg: '#FAF5FF', fg: '#7E22CE', border: '#D8B4FE' },
  bereavement: { Icon: HeartCrack,   bg: '#F3F4F6', fg: '#374151', border: '#9CA3AF' },
  emergency:   { Icon: Flame,        bg: '#FEE2E2', fg: '#7F1D1D', border: '#FCA5A5' },
  unpaid:      { Icon: Pause,        bg: '#F5F5F4', fg: '#525252', border: '#A8A29E' },
  other:       { Icon: MoreHorizontal, bg: '#F1F5F9', fg: '#475569', border: '#94A3B8' },
};
const FALLBACK_VISUAL = { Icon: Briefcase, bg: '#F1F5F9', fg: '#475569', border: '#94A3B8' };

export default function RequestTypePicker({ onPick, onClose, leaveTypes = [], me = null, blockingDeclaration = null }) {
  const meGender = (me?.gender || '').toLowerCase();
  const leaveTypeTiles = (leaveTypes || [])
    .filter(t => t.active !== false && t.id !== 'sick')
    .filter(t => {
      if (!t.applies_to_gender) return true;
      if (!meGender) return true;
      return t.applies_to_gender === meGender;
    })
    .sort((a, b) => (a.sort_order || 100) - (b.sort_order || 100))
    .map(t => {
      const v = LEAVE_TYPE_VISUAL[t.id] || FALLBACK_VISUAL;
      return {
        id: `leave:${t.id}`,
        Icon: v.Icon,
        title: t.name || t.id,
        bg: v.bg,
        fg: v.fg,
        border: v.border,
      };
    });

  const permissionTiles = [
    { id: 'late_arrival', Icon: Sunrise, title: 'Late arrival', sub: 'After 08:00', bg: '#FEF3C7', fg: '#A16207', border: '#FDE68A' },
    { id: 'early_leave',  Icon: Sunset,  title: 'Early leave',  sub: 'Before end',  bg: '#FCE7F3', fg: '#BE185D', border: '#FBCFE8' },
  ];

  // Lock body scroll while open + portal-mount on document.body so the
  // picker is fully isolated from any parent's render cycle.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Compact grid tile — icon + name (and optional 1-word subtext).
  const renderCompactTile = (opt) => {
    const Icon = opt.Icon;
    return (
      <button
        key={opt.id}
        type="button"
        onClick={() => onPick(opt.id)}
        className="text-left flex items-center gap-2 px-3 py-2.5 rounded-lg border transition-all hover:scale-[1.02] active:scale-[0.98]"
        style={{ borderColor: opt.border, background: opt.bg }}
      >
        <Icon className="w-4 h-4 flex-shrink-0" style={{ color: opt.fg }} />
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-semibold leading-tight" style={{ color: opt.fg }}>
            {opt.title}
          </div>
          {opt.sub && (
            <div className="text-[10px] leading-tight" style={{ color: opt.fg, opacity: 0.7 }}>
              {opt.sub}
            </div>
          )}
        </div>
      </button>
    );
  };

  const SectionLabel = ({ children, top = false }) => (
    <div className="text-[10px] tracking-[0.18em] mb-2 px-1"
      style={{ color: '#1F1B16', fontWeight: 700, marginTop: top ? 0 : 14 }}>
      {children}
    </div>
  );

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
          background: '#FFFFFF',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        {/* Header */}
        <div className="flex items-baseline justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border-soft)' }}>
          <div>
            <h2 className="serif text-lg" style={{ fontWeight: 500, color: '#1F1B16' }}>
              New request
            </h2>
            <div className="text-xs mt-0.5" style={{ color: '#1F1B16' }}>
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

        {/* Blocking-state escape hatch — shown when a prior sick declaration
            has an overdue Sehhaty cert. Replaces all other options. */}
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

        {/* Body */}
        <div className="p-4">
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
            </button>
          ) : (
            <>
              {/* URGENT — Sick leave (full-width, prominent) */}
              <SectionLabel top>URGENT</SectionLabel>
              <button
                type="button"
                onClick={() => onPick('quick_sick')}
                className="w-full text-left flex items-center gap-3 p-3 rounded-xl border transition-all hover:scale-[1.01] active:scale-[0.99]"
                style={{ borderColor: '#FCA5A5', background: '#FEE2E2' }}
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{ background: '#FFFFFF', color: '#B91C1C', border: '1px solid #FCA5A5' }}
                >
                  <HeartPulse className="w-4 h-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold leading-tight" style={{ color: '#7F1D1D' }}>
                    Sick leave
                  </div>
                  <div className="text-[11px] leading-tight mt-0.5" style={{ color: '#7F1D1D', opacity: 0.85 }} dir="rtl">
                    إجازة مرضية
                  </div>
                  <div className="text-[10px] mt-1" style={{ color: '#7F1D1D', opacity: 0.75 }}>
                    Sick today or have a Sehhaty certificate
                  </div>
                </div>
              </button>

              {/* LEAVE — 2-col grid of compact tiles */}
              {leaveTypeTiles.length > 0 && (
                <>
                  <SectionLabel>LEAVE</SectionLabel>
                  <div className="grid grid-cols-2 gap-2">
                    {leaveTypeTiles.map(renderCompactTile)}
                  </div>
                </>
              )}

              {/* PERMISSIONS — 2-col grid of compact tiles */}
              <SectionLabel>PERMISSIONS</SectionLabel>
              <div className="grid grid-cols-2 gap-2">
                {permissionTiles.map(renderCompactTile)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
