import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeftCircle, Send, Loader2, Clock, CheckCircle2, AlertCircle, X, Mail } from 'lucide-react';
import { supabase, directGet, directPatch } from '../supabaseClient.js';
import { fmtDateShort } from '../lib/leaveLogic.js';

// =============================================================================
// MyRejoiningCard
//
// Shown to a staff member on their PersonalDashboard for any of THEIR
// approved leaves where:
//   • end_date < today (leave has finished)
//   • return_stage IS NULL (never submitted) OR rejected_by_*
//     (manager/HR sent it back for fixes)
//   • return_stage != 'approved' (final state, no action needed)
//
// Three states the card can show per leave row:
//   1. NOT SUBMITTED        →  "Submit rejoining" button + inline form
//   2. PENDING MANAGER/HR   →  status badge, no action
//   3. REJECTED             →  reason shown, "Resubmit" button + form
//
// Submission writes:
//   actual_return_date   = picked date (default end_date+1)
//   return_notes         = optional text
//   return_submitted_at  = now()
//   return_stage         = 'pending_manager'
//   return_rejection_reason = null (cleared on resubmit)
//
// Manager / HR pick up from there (PendingReturnsCard).
// =============================================================================

export default function MyRejoiningCard({ me, employees = [] }) {
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId,  setBusyId]  = useState(null);
  const [openId,  setOpenId]  = useState(null);
  const [form,    setForm]    = useState({ actualDate: '', notes: '' });
  const [error,   setError]   = useState('');

  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const load = useCallback(async () => {
    if (!me?.id) return;
    setLoading(true);
    try {
      // All my approved leaves with end_date past, that are either
      // unsubmitted, pending review, or rejected. Hide rows already at
      // return_stage='approved' (workflow complete).
      const data = await directGet(
        'leave_requests',
        `select=*&employee_id=eq.${encodeURIComponent(me.id)}` +
        `&stage=eq.approved&end_date=lt.${todayISO}` +
        `&or=(return_stage.is.null,return_stage.in.(pending_manager,pending_hr,rejected_by_manager,rejected_by_hr))` +
        `&order=end_date.desc&limit=50`,
        { timeoutMs: 10000 }
      );
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn('[my rejoining] load failed:', err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [me?.id, todayISO]);

  useEffect(() => { load(); }, [load]);

  // Realtime — manager/HR decisions update return_stage. Re-run load so
  // the staff sees their request move from pending → approved/rejected
  // without a manual refresh.
  useEffect(() => {
    if (!me?.id) return undefined;
    const channel = supabase
      .channel(`my-rejoining-${me.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'leave_requests',
          filter: `employee_id=eq.${me.id}` },
        () => load())
      .subscribe();
    return () => { try { supabase.removeChannel(channel); } catch {} };
  }, [me?.id, load]);

  const openForm = (req) => {
    setOpenId(req.id);
    setError('');
    // Pre-fill: existing actual_return_date if resubmitting, else end_date+1
    if (req.actual_return_date) {
      setForm({ actualDate: req.actual_return_date, notes: req.return_notes || '' });
    } else {
      const d = new Date(req.end_date);
      d.setDate(d.getDate() + 1);
      setForm({ actualDate: d.toISOString().slice(0, 10), notes: '' });
    }
  };

  const cancel = () => { setOpenId(null); setError(''); };

  const submit = useCallback(async (req) => {
    if (!form.actualDate) { setError('Return date is required'); return; }
    if (form.actualDate < req.start_date) {
      setError(`Return date must be on or after leave start (${fmtDateShort(req.start_date)})`);
      return;
    }
    setBusyId(req.id); setError('');
    try {
      await directPatch('leave_requests', 'id', req.id, {
        actual_return_date:      form.actualDate,
        return_notes:            form.notes.trim() || null,
        return_submitted_at:     new Date().toISOString(),
        return_stage:            'pending_manager',
        return_rejection_reason: null,
      }, { timeoutMs: 10000 });
      cancel();
      await load();
    } catch (err) {
      setError(err.message || 'Submit failed');
    } finally {
      setBusyId(null);
    }
  }, [form, load]);

  if (loading || rows.length === 0) return null;

  // Resolve the staff's manager once — used to compose the optional
  // 'email manager' draft when the rejoining is sitting at AWAITING
  // MANAGER. The email is a plain mailto: with the leave details and
  // a deep link to the verify page; gives the manager a nudge with
  // everything they need to approve.
  const myManager = me?.manager_id ? employees.find(e => e.id === me.manager_id) : null;
  const composeManagerNudge = (req) => {
    if (!myManager?.email) {
      alert('Your manager has no email on file in the directory. Please contact HR.');
      return;
    }
    const verifyUrl = `${window.location.origin}/verify-leave/${req.id}`;
    const subject = `Rejoining approval needed — ${me.name} · ${fmtDateShort(req.start_date)} → ${fmtDateShort(req.end_date)}`;
    const body = [
      `Dear ${myManager.name?.split(' ')[0] || 'Manager'},`,
      ``,
      `I have submitted my rejoining request after returning from ${(req.leave_type_id || 'leave').toLowerCase()} leave.`,
      ``,
      `  Period:           ${fmtDateShort(req.start_date)} → ${fmtDateShort(req.end_date)}  (${req.days} day${req.days === 1 ? '' : 's'})`,
      `  Returned on:      ${fmtDateShort(req.actual_return_date)}`,
      `  Submitted at:     ${new Date(req.return_submitted_at || Date.now()).toLocaleString('en-GB')}`,
      req.return_notes ? `  Notes:            ${req.return_notes}` : null,
      ``,
      `Please review and approve at your convenience. The full record is visible on the portal:`,
      `  ${verifyUrl}`,
      ``,
      `Or open the ESAU HR portal directly: ${window.location.origin}`,
      ``,
      `Thank you,`,
      me.name,
      me.id,
    ].filter(Boolean).join('\n');
    const mailto = `mailto:${encodeURIComponent(myManager.email)}` +
                   `?subject=${encodeURIComponent(subject)}` +
                   `&body=${encodeURIComponent(body)}`;
    window.location.href = mailto;
  };

  return (
    <section className="rounded-2xl overflow-hidden mb-4"
             style={{ background: 'linear-gradient(135deg, #ECFDF5 0%, #D1FAE5 100%)', border: '1px solid #86EFAC' }}>
      <div className="px-5 py-4" style={{ borderBottom: '1px solid #86EFAC' }}>
        <div className="flex items-center gap-2">
          <ArrowLeftCircle className="w-4 h-4" style={{ color: '#0F4C2A' }} />
          <div className="font-semibold text-sm" style={{ color: '#0A0A0A' }}>
            {rows.length === 1 ? 'Welcome back — submit your rejoining' : `${rows.length} rejoinings to submit`}
          </div>
        </div>
        <div className="text-xs mt-1" style={{ color: '#1F1B16' }}>
          Confirm your return so your manager and HR can finalize the rejoining record.
        </div>
      </div>

      <div className="divide-y" style={{ borderColor: '#86EFAC' }}>
        {rows.map(req => {
          const stage = req.return_stage;
          const open = openId === req.id;
          const busy = busyId === req.id;
          const canSubmit = !stage || stage === 'rejected_by_manager' || stage === 'rejected_by_hr';
          const pendingMgr = stage === 'pending_manager';
          const pendingHr  = stage === 'pending_hr';
          const rejectedBy = stage === 'rejected_by_manager' ? 'Manager'
                          : stage === 'rejected_by_hr'      ? 'HR' : null;

          return (
            <div key={req.id} className="px-5 py-3">
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold" style={{ color: '#0A0A0A' }}>
                    {(req.leave_type_id || 'leave').toUpperCase()} · {fmtDateShort(req.start_date)} → {fmtDateShort(req.end_date)}
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: '#1F1B16' }}>
                    {req.days} day{req.days === 1 ? '' : 's'}{req.is_half_day ? ' · half day' : ''}
                  </div>
                </div>
                {pendingMgr && (
                  <>
                    <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold"
                          style={{ background: '#FEF3C7', color: '#0A0A0A' }}>
                      <Clock className="w-3 h-3" /> AWAITING MANAGER
                    </span>
                    {myManager?.email && (
                      <button
                        onClick={() => composeManagerNudge(req)}
                        className="px-2.5 py-1 rounded-md text-[10px] font-semibold inline-flex items-center gap-1.5"
                        style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #C9B894' }}
                        title={`Compose email to ${myManager.name}`}>
                        <Mail className="w-3 h-3" /> Email manager
                      </button>
                    )}
                  </>
                )}
                {pendingHr && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold"
                        style={{ background: '#DBEAFE', color: '#0A0A0A' }}>
                    <Clock className="w-3 h-3" /> AWAITING HR
                  </span>
                )}
                {rejectedBy && (
                  <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold"
                        style={{ background: '#FEE2E2', color: '#991B1B' }}>
                    <AlertCircle className="w-3 h-3" /> {rejectedBy.toUpperCase()} SENT BACK
                  </span>
                )}
                {!open && canSubmit && (
                  <button
                    onClick={() => openForm(req)}
                    disabled={busy}
                    className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                    style={{ background: '#0F4C2A', color: '#FFFFFF' }}>
                    <Send className="w-3 h-3" /> {rejectedBy ? 'Resubmit' : 'Submit rejoining'}
                  </button>
                )}
              </div>

              {rejectedBy && req.return_rejection_reason && !open && (
                <div className="mt-2 px-3 py-2 rounded text-xs"
                     style={{ background: '#FFFFFF', border: '1px solid #FCA5A5' }}>
                  <div className="font-semibold mb-0.5" style={{ color: '#0A0A0A' }}>{rejectedBy} note:</div>
                  <div style={{ color: '#1F1B16' }}>{req.return_rejection_reason}</div>
                </div>
              )}

              {open && canSubmit && (
                <div className="mt-3 pt-3 border-t" style={{ borderColor: '#86EFAC' }}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                    <label className="block">
                      <span className="text-[10px] tracking-wider font-semibold block mb-1" style={{ color: '#0A0A0A' }}>
                        ACTUAL RETURN DATE
                      </span>
                      <input
                        type="date"
                        value={form.actualDate}
                        onChange={(e) => setForm(f => ({ ...f, actualDate: e.target.value }))}
                        className="w-full px-2 py-1.5 rounded text-sm"
                        style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}
                      />
                    </label>
                    <label className="block">
                      <span className="text-[10px] tracking-wider font-semibold block mb-1" style={{ color: '#0A0A0A' }}>
                        NOTES (OPTIONAL)
                      </span>
                      <input
                        type="text"
                        value={form.notes}
                        onChange={(e) => setForm(f => ({ ...f, notes: e.target.value }))}
                        placeholder="e.g. medical certificate attached, returned 1 day early"
                        className="w-full px-2 py-1.5 rounded text-sm"
                        style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}
                      />
                    </label>
                  </div>
                  {error && (
                    <div className="mb-2 px-2 py-1.5 rounded text-xs"
                         style={{ background: '#FEE2E2', color: '#0A0A0A' }}>
                      {error}
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => submit(req)}
                      disabled={busy || !form.actualDate}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: '#0F4C2A', color: '#FFFFFF', opacity: busy || !form.actualDate ? 0.6 : 1 }}>
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                      Send for approval
                    </button>
                    <button
                      onClick={cancel}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: 'transparent', color: '#1F1B16' }}>
                      <X className="w-3 h-3" /> Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
