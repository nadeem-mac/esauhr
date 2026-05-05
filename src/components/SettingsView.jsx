import React, { useState, useMemo } from 'react';
import {
  Shield, UsersRound, ListTree, Database, BarChart3, Info, ChevronRight, PenLine,
} from 'lucide-react';
import { Card } from './Dashboard.jsx';
import ReviewerPermissionsCard from './ReviewerPermissionsCard.jsx';
import ManagerAssignmentsCard from './ManagerAssignmentsCard.jsx';
import MigrationsPanel from './MigrationsPanel.jsx';
import SignatoriesCard from './SignatoriesCard.jsx';

// =============================================================================
// SettingsView — admin configuration surface for Nadeem
//
// The previous version was a single tall scroll containing every panel
// stacked vertically: ReviewerPermissions → ManagerAssignments →
// Migrations → LeaveTypes → Summary → About. By the time you got to
// the bottom you'd lost orientation, and finding any one section
// meant scrolling past the others. The MigrationsPanel especially
// is dense and pushes everything else off-screen.
//
// Redesign: a left-rail tab navigator with six sections. Click a
// section, the content area swaps to just that panel. Mobile gets a
// horizontal pill row instead of the rail. Section content is
// unchanged — every existing card renders as before, just in
// isolation.
//
// Density tightened: smaller margins, compact stat tiles in Summary
// (4 across instead of 3 large ones), and the section description
// line on each rail item gives at-a-glance context without making
// the user click in to find out what's there.
// =============================================================================

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

// Section definitions — kept in one place so add/remove is a single
// edit. id drives the active state; the body field is a render
// function so we don't instantiate every section's tree on every
// render (only the active one mounts).
const SECTIONS = [
  {
    id: 'permissions',
    label: 'Permissions',
    icon: Shield,
    desc: 'HR reviewer + manager flags',
    body: ({ employees, me }) => <ReviewerPermissionsCard employees={employees} me={me} />,
  },
  {
    id: 'managers',
    label: 'Manager assignments',
    icon: UsersRound,
    desc: 'Who reports to whom',
    body: ({ employees, me }) => <ManagerAssignmentsCard employees={employees} me={me} />,
  },
  {
    id: 'signatories',
    label: 'Signatories',
    icon: PenLine,
    desc: 'Offer letter signing authorities',
    body: () => <SignatoriesCard />,
  },
  {
    id: 'leaves',
    label: 'Leave types',
    icon: ListTree,
    desc: 'Categories and entitlements',
    body: ({ leaveTypes, onUpdateType }) => (
      <Card title="Leave types" subtitle="Rename categories and adjust entitlements to match company policy">
        <div className="space-y-3">
          {leaveTypes.map(t => (
            <LeaveTypeRow key={t.id} type={t} onUpdate={onUpdateType}/>
          ))}
        </div>
      </Card>
    ),
  },
  {
    id: 'migrations',
    label: 'Migrations',
    icon: Database,
    desc: 'Apply pending schema changes',
    body: ({ me, onMigrationsChanged }) => (
      <ErrorBoundary>
        <MigrationsPanel me={me} onChanged={onMigrationsChanged} />
      </ErrorBoundary>
    ),
  },
  {
    id: 'summary',
    label: 'Summary',
    icon: BarChart3,
    desc: 'System totals at a glance',
    body: ({ employees, requests, holidays, leaveTypes }) => (
      <Card title="System summary">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Employees"   value={employees.length}  sub="Active" />
          <Stat label="Requests"    value={requests.length}   sub="All-time" />
          <Stat label="Holidays"    value={holidays.length}   sub="Configured" />
          <Stat label="Leave types" value={leaveTypes.length} sub="Categories" />
        </div>
      </Card>
    ),
  },
  {
    id: 'about',
    label: 'About',
    icon: Info,
    desc: 'Calculation engine reference',
    body: () => (
      <Card title="Calculation engine">
        <div className="text-[13px] opacity-85 space-y-2.5 leading-relaxed">
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Service-based entitlement.</strong> Employees earn 21 days of annual leave for the first five years of service, then 30 days thereafter. Calculated automatically from each person's join date.</p>
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Pro-rata for mid-year joiners.</strong> An employee who joins on 1 July earns half the annual entitlement for that year. Monthly accrual tracks what they've earned so far.</p>
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Working-day counting.</strong> For leave types that count only working days (annual, emergency, marriage, paternity, bereavement), Fridays and Saturdays are excluded, along with any public holidays you configure. Sick, Hajj, and maternity count calendar days.</p>
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Pending holds.</strong> Available balance subtracts both approved and pending requests. You cannot over-approve by mistake.</p>
          <p><strong style={{ color: 'var(--evergreen-700)' }}>Overlap detection.</strong> The new-request form flags any proposed dates that conflict with an existing approved or pending leave for the same employee.</p>
        </div>
      </Card>
    ),
  },
];

export default function SettingsView({ leaveTypes, onUpdateType, employees, requests, holidays, me, pendingMigrationCount = null, onMigrationsChanged }) {
  const isAdmin = Boolean(me?.is_admin);
  const [activeId, setActiveId] = useState(SECTIONS[0].id);

  const active = useMemo(
    () => SECTIONS.find(s => s.id === activeId) || SECTIONS[0],
    [activeId]
  );

  if (!isAdmin) {
    return (
      <div className="rounded-xl border p-6 text-center"
        style={{ borderColor: 'var(--border-soft)', background: 'var(--paper-2)' }}>
        <div className="text-[10px] tracking-widest opacity-60 mb-1">CONFIGURATION</div>
        <div className="serif text-2xl mb-2">Admin only</div>
        <div className="text-xs opacity-70">This section is restricted to system administrators.</div>
      </div>
    );
  }

  const ctx = { leaveTypes, onUpdateType, employees, requests, holidays, me, onMigrationsChanged };

  return (
    <div className="space-y-4">
      {/* Header — small kicker, compact serif title with the active
          section name appended in muted weight so the user has
          context-of-context without scrolling back to a tab indicator. */}
      <div>
        <div className="text-[10px] tracking-[0.25em] opacity-50 mb-1">CONFIGURATION</div>
        <h1 className="serif text-3xl" style={{ fontWeight: 500, letterSpacing: '-0.02em' }}>
          Settings <span className="opacity-40 font-light">/ {active.label}</span>
        </h1>
      </div>

      {/* Two-column layout on desktop: rail on the left, content on
          the right. Mobile collapses to a single column with a
          horizontal pill-scroller for sections at the top. */}
      <div className="grid grid-cols-1 md:grid-cols-[200px_1fr] gap-4">
        {/* Mobile: horizontal pill nav */}
        <nav className="md:hidden -mx-1 overflow-x-auto" aria-label="Settings sections">
          <div className="flex gap-1.5 px-1 pb-1.5">
            {SECTIONS.map(s => {
              const isActive = s.id === activeId;
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors"
                  style={{
                    background: isActive ? 'var(--evergreen-600)' : 'var(--paper)',
                    color: isActive ? '#FFFFFF' : '#0A0A0A',
                    border: '1px solid ' + (isActive ? 'var(--evergreen-600)' : 'var(--border)'),
                    fontWeight: isActive ? 600 : 500,
                  }}
                >
                  <Icon className="w-3 h-3" />
                  {s.label}
                  {s.id === 'migrations' && pendingMigrationCount > 0 && (
                    <span
                      className="text-[9px] px-1 rounded-full font-bold"
                      style={{
                        background: isActive ? '#FFFFFF' : '#DC2626',
                        color: isActive ? '#DC2626' : '#FFFFFF',
                        minWidth: 14,
                        lineHeight: 1.4,
                        textAlign: 'center',
                      }}
                    >
                      {pendingMigrationCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Desktop: vertical rail. Sticky so it stays in view when
            the content panel scrolls. Each rail item: icon, label,
            small description; active item gets a green tinted
            background, bolder text, and a chevron indicator. */}
        <nav className="hidden md:block sticky top-4 self-start" aria-label="Settings sections">
          <div className="rounded-xl border p-1.5"
            style={{ borderColor: 'var(--border-soft)', background: 'var(--paper)' }}>
            {SECTIONS.map(s => {
              const isActive = s.id === activeId;
              const Icon = s.icon;
              return (
                <button
                  key={s.id}
                  onClick={() => setActiveId(s.id)}
                  className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors"
                  style={{
                    background: isActive ? 'var(--evergreen-50, #ECFDF5)' : 'transparent',
                    cursor: 'pointer',
                  }}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <div
                    className="flex-shrink-0 mt-0.5"
                    style={{ color: isActive ? 'var(--evergreen-700)' : '#737373' }}
                  >
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] leading-tight flex items-center gap-1.5"
                      style={{
                        color: isActive ? 'var(--evergreen-800, #0F2818)' : '#0A0A0A',
                        fontWeight: isActive ? 600 : 500,
                      }}>
                      <span>{s.label}</span>
                      {s.id === 'migrations' && pendingMigrationCount > 0 && (
                        // Red badge — matches the urgent-attention
                        // style used on the Settings tab badge so
                        // Nadeem sees the same visual cue as he drills
                        // down from the top nav.
                        <span
                          className="text-[9px] px-1.5 py-0.5 rounded-full font-bold inline-flex items-center justify-center"
                          style={{
                            background: '#DC2626',
                            color: '#FFFFFF',
                            minWidth: 16,
                            lineHeight: 1,
                            letterSpacing: '0.02em',
                          }}
                          title={`${pendingMigrationCount} pending`}
                        >
                          {pendingMigrationCount}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px] opacity-55 leading-tight mt-0.5">
                      {s.id === 'migrations' && pendingMigrationCount > 0
                        ? `${pendingMigrationCount} pending — apply now`
                        : s.desc}
                    </div>
                  </div>
                  {isActive && (
                    <ChevronRight className="w-3 h-3 mt-0.5 flex-shrink-0" style={{ color: 'var(--evergreen-700)' }} />
                  )}
                </button>
              );
            })}
          </div>
        </nav>

        {/* Content area — only the active section renders. Wrapped
            with a key on activeId so the section remounts cleanly
            when switching (clears any in-flight state from the
            previous section). */}
        <div key={activeId} className="min-w-0">
          {active.body(ctx)}
        </div>
      </div>
    </div>
  );
}

// ─── Subcomponents ─────────────────────────────────────────────────

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

// Compact stat tile — half the visual weight of the old Info layout.
// Smaller numeric, single-line label, denser internal spacing.
function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border p-3"
      style={{ borderColor: 'var(--border-soft)', background: 'var(--paper)' }}>
      <div className="text-[10px] tracking-widest opacity-60">{label.toUpperCase()}</div>
      <div className="serif text-2xl mt-1" style={{ fontWeight: 500, letterSpacing: '-0.01em' }}>{value}</div>
      <div className="text-[11px] opacity-55 mt-0.5">{sub}</div>
    </div>
  );
}
