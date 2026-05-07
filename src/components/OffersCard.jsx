// =============================================================================
// OffersCard.jsx
//
// HR-side dashboard card showing all offers in flight, with:
//   • Quick-stats header (offers awaiting acceptance, accepted-pending-PSN,
//     about-to-expire)
//   • "New offer" button → opens NewOfferModal
//   • Filterable list of offers grouped by status
//   • Per-offer actions: copy acceptance link, withdraw offer, mark
//     PSN issued (records the SOL outcome and creates the employee row)
//
// Subscribes to offer_letters realtime so a freshly-created offer
// shows up across all admin/HR sessions without refresh. Auto-hides
// when there are no offers and the user closes the (only) inline
// "no offers" state — keeps the dashboard from showing a permanent
// empty card to teams that aren't actively hiring.
// =============================================================================

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  UserPlus, Plus, Copy, X, Loader2, RefreshCw, Mail, FileCheck2,
  AlertTriangle, Calendar, Clock, ChevronDown, ChevronRight, FileText, Eye,
  Send, Trash2,
} from 'lucide-react';
import { directGet, directPatch, directPatchQuery, supabase } from '../supabaseClient.js';
import NewOfferModal from './NewOfferModal.jsx';
import IssuePsnModal from './IssuePsnModal.jsx';
import LetterPreviewModal from './LetterPreviewModal.jsx';
import SuccessToast from './SuccessToast.jsx';
import RecentAcceptancesBanner from './RecentAcceptancesBanner.jsx';
import { buildOfferEmailBody } from '../lib/offerLetterGenerator.js';

// ─── Status presentation ──────────────────────────────────────────
// One source of truth for how each offer status renders. label is
// the short pill text; color is the badge fill; description is the
// subtle line under the candidate's name.
const STATUS_PRESENTATION = {
  draft: {
    label: 'Draft',
    bg: '#F5F5F5', fg: '#525252', border: '#D4D4D4',
    description: 'Not yet sent.',
  },
  offer_sent: {
    label: 'Awaiting acceptance',
    bg: '#FEF6E2', fg: '#854F0B', border: '#E8C896',
    description: 'Email sent. Waiting for candidate to click acceptance link.',
  },
  offer_accepted: {
    label: 'Accepted — pending PSN',
    bg: '#ECFDF3', fg: '#0F4C2A', border: '#A7D8B7',
    description: 'Candidate accepted. Process in SOL, then mark PSN issued.',
  },
  offer_declined: {
    label: 'Declined',
    bg: '#FCEFEF', fg: '#791F1F', border: '#E8B5B0',
    description: 'Candidate declined the offer.',
  },
  expired: {
    label: 'Expired',
    bg: '#F5F5F5', fg: '#525252', border: '#D4D4D4',
    description: 'Link expired without a response. Re-send to extend by 7 days, or Discard to remove from view.',
  },
  withdrawn: {
    label: 'Withdrawn',
    bg: '#F5F5F5', fg: '#525252', border: '#D4D4D4',
    description: 'Offer withdrawn by HR.',
  },
  psn_issued: {
    label: 'PSN issued · pre-joiner',
    bg: '#EEF0FA', fg: '#3B4279', border: '#B8BFD9',
    description: 'Onboarding underway. Will become active on join date.',
  },
  cancelled: {
    label: 'Cancelled',
    bg: '#F5F5F5', fg: '#525252', border: '#D4D4D4',
    description: 'Offer abandoned.',
  },
};

// Statuses the user might want to act on, displayed first.
// 'expired' is here (not archived) because Nadeem wants Bashaier to
// see expired offers alongside active ones — faded but visible — so
// she can quickly Re-send (extend by 7 days) or Discard them. Without
// that visibility expired offers got lost in the Archived collapse.
const ACTIVE_STATUSES = ['offer_sent', 'offer_accepted', 'expired'];
const ARCHIVED_STATUSES = ['offer_declined', 'withdrawn', 'psn_issued', 'cancelled'];

// Auto-discard threshold — offers that expired more than this many
// days ago without a response are treated as abandoned and silently
// flipped to status='cancelled' on next pipeline load. Keeps the
// active section from accumulating stale rows over time.
const AUTO_DISCARD_AFTER_DAYS = 30;

// Compute the "effective" status of an offer — handles the case
// where the DB still has status='offer_sent' but the expires_at
// timestamp has passed. The DB-side sync (in OffersCard.load) will
// flip it to 'expired' on next fetch, but until then the UI should
// already display the expired state so Bashaier never sees a stale
// status pill.
function effectiveStatus(offer) {
  if (offer?.status === 'offer_sent' && offer.expires_at) {
    if (new Date(offer.expires_at).getTime() <= Date.now()) {
      return 'expired';
    }
  }
  return offer?.status || 'draft';
}

// Returns the urgency level for a still-active offer_sent row,
// used to colour the days-remaining chip:
//   'urgent'  — 0 or 1 days left  (red — must act today)
//   'warning' — 2 or 3 days left  (amber)
//   'ok'      — more days left    (green/neutral)
//   null      — not applicable (already expired or never had expiry)
function expiryUrgency(offer) {
  if (effectiveStatus(offer) !== 'offer_sent' || !offer.expires_at) return null;
  const ms = new Date(offer.expires_at).getTime() - Date.now();
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days <= 1) return 'urgent';
  if (days <= 3) return 'warning';
  return 'ok';
}

export default function OffersCard({ me, employees, readOnly = false }) {
  const [offers, setOffers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [newOfferOpen, setNewOfferOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [issuePsnFor, setIssuePsnFor] = useState(null);

  // Toast surfaced after a successful offer creation. Shows the new
  // offer's reference number (ESAU/HR/YYYY/XXXXXX) so Bashaier
  // confirms the system recorded the offer before she emails the
  // candidate. Auto-dismisses via SuccessToast's internal timer.
  const [createdToast, setCreatedToast] = useState(null);

  // ─── Load ───────────────────────────────────────────────────────
  // On every fetch we also reconcile two server-side states that the
  // DB has no cron to handle:
  //
  //   1. Auto-flip offer_sent → expired
  //      Any row still marked offer_sent whose expires_at has passed
  //      is updated to status='expired'. The candidate-side acceptance
  //      page also catches this on view, but the HR pipeline needs to
  //      reflect the truth too so Bashaier doesn't see a stale
  //      "Awaiting acceptance" pill on something that's actually dead.
  //
  //   2. Auto-discard expired → cancelled (after AUTO_DISCARD_AFTER_DAYS)
  //      Expired offers that haven't been responded to OR re-sent for
  //      30+ days are flipped to status='cancelled' so they fall out
  //      of the active section. Anyone resurrecting a dropped lead
  //      after a month should create a fresh offer rather than reuse
  //      a half-year-old token.
  //
  // Both are best-effort — failure to sync doesn't block the load, it
  // just means the next fetch will retry. Both run as single
  // PostgREST PATCH-by-filter calls, so each is one round trip
  // regardless of how many rows match.
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const nowIso = new Date().toISOString();
      const cutoffIso = new Date(
        Date.now() - AUTO_DISCARD_AFTER_DAYS * 24 * 60 * 60 * 1000
      ).toISOString();

      // 1. Flip expired offers (silent — failure isn't fatal)
      try {
        await directPatchQuery(
          'offer_letters',
          `status=eq.offer_sent&expires_at=lt.${encodeURIComponent(nowIso)}`,
          { status: 'expired' },
          { timeoutMs: 6000 }
        );
      } catch (e) {
        console.warn('Auto-expire sync failed (non-fatal):', e?.message || e);
      }

      // 2. Auto-discard long-expired offers (silent)
      try {
        await directPatchQuery(
          'offer_letters',
          // Match: status=expired, no response on file, expired more than
          // AUTO_DISCARD_AFTER_DAYS ago.
          `status=eq.expired&responded_at=is.null&expires_at=lt.${encodeURIComponent(cutoffIso)}`,
          { status: 'cancelled' },
          { timeoutMs: 6000 }
        );
      } catch (e) {
        console.warn('Auto-discard sync failed (non-fatal):', e?.message || e);
      }

      const data = await directGet(
        'offer_letters',
        'select=*&order=created_at.desc',
        { timeoutMs: 10000 }
      );
      setOffers(data || []);
      setError('');
    } catch (e) {
      console.warn('OffersCard load failed:', e);
      setError(e?.message || 'Could not load offers.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Combined onCreated handler — refreshes the pipeline AND raises
  // the success toast with the new offer's reference number. The
  // ref# (ESAU/HR/YYYY/XXXXXX) matches the format used inside the
  // letter PDF so Bashaier sees the same identifier in both places.
  const handleOfferCreated = useCallback((created) => {
    load(true);
    if (created?.offer_token) {
      const year = new Date(created.created_at || Date.now()).getFullYear();
      const shortRef = String(created.offer_token).slice(0, 6).toUpperCase();
      setCreatedToast({
        title: 'Offer created',
        body: `Reference ESAU/HR/${year}/${shortRef}. The offer is now in the pipeline below — click Email to send it to the candidate, or Contract to view the bilingual PDF.`,
      });
    }
  }, [load]);

  // ─── Realtime — refetch on any offer_letters change ─────────────
  useEffect(() => {
    if (!supabase) return;
    let timer = null;
    const debouncedReload = () => {
      clearTimeout(timer);
      timer = setTimeout(() => load(true), 600);
    };
    const channel = supabase.channel('offer-letters-card')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'offer_letters' },
        debouncedReload)
      .subscribe();
    return () => {
      clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [load]);

  // ─── Group + sort ───────────────────────────────────────────────
  // Uses effectiveStatus (not raw o.status) so client-derived
  // 'expired' rows land in the active section even before the
  // server-side flip catches up.
  const grouped = useMemo(() => {
    const active = [];
    const archived = [];
    offers.forEach(o => {
      const eff = effectiveStatus(o);
      if (ACTIVE_STATUSES.includes(eff)) active.push(o);
      else archived.push(o);
    });
    return { active, archived };
  }, [offers]);

  // ─── Stats ──────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const now = Date.now();
    const expiringSoonMs = 3 * 24 * 60 * 60 * 1000; // 3 days
    let awaiting = 0, acceptedPendingPsn = 0, expiringSoon = 0, expiredNeedsAction = 0;
    offers.forEach(o => {
      const eff = effectiveStatus(o);
      if (eff === 'offer_sent') {
        awaiting++;
        if (o.expires_at && new Date(o.expires_at).getTime() - now < expiringSoonMs) {
          expiringSoon++;
        }
      } else if (eff === 'offer_accepted') {
        acceptedPendingPsn++;
      } else if (eff === 'expired') {
        expiredNeedsAction++;
      }
    });
    return { awaiting, acceptedPendingPsn, expiringSoon, expiredNeedsAction };
  }, [offers]);

  // ─── Auto-hide if nothing meaningful ────────────────────────────
  // If there are zero offers in any state, hide the card entirely so
  // teams that aren't hiring don't see a permanent empty surface.
  // Once they create one, the card stays visible (offers history).
  if (!loading && offers.length === 0) {
    return (
      <section
        className="rounded-2xl border bg-white p-5"
        style={{ borderColor: 'var(--border-soft)' }}
      >
        <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
          <div>
            <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#1F1B16', fontWeight: 700 }}>
              CANDIDATE OFFERS
            </div>
            <div style={{ fontFamily: 'inherit', fontSize: 20, color: '#1F1B16' }}>
              Hiring pipeline
            </div>
            <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              {readOnly
                ? 'No offers issued yet. HR has not created any candidate offers.'
                : 'Issue an offer to a new candidate. The portal generates the letter and an Outlook draft to send.'}
            </div>
          </div>
          {!readOnly && (
            <button
              onClick={() => setNewOfferOpen(true)}
              className="px-3 py-2 rounded-lg text-sm flex items-center gap-2"
              style={{ background: 'var(--evergreen-600)', color: '#FFFFFF', fontWeight: 600 }}
            >
              <Plus className="w-4 h-4" /> New offer
            </button>
          )}
        </div>
        {!readOnly && (
          <NewOfferModal
            open={newOfferOpen}
            onClose={() => setNewOfferOpen(false)}
            onCreated={handleOfferCreated}
            employees={employees}
            me={me}
          />
        )}
      </section>
    );
  }

  return (
    <>
      {/* Recent acceptances banner — stays for 15 days per acceptance,
          per-user dismissible. Reads from the same offers list the
          card uses, so the same realtime sub drives it. Hidden when
          there are no qualifying acceptances (component returns null). */}
      <RecentAcceptancesBanner offers={offers} me={me} />
      <section
        className="rounded-2xl border bg-white p-5"
        style={{ borderColor: 'var(--border-soft)' }}
      >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#1F1B16', fontWeight: 700 }}>
            CANDIDATE OFFERS
          </div>
          <div style={{ fontFamily: 'inherit', fontSize: 20, color: '#1F1B16' }}>
            Hiring pipeline
          </div>
          <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            Issue offers, track acceptances, and record PSN issuance from SOL.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setRefreshing(true); load(true); }}
            disabled={refreshing}
            className="p-2 rounded-full opacity-60 hover:opacity-100 disabled:opacity-40"
            title="Refresh"
            aria-label="Refresh offers"
            style={{ border: '1px solid var(--border-soft)' }}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          {!readOnly && (
            <button
              onClick={() => setNewOfferOpen(true)}
              className="px-3 py-2 rounded-lg text-sm flex items-center gap-2"
              style={{ background: 'var(--evergreen-600)', color: '#FFFFFF', fontWeight: 600 }}
            >
              <Plus className="w-4 h-4" /> New offer
            </button>
          )}
        </div>
      </div>

      {/* Stat tiles. Layout switches from 3 to 4 columns when there
          are expired offers that need attention — the extra tile
          surfaces them without crowding the grid when there's nothing
          to show. */}
      {!loading && offers.length > 0 && (
        <div
          className={
            stats.expiredNeedsAction > 0
              ? 'grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4'
              : 'grid grid-cols-3 gap-2 mb-4'
          }
        >
          <StatTile
            label="Awaiting acceptance"
            count={stats.awaiting}
            icon={<Mail className="w-3.5 h-3.5" />}
            color="#854F0B"
            bg="#FEF6E2"
          />
          <StatTile
            label="Accepted, pending PSN"
            count={stats.acceptedPendingPsn}
            icon={<FileCheck2 className="w-3.5 h-3.5" />}
            color="#0F4C2A"
            bg="#ECFDF3"
          />
          <StatTile
            label="Expiring within 3 days"
            count={stats.expiringSoon}
            icon={<AlertTriangle className="w-3.5 h-3.5" />}
            color={stats.expiringSoon > 0 ? '#854F0B' : '#737373'}
            bg={stats.expiringSoon > 0 ? '#FEF6E2' : '#F5F5F5'}
          />
          {stats.expiredNeedsAction > 0 && (
            <StatTile
              label="Expired — needs action"
              count={stats.expiredNeedsAction}
              icon={<Clock className="w-3.5 h-3.5" />}
              color="#991B1B"
              bg="#FEF2F2"
            />
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm py-6 justify-center" style={{ color: '#0A0A0A', opacity: 0.6 }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading offers…
        </div>
      ) : (
        <>
          {/* Active offers (offer_sent + offer_accepted) */}
          {grouped.active.length > 0 ? (
            <div className="space-y-2 mb-3">
              {grouped.active.map(o => (
                <OfferRow
                  key={o.id}
                  offer={o}
                  employees={employees}
                  onChanged={() => load(true)}
                  onIssuePsn={() => setIssuePsnFor(o)}
                  me={me}
                  readOnly={readOnly}
                />
              ))}
            </div>
          ) : (
            <div
              className="rounded-lg p-3 text-xs text-center mb-3"
              style={{ background: 'var(--paper-2)', color: '#0A0A0A', opacity: 0.6 }}
            >
              No active offers. {grouped.archived.length > 0 ? 'See archived offers below.' : ''}
            </div>
          )}

          {/* Archived toggle */}
          {grouped.archived.length > 0 && (
            <div>
              <button
                onClick={() => setShowArchived(s => !s)}
                className="text-xs flex items-center gap-1.5"
                style={{ color: '#0A0A0A', opacity: 0.7, fontWeight: 600 }}
              >
                {showArchived
                  ? <ChevronDown className="w-3.5 h-3.5" />
                  : <ChevronRight className="w-3.5 h-3.5" />}
                Archived offers ({grouped.archived.length})
              </button>
              {showArchived && (
                <div className="space-y-2 mt-2">
                  {grouped.archived.map(o => (
                    <OfferRow
                      key={o.id}
                      offer={o}
                      employees={employees}
                  onChanged={() => load(true)}
                      onIssuePsn={() => setIssuePsnFor(o)}
                      me={me}
                      readOnly={readOnly}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {error && (
        <div
          className="rounded-lg p-3 text-xs mt-3"
          style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}
        >
          {error}
        </div>
      )}

      {/* Modal: New offer — hidden in read-only mode */}
      {!readOnly && (
        <NewOfferModal
          open={newOfferOpen}
          onClose={() => setNewOfferOpen(false)}
          onCreated={handleOfferCreated}
          employees={employees}
          me={me}
        />
      )}

      {/* Modal: Issue PSN (Phase 5 surface) — placeholder import; will
          be implemented in a follow-up commit. For now the button
          only opens an empty modal that does nothing. Also hidden in
          read-only mode. */}
      {!readOnly && issuePsnFor && (
        <IssuePsnModal
          offer={issuePsnFor}
          onClose={() => setIssuePsnFor(null)}
          onIssued={() => { setIssuePsnFor(null); load(true); }}
          me={me}
        />
      )}

      {/* Success toast — surfaces after handleOfferCreated fires.
          Auto-dismisses internally; we just need to clear our local
          state when it does so a second creation can re-arm it. */}
      {createdToast && (
        <SuccessToast
          title={createdToast.title}
          body={createdToast.body}
          onDismiss={() => setCreatedToast(null)}
        />
      )}
    </section>
    </>
  );
}

// ─── Per-offer row ─────────────────────────────────────────────────

function OfferRow({ offer, employees, onChanged, onIssuePsn, me, readOnly = false }) {
  // Effective status accounts for client-side expiry — a row whose
  // expires_at has passed is rendered as 'expired' even before the
  // server-side flip lands (the auto-flip in OffersCard.load runs on
  // each fetch, but a long-open page should still display the
  // truth without waiting for the next refresh).
  const effStatus = effectiveStatus(offer);
  const presentation = STATUS_PRESENTATION[effStatus] || STATUS_PRESENTATION.draft;
  const urgency = expiryUrgency(offer);

  const [actingOn, setActingOn] = useState(null); // 'withdraw' | 'resend' | 'discard'
  const [copyToast, setCopyToast] = useState(false);
  // letterPreview: holds the offer object when the in-page Contract
  // modal is open, null when closed. Hosted on the row (not the
  // parent card) because each row's button click opens a modal for
  // that specific row's offer; only one is ever open at a time.
  const [letterPreview, setLetterPreview] = useState(null);

  // Compute days remaining until expiry (for still-active offer_sent
  // rows only — uses effStatus so already-expired rows return null).
  const daysRemaining = useMemo(() => {
    if (effStatus !== 'offer_sent' || !offer.expires_at) return null;
    const ms = new Date(offer.expires_at).getTime() - Date.now();
    return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
  }, [offer, effStatus]);

  const acceptanceUrl = `${window.location.origin}/accept-offer?token=${offer.offer_token}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(acceptanceUrl);
      setCopyToast(true);
      setTimeout(() => setCopyToast(false), 1500);
    } catch (e) {
      console.warn('clipboard failed:', e);
    }
  }

  // View contract — opens an in-page modal showing the same
  // bilingual offer letter the candidate sees on the public
  // acceptance page. State-driven (setLetterPreview) rather than
  // window.open() so the preview lives inside the portal and
  // doesn't depend on browser popup permissions.
  //
  // Behavior differs by access level (see LetterPreviewModal):
  //   • Full-access (Bashaier / admin): includes a Print / Save
  //     as PDF button in the modal toolbar.
  //   • Read-only (SUP team): no print button, plus a print-
  //     blocking CSS rule. Best-effort, not bulletproof — see
  //     LetterPreviewModal for the full caveat.
  function viewLetter() {
    setLetterPreview(offer);
  }

  // Compose the offer email — opens a new Outlook draft pre-filled
  // with To, Cc, subject, and body (including the acceptance link).
  // Uses mailto: rather than .eml because Bashaier wanted "the email
  // window opens up" rather than a download she has to re-open.
  // mailto: handles To/Cc/body cleanly; the trade-off is that the
  // PDF can't be auto-attached (mailto: doesn't support attachments).
  // Bashaier opens the contract via the separate Contract button and
  // attaches it manually.
  //
  // CC list (deduplicated, lowercased):
  //   • Always: John Ho, James Liu (Country Heads), Badria, Jaffar
  //     (SUP team), Fahad Hussain (SUP manager)
  //   • Plus the manager assigned to this offer (if they have an
  //     email on file) — derived from offer.manager_id by looking
  //     them up in the employees prop.
  function composeEmail() {
    const candidateEmail = (offer.candidate_email || '').trim();
    if (!candidateEmail) {
      alert('No candidate email on this offer. Cannot compose.');
      return;
    }

    // Always-Cc per company policy. This list mirrors the FIXED_CC
    // used in AttendanceView and EvaluationReviewModal — same
    // recipients across all HR-driven candidate communications.
    const FIXED_CC = [
      'johnho@evergreen-shipping.com.sa',
      'jamesliu@evergreen-shipping.com.sa',
      'badria.alhassan@evergreen-shipping.com.sa',
      'jaffar.aldarweash@evergreen-shipping.com.sa',
      'fahad.alhussain@evergreen-shipping.com.sa',
    ];

    // Add the offer's reporting manager if they have an email on file.
    // (employees prop is the same array used elsewhere in the portal —
    // includes is_admin / manager_id flags. We just need the email.)
    const ccList = [...FIXED_CC];
    if (offer.manager_id && Array.isArray(employees)) {
      const mgr = employees.find(e => e.id === offer.manager_id);
      if (mgr?.email) {
        ccList.push(mgr.email.toLowerCase());
      }
    }
    // Dedupe (case-insensitive). Outlook handles case but seeing
    // duplicates in the To/Cc field looks careless.
    const uniqueCc = Array.from(new Set(ccList.map(e => e.toLowerCase())));

    const acceptanceUrl = `${window.location.origin}/accept-offer?token=${offer.offer_token}`;
    // Subject format: "Offer of employment — [Candidate Name] — [Position] — Evergreen Shipping"
    // Candidate name is title-cased (the form auto-uppercases for
    // data entry, but in subject lines a Title Case rendering reads
    // more naturally to the recipient than ALL CAPS).
    const candidateForSubject = (offer.candidate_name || 'Candidate')
      .toLowerCase()
      .replace(/\b\w/g, c => c.toUpperCase());
    const subject = `Offer of employment — ${candidateForSubject} — ${offer.position_title || 'Evergreen Shipping'} — Evergreen Shipping`;
    const body = buildOfferEmailBody(
      { candidateName: offer.candidate_name, positionTitle: offer.position_title },
      acceptanceUrl,
      { name: me?.name || 'BASHAIER ALSUBAIE', email: me?.email || 'bashaier.alsubaie@evergreen-shipping.com.sa' }
    );

    // mailto: encoding. URLSearchParams produces application/x-www-
    // form-urlencoded format which encodes spaces as '+' — that's
    // wrong for RFC 6068 mailto: URLs, where spaces must be %20.
    // Outlook treats '+' literally and shows pluses everywhere there
    // should be spaces, so we build the query string manually with
    // encodeURIComponent (which uses %20 for spaces).
    const qs = [
      `cc=${encodeURIComponent(uniqueCc.join(','))}`,
      `subject=${encodeURIComponent(subject)}`,
      `body=${encodeURIComponent(body)}`,
    ].join('&');
    const mailto = `mailto:${encodeURIComponent(candidateEmail)}?${qs}`;

    // window.location.assign() opens the user's default mail handler
    // (Outlook on Bashaier's machine). Doesn't navigate the portal
    // away because mailto: is a registered protocol.
    window.location.assign(mailto);
  }

  async function withdrawOffer() {
    if (readOnly) return;
    if (!confirm(`Withdraw offer to ${offer.candidate_name}? This cannot be undone.`)) return;
    setActingOn('withdraw');
    try {
      await directPatch('offer_letters', 'id', offer.id, {
        status: 'withdrawn',
        updated_at: new Date().toISOString(),
      });
      onChanged?.();
    } catch (e) {
      alert(e?.message || 'Could not withdraw offer.');
    } finally {
      setActingOn(null);
    }
  }

  // Re-send an expired offer: bumps expires_at to +7 days from now
  // and flips status back to offer_sent. Per Nadeem's choice the
  // SAME token is kept — the original email's link becomes valid
  // again, no need to compose a brand-new email. Bashaier still
  // needs to ping the candidate (Email button or a manual
  // WhatsApp) to let them know the link is alive again, since
  // we don't auto-send anything here.
  async function resendOffer() {
    if (readOnly) return;
    if (!confirm(
      `Re-send offer to ${offer.candidate_name}?\n\n` +
      `The acceptance link will be valid for another 7 days.\n` +
      `The same link works — you'll need to ping the candidate to let them know.`
    )) return;
    setActingOn('resend');
    try {
      const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await directPatch('offer_letters', 'id', offer.id, {
        status: 'offer_sent',
        expires_at: newExpiry,
        updated_at: new Date().toISOString(),
      });
      onChanged?.();
    } catch (e) {
      alert(e?.message || 'Could not re-send offer.');
    } finally {
      setActingOn(null);
    }
  }

  // Discard an expired offer she doesn't want to revive — flips to
  // status='cancelled' so it falls out of the active section and
  // into Archived. Reversible only via DB intervention; the warning
  // tells Bashaier this is effectively final.
  async function discardOffer() {
    if (readOnly) return;
    if (!confirm(
      `Discard the offer to ${offer.candidate_name}?\n\n` +
      `This moves it to the archive. To restart, create a new offer.`
    )) return;
    setActingOn('discard');
    try {
      await directPatch('offer_letters', 'id', offer.id, {
        status: 'cancelled',
        updated_at: new Date().toISOString(),
      });
      onChanged?.();
    } catch (e) {
      alert(e?.message || 'Could not discard offer.');
    } finally {
      setActingOn(null);
    }
  }

  // Expired rows fade so Bashaier's eye is drawn to active work first.
  // Still fully readable, just visually de-emphasised.
  const isExpired = effStatus === 'expired';

  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: 'var(--border-soft)',
        background: 'var(--paper)',
        opacity: isExpired ? 0.72 : 1,
      }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span style={{ fontWeight: 600, fontSize: 14, color: '#0A0A0A' }}>
              {offer.candidate_name}
            </span>
            <span
              className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center"
              style={{
                background: presentation.bg,
                color: presentation.fg,
                border: `1px solid ${presentation.border}`,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
              }}
            >
              {presentation.label}
            </span>
            {daysRemaining !== null && (
              // Three urgency tiers via expiryUrgency():
              //   urgent (0–1 days):  red bg / red text / red border
              //   warning (2–3 days): amber bg / amber text / amber border
              //   ok (4+ days):       neutral paper bg / dark text
              <span
                className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                style={{
                  background: urgency === 'urgent'  ? '#FEF2F2'
                            : urgency === 'warning' ? '#FEF6E2'
                            :                          'var(--paper-2)',
                  color:      urgency === 'urgent'  ? '#991B1B'
                            : urgency === 'warning' ? '#854F0B'
                            :                          '#0A0A0A',
                  border: '1px solid ' + (
                              urgency === 'urgent'  ? '#FCA5A5'
                            : urgency === 'warning' ? '#E8C896'
                            :                          'var(--border)'
                            ),
                  fontWeight: 600,
                }}
                title={
                    urgency === 'urgent'
                      ? 'Acceptance window closing — re-send if needed'
                      : urgency === 'warning'
                        ? 'Acceptance window closing within a few days'
                        : 'Acceptance window healthy'
                }
              >
                <Clock className="w-2.5 h-2.5" />
                {daysRemaining === 0 ? 'expires today' : `${daysRemaining}d left`}
              </span>
            )}
          </div>
          <div className="text-xs mt-0.5" style={{ color: '#0A0A0A' }}>
            {offer.position_title} · {offer.department}
          </div>
          <div className="text-[11px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.65 }}>
            {offer.candidate_email}
            {offer.proposed_join_date && (
              <> · joins {fmtDate(offer.proposed_join_date)}</>
            )}
          </div>
          <div className="text-[11px] mt-1" style={{ color: '#0A0A0A', opacity: 0.6, fontStyle: 'italic' }}>
            {presentation.description}
          </div>

          {/* Response details — shown for accepted/declined offers.
              Bashaier sees when the candidate responded and (for
              declines) the reason they gave. */}
          {(offer.status === 'offer_accepted' || offer.status === 'offer_declined') && offer.responded_at && (
            <div
              className="mt-2 p-2 rounded-md text-[11px]"
              style={{
                background: offer.status === 'offer_accepted' ? '#ECFDF3' : '#FCEFEF',
                border: `1px solid ${offer.status === 'offer_accepted' ? '#A7D8B7' : '#E8B5B0'}`,
                color: offer.status === 'offer_accepted' ? '#0F4C2A' : '#791F1F',
                lineHeight: 1.5,
              }}
            >
              <div style={{ fontWeight: 700, letterSpacing: '0.04em' }}>
                {offer.status === 'offer_accepted' ? 'CANDIDATE ACCEPTED' : 'CANDIDATE DECLINED'}
                <span style={{ fontWeight: 400, marginLeft: 6 }}>
                  on {new Date(offer.responded_at).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}
                </span>
              </div>
              {offer.status === 'offer_declined' && offer.decline_reason && (
                <div style={{ marginTop: 4, opacity: 0.9 }}>
                  Reason: <span style={{ fontStyle: 'italic' }}>{offer.decline_reason}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-row items-center gap-1.5 shrink-0 flex-wrap">
          {/* Contract — visible to ALL users on EVERY status. Opens
              an in-page modal showing the bilingual offer letter
              with the same green-bordered card styling the candidate
              sees. Read-only viewers (Badria, Fahad SUP, Jaffar) get
              the modal without the Print button + with a print-
              blocking CSS rule. */}
          <button
            onClick={viewLetter}
            className="text-[11px] px-2.5 py-1 rounded-full inline-flex items-center gap-1.5"
            style={{
              background: 'transparent',
              color: '#0F4C2A',
              border: '1px solid #A7D8B7',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            {readOnly ? <Eye className="w-3 h-3" /> : <FileText className="w-3 h-3" />}
            Contract
          </button>

          {/* Email — opens an Outlook draft with To/Cc/body/link
              prefilled. Hidden in read-only mode (viewers preview
              the contract but don't send communications). Hidden on
              expired offers because the link is dead — Re-send first
              to revive it, then send a fresh email if needed. */}
          {!readOnly && effStatus !== 'expired' && (
            <button
              onClick={composeEmail}
              className="text-[11px] px-2.5 py-1 rounded-full inline-flex items-center gap-1.5"
              style={{
                background: 'var(--evergreen-600)',
                color: '#FFFFFF',
                border: '1px solid var(--evergreen-600)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Mail className="w-3 h-3" /> Email
            </button>
          )}

          {/* Offer Link — copies the candidate's acceptance URL to
              the clipboard so Bashaier can paste it elsewhere (a
              follow-up WhatsApp, a separate manual email, etc.).
              Hidden in read-only mode (viewers shouldn't be sharing
              the candidate's private acceptance link). Hidden on
              expired offers — the link wouldn't work for the
              candidate anyway. */}
          {!readOnly && effStatus !== 'expired' && (
            <button
              onClick={copyLink}
              className="text-[11px] px-2.5 py-1 rounded-full inline-flex items-center gap-1.5"
              style={{
                background: copyToast ? '#0F4C2A' : 'transparent',
                color: copyToast ? '#FFFFFF' : '#0A0A0A',
                border: '1px solid ' + (copyToast ? '#0F4C2A' : 'var(--border)'),
                fontWeight: 500,
                cursor: 'pointer',
              }}
              title="Copy the candidate's acceptance link"
            >
              <Copy className="w-3 h-3" />
              {copyToast ? 'Copied!' : 'Offer Link'}
            </button>
          )}

          {/* Re-send — only on expired offers. Bumps expires_at by
              7 days and flips status back to offer_sent so the same
              acceptance URL works again. Bashaier still has to ping
              the candidate manually since we don't auto-send anything. */}
          {!readOnly && effStatus === 'expired' && (
            <button
              onClick={resendOffer}
              disabled={actingOn === 'resend'}
              className="text-[11px] px-2.5 py-1 rounded-full inline-flex items-center gap-1.5"
              style={{
                background: 'var(--evergreen-600)',
                color: '#FFFFFF',
                border: '1px solid var(--evergreen-600)',
                fontWeight: 600,
                cursor: actingOn === 'resend' ? 'wait' : 'pointer',
                opacity: actingOn === 'resend' ? 0.6 : 1,
              }}
              title="Extend the acceptance window by 7 days (same link)"
            >
              {actingOn === 'resend'
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Send className="w-3 h-3" />}
              Re-send
            </button>
          )}

          {/* Discard — only on expired offers. Sets status='cancelled'
              so the row drops out of the active section. Used when
              Bashaier doesn't want to revive the offer. */}
          {!readOnly && effStatus === 'expired' && (
            <button
              onClick={discardOffer}
              disabled={actingOn === 'discard'}
              className="text-[11px] px-2.5 py-1 rounded-full inline-flex items-center gap-1.5"
              style={{
                background: 'transparent',
                color: '#525252',
                border: '1px solid var(--border)',
                fontWeight: 500,
                cursor: actingOn === 'discard' ? 'not-allowed' : 'pointer',
                opacity: actingOn === 'discard' ? 0.5 : 1,
              }}
              title="Move to archive (cancelled)"
            >
              {actingOn === 'discard'
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <Trash2 className="w-3 h-3" />}
              Discard
            </button>
          )}

          {/* Withdraw — only on still-active offer_sent (response
              still pending). Hidden in read-only mode and on expired
              offers (Discard replaces Withdraw for the expired case). */}
          {!readOnly && effStatus === 'offer_sent' && (
            <button
              onClick={withdrawOffer}
              disabled={actingOn === 'withdraw'}
              className="text-[11px] px-2.5 py-1 rounded-full inline-flex items-center gap-1.5"
              style={{
                background: 'transparent',
                color: '#991B1B',
                border: '1px solid #FCA5A5',
                fontWeight: 500,
                cursor: actingOn === 'withdraw' ? 'not-allowed' : 'pointer',
                opacity: actingOn === 'withdraw' ? 0.5 : 1,
              }}
            >
              {actingOn === 'withdraw'
                ? <Loader2 className="w-3 h-3 animate-spin" />
                : <X className="w-3 h-3" />}
              Withdraw
            </button>
          )}
          {!readOnly && effStatus === 'offer_accepted' && (
            <button
              onClick={onIssuePsn}
              className="text-[11px] px-2.5 py-1 rounded-full inline-flex items-center gap-1.5"
              style={{
                background: 'var(--evergreen-600)',
                color: '#FFFFFF',
                border: '1px solid var(--evergreen-600)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <UserPlus className="w-3 h-3" /> Issue PSN
            </button>
          )}
        </div>
      </div>

      {/* In-page contract preview modal — same green-bordered card
          the candidate sees on the public acceptance page. */}
      {letterPreview && (
        <LetterPreviewModal
          offer={letterPreview}
          onClose={() => setLetterPreview(null)}
          readOnly={readOnly}
        />
      )}
    </div>
  );
}

// ─── Stat tile ────────────────────────────────────────────────────

function StatTile({ label, count, icon, color, bg }) {
  return (
    <div
      className="rounded-lg p-2.5"
      style={{ background: bg }}
    >
      <div className="flex items-center gap-1.5 text-[10px] tracking-wider" style={{ color, fontWeight: 700, opacity: 0.85 }}>
        {icon} {label.toUpperCase()}
      </div>
      <div className="serif text-2xl mt-0.5" style={{ fontWeight: 600, color }}>
        {count}
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────
function fmtDate(yyyymmdd) {
  if (!yyyymmdd) return '';
  const [y, m, d] = String(yyyymmdd).split('-').map(Number);
  if (!y) return yyyymmdd;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
