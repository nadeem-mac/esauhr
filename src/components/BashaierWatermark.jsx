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

// Stars sprinkled along the flight path — a rich, scattered trail. Each is
// timed (delay) so it twinkles just as the sprite sweeps past it.
const FLY_MS = 8200;
const STARS = [];
{
  let idx = 0;
  for (let x = 1; x <= 99; x += 2.2) {
    const baseY = 78 - 0.7 * (x + 20);                  // along the swoop (vh)
    const delay = ((x + 20) / 138) * (FLY_MS / 1000);   // seconds
    const count = 3 + (idx % 2 === 0 ? 2 : 1);          // 4–5 stars per step
    for (let k = 0; k < count; k++) {
      const spreadY = (((idx * 7 + k * 13) % 15) - 7) + (k === 1 ? -11 : k === 2 ? 11 : k === 3 ? -5 : 0);
      const spreadX = (((idx * 5 + k * 9) % 9) - 4);
      STARS.push({
        x: x + spreadX,
        y: Math.max(1, baseY + spreadY),
        delay: delay + k * 0.08,
        size: 6 + ((idx + k) % 5) * 5,
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

function Pixie() {
  // Bashaier's fairy — the 🧚 emoji, flying with a soft glow.
  return (
    <span style={{
      fontSize: '132px', lineHeight: 1, display: 'inline-block',
      filter: 'drop-shadow(0 5px 12px rgba(153,53,86,0.35))',
    }}>
      🧚‍♀️
    </span>
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
