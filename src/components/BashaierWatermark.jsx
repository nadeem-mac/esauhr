import React, { useState, useEffect } from 'react';

// =============================================================================
// BashaierWatermark
//
// Whimsical flying fairy shown ONLY for Bashaier (H94830). The 🧚 emoji
// swirls across the page every so often — wings fluttering — leaving a dense
// weaving trail of twinkling stars. Decorative only: fixed, pointer-events
// off, disabled under reduced-motion.
// =============================================================================

const FLY_MS = 9000;

// Dense star trail. y weaves with a sine wave so the sprinkle follows the
// fairy's swirling path rather than a straight line. Each star's delay is
// timed to roughly when she sweeps past that x.
const STARS = [];
{
  let idx = 0;
  for (let x = 1; x <= 99; x += 1.8) {
    const wave = Math.sin((x / 99) * Math.PI * 3) * 16;     // weave ±16vh
    const baseY = 50 - 0.28 * (x - 50) + wave;
    const delay = (x / 99) * (FLY_MS / 1000);
    const count = 4 + (idx % 2 === 0 ? 2 : 1);              // 5–6 per step
    for (let k = 0; k < count; k++) {
      const spreadY = (((idx * 7 + k * 13) % 19) - 9) + (k === 1 ? -13 : k === 2 ? 13 : 0);
      const spreadX = (((idx * 5 + k * 9) % 9) - 4);
      STARS.push({
        x: x + spreadX,
        y: Math.max(1, Math.min(96, baseY + spreadY)),
        delay: delay + k * 0.06,
        size: 10 + ((idx + k) % 5) * 6,
        key: `s${idx}_${k}`,
      });
    }
    idx++;
  }
}

function Star({ size }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M12 0l2.9 8.2L23 11l-8.1 2.8L12 24l-2.9-10.2L1 11l8.1-2.8z" fill="#F6C544" />
      <circle cx="12" cy="11.5" r="2" fill="#FFF6D6" />
    </svg>
  );
}

export default function BashaierWatermark() {
  const [flying, setFlying] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined'
        && window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return; // respect reduced-motion — no flights
    }
    let startTimer, endTimer;
    const schedule = () => {
      const delay = 80000 + Math.random() * 70000; // every ~80–150s
      startTimer = setTimeout(() => {
        setFlying(true);
        endTimer = setTimeout(() => { setFlying(false); schedule(); }, FLY_MS + 2800);
      }, delay);
    };
    schedule();
    return () => { clearTimeout(startTimer); clearTimeout(endTimer); };
  }, []);

  if (!flying) return null;

  return (
    <div aria-hidden="true"
         style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 45, overflow: 'hidden' }}>
      <style>{`
        /* Swirling flight path — weaves up and down while crossing, with
           rolling rotation, instead of a straight corner-to-corner line. */
        @keyframes bwSwirl {
          0%   { transform: translate(-16vw, 86vh) rotate(0deg)   scale(0.7); opacity: 0; }
          8%   { opacity: 1; }
          18%  { transform: translate(10vw, 52vh)  rotate(-22deg) scale(1.0); }
          30%  { transform: translate(26vw, 72vh)  rotate(14deg)  scale(0.95); }
          43%  { transform: translate(44vw, 34vh)  rotate(-26deg) scale(1.05); }
          56%  { transform: translate(60vw, 60vh)  rotate(18deg)  scale(1.0); }
          69%  { transform: translate(76vw, 26vh)  rotate(-20deg) scale(1.05); }
          82%  { transform: translate(92vw, 48vh)  rotate(12deg)  scale(1.0); }
          92%  { opacity: 1; }
          100% { transform: translate(122vw, 6vh)  rotate(-8deg)  scale(0.82); opacity: 0; }
        }
        /* Wing flap — fast flutter (narrow/widen + tiny roll) layered on the
           inner element so it runs independently of the flight path. */
        @keyframes bwFlap {
          0%, 100% { transform: scaleX(1)    rotate(0deg); }
          50%      { transform: scaleX(0.74) rotate(-5deg); }
        }
        @keyframes bwTwinkle {
          0%   { opacity: 0; transform: scale(0.2) rotate(0deg); }
          25%  { opacity: 1; transform: scale(1.1) rotate(25deg); }
          60%  { opacity: 1; transform: scale(0.95) rotate(45deg); }
          100% { opacity: 0; transform: scale(0.5) rotate(70deg); }
        }
        .bw-pixie {
          position: fixed; top: 0; left: 0;
          will-change: transform, opacity;
          animation: bwSwirl ${FLY_MS}ms ease-in-out forwards;
        }
        .bw-flap {
          display: inline-block;
          font-size: 132px; line-height: 1;
          filter: drop-shadow(0 5px 12px rgba(153,53,86,0.35));
          animation: bwFlap 0.28s ease-in-out infinite;
        }
        .bw-star {
          position: fixed;
          opacity: 0;
          filter: drop-shadow(0 0 4px rgba(246,197,68,0.9));
          animation: bwTwinkle 2.4s ease-out forwards;
        }
      `}</style>

      {STARS.map(s => (
        <span key={s.key} className="bw-star"
              style={{ left: `${s.x}vw`, top: `${s.y}vh`, animationDelay: `${s.delay}s` }}>
          <Star size={s.size} />
        </span>
      ))}

      <span className="bw-pixie"><span className="bw-flap">🧚‍♀️</span></span>
    </div>
  );
}
