import React, { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient.js';
import EvergreenLogo from './EvergreenLogo.jsx';

// Public verify page. Anyone scanning the QR code on a printed
// permission letter, leave form, or rejoining report lands here. Calls
// the relevant public RPC (security definer, returns only approved
// requests with sanitized fields) — no auth required.
//
// Three modes — same chrome, different RPC + field set:
//   mode='permission' →  verify_permission(integer) →  PermissionRequestCard
//   mode='leave'      →  verify_leave(uuid)         →  LeaveRequestCard
//   mode='rejoin'     →  verify_leave(uuid)         →  RejoiningRecordCard

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
  if (mode === 'leave' || mode === 'rejoin') {
    const hex = s.replace(/-/g, '');
    if (hex.length > 8 && /^[0-9a-f]+$/i.test(hex)) {
      return (mode === 'rejoin' ? 'RJ-' : 'LV-') + hex.slice(0, 8).toUpperCase();
    }
    return (mode === 'rejoin' ? 'RJ-' : 'LV-') + s.padStart(5, '0');
  }
  return `PR-${s.padStart(5, '0')}`;
}

export default function VerifyPage({ requestId, mode = 'permission' }) {
  const [state, setState] = useState({ loading: true, request: null, error: null });

  // Both 'leave' and 'rejoin' modes hit verify_leave (the rejoining is a
  // sub-state of the same row, not a separate record). The mode just
  // changes which fields we surface in the rendered card.
  const rpcName = (mode === 'leave' || mode === 'rejoin') ? 'verify_leave' : 'verify_permission';
  const titleLabel = mode === 'rejoin'    ? 'REJOINING REPORT VERIFICATION'
                  : mode === 'leave'      ? 'LEAVE APPLICATION VERIFICATION'
                  :                          'PERMISSION LETTER VERIFICATION';
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
        // For 'rejoin' mode the row must also have a finalized rejoining
        // workflow (return_stage='approved'). The QR is only embedded in
        // the report after Bashaier's final approval, so a row that comes
        // back without an approved return_stage means someone scanned a
        // mid-flight or fabricated form.
        if (mode === 'rejoin' && row.return_stage !== 'approved') {
          setState({
            loading: false, request: null,
            error: 'This rejoining record is not finalised. Final HR approval is still pending.',
          });
          return;
        }
        setState({ loading: false, request: row, error: null });
      } catch (err) {
        if (!cancelled) setState({ loading: false, request: null, error: err?.message || 'Lookup failed.' });
      }
    })();
    return () => { cancelled = true; };
  }, [requestId, rpcName, mode]);

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

        {state.request && (
            mode === 'rejoin'     ? <RejoiningRecordCard request={state.request} />
          : mode === 'leave'      ? <LeaveRequestCard    request={state.request} />
          :                          <PermissionRequestCard request={state.request} />
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
      {request.return_stage === 'approved' && request.actual_return_date && (
        <Row label="Returned">
          <span style={{ color: '#0F4C2A', fontWeight: 600 }}>
            ✓ {fmtDate(request.actual_return_date)}
          </span>
        </Row>
      )}
      {request.return_stage && request.return_stage !== 'approved' && (
        <Row label="Rejoining">
          <span style={{
            color: request.return_stage.startsWith('rejected') ? '#B91C1C'
                 : request.return_stage === 'pending_hr'        ? '#0F4C2A'
                 : '#8B6914',
            fontWeight: 600,
          }}>
            {request.return_stage.replace(/_/g, ' ').toUpperCase()}
          </span>
        </Row>
      )}
      {request.return_status && request.return_status === 'no_show' && (
        <Row label="Return status">
          <span style={{ color: '#B83A2E', fontWeight: 600 }}>NO SHOW</span>
        </Row>
      )}

      <div className="mt-5 pt-4 text-xs opacity-70" style={{ borderTop: '1px dashed var(--border-soft, #E5E0D5)' }}>
        ✓ This leave was formally approved and recorded.
        The printed form is authentic.
      </div>
    </div>
  );
}

// Rejoining-specific card. Same chrome as LeaveRequestCard but the
// emphasis is reversed: actual return + payroll resumption is what
// the verifier cares about, not the original absence dates. Reaches
// here only after the rejoining workflow has been finalised by HR
// (the loader rejects rows with return_stage != 'approved'), so we
// can confidently render the ✓ REJOINED status.
function RejoiningRecordCard({ request }) {
  const typeLabel = LEAVE_TYPE_LABEL[request.leave_type_id] || request.leave_type_id || '—';
  const periodLabel = request.start_date === request.end_date
    ? fmtDate(request.start_date)
    : `${fmtDate(request.start_date)} → ${fmtDate(request.end_date)}`;
  const dayCount = Number(request.days || 0);
  const daysLabel = `${dayCount} day${dayCount === 1 ? '' : 's'}`;

  // Punctuality string — early / on schedule / late vs original end_date+1
  const punctuality = (() => {
    if (!request.actual_return_date || !request.end_date) return null;
    const a = new Date(request.actual_return_date);
    const e = new Date(request.end_date);
    e.setDate(e.getDate() + 1);
    const diff = Math.round((a - e) / 86_400_000);
    if (diff === 0) return { label: 'Returned on schedule', color: '#0F4C2A' };
    if (diff < 0)   return { label: `Returned ${Math.abs(diff)} day${Math.abs(diff) === 1 ? '' : 's'} early`, color: '#0F4C2A' };
    return { label: `Returned ${diff} day${diff === 1 ? '' : 's'} late`, color: '#B91C1C' };
  })();

  return (
    <div className="esau-card p-6"
         style={{ borderLeft: '4px solid #0F4C2A' }}>
      <div className="flex items-baseline gap-2 mb-4">
        <span className="text-[10px] tracking-[0.25em] font-semibold" style={{ color: '#0F4C2A' }}>
          ✓ REJOINED · APPROVED BY HR
        </span>
      </div>

      {/* Return-focused fields first — the headline information for a
          rejoining verification. */}
      <Row label="Reported back on">
        <span style={{ color: '#0F4C2A', fontWeight: 700 }}>
          {fmtDate(request.actual_return_date)}
        </span>
      </Row>
      {punctuality && (
        <Row label="Punctuality">
          <span style={{ color: punctuality.color, fontWeight: 600 }}>
            {punctuality.label}
          </span>
        </Row>
      )}
      <Row label="Employee">{request.employee_name || request.employee_id}</Row>
      {request.employee_department && (
        <Row label="Department">
          {request.employee_department}{request.employee_location ? ` · ${request.employee_location}` : ''}
        </Row>
      )}

      {/* Original-leave context — kept as supporting info. */}
      <div className="mt-3 pt-3 text-xs uppercase tracking-wider opacity-50"
           style={{ borderTop: '1px dashed var(--border-soft, #E5E0D5)' }}>
        Original leave
      </div>
      <Row label="Leave type">{typeLabel}</Row>
      <Row label="Period">{periodLabel}</Row>
      <Row label="Duration">{daysLabel}</Row>

      {/* Workflow audit trail */}
      <div className="mt-3 pt-3 text-xs uppercase tracking-wider opacity-50"
           style={{ borderTop: '1px dashed var(--border-soft, #E5E0D5)' }}>
        Approval chain
      </div>
      {request.return_submitted_at && (
        <Row label="Submitted by staff">{fmtDateTime(request.return_submitted_at)}</Row>
      )}
      {request.return_manager_decided_at && (
        <Row label="Manager approved">{fmtDateTime(request.return_manager_decided_at)}</Row>
      )}
      {request.return_hr_decided_at && (
        <Row label="HR approved">{fmtDateTime(request.return_hr_decided_at)}</Row>
      )}

      {Number(request.balance_after) > 0 && (
        <Row label="Balance credited">
          <span style={{ color: '#0F4C2A', fontWeight: 600 }}>
            +{request.balance_after} day{request.balance_after === 1 ? '' : 's'} (early return)
          </span>
        </Row>
      )}

      <div className="mt-5 pt-4 text-xs opacity-70" style={{ borderTop: '1px dashed var(--border-soft, #E5E0D5)' }}>
        ✓ This rejoining was formally approved and recorded.
        The printed report is authentic. Payroll has been activated effective the reported-back date.
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
