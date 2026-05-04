// =============================================================================
// SignatoriesCard.jsx
//
// Settings panel for managing the people who sign offer letters.
// Lives in Settings → Signatories. Each row is editable inline:
//   • Name, title, email, department scope, display order, active flag
//   • Save button per row, only shown when row is dirty
// "Add signatory" button at the top creates a new row.
//
// Signature image upload deferred — the offer letter PDF currently
// renders the typed name + title in the signature block. Image
// upload will arrive in a follow-up phase via Supabase Storage.
//
// Why this exists: offer letters need a real signing authority, and
// hard-coding the list in SQL means every update requires a
// migration. With this panel Bashaier (or the admin) can add or
// retire signatories on the fly without touching code.
// =============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  Loader2, Plus, Trash2, RefreshCw, Save, AlertCircle,
} from 'lucide-react';
import { directGet, directPost, directPatch, directDelete } from '../supabaseClient.js';

const TINY_LABEL = { fontSize: 11, fontWeight: 600, color: '#0A0A0A' };
const ROW_INPUT_STYLE = {
  background: 'transparent',
  border: '1px solid var(--border-soft)',
  borderRadius: 6,
  padding: '6px 8px',
  fontSize: 13,
  color: '#0A0A0A',
  outline: 'none',
};

export default function SignatoriesCard() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [adding, setAdding] = useState(false);

  // ─── Load ───────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await directGet(
        'signatories',
        'select=*&order=display_order.asc,name.asc',
        { timeoutMs: 8000 }
      );
      // Each row gets a `_dirty` flag we toggle on edits and a
      // `_draft` snapshot of the editable fields. Keeps the form
      // logic local without needing a separate state map.
      setRows((data || []).map(r => ({ ...r, _draft: { ...r }, _dirty: false })));
      setError('');
    } catch (e) {
      console.warn('Signatories load failed:', e);
      setError(e?.message || 'Could not load signatories.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ─── Add new ────────────────────────────────────────────────────
  async function handleAdd() {
    setAdding(true);
    try {
      const inserted = await directPost(
        'signatories',
        {
          name: 'New signatory',
          title: 'Title',
          email: null,
          department_scope: null,
          display_order: 100,
          active: true,
        },
        { returning: 'representation' }
      );
      const created = Array.isArray(inserted) ? inserted[0] : inserted;
      if (created?.id) {
        setRows(prev => [
          ...prev,
          { ...created, _draft: { ...created }, _dirty: false },
        ]);
      }
    } catch (e) {
      alert(e?.message || 'Could not add signatory.');
    } finally {
      setAdding(false);
    }
  }

  // ─── Edit a field on a row ──────────────────────────────────────
  function patchDraft(id, field, value) {
    setRows(prev => prev.map(r => {
      if (r.id !== id) return r;
      const draft = { ...r._draft, [field]: value };
      const dirty = ['name','title','email','department_scope','display_order','active']
        .some(k => draft[k] !== r[k]);
      return { ...r, _draft: draft, _dirty: dirty };
    }));
  }

  // ─── Save row ───────────────────────────────────────────────────
  async function handleSave(row) {
    try {
      const patch = {
        name:             row._draft.name?.trim() || '—',
        title:            row._draft.title?.trim() || '—',
        email:            row._draft.email?.trim() || null,
        department_scope: row._draft.department_scope?.trim() || null,
        display_order:    Number(row._draft.display_order) || 100,
        active:           Boolean(row._draft.active),
        updated_at:       new Date().toISOString(),
      };
      await directPatch('signatories', 'id', row.id, patch);
      // Re-snapshot so dirty resets
      setRows(prev => prev.map(r =>
        r.id === row.id
          ? { ...r, ...patch, _draft: { ...r._draft, ...patch }, _dirty: false }
          : r
      ));
    } catch (e) {
      alert(e?.message || 'Save failed.');
    }
  }

  // ─── Delete row ─────────────────────────────────────────────────
  async function handleDelete(row) {
    if (!confirm(`Delete signatory "${row.name}"? Past offer letters keep their record (the foreign key clears to null).`)) return;
    try {
      await directDelete('signatories', `id=eq.${row.id}`);
      setRows(prev => prev.filter(r => r.id !== row.id));
    } catch (e) {
      alert(e?.message || 'Delete failed.');
    }
  }

  return (
    <section
      className="rounded-2xl border bg-white p-5"
      style={{ borderColor: 'var(--border-soft)' }}
    >
      <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <div className="text-[10px] tracking-[0.25em] mb-1" style={{ color: '#0A0A0A', fontWeight: 700 }}>
            OFFER LETTER SIGNATORIES
          </div>
          <div style={{ fontFamily: 'Georgia, serif', fontSize: 20, color: '#0A0A0A' }}>
            Signing authorities
          </div>
          <div className="text-xs mt-1" style={{ color: '#0A0A0A', opacity: 0.7 }}>
            People who sign offer letters. Their name + title appears in the letter's signature block. Department scope (optional) restricts a signatory to offers in that department.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            className="p-2 rounded-full opacity-60 hover:opacity-100"
            title="Refresh"
            style={{ border: '1px solid var(--border-soft)' }}
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleAdd}
            disabled={adding}
            className="px-3 py-2 rounded-lg text-sm flex items-center gap-2 disabled:opacity-50"
            style={{ background: 'var(--evergreen-600)', color: '#FFFFFF', fontWeight: 600 }}
          >
            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            Add signatory
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm py-6 justify-center" style={{ color: '#0A0A0A', opacity: 0.6 }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      ) : error ? (
        <div className="rounded-lg p-3 text-xs flex items-start gap-2"
          style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B' }}>
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
          <div>{error}</div>
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg p-4 text-sm text-center"
          style={{ background: 'var(--paper-2)', color: '#0A0A0A', opacity: 0.7 }}>
          No signatories yet. Click "Add signatory" to create the first one.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map(row => (
            <SignatoryRow
              key={row.id}
              row={row}
              onPatch={(field, val) => patchDraft(row.id, field, val)}
              onSave={() => handleSave(row)}
              onDelete={() => handleDelete(row)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Per-row editor ───────────────────────────────────────────────

function SignatoryRow({ row, onPatch, onSave, onDelete }) {
  const draft = row._draft;
  return (
    <div
      className="rounded-lg border p-3"
      style={{
        borderColor: 'var(--border-soft)',
        background: row._dirty ? '#FEF6E2' : 'var(--paper)',
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-12 gap-2">
        <Field label="Name" col="md:col-span-3">
          <input
            value={draft.name || ''}
            onChange={e => onPatch('name', e.target.value)}
            placeholder="e.g. John Ho"
            style={ROW_INPUT_STYLE}
            className="w-full"
          />
        </Field>
        <Field label="Title" col="md:col-span-3">
          <input
            value={draft.title || ''}
            onChange={e => onPatch('title', e.target.value)}
            placeholder="e.g. Country Head"
            style={ROW_INPUT_STYLE}
            className="w-full"
          />
        </Field>
        <Field label="Email" col="md:col-span-3">
          <input
            value={draft.email || ''}
            onChange={e => onPatch('email', e.target.value)}
            placeholder="signatory@evergreen…"
            style={ROW_INPUT_STYLE}
            className="w-full"
          />
        </Field>
        <Field label="Department" col="md:col-span-2">
          <input
            value={draft.department_scope || ''}
            onChange={e => onPatch('department_scope', e.target.value)}
            placeholder="(any)"
            title="Restrict signatory to offers in this department. Leave blank to apply to all departments."
            style={ROW_INPUT_STYLE}
            className="w-full"
          />
        </Field>
        <Field label="Order" col="md:col-span-1">
          <input
            type="number"
            value={draft.display_order ?? 100}
            onChange={e => onPatch('display_order', e.target.value)}
            style={ROW_INPUT_STYLE}
            className="w-full"
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-2 mt-2.5">
        <label className="flex items-center gap-1.5 text-xs cursor-pointer" style={{ color: '#0A0A0A' }}>
          <input
            type="checkbox"
            checked={Boolean(draft.active)}
            onChange={e => onPatch('active', e.target.checked)}
          />
          Active (appears in offer-letter picker)
        </label>
        <div className="flex items-center gap-2">
          {row._dirty && (
            <button
              onClick={onSave}
              className="text-[11px] px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
              style={{
                background: 'var(--evergreen-600)',
                color: '#FFFFFF',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              <Save className="w-3 h-3" /> Save
            </button>
          )}
          <button
            onClick={onDelete}
            className="text-[11px] px-2 py-1.5 rounded-full inline-flex items-center gap-1.5"
            title="Delete signatory"
            style={{
              background: 'transparent',
              color: '#991B1B',
              border: '1px solid #FCA5A5',
              fontWeight: 500,
              cursor: 'pointer',
            }}
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Field label ──────────────────────────────────────────────────

function Field({ label, col, children }) {
  return (
    <div className={col || ''}>
      <div className="text-[10px] mb-1 opacity-60" style={TINY_LABEL}>{label.toUpperCase()}</div>
      {children}
    </div>
  );
}
