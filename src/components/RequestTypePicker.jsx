import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Plane, Sunrise, Sunset, ChevronRight, HeartPulse, AlertTriangle, Upload, Baby, Heart, Star, Briefcase, Pause, MoreHorizontal } from 'lucide-react';

// =============================================================================
// RequestTypePicker
//
// One-stop entry for staff submitting any new request. Surfaces every
// leave category as a dedicated tile so staff can pick exactly what
// they need in one tap. Layout (top-to-bottom):
//
//   1. URGENT      → Sick leave
//   2. LEAVE       → Annual, Maternity (female only), Paternity (male only),
//                    Hajj, Marriage, Bereavement, Emergency, Unpaid, Other
//   3. PERMISSIONS → Late arrival, Early leave
//
// Leave-type tiles are rendered from the `leaveTypes` prop (Supabase),
// so any new types added to the DB appear here automatically without a
// code change. Gender-restricted types are filtered to the staff's
// gender as a UX nicety; server-side validation enforces the rule.
// =============================================================================

const LEAVE_TYPE_VISUAL = {
  annual:      { icon: Plane,           iconBg: '#ECFDF5', iconColor: '#0F4C2A', borderColor: '#86EFAC' },
  maternity:   { icon: Baby,            iconBg: '#FCE7F3', iconColor: '#9D174D', borderColor: '#F9A8D4' },
  paternity:   { icon: Baby,            iconBg: '#E0F2FE', iconColor: '#075985', borderColor: '#7DD3FC' },
  hajj:        { icon: Star,            iconBg: '#FEF3C7', iconColor: '#854F0B', borderColor: '#FCD34D' },
  marriage:    { icon: Heart,           iconBg: '#FAF5FF', iconColor: '#7E22CE', borderColor: '#D8B4FE' },
  bereavement: { icon: Heart,           iconBg: '#F3F4F6', iconColor: '#374151', borderColor: '#9CA3AF' },
  emergency:   { icon: AlertTriangle,   iconBg: '#FEE2E2', iconColor: '#7F1D1D', borderColor: '#FCA5A5' },
  unpaid:      { icon: Pause,           iconBg: '#F5F5F4', iconColor: '#525252', borderColor: '#A8A29E' },
  other:       { icon: MoreHorizontal,  iconBg: '#F1F5F9', iconColor: '#475569', borderColor: '#94A3B8' },
};

const FALLBACK_VISUAL = { icon: Briefcase, iconBg: '#F1F5F9', iconColor: '#475569', borderColor: '#94A3B8' };

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
        icon: v.icon,
        title: t.name || t.id,
        description: t.description || '',
        iconBg: v.iconBg,
        iconColor: v.iconColor,
        borderColor: v.borderColor,
      };
    });

  const sickTile = {
    id: 'sick_unified',
    icon: HeartPulse,
    title: 'Sick leave — I am sick today or I have a Sehhaty Certificate',
    titleArabic: 'إجازة مرضية — أنا مريض اليوم أو لدي شهادة صحتي',
    description: 'Declare a sick day with or without a Sehhaty certificate. The form will guide you.',
    iconBg: '#FEE2E2',
    iconColor: '#B91C1C',
    borderColor: '#FCA5A5',
  };

  const permissionTiles = [
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

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const renderTile = (opt) => {
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
          {opt.description && (
            <div className="text-[11px] mt-0.5" style={{ color: '#1F1B16' }}>
              {opt.description}
            </div>
          )}
        </div>
        <ChevronRight
          className="w-4 h-4 flex-shrink-0 opacity-30 group-hover:opacity-100 group-hover:translate-x-0.5 transition-all"
          style={{ color: '#1F1B16' }}
        />
      </button>
    );
  };

  const SectionLabel = ({ children }) => (
    <div className="text-[10px] tracking-[0.18em] mt-3 mb-1.5 px-1" style={{ color: '#1F1B16', fontWeight: 700 }}>
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

        <div className="p-4 pt-2">
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
            <>
              <SectionLabel>URGENT</SectionLabel>
              <div className="space-y-2">
                {renderTile(sickTile)}
              </div>

              {leaveTypeTiles.length > 0 && (
                <>
                  <SectionLabel>LEAVE</SectionLabel>
                  <div className="space-y-2">
                    {leaveTypeTiles.map(renderTile)}
                  </div>
                </>
              )}

              <SectionLabel>PERMISSIONS</SectionLabel>
              <div className="space-y-2">
                {permissionTiles.map(renderTile)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
