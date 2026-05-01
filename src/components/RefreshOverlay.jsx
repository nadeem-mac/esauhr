import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// =============================================================================
// RefreshOverlay
//
// Full-screen overlay shown while AppShell.refreshing is true. The visual
// is an Evergreen-brand container ship sailing across a layered seascape
// with drifting clouds, a hint of horizon, and a wake trailing behind.
// More on-brand than a sailboat (Evergreen Line is a container shipping
// company) and reads well at any viewport width.
//
// All motion is pure CSS keyframes inlined in a <style> tag so the
// component stays self-contained. Each layer has its own loop length so
// the composition never repeats exactly:
//   • clouds         — 24s slow drift (background)
//   • back wave band —  4.5s
//   • mid wave band  —  3.2s, reversed
//   • near wave band —  2.4s
//   • ship bob+sway  —  4.0s easing
//   • smoke puffs    — 2.6s rise & fade, three offsets
//   • flag flutter   — 1.4s
//   • progress dots  — 1.4s with stagger
//
// Visibility is fully controlled by the `open` prop. The component also
// stays mounted briefly after open flips false so the fade-out plays.
// =============================================================================

const BRAND_GREEN = '#2D5F3F';
const BRAND_DARK  = '#1F4530';
const BRAND_RED   = '#C0392B';   // matches the 'E' on the Evergreen logo
const HULL_DARK   = '#0F2818';
const PAPER       = '#FFFDF7';
const COPPER      = '#9D6B53';
const SKY_TINT    = '#F4EEDF';

export default function RefreshOverlay({ open, message = 'Refreshing your dashboard…' }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // requestAnimationFrame so the initial paint is opacity 0, then
      // we transition up to opacity 1 — gives a clean fade IN
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 240);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!mounted) return null;

  return createPortal(
    <>
      <style>{`
        /* Cloud drift — long, slow, subtle parallax. Translate by viewport
           width so the loop hides the wrap perfectly. */
        @keyframes esau-cloud-drift {
          from { transform: translateX(0); }
          to   { transform: translateX(-200px); }
        }

        /* Wave bands — tile-translate by 80px (= one wave repeat) so the
           drift is seamless. Different durations per band for parallax. */
        @keyframes esau-wave-drift-back {
          from { transform: translateX(0); }
          to   { transform: translateX(-80px); }
        }
        @keyframes esau-wave-drift-mid {
          from { transform: translateX(-80px); }
          to   { transform: translateX(0); }
        }

        /* Ship bob — gentle vertical bob plus a tiny rocking rotation,
           anchored at the waterline so the rotation reads as a list and
           not a spin. */
        @keyframes esau-ship-bob {
          0%, 100% { transform: translateY(0)    rotate(-0.6deg); }
          50%      { transform: translateY(-3px) rotate( 0.6deg); }
        }

        /* Smoke puffs — rise diagonally and fade. Three puffs share the
           keyframes but use different animation-delay so they leave the
           funnel at different times. */
        @keyframes esau-smoke {
          0%   { transform: translate(0,0)        scale(0.6); opacity: 0; }
          15%  { opacity: 0.55; }
          100% { transform: translate(-22px,-44px) scale(1.6); opacity: 0; }
        }

        /* Pennant flag flutter — quick skew oscillation. */
        @keyframes esau-flag {
          0%, 100% { transform: skewX(0deg)   skewY(0deg); }
          50%      { transform: skewX(-14deg) skewY(2deg); }
        }

        /* Wake foam — wide ellipse fading in/out behind the ship */
        @keyframes esau-wake {
          0%, 100% { opacity: 0.35; transform: scaleX(1); }
          50%      { opacity: 0.6;  transform: scaleX(1.08); }
        }

        /* Progress dots — staggered pulse. */
        @keyframes esau-dot {
          0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
          40%           { opacity: 1;   transform: scale(1.1); }
        }

        /* Sun glow — gentle pulse on opacity. */
        @keyframes esau-sun-glow {
          0%, 100% { opacity: 0.85; }
          50%      { opacity: 1; }
        }

        /* Sun rays — slow rotation around the disc. */
        @keyframes esau-sun-rotate {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
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
          // Soft sky-to-sea gradient — a touch of blue at the top so
          // white clouds and the gold sun read crisply against it,
          // fading down to the warm cream paper colour at sea level.
          background: `linear-gradient(180deg, #DCEAF2 0%, #EFE6D2 45%, ${PAPER} 65%, #F0E9D7 100%)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: visible ? 1 : 0,
          transition: 'opacity 220ms ease',
          pointerEvents: visible ? 'auto' : 'none',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: 'min(540px, 90vw)', textAlign: 'center' }}>
          {/* Seascape SVG — 540 × 220 viewBox, fluid width.
              Layered: sun → clouds → horizon → waves → ship + wake. */}
          <svg
            viewBox="0 0 540 220"
            width="100%"
            height="auto"
            style={{ maxHeight: '240px', display: 'block' }}
            aria-hidden="true"
          >
            <defs>
              {/* Sun radial gradient — bright warm core fading to a soft halo */}
              <radialGradient id="sun-grad" cx="50%" cy="50%" r="50%">
                <stop offset="0%"  stopColor="#FFE08A" />
                <stop offset="55%" stopColor="#F4B860" />
                <stop offset="100%" stopColor="#E89A45" stopOpacity="0.0" />
              </radialGradient>
              {/* Wave pattern — soft serif curve, copper-toned */}
              <pattern id="wave-pat" x="0" y="0" width="80" height="14" patternUnits="userSpaceOnUse">
                <path
                  d="M 0,7 Q 20,0 40,7 T 80,7"
                  fill="none"
                  stroke={COPPER}
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
              </pattern>
              {/* Container colour swatches — alternating greens for variety */}
              <linearGradient id="container-a" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stopColor="#3A7A52" />
                <stop offset="100%" stopColor={BRAND_GREEN} />
              </linearGradient>
              <linearGradient id="container-b" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stopColor={BRAND_GREEN} />
                <stop offset="100%" stopColor={BRAND_DARK} />
              </linearGradient>
              <linearGradient id="hull-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"  stopColor={BRAND_DARK} />
                <stop offset="100%" stopColor={HULL_DARK} />
              </linearGradient>
            </defs>

            {/* Sun — warm gold disc with halo and 8 radiating rays.
                Rays slowly rotate around the sun centre while the disc
                pulses, so the sun feels alive without being distracting. */}
            <g style={{ transformOrigin: '450px 50px', animation: 'esau-sun-rotate 28s linear infinite' }}>
              {/* 8 rays at 45° intervals */}
              {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => (
                <line
                  key={deg}
                  x1="450" y1="50" x2="450" y2="22"
                  stroke="#F4B860" strokeWidth="1.6" strokeLinecap="round" opacity="0.55"
                  transform={`rotate(${deg} 450 50)`}
                />
              ))}
            </g>
            <g style={{ transformOrigin: '450px 50px', animation: 'esau-sun-glow 4.2s ease-in-out infinite' }}>
              {/* Outer halo */}
              <circle cx="450" cy="50" r="22" fill="url(#sun-grad)" />
              {/* Bright core */}
              <circle cx="450" cy="50" r="13" fill="#FFD970" />
              <circle cx="450" cy="50" r="9"  fill="#FFE9A8" />
            </g>

            {/* Clouds — three soft cumulus puffs drifting. The clip-path
                container repeats the cloud group seamlessly via translateX. */}
            <g style={{ animation: 'esau-cloud-drift 24s linear infinite' }}>
              <Cloud x={60}  y={40} scale={1.0} />
              <Cloud x={210} y={30} scale={1.4} />
              <Cloud x={360} y={55} scale={0.9} />
              {/* Duplicate the row 200px to the right so the drift loops seamlessly */}
              <Cloud x={260}  y={40} scale={1.0} />
              <Cloud x={410}  y={30} scale={1.4} />
              <Cloud x={560}  y={55} scale={0.9} />
            </g>

            {/* Horizon line — very soft, just enough to anchor the eye */}
            <line x1="0" y1="118" x2="540" y2="118" stroke={COPPER} strokeWidth="0.5" opacity="0.3" />

            {/* Wake — ellipse behind the ship, fades in and out */}
            <g style={{ transformOrigin: '255px 158px', animation: 'esau-wake 2s ease-in-out infinite' }}>
              <ellipse cx="225" cy="158" rx="60" ry="3" fill={PAPER} opacity="0.7" />
              <ellipse cx="195" cy="160" rx="40" ry="2" fill={PAPER} opacity="0.5" />
            </g>

            {/* SHIP — anchored at viewBox centre then animated. Container
                ship silhouette with stacked green containers, single
                funnel + bridge superstructure, EVERGREEN word on the
                hull. */}
            <g
              style={{
                animation: 'esau-ship-bob 4s ease-in-out infinite',
                transformOrigin: '270px 160px',
              }}
            >
              {/* Hull — long shallow trapezoid */}
              <path
                d="M 192 152 L 348 152 L 336 168 L 204 168 Z"
                fill="url(#hull-grad)"
                stroke={HULL_DARK}
                strokeWidth="0.8"
              />

              {/* EVERGREEN word on the hull */}
              <text
                x="270"
                y="163"
                fontFamily="Calibri, Arial, sans-serif"
                fontSize="6.4"
                fontWeight="700"
                fill={PAPER}
                textAnchor="middle"
                letterSpacing="1.4"
              >
                EVERGREEN
              </text>
              {/* Red E to match the actual logo */}
              <text
                x="241"
                y="163"
                fontFamily="Calibri, Arial, sans-serif"
                fontSize="6.4"
                fontWeight="700"
                fill={BRAND_RED}
                textAnchor="middle"
              >
                E
              </text>

              {/* Container deck — three rows of containers, alternating colour gradients */}
              {/* Bottom row */}
              <g>
                <rect x="200" y="138" width="22" height="14" fill="url(#container-a)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="223" y="138" width="22" height="14" fill="url(#container-b)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="246" y="138" width="22" height="14" fill="url(#container-a)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="269" y="138" width="22" height="14" fill="url(#container-b)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="292" y="138" width="22" height="14" fill="url(#container-a)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="315" y="138" width="22" height="14" fill="url(#container-b)" stroke={HULL_DARK} strokeWidth="0.4" />
              </g>
              {/* Middle row, narrower */}
              <g>
                <rect x="212" y="124" width="22" height="14" fill="url(#container-b)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="235" y="124" width="22" height="14" fill="url(#container-a)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="258" y="124" width="22" height="14" fill="url(#container-b)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="281" y="124" width="22" height="14" fill="url(#container-a)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="304" y="124" width="22" height="14" fill="url(#container-b)" stroke={HULL_DARK} strokeWidth="0.4" />
              </g>
              {/* Top row, narrower still */}
              <g>
                <rect x="224" y="110" width="22" height="14" fill="url(#container-a)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="247" y="110" width="22" height="14" fill="url(#container-b)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="270" y="110" width="22" height="14" fill="url(#container-a)" stroke={HULL_DARK} strokeWidth="0.4" />
                <rect x="293" y="110" width="22" height="14" fill="url(#container-b)" stroke={HULL_DARK} strokeWidth="0.4" />
              </g>

              {/* Bridge — superstructure rear of the ship */}
              <rect x="335" y="120" width="14" height="32" fill={PAPER} stroke={HULL_DARK} strokeWidth="0.6" />
              {/* Bridge windows — tiny ticks */}
              <rect x="337" y="124" width="10" height="2" fill={BRAND_DARK} />
              <rect x="337" y="128" width="10" height="2" fill={BRAND_DARK} />
              <rect x="337" y="132" width="10" height="2" fill={BRAND_DARK} />

              {/* Funnel — black with two horizontal stripes */}
              <rect x="338" y="100" width="8" height="22" fill={HULL_DARK} stroke={HULL_DARK} strokeWidth="0.4" />
              <rect x="338" y="106" width="8" height="2" fill={BRAND_RED} />
              <rect x="338" y="113" width="8" height="2" fill={PAPER} />

              {/* Smoke puffs — three soft circles rising from the funnel */}
              <g style={{ transformOrigin: '342px 100px' }}>
                <circle cx="342" cy="100" r="4" fill={PAPER} opacity="0"
                        style={{ animation: 'esau-smoke 2.6s ease-out 0s   infinite' }} />
                <circle cx="342" cy="100" r="3" fill={PAPER} opacity="0"
                        style={{ animation: 'esau-smoke 2.6s ease-out 0.9s infinite' }} />
                <circle cx="342" cy="100" r="3.5" fill={PAPER} opacity="0"
                        style={{ animation: 'esau-smoke 2.6s ease-out 1.7s infinite' }} />
              </g>

              {/* Bow flag */}
              <line x1="195" y1="148" x2="195" y2="116" stroke={HULL_DARK} strokeWidth="0.8" />
              <g style={{ transformOrigin: '195px 116px', animation: 'esau-flag 1.4s ease-in-out infinite' }}>
                <path d="M 195 116 L 207 119 L 195 122 Z" fill={BRAND_RED} />
              </g>
            </g>

            {/* Wave bands — three layers, parallax. Each is a tiled pattern
                inside a clipping rect so the drift is seamless. The
                pattern repeats every 80px so we translate by exactly that. */}
            <g style={{ animation: 'esau-wave-drift-back 4.5s linear infinite', opacity: 0.6 }}>
              <rect x="-80" y="170" width="700" height="14" fill="url(#wave-pat)" />
            </g>
            <g style={{ animation: 'esau-wave-drift-mid 3.2s linear infinite', opacity: 0.85 }}>
              <rect x="-80" y="184" width="700" height="14" fill="url(#wave-pat)" />
            </g>
            <g style={{ animation: 'esau-wave-drift-back 2.4s linear infinite' }}>
              <rect x="-80" y="198" width="700" height="14" fill="url(#wave-pat)" />
            </g>
          </svg>

          {/* Caption */}
          <div
            style={{
              fontFamily: 'Georgia, serif',
              fontSize: '22px',
              color: '#1F1B16',
              marginTop: '20px',
              fontStyle: 'italic',
              fontWeight: 400,
              letterSpacing: '-0.01em',
            }}
          >
            {message}
          </div>

          {/* Progress dots */}
          <div style={{ marginTop: '14px', display: 'inline-flex', gap: '6px' }}>
            {[0, 1, 2].map(i => (
              <span
                key={i}
                style={{
                  width: '7px',
                  height: '7px',
                  borderRadius: '50%',
                  background: BRAND_GREEN,
                  display: 'inline-block',
                  animation: `esau-dot 1.4s ease-in-out ${i * 0.18}s infinite`,
                }}
              />
            ))}
          </div>

          <div
            style={{
              marginTop: '16px',
              fontSize: '11px',
              color: '#1F1B16',
              opacity: 0.55,
              letterSpacing: '0.18em',
              fontWeight: 700,
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

// ─── helpers ──────────────────────────────────────────────────────────────────
function Cloud({ x, y, scale = 1 }) {
  return (
    <g transform={`translate(${x},${y}) scale(${scale})`}>
      {/* Soft shadow under the cloud — gives a hint of depth */}
      <ellipse cx="14" cy="13" rx="18" ry="3" fill="#A9B5C0" opacity="0.22" />
      {/* Main cloud body — overlapping ellipses for a fluffy silhouette */}
      <ellipse cx="14" cy="6" rx="16" ry="7"  fill="#FFFFFF" opacity="0.96" />
      <ellipse cx="5"  cy="9" rx="8"  ry="6"  fill="#FFFFFF" opacity="0.96" />
      <ellipse cx="24" cy="9" rx="11" ry="6"  fill="#FFFFFF" opacity="0.96" />
      <ellipse cx="14" cy="3" rx="9"  ry="4"  fill="#FFFFFF" opacity="0.96" />
    </g>
  );
}
