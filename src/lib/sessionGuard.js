// ──────────────────────────────────────────────────────────────────────
//  useSessionGuard — enforces single-session login + auto-logout on idle
//
//  Two concerns wrapped into one hook so AppShell only has to install
//  it once with the current `me` and `signOut` callback.
//
//  Nadeem 2026-05-21: 'staff should auto logout if system is not used
//  more then 10 mins, if the staff is logged in in one place he cannot
//  login in another place'
//
//  ── SINGLE SESSION ───────────────────────────────────────────────────
//  Each successful login (Auth.jsx) generates a UUID, writes it to
//  employees.current_session_id, and stores the same UUID in this
//  browser's localStorage under 'esau_session_id'.
//
//  On mount + every POLL_MS (default 30s), this hook re-fetches
//  employees.current_session_id for the logged-in PSN and compares.
//  Mismatch → kick the older session via signOut().
//
//  The first session ever (NULL in DB) gets adopted: we write the
//  local UUID to the DB without kicking. Prevents the migration
//  itself from logging everyone out.
//
//  ── IDLE LOGOUT ──────────────────────────────────────────────────────
//  Listens for mousedown / keydown / touchstart / scroll / wheel /
//  pointermove on document. Each event resets a 10-minute timer
//  (IDLE_MS). On expiry → signOut().
//
//  Tabs in the same browser share localStorage so they all see the
//  same session_id; idle is per-tab but resetting in one tab doesn't
//  reset the other. Closing the laptop lid pauses the timer
//  (setTimeout doesn't fire while sleeping); on wake, it fires the
//  expiry immediately if the deadline has passed → signOut.
// ──────────────────────────────────────────────────────────────────────

import { useEffect, useRef } from 'react';
import { directGet, directPatch } from '../supabaseClient.js';

const IDLE_MS = 10 * 60 * 1000;   // 10 minutes
const POLL_MS = 30 * 1000;        // 30 seconds — single-session check

const ACTIVITY_EVENTS = [
  'mousedown',
  'keydown',
  'touchstart',
  'scroll',
  'wheel',
  'pointermove',
];

export function useSessionGuard(me, signOut) {
  const idleTimerRef = useRef(null);
  const pollTimerRef = useRef(null);

  useEffect(() => {
    if (!me?.id) return;

    let cancelled = false;

    const kick = (reason) => {
      console.warn(`[sessionGuard] forcing signOut: ${reason}`);
      // NOTE: do NOT remove 'esau_session_id' here. localStorage is shared
      // across all tabs of the same browser, so clearing it makes sibling
      // tabs see "no local session" and kick themselves → cascade logout.
      // The explicit Logout button (AppShell) clears it for a full sign-out.
      signOut?.();
    };

    // ── Single-session enforcement ──────────────────────────────────
    const checkSession = async () => {
      if (cancelled) return;
      const local = (() => {
        try { return localStorage.getItem('esau_session_id'); } catch { return null; }
      })();

      try {
        const rows = await directGet('employees',
          `select=current_session_id&id=eq.${encodeURIComponent(me.id)}&limit=1`,
          { timeoutMs: 8000 });
        if (cancelled) return;
        const remote = rows?.[0]?.current_session_id || null;

        if (!local && remote) {
          // No local UUID but the server has one. On the same browser this
          // means a sibling tab cleared the shared key, or we're in a
          // private window — NOT a competing device (a real other device
          // brings its own local UUID and trips the mismatch branch below).
          // So adopt the server's id rather than kicking — stops same-browser
          // tabs fighting each other. (Nadeem 2026-06-08)
          try { localStorage.setItem('esau_session_id', remote); } catch { /* private mode */ }
          return;
        }
        if (local && !remote) {
          // Remote was cleared (admin reset / migration / signOut
          // by another tab). Adopt by writing ours back.
          await directPatch('employees', 'id', me.id, {
            current_session_id: local,
            current_session_at: new Date().toISOString(),
          });
          return;
        }
        if (local && remote && local !== remote) {
          // A newer login on another device wrote a different UUID.
          // We're the stale one. Kick.
          kick('session UUID mismatch — newer login elsewhere');
        }
      } catch (e) {
        // Network blip — don't kick. We'll try again on next poll.
        console.warn('[sessionGuard] poll error:', e?.message || e);
      }
    };

    // First check immediately, then on interval.
    checkSession();
    pollTimerRef.current = setInterval(checkSession, POLL_MS);

    // ── Idle-logout enforcement ─────────────────────────────────────
    const resetIdleTimer = () => {
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(() => {
        kick('idle timeout (10 min)');
      }, IDLE_MS);
    };

    ACTIVITY_EVENTS.forEach(ev => {
      window.addEventListener(ev, resetIdleTimer, { passive: true });
    });
    resetIdleTimer(); // start the clock

    return () => {
      cancelled = true;
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      ACTIVITY_EVENTS.forEach(ev => {
        window.removeEventListener(ev, resetIdleTimer);
      });
    };
  }, [me?.id, signOut]);
}
