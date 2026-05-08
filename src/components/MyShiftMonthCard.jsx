import React, { useEffect, useState } from 'react';
import { directGet } from '../supabaseClient.js';
import ShiftMonthGrid from './ShiftMonthGrid.jsx';

// =============================================================================
// MyShiftMonthCard
//
// Staff-side month grid. One row — themselves — across the visible
// month. Sits on PersonalDashboard alongside the existing pending-shift
// action card and the 30-day status list. The 30-day list answers
// "what got approved", this card answers "where am I working this
// month".
//
// VISIBILITY RULE (per Nadeem 2026-05-09):
//   The card should ONLY appear for staff who actually have shift
//   assignments — not the entire workforce. Office staff who never
//   work shift hours don't need this card cluttering their dashboard.
//
//   Implementation: cheap existence check on employee_shifts at mount.
//   If zero rows exist for this employee (any month, any status), the
//   card returns null. The query is tiny (limit=1, count headers off,
//   single id filter) so it costs almost nothing.
//
//   Nadeem (admin) and Bashaier (HR reviewer) see the full-fleet view
//   via HrShiftMonthCard on Dashboard.jsx — that one has its own
//   visibility gate and is unaffected by this card's behaviour.
// =============================================================================

export default function MyShiftMonthCard({ me }) {
  // Three states:
  //   null    → still checking (don't render anything)
  //   true    → user has at least one shift, render the grid
  //   false   → user has never been assigned a shift, render null
  const [hasShifts, setHasShifts] = useState(null);

  useEffect(() => {
    if (!me?.id) {
      setHasShifts(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // Cheap existence probe — fetch up to 1 row matching this
        // employee. If anything comes back, we know they have shift
        // history. If empty, they don't.
        const rows = await directGet(
          'employee_shifts',
          `select=id&employee_id=eq.${encodeURIComponent(me.id)}&limit=1`,
          { timeoutMs: 6000 },
        );
        if (cancelled) return;
        setHasShifts(Array.isArray(rows) && rows.length > 0);
      } catch (e) {
        // On error, hide rather than show — better to suppress a
        // potentially-empty card than to flash one that's broken.
        if (!cancelled) setHasShifts(false);
      }
    })();
    return () => { cancelled = true; };
  }, [me?.id]);

  // Don't render anything while the existence check is in flight or
  // when the user has no shift history. Avoids a flicker where the
  // card mounts then disappears, and avoids cluttering office-staff
  // dashboards with an empty shift card.
  if (!me?.id || hasShifts !== true) return null;

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
