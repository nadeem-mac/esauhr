// ──────────────────────────────────────────────────────────────────────
//  Logbook — private manual-entry workspace for Bashaier
//
//  Records paper/email leave applications she's still receiving offline.
//  Each entry writes straight to the master leave_requests table as
//  fully approved, so balances on the staff dashboard update immediately.
//
//  Nadeem 2026-05-21: 'a separate tab which stays exclusively for
//  Bashaier where she can manually enter annual leaves by herself …
//  the data when she enters it gets updated in the master'
//
//  Access is hard-gated upstream in AppShell to two PSNs:
//    H94830 (Bashaier), H94152 (Nadeem — admin oversight)
//  No one else sees the tab.
//
// ── DESIGN ──────────────────────────────────────────────────────────
//
//  Single-page form, top to bottom:
//    1. Employee picker  — typeahead by name or PSN
//    2. Leave type       — defaults to Annual
//    3. Date range       — start + end, plus a half-day toggle
//    4. Days (computed)  — read-only, mirrors what the portal computes
//    5. Reason / source  — free-text ('Received via email 18 May',
//                          'Verbal request approved by John')
//    6. Save             — writes to leave_requests with stage='approved'
//
//  Below the form, a 'Recently logged' table shows the last 10 entries
//  she's made so she can spot-check what she's added.
//
// ── WHAT GETS WRITTEN ───────────────────────────────────────────────
//
//  leave_requests row with:
//    stage:                 'approved'   (skip the workflow)
//    status:                'approved'   (legacy mirror)
//    requested_at:          now
//    manager_decided_at:    now
//    hr_decided_at:         now
//    substitute_ids:        []           (paper leaves don't go through
//    substitute_decisions:  {}            the online substitute-acceptance
//                                          loop — empty arrays/objects
//                                          signal 'no subs' to the PDF)
//    reason:                'Manual entry · ' + the source field
//    requested_by:          me.id        (Bashaier as the entry agent)
//
//  Balance computation picks this up automatically because
//  calculateBalance counts every stage='approved' row toward 'used'.
// ──────────────────────────────────────────────────────────────────────

import React, { useState, useMemo, useEffect } from 'react';
import { directGet, directPost, directDelete, directPatch } from '../supabaseClient.js';
import { NotebookPen, Save, Loader2, Search, CheckCircle2, AlertCircle, Wallet, Trash2, Mail, FileText } from 'lucide-react';
import { calculateRequestDays, calculateBalance, fmtDate } from '../lib/leaveLogic.js';
import { generateLogbookPdfBlob } from '../lib/leaveApplicationPdf.js';
import { generateVacationFormBlob, buildEmailDraft, downloadBlob } from '../lib/vacationForm.js';
import LeaveApprovedModal from './LeaveApprovedModal.jsx';
import LogbookPermissionEntry from './LogbookPermissionEntry.jsx';
import LogbookRejoiningEntry from './LogbookRejoiningEntry.jsx';
import LeaveHistoryImportCard from './LeaveHistoryImportCard.jsx';

export default function Logbook({ me, employees = [], leaveTypes = [], onSaved }) {
  const [mode, setMode] = useState('leave');   // 'leave' | 'permission'
  const [empQuery, setEmpQuery] = useState('');
  const [empId, setEmpId] = useState('');
  const [leaveType, setLeaveType] = useState('annual');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [isHalfDay, setIsHalfDay] = useState(false);
  // Multiple separate (non-consecutive) dates in one entry — e.g. exam
  // leave on the 15th and the 18th. Bashaier adds each date as a chip;
  // on save the system groups consecutive dates into ranges and creates
  // one approved leave_request per run (so 15 & 18 → two 1-day rows).
  const [multiMode, setMultiMode] = useState(false);
  const [extraDates, setExtraDates] = useState([]);   // ISO 'YYYY-MM-DD'
  const [holidays, setHolidays] = useState([]);       // public_holidays {date,name}
  const [newDate, setNewDate] = useState('');
  const [reason, setReason] = useState('');
  // Required — date the paper/email application was received from
  // the staff member. Drives the 'Submitted' + 'Notice' rows on
  // the printed form so the PDF reflects the actual application
  // date, not when Bashaier happened to log it. Nadeem 2026-05-21.
  const [applicationDate, setApplicationDate] = useState('');
  // Required — how the application arrived. Either 'email' (an
  // email/forwarded message) or 'paper' (a physical signed form).
  // Surfaces in the reason text → REASON / remarks column on the
  // printed PDF so HR can later see how each historical entry
  // originated. Nadeem 2026-05-21.
  const [submissionMethod, setSubmissionMethod] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [recent, setRecent] = useState([]);
  const [deletingId, setDeletingId] = useState(null);
  // Manual override for the day count. When null, the form uses the
  // auto-calculated working-days figure (MOL Article 113). Bashaier
  // can override when the paper application explicitly states a
  // different number — e.g. calendar-day counts that include
  // weekends, which is how the legacy Excel tracker recorded leaves.
  const [daysOverride, setDaysOverride] = useState(null);
  const [savedModal, setSavedModal] = useState(null);
  const [docId, setDocId] = useState(null);
  // Substitutes — Bashaier picks from the staff's own department +
  // location (same eligibility rules as the main workflow). Since
  // she's recording a paper application that's already been signed
  // off, the picked substitutes auto-record as 'accepted' with the
  // current timestamp. Max 3, matching the regular flow's cap.
  const [substituteIds, setSubstituteIds] = useState([]);
  const [subSearch, setSubSearch] = useState('');
  // When the staff's paper application names someone from a different
  // department in the same location (common in small branches like JED
  // where LOG + BIZ work hand-in-hand), Bashaier toggles this on to
  // widen the eligibility pool. Defaults off so the strict same-dept
  // rule of the main workflow stays the safer default.
  const [widenSubPool, setWidenSubPool] = useState(false);
  const [balance, setBalance] = useState(null);
  const [balanceLoading, setBalanceLoading] = useState(false);

  // ── Employee search ────────────────────────────────────────────────
  const empMatches = useMemo(() => {
    const q = (empQuery || '').trim().toLowerCase();
    if (!q || q.length < 2) return [];
    return (employees || [])
      .filter(e =>
        e.id?.toLowerCase().includes(q) ||
        (e.name || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [empQuery, employees]);

  const selectedEmp = useMemo(
    () => (employees || []).find(e => e.id === empId),
    [empId, employees]
  );

  // ── Day count ──────────────────────────────────────────────────────
  const lt = useMemo(
    () => (leaveTypes || []).find(t => t.id === leaveType) || { id: 'annual' },
    [leaveType, leaveTypes]
  );
  // Auto-calc — calendar days, with official public holidays (Eid etc.)
  // inside the period automatically NOT deducted (KSA Labor Law).
  const autoDays = useMemo(() => {
    if (!startDate || !endDate) return 0;
    return calculateRequestDays(startDate, endDate, lt, holidays, isHalfDay);
  }, [startDate, endDate, lt, isHalfDay, holidays]);
  // Final days to insert — manual override takes precedence
  const days = multiMode
    ? extraDates.length
    : (daysOverride != null && daysOverride !== '' ? Number(daysOverride) : autoDays);

  const addExtraDate = () => {
    if (!newDate) return;
    setExtraDates(prev => prev.includes(newDate) ? prev : [...prev, newDate].sort());
    setNewDate('');
  };
  const removeExtraDate = (d) => setExtraDates(prev => prev.filter(x => x !== d));

  // Group sorted ISO dates into consecutive runs → [{start, end, count}].
  const groupRuns = (dates) => {
    const sorted = [...new Set(dates)].sort();
    const runs = [];
    const nextIso = (iso) => { const [y, m, dd] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, dd + 1)).toISOString().slice(0, 10); };
    let run = null;
    for (const d of sorted) {
      if (run && nextIso(run.end) === d) { run.end = d; run.count++; }
      else { if (run) runs.push(run); run = { start: d, end: d, count: 1 }; }
    }
    if (run) runs.push(run);
    return runs;
  };

  // ── Public holidays — so the day count auto-excludes Eid etc. ──────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await directGet('public_holidays', 'select=date,name&order=date', { timeoutMs: 8000 });
        if (!cancelled) setHolidays(rows || []);
      } catch (e) {
        console.warn('logbook holidays load failed:', e?.message || e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Recent entries — last 10 manual entries Bashaier logged ────────
  useEffect(() => {
    let cancelled = false;
    const loadRecent = async () => {
      try {
        const rows = await directGet(
          'leave_requests',
          `select=id,employee_id,leave_type_id,start_date,end_date,days,reason,is_half_day,requested_at,manager_decided_at,hr_decided_at,substitute_ids,substitute_decisions`
          + `&reason=ilike.Manual entry*`
          + `&order=hr_decided_at.desc.nullslast&limit=2000`,
          { timeoutMs: 10000 }
        );
        if (!cancelled) setRecent(rows || []);
      } catch (e) {
        console.warn('logbook recent load failed:', e?.message || e);
      }
    };
    loadRecent();
    return () => { cancelled = true; };
  }, [msg]);  // reload after each successful save

  // ── Group logged entries by the month they were entered (logged) ──────
  const recentGroups = useMemo(() => {
    const map = new Map();
    (recent || []).forEach(r => {
      const dt = r.hr_decided_at || r.requested_at || r.start_date;
      const d = dt ? new Date(dt) : null;
      const key = d && !isNaN(d) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` : '0000-00';
      if (!map.has(key)) {
        map.set(key, {
          key,
          label: d && !isNaN(d) ? d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'Undated',
          items: [],
        });
      }
      map.get(key).items.push(r);
    });
    return [...map.values()].sort((a, b) => b.key.localeCompare(a.key));
  }, [recent]);

  // Reset substitutes whenever the picked employee changes — they're
  // department-scoped, so swapping employees invalidates the previous
  // picks. Also clears the search box.
  useEffect(() => {
    setSubstituteIds([]);
    setSubSearch('');
    setWidenSubPool(false);
  }, [empId]);

  // ── Live balance for the selected employee + leave type ─────────────
  // Fetches leave_balances + this employee's approved leave_requests
  // for the current year, then runs calculateBalance to get the
  // entitled/used/available figures. Re-runs when empId or leaveType
  // changes (and after each save via `msg` dependency).
  useEffect(() => {
    if (!empId || !leaveType) { setBalance(null); return; }
    let cancelled = false;
    const year = new Date().getFullYear();
    setBalanceLoading(true);
    (async () => {
      try {
        const [reqs, bals] = await Promise.all([
          directGet('leave_requests',
            `select=id,employee_id,leave_type_id,start_date,end_date,days,stage,status`
            + `&employee_id=eq.${encodeURIComponent(empId)}`
            + `&leave_type_id=eq.${encodeURIComponent(leaveType)}`,
            { timeoutMs: 8000 }),
          directGet('leave_balances',
            `select=carried_over,adjustment,adjustment_note`
            + `&employee_id=eq.${encodeURIComponent(empId)}`
            + `&leave_type_id=eq.${encodeURIComponent(leaveType)}`
            + `&year=eq.${year}&limit=1`,
            { timeoutMs: 8000 }),
        ]);
        if (cancelled) return;
        const emp = (employees || []).find(e => e.id === empId);
        const ltRow = (leaveTypes || []).find(t => t.id === leaveType);
        if (!emp || !ltRow) { setBalance(null); return; }
        const adj = bals?.[0] || {};
        const result = calculateBalance({
          employee: emp,
          leaveType: ltRow,
          year,
          requests: reqs || [],
          adjustments: {
            carried_over: Number(adj.carried_over || 0),
            adjustment:   Number(adj.adjustment   || 0),
          },
          asOf: new Date(),
        });
        if (!cancelled) setBalance({ ...result, adjustment_note: adj.adjustment_note });
      } catch (e) {
        console.warn('logbook balance fetch failed:', e?.message || e);
        if (!cancelled) setBalance(null);
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [empId, leaveType, employees, leaveTypes, msg]);

  // ── Submit ─────────────────────────────────────────────────────────
  // applicationDate is REQUIRED — Bashaier must capture when the
  // paper or email application was received. This date drives both
  // the Submitted row and the Notice calculation (Planned vs Urgent)
  // on the printed form, so it has to match the staff's actual
  // submission moment, not the moment Bashaier logs the entry.
  const canSave = empId && leaveType && days > 0 && applicationDate && submissionMethod && !busy
    && (multiMode ? extraDates.length > 0 : (startDate && endDate));

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setMsg(null);
    try {
      const now = new Date().toISOString();
      // requested_at = noon on the application date (ISO). Noon avoids
      // timezone surprises that could push the date backward when
      // converted to GMT for storage.
      const requestedAtIso = `${applicationDate}T12:00:00.000Z`;
      const appDateLabel = new Date(applicationDate).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric',
      });
      // Same shape PendingSubstitutionsCard writes on online accept.
      const isSick = leaveType === 'sick';
      const subIds = isSick ? [] : substituteIds;
      const subDecisions = {};
      subIds.forEach(psn => {
        // Substitute acceptance timestamp pinned to the application
        // date too — keeps the paper trail internally consistent.
        subDecisions[psn] = { decision: 'accepted', at: requestedAtIso };
      });
      const sourceNote = reason.trim();
      // 'paper application received' or 'email received' — concrete
      // wording in the PDF remarks column shows how each historical
      // entry was captured.
      const methodPhrase = submissionMethod === 'paper'
        ? `paper application received ${appDateLabel}`
        : `email received ${appDateLabel}`;

      // ── Multiple separate dates → one approved row per consecutive run ──
      if (multiMode) {
        const runs = groupRuns(extraDates);
        const baseReason = sourceNote
          ? `Manual entry · ${methodPhrase} · ${sourceNote}`
          : `Manual entry · ${methodPhrase}`;
        let created = 0;
        for (const r of runs) {
          await directPost('leave_requests', {
            employee_id:          empId,
            leave_type_id:        leaveType,
            start_date:           r.start,
            end_date:             r.end,
            days:                 r.count,
            is_half_day:          null,
            reason:               baseReason,
            stage:                'approved',
            status:               'approved',
            requested_at:         requestedAtIso,
            manager_decided_at:   requestedAtIso,
            hr_decided_at:        requestedAtIso,
            substitute_ids:       subIds,
            substitute_decisions: subDecisions,
            requested_by:         me?.id || null,
          });
          created++;
        }
        const emp = (employees || []).find(e => e.id === empId);
        const niceDates = extraDates.map(d => new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })).join(', ');
        setMsg({ kind: 'ok', text: `Logged ${lt?.name || leaveType} for ${emp?.name || empId}: ${niceDates} · ${extraDates.length} day(s) in ${created} ${created === 1 ? 'entry' : 'entries'}.` });
        setEmpQuery(''); setEmpId('');
        setStartDate(''); setEndDate(''); setIsHalfDay(false);
        setMultiMode(false); setExtraDates([]); setNewDate('');
        setReason(''); setApplicationDate(''); setSubmissionMethod('');
        setDaysOverride(null);
        onSaved?.();
        setBusy(false);
        return;
      }

      const payload = {
        employee_id:         empId,
        leave_type_id:       leaveType,
        start_date:          startDate,
        end_date:            endDate,
        days,
        is_half_day:         isHalfDay || null,
        // Reason embeds the application method + date so the PDF's
        // REASON section (a.k.a. remarks column) reads naturally:
        //   'Manual entry · paper application received DD MMM YYYY · <notes>'
        //   'Manual entry · email received DD MMM YYYY · <notes>'
        // When the optional notes field is blank, the trailing
        // separator is dropped so the line ends cleanly.
        reason: sourceNote
          ? `Manual entry · ${methodPhrase} · ${sourceNote}`
          : `Manual entry · ${methodPhrase}`,
        stage:               'approved',
        status:              'approved',
        // requested_at = actual application date (not log time)
        requested_at:        requestedAtIso,
        // Manager / HR decisions also pinned to the application date
        // so the form reads as if the workflow had completed on that
        // day — consistent with how paper approvals work.
        manager_decided_at:  requestedAtIso,
        hr_decided_at:       requestedAtIso,
        substitute_ids:      subIds,
        substitute_decisions: subDecisions,
        requested_by:        me?.id || null,
      };
      const inserted = await directPost('leave_requests', payload);
      const newRow = Array.isArray(inserted) ? inserted[0] : inserted;

      // Resolve the context the LeaveApprovedModal expects: the
      // employee, their manager (for CC + signature block), the HR
      // approver (Bashaier = me), and a small empMap for sick-leave
      // CC lookups. Annual leaves don't need badria/fahad so empMap
      // can be sparse — modal handles missing entries gracefully.
      const emp = (employees || []).find(e => e.id === empId);
      const mgr = emp?.manager_id
        ? (employees || []).find(e => e.id === emp.manager_id)
        : null;
      const empMap = (employees || []).reduce((acc, e) => {
        acc[e.id] = e;
        return acc;
      }, {});

      setSavedModal({
        request:    newRow,
        employee:   emp,
        manager:    mgr,
        hrApprover: me,
        empMap,
        // Look up each substitute's employee record so the PDF table
        // renders the full name/PSN, then the modal pulls the
        // 'accepted'+timestamp from substitute_decisions on the row.
        substitutes: subIds
          .map(psn => (employees || []).find(e => e.id === psn))
          .filter(Boolean),
      });

      setMsg({ kind: 'ok', text: `Logged ${days}d for ${emp?.name || empId}` });
      // Clear form so the next entry starts fresh
      setEmpQuery('');
      setEmpId('');
      setStartDate('');
      setEndDate('');
      setIsHalfDay(false);
      setReason('');
      setApplicationDate('');
      setSubmissionMethod('');
      setDaysOverride(null);
      setSubstituteIds([]);
      setSubSearch('');
      onSaved?.();
    } catch (err) {
      console.error('logbook save error:', err);
      setMsg({ kind: 'err', text: err?.message || 'Failed to log entry' });
    } finally {
      setBusy(false);
    }
  };

  // Delete a mistakenly-logged entry. Removes the leave_requests row and
  // reverts any attendance_daily days that were linked to it, so the
  // record (and the staff member's leave balance, which is computed from
  // Manually-prepared Word .docx for a logged leave — WITHOUT the QR code
  // and Ref number (manual:true), so it reads as hand-prepared. Temporary
  // until the full system launch. (Nadeem 2026-06-08)
  const downloadLeaveWord = async (r, e) => {
    setDocId(r.id);
    try {
      const manager = e?.manager_id ? (employees || []).find(x => x.id === e.manager_id) : null;
      const subs = (r.substitute_ids || []).map(psn => (employees || []).find(x => x.id === psn)).filter(Boolean);
      const blob = await generateVacationFormBlob({
        employee: e || { id: r.employee_id, name: r.employee_id },
        request: r, manager, hrApprover: me, substitutes: subs, manual: true,
      });
      downloadBlob(blob, `Leave_${(e?.name || r.employee_id).replace(/\s+/g, '_')}_${r.start_date}.docx`);
    } catch (err) {
      console.error('leave word doc failed:', err);
    } finally {
      setDocId(null);
    }
  };

  const emailLeave = (r, e) => {
    try {
      const manager = e?.manager_id ? (employees || []).find(x => x.id === e.manager_id) : null;
      const subs = (r.substitute_ids || []).map(psn => (employees || []).find(x => x.id === psn)).filter(Boolean);
      const draft = buildEmailDraft({ employee: e || { id: r.employee_id, name: r.employee_id }, request: r, manager, hrApprover: me, substitutes: subs });
      window.open(draft.mailto, '_blank');
    } catch (err) {
      console.error('leave email draft failed:', err);
    }
  };

  // leave_requests) updates correctly. Nadeem 2026-06-03.
  const deleteEntry = async (r) => {
    const emp = (employees || []).find(x => x.id === r.employee_id);
    const who = emp?.name || r.employee_id;
    const period = `${fmtDate(new Date(r.start_date))}${r.end_date && r.end_date !== r.start_date ? ` → ${fmtDate(new Date(r.end_date))}` : ''}`;
    if (!window.confirm(
      `Delete this logged ${r.leave_type_id} entry for ${who} (${period})?\n\n` +
      `This permanently removes the leave record, restores the leave balance, and reverts those days in attendance. This cannot be undone.`
    )) return;
    setDeletingId(r.id);
    try {
      // 1) Revert any attendance_daily rows linked to this leave request —
      //    clear the link and re-derive a basic status from the punch.
      try {
        const linked = await directGet(
          'attendance_daily',
          `select=id,first_punch,last_punch&leave_request_id=eq.${r.id}`,
          { timeoutMs: 10000 },
        );
        for (const a of (linked || [])) {
          await directPatch('attendance_daily', 'id', a.id, {
            leave_request_id: null,
            status: a.first_punch ? 'present' : 'absent',
          });
        }
      } catch (e) {
        console.warn('attendance revert during delete failed:', e?.message || e);
      }
      // 2) Delete the leave record itself.
      await directDelete('leave_requests', `id=eq.${r.id}`);
      // 3) Update the list + refresh the monthly grid.
      setRecent(prev => prev.filter(x => x.id !== r.id));
      try { window.dispatchEvent(new CustomEvent('esau:attendance-changed')); } catch {}
      setMsg({ kind: 'ok', text: `Deleted logged entry for ${who}` });
    } catch (e) {
      console.error('logbook delete failed:', e);
      setMsg({ kind: 'err', text: `Delete failed: ${e?.message || e}` });
    } finally {
      setDeletingId(null);
    }
  };
  // Bashaier (H94830) — pink themed; everyone else keeps the green.
  const isPink   = me?.id === 'H94830';
  const ACCENT   = isPink ? '#993556' : '#0F4C2A';   // primary fill / kicker
  const ACCENT_BG= isPink ? '#FBEAF0' : 'rgba(15,76,42,0.05)'; // soft wash
  const ACCENT_BD= isPink ? '#F4C0D1' : 'rgba(15,76,42,0.18)'; // soft border
  // Leave-history import is an HR/admin-only tool (Bashaier included).
  const isAdminHr = !!(me?.is_admin || me?.is_hr_reviewer || me?.id === 'H94830');
  const MODES = [['leave', 'Leave'], ['permission', 'Permission'], ['rejoining', 'Rejoining'],
    ...(isAdminHr ? [['import', 'Import']] : [])];
  const REQ_BD   = isPink ? '#ED93B1' : '#FCD34D';   // required-field border
  const REQ_BG   = isPink ? '#FBEAF0' : '#FFFBEB';   // required-field bg
  const REQ_FG   = isPink ? '#993556' : '#854F0B';   // required-field text
  return (
    <div className="space-y-5 p-4 max-w-5xl mx-auto">
      <header className="flex items-center gap-2.5 pb-3 border-b border-black/10">
        <NotebookPen size={20} style={{ color: ACCENT }} />
        <div>
          <h2 className="text-lg font-semibold leading-tight" style={{ color: '#1F1B16' }}>
            Logbook
          </h2>
          <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
            Manual entry for paper / email applications
          </div>
        </div>
      </header>

      {/* Leave / Permission / Rejoining mode switch — equal rounded boxes */}
      <div className="flex gap-2">
        {MODES.map(([k, lbl]) => (
          <button key={k} type="button" onClick={() => setMode(k)}
            className="flex-1 text-center text-sm font-semibold border transition"
            style={{
              height: 40, borderRadius: 8,
              ...(mode === k
                ? { background: ACCENT, color: '#FFFFFF', borderColor: ACCENT }
                : { background: '#FFFFFF', color: '#1F1B16', borderColor: 'rgba(0,0,0,0.15)' }),
            }}>
            {lbl}
          </button>
        ))}
      </div>

      {mode === 'permission' && (
        <LogbookPermissionEntry me={me} employees={employees} onSaved={onSaved} />
      )}

      {mode === 'rejoining' && (
        <LogbookRejoiningEntry me={me} employees={employees} onSaved={onSaved} />
      )}

      {mode === 'import' && isAdminHr && (
        <LeaveHistoryImportCard me={me} employees={employees} onSaved={onSaved} />
      )}

      {mode === 'leave' && (<>
      <div className="space-y-5">
      {/* TOP — form */}
      <div className="space-y-4 min-w-0">
      {/* Form */}
      <div className="rounded-xl border bg-white p-4 space-y-3" style={{ borderColor: ACCENT_BD }}>
        {/* Employee picker */}
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Employee
          </label>
          {selectedEmp ? (
            <div className="flex items-center justify-between rounded border border-black/15 bg-black/[0.02] px-3 py-2">
              <div>
                <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                  {selectedEmp.name}
                </div>
                <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
                  {selectedEmp.id} · {selectedEmp.department || '—'}
                </div>
              </div>
              <button
                onClick={() => { setEmpId(''); setEmpQuery(''); }}
                className="text-xs underline"
                style={{ color: '#0F4C2A' }}>
                change
              </button>
            </div>
          ) : (
            <div className="relative">
              <div className="flex items-center gap-2 rounded border border-black/15 bg-white px-3 py-2">
                <Search size={14} style={{ color: '#1F1B16', opacity: 0.5 }} />
                <input
                  className="flex-1 text-sm outline-none"
                  placeholder="Search by name or PSN (e.g. Nadeem, H94328)…"
                  value={empQuery}
                  onChange={(e) => setEmpQuery(e.target.value)}
                  autoFocus
                />
              </div>
              {empMatches.length > 0 && (
                <ul className="absolute z-10 mt-1 w-full rounded border border-black/15 bg-white shadow-lg max-h-64 overflow-y-auto">
                  {empMatches.map(e => (
                    <li key={e.id}>
                      <button
                        onClick={() => { setEmpId(e.id); setEmpQuery(''); }}
                        className="w-full text-left px-3 py-2 hover:bg-black/[0.04] border-b border-black/5 last:border-0">
                        <div className="text-sm font-medium" style={{ color: '#1F1B16' }}>
                          {e.name}
                        </div>
                        <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
                          {e.id} · {e.department || '—'} · {e.location || ''}
                        </div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {/* Live balance for the selected employee + leave type.
            Updates whenever Bashaier changes either dropdown, AND
            after every save so she can confirm the deduction took
            effect. */}
        {selectedEmp && (
          <div className="rounded border px-3 py-2"
               style={{ background: ACCENT_BG, borderColor: ACCENT_BD }}>
            <div className="flex items-center gap-2 mb-1.5">
              <Wallet size={13} style={{ color: ACCENT }} />
              <span className="text-xs font-semibold uppercase tracking-wide"
                    style={{ color: ACCENT }}>
                Current {leaveType} balance · {new Date().getFullYear()}
              </span>
              {balanceLoading && <Loader2 size={11} className="animate-spin" style={{ color: ACCENT }} />}
            </div>
            {balance ? (
              <>
                <div className="grid grid-cols-4 gap-2 text-center text-xs">
                  <BalanceCell label="ENTITLED"  val={balance.entitlement}
                               fg="#1D4ED8" bg="#DBEAFE" />
                  <BalanceCell label="CARRIED"   val={balance.carried}
                               fg="#A16207" bg="#FEF3C7" />
                  <BalanceCell label="USED+PEND" val={balance.used + balance.pending}
                               fg="#B84A3E" bg="#FEE2E2" />
                  <BalanceCell label="AVAILABLE" val={balance.available}
                               fg={balance.available < 0 ? '#B84A3E' : '#0F4C2A'}
                               bg={balance.available < 0 ? '#FEE2E2' : '#D1FAE5'}
                               emphasize />
                </div>
                {/* After-this-request preview */}
                {days > 0 && (
                  <div className="mt-2 pt-2 border-t border-black/10 flex items-center justify-between text-xs"
                       style={{ color: '#1F1B16' }}>
                    <span style={{ opacity: 0.7 }}>
                      After this {days}-day entry:
                    </span>
                    <strong style={{
                      color: (balance.available - days) < 0 ? '#B84A3E' : '#0F4C2A'
                    }}>
                      {(balance.available - days).toFixed(1)} days
                      {(balance.available - days) < 0 && ' (over)'}
                    </strong>
                  </div>
                )}
                {/* Carry-forward callout — surfaces whenever there's
                    a non-zero carry, with the prior year named so
                    Bashaier sees where the extra days came from.
                    Nadeem 2026-05-21. */}
                {balance.carried > 0 && (
                  <div className="mt-2 pt-2 border-t border-black/10 flex items-center gap-1.5 text-xs"
                       style={{ color: '#A16207' }}>
                    <span aria-hidden="true">↩</span>
                    <span>
                      Includes <strong>{balance.carried}</strong>
                      {' '}{balance.carried === 1 ? 'day' : 'days'} carried forward from {new Date().getFullYear() - 1}
                    </span>
                  </div>
                )}
                {balance.adjustment_note && (
                  <div className="mt-1.5 text-[10px]" style={{ color: '#1F1B16', opacity: 0.55 }}>
                    Note: {balance.adjustment_note}
                  </div>
                )}
              </>
            ) : !balanceLoading && (
              <p className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
                No balance row yet (defaults to entitlement only).
              </p>
            )}
          </div>
        )}

        {/* Leave type */}
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Leave type
          </label>
          <select
            value={leaveType}
            onChange={(e) => setLeaveType(e.target.value)}
            className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none">
            {(leaveTypes || []).map(t => (
              <option key={t.id} value={t.id}>{t.label || t.id}</option>
            ))}
            {/* fallback if leaveTypes hasn't loaded */}
            {(leaveTypes || []).length === 0 && (
              <option value="annual">Annual</option>
            )}
          </select>
        </div>

        {/* Multiple separate dates toggle */}
        <label className="flex items-center gap-2 text-sm" style={{ color: '#1F1B16' }}>
          <input
            type="checkbox"
            checked={multiMode}
            onChange={(e) => { setMultiMode(e.target.checked); setDaysOverride(null); }}
          />
          Multiple separate dates (e.g. exam leave on the 15th &amp; 18th)
        </label>

        {/* Dates + half-day */}
        {!multiMode ? (
        <>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
              Start date
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
              End date
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm" style={{ color: '#1F1B16' }}>
          <input
            type="checkbox"
            checked={isHalfDay}
            onChange={(e) => setIsHalfDay(e.target.checked)}
          />
          Half-day request
        </label>

        {/* Day count — auto from MOL working-day calc, but Bashaier can
            override when the paper application uses calendar days */}
        {startDate && endDate && (
          <div className="rounded bg-black/[0.03] px-3 py-2 space-y-2">
            <div className="flex items-center gap-3 text-sm" style={{ color: '#1F1B16' }}>
              <span>Duration:</span>
              <input
                type="number"
                step="0.5"
                min="0"
                value={daysOverride != null ? daysOverride : autoDays}
                onChange={(e) => setDaysOverride(e.target.value)}
                className="w-20 text-sm rounded border border-black/15 bg-white px-2 py-1 outline-none font-semibold"
              />
              <span style={{ opacity: 0.7 }}>
                {days === 1 ? 'day' : 'days'}
              </span>
              {daysOverride != null && Number(daysOverride) !== autoDays && (
                <button
                  onClick={() => setDaysOverride(null)}
                  className="text-xs underline ml-auto"
                  style={{ color: '#0F4C2A' }}>
                  reset to auto ({autoDays})
                </button>
              )}
            </div>
            <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
              {fmtDate(new Date(startDate))} → {fmtDate(new Date(endDate))}
              {' · '}
              {daysOverride == null
                ? `auto-computed calendar days (KSA Art. 109 — weekends counted, official Eid/public holidays not deducted)`
                : Number(daysOverride) !== autoDays
                  ? `manual override · auto was ${autoDays} days`
                  : `auto-computed calendar days (KSA Art. 109 — weekends counted, official Eid/public holidays not deducted)`}
            </div>
          </div>
        )}
        </>
        ) : (
        <div className="space-y-2">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>Leave dates</label>
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={newDate}
              onChange={(e) => setNewDate(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtraDate(); } }}
              className="text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none"
            />
            <button type="button" onClick={addExtraDate} disabled={!newDate}
              className="text-sm font-semibold px-3 py-2 rounded text-white disabled:opacity-50"
              style={{ background: ACCENT }}>
              + Add date
            </button>
          </div>
          {extraDates.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {extraDates.map(d => (
                <span key={d} className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-full"
                      style={{ background: ACCENT_BG, color: ACCENT, border: `1px solid ${ACCENT_BD}` }}>
                  {new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })}
                  <button type="button" onClick={() => removeExtraDate(d)} className="font-bold" style={{ lineHeight: 1 }}>×</button>
                </span>
              ))}
            </div>
          ) : (
            <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>Add each leave date — they need not be consecutive. Consecutive dates are merged into one entry automatically.</div>
          )}
          {extraDates.length > 0 && (
            <div className="text-xs font-semibold" style={{ color: ACCENT }}>
              {extraDates.length} day(s) · {groupRuns(extraDates).length} entr{groupRuns(extraDates).length === 1 ? 'y' : 'ies'} will be created
            </div>
          )}
        </div>
        )}

        {/* Application received: how + when. Both required.
            Drive the 'Submitted' + 'Notice' rows on the printed
            form, and surface in the REASON / remarks column so each
            historical entry says how it was originally captured. */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase flex items-center gap-1.5" style={{ color: '#1F1B16' }}>
              Received via
              <span className="text-[9px] px-1.5 py-0.5 rounded"
                    style={{ background: REQ_BG, color: REQ_FG, fontWeight: 700 }}>
                REQUIRED
              </span>
            </label>
            <select
              value={submissionMethod}
              onChange={(e) => setSubmissionMethod(e.target.value)}
              className="w-full text-sm rounded border px-3 py-2 outline-none"
              style={{
                borderColor: submissionMethod ? 'rgba(0,0,0,0.15)' : REQ_BD,
                background: submissionMethod ? '#FFFFFF' : REQ_BG,
              }}>
              <option value="">— select —</option>
              <option value="paper">📄 Paper application</option>
              <option value="email">📧 Email</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-semibold uppercase flex items-center gap-1.5" style={{ color: '#1F1B16' }}>
              Received on
              <span className="text-[9px] px-1.5 py-0.5 rounded"
                    style={{ background: REQ_BG, color: REQ_FG, fontWeight: 700 }}>
                REQUIRED
              </span>
            </label>
            <input
              type="date"
              value={applicationDate}
              onChange={(e) => setApplicationDate(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              className="w-full text-sm rounded border px-3 py-2 outline-none"
              style={{
                borderColor: applicationDate ? 'rgba(0,0,0,0.15)' : REQ_BD,
                background: applicationDate ? '#FFFFFF' : REQ_BG,
              }}
            />
          </div>
        </div>
        <p className="text-[10px] -mt-1" style={{ color: '#1F1B16', opacity: 0.6 }}>
          The date the {submissionMethod === 'paper' ? 'paper form was signed' : submissionMethod === 'email' ? 'email arrived' : 'application was received'} —
          drives the printed form's <strong>Submitted</strong> row and the <strong>Planned vs Urgent</strong> notice computation.
        </p>

        {/* Reason / source */}
        <div className="space-y-1">
          <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
            Source / notes <span style={{ opacity: 0.6 }}>(optional)</span>
          </label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. paper form received in person · approved by Sadakathullah"
            className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none min-h-[60px]"
          />
        </div>

        {/* Substitutes — same eligibility rule as the main workflow
            (same department + same location, max 3, can't pick self).
            Bashaier picks who appeared on the paper application; they
            auto-record as 'accepted' with the save timestamp so the
            PDF renders the green 'Accepted online' stamp. Hidden for
            sick leaves — matches main flow. */}
        {selectedEmp && leaveType !== 'sick' && (
          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase" style={{ color: '#1F1B16' }}>
              Substitutes
              <span className="font-normal" style={{ opacity: 0.6 }}>
                {' '}(pick up to 3 from {widenSubPool
                  ? `${selectedEmp.location || '—'} · any dept`
                  : `${selectedEmp.department || '—'} · ${selectedEmp.location || '—'}`})
              </span>
            </label>

            {/* Picked subs as removable chips */}
            {substituteIds.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {substituteIds.map(id => {
                  const e = (employees || []).find(x => x.id === id);
                  return (
                    <span key={id}
                          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs"
                          style={{ background: '#D1FAE5', color: '#0F4C2A' }}>
                      <CheckCircle2 size={11} />
                      <span style={{ fontWeight: 500 }}>{e?.name || id}</span>
                      {e?.department && e.department !== selectedEmp.department && (
                        <span style={{ opacity: 0.7 }}>· {e.department}</span>
                      )}
                      <button type="button"
                              onClick={() => setSubstituteIds(substituteIds.filter(x => x !== id))}
                              className="ml-1 hover:opacity-70"
                              aria-label="Remove substitute">
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}

            {substituteIds.length < 3 ? (
              <>
                <input
                  value={subSearch}
                  onChange={(e) => setSubSearch(e.target.value)}
                  placeholder="Search by name or PSN…"
                  className="w-full text-sm rounded border border-black/15 bg-white px-3 py-2 outline-none"
                />
                <div className="max-h-32 overflow-y-auto rounded border border-black/10">
                  {(() => {
                    const pool = (employees || []).filter(e =>
                      e.id !== selectedEmp.id &&
                      // Same location always required. Department match
                      // required UNLESS Bashaier has widened the pool.
                      e.location === selectedEmp.location &&
                      (widenSubPool || e.department === selectedEmp.department) &&
                      !substituteIds.includes(e.id) &&
                      (!subSearch ||
                        (e.name || '').toLowerCase().includes(subSearch.toLowerCase()) ||
                        e.id.toLowerCase().includes(subSearch.toLowerCase()))
                    ).slice(0, 12);
                    if (pool.length === 0) {
                      return (
                        <div className="px-3 py-2 text-xs" style={{ color: '#1F1B16', opacity: 0.55 }}>
                          No eligible colleagues from {widenSubPool
                            ? `${selectedEmp.location || '—'}`
                            : `${selectedEmp.department || '—'} · ${selectedEmp.location || '—'}`}.
                          {!widenSubPool && ' Try the toggle below to widen the pool.'}
                        </div>
                      );
                    }
                    return pool.map(e => (
                      <button key={e.id} type="button"
                              onClick={() => { setSubstituteIds([...substituteIds, e.id]); setSubSearch(''); }}
                              className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-black/[0.04] border-b border-black/5 last:border-0 text-left">
                        <span style={{ color: '#1F1B16', fontWeight: 500 }}>{e.name}</span>
                        <span className="text-xs" style={{ color: '#1F1B16', opacity: 0.5 }}>
                          {e.id}
                          {e.department !== selectedEmp.department && ` · ${e.department}`}
                        </span>
                      </button>
                    ));
                  })()}
                </div>
                {/* Widen-pool toggle — opens to cross-department subs in
                    the same location. Common when paper apps name someone
                    from an adjacent team (e.g. LOG ↔ BIZ in Jeddah). */}
                <label className="flex items-center gap-2 text-xs pt-1" style={{ color: '#1F1B16' }}>
                  <input
                    type="checkbox"
                    checked={widenSubPool}
                    onChange={(e) => setWidenSubPool(e.target.checked)}
                  />
                  Include all departments in {selectedEmp.location || '—'}
                  {!widenSubPool && (
                    <span style={{ opacity: 0.55 }}>
                      · default is same dept only
                    </span>
                  )}
                </label>
              </>
            ) : (
              <div className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>
                Maximum of 3 substitutes reached — remove one to swap.
              </div>
            )}
          </div>
        )}

        {/* Status message */}
        {msg && (
          <div className={`flex items-center gap-2 text-sm rounded px-3 py-2 ${
            msg.kind === 'ok'
              ? 'bg-green-50 text-green-900'
              : 'bg-red-50 text-red-900'
          }`}>
            {msg.kind === 'ok' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
            {msg.text}
          </div>
        )}

        {/* Save */}
        <div className="flex justify-end pt-2">
          <button
            onClick={save}
            disabled={!canSave}
            className="flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold text-white disabled:opacity-50"
            style={{ background: ACCENT }}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {busy ? 'Saving…' : 'Log entry'}
          </button>
        </div>
      </div>
      </div>{/* /TOP form */}

      {/* BELOW — logged entries, grouped by month, all entries, scrollable */}
      <div className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: ACCENT_BD }}>
        <div className="px-4 py-3 border-b flex items-center gap-2" style={{ borderColor: ACCENT_BD }}>
          <h3 className="text-sm font-semibold" style={{ color: '#1F1B16' }}>
            Logged entries ({recent.length})
          </h3>
          {recent.length > 0 && (
            <span className="text-xs" style={{ color: '#1F1B16', opacity: 0.6 }}>· tap a row to re-open</span>
          )}
        </div>
        {recent.length === 0 ? (
          <p className="text-xs px-4 py-4" style={{ color: '#1F1B16', opacity: 0.6 }}>
            No manual entries yet. Logged entries will appear here.
          </p>
        ) : (
          <div className="max-h-[62vh] overflow-y-auto">
            {recentGroups.map(g => (
              <div key={g.key}>
                <div className="px-4 py-1.5 text-[11px] font-semibold uppercase tracking-wide sticky top-0 z-10"
                     style={{ background: ACCENT_BG, color: ACCENT }}>
                  {g.label} · {g.items.length}
                </div>
                {g.items.map(r => {
                  const e = (employees || []).find(x => x.id === r.employee_id);
                  const period = `${fmtDate(new Date(r.start_date))}${r.end_date && r.end_date !== r.start_date ? ` → ${fmtDate(new Date(r.end_date))}` : ''}`;
                  const enteredRaw = r.hr_decided_at || r.requested_at || null;
                  const enteredDt = enteredRaw ? new Date(enteredRaw) : null;
                  const entered = enteredDt && !isNaN(enteredDt) ? fmtDate(enteredDt) : null;
                  return (
                    <div
                      key={r.id}
                      onClick={() => {
                        const mgr = e?.manager_id
                          ? (employees || []).find(x => x.id === e.manager_id)
                          : null;
                        const empMap = (employees || []).reduce((acc, x) => { acc[x.id] = x; return acc; }, {});
                        const subs = (r.substitute_ids || [])
                          .map(psn => (employees || []).find(x => x.id === psn))
                          .filter(Boolean);
                        setSavedModal({ request: r, employee: e, manager: mgr, hrApprover: me, empMap, substitutes: subs });
                      }}
                      className="group flex items-center justify-between gap-3 px-4 py-2.5 border-b border-black/5 cursor-pointer hover:bg-black/[0.02]"
                      style={{ color: '#1F1B16' }}>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-medium truncate">{e?.name || r.employee_id}</div>
                        <div className="text-[11px] mt-0.5" style={{ color: '#1F1B16', opacity: 0.65 }}>
                          <span className="capitalize">{r.leave_type_id}</span> · {period}
                          {entered && <> · logged {entered}</>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded"
                              style={{ background: ACCENT_BG, color: ACCENT }}>
                          {r.days}d
                        </span>
                        <span className="hidden group-hover:inline-flex items-center gap-0.5">
                          <button type="button" title="Open prefilled email"
                            onClick={(ev) => { ev.stopPropagation(); emailLeave(r, e); }}
                            className="inline-flex items-center justify-center rounded p-1 hover:bg-emerald-50"
                            style={{ color: '#0F6E56' }}>
                            <Mail size={13} />
                          </button>
                          <button type="button" title="Download Word document"
                            onClick={(ev) => { ev.stopPropagation(); downloadLeaveWord(r, e); }}
                            disabled={docId === r.id}
                            className="inline-flex items-center justify-center rounded p-1 hover:bg-blue-50"
                            style={{ color: '#1D4ED8', opacity: docId === r.id ? 0.5 : 1 }}>
                            {docId === r.id ? <Loader2 size={13} className="animate-spin" /> : <FileText size={13} />}
                          </button>
                          <button type="button" title="Delete this entry"
                            onClick={(ev) => { ev.stopPropagation(); deleteEntry(r); }}
                            disabled={deletingId === r.id}
                            className="inline-flex items-center justify-center rounded p-1 hover:bg-red-50"
                            style={{ color: '#B91C1C', opacity: deletingId === r.id ? 0.5 : 1 }}>
                            {deletingId === r.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                          </button>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      </div>{/* /wrapper */}

      {/* Post-save modal — same Download PDF + Open Email surface the
          regular approval flow uses. Re-opens too when Bashaier clicks
          any row in 'Recently logged'. */}
      {savedModal && (
        <LeaveApprovedModal
          request={savedModal.request}
          employee={savedModal.employee}
          manager={savedModal.manager}
          hrApprover={savedModal.hrApprover}
          empMap={savedModal.empMap}
          substitutes={savedModal.substitutes}
          pdfGenerator={generateLogbookPdfBlob}
          onClose={() => setSavedModal(null)}
        />
      )}
      </>)}
    </div>
  );
}

// Small balance-figure cell — coloured per metric so the four numbers
// read at a glance: blue = entitled (fixed), amber = carried (rollover),
// red = used (consumed), green = available (healthy). Available cell
// is emphasised slightly larger since it's the actionable number.
function BalanceCell({ label, val, fg = '#0F4C2A', bg = '#FFFFFF', emphasize = false }) {
  const num = typeof val === 'number' ? val : Number(val || 0);
  return (
    <div className={`rounded px-2 py-1.5 ${emphasize ? 'ring-2' : ''}`}
         style={{
           background: bg,
           ...(emphasize ? { '--tw-ring-color': fg, boxShadow: `inset 0 0 0 1.5px ${fg}40` } : {}),
         }}>
      <div className="text-[9px] font-bold tracking-wider"
           style={{ color: fg, opacity: 0.8 }}>
        {label}
      </div>
      <div className={`font-bold ${emphasize ? 'text-base' : 'text-sm'}`}
           style={{ color: fg }}>
        {num.toFixed(num % 1 === 0 ? 0 : 2)}
      </div>
    </div>
  );
}
