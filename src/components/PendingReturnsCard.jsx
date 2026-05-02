import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeftCircle, Loader2, FileDown, AlertTriangle, Check, X, ChevronRight } from 'lucide-react';
import { supabase, directGet, directPatch } from '../supabaseClient.js';
import { fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';
import { downloadRejoiningReportForRequest } from '../lib/rejoiningReport.js';

// =============================================================================
// PendingReturnsCard
//
// Approval queue for staff-submitted rejoining requests. Two scopes:
//
//   scope='manager'  →  return_stage='pending_manager'
//                       (only direct reports)
//                       Approve  →  pending_hr
//                       Reject   →  rejected_by_manager (sends back to staff)
//
//   scope='hr'       →  return_stage='pending_hr'                  (primary)
//                       + end_date + 1 day < today &&
//                         return_stage IS NULL                      (no-show)
//                       company-wide
//                       Approve  →  approved (final) — sets returned_at,
//                                   return_confirmed_by, return_status
//                       Reject   →  rejected_by_hr
//
// "No-show" rows on the HR card are leaves where the staff hasn't even
// submitted yet, 3+ days past their end_date. HR can ping or escalate
// from there. They're sorted to the top with a red NO-SHOW chip.
// =============================================================================

const NO_SHOW_THRESHOLD_DAYS = 1;

export default function PendingReturnsCard({ me, employees, scope = 'manager' }) {
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId,  setBusyId]  = useState(null);
  const [openId,  setOpenId]  = useState(null);
  const [rejectMode, setRejectMode] = useState(false);
  const [reason,  setReason]  = useState('');

  const empMap = useMemo(() => {
    const m = {};
    (employees || []).forEach(e => { m[e.id] = e; });
    return m;
  }, [employees]);

  const directReportIds = useMemo(() => {
    if (scope !== 'manager') return null;
    return (employees || []).filter(e => e.manager_id === me?.id).map(e => e.id);
  }, [employees, me?.id, scope]);

  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const load = useCallback(async () => {
    if (!me?.id) return;

    if (scope === 'manager') {
      if (!directReportIds || directReportIds.length === 0) {
        setRows([]); setLoading(false); return;
      }
    }

    setLoading(true);
    try {
      let data = [];

      if (scope === 'manager') {
        // Pending-manager rejoining requests from direct reports.
        data = await directGet(
          'leave_requests',
          `select=*&stage=eq.approved&return_stage=eq.pending_manager` +
          `&employee_id=in.(${directReportIds.map(id => `"${id}"`).join(',')})` +
          `&order=return_submitted_at.asc&limit=200`,
          { timeoutMs: 10000 },
        );
      } else {
        // HR scope — two parallel queries union'd:
        //   a) pending_hr (primary work)
        //   b) end_date+1 < today AND return_stage IS NULL (no-shows)
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - NO_SHOW_THRESHOLD_DAYS);
        const cutoffISO = cutoff.toISOString().slice(0, 10);
        const [pendingHr, noShows] = await Promise.all([
          directGet(
            'leave_requests',
            `select=*&stage=eq.approved&return_stage=eq.pending_hr` +
            `&order=return_manager_decided_at.asc&limit=200`,
            { timeoutMs: 10000 },
          ).catch(() => []),
          directGet(
            'leave_requests',
            `select=*&stage=eq.approved&return_stage=is.null&end_date=lte.${cutoffISO}` +
            `&order=end_date.asc&limit=200`,
            { timeoutMs: 10000 },
          ).catch(() => []),
        ]);
        data = [
          ...(Array.isArray(pendingHr) ? pendingHr : []),
          ...(Array.isArray(noShows)   ? noShows   : []),
        ];
      }
      setRows(data);
    } catch (err) {
      console.warn('[pending returns] load failed:', err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [me?.id, scope, directReportIds?.join(','), todayISO]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!me?.id) return undefined;
    const channel = supabase
      .channel(`pending-returns-${scope}-${me.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'leave_requests' },
        () => load())
      .subscribe();
    return () => { try { supabase.removeChannel(channel); } catch {} };
  }, [me?.id, scope, load]);

  const openRow = (req, mode = 'view') => {
    setOpenId(req.id);
    setRejectMode(mode === 'reject');
    setReason('');
  };
  const cancel = () => { setOpenId(null); setRejectMode(false); setReason(''); };

  const approve = useCallback(async (req) => {
    if (!me?.id) return;
    setBusyId(req.id);
    try {
      let patch;
      if (scope === 'manager') {
        patch = {
          return_stage:              'pending_hr',
          return_manager_decided_at: new Date().toISOString(),
          return_manager_decided_by: me.id,
          return_rejection_reason:   null,
        };
      } else {
        // HR final approval — compute balance_after and credit early
        // returns. If staff returned earlier than end_date, the
        // unused days are credited back as a leave_balances adjustment
        // so their available balance is accurate going forward.
        patch = {
          return_stage:              'approved',
          return_hr_decided_at:      new Date().toISOString(),
          return_hr_decided_by:      me.id,
          // Final approval also stamps the legacy fields used by the
          // Rejoining Report and the verify page.
          returned_at:               new Date().toISOString(),
          return_confirmed_by:       me.id,
          return_status:             'returned',
          return_rejection_reason:   null,
        };

        try {
          // Days saved if staff returned early. actual_return_date is the
          // first day BACK at work, so anything earlier than end_date+1
          // means the leave was cut short.
          const planned = new Date(req.end_date);
          const actual  = new Date(req.actual_return_date);
          // expectedReturn = end_date + 1 day
          const expectedReturn = new Date(planned); expectedReturn.setDate(expectedReturn.getDate() + 1);
          const daysSaved = Math.max(0, Math.floor((expectedReturn - actual) / 86_400_000));

          if (daysSaved > 0) {
            // Credit back to the leave_balances row. Adjustment is
            // additive to whatever's already there.
            const yr = new Date(req.start_date).getFullYear();
            const balRows = await directGet(
              'leave_balances',
              `select=id,adjustment,adjustment_note&employee_id=eq.${encodeURIComponent(req.employee_id)}` +
              `&leave_type_id=eq.${encodeURIComponent(req.leave_type_id)}&year=eq.${yr}`,
              { timeoutMs: 6000 },
            );
            if (Array.isArray(balRows) && balRows.length > 0) {
              const cur = balRows[0];
              const newAdj = Number(cur.adjustment || 0) + daysSaved;
              const note = `${cur.adjustment_note ? cur.adjustment_note + ' · ' : ''}` +
                           `+${daysSaved}d credited (early return on rejoining ${new Date().toISOString().slice(0,10)})`;
              await directPatch('leave_balances', 'id', cur.id, {
                adjustment: newAdj,
                adjustment_note: note,
              }, { timeoutMs: 6000 });
            }
            patch.balance_after = daysSaved; // store the credit count for reporting
          } else {
            patch.balance_after = 0;
          }
        } catch (e) {
          console.warn('[rejoining approve] balance reconciliation failed (non-fatal):', e);
        }
      }
      await directPatch('leave_requests', 'id', req.id, patch, { timeoutMs: 10000 });
      cancel();
      await load();
    } catch (err) {
      alert('Approve failed: ' + (err.message || err));
    } finally {
      setBusyId(null);
    }
  }, [me?.id, scope, load]);

  const reject = useCallback(async (req) => {
    if (!me?.id) return;
    if (!reason.trim()) { alert('Please give a reason so the staff can fix and resubmit.'); return; }
    setBusyId(req.id);
    try {
      const patch = {
        return_stage: scope === 'manager' ? 'rejected_by_manager' : 'rejected_by_hr',
        return_rejection_reason: reason.trim(),
        ...(scope === 'manager'
          ? { return_manager_decided_at: new Date().toISOString(), return_manager_decided_by: me.id }
          : { return_hr_decided_at:      new Date().toISOString(), return_hr_decided_by:      me.id }),
      };
      await directPatch('leave_requests', 'id', req.id, patch, { timeoutMs: 10000 });
      cancel();
      await load();
    } catch (err) {
      alert('Reject failed: ' + (err.message || err));
    } finally {
      setBusyId(null);
    }
  }, [me?.id, scope, reason, load]);

  const handleDownload = useCallback(async (req) => {
    setBusyId(req.id);
    try {
      await downloadRejoiningReportForRequest(req, empMap);
    } catch (err) {
      alert('Could not generate rejoining report: ' + (err.message || err));
    } finally {
      setBusyId(null);
    }
  }, [empMap]);

  if (loading || rows.length === 0) return null;

  // No-show detection (HR scope only; rows where return_stage IS NULL
  // and end_date+3 < today are pulled in the query above).
  const isNoShow = (req) => req.return_stage == null;
  const isPendingMgr = (req) => req.return_stage === 'pending_manager';
  const isPendingHr  = (req) => req.return_stage === 'pending_hr';

  // Sort: no-shows first, then by submission time (oldest first).
  const sorted = [...rows].sort((a, b) => {
    const aNo = isNoShow(a) ? 1 : 0;
    const bNo = isNoShow(b) ? 1 : 0;
    if (aNo !== bNo) return bNo - aNo;
    const aT = a.return_submitted_at || a.end_date;
    const bT = b.return_submitted_at || b.end_date;
    return new Date(aT) - new Date(bT);
  });

  const headline = scope === 'manager'
    ? `${rows.length} rejoining ${rows.length === 1 ? 'request' : 'requests'} from your team`
    : `${rows.length} rejoining ${rows.length === 1 ? 'item' : 'items'} for HR final approval`;
  const subline = scope === 'manager'
    ? 'Approve or send back. Once approved it routes to HR for final sign-off.'
    : 'Approve to record the return officially. No-show rows are leaves where the staff hasn\'t submitted yet.';

  return (
    <section className="rounded-2xl overflow-hidden mb-4"
             style={{ background: 'linear-gradient(135deg, #ECFDF5 0%, #D1FAE5 100%)', border: '1px solid #86EFAC' }}>
      <div className="px-5 py-4" style={{ borderBottom: '1px solid #86EFAC' }}>
        <div className="flex items-center gap-2">
          <ArrowLeftCircle className="w-4 h-4" style={{ color: '#0F4C2A' }} />
          <div className="font-semibold text-sm" style={{ color: '#0A0A0A' }}>{headline}</div>
        </div>
        <div className="text-xs mt-1" style={{ color: '#1F1B16' }}>{subline}</div>
      </div>

      <div className="divide-y" style={{ borderColor: '#86EFAC' }}>
        {sorted.map(req => {
          const emp = empMap[req.employee_id];
          const noShow = isNoShow(req);
          const open = openId === req.id;
          const busy = busyId === req.id;

          return (
            <div key={req.id} className="px-5 py-3" style={{ background: noShow ? '#FEF2F2' : 'transparent' }}>
              <div className="flex items-center gap-3 flex-wrap">
                <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                     style={{ background: avatarColor(emp?.name || req.employee_id), color: '#FFFFFF' }}>
                  {getInitials(emp?.name || req.employee_id)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold truncate" style={{ color: '#0A0A0A' }}>
                    {emp?.name || req.employee_id}
                  </div>
                  <div className="text-xs flex items-center gap-2 flex-wrap" style={{ color: '#1F1B16' }}>
                    <span>{(req.leave_type_id || 'leave').toUpperCase()}</span>
                    <span>·</span>
                    <span>{fmtDateShort(req.start_date)} → {fmtDateShort(req.end_date)}</span>
                    <span>·</span>
                    <span>{req.days} day{req.days === 1 ? '' : 's'}</span>
                    {req.actual_return_date && (
                      <>
                        <span>·</span>
                        <span style={{ color: '#0F4C2A', fontWeight: 600 }}>
                          returned {fmtDateShort(req.actual_return_date)}
                        </span>
                      </>
                    )}
                    {noShow && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ml-1"
                            style={{ background: '#FEE2E2', color: '#991B1B' }}>
                        <AlertTriangle className="w-3 h-3" /> NO-SHOW
                      </span>
                    )}
                    {isPendingMgr(req) && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ml-1"
                            style={{ background: '#FEF3C7', color: '#0A0A0A' }}>
                        AWAITING MGR
                      </span>
                    )}
                    {isPendingHr(req) && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold ml-1"
                            style={{ background: '#DBEAFE', color: '#0A0A0A' }}>
                        AWAITING HR
                      </span>
                    )}
                  </div>
                </div>
                {!open && !noShow && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => openRow(req, 'view')}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: '#0F4C2A', color: '#FFFFFF' }}>
                      Review <ChevronRight className="w-3 h-3" />
                    </button>
                  </div>
                )}
                {!open && noShow && (
                  <div className="text-[10px] font-bold" style={{ color: '#991B1B' }}>
                    No submission for {Math.floor((new Date(todayISO) - new Date(req.end_date)) / 86_400_000)} days
                  </div>
                )}
              </div>

              {req.return_notes && !open && !noShow && (
                <div className="mt-2 text-xs px-3 py-1.5 rounded"
                     style={{ background: '#FFFFFF', border: '1px solid #86EFAC', color: '#1F1B16' }}>
                  <span className="font-semibold" style={{ color: '#0A0A0A' }}>Note: </span>{req.return_notes}
                </div>
              )}

              {open && (
                <div className="mt-3 pt-3 border-t space-y-2" style={{ borderColor: '#86EFAC' }}>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                    <Field label="Submitted" value={req.return_submitted_at ? fmtDateShort(req.return_submitted_at) : '—'} />
                    <Field label="Return date" value={req.actual_return_date ? fmtDateShort(req.actual_return_date) : '—'} bold />
                    <Field label="Original end" value={fmtDateShort(req.end_date)} />
                    <Field label="Notes from staff" value={req.return_notes || '—'} />
                  </div>

                  {!rejectMode && (
                    <div className="flex items-center gap-2 flex-wrap pt-1">
                      <button
                        onClick={() => approve(req)}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                        style={{ background: '#0F4C2A', color: '#FFFFFF' }}>
                        {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        {scope === 'manager' ? 'Approve & forward to HR' : 'Final approve'}
                      </button>
                      <button
                        onClick={() => setRejectMode(true)}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                        style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #FCA5A5' }}>
                        Send back
                      </button>
                      {/* Preview report — HR only. Manager doesn't get
                          to download/preview the .docx because the
                          rejoining isn't 'official' until Bashaier's
                          final approval (which is when the QR code
                          becomes meaningful). */}
                      {scope === 'hr' && (
                        <button
                          onClick={() => handleDownload(req)}
                          disabled={busy}
                          className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                          style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #C9B894' }}>
                          <FileDown className="w-3 h-3" /> Preview report
                        </button>
                      )}
                      <button
                        onClick={cancel}
                        disabled={busy}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                        style={{ background: 'transparent', color: '#1F1B16' }}>
                        Close
                      </button>
                    </div>
                  )}

                  {rejectMode && (
                    <div className="space-y-2 pt-1">
                      <label className="block">
                        <span className="text-[10px] tracking-wider font-semibold block mb-1" style={{ color: '#0A0A0A' }}>
                          REASON FOR SENDING BACK (REQUIRED)
                        </span>
                        <input
                          type="text"
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="e.g. wrong return date, please correct"
                          className="w-full px-2 py-1.5 rounded text-sm"
                          style={{ border: '1px solid #FCA5A5', background: '#FFFFFF', color: '#0A0A0A' }}
                        />
                      </label>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => reject(req)}
                          disabled={busy || !reason.trim()}
                          className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                          style={{ background: '#B91C1C', color: '#FFFFFF', opacity: busy || !reason.trim() ? 0.6 : 1 }}>
                          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <X className="w-3 h-3" />}
                          Send back to staff
                        </button>
                        <button
                          onClick={() => { setRejectMode(false); setReason(''); }}
                          disabled={busy}
                          className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                          style={{ background: 'transparent', color: '#1F1B16' }}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Field({ label, value, bold }) {
  return (
    <div>
      <div className="text-[10px] tracking-wider font-semibold" style={{ color: '#0A0A0A' }}>{label}</div>
      <div className="text-xs mt-0.5" style={{ color: '#1F1B16', fontWeight: bold ? 600 : 400 }}>{value}</div>
    </div>
  );
}
