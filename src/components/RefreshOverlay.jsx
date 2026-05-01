import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// =============================================================================
// RefreshOverlay
//
// Full-screen overlay shown while the global refresh button is in flight.
// A small Evergreen-themed ship sails left-to-right across animated waves
// while a "Refreshing your dashboard…" caption sits above. The overlay is
// portal-mounted to document.body so it sits above every other layer
// (header, tabs, modals).
//
// Visibility is fully controlled by the `open` prop. When open flips
// false, the overlay fades out over ~200ms instead of disappearing
// instantly so the transition reads as a deliberate "done" rather than
// a flicker.
//
// No backdrop click-to-close — the underlying refresh promise can't be
// cancelled, so dismissing the overlay would just be theater. Pointer
// events are blocked while the overlay is up.
// =============================================================================

const SHIP_COLOR  = '#2D5F3F';   // Evergreen brand
const HULL_COLOR  = '#1F4530';
const WAVE_COLOR  = '#9D6B53';   // warm copper wave (matches the paper aesthetic)
const SAIL_COLOR  = '#FFFDF7';

export default function RefreshOverlay({ open, message = 'Refreshing your dashboard…' }) {
  // Mount/unmount with a fade. We keep the node mounted for ~200ms after
  // open flips to false so the CSS transition has somewhere to play out.
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // small delay so the initial render is at opacity 0, then we
      // transition to opacity 1 — gives a clean fade-IN
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 220);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <>
      {/* Inline keyframes — kept here rather than in a global stylesheet
          so the overlay file is fully self-contained. */}
      <style>{`
        @keyframes esau-ship-sail {
          0%   { transform: translateX(-12vw) translateY(0)      rotate(-1.5deg); }
          25%  { transform: translateX(0)      translateY(-3px)  rotate( 0.5deg); }
          50%  { transform: translateX(12vw)   translateY(0)     rotate( 1.5deg); }
          75%  { transform: translateX(0)      translateY(-3px)  rotate( 0.5deg); }
          100% { transform: translateX(-12vw)  translateY(0)     rotate(-1.5deg); }
        }
        @keyframes esau-wave-drift {
          from { transform: translateX(0); }
          to   { transform: translateX(-40px); }
        }
        @keyframes esau-flag-flutter {
          0%, 100% { transform: skewX(0deg); }
          50%      { transform: skewX(-12deg); }
        }
        @keyframes esau-dot-pulse {
          0%, 80%, 100% { opacity: 0.25; }
          40%           { opacity: 1; }
        }
      `}</style>
      <div
        role="status"
        aria-live="polite"
        aria-label="Refreshing"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 200,
          background: 'rgba(255, 253, 247, 0.92)',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: visible ? 1 : 0,
          transition: 'opacity 200ms ease',
          pointerEvents: visible ? 'auto' : 'none',
        }}
      >
        <div style={{ width: 'min(420px, 80vw)', textAlign: 'center' }}>
          {/* Ship + waves SVG. The ship animates via CSS keyframes
              applied to the .ship group; the waves use a tiled gradient
              with a slow horizontal drift. */}
          <svg
            viewBox="0 0 320 140"
            width="100%"
            height="auto"
            style={{ maxHeight: '160px' }}
            aria-hidden="true"
          >
            <defs>
              <pattern id="esau-wave-pattern" x="0" y="0" width="40" height="20" patternUnits="userSpaceOnUse">
                <path
                  d="M 0,10 Q 10,0 20,10 T 40,10"
                  fill="none"
                  stroke={WAVE_COLOR}
                  strokeWidth="1.5"
                  opacity="0.55"
                />
              </pattern>
            </defs>

            {/* Two wave bands at different speeds and offsets for parallax */}
            <g style={{ animation: 'esau-wave-drift 1.6s linear infinite' }}>
              <rect x="-40" y="92" width="400" height="20" fill="url(#esau-wave-pattern)" />
            </g>
            <g style={{ animation: 'esau-wave-drift 2.4s linear infinite reverse', opacity: 0.5 }}>
              <rect x="-40" y="108" width="400" height="20" fill="url(#esau-wave-pattern)" />
            </g>

            {/* Ship — anchored at viewBox centre then animated with translate.
                Bobs left-right and up-down on a 3.6s loop. */}
            <g
              style={{
                animation: 'esau-ship-sail 3.6s ease-in-out infinite',
                transformOrigin: '160px 90px',
              }}
            >
              {/* Mast */}
              <line x1="160" y1="32" x2="160" y2="78" stroke={HULL_COLOR} strokeWidth="2" strokeLinecap="round" />

              {/* Main sail — slight billow via path */}
              <path
                d="M 160 36 Q 142 50 148 78 L 160 78 Z"
                fill={SAIL_COLOR}
                stroke={SHIP_COLOR}
                strokeWidth="1.2"
              />
              <path
                d="M 160 36 Q 178 50 172 78 L 160 78 Z"
                fill={SAIL_COLOR}
                stroke={SHIP_COLOR}
                strokeWidth="1.2"
              />

              {/* Pennant flag */}
              <g style={{ animation: 'esau-flag-flutter 1.2s ease-in-out infinite', transformOrigin: '160px 32px' }}>
                <path d="M 160 30 L 174 26 L 160 36 Z" fill={SHIP_COLOR} />
              </g>

              {/* Hull — trapezoid */}
              <path
                d="M 132 78 L 188 78 L 180 92 L 140 92 Z"
                fill={SHIP_COLOR}
                stroke={HULL_COLOR}
                strokeWidth="1.5"
              />
              {/* Deck line */}
              <line x1="135" y1="82" x2="185" y2="82" stroke={HULL_COLOR} strokeWidth="0.8" opacity="0.7" />
              {/* Two tiny portholes */}
              <circle cx="148" cy="86" r="1.6" fill={SAIL_COLOR} />
              <circle cx="172" cy="86" r="1.6" fill={SAIL_COLOR} />
            </g>
          </svg>

          {/* Caption */}
          <div
            style={{
              fontFamily: 'Georgia, serif',
              fontSize: '20px',
              color: '#1F1B16',
              marginTop: '18px',
              fontStyle: 'italic',
              fontWeight: 400,
            }}
          >
            {message}
          </div>

          {/* Three pulsing dots — small, secondary, indicates progress
              when the network is slow */}
          <div style={{ marginTop: '14px', display: 'inline-flex', gap: '6px' }}>
            {[0, 1, 2].map(i => (
              <span
                key={i}
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: SHIP_COLOR,
                  display: 'inline-block',
                  animation: `esau-dot-pulse 1.4s ease-in-out ${i * 0.16}s infinite`,
                }}
              />
            ))}
          </div>

          <div
            style={{
              marginTop: '14px',
              fontSize: '11px',
              color: '#1F1B16',
              opacity: 0.55,
              letterSpacing: '0.15em',
              fontWeight: 600,
            }}
          >
            FETCHING THE LATEST · YOU'RE STILL SIGNED IN
          </div>
        </div>
      </div>
    </>,
    document.body
  );
}
