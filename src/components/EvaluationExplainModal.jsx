import React from 'react';
import { X, Clock, Calendar, FileText, ArrowRight, Check, AlertCircle } from 'lucide-react';

// =============================================================================
// EvaluationExplainModal.jsx
//
// Renders the full classification chain for a single attendance violation
// entry. Surfaces:
//   1. Raw punches from the file
//   2. Schedule applied (assigned shift OR office-hours fallback)
//   3. Late / early calculation with the exact minute math
//   4. Permission lookup result (if any)
//   5. Final classification + minutes off
//
// Lets Bashaier (or anyone) settle disputes in one click — "why is this
// marked late?" can be answered without trawling code or guessing.
//
// Pure render — takes the entry object as already passed to FlaggedSection
// and renders the data already on it. No DB queries, no recomputation.
// =============================================================================

const fmtTime = (t) => {
  if (!t) return '—';
  const s = String(t);
  // Accept HH:MM:SS or HH:MM, return HH:MM
  return s.slice(0, 5);
};

const fmtDateLong = (iso) => {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
};

// Minutes-since-midnight from "HH:MM" or "HH:MM:SS".
const toMin = (t) => {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

const fmtMinDelta = (n) => {
  if (n == null) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n} min`;
};

// Section header — small caps + thin underline. Used for each step
// of the chain: punches → schedule → comparison → permission → result.
function StepHeader({ icon: Icon, label }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5"
      style={{
        color: '#7A7A7A',
        fontSize: '10px',
        letterSpacing: '0.08em',
        fontWeight: 600,
        textTransform: 'uppercase',
      }}>
      {Icon && <Icon className="w-3 h-3" style={{ color: '#7A7A7A' }} aria-hidden />}
      <span>{label}</span>
    </div>
  );
}

// Key/value pair with a thin gridline. Tabular look, easy to scan.
function Row({ label, value, tone }) {
  return (
    <div className="flex items-baseline gap-3 py-1"
      style={{ borderBottom: '1px solid #F4F4EE' }}>
      <span className="text-[11px]" style={{ color: '#7A7A7A', minWidth: '120px' }}>
        {label}
      </span>
      <span className="text-[11px]" style={{
        color: tone === 'red' ? '#A32D2D'
             : tone === 'amber' ? '#854F0B'
             : tone === 'green' ? '#0F6E56'
             : '#0A0A0A',
        fontWeight: tone ? 600 : 500,
        fontFamily: tone === 'mono' ? 'monospace' : 'inherit',
      }}>
        {value}
      </span>
    </div>
  );
}

export default function EvaluationExplainModal({ entry, kind, onClose }) {
  if (!entry) return null;

  const employee = entry.employee || {};
  const punches = Array.isArray(entry.row?.punches) ? entry.row.punches
                : entry.row?.punchList || []; // fallback for older shapes
  const firstPunch = entry.punchInStr || entry.row?.firstPunch || punches[0] || null;
  const lastPunch  = entry.punchOutStr || entry.row?.lastPunch || (punches.length > 1 ? punches[punches.length - 1] : null);

  const isShift = !!entry.isCustomShift;
  const sStart  = entry.scheduledStart || (isShift ? null : '08:00:00');
  const sEnd    = entry.scheduledEnd   || (isShift ? null : '17:00:00');
  const lateCutoff  = entry.lateCutoff  || (isShift && sStart ? null : '08:15');
  const earlyCutoff = entry.earlyCutoff || (isShift && sEnd ? null : '16:45');

  // Build the comparison row depending on the violation kind. We
  // recompute minutes off from punch + schedule so we can show the
  // arithmetic, even if the entry already carries minutesLate /
  // minutesEarly — no surprises about how the number was derived.
  let comparison = null;
  if (kind === 'late' && firstPunch && sStart) {
    const punchMin = toMin(firstPunch);
    const startMin = toMin(sStart);
    const cutoffMin = lateCutoff ? toMin(lateCutoff) : startMin; // July 2026: no grace
    const beyondCutoff = punchMin - cutoffMin;
    comparison = {
      label: 'Late check',
      lines: [
        { l: 'Punch in',          v: fmtTime(firstPunch) },
        { l: 'Shift / schedule',  v: fmtTime(sStart) + ' \u2192 ' + fmtTime(sEnd) + (isShift ? '' : ' (office hours)') },
        { l: '15-min grace',      v: 'Up to ' + fmtTime(`${Math.floor(cutoffMin/60)}:${String(cutoffMin%60).padStart(2,'0')}`) },
        { l: 'Beyond grace',      v: fmtMinDelta(beyondCutoff), tone: beyondCutoff > 0 ? 'red' : 'green' },
      ],
    };
  } else if (kind === 'early' && lastPunch && sEnd) {
    const punchMin = toMin(lastPunch);
    const endMin   = toMin(sEnd);
    const cutoffMin = earlyCutoff ? toMin(earlyCutoff) : (endMin - 15);
    const beforeCutoff = cutoffMin - punchMin;
    comparison = {
      label: 'Early-leave check',
      lines: [
        { l: 'Punch out',         v: fmtTime(lastPunch) },
        { l: 'Shift / schedule',  v: fmtTime(sStart) + ' \u2192 ' + fmtTime(sEnd) + (isShift ? '' : ' (office hours)') },
        { l: '15-min grace',      v: 'From ' + fmtTime(`${Math.floor(cutoffMin/60)}:${String(cutoffMin%60).padStart(2,'0')}`) },
        { l: 'Before grace',      v: fmtMinDelta(beforeCutoff), tone: beforeCutoff > 0 ? 'red' : 'green' },
      ],
    };
  } else if (kind === 'missedIn' || kind === 'missedOut' || kind === 'shiftAbsent') {
    comparison = {
      label: 'Punch availability',
      lines: [
        { l: 'Punch in',  v: firstPunch ? fmtTime(firstPunch) : 'Missing', tone: firstPunch ? 'green' : 'red' },
        { l: 'Punch out', v: lastPunch  ? fmtTime(lastPunch)  : 'Missing', tone: lastPunch  ? 'green' : 'red' },
        { l: 'Shift / schedule', v: sStart && sEnd ? (fmtTime(sStart) + ' \u2192 ' + fmtTime(sEnd) + (isShift ? '' : ' (office hours)')) : 'Unknown' },
      ],
    };
  }

  // Permission lookup — recorded by the violation classifier earlier.
  const permRow = entry.permission ? {
    found: true,
    timeFrom: fmtTime(entry.permission.time_from),
    timeTo:   fmtTime(entry.permission.time_to),
    type:     entry.permission.type === 'late_arrival' ? 'Late arrival' : 'Early leave',
    status:   entry.permStatus,  // 'LATE_PERMITTED' | 'LATE_BEYOND' | 'EARLY_PERMITTED' | etc
  } : null;

  // Outcome label — what the system finally classified this row as.
  const outcomeLabel = (() => {
    if (kind === 'late') {
      if (entry.permStatus === 'LATE_PERMITTED') return 'Late but covered by permission — no action';
      if (entry.permStatus === 'LATE_BEYOND')    return 'Late beyond permission — actionable';
      return 'Late, no permission — actionable';
    }
    if (kind === 'early') {
      if (entry.permStatus === 'EARLY_PERMITTED') return 'Early but covered by permission — no action';
      if (entry.permStatus === 'EARLY_BEYOND')    return 'Early beyond permission — actionable';
      return 'Early, no permission — actionable';
    }
    if (kind === 'missedIn')   return 'Missed punch-in — actionable';
    if (kind === 'missedOut')  return 'Missed punch-out — actionable';
    if (kind === 'shiftAbsent') return 'Unexcused shift absence — actionable';
    return 'Flagged — actionable';
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(31,27,22,0.4)' }}
      onClick={onClose}>
      <div className="rounded-xl shadow-lg w-full max-w-lg overflow-hidden"
        style={{
          background: '#FFFFFF',
          border: '1px solid #EEEAE0',
          fontFamily: 'inherit',
        }}
        onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-4 py-3 flex items-start justify-between"
          style={{ borderBottom: '1px solid #EEEAE0' }}>
          <div>
            <div className="text-[10px]" style={{ color: '#7A7A7A', letterSpacing: '0.08em', fontWeight: 600 }}>
              EVALUATION DETAIL
            </div>
            <div className="text-[14px] mt-0.5" style={{ color: '#0A0A0A', fontWeight: 600 }}>
              {employee.name || employee.id}
              <span className="ml-2 text-[11px]" style={{ color: '#7A7A7A', fontFamily: 'monospace', fontWeight: 400 }}>
                {employee.id || ''}
              </span>
            </div>
            <div className="text-[11px] mt-0.5" style={{ color: '#7A7A7A' }}>
              {fmtDateLong(entry.dateLabel)}
            </div>
          </div>
          <button onClick={onClose}
            className="p-1 rounded hover:bg-[#FAFAF9]"
            style={{ color: '#7A7A7A' }}>
            <X className="w-4 h-4"/>
          </button>
        </div>

        {/* Body */}
        <div className="p-4 space-y-4 max-h-[60vh] overflow-y-auto">

          {/* Step 1 — Punches */}
          <div>
            <StepHeader icon={Clock} label="1. Raw punches from the file"/>
            <div className="text-[11px] px-2 py-1.5 rounded"
              style={{
                background: '#FAFAF9',
                fontFamily: 'monospace',
                color: '#0A0A0A',
                border: '1px solid #EEEAE0',
              }}>
              {punches.length > 0
                ? punches.map(fmtTime).join(' \u00b7 ')
                : (firstPunch || lastPunch)
                  ? [firstPunch, lastPunch].filter(Boolean).map(fmtTime).join(' \u00b7 ')
                  : '(no punches)'}
            </div>
          </div>

          {/* Step 2 — Schedule applied */}
          <div>
            <StepHeader icon={Calendar} label="2. Schedule applied"/>
            <div className="space-y-0">
              <Row label="Source"
                value={isShift ? `Manager-assigned shift${entry.assignedBy ? ' (' + entry.assignedBy + ')' : ''}` : 'Office-hours fallback'}/>
              <Row label="Window" value={sStart && sEnd ? fmtTime(sStart) + ' \u2192 ' + fmtTime(sEnd) : 'Unknown'}/>
              {entry.scheduleLabel && (
                <Row label="Label" value={entry.scheduleLabel}/>
              )}
            </div>
          </div>

          {/* Step 3 — Comparison */}
          {comparison && (
            <div>
              <StepHeader icon={ArrowRight} label={'3. ' + comparison.label}/>
              <div className="space-y-0">
                {comparison.lines.map((ln, i) => (
                  <Row key={i} label={ln.l} value={ln.v} tone={ln.tone}/>
                ))}
              </div>
            </div>
          )}

          {/* Step 4 — Permission lookup */}
          <div>
            <StepHeader icon={FileText} label="4. Permission lookup"/>
            {permRow ? (
              <div className="space-y-0">
                <Row label="On file" value="Yes" tone="green"/>
                <Row label="Type"    value={permRow.type}/>
                <Row label="Window"  value={permRow.timeFrom + ' \u2192 ' + permRow.timeTo}/>
                <Row label="Coverage"
                  value={permRow.status === 'LATE_PERMITTED' || permRow.status === 'EARLY_PERMITTED'
                    ? 'Fully covers the punch'
                    : permRow.status === 'LATE_BEYOND' || permRow.status === 'EARLY_BEYOND'
                    ? 'Partial — punch falls outside the permitted window'
                    : 'Not applicable'}
                  tone={permRow.status === 'LATE_PERMITTED' || permRow.status === 'EARLY_PERMITTED' ? 'green' : 'amber'}/>
              </div>
            ) : (
              <Row label="On file" value="No permission found for this date" tone="red"/>
            )}
          </div>

          {/* Step 5 — Outcome */}
          <div>
            <StepHeader icon={Check} label="5. Final classification"/>
            <div className="px-2 py-2 rounded"
              style={{
                background: '#F1FBF7',
                color: '#0A0A0A',
                fontSize: '11px',
                fontWeight: 500,
                border: '1px solid #D7F0E5',
              }}>
              {outcomeLabel}
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="px-4 py-2.5 text-[10px]"
          style={{
            borderTop: '1px solid #EEEAE0',
            color: '#7A7A7A',
            background: '#FAFAF9',
          }}>
          <AlertCircle className="w-3 h-3 inline-block mr-1" style={{ verticalAlign: '-2px' }}/>
          This view shows the data the classifier saw at the time of evaluation. Re-uploads or schedule changes after the fact may shift this row's classification on the next re-evaluation.
        </div>
      </div>
    </div>
  );
}
