// ──────────────────────────────────────────────────────────────────────
//  HolidayShiftDefaultersCard
//
//  Surfaces holiday-shift defaulters for the date Bashaier is viewing
//  in AttendanceView. Sits alongside the existing late/early/missed
//  tiles but reads from holiday_shifts (not the normal 8-5 schedule)
//  so Eid OT compliance is visible at upload time.
//
//  Strict comparison (Nadeem 2026-05-21 — no grace period for OT):
//    late_minutes  = max(0, actual_in  − scheduled_in)
//    early_minutes = max(0, scheduled_out − actual_out)
//    no_show       = first_punch IS NULL
//
//  Renders nothing if the viewed date has no approved holiday shifts —
//  zero visual noise on normal working days.
//
//  Read-only / query-time only: no DB writes, no violation rows
//  created. Reflects the latest state of both holiday_shifts AND
//  attendance_daily every time the card mounts. Safe to re-render
//  after a re-upload — auto-refreshes its comparison.
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useEffect, useMemo } from 'react';
import { directGet } from '../supabaseClient.js';
import {
  CalendarDays, ChevronDown, ChevronRight, Loader2, AlertCircle,
  CheckCircle2, AlertTriangle, MinusCircle, Clock,
} from 'lucide-react';

const STATUS = {
  on_time:   { bg: '#D1FAE5', fg: '#065F46', label: 'ON TIME',   Icon: CheckCircle2 },
  deviation: { bg: '#FEF3C7', fg: '#854F0B', label: 'DEVIATION', Icon: AlertTriangle },
  no_show:   { bg: '#FEE2E2', fg: '#991B1B', label: 'NO SHOW',   Icon: MinusCircle  },
};

const fmtTime = (t) => t ? String(t).slice(0, 5) : '—';
const toMins  = (t) => {
  if (!t) return null;
  const [h, m] = String(t).split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

export default function HolidayShiftDefaultersCard({ csvDate, empById = {} }) {
  const [period, setPeriod]   = useState(null);
  const [shifts, setShifts]   = useState([]);
  const [punches, setPunches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState(null);
  const [expanded, setExpanded] = useState(false);

  // Load the holiday_period covering csvDate (if any), then its
  // approved shifts for that exact date, then matching attendance_daily.
  useEffect(() => {
    if (!csvDate) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setErr(null);
      try {
        // 1) Period covering the viewed date
        const periodRows = await directGet('holiday_periods',
          `select=*&is_active=eq.true`
          + `&start_date=lte.${csvDate}&end_date=gte.${csvDate}`
          + `&limit=1`,
          { timeoutMs: 8000 });
        const p = (periodRows || [])[0] || null;
        if (cancelled) return;
        setPeriod(p);
        if (!p) {
          setShifts([]); setPunches([]); setLoading(false);
          return;
        }
        // 2) Approved shifts on this date
        const sRows = await directGet('holiday_shifts',
          `select=*&holiday_period_id=eq.${p.id}`
          + `&shift_date=eq.${csvDate}&status=eq.approved`,
          { timeoutMs: 8000 });
        const sh = sRows || [];
        if (cancelled) return;
        setShifts(sh);
        if (sh.length === 0) {
          setPunches([]); setLoading(false);
          return;
        }
        // 3) Matching attendance for these PSNs on this date
        const psns = [...new Set(sh.map(s => s.employee_id))]
          .map(p => `"${p}"`).join(',');
        const aRows = await directGet('attendance_daily',
          `select=employee_id,first_punch,last_punch,punch_count,status`
          + `&employee_id=in.(${psns})`
          + `&attendance_date=eq.${csvDate}`
          + `&limit=200`,
          { timeoutMs: 8000 });
        if (!cancelled) setPunches(aRows || []);
      } catch (e) {
        if (!cancelled) setErr(e?.message || 'Failed to load holiday compliance');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [csvDate]);

  // Compute per-shift defaulter rows
  const rows = useMemo(() => {
    return shifts.map(s => {
      const att = punches.find(a => a.employee_id === s.employee_id);
      const schedIn  = toMins(s.clock_in_time);
      const schedOut = toMins(s.clock_out_time);
      const actIn    = toMins(att?.first_punch);
      const actOut   = toMins(att?.last_punch);
      const noShow   = actIn == null;
      const late     = !noShow ? Math.max(0, actIn  - schedIn)   : 0;
      const earlyOut = !noShow && actOut != null
                        ? Math.max(0, schedOut - actOut) : 0;
      return {
        shift: s,
        emp: empById[s.employee_id] || { id: s.employee_id, name: s.employee_id },
        actual_in:  att?.first_punch || null,
        actual_out: att?.last_punch || null,
        late_minutes:  late,
        early_minutes: earlyOut,
        no_show: noShow,
        status: noShow ? 'no_show'
              : (late === 0 && earlyOut === 0) ? 'on_time'
              : 'deviation',
      };
    });
  }, [shifts, punches, empById]);

  const summary = useMemo(() => ({
    total:     rows.length,
    onTime:    rows.filter(r => r.status === 'on_time').length,
    deviation: rows.filter(r => r.status === 'deviation').length,
    noShow:    rows.filter(r => r.no_show).length,
  }), [rows]);

  const defaulters = summary.deviation + summary.noShow;

  // Don't render anything on dates without a holiday period
  if (!period && !loading) return null;

  // Derive a clean section label from the period name
  // e.g. 'Eid Al Adha 2026' → 'EID AL ADHA'
  const sectionLabel = period
    ? period.name.replace(/\s+\d{4}\s*$/, '').toUpperCase()
    : 'HOLIDAY OT';

  return (
    <div className="rounded-xl border" style={{
      borderColor: defaulters > 0 ? '#FCD34D' : 'rgba(0,0,0,0.08)',
      background: defaulters > 0 ? '#FFFBEB' : '#FFFFFF',
    }}>
      {/* Tile header — click to expand */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left"
        disabled={loading || rows.length === 0}
      >
        <div className="flex items-center gap-2">
          {expanded ? <ChevronDown size={14} style={{ color: '#1F1B16', opacity: 0.6 }} />
                    : <ChevronRight size={14} style={{ color: '#1F1B16', opacity: 0.6 }} />}
          <CalendarDays size={16} style={{ color: '#A16207' }} />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] tracking-[0.25em] font-bold" style={{ color: '#0A0A0A' }}>
                {sectionLabel}
              </span>
              {period && (
                <span className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.6 }}>
                  · {period.name}
                </span>
              )}
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.65 }}>
              {loading ? 'Loading…'
               : rows.length === 0
                 ? 'No staff assigned for this date.'
                 : `${rows.length} scheduled · ${defaulters} defaulter${defaulters === 1 ? '' : 's'} · ${summary.onTime} on time`}
            </div>
          </div>
        </div>
        {/* Count chips */}
        <div className="flex items-center gap-1">
          {loading && <Loader2 size={12} className="animate-spin" style={{ color: '#1F1B16', opacity: 0.5 }} />}
          {summary.noShow > 0 && (
            <CountPill bg="#FEE2E2" fg="#991B1B" label="NO SHOW" count={summary.noShow} />
          )}
          {summary.deviation > 0 && (
            <CountPill bg="#FEF3C7" fg="#854F0B" label="DEVIATION" count={summary.deviation} />
          )}
          {summary.onTime > 0 && (
            <CountPill bg="#D1FAE5" fg="#065F46" label="ON TIME" count={summary.onTime} />
          )}
        </div>
      </button>

      {/* Expanded body */}
      {expanded && rows.length > 0 && (
        <div className="border-t" style={{ borderColor: 'rgba(0,0,0,0.06)' }}>
          {err && (
            <div className="flex items-center gap-2 m-3 text-xs rounded px-3 py-2"
                 style={{ background: '#FEF2F2', color: '#991B1B' }}>
              <AlertCircle size={12} /> {err}
            </div>
          )}
          <div className="divide-y" style={{ borderColor: 'rgba(0,0,0,0.05)' }}>
            {/* Surface defaulters first, then on-time */}
            {[...rows]
              .sort((a, b) => {
                const order = { no_show: 0, deviation: 1, on_time: 2 };
                return order[a.status] - order[b.status];
              })
              .map(r => <DefaulterRow key={r.shift.id} row={r} />)}
          </div>
          <div className="px-4 py-2 text-[10px] border-t"
               style={{ borderColor: 'rgba(0,0,0,0.06)', color: '#1F1B16', opacity: 0.55 }}>
            Strict comparison · no grace period · holiday OT pay applies to actual worked time
          </div>
        </div>
      )}
    </div>
  );
}

function CountPill({ bg, fg, label, count }) {
  return (
    <span className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded"
          style={{ background: bg, color: fg, letterSpacing: '0.04em' }}
          title={`${count} ${label.toLowerCase()}`}>
      {label} · {count}
    </span>
  );
}

function DefaulterRow({ row }) {
  const s = STATUS[row.status];
  const Icon = s.Icon;
  return (
    <div className="px-4 py-2 flex items-center gap-3 text-sm"
         style={{ borderTop: '1px solid rgba(0,0,0,0.05)' }}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate" style={{ color: '#1F1B16' }}>
            {row.emp.name || row.emp.id}
          </span>
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-bold text-[9px]"
                style={{ background: s.bg, color: s.fg, letterSpacing: '0.04em' }}>
            <Icon size={9} /> {s.label}
          </span>
          <span className="text-[10px]" style={{ color: '#1F1B16', opacity: 0.5 }}>
            {row.emp.id} · {row.emp.department || ''}
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5 text-xs font-mono"
             style={{ color: '#1F1B16', opacity: 0.75 }}>
          <Clock size={11} />
          <span>Sched {fmtTime(row.shift.clock_in_time)}–{fmtTime(row.shift.clock_out_time)}</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>
            Actual{' '}
            {row.no_show
              ? <span style={{ color: '#991B1B' }}>—</span>
              : `${fmtTime(row.actual_in)}–${fmtTime(row.actual_out)}`}
          </span>
          {row.late_minutes > 0 && (
            <span style={{ color: '#B45309', fontWeight: 700 }}>
              · LATE {row.late_minutes}m
            </span>
          )}
          {row.early_minutes > 0 && (
            <span style={{ color: '#B45309', fontWeight: 700 }}>
              · EARLY OUT {row.early_minutes}m
            </span>
          )}
        </div>
        {row.shift.notes && (
          <p className="text-[10px] mt-0.5 italic" style={{ color: '#1F1B16', opacity: 0.5 }}>
            {row.shift.notes}
          </p>
        )}
      </div>
    </div>
  );
}
