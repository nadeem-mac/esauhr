// =============================================================================
// LetterPreviewModal.jsx
//
// In-page overlay that shows the bilingual offer letter exactly as
// the candidate sees it on the public acceptance page. Used by
// OffersCard's "Contract" button — replaces the previous
// window.open() popup which depended on browser popup permissions
// and rendered in a separate tab disconnected from the portal.
//
// Visual style intentionally MATCHES AcceptOfferPage:
//   • Letter sized to its natural 794px width, centered
//   • 2px Evergreen-green rounded border (16px radius)
//   • Subtle green-tinted drop shadow
// so Bashaier sees the same thing the candidate will see when they
// click the acceptance link. No surprises between what she
// previews and what reaches the candidate.
//
// readOnly mode (Badria, Fahad SUP, Jaffar):
//   • Hides the Print / Save-as-PDF button at the top
//   • Adds @media print { body * { visibility:hidden } } so
//     Ctrl+P produces a blank page with a polite message instead
//     of the contract. This is best-effort — see the comment in
//     OffersCard.viewLetter() for the full caveat about browser
//     print prevention.
//
// Body scroll is locked while the modal is open so the page
// behind doesn't drift. The overlay is dismissable by clicking
// outside the card, the X button, or pressing Escape.
// =============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { X, Printer, Loader2 } from 'lucide-react';
import { directGet } from '../supabaseClient.js';
import { buildLetterHtml } from '../lib/offerLetterGenerator.js';

export default function LetterPreviewModal({ offer, onClose, readOnly = false }) {
  const [signatory, setSignatory] = useState(null);
  const [loadingSig, setLoadingSig] = useState(true);

  // Fetch the signatory record so the letter renders with the right
  // name + title in the signature block. Falls back to a placeholder
  // signatory if the lookup fails or the offer has no signatory_id —
  // the letter still renders, just with '—' where the name goes.
  useEffect(() => {
    if (!offer) return;
    let cancelled = false;
    (async () => {
      if (!offer.signatory_id) {
        if (!cancelled) {
          setSignatory({ name: '—', title: '—' });
          setLoadingSig(false);
        }
        return;
      }
      try {
        const sigs = await directGet(
          'signatories',
          `select=name,title&id=eq.${encodeURIComponent(offer.signatory_id)}&limit=1`,
          { timeoutMs: 6000 }
        );
        if (cancelled) return;
        setSignatory(Array.isArray(sigs) && sigs[0] ? sigs[0] : { name: '—', title: '—' });
      } catch {
        if (!cancelled) setSignatory({ name: '—', title: '—' });
      } finally {
        if (!cancelled) setLoadingSig(false);
      }
    })();
    return () => { cancelled = true; };
  }, [offer]);

  // Lock background scroll + Escape-to-close while modal is open.
  // Restore body overflow on unmount so a navigation away mid-modal
  // doesn't leave the page locked.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function onKey(e) { if (e.key === 'Escape') onClose?.(); }
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Build the letter HTML once per offer/signatory change. Same call
  // shape AcceptOfferPage uses, so the candidate and Bashaier both
  // see identical content rendered from the same source.
  const letterHtml = useMemo(() => {
    if (!offer || !signatory) return '';
    return buildLetterHtml(
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
      signatory
    );
  }, [offer, signatory]);

  if (!offer) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Offer letter preview"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(15, 23, 42, 0.55)',
        overflowY: 'auto',
        padding: '24px 16px',
        // Use flex column so the card aligns to the top with margin
        // rather than vertically centered — important because the
        // letter is 1123px tall, taller than most viewports. With
        // center alignment the top of the letter would clip behind
        // the screen edge with no way to scroll up.
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
      }}
    >
      {/* Toolbar — sticks to the top of the modal */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 794,
          background: '#0F4C2A',
          color: '#FFFFFF',
          borderRadius: 12,
          padding: '12px 16px',
          marginBottom: 14,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          boxShadow: '0 4px 16px rgba(0,0,0,0.20)',
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.3px' }}>
            Offer Letter — {offer.candidate_name}
          </div>
          <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>
            {readOnly
              ? 'Read-only preview · printing is restricted'
              : 'This is exactly what the candidate sees on the acceptance page.'}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {!readOnly && (
            <button
              onClick={() => window.print()}
              style={{
                background: '#FFFFFF',
                color: '#0F4C2A',
                border: 'none',
                padding: '8px 14px',
                fontSize: 13,
                fontWeight: 600,
                cursor: 'pointer',
                borderRadius: 6,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
              title="Print or save as PDF"
            >
              <Printer style={{ width: 14, height: 14 }} />
              Print / Save as PDF
            </button>
          )}
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            style={{
              background: 'transparent',
              color: '#FFFFFF',
              border: '1px solid rgba(255,255,255,0.4)',
              padding: 7,
              cursor: 'pointer',
              borderRadius: 6,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>
        </div>
      </div>

      {/* Letter card — matches the candidate-side styling exactly:
          794px max-width, 2px green border, 16px rounded corners,
          green-tinted shadow. */}
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 794,
          background: '#FFFFFF',
          borderRadius: 16,
          border: '2px solid #0F4C2A',
          boxShadow: '0 6px 28px rgba(15, 76, 42, 0.20)',
          overflow: 'hidden',
          marginBottom: 24,
        }}
      >
        {loadingSig ? (
          <div style={{
            padding: 60,
            textAlign: 'center',
            color: '#525252',
            fontSize: 13,
            fontFamily: "'Helvetica Neue', Arial, sans-serif",
          }}>
            <Loader2 style={{ width: 18, height: 18, display: 'inline-block', verticalAlign: 'middle', marginRight: 8 }} className="animate-spin" />
            Loading the contract…
          </div>
        ) : (
          <div dangerouslySetInnerHTML={{ __html: letterHtml }} />
        )}
      </div>

      {/* Print-blocking style block for read-only viewers. Kept inside
          the modal so it only applies while the modal is mounted —
          Bashaier (full-access) doesn't get her print pipeline broken. */}
      {readOnly && (
        <style>{`
          @media print {
            body > *:not([role="dialog"]) { visibility: hidden !important; }
            [role="dialog"] > *:not([data-letter-card]) { visibility: hidden !important; }
            body::after {
              content: "Printing this preview is restricted. Please contact HR for an official copy.";
              visibility: visible;
              position: fixed;
              top: 50%;
              left: 50%;
              transform: translate(-50%, -50%);
              font-family: Arial, sans-serif;
              font-size: 16px;
              color: #525252;
              text-align: center;
              max-width: 320px;
            }
          }
        `}</style>
      )}

      {/* Print-only style for Bashaier so the modal toolbar disappears
          on the printed page (just the letter prints). */}
      {!readOnly && (
        <style>{`
          @media print {
            [role="dialog"] {
              position: static !important;
              background: transparent !important;
              padding: 0 !important;
              overflow: visible !important;
            }
            [role="dialog"] > div:first-child { display: none !important; }
            [role="dialog"] > div:nth-child(2) {
              max-width: none !important;
              border: none !important;
              border-radius: 0 !important;
              box-shadow: none !important;
              margin: 0 !important;
            }
            body > *:not([role="dialog"]) { display: none !important; }
            @page { size: A4 portrait; margin: 0; }
          }
        `}</style>
      )}
    </div>
  );
}
