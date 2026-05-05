// =============================================================================
// HiringView.jsx
//
// Top-tab page for the candidate offer pipeline. Mounted at tab='hiring'
// for admins, HR reviewers (Bashaier), and read-only viewers (Badria,
// Fahad SUP, Jaffar). Hosts the OffersCard for now; future phases add
// the leaver pipeline (resignations) as a sibling section below.
//
// readOnly mode:
//   When the signed-in user is in the hiring-viewer allowlist (i.e.
//   not admin and not HR reviewer), readOnly=true is passed through.
//   This hides creation/withdraw/download controls inside OffersCard
//   while keeping the pipeline view readable. A subtle banner at the
//   top of the page tells the viewer their access level so they don't
//   wonder why action buttons are missing.
// =============================================================================

import React from 'react';
import { Eye } from 'lucide-react';
import OffersCard from './OffersCard.jsx';

export default function HiringView({ me, employees, readOnly = false }) {
  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="text-[10px] tracking-[0.25em] opacity-50 mb-2">JOINER & LEAVER PIPELINE</div>
        <h1 className="serif text-3xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
          Hiring
        </h1>
        <p className="text-sm opacity-70 mt-1.5 max-w-2xl">
          Issue and track candidate offers from initial letter through SOL processing and PSN issuance.
          Future phases will add the leaver pipeline (resignations, notice period, departure handover) here too.
        </p>
      </div>

      {/* Read-only banner — surfaces when SUP team is viewing */}
      {readOnly && (
        <div
          className="rounded-lg p-3 flex items-start gap-2.5"
          style={{
            background: '#EEF0FA',
            border: '1px solid #B8BFD9',
            color: '#3B4279',
          }}
        >
          <Eye className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="text-[12px] leading-relaxed">
            <div style={{ fontWeight: 700, letterSpacing: '0.04em', marginBottom: 2 }}>READ-ONLY VIEW</div>
            You can review the offer pipeline status and history. Creating or amending offers is restricted to HR.
            Contact Bashaier (HR) for any actions you need to take.
          </div>
        </div>
      )}

      {/* Offer pipeline */}
      <OffersCard me={me} employees={employees} readOnly={readOnly} />
    </div>
  );
}
