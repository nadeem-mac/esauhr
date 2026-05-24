// ──────────────────────────────────────────────────────────────────────
//  HolidayShifts — manager nomination workspace
//
//  Replaces the manager-emailed Excel for Eid OT scheduling. Each
//  manager nominates their team members with specific clock-in/clock-
//  out times for each day of the holiday window. Shifts start as
//  'pending' and flow to HR (Bashaier) for approval in Phase 4.
//
//  Access:
//    • Manager → sees + edits shifts they assigned, can nominate from
//                 their direct reports + same-dept employees
//    • HR      → sees all shifts across all departments
//    • Admin   → sees everything + can override anything
//    • Staff   → no access (read-only view comes in Phase 5 on their
//                personal dashboard)
//
//  Phase 3 of 6. Manager → HR approval flow in Phase 4.
//  Nadeem 2026-05-21.
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useMemo, useEffect } from 'react';
import { directGet, directPost, directPatch } from '../supabaseClient.js';
import {
  CalendarDays, Plus, Save, Loader2, Trash2, AlertCircle, CheckCircle2,
  X, Clock, Users, Edit3, ChevronDown, FileSpreadsheet,
} from 'lucide-react';
import HolidayOtReport from './HolidayOtReport.jsx';

const STATUS_STYLES = {
  pending:   { bg: '#FEF3C7', fg: '#854F0B', label: 'PENDING' },
  approved:  { bg: '#D1FAE5', fg: '#065F46', label: 'APPROVED' },
  rejected:  { bg: '#FEE2E2', fg: '#991B1B', label: 'REJECTED' },
  cancelled: { bg: '#E5E7EB', fg: '#374151', label: 'CANCELLED' },
};

const fmtDayDate = (d) => new Date(d).toLocaleDateString('en-GB', {
  weekday: 'short', day: '2-digit', month: 'short',
});

const fmtTime = (t) => (t || '').slice(0, 5);  // 09:00:00 → 09:00


export default function HolidayShifts({ me, employees = [] }) {
  const isAdmin       = Boolean(me?.is_admin);
  const isHrReviewer  = Boolean(me?.is_hr_reviewer);

  const [periods, setPeriods]   = useState([]);
  const [periodId, setPeriodId] = useState('');
  const [shifts, setShifts]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [err, setErr]           = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);
  // HR-only — filter by status so Bashaier can focus on pending. For
  // managers we default to showing everything (their list is smaller).
  const [statusFilter, setStatusFilter] = useState('all');
  // Phase 6 — OT comparison report modal. Opens via the [Report] button
  // in the header. Renders strict comparison of approved shifts vs
  // attendance_daily punches + offers Excel export.
  const [showReport, setShowReport]     = useState(false);

  // ── Load active periods ───────────────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const rows = await directGet('holiday_periods',
          'select=*&is_active=eq.true&order=start_date.desc',
          { timeoutMs: 8000 });
        setPeriods(rows || []);
        if ((rows || []).length > 0 && !periodId) setPeriodId(rows[0].id);
      } catch (e) {
        setErr(e?.message || 'Failed to load holiday periods');
      } finally {
        setLoading(false);
      }
    })();
  }, []); // eslint-disable-line

  // ── Load shifts for selected period ───────────────────────────────
  const loadShifts = async () => {
    if (!periodId) { setShifts([]); return; }
    try {
      const rows = await directGet('holiday_shifts',
        `select=*&holiday_period_id=eq.${periodId}&order=shift_date.asc,employee_id.asc`,
        { timeoutMs: 10000 });
      setShifts(rows || []);
    } catch (e) {
      setErr(e?.message || 'Failed to load shifts');
    }
  };
  useEffect(() => { loadShifts(); /* eslint-disable-next-line */ }, [periodId]);

  // ── Selected period meta ──────────────────────────────────────────
  const selectedPeriod = useMemo(
    () => periods.find(p => p.id === periodId),
    [periods, periodId]
  );

  // ── Visibility filter — managers only see what they assigned;
  //    HR + admin see everything in the period. Status filter is
  //    overlaid on top for the HR review case.
  const visibleShifts = useMemo(() => {
    let scoped = (isAdmin || isHrReviewer)
      ? shifts
      : shifts.filter(s => s.assigned_by === me?.id);
    if (statusFilter !== 'all') {
      scoped = scoped.filter(s => s.status === statusFilter);
    }
    return scoped;
  }, [shifts, me, isAdmin, isHrReviewer, statusFilter]);

  // Pending count across ALL shifts for the badge (regardless of
  // current filter) — Bashaier wants the total queue size.
  const totalPending = useMemo(
    () => shifts.filter(s => s.status === 'pending').length,
    [shifts]
  );

  // ── Group by date for the listing ─────────────────────────────────
  const shiftsByDate = useMemo(() => {
    const map = new Map();
    for (const s of visibleShifts) {
      if (!map.has(s.shift_date)) map.set(s.shift_date, []);
      map.get(s.shift_date).push(s);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visibleShifts]);

  // ── Eligible staff for current manager ────────────────────────────
  // Managers nominate from their direct reports + anyone in their own
  // department/location. HR + admin can nominate anyone in the
  // employees list.
  const eligibleStaff = useMemo(() => {
    if (isAdmin || isHrReviewer) return employees || [];
    if (!me) return [];
    return (employees || []).filter(e =>
      e.id !== me.id &&
      (e.manager_id === me.id ||
       (e.department === me.department && e.location === me.location))
    );
  }, [employees, me, isAdmin, isHrReviewer]);

  // ── Render ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-6 flex items-center gap-2 text-sm" style={{ color: '#1F1B16', opacity: 0.7 }}>
        <Loader2 size={14} className="animate-spin" /> Loading holiday periods…
      </div>
    );
  }

  if (periods.length === 0) {
    return (
      <div className="p-6 max-w-2xl">
        <div className="rounded-lg border p-6 text-center" style={{ borderColor: 'rgba(0,0,0,0.1)' }}>
          <CalendarDays size={28} style={{ color: '#0F4C2A', opacity: 0.4 }} className="mx-auto mb-2" />
          <h3 className="text-sm font-semibold mb-1" style={{ color: '#1F1B16' }}>
            No active holiday periods
          </h3>
          <p className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
            Ask HR to add a holiday window in <strong>Settings → Holiday periods</strong> before nominating staff.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-w-4xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between gap-2 pb-2 border-b border-black/10">
        <div className="flex items-center gap-2">
          <CalendarDays size={20} style={{ color: '#0F4C2A' }} />
          <h2 className="text-lg font-semibold" style={{ color: '#1F1B16' }}>
            Holiday Shifts
          </h2>
          <span className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
            · OT nominations
          </span>
        </div>
        <div className="flex items-center gap-2">
          {selectedPeriod && shifts.some(s => s.status === 'approved') && (
            <button
              onClick={() => setShowReport(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded border"
              style={{ borderColor: '#0F4C2A', color: '#0F4C2A', background: '#FFFFFF' }}>
              <FileSpreadsheet size={12} /> OT Report
            </button>
          )}
          {!showForm && !editing && selectedPeriod && (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded text-white"
              style={{ background: '#0F4C2A' }}>
              <Plus size={12} /> Add shift
            </button>
          )}
        </div>
      </header>

      {/* OT Report modal */}
      {showReport && selectedPeriod && (
        <HolidayOtReport
          period={selectedPeriod}
          employees={employees}
          me={me}
          onClose={() => setShowReport(false)}
        />
      )}

      {/* Period selector */}
      <div className="space-y-1">
        <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
          Holiday period
        </label>
        <div className="relative">
          <select
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value)}
            className="w-full text-sm rounded border border-black/15 bg-white pl-3 pr-9 py-2 outline-none appearance-none"
          >
            {periods.map(p => {
              const days = Math.floor(
                (new Date(p.end_date) - new Date(p.start_date)) / 86400000
              ) + 1;
              return (
                <option key={p.id} value={p.id}>
                  {p.name} · {fmtDayDate(p.start_date)} → {fmtDayDate(p.end_date)} · {days}d
                </option>
              );
            })}
          </select>
          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
                       style={{ color: '#1F1B16', opacity: 0.5 }} />
        </div>
      </div>

      {/* Add / edit form */}
      {(showForm || editing) && selectedPeriod && (
        <ShiftForm
          initial={editing}
          period={selectedPeriod}
          eligibleStaff={eligibleStaff}
          me={me}
          existingShifts={visibleShifts}
          onCancel={() => { setShowForm(false); setEditing(null); }}
          onSaved={() => { setShowForm(false); setEditing(null); loadShifts(); }}
        />
      )}

      {/* Error toast */}
      {err && (
        <div className="flex items-center gap-2 text-xs rounded px-3 py-2"
             style={{ background: '#FEF2F2', color: '#991B1B' }}>
          <AlertCircle size={12} /> {err}
        </div>
      )}

      {/* Stats row */}
      {selectedPeriod && (
        <StatsRow shifts={visibleShifts} />
      )}

      {/* HR / admin status filter + bulk approve */}
      {selectedPeriod && (isAdmin || isHrReviewer) && (
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] font-bold tracking-wider"
                  style={{ color: '#1F1B16', opacity: 0.6 }}>FILTER:</span>
            {['all', 'pending', 'approved', 'rejected', 'cancelled'].map(s => {
              const isActive = statusFilter === s;
              const style = STATUS_STYLES[s] || { bg: '#E5E7EB', fg: '#374151' };
              return (
                <button key={s}
                  onClick={() => setStatusFilter(s)}
                  className="text-[10px] px-2 py-1 rounded font-bold tracking-wide"
                  style={{
                    background: isActive ? style.bg : '#FAFAF6',
                    color: isActive ? style.fg : '#1F1B16',
                    opacity:    isActive ? 1     : 0.6,
                    border: isActive ? `1px solid ${style.fg}30` : '1px solid rgba(0,0,0,0.08)',
                  }}>
                  {s.toUpperCase()}
                </button>
              );
            })}
          </div>
          {totalPending > 0 && statusFilter === 'pending' && (
            <button
              onClick={async () => {
                const pendingIds = visibleShifts.filter(s => s.status === 'pending').map(s => s.id);
                if (pendingIds.length === 0) return;
                if (!confirm(`Approve all ${pendingIds.length} pending shifts in this view?`)) return;
                try {
                  const now = new Date().toISOString();
                  await Promise.all(pendingIds.map(id =>
                    directPatch('holiday_shifts', 'id', id, {
                      status: 'approved',
                      approved_by: me?.id,
                      approved_at: now,
                    })
                  ));
                  loadShifts();
                } catch (e) { setErr(e?.message || 'Bulk approve failed'); }
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded text-white"
              style={{ background: '#0F4C2A' }}>
              <CheckCircle2 size={12} /> Approve all visible
            </button>
          )}
        </div>
      )}

      {/* Shifts grouped by date */}
      {shiftsByDate.length === 0 ? (
        <div className="rounded border p-6 text-center"
             style={{ borderColor: 'rgba(0,0,0,0.08)', background: '#FAFAF6' }}>
          <Users size={20} style={{ color: '#1F1B16', opacity: 0.3 }} className="mx-auto mb-2" />
          <p className="text-sm" style={{ color: '#1F1B16', opacity: 0.7 }}>
            No shifts yet for this period.
          </p>
          <p className="text-xs mt-1" style={{ color: '#1F1B16', opacity: 0.5 }}>
            Click <strong>Add shift</strong> to nominate your first staff member.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {shiftsByDate.map(([date, dateShifts]) => (
            <DateGroup
              key={date}
              date={date}
              shifts={dateShifts}
              employees={employees}
              me={me}
              isAdmin={isAdmin}
              isHrReviewer={isHrReviewer}
              onEdit={(s) => setEditing(s)}
              onApprove={async (s) => {
                try {
                  await directPatch('holiday_shifts', 'id', s.id, {
                    status: 'approved',
                    approved_by: me?.id,
                    approved_at: new Date().toISOString(),
                  });
                  loadShifts();
                } catch (e) { setErr(e?.message || 'Approve failed'); }
              }}
              onReject={async (s) => {
                const reason = prompt(
                  `Reject this shift for ${employees.find(e => e.id === s.employee_id)?.name || s.employee_id} on ${fmtDayDate(s.shift_date)}?\n\nReason (will be visible to the manager who nominated):`,
                  ''
                );
                if (reason === null) return;  // cancelled
                try {
                  await directPatch('holiday_shifts', 'id', s.id, {
                    status: 'rejected',
                    approved_by: me?.id,
                    approved_at: new Date().toISOString(),
                    rejection_reason: reason.trim() || 'No reason provided',
                  });
                  loadShifts();
                } catch (e) { setErr(e?.message || 'Reject failed'); }
              }}
              onCancel={async (s) => {
                if (!confirm(`Cancel shift for ${employees.find(e => e.id === s.employee_id)?.name || s.employee_id} on ${fmtDayDate(s.shift_date)}?`)) return;
                try {
                  await directPatch('holiday_shifts', 'id', s.id,
                    { status: 'cancelled' });
                  loadShifts();
                } catch (e) { setErr(e?.message || 'Cancel failed'); }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}


// ── StatsRow ──────────────────────────────────────────────────────────
function StatsRow({ shifts }) {
  const counts = shifts.reduce((acc, s) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});
  const totalHours = shifts
    .filter(s => s.status === 'approved' || s.status === 'pending')
    .reduce((sum, s) => sum + Number(s.expected_hours || 0), 0);
  return (
    <div className="grid grid-cols-4 gap-2 text-center text-xs">
      <StatCell label="PENDING"   count={counts.pending   || 0} bg="#FEF3C7" fg="#854F0B" />
      <StatCell label="APPROVED"  count={counts.approved  || 0} bg="#D1FAE5" fg="#065F46" />
      <StatCell label="REJECTED"  count={counts.rejected  || 0} bg="#FEE2E2" fg="#991B1B" />
      <StatCell label="OT HOURS"  count={totalHours.toFixed(1)} bg="#DBEAFE" fg="#1D4ED8" suffix="h" />
    </div>
  );
}
function StatCell({ label, count, bg, fg, suffix = '' }) {
  return (
    <div className="rounded px-2 py-1.5" style={{ background: bg }}>
      <div className="text-[9px] font-bold tracking-wider" style={{ color: fg, opacity: 0.8 }}>
        {label}
      </div>
      <div className="text-base font-bold" style={{ color: fg }}>
        {count}{suffix}
      </div>
    </div>
  );
}


// ── DateGroup ─────────────────────────────────────────────────────────
function DateGroup({ date, shifts, employees, me, isAdmin, isHrReviewer, onEdit, onApprove, onReject, onCancel }) {
  return (
    <div className="rounded-lg border bg-white" style={{ borderColor: 'rgba(0,0,0,0.08)' }}>
      <div className="px-3 py-2 border-b text-xs font-semibold tracking-wide"
           style={{ borderColor: 'rgba(0,0,0,0.06)', color: '#0F4C2A', background: '#FAFAF6' }}>
        {fmtDayDate(date)} · {shifts.length} {shifts.length === 1 ? 'shift' : 'shifts'}
      </div>
      <div className="divide-y" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
        {shifts.map(s => {
          const emp = employees.find(e => e.id === s.employee_id);
          const style = STATUS_STYLES[s.status] || STATUS_STYLES.pending;
          const canEdit    = (isAdmin || isHrReviewer || s.assigned_by === me?.id) && s.status !== 'cancelled';
          const canReview  = (isAdmin || isHrReviewer) && s.status === 'pending';
          return (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2 text-sm"
                 style={{ borderTop: '1px solid rgba(0,0,0,0.05)' }}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate" style={{ color: '#1F1B16' }}>
                    {emp?.name || s.employee_id}
                  </span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                        style={{ background: style.bg, color: style.fg, letterSpacing: '0.04em' }}>
                    {style.label}
                  </span>
                </div>
                <div className="text-xs mt-0.5 flex items-center gap-2" style={{ color: '#1F1B16', opacity: 0.7 }}>
                  <Clock size={11} />
                  <span>{fmtTime(s.clock_in_time)} → {fmtTime(s.clock_out_time)}</span>
                  <span style={{ opacity: 0.6 }}>· {Number(s.expected_hours).toFixed(1)}h</span>
                  {emp && (
                    <span style={{ opacity: 0.6 }}>· {emp.department}</span>
                  )}
                </div>
                {s.notes && (
                  <p className="text-[11px] mt-1 italic" style={{ color: '#1F1B16', opacity: 0.55 }}>
                    {s.notes}
                  </p>
                )}
                {s.rejection_reason && (
                  <p className="text-[11px] mt-1" style={{ color: '#991B1B' }}>
                    Rejected: {s.rejection_reason}
                  </p>
                )}
                {s.status === 'approved' && s.approved_at && (
                  <p className="text-[10px] mt-1" style={{ color: '#065F46', opacity: 0.7 }}>
                    Approved {new Date(s.approved_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1">
                {/* Approve / Reject — HR + admin on pending shifts only */}
                {canReview && (
                  <>
                    <button onClick={() => onApprove(s)}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold text-white"
                            style={{ background: '#0F4C2A' }}
                            title="Approve">
                      <CheckCircle2 size={11} /> Approve
                    </button>
                    <button onClick={() => onReject(s)}
                            className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold"
                            style={{ background: '#FEE2E2', color: '#991B1B' }}
                            title="Reject with reason">
                      <X size={11} /> Reject
                    </button>
                  </>
                )}
                {/* Edit / Cancel — anyone with rights, hidden on cancelled */}
                {canEdit && (
                  <>
                    <button onClick={() => onEdit(s)}
                            className="p-1.5 rounded hover:bg-black/[0.05]" title="Edit">
                      <Edit3 size={12} style={{ color: '#1F1B16', opacity: 0.6 }} />
                    </button>
                    <button onClick={() => onCancel(s)}
                            className="p-1.5 rounded hover:bg-red-50" title="Cancel">
                      <Trash2 size={12} style={{ color: '#B84A3E' }} />
                    </button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


// ── ShiftForm — create / edit ─────────────────────────────────────────
function ShiftForm({ initial, period, eligibleStaff, me, existingShifts, onCancel, onSaved }) {
  const [empId, setEmpId]           = useState(initial?.employee_id || '');
  const [empQuery, setEmpQuery]     = useState('');
  const [shiftDate, setShiftDate]   = useState(initial?.shift_date || period.start_date);
  const [clockIn, setClockIn]       = useState(fmtTime(initial?.clock_in_time) || '09:00');
  const [clockOut, setClockOut]     = useState(fmtTime(initial?.clock_out_time) || '17:00');
  const [notes, setNotes]           = useState(initial?.notes || '');
  const [busy, setBusy]             = useState(false);
  const [err, setErr]               = useState(null);

  const isEdit = Boolean(initial?.id);

  // Build list of dates within the period
  const dateOptions = useMemo(() => {
    const out = [];
    const start = new Date(period.start_date);
    const end = new Date(period.end_date);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, [period.start_date, period.end_date]);

  // Typeahead for staff
  const empMatches = useMemo(() => {
    const q = (empQuery || '').trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return (eligibleStaff || [])
      .filter(e =>
        e.id?.toLowerCase().includes(q) ||
        (e.name || '').toLowerCase().includes(q))
      .slice(0, 6);
  }, [empQuery, eligibleStaff]);

  const selectedEmp = useMemo(
    () => (eligibleStaff || []).find(e => e.id === empId),
    [empId, eligibleStaff]
  );

  // Duplicate check — UNIQUE (employee_id, shift_date) is enforced
  // at the DB level too, but we warn early in the UI.
  const duplicate = useMemo(() => {
    if (!empId || !shiftDate) return false;
    return existingShifts.some(s =>
      s.employee_id === empId &&
      s.shift_date  === shiftDate &&
      s.id          !== initial?.id &&
      s.status      !== 'cancelled'
    );
  }, [empId, shiftDate, existingShifts, initial]);

  const canSave = empId && shiftDate && clockIn && clockOut
               && clockOut > clockIn && !duplicate && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setErr(null);
    try {
      const payload = {
        holiday_period_id: period.id,
        employee_id:       empId,
        shift_date:        shiftDate,
        clock_in_time:     clockIn + ':00',
        clock_out_time:    clockOut + ':00',
        notes: notes.trim() || null,
        assigned_by:       me?.id,
      };
      if (isEdit) {
        await directPatch('holiday_shifts', 'id', initial.id, payload);
      } else {
        await directPost('holiday_shifts', { ...payload, status: 'pending' });
      }
      onSaved?.();
    } catch (e) {
      setErr(e?.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-3"
         style={{ background: '#FFFBEB', borderColor: '#FCD34D' }}>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: '#92400E' }}>
          {isEdit ? 'Edit shift' : 'New shift'} · {period.name}
        </h4>
        <button onClick={onCancel} className="p-1 rounded hover:bg-black/[0.05]" title="Cancel">
          <X size={14} style={{ color: '#1F1B16', opacity: 0.6 }} />
        </button>
      </div>

      {/* Staff picker */}
      <div className="space-y-1">
        <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
          Staff member
        </label>
        {selectedEmp ? (
          <div className="flex items-center justify-between rounded border border-black/15 bg-white px-3 py-2">
            <div>
              <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                {selectedEmp.name}
              </div>
              <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
                {selectedEmp.id} · {selectedEmp.department} · {selectedEmp.location}
              </div>
            </div>
            {!isEdit && (
              <button onClick={() => { setEmpId(''); setEmpQuery(''); }}
                      className="text-xs underline" style={{ color: '#0F4C2A' }}>
                change
              </button>
            )}
          </div>
        ) : (
          <div className="relative">
            <input
              value={empQuery}
              onChange={(e) => setEmpQuery(e.target.value)}
              placeholder="Search by name or PSN…"
              className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none"
              autoFocus
            />
            {empMatches.length > 0 && (
              <ul className="absolute z-10 mt-1 w-full rounded border border-black/15 bg-white shadow-lg max-h-48 overflow-y-auto">
                {empMatches.map(e => (
                  <li key={e.id}>
                    <button
                      onClick={() => { setEmpId(e.id); setEmpQuery(''); }}
                      className="w-full text-left px-3 py-2 hover:bg-black/[0.04] border-b border-black/5 last:border-0">
                      <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                        {e.name}
                      </div>
                      <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
                        {e.id} · {e.department} · {e.location}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.55 }}>
          Eligible: your direct reports + same dept/location ({eligibleStaff.length} staff available).
        </p>
      </div>

      {/* Date + times */}
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Date
          </label>
          <select value={shiftDate} onChange={(e) => setShiftDate(e.target.value)}
                  className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none">
            {dateOptions.map(d => (
              <option key={d} value={d}>{fmtDayDate(d)}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Clock in
          </label>
          <input type="time" value={clockIn}
                 onChange={(e) => setClockIn(e.target.value)}
                 className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Clock out
          </label>
          <input type="time" value={clockOut}
                 onChange={(e) => setClockOut(e.target.value)}
                 min={clockIn}
                 className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none" />
        </div>
      </div>

      {/* Computed hours preview */}
      {clockIn && clockOut && clockOut > clockIn && (
        <div className="text-xs px-3 py-2 rounded bg-black/[0.03]" style={{ color: '#1F1B16' }}>
          Duration: <strong>{
            (() => {
              const [h1, m1] = clockIn.split(':').map(Number);
              const [h2, m2] = clockOut.split(':').map(Number);
              const mins = (h2 * 60 + m2) - (h1 * 60 + m1);
              return (mins / 60).toFixed(2);
            })()
          } hours</strong>
        </div>
      )}

      {duplicate && (
        <div className="flex items-center gap-2 text-xs rounded px-3 py-2"
             style={{ background: '#FEE2E2', color: '#991B1B' }}>
          <AlertCircle size={12} />
          This staff already has a shift on {fmtDayDate(shiftDate)}. Edit or cancel that one first.
        </div>
      )}

      {/* Notes */}
      <div className="space-y-1">
        <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
          Notes <span style={{ opacity: 0.6 }}>(optional)</span>
        </label>
        <input
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="e.g. covering customer service line"
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
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
          {busy ? 'Saving…' : isEdit ? 'Update shift' : 'Submit for approval'}
        </button>
      </div>
    </div>
  );
}
