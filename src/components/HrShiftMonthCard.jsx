import React from 'react';
import ShiftMonthGrid from './ShiftMonthGrid.jsx';

// HrShiftMonthCard
//
// Bashaier / HR full-fleet shift view. Renders every employee in the
// directory who has a shift in the visible month, grouped by location.
// Empty rows are hidden by the grid (hideEmptyRows={true}) so the card
// reflects the "actually scheduled" subset rather than the entire
// company headcount.
//
// Clicking a row name opens the EmployeeDetailModal via the parent's
// onSelectEmployee callback, which Dashboard.jsx already provides.
export default function HrShiftMonthCard({ me, employees, onSelectEmployee }) {
  return (
    <ShiftMonthGrid
      me={me}
      employees={employees || []}
      groupByLocation={true}
      hideEmptyRows={true}
      onEmployeeClick={onSelectEmployee || null}
      kicker="ALL STAFF SHIFTS"
      title="Shift assignments this month"
      subtitle="Grouped by location. Updates in realtime as managers dispatch shifts and you (SUP) approve them."
    />
  );
}
