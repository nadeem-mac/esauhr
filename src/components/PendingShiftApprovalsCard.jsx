import React, { useEffect, useMemo, useState } from 'react';
import { Card } from './Dashboard.jsx';
import { CalendarDays, Check, ChevronDown } from 'lucide-react';
import { directGet, directPatchQuery, supabase } from '../supabaseClient.js';

// =============================================================================
// PendingShiftApprovalsCard
//
// Bashaier's queue of accepted shifts that still need her final SUP approval.
// Pulls employee_shifts where status='accepted' AND notified_hr_at IS NULL —
// i.e. the manager dispatched a roster, the staff member acknowledged, and now
// it's sitting waiting for HR to greenlight.
//
// Used to live as an inline panel inside BashaierTasksCard alongside the
// monthly-report drafting workflow ("Reports for Mr John"). That conflated
// two unrelated tasks and made the queue easy to miss. Now it has its own
// Card on the dashboard, sized and styled identically to the surrounding
// "Out of office today" / "Pending requests" / "Upcoming leaves" trio so it
// reads as a peer.
//
// Behaviour:
//   • Auto-hides when the queue is empty (Bashaier never sees a stale 0-state)
//   • Realtime sub on employee_shifts keeps the card live as managers
//     dispatch new rosters and staff accept them
//   • Single "Approve all" action stamps notified_hr_at on every visible row
//     in one round trip — historically Bashaier reviews these in batches,
//     not one-by-one, so per-row approval would just be friction.
// =============================================================================

function fmtDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function PendingShiftApprovalsCard({ employees }) {
  const [acceptedShifts, setAcceptedShifts] = useState([]);
  const [open, setOpen] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState('');

  // Realtime fetch loop. Runs on mount + on any employee_shifts change.
  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      try {
        const rows = await directGet(
          'employee_shifts',
          'select=*&status=eq.accepted&notified_hr_at=is.null&order=shift_date.asc',
          { timeoutMs: 8000 }
        );
        if (mounted) setAcceptedShifts(Array.isArray(rows) ? rows : []);
      } catch {
        if (mounted) setAcceptedShifts([]);
      }
    };
    refresh();
    if (!supabase) return () => { mounted = false; };
    const ch = supabase.channel('hr-pending-shift-approvals')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'employee_shifts' }, refresh)
      .subscribe();
    return () => { mounted = false; try { supabase.removeChannel(ch); } catch {} };
  }, []);

  // Group by employee so a 5-day rotation reads as one row, not five repeats.
  const acceptedByEmployee = useMemo(() => {
    const map = new Map();
    acceptedShifts.forEach(s => {
      const list = map.get(s.employee_id) || [];
      list.push(s);
      map.set(s.employee_id, list);
    });
    const empMap = Object.fromEntries(employees.map(e => [e.id, e]));
    return Array.from(map.entries()).map(([empId, list]) => {
      const dates = list.map(r => r.shift_date).sort();
      return {
        employeeId: empId,
        employeeName: empMap[empId]?.name || 'Unknown',
        managerName: empMap[list[0].set_by]?.name || 'Manager',
        count: list.length,
        firstDate: dates[0],
        lastDate: dates[dates.length - 1],
      };
    }).sort((a, b) => a.firstDate.localeCompare(b.firstDate));
  }, [acceptedShifts, employees]);

  // Approve-all action. Stamps notified_hr_at with the current timestamp on
  // every visible row in one PATCH ... WHERE id IN (...) call. Optimistically
  // empties the local list so the card disappears immediately even before the
  // realtime echo lands.
  const approveAll = async () => {
    if (!acceptedShifts.length || approving) return;
    setApproving(true);
    setError('');
    try {
      const ids = acceptedShifts.map(s => `"${s.id}"`).join(',');
      await directPatchQuery(
        'employee_shifts',
        `id=in.(${ids})`,
        { notified_hr_at: new Date().toISOString() },
        { timeoutMs: 12000 }
      );
      setAcceptedShifts([]);
      setOpen(false);
    } catch (e) {
      setError(e?.message || 'Approval failed. Please try again.');
    } finally {
      setApproving(false);
    }
  };

  // Self-hide when queue is empty.
  if (acceptedShifts.length === 0) return null;

  const subtitle = `${acceptedShifts.length} day${acceptedShifts.length === 1 ? '' : 's'} awaiting your approval`;

  return (
    <Card
      title="Pending shift approvals"
      subtitle={subtitle}
      accent="var(--evergreen-600)"
    >
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 text-left rounded-lg p-2 -m-2 hover:bg-white/40 transition-colors"
      >
        <div
          className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
          style={{ background: 'var(--evergreen-50)', border: '1px solid var(--evergreen-200)', color: 'var(--evergreen-600)' }}
        >
          <CalendarDays className="w-4 h-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
            {acceptedByEmployee.length === 1
              ? `${acceptedByEmployee[0].employeeName.split(' ')[0]} confirmed a new shift schedule`
              : `${acceptedByEmployee.length} staff confirmed new shift schedules`}
          </div>
          <div className="text-[11px]" style={{ color: '#1F1B16' }}>
            Tap to review, then approve as SUP.
          </div>
        </div>
        <ChevronDown
          className="w-4 h-4 flex-shrink-0 transition-transform"
          style={{ color: '#1F1B16', transform: open ? 'rotate(180deg)' : 'none' }}
        />
      </button>

      {open && (
        <div className="mt-3 fade-in">
          <ul className="space-y-2 mb-3">
            {acceptedByEmployee.map(row => (
              <li
                key={row.employeeId}
                className="flex items-center gap-3 rounded border px-3 py-2 bg-white"
                style={{ borderColor: 'var(--border-soft)' }}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                    {row.employeeName}
                  </div>
                  <div className="text-[11px]" style={{ color: '#1F1B16' }}>
                    {row.count} day{row.count === 1 ? '' : 's'} ({fmtDateShort(row.firstDate)}
                    {row.firstDate !== row.lastDate ? ` → ${fmtDateShort(row.lastDate)}` : ''})
                    {' · set by '}{row.managerName.split(' ')[0]}
                  </div>
                </div>
              </li>
            ))}
          </ul>

          {error && (
            <div className="text-xs mb-2" style={{ color: 'var(--clay)' }}>
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px]" style={{ color: '#1F1B16' }}>
              Approving issues final SUP sign-off and notifies the staff.
            </span>
            <button
              type="button"
              onClick={approveAll}
              disabled={approving}
              className="px-3 py-1.5 rounded text-xs flex items-center gap-1.5 text-white transition-opacity"
              style={{
                background: 'var(--evergreen-600)',
                opacity: approving ? 0.5 : 1,
                cursor: approving ? 'not-allowed' : 'pointer',
              }}
            >
              <Check className="w-3.5 h-3.5" />
              {approving ? 'Approving…' : 'Approve all'}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
