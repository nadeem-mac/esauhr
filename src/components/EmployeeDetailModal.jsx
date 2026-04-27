import React, { useMemo, useState } from 'react';
import { X, Building2, MapPin, Calendar, Briefcase, KeyRound, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
import { Avatar, Pill } from './Dashboard.jsx';
import { supabase } from '../supabaseClient.js';
import {
  calculateBalance, fmtDate, fmtDateShort, yearsOfService, monthsOfService, LOCATION_LABELS,
} from '../lib/leaveLogic.js';

export default function EmployeeDetailModal({ employee, leaveTypes, requests, balances, typeMap, me, onClose }) {
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
          <div>
            <div className="text-xs tracking-widest opacity-60 mb-3">LEAVE BALANCES · {year}</div>
            <div className="grid sm:grid-cols-2 gap-3">
              {balByType.map(({ type, balance }) => {
                const total = balance.total || 0;
                const used = balance.used + balance.pending;
                const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
                return (
                  <div key={type.id} className="rounded-xl border p-4"
                       style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
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
                   style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
                <Briefcase className="w-5 h-5 mx-auto mb-2"/>
                No leave records yet.
              </div>
            ) : (
              <ul className="rounded-xl border divide-y"
                  style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
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
    <div className="rounded-xl border p-4" style={{ borderColor:'var(--border-soft)', background:'#FFFDF7' }}>
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
