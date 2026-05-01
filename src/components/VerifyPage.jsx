import React, { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient.js';
import EvergreenLogo from './EvergreenLogo.jsx';

// Public verify page. Anyone scanning the QR code on a printed
// permission letter or leave form lands here. Calls the relevant
// public RPC (security definer, returns only approved requests
// with sanitized fields) — no auth required.
//
// Two modes — same chrome, different RPC + field set:
//   mode='permission'  →  verify_permission(integer)  →  PermissionRequestCard
//   mode='leave'       →  verify_leave(uuid)          →  LeaveRequestCard

const PERMISSION_TYPE_LABEL = {
  late_arrival: 'Late Arrival',
  early_leave:  'Early Departure',
};

const LEAVE_TYPE_LABEL = {
  annual:      'Annual Leave',
  sick:        'Sick Leave',
  emergency:   'Emergency Leave',
  hajj:        'Hajj Leave',
  maternity:   'Maternity Leave',
  paternity:   'Paternity Leave',
  marriage:    'Marriage Leave',
  bereavement: 'Bereavement Leave',
  iddah:       'Iddah Leave',
  unpaid:      'Unpaid Leave',
  other:       'Other Leave',
};

// Same shortRef pattern the printed letter uses, so the verifier can
// eyeball-match the ref on screen against the ref on paper.
function shortRef(mode, id) {
  const s = String(id ?? '');
  if (mode === 'leave') {
    const hex = s.replace(/-/g, '');
    if (hex.length > 8 && /^[0-9a-f]+$/i.test(hex)) {
      return `LV-${hex.slice(0, 8).toUpperCase()}`;
    }
    return `LV-${s.padStart(5, '0')}`;
  }
  return `PR-${s.padStart(5, '0')}`;
}

export default function VerifyPage({ requestId, mode = 'permission' }) {
  const [state, setState] = useState({ loading: true, request: null, error: null });

  const rpcName = mode === 'leave' ? 'verify_leave' : 'verify_permission';
  const titleLabel = mode === 'leave'
    ? 'LEAVE APPLICATION VERIFICATION'
    : 'PERMISSION LETTER VERIFICATION';
  const refLabel = shortRef(mode, requestId);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc(rpcName, { p_id: requestId });
        if (cancelled) return;
        if (error) {
          setState({ loading: false, request: null, error: error.message || 'Lookup failed.' });
          return;
        }
        const row = Array.isArray(data) ? data[0] : data;
        if (!row) {
          setState({ loading: false, request: null, error: 'No approved request found with this reference.' });
          return;
        }
        setState({ loading: false, request: row, error: null });
      } catch (err) {
        if (!cancelled) setState({ loading: false, request: null, error: err?.message || 'Lookup failed.' });
      }
    })();
    return () => { cancelled = true; };
  }, [requestId, rpcName]);

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12"
         style={{ background: 'var(--paper, #FFFDF7)', color: 'var(--ink, #1F1B16)' }}>
      <div className="w-full max-w-md">

        <div className="mb-6 text-center">
          <div className="flex justify-center mb-3 opacity-90">
            <EvergreenLogo variant="stack" size="md" />
          </div>
          <div className="text-[10px] tracking-[0.25em] opacity-60">{titleLabel}</div>
          <div className="text-xs opacity-50 mt-1">Reference: {refLabel}</div>
        </div>

        {state.loading && (
          <div className="esau-card p-6 text-center text-sm opacity-70">Looking up request…</div>
        )}

        {state.error && !state.request && (
          <div className="esau-card p-6 text-center"
               style={{ borderLeft: '4px solid #B83A2E' }}>
            <div className="text-xs tracking-[0.2em] font-semibold mb-2" style={{ color: '#B83A2E' }}>NOT FOUND</div>
            <div className="text-sm opacity-80">{state.error}</div>
            <div className="text-xs opacity-60 mt-3">
              This QR points to a request that does not exist, has not been approved,
              or has been removed. Contact HR if you believe this is an error.
            </div>
          </div>
        )}

        {state.request && (mode === 'leave'
          ? <LeaveRequestCard request={state.request} />
          : <PermissionRequestCard request={state.request} />
        )}

        <div className="mt-6 text-center text-[10px] opacity-50">
          Evergreen Shipping Agency Saudi Co. (L.L.C) · ESAU SADMN SUP / HR Dept
        </div>
      </div>
    </div>
  );
}

function PermissionRequestCard({ request }) {
  const stage = request.stage || 'unknown';
  const palette = stagePalette(stage);
  const typeLabel = PERMISSION_TYPE_LABEL[request.type] || request.type;

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
      <Row label="Employee">{request.employee_name || request.employee_id}</Row>
      {request.employee_department && (
        <Row label="Department">
          {request.employee_department}{request.employee_location ? ` · ${request.employee_location}` : ''}
        </Row>
      )}
      <Row label="Submitted">{fmtDateTime(request.requested_at)}</Row>
      {request.manager_decided_at && <Row label="Manager decided">{fmtDateTime(request.manager_decided_at)}</Row>}
      {request.hr_decided_at && <Row label="HR decided">{fmtDateTime(request.hr_decided_at)}</Row>}

      <div className="mt-5 pt-4 text-xs opacity-70" style={{ borderTop: '1px dashed var(--border-soft, #E5E0D5)' }}>
        ✓ This request was formally approved and recorded.
        The printed letter is authentic.
      </div>
    </div>
  );
}

function LeaveRequestCard({ request }) {
  const stage = request.stage || 'unknown';
  const palette = stagePalette(stage);
  const typeLabel = LEAVE_TYPE_LABEL[request.leave_type_id] || request.leave_type_id || '—';
  const dayCount = Number(request.days || 0);
  const daysLabel = `${dayCount} day${dayCount === 1 ? '' : 's'}${request.is_half_day ? ' (half day)' : ''}`;
  const periodLabel = request.start_date === request.end_date
    ? fmtDate(request.start_date)
    : `${fmtDate(request.start_date)} → ${fmtDate(request.end_date)}`;

  return (
    <div className="esau-card p-6"
         style={{ borderLeft: `4px solid ${palette.accent}` }}>
      <div className="flex items-baseline gap-2 mb-4">
        <span className="text-[10px] tracking-[0.25em] font-semibold" style={{ color: palette.accent }}>
          {palette.label}
        </span>
      </div>

      <Row label="Leave type">{typeLabel}</Row>
      <Row label="Period">{periodLabel}</Row>
      <Row label="Duration">{daysLabel}</Row>
      <Row label="Employee">{request.employee_name || request.employee_id}</Row>
      {request.employee_department && (
        <Row label="Department">
          {request.employee_department}{request.employee_location ? ` · ${request.employee_location}` : ''}
        </Row>
      )}
      <Row label="Submitted">{fmtDateTime(request.requested_at)}</Row>
      {request.manager_decided_at && <Row label="Manager decided">{fmtDateTime(request.manager_decided_at)}</Row>}
      {request.hr_decided_at && <Row label="HR decided">{fmtDateTime(request.hr_decided_at)}</Row>}

      <div className="mt-5 pt-4 text-xs opacity-70" style={{ borderTop: '1px dashed var(--border-soft, #E5E0D5)' }}>
        ✓ This leave was formally approved and recorded.
        The printed form is authentic.
      </div>
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
    case 'pending_substitutes': return { label: 'PENDING SUBSTITUTES', accent: '#9D6B53' };
    case 'pending_manager':     return { label: 'PENDING MANAGER',  accent: '#9D6B53' };
    case 'pending_hr':          return { label: 'PENDING HR',       accent: '#9D6B53' };
    case 'rejected_by_manager': return { label: 'REJECTED',         accent: '#B83A2E' };
    case 'rejected_by_hr':      return { label: 'REJECTED',         accent: '#B83A2E' };
    case 'expired':             return { label: 'EXPIRED',          accent: '#737373' };
    default:                    return { label: (stage || 'unknown').toUpperCase(), accent: '#737373' };
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
