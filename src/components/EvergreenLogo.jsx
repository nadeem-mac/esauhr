import React from 'react';

// Evergreen brand mark — uses the real Evergreen logo PNG.
//
// Variants:
//   'mark'  – the circular emblem only (compact, e.g. headers)
//   'full'  – emblem + "Leave Desk" wordmark beside it (horizontal)
//   'stack' – the full Evergreen logo (emblem + EVERGREEN wordmark) stacked above
//             a "Leave Desk · HR Platform" subtitle. Used on splash + auth.
//
// sizes: sm | md | lg | xl

const MARK_SIZE = { sm: 28, md: 36, lg: 56, xl: 88 };
const STACK_W   = { sm: 180, md: 240, lg: 320, xl: 420 };

export default function EvergreenLogo({
  variant   = 'full',
  size      = 'md',
  wordmark  = 'Leave Desk',
  subtitle  = 'HR · LEAVE DESK',
  className = '',
  light     = false,   // for dark backgrounds, set light=true to brighten subtitle
}) {
  if (variant === 'mark') {
    const px = MARK_SIZE[size];
    return (
      <img
        src="/evergreen-mark.png"
        alt="Evergreen"
        width={px}
        height={px}
        className={`block ${className}`}
        style={{ width: px, height: px, objectFit: 'contain' }}
      />
    );
  }

  if (variant === 'stack') {
    const w = STACK_W[size];
    return (
      <div className={`flex flex-col items-center text-center gap-3 ${className}`}>
        <img
          src="/evergreen-full.png"
          alt="Evergreen"
          style={{ width: w, height: 'auto', objectFit: 'contain' }}
          className="block"
        />
        {subtitle && (
          <div className={`text-[11px] tracking-[0.35em] ${light ? 'opacity-70' : 'opacity-60'}`}
               style={{ fontWeight: 500 }}>
            {subtitle}
          </div>
        )}
      </div>
    );
  }

  // full — horizontal: mark + wordmark to the right
  const px = MARK_SIZE[size];
  return (
    <div className={`flex items-center gap-3 ${className}`}>
      <img
        src="/evergreen-mark.png"
        alt="Evergreen"
        width={px}
        height={px}
        style={{ width: px, height: px, objectFit: 'contain' }}
      />
      <div className="leading-tight">
        <div className="serif text-xl" style={{ fontWeight: 600, letterSpacing: '-0.01em' }}>
          {wordmark}
        </div>
        <div className={`text-[10px] tracking-[0.25em] mt-0.5 ${light ? 'opacity-70' : 'opacity-55'}`}
             style={{ fontWeight: 500 }}>
          EVERGREEN
        </div>
      </div>
    </div>
  );
}
