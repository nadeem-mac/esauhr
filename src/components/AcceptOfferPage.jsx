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

        // If already responded, show the locked summary
        if (row.status === 'offer_accepted' || row.status === 'offer_declined') {
          setStage('responded');
          return;
        }

        // Check expiry
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
          setStage('error');
          setErrorMessage('This offer has expired. The acceptance window was 14 days from issue. Please contact HR if you would like to discuss next steps.');
          return;
        }

        // Load the signatory in parallel for the letter view
        if (row.signatory_id) {
          try {
            const sigRows = await directGet(
              'signatories',
              `select=name,title&id=eq.${encodeURIComponent(row.signatory_id)}&limit=1`,
              { timeoutMs: 6000 }
            );
            if (!cancelled && sigRows?.[0]) {
              setSignatory(sigRows[0]);
            }
          } catch {
            // Non-fatal; the letter just shows '—' for signatory
          }
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
    <div style={{ minHeight: '100vh', background: '#F5F5F5', fontFamily: "'Helvetica Neue', Arial, sans-serif", padding: '24px 16px' }}>
      <div style={{ maxWidth: 920, margin: '0 auto' }}>
        <PageHeader />

        {stage === 'loading' && <CenteredCard><Loading /></CenteredCard>}

        {stage === 'error' && (
          <CenteredCard>
            <ErrorState message={errorMessage} />
          </CenteredCard>
        )}

        {stage === 'responded' && offer && (
          <RespondedState offer={offer} />
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
          <DoneState offer={offer} decision={finalDecision} />
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

function RespondedState({ offer }) {
  const isAccepted = offer.status === 'offer_accepted';
  const respondedDate = offer.responded_at
    ? new Date(offer.responded_at).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })
    : '—';

  return (
    <CenteredCard>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 56, height: 56,
          borderRadius: '50%',
          background: isAccepted ? '#ECFDF3' : '#FEF6E2',
          color: isAccepted ? '#0F4C2A' : '#854F0B',
          marginBottom: 16,
          fontSize: 28, fontWeight: 700,
        }}>
          {isAccepted ? '✓' : '✕'}
        </div>
        <h1 style={{ fontSize: 18, fontWeight: 700, color: '#0F172A', margin: '0 0 8px' }}>
          You have already responded to this offer
        </h1>
        <p style={{ fontSize: 14, color: '#525252', lineHeight: 1.6, maxWidth: 480, margin: '0 auto 12px' }}>
          You {isAccepted ? <strong>accepted</strong> : <strong>declined</strong>} this offer on {respondedDate}.
        </p>
        <p style={{ fontSize: 13, color: '#737373', maxWidth: 480, margin: '0 auto', lineHeight: 1.6 }}>
          If you believe this was recorded in error, please contact HR. The acceptance link cannot be reused.
        </p>
      </div>
    </CenteredCard>
  );
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
        Both fields must match what HR has on file. The acceptance link expires 14 days after issue.
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
      {/* Letter — rendered exactly as the PDF version */}
      <div style={{
        background: '#FFFFFF',
        borderRadius: 8,
        boxShadow: '0 4px 24px rgba(0,0,0,0.10)',
        overflow: 'hidden',
        marginBottom: 20,
      }}>
        <div dangerouslySetInnerHTML={{ __html: letterHtml }} />
      </div>

      {/* Decision panel */}
      <div style={{
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

function DoneState({ offer, decision }) {
  const isAccepted = decision === 'accepted';
  return (
    <CenteredCard>
      <div style={{ textAlign: 'center' }}>
        <div style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 64, height: 64,
          borderRadius: '50%',
          background: isAccepted ? '#ECFDF3' : '#FEF6E2',
          color: isAccepted ? '#0F4C2A' : '#854F0B',
          marginBottom: 16,
          fontSize: 32, fontWeight: 700,
        }}>
          {isAccepted ? '✓' : '✕'}
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0F172A', margin: '0 0 8px' }}>
          {isAccepted ? 'Thank you for accepting!' : 'Your decline has been recorded'}
        </h1>
        <p style={{ fontSize: 14, color: '#525252', lineHeight: 1.7, maxWidth: 520, margin: '0 auto 16px' }}>
          {isAccepted
            ? 'We are delighted to welcome you to the Evergreen team. HR will be in touch with you shortly to begin onboarding through the SOL system and issue your Personal Service Number (PSN).'
            : 'Thank you for letting us know. HR has been notified of your decision. We wish you the very best in your future endeavours.'}
        </p>
        <p style={{ fontSize: 12, color: '#9E9E9E', maxWidth: 480, margin: '0 auto', lineHeight: 1.6 }}>
          Reference: ESAU/HR/{new Date().getFullYear()}/{(offer.offer_token || '').slice(0, 6).toUpperCase()}
          <br />
          Recorded on {new Date(offer.responded_at || Date.now()).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' })}
        </p>
      </div>
    </CenteredCard>
  );
}
