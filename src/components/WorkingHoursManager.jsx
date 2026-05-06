// =============================================================================
// WorkingHoursManager.jsx
//
// Bashaier's UI for two related setup-and-operations concerns:
//
//  1. WORKING HOURS  — Mark individual employees as following the
//                      SUP-team schedule (08:00-16:00, no lunch break).
//                      Same field that already drives `scheduleFor()`
//                      in the daily-flow evaluator: writes
//                      `working_hours_group = 'sup_team'` on the
//                      employees row. Setting it to null reverts them
//                      to standard 08:00-17:00.
//
//                      Initial trigger: SAAD ALOTHMAN (H94193) and
//                      MUSAID AL MUAISEB (H94725) start work at 08:00
//                      and finish at 16:00 (no lunch break). This UI
//                      is the way to flip them — and any future
//                      employee with the same hours.
//
//  2. MAWANI VISITS — Log dates when an employee is out of office on
//                      Mawani (Saudi Ports Authority) duty. The
//                      attendance evaluator treats those dates as
//                      'present' regardless of punch times — leaving
//                      early to attend a Mawani visit is not
//                      "early leave."
//
// LAYOUT
//   Collapsible card, mounts in Zone 3 of AttendanceView next to the
//   Historical-backfill panel. Two tabs inside: Working Hours | Mawani
//   Visits. Realtime subscription keeps the lists current.
// =============================================================================

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Clock, Users, Calendar as CalIcon, Plus, X, Save, Trash2,
  ChevronDown, Anchor, AlertCircle, CheckCircle2, Search, Loader2,
} from 'lucide-react';
import {
  directGet,
  directPatch,
  directPost,
  directDelete,
} from '../supabaseClient.js';

// ─── Inline keyframes ────────────────────────────────────────────────
const ANIM_CSS = `
@keyframes whm-pop-in {
  0%   { opacity: 0; transform: translateY(6px) scale(0.96); }
  70%  { opacity: 1; transform: translateY(-2px) scale(1.015); }
  100% { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes whm-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(15, 76, 42, 0.4); }
  50%      { box-shadow: 0 0 0 8px rgba(15, 76, 42, 0); }
}
@keyframes whm-row-in {
  0%   { opacity: 0; transform: translateX(8px); }
  100% { opacity: 1; transform: translateX(0); }
}
`;

// ─── Helpers ─────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

function ymd(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function todayIso() {
  return ymd(new Date());
}

function trimTime(t) {
  if (!t) return '';
  return String(t).slice(0, 5);
}

// =============================================================================

export default function WorkingHoursManager({ me, employees, canEdit }) {
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState('hours');

  return (
    <div
      className="rounded-2xl overflow-hidden relative"
      style={{
        background: 'linear-gradient(135deg, #F0F9F4 0%, #E8F5E9 100%)',
        border: '1px solid #BBDEC0',
        boxShadow: expanded ? '0 8px 24px rgba(15,76,42,0.10)' : '0 1px 2px rgba(0,0,0,0.04)',
        transition: 'box-shadow 0.3s ease',
        fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
      }}
    >
      <style>{ANIM_CSS}</style>

      {/* Decorative corner */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          right: -40, top: -40,
          width: 160, height: 160,
          background: 'radial-gradient(circle at center, rgba(15,76,42,0.18) 0%, transparent 70%)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />

      {/* Header */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-3 relative"
        style={{
          cursor: 'pointer', background: 'transparent', border: 'none',
          padding: '16px 18px', textAlign: 'left', zIndex: 1,
          fontFamily: 'inherit',
        }}
        aria-expanded={expanded}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
            style={{
              background: '#0F4C2A',
              color: '#FFFFFF',
              animation: expanded ? 'none' : 'whm-pulse 2.4s ease-in-out infinite',
            }}
          >
            <Clock className="w-5 h-5" />
          </div>
          <div>
            <div
              className="text-[10px]"
              style={{ color: '#0F4C2A', fontWeight: 700, letterSpacing: '0.22em' }}
            >
              SCHEDULES &amp; DUTY VISITS
            </div>
            <div
              style={{
                fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
                fontSize: 17,
                color: '#1F1B16',
                lineHeight: 1.2,
                fontWeight: 700,
              }}
            >
              Working hours &amp; Mawani visits
            </div>
            <div className="text-[12px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.7 }}>
              Mark staff with non-standard hours and log days they&rsquo;re on Mawani duty.
            </div>
          </div>
        </div>
        <ChevronDown
          className="w-5 h-5 flex-shrink-0"
          style={{
            color: '#0F4C2A',
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1)',
          }}
        />
      </button>

      {expanded && (
        <div
          style={{
            position: 'relative', zIndex: 1,
            padding: '4px 18px 18px',
            borderTop: '1px solid rgba(187,222,192,0.7)',
            animation: 'whm-pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1)',
          }}
        >
          {/* Tabs */}
          <div className="flex gap-1 my-3" role="tablist">
            <TabButton
              active={tab === 'hours'}
              onClick={() => setTab('hours')}
              icon={<Users className="w-3.5 h-3.5" />}
              label="Working hours"
            />
            <TabButton
              active={tab === 'mawani'}
              onClick={() => setTab('mawani')}
              icon={<Anchor className="w-3.5 h-3.5" />}
              label="Mawani visits"
            />
          </div>

          {tab === 'hours' && (
            <WorkingHoursTab me={me} employees={employees} canEdit={canEdit} />
          )}
          {tab === 'mawani' && (
            <MawaniVisitsTab me={me} employees={employees} canEdit={canEdit} />
          )}
        </div>
      )}
    </div>
  );
}

// ─── TabButton ───────────────────────────────────────────────────────
function TabButton({ active, onClick, icon, label }) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px]"
      style={{
        background: active ? '#1F1B16' : 'rgba(255,255,255,0.7)',
        color: active ? '#FFFFFF' : '#1F1B16',
        border: '1px solid ' + (active ? '#1F1B16' : 'rgba(0,0,0,0.1)'),
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        transition: 'all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)',
        fontFamily: 'inherit',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// WORKING HOURS TAB
// ═══════════════════════════════════════════════════════════════════════

function WorkingHoursTab({ me, employees, canEdit }) {
  // Local copy of employees keyed by id, with their working_hours_group.
  // We update this optimistically on save so the row reflects the
  // change immediately.
  const [empMap, setEmpMap] = useState(() => {
    const m = new Map();
    (employees || []).forEach(e => { if (e?.id) m.set(e.id, e); });
    return m;
  });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'); // 'all' | 'sup_team' | 'standard'
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState(null);

  // Refresh from prop changes so realtime updates from elsewhere flow
  // through — AttendanceView already keeps `employees` live.
  useEffect(() => {
    const m = new Map();
    (employees || []).forEach(e => { if (e?.id) m.set(e.id, e); });
    setEmpMap(m);
  }, [employees]);

  const filtered = useMemo(() => {
    const list = Array.from(empMap.values());
    const q = search.trim().toLowerCase();
    return list
      .filter(e => {
        if (filter === 'sup_team' && e.working_hours_group !== 'sup_team') return false;
        if (filter === 'standard' && e.working_hours_group === 'sup_team') return false;
        if (!q) return true;
        return (e.name || '').toLowerCase().includes(q) ||
               (e.id   || '').toLowerCase().includes(q) ||
               (e.department || '').toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // SUP-team first, then alpha by name. Helps Bashaier scan
        // who's already configured.
        const aSup = a.working_hours_group === 'sup_team' ? 0 : 1;
        const bSup = b.working_hours_group === 'sup_team' ? 0 : 1;
        if (aSup !== bSup) return aSup - bSup;
        return (a.name || '').localeCompare(b.name || '');
      });
  }, [empMap, search, filter]);

  const supCount = useMemo(
    () => Array.from(empMap.values()).filter(e => e.working_hours_group === 'sup_team').length,
    [empMap]
  );

  const handleToggle = useCallback(async (emp) => {
    if (!canEdit) return;
    setError(null);
    setSavingId(emp.id);
    const newGroup = emp.working_hours_group === 'sup_team' ? null : 'sup_team';
    try {
      // Update in place — the daily evaluator reads working_hours_group
      // straight off the employees row, so this is the only field we
      // need to touch.
      await directPatch('employees', 'id', emp.id, {
        working_hours_group: newGroup,
      });
      setEmpMap(prev => {
        const next = new Map(prev);
        next.set(emp.id, { ...emp, working_hours_group: newGroup });
        return next;
      });
    } catch (e) {
      setError(`Couldn't update ${emp.name || emp.id}: ${e?.message || e}`);
    } finally {
      setSavingId(null);
    }
  }, [canEdit]);

  return (
    <div>
      {/* Explainer */}
      <div
        className="rounded-xl p-3 mb-3"
        style={{
          background: '#FFFFFF',
          border: '1px solid #BBDEC0',
          fontSize: 12,
          color: '#0A0A0A',
          lineHeight: 1.55,
        }}
      >
        Mark employees who follow the <strong>SUP-team schedule (08:00&ndash;16:00, no lunch break)</strong>.{' '}
        Their attendance is then evaluated against 16:00 finish time instead of the standard 17:00 &mdash;
        leaving at 16:00 won&rsquo;t flag as &ldquo;left early.&rdquo;{' '}
        Currently <strong>{supCount}</strong> employee{supCount === 1 ? '' : 's'} on SUP schedule.
      </div>

      {/* Search + filter */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <div
          className="relative flex-1 min-w-[160px]"
          style={{ minWidth: 160 }}
        >
          <Search
            className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2"
            style={{ color: '#0A0A0A', opacity: 0.5 }}
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, PSN, dept"
            style={{
              width: '100%',
              padding: '7px 10px 7px 28px',
              border: '1px solid #D4D4D4',
              borderRadius: 8,
              fontSize: 12,
              fontFamily: 'inherit',
              background: '#FFFFFF',
            }}
          />
        </div>
        <FilterPill
          active={filter === 'all'}
          onClick={() => setFilter('all')}
          label="All"
        />
        <FilterPill
          active={filter === 'sup_team'}
          onClick={() => setFilter('sup_team')}
          label={`SUP (${supCount})`}
          tone="green"
        />
        <FilterPill
          active={filter === 'standard'}
          onClick={() => setFilter('standard')}
          label="Standard"
        />
      </div>

      {error && (
        <div
          className="rounded-lg p-2.5 mb-3 inline-flex items-start gap-2"
          style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B', fontSize: 12 }}
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* List */}
      <div
        style={{
          background: '#FFFFFF',
          border: '1px solid #E5E5E5',
          borderRadius: 10,
          overflow: 'hidden',
          maxHeight: 420,
          overflowY: 'auto',
        }}
      >
        {filtered.length === 0 ? (
          <div className="p-5 text-center" style={{ color: '#0A0A0A', opacity: 0.55, fontSize: 13 }}>
            No matching employees.
          </div>
        ) : (
          filtered.map((emp, i) => {
            const isSup = emp.working_hours_group === 'sup_team';
            const saving = savingId === emp.id;
            return (
              <div
                key={emp.id}
                style={{
                  padding: '10px 12px',
                  borderTop: i === 0 ? 'none' : '1px solid #F0F0F0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  animation: `whm-row-in 0.3s ease-out ${Math.min(i * 8, 200)}ms both`,
                  background: isSup ? 'rgba(15,76,42,0.025)' : '#FFFFFF',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-[13px]" style={{ color: '#1F1B16', fontWeight: 600 }}>
                    {emp.name || emp.id}
                  </div>
                  <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.65 }}>
                    {emp.id}
                    {emp.department ? ` · ${emp.department}` : ''}
                    {emp.location ? ` · ${emp.location}` : ''}
                  </div>
                </div>
                {/* Hours pill */}
                <div
                  style={{
                    fontSize: 11,
                    padding: '3px 9px',
                    borderRadius: 999,
                    fontWeight: 700,
                    background: isSup ? '#ECFDF5' : '#F5F5F5',
                    color:      isSup ? '#0F4C2A' : '#525252',
                    border: '1px solid ' + (isSup ? '#A7F3D0' : '#D4D4D4'),
                    whiteSpace: 'nowrap',
                  }}
                >
                  {isSup ? '08:00–16:00' : '08:00–17:00'}
                </div>
                {canEdit && (
                  <button
                    onClick={() => handleToggle(emp)}
                    disabled={saving}
                    className="text-[11px] px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
                    style={{
                      background: isSup ? '#FFFFFF' : '#0F4C2A',
                      color:      isSup ? '#0F4C2A' : '#FFFFFF',
                      border: '1px solid ' + (isSup ? '#BBDEC0' : '#0F4C2A'),
                      fontWeight: 700,
                      cursor: saving ? 'wait' : 'pointer',
                      opacity: saving ? 0.6 : 1,
                      fontFamily: 'inherit',
                      transition: 'all 0.18s cubic-bezier(0.34, 1.56, 0.64, 1)',
                    }}
                  >
                    {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                    {isSup ? 'Revert to standard' : 'Mark SUP'}
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ─── FilterPill ──────────────────────────────────────────────────────
function FilterPill({ active, onClick, label, tone }) {
  const greenActive = tone === 'green' && active;
  return (
    <button
      onClick={onClick}
      className="text-[11px] px-3 py-1.5 rounded-full"
      style={{
        background: greenActive ? '#0F4C2A' : (active ? '#1F1B16' : '#FFFFFF'),
        color:      (active) ? '#FFFFFF' : '#0A0A0A',
        border: '1px solid ' + (active ? (greenActive ? '#0F4C2A' : '#1F1B16') : '#D4D4D4'),
        fontWeight: active ? 700 : 500,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MAWANI VISITS TAB
// ═══════════════════════════════════════════════════════════════════════

function MawaniVisitsTab({ me, employees, canEdit }) {
  const [visits, setVisits] = useState(null);  // null = loading
  const [error, setError]   = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState('upcoming'); // 'upcoming' | 'past' | 'all'

  // Fetch visits — restrict to ~last 90 days + future for the UI.
  // Keeps the list manageable even after months of usage.
  const fetchVisits = useCallback(async () => {
    setError(null);
    try {
      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const data = await directGet(
        'mawani_visits',
        `select=id,employee_id,visit_date,planned_start,planned_end,purpose,status,notes,created_at,created_by` +
        `&visit_date=gte.${ymd(ninetyDaysAgo)}` +
        `&order=visit_date.desc`,
        { timeoutMs: 12000 }
      );
      setVisits(data || []);
    } catch (e) {
      setError(`Couldn't load Mawani visits: ${e?.message || e}`);
      setVisits([]);
    }
  }, []);

  useEffect(() => {
    fetchVisits();
  }, [fetchVisits]);

  const empMap = useMemo(() => {
    const m = new Map();
    (employees || []).forEach(e => { if (e?.id) m.set(e.id, e); });
    return m;
  }, [employees]);

  const today = todayIso();
  const filteredVisits = useMemo(() => {
    if (!visits) return [];
    return visits.filter(v => {
      if (v.status === 'cancelled' && filter !== 'all') return false;
      if (filter === 'upcoming') return v.visit_date >= today;
      if (filter === 'past')     return v.visit_date <  today;
      return true;
    });
  }, [visits, filter, today]);

  const handleAdded = useCallback(() => {
    setShowAdd(false);
    fetchVisits();
  }, [fetchVisits]);

  const handleCancel = useCallback(async (v) => {
    if (!canEdit) return;
    if (!confirm(`Cancel Mawani visit for ${empMap.get(v.employee_id)?.name || v.employee_id} on ${fmtDate(v.visit_date)}?`)) return;
    try {
      await directPatch('mawani_visits', 'id', v.id, {
        status: 'cancelled',
        updated_at: new Date().toISOString(),
        updated_by: me?.id || null,
      });
      fetchVisits();
    } catch (e) {
      setError(`Couldn't cancel: ${e?.message || e}`);
    }
  }, [canEdit, empMap, me?.id, fetchVisits]);

  const handleDelete = useCallback(async (v) => {
    if (!canEdit) return;
    if (!confirm(`Delete this Mawani visit record permanently? This can't be undone.`)) return;
    try {
      await directDelete('mawani_visits', `id=eq.${encodeURIComponent(v.id)}`);
      fetchVisits();
    } catch (e) {
      setError(`Couldn't delete: ${e?.message || e}`);
    }
  }, [canEdit, fetchVisits]);

  return (
    <div>
      {/* Explainer */}
      <div
        className="rounded-xl p-3 mb-3"
        style={{
          background: '#FFFFFF',
          border: '1px solid #BBDEC0',
          fontSize: 12,
          color: '#0A0A0A',
          lineHeight: 1.55,
        }}
      >
        Log dates when staff are out on Mawani (Saudi Ports Authority) duty. The attendance evaluator
        treats logged dates as &lsquo;present&rsquo; regardless of punch-in/out times &mdash; leaving the
        office for a Mawani visit isn&rsquo;t early leave. Optional time window narrows the visit to a partial day.
      </div>

      {/* Filter + Add */}
      <div className="flex items-center gap-2 mb-3 flex-wrap">
        <FilterPill active={filter === 'upcoming'} onClick={() => setFilter('upcoming')} label="Upcoming" />
        <FilterPill active={filter === 'past'}     onClick={() => setFilter('past')}     label="Past 90 days" />
        <FilterPill active={filter === 'all'}      onClick={() => setFilter('all')}      label="All" />
        <div style={{ flex: 1 }} />
        {canEdit && !showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            className="text-[12px] px-3.5 py-2 rounded-full inline-flex items-center gap-1.5"
            style={{
              background: '#0F4C2A',
              color: '#FFFFFF',
              border: 'none',
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 2px 6px rgba(15,76,42,0.18)',
              fontFamily: 'inherit',
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            Add visit
          </button>
        )}
      </div>

      {showAdd && (
        <AddMawaniVisit
          me={me}
          employees={employees}
          onSaved={handleAdded}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {error && (
        <div
          className="rounded-lg p-2.5 mb-3 inline-flex items-start gap-2"
          style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B', fontSize: 12 }}
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* Visits list */}
      {visits === null ? (
        <div className="flex items-center gap-2 py-6 justify-center text-sm" style={{ color: '#0A0A0A', opacity: 0.6 }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading visits…
        </div>
      ) : filteredVisits.length === 0 ? (
        <div
          className="rounded-xl p-5 text-center"
          style={{ background: '#FFFFFF', border: '1px dashed #BBDEC0', color: '#0A0A0A', opacity: 0.65 }}
        >
          <Anchor className="w-6 h-6 mx-auto mb-2" />
          <div className="text-[13px]">No Mawani visits in this view.</div>
          {canEdit && filter === 'upcoming' && (
            <div className="text-[11px] mt-1">Click &ldquo;Add visit&rdquo; to log one.</div>
          )}
        </div>
      ) : (
        <div
          style={{
            background: '#FFFFFF',
            border: '1px solid #E5E5E5',
            borderRadius: 10,
            overflow: 'hidden',
            maxHeight: 420,
            overflowY: 'auto',
          }}
        >
          {filteredVisits.map((v, i) => {
            const emp = empMap.get(v.employee_id);
            const isPast = v.visit_date < today;
            const cancelled = v.status === 'cancelled';
            const window = (v.planned_start || v.planned_end)
              ? `${trimTime(v.planned_start) || '?'} \u2192 ${trimTime(v.planned_end) || '?'}`
              : 'Full day';
            return (
              <div
                key={v.id}
                style={{
                  padding: '10px 12px',
                  borderTop: i === 0 ? 'none' : '1px solid #F0F0F0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  opacity: cancelled ? 0.55 : 1,
                  background: !isPast && !cancelled ? 'rgba(15,76,42,0.025)' : '#FFFFFF',
                  animation: `whm-row-in 0.3s ease-out ${Math.min(i * 8, 200)}ms both`,
                }}
              >
                <div
                  className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                  style={{
                    background: cancelled ? '#F5F5F5' : '#ECFDF5',
                    color:      cancelled ? '#737373' : '#0F4C2A',
                    border: '1px solid ' + (cancelled ? '#D4D4D4' : '#A7F3D0'),
                  }}
                >
                  <Anchor className="w-4 h-4" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="text-[13px]" style={{ color: '#1F1B16', fontWeight: 600 }}>
                    {emp?.name || v.employee_id}
                    {cancelled && (
                      <span style={{
                        marginLeft: 8, fontSize: 10, padding: '1px 6px',
                        borderRadius: 999, background: '#F5F5F5', color: '#525252',
                        fontWeight: 700, letterSpacing: '0.06em',
                      }}>
                        CANCELLED
                      </span>
                    )}
                    {!cancelled && !isPast && (
                      <span style={{
                        marginLeft: 8, fontSize: 10, padding: '1px 6px',
                        borderRadius: 999, background: '#ECFDF5', color: '#0F4C2A',
                        fontWeight: 700, letterSpacing: '0.06em',
                      }}>
                        UPCOMING
                      </span>
                    )}
                  </div>
                  <div className="text-[11px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
                    {fmtDate(v.visit_date)} · {window}
                    {v.purpose && <span> · {v.purpose}</span>}
                  </div>
                  {v.notes && (
                    <div className="text-[11px] mt-0.5" style={{ color: '#0A0A0A', opacity: 0.55, fontStyle: 'italic' }}>
                      &ldquo;{v.notes}&rdquo;
                    </div>
                  )}
                </div>
                {canEdit && !cancelled && (
                  <button
                    onClick={() => handleCancel(v)}
                    title="Mark as cancelled"
                    className="text-[11px] px-2.5 py-1 rounded-full"
                    style={{
                      background: '#FFFFFF',
                      color: '#854F0B',
                      border: '1px solid #FCD34D',
                      fontWeight: 600,
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                    }}
                  >
                    Cancel
                  </button>
                )}
                {canEdit && (
                  <button
                    onClick={() => handleDelete(v)}
                    title="Delete record"
                    className="w-7 h-7 rounded-full flex items-center justify-center"
                    style={{
                      background: '#FFFFFF',
                      color: '#991B1B',
                      border: '1px solid #FCA5A5',
                      cursor: 'pointer',
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── AddMawaniVisit ──────────────────────────────────────────────────
function AddMawaniVisit({ me, employees, onSaved, onCancel }) {
  const [employeeId, setEmployeeId]   = useState('');
  const [visitDate, setVisitDate]     = useState(todayIso());
  const [plannedStart, setPlannedStart] = useState('');
  const [plannedEnd, setPlannedEnd]   = useState('');
  const [purpose, setPurpose]         = useState('');
  const [notes, setNotes]             = useState('');
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState(null);

  // Suggest "scheduled" employees first — those with working_hours_group
  // = 'sup_team' (Mawani is most common for those staff). The dropdown
  // still shows everyone, just sorted with SUP staff at the top.
  const sortedEmps = useMemo(() => {
    return [...(employees || [])].sort((a, b) => {
      const aSup = a.working_hours_group === 'sup_team' ? 0 : 1;
      const bSup = b.working_hours_group === 'sup_team' ? 0 : 1;
      if (aSup !== bSup) return aSup - bSup;
      return (a.name || '').localeCompare(b.name || '');
    });
  }, [employees]);

  const submit = useCallback(async () => {
    setErr(null);
    if (!employeeId) { setErr('Pick an employee.'); return; }
    if (!visitDate)  { setErr('Pick a visit date.'); return; }
    // Time-window sanity check
    if (plannedStart && plannedEnd && plannedStart >= plannedEnd) {
      setErr('Start time must be before end time.');
      return;
    }
    setSaving(true);
    try {
      await directPost('mawani_visits', {
        employee_id:  employeeId,
        visit_date:   visitDate,
        planned_start: plannedStart || null,
        planned_end:   plannedEnd   || null,
        purpose:      purpose.trim() || null,
        notes:        notes.trim()   || null,
        status:       'planned',
        created_by:   me?.id || null,
      });
      onSaved?.();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  }, [employeeId, visitDate, plannedStart, plannedEnd, purpose, notes, me?.id, onSaved]);

  return (
    <div
      className="rounded-xl p-4 mb-3"
      style={{
        background: '#FFFFFF',
        border: '1.5px solid #0F4C2A',
        animation: 'whm-pop-in 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)',
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <div
          style={{
            fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
            fontSize: 15,
            color: '#1F1B16',
            fontWeight: 700,
          }}
        >
          Log Mawani visit
        </div>
        <button
          onClick={onCancel}
          aria-label="Close"
          className="w-7 h-7 rounded-full flex items-center justify-center"
          style={{ background: '#F5F5F5', border: 'none', cursor: 'pointer', color: '#0A0A0A' }}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField label="Employee">
          <select
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
            style={selectStyle}
          >
            <option value="">— Select —</option>
            {sortedEmps.map(e => (
              <option key={e.id} value={e.id}>
                {e.name || e.id} ({e.id})
                {e.working_hours_group === 'sup_team' ? ' · SUP' : ''}
              </option>
            ))}
          </select>
        </FormField>
        <FormField label="Visit date">
          <input
            type="date"
            value={visitDate}
            onChange={(e) => setVisitDate(e.target.value)}
            style={inputStyle}
          />
        </FormField>
        <FormField label="Start time (optional)">
          <input
            type="time"
            value={plannedStart}
            onChange={(e) => setPlannedStart(e.target.value)}
            style={inputStyle}
          />
        </FormField>
        <FormField label="End time (optional)">
          <input
            type="time"
            value={plannedEnd}
            onChange={(e) => setPlannedEnd(e.target.value)}
            style={inputStyle}
          />
        </FormField>
        <FormField label="Purpose (optional)" full>
          <input
            type="text"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            placeholder="e.g. Container clearance, Customs follow-up"
            style={inputStyle}
            maxLength={200}
          />
        </FormField>
        <FormField label="Notes (optional)" full>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            style={{ ...inputStyle, resize: 'vertical', minHeight: 50 }}
            maxLength={500}
          />
        </FormField>
      </div>

      {err && (
        <div
          className="rounded-lg p-2 mt-3 inline-flex items-start gap-2"
          style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B', fontSize: 12 }}
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <span>{err}</span>
        </div>
      )}

      <div className="flex items-center gap-2 mt-3">
        <button
          onClick={submit}
          disabled={saving}
          className="text-[12px] px-4 py-2 rounded-full inline-flex items-center gap-1.5"
          style={{
            background: '#0F4C2A',
            color: '#FFFFFF',
            border: 'none',
            fontWeight: 700,
            cursor: saving ? 'wait' : 'pointer',
            opacity: saving ? 0.6 : 1,
            boxShadow: '0 2px 6px rgba(15,76,42,0.18)',
            fontFamily: 'inherit',
          }}
        >
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
          Save visit
        </button>
        <button
          onClick={onCancel}
          className="text-[12px] px-3 py-2 rounded-full"
          style={{
            background: '#FFFFFF',
            color: '#0A0A0A',
            border: '1px solid #D4D4D4',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── FormField ──────────────────────────────────────────────────────
function FormField({ label, children, full }) {
  return (
    <div style={{ gridColumn: full ? '1 / -1' : 'auto' }}>
      <div
        className="text-[10px] mb-1"
        style={{ color: '#0F4C2A', fontWeight: 700, letterSpacing: '0.16em' }}
      >
        {label.toUpperCase()}
      </div>
      {children}
    </div>
  );
}

const inputStyle = {
  width: '100%',
  padding: '7px 10px',
  border: '1px solid #D4D4D4',
  borderRadius: 8,
  fontSize: 13,
  fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
  background: '#FFFFFF',
};

const selectStyle = {
  ...inputStyle,
  cursor: 'pointer',
};
