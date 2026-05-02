import React, { useState, useEffect, useCallback } from 'react';
import { CheckCircle2, X } from 'lucide-react';
import { supabase, directGet, directPatch } from '../supabaseClient.js';

// =============================================================================
// SubstituteFreedCard
//
// Surfaces 'coverage closed' notifications fired by the Postgres trigger
// trg_notify_substitutes_on_rejoin. When a colleague the user was covering
// for submits their rejoining, this card shows a small banner letting them
// know their coverage commitment is closed. Tapping Dismiss marks the
// notification as read.
//
// Hides itself when there are no unread 'substitute_freed' notifications.
// =============================================================================

export default function SubstituteFreedCard({ me }) {
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId,  setBusyId]  = useState(null);

  const load = useCallback(async () => {
    if (!me?.id) return;
    setLoading(true);
    try {
      const data = await directGet(
        'notifications',
        `select=*&recipient_id=eq.${encodeURIComponent(me.id)}` +
        `&kind=eq.substitute_freed&read_at=is.null&order=created_at.desc&limit=20`,
        { timeoutMs: 8000 },
      );
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn('[substitute freed] load failed:', err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [me?.id]);

  useEffect(() => { load(); }, [load]);

  // Realtime — new notification rows arrive as the trigger fires.
  useEffect(() => {
    if (!me?.id) return undefined;
    const channel = supabase
      .channel(`notifs-${me.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'notifications',
          filter: `recipient_id=eq.${me.id}` },
        () => load())
      .subscribe();
    return () => { try { supabase.removeChannel(channel); } catch {} };
  }, [me?.id, load]);

  const dismiss = useCallback(async (n) => {
    setBusyId(n.id);
    try {
      await directPatch('notifications', 'id', n.id,
        { read_at: new Date().toISOString() },
        { timeoutMs: 6000 });
      await load();
    } catch (err) {
      console.warn('[substitute freed] dismiss failed:', err);
    } finally {
      setBusyId(null);
    }
  }, [load]);

  if (loading || rows.length === 0) return null;

  return (
    <section className="rounded-2xl overflow-hidden mb-4"
             style={{ background: 'linear-gradient(135deg, #EFF6FF 0%, #DBEAFE 100%)', border: '1px solid #93C5FD' }}>
      <div className="px-5 py-4 flex items-center gap-2"
           style={{ borderBottom: '1px solid #93C5FD' }}>
        <CheckCircle2 className="w-4 h-4" style={{ color: '#1E40AF' }} />
        <div className="font-semibold text-sm" style={{ color: '#0A0A0A' }}>
          {rows.length === 1 ? 'Coverage commitment closed' : `${rows.length} coverage commitments closed`}
        </div>
      </div>
      <div className="divide-y" style={{ borderColor: '#93C5FD' }}>
        {rows.map(n => (
          <div key={n.id} className="px-5 py-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold" style={{ color: '#0A0A0A' }}>{n.title}</div>
              <div className="text-xs mt-0.5" style={{ color: '#1F1B16' }}>{n.body}</div>
            </div>
            <button
              onClick={() => dismiss(n)}
              disabled={busyId === n.id}
              className="px-2.5 py-1 rounded-md text-[10px] font-semibold inline-flex items-center gap-1 flex-shrink-0"
              style={{ background: '#FFFFFF', color: '#1E40AF', border: '1px solid #93C5FD' }}>
              <X className="w-3 h-3" /> Dismiss
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}
