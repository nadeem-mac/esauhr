import React from 'react';
import ShiftMonthGrid from './ShiftMonthGrid.jsx';

// MyShiftMonthCard
//
// Staff-side month grid. One row — themselves — across the visible
// month. Sits on PersonalDashboard alongside the existing pending-shift
// action card and the 30-day status list. The 30-day list answers
// "what got approved", this card answers "where am I working this
// month".
export default function MyShiftMonthCard({ me }) {
  if (!me?.id) return null;
  // Prepare a single-employee list for the shared grid. We reuse the
  // logged-in user's own record — name, department, location all come
  // from the auth payload so no extra fetch is needed.
  const rows = [{
    id:         me.id,
    name:       me.name || 'You',
    department: me.department || '',
    location:   me.location || '',
  }];
  return (
    <ShiftMonthGrid
      me={me}
      employees={rows}
      kicker="MY SCHEDULE"
      title="Your shifts this month"
      subtitle="Days with a chip are shifts your manager has assigned. Approved by SUP shifts are final."
    />
  );
}
