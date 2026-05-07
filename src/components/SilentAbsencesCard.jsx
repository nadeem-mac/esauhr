import React, { useState } from 'react';
import { ChevronDown, ChevronRight, UserX, Plane, MapPin } from 'lucide-react';

// =============================================================================
// SilentAbsencesCard.jsx
//
// Surfaces staff who are entirely absent from today's time card — no
// row, no punches at all. Distinct from the missed-punch tiles, which
// only show staff who DID punch but missed one of the two punches.
//
// Categorizes silent staff into:
//   1. On approved leave        — already covered, no action
//   2. On Mawani visit          — already covered, no action
//   3. Unexplained absence      — investigate
//
// The first two groups are shown collapsed by default with just a
// count — they're not actionable, just informational. The unexplained
// group is expanded by default and shows full names + PSN + manager
// for each staff so Bashaier can investigate.
//
// Hidden when there are zero silent absences (best case).
// =============================================================================

export default function SilentAbsencesCard({ silentAbsences, empById }) {
  const [showLeave,  setShowLeave]  = useState(false);
  const [showMawani, setShowMawani] = useState(false);
  const [collapsed,  setCollapsed]  = useState(false);

  const onLeave    = silentAbsences?.onLeave    || [];
  const onMawani   = silentAbsences?.onMawani   || [];
  const unexplained = silentAbsences?.unexplained || [];
  const total = onLeave.length + onMawani.length + unexplained.length;

  if (total === 0) return null;

  const managerName = (emp) => {
    const mgrId = String(emp?.manager_id || '').toUpperCase();
    return mgrId && empById?.[mgrId]?.name ? empById[mgrId].name : null;
  };

  return (
    <div className="rounded-xl mb-4"
      style={{
        background: '#FFFFFF',
        border: '1px solid #EEEAE0',
        fontFamily: 'inherit',
      }}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 cursor-pointer"
        onClick={() => setCollapsed(c => !c)}>
        <div className="flex items-center gap-2">
          <UserX className="w-4 h-4" style={{ color: unexplained.length > 0 ? '#A32D2D' : '#7A7A7A' }}/>
          <div>
            <div className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
              Silent absences
              <span className="ml-2 text-[10px]" style={{ color: '#7A7A7A', fontWeight: 500 }}>
                {total} staff with no punches today
              </span>
            </div>
            <div className="flex items-center gap-1.5 mt-1 flex-wrap">
              {unexplained.length > 0 && (
                <span className="text-[10px] px-1.5 py-px rounded"
                  style={{ background: '#FCEBEB', color: '#A32D2D', fontWeight: 600 }}>
                  {unexplained.length} unexplained
                </span>
              )}
              {onLeave.length > 0 && (
                <span className="text-[10px] px-1.5 py-px rounded"
                  style={{ background: '#E1F5EE', color: '#0F6E56', fontWeight: 600 }}>
                  {onLeave.length} on leave
                </span>
              )}
              {onMawani.length > 0 && (
                <span className="text-[10px] px-1.5 py-px rounded"
                  style={{ background: '#E6F1FB', color: '#0C447C', fontWeight: 600 }}>
                  {onMawani.length} Mawani
                </span>
              )}
            </div>
          </div>
        </div>
        {collapsed
          ? <ChevronRight className="w-4 h-4" style={{ color: '#7A7A7A' }}/>
          : <ChevronDown  className="w-4 h-4" style={{ color: '#7A7A7A' }}/>}
      </div>

      {!collapsed && (
        <div style={{ borderTop: '1px solid #EEEAE0' }}>

          {/* Unexplained — most urgent, expanded by default */}
          {unexplained.length > 0 && (
            <div className="px-3 py-2.5"
              style={{ borderLeft: '3px solid #FCEBEB', paddingLeft: '9px' }}>
              <div className="text-[10px] mb-1.5"
                style={{ color: '#A32D2D', fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                Unexplained &middot; {unexplained.length}
              </div>
              <ul className="space-y-1">
                {unexplained.map(emp => (
                  <li key={emp.id} className="text-[11px] flex items-baseline gap-2">
                    <span style={{ color: '#0A0A0A', fontWeight: 600 }}>{emp.name}</span>
                    <span style={{ color: '#7A7A7A', fontFamily: 'monospace' }}>{emp.id}</span>
                    {emp.department && (
                      <span style={{ color: '#7A7A7A' }}>&middot; {emp.department}</span>
                    )}
                    {managerName(emp) && (
                      <span style={{ color: '#7A7A7A' }}>&middot; under {managerName(emp)}</span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="text-[10px] mt-2" style={{ color: '#7A7A7A' }}>
                No leave or Mawani visit on file. Verify with the staff or their manager before payroll runs.
              </div>
            </div>
          )}

          {/* On leave — collapsed by default */}
          {onLeave.length > 0 && (
            <div style={{ borderTop: unexplained.length > 0 ? '1px solid #EEEAE0' : 'none' }}>
              <div className="px-3 py-2 cursor-pointer hover:bg-[#FAFAF9] flex items-center justify-between"
                onClick={() => setShowLeave(s => !s)}>
                <div className="flex items-center gap-1.5">
                  <Plane className="w-3 h-3" style={{ color: '#0F6E56' }}/>
                  <span className="text-[11px]" style={{ color: '#0A0A0A', fontWeight: 500 }}>
                    On approved leave &middot; {onLeave.length}
                  </span>
                </div>
                {showLeave
                  ? <ChevronDown className="w-3.5 h-3.5" style={{ color: '#7A7A7A' }}/>
                  : <ChevronRight className="w-3.5 h-3.5" style={{ color: '#7A7A7A' }}/>}
              </div>
              {showLeave && (
                <ul className="px-3 pb-2.5 space-y-0.5">
                  {onLeave.map(emp => (
                    <li key={emp.id} className="text-[11px] flex items-baseline gap-2">
                      <span style={{ color: '#0A0A0A' }}>{emp.name}</span>
                      <span style={{ color: '#7A7A7A', fontFamily: 'monospace' }}>{emp.id}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Mawani — collapsed by default */}
          {onMawani.length > 0 && (
            <div style={{ borderTop: (unexplained.length > 0 || onLeave.length > 0) ? '1px solid #EEEAE0' : 'none' }}>
              <div className="px-3 py-2 cursor-pointer hover:bg-[#FAFAF9] flex items-center justify-between"
                onClick={() => setShowMawani(s => !s)}>
                <div className="flex items-center gap-1.5">
                  <MapPin className="w-3 h-3" style={{ color: '#0C447C' }}/>
                  <span className="text-[11px]" style={{ color: '#0A0A0A', fontWeight: 500 }}>
                    On Mawani visit &middot; {onMawani.length}
                  </span>
                </div>
                {showMawani
                  ? <ChevronDown className="w-3.5 h-3.5" style={{ color: '#7A7A7A' }}/>
                  : <ChevronRight className="w-3.5 h-3.5" style={{ color: '#7A7A7A' }}/>}
              </div>
              {showMawani && (
                <ul className="px-3 pb-2.5 space-y-0.5">
                  {onMawani.map(emp => (
                    <li key={emp.id} className="text-[11px] flex items-baseline gap-2">
                      <span style={{ color: '#0A0A0A' }}>{emp.name}</span>
                      <span style={{ color: '#7A7A7A', fontFamily: 'monospace' }}>{emp.id}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
