import React, { useMemo } from 'react';
import ShiftMonthGrid from './ShiftMonthGrid.jsx';

// TeamShiftMonthCard
//
// Manager-side month grid. Scoped to direct reports (employee.manager_id =
// me.id). Sits at the top of the Shifts tab so the manager sees the
// whole team's month at a glance before reaching the editor below.
export default function TeamShiftMonthCard({ me, employees }) {
  const directReports = useMemo(
    () => (employees || []).filter(e => e.manager_id === me?.id),
    [employees, me?.id]
  );
  if (!directReports.length) return null;
  return (
    <ShiftMonthGrid
      me={me}
      employees={directReports}
      kicker="MY TEAM"
      title="Team shifts this month"
      subtitle={`${directReports.length} direct report${directReports.length === 1 ? '' : 's'}. Realtime updates as shifts are dispatched, accepted, or approved.`}
    />
  );
}
