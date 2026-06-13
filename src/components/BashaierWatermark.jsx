import React, { useEffect, useState } from 'react';

// =============================================================================
// BashaierWatermark
//
// A whimsical flying-pixie animation shown ONLY for Bashaier (H94830) on
// every page. An original little fairy/sprite (not any trademarked
// character) flies across the page every so often, leaving a trail of
// twinkling stars behind. Purely decorative: fixed, pointer-events off,
// and disabled under reduced-motion.
// =============================================================================

// Stars sprinkled along the flight path. x in vw; y follows the swoop; the
// delay is timed so each star twinkles just as the sprite passes it.
const FLY_MS = 8200;
const STAR_XS = [4, 15, 26, 37, 48, 59, 70, 81, 92];
const STARS = STAR_XS.map((x, i) => {
  const y = 78 - 0.7 * (x + 20);                 // roughly along the path (vh)
  const delay = ((x + 20) / 138) * (FLY_MS / 1000); // seconds
  const size = 9 + (i % 3) * 4;
  return { x, y: Math.max(2, y), delay, size, key: `s${i}` };
});

function Star({ size }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M12 0l2.9 8.2L23 11l-8.1 2.8L12 24l-2.9-10.2L1 11l8.1-2.8z" fill="#F6C544" />
      <circle cx="12" cy="11.5" r="2" fill="#FFF6D6" />
    </svg>
  );
}

function Pixie() {
  // Original stylised flying fairy — green tunic, peach skin, little cap
  // with a pink feather, gold sparkle wand. Flying toward the upper-right.
  return (
    <svg viewBox="0 0 260 170" width="118" height="77" aria-hidden="true"
         style={{ filter: 'drop-shadow(0 3px 7px rgba(153,53,86,0.30))' }}>
      {/* wing */}
      <path d="M150 70 q-34 -22 -50 2 q24 20 50 8 z" fill="#FFFFFF" opacity="0.7" />
      <path d="M150 74 q-30 6 -46 26 q26 6 46 -12 z" fill="#FFFFFF" opacity="0.5" />
      {/* trailing leg */}
      <path d="M150 78 q-16 10 -34 10 q-5 0 -4 -5 q16 -7 32 -12 z" fill="#2F7D4F" />
      <path d="M150 82 q-10 12 -24 18 q-4 1 -4 -4 q12 -9 22 -18 z" fill="#2F7D4F" />
      {/* tunic / body */}
      <path d="M150 62 q22 -11 44 -4 q7 2 9 9 q-4 12 -18 13 q-20 3 -33 -8 q-7 -6 -2 -10 z" fill="#36925E" />
      <path d="M188 66 q8 4 6 12 q-10 3 -18 -1 q6 -7 12 -11 z" fill="#2F7D4F" />
      {/* forward arm */}
      <path d="M190 58 q15 -11 28 -24 q5 4 1 9 q-11 13 -24 22 q-7 3 -5 -7 z" fill="#F2C9A5" />
      {/* head */}
      <circle cx="208" cy="40" r="12" fill="#F4CDAA" />
      {/* cap + feather */}
      <path d="M196 36 q10 -16 26 -10 q-2 9 -10 12 q-9 3 -16 -2 z" fill="#2F7D4F" />
      <path d="M220 24 q9 -3 13 1 q-5 6 -13 6 z" fill="#C9466B" />
      {/* sparkle at fingertip */}
      <path d="M216 18 l2.6 5.6 6 .9-4.3 4.2 1 6-5.3-2.8-5.3 2.8 1-6-4.3-4.2 6-.9z" fill="#F6C544" />
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
      const delay = 32000 + Math.random() * 40000; // every 32–72s
      startTimer = setTimeout(() => {
        setFlying(true);
        endTimer = setTimeout(() => { setFlying(false); schedule(); }, FLY_MS + 400);
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
        @keyframes bwFly {
          0%   { transform: translate(-20vw, 80vh) rotate(-6deg)  scale(0.85); opacity: 0; }
          10%  { opacity: 1; }
          35%  { transform: translate(28vw, 44vh) rotate(-13deg) scale(1.0); }
          60%  { transform: translate(58vw, 26vh) rotate(-7deg)  scale(1.05); }
          90%  { opacity: 1; }
          100% { transform: translate(120vw, -16vh) rotate(-4deg) scale(0.9); opacity: 0; }
        }
        @keyframes bwTwinkle {
          0%   { opacity: 0; transform: scale(0.3) rotate(0deg); }
          30%  { opacity: 1; transform: scale(1)   rotate(25deg); }
          100% { opacity: 0; transform: scale(0.5) rotate(60deg); }
        }
        .bw-pixie {
          position: fixed; top: 0; left: 0;
          will-change: transform, opacity;
          animation: bwFly ${FLY_MS}ms ease-in-out forwards;
        }
        .bw-star {
          position: fixed;
          opacity: 0;
          animation: bwTwinkle 1.6s ease-out forwards;
        }
      `}</style>

      {STARS.map(s => (
        <span key={s.key} className="bw-star"
              style={{ left: `${s.x}vw`, top: `${s.y}vh`, animationDelay: `${s.delay}s` }}>
          <Star size={s.size} />
        </span>
      ))}

      <span className="bw-pixie"><Pixie /></span>
    </div>
  );
}
