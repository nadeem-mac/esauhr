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
  // Single-entry [+ Add shift] flow retired 2026-05-21 per Nadeem
  // ('remove single entry style'). New shifts always go through the
  // bulk form — one staff × one date is just a bulk of 1. Editing
  // an existing shift still uses ShiftForm via the `editing` state.
  const [editing, setEditing]   = useState(null);
  // HR-only — filter by status so Bashaier can focus on pending.
  const [statusFilter, setStatusFilter] = useState('all');
  // Phase 6 — OT comparison report modal.
  const [showReport, setShowReport]     = useState(false);
  // Bulk form — the ONLY add path now.
  const [showBulkForm, setShowBulkForm] = useState(false);

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
          {!editing && !showBulkForm && selectedPeriod && (
            <button
              onClick={() => setShowBulkForm(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded text-white"
              style={{ background: '#0F4C2A' }}
              title="Pick staff + dates + time window in one form">
              <Plus size={12} /> Add shifts
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

      {/* Edit form — re-uses ShiftForm in single-row mode. Triggered
          ONLY by clicking the pencil icon on an existing row. New
          shifts go through BulkShiftForm regardless of count. */}
      {editing && selectedPeriod && (
        <ShiftForm
          initial={editing}
          period={selectedPeriod}
          eligibleStaff={eligibleStaff}
          me={me}
          existingShifts={visibleShifts}
          onCancel={() => setEditing(null)}
          onSaved={() => { setEditing(null); loadShifts(); }}
        />
      )}

      {/* Bulk add form — multi-staff × multi-date in one go */}
      {showBulkForm && selectedPeriod && (
        <BulkShiftForm
          period={selectedPeriod}
          eligibleStaff={eligibleStaff}
          me={me}
          existingShifts={shifts}
          onCancel={() => setShowBulkForm(false)}
          onSaved={() => { setShowBulkForm(false); loadShifts(); }}
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
            Click <strong>Add shifts</strong> — pick staff, pick dates, set the time window once.
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
               && clockOut > clockIn && !duplicate && notes && !busy;

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

      {/* Work description — REQUIRED. Same canonical list as the
          bulk form. Nadeem 2026-05-21: 'WORK DESCRIPTION / TASK
          SUMMARY is mandatory not optional must select then can
          save'. Amber border + tint when unselected so the
          affordance is hard to miss. */}
      <div className="space-y-1">
        <label className="text-xs font-semibold uppercase flex items-center gap-1.5" style={{ color: '#1F1B16' }}>
          Work description / Task summary
          <span className="text-[9px] px-1.5 py-0.5 rounded"
                style={{ background: '#FEF3C7', color: '#854F0B', fontWeight: 700 }}>
            REQUIRED
          </span>
        </label>
        <div className="relative">
          <select
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full text-sm rounded border pl-3 pr-9 py-2 outline-none appearance-none"
            style={{
              borderColor: notes ? 'rgba(0,0,0,0.15)' : '#FCD34D',
              background:  notes ? '#FFFFFF' : '#FFFBEB',
            }}>
            <option value="">— select task —</option>
            <option value="D/O Release Counter / Fasah Link / 24/7 MAWANI Requirements">
              D/O Release Counter / Fasah Link / 24/7 MAWANI Requirements
            </option>
            <option value="D/O Release Counter / Fasah Link — Back Up / 24/7 MAWANI Requirements">
              D/O Release Counter / Fasah Link — Back Up / 24/7 MAWANI Requirements
            </option>
            <option value="EQC ECRN Ext / Detention / Damage Invoice / 24/7 MAWANI Requirements">
              EQC ECRN Ext / Detention / Damage Invoice / 24/7 MAWANI Requirements
            </option>
            <option value="CBF Submission / ALDS Data / OPS Tasks">
              CBF Submission / ALDS Data / OPS Tasks
            </option>
            <option value="Export Issues & Inquiries / Booking / Preload & Data Quality Checks / 24/7 MAWANI Requirements">
              Export Issues & Inquiries / Booking / Preload & Data Quality Checks / 24/7 MAWANI Requirements
            </option>
            <option value="Export Issues & Inquiries / Preload & Data Quality Checks">
              Export Issues & Inquiries / Preload & Data Quality Checks
            </option>
            <option value="Import Manifest / Export Inquiries / Email Attendance">
              Import Manifest / Export Inquiries / Email Attendance
            </option>
            <option value="Invoicing / ESAL / Offsetting / 24/7 MAWANI Requirements">
              Invoicing / ESAL / Offsetting / 24/7 MAWANI Requirements
            </option>
            <option value="Office Work Monitoring & Other Tasks">
              Office Work Monitoring & Other Tasks
            </option>
            <option value="CSD Export Tasks — 24/7 MAWANI Requirements">
              CSD Export Tasks — 24/7 MAWANI Requirements
            </option>
            <option value="24/7 MAWANI Requirements Compliance">
              24/7 MAWANI Requirements Compliance
            </option>
          </select>
          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
                       style={{ color: '#1F1B16', opacity: 0.5 }} />
        </div>
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


// ── BulkShiftForm — multi-staff × multi-date in one submission ────────
//
//  For managers who need to assign the same time window to several
//  people across several dates of the holiday period. Nadeem 2026-05-21
//  Bulk action with duplicate-skip:
//    • UI shows live preview of how many shifts will be created
//    • DB-level UNIQUE (employee_id, shift_date) is respected — duplicate
//      pairs are skipped client-side before submit (saves round-trips)
//    • Each shift inserted independently via Promise.all — partial
//      failures don't roll back successful inserts
//  Posts each row with status='pending', awaiting HR approval (same as
//  the single-shift form path).
//
function BulkShiftForm({ period, eligibleStaff, me, existingShifts, onCancel, onSaved }) {
  // Selection state
  const [selectedStaff, setSelectedStaff] = useState(new Set());  // Set<psn>
  const [selectedDates, setSelectedDates] = useState(new Set());  // Set<YYYY-MM-DD>
  const [clockIn, setClockIn]   = useState('09:00');
  const [clockOut, setClockOut] = useState('17:00');
  const [notes, setNotes]       = useState('');
  const [empQuery, setEmpQuery] = useState('');
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState(null);
  const [progress, setProgress] = useState({ done: 0, total: 0 });

  // Date options inside the period
  const dateOptions = useMemo(() => {
    const out = [];
    const start = new Date(period.start_date);
    const end   = new Date(period.end_date);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      out.push(d.toISOString().slice(0, 10));
    }
    return out;
  }, [period.start_date, period.end_date]);

  // Existing non-cancelled shifts as a Set of "psn|date" keys —
  // used both for filtering the staff/date matrix preview and for
  // skipping duplicates at submit time.
  const existingPairs = useMemo(() => {
    const s = new Set();
    for (const sh of existingShifts) {
      if (sh.status !== 'cancelled') s.add(`${sh.employee_id}|${sh.shift_date}`);
    }
    return s;
  }, [existingShifts]);

  // Filtered eligibility list — typeahead text + 'show only my
  // direct reports' affordance for managers with large departments.
  const filteredStaff = useMemo(() => {
    const q = empQuery.trim().toLowerCase();
    if (!q) return eligibleStaff;
    return eligibleStaff.filter(e =>
      e.id?.toLowerCase().includes(q) ||
      (e.name || '').toLowerCase().includes(q));
  }, [empQuery, eligibleStaff]);

  // Preview math — how many shifts will actually be inserted, and
  // how many will be skipped because of existing entries.
  const preview = useMemo(() => {
    let willCreate = 0;
    let willSkip   = 0;
    for (const psn of selectedStaff) {
      for (const date of selectedDates) {
        if (existingPairs.has(`${psn}|${date}`)) willSkip++;
        else willCreate++;
      }
    }
    return { willCreate, willSkip };
  }, [selectedStaff, selectedDates, existingPairs]);

  const canSave = preview.willCreate > 0
                && clockIn && clockOut && clockOut > clockIn
                && notes
                && !busy;

  const toggleStaff = (psn) => {
    setSelectedStaff(prev => {
      const next = new Set(prev);
      if (next.has(psn)) next.delete(psn); else next.add(psn);
      return next;
    });
  };
  const toggleDate = (date) => {
    setSelectedDates(prev => {
      const next = new Set(prev);
      if (next.has(date)) next.delete(date); else next.add(date);
      return next;
    });
  };
  const selectAllVisibleStaff = () => {
    setSelectedStaff(prev => {
      const next = new Set(prev);
      filteredStaff.forEach(e => next.add(e.id));
      return next;
    });
  };
  const selectAllDates = () => setSelectedDates(new Set(dateOptions));
  const clearStaff = () => setSelectedStaff(new Set());
  const clearDates = () => setSelectedDates(new Set());

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setErr(null);
    // Build the list of (psn, date) pairs that don't already exist.
    const toInsert = [];
    for (const psn of selectedStaff) {
      for (const date of selectedDates) {
        if (!existingPairs.has(`${psn}|${date}`)) {
          toInsert.push({ psn, date });
        }
      }
    }
    setProgress({ done: 0, total: toInsert.length });
    let okCount = 0;
    let failCount = 0;
    const errors = [];
    // Sequential insert so progress counter is meaningful and we
    // don't blast the API with 20+ concurrent requests. Slow path
    // but predictable; bulk usage is once per Eid, not per minute.
    for (let i = 0; i < toInsert.length; i++) {
      const { psn, date } = toInsert[i];
      try {
        await directPost('holiday_shifts', {
          holiday_period_id: period.id,
          employee_id:       psn,
          shift_date:        date,
          clock_in_time:     clockIn  + ':00',
          clock_out_time:    clockOut + ':00',
          notes: notes || null,
          assigned_by:       me?.id,
          status:            'pending',
        });
        okCount++;
      } catch (e) {
        failCount++;
        errors.push(`${psn} on ${date}: ${e?.message || 'unknown'}`);
      }
      setProgress({ done: i + 1, total: toInsert.length });
    }
    setBusy(false);
    if (failCount > 0) {
      setErr(`${okCount} created, ${failCount} failed.\n` + errors.slice(0, 3).join('\n'));
      if (okCount > 0) onSaved?.();   // refresh so the partial wins show up
    } else {
      onSaved?.();
    }
  };

  return (
    <div className="rounded-lg border p-4 space-y-3"
         style={{ background: '#FFFBEB', borderColor: '#A16207' }}>
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider" style={{ color: '#92400E' }}>
            Bulk add shifts · {period.name}
          </h4>
          <p className="text-[10px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.6 }}>
            Same clock-in/out applied to every selected staff × date combination.
          </p>
        </div>
        <button onClick={onCancel} className="p-1 rounded hover:bg-black/[0.05]" title="Cancel">
          <X size={14} style={{ color: '#1F1B16', opacity: 0.6 }} />
        </button>
      </div>

      {/* Staff multi-select */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Staff <span style={{ opacity: 0.6 }}>({selectedStaff.size} selected)</span>
          </label>
          <div className="flex gap-2 text-[10px]">
            <button onClick={selectAllVisibleStaff}
                    className="underline" style={{ color: '#0F4C2A' }}>
              select all visible
            </button>
            <button onClick={clearStaff}
                    className="underline" style={{ color: '#B84A3E' }}>
              clear
            </button>
          </div>
        </div>
        <input
          value={empQuery}
          onChange={(e) => setEmpQuery(e.target.value)}
          placeholder="Filter by name or PSN…"
          className="w-full text-sm rounded border border-black/15 bg-white px-3 py-1.5 outline-none"
        />
        <div className="rounded border max-h-48 overflow-y-auto bg-white"
             style={{ borderColor: 'rgba(0,0,0,0.1)' }}>
          {filteredStaff.length === 0 ? (
            <p className="text-xs px-3 py-3" style={{ color: '#1F1B16', opacity: 0.55 }}>
              No staff match.
            </p>
          ) : (
            filteredStaff.map(e => {
              const isSelected = selectedStaff.has(e.id);
              return (
                <label key={e.id}
                       className="flex items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-black/[0.03] border-b last:border-0"
                       style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
                  <input type="checkbox" checked={isSelected}
                         onChange={() => toggleStaff(e.id)} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" style={{ color: '#1F1B16' }}>
                      {e.name}
                    </div>
                    <div className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.55 }}>
                      {e.id} · {e.department} · {e.location}
                    </div>
                  </div>
                </label>
              );
            })
          )}
        </div>
      </div>

      {/* Date multi-select */}
      <div className="space-y-1">
        <div className="flex items-center justify-between">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Dates <span style={{ opacity: 0.6 }}>({selectedDates.size} selected)</span>
          </label>
          <div className="flex gap-2 text-[10px]">
            <button onClick={selectAllDates}
                    className="underline" style={{ color: '#0F4C2A' }}>
              select all
            </button>
            <button onClick={clearDates}
                    className="underline" style={{ color: '#B84A3E' }}>
              clear
            </button>
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {dateOptions.map(d => {
            const isSelected = selectedDates.has(d);
            return (
              <button key={d}
                onClick={() => toggleDate(d)}
                className="px-2 py-1 text-[11px] font-semibold rounded border"
                style={{
                  background:  isSelected ? '#0F4C2A' : '#FFFFFF',
                  color:       isSelected ? '#FFFFFF' : '#1F1B16',
                  borderColor: isSelected ? '#0F4C2A' : 'rgba(0,0,0,0.15)',
                }}>
                {fmtDayDate(d)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Time window */}
      <div className="grid grid-cols-2 gap-2">
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
          <input type="time" value={clockOut} min={clockIn}
                 onChange={(e) => setClockOut(e.target.value)}
                 className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none" />
        </div>
      </div>

      {/* Work description (same list as single form) — REQUIRED in
          bulk too. Nadeem 2026-05-21. */}
      <div className="space-y-1">
        <label className="text-xs font-semibold uppercase flex items-center gap-1.5" style={{ color: '#1F1B16' }}>
          Work description / Task summary
          <span className="text-[9px] px-1.5 py-0.5 rounded"
                style={{ background: '#FEF3C7', color: '#854F0B', fontWeight: 700 }}>
            REQUIRED
          </span>
        </label>
        <div className="relative">
          <select
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="w-full text-sm rounded border pl-3 pr-9 py-2 outline-none appearance-none"
            style={{
              borderColor: notes ? 'rgba(0,0,0,0.15)' : '#FCD34D',
              background:  notes ? '#FFFFFF' : '#FFFBEB',
            }}>
            <option value="">— select task —</option>
            <option value="D/O Release Counter / Fasah Link / 24/7 MAWANI Requirements">D/O Release Counter / Fasah Link / 24/7 MAWANI Requirements</option>
            <option value="D/O Release Counter / Fasah Link — Back Up / 24/7 MAWANI Requirements">D/O Release Counter / Fasah Link — Back Up / 24/7 MAWANI Requirements</option>
            <option value="EQC ECRN Ext / Detention / Damage Invoice / 24/7 MAWANI Requirements">EQC ECRN Ext / Detention / Damage Invoice / 24/7 MAWANI Requirements</option>
            <option value="CBF Submission / ALDS Data / OPS Tasks">CBF Submission / ALDS Data / OPS Tasks</option>
            <option value="Export Issues & Inquiries / Booking / Preload & Data Quality Checks / 24/7 MAWANI Requirements">Export Issues & Inquiries / Booking / Preload & Data Quality Checks / 24/7 MAWANI Requirements</option>
            <option value="Export Issues & Inquiries / Preload & Data Quality Checks">Export Issues & Inquiries / Preload & Data Quality Checks</option>
            <option value="Import Manifest / Export Inquiries / Email Attendance">Import Manifest / Export Inquiries / Email Attendance</option>
            <option value="Invoicing / ESAL / Offsetting / 24/7 MAWANI Requirements">Invoicing / ESAL / Offsetting / 24/7 MAWANI Requirements</option>
            <option value="Office Work Monitoring & Other Tasks">Office Work Monitoring & Other Tasks</option>
            <option value="CSD Export Tasks — 24/7 MAWANI Requirements">CSD Export Tasks — 24/7 MAWANI Requirements</option>
            <option value="24/7 MAWANI Requirements Compliance">24/7 MAWANI Requirements Compliance</option>
          </select>
          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none"
                       style={{ color: '#1F1B16', opacity: 0.5 }} />
        </div>
      </div>

      {/* Preview banner */}
      {(selectedStaff.size > 0 && selectedDates.size > 0) && (
        <div className="rounded px-3 py-2 text-xs flex items-center justify-between"
             style={{ background: '#DBEAFE', color: '#1D4ED8' }}>
          <span>
            Will create <strong>{preview.willCreate}</strong> shift{preview.willCreate === 1 ? '' : 's'}
            {preview.willSkip > 0 && (
              <> · skip <strong>{preview.willSkip}</strong> duplicate{preview.willSkip === 1 ? '' : 's'}</>
            )}
          </span>
          {clockIn && clockOut && clockOut > clockIn && (() => {
            const [h1, m1] = clockIn.split(':').map(Number);
            const [h2, m2] = clockOut.split(':').map(Number);
            const hours = ((h2 * 60 + m2) - (h1 * 60 + m1)) / 60;
            return (
              <span>
                {(hours * preview.willCreate).toFixed(1)}h total
              </span>
            );
          })()}
        </div>
      )}

      {/* Progress while inserting */}
      {busy && progress.total > 0 && (
        <div className="rounded px-3 py-2 text-xs"
             style={{ background: '#FEF3C7', color: '#854F0B' }}>
          Creating shifts… {progress.done} / {progress.total}
        </div>
      )}

      {err && (
        <div className="flex items-start gap-2 text-xs rounded px-3 py-2 whitespace-pre-line"
             style={{ background: '#FEF2F2', color: '#991B1B' }}>
          <AlertCircle size={12} className="mt-0.5 flex-shrink-0" /> {err}
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
          {busy
            ? 'Creating…'
            : preview.willCreate > 0
              ? `Submit ${preview.willCreate} shift${preview.willCreate === 1 ? '' : 's'} for approval`
              : 'Select staff + dates'}
        </button>
      </div>
    </div>
  );
}
