import React from 'react';
import { Card } from './Dashboard.jsx';
import ReviewerPermissionsCard from './ReviewerPermissionsCard.jsx';
import ManagerAssignmentsCard from './ManagerAssignmentsCard.jsx';
import MigrationsPanel from './MigrationsPanel.jsx';

// Defensive boundary — if MigrationsPanel (a relatively new and
// complex card) crashes for any reason, we don't want the entire
// Settings page to white-screen. The rest of the cards (leave
// types, summary, calculation engine info) continue to render and
// the user can still admin the system. The boundary surfaces the
// underlying error so we can debug, rather than hiding it.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[SettingsView ErrorBoundary]', error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border p-4"
          style={{ borderColor: '#FCA5A5', background: '#FEF2F2', color: '#991B1B' }}>
          <div className="text-[10px] tracking-widest font-bold mb-1">SECTION FAILED TO RENDER</div>
          <div className="text-xs font-mono">{String(this.state.error?.message || this.state.error)}</div>
          <div className="text-[10px] mt-2 opacity-70">
            The rest of Settings continues to work. Open the browser console for the full stack trace.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function SettingsView({ leaveTypes, onUpdateType, employees, requests, holidays, me }) {
  const isAdmin = Boolean(me?.is_admin);
  return (
    <div className="space-y-6">
      <div>
        <div className="text-[10px] tracking-[0.25em] opacity-50 mb-2">CONFIGURATION</div>
        <h1 className="serif text-4xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>Settings</h1>
      </div>

      {isAdmin && (
        <ReviewerPermissionsCard employees={employees} me={me} />
      )}
      {isAdmin && (
        <ManagerAssignmentsCard employees={employees} me={me} />
      )}
      {isAdmin && (
        <ErrorBoundary>
          <MigrationsPanel me={me} />
        </ErrorBoundary>
      )}

      <Card title="Leave types" subtitle="Rename categories and adjust entitlements to match company policy">
        <div className="space-y-3">
          {leaveTypes.map(t => (
            <LeaveTypeRow key={t.id} type={t} onUpdate={onUpdateType}/>
          ))}
        </div>
      </Card>

      <Card title="Summary">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <Info label="Employees" value={employees.length} sub={`Active in the system`}/>
          <Info label="Requests" value={requests.length} sub={`All-time`}/>
          <Info label="Public holidays" value={holidays.length} sub={`Configured in the database`}/>
        </div>
      </Card>

      <Card title="About the calculation engine">
        <div className="text-sm opacity-80 space-y-2 leading-relaxed">
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Service-based entitlement:</strong> Employees earn 21 days of annual leave for the first five years of service, then 30 days thereafter. Calculated automatically from each person's join date.</p>
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Pro-rata for mid-year joiners:</strong> An employee who joins on 1 July earns half the annual entitlement for that year. Monthly accrual tracks what they've earned so far.</p>
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Working-day counting:</strong> For leave types that count only working days (annual, emergency, marriage, paternity, bereavement), Fridays and Saturdays are excluded, along with any public holidays you configure. Sick, Hajj, and maternity count calendar days.</p>
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Pending holds:</strong> Available balance subtracts both approved and pending requests. You cannot over-approve by mistake.</p>
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Overlap detection:</strong> The new-request form flags any proposed dates that conflict with an existing approved or pending leave for the same employee.</p>
        </div>
      </Card>
    </div>
  );
}

function LeaveTypeRow({ type, onUpdate }) {
  const [saving, setSaving] = React.useState(false);
  const [name, setName] = React.useState(type.name);
  const [days, setDays] = React.useState(type.default_days);

  const dirty = name !== type.name || Number(days) !== Number(type.default_days);

  const save = async () => {
    setSaving(true);
    try { await onUpdate(type.id, { name, default_days: Number(days) }); }
    catch (e) { alert(e.message || 'Save failed'); }
    finally { setSaving(false); }
  };

  return (
    <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border"
         style={{ borderColor: 'var(--border-soft)' }}>
      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: type.color }}/>
      <input value={name} onChange={e => setName(e.target.value)}
        className="flex-1 min-w-[160px] text-sm bg-transparent px-2 py-1.5 rounded border"
        style={{ borderColor: 'var(--border-soft)', fontWeight: 500 }}/>
      <div className="flex items-center gap-2">
        <input type="number" min="0" step="0.5" value={days}
          onChange={e => setDays(e.target.value)}
          className="w-20 text-sm bg-transparent px-2 py-1.5 rounded border"
          style={{ borderColor: 'var(--border-soft)' }}/>
        <span className="text-xs opacity-60">days/year</span>
      </div>
      <div className="text-[11px] opacity-60">
        {type.accrual_method} · {type.counts_working_days_only ? 'working days' : 'calendar days'}
      </div>
      {dirty && (
        <button onClick={save} disabled={saving}
          className="text-xs px-3 py-1.5 rounded-full disabled:opacity-50"
          style={{ background: 'var(--evergreen-500)', color: 'var(--paper)' }}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      )}
      <div className="w-full text-xs opacity-60 pl-6">{type.description}</div>
    </div>
  );
}

function Info({ label, value, sub }) {
  return (
    <div className="p-4 rounded-lg border" style={{ borderColor: 'var(--border-soft)', background: 'var(--paper)' }}>
      <div className="text-[10px] tracking-widest opacity-60">{label.toUpperCase()}</div>
      <div className="serif text-3xl mt-1" style={{ fontWeight: 500 }}>{value}</div>
      <div className="text-xs opacity-60 mt-1">{sub}</div>
    </div>
  );
}
