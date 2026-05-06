// ─── useClickBounce ─────────────────────────────────────────────────
//
// Tiny helper for the satisfying "tap-bounce" effect on clickable
// employee names. The animation runs once per click and self-clears,
// so repeated clicks always re-trigger the bounce instead of being
// no-op'd by an already-applied class.
//
// Usage:
//   const { bouncing, bouncePulse } = useClickBounce();
//   <button onClick={() => { bouncePulse(); onClick(); }}
//           className={`click-bounce ${bouncing ? 'bouncing' : ''}`}>
//     {employee.name}
//   </button>
//
// Or wrap with the BounceTap component which handles the wiring:
//   <BounceTap onClick={() => setSelectedEmployee(emp)}>
//     {emp.name}
//   </BounceTap>
//
// The CSS for click-bounce + .bouncing modifier lives in
// src/styles/index.css.

import React, { useState, useCallback, useRef } from 'react';

export function useClickBounce() {
  const [bouncing, setBouncing] = useState(false);
  const timerRef = useRef(null);

  const bouncePulse = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setBouncing(false);
    // requestAnimationFrame ensures the false→true transition is a
    // real DOM update, so consecutive clicks always retrigger the
    // animation instead of being optimized away by React.
    requestAnimationFrame(() => {
      setBouncing(true);
      timerRef.current = setTimeout(() => setBouncing(false), 380);
    });
  }, []);

  return { bouncing, bouncePulse };
}

// ─── <BounceTap> wrapper ───────────────────────────────────────────
// Renders a span by default (inline) but passes through any element
// type via the `as` prop. Bounces on click; calls onClick after the
// pulse fires so the caller's navigation/modal-open feels connected
// to the tactile feedback.
export default function BounceTap({
  as = 'span',
  className = '',
  onClick,
  children,
  style,
  ...rest
}) {
  const Tag = as;
  const { bouncing, bouncePulse } = useClickBounce();
  const handle = (e) => {
    bouncePulse();
    if (typeof onClick === 'function') onClick(e);
  };
  return (
    <Tag
      className={`click-bounce ${bouncing ? 'bouncing' : ''} ${className}`}
      onClick={handle}
      style={style}
      {...rest}
    >
      {children}
    </Tag>
  );
}
