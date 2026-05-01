import React from 'react';
import { Clock3, Check, X, HelpCircle, Users2 } from 'lucide-react';
import { fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';

// =============================================================================
// LeaveSubstituteWaitCard
//
// Shown to the requesting staff member (e.g. Shahad) on her PersonalDashboard
// while her leave request is at stage='pending_substitutes'. Lists each
// substitute alongside their current decision so she can see who hasn't
// responded yet, who accepted, and who declined.
//
// Read-only — there's no action she can take from here. The card disappears
// automatically once the trigger advances the stage (all accepted →
// pending_manager) or the request is rejected.
//
// Receives `requests` (the user's own leave_requests rows, already loaded
// by PersonalDashboard) and `empMap` (id → employee). Renders nothing
// when there are no rows in the substitutes stage.
// =============================================================================

export default function LeaveSubstituteWaitCard({ requests = [], empMap = {} }) {
  const waiting = (requests || []).filter(r => r.stage === 'pending_substitutes');
  if (waiting.length === 0) return null;

  return (
    <section className="rounded-2xl overflow-hidden mb-4"
             style={{ background: '#FFFDF7', border: '1px solid var(--border-soft, #E8E5D8)' }}>
      <div className="px-5 py-4 flex items-center gap-2"
           style={{ borderBottom: '1px solid var(--border-soft, #E8E5D8)' }}>
        <Users2 className="w-4 h-4" style={{ color: '#9D6B53' }} />
        <div className="font-semibold text-sm" style={{ color: '#1F1B16' }}>
          {waiting.length === 1
            ? 'Waiting for substitute approval'
            : `${waiting.length} requests waiting for substitute approval`}
        </div>
      </div>
      <ul className="divide-y" style={{ borderColor: 'var(--border-soft, #E8E5D8)' }}>
        {waiting.map(req => {
          const ids = req.substitute_ids || [];
          const acceptedCount = ids.filter(sid => {
            const raw = req.substitute_decisions?.[sid];
            const dec = !raw ? 'pending' : typeof raw === 'string' ? raw : (raw.decision || 'pending');
            return dec === 'accepted';
          }).length;
          return (
            <li key={req.id} className="px-5 py-4">
              <div className="flex items-center gap-2 flex-wrap mb-2">
                <Clock3 className="w-3.5 h-3.5" style={{ color: '#1F1B16', opacity: 0.6 }} />
                <span className="text-sm" style={{ color: '#1F1B16', fontWeight: 500 }}>
                  {fmtDateShort(req.start_date)} → {fmtDateShort(req.end_date)}
                </span>
                <span className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
                  · {req.days} day{req.days !== 1 ? 's' : ''}
                </span>
                <span className="text-[10px] px-2 py-0.5 rounded-full ml-auto"
                      style={{ background: '#FEF3C7', color: '#92400E', fontWeight: 700, letterSpacing: '0.1em' }}>
                  {acceptedCount}/{ids.length} CONFIRMED
                </span>
              </div>
              {/* Per-substitute pill grid — each substitute with their
                  current decision. Three states:
                    • accepted  → green tick + name
                    • declined  → red cross + name
                    • pending   → amber clock + name
                  Reads substitute_decisions[psn] handling both the legacy
                  string shape and the {decision, at} object shape. */}
              <div className="flex flex-wrap gap-1.5">
                {ids.map(sid => {
                  const raw = req.substitute_decisions?.[sid];
                  const dec = !raw ? 'pending' : typeof raw === 'string' ? raw : (raw.decision || 'pending');
                  const accepted = dec === 'accepted';
                  const declined = dec === 'declined';
                  const bg    = accepted ? '#ECFDF5' : declined ? '#FEE2E2' : '#FEF3C7';
                  const color = accepted ? '#0F4C2A' : declined ? '#B91C1C' : '#92400E';
                  const Icon  = accepted ? Check : declined ? X : HelpCircle;
                  const name  = empMap[sid]?.name || sid;
                  return (
                    <span key={sid}
                      className="inline-flex items-center gap-1.5 pl-1 pr-2.5 py-1 rounded-full"
                      style={{ background: bg, color, fontSize: '11px', fontWeight: 500 }}
                      title={dec.toUpperCase()}>
                      <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-[9px] font-bold"
                            style={{ background: avatarColor(name) }}>
                        {getInitials(name)}
                      </span>
                      <Icon className="w-3 h-3" />
                      {name}
                    </span>
                  );
                })}
              </div>
              <div className="text-[11px] mt-2" style={{ color: '#1F1B16', opacity: 0.6 }}>
                Your manager will see this request once all substitutes confirm coverage. If anyone declines, the request is cancelled and you'll need to resubmit with a different substitute.
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
