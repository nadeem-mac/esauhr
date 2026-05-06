import React, { useEffect, useState, useMemo } from 'react';
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
const PAPER       = '#FFFFFF';
const COPPER      = '#9D6B53';
const SKY_TINT    = '#F2F2F2';

export default function RefreshOverlay({ open, message = 'Made by the HumbleGenius ✨' }) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  // Funny quote pool — Mix of English and Arabic. A fresh random quote
  // is picked every time the overlay opens (useMemo keyed on `open`),
  // so each refresh feels different and gives staff a tiny smile while
  // the ship animation plays. RTL Arabic flips direction at render
  // time via the `lang` flag.
  const quote = useMemo(() => {
    const pool = [
      // English — light, work-flavoured, never punching down
      { lang: 'en', text: 'Coffee first. Decisions later. ☕' },
      { lang: 'en', text: "If at first you don't succeed, hit refresh." },
      { lang: 'en', text: "I'm not lazy, I'm on energy-saving mode. 🔋" },
      { lang: 'en', text: 'Behind every great employee is a refresh button.' },
      { lang: 'en', text: 'Teamwork makes the dream work. 🤝' },
      { lang: 'en', text: 'Mondays exist so we appreciate Fridays. 📅' },
      { lang: 'en', text: 'Hard work pays off later. Coffee pays off now. ☕' },
      { lang: 'en', text: "Out of office. Mostly out of patience. 🌴" },
      { lang: 'en', text: "You can't spell 'productive' without 'duct tape'." },
      { lang: 'en', text: 'Reply-all is a cry for help. 📨' },
      { lang: 'en', text: 'Every spreadsheet is a story waiting to happen. 📊' },
      { lang: 'en', text: 'The meeting could have been an email. 📧' },
      { lang: 'en', text: 'Plot twist: the email could have been silence.' },
      { lang: 'en', text: 'Friday is a feeling. 🎉' },
      { lang: 'en', text: 'Inbox zero is a myth. So is free time. 📮' },
      { lang: 'en', text: 'Be the calm in your own inbox. 🌊' },

      // Arabic — same energy, friendly tone
      { lang: 'ar', text: 'القهوة أولاً، القرارات لاحقاً ☕' },
      { lang: 'ar', text: 'إذا تعطل الجهاز، اضغط تحديث وادعُ بالخير 🤲' },
      { lang: 'ar', text: 'العمل عبادة، والقهوة وقود العبادة ☕' },
      { lang: 'ar', text: 'في الاجتماع: حاضر بالجسد، غائب بالعقل 🧠' },
      { lang: 'ar', text: 'الإيميلات كثيرة، الأعصاب قليلة 📨' },
      { lang: 'ar', text: 'أحياناً النجاح يبدأ بضغطة زر تحديث 🔄' },
      { lang: 'ar', text: 'الجمعة شعور، وليست يوماً 🎉' },
      { lang: 'ar', text: 'الوقت كالسيف، إن لم تقطعه قطعك بالقهوة ☕' },
      { lang: 'ar', text: 'كل جدول بيانات قصة تنتظر أن تُروى 📊' },
      { lang: 'ar', text: 'الاجتماع كان من الممكن أن يكون إيميلاً 📧' },
      { lang: 'ar', text: 'كن هدوء بريدك الإلكتروني 🌊' },
    ];
    return pool[Math.floor(Math.random() * pool.length)];
    // Re-roll every time the overlay opens — the dependency on `open`
    // means a closed-then-opened overlay shows a fresh quote.
  }, [open]);

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

        /* Bird flight — slow drift left to right across the sky. The
           translation distance covers the viewBox width plus padding
           on each side so the bird disappears off-screen and reappears
           cleanly on the other side. */
        @keyframes esau-bird-fly-left {
          from { transform: translateX(540px); }
          to   { transform: translateX(-80px); }
        }
        @keyframes esau-bird-fly-right {
          from { transform: translateX(-80px); }
          to   { transform: translateX(540px); }
        }
        /* Wing flap — quick scaleY oscillation on the wing path so
           the seagull "M" shape opens and closes as it flies. The
           transform-box: fill-box keeps the scale anchored to the
           bird's centre instead of the SVG origin. */
        @keyframes esau-bird-flap {
          0%, 100% { transform: scaleY(1); }
          50%      { transform: scaleY(0.55); }
        }
        /* Vertical bob — birds dip and rise gently as they fly so
           the path doesn't look mechanical. Slower than the flap. */
        @keyframes esau-bird-bob {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(4px); }
        }

        /* Credit-line wave — each letter bobs up and down on a
           staggered timing so the whole "Made with ✨ by the
           HumbleGenius" phrase undulates like a banner in the
           breeze. The animation-delay is set inline per letter
           so each one starts at a slightly later offset. */
        @keyframes esau-credit-wave {
          0%, 100% { transform: translateY(0); }
          50%      { transform: translateY(-5px); }
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

            {/* Birds — three seagulls drift across the sky at different
                heights and speeds. Each bird is a wrapper <g> doing the
                horizontal traversal, an inner <g> doing the slow vertical
                bob, and the wing path itself doing the rapid wing flap.
                Two fly left, one flies right so the sky has cross-traffic
                like a real coastline. Wing-flap speed varies per bird so
                the flock doesn't beat in lock-step. */}
            {/* Bird 1 — high left-drifter, slow flap */}
            <g style={{ animation: 'esau-bird-fly-left 14s linear infinite' }}>
              <g style={{ transformOrigin: '0 0', animation: 'esau-bird-bob 2.6s ease-in-out infinite' }}>
                <g
                  style={{
                    transformBox: 'fill-box',
                    transformOrigin: 'center',
                    animation: 'esau-bird-flap 0.55s ease-in-out infinite',
                  }}
                >
                  <path d="M -8 18 Q -4 12 0 18 Q 4 12 8 18" stroke="#5C4A2E" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
                </g>
              </g>
            </g>
            {/* Bird 2 — mid-altitude right-drifter, faster flap. The
                negative scaleX flips the silhouette so the bird "faces"
                its direction of travel. */}
            <g style={{ animation: 'esau-bird-fly-right 17s linear infinite', animationDelay: '-3s' }}>
              <g style={{ transformOrigin: '0 0', animation: 'esau-bird-bob 2.2s ease-in-out infinite', transform: 'translateY(45px)' }}>
                <g
                  style={{
                    transformBox: 'fill-box',
                    transformOrigin: 'center',
                    animation: 'esau-bird-flap 0.42s ease-in-out infinite',
                  }}
                >
                  <path d="M -7 0 Q -3.5 -5 0 0 Q 3.5 -5 7 0" stroke="#5C4A2E" strokeWidth="1.3" fill="none" strokeLinecap="round"/>
                </g>
              </g>
            </g>
            {/* Bird 3 — lower left-drifter, smallest, fastest flap.
                Slight delay so it crosses the sky out of sync with bird 1. */}
            <g style={{ animation: 'esau-bird-fly-left 11s linear infinite', animationDelay: '-7s' }}>
              <g style={{ transformOrigin: '0 0', animation: 'esau-bird-bob 1.8s ease-in-out infinite', transform: 'translateY(78px)' }}>
                <g
                  style={{
                    transformBox: 'fill-box',
                    transformOrigin: 'center',
                    animation: 'esau-bird-flap 0.38s ease-in-out infinite',
                  }}
                >
                  <path d="M -5 0 Q -2.5 -3.5 0 0 Q 2.5 -3.5 5 0" stroke="#5C4A2E" strokeWidth="1.1" fill="none" strokeLinecap="round" opacity="0.85"/>
                </g>
              </g>
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

          {/* Main caption — was "Refreshing your dashboard…", now the
              author credit with a per-letter wave. Per Nadeem:
              "instead of refreshing your dashboard, mention made by
              the HumbleGenius". Each letter bobs on a staggered
              60ms delay so the whole line waves like a flag. */}
          {(() => {
            const credit = 'Made by the HumbleGenius ✨';
            const chars = Array.from(credit);
            return (
              <div
                style={{
                  marginTop: '20px',
                  fontSize: '24px',
                  color: '#0A0A0A',
                  fontWeight: 700,
                  letterSpacing: '-0.005em',
                  fontFamily: 'Georgia, serif',
                  fontStyle: 'italic',
                  display: 'inline-flex',
                  flexWrap: 'wrap',
                  justifyContent: 'center',
                  alignItems: 'center',
                  gap: '0px',
                }}
                aria-label="Made by the HumbleGenius"
              >
                {chars.map((ch, i) => {
                  const isSpace = ch === ' ';
                  return (
                    <span
                      key={i}
                      aria-hidden="true"
                      style={{
                        display: 'inline-block',
                        whiteSpace: 'pre',
                        animation: 'esau-credit-wave 1.6s ease-in-out infinite',
                        animationDelay: `${i * 0.06}s`,
                        fontSize: ch === '✨' ? '26px' : 'inherit',
                      }}
                    >
                      {isSpace ? '\u00A0' : ch}
                    </span>
                  );
                })}
              </div>
            );
          })()}

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

          {/* Funny quote — random English or Arabic, picked once per
              overlay open. Per Nadeem: "in bottom make funny quotes
              to make staff smile, use random english and arabic
              time to time". */}
          <div
            style={{
              marginTop: '20px',
              maxWidth: '440px',
              fontSize: '13px',
              color: '#1F1B16',
              opacity: 0.7,
              fontStyle: 'italic',
              fontFamily: quote.lang === 'ar'
                ? '"Segoe UI", "Tahoma", Georgia, serif'
                : 'Georgia, serif',
              direction: quote.lang === 'ar' ? 'rtl' : 'ltr',
              lineHeight: 1.45,
              padding: '0 16px',
            }}
          >
            "{quote.text}"
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
