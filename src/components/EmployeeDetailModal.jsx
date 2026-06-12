import React, { useMemo, useState } from 'react';
import { X, Building2, MapPin, Calendar, Briefcase, KeyRound, Loader2, CheckCircle2, AlertCircle, Pencil, Save, FileText, Download, Mail, Phone, UserCheck, Trash2, AlertTriangle } from 'lucide-react';
import { Avatar, Pill } from './Dashboard.jsx';
import { supabase, directPatch } from '../supabaseClient.js';
import {
  calculateBalance, fmtDate, fmtDateShort, yearsOfService, monthsOfService, LOCATION_LABELS,
} from '../lib/leaveLogic.js';
import { downloadMonthlyAttendanceReport } from '../lib/monthlyAttendanceReport.js';

// Full English display names for ESAU department codes. Used everywhere the
// department is rendered to staff/HR — the codes themselves are kept
// short for filtering, sorting, and DB consistency.
const DEPT_FULL_NAMES = {
  'SUP':       'Human Resources & Supervisory Department',
  'HR':        'Human Resources & Supervisory Department', // legacy fallback
  'BIZ':       'Business',
  'LOG':       'Logistics',
  'OPS':       'Operations Department',
  'FIN':       'Finance',
  'CSD':       'Customer Service Department',
  'MGT':       'Management',
  'SUP / CSD': 'Human Resources & Supervisory / Customer Service Department',
};

export default function EmployeeDetailModal({ employee, leaveTypes, requests, balances, permissions = [], typeMap, me, employees = [], empMap = {}, onSaved, onDeleted, onClose }) {
  const year = new Date().getFullYear();

  // ─── Header PIN-reset state ──────────────────────────────────────
  // Per Nadeem: PIN reset moves from the bottom of the modal to a
  // small 🔑 button in the header corner, opens an inline panel
  // when clicked. Once a PIN is set successfully, the panel shows
  // a success message + "Edit again" affordance so admin can issue
  // another PIN without closing the dialog.
  const canResetPin = (me?.is_admin || me?.can_reset_pins);
  const [pinOpen, setPinOpen] = useState(false);
  const [pinValue, setPinValue] = useState('');
  const [pinBusy, setPinBusy] = useState(false);
  const [pinDone, setPinDone] = useState('');   // success message
  const [pinErr, setPinErr] = useState('');
  // Reset PIN state when the modal swaps to a different employee
  React.useEffect(() => {
    setPinOpen(false);
    setPinValue('');
    setPinDone('');
    setPinErr('');
  }, [employee.id]);

  const submitPin = async (e) => {
    if (e) e.preventDefault();
    setPinBusy(true);
    setPinErr('');
    setPinDone('');
    try {
      if (!pinValue || pinValue.length < 6) {
        throw new Error('PIN must be at least 6 characters.');
      }
      const { data, error } = await supabase.rpc('admin_reset_pin', {
        target_psn: employee.id,
        new_pin: pinValue,
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Unknown error');
      setPinDone(`PIN ${data.action === 'created' ? 'issued' : 'changed'} to ${pinValue}`);
    } catch (ex) {
      setPinErr(ex?.message || String(ex));
    } finally {
      setPinBusy(false);
    }
  };

  // ─── Header deactivate-employee state ────────────────────────────────
  // Soft-delete pattern (Nadeem 2026-05-17). Previously this button
  // called admin_delete_employee RPC which destructively wiped the
  // employee row + all related history (requests, balances,
  // attendance, etc.). Bashaier asked for a reversible inactive flow
  // instead: keep the data, just mark the row as 'inactive' so it
  // drops out of active counts but stays viewable via the Employees
  // tab's "Show inactive" toggle. The destructive RPC stays in the
  // database for admin edge-cases but is no longer wired to the UI.
  const isAlreadyInactive = ['inactive', 'departed', 'terminated'].includes(employee?.employment_status);
  const canDeactivate = (me?.is_admin || me?.is_hr_reviewer) && me?.id !== employee.id;
  const [delStage, setDelStage] = useState('idle');
  // 'idle' | 'confirm' | 'submitting' | 'done' | 'error'
  const [delError, setDelError] = useState('');
  const [delResult, setDelResult] = useState(null);
  React.useEffect(() => {
    setDelStage('idle');
    setDelError('');
    setDelResult(null);
  }, [employee.id]);

  // Submit handler — toggles the employment_status:
  //   active → 'inactive'   (deactivate)
  //   inactive/departed/terminated → 'active' (reactivate)
  // Both directions use a single UPDATE via directPatch. No typed
  // confirmation needed since the action is reversible.
  const submitDeactivate = async () => {
    setDelStage('submitting');
    setDelError('');
    try {
      const targetStatus = isAlreadyInactive ? 'active' : 'inactive';
      // Primary change — must succeed. Keep the payload to the column we
      // know exists so a missing audit column can't 400 the whole PATCH.
      const result = await directPatch('employees', 'id', employee.id, {
        employment_status: targetStatus,
      });
      // Audit fields — who toggled the status and when. Best-effort: these
      // columns may not exist in every environment, and PostgREST returns
      // PGRST204 (not a silent drop) for unknown columns, so we send them
      // separately and ignore failures rather than block the deactivation.
      try {
        await directPatch('employees', 'id', employee.id, {
          status_changed_by: me?.id || null,
          status_changed_at: new Date().toISOString(),
        });
      } catch { /* audit columns absent — non-fatal */ }
      setDelResult({ ok: true, status: targetStatus, name: employee.name });
      setDelStage('done');
      setTimeout(() => {
        if (typeof onDeleted === 'function') {
          // Reuse the onDeleted callback for backward compatibility —
          // parent components already handle 'employee gone' by
          // refetching the list. Inactive becomes invisible there
          // unless the "Show inactive" toggle is on.
          try { onDeleted(employee.id, { ok: true, status: targetStatus }); } catch (_) { /* swallow */ }
        }
        if (typeof onClose === 'function') {
          onClose();
        }
      }, 1100);
    } catch (e) {
      setDelError(e?.message || String(e));
      setDelStage('error');
    }
  };

  const balByType = useMemo(() => {
    return leaveTypes.map(t => {
      const adj = balances.find(b => b.leave_type_id === t.id && b.year === year) || {};
      return { type: t, balance: calculateBalance({ employee, leaveType: t, year, requests, adjustments: adj }) };
    });
  }, [leaveTypes, balances, requests, employee, year]);

  const history = useMemo(() => {
    return [...requests].sort((a, b) =>
      new Date(b.requested_at || b.created_at) - new Date(a.requested_at || a.created_at)
    );
  }, [requests]);

  // ── Leave statement (shareable PDF) ────────────────────────────────
  //  Nadeem 2026-05-29: when staff ask Bashaier for their details, she
  //  needs to send a complete picture — balance + this-year history +
  //  how many times they applied + last applied + permissions. One-click
  //  printable statement she can save as PDF and email to the staff.
  const buildStatement = () => {
    const esc = (s) => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const yr = new Date().getFullYear();
    const d2 = (s) => {
      if (!s) return '—';
      const d = new Date(s + (String(s).length === 10 ? 'T00:00:00' : ''));
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    };
    const dayCount = (a, b) => {
      if (!a || !b) return 0;
      return Math.max(1, Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000) + 1);
    };
    const typeName = (id) => {
      const t = (leaveTypes || []).find(x => x.id === id);
      return t?.label || t?.name || (id ? id.charAt(0).toUpperCase() + id.slice(1) : '—');
    };
    const stageLabel = (r) => {
      const s = r.stage || r.status || '';
      if (s === 'approved') return 'Approved';
      if (s.includes('reject')) return 'Rejected';
      if (s.includes('cancel')) return 'Cancelled';
      if (s.includes('pending')) return 'Pending';
      return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
    };

    // This-year requests (by requested_at, fallback to start_date year)
    const thisYear = history.filter(r => {
      const ry = new Date(r.requested_at || r.created_at || r.start_date).getFullYear();
      return ry === yr;
    });
    const approvedThisYear = thisYear.filter(r => (r.stage || r.status) === 'approved');
    const lastApplied = thisYear[0]; // history already sorted desc

    // Balance rows (skip unlimited / empty types)
    const balRows = balByType.filter(({ type, balance }) => {
      const unlimited = type.accrual_method === 'unlimited';
      const empty = !balance.total && balance.available === 0 && balance.used === 0;
      return !unlimited && !empty;
    }).map(({ type, balance }) => {
      const bonus = Number(balance.bonus || 0);
      const dispTotal = balance.entitlement + balance.carried + bonus;
      const dispAvail = dispTotal - (balance.used || 0);
      return `<tr>
        <td>${esc(type.label || type.name || type.id)}</td>
        <td style="text-align:right">${dispTotal}</td>
        <td style="text-align:right">${balance.used || 0}</td>
        <td style="text-align:right;font-weight:700;color:${dispAvail <= 0 ? '#991B1B' : '#065F46'}">${dispAvail}</td>
      </tr>`;
    }).join('');

    // History table (this year)
    const histRows = thisYear.map(r => `
      <tr>
        <td>${esc(d2(r.requested_at || r.created_at))}</td>
        <td>${esc(typeName(r.leave_type_id))}</td>
        <td>${esc(d2(r.start_date))} → ${esc(d2(r.end_date))}</td>
        <td style="text-align:right">${dayCount(r.start_date, r.end_date)}${r.is_half_day ? ' (½)' : ''}</td>
        <td>${esc(stageLabel(r))}</td>
      </tr>`).join('');

    // Permissions this year
    const permsThisYear = (permissions || []).filter(p => {
      const py = new Date(p.permission_date || p.requested_at).getFullYear();
      return py === yr && (p.stage || p.status) === 'approved';
    });
    const lateN = permsThisYear.filter(p => (p.type || '').includes('late')).length;
    const earlyN = permsThisYear.filter(p => (p.type || '').includes('early')).length;

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<title>Leave Statement — ${esc(employee.name)}</title>
<style>
  @page { size: A4 portrait; margin: 16mm; }
  * { box-sizing:border-box; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  body { font-family:'Calibri','Segoe UI',sans-serif; color:#1F1B16; font-size:12px; margin:0; padding:24px; }
  .report-header { border-bottom:2px solid #0F4C2A; padding-bottom:12px; margin-bottom:16px; }
  .kicker { font-size:9px; letter-spacing:.3em; color:#0F4C2A; font-weight:700; text-transform:uppercase; }
  h1 { font-size:22px; margin:4px 0 2px; color:#0A0A0A; }
  .sub { font-size:11px; color:#555; }
  .info { display:grid; grid-template-columns:1fr 1fr; gap:4px 24px; margin:14px 0 18px; font-size:11px; }
  .info .row { display:flex; justify-content:space-between; border-bottom:1px dotted #E5E7EB; padding:3px 0; }
  .info .row .k { color:#666; }
  .info .row .v { font-weight:600; color:#0A0A0A; }
  .cards { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:18px; }
  .card { border:1px solid rgba(0,0,0,.08); border-radius:6px; padding:10px 12px; }
  .card .lbl { font-size:9px; letter-spacing:.1em; color:#555; text-transform:uppercase; }
  .card .val { font-size:24px; font-weight:700; color:#0A0A0A; margin-top:2px; }
  .card .sv { font-size:10px; color:#666; }
  h2 { font-size:13px; margin:18px 0 7px; color:#0F4C2A; }
  table { width:100%; border-collapse:collapse; font-size:11px; margin-bottom:6px; }
  th { background:#0F4C2A; color:#fff; padding:5px 8px; text-align:left; font-size:9px; text-transform:uppercase; letter-spacing:.03em; }
  td { padding:4px 8px; border-bottom:1px solid #F3F4F6; }
  .no-print {} @media print { .no-print { display:none !important; } body { padding:0; } }
  .pbtn { background:#0F4C2A; color:#fff; padding:6px 14px; border:0; border-radius:4px; cursor:pointer; font-size:12px; font-weight:600; }
  .footer { margin-top:24px; padding-top:10px; border-top:1px solid #D1D5DB; font-size:9px; color:#666; display:flex; justify-content:space-between; }
</style></head><body>
  <div class="no-print" style="margin-bottom:10px"><button class="pbtn" onclick="window.print()">Print / Save as PDF</button></div>
  <header class="report-header">
    <div class="kicker">Evergreen Shipping Agency Saudi Co. (L.L.C) · ESAU HR</div>
    <h1>Leave Statement — ${esc(employee.name)}</h1>
    <div class="sub">Balance &amp; leave activity for ${yr}</div>
  </header>

  <div class="info">
    <div class="row"><span class="k">PSN ID</span><span class="v">${esc(employee.id)}</span></div>
    <div class="row"><span class="k">Department</span><span class="v">${esc(employee.department || '—')}</span></div>
    <div class="row"><span class="k">Designation</span><span class="v">${esc(employee.designation || '—')}</span></div>
    <div class="row"><span class="k">Location</span><span class="v">${esc(employee.location || '—')}</span></div>
    <div class="row"><span class="k">Date joined</span><span class="v">${esc(d2(employee.join_date))}</span></div>
    <div class="row"><span class="k">Tenure</span><span class="v">${yos} yr${yos === 1 ? '' : 's'} ${mos} mo</span></div>
  </div>

  <div class="cards">
    <div class="card" style="border-color:#A7F3D0;background:#F0FDF4">
      <div class="lbl">Annual remaining</div>
      <div class="val" style="color:#065F46">${(() => { const b = balByType.find(x => x.type.id === 'annual')?.balance; return b ? (b.entitlement + b.carried + Number(b.bonus||0) - (b.used||0)) : 0; })()}</div>
      <div class="sv">of ${(() => { const b = balByType.find(x => x.type.id === 'annual')?.balance; return b ? (b.entitlement + b.carried + Number(b.bonus||0)) : 0; })()} days</div>
    </div>
    <div class="card" style="border-color:#BFDBFE;background:#EFF6FF">
      <div class="lbl">Applications in ${yr}</div>
      <div class="val">${thisYear.length}</div>
      <div class="sv">${approvedThisYear.length} approved</div>
    </div>
    <div class="card" style="border-color:#FBCFE8;background:#FDF4FF">
      <div class="lbl">Last applied</div>
      <div class="val" style="font-size:16px;margin-top:6px">${lastApplied ? esc(d2(lastApplied.requested_at || lastApplied.created_at)) : '—'}</div>
      <div class="sv">${lastApplied ? esc(typeName(lastApplied.leave_type_id)) : 'No applications this year'}</div>
    </div>
  </div>

  <h2>Leave balance by type</h2>
  <table><thead><tr><th>Leave Type</th><th style="text-align:right">Entitled</th><th style="text-align:right">Used</th><th style="text-align:right">Available</th></tr></thead>
    <tbody>${balRows || '<tr><td colspan="4" style="padding:8px;color:#999;font-style:italic">No tracked balances.</td></tr>'}</tbody></table>

  <h2>Leave applications in ${yr} (${thisYear.length})</h2>
  <table><thead><tr><th>Date Applied</th><th>Type</th><th>Period</th><th style="text-align:right">Days</th><th>Status</th></tr></thead>
    <tbody>${histRows || '<tr><td colspan="5" style="padding:8px;color:#999;font-style:italic">No leave applications this year.</td></tr>'}</tbody></table>

  <h2>Permissions in ${yr}</h2>
  <table><thead><tr><th>Late arrivals</th><th>Early departures</th><th>Total</th></tr></thead>
    <tbody><tr><td>${lateN}</td><td>${earlyN}</td><td style="font-weight:700">${lateN + earlyN}</td></tr></tbody></table>

  <div class="footer">
    <span>Issued by ${esc(me?.name || 'ESAU HR')} · ${esc(new Date().toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }))}</span>
    <span>ESAU HR portal · for ${esc(employee.name)}</span>
  </div>
</body></html>`;
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const w = window.open(url, '_blank');
    if (!w) {
      const a = document.createElement('a');
      a.href = url; a.download = `Leave_Statement_${esc(employee.name).replace(/\s+/g, '_')}.html`; a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  const yos = yearsOfService(employee.join_date);
  const mos = monthsOfService(employee.join_date) % 12;
  const manager = (employees || []).find(e => e.id === employee.manager_id);
  const status = employee.employment_status || 'active';
  const statusLabel = status === 'on_leave' ? 'ON LEAVE'
                    : status === 'terminated' ? 'TERMINATED'
                    : 'ACTIVE';
  const statusFg = status === 'active' ? '#0F4C2A'
                  : status === 'on_leave' ? '#854F0B'
                  : '#991B1B';
  const statusBg = status === 'active' ? '#ECFDF5'
                  : status === 'on_leave' ? '#FEF3C7'
                  : '#FEE2E2';

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 modal-bounce-backdrop"
         style={{ background: 'rgba(15, 31, 26, 0.4)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="rounded-t-2xl sm:rounded-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto modal-bounce-card"
        style={{ background: 'var(--paper)' }}>
        {/* Compact info-rich header. Pulls more details forward
            (manager, email, phone, employment status) so admin can
            see everything important without scrolling. */}
        <div className="sticky top-0 z-10 px-4 py-3 border-b backdrop-blur"
             style={{ borderColor: 'var(--border-soft)', background: 'rgba(250, 247, 240, 0.95)' }}>
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <Avatar id={employee.id} name={employee.name} size="lg"/>
              <div className="min-w-0 flex-1">
                {/* Top row: ID + status pill */}
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="text-[10px] tracking-[0.22em] mono" style={{ color: '#0A0A0A', opacity: 0.55 }}>
                    {employee.id}
                  </span>
                  <span className="text-[8.5px] tracking-[0.12em] px-1.5 py-0.5 rounded-full"
                    style={{ background: statusBg, color: statusFg, fontWeight: 700 }}>
                    {statusLabel}
                  </span>
                </div>
                {/* Name */}
                <h2 className="serif text-xl truncate"
                  style={{ fontWeight: 500, letterSpacing: '-0.01em', color: '#1F1B16', lineHeight: 1.15 }}>
                  {employee.name}
                </h2>
                {/* Quick-info chips — wraps nicely on narrow viewports */}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1.5 text-[11px]"
                  style={{ color: '#0A0A0A' }}>
                  <span className="flex items-center gap-1" title="Department">
                    <Building2 className="w-3 h-3" style={{ opacity: 0.55 }}/>
                    {employee.department}
                  </span>
                  <span className="flex items-center gap-1" title="Location">
                    <MapPin className="w-3 h-3" style={{ opacity: 0.55 }}/>
                    {LOCATION_LABELS[employee.location] || employee.location}
                  </span>
                  {employee.join_date && (
                    <span className="flex items-center gap-1" title="Years of service">
                      <Calendar className="w-3 h-3" style={{ opacity: 0.55 }}/>
                      {yos}y {mos}m · joined {fmtDateShort(employee.join_date)}
                    </span>
                  )}
                  {manager && (
                    <span className="flex items-center gap-1" title="Reports to">
                      <UserCheck className="w-3 h-3" style={{ opacity: 0.55 }}/>
                      {manager.name}
                    </span>
                  )}
                  {employee.email && (
                    <a href={`mailto:${employee.email}`}
                      className="flex items-center gap-1 hover:underline"
                      style={{ color: '#0F4C2A' }}>
                      <Mail className="w-3 h-3" style={{ opacity: 0.6 }}/>
                      {employee.email}
                    </a>
                  )}
                  {employee.phone && (
                    <a href={`tel:${employee.phone}`}
                      className="flex items-center gap-1 hover:underline"
                      style={{ color: '#0F4C2A' }}>
                      <Phone className="w-3 h-3" style={{ opacity: 0.6 }}/>
                      {employee.phone}
                    </a>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {canResetPin && (
                <button
                  onClick={() => { setPinOpen(v => !v); if (delStage !== 'idle') { setDelStage('idle'); setDelTyped(''); setDelError(''); } }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] transition-colors"
                  style={{
                    /* PIN button: mint-green tinted always — clearly an
                       admin action, not just neutral chrome. Tone deepens
                       when the panel is open so admin sees the active
                       state. */
                    background: pinOpen ? '#0F4C2A' : '#ECFDF5',
                    border: '1px solid ' + (pinOpen ? '#0F4C2A' : '#A7F3D0'),
                    color: pinOpen ? '#FFFFFF' : '#0F4C2A',
                    fontWeight: 700,
                    lineHeight: 1,
                    cursor: 'pointer',
                  }}
                  title="Reset PIN for this employee"
                >
                  <span style={{ fontSize: 13 }} aria-hidden="true">🔑</span>
                  <span>Reset PIN</span>
                </button>
              )}
              {canDeactivate && (
                <button
                  onClick={() => {
                    if (delStage === 'idle') {
                      setDelStage('confirm');
                      setDelError('');
                      setPinOpen(false);
                    } else {
                      setDelStage('idle');
                      setDelError('');
                    }
                  }}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] transition-colors"
                  style={{
                    /* Inactive button: amber when activating, brand-green
                       when reactivating. Both reversible — no destructive
                       red. Solid fill when confirm panel is open. */
                    background: delStage !== 'idle'
                      ? (isAlreadyInactive ? '#0F4C2A' : '#92400E')
                      : (isAlreadyInactive ? '#ECFDF5' : '#FEF3C7'),
                    border: '1px solid ' + (delStage !== 'idle'
                      ? (isAlreadyInactive ? '#0F4C2A' : '#92400E')
                      : (isAlreadyInactive ? '#A7F3D0' : '#FCD34D')),
                    color: delStage !== 'idle'
                      ? '#FFFFFF'
                      : (isAlreadyInactive ? '#0F4C2A' : '#92400E'),
                    fontWeight: 700,
                    lineHeight: 1,
                    cursor: 'pointer',
                  }}
                  title={isAlreadyInactive
                    ? 'Restore this employee to the active roster'
                    : 'Mark this employee inactive — data is preserved'}
                >
                  <span style={{ fontSize: 13 }} aria-hidden="true">
                    {isAlreadyInactive ? '↻' : '⊘'}
                  </span>
                  <span>{isAlreadyInactive ? 'Reactivate' : 'Deactivate'}</span>
                </button>
              )}
              <button onClick={onClose} className="p-1.5 rounded-full hover:bg-black/5" aria-label="Close" title="Close">
                <X className="w-4 h-4"/>
              </button>
            </div>
          </div>

          {/* Inline PIN-reset panel — opens when admin clicks the 🔑
              button in the corner. Shows the input + a few quick-pick
              defaults; on success, shows the new PIN + "Edit again"
              link so admin can issue another PIN without closing. */}
          {pinOpen && canResetPin && (
            <div className="mt-3 pt-3" style={{ borderTop: '1px dashed var(--border-soft)' }}>
              {pinDone && !pinErr ? (
                /* Success state */
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-start gap-2 text-[12px]" style={{ color: '#0F4C2A' }}>
                    <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                    <div>
                      <div style={{ fontWeight: 700 }}>PIN changed</div>
                      <div className="mt-0.5" style={{ opacity: 0.85 }}>
                        New PIN: <span className="font-mono px-1.5 py-0.5 rounded" style={{ background: '#FFFFFF', border: '1px solid #A7F3D0', fontWeight: 700, letterSpacing: '0.08em' }}>{pinValue}</span>
                        {' '}· share this with {employee.name?.split(' ')[0] || 'them'}.
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => { setPinDone(''); setPinErr(''); setPinValue(''); }}
                      className="text-[11px] inline-flex items-center gap-1 px-2.5 py-1 rounded-full"
                      style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)', color: '#0A0A0A', cursor: 'pointer', fontWeight: 600 }}
                    >
                      <Pencil className="w-3 h-3"/> Edit again
                    </button>
                    <button
                      type="button"
                      onClick={() => { setPinOpen(false); setPinDone(''); setPinErr(''); setPinValue(''); }}
                      className="text-[11px] px-2.5 py-1 rounded-full"
                      style={{ background: 'none', border: 'none', color: '#0A0A0A', opacity: 0.7, cursor: 'pointer' }}
                    >
                      Close
                    </button>
                  </div>
                </div>
              ) : (
                /* Edit state */
                <form onSubmit={submitPin} className="flex items-end gap-2 flex-wrap">
                  <div className="flex-1" style={{ minWidth: 180 }}>
                    <label className="block text-[9px] tracking-[0.16em] mb-1" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
                      🔑 NEW PIN FOR {employee.id}
                    </label>
                    <input
                      type="text"
                      value={pinValue}
                      onChange={e => setPinValue(e.target.value)}
                      autoFocus
                      disabled={pinBusy}
                      placeholder="At least 6 characters"
                      className="w-full px-3 py-1.5 rounded-lg border text-sm font-mono"
                      style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#1F1B16', letterSpacing: '0.08em' }}
                    />
                    <div className="flex gap-1 mt-1.5">
                      {['202600', '260026', '123456'].map(p => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setPinValue(p)}
                          disabled={pinBusy}
                          className="text-[10px] tracking-wider px-1.5 py-0.5 rounded font-mono"
                          style={{ background: 'rgba(15,40,24,0.06)', color: '#0F4C2A', border: 'none', cursor: 'pointer' }}
                        >
                          use {p}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => { setPinOpen(false); setPinErr(''); setPinValue(''); }}
                      disabled={pinBusy}
                      className="text-[11px] px-3 py-1.5 rounded-full"
                      style={{ background: '#FFFFFF', border: '1px solid var(--border-soft)', color: '#0A0A0A', cursor: pinBusy ? 'not-allowed' : 'pointer', fontWeight: 600 }}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={pinBusy || !pinValue || pinValue.length < 6}
                      className="inline-flex items-center gap-1 text-[11px] px-3 py-1.5 rounded-full"
                      style={{
                        background: '#0F4C2A',
                        color: '#FFFFFF',
                        border: 'none',
                        cursor: (pinBusy || !pinValue || pinValue.length < 6) ? 'not-allowed' : 'pointer',
                        opacity: (pinBusy || !pinValue || pinValue.length < 6) ? 0.5 : 1,
                        fontWeight: 700,
                      }}
                    >
                      {pinBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      {pinBusy ? 'Saving…' : 'Save PIN'}
                    </button>
                  </div>
                  {pinErr && (
                    <div className="w-full flex items-center gap-1.5 px-2 py-1 rounded text-[11px]"
                      style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
                      <AlertCircle className="w-3 h-3 flex-shrink-0" /> {pinErr}
                    </div>
                  )}
                </form>
              )}
            </div>
          )}

          {/* Inline Delete-employee confirm panel — opens when admin
              clicks the 🗑️ Delete pill. Mirrors the PIN panel's
              placement (inside the sticky header band, slides down
              below the title row) so both header-triggered actions
              surface in the same predictable spot. Multi-step:
              confirm → submitting → done / error. */}
          {canDeactivate && delStage !== 'idle' && (
            <div className="mt-3 pt-3" style={{ borderTop: '1px dashed #FCD34D' }}>
              {delStage === 'done' ? (
                /* Success — soft green banner, reversible action */
                <div className="flex items-start gap-2 rounded-lg" style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', padding: '10px 12px', color: '#0F4C2A' }}>
                  <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
                  <div className="text-[12px]">
                    <div style={{ fontWeight: 700 }}>
                      {delResult?.name || employee.name} {delResult?.status === 'active' ? 'reactivated' : 'marked inactive'}
                    </div>
                    <div className="mt-0.5 text-[10.5px]" style={{ opacity: 0.85 }}>
                      {delResult?.status === 'active'
                        ? 'Now appears in the active roster and counts.'
                        : 'Data is preserved. Reactivate any time from the Employees tab with "Show inactive" on.'}
                    </div>
                  </div>
                </div>
              ) : (
                /* Confirm / submitting / error — soft warning (reversible) */
                <div>
                  <div className="flex items-start gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: isAlreadyInactive ? '#0F4C2A' : '#92400E' }} />
                    <div>
                      <div className="text-[11px]" style={{ color: isAlreadyInactive ? '#0F4C2A' : '#92400E', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
                        {isAlreadyInactive ? `Reactivate ${employee.name}?` : `Mark ${employee.name} as inactive?`}
                      </div>
                      <div className="text-[11.5px] mt-1" style={{ color: '#1F1B16', lineHeight: 1.5, opacity: 0.85 }}>
                        {isAlreadyInactive
                          ? 'Restores this staff member to the active roster. They will appear in dashboard counts again and can submit requests.'
                          : (<>This is <strong>reversible</strong>. All data stays intact — profile, history, balances, attendance. The employee just drops out of active counts. You can reactivate any time from the Employees tab with <strong>Show inactive</strong> on.</>)}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 mt-3 justify-end">
                    <button
                      onClick={() => { setDelStage('idle'); setDelError(''); }}
                      disabled={delStage === 'submitting'}
                      className="text-[11px] px-3 py-1.5 rounded-full"
                      style={{
                        background: '#FFFFFF',
                        border: '1px solid var(--border-soft)',
                        color: '#0A0A0A',
                        cursor: delStage === 'submitting' ? 'not-allowed' : 'pointer',
                        fontWeight: 600,
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={submitDeactivate}
                      disabled={delStage === 'submitting'}
                      className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full"
                      style={{
                        background: isAlreadyInactive ? '#0F4C2A' : '#92400E',
                        color: '#FFFFFF',
                        border: 'none',
                        cursor: delStage === 'submitting' ? 'not-allowed' : 'pointer',
                        opacity: delStage === 'submitting' ? 0.5 : 1,
                        fontWeight: 700,
                      }}
                    >
                      {delStage === 'submitting'
                        ? <><Loader2 className="w-3 h-3 animate-spin" /> {isAlreadyInactive ? 'Reactivating…' : 'Deactivating…'}</>
                        : <>{isAlreadyInactive ? '↻ Reactivate' : '⊘ Mark Inactive'}</>}
                    </button>
                  </div>

                  {delError && (
                    <div className="mt-2 flex items-center gap-1.5 px-2 py-1 rounded text-[11px]"
                      style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
                      <AlertCircle className="w-3 h-3 flex-shrink-0" /> {delError}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="p-4 space-y-4">
          {/* Government records — Arabic name, National ID, DOB,
              gender, official Arabic profession, GOSI eligibility,
              MOL join date. Populated by the MOL · GOSI sync flow.
              Always renders for admin and HR reviewer (they administer
              government correspondence) — when empty, the section
              surfaces a "Pull from MOL · GOSI" button so they can
              fill it for this one employee without going to the
              bulk sync tab.
              Regular staff see only their OWN government record on
              the personal dashboard if needed (out of scope for
              this commit — the modal is mostly used by privileged
              roles). */}
          {(me?.is_admin || me?.is_hr_reviewer) && employee?.id && (
            <GovernmentRecordsPanel employee={employee} onSaved={onSaved} />
          )}

          {/* Edit-profile panel — visible only to admin + HR reviewer.
              Bashaier asked for the ability to fix staff data herself
              (typos, missing emails, wrong department, manager not yet
              assigned). The panel writes through directPatch on the
              employees table; success calls onSaved() so the parent
              can refresh its in-memory directory. */}
          {(me?.is_admin || me?.is_hr_reviewer) && employee?.id && (
            <EditProfilePanel
              employee={employee}
              employees={employees}
              onSaved={onSaved}
            />
          )}

          {/* Monthly attendance report removed from this modal —
              the dedicated Attendance tab now owns the per-employee
              monthly report download (richer flow with calendar +
              evaluation tiles + month picker), so duplicating a
              stripped-down version here just confuses Bashaier
              about which one to use. */}

          {/* Leave balances — Option C tile grid (per Nadeem's pick).
              4-column grid of mini stat tiles. Each tile has a thin
              color stripe at the top, type name (10px caps), and a
              big mono number with /total subtle. ~130px tall for 8
              types — half the previous tile-grid footprint. */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] tracking-[0.22em]" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
                LEAVE BALANCES · {year}
              </div>
              <button onClick={buildStatement}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded text-white"
                style={{ background: '#0F4C2A' }}
                title="Generate a printable leave statement to send this staff member">
                <FileText size={12} /> Leave Statement
              </button>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {balByType.map(({ type, balance }) => {
                const exhausted = balance.available <= 0 && (balance.total || 0) > 0;
                const unlimited = type.accrual_method === 'unlimited' || (!balance.total && balance.available === 0 && balance.used === 0);

                // Decompose the balance into HR-friendly numbers:
                //   • dispTotal   — entitlement + carried + bonus (positive adj)
                //   • prePortal   — negative adj surfaced as 'taken before portal'
                //   • dispUsed    — portal-recorded leaves + pending + prePortal
                //   • dispAvail   — dispTotal − dispUsed  (== balance.available)
                //
                // This decomposition is for DISPLAY only. The underlying
                // balance.available number is unchanged — only how the
                // pieces are presented changes. Nadeem 2026-05-21: 'easy
                // to understand … ensuring all information is correct'.
                const adjVal     = Number(balance.adjustment || 0);
                const prePortal  = adjVal < 0 ? -adjVal : 0;
                const bonus      = adjVal > 0 ?  adjVal : 0;
                const dispTotal  = balance.entitlement + balance.carried + bonus;
                const dispUsed   = balance.used + balance.pending + prePortal;
                const dispAvail  = dispTotal - dispUsed;

                const hasCarry      = balance.carried > 0;
                const hasPrePortal  = prePortal > 0;
                const hasPortalUsed = balance.used > 0;
                const hasBonus      = bonus > 0;
                const isHighlighted = hasCarry || hasPrePortal;

                return (
                  <div
                    key={type.id}
                    className="rounded-lg overflow-hidden relative"
                    style={{
                      background: isHighlighted ? '#FFFBEB' : '#FAFAF6',
                      padding: '10px 10px 10px',
                      border: isHighlighted ? '1px solid #FCD34D' : '1px solid transparent',
                    }}
                    title={
                      `AUDIT BREAKDOWN\n` +
                      `Entitlement (${year}):  ${balance.entitlement}\n` +
                      (hasCarry      ? `Carried from ${year - 1}: +${balance.carried}\n` : '') +
                      (hasBonus      ? `Bonus / adjustment:    +${bonus}\n`              : '') +
                      `── Total pool:         ${dispTotal}\n` +
                      (hasPrePortal  ? `Used before portal:    −${prePortal}\n` : '') +
                      (hasPortalUsed ? `Used in portal:        −${balance.used}\n` : '') +
                      (balance.pending > 0 ? `Pending:               −${balance.pending}\n` : '') +
                      `── Available:          ${dispAvail}`
                    }
                  >
                    {/* Color stripe */}
                    <div
                      style={{
                        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
                        background: type.color,
                      }}
                    />

                    {/* Name */}
                    <div
                      className="truncate"
                      style={{
                        fontSize: 10, color: '#0A0A0A', fontWeight: 600,
                        opacity: 0.8, marginBottom: 4, marginTop: 1,
                      }}
                    >
                      {type.name}
                    </div>

                    {/* Headline — big AVAILABLE number, smaller /total */}
                    <div className="flex items-baseline gap-0.5 font-mono" style={{ lineHeight: 1 }}>
                      <span style={{
                        fontSize: 20, fontWeight: 700,
                        color: exhausted ? 'var(--clay)' : '#1F1B16',
                      }}>
                        {unlimited ? '∞' : dispAvail}
                      </span>
                      {!unlimited && (
                        <span style={{ fontSize: 12, color: '#0A0A0A', opacity: 0.5, fontWeight: 400 }}>
                          {' / '}{dispTotal}
                        </span>
                      )}
                      {balance.pending > 0 && (
                        <span
                          className="ml-auto px-1 rounded"
                          style={{ background: '#FEF3C7', color: '#854F0B', fontSize: 9, fontWeight: 700 }}
                          title={`${balance.pending} pending`}
                        >
                          +{balance.pending}
                        </span>
                      )}
                    </div>
                    {!unlimited && (
                      <div style={{
                        fontSize: 9, color: '#0A0A0A', opacity: 0.55,
                        marginTop: 2, fontWeight: 500,
                      }}>
                        days available
                      </div>
                    )}

                    {/* Breakdown lines — each context fact on its own
                        line with a coloured marker. Only render when
                        the relevant figure is non-zero, so simple
                        tiles stay clean. */}
                    {(hasCarry || hasPrePortal || hasBonus || hasPortalUsed) && (
                      <div style={{ marginTop: 6, lineHeight: 1.6 }}>
                        {hasCarry && (
                          <div className="flex items-center gap-1.5" style={{ fontSize: 9.5, color: '#0A0A0A' }}>
                            <span style={{
                              width: 5, height: 5, borderRadius: '50%',
                              background: '#A16207', flexShrink: 0,
                            }} />
                            <span><strong style={{ fontWeight: 700 }}>{balance.carried}</strong> from {year - 1} carryover</span>
                          </div>
                        )}
                        {hasBonus && (
                          <div className="flex items-center gap-1.5" style={{ fontSize: 9.5, color: '#0A0A0A' }}>
                            <span style={{
                              width: 5, height: 5, borderRadius: '50%',
                              background: '#0F4C2A', flexShrink: 0,
                            }} />
                            <span><strong style={{ fontWeight: 700 }}>+{bonus}</strong> HR adjustment</span>
                          </div>
                        )}
                        {hasPrePortal && (
                          <div className="flex items-center gap-1.5" style={{ fontSize: 9.5, color: '#0A0A0A' }}>
                            <span style={{
                              width: 5, height: 5, borderRadius: '50%',
                              background: '#9D6B53', flexShrink: 0,
                            }} />
                            <span><strong style={{ fontWeight: 700 }}>{prePortal}</strong> used before portal</span>
                          </div>
                        )}
                        {hasPortalUsed && (
                          <div className="flex items-center gap-1.5" style={{ fontSize: 9.5, color: '#0A0A0A' }}>
                            <span style={{
                              width: 5, height: 5, borderRadius: '50%',
                              background: '#737373', flexShrink: 0,
                            }} />
                            <span><strong style={{ fontWeight: 700 }}>{balance.used}</strong> used in {year}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-[10px] tracking-[0.22em] mb-2" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
              LEAVE HISTORY
            </div>
            {history.length === 0 ? (
              <div className="rounded-xl border p-6 text-center text-sm opacity-60"
                   style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
                <Briefcase className="w-5 h-5 mx-auto mb-2"/>
                No leave records yet.
              </div>
            ) : (
              <ul className="rounded-xl border divide-y"
                  style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
                {history.map(r => {
                  const tp = typeMap[r.leave_type_id];
                  return (
                    <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: tp?.color }}/>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm" style={{ fontWeight: 500 }}>{tp?.name || r.leave_type_id}</div>
                        <div className="text-xs opacity-60">{fmtDateShort(r.start_date)} → {fmtDateShort(r.end_date)} · {r.days}d</div>
                      </div>
                      <Pill color={r.status === 'approved' ? 'var(--evergreen-500)' : r.status === 'rejected' ? 'var(--clay)' : 'var(--copper)'}>
                        {r.status}
                      </Pill>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Reset PIN moved to the header (🔑 button next to close).
              Per Nadeem: "the admin reset pin option move after the
              main name in top in the corner, use some logical emoji
              for it". The inline panel opens below the header on
              click. */}

          {/* Danger zone moved to the header too — Nadeem: "suggest
              keep delete employee button on top next to PIN emoji,
              use a name tag for the emoji make it appear as a
              button and after that keep delete button with emoji".
              The 🗑️ Delete pill in the header corner triggers the
              same multi-step confirmation flow that used to live
              here at the bottom. */}
        </div>
      </div>
    </div>
  );
}

// ─── DangerZone ─────────────────────────────────────────────────────
// Permanently deletes an employee record + all their data via the
// admin_delete_employee RPC. Multi-step confirmation:
//   1. Idle: a clearly-marked red "Delete employee" button — easy to
//      see, hard to click by accident (must scroll to the bottom of
//      the modal).
//   2. Confirm: a dialog appears with the warning message, a list
//      of what will be deleted, and an input requiring the admin to
//      type the PSN. The Delete button stays disabled until the
//      typed PSN matches the target employee's ID.
//   3. Submitting: spinner + "Deleting…" status.
//   4. Done: brief "Removed" message, modal auto-closes after
//      ~1 second so admin sees the confirmation.
//
// The RPC handles all server-side cascade logic. Client just triggers
// it and reflects the response.
function DangerZone({ employee, me, onDeleted, onClose }) {
  const [stage, setStage] = useState('idle');
  // 'idle' | 'confirm' | 'submitting' | 'done' | 'error'
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  // Reset state when the modal swaps to a different employee
  React.useEffect(() => {
    setStage('idle');
    setTyped('');
    setError('');
    setResult(null);
  }, [employee.id]);

  const submit = async () => {
    setStage('submitting');
    setError('');
    try {
      const { data, error } = await supabase.rpc('admin_delete_employee', {
        target_psn:   employee.id,
        confirmation: typed.trim(),
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Unknown error');
      setResult(data);
      setStage('done');
      // Notify parent so they can refresh the directory + close the
      // modal. We delay the close slightly so admin sees the success
      // confirmation before it disappears.
      setTimeout(() => {
        if (typeof onDeleted === 'function') {
          try { onDeleted(employee.id, data); } catch (_) { /* swallow */ }
        }
        if (typeof onClose === 'function') {
          onClose();
        }
      }, 1100);
    } catch (e) {
      setError(e?.message || String(e));
      setStage('error');
    }
  };

  // Idle — a single clearly-bounded red button
  if (stage === 'idle') {
    return (
      <div className="rounded-xl"
        style={{
          border: '1px dashed #FCA5A5',
          background: '#FEF2F2',
          padding: '10px 12px',
        }}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#991B1B' }} />
            <div>
              <div className="text-[10px] tracking-[0.22em]" style={{ color: '#991B1B', fontWeight: 700, opacity: 0.85 }}>
                DANGER ZONE
              </div>
              <div className="text-[11.5px] mt-0.5" style={{ color: '#991B1B', opacity: 0.85 }}>
                Permanently delete this employee record from the system.
              </div>
            </div>
          </div>
          <button
            onClick={() => { setStage('confirm'); setTyped(''); setError(''); }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px]"
            style={{
              background: '#FFFFFF',
              border: '1px solid #FCA5A5',
              color: '#991B1B',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            <Trash2 className="w-3 h-3" />
            Delete employee
          </button>
        </div>
      </div>
    );
  }

  // Done — brief success state before auto-close
  if (stage === 'done') {
    return (
      <div className="rounded-xl flex items-start gap-2"
        style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', padding: '10px 12px', color: '#0F4C2A' }}
      >
        <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
        <div className="text-[12px]">
          <div style={{ fontWeight: 700 }}>{result?.name || employee.name} removed</div>
          {result?.counts && (
            <div className="mt-0.5 text-[10.5px]" style={{ opacity: 0.85 }}>
              Cleaned up:{' '}
              {Object.entries(result.counts)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`)
                .join(', ') || 'no associated records'}.
            </div>
          )}
        </div>
      </div>
    );
  }

  // Confirm / submitting / error — full warning UI
  return (
    <div className="rounded-xl"
      style={{
        background: '#FEF2F2',
        border: '1px solid #FCA5A5',
        padding: '14px 16px',
        boxShadow: '0 0 0 3px rgba(153, 27, 27, 0.04)',
      }}
    >
      <div className="flex items-start gap-2 mb-3">
        <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: '#991B1B' }} />
        <div>
          <div className="text-[12px]" style={{ color: '#991B1B', fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
            Delete {employee.name}?
          </div>
          <div className="text-[12px] mt-1.5" style={{ color: '#7F1D1D', lineHeight: 1.5 }}>
            This action <strong>cannot be undone</strong>. The complete data for this staff member will be deleted from the system, including:
          </div>
          <ul className="text-[11.5px] mt-1.5 space-y-0.5" style={{ color: '#7F1D1D', listStyle: 'disc', marginLeft: 18 }}>
            <li>Employee profile + government records (Arabic name, National ID, DOB, GOSI data)</li>
            <li>All leave requests, balances, and history</li>
            <li>All attendance records and uploads</li>
            <li>All shift plans and acknowledgments</li>
            <li>All permission requests</li>
            <li>Their PSN authentication and active sessions</li>
          </ul>
          <div className="text-[11px] mt-2" style={{ color: '#7F1D1D', opacity: 0.85 }}>
            The deletion will be recorded in the activity log under your name. References to this employee in historical records (e.g. who approved someone else's leave) will be set to null but kept.
          </div>
        </div>
      </div>

      {/* Typed-confirmation input */}
      <div className="mt-3">
        <label className="block text-[10px] tracking-[0.16em] mb-1" style={{ color: '#7F1D1D', fontWeight: 700 }}>
          TYPE <span className="font-mono px-1 py-0.5 rounded" style={{ background: '#FFFFFF', border: '1px solid #FCA5A5', letterSpacing: '0.1em' }}>{employee.id}</span> TO CONFIRM
        </label>
        <input
          type="text"
          value={typed}
          onChange={e => setTyped(e.target.value)}
          disabled={stage === 'submitting'}
          autoFocus
          placeholder={employee.id}
          className="w-full px-3 py-2 rounded-lg border text-sm font-mono"
          style={{
            borderColor: typed && typed.trim() !== employee.id ? '#FCA5A5' : 'var(--border-soft)',
            background: '#FFFFFF',
            color: '#1F1B16',
            letterSpacing: '0.1em',
          }}
        />
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11.5px]"
          style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="mt-3 flex justify-end gap-2">
        <button
          onClick={() => { setStage('idle'); setTyped(''); setError(''); }}
          disabled={stage === 'submitting'}
          className="text-[11px] px-3 py-1.5 rounded-full"
          style={{
            background: '#FFFFFF',
            border: '1px solid var(--border-soft)',
            color: '#0A0A0A',
            cursor: stage === 'submitting' ? 'not-allowed' : 'pointer',
            fontWeight: 600,
          }}
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={stage === 'submitting' || typed.trim() !== employee.id}
          className="inline-flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded-full"
          style={{
            background: '#991B1B',
            color: '#FFFFFF',
            border: 'none',
            cursor: (stage === 'submitting' || typed.trim() !== employee.id) ? 'not-allowed' : 'pointer',
            opacity: (stage === 'submitting' || typed.trim() !== employee.id) ? 0.5 : 1,
            fontWeight: 700,
          }}
        >
          {stage === 'submitting'
            ? <><Loader2 className="w-3 h-3 animate-spin" /> Deleting…</>
            : <><Trash2 className="w-3 h-3" /> Permanently delete</>}
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────
   ADMIN-ONLY: reset any staff member's PIN.
   Calls the admin_reset_pin RPC which itself
   verifies the caller is_admin server-side.
   ───────────────────────────────────────────── */
function ResetPinSection({ employee }) {
  const [open, setOpen]       = useState(false);
  const [pin, setPin]         = useState('202600');
  const [busy, setBusy]       = useState(false);
  const [done, setDone]       = useState('');
  const [err,  setErr]        = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(''); setDone('');
    try {
      if (!pin || pin.length < 6) throw new Error('PIN must be at least 6 characters.');
      const { data, error } = await supabase.rpc('admin_reset_pin', {
        target_psn: employee.id, new_pin: pin
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || 'Unknown error');
      setDone(`PIN ${data.action === 'created' ? 'issued' : 'reset'} to ${pin}`);
    } catch (ex) {
      setErr(ex.message || String(ex));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-xl border p-4" style={{ borderColor:'var(--border-soft)', background:'#FFFFFF' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 opacity-60" />
          <div className="text-xs tracking-widest opacity-60 font-bold">ADMIN · RESET PIN</div>
        </div>
        {!open && (
          <button onClick={() => { setOpen(true); setDone(''); setErr(''); }}
            className="px-3 py-1.5 rounded-full text-xs font-semibold"
            style={{ background:'var(--ink)', color:'var(--paper)' }}>
            Reset PIN
          </button>
        )}
      </div>

      {open && (
        <form onSubmit={submit} className="mt-3 space-y-3">
          <div>
            <label className="block text-[10px] tracking-[0.2em] opacity-70 font-bold mb-1.5">NEW PIN</label>
            <input type="text" value={pin} onChange={e => setPin(e.target.value)}
              autoFocus disabled={busy} placeholder="At least 6 characters"
              className="w-full px-3 py-2.5 rounded-xl border text-sm font-mono bg-transparent"
              style={{ borderColor:'var(--border)' }} />
            <div className="flex gap-1.5 mt-2">
              {['202600','260026','123456'].map(p => (
                <button key={p} type="button" onClick={() => setPin(p)} disabled={busy}
                  className="text-[10px] tracking-wider px-2 py-1 rounded-md font-mono"
                  style={{ background:'rgba(15,40,24,0.06)' }}>
                  use {p}
                </button>
              ))}
            </div>
          </div>

          {err && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ background:'rgba(184,74,62,0.10)', color:'var(--clay)' }}>
              <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {err}
            </div>
          )}
          {done && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
              style={{ background:'rgba(45,95,63,0.10)', color:'var(--evergreen-500)' }}>
              <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" /> {done} — share this with {employee.name.split(' ')[0]}.
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button type="button" onClick={() => { setOpen(false); setErr(''); setDone(''); }} disabled={busy}
              className="px-3 py-1.5 rounded-full text-xs">
              Cancel
            </button>
            <button type="submit" disabled={busy}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-semibold"
              style={{ background: 'linear-gradient(135deg, #FF8A4D 0%, #FF4E6A 100%)', color:'#fff' }}>
              {busy && <Loader2 className="w-3 h-3 animate-spin" />}
              {busy ? 'Resetting…' : (done ? 'Done' : `Reset PIN for ${employee.id}`)}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

// ─── EditProfilePanel ────────────────────────────────────────────────────
// Inline editor for the most fix-prone employee fields. Visible only to
// admin + HR reviewer. Reasons Bashaier raised:
//   • Names sometimes arrive in mixed casing in the device export but
//     should be normalised in the directory
//   • Email addresses missing → can't send notices
//   • Wrong department assigned at onboarding → wrong shift cutoffs
//   • Manager not yet linked → CC list incomplete on emails
//
// Updates are written via directPatch on the 'employees' table. On
// success, onSaved(updatedEmployee) is called so the parent screen
// can refresh its cached directory without a full reload.
//
// Compact UX: a single Edit button reveals the form; Cancel reverts
// to the original values; Save persists. Disabled fields show why
// they're disabled (e.g. PSN can't be changed because it's the FK
// for everything else).
function EditProfilePanel({ employee, employees, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState('');
  const [done, setDone]       = useState(false);
  const [form, setForm] = useState({
    name:             employee.name              || '',
    email:            employee.email             || '',
    personal_email:   employee.personal_email    || '',
    department:       employee.department        || '',
    location:         employee.location          || '',
    manager_id:       employee.manager_id        || '',
    phone:            employee.phone             || '',
    iqama_id:         employee.iqama_id          || '',
    nationality_full: employee.nationality_full  || '',
    gender:           employee.gender            || '',
    join_date:        employee.join_date         || '',
  });

  // Reset form when modal swaps to a different employee
  React.useEffect(() => {
    setForm({
      name:             employee.name              || '',
      email:            employee.email             || '',
      personal_email:   employee.personal_email    || '',
      department:       employee.department        || '',
      location:         employee.location          || '',
      manager_id:       employee.manager_id        || '',
      phone:            employee.phone             || '',
      iqama_id:         employee.iqama_id          || '',
      nationality_full: employee.nationality_full  || '',
      gender:           employee.gender            || '',
      join_date:        employee.join_date         || '',
    });
    setEditing(false);
    setError('');
    setDone(false);
  }, [employee.id]);

  const departments = useMemo(() => {
    const set = new Set((employees || []).map(e => e.department).filter(Boolean));
    return Array.from(set).sort();
  }, [employees]);

  const managers = useMemo(() => {
    // Anyone in the directory can be a manager; surfaced sorted by name.
    return (employees || [])
      .filter(e => e.id !== employee.id) // can't be your own manager
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }, [employees, employee.id]);

  async function handleSave() {
    setBusy(true);
    setError('');
    setDone(false);
    try {
      // Build a minimal patch with only the changed fields. Empty-string
      // values get translated to null so the column is properly cleared
      // rather than being stored as '' (which fails some FK checks).
      const patch = {};
      const keys = [
        'name', 'email', 'personal_email', 'department', 'location',
        'manager_id', 'phone',
        'iqama_id', 'nationality_full', 'gender', 'join_date',
      ];
      keys.forEach(k => {
        const cur = String(employee[k] ?? '');
        const nxt = String(form[k] ?? '');
        if (cur !== nxt) patch[k] = nxt === '' ? null : nxt;
      });
      // Derive the legacy short nationality ('saudi' | 'expat') from
      // the full name so existing code keeps working.
      if ('nationality_full' in patch) {
        patch.nationality =
          (patch.nationality_full || '').toLowerCase() === 'saudi' ? 'saudi' : 'expat';
      }
      if (Object.keys(patch).length === 0) {
        setEditing(false);
        setBusy(false);
        return;
      }
      const updated = await directPatch('employees', 'id', employee.id, patch, { timeoutMs: 8000 });
      setDone(true);
      setEditing(false);
      // Notify parent so the in-memory list reflects the change. Some
      // call sites pass onSaved, others don't — guard.
      if (typeof onSaved === 'function') {
        const merged = { ...employee, ...patch };
        try { onSaved(merged); } catch (_) { /* parent decided not to refresh */ }
      }
    } catch (e) {
      setError(e?.message || 'Could not save changes.');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    // Read-only summary with an Edit button. Shows the same fields the
    // editor surfaces, so Bashaier sees what's editable at a glance.
    return (
      <div className="rounded-xl border"
           style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', padding: '10px 12px' }}>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div className="text-[10px] tracking-[0.22em]" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
            PROFILE
          </div>
          <button
            type="button"
            onClick={() => { setEditing(true); setDone(false); }}
            className="text-[10.5px] inline-flex items-center gap-1 px-2.5 py-1 rounded-full border"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A', fontWeight: 600 }}
          >
            <Pencil className="w-3 h-3"/> Edit
          </button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1.5 text-[11px]" style={{ color: '#0A0A0A' }}>
          <ProfileLine label="Name"        value={employee.name} />
          <ProfileLine
            label={(employee.nationality_full || employee.nationality || '').toLowerCase() === 'saudi' ? 'National ID' : 'Iqama ID'}
            value={employee.iqama_id} missing="—" />
          <ProfileLine label="Nationality" value={employee.nationality_full || (employee.nationality === 'saudi' ? 'Saudi' : '—')} missing="—" />
          <ProfileLine label="Gender"      value={employee.gender ? (employee.gender[0].toUpperCase() + employee.gender.slice(1)) : '—'} missing="—" />
          <ProfileLine label="Joining date" value={employee.join_date} missing="—" />
          <ProfileLine label="Department"  value={DEPT_FULL_NAMES[employee.department] || employee.department} />
          <ProfileLine label="Location"    value={LOCATION_LABELS[employee.location] || employee.location} />
          <ProfileLine label="Manager"     value={(employees || []).find(e => e.id === employee.manager_id)?.name || employee.manager_id} missing="—" />
          <ProfileLine label="Phone"       value={employee.phone} missing="—" />
          <ProfileLine label="Company email"  value={employee.email} missing="No email" />
          <ProfileLine label="Personal email" value={employee.personal_email} missing="—" />
        </div>
        {done && (
          <div className="mt-2 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px]"
               style={{ background: '#ECFDF5', color: '#047857', border: '1px solid #A7F3D0' }}>
            <CheckCircle2 className="w-3 h-3"/> Saved
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="rounded-xl border p-4"
         style={{ borderColor: 'var(--evergreen-500)', background: '#F0FDF4' }}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="text-xs tracking-widest" style={{ fontWeight: 700, color: '#047857' }}>
          EDIT PROFILE · {employee.id}
        </div>
        <div className="text-[10px] opacity-60" style={{ color: '#0A0A0A' }}>
          PSN / join date / nationality are not editable here
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Name">
          <input type="text" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}/>
        </Field>
        <Field label={(form.nationality_full || '').toLowerCase() === 'saudi' ? 'National ID' : 'Iqama / National ID'}>
          <input type="text" value={form.iqama_id} inputMode="numeric"
            onChange={e => setForm(f => ({ ...f, iqama_id: e.target.value.replace(/\D/g, '').slice(0, 10) }))}
            placeholder="10-digit ID"
            className="w-full px-3 py-2 rounded-md text-sm font-mono"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}/>
        </Field>
        <Field label="Nationality">
          <select value={form.nationality_full}
            onChange={e => setForm(f => ({ ...f, nationality_full: e.target.value }))}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}>
            <option value="">—</option>
            {['Saudi','Indian','Pakistani','Philippine','Sudanese','Egyptian','Palestine','Taiwanese','Bangladeshi','Yemeni','Jordanian','Syrian','Lebanese','Other'].map(n => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </Field>
        <Field label="Gender">
          <select value={form.gender}
            onChange={e => setForm(f => ({ ...f, gender: e.target.value }))}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}>
            <option value="">—</option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </Field>
        <Field label="Joining date">
          <input type="date" value={form.join_date || ''}
            onChange={e => setForm(f => ({ ...f, join_date: e.target.value }))}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}/>
        </Field>
        <Field label="Company email">
          <input type="email" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            placeholder="firstname.lastname@evergreen-shipping.com.sa"
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}/>
        </Field>
        <Field label="Personal email">
          <input type="email" value={form.personal_email}
            onChange={e => setForm(f => ({ ...f, personal_email: e.target.value }))}
            placeholder="personal@gmail.com"
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}/>
        </Field>
        <Field label="Department">
          <select value={form.department}
            onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}>
            <option value="">—</option>
            {departments.map(d => <option key={d} value={d}>{DEPT_FULL_NAMES[d] || d}</option>)}
          </select>
        </Field>
        <Field label="Location">
          <select value={form.location}
            onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}>
            <option value="">—</option>
            {Object.entries(LOCATION_LABELS).map(([code, label]) => (
              <option key={code} value={code}>{label}</option>
            ))}
          </select>
        </Field>
        <Field label="Manager">
          <select value={form.manager_id || ''}
            onChange={e => setForm(f => ({ ...f, manager_id: e.target.value }))}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}>
            <option value="">— (no manager)</option>
            {managers.map(m => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.id} · {m.department || ''}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Phone">
          <input type="tel" value={form.phone}
            onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
            placeholder="+966 5X XXX XXXX"
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}/>
        </Field>
      </div>

      {error && (
        <div className="mt-3 px-3 py-2 rounded-md text-xs flex items-start gap-2"
             style={{ background: '#FEE2E2', color: '#0A0A0A', border: '1px solid #FECACA' }}>
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"/> {error}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button type="button" onClick={() => { setEditing(false); setError(''); }}
          disabled={busy}
          className="text-xs px-4 py-2 rounded-full border disabled:opacity-50"
          style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A', background: '#FFFFFF' }}>
          Cancel
        </button>
        <button type="button" onClick={handleSave}
          disabled={busy}
          className="text-xs px-4 py-2 rounded-full inline-flex items-center gap-1.5 disabled:opacity-50"
          style={{ background: '#047857', color: '#FFFFFF', fontWeight: 600 }}>
          {busy ? <><Loader2 className="w-3 h-3 animate-spin"/> Saving…</> : <><Save className="w-3 h-3"/> Save changes</>}
        </button>
      </div>
    </div>
  );
}

function ProfileLine({ label, value, missing }) {
  const empty = !value;
  return (
    <div className="min-w-0">
      <div className="text-[9px] tracking-[0.16em] mb-0.5" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
        {label.toUpperCase()}
      </div>
      <div className="truncate" style={{ fontSize: 11.5, fontWeight: empty ? 400 : 600, color: empty ? '#B45309' : '#0A0A0A', lineHeight: 1.2 }}>
        {empty ? (missing || '—') : value}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-[10px] tracking-wider font-semibold block mb-1" style={{ color: '#0A0A0A' }}>
        {label.toUpperCase()}
      </span>
      {children}
    </label>
  );
}

// ─── MonthlyAttendancePanel ──────────────────────────────────────────────
// HR-only month picker + download button for the attendance summary
// .docx. Defaults to the previous calendar month (most common use
// case: Bashaier finalising last month's evaluation file). Lets her
// jump back up to 12 months for retrospective reports.
function MonthlyAttendancePanel({ employee, empMap, me }) {
  // Default month = previous calendar month (most common case)
  const defaultMonth = useMemo(() => {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return d.toISOString().slice(0, 7); // 'YYYY-MM'
  }, []);
  const [month, setMonth] = useState(defaultMonth);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState('');
  const [done, setDone]   = useState(null);

  async function handleDownload() {
    setBusy(true); setError(''); setDone(null);
    try {
      const result = await downloadMonthlyAttendanceReport({
        employee,
        empMap,
        monthStart: month + '-01',
        preparedBy: {
          name:    me?.is_hr_reviewer ? 'BASHAIER ALI' : (me?.name || 'HR'),
          title:   'HR Department',
          company: 'Evergreen Shipping Agency Saudi Co., (L.L.C)',
        },
      });
      setDone(result);
    } catch (e) {
      setError(e?.message || 'Could not generate the report.');
    } finally {
      setBusy(false);
    }
  }

  // Month options: last 12 months
  const monthOptions = useMemo(() => {
    const out = [];
    const d = new Date();
    d.setDate(1);
    for (let i = 0; i < 12; i++) {
      const v = d.toISOString().slice(0, 7);
      const label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      out.push({ value: v, label });
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  }, []);

  return (
    <div className="rounded-xl border p-4"
         style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div>
          <div className="text-xs tracking-widest opacity-60">MONTHLY ATTENDANCE REPORT</div>
          <div className="text-[11px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            Single-page .docx for the employee's HR file or evaluation handover.
          </div>
        </div>
        <FileText className="w-4 h-4 opacity-60" style={{ color: '#0A0A0A' }}/>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <select
          value={month}
          onChange={e => { setMonth(e.target.value); setDone(null); setError(''); }}
          className="text-xs px-3 py-2 rounded-md border"
          style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF', color: '#0A0A0A' }}>
          {monthOptions.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <button type="button" onClick={handleDownload} disabled={busy}
          className="text-xs px-4 py-2 rounded-full inline-flex items-center gap-1.5 disabled:opacity-50"
          style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 600 }}>
          {busy ? <><Loader2 className="w-3 h-3 animate-spin"/> Generating…</> : <><Download className="w-3 h-3"/> Generate report</>}
        </button>
      </div>

      {error && (
        <div className="mt-3 px-3 py-2 rounded-md text-xs flex items-start gap-2"
             style={{ background: '#FEE2E2', color: '#0A0A0A', border: '1px solid #FECACA' }}>
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"/> {error}
        </div>
      )}
      {done && (
        <div className="mt-3 px-3 py-2 rounded-md text-xs flex items-start gap-2"
             style={{
               background: done.overThreshold ? '#FEE2E2' : '#ECFDF5',
               color: '#0A0A0A',
               border: '1px solid ' + (done.overThreshold ? '#FECACA' : '#A7F3D0'),
             }}>
          <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"
            style={{ color: done.overThreshold ? '#991B1B' : '#047857' }}/>
          <span>
            <strong>Report downloaded.</strong> {done.rowCount} incident{done.rowCount === 1 ? '' : 's'} across {done.distinctDays} day{done.distinctDays === 1 ? '' : 's'}.
            {done.overThreshold && ' Above the 5-per-month review threshold — flagged in the report notes.'}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── GovernmentRecordsPanel ────────────────────────────────────────
//
// Displays the MOL/GOSI fields populated by the Government Data
// Sync flow: Arabic name, National ID, DOB, gender, official Arabic
// profession (المهنة), MOL join date, GOSI eligibility code,
// nationality (saudi vs expat).
//
// Renders nothing when the employee has no government data yet —
// keeps the modal compact for staff who haven't been synced. The
// panel uses the same visual idiom as the rest of the modal (boxed
// section with a label band on top).
//
// All values rendered as-is: Arabic fields keep their RTL direction
// and Arabic font, English fields are uppercase per HR convention.
function GovernmentRecordsPanel({ employee, onSaved }) {
  // ─── Per-employee MOL/GOSI pull ─────────────────────────────────
  // Bulk sync (the MOL · GOSI tab) handles the whole roster at once
  // but admin needs a per-employee fallback for two cases:
  //   • The employee was added to the portal AFTER the last bulk
  //     sync and never got their gov fields populated
  //   • A specific row failed to apply during the bulk sync (CHECK
  //     constraint, transient network blip) and admin wants to
  //     retry just that record
  // The button below loads the bundled MOL snapshot (which is the
  // committed copy of Jafar's most recent file), finds the best
  // matching subscriber for THIS employee using national_id first
  // (deterministic) then englishNameSimilarity, and offers to apply.
  const [pullState, setPullState] = useState('idle');
  // 'idle' | 'preview' | 'applying' | 'done' | 'error'
  const [pullMatch, setPullMatch] = useState(null);
  const [pullError, setPullError] = useState(null);

  const findMolMatch = async () => {
    setPullState('idle');
    setPullError(null);
    try {
      // Lazy-import the snapshot + matcher so the modal doesn't load
      // them upfront for every employee view.
      const [snapshotModule, syncLib] = await Promise.all([
        import('../data/molSnapshot.json'),
        import('../lib/molSync.js'),
      ]);
      const snapshot = snapshotModule.default || snapshotModule;
      const subs = snapshot.subscribers || [];

      // Phase 1 — National ID match (deterministic). If the employee
      // already has a national_id set (from a prior partial sync),
      // use it directly.
      let matched = null;
      let confidence = 0;
      let reason = '';
      if (employee.national_id) {
        matched = subs.find(s => String(s.national_id) === String(employee.national_id));
        if (matched) { confidence = 1.0; reason = 'National ID match'; }
      }

      // Phase 2 — Best-effort name match. Use canonical-vs-portal-name
      // similarity, same algorithm as the bulk sync.
      if (!matched) {
        let best = { sub: null, score: 0 };
        for (const s of subs) {
          if (!s.canonical_name) continue;
          const score = syncLib.englishNameSimilarity(s.canonical_name, employee.name || '');
          if (score > best.score) best = { sub: s, score };
        }
        if (best.sub && best.score >= 0.3) {
          matched = best.sub;
          confidence = best.score;
          reason = best.score >= 0.7 ? 'Name match' : 'Best-effort name match';
        }
      }

      if (matched) {
        setPullMatch({ sub: matched, confidence, reason });
        setPullState('preview');
      } else {
        setPullError(`No matching MOL/GOSI record found for ${employee.name}. Try the bulk sync tab to upload a fresh MOL file.`);
        setPullState('error');
      }
    } catch (e) {
      setPullError(String(e?.message || e));
      setPullState('error');
    }
  };

  const applyPull = async () => {
    if (!pullMatch?.sub) return;
    setPullState('applying');
    setPullError(null);
    try {
      const m = pullMatch.sub;
      const patch = {
        arabic_name:       m.arabic_name || null,
        national_id:       m.national_id || null,
        date_of_birth:     m.date_of_birth || null,
        gender:            m.gender || null,
        arabic_profession: m.arabic_profession || null,
        mol_join_date:     m.mol_join_date || null,
        gosi_eligibility:  m.gosi_eligibility || null,
        nationality:       m.nationality || null,
        mol_synced_at:     new Date().toISOString(),
      };
      // Overwrite the English name with the canonical transliteration —
      // matches what the bulk sync does. Per Nadeem: portal name should
      // appear the same as it does in GOSI's English form. Our
      // dictionary-driven transliteration is the closest source we have
      // to that since GOSI's English name field isn't exported in MOL.
      if (m.canonical_name) {
        patch.name = m.canonical_name;
      }
      const updated = await directPatch(
        'employees', 'id', employee.id, patch,
        { timeoutMs: 9000 }
      );
      // directPatch returns the updated row (or array of rows); merge
      // it into the modal's employee state via onSaved so the panel
      // refreshes immediately without closing.
      const newEmp = Array.isArray(updated) ? updated[0] : updated;
      if (onSaved && newEmp) {
        onSaved({ ...employee, ...newEmp });
      }
      setPullState('done');
      // Auto-collapse the preview after a short success display
      setTimeout(() => {
        setPullState('idle');
        setPullMatch(null);
      }, 1500);
    } catch (e) {
      setPullError(String(e?.message || e));
      setPullState('error');
    }
  };

  const hasAny =
    employee.arabic_name ||
    employee.national_id ||
    employee.date_of_birth ||
    employee.gender ||
    employee.arabic_profession ||
    employee.mol_join_date ||
    employee.gosi_eligibility ||
    (employee.nationality && employee.nationality !== 'expat');

  const fmt = (v) => v == null || v === '' ? '—' : v;
  // Timezone-safe date formatter. The naive "new Date('1982-01-01')"
  // approach parses ISO date strings as UTC midnight, which then
  // converts to the previous day in any timezone west of UTC. For a
  // pure DATE field (not a timestamp), we want to display exactly
  // what's stored — so split the YYYY-MM-DD string directly without
  // bouncing through Date arithmetic.
  const fmtDateLocal = (s) => {
    if (!s) return '—';
    const str = String(s).trim();
    // Match YYYY-MM-DD (or YYYY-MM-DD followed by anything — for
    // timestamptz strings we just take the date portion)
    const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
      const [, year, month, day] = m;
      const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const monIdx = parseInt(month, 10) - 1;
      if (monIdx >= 0 && monIdx < 12) {
        return `${day} ${monthNames[monIdx]} ${year}`;
      }
    }
    // Fallback for unexpected formats — use Date but in UTC so we
    // don't shift the displayed day.
    try {
      const d = new Date(str);
      if (isNaN(d)) return str;
      return d.toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
        timeZone: 'UTC',
      });
    } catch {
      return str;
    }
  };

  return (
    <section
      className="rounded-xl"
      style={{
        // Iqama / National-ID plastic-card visual treatment. A diagonal
        // mint-to-white-to-mint gradient suggests a glossy laminated
        // surface; an inset highlight along the top reinforces the
        // 'embossed plastic' feel; the warm green border matches the
        // colour family used on real Saudi ID cards. Position relative
        // so the absolutely-positioned MOI watermark below sits inside
        // the card; overflow hidden so it can't bleed past the rounded
        // corners.
        position: 'relative',
        overflow: 'hidden',
        background: 'linear-gradient(135deg, #ECFDF5 0%, #FFFFFF 35%, #FFFFFF 65%, #F0FAF4 100%)',
        border: '1px solid #A7F3D0',
        boxShadow: '0 0 0 3px rgba(15, 76, 42, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.9)',
        padding: '10px 12px',
      }}
    >
      {/* MOI watermark — actual KSA Ministry of Interior seal,
          bundled as an 8.6 KB anti-aliased palette PNG with
          transparent background. Centred behind the data fields
          at low opacity so it reads as an official-document
          watermark rather than as decoration.

          Sizing & opacity per Nadeem 2026-05-09: the previous
          240px @ 7% rendered too bold against the card. Reduced
          to 170px @ 4.5% — at this scale the wreath/palm/swords
          all stay visible but the whole seal sits like a faint
          ghost under the data instead of fighting it for
          attention. width:auto + maxHeight constrains the
          square logo by its longest side without distorting.

          pointer-events:none / draggable:false / userSelect:none
          guarantee the watermark never blocks clicks on Re-pull
          and can't be accidentally drag-selected or right-click
          saved off the card. */}
      <img
        src="/moi-seal.png"
        alt=""
        aria-hidden="true"
        draggable={false}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          transform: 'translate(-50%, -50%)',
          maxWidth: 170,
          maxHeight: 170,
          width: 'auto',
          height: 'auto',
          opacity: 0.045,
          pointerEvents: 'none',
          userSelect: 'none',
          zIndex: 0,
        }}
      />

      {/* All actual content sits above the watermark via z-index. */}
      <div style={{ position: 'relative', zIndex: 1 }}>
      <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
        <div className="text-[10px] tracking-[0.25em]" style={{ color: '#0F4C2A', fontWeight: 700 }}>
          GOVERNMENT RECORDS
          <span className="ml-2 px-1.5 py-0.5 rounded-full text-[8.5px]"
            style={{ background: '#E8F5E9', color: '#0F4C2A', letterSpacing: '0.04em' }}>
            MOL · GOSI
          </span>
        </div>
        {/* Per-employee Pull-from-MOL button. Always visible to admin/
            HR-reviewer (panel-level gate above the panel handles role).
            When fields are partially populated the button still works
            — re-pulls the latest snapshot for this employee. */}
        {pullState !== 'preview' && pullState !== 'applying' && (
          <button
            onClick={findMolMatch}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10.5px]"
            style={{
              background: hasAny ? '#FFFFFF' : '#0F4C2A',
              color: hasAny ? '#0F4C2A' : '#FFFFFF',
              border: hasAny ? '1px solid #A7F3D0' : 'none',
              fontWeight: 700,
              cursor: 'pointer',
              letterSpacing: '0.04em',
            }}
            title="Look up this employee in the MOL/GOSI snapshot and fill the government fields"
          >
            <FileText className="w-3 h-3" />
            {hasAny ? 'Re-pull from MOL · GOSI' : 'Pull from MOL · GOSI'}
          </button>
        )}
      </div>

      {/* Empty-state hint when nothing has been synced yet for this
          employee. Tells admin exactly what to do — click the button
          above. */}
      {!hasAny && pullState === 'idle' && (
        <div className="mb-3 p-3 rounded-lg text-[12px]"
          style={{ background: '#FFFBEB', border: '1px solid #FDE68A', color: '#854F0B' }}>
          No government data on file yet. Click <strong>Pull from MOL · GOSI</strong> above to fill the National ID, date of birth, profession, and GOSI registration from the latest MOL snapshot.
        </div>
      )}

      {/* Preview — admin reviews the matched MOL row before applying */}
      {pullState === 'preview' && pullMatch && (
        <div className="mb-3 p-3 rounded-lg text-[12px]"
          style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#1F1B16' }}>
          <div className="flex items-start justify-between gap-2 mb-2 flex-wrap">
            <div>
              <div style={{ fontWeight: 700, color: '#0F4C2A' }}>
                Found a {Math.round(pullMatch.confidence * 100)}% match in MOL · GOSI
              </div>
              <div className="text-[10.5px]" style={{ opacity: 0.7 }}>
                {pullMatch.reason}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setPullState('idle'); setPullMatch(null); }}
                className="px-2.5 py-1 rounded-full text-[10.5px]"
                style={{ background: '#FFFFFF', color: '#1F1B16', border: '1px solid #D4D4D4', cursor: 'pointer' }}
              >
                Cancel
              </button>
              <button
                onClick={applyPull}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[10.5px]"
                style={{ background: '#0F4C2A', color: '#FFFFFF', border: 'none', fontWeight: 700, cursor: 'pointer' }}
              >
                <Save className="w-3 h-3" />
                Apply to this employee
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
            <div>
              <span style={{ opacity: 0.7 }}>New name:</span>{' '}
              <strong>{pullMatch.sub.canonical_name || '—'}</strong>
              {pullMatch.sub.canonical_name && employee.name && pullMatch.sub.canonical_name !== employee.name && (
                <div style={{ opacity: 0.55, textDecoration: 'line-through', fontSize: 10 }}>
                  was: {employee.name}
                </div>
              )}
            </div>
            <div>
              <span style={{ opacity: 0.7 }}>National ID:</span>{' '}
              <strong className="font-mono">{pullMatch.sub.national_id || '—'}</strong>
            </div>
            <div className="col-span-2" style={{ direction: 'rtl', fontFamily: 'system-ui' }}>
              <span style={{ opacity: 0.7 }}>الاسم:</span>{' '}
              <strong>{pullMatch.sub.arabic_name || '—'}</strong>
            </div>
            <div>
              <span style={{ opacity: 0.7 }}>DOB:</span>{' '}
              <strong>{fmtDateLocal(pullMatch.sub.date_of_birth)}</strong>
            </div>
            <div>
              <span style={{ opacity: 0.7 }}>GOSI registration:</span>{' '}
              <strong>{fmtDateLocal(pullMatch.sub.mol_join_date)}</strong>
            </div>
          </div>
        </div>
      )}

      {pullState === 'applying' && (
        <div className="mb-3 p-3 rounded-lg flex items-center gap-2 text-[12px]"
          style={{ background: '#F0F9FF', border: '1px solid #BAE6FD', color: '#0C4A6E' }}>
          <Loader2 className="w-4 h-4 animate-spin" />
          Applying MOL · GOSI data…
        </div>
      )}

      {pullState === 'done' && (
        <div className="mb-3 p-3 rounded-lg flex items-center gap-2 text-[12px]"
          style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#0F4C2A' }}>
          <CheckCircle2 className="w-4 h-4" />
          Government records updated for {employee.name}.
        </div>
      )}

      {pullState === 'error' && pullError && (
        <div className="mb-3 p-3 rounded-lg flex items-start gap-2 text-[12px]"
          style={{ background: '#FEE2E2', border: '1px solid #FCA5A5', color: '#991B1B' }}>
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div className="flex-1">{pullError}</div>
          <button
            onClick={() => { setPullState('idle'); setPullError(null); }}
            className="text-[10.5px] underline"
            style={{ background: 'none', border: 'none', color: '#991B1B', cursor: 'pointer' }}
          >
            dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3 gap-y-2">
        {/* Row 1 — Arabic name (2 cols) · National ID (1) · Profession (1).
            Per Nadeem: shift National ID up next to the Arabic name
            (which leaves a gap of unused space without it), and put
            Profession in the slot after National ID. */}
        <div className="col-span-2">
          <div className="text-[9px] tracking-[0.16em] mb-0.5" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
            ARABIC NAME · الاسم
          </div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#1F1B16', fontFamily: 'system-ui', lineHeight: 1.2 }}>
            {employee.arabic_name || '—'}
          </div>
        </div>

        {/* National ID — slot to the right of the Arabic name */}
        <GovField label="NATIONAL ID · رقم الهوية" mono>
          {fmt(employee.national_id)}
        </GovField>

        {/* Profession — Arabic, RTL */}
        <div>
          <div className="text-[9px] tracking-[0.16em] mb-0.5" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
            PROFESSION · المهنة
          </div>
          <div style={{ fontSize: 12, color: '#1F1B16', fontFamily: 'system-ui', lineHeight: 1.2, fontWeight: 600 }}>
            {employee.arabic_profession || '—'}
          </div>
        </div>

        {/* Row 2 — starts with Gender, then Nationality, DOB, GOSI registration */}
        <GovField label="GENDER · الجنس">
          {employee.gender ? employee.gender.toUpperCase() : '—'}
        </GovField>

        <GovField label="NATIONALITY · الجنسية">
          {employee.nationality ? employee.nationality.toUpperCase() : '—'}
        </GovField>

        <GovField label="DATE OF BIRTH · تاريخ الميلاد">
          {fmtDateLocal(employee.date_of_birth)}
        </GovField>

        <GovField label="GOSI REGISTRATION · تاريخ الإلتحاق">
          {fmtDateLocal(employee.mol_join_date)}
        </GovField>
      </div>

      {/* Footer line — GOSI Eligibility (small, low-traffic field)
          and last-synced timestamp share the same line. Keeps the
          main grid to a clean two rows while preserving the data. */}
      {(employee.gosi_eligibility || employee.mol_synced_at) && (
        <div className="mt-2 pt-2 flex items-center justify-between gap-3 flex-wrap text-[9.5px]"
          style={{ borderTop: '1px solid var(--border-soft)', color: '#0A0A0A', opacity: 0.6 }}>
          {employee.gosi_eligibility ? (
            <span>
              <span style={{ fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', marginRight: 6 }}>
                GOSI ELIGIBILITY · الأهلية
              </span>
              <span className="font-mono" style={{ color: '#1F1B16', opacity: 0.85, fontWeight: 600 }}>
                {employee.gosi_eligibility}
              </span>
            </span>
          ) : <span/>}
          {employee.mol_synced_at && (
            <span>Last synced: {fmtDateLocal(employee.mol_synced_at)}</span>
          )}
        </div>
      )}
      </div>
    </section>
  );
}

// GovField — small labeled value cell used by GovernmentRecordsPanel.
// Named distinctly from the Field helper higher up in this file
// (which is used by EditProfilePanel for editable inputs).
function GovField({ label, mono, children }) {
  return (
    <div>
      <div className="text-[9px] tracking-[0.16em] mb-0.5" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
        {label}
      </div>
      <div className={mono ? 'font-mono tracking-wide' : ''}
        style={{ fontSize: 12, color: '#1F1B16', fontWeight: 600, lineHeight: 1.2 }}>
        {children}
      </div>
    </div>
  );
}
