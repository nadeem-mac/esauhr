import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ArrowLeftCircle, Loader2, FileDown, AlertTriangle, Check, X } from 'lucide-react';
import { supabase, directGet, directPatch } from '../supabaseClient.js';
import { fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';
import { downloadRejoiningReportForRequest } from '../lib/rejoiningReport.js';

// =============================================================================
// PendingReturnsCard
//
// Surfaces approved leaves whose end_date has passed but where the
// employee's return has not yet been confirmed. Two scopes:
//
//   scope='manager'  →  only the current manager's direct reports
//   scope='hr'       →  every employee company-wide (HR fallback view)
//
// One-click "Mark as returned" patches:
//   returned_at         = now()
//   actual_return_date  = today (default; user can override before saving)
//   return_confirmed_by = me.id
//   return_status       = 'returned'
//
// Rows where end_date + 3 days < today AND returned_at IS NULL are
// flagged "no-show" with a warning chip — those need HR attention.
//
// Self-contained: fetches its own data, hides itself when empty,
// uses directPatch for updates (matches PendingSubstitutionsCard
// pattern — supabase-js client has wedged on similar flows).
// =============================================================================

const NO_SHOW_THRESHOLD_DAYS = 3;

export default function PendingReturnsCard({ me, employees, scope = 'manager' }) {
  const [rows,    setRows]    = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId,  setBusyId]  = useState(null);
  const [openId,  setOpenId]  = useState(null);
  const [notes,   setNotes]   = useState('');
  const [actualDate, setActualDate] = useState('');

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
    if (scope === 'manager' && (!directReportIds || directReportIds.length === 0)) {
      setRows([]); setLoading(false); return;
    }
    setLoading(true);
    try {
      // stage=approved, end_date past, returned_at IS NULL
      const filter =
        `stage=eq.approved&end_date=lt.${todayISO}&returned_at=is.null` +
        (scope === 'manager'
          ? `&employee_id=in.(${directReportIds.map(id => `"${id}"`).join(',')})`
          : '') +
        `&order=end_date.desc&limit=200`;
      const data = await directGet('leave_requests', `select=*&${filter}`, { timeoutMs: 10000 });
      setRows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn('[pending returns] load failed:', err);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [me?.id, scope, directReportIds?.join(','), todayISO]);

  useEffect(() => { load(); }, [load]);

  // Realtime — any leave row change. Re-runs the load filter so newly
  // confirmed returns disappear and freshly-ended leaves appear.
  useEffect(() => {
    if (!me?.id) return undefined;
    const channel = supabase
      .channel(`pending-returns-${scope}-${me.id}`)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'leave_requests' },
        () => { load(); })
      .subscribe();
    return () => { try { supabase.removeChannel(channel); } catch {} };
  }, [me?.id, scope, load]);

  const openConfirm = (req) => {
    setOpenId(req.id);
    setNotes('');
    // Default actual_return_date = end_date + 1 (the natural rejoining day).
    // Manager/HR can override before saving.
    const d = new Date(req.end_date);
    d.setDate(d.getDate() + 1);
    setActualDate(d.toISOString().slice(0, 10));
  };

  const cancelConfirm = () => {
    setOpenId(null);
    setNotes('');
    setActualDate('');
  };

  const confirmReturn = useCallback(async (req) => {
    if (!me?.id) return;
    setBusyId(req.id);
    try {
      await directPatch('leave_requests', 'id', req.id, {
        returned_at:         new Date().toISOString(),
        actual_return_date:  actualDate || todayISO,
        return_confirmed_by: me.id,
        return_notes:        notes.trim() || null,
        return_status:       'returned',
      }, { timeoutMs: 10000 });
      cancelConfirm();
      await load();
    } catch (err) {
      console.warn('[pending returns] confirm failed:', err);
      alert('Could not confirm return: ' + (err.message || err));
    } finally {
      setBusyId(null);
    }
  }, [me?.id, actualDate, notes, todayISO, load]);

  const handleDownload = useCallback(async (req) => {
    setBusyId(req.id);
    try {
      await downloadRejoiningReportForRequest(req, empMap);
    } catch (err) {
      console.warn('[pending returns] rejoining report failed:', err);
      alert('Could not generate rejoining report: ' + (err.message || err));
    } finally {
      setBusyId(null);
    }
  }, [empMap]);

  if (loading || rows.length === 0) return null;

  // Split into urgent (no_show) vs normal pending so the urgent ones
  // get shown first.
  const today = new Date(todayISO);
  const isNoShow = (req) => {
    const end = new Date(req.end_date);
    const ageDays = Math.floor((today - end) / 86_400_000);
    return ageDays >= NO_SHOW_THRESHOLD_DAYS;
  };
  const sorted = [...rows].sort((a, b) => {
    const aFlag = isNoShow(a) ? 1 : 0;
    const bFlag = isNoShow(b) ? 1 : 0;
    if (aFlag !== bFlag) return bFlag - aFlag;
    return new Date(a.end_date) - new Date(b.end_date);
  });

  const headline = scope === 'manager'
    ? `${rows.length} ${rows.length === 1 ? 'return' : 'returns'} pending confirmation`
    : `${rows.length} ${rows.length === 1 ? 'leave' : 'leaves'} awaiting return confirmation`;
  const subline = scope === 'manager'
    ? 'Direct reports whose approved leave has ended.'
    : 'Company-wide. HR can confirm if the manager hasn\'t yet.';

  return (
    <section className="rounded-2xl overflow-hidden mb-4"
             style={{ background: 'linear-gradient(135deg, #ECFDF5 0%, #D1FAE5 100%)', border: '1px solid #86EFAC' }}>
      <div className="px-5 py-4 flex items-center gap-2"
           style={{ borderBottom: '1px solid #86EFAC' }}>
        <ArrowLeftCircle className="w-4 h-4" style={{ color: '#0F4C2A' }} />
        <div className="flex-1">
          <div className="font-semibold text-sm" style={{ color: '#0A0A0A' }}>{headline}</div>
          <div className="text-xs" style={{ color: '#1F1B16' }}>{subline}</div>
        </div>
      </div>

      <div className="divide-y" style={{ borderColor: '#86EFAC' }}>
        {sorted.map(req => {
          const emp = empMap[req.employee_id];
          const noShow = isNoShow(req);
          const open = openId === req.id;
          const busy = busyId === req.id;
          return (
            <div key={req.id} className="px-5 py-3" style={{ background: noShow ? '#FEF2F2' : 'transparent' }}>
              <div className="flex items-center gap-3">
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
                    {noShow && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-bold"
                            style={{ background: '#FEE2E2', color: '#991B1B' }}>
                        <AlertTriangle className="w-3 h-3" /> NO-SHOW
                      </span>
                    )}
                  </div>
                </div>
                {!open && (
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => openConfirm(req)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: '#0F4C2A', color: '#FFFFFF' }}>
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      Mark as returned
                    </button>
                  </div>
                )}
              </div>

              {open && (
                <div className="mt-3 pt-3 border-t" style={{ borderColor: '#86EFAC' }}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                    <label className="block">
                      <span className="text-[10px] tracking-wider font-semibold block mb-1" style={{ color: '#0A0A0A' }}>
                        ACTUAL RETURN DATE
                      </span>
                      <input
                        type="date"
                        value={actualDate}
                        onChange={(e) => setActualDate(e.target.value)}
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
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="e.g. medical certificate submitted"
                        className="w-full px-2 py-1.5 rounded text-sm"
                        style={{ border: '1px solid #86EFAC', background: '#FFFFFF', color: '#0A0A0A' }}
                      />
                    </label>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={() => confirmReturn(req)}
                      disabled={busy || !actualDate}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: '#0F4C2A', color: '#FFFFFF', opacity: busy || !actualDate ? 0.6 : 1 }}>
                      {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                      Confirm return
                    </button>
                    <button
                      onClick={() => handleDownload(req)}
                      disabled={busy}
                      className="px-3 py-1.5 rounded-md text-xs font-semibold inline-flex items-center gap-1.5"
                      style={{ background: '#FFFFFF', color: '#0A0A0A', border: '1px solid #C9B894' }}>
                      <FileDown className="w-3 h-3" /> Rejoining report (preview)
                    </button>
                    <button
                      onClick={cancelConfirm}
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
