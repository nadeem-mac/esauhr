// =============================================================================
// RecentAcceptancesBanner.jsx
//
// Top-of-page banner stack that announces recent candidate
// acceptances to the Hiring team (Bashaier, Nadeem, and the
// read-only SUP viewers — Badria, Fahad Sulaiman, Jaffar). Per
// Nadeem: when a candidate accepts an offer, the team needs a
// visible cue that stays for 15 days from the acceptance.
//
// VISIBILITY RULES
//   An acceptance shows in the banner when ALL of these hold:
//     1. offer.status === 'offer_accepted'
//        (psn_issued, declined, withdrawn, etc. naturally drop
//        out — once HR has issued the PSN the workflow is done
//        and the banner auto-hides)
//     2. now - offer.responded_at  <  15 days
//     3. The current user hasn't dismissed THIS specific offer
//
// Once any of those flip the banner disappears for the user.
//
// PER-USER DISMISSAL
//   Stored in localStorage keyed by user PSN + offer id:
//     esau_acc_dismiss_<userId>_<offerId> = ISO timestamp
//   Per-user means Bashaier dismissing on her laptop doesn't
//   affect Nadeem's view, which is what we want — they may both
//   need to react to the acceptance independently. Trade-off:
//   dismissals don't sync across the same user's devices. For
//   a 15-day-max banner that's acceptable.
//
// REALTIME
//   No realtime sub of its own — relies on OffersCard's existing
//   debounced realtime channel to refetch on any offer_letters
//   change. When a candidate accepts, OffersCard's load(true)
//   fires within ~600ms and the new acceptance flows into our
//   props. So "as soon as the staff accepts" is satisfied without
//   any extra plumbing here.
//
// LAYOUT
//   One row per active acceptance, stacked vertically. Green
//   branded card. Each row shows: candidate name, position,
//   department, "accepted X ago", and a small Dismiss button.
//   Hidden entirely when there are no qualifying acceptances
//   (returns null) so the section doesn't reserve empty space.
// =============================================================================

import React, { useMemo, useState, useEffect } from 'react';
import { Sparkles, X, Clock } from 'lucide-react';

// 15-day window per Nadeem's spec.
const ACTIVE_WINDOW_DAYS = 15;
const ACTIVE_WINDOW_MS = ACTIVE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

const dismissKey = (userId, offerId) =>
  `esau_acc_dismiss_${userId || 'anon'}_${offerId}`;

export default function RecentAcceptancesBanner({ offers, me }) {
  // Local state mirroring localStorage, so dismissing instantly hides
  // the banner without forcing a re-read. Re-syncs on prop change in
  // case another tab dismissed something.
  const [dismissedSet, setDismissedSet] = useState(() => loadDismissed(me?.id, offers));

  useEffect(() => {
    setDismissedSet(loadDismissed(me?.id, offers));
  }, [me?.id, offers]);

  // Filter to acceptances within the 15-day window that this user
  // hasn't dismissed. Sorted newest-first so the freshest acceptance
  // is at the top of the stack.
  const activeAcceptances = useMemo(() => {
    if (!Array.isArray(offers) || offers.length === 0) return [];
    const cutoff = Date.now() - ACTIVE_WINDOW_MS;
    return offers
      .filter(o => o.status === 'offer_accepted')
      .filter(o => o.responded_at && new Date(o.responded_at).getTime() >= cutoff)
      .filter(o => !dismissedSet.has(o.id))
      .sort((a, b) => new Date(b.responded_at) - new Date(a.responded_at));
  }, [offers, dismissedSet]);

  function dismiss(offerId) {
    if (!me?.id) return;
    try {
      localStorage.setItem(dismissKey(me.id, offerId), new Date().toISOString());
    } catch {
      // localStorage might be disabled in private mode — silently fall
      // back to in-memory dismissal so the UX still works for the
      // current session.
    }
    setDismissedSet(prev => {
      const next = new Set(prev);
      next.add(offerId);
      return next;
    });
  }

  if (activeAcceptances.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
      {activeAcceptances.map(offer => (
        <AcceptanceRow key={offer.id} offer={offer} onDismiss={() => dismiss(offer.id)} />
      ))}
    </div>
  );
}

// ─── One row per acceptance ───────────────────────────────────────
function AcceptanceRow({ offer, onDismiss }) {
  const respondedDate = offer.responded_at ? new Date(offer.responded_at) : null;
  const ago = respondedDate ? formatTimeAgo(respondedDate) : '';
  const remainingDays = respondedDate
    ? Math.max(0, ACTIVE_WINDOW_DAYS - Math.floor((Date.now() - respondedDate.getTime()) / (24 * 60 * 60 * 1000)))
    : 0;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: 'linear-gradient(90deg, #ECFDF3 0%, #F0FDF4 100%)',
        border: '1.5px solid #0F4C2A',
        borderRadius: 12,
        padding: '14px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        boxShadow: '0 2px 10px rgba(15, 76, 42, 0.08)',
      }}
    >
      {/* Sparkles icon — green disc on the left signals "celebratory
          news worth attention" without being a noisy red urgent dot. */}
      <div style={{
        flexShrink: 0,
        width: 36,
        height: 36,
        borderRadius: '50%',
        background: '#0F4C2A',
        color: '#FFFFFF',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}>
        <Sparkles className="w-4 h-4" />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.18em', color: '#0F4C2A', marginBottom: 2 }}>
          OFFER ACCEPTED
        </div>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#0A0A0A', lineHeight: 1.3 }}>
          {offer.candidate_name || 'Candidate'}
          {offer.position_title && (
            <span style={{ fontWeight: 400, color: '#1F1B16' }}>
              {' — '}{offer.position_title}
            </span>
          )}
          {offer.department && (
            <span style={{ fontWeight: 400, color: '#1F1B16', opacity: 0.7 }}>
              {' · '}{offer.department}
            </span>
          )}
        </div>
        <div style={{
          fontSize: 11,
          color: '#0A0A0A',
          opacity: 0.7,
          marginTop: 3,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          flexWrap: 'wrap',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Clock className="w-3 h-3" /> Accepted {ago}
          </span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>Banner stays for {remainingDays} more {remainingDays === 1 ? 'day' : 'days'}</span>
        </div>
      </div>

      <button
        onClick={onDismiss}
        title="Dismiss this notification (only for you)"
        aria-label="Dismiss"
        style={{
          flexShrink: 0,
          background: 'transparent',
          border: '1px solid rgba(15, 76, 42, 0.3)',
          color: '#0F4C2A',
          padding: '6px 10px',
          fontSize: 11,
          fontWeight: 500,
          cursor: 'pointer',
          borderRadius: 6,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <X className="w-3 h-3" />
        Dismiss
      </button>
    </div>
  );
}

// ─── Helpers ───────────────────────────────────────────────────────

// Build the initial dismissed-set from localStorage. We pre-seed by
// reading every offer ID's dismissal key rather than scanning all
// localStorage keys — bounded by the offers list size and avoids
// touching unrelated keys.
function loadDismissed(userId, offers) {
  const set = new Set();
  if (!userId || !Array.isArray(offers)) return set;
  try {
    for (const o of offers) {
      if (!o?.id) continue;
      const v = localStorage.getItem(dismissKey(userId, o.id));
      if (v) set.add(o.id);
    }
  } catch {
    // localStorage unavailable; return empty set
  }
  return set;
}

function formatTimeAgo(date) {
  const ms = Date.now() - date.getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`;
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
