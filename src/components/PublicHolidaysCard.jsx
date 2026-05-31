// ──────────────────────────────────────────────────────────────────────
//  PublicHolidaysCard — admin-managed official holiday DATES
//
//  Writes the `public_holidays` table (date + name). These are the
//  dates the Monthly Attendance grid tints, the coverage check treats
//  as non-working, and the leave engine excludes from working-day
//  counts.
//
//  This is deliberately MANUAL: KSA's Eid dates are moon-sighting /
//  official-announcement based and can't be auto-generated reliably.
//  Management announces the dates; HR enters them here and they take
//  effect immediately (the grid reads this table directly).
//
//  Distinct from HolidayPeriodsCard, which manages `holiday_periods`
//  (the Eid / National Day WINDOWS used for OT shift nominations).
//
//  Nadeem 2026-05-31.
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from 'react';
import { directGet, directPost, directPatch, directDelete } from '../supabaseClient.js';
import { CalendarDays, Plus, Save, Loader2, Trash2, AlertCircle, CheckCircle2, X, Edit3 } from 'lucide-react';

const GREEN = '#0F4C2A';

function fmtLong(dateStr) {
  try {
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return dateStr; }
}

export default function PublicHolidaysCard({ me }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);   // row being edited
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const data = await directGet('public_holidays',
        'select=*&order=date.desc', { timeoutMs: 10000 });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e?.message || 'Failed to load public holidays');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const resetForm = () => { setShowForm(false); setEditing(null); setDate(''); setName(''); };

  const startAdd = () => { setEditing(null); setDate(''); setName(''); setShowForm(true); setOk(null); setErr(null); };
  const startEdit = (r) => { setEditing(r); setDate(String(r.date).slice(0, 10)); setName(r.name || ''); setShowForm(true); setOk(null); setErr(null); };

  const save = async () => {
    if (!date) { setErr('Please pick a date.'); return; }
    if (!name.trim()) { setErr('Please enter a holiday name.'); return; }
    setSaving(true); setErr(null); setOk(null);
    try {
      const payload = { date, name: name.trim() };
      if (editing) {
        await directPatch('public_holidays', 'id', editing.id, payload, { timeoutMs: 10000 });
        setOk('Holiday updated.');
      } else {
        await directPost('public_holidays', payload, { timeoutMs: 10000 });
        setOk('Holiday added.');
      }
      resetForm();
      await load();
    } catch (e) {
      const msg = String(e?.message || e);
      // A unique-violation on date means it already exists.
      if (/duplicate|unique|23505/i.test(msg)) setErr('A holiday already exists on that date — edit the existing one instead.');
      else setErr(msg || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete "${r.name}" on ${fmtLong(String(r.date).slice(0, 10))}? Attendance columns for this date will go back to a normal working day.`)) return;
    setBusyId(r.id); setErr(null); setOk(null);
    try {
      await directDelete('public_holidays', `id=eq.${r.id}`, { timeoutMs: 10000 });
      setOk('Holiday removed.');
      await load();
    } catch (e) {
      setErr(e?.message || 'Delete failed');
    } finally {
      setBusyId(null);
    }
  };

  // Convenience: the two FIXED Gregorian KSA holidays for a given year.
  // (Eid is moon-based — entered manually.)
  const quickAddFixed = async () => {
    const yr = new Date().getFullYear();
    const input = window.prompt('Add the two fixed KSA national holidays (Founding Day 22 Feb, National Day 23 Sep) for which year?', String(yr));
    if (!input) return;
    const y = parseInt(input, 10);
    if (!y || y < 2024 || y > 2099) { setErr('Please enter a valid year.'); return; }
    setSaving(true); setErr(null); setOk(null);
    let added = 0;
    for (const h of [{ date: `${y}-02-22`, name: 'Founding Day' }, { date: `${y}-09-23`, name: 'Saudi National Day' }]) {
      try { await directPost('public_holidays', h, { timeoutMs: 8000 }); added++; }
      catch { /* likely already present — skip */ }
    }
    setOk(added ? `Added ${added} fixed holiday${added > 1 ? 's' : ''} for ${y}.` : `Those holidays already exist for ${y}.`);
    setSaving(false);
    await load();
  };

  return (
    <div className="rounded-xl border bg-white" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
        <div className="flex items-center gap-2">
          <CalendarDays size={16} style={{ color: GREEN }} />
          <div>
            <h3 className="text-sm font-semibold" style={{ color: '#1F1B16' }}>Public holidays</h3>
            <p className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.65 }}>
              Official holiday dates announced by Management. Tints the attendance grid and is excluded from working-day counts.
            </p>
          </div>
        </div>
        {!showForm && (
          <div className="flex items-center gap-2">
            <button onClick={quickAddFixed} disabled={saving}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-full"
              style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#1F1B16', cursor: 'pointer', fontWeight: 600 }}
              title="Add the two fixed Gregorian KSA holidays (Founding Day, National Day) for a year">
              + Fixed KSA dates
            </button>
            <button onClick={startAdd}
              className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1.5 rounded-full"
              style={{ border: `1px solid ${GREEN}`, background: GREEN, color: '#FFFFFF', cursor: 'pointer', fontWeight: 700 }}>
              <Plus size={13} /> Add holiday
            </button>
          </div>
        )}
      </div>

      <div className="p-4">
        {err && (
          <div className="flex items-start gap-2 text-[12px] mb-3 px-3 py-2 rounded" style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B' }}>
            <AlertCircle size={14} style={{ marginTop: 1, flex: '0 0 auto' }} /> <span>{err}</span>
          </div>
        )}
        {ok && (
          <div className="flex items-center gap-2 text-[12px] mb-3 px-3 py-2 rounded" style={{ background: '#ECFDF5', border: '1px solid #A7F3D0', color: '#065F46' }}>
            <CheckCircle2 size={14} /> <span>{ok}</span>
          </div>
        )}

        {showForm && (
          <div className="mb-4 p-3 rounded-lg" style={{ background: '#FAFAF9', border: '1px solid rgba(0,0,0,0.08)' }}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-[12px] font-semibold" style={{ color: '#1F1B16' }}>{editing ? 'Edit holiday' : 'New holiday'}</div>
              <button onClick={resetForm} className="p-1 rounded" style={{ cursor: 'pointer' }} title="Cancel"><X size={14} style={{ color: '#1F1B16' }} /></button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-2">
              <div>
                <label className="block text-[10px] mb-1" style={{ color: '#1F1B16', fontWeight: 700, letterSpacing: '0.04em' }}>DATE</label>
                <input type="date" value={date} onChange={e => setDate(e.target.value)}
                  className="w-full text-[13px] px-2 py-1.5 rounded" style={{ border: '1px solid #D4D4D4', color: '#0A0A0A' }} />
              </div>
              <div>
                <label className="block text-[10px] mb-1" style={{ color: '#1F1B16', fontWeight: 700, letterSpacing: '0.04em' }}>NAME</label>
                <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Eid Al Adha, Saudi National Day"
                  className="w-full text-[13px] px-2 py-1.5 rounded" style={{ border: '1px solid #D4D4D4', color: '#0A0A0A' }} />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-3">
              <button onClick={resetForm} className="text-[12px] px-3 py-1.5 rounded" style={{ border: '1px solid #D4D4D4', background: '#FFFFFF', color: '#1F1B16', cursor: 'pointer' }}>Cancel</button>
              <button onClick={save} disabled={saving}
                className="inline-flex items-center gap-1 text-[12px] px-3 py-1.5 rounded disabled:opacity-50"
                style={{ border: `1px solid ${GREEN}`, background: GREEN, color: '#FFFFFF', cursor: 'pointer', fontWeight: 700 }}>
                {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} {editing ? 'Save changes' : 'Add holiday'}
              </button>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 text-[12px] py-6 justify-center" style={{ color: '#1F1B16', opacity: 0.7 }}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center py-6 text-[12px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
            No public holidays configured yet. Add the dates Management has announced.
          </div>
        ) : (
          <div className="space-y-1.5">
            {rows.map(r => {
              const ds = String(r.date).slice(0, 10);
              const past = ds < new Date().toISOString().slice(0, 10);
              return (
                <div key={r.id} className="flex items-center justify-between px-3 py-2 rounded"
                  style={{ border: '1px solid rgba(0,0,0,0.08)', background: past ? '#FAFAFA' : '#F5F3FF', opacity: past ? 0.7 : 1 }}>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold truncate" style={{ color: '#0A0A0A' }}>{r.name}</div>
                    <div className="text-[11px]" style={{ color: '#1F1B16' }}>{fmtLong(ds)}{past ? ' · past' : ''}</div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => startEdit(r)} className="p-1.5 rounded" style={{ cursor: 'pointer' }} title="Edit"><Edit3 size={14} style={{ color: GREEN }} /></button>
                    <button onClick={() => remove(r)} disabled={busyId === r.id} className="p-1.5 rounded disabled:opacity-50" style={{ cursor: 'pointer' }} title="Delete">
                      {busyId === r.id ? <Loader2 size={14} className="animate-spin" style={{ color: '#991B1B' }} /> : <Trash2 size={14} style={{ color: '#991B1B' }} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
