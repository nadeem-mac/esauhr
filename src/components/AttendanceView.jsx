import React, { useState, useMemo } from 'react';
import { Clock, Mail, AlertTriangle, Search, CheckCircle2, Send } from 'lucide-react';

// LATE-ARRIVAL EMAIL COMPOSER
// ────────────────────────────
// ESAU rules (from policy):
//   • Official clock-in: 08:00
//   • Grace period: until 08:15 (no notice)
//   • After 08:15 → late notice email composed
//
// This component opens a draft in the user's email client via mailto:
// (no API keys, no infrastructure — works on every device).
// Uses staff.email if set, otherwise falls back to the admin's address.

const CUTOFF = '08:15';
const OFFICIAL = '08:00';

// CC recipients required by company policy on every late notice.
const CC_LIST = [
  'johnho@evergreen-shipping.com.sa',
  'jamesliu@evergreen-shipping.com.sa',
  'esau-dmn-supallmembers@evergreen-shipping.com.sa',
].join(',');

const FALLBACK_TO = 'nadeem@evergreen-shipping.com.sa';

export default function AttendanceView({ me, employees }) {
  const [psn,  setPsn]  = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [time, setTime] = useState('');
  const [search, setSearch] = useState('');

  const employee = useMemo(
    () => employees.find(e => e.id?.toUpperCase() === psn.trim().toUpperCase()),
    [employees, psn]
  );

  // List for the picker — narrow by typing PSN/name/department
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return employees.filter(e =>
      e.id?.toLowerCase().includes(q) ||
      e.name?.toLowerCase().includes(q) ||
      e.department?.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [employees, search]);

  const isLate       = time && time > CUTOFF;
  const minutesLate  = isLate ? minutesBetween(OFFICIAL, time) : 0;
  const minutesPast  = isLate ? minutesBetween(CUTOFF, time)   : 0;

  const mailtoHref = (employee && time)
    ? buildMailto({ employee, date, time, minutesLate, minutesPast })
    : null;

  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] tracking-[0.3em] opacity-50 mb-2 flex items-center gap-2">
          <span className="inline-block w-7 h-px bg-current" />ATTENDANCE
        </div>
        <h1 className="serif text-4xl font-bold leading-none" style={{ letterSpacing:'-0.025em' }}>
          Late arrival notice.
        </h1>
        <p className="text-sm opacity-70 mt-2 max-w-2xl">
          Compose a late-arrival email for any staff member. The official clock-in time is
          <strong> 08:00</strong> with a grace period until <strong>08:15</strong>.
          The email will open in your default mail client, pre-filled with the proper recipients
          and subject — review and send.
        </p>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        {/* LEFT: composer form */}
        <div className="rounded-2xl border bg-white p-5" style={{ borderColor:'var(--border-soft)' }}>
          <div className="text-[11px] tracking-[0.25em] opacity-70 font-bold mb-4">STAFF MEMBER</div>

          <div className="mb-4">
            <label className="block text-[11px] tracking-[0.2em] opacity-70 font-bold mb-1.5">SEARCH</label>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 opacity-50" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Type PSN, name, or department"
                className="w-full pl-10 pr-3 py-2.5 rounded-xl border text-sm bg-transparent"
                style={{ borderColor:'var(--border)' }} />
            </div>
            {matches.length > 0 && (
              <ul className="mt-2 border rounded-xl divide-y overflow-hidden" style={{ borderColor:'var(--border-soft)' }}>
                {matches.map(emp => (
                  <li key={emp.id}>
                    <button onClick={() => { setPsn(emp.id); setSearch(''); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-black/[0.03] flex items-center justify-between gap-2">
                      <span><span className="font-mono opacity-60 text-xs mr-2">{emp.id}</span>{emp.name}</span>
                      <span className="text-[10px] opacity-50">{emp.department} · {emp.location}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mb-4">
            <label className="block text-[11px] tracking-[0.2em] opacity-70 font-bold mb-1.5">PSN</label>
            <input value={psn} onChange={e => setPsn(e.target.value.toUpperCase())}
              placeholder="e.g. H94152"
              className="w-full px-3 py-2.5 rounded-xl border text-sm bg-transparent font-mono"
              style={{ borderColor:'var(--border)' }} />
            {psn && !employee && (
              <div className="text-xs mt-1.5" style={{ color:'var(--clay)' }}>
                No staff with PSN "{psn}" found.
              </div>
            )}
            {employee && (
              <div className="text-xs mt-1.5 opacity-70">
                {employee.name} · {employee.department} · {employee.location}
                {!employee.email && <span className="ml-2" style={{ color:'var(--clay)' }}>(no email on file — will route to admin)</span>}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 mb-5">
            <div>
              <label className="block text-[11px] tracking-[0.2em] opacity-70 font-bold mb-1.5">DATE</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border text-sm bg-transparent"
                style={{ borderColor:'var(--border)' }} />
            </div>
            <div>
              <label className="block text-[11px] tracking-[0.2em] opacity-70 font-bold mb-1.5">CLOCK-IN TIME</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl border text-sm bg-transparent"
                style={{ borderColor:'var(--border)' }} />
            </div>
          </div>

          {time && !isLate && (
            <div className="rounded-xl px-4 py-3 text-sm flex items-center gap-2 mb-4"
              style={{ background:'rgba(45,95,63,0.08)', color:'var(--evergreen-500)' }}>
              <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
              <span>Within grace period (08:00–08:15). No notice required.</span>
            </div>
          )}

          {time && isLate && employee && (
            <div className="rounded-xl px-4 py-3 mb-4 text-sm"
              style={{ background:'rgba(255,138,77,0.10)', border:'1px solid rgba(255,138,77,0.40)' }}>
              <div className="flex items-center gap-2 font-semibold mb-1" style={{ color:'#F97316' }}>
                <AlertTriangle className="w-4 h-4" /> Late by {minutesLate} min ({minutesPast} min past grace)
              </div>
              <div className="text-xs opacity-80">
                A late-arrival email will be composed and addressed to {employee.email || FALLBACK_TO},
                with HR leadership on CC.
              </div>
            </div>
          )}

          <a href={mailtoHref || '#'} target="_blank"
            onClick={e => { if (!mailtoHref) e.preventDefault(); }}
            className={`inline-flex items-center justify-center gap-2 w-full px-5 py-3 rounded-full text-sm font-semibold ${mailtoHref ? '' : 'opacity-40 cursor-not-allowed'}`}
            style={{ background: mailtoHref ? 'linear-gradient(135deg, #FF8A4D 0%, #FF4E6A 100%)' : 'var(--paper-2)', color: mailtoHref ? '#fff' : 'var(--ink-soft)' }}>
            <Mail className="w-4 h-4" /> Compose late-arrival email
          </a>
        </div>

        {/* RIGHT: preview */}
        <div className="rounded-2xl border p-5" style={{ borderColor:'var(--border-soft)', background:'var(--paper-2)' }}>
          <div className="text-[11px] tracking-[0.25em] opacity-70 font-bold mb-4">EMAIL PREVIEW</div>

          {!employee || !time ? (
            <div className="opacity-60 text-sm py-12 text-center">
              <Mail className="w-6 h-6 mx-auto mb-3 opacity-50" />
              Pick a staff member and clock-in time to preview the email.
            </div>
          ) : !isLate ? (
            <div className="opacity-60 text-sm py-12 text-center">
              No email needed — staff arrived within grace period.
            </div>
          ) : (
            <div className="text-sm space-y-3">
              <PreviewRow label="To"      value={employee.email || FALLBACK_TO} />
              <PreviewRow label="Cc"      value={CC_LIST.split(',').join('\n')} multiline />
              <PreviewRow label="Subject" value={`Late Arrival Notice — ${employee.id} — ${employee.name} — ${date}`} bold />
              <div className="pt-3 border-t whitespace-pre-wrap leading-relaxed text-[13px]"
                style={{ borderColor:'var(--border-soft)' }}>
                {buildBody({ employee, date, time, minutesLate, minutesPast })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* HELPER NOTE */}
      <div className="rounded-2xl p-4 text-xs leading-relaxed"
        style={{ background:'var(--paper-2)', border:'1px solid var(--border-soft)' }}>
        <div className="font-semibold mb-1 flex items-center gap-1.5">
          <Send className="w-3.5 h-3.5" /> How this works
        </div>
        <p className="opacity-80">
          Clicking <em>Compose late-arrival email</em> opens your default email client
          (Outlook, Apple Mail, Gmail web, etc.) with the message pre-filled. You can edit
          before sending — the email is sent from <strong>your</strong> address, not from a
          service account, which keeps everything under your name and your audit trail.
          Future versions can ingest the ZKTeco daily report automatically and surface
          all late staff at once.
        </p>
      </div>
    </div>
  );
}

function PreviewRow({ label, value, bold, multiline }) {
  return (
    <div className="flex gap-3">
      <div className="text-[10px] tracking-[0.25em] opacity-60 font-semibold w-12 flex-shrink-0 pt-0.5">{label.toUpperCase()}</div>
      <div className={`flex-1 ${bold ? 'font-semibold' : ''} ${multiline ? 'whitespace-pre-line text-xs' : 'text-sm'}`}>{value}</div>
    </div>
  );
}

/* ─── helpers ───────────────────────────── */

function minutesBetween(a, b) {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return (bh * 60 + bm) - (ah * 60 + am);
}

function buildMailto({ employee, date, time, minutesLate, minutesPast }) {
  const TO = employee.email || FALLBACK_TO;
  const subject = `Late Arrival Notice — ${employee.id} — ${employee.name} — ${date}`;
  const body = buildBody({ employee, date, time, minutesLate, minutesPast });
  return `mailto:${TO}?cc=${CC_LIST}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function buildBody({ employee, date, time, minutesLate, minutesPast }) {
  const niceName = displayName(employee.name);
  const dateStr  = new Date(date).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  return `Dear ${niceName},

This is a formal notice that your clock-in time on ${dateStr} was recorded at ${time}.

The official clock-in time at ESAU is 08:00, with a grace period until 08:15. Your arrival was ${minutesLate} minutes after the official start time (${minutesPast} minutes past the grace period).

ESAU's attendance policy:
  • 08:00     — Official clock-in
  • 08:15     — Grace period ends
  • After 08:15 — Late arrival is recorded and a notice is issued

Repeated late arrivals will be reflected in your monthly performance evaluation. If there were exceptional circumstances, please reply to this email and copy your line manager.

Regards,
HR — Evergreen Shipping
ESAU · Dammam`;
}

function displayName(name) {
  if (!name) return 'colleague';
  const PREFIX = ['MOHAMMED','MOHAMMAD','MUHAMMAD','MOHD','ABDULLAH','ABDUL','ABDULRAHMAN','AHMED','AHMAD'];
  const titleCase = (w) => w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : '';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && PREFIX.includes(parts[0].toUpperCase())) return titleCase(parts[1]);
  return titleCase(parts[0] || name);
}
