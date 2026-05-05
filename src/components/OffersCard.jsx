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
} from 'lucide-react';
import { directGet, directPatch, supabase } from '../supabaseClient.js';
import NewOfferModal from './NewOfferModal.jsx';
import IssuePsnModal from './IssuePsnModal.jsx';
import LetterPreviewModal from './LetterPreviewModal.jsx';
import SuccessToast from './SuccessToast.jsx';
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
    description: '7-day acceptance window passed.',
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

// Statuses the user might want to act on, displayed first
const ACTIVE_STATUSES = ['offer_sent', 'offer_accepted'];
const ARCHIVED_STATUSES = ['offer_declined', 'expired', 'withdrawn', 'psn_issued', 'cancelled'];

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
  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
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
  const grouped = useMemo(() => {
    const active = [];
    const archived = [];
    offers.forEach(o => {
      if (ACTIVE_STATUSES.includes(o.status)) active.push(o);
      else archived.push(o);
    });
    return { active, archived };
  }, [offers]);

  // ─── Stats ──────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const now = Date.now();
    const expiringSoonMs = 3 * 24 * 60 * 60 * 1000; // 3 days
    let awaiting = 0, acceptedPendingPsn = 0, expiringSoon = 0;
    offers.forEach(o => {
      if (o.status === 'offer_sent') {
        awaiting++;
        if (o.expires_at && new Date(o.expires_at).getTime() - now < expiringSoonMs) {
          expiringSoon++;
        }
      } else if (o.status === 'offer_accepted') {
        acceptedPendingPsn++;
      }
    });
    return { awaiting, acceptedPendingPsn, expiringSoon };
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
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 20, color: '#1F1B16' }}>
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
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 20, color: '#1F1B16' }}>
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

      {/* Stat tiles */}
      {!loading && offers.length > 0 && (
        <div className="grid grid-cols-3 gap-2 mb-4">
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
  );
}

// ─── Per-offer row ─────────────────────────────────────────────────

function OfferRow({ offer, employees, onChanged, onIssuePsn, me, readOnly = false }) {
  const presentation = STATUS_PRESENTATION[offer.status] || STATUS_PRESENTATION.draft;
  const [actingOn, setActingOn] = useState(null); // 'withdraw' | 'copy'
  const [copyToast, setCopyToast] = useState(false);
  // letterPreview: holds the offer object when the in-page Contract
  // modal is open, null when closed. Hosted on the row (not the
  // parent card) because each row's button click opens a modal for
  // that specific row's offer; only one is ever open at a time.
  const [letterPreview, setLetterPreview] = useState(null);

  // Compute days remaining until expiry (for offer_sent only)
  const daysRemaining = useMemo(() => {
    if (offer.status !== 'offer_sent' || !offer.expires_at) return null;
    const ms = new Date(offer.expires_at).getTime() - Date.now();
    return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
  }, [offer]);

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
    const subject = `Offer of employment — ${offer.position_title || 'Evergreen Shipping'} — Evergreen Shipping`;
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

  return (
    <div
      className="rounded-lg border p-3"
      style={{ borderColor: 'var(--border-soft)', background: 'var(--paper)' }}
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
              <span
                className="text-[10px] px-2 py-0.5 rounded-full inline-flex items-center gap-1"
                style={{
                  background: daysRemaining <= 3 ? '#FEF2F2' : 'var(--paper-2)',
                  color: daysRemaining <= 3 ? '#991B1B' : '#0A0A0A',
                  border: '1px solid ' + (daysRemaining <= 3 ? '#FCA5A5' : 'var(--border)'),
                  fontWeight: 600,
                }}
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
              the contract but don't send communications). Available
              on every status so Bashaier can re-send if needed. */}
          {!readOnly && (
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

          {/* Withdraw — only on offer_sent (still pending response).
              Hidden in read-only mode. */}
          {!readOnly && offer.status === 'offer_sent' && (
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
          {!readOnly && offer.status === 'offer_accepted' && (
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
