import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, Download, Mail, X, Loader2, AlertTriangle } from 'lucide-react';
import {
  downloadPermissionLetter,
  buildPermissionEmailDraft,
  resolveExecCcEmails,
} from '../lib/permissionLetter.js';

// =============================================================================
// PermissionApprovedModal
//
// Triggered automatically after Bashaier issues the FINAL HR approval on a
// permission request (manager already approved → HR approved → done).
// Two actions:
//   1. Download permission letter — single-page A4 .docx with employee
//      details, approval chain, signatures
//   2. Open email — mailto: link prefilled with To = staff,
//      CC = manager + executive list (John, James, Fahad Hussain, Badria,
//      Jaffar, looked up by name from employees.email). User adds the
//      downloaded .docx as an attachment and sends.
//
// Read-only — submission/decision actions happen elsewhere; this is the
// post-decision artifact handoff.
// =============================================================================

export default function PermissionApprovedModal({ request, employee, manager, hrApprover, employees, onClose }) {
  const [downloading, setDownloading] = useState(false);
  const [downloaded, setDownloaded]   = useState(false);
  const [error, setError]             = useState('');

  // Body scroll lock while open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  if (!request) return null;

  const draft = buildPermissionEmailDraft({ employee, manager, hrApprover, request, employees });
  const execCc = resolveExecCcEmails(employees);

  async function handleDownload() {
    setDownloading(true);
    setError('');
    try {
      await downloadPermissionLetter({ employee, manager, hrApprover, request });
      setDownloaded(true);
    } catch (e) {
      setError(e?.message || 'Could not generate the letter. Please try again.');
    } finally {
      setDownloading(false);
    }
  }

  function handleOpenEmail() {
    // mailto: link opens the default email client. The user attaches the
    // downloaded .docx manually before sending — mailto: doesn't carry
    // attachments. We deliberately don't try to use the FileSystem Access
    // API or Web Share for this because Outlook/Gmail desktop clients
    // don't accept those.
    window.location.href = draft.mailto;
  }

  return createPortal(
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 16px', overflowY: 'auto',
      }}
    >
      <div
        className="w-full max-w-lg rounded-2xl border"
        style={{
          borderColor: 'var(--border-soft)',
          background: '#FFFFFF',
          boxShadow: '0 12px 40px rgba(31,27,22,0.18)',
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 py-5 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-start gap-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: '#ECFDF5', border: '1px solid #A7F3D0' }}
            >
              <CheckCircle2 className="w-5 h-5" style={{ color: '#047857' }} />
            </div>
            <div>
              <h2 className="serif text-lg" style={{ fontWeight: 500, color: '#1F1B16' }}>
                Permission approved
              </h2>
              <div className="text-xs mt-1" style={{ color: '#1F1B16' }}>
                Final HR approval issued. Download the letter and send the notification email.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-full hover:bg-black/5 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" style={{ color: '#1F1B16' }} />
          </button>
        </div>

        {/* Email recipients preview */}
        <div className="px-6 py-4 border-b text-xs" style={{ borderColor: 'var(--border-soft)', color: '#1F1B16' }}>
          <div className="grid grid-cols-[60px_1fr] gap-x-3 gap-y-1.5">
            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>TO</span>
            <span>{employee?.name} {employee?.email ? <em style={{ opacity: 0.7 }}>&lt;{employee.email}&gt;</em> : <span style={{ color: '#B91C1C' }}>(no email on file)</span>}</span>

            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>CC</span>
            <span>
              {manager?.name ? <>{manager.name} (manager){manager.email ? '' : <span style={{ color: '#B91C1C' }}> · no email</span>}</> : <span style={{ opacity: 0.6 }}>(no manager linked)</span>}
              {execCc.length > 0 && <>, +{execCc.length} executives</>}
            </span>

            <span style={{ fontWeight: 700, letterSpacing: '0.18em', fontSize: '10px' }}>SUBJECT</span>
            <span>{draft.subject}</span>
          </div>
          {execCc.length === 0 && (
            <div className="mt-3 flex items-start gap-2 text-[11px] px-2.5 py-2 rounded" style={{ background: '#FEF3C7', color: '#92400E' }}>
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
              <span>No executive CCs resolved (John, James, Fahad Hussain, Badria, Jaffar). Check that those names exist in the employees table with email addresses on file.</span>
            </div>
          )}
        </div>

        {/* Action buttons */}
        <div className="p-5 flex flex-col sm:flex-row gap-2.5">
          <button
            type="button"
            onClick={handleDownload}
            disabled={downloading}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border text-sm transition-colors disabled:opacity-50"
            style={{
              background: downloaded ? '#ECFDF5' : '#FFFFFF',
              borderColor: downloaded ? '#A7F3D0' : 'var(--border-soft)',
              color: '#1F1B16',
              fontWeight: 500,
            }}
          >
            {downloading
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
              : downloaded
                ? <><CheckCircle2 className="w-4 h-4" style={{ color: '#047857' }} /> Letter downloaded</>
                : <><Download className="w-4 h-4" /> Download letter (.docx)</>
            }
          </button>
          <button
            type="button"
            onClick={handleOpenEmail}
            disabled={!employee?.email}
            className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm transition-colors disabled:opacity-50"
            style={{
              background: 'var(--ink)', color: 'var(--paper)',
              fontWeight: 500,
            }}
          >
            <Mail className="w-4 h-4" /> Open email draft
          </button>
        </div>

        {error && (
          <div className="px-5 pb-4 text-xs" style={{ color: '#B91C1C' }}>
            {error}
          </div>
        )}

        {/* Tip */}
        <div className="px-5 pb-5 text-[11px]" style={{ color: '#1F1B16', opacity: 0.7 }}>
          Tip: download the letter first, then open the email draft and attach the .docx before sending. Email attachments cannot be pre-filled by the browser.
        </div>
      </div>
    </div>,
    document.body
  );
}
