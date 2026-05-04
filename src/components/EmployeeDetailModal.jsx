import React, { useMemo, useState } from 'react';
import { X, Building2, MapPin, Calendar, Briefcase, KeyRound, Loader2, CheckCircle2, AlertCircle, Pencil, Save, FileText, Download } from 'lucide-react';
import { Avatar, Pill } from './Dashboard.jsx';
import { supabase, directPatch } from '../supabaseClient.js';
import {
  calculateBalance, fmtDate, fmtDateShort, yearsOfService, monthsOfService, LOCATION_LABELS,
} from '../lib/leaveLogic.js';
import { downloadMonthlyAttendanceReport } from '../lib/monthlyAttendanceReport.js';

export default function EmployeeDetailModal({ employee, leaveTypes, requests, balances, typeMap, me, employees = [], empMap = {}, onSaved, onClose }) {
  const year = new Date().getFullYear();

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

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4"
         style={{ background: 'rgba(15, 31, 26, 0.4)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        className="rounded-t-2xl sm:rounded-2xl w-full max-w-3xl max-h-[92vh] overflow-y-auto fade-in"
        style={{ background: 'var(--paper)' }}>
        <div className="sticky top-0 z-10 flex items-center justify-between p-5 border-b backdrop-blur"
             style={{ borderColor: 'var(--border-soft)', background: 'rgba(250, 247, 240, 0.95)' }}>
          <div className="flex items-center gap-4 min-w-0">
            <Avatar id={employee.id} name={employee.name} size="xl"/>
            <div className="min-w-0">
              <div className="text-[10px] tracking-[0.25em] opacity-50 mono">{employee.id}</div>
              <h2 className="serif text-2xl truncate" style={{ fontWeight: 500, letterSpacing: '-0.01em' }}>{employee.name}</h2>
              <div className="text-xs opacity-60 flex flex-wrap items-center gap-3 mt-1">
                <span className="flex items-center gap-1"><Building2 className="w-3 h-3"/>{employee.department}</span>
                <span className="flex items-center gap-1"><MapPin className="w-3 h-3"/>{LOCATION_LABELS[employee.location] || employee.location}</span>
                {employee.join_date && (
                  <span className="flex items-center gap-1">
                    <Calendar className="w-3 h-3"/>
                    Joined {fmtDate(employee.join_date)} · {yos}y {mos}m
                  </span>
                )}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-black/5 flex-shrink-0">
            <X className="w-5 h-5"/>
          </button>
        </div>

        <div className="p-5 space-y-6">
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

          {/* Monthly attendance summary — HR-only download. Bashaier
              picks a month and gets a single-page .docx for the
              employee's HR file or for evaluation handover. Reads
              from attendance_violations directly so it always
              reflects the current record. */}
          {(me?.is_admin || me?.is_hr_reviewer) && employee?.id && (
            <MonthlyAttendancePanel employee={employee} empMap={empMap} me={me} />
          )}

          <div>
            <div className="text-xs tracking-widest opacity-60 mb-3">LEAVE BALANCES · {year}</div>
            <div className="grid sm:grid-cols-2 gap-3">
              {balByType.map(({ type, balance }) => {
                const total = balance.total || 0;
                const used = balance.used + balance.pending;
                const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
                return (
                  <div key={type.id} className="rounded-xl border p-4"
                       style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
                    <div className="flex items-center justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-2 h-2 rounded-full" style={{ background: type.color }}/>
                        <div className="text-sm" style={{ fontWeight: 500 }}>{type.name}</div>
                      </div>
                      <Pill color={type.color}>{balance.available} left</Pill>
                    </div>
                    {total > 0 && (
                      <div className="h-1.5 rounded-full overflow-hidden mb-2" style={{ background: 'var(--border-soft)' }}>
                        <div className="h-full" style={{
                          width: `${pct}%`,
                          background: pct > 80 ? 'var(--clay)' : type.color,
                        }}/>
                      </div>
                    )}
                    <div className="grid grid-cols-3 gap-1 text-[11px] opacity-70">
                      <div>Entitled: <strong>{balance.total}</strong></div>
                      <div>Used: <strong>{balance.used}</strong></div>
                      <div>Pending: <strong>{balance.pending}</strong></div>
                    </div>
                    {balance.accrualNote && <div className="text-[10px] opacity-50 mt-1">{balance.accrualNote}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <div className="text-xs tracking-widest opacity-60 mb-3">LEAVE HISTORY</div>
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

          {(me?.is_admin || me?.can_reset_pins) && employee?.id && (
            <ResetPinSection employee={employee} />
          )}
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
      <div className="rounded-xl border p-4"
           style={{ borderColor: 'var(--border-soft)', background: '#FFFFFF' }}>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="text-xs tracking-widest opacity-60">PROFILE</div>
          <button
            type="button"
            onClick={() => { setEditing(true); setDone(false); }}
            className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border"
            style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A' }}
          >
            <Pencil className="w-3 h-3"/> Edit
          </button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-xs" style={{ color: '#0A0A0A' }}>
          <ProfileLine label="Name"        value={employee.name} />
          <ProfileLine label="Email"       value={employee.email} missing="No email on file" />
          <ProfileLine label="Department"  value={employee.department} />
          <ProfileLine label="Location"    value={LOCATION_LABELS[employee.location] || employee.location} />
          <ProfileLine label="Manager"     value={(employees || []).find(e => e.id === employee.manager_id)?.name || employee.manager_id} missing="No manager linked" />
          <ProfileLine label="Phone"       value={employee.phone} missing="—" />
        </div>
        {done && (
          <div className="mt-3 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px]"
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
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="text-[10px] tracking-wider font-semibold opacity-70">{label.toUpperCase()}</span>
      <span style={{ fontWeight: empty ? 400 : 600, color: empty ? '#B45309' : '#0A0A0A' }}>
        {empty ? (missing || '—') : value}
      </span>
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
