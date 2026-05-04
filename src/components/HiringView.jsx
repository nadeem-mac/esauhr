// =============================================================================
// HiringView.jsx
//
// Top-tab page for the candidate offer pipeline. Mounted at tab='hiring'
// for admins and HR reviewers (Bashaier). Hosts the OffersCard for now;
// future phases add the leaver pipeline (resignations) as a sibling
// section below.
//
// Lifted out of the Dashboard so the hiring workflow has its own
// dedicated space — the Dashboard is the daily-action surface, and
// joiner/leaver flows are a different cadence (weekly/monthly).
// =============================================================================

import React from 'react';
import OffersCard from './OffersCard.jsx';

export default function HiringView({ me, employees }) {
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

      {/* Offer pipeline */}
      <OffersCard me={me} employees={employees} />
    </div>
  );
}
