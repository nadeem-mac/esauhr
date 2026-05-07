// =============================================================================
// IssuePsnModal.jsx — PLACEHOLDER (Phase 5)
//
// Surface for Bashaier to enter the PSN that SOL has issued for an
// accepted candidate, which then creates the actual employees row
// with status='pre_joining'. Full implementation is in Phase 5;
// this stub is here so OffersCard's "Issue PSN" button has
// something to mount.
//
// What Phase 5 will add to this file:
//   • Form: PSN (text input, validates HXXXXX format), Iqama number,
//     optional location override, dependants for GOSI seed
//   • On submit: create employees row with status='pre_joining',
//     update offer_letters row to status='psn_issued' with
//     psn_assigned + psn_assigned_at + psn_assigned_by_id
//   • Generate temporary PIN credential for the new joiner
//   • Email the joiner their PSN + temp PIN with login instructions
// =============================================================================

import React from 'react';
import { X } from 'lucide-react';

export default function IssuePsnModal({ offer, onClose, onIssued, me }) {
  if (!offer) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
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
          width: '100%',
          maxWidth: 460,
          padding: '22px 24px',
        }}
      >
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#0A0A0A', fontWeight: 700 }}>
              ISSUE PSN
            </div>
            <div style={{ fontFamily: 'inherit', fontSize: 20, color: '#0A0A0A' }}>
              {offer.candidate_name}
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

        <div
          className="rounded-lg p-3 text-xs"
          style={{ background: '#FEF6E2', border: '1px solid #E8C896', color: '#854F0B' }}
        >
          PSN issuance flow will be added in Phase 5. For now, please
          continue to issue PSNs through SOL externally and update the
          offer record manually via SQL or the next admin update.
        </div>

        <div className="text-[11px] mt-3" style={{ color: '#0A0A0A', opacity: 0.65 }}>
          Coming next: enter the PSN issued by SOL, optional Iqama details,
          and the system creates the employees row with status='pre_joining'
          so the candidate can log in and complete onboarding.
        </div>

        <div className="flex justify-end mt-4">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm"
            style={{
              background: 'var(--evergreen-600)',
              color: '#FFFFFF',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
