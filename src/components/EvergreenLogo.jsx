import React from 'react';

// Evergreen brand mark — uses the real Evergreen logo PNG.
// No "Leave Desk" wordmark anywhere — pure Evergreen branding.
//
// Variants:
//   'mark'  – the circular emblem only (the Evergreen globe)
//   'full'  – the full Evergreen logo image (emblem + EVERGREEN wordmark from the PNG)
//   'stack' – the full Evergreen logo, centred. Used on splash + auth.
//
// sizes: sm | md | lg | xl

const MARK_SIZE  = { sm: 28, md: 36, lg: 56, xl: 88 };
const FULL_WIDTH = { sm: 130, md: 170, lg: 240, xl: 360 };

export default function EvergreenLogo({
  variant   = 'mark',
  size      = 'md',
  className = '',
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
    const w = FULL_WIDTH[size];
    return (
      <img
        src="/evergreen-full.png"
        alt="Evergreen"
        className={`block ${className}`}
        style={{ width: w, height: 'auto', objectFit: 'contain' }}
      />
    );
  }

  // 'full' – horizontal version of the logo (image already includes EVERGREEN text)
  const w = FULL_WIDTH[size];
  return (
    <img
      src="/evergreen-full.png"
      alt="Evergreen"
      className={`block ${className}`}
      style={{ width: w, height: 'auto', objectFit: 'contain' }}
    />
  );
}
