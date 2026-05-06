import React, { useMemo, useState } from 'react';
import { X, Building2, MapPin, Calendar, Briefcase, KeyRound, Loader2, CheckCircle2, AlertCircle, Pencil, Save, FileText, Download, Mail, Phone, UserCheck } from 'lucide-react';
import { Avatar, Pill } from './Dashboard.jsx';
import { supabase, directPatch } from '../supabaseClient.js';
import {
  calculateBalance, fmtDate, fmtDateShort, yearsOfService, monthsOfService, LOCATION_LABELS,
} from '../lib/leaveLogic.js';
import { downloadMonthlyAttendanceReport } from '../lib/monthlyAttendanceReport.js';

export default function EmployeeDetailModal({ employee, leaveTypes, requests, balances, typeMap, me, employees = [], empMap = {}, onSaved, onClose }) {
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
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
         style={{ background: 'rgba(15, 31, 26, 0.4)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="rounded-t-2xl sm:rounded-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto fade-in"
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
            <div className="flex items-center gap-1 flex-shrink-0">
              {canResetPin && (
                <button
                  onClick={() => setPinOpen(v => !v)}
                  className="px-2 py-1.5 rounded-full text-[12px] hover:bg-black/5"
                  style={{ color: pinOpen ? '#0F4C2A' : '#1F1B16', fontWeight: 600, lineHeight: 1 }}
                  title="Reset PIN for this employee"
                  aria-label="Reset PIN"
                >
                  🔑
                </button>
              )}
              <button onClick={onClose} className="p-1.5 rounded-full hover:bg-black/5">
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
            <div className="text-[10px] tracking-[0.22em] mb-2" style={{ color: '#0A0A0A', fontWeight: 700, opacity: 0.7 }}>
              LEAVE BALANCES · {year}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
              {balByType.map(({ type, balance }) => {
                const total = balance.total || 0;
                const exhausted = balance.available <= 0 && total > 0;
                const unlimited = type.accrual_method === 'unlimited' || (!total && balance.available === 0 && balance.used === 0);
                return (
                  <div
                    key={type.id}
                    className="rounded-lg overflow-hidden relative"
                    style={{
                      background: '#FAFAF6',
                      padding: '8px 10px 8px',
                      paddingTop: 10,
                    }}
                    title={`${balance.used} used · ${balance.pending} pending · ${balance.available} available${balance.accrualNote ? ' · ' + balance.accrualNote : ''}`}
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
                        fontSize: 10,
                        color: '#0A0A0A',
                        fontWeight: 600,
                        opacity: 0.8,
                        marginBottom: 3,
                      }}
                    >
                      {type.name}
                    </div>
                    {/* Number — big available + small /total */}
                    <div className="flex items-baseline gap-0.5 font-mono" style={{ lineHeight: 1 }}>
                      <span style={{
                        fontSize: 18, fontWeight: 700,
                        color: exhausted ? 'var(--clay)' : '#1F1B16',
                      }}>
                        {unlimited ? '∞' : balance.available}
                      </span>
                      {!unlimited && (
                        <span style={{ fontSize: 11, color: '#0A0A0A', opacity: 0.5, fontWeight: 400 }}>
                          /{balance.total || 0}
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
        </div>
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
    name:          employee.name        || '',
    email:         employee.email       || '',
    department:    employee.department  || '',
    location:      employee.location    || '',
    manager_id:    employee.manager_id  || '',
    phone:         employee.phone       || '',
  });

  // Reset form when modal swaps to a different employee
  React.useEffect(() => {
    setForm({
      name:       employee.name       || '',
      email:      employee.email      || '',
      department: employee.department || '',
      location:   employee.location   || '',
      manager_id: employee.manager_id || '',
      phone:      employee.phone      || '',
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
      const keys = ['name', 'email', 'department', 'location', 'manager_id', 'phone'];
      keys.forEach(k => {
        const cur = String(employee[k] ?? '');
        const nxt = String(form[k] ?? '');
        if (cur !== nxt) patch[k] = nxt === '' ? null : nxt;
      });
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
          <ProfileLine label="Email"       value={employee.email} missing="No email" />
          <ProfileLine label="Phone"       value={employee.phone} missing="—" />
          <ProfileLine label="Department"  value={employee.department} />
          <ProfileLine label="Location"    value={LOCATION_LABELS[employee.location] || employee.location} />
          <ProfileLine label="Manager"     value={(employees || []).find(e => e.id === employee.manager_id)?.name || employee.manager_id} missing="—" />
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
        <Field label="Email">
          <input type="email" value={form.email}
            onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
            placeholder="firstname.lastname@evergreen-shipping.com.sa"
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}/>
        </Field>
        <Field label="Department">
          <select value={form.department}
            onChange={e => setForm(f => ({ ...f, department: e.target.value }))}
            className="w-full px-3 py-2 rounded-md text-sm"
            style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}>
            <option value="">—</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
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
  const fmtDateLocal = (s) => {
    if (!s) return '—';
    try {
      const d = new Date(s);
      if (isNaN(d)) return s;
      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch {
      return s;
    }
  };

  return (
    <section
      className="rounded-xl"
      style={{
        background: '#FFFFFF',
        // Evergreen-themed green border to visually mark this as the
        // government-data section (mirrors the green MOL · GOSI pill).
        // Slightly heavier than var(--border-soft) so the panel reads
        // as a deliberate accent rather than a flat divider.
        border: '1px solid #A7F3D0',
        boxShadow: '0 0 0 3px rgba(15, 76, 42, 0.04)',
        padding: '10px 12px',
      }}
    >
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
