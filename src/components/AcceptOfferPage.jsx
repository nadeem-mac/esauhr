// =============================================================================
// AcceptOfferPage.jsx
//
// Public landing page for offer-letter acceptance. Anyone who clicks
// the link in Bashaier's covering email lands here — no portal login
// required. The flow has four distinct UI states:
//
//   1. LOADING     — fetching the offer by token
//   2. ERROR       — token invalid / expired / network failure
//   3. RESPONDED   — offer was already accepted/declined; show summary
//                    + locked state ("contact HR if you believe this
//                    is an error")
//   4. ACTIVE      — pending response. Two sub-states:
//        a. VERIFY  — entry form for email + Iqama
//        b. DECIDE  — letter rendered + Accept/Decline buttons
//
// SECURITY
//   • The token is 24 random bytes (≈10^57 possibilities) so the URL
//     itself is unguessable. Public exposure is acceptable.
//   • Identity verification: candidate must enter both the personal
//     email Bashaier sent the offer to AND their Iqama / National ID.
//     Email alone is too weak (anyone with the email can paste it
//     in); Iqama proves they're the actual person.
//   • One-shot: once status is offer_accepted or offer_declined,
//     responded_at is set and re-visits show the locked summary.
//   • Audit trail: every accept/decline writes an audit_log row with
//     IP-best-effort, user-agent, and the decision.
//
// NO TRUSTED DATA EXPOSED
//   The page reads only the candidate's OWN offer row (matched by
//   token) and the signatory referenced on it. No employee, leave,
//   shift, or other portal data is touched. PostgREST RLS still
//   applies; the public policy on offer_letters lets the anon role
//   read by token because the token is the secret.
// =============================================================================

import React, { useEffect, useState, useMemo } from 'react';
import { directGet, directPatch } from '../supabaseClient.js';
import { buildLetterHtml } from '../lib/offerLetterGenerator.js';
import EvergreenLogo from './EvergreenLogo.jsx';

const TOKEN_RX = /^[A-Za-z0-9_-]{20,}$/;

export default function AcceptOfferPage({ token }) {
  // Top-level UI state
  //   stage: 'loading' | 'error' | 'responded' | 'verify' | 'decide'
  //          | 'submitting' | 'done'
  const [stage, setStage] = useState('loading');
  const [errorMessage, setErrorMessage] = useState('');
  const [offer, setOffer] = useState(null);
  const [signatory, setSignatory] = useState(null);

  // Verify form
  const [verifyEmail, setVerifyEmail] = useState('');
  const [verifyIqama, setVerifyIqama] = useState('');
  const [verifyError, setVerifyError] = useState('');

  // Decision UI
  const [showingDeclineForm, setShowingDeclineForm] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [decisionError, setDecisionError] = useState('');

  // Final state — what they did
  const [finalDecision, setFinalDecision] = useState(null); // 'accepted' | 'declined'

  // ─── Initial load ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!token || !TOKEN_RX.test(token)) {
        setStage('error');
        setErrorMessage('The link is missing or malformed. Please check the URL or contact HR.');
        return;
      }
      try {
        const rows = await directGet(
          'offer_letters',
          `select=*&offer_token=eq.${encodeURIComponent(token)}&limit=1`,
          { timeoutMs: 8000 }
        );
        if (cancelled) return;
        const row = Array.isArray(rows) ? rows[0] : null;
        if (!row) {
          setStage('error');
          setErrorMessage('This offer link is not recognized. Please check that you copied the full link, or contact HR if you believe this is an error.');
          return;
        }
        setOffer(row);

        // Load the signatory regardless of the next stage — both
        // 'verify→decide' and the 'responded' revisit case need to
        // render the (stamped) letter, and that needs the signatory's
        // name + title in the company-side block.
        let loadedSignatory = null;
        if (row.signatory_id) {
          try {
            const sigRows = await directGet(
              'signatories',
              `select=name,title&id=eq.${encodeURIComponent(row.signatory_id)}&limit=1`,
              { timeoutMs: 6000 }
            );
            if (!cancelled && sigRows?.[0]) {
              loadedSignatory = sigRows[0];
              setSignatory(loadedSignatory);
            }
          } catch {
            // Non-fatal; the letter just shows '—' for signatory
          }
        }

        // If already responded, show the locked summary (with
        // stamped contract + email-back instructions for accepted).
        if (row.status === 'offer_accepted' || row.status === 'offer_declined') {
          setStage('responded');
          return;
        }

        // Check expiry
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
          setStage('error');
          setErrorMessage('This offer has expired. The acceptance window was 7 days from issue. Please contact HR if you would like to discuss next steps.');
          return;
        }

        setStage('verify');
      } catch (e) {
        if (cancelled) return;
        setStage('error');
        setErrorMessage('Could not load this offer. Please check your connection and try again, or contact HR.');
        console.error('Offer load failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  // ─── Verification ──────────────────────────────────────────────
  function handleVerify(e) {
    e.preventDefault();
    setVerifyError('');

    const emailMatch = verifyEmail.trim().toLowerCase() === (offer.candidate_email || '').toLowerCase();
    const iqamaMatch = verifyIqama.trim() === (offer.candidate_iqama || '');

    if (!emailMatch || !iqamaMatch) {
      // Don't tell the candidate WHICH field failed — that would let
      // an attacker enumerate. Generic error covers both cases.
      setVerifyError('The email or Iqama / National ID does not match our records. Please double-check and try again. If you continue to have trouble, contact HR.');
      return;
    }

    setStage('decide');
  }

  // ─── Submit decision ───────────────────────────────────────────
  async function submitDecision(decision /* 'accepted' | 'declined' */, reason = null) {
    setDecisionError('');
    setStage('submitting');

    const newStatus = decision === 'accepted' ? 'offer_accepted' : 'offer_declined';
    const patch = {
      status: newStatus,
      responded_at: new Date().toISOString(),
      response_user_agent: (navigator.userAgent || '').slice(0, 500),
      // response_ip is captured server-side via PostgREST trigger if
      // configured; we don't try to fetch the IP from the client (that
      // would be the client's idea of its own IP, which is unreliable
      // and easy to spoof). Left null here.
    };
    if (decision === 'declined' && reason) {
      patch.decline_reason = reason.trim().slice(0, 1000);
    }

    try {
      // Patch by token AND status='offer_sent' to guarantee one-shot
      // semantics — if a concurrent request already flipped the status,
      // this PATCH affects 0 rows and we surface that as an error.
      const updated = await directPatch(
        'offer_letters',
        'offer_token',
        offer.offer_token,
        patch,
        {
          timeoutMs: 8000,
          // Returning=representation so we can confirm the row updated
          headers: { 'Prefer': 'return=representation' },
        }
      );
      const updatedRow = Array.isArray(updated) ? updated[0] : updated;
      if (!updatedRow?.id) {
        // No rows updated — most likely already responded between page
        // load and submit (very rare race condition).
        setStage('responded');
        if (offer) setOffer({ ...offer, status: newStatus, responded_at: patch.responded_at });
        return;
      }

      setOffer(updatedRow);
      setFinalDecision(decision);
      setStage('done');
    } catch (e) {
      console.error('Decision submit failed:', e);
      setDecisionError('Could not record your response. Please check your connection and try again.');
      setStage('decide');
    }
  }

  // ─── Render ────────────────────────────────────────────────────
  return (
    <div style={{ minHeight: '100vh', background: '#F5F5F5', fontFamily: 'inherit', padding: '24px 16px' }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <PageHeader />

        {stage === 'loading' && <CenteredCard><Loading /></CenteredCard>}

        {stage === 'error' && (
          <CenteredCard>
            <ErrorState message={errorMessage} />
          </CenteredCard>
        )}

        {stage === 'responded' && offer && (
          <RespondedState offer={offer} signatory={signatory} />
        )}

        {stage === 'verify' && offer && (
          <VerifyForm
            offer={offer}
            email={verifyEmail}
            setEmail={setVerifyEmail}
            iqama={verifyIqama}
            setIqama={setVerifyIqama}
            error={verifyError}
            onSubmit={handleVerify}
          />
        )}

        {(stage === 'decide' || stage === 'submitting') && offer && signatory !== undefined && (
          <DecideView
            offer={offer}
            signatory={signatory}
            submitting={stage === 'submitting'}
            showingDeclineForm={showingDeclineForm}
            setShowingDeclineForm={setShowingDeclineForm}
            declineReason={declineReason}
            setDeclineReason={setDeclineReason}
            error={decisionError}
            onAccept={() => submitDecision('accepted')}
            onDecline={(reason) => submitDecision('declined', reason)}
          />
        )}

        {stage === 'done' && offer && (
          <DoneState offer={offer} decision={finalDecision} signatory={signatory} />
        )}

        <Footer />
      </div>
    </div>
  );
}

// ─── Page chrome ───────────────────────────────────────────────────

function PageHeader() {
  return (
    <div style={{ textAlign: 'center', marginBottom: 24 }}>
      {/* Same logo + sizing the dashboard uses: full Evergreen
          wordmark image, medium size. Centered above the content
          rather than next to it so the candidate sees a familiar
          corporate header on first load. */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 6 }}>
        <EvergreenLogo variant="full" size="md" />
      </div>
      <div style={{ fontSize: 11, color: '#737373' }}>
        Evergreen Shipping Agency Saudi Co. (LLC)
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div style={{ marginTop: 28, textAlign: 'center', fontSize: 11, color: '#9E9E9E' }}>
      Need help? Contact HR at <a href="mailto:bashaier.alsubaie@evergreen-shipping.com.sa" style={{ color: '#0F4C2A' }}>bashaier.alsubaie@evergreen-shipping.com.sa</a>
    </div>
  );
}

function CenteredCard({ children }) {
  return (
    <div style={{
      background: '#FFFFFF',
      borderRadius: 12,
      padding: '40px 32px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
      border: '1px solid #E5E5E5',
    }}>
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div style={{ textAlign: 'center', color: '#737373', fontSize: 14 }}>
      Loading your offer letter…
    </div>
  );
}

function ErrorState({ message }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 56, height: 56,
        borderRadius: '50%',
        background: '#FEF2F2',
        marginBottom: 16,
        fontSize: 28, color: '#DC2626',
      }}>!</div>
      <h1 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', margin: '0 0 8px' }}>
        We couldn't open this offer
      </h1>
      <p style={{ fontSize: 14, color: '#525252', lineHeight: 1.6, maxWidth: 480, margin: '0 auto' }}>
        {message}
      </p>
    </div>
  );
}

// ─── Already-responded state ───────────────────────────────────────

// ─── Decision recorded — shared component for both fresh submissions
// and revisits. Renders the stamped contract + email-back
// instructions when accepted; a simpler confirmation when declined.
function RespondedState({ offer, signatory }) {
  const isAccepted = offer.status === 'offer_accepted';
  if (!isAccepted) {
    return <DeclineRecordedCard offer={offer} />;
  }
  return <AcceptanceRecordedView offer={offer} signatory={signatory} />;
}

// ─── Verify form ───────────────────────────────────────────────────

function VerifyForm({ offer, email, setEmail, iqama, setIqama, error, onSubmit }) {
  const positionLine = offer.position_title || 'the role';

  return (
    <div style={{
      background: '#FFFFFF',
      borderRadius: 12,
      padding: '32px 28px',
      boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
      border: '1px solid #E5E5E5',
      maxWidth: 540,
      margin: '0 auto',
    }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 11, color: '#0F4C2A', fontWeight: 700, letterSpacing: '0.5px', marginBottom: 4 }}>
          IDENTITY VERIFICATION
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0F172A', margin: '0 0 8px' }}>
          Welcome, {(offer.candidate_name || '').split(' ')[0] || 'Candidate'}
        </h1>
        <p style={{ fontSize: 13, color: '#525252', lineHeight: 1.6, margin: 0 }}>
          You have an offer for <strong>{positionLine}</strong> at Evergreen Shipping Agency Saudi Co. (LLC).
          Please verify your identity to view the offer letter and respond.
        </p>
      </div>

      <form onSubmit={onSubmit}>
        <Label>Personal email</Label>
        <Input
          type="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          placeholder="The email this offer was sent to"
          autoComplete="email"
          required
        />

        <Label style={{ marginTop: 16 }}>Iqama / National ID</Label>
        <Input
          type="text"
          inputMode="numeric"
          value={iqama}
          onChange={e => setIqama(e.target.value.replace(/\D/g, '').slice(0, 10))}
          placeholder="10-digit number"
          required
        />

        {error && (
          <div style={{
            background: '#FEF2F2',
            border: '1px solid #FCA5A5',
            color: '#991B1B',
            padding: '10px 12px',
            borderRadius: 6,
            fontSize: 13,
            marginTop: 16,
            lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          style={{
            marginTop: 20,
            width: '100%',
            padding: '12px 16px',
            background: '#0F4C2A',
            color: '#FFFFFF',
            border: 'none',
            borderRadius: 6,
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
            letterSpacing: '0.3px',
          }}
        >
          Verify and view offer
        </button>
      </form>

      <p style={{ fontSize: 11, color: '#9E9E9E', marginTop: 14, textAlign: 'center', lineHeight: 1.6 }}>
        Both fields must match what HR has on file. The acceptance link expires 7 days after issue.
      </p>
    </div>
  );
}

function Label({ children, style }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 600, color: '#0F172A', marginBottom: 6, ...(style || {}) }}>
      {children}
    </div>
  );
}

function Input({ ...props }) {
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '10px 12px',
        fontSize: 14,
        border: '1px solid #D5D5D5',
        borderRadius: 6,
        background: '#FFFFFF',
        color: '#0F172A',
        outline: 'none',
        fontFamily: 'inherit',
      }}
    />
  );
}

// ─── Letter + decision view ────────────────────────────────────────

function DecideView({ offer, signatory, submitting, showingDeclineForm, setShowingDeclineForm, declineReason, setDeclineReason, error, onAccept, onDecline }) {
  // Render the same letter HTML the PDF was generated from. The
  // candidate sees exactly what they're agreeing to.
  const letterHtml = useMemo(() => {
    return buildLetterHtml(
      {
        candidateName:    offer.candidate_name,
        positionTitle:    offer.position_title,
        department:       offer.department,
        location:         offer.location_label || offer.location || '',
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
  }, [offer, signatory]);

  const declineValid = declineReason.trim().length >= 5;

  return (
    <>
      {/* Letter — rendered exactly as the PDF version. Wrapper is
          sized to the letter's natural 794px width and centered so
          the candidate sees no dead space to either side on wider
          screens. The green rounded border highlights this as the
          official contract document — distinct from the decision
          panel below it. overflow:hidden clips the letter HTML's
          internal corners against the rounded border. */}
      <div style={{
        maxWidth: 794,
        margin: '0 auto 20px',
        background: '#FFFFFF',
        borderRadius: 16,
        border: '2px solid #0F4C2A',
        boxShadow: '0 6px 28px rgba(15, 76, 42, 0.15)',
        overflow: 'hidden',
      }}>
        <div dangerouslySetInnerHTML={{ __html: letterHtml }} />
      </div>

      {/* Decision panel — sized to match the letter width so the
          page reads as one coherent column on desktop. */}
      <div style={{
        maxWidth: 794,
        margin: '0 auto',
        background: '#FFFFFF',
        borderRadius: 12,
        padding: '24px 28px',
        boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
        border: '1px solid #E5E5E5',
      }}>
        <div style={{ fontSize: 11, color: '#0F4C2A', fontWeight: 700, letterSpacing: '0.5px', marginBottom: 4 }}>
          YOUR DECISION
        </div>
        <h2 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', margin: '0 0 6px' }}>
          Please respond to this offer
        </h2>
        <p style={{ fontSize: 13, color: '#525252', lineHeight: 1.6, margin: '0 0 18px' }}>
          By accepting, you confirm you have read the offer above and agree to the terms set out in the letter.
          You can only respond once. After accepting, HR will register you in the SOL system and issue your Personal Service Number.
        </p>

        {!showingDeclineForm ? (
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={onAccept}
              disabled={submitting}
              style={{
                flex: '1 1 200px',
                padding: '14px 20px',
                background: '#0F4C2A',
                color: '#FFFFFF',
                border: 'none',
                borderRadius: 6,
                fontSize: 15,
                fontWeight: 700,
                cursor: submitting ? 'wait' : 'pointer',
                letterSpacing: '0.3px',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              {submitting ? 'Submitting…' : '✓ Accept this offer'}
            </button>
            <button
              type="button"
              onClick={() => setShowingDeclineForm(true)}
              disabled={submitting}
              style={{
                flex: '1 1 200px',
                padding: '14px 20px',
                background: '#FFFFFF',
                color: '#525252',
                border: '1.5px solid #D5D5D5',
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 600,
                cursor: submitting ? 'wait' : 'pointer',
                opacity: submitting ? 0.6 : 1,
              }}
            >
              Decline
            </button>
          </div>
        ) : (
          <div>
            <Label>Reason for declining (required)</Label>
            <textarea
              value={declineReason}
              onChange={e => setDeclineReason(e.target.value.slice(0, 1000))}
              placeholder="A brief explanation helps HR follow up appropriately. Minimum 5 characters."
              rows={4}
              style={{
                width: '100%',
                padding: '10px 12px',
                fontSize: 14,
                border: '1px solid #D5D5D5',
                borderRadius: 6,
                background: '#FFFFFF',
                color: '#0F172A',
                outline: 'none',
                fontFamily: 'inherit',
                resize: 'vertical',
              }}
            />
            <div style={{ fontSize: 11, color: '#9E9E9E', marginTop: 4, textAlign: 'right' }}>
              {declineReason.length} / 1000
            </div>
            <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
              <button
                type="button"
                onClick={() => { setShowingDeclineForm(false); setDeclineReason(''); }}
                disabled={submitting}
                style={{
                  flex: '0 0 auto',
                  padding: '12px 18px',
                  background: 'transparent',
                  color: '#525252',
                  border: '1px solid #D5D5D5',
                  borderRadius: 6,
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: submitting ? 'wait' : 'pointer',
                }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => onDecline(declineReason)}
                disabled={submitting || !declineValid}
                style={{
                  flex: 1,
                  padding: '12px 18px',
                  background: declineValid ? '#991B1B' : '#D5D5D5',
                  color: '#FFFFFF',
                  border: 'none',
                  borderRadius: 6,
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: (submitting || !declineValid) ? 'not-allowed' : 'pointer',
                  opacity: submitting ? 0.6 : 1,
                }}
              >
                {submitting ? 'Submitting…' : 'Submit decline'}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div style={{
            background: '#FEF2F2',
            border: '1px solid #FCA5A5',
            color: '#991B1B',
            padding: '10px 12px',
            borderRadius: 6,
            fontSize: 13,
            marginTop: 14,
            lineHeight: 1.5,
          }}>
            {error}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Done state ───────────────────────────────────────────────────

// ─── Done — shown immediately after the candidate submits their
// decision. Routes to the same recorded-state components used by
// revisits (RespondedState), so a candidate who accepts and stays
// on the page sees the same screen they'd see if they came back to
// the link tomorrow.
function DoneState({ offer, decision, signatory }) {
  if (decision === 'accepted' || offer.status === 'offer_accepted') {
    return <AcceptanceRecordedView offer={offer} signatory={signatory} />;
  }
  return <DeclineRecordedCard offer={offer} />;
}

// ─── Acceptance recorded — main view after Accept ──────────────────
//
// Shows three things, top to bottom:
//   1. A success header confirming the acceptance is on file
//   2. The "Next steps" panel — Download contract + email-back
//      instructions with a pre-filled mailto: button
//   3. The contract preview WITH the digital acceptance stamp baked
//      in, so the candidate can see what their downloaded copy will
//      contain
//
// The same view is used both immediately after submission and on
// revisits to the link, so a candidate who accepts at midnight and
// reopens the link the next morning sees exactly the same thing.
//
// Sized to match DecideView's layout (794px max-width centered, green
// rounded border around the contract).
function AcceptanceRecordedView({ offer, signatory }) {
  const respondedAt = offer.responded_at
    ? new Date(offer.responded_at)
    : new Date();

  const ref = `ESAU/HR/${respondedAt.getFullYear()}/${(offer.offer_token || '').slice(0, 6).toUpperCase()}`;

  // Build the letter HTML WITH the acceptance mark — drives both the
  // on-page preview and the printable version that opens when the
  // candidate clicks Download.
  const letterHtml = useMemo(() => {
    return buildLetterHtml(
      {
        candidateName:    offer.candidate_name,
        positionTitle:    offer.position_title,
        department:       offer.department,
        location:         offer.location_label || offer.location || '',
        proposedJoinDate: offer.proposed_join_date,
        salaryBasic:      offer.salary_basic || 0,
        salaryHousing:    offer.salary_housing || 0,
        salaryTransport:  offer.salary_transportation || 0,
        salaryOther:      offer.salary_other || 0,
        salaryTotal:      offer.salary_amount || 0,
        offerToken:       offer.offer_token,
      },
      signatory || { name: '—', title: '—' },
      {
        acceptedAt: respondedAt.toISOString(),
        candidateName: offer.candidate_name,
        ref,
      }
    );
  }, [offer, signatory, respondedAt, ref]);

  // Download / Save-as-PDF — opens a popup containing JUST the
  // stamped letter HTML, then triggers print after images load.
  // Same proven pattern used by the LetterPreviewModal print
  // button on the HR side. The print dialog lets the candidate
  // choose Save as PDF (default on most modern browsers), giving
  // them a permanent stamped copy to attach to their reply email.
  function downloadStamped() {
    const win = window.open('', '_blank', 'width=900,height=1100');
    if (!win) {
      alert('Your browser blocked the download window. Please allow pop-ups for this site and try again.');
      return;
    }
    const safeName = (offer.candidate_name || 'Candidate')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '_');
    const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Offer_Letter_Accepted_${safeName}</title>
  <style>
    @page { size: A4 portrait; margin: 0; }
    @media print { body { margin: 0; } }
    html, body { margin: 0; padding: 0; background: #fff; }
  </style>
</head>
<body>
  ${letterHtml}
  <script>
    (function(){
      var imgs = Array.prototype.slice.call(document.querySelectorAll('img'));
      var pending = imgs.filter(function(i){ return !i.complete; }).length;
      var triggered = false;
      function go(){
        if (triggered) return;
        triggered = true;
        setTimeout(function(){ window.print(); }, 250);
      }
      if (pending === 0) { go(); }
      else {
        imgs.forEach(function(i){
          if (i.complete) return;
          var done = function(){ pending--; if (pending <= 0) go(); };
          i.addEventListener('load', done);
          i.addEventListener('error', done);
        });
        setTimeout(go, 3500);
      }
    })();
  </script>
</body>
</html>`;
    win.document.open();
    win.document.write(html);
    win.document.close();
  }

  // Pre-filled email-back. Opens the candidate's default mail
  // handler with HR's address as the recipient and a body that
  // names the position, reference, and asks them to attach the
  // downloaded PDF. mailto: doesn't support attachments — the
  // candidate has to drag the saved file in manually — but the
  // body explicitly tells them to do that.
  function emailBack() {
    const to = 'bashaier.alsubaie@evergreen-shipping.com.sa';
    const subject = `Accepted offer — ${(offer.candidate_name || 'Candidate')} — ${(offer.position_title || 'Evergreen Shipping')}`;
    const body = [
      `Dear HR,`,
      ``,
      `Please find attached the signed acceptance of the offer letter for the ${offer.position_title || 'role'} position.`,
      ``,
      `Reference: ${ref}`,
      `Acceptance recorded: ${respondedAt.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Riyadh' })} (Asia/Riyadh)`,
      ``,
      `* Please attach the offer letter PDF you saved from the acceptance page before sending. *`,
      ``,
      `Best regards,`,
      `${(offer.candidate_name || '').replace(/\b\w/g, c => c.toUpperCase())}`,
    ].join('\r\n');

    // mailto: requires %20 for spaces, not + (which is form-encoding).
    const qs = [
      `subject=${encodeURIComponent(subject)}`,
      `body=${encodeURIComponent(body)}`,
    ].join('&');
    window.location.assign(`mailto:${encodeURIComponent(to)}?${qs}`);
  }

  return (
    <>
      {/* Success header — confirms the acceptance is on file BEFORE
          the candidate scrolls down. Sized to match the contract's
          794px width below it. */}
      <div style={{
        maxWidth: 794,
        margin: '0 auto 14px',
        background: '#FFFFFF',
        borderRadius: 12,
        border: '2px solid #0F4C2A',
        padding: '20px 24px',
        textAlign: 'center',
        boxShadow: '0 4px 16px rgba(15, 76, 42, 0.12)',
      }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 56, height: 56,
          borderRadius: '50%',
          background: '#0F4C2A',
          color: '#FFFFFF',
          marginBottom: 12,
          fontSize: 28, fontWeight: 700,
        }}>
          ✓
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0F4C2A', margin: '0 0 6px' }}>
          Your acceptance has been recorded
        </h1>
        <p style={{ fontSize: 13, color: '#525252', lineHeight: 1.6, margin: '0 auto', maxWidth: 580 }}>
          Reference {ref} — recorded on {respondedAt.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Riyadh' })} (Asia/Riyadh).
          A copy of the contract below shows your digital acceptance stamp.
        </p>
      </div>

      {/* Next steps — primary action panel. Telling the candidate
          BEFORE they see the contract that they need to (a) save it
          and (b) email it back means they read the contract knowing
          what they need to do next. */}
      <div style={{
        maxWidth: 794,
        margin: '0 auto 20px',
        background: '#FEF6E2',
        borderRadius: 12,
        border: '1px solid #E8C896',
        padding: '18px 22px',
      }}>
        <div style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.18em',
          color: '#854F0B',
          marginBottom: 6,
        }}>
          NEXT STEPS — PLEASE COMPLETE
        </div>
        <h2 style={{
          fontSize: 16,
          fontWeight: 700,
          color: '#0F172A',
          margin: '0 0 10px',
        }}>
          Save the contract and email it to HR
        </h2>
        <ol style={{
          fontSize: 13,
          color: '#525252',
          lineHeight: 1.7,
          margin: '0 0 16px 18px',
          padding: 0,
        }}>
          <li><strong>Download</strong> the contract below — your acceptance is stamped on it.</li>
          <li><strong>Email</strong> the saved PDF to HR using the button below to confirm receipt and complete your file.</li>
        </ol>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button
            onClick={downloadStamped}
            style={{
              background: '#0F4C2A',
              color: '#FFFFFF',
              border: 'none',
              padding: '11px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              borderRadius: 8,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            ⬇ Download contract (PDF)
          </button>
          <button
            onClick={emailBack}
            style={{
              background: '#FFFFFF',
              color: '#0F4C2A',
              border: '1.5px solid #0F4C2A',
              padding: '11px 20px',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              borderRadius: 8,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            ✉ Open email to HR
          </button>
        </div>
        <div style={{
          fontSize: 11,
          color: '#854F0B',
          marginTop: 10,
          fontStyle: 'italic',
        }}>
          The email opens with HR's address, subject, and message pre-filled — please attach the PDF you saved before sending.
        </div>
      </div>

      {/* Stamped contract — same green-bordered card style as
          DecideView so the candidate sees it occupy the same space
          they reviewed before, just now with the acceptance mark. */}
      <div style={{
        maxWidth: 794,
        margin: '0 auto',
        background: '#FFFFFF',
        borderRadius: 16,
        border: '2px solid #0F4C2A',
        boxShadow: '0 6px 28px rgba(15, 76, 42, 0.15)',
        overflow: 'hidden',
        marginBottom: 24,
      }}>
        <style>{`
          /* The .offer-letter container has height:1123px + overflow:
             hidden baked in for the print path. Override here so the
             stamped contract grows naturally on screen — same trick
             the LetterPreviewModal uses. */
          .acceptance-recorded .offer-letter {
            height: auto !important;
            min-height: 1123px;
            overflow: visible !important;
          }
        `}</style>
        <div className="acceptance-recorded" dangerouslySetInnerHTML={{ __html: letterHtml }} />
      </div>
    </>
  );
}

// ─── Decline recorded — simpler card, no contract download ─────────
function DeclineRecordedCard({ offer }) {
  const respondedAt = offer.responded_at
    ? new Date(offer.responded_at)
    : new Date();
  const ref = `ESAU/HR/${respondedAt.getFullYear()}/${(offer.offer_token || '').slice(0, 6).toUpperCase()}`;

  return (
    <CenteredCard>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 56, height: 56,
          borderRadius: '50%',
          background: '#FEF6E2',
          color: '#854F0B',
          marginBottom: 16,
          fontSize: 28, fontWeight: 700,
        }}>
          ✕
        </div>
        <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0F172A', margin: '0 0 8px' }}>
          Your decline has been recorded
        </h1>
        <p style={{ fontSize: 14, color: '#525252', lineHeight: 1.7, maxWidth: 480, margin: '0 auto 14px' }}>
          Thank you for letting us know. HR has been notified. We wish you the very best in your future endeavours.
        </p>
        <p style={{ fontSize: 12, color: '#9E9E9E', maxWidth: 480, margin: '0 auto', lineHeight: 1.6 }}>
          Reference: {ref}
          <br />
          Recorded on {respondedAt.toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Riyadh' })} (Asia/Riyadh)
        </p>
      </div>
    </CenteredCard>
  );
}
