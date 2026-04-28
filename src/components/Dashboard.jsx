import React, { useMemo, useState, useEffect, useCallback } from 'react';
import { Check, ArrowRight, Palmtree, Calendar, KeyRound, Mail, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { supabase } from '../supabaseClient.js';
import { todayISO, fmtDateShort, getInitials, avatarColor } from '../lib/leaveLogic.js';
import BashaierTasksCard from './BashaierTasksCard.jsx';

export default function Dashboard({ me, employees, requests, typeMap, empMap, permissions, onGoToRequests, onNewRequest }) {
  // Personalised greeting — fully inline to eliminate any minifier scope issues.
  const _hr = new Date().getHours();
  const _period = _hr < 12 ? 'morning' : _hr < 17 ? 'afternoon' : 'evening';
  const _parts = String(me?.name || '').trim().split(/\s+/).filter(Boolean);
  const _skip = ['MOHAMMED','MOHAMMAD','MUHAMMAD','MOHD','ABDULLAH','ABDUL','ABDULRAHMAN','AHMED','AHMAD'];
  const _pickIdx = (_parts.length >= 2 && _skip.includes(_parts[0].toUpperCase())) ? 1 : 0;
  const _pick = _parts[_pickIdx] || '';
  const _display = _pick ? _pick.charAt(0).toUpperCase() + _pick.slice(1).toLowerCase() : '';
  const greeting = _display ? `Good ${_period}, ${_display}.` : `Good ${_period}.`;
  const today = todayISO();

  const onLeaveToday = useMemo(
    () => requests.filter(r => r.status === 'approved' && r.start_date <= today && r.end_date >= today),
    [requests, today]
  );

  const pending = useMemo(
    () => requests.filter(r => r.status === 'pending').sort((a,b) => new Date(b.requested_at) - new Date(a.requested_at)),
    [requests]
  );

  const upcoming = useMemo(() => {
    return requests
      .filter(r => r.status === 'approved' && r.start_date > today)
      .sort((a,b) => a.start_date.localeCompare(b.start_date))
      .slice(0, 8);
  }, [requests, today]);

  const approvedThisMonth = useMemo(() => {
    const now = new Date();
    return requests.filter(r => {
      if (r.status !== 'approved') return false;
      const d = new Date(r.start_date);
      return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    }).length;
  }, [requests]);

  const byLocation = useMemo(() => {
    const m = { DMM: 0, JED: 0, RYD: 0 };
    employees.forEach(e => { m[e.location] = (m[e.location] || 0) + 1; });
    return m;
  }, [employees]);

  const byDept = useMemo(() => {
    const m = {};
    employees.forEach(e => { m[e.department] = (m[e.department] || 0) + 1; });
    return Object.entries(m).sort((a,b) => b[1] - a[1]);
  }, [employees]);

  const byNationality = useMemo(() => {
    let saudi = 0, expat = 0;
    employees.forEach(e => {
      if (e.nationality === 'saudi') saudi++;
      else if (e.nationality === 'expat') expat++;
    });
    return { saudi, expat };
  }, [employees]);

  const byGender = useMemo(() => {
    const FEM_FIRST = new Set(['BASHAIER','BADRIA','SHAHAD','AMNA','AMINAH','NORA','NORAH','NOURA','LAYLA','SARA','SARAH','MARIA','JOAN','JOY','GRACE','AISHA','AMINA','FATIMA','KHADIJA','MARIAM','MARYAM','ZAINAB','HAYA','REEM','REEMA','RANA','DANA','LINA','NADA','WAFA','AYESHA','PRINCESS','JESSICA','JENNIFER','ANNA','HANNAH','LISA','EMMA','OLIVIA','SOPHIA','PRIYA','NEHA','SAFIA','SAFIYA']);
    let male = 0, female = 0;
    employees.forEach(e => {
      const g = (e.gender || '').toLowerCase();
      if (g === 'female' || g === 'f') female++;
      else if (g === 'male' || g === 'm') male++;
      else {
        const first = (e.name || '').split(/\s+/)[0].toUpperCase();
        if (FEM_FIRST.has(first)) female++;
        else male++;
      }
    });
    return { male, female };
  }, [employees]);

  const bashaierMode = !!(me?.is_hr_reviewer && !me?.is_admin);

  const heroMessage = useMemo(() => {
    const messages = [
      'Today is a good day to lead with kindness.',
      'Your steady hand keeps the whole team in motion.',
      'Quiet excellence shapes the company more than loud effort.',
      'Every signature you finish is one less worry for someone.',
      'You are the reason the inbox feels less heavy on Mondays.',
      'Small acts of care add up to a culture of trust.',
      'You make complicated processes feel simple. That is rare.',
      'A calm HR desk is a gift to every department.',
      'Today, your work touches more lives than you will ever know.',
      'You bring grace to numbers and warmth to policy.',
      'The files may be quiet, but your impact is loud.',
      'Your patience is a quiet superpower.',
      'You are exactly where the team needs you to be.',
    ];
    const dayIndex = Math.floor(Date.now() / 86400000) % messages.length;
    return messages[dayIndex];
  }, []);


  return (
    <div className="space-y-8">
      {/* Hero — Editorial Minimal (Option 1): cream background, serif typography, italic quote.
          Bashaier sees her name + heroMessage as the italic quote; everyone else sees the
          plain greeting. No tiles, no gradients. */}
      {bashaierMode ? (
        <div className="pb-8" style={{ borderBottom: '1px solid #E5E0D5' }}>
          <div className="text-xs mb-3.5" style={{ color: '#9D6B53', letterSpacing: '0.3em' }}>
            — {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()}
          </div>
          <h1 className="leading-[1] mb-4" style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 'clamp(2.2rem, 5vw, 3.5rem)', color: '#1F1B16', fontWeight: 400, letterSpacing: '-0.02em' }}>
            Good {_period}, Bashaier.
          </h1>
          <p className="mb-3" style={{ fontFamily: 'Georgia, serif', fontStyle: 'italic', color: '#6B5A4A', fontSize: '1.15rem', maxWidth: '38rem', lineHeight: 1.4 }}>
            "{heroMessage}"
          </p>
          <p className="text-sm" style={{ color: '#6B5A4A', margin: 0 }}>
            {pending.length > 0
              ? <>You have <span style={{ fontWeight: 600, color: '#1F1B16' }}>{pending.length} pending {pending.length === 1 ? 'request' : 'requests'}</span> waiting on your decision, and <span style={{ fontWeight: 600, color: '#1F1B16' }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
              : <>Your queue is clear. <span style={{ fontWeight: 600, color: '#1F1B16' }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
            }
          </p>
        </div>
      ) : (
      <div className="pb-8" style={{ borderBottom: '1px solid #E5E0D5' }}>
        <div className="text-xs mb-3.5" style={{ color: '#9D6B53', letterSpacing: '0.3em' }}>
          — {new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()}
        </div>
        <h1 className="leading-[1]" style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: 'clamp(2.5rem, 5vw, 3.8rem)', color: '#1F1B16', fontWeight: 400, letterSpacing: '-0.02em' }}>
          {greeting}
        </h1>
        <p className="text-base mt-4 max-w-xl" style={{ color: '#6B5A4A' }}>
          {pending.length > 0
            ? <>You have <span style={{ color: '#C97A4F', fontWeight: 600 }}>{pending.length} pending {pending.length === 1 ? 'request' : 'requests'}</span> waiting on your decision, and <span style={{ fontWeight: 600, color: '#1F1B16' }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
            : <>Your queue is clear. <span style={{ fontWeight: 600, color: '#1F1B16' }}>{onLeaveToday.length}</span> {onLeaveToday.length === 1 ? 'person is' : 'people are'} out of office today.</>
          }
        </p>
      </div>
      )}

      {/* Stat cards — 5-up when HR reviewer (extra Your Tasks tile), 4-up otherwise */}
      <div className={`grid grid-cols-2 ${bashaierMode ? 'lg:grid-cols-5' : 'lg:grid-cols-4'} gap-4`}>
        <StatCard label="Total Staff" value={employees.length}
                  sub={`${byLocation.DMM || 0} DMM · ${byLocation.JED || 0} JED · ${byLocation.RYD || 0} RYD`}/>
        <StatCard label="On Leave Today" value={onLeaveToday.length}
                  sub="Currently out of office" accent="var(--evergreen-500)"/>
        <StatCard label="Pending Approval" value={pending.length}
                  sub="Awaiting your decision" accent="var(--clay)" onClick={onGoToRequests}/>
        <StatCard label="Approved This Month" value={approvedThisMonth}
                  sub={new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}/>
        {bashaierMode && (
          <StatCard label="Your Tasks" value={3}
                    sub="Reports for Mr John"
                    onClick={() => {
                      const el = document.getElementById('bashaier-tasks-anchor');
                      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}/>
        )}
      </div>

      {/* Headcount — Editorial Minimal (Option 1): bordered grid, serif numbers,
           inline demographic summary in the subtitle. */}
      <div className="pt-7" style={{ borderTop: '1px solid #E5E0D5' }}>
        <div className="flex items-baseline justify-between flex-wrap gap-3 mb-5">
          <div>
            <div className="text-[10px]" style={{ color: '#9D6B53', letterSpacing: '0.3em' }}>PEOPLE AT ESAU</div>
            <h2 style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: '26px', color: '#1F1B16', marginTop: '4px', fontWeight: 400 }}>
              Headcount by department
            </h2>
          </div>
          <div className="text-xs" style={{ color: '#9C9385' }}>
            {employees.length} active · {byNationality.saudi} Saudi · {byNationality.expat} Expat · {byGender.male} Male · <span style={{ color: '#C97A4F', fontWeight: 600 }}>{byGender.female} Female</span>
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6"
             style={{ borderTop: '1px solid #E5E0D5', borderLeft: '1px solid #E5E0D5' }}>
          {byDept.map(([dept, count]) => (
            <div key={dept}
                 style={{ borderRight: '1px solid #E5E0D5', borderBottom: '1px solid #E5E0D5', padding: '18px' }}>
              <div className="text-[10px]" style={{ color: '#9D6B53', letterSpacing: '0.2em', fontWeight: 500 }}>{dept}</div>
              <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: '36px', color: '#1F1B16', lineHeight: 1, margin: '8px 0 4px', fontWeight: 400 }}>
                {count}
              </div>
              <div className="text-[11px]" style={{ color: '#9C9385' }}>
                {Math.round((count / employees.length) * 100)}%
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Three column summary */}
      <div className="grid lg:grid-cols-3 gap-5">
        <Card title="Out of office today" subtitle={`${onLeaveToday.length} ${onLeaveToday.length === 1 ? 'person' : 'people'}`}>
          {onLeaveToday.length === 0 ? (
            <Empty icon={Palmtree} message="Full house — nobody on leave today."/>
          ) : (
            <ul className="space-y-3">
              {onLeaveToday.map(r => {
                const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                if (!emp) return null;
                return (
                  <li key={r.id} className="flex items-center gap-3">
                    <Avatar id={emp.id} name={emp.name}/>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                      <div className="text-xs opacity-60">{emp.department} · {emp.location}</div>
                    </div>
                    <div className="text-right">
                      <Pill color={tp?.color}>{tp?.name || r.leave_type_id}</Pill>
                      <div className="text-xs opacity-60 mt-1">until {fmtDateShort(r.end_date)}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Pending requests" subtitle={pending.length > 0 ? 'Needs action' : 'Queue is empty'} accent="var(--clay)">
          {pending.length === 0 ? (
            <Empty icon={Check} message="Nothing to approve — nice."/>
          ) : (
            <ul className="space-y-3">
              {pending.slice(0, 5).map(r => {
                const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                if (!emp) return null;
                return (
                  <li key={r.id} className="flex items-center gap-3">
                    <Avatar id={emp.id} name={emp.name}/>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                      <div className="text-xs opacity-60">{tp?.name} · {r.days} {Number(r.days) === 1 ? 'day' : 'days'}</div>
                    </div>
                    <div className="text-xs opacity-60">{fmtDateShort(r.start_date)}</div>
                  </li>
                );
              })}
              {pending.length > 5 && (
                <li>
                  <button onClick={onGoToRequests} className="text-xs flex items-center gap-1 opacity-70 hover:opacity-100">
                    See {pending.length - 5} more <ArrowRight className="w-3 h-3"/>
                  </button>
                </li>
              )}
            </ul>
          )}
        </Card>

        <Card title="Upcoming leaves" subtitle="Next 8 approved">
          {upcoming.length === 0 ? (
            <Empty icon={Calendar} message="Nothing on the calendar yet."/>
          ) : (
            <ul className="space-y-3">
              {upcoming.map(r => {
                const emp = empMap[r.employee_id]; const tp = typeMap[r.leave_type_id];
                if (!emp) return null;
                return (
                  <li key={r.id} className="flex items-center gap-3">
                    <div className="w-10 text-center flex-shrink-0">
                      <div className="serif text-lg leading-none" style={{ fontWeight: 500 }}>
                        {new Date(r.start_date).getDate()}
                      </div>
                      <div className="text-[10px] uppercase tracking-wider opacity-50 mt-0.5">
                        {new Date(r.start_date).toLocaleDateString('en-GB', { month: 'short' })}
                      </div>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate" style={{ fontWeight: 500 }}>{emp.name}</div>
                      <div className="text-xs opacity-60">{tp?.name} · {r.days}d</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* Bashaier's tasks — only for HR reviewer who isn't admin */}
      {me?.is_hr_reviewer && !me?.is_admin && (
        <div id="bashaier-tasks-anchor" style={{ scrollMarginTop: '80px' }}>
          <BashaierTasksCard employees={employees} requests={requests} permissions={permissions} />
        </div>
      )}

      {/* PIN Requests — pending requests from staff who clicked Request access */}
      <PinRequestsCard me={me} employees={employees} />

      {/* (Headcount block has moved up — see new colored block right after Stat cards.) */}
    </div>
  );
}

/* ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ small UI primitives shared across pages ÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂÃÂ¢ÃÂÃÂ */
export function Card({ title, subtitle, children, accent }) {
  return (
    <div className="rounded-xl border p-5" style={{ borderColor: 'var(--border-soft)', background: '#FFFDF7' }}>
      {(title || subtitle) && (
        <div className="flex items-baseline justify-between mb-4 pb-3 border-b" style={{ borderColor: 'var(--border-soft)' }}>
          <div className="flex items-center gap-2">
            {accent && <div className="w-1.5 h-1.5 rounded-full" style={{ background: accent }}/>}
            <h3 className="serif text-lg" style={{ fontWeight: 500 }}>{title}</h3>
          </div>
          {subtitle && <div className="text-xs opacity-60">{subtitle}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

export function StatCard({ label, value, sub, accent = 'var(--ink)', onClick }) {
  // Editorial Minimal (Option 1): plain typography, no tiles, no gradients.
  // The "Your Tasks" tile gets a single warm-orange left rule + matching label
  // colour so it stands out for HR reviewers without breaking the calm.
  const isYourTasks = label === 'Your Tasks';
  const Tag = onClick ? 'button' : 'div';
  const labelColor = isYourTasks ? '#C97A4F' : '#9D6B53';
  return (
    <Tag onClick={onClick}
      className={`text-left block w-full transition-opacity hover:opacity-80 ${onClick ? 'cursor-pointer' : ''}`}
      style={{
        paddingLeft:  isYourTasks ? '16px' : '0',
        borderLeft:   isYourTasks ? '2px solid #C97A4F' : 'none',
        background:   'transparent',
        border:       isYourTasks ? '' : 'none',
        minHeight:    '88px',
      }}>
      <div className="text-[10px]" style={{ color: labelColor, letterSpacing: '0.2em', fontWeight: 500 }}>
        {label.toUpperCase()}
      </div>
      <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: '42px', color: '#1F1B16', lineHeight: 1, margin: '8px 0 4px', fontWeight: 400 }}>
        {value}
      </div>
      {sub && <div className="text-[11px]" style={{ color: '#9C9385' }}>{sub}</div>}
    </Tag>
  );
}

export function Avatar({ id, name, size = 'md' }) {
  const dim = { sm: 'w-7 h-7 text-[10px]', md: 'w-9 h-9 text-xs', lg: 'w-11 h-11 text-sm', xl: 'w-16 h-16 text-lg' }[size];
  return (
    <div className={`${dim} rounded-full flex items-center justify-center flex-shrink-0`}
         style={{ background: avatarColor(id), color: '#F4EEDF', fontWeight: 600, letterSpacing: '0.05em' }}>
      {getInitials(name)}
    </div>
  );
}

export function Pill({ color = 'var(--evergreen-500)', children }) {
  return (
    <span className="text-[11px] px-2 py-0.5 rounded-full inline-block"
          style={{ background: `${color}18`, color, fontWeight: 500 }}>
      {children}
    </span>
  );
}

export function Empty({ icon: Icon, message }) {
  return (
    <div className="text-center py-8 opacity-50">
      <Icon className="w-6 h-6 mx-auto mb-2"/>
      <div className="text-sm">{message}</div>
    </div>
  );
}


/* ─────────────────────────────────────────────────────────────────
   PinRequestsCard
   ─────────────────────────────────────────────────────────────────
   Shows pending registration_requests rows joined to the employees
   directory. Admin (Nadeem) AND reviewers (Bashaier) can issue PINs.

   Click "Generate & Email" → generates random 6-digit PIN →
   calls admin_reset_pin RPC → marks request fulfilled →
   opens user's mail client with PIN pre-filled.

   If the staff already has a PIN (auth_user_id is not null), the
   button is disabled and shows "Already has PIN — use Reset PIN".
   ───────────────────────────────────────────────────────────────── */
function PinRequestsCard({ me, employees }) {
  const [requests, setRequests] = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [busyId,   setBusyId]   = useState(null);
  const [error,    setError]    = useState('');
  const [info,     setInfo]     = useState('');

  const empById = useMemo(
    () => Object.fromEntries(employees.map(e => [e.id, e])),
    [employees]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('registration_requests')
        .select('*')
        .eq('status', 'pending')
        .order('requested_at', { ascending: true });
      if (error) throw error;
      setRequests(data || []);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Realtime: refresh when a new request comes in
  useEffect(() => {
    const ch = supabase.channel('pin-requests-feed')
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'registration_requests' },
        load)
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [load]);

  const generateAndEmail = async (req) => {
    setError(''); setInfo(''); setBusyId(req.id);
    try {
      const emp = empById[req.psn];
      if (!emp) throw new Error('Employee record not found for ' + req.psn);

      // Block if already has a PIN — admin/reviewer should use Reset PIN instead
      if (emp.auth_user_id) {
        setError(`${emp.name} already has a PIN. Use the Reset PIN button on their employee card instead.`);
        return;
      }

      // Random 6-digit PIN
      const pin = String(Math.floor(100000 + Math.random() * 900000));

      // Issue via admin_reset_pin RPC (creates auth user using employees.email)
      const { data, error: rpcErr } = await supabase.rpc('admin_reset_pin', {
        target_psn: req.psn, new_pin: pin
      });
      if (rpcErr) throw rpcErr;
      if (!data?.ok) throw new Error(data?.error || 'PIN issue failed');

      // Mark request fulfilled
      await supabase.from('registration_requests')
        .update({ status: 'fulfilled', fulfilled_at: new Date().toISOString(), fulfilled_by: me?.auth_user_id || null })
        .eq('id', req.id);

      // Open mail client with pre-filled message
      const subject = encodeURIComponent('Your Evergreen HR PIN');
      const body = encodeURIComponent(
        `Dear ${emp.name.split(' ').slice(0, 2).join(' ')},\n\n` +
        `Your Evergreen HR PIN has been generated.\n\n` +
        `PSN ID: ${emp.id}\n` +
        `PIN: ${pin}\n\n` +
        `Please sign in at https://esauhr.netlify.app and keep this PIN confidential.\n\n` +
        `Best regards,\n${me?.name?.split(' ').slice(0, 2).join(' ') || 'HR'}\n` +
        `Evergreen Shipping Agency Saudi Co. (LLC)`
      );
      const to = emp.email || '';
      window.location.href = `mailto:${encodeURIComponent(to)}?subject=${subject}&body=${body}`;

      setInfo(`PIN ${pin} issued to ${emp.name}. Mail draft opened.`);
      await load();
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setBusyId(null);
    }
  };

  const reject = async (req) => {
    setBusyId(req.id);
    try {
      await supabase.from('registration_requests')
        .update({ status: 'rejected', fulfilled_at: new Date().toISOString(), fulfilled_by: me?.auth_user_id || null })
        .eq('id', req.id);
      await load();
    } finally { setBusyId(null); }
  };

  return (
    <Card title="PIN requests" subtitle={loading ? 'Loading…' : (requests.length === 0 ? 'No pending requests.' : `${requests.length} pending`)}>
      {error && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
          style={{ background: 'rgba(184,74,62,0.10)', color: 'var(--clay)' }}>
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" /> {error}
        </div>
      )}
      {info && (
        <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
          style={{ background: 'rgba(45,95,63,0.10)', color: 'var(--evergreen-500)' }}>
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" /> {info}
        </div>
      )}
      {!loading && requests.length === 0 ? (
        <div className="py-6 text-center opacity-50 text-sm">
          <KeyRound className="w-5 h-5 mx-auto mb-2" />
          Queue is clear.
        </div>
      ) : (
        <ul className="divide-y" style={{ borderColor: 'var(--border-soft)' }}>
          {requests.map(req => {
            const emp = empById[req.psn];
            const hasPin = emp?.auth_user_id;
            return (
              <li key={req.id} className="py-3 flex items-center gap-3">
                <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-white text-xs font-bold"
                  style={{ background: emp ? avatarColor(req.psn) : '#999' }}>
                  {emp ? getInitials(emp.name) : '?'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate" style={{ fontWeight: 500 }}>
                    {emp?.name || `Unknown PSN ${req.psn}`}
                  </div>
                  <div className="text-xs opacity-60">
                    {req.psn}{emp?.department ? ' · ' + emp.department : ''}
                    {hasPin ? ' · already has PIN' : ''}
                  </div>
                </div>
                <button onClick={() => reject(req)} disabled={busyId === req.id}
                  className="text-[10px] tracking-wider px-2.5 py-1 rounded-md opacity-60 hover:opacity-100">
                  Reject
                </button>
                <button onClick={() => generateAndEmail(req)} disabled={busyId === req.id || hasPin}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full"
                  style={hasPin
                    ? { background: '#ddd', color: '#888' }
                    : { background: 'linear-gradient(135deg, #FF8A4D 0%, #FF4E6A 100%)', color: '#fff' }}>
                  {busyId === req.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Mail className="w-3 h-3" />}
                  {hasPin ? 'Reset PIN instead' : (busyId === req.id ? 'Issuing…' : 'Generate & Email')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
