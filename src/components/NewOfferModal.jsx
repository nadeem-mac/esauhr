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
import { X, Loader2, Mail, FileText, AlertCircle, Sparkles, Plus } from 'lucide-react';
import { directGet, directPost } from '../supabaseClient.js';
import { LOCATION_LABELS } from '../lib/leaveLogic.js';
import {
  generateOfferLetterPDF,
  buildOfferEmailBody,
  buildEmlMessage,
  downloadBlob,
  generateOfferToken,
} from '../lib/offerLetterGenerator.js';

// Position catalogue keyed by department code. Drives the
// position-title dropdown in the New Offer form. Each list is the
// canonical set of role titles HR uses internally; if a position
// doesn't fit, a "Custom…" option lets Bashaier type a free-text
// title. Update these lists in one place when new roles are
// introduced.
const POSITIONS_BY_DEPARTMENT = {
  SUP: [
    'Supervisor',
    'Senior Supervisor',
    'Operations Supervisor',
    'Government Affairs Officer',
    'Government Relations Officer',
    'Customs Coordinator',
    'Document Controller',
  ],
  BIZ: [
    'Business Analyst',
    'Sales Executive',
    'Senior Sales Executive',
    'Account Manager',
    'Business Development Officer',
    'Marketing Coordinator',
  ],
  CSD: [
    'Customer Service Officer',
    'Senior Customer Service Officer',
    'Customer Service Coordinator',
    'Documentation Officer',
    'Booking Officer',
    'Import Coordinator',
    'Export Coordinator',
  ],
  OPS: [
    'Operations Officer',
    'Senior Operations Officer',
    'Vessel Operations Officer',
    'Yard Coordinator',
    'Logistics Coordinator',
  ],
  HR: [
    'HR Officer',
    'Senior HR Officer',
    'HR Coordinator',
    'HR Reviewer',
    'Recruitment Officer',
  ],
  IT: [
    'IT Officer',
    'IT Support Engineer',
    'Systems Administrator',
    'Software Developer',
  ],
  FIN: [
    'Accountant',
    'Senior Accountant',
    'Finance Officer',
    'Finance Coordinator',
    'Chief Accountant',
  ],
};

// Full position list across all departments — used as fallback when
// the chosen department isn't in the catalogue (e.g. a department
// added to the org chart but not yet listed above).
const ALL_POSITIONS = Array.from(
  new Set(Object.values(POSITIONS_BY_DEPARTMENT).flat())
).sort();

const TODAY = new Date().toISOString().slice(0, 10);
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
  const [positionCustom, setPositionCustom] = useState(''); // free-text fallback
  const [department, setDepartment] = useState('');
  const [location, setLocation] = useState('DMM'); // default to Dammam HQ
  const [proposedJoinDate, setProposedJoinDate] = useState(defaultJoinDate());
  const [salaryBasic, setSalaryBasic] = useState('');
  const [salaryHousing, setSalaryHousing] = useState('');
  const [salaryTransport, setSalaryTransport] = useState('');
  const [salaryOther, setSalaryOther] = useState('');
  const [managerId, setManagerId] = useState('');
  const [signatoryId, setSignatoryId] = useState('');

  const [signatories, setSignatories] = useState([]);
  const [signatoriesLoading, setSignatoriesLoading] = useState(false);

  // Inline signatory add (so user doesn't have to leave the form)
  const [signatoryAdding, setSignatoryAdding] = useState(false);
  const [newSigName, setNewSigName] = useState('');
  const [newSigTitle, setNewSigTitle] = useState('');
  const [savingNewSig, setSavingNewSig] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // ─── Reset on open ──────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    setCandidateName('');
    setCandidateEmail('');
    setCandidatePhone('');
    setPositionTitle('');
    setPositionCustom('');
    setDepartment('');
    setLocation('DMM');
    setProposedJoinDate(defaultJoinDate());
    setSalaryBasic('');
    setSalaryHousing('');
    setSalaryTransport('');
    setSalaryOther('');
    setManagerId('');
    setSignatoryId('');
    setSignatoryAdding(false);
    setNewSigName('');
    setNewSigTitle('');
    setError('');
    loadSignatories();
  }, [open]);

  async function loadSignatories() {
    setSignatoriesLoading(true);
    try {
      const rows = await directGet(
        'signatories',
        'select=*&active=eq.true&order=display_order.asc'
      );
      setSignatories(rows || []);
    } catch (e) {
      console.warn('signatories load failed:', e);
      setSignatories([]);
    } finally {
      setSignatoriesLoading(false);
    }
  }

  // ─── Derived: departments, managers, locations ──────────────────
  // Departments come from the existing employees table — keeps the
  // values consistent with the rest of the portal.
  const departments = useMemo(() => {
    const set = new Set();
    (employees || []).forEach(e => { if (e.department) set.add(e.department); });
    return [...set].sort();
  }, [employees]);

  // Locations from real employee data, ordered alphabetically by
  // their friendly label. Falls back to the canonical KSA office
  // list if employees haven't been seeded yet.
  const locations = useMemo(() => {
    const set = new Set();
    (employees || []).forEach(e => { if (e.location) set.add(e.location); });
    if (set.size === 0) {
      ['DMM', 'JED', 'RYD'].forEach(c => set.add(c));
    }
    return [...set].sort((a, b) =>
      (LOCATION_LABELS[a] || a).localeCompare(LOCATION_LABELS[b] || b)
    );
  }, [employees]);

  // Managers: anyone with at least one direct report (i.e. someone
  // else has manager_id = their.id) PLUS any admin or HR reviewer.
  // Previously this filtered on a non-existent is_manager column,
  // which gave Bashaier an empty list.
  const managers = useMemo(() => {
    if (!employees) return [];
    const managerIds = new Set();
    employees.forEach(e => {
      if (e.manager_id) managerIds.add(e.manager_id);
    });
    return employees
      .filter(e =>
        managerIds.has(e.id) ||
        e.is_admin ||
        e.is_hr_reviewer
      )
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [employees]);

  // Available positions for the chosen department. Falls back to
  // ALL_POSITIONS when the dept isn't in the catalogue, and stays
  // empty until a department is selected (forces dept-first flow).
  const availablePositions = useMemo(() => {
    if (!department) return [];
    return POSITIONS_BY_DEPARTMENT[department] || ALL_POSITIONS;
  }, [department]);

  // When the department changes, clear the position so the user
  // re-picks from the now-relevant list.
  useEffect(() => {
    setPositionTitle('');
    setPositionCustom('');
  }, [department]);

  // ─── Validation ─────────────────────────────────────────────────
  const finalPositionTitle = positionTitle === '__CUSTOM__'
    ? positionCustom.trim()
    : positionTitle.trim();

  // Salary breakdown — five separate fields per the standard
  // Evergreen joining report format (Basic + Housing + Transportation
  // + Other = Total). Total is auto-computed from the four
  // components. Bashaier enters each value individually so the
  // offer letter displays the same breakdown the candidate will
  // see on their formal joining report later.
  const salaryTotal = useMemo(() => {
    const b = Number(salaryBasic) || 0;
    const h = Number(salaryHousing) || 0;
    const t = Number(salaryTransport) || 0;
    const o = Number(salaryOther) || 0;
    return b + h + t + o;
  }, [salaryBasic, salaryHousing, salaryTransport, salaryOther]);

  const errors = useMemo(() => {
    const list = [];
    if (!candidateName.trim()) list.push('Candidate name is required');
    if (!candidateEmail.trim()) list.push('Personal email is required');
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidateEmail.trim())) list.push('Personal email format looks invalid');
    if (!department) list.push('Department is required');
    if (!finalPositionTitle) list.push('Position title is required');
    if (!location) list.push('Location is required');
    if (!proposedJoinDate) list.push('Joining date is required');
    else if (proposedJoinDate < TODAY) list.push('Joining date must be today or in the future');
    if (!salaryBasic || Number(salaryBasic) <= 0) list.push('Basic salary must be greater than zero');
    if (salaryTotal <= 0) list.push('Total salary must be greater than zero');
    if (!signatoryId) list.push('Signatory is required (add one below if the list is empty)');
    return list;
  }, [candidateName, candidateEmail, finalPositionTitle, department, location, proposedJoinDate, salaryBasic, salaryTotal, signatoryId]);

  const canSubmit = !submitting && errors.length === 0;

  // ─── Inline signatory creation ─────────────────────────────────
  async function saveNewSignatory() {
    if (!newSigName.trim() || !newSigTitle.trim()) return;
    setSavingNewSig(true);
    try {
      const inserted = await directPost(
        'signatories',
        {
          name: newSigName.trim(),
          title: newSigTitle.trim(),
          active: true,
          display_order: 100,
        },
        { returning: 'representation' }
      );
      const created = Array.isArray(inserted) ? inserted[0] : inserted;
      if (created?.id) {
        setSignatories(prev => [...prev, created]);
        setSignatoryId(created.id);
        setSignatoryAdding(false);
        setNewSigName('');
        setNewSigTitle('');
      }
    } catch (e) {
      alert(e?.message || 'Could not save signatory.');
    } finally {
      setSavingNewSig(false);
    }
  }

  // ─── Submit ─────────────────────────────────────────────────────
  async function handleGenerate() {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');

    try {
      const offerToken = generateOfferToken();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 14);

      const row = {
        candidate_name:        candidateName.trim(),
        candidate_email:       candidateEmail.trim().toLowerCase(),
        candidate_phone:       candidatePhone.trim() || null,
        position_title:        finalPositionTitle,
        department:            department,
        proposed_join_date:    proposedJoinDate,
        salary_amount:         salaryTotal,
        salary_basic:          Number(salaryBasic) || 0,
        salary_housing:        Number(salaryHousing) || 0,
        salary_transportation: Number(salaryTransport) || 0,
        salary_other:          Number(salaryOther) || 0,
        salary_currency:       'SAR',
        manager_id:            managerId || null,
        signatory_id:          signatoryId,
        offer_token:           offerToken,
        expires_at:            expiresAt.toISOString(),
        status:                'offer_sent',
        created_by_id:         me?.id || null,
      };

      const inserted = await directPost('offer_letters', row, { returning: 'representation' });
      const created = Array.isArray(inserted) ? inserted[0] : inserted;
      if (!created?.id) {
        throw new Error('Insert returned no row');
      }

      const signatory = signatories.find(s => s.id === signatoryId);
      const manager = managers.find(m => m.id === managerId);
      const pdfBlob = await generateOfferLetterPDF(
        {
          candidateName:    candidateName.trim(),
          positionTitle:    finalPositionTitle,
          department:       department,
          location:         LOCATION_LABELS[location] || location,
          proposedJoinDate: proposedJoinDate,
          salaryBasic:      Number(salaryBasic) || 0,
          salaryHousing:    Number(salaryHousing) || 0,
          salaryTransport:  Number(salaryTransport) || 0,
          salaryOther:      Number(salaryOther) || 0,
          salaryTotal:      salaryTotal,
          managerName:      manager?.name || null,
        },
        signatory
      );

      const acceptanceUrl = `${window.location.origin}/accept-offer?token=${offerToken}`;
      const subject = `Offer of employment — ${finalPositionTitle} — Evergreen Shipping`;
      const body = buildOfferEmailBody(
        { candidateName: candidateName.trim(), positionTitle: finalPositionTitle },
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

      downloadBlob(eml, `Offer_${safeNameForFile}.eml`);
      setTimeout(() => downloadBlob(pdfBlob, pdfFilename), 600);

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
          {/* Department FIRST so position dropdown is meaningful. Two-
              column grid pairs Department with Location since both are
              location-y org placement decisions. */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Department *" required>
              <Select value={department} onChange={setDepartment}>
                <option value="">— select —</option>
                {departments.map(d => <option key={d} value={d}>{d}</option>)}
              </Select>
            </Field>
            <Field label="Location *" required>
              <Select value={location} onChange={setLocation}>
                {locations.map(l => (
                  <option key={l} value={l}>
                    {LOCATION_LABELS[l] || l} ({l})
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* Position dropdown — hydrated from the per-department
              catalogue. "Custom…" reveals a free-text input for roles
              not in the list (e.g. a brand-new title nobody has
              before). */}
          <Field label="Position title *" required>
            <Select value={positionTitle} onChange={setPositionTitle} disabled={!department}>
              <option value="">{department ? '— select position —' : 'Pick department first'}</option>
              {availablePositions.map(p => <option key={p} value={p}>{p}</option>)}
              <option value="__CUSTOM__">Custom… (type your own)</option>
            </Select>
            {positionTitle === '__CUSTOM__' && (
              <div className="mt-2">
                <Input
                  value={positionCustom}
                  onChange={setPositionCustom}
                  placeholder="Type the exact position title for the offer letter"
                />
              </div>
            )}
          </Field>

          <Field label="Reporting to (manager) *" required>
            <Select value={managerId} onChange={setManagerId}>
              <option value="">— select manager —</option>
              {managers.map(m => (
                <option key={m.id} value={m.id}>
                  {m.name} — {m.id} · {m.department || '—'}
                </option>
              ))}
            </Select>
            {managers.length === 0 && (
              <div className="text-[11px] mt-1 opacity-70" style={{ color: '#854F0B' }}>
                No managers found. The list pulls from anyone who has direct reports, plus admin/HR reviewer roles.
              </div>
            )}
          </Field>

          <Field label="Joining date *" required>
            <Input type="date" value={proposedJoinDate} onChange={setProposedJoinDate} />
          </Field>

          {/* Salary breakdown — matches the formal joining report
              format. Bashaier enters each component, total is
              auto-computed and shown on a green tile. The four
              components and the total all appear separately on
              the offer letter PDF. */}
          <Field label="Salary breakdown (SAR per month) *">
            <div
              className="rounded-lg border p-3"
              style={{ borderColor: 'var(--border)', background: 'var(--paper)' }}
            >
              <div className="grid grid-cols-2 gap-2">
                <SalaryInput label="Basic Salary *" value={salaryBasic}    onChange={setSalaryBasic}    placeholder="e.g. 3900" />
                <SalaryInput label="Housing Allowance" value={salaryHousing}  onChange={setSalaryHousing}  placeholder="e.g. 1500" />
                <SalaryInput label="Transportation"    value={salaryTransport} onChange={setSalaryTransport} placeholder="e.g. 600" />
                <SalaryInput label="Other Allowance"   value={salaryOther}    onChange={setSalaryOther}    placeholder="0" />
              </div>
              <div
                className="rounded-md mt-2 px-3 py-2 flex items-center justify-between"
                style={{ background: '#ECFDF3', border: '1px solid #A7D8B7' }}
              >
                <div className="text-[10px] tracking-widest" style={{ color: '#0F4C2A', fontWeight: 700 }}>
                  TOTAL SALARY
                </div>
                <div className="text-base" style={{ color: '#0F4C2A', fontWeight: 700 }}>
                  SAR {salaryTotal.toLocaleString('en-GB')}
                </div>
              </div>
            </div>
          </Field>
        </FormSection>

        {/* Signatory — with inline add */}
        <FormSection title="Letter signatory">
          {signatoriesLoading ? (
            <div className="flex items-center gap-2 text-xs" style={{ color: '#0A0A0A', opacity: 0.6 }}>
              <Loader2 className="w-3 h-3 animate-spin" /> Loading signatories…
            </div>
          ) : signatoryAdding ? (
            <div
              className="rounded-lg p-3 space-y-2"
              style={{ background: '#FEF6E2', border: '1px solid #E8C896' }}
            >
              <div className="text-[11px] mb-1" style={{ color: '#854F0B', fontWeight: 700 }}>
                ADD NEW SIGNATORY
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input value={newSigName} onChange={setNewSigName} placeholder="Name (e.g. John Ho)" />
                <Input value={newSigTitle} onChange={setNewSigTitle} placeholder="Title (e.g. Country Head)" />
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  type="button"
                  onClick={() => { setSignatoryAdding(false); setNewSigName(''); setNewSigTitle(''); }}
                  className="text-[11px] px-3 py-1.5 rounded-full"
                  style={{ background: 'transparent', color: '#0A0A0A', border: '1px solid var(--border)', cursor: 'pointer' }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveNewSignatory}
                  disabled={!newSigName.trim() || !newSigTitle.trim() || savingNewSig}
                  className="text-[11px] px-3 py-1.5 rounded-full inline-flex items-center gap-1.5 disabled:opacity-50"
                  style={{ background: 'var(--evergreen-600)', color: '#FFFFFF', fontWeight: 600, cursor: 'pointer' }}
                >
                  {savingNewSig ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Save signatory
                </button>
              </div>
            </div>
          ) : (
            <>
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
              <button
                type="button"
                onClick={() => setSignatoryAdding(true)}
                className="text-[11px] mt-1 inline-flex items-center gap-1"
                style={{ color: 'var(--evergreen-700, #0F4C2A)', fontWeight: 600, cursor: 'pointer' }}
              >
                <Plus className="w-3 h-3" /> Add a new signatory
              </button>
              {signatories.length === 0 && (
                <div className="text-[11px] mt-1 opacity-70" style={{ color: '#854F0B' }}>
                  No signatories yet. Click "Add a new signatory" above to create the first one.
                </div>
              )}
            </>
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

        <div className="text-[11px] mt-3 leading-relaxed" style={{ color: '#0A0A0A', opacity: 0.6 }}>
          On generate: offer is recorded with a 14-day acceptance window. PDF and Outlook draft (.eml) download — open the .eml to review and send.
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

function Select({ value, onChange, children, disabled }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className="w-full text-sm rounded-lg px-3 py-2"
      style={{
        background: disabled ? 'var(--paper-2)' : '#FFFFFF',
        border: '1px solid var(--border)',
        color: '#0A0A0A',
        outline: 'none',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </select>
  );
}

// Compact salary breakdown input — small label above a number
// input, styled to fit four-across in the breakdown card.
function SalaryInput({ label, value, onChange, placeholder }) {
  return (
    <label className="block">
      <div className="text-[10px] mb-1 opacity-65" style={{ color: '#0A0A0A', fontWeight: 600 }}>
        {label}
      </div>
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        min="0"
        step="100"
        className="w-full text-sm rounded-md px-2 py-1.5"
        style={{
          background: '#FFFFFF',
          border: '1px solid var(--border)',
          color: '#0A0A0A',
          outline: 'none',
        }}
      />
    </label>
  );
}
