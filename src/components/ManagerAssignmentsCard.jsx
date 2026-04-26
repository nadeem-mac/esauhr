import React, { useEffect, useMemo, useState } from 'react';
import { Search, Loader2, Users, Check } from 'lucide-react';
import { Card } from './Dashboard.jsx';
import { supabase } from '../supabaseClient.js';
import { logAction } from '../lib/audit.js';

// MANAGER ASSIGNMENTS CARD (admin-only)
// ─────────────────────────────────────
// Each staff member's direct manager. The manager approves their leave/permission
// requests first; Bashaier sees everything as central oversight regardless.
//
// Admin can:
//   • Search staff by PSN, name, or department
//   • Change any staff's manager via dropdown
//   • Bulk-assign all staff in a department to a chosen manager

export default function ManagerAssignmentsCard({ employees, me }) {
  const [staff,    setStaff]    = useState(employees || []);
  const [search,   setSearch]   = useState('');
  const [deptPick, setDeptPick] = useState('');
  const [bulkMgr,  setBulkMgr]  = useState('');
  const [busyId,   setBusyId]   = useState(null);
  const [savedAt,  setSavedAt]  = useState({});
  const [error,    setError]    = useState('');

  // Refresh from server when employees prop changes
  useEffect(() => { setStaff(employees || []); }, [employees]);

  const departments = useMemo(() => {
    const d = new Set();
    (staff || []).forEach(e => { if (e.department) d.add(e.department); });
    return [...d].sort();
  }, [staff]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (staff || []).filter(e => {
      if (!q) return true;
      return (e.id || '').toLowerCase().includes(q)
          || (e.name || '').toLowerCase().includes(q)
          || (e.department || '').toLowerCase().includes(q);
    }).sort((a, b) => (a.department || '').localeCompare(b.department || '') || (a.name || '').localeCompare(b.name || ''));
  }, [staff, search]);

  async function setManager(empId, newMgrId) {
    if (empId === newMgrId) {
      setError('A staff member cannot be their own manager.');
      return;
    }
    setBusyId(empId); setError('');
    try {
      const { error } = await supabase
        .from('employees')
        .update({ manager_id: newMgrId || null })
        .eq('id', empId);
      if (error) throw error;
      // optimistic local update
      setStaff(prev => prev.map(e => e.id === empId ? { ...e, manager_id: newMgrId || null } : e));
      setSavedAt(s => ({ ...s, [empId]: Date.now() }));
      logAction(me, 'manager_assigned', { employee_id: empId, manager_id: newMgrId || null }).catch(() => {});
    } catch (err) {
      setError(err.message || 'Update failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function bulkAssignDepartment() {
    if (!deptPick || !bulkMgr) return;
    setError('');
    const targets = (staff || []).filter(e => e.department === deptPick && e.id !== bulkMgr);
    let updated = 0;
    for (const t of targets) {
      try {
        const { error } = await supabase
          .from('employees')
          .update({ manager_id: bulkMgr })
          .eq('id', t.id);
        if (!error) {
          updated++;
          setStaff(prev => prev.map(e => e.id === t.id ? { ...e, manager_id: bulkMgr } : e));
        }
      } catch {}
    }
    logAction(me, 'manager_bulk_assigned', { department: deptPick, manager_id: bulkMgr, count: updated }).catch(() => {});
    setError(`✓ ${updated} staff in ${deptPick} now report to ${bulkMgr}.`);
    setDeptPick(''); setBulkMgr('');
  }

  return (
    <Card title="Manager assignments"
          subtitle="Each staff member's direct manager. Manager approves their requests; Bashaier sees everything as central oversight.">

      {/* Bulk assign by department */}
      <div className="rounded-xl p-4 mb-5 grid md:grid-cols-3 gap-3 items-end"
           style={{ background:'var(--paper-2)', border:'1px solid var(--border-soft)' }}>
        <div>
          <label className="block text-[10px] tracking-[0.2em] opacity-60 font-bold mb-1.5">DEPARTMENT</label>
          <select value={deptPick} onChange={e => setDeptPick(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border bg-transparent text-sm"
            style={{ borderColor:'var(--border)' }}>
            <option value="">— pick department —</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] tracking-[0.2em] opacity-60 font-bold mb-1.5">SET ALL TO MANAGER</label>
          <select value={bulkMgr} onChange={e => setBulkMgr(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border bg-transparent text-sm"
            style={{ borderColor:'var(--border)' }}>
            <option value="">— pick manager —</option>
            {(staff || []).filter(e => !deptPick || e.department === deptPick).map(e =>
              <option key={e.id} value={e.id}>{e.id} — {e.name}</option>
            )}
          </select>
        </div>
        <button onClick={bulkAssignDepartment} disabled={!deptPick || !bulkMgr}
          className="px-4 py-2 rounded-full text-xs font-bold disabled:opacity-40"
          style={{ background:'var(--ink)', color:'var(--paper)' }}>
          Apply to all
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-4">
        <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search by PSN, name, or department"
          className="w-full pl-10 pr-3 py-2.5 rounded-xl border bg-transparent text-sm"
          style={{ borderColor:'var(--border)' }} />
      </div>

      {error && (
        <div className="text-xs mb-3 px-3 py-2 rounded-lg"
          style={{ background:'rgba(45,95,63,0.10)', color:'var(--evergreen-500)' }}>{error}</div>
      )}

      {/* Staff list */}
      <ul className="divide-y border rounded-xl overflow-hidden max-h-[500px] overflow-y-auto"
        style={{ borderColor:'var(--border-soft)' }}>
        {filtered.map(emp => {
          const mgr = (staff || []).find(e => e.id === emp.manager_id);
          const justSaved = savedAt[emp.id] && (Date.now() - savedAt[emp.id] < 3000);
          return (
            <li key={emp.id} className="px-4 py-3 flex items-center justify-between gap-3"
              style={{ borderColor:'var(--border-soft)' }}>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold flex items-center gap-2">
                  <span className="font-mono text-xs opacity-50">{emp.id}</span>
                  <span className="truncate">{emp.name}</span>
                  {justSaved && <Check className="w-3.5 h-3.5" style={{ color:'var(--evergreen-500)' }} />}
                </div>
                <div className="text-[11px] opacity-60 mt-0.5">{emp.department} · {emp.location}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] tracking-widest opacity-50">REPORTS TO</span>
                <select value={emp.manager_id || ''} disabled={busyId === emp.id}
                  onChange={e => setManager(emp.id, e.target.value)}
                  className="px-2 py-1.5 rounded-lg border bg-transparent text-xs min-w-[180px]"
                  style={{ borderColor:'var(--border)' }}>
                  <option value="">— no manager —</option>
                  {(staff || []).filter(m => m.id !== emp.id).map(m =>
                    <option key={m.id} value={m.id}>{m.id} — {m.name}</option>
                  )}
                </select>
                {busyId === emp.id && <Loader2 className="w-3.5 h-3.5 animate-spin opacity-60" />}
              </div>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-4 py-8 text-center text-sm opacity-50">No staff match your search.</li>
        )}
      </ul>
      <div className="text-[10px] opacity-50 mt-3 flex items-center gap-1.5">
        <Users className="w-3 h-3" /> {filtered.length} of {staff.length} staff shown
      </div>
    </Card>
  );
}
