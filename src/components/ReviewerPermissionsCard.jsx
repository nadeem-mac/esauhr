import React, { useState, useMemo } from 'react';
import { Card } from './Dashboard.jsx';
import { supabase } from '../supabaseClient.js';
import { ShieldCheck, Search, Loader2, Check } from 'lucide-react';
import { logAction } from '../lib/audit.js';

// Admin-only.  Lists every employee with two toggles:
//   • Can review leave requests
//   • Can review permission requests (late / early)
// Persists to employees.can_review_leave and .can_review_permissions.

export default function ReviewerPermissionsCard({ employees = [], me }) {
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [localFlags, setLocalFlags] = useState({}); // optimistic state

  // Filter + show staff who already have review rights at the top, then the rest
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = employees.filter(e => {
      if (!q) return true;
      return (e.id || '').toLowerCase().includes(q)
          || (e.name || '').toLowerCase().includes(q)
          || (e.department || '').toLowerCase().includes(q)
          || (e.location || '').toLowerCase().includes(q);
    });
    list.sort((a, b) => {
      const score = e => (effective(e, 'can_review_leave', localFlags) ? 1 : 0) + (effective(e, 'can_review_permissions', localFlags) ? 1 : 0);
      const sb = score(b), sa = score(a);
      if (sb !== sa) return sb - sa;
      return (a.name || '').localeCompare(b.name || '');
    });
    return list;
  }, [employees, query, localFlags]);

  async function toggle(emp, field) {
    const newValue = !effective(emp, field, localFlags);
    setBusyId(emp.id + ':' + field);
    setLocalFlags(prev => ({ ...prev, [emp.id]: { ...(prev[emp.id] || {}), [field]: newValue } }));
    try {
      const { error } = await supabase.from('employees').update({ [field]: newValue }).eq('id', emp.id);
      if (error) throw error;
      logAction(me, 'reviewer_role_change', {
        targetType: 'employee',
        targetId:   emp.id,
        targetLabel:`${emp.name} (${emp.id})`,
        details:    { field, value: newValue },
      });
    } catch (err) {
      // rollback
      setLocalFlags(prev => ({ ...prev, [emp.id]: { ...(prev[emp.id] || {}), [field]: !newValue } }));
      alert(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card
      title="Reviewer permissions"
      subtitle="Grant SUP staff the right to review leave or permission requests. Toggles take effect immediately."
    >
      <div className="flex items-center gap-2 mb-4 px-3 py-2 rounded-xl border" style={{ borderColor: 'var(--border)' }}>
        <Search className="w-4 h-4 opacity-50" />
        <input value={query} onChange={e => setQuery(e.target.value)}
          placeholder="Search by PSN, name, department or location"
          className="flex-1 bg-transparent text-sm outline-none"/>
      </div>

      <ul className="divide-y rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-soft)' }}>
        {filtered.slice(0, 50).map(emp => {
          const canLeave = effective(emp, 'can_review_leave', localFlags);
          const canPerm  = effective(emp, 'can_review_permissions', localFlags);
          return (
            <li key={emp.id}
              className="px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
              style={{ background: 'var(--paper-2)' }}>
              <div className="flex-1 min-w-0">
                <div className="text-sm flex items-center gap-2">
                  <span className="font-mono opacity-50 text-xs">{emp.id}</span>
                  <span>{emp.name}</span>
                  {emp.is_admin && (
                    <span className="text-[9px] tracking-widest px-1.5 py-0.5 rounded-full font-medium"
                      style={{ background: 'var(--evergreen-800)', color: 'var(--paper)' }}>ADMIN</span>
                  )}
                </div>
                <div className="text-xs opacity-60">
                  {emp.department} · {emp.location}
                </div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Toggle
                  label="Review leave"
                  on={canLeave}
                  busy={busyId === emp.id + ':can_review_leave'}
                  onClick={() => toggle(emp, 'can_review_leave')}
                />
                <Toggle
                  label="Review permissions"
                  on={canPerm}
                  busy={busyId === emp.id + ':can_review_permissions'}
                  onClick={() => toggle(emp, 'can_review_permissions')}
                />
              </div>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-4 py-6 text-center text-xs opacity-60" style={{ background: 'var(--paper-2)' }}>
            No employees match.
          </li>
        )}
      </ul>
      {filtered.length > 50 && (
        <div className="text-[11px] opacity-60 mt-2 text-center">
          Showing 50 of {filtered.length} matches — narrow your search to see more.
        </div>
      )}
    </Card>
  );
}

function Toggle({ label, on, busy, onClick }) {
  return (
    <button onClick={onClick} disabled={busy}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs border transition-all disabled:opacity-50"
      style={{
        borderColor: on ? 'var(--evergreen-500)' : 'var(--border)',
        background:  on ? 'var(--evergreen-500)' : 'transparent',
        color:       on ? 'var(--paper)'        : 'var(--ink-soft)',
      }}>
      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : on ? <Check className="w-3 h-3" /> : <ShieldCheck className="w-3 h-3" />}
      {label}
    </button>
  );
}

// Read effective value: optimistic localFlags override the prop
function effective(emp, field, localFlags) {
  const o = localFlags[emp.id]?.[field];
  if (o !== undefined) return o;
  return Boolean(emp[field]);
}
