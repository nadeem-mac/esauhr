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
import { buildLetterHtml } from '../lib/offerLetterGenerator.js';

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
            onCreated={() => load(true)}
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
          onCreated={() => load(true)}
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
    </section>
  );
}

// ─── Per-offer row ─────────────────────────────────────────────────

function OfferRow({ offer, onChanged, onIssuePsn, me, readOnly = false }) {
  const presentation = STATUS_PRESENTATION[offer.status] || STATUS_PRESENTATION.draft;
  const [actingOn, setActingOn] = useState(null); // 'withdraw' | 'copy'
  const [copyToast, setCopyToast] = useState(false);
  const [loadingLetter, setLoadingLetter] = useState(false);

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

  // View letter — opens a new tab showing the same bilingual offer
  // letter that was sent to the candidate. Both Bashaier and read-only
  // viewers (Badria, Fahad SUP, Jaffar) can use this. The letter is
  // rendered live from buildLetterHtml() — same source the PDF was
  // generated from — so what they see is exactly what the candidate
  // received.
  //
  // Behavior differs by access level:
  //   • Full-access (Bashaier / admin): shows the print toolbar +
  //     auto-prints, so she can re-save as PDF if needed.
  //   • Read-only (SUP team): NO print toolbar, NO auto-print, plus
  //     a CSS rule that blanks the page when printed. We can't fully
  //     prevent Ctrl+P (no web tech can), but we make it inconvenient
  //     and signal clearly that download isn't intended.
  async function viewLetter() {
    setLoadingLetter(true);
    try {
      // Fetch the signatory the offer used so the letter renders
      // with the right name/title in the signature block.
      let signatory = null;
      if (offer.signatory_id) {
        try {
          const sigs = await directGet(
            'signatories',
            `select=name,title&id=eq.${encodeURIComponent(offer.signatory_id)}&limit=1`,
            { timeoutMs: 6000 }
          );
          signatory = Array.isArray(sigs) ? sigs[0] : null;
        } catch {
          /* fall through with null signatory */
        }
      }

      // Open the new tab synchronously (must be inside the click
      // gesture or it gets pop-up-blocked).
      const win = window.open('', '_blank');
      if (!win) {
        alert('The viewer window was blocked. Please allow pop-ups for this site and try again.');
        return;
      }

      const safeName = (offer.candidate_name || 'Candidate')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '_');

      const letterHtml = buildLetterHtml(
        {
          candidateName:    offer.candidate_name,
          positionTitle:    offer.position_title,
          department:       offer.department,
          location:         offer.location || '',
          proposedJoinDate: offer.proposed_join_date,
          salaryBasic:      offer.salary_basic || 0,
          salaryHousing:    offer.salary_housing || 0,
          salaryTransport:  offer.salary_transportation || 0,
          salaryOther:      offer.salary_other || 0,
          salaryTotal:      offer.salary_amount || 0,
          offerToken:       offer.offer_token,
        },
        signatory || { name: '—', title: '—' }
      );

      // For read-only viewers we suppress the print toolbar AND add
      // a print-blocking CSS rule. For Bashaier we keep the existing
      // print-window experience (toolbar + auto-print).
      const printBlockedCss = readOnly
        ? `
          @media print {
            body * { visibility: hidden !important; }
            body::after {
              content: "Printing this view is restricted. Please contact HR for an official copy.";
              visibility: visible;
              position: fixed;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              font-family: Arial, sans-serif;
              font-size: 16px;
              color: #525252;
              text-align: center;
              max-width: 300px;
            }
          }
          /* Disable common keyboard shortcuts for save/print at the
             event level. Won't stop a determined user with browser
             menu, but signals intent. */
        `
        : '';

      const toolbar = readOnly
        ? `<div style="background:#3B4279;color:#fff;padding:14px 20px;display:flex;align-items:center;gap:12px;font-family:Arial,sans-serif;">
             <strong style="font-size:13px;">READ-ONLY VIEW</strong>
             <span style="font-size:12px;opacity:0.85;">Contract preview · ${escapeHtml(offer.candidate_name || '')} · ${escapeHtml(offer.position_title || '')}</span>
           </div>`
        : `<div class="print-toolbar" style="position:sticky;top:0;background:#0F4C2A;color:#fff;padding:14px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;z-index:10;box-shadow:0 2px 6px rgba(0,0,0,0.15);font-family:Arial,sans-serif;">
             <div>
               <div style="font-size:14px;font-weight:500;">Offer Letter — ${escapeHtml(offer.candidate_name || '')}</div>
               <div style="font-size:12px;opacity:0.85;margin-top:2px;">Use Print → Save as PDF to download a copy.</div>
             </div>
             <button onclick="window.print()" style="background:#fff;color:#0F4C2A;border:none;padding:8px 16px;font-size:13px;font-weight:500;cursor:pointer;border-radius:4px;">Print / Save as PDF</button>
           </div>`;

      const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(safeName)} — Offer Letter</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    @media print {
      body { margin: 0; }
      .print-toolbar { display: none !important; }
    }
    html, body { margin: 0; padding: 0; background: #f5f5f5; }
    .letter-host { max-width: 794px; margin: 16px auto 32px; background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,0.12); }
    @media print { .letter-host { margin: 0; box-shadow: none; max-width: none; } }
    ${printBlockedCss}
  </style>
</head>
<body>
  ${toolbar}
  <div class="letter-host">${letterHtml}</div>
</body>
</html>`;

      win.document.open();
      win.document.write(html);
      win.document.close();
    } catch (e) {
      console.error('View letter failed:', e);
      alert('Could not load the offer letter. Please try again.');
    } finally {
      setLoadingLetter(false);
    }
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
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          {/* View letter — visible for ALL users on EVERY status. This
              is how Bashaier and the SUP team open the bilingual
              contract that was sent to the candidate. The new tab's
              behavior depends on access level (see viewLetter() above). */}
          <button
            onClick={viewLetter}
            disabled={loadingLetter}
            className="text-[11px] px-2.5 py-1 rounded-full inline-flex items-center gap-1.5"
            style={{
              background: 'transparent',
              color: '#0F4C2A',
              border: '1px solid #A7D8B7',
              fontWeight: 500,
              cursor: loadingLetter ? 'wait' : 'pointer',
              opacity: loadingLetter ? 0.6 : 1,
            }}
          >
            {loadingLetter
              ? <Loader2 className="w-3 h-3 animate-spin" />
              : (readOnly ? <Eye className="w-3 h-3" /> : <FileText className="w-3 h-3" />)}
            {readOnly ? 'View contract' : 'View letter'}
          </button>

          {/* Write actions — hidden in read-only mode */}
          {!readOnly && offer.status === 'offer_sent' && (
            <>
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
              >
                <Copy className="w-3 h-3" />
                {copyToast ? 'Copied!' : 'Copy link'}
              </button>
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
            </>
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

// HTML escape for inline document writes in the View Letter popup.
// We can't import the one from offerLetterGenerator (it's not
// exported and module-internal) so a tiny duplicate lives here.
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
