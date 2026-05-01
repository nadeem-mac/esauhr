import React, { useEffect, useState } from 'react';
import { directGet } from '../supabaseClient.js';
import EvergreenLogo from './EvergreenLogo.jsx';

// Public verify page. Anyone scanning the QR code on a printed
// permission letter lands here. Reads the request from the live
// database and displays its current state — no auth, no editing.
//
// Three possible states displayed:
//   • Approved (green tick) — request is final and stamped
//   • Pending  (yellow)     — still in workflow
//   • Rejected/Expired (red)— terminal but not approved
//
// Designed for quick visual confirmation by a manager spot-checking
// a printout: "Yes, this letter matches a real, approved record."

export default function VerifyPage({ requestId }) {
  const [state, setState] = useState({ loading: true, request: null, employee: null, error: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet(
          'permission_requests',
          `select=*&id=eq.${requestId}&limit=1`,
          { timeoutMs: 8000 },
        );
        if (cancelled) return;
        if (!rows || !rows.length) {
          setState({ loading: false, request: null, employee: null, error: 'Request not found.' });
          return;
        }
        const req = rows[0];
        // Look up the employee for the display
        const emps = await directGet(
          'employees',
          `select=id,name,department,location&id=eq.${encodeURIComponent(req.employee_id)}&limit=1`,
          { timeoutMs: 8000 },
        );
        if (cancelled) return;
        setState({ loading: false, request: req, employee: emps?.[0] || null, error: null });
      } catch (err) {
        if (!cancelled) setState({ loading: false, request: null, employee: null, error: err?.message || 'Lookup failed.' });
      }
    })();
    return () => { cancelled = true; };
  }, [requestId]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12"
         style={{ background: 'var(--paper, #FFFDF7)', color: 'var(--ink, #1F1B16)' }}>
      <div className="w-full max-w-md">

        <div className="mb-6 text-center">
          <div className="flex justify-center mb-3 opacity-90">
            <EvergreenLogo variant="stack" size="md" />
          </div>
          <div className="text-[10px] tracking-[0.25em] opacity-60">PERMISSION LETTER VERIFICATION</div>
          <div className="text-xs opacity-50 mt-1">Reference: PR-{String(requestId).padStart(5, '0')}</div>
        </div>

        {state.loading && (
          <div className="esau-card p-6 text-center text-sm opacity-70">Looking up request…</div>
        )}

        {state.error && (
          <div className="esau-card p-6 text-center"
               style={{ borderLeft: '4px solid #B83A2E' }}>
            <div className="text-xs tracking-[0.2em] font-semibold mb-2" style={{ color: '#B83A2E' }}>NOT FOUND</div>
            <div className="text-sm opacity-80">{state.error}</div>
            <div className="text-xs opacity-60 mt-3">
              This QR code points to a request that does not exist in our records.
              The letter may be invalid, or the QR may be from a different system.
            </div>
          </div>
        )}

        {state.request && <RequestCard request={state.request} employee={state.employee} />}

        <div className="mt-6 text-center text-[10px] opacity-50">
          Evergreen Shipping Agency Saudi Co. (L.L.C) · ESAU SADMN SUP / HR Dept
        </div>
      </div>
    </div>
  );
}

function RequestCard({ request, employee }) {
  const stage = request.stage || request.status || 'unknown';
  const palette = stagePalette(stage);
  const typeLabel = request.type === 'late_arrival' ? 'Late Arrival'
                  : request.type === 'early_leave'  ? 'Early Departure'
                  : request.type;

  return (
    <div className="esau-card p-6"
         style={{ borderLeft: `4px solid ${palette.accent}` }}>
      <div className="flex items-baseline gap-2 mb-4">
        <span className="text-[10px] tracking-[0.25em] font-semibold" style={{ color: palette.accent }}>
          {palette.label}
        </span>
      </div>

      <Row label="Permission type">{typeLabel}</Row>
      <Row label="Permission date">{fmtDate(request.permission_date)}</Row>
      <Row label="Time window">
        {request.time_from && request.time_to
          ? `${request.time_from} → ${request.time_to}`
          : '—'}
      </Row>
      <Row label="Employee">{employee?.name || request.employee_id}</Row>
      {employee?.department && <Row label="Department">{employee.department}{employee.location ? ` · ${employee.location}` : ''}</Row>}
      <Row label="Submitted">{fmtDateTime(request.requested_at)}</Row>
      {request.manager_decided_at && <Row label="Manager decided">{fmtDateTime(request.manager_decided_at)}</Row>}
      {request.hr_decided_at && <Row label="HR decided">{fmtDateTime(request.hr_decided_at)}</Row>}

      {stage === 'approved' && (
        <div className="mt-5 pt-4 text-xs opacity-70" style={{ borderTop: '1px dashed var(--border-soft, #E5E0D5)' }}>
          ✓ This request was formally approved and recorded.
          The printed letter you are holding is authentic.
        </div>
      )}
      {stage !== 'approved' && (
        <div className="mt-5 pt-4 text-xs opacity-70" style={{ borderTop: '1px dashed var(--border-soft, #E5E0D5)' }}>
          The request is currently in <b>{stage}</b> state. If the printed letter
          claims approval but this page does not, please contact HR for clarification.
        </div>
      )}
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div className="flex items-baseline justify-between text-sm py-1.5">
      <span className="text-xs uppercase tracking-wider opacity-60">{label}</span>
      <span className="font-medium ml-3 text-right">{children}</span>
    </div>
  );
}

function stagePalette(stage) {
  switch (stage) {
    case 'approved':            return { label: 'APPROVED',         accent: '#2D5F3F' };
    case 'pending_manager':     return { label: 'PENDING MANAGER',  accent: '#9D6B53' };
    case 'pending_hr':          return { label: 'PENDING HR',       accent: '#9D6B53' };
    case 'rejected_by_manager': return { label: 'REJECTED',         accent: '#B83A2E' };
    case 'rejected_by_hr':      return { label: 'REJECTED',         accent: '#B83A2E' };
    case 'expired':             return { label: 'EXPIRED',          accent: '#737373' };
    default:                    return { label: stage.toUpperCase(),accent: '#737373' };
  }
}

function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })} · ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}
