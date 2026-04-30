import React, { useState, useEffect, useCallback } from 'react';
import { UserCheck, ThumbsUp, ThumbsDown, Loader2 } from 'lucide-react';
import { supabase, directGet } from '../supabaseClient.js';
import { fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';

// =============================================================================
// PendingSubstitutionsCard
//
// Renders coverage requests where the current user is listed in
// substitute_ids and the request is still at stage='pending_substitutes'.
// Each card has Accept / Decline buttons that update the row's
// substitute_decisions JSON; the Postgres trigger
// advance_stage_on_substitute_decision then auto-advances the stage
// (→ pending_manager when all accept, → rejected_by_substitute on any
// decline).
//
// Self-contained — fetches its own data, owns its loading state, hides
// itself when there's nothing to show. Mounts on every dashboard variant
// (PersonalDashboard, Dashboard, ManagerDashboard) so admin/HR/manager
// users can also accept substitution requests when they're picked as a
// substitute. Previously this was inline in PersonalDashboard only,
// which meant any non-staff user picked as a substitute had no UI to
// accept or decline.
//
// Empty/Hidden when subRequests is empty so dashboards that already have
// vertical content stay clean.
// =============================================================================

export default function PendingSubstitutionsCard({ me, empMap }) {
  const [subRequests, setSubRequests] = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [busyId,      setBusyId]      = useState(null);

  const load = useCallback(async () => {
    if (!me?.id) return;
    setLoading(true);
    try {
      const rows = await directGet(
        'leave_requests',
        `select=*&substitute_ids=cs.{${me.id}}&stage=eq.pending_substitutes&order=start_date.asc`,
        { timeoutMs: 10000 }
      );
      // Hide rows where MY decision is already final
      const pending = (Array.isArray(rows) ? rows : []).filter(r => {
        const d = r.substitute_decisions?.[me.id];
        if (!d) return true;
        const dec = typeof d === 'string' ? d : d.decision;
        return dec !== 'accepted' && dec !== 'declined';
      });
      setSubRequests(pending);
    } catch (err) {
      console.warn('[substitutions] load failed:', err);
      setSubRequests([]);
    } finally {
      setLoading(false);
    }
  }, [me?.id]);

  useEffect(() => { load(); }, [load]);

  const respond = useCallback(async (request, decision) => {
    if (!me?.id) return;
    setBusyId(request.id);
    const merged = {
      ...(request.substitute_decisions || {}),
      [me.id]: { decision, at: new Date().toISOString() }
    };
    try {
      const updatePromise = supabase
        .from('leave_requests')
        .update({ substitute_decisions: merged })
        .eq('id', request.id);
      const { error } = await Promise.race([
        Promise.resolve(updatePromise),
        new Promise((_, rej) => setTimeout(() => rej(new Error('decision update timed out')), 10000)),
      ]);
      if (error) throw error;
      await load();
    } catch (err) {
      console.warn('[substitutions] respond failed:', err);
      alert('Could not record your decision: ' + (err.message || err));
    } finally {
      setBusyId(null);
    }
  }, [me?.id, load]);

  // Hide the whole card when there's nothing to show. Loading state is
  // also hidden so dashboards don't flash an empty 'A colleague needs
  // you to cover' shell on first paint.
  if (loading || subRequests.length === 0) return null;

  return (
    <section className="rounded-2xl overflow-hidden mb-4"
             style={{ background: 'linear-gradient(135deg, #FFF8E7 0%, #FFE8B8 100%)', border: '1px solid #E8C97A' }}>
      <div className="px-5 py-4 flex items-center gap-2"
           style={{ borderBottom: '1px solid #E8C97A' }}>
        <UserCheck className="w-4 h-4" style={{ color: '#8B6914' }} />
        <div className="font-semibold text-sm" style={{ color: '#5C4406' }}>
          {subRequests.length === 1
            ? 'A colleague needs you to cover'
            : `${subRequests.length} colleagues need you to cover`}
        </div>
      </div>
      <ul className="divide-y" style={{ borderColor: 'rgba(139,105,20,0.2)' }}>
        {subRequests.map(req => {
          const empName = empMap?.[req.employee_id]?.name || req.employee_id;
          const initials = getInitials(empName);
          const busy = busyId === req.id;
          return (
            <li key={req.id} className="px-5 py-3 flex items-center gap-3">
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                   style={{ background: avatarColor(empName) }}>
                {initials}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold truncate" style={{ color: '#5C4406' }}>
                  {empName}
                </div>
                <div className="text-xs opacity-80" style={{ color: '#5C4406' }}>
                  {fmtDateShort(req.start_date)} → {fmtDateShort(req.end_date)} · {req.days} day{req.days !== 1 ? 's' : ''}
                  {req.reason ? ' · ' + req.reason : ''}
                </div>
              </div>
              <button
                type="button"
                onClick={() => respond(req, 'declined')}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-full disabled:opacity-50"
                style={{ background: '#fff', color: '#B83A2E', border: '1px solid #B83A2E' }}>
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsDown className="w-3 h-3" />} Decline
              </button>
              <button
                type="button"
                onClick={() => respond(req, 'accepted')}
                disabled={busy}
                className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-full disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg, #2D5F3F 0%, #1F4530 100%)', color: '#fff' }}>
                {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ThumbsUp className="w-3 h-3" />} Accept
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
