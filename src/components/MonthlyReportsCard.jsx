import React, { useMemo, useState, useCallback } from 'react';
import { CheckCircle2, AlertCircle, Circle, FileText, ChevronDown, ChevronRight } from 'lucide-react';

// =============================================================================
// MonthlyReportsCard
//
// Replaces the old login-reminder popup (🧚) with a calm, persistent surface
// that lives in the Reviews tab. Per Nadeem 2026-05-17: 'remove the reminder
// on login, just put it in review tab'.
//
// THE THREE TASKS
//   1. Mid-month permissions report — due 15th of each month
//   2. End-of-month permissions report — due last day of month
//   3. Last-month vacation summary — due 1st, available through 7th
//
// STATE PERSISTENCE
//   Uses the same localStorage keys the old popup used so a 'Mark sent'
//   click on this card hides the same task that 'I've sent it' did on the
//   popup, and vice-versa. Migration is silent — no data wipe.
//
//     esau_taskdone_<key>_<YYYY-MM>    — set when Bashaier marks done
//     esau_tasksnooze_<key>_<YYYY-MM-DD> — set on snooze (one-day suppress)
//
//   Snooze is preserved for backward compat but no longer has any UI
//   trigger on this card — the whole point of the move is to drop the
//   anxious 'snooze me' interaction.
//
// STATUS LADDER
//   not_yet_due — show as a muted future task, no action
//   due_today   — show as actionable (amber pill)
//   overdue     — same as due_today but red pill
//   sent        — collapsed by default with a green check
//
// All three tasks render in the same card; default-open if any is
// actionable (due_today or overdue) so Bashaier sees them first on entry.
// =============================================================================

function todayInfo() {
  const today = new Date();
  const day = today.getDate();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;
  const lastDay = new Date(year, month, 0).getDate();
  const monthKey = `${year}-${String(month).padStart(2, '0')}`;
  const dayKey   = `${monthKey}-${String(day).padStart(2, '0')}`;
  return { day, year, month, lastDay, monthKey, dayKey };
}

// Predicates kept in sync with the old popup logic (lines 203-222 of
// the old Dashboard.jsx). If a future quarter adds a new monthly
// report, register it here and the card picks it up automatically.
function buildTasks() {
  const { day, lastDay } = todayInfo();
  return [
    {
      key: 'mid_month_perms',
      title: 'Mid-month permissions report',
      subtitle: 'Send the 1–15 update to Mr John',
      dueLabel: '15th of the month',
      isDue: day >= 15,                  // due 15th, overdue after
    },
    {
      key: 'end_of_month_perms',
      title: 'End-of-month permissions report',
      subtitle: 'Send the full month permissions report to Mr John',
      dueLabel: 'last day of the month',
      isDue: day >= lastDay,             // due last day of month
    },
    {
      key: 'last_month_vacation',
      title: 'Last-month vacation summary',
      subtitle: 'Send last month\'s staff vacations report to Mr John',
      dueLabel: '1st of the month (through the 7th)',
      isDue: day >= 1 && day <= 7,       // due 1st, valid through 7th
    },
  ];
}

function statusFor(task, monthKey) {
  const sent = typeof window !== 'undefined' &&
    window.localStorage?.getItem(`esau_taskdone_${task.key}_${monthKey}`);
  if (sent) return 'sent';
  if (!task.isDue) return 'not_yet_due';
  // 'Overdue' means today is past the canonical due date AND the report
  // isn't marked sent. Mid-month: any day after 15. End-of-month: only
  // applies on the last day itself, so 'due_today' (no overdue state).
  // Vacation: through the 7th so day 8+ would be overdue, but at that
  // point the task is no longer surfaced this month at all (isDue=false).
  const { day } = todayInfo();
  if (task.key === 'mid_month_perms'    && day > 15) return 'overdue';
  if (task.key === 'last_month_vacation' && day > 7) return 'overdue';
  return 'due_today';
}

const STATUS_META = {
  sent:        { fg: '#0F4C2A', bg: '#ECFDF5', border: '#86EFAC', label: 'SENT',     Icon: CheckCircle2 },
  due_today:   { fg: '#92400E', bg: '#FEF3C7', border: '#FCD34D', label: 'DUE TODAY', Icon: AlertCircle },
  overdue:     { fg: '#7F1D1D', bg: '#FEE2E2', border: '#FCA5A5', label: 'OVERDUE',  Icon: AlertCircle },
  not_yet_due: { fg: '#1F1B16', bg: '#FCFCF9', border: '#E5E5E5', label: 'UPCOMING', Icon: Circle },
};

export default function MonthlyReportsCard() {
  const { monthKey } = todayInfo();
  // Re-render bump for after we write to localStorage — React doesn't
  // observe localStorage so we need to force a recomputation of
  // statuses. tick changes are cheap.
  const [tick, setTick] = useState(0);

  const tasks = useMemo(() => buildTasks(), []);
  const rows = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    void tick;
    return tasks.map(t => ({ ...t, status: statusFor(t, monthKey) }));
  }, [tasks, monthKey, tick]);

  // Open by default if anything is actionable, so Bashaier sees the
  // alert on entry. Otherwise collapse to keep the Reviews tab calm.
  const hasAction = rows.some(r => r.status === 'due_today' || r.status === 'overdue');
  const [open, setOpen] = useState(hasAction);

  const markSent = useCallback((key) => {
    try {
      window.localStorage.setItem(
        `esau_taskdone_${key}_${monthKey}`,
        new Date().toISOString(),
      );
      setTick(t => t + 1);
    } catch {/* localStorage may be disabled — ignore */}
  }, [monthKey]);

  const undoSent = useCallback((key) => {
    try {
      window.localStorage.removeItem(`esau_taskdone_${key}_${monthKey}`);
      setTick(t => t + 1);
    } catch {/* ignore */}
  }, [monthKey]);

  const actionableCount = rows.filter(r => r.status === 'due_today' || r.status === 'overdue').length;

  return (
    <div className="rounded-xl border esau-card"
      style={{ background: '#FFFFFF', borderColor: 'var(--border-soft)' }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 border-b"
        style={{ borderColor: '#F4F4EE', background: 'transparent' }}
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="w-3.5 h-3.5" style={{ color: '#1F1B16' }}/>
                : <ChevronRight className="w-3.5 h-3.5" style={{ color: '#1F1B16' }}/>}
          <FileText className="w-4 h-4" style={{ color: actionableCount > 0 ? '#92400E' : '#0F4C2A' }} />
          <span className="text-[10px] tracking-[0.22em]" style={{ fontWeight: 700, color: '#1F1B16' }}>
            MONTHLY REPORTS · MR JOHN
          </span>
          {actionableCount > 0 && (
            <span style={{ background: '#FEF3C7', color: '#92400E', padding: '1px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700 }}>
              {actionableCount} due
            </span>
          )}
        </div>
        <span className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.55 }}>
          {actionableCount === 0 ? 'all clear this month' : 'click to expand'}
        </span>
      </button>

      {open && (
        <div className="px-4 py-3 space-y-2">
          {rows.map(r => {
            const meta = STATUS_META[r.status];
            const Icon = meta.Icon;
            const isSent = r.status === 'sent';
            return (
              <div key={r.key}
                className="rounded-lg border p-3 flex items-center gap-3"
                style={{
                  borderColor: meta.border,
                  background: isSent ? '#FCFCF9' : meta.bg,
                  opacity: r.status === 'not_yet_due' ? 0.75 : 1,
                }}>
                <Icon className="w-4 h-4 flex-shrink-0" style={{ color: meta.fg }}/>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px]" style={{ color: '#1F1B16', fontWeight: 600 }}>
                    {r.title}
                  </div>
                  <div className="text-[11px]" style={{ color: '#1F1B16', opacity: 0.75 }}>
                    {r.subtitle} · due {r.dueLabel}
                  </div>
                </div>
                <span style={{
                  background: meta.bg, color: meta.fg, border: `1px solid ${meta.border}`,
                  padding: '2px 8px', borderRadius: 999, fontSize: 9,
                  fontWeight: 700, letterSpacing: '0.06em', whiteSpace: 'nowrap',
                }}>
                  {meta.label}
                </span>
                {isSent ? (
                  <button
                    type="button"
                    onClick={() => undoSent(r.key)}
                    className="text-[10px] px-2 py-1 rounded-full border"
                    style={{ borderColor: '#E5E5E5', color: '#1F1B16', background: '#FFFFFF' }}
                  >
                    Undo
                  </button>
                ) : r.status === 'due_today' || r.status === 'overdue' ? (
                  <button
                    type="button"
                    onClick={() => markSent(r.key)}
                    className="text-[10px] px-3 py-1.5 rounded-full font-semibold"
                    style={{
                      background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)',
                      color: '#fff', border: 'none',
                    }}
                  >
                    ✓ Mark sent
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
