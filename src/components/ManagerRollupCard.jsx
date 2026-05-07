import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Users } from 'lucide-react';

// =============================================================================
// ManagerRollupCard.jsx
//
// Per-manager summary of today's attendance violations. Groups every
// detection entry by the staff member's manager_id and shows a single
// row per manager with counts. Saves Bashaier from scrolling through
// every individual violation tile to figure out which team has the
// most issues today.
//
// Click a manager row to expand and see the specific staff + issues.
// Click again to collapse.
//
// Lives near the top of the workspace, below the FileSummary stats but
// above the per-violation panels. Hidden when there are zero issues
// across all managers (the good case — no need to take page space).
// =============================================================================

const ISSUE_TYPE_LABELS = {
  late:        'late',
  early:       'early leave',
  missedIn:    'missed in',
  missedOut:   'missed out',
  shiftAbsent: 'shift absence',
};

// Build the per-manager rollup from detection arrays. Returns an array
// sorted by total issues desc, then manager name. Each row collects
// every issue for that manager's direct reports plus a roll-up total
// and a count of how many already have an email logged.
function buildRollup(detection, empById, loggedMarkers) {
  if (!detection) return [];

  const buckets = new Map();  // managerId -> { managerName, issuesByEmp: Map, totalIssues, types: {...}, emailedCount }

  const addEntry = (entry, type) => {
    if (!entry?.employee?.id) return;
    const empId = String(entry.employee.id).toUpperCase();
    const employee = empById?.[empId] || entry.employee;
    const managerId = String(employee.manager_id || '').toUpperCase() || 'UNASSIGNED';
    if (!buckets.has(managerId)) {
      const manager = empById?.[managerId] || null;
      buckets.set(managerId, {
        managerId,
        managerName: manager?.name || (managerId === 'UNASSIGNED' ? 'Unassigned' : managerId),
        issuesByEmp: new Map(),
        totalIssues: 0,
        emailedCount: 0,
        types: { late: 0, early: 0, missedIn: 0, missedOut: 0, shiftAbsent: 0 },
      });
    }
    const bucket = buckets.get(managerId);
    if (!bucket.issuesByEmp.has(empId)) {
      bucket.issuesByEmp.set(empId, {
        employeeId: empId,
        employeeName: employee.name || empId,
        issues: [],
      });
    }
    // Translate detection 'type' (early, missedIn, etc.) into the
    // attendance_violations 'violation_type' key used by loggedMarkers.
    const violationType = type === 'early' ? 'early_leave'
                        : type === 'missedIn' ? 'missed_in'
                        : type === 'missedOut' || type === 'shiftAbsent' ? 'missed_out'
                        : type;  // 'late' stays as-is
    const markerKey = empId + ':' + violationType;
    const isEmailed = !!loggedMarkers?.[markerKey];

    bucket.issuesByEmp.get(empId).issues.push({ type, entry, isEmailed });
    bucket.totalIssues += 1;
    bucket.types[type] = (bucket.types[type] || 0) + 1;
    if (isEmailed) bucket.emailedCount += 1;
  };

  (detection.late || []).forEach(e => addEntry(e, 'late'));
  (detection.early || []).forEach(e => addEntry(e, 'early'));
  (detection.missedIn || []).forEach(e => addEntry(e, 'missedIn'));
  (detection.missedOut || []).forEach(e => addEntry(e, 'missedOut'));
  (detection.shiftAbsent || []).forEach(e => addEntry(e, 'shiftAbsent'));

  return Array.from(buckets.values())
    .map(b => ({
      ...b,
      staff: Array.from(b.issuesByEmp.values())
        .sort((a, b2) => b2.issues.length - a.issues.length || a.employeeName.localeCompare(b2.employeeName)),
    }))
    .sort((a, b) => b.totalIssues - a.totalIssues || a.managerName.localeCompare(b.managerName));
}

// Compose a one-line type breakdown like "3 late · 1 missed-out". We
// only show types that actually have a non-zero count to keep the row
// tight.
function fmtTypes(types) {
  const parts = [];
  for (const [k, n] of Object.entries(types)) {
    if (n > 0) parts.push(`${n} ${ISSUE_TYPE_LABELS[k] || k}`);
  }
  return parts.join(' \u00b7 ');
}

export default function ManagerRollupCard({ detection, empById, loggedMarkers }) {
  const [expanded, setExpanded] = useState({}); // managerId -> bool
  const [collapsed, setCollapsed] = useState(false);

  const rollup = useMemo(() => buildRollup(detection, empById, loggedMarkers), [detection, empById, loggedMarkers]);

  if (rollup.length === 0) return null;

  const totalIssues = rollup.reduce((sum, r) => sum + r.totalIssues, 0);
  const totalStaff  = rollup.reduce((sum, r) => sum + r.staff.length, 0);

  return (
    <div className="rounded-xl mb-4"
      style={{
        background: '#FFFFFF',
        border: '1px solid #EEEAE0',
        fontFamily: 'inherit',
      }}>
      {/* Header — total counts + collapse toggle. */}
      <div className="flex items-center justify-between p-3 cursor-pointer"
        onClick={() => setCollapsed(c => !c)}>
        <div className="flex items-center gap-2">
          <Users className="w-4 h-4" style={{ color: '#534AB7' }}/>
          <div>
            <div className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
              By manager
              <span className="ml-2 text-[10px]" style={{ color: '#7A7A7A', fontWeight: 500 }}>
                {totalIssues} {totalIssues === 1 ? 'issue' : 'issues'} \u00b7 {totalStaff} staff \u00b7 {rollup.length} {rollup.length === 1 ? 'manager' : 'managers'}
              </span>
            </div>
          </div>
        </div>
        {collapsed
          ? <ChevronRight className="w-4 h-4" style={{ color: '#7A7A7A' }}/>
          : <ChevronDown  className="w-4 h-4" style={{ color: '#7A7A7A' }}/>}
      </div>

      {!collapsed && (
        <div style={{ borderTop: '1px solid #EEEAE0' }}>
          {rollup.map((row, idx) => {
            const isExpanded = !!expanded[row.managerId];
            return (
              <div key={row.managerId}
                style={{
                  borderTop: idx === 0 ? 'none' : '1px solid #EEEAE0',
                }}>
                <div className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-[#FAFAF9]"
                  onClick={() => setExpanded(prev => ({ ...prev, [row.managerId]: !prev[row.managerId] }))}>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[12px]" style={{ color: '#0A0A0A', fontWeight: 600 }}>
                        {row.managerName}
                      </span>
                      <span className="text-[10px]" style={{ color: '#7A7A7A', fontFamily: 'monospace', fontWeight: 400 }}>
                        {row.managerId !== 'UNASSIGNED' ? row.managerId : ''}
                      </span>
                      {row.emailedCount > 0 && (
                        <span className="text-[10px] px-1.5 py-px rounded"
                          style={{
                            background: row.emailedCount === row.totalIssues ? '#E1F5EE' : '#FAEEDA',
                            color:      row.emailedCount === row.totalIssues ? '#0F6E56' : '#854F0B',
                            fontWeight: 600,
                          }}>
                          {row.emailedCount === row.totalIssues
                            ? '\u2713 all sent'
                            : `${row.emailedCount}/${row.totalIssues} sent`}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] mt-0.5" style={{ color: '#0A0A0A' }}>
                      <strong style={{ fontWeight: 600 }}>{row.totalIssues} {row.totalIssues === 1 ? 'issue' : 'issues'}</strong>
                      <span style={{ color: '#7A7A7A' }}>
                        {' across '}{row.staff.length} {row.staff.length === 1 ? 'staff' : 'staff'}
                        {' \u00b7 '}{fmtTypes(row.types)}
                      </span>
                    </div>
                  </div>
                  {isExpanded
                    ? <ChevronDown  className="w-4 h-4" style={{ color: '#7A7A7A' }}/>
                    : <ChevronRight className="w-4 h-4" style={{ color: '#7A7A7A' }}/>}
                </div>

                {isExpanded && (
                  <div className="px-3 pb-3" style={{ background: '#FAFAF9' }}>
                    <ul className="space-y-1 mt-1">
                      {row.staff.map(staff => (
                        <li key={staff.employeeId} className="text-[11px] flex items-baseline gap-2">
                          <span style={{ color: '#0A0A0A', fontWeight: 600 }}>{staff.employeeName}</span>
                          <span style={{ color: '#7A7A7A', fontFamily: 'monospace' }}>{staff.employeeId}</span>
                          <span style={{ color: '#0A0A0A' }}>
                            {staff.issues.map((iss, i) => (
                              <span key={i}>
                                {i > 0 && <span style={{ color: '#7A7A7A' }}>{' \u00b7 '}</span>}
                                {ISSUE_TYPE_LABELS[iss.type] || iss.type}
                                {typeof iss.entry?.minutesLate === 'number' && iss.entry.minutesLate > 0 && (
                                  <span style={{ color: '#7A7A7A' }}> ({iss.entry.minutesLate}m)</span>
                                )}
                                {typeof iss.entry?.minutesEarly === 'number' && iss.entry.minutesEarly > 0 && (
                                  <span style={{ color: '#7A7A7A' }}> ({iss.entry.minutesEarly}m)</span>
                                )}
                                {iss.isEmailed && (
                                  <span style={{ color: '#0F6E56', marginLeft: '4px' }}>{'\u2713'}</span>
                                )}
                              </span>
                            ))}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
