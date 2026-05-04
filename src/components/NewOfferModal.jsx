// =============================================================================
// NewOfferModal.jsx
//
// HR-side form for creating a new candidate offer. Bashaier (or any
// admin/HR reviewer) opens this modal from OffersCard, fills in the
// candidate + offer details, and clicks "Generate offer". The portal:
//
//   1. Inserts a row into offer_letters with status='offer_sent',
//      a freshly-generated 32-char offer_token, and expires_at = +14d
//   2. Generates the offer letter PDF using the chosen signatory
//   3. Builds an .eml file with the PDF attached and the body
//      pre-filled, ready for Bashaier to open in Outlook and send
//   4. Closes the modal and refreshes the offers list
//
// No SendGrid / Resend / DNS — the .eml opens in her actual Outlook
// from her real evergreen-shipping mailbox. Same approach the rest
// of the portal uses (e.g. attendance reports).
// =============================================================================

import React, { useState, useEffect, useMemo } from 'react';
import { X, Loader2, Mail, FileText, AlertCircle, Sparkles } from 'lucide-react';
import { directGet, directPost } from '../supabaseClient.js';
import {
  generateOfferLetterPDF,
  buildOfferEmailBody,
  buildEmlMessage,
  downloadBlob,
  generateOfferToken,
} from '../lib/offerLetterGenerator.js';

const TODAY = new Date().toISOString().slice(0, 10);
// Default join date suggestion: first of next month. Helps Bashaier
// avoid the common typo of accidentally setting today as join date.
function defaultJoinDate() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

export default function NewOfferModal({ open, onClose, onCreated, employees, me }) {
  // ─── Form state ─────────────────────────────────────────────────
  const [candidateName, setCandidateName] = useState('');
  const [candidateEmail, setCandidateEmail] = useState('');
  const [candidatePhone, setCandidatePhone] = useState('');
  const [positionTitle, setPositionTitle] = useState('');
  const [department, setDepartment] = useState('');
  const [proposedJoinDate, setProposedJoinDate] = useState(defaultJoinDate());
  const [salaryAmount, setSalaryAmount] = useState('');
  const [managerId, setManagerId] = useState('');
  const [signatoryId, setSignatoryId] = useState('');

  const [signatories, setSignatories] = useState([]);
  const [signatoriesLoading, setSignatoriesLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // ─── Reset on open ──────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setCandidateName('');
    setCandidateEmail('');
    setCandidatePhone('');
    setPositionTitle('');
    setDepartment('');
    setProposedJoinDate(defaultJoinDate());
    setSalaryAmount('');
    setManagerId('');
    setSignatoryId('');
    setError('');
    // Load signatories every open so freshly added ones appear
    setSignatoriesLoading(true);
    directGet('signatories', 'select=*&active=eq.true&order=display_order.asc')
      .then(rows => setSignatories(rows || []))
      .catch(e => {
        console.warn('signatories load failed:', e);
        setSignatories([]);
      })
      .finally(() => setSignatoriesLoading(false));
  }, [open]);

  // ─── Derived: department list and managers ──────────────────────
  // Departments come from the existing employees table — keeps the
  // values consistent with the rest of the portal.
  const departments = useMemo(() => {
    const set = new Set();
    (employees || []).forEach(e => { if (e.department) set.add(e.department); });
    return [...set].sort();
  }, [employees]);

  // Managers: anyone with is_manager flag, sorted by name. The
  // candidate doesn't exist as an employee yet, so manager_id
  // points at someone real on the active roster.
  const managers = useMemo(() => {
    return (employees || [])
      .filter(e => e.is_manager || e.is_admin)
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [employees]);

  // ─── Validation ─────────────────────────────────────────────────
  const errors = useMemo(() => {
    const list = [];
    if (!candidateName.trim()) list.push('Candidate name is required');
    if (!candidateEmail.trim()) list.push('Personal email is required');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail.trim())) list.push('Personal email format looks invalid');
    if (!positionTitle.trim()) list.push('Position title is required');
    if (!department) list.push('Department is required');
    if (!proposedJoinDate) list.push('Joining date is required');
    else if (proposedJoinDate < TODAY) list.push('Joining date must be today or in the future');
    if (!salaryAmount || Number(salaryAmount) <= 0) list.push('Salary must be greater than zero');
    if (!signatoryId) list.push('Signatory is required (add one in Settings → Signatories first if the list is empty)');
    return list;
  }, [candidateName, candidateEmail, positionTitle, department, proposedJoinDate, salaryAmount, signatoryId]);

  const canSubmit = !submitting && errors.length === 0;

  // ─── Submit ─────────────────────────────────────────────────────
  async function handleGenerate() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');

    try {
      // 1) Build the offer row
      const offerToken = generateOfferToken();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 14);

      const row = {
        candidate_name:       candidateName.trim(),
        candidate_email:      candidateEmail.trim().toLowerCase(),
        candidate_phone:      candidatePhone.trim() || null,
        position_title:       positionTitle.trim(),
        department:           department,
        proposed_join_date:   proposedJoinDate,
        salary_amount:        Number(salaryAmount),
        salary_currency:      'SAR',
        manager_id:           managerId || null,
        signatory_id:         signatoryId,
        offer_token:          offerToken,
        expires_at:           expiresAt.toISOString(),
        status:               'offer_sent',
        created_by_id:        me?.id || null,
      };

      const inserted = await directPost('offer_letters', row, { returning: 'representation' });
      const created = Array.isArray(inserted) ? inserted[0] : inserted;
      if (!created?.id) {
        throw new Error('Insert returned no row');
      }

      // 2) Generate the PDF
      const signatory = signatories.find(s => s.id === signatoryId);
      const manager = managers.find(m => m.id === managerId);
      const pdfBlob = await generateOfferLetterPDF(
        {
          candidateName:    candidateName.trim(),
          positionTitle:    positionTitle.trim(),
          department:       department,
          proposedJoinDate: proposedJoinDate,
          salaryAmount:     Number(salaryAmount),
          managerName:      manager?.name || null,
        },
        signatory
      );

      // 3) Build email body + .eml
      const acceptanceUrl = `${window.location.origin}/accept-offer?token=${offerToken}`;
      const subject = `Offer of employment — ${positionTitle.trim()} — Evergreen Shipping`;
      const body = buildOfferEmailBody(
        { candidateName: candidateName.trim(), positionTitle: positionTitle.trim() },
        acceptanceUrl,
        { name: me?.name || 'BASHAIER ALSUBAIE', email: me?.email || 'bashaier.alsubaie@evergreen-shipping.com.sa' }
      );

      const safeNameForFile = candidateName.trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
      const pdfFilename = `Offer_Letter_${safeNameForFile}.pdf`;

      const eml = await buildEmlMessage({
        fromName:   me?.name || 'BASHAIER ALSUBAIE',
        fromEmail:  me?.email || 'bashaier.alsubaie@evergreen-shipping.com.sa',
        toEmail:    candidateEmail.trim(),
        toName:     candidateName.trim(),
        subject,
        body,
        pdfBlob,
        pdfFilename,
      });

      // 4) Trigger the .eml download — Bashaier double-clicks it,
      // Outlook opens with PDF attached + body filled in. She
      // reviews and hits Send.
      downloadBlob(eml, `Offer_${safeNameForFile}.eml`);

      // 5) Optionally also surface the PDF on disk so she has a
      // standalone copy to file in HR records. Done in a follow-up
      // download to avoid Chrome's "blocked multiple downloads"
      // warning — small delay between them.
      setTimeout(() => {
        downloadBlob(pdfBlob, pdfFilename);
      }, 600);

      // Notify caller and close
      if (onCreated) onCreated(created);
      onClose();
    } catch (e) {
      console.error('Offer creation failed:', e);
      setError(e?.message || 'Could not create the offer. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="New offer"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: '#FFFFFF',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: '0 20px 50px rgba(15, 23, 42, 0.25)',
          width: '100%',
          maxWidth: 540,
          maxHeight: 'calc(100vh - 32px)',
          overflowY: 'auto',
          padding: '24px 26px',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#0A0A0A', fontWeight: 700 }}>
              NEW OFFER
            </div>
            <div style={{ fontFamily: 'Georgia, serif', fontSize: 22, color: '#0A0A0A' }}>
              Issue offer letter
            </div>
            <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              Generates the letter as a PDF and an Outlook draft (.eml). Open the .eml to review and send.
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-full opacity-60 hover:opacity-100"
            style={{ border: '1px solid var(--border)', background: 'transparent' }}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Candidate section */}
        <FormSection title="Candidate" icon={<Sparkles className="w-3 h-3" />}>
          <Field label="Full name *" required>
            <Input value={candidateName} onChange={setCandidateName} placeholder="e.g. Sami Al-Mansour" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Personal email *" required>
              <Input
                value={candidateEmail}
                onChange={(v) => setCandidateEmail(v)}
                placeholder="name@example.com"
                type="email"
              />
            </Field>
            <Field label="Phone (optional)">
              <Input value={candidatePhone} onChange={setCandidatePhone} placeholder="+966 5X XXX XXXX" />
            </Field>
          </div>
        </FormSection>

        {/* Offer details */}
        <FormSection title="Offer details">
          <Field label="Position title *" required>
            <Input value={positionTitle} onChange={setPositionTitle} placeholder="e.g. CSD Officer" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Department *" required>
              <Select value={department} onChange={setDepartment}>
                <option value="">— select —</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </Select>
            </Field>
            <Field label="Reporting to (manager)">
              <Select value={managerId} onChange={setManagerId}>
                <option value="">— none / TBD —</option>
                {managers.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.id})
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Joining date *" required>
              <Input type="date" value={proposedJoinDate} onChange={setProposedJoinDate} />
            </Field>
            <Field label="Monthly salary (SAR) *" required>
              <Input
                type="number"
                value={salaryAmount}
                onChange={setSalaryAmount}
                placeholder="e.g. 8000"
                min="0"
                step="100"
              />
            </Field>
          </div>
        </FormSection>

        {/* Signatory */}
        <FormSection title="Letter signatory">
          {signatoriesLoading ? (
            <div className="flex items-center gap-2 text-xs" style={{ color: '#0A0A0A', opacity: 0.6 }}>
              <Loader2 className="w-3 h-3 animate-spin" /> Loading signatories…
            </div>
          ) : signatories.length === 0 ? (
            <div
              className="rounded-lg p-3 text-xs flex items-start gap-2"
              style={{ background: '#FEF3C7', border: '1px solid #F0CB69', color: '#854F0B' }}
            >
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <div>
                No signatories configured yet. Add one in <strong>Settings → Signatories</strong> (coming next), or via SQL editor for now. The signatory's name and title appears in the offer letter signature block.
              </div>
            </div>
          ) : (
            <Field label="Signed by *" required>
              <Select value={signatoryId} onChange={setSignatoryId}>
                <option value="">— select —</option>
                {signatories.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name} — {s.title}
                    {s.department_scope ? ` (${s.department_scope})` : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </FormSection>

        {/* Validation summary */}
        {errors.length > 0 && (
          <div
            className="rounded-lg p-3 text-xs mb-3"
            style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}
          >
            <div className="font-semibold mb-1">Please fix:</div>
            <ul className="list-disc pl-4 space-y-0.5">
              {errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          </div>
        )}

        {/* Hard error from submit */}
        {error && (
          <div
            className="rounded-lg p-3 text-xs mb-3 flex items-start gap-2"
            style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}
          >
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
            <div>{error}</div>
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-2 border-t" style={{ borderColor: 'var(--border-soft)' }}>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm transition-opacity"
            style={{
              background: 'transparent',
              color: '#0A0A0A',
              border: '1px solid var(--border)',
              fontWeight: 500,
              cursor: submitting ? 'not-allowed' : 'pointer',
              opacity: submitting ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleGenerate}
            disabled={!canSubmit}
            className="px-4 py-2 rounded-lg text-sm flex items-center gap-2 transition-opacity"
            style={{
              background: 'var(--evergreen-600)',
              color: '#FFFFFF',
              fontWeight: 600,
              opacity: canSubmit ? 1 : 0.5,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
            {submitting ? 'Generating…' : 'Generate offer'}
          </button>
        </div>

        {/* Footer note */}
        <div className="text-[11px] mt-3 leading-relaxed" style={{ color: '#0A0A0A', opacity: 0.6 }}>
          On generate: offer is recorded with a 14-day acceptance window. PDF and Outlook draft (.eml) download — open the .eml to review and send. The candidate clicks the link in your email to accept.
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────

function FormSection({ title, icon, children }) {
  return (
    <div className="mb-4 pb-4 border-b" style={{ borderColor: 'var(--border-soft)' }}>
      <div className="text-[10px] tracking-[0.2em] mb-2.5 flex items-center gap-1.5" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
        {icon} {title.toUpperCase()}
      </div>
      <div className="space-y-3">{children}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="text-[11px] mb-1" style={{ color: '#0A0A0A', fontWeight: 600 }}>{label}</div>
      {children}
    </label>
  );
}

function Input({ value, onChange, placeholder, type = 'text', min, step }) {
  return (
    <input
      type={type}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      min={min}
      step={step}
      className="w-full text-sm rounded-lg px-3 py-2"
      style={{
        background: '#FFFFFF',
        border: '1px solid var(--border)',
        color: '#0A0A0A',
        outline: 'none',
      }}
    />
  );
}

function Select({ value, onChange, children }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full text-sm rounded-lg px-3 py-2"
      style={{
        background: '#FFFFFF',
        border: '1px solid var(--border)',
        color: '#0A0A0A',
        outline: 'none',
      }}
    >
      {children}
    </select>
  );
}
