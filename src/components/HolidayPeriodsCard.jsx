// ──────────────────────────────────────────────────────────────────────
//  HolidayPeriodsCard — HR-managed holiday windows
//
//  Bashaier defines each Eid Al Adha, Eid Al Fitr, National Day etc.
//  here. Each row becomes a holiday_periods record that managers can
//  attach holiday_shifts to via the Holiday Shifts tab.
//
//  Phase 2 of the holiday-OT module. Pure CRUD — no shift assignment
//  happens at this surface (that's Phase 3).
//
//  Nadeem 2026-05-21.
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useEffect } from 'react';
import { directGet, directPost, directPatch } from '../supabaseClient.js';
import { CalendarDays, Plus, Save, Loader2, Trash2, AlertCircle, CheckCircle2, X, Edit3 } from 'lucide-react';

export default function HolidayPeriodsCard({ me }) {
  const [periods, setPeriods] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState(null);  // row being edited
  const [shiftCounts, setShiftCounts] = useState({}); // period_id → count

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const rows = await directGet('holiday_periods',
        'select=*&order=start_date.desc', { timeoutMs: 10000 });
      setPeriods(rows || []);
      // For each period, get the count of attached shifts — helps
      // Bashaier see whether deleting will affect existing nominations.
      const counts = {};
      for (const p of (rows || [])) {
        try {
          const s = await directGet('holiday_shifts',
            `select=id&holiday_period_id=eq.${p.id}&limit=1000`,
            { timeoutMs: 6000 });
          counts[p.id] = (s || []).length;
        } catch (_) { counts[p.id] = 0; }
      }
      setShiftCounts(counts);
    } catch (e) {
      setErr(e?.message || 'Failed to load holiday periods');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="rounded-xl border bg-white" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
      <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
        <div className="flex items-center gap-2">
          <CalendarDays size={16} style={{ color: '#0F4C2A' }} />
          <div>
            <h3 className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
              Holiday periods
            </h3>
            <p className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
              Define each Eid / National Day window — managers nominate staff against these.
            </p>
          </div>
        </div>
        {!showForm && !editing && (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded text-white"
            style={{ background: '#0F4C2A' }}>
            <Plus size={12} /> New period
          </button>
        )}
      </div>

      {/* Inline create / edit form */}
      {(showForm || editing) && (
        <HolidayPeriodForm
          initial={editing}
          me={me}
          onCancel={() => { setShowForm(false); setEditing(null); }}
          onSaved={() => { setShowForm(false); setEditing(null); load(); }}
        />
      )}

      {/* Body */}
      <div className="p-4">
        {loading ? (
          <div className="flex items-center gap-2 text-xs" style={{ color: '#1F1B16', opacity: 0.7 }}>
            <Loader2 size={12} className="animate-spin" /> Loading…
          </div>
        ) : err ? (
          <div className="flex items-center gap-2 text-xs rounded px-3 py-2"
               style={{ background: '#FEF2F2', color: '#991B1B' }}>
            <AlertCircle size={12} /> {err}
          </div>
        ) : periods.length === 0 ? (
          <div className="text-center py-6">
            <p className="text-sm" style={{ color: '#1F1B16', opacity: 0.7 }}>
              No holiday periods yet.
            </p>
            <p className="text-xs mt-1" style={{ color: '#1F1B16', opacity: 0.5 }}>
              Create one to start nominating staff for OT shifts.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {periods.map(p => (
              <PeriodRow
                key={p.id}
                period={p}
                shiftCount={shiftCounts[p.id] || 0}
                onEdit={() => setEditing(p)}
                onToggleActive={async () => {
                  try {
                    await directPatch('holiday_periods', 'id', p.id,
                      { is_active: !p.is_active });
                    load();
                  } catch (e) { setErr(e?.message || 'Toggle failed'); }
                }}
                onDelete={async () => {
                  const n = shiftCounts[p.id] || 0;
                  const msg = n > 0
                    ? `Delete "${p.name}" and its ${n} attached shift(s)? Cannot be undone.`
                    : `Delete "${p.name}"? Cannot be undone.`;
                  if (!confirm(msg)) return;
                  try {
                    await fetch(
                      `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/holiday_periods?id=eq.${p.id}`,
                      {
                        method: 'DELETE',
                        headers: {
                          apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
                          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
                        },
                      });
                    load();
                  } catch (e) { setErr(e?.message || 'Delete failed'); }
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}


// ── PeriodRow ─────────────────────────────────────────────────────────
function PeriodRow({ period, shiftCount, onEdit, onToggleActive, onDelete }) {
  const fmt = (d) => new Date(d).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
  const days = Math.floor(
    (new Date(period.end_date) - new Date(period.start_date)) / 86400000
  ) + 1;
  return (
    <div className="flex items-center justify-between gap-3 rounded border p-3"
         style={{
           borderColor: 'rgba(0,0,0,0.08)',
           background: period.is_active ? '#FFFFFF' : '#FAFAF6',
           opacity:    period.is_active ? 1 : 0.7,
         }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <h4 className="text-sm font-semibold truncate" style={{ color: '#1F1B16' }}>
            {period.name}
          </h4>
          {!period.is_active && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                  style={{ background: '#E5E7EB', color: '#374151', letterSpacing: '0.05em' }}>
              INACTIVE
            </span>
          )}
          {shiftCount > 0 && (
            <span className="text-[9px] px-1.5 py-0.5 rounded font-bold"
                  style={{ background: '#DBEAFE', color: '#1D4ED8' }}>
              {shiftCount} {shiftCount === 1 ? 'shift' : 'shifts'}
            </span>
          )}
        </div>
        <p className="text-xs mt-0.5" style={{ color: '#1F1B16', opacity: 0.65 }}>
          {fmt(period.start_date)} → {fmt(period.end_date)}  ·  {days} {days === 1 ? 'day' : 'days'}
        </p>
        {period.notes && (
          <p className="text-[11px] mt-1 italic" style={{ color: '#1F1B16', opacity: 0.55 }}>
            {period.notes}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={onToggleActive}
          className="text-[10px] px-2 py-1 rounded font-semibold"
          style={{
            background: period.is_active ? '#FEF3C7' : '#D1FAE5',
            color:      period.is_active ? '#854F0B' : '#065F46',
          }}
          title={period.is_active ? 'Make inactive (managers cannot add new shifts)' : 'Make active'}>
          {period.is_active ? 'Active' : 'Activate'}
        </button>
        <button onClick={onEdit}
          className="p-1.5 rounded hover:bg-black/[0.05]"
          title="Edit">
          <Edit3 size={12} style={{ color: '#1F1B16', opacity: 0.6 }} />
        </button>
        <button onClick={onDelete}
          className="p-1.5 rounded hover:bg-red-50"
          title="Delete">
          <Trash2 size={12} style={{ color: '#B84A3E' }} />
        </button>
      </div>
    </div>
  );
}


// ── HolidayPeriodForm — used for both create + edit ───────────────────
function HolidayPeriodForm({ initial, me, onCancel, onSaved }) {
  const [name, setName]           = useState(initial?.name || '');
  const [startDate, setStartDate] = useState(initial?.start_date || '');
  const [endDate, setEndDate]     = useState(initial?.end_date || '');
  const [notes, setNotes]         = useState(initial?.notes || '');
  const [busy, setBusy]           = useState(false);
  const [err, setErr]             = useState(null);

  const isEdit = Boolean(initial?.id);
  const canSave = name.trim() && startDate && endDate && !busy
               && new Date(endDate) >= new Date(startDate);

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setErr(null);
    try {
      const payload = {
        name: name.trim(),
        start_date: startDate,
        end_date:   endDate,
        notes: notes.trim() || null,
        is_active: initial?.is_active ?? true,
      };
      if (isEdit) {
        await directPatch('holiday_periods', 'id', initial.id, payload);
      } else {
        await directPost('holiday_periods', {
          ...payload,
          created_by: me?.id || null,
        });
      }
      onSaved?.();
    } catch (e) {
      setErr(e?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-4 border-b space-y-3"
         style={{ background: '#FFFBEB', borderColor: 'rgba(0,0,0,0.08)' }}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: '#92400E' }}>
          {isEdit ? 'Edit period' : 'New holiday period'}
        </h4>
        <button onClick={onCancel} className="p-1 rounded hover:bg-black/[0.05]"
                title="Cancel">
          <X size={14} style={{ color: '#1F1B16', opacity: 0.6 }} />
        </button>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
          Name
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Eid Al Adha 2026"
          className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Start date
          </label>
          <input type="date" value={startDate}
                 onChange={(e) => setStartDate(e.target.value)}
                 className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            End date
          </label>
          <input type="date" value={endDate}
                 onChange={(e) => setEndDate(e.target.value)}
                 min={startDate}
                 className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none" />
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
          Notes <span style={{ opacity: 0.6 }}>(optional)</span>
        </label>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. Confirmed via lunar calendar"
          className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none"
        />
      </div>

      {err && (
        <div className="flex items-center gap-2 text-xs rounded px-3 py-2"
             style={{ background: '#FEF2F2', color: '#991B1B' }}>
          <AlertCircle size={12} /> {err}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel}
          className="px-3 py-1.5 text-xs rounded border"
          style={{ borderColor: 'rgba(0,0,0,0.15)', color: '#1F1B16' }}>
          Cancel
        </button>
        <button onClick={save} disabled={!canSave}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded text-white disabled:opacity-50"
          style={{ background: '#0F4C2A' }}>
          {busy ? <Loader2 size={11} className="animate-spin" /> : isEdit ? <Save size={11} /> : <CheckCircle2 size={11} />}
          {busy ? 'Saving…' : isEdit ? 'Update period' : 'Create period'}
        </button>
      </div>
    </div>
  );
}
