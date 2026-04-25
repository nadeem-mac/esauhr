import React from 'react';

// Evergreen Line — the Leave Desk brand mark.
// Use this consistently anywhere a logo is shown.
//
// variants:
//   'full'  – icon + "Leave Desk" + EVERGREEN · LINE tagline (default)
//   'mark'  – icon only
//   'stack' – icon centred above wordmark (used on splash / hero centre)
//
// sizes: sm | md | lg | xl
// invert: render on light background (icon goes light → dark)

const SIZE = {
  sm: { box: 32, icon: 18, font: 'text-base',  tag: 'text-[9px]'  },
  md: { box: 36, icon: 20, font: 'text-xl',    tag: 'text-[10px]' },
  lg: { box: 56, icon: 32, font: 'text-2xl',   tag: 'text-[11px]' },
  xl: { box: 80, icon: 48, font: 'text-4xl',   tag: 'text-xs'     },
};

function Mark({ size = 'md', invert = false }) {
  const s = SIZE[size];
  const stroke = invert ? '#1F4A2F' : '#8FB39A';
  const bg     = invert ? '#F4EEDF' : 'var(--evergreen-800)';
  return (
    <div
      className="rounded-lg flex items-center justify-center flex-shrink-0"
      style={{ width: s.box, height: s.box, background: bg }}
    >
      <svg viewBox="0 0 32 32" width={s.icon} height={s.icon} aria-hidden="true">
        <path d="M16 5 C 9 10, 9 20, 16 27 C 23 20, 23 10, 16 5 Z"
              fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round"/>
        <line x1="16" y1="5" x2="16" y2="27" stroke={stroke} strokeWidth="1.3"/>
      </svg>
    </div>
  );
}

export default function EvergreenLogo({
  variant = 'full',
  size    = 'md',
  invert  = false,
  tagline = 'EVERGREEN · LINE',
  wordmark = 'Leave Desk',
  className = '',
}) {
  if (variant === 'mark') {
    return (
      <div className={className}>
        <Mark size={size} invert={invert} />
      </div>
    );
  }

  const s = SIZE[size];

  if (variant === 'stack') {
    return (
      <div className={`flex flex-col items-center gap-3 ${className}`}>
        <Mark size={size} invert={invert} />
        <div className="text-center">
          <div className={`serif ${s.font} leading-none`} style={{ fontWeight: 600 }}>{wordmark}</div>
          <div className={`${s.tag} tracking-[0.25em] opacity-60 mt-1.5`}>{tagline}</div>
        </div>
      </div>
    );
  }

  // 'full' – horizontal
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <Mark size={size} invert={invert} />
      <div>
        <div className={`serif ${s.font} leading-none`} style={{ fontWeight: 600 }}>{wordmark}</div>
        <div className={`${s.tag} tracking-[0.2em] opacity-60 mt-0.5`}>{tagline}</div>
      </div>
    </div>
  );
}
