import React, { useEffect, useState } from 'react';

// =============================================================================
// BashaierWatermark
//
// A soft, whimsical background watermark shown ONLY for Bashaier (H94830) —
// an original flying-pixie silhouette (not any trademarked character) that
// matches her fairy (🧚) theme. It rests faintly in the corner and, every
// minute or so, takes a gentle flight across the page leaving a little
// pixie-dust trail. Purely decorative: fixed, behind/over content with
// pointer-events disabled, and disabled entirely under reduced-motion.
// =============================================================================

const PINK = '#993556';

function PixieSprite({ style, className }) {
  // Original stylised flying-fairy silhouette + pixie-dust trail.
  return (
    <svg viewBox="0 0 260 170" className={className} style={style} aria-hidden="true">
      <g fill="currentColor">
        {/* pixie-dust trail (lower-left → behind the figure) */}
        <g className="bw-dust">
          <circle cx="14"  cy="150" r="2" />
          <circle cx="34"  cy="140" r="2.6" />
          <circle cx="54"  cy="131" r="1.8" />
          <path d="M74 124 l2.2 4.6 4.8 .7-3.5 3.4 .8 4.9-4.3-2.4-4.3 2.4 .8-4.9-3.5-3.4 4.8-.7z" />
          <circle cx="98"  cy="112" r="2.2" />
          <circle cx="116" cy="106" r="1.6" />
          <path d="M132 96 l1.8 3.8 4 .6-2.9 2.8 .7 4-3.6-2-3.6 2 .7-4-2.9-2.8 4-.6z" />
        </g>
        {/* wing */}
        <path d="M150 70 q-30 -18 -44 4 q22 16 44 6 z" opacity="0.55" />
        {/* torso, leaning forward in flight */}
        <path d="M150 64 q20 -10 40 -4 q6 2 8 8 q-4 10 -16 11 q-18 3 -30 -7 q-6 -5 -2 -8 z" />
        {/* trailing leg */}
        <path d="M150 74 q-14 8 -30 8 q-4 0 -3 -4 q14 -6 28 -10 z" />
        {/* forward arm reaching up */}
        <path d="M188 58 q14 -10 26 -22 q4 4 1 8 q-10 12 -22 20 q-6 3 -5 -6 z" />
        {/* head + little tuft */}
        <circle cx="206" cy="40" r="11" />
        <path d="M214 31 q8 -6 12 -2 q-3 6 -11 7 z" />
        {/* sparkle at fingertip */}
        <path d="M216 22 l2 4.4 4.6 .7-3.3 3.2 .8 4.6-4.1-2.2-4.1 2.2 .8-4.6-3.3-3.2 4.6-.7z" opacity="0.9" />
      </g>
    </svg>
  );
}

export default function BashaierWatermark() {
  const [flying, setFlying] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined'
        && window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return; // respect reduced-motion — rest only, no flights
    }
    let startTimer, endTimer;
    const schedule = () => {
      const delay = 50000 + Math.random() * 50000; // every 50–100s
      startTimer = setTimeout(() => {
        setFlying(true);
        endTimer = setTimeout(() => { setFlying(false); schedule(); }, 8200);
      }, delay);
    };
    schedule();
    return () => { clearTimeout(startTimer); clearTimeout(endTimer); };
  }, []);

  return (
    <div aria-hidden="true"
         style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
      <style>{`
        @keyframes bwFloat {
          0%, 100% { transform: translateY(0) rotate(-4deg); }
          50%      { transform: translateY(-14px) rotate(-1deg); }
        }
        @keyframes bwDust {
          0%, 100% { opacity: 0.45; }
          50%      { opacity: 1; }
        }
        @keyframes bwFly {
          0%   { transform: translate(-20vw, 80vh) rotate(-6deg) scale(0.78); opacity: 0; }
          12%  { opacity: 0.16; }
          35%  { transform: translate(28vw, 44vh) rotate(-13deg) scale(0.92); }
          60%  { transform: translate(58vw, 26vh) rotate(-7deg)  scale(1);    }
          88%  { opacity: 0.16; }
          100% { transform: translate(118vw, -14vh) rotate(-5deg) scale(0.82); opacity: 0; }
        }
        .bw-rest {
          position: fixed; right: 3vw; bottom: 4vh; width: 230px; height: auto;
          color: ${PINK}; opacity: 0.06;
          animation: bwFloat 7s ease-in-out infinite;
        }
        .bw-fly {
          position: fixed; top: 0; left: 0; width: 170px; height: auto;
          color: ${PINK}; opacity: 0; will-change: transform, opacity;
          animation: bwFly 8.2s ease-in-out forwards;
          z-index: 40;
        }
        .bw-dust { animation: bwDust 2.4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .bw-rest { animation: none; }
          .bw-dust { animation: none; }
        }
      `}</style>

      {/* resting watermark, lower-right */}
      <PixieSprite className="bw-rest" />

      {/* occasional flight across the page */}
      {flying && <PixieSprite className="bw-fly" />}
    </div>
  );
}
