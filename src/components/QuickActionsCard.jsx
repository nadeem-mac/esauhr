import React, { useMemo, useRef, useState, useEffect } from 'react';
import {
  Plus, Search, Printer, Mail, BarChart3, Network,
  ArrowRight, X, Phone, MapPin,
} from 'lucide-react';
import { salutationFor } from '../lib/salutations.js';

// =============================================================================
// QuickActionsCard
//
// Bashaier's daily-work command center. Sits right below the hero on her
// Dashboard view. Five things she reaches for every morning, presented as
// large editorial action tiles with brand-color accents:
//
//   1. APPLY LEAVE FOR STAFF — managers frequently email her saying
//      'please apply X leave for Y staff'; this opens NewRequestModal
//      with employee picker enabled
//   2. FIND EMPLOYEE — instant search across the whole staff roster.
//      Click a result to jump to their profile in the Employees tab
//      (or just see their key info inline)
//   3. PRINT FORM — placeholder for the PDF form picker (vacation,
//      rejoining, permission for any employee). For now routes to
//      Requests tab; the dedicated picker modal comes next.
//   4. SEND REMINDER — opens the Reviews tab where the sick certs
//      reminder workflow lives
//   5. MONTHLY REPORTS — jumps to the Attendance tab where the
//      monthly attendance + compliance card sits
//
// Plus a small inline employee search at the top of the card — most
// common micro-action she does ('quickly check what X's PSN is, what
// their department is, etc.').
//
// Design language matches the rest of Bashaier's editorial dashboard:
// serif headings, kicker labels, generous whitespace, brand-accent
// dots only where they earn attention. Nadeem 2026-05-17.
// =============================================================================

export default function QuickActionsCard({
  me,
  employees = [],
  pendingCount = 0,
  onNewRequest,
  onGoToReviews,
  onGoToRequests,
  onGoToAttendance,
  onOpenOrgChart,
  onUploadCert,
}) {
  const [search, setSearch] = useState('');
  const [showResults, setShowResults] = useState(false);
  const inputRef = useRef(null);

  // Filter staff for inline search. Match name or PSN, cap at 6 hits
  // so the dropdown doesn't dominate the card.
  const searchResults = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (q.length < 2) return [];
    return (employees || [])
      .filter(e =>
        (e.name || '').toLowerCase().includes(q) ||
        (e.id   || '').toLowerCase().includes(q)
      )
      .slice(0, 6);
  }, [employees, search]);

  // Click-outside to close the search results dropdown.
  useEffect(() => {
    if (!showResults) return;
    const handler = (e) => {
      if (inputRef.current && !inputRef.current.contains(e.target)) {
        setShowResults(false);
      }
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [showResults]);

  return (
    <section
      className="rounded-2xl overflow-hidden"
      style={{ background: '#FFFFFF', border: '1px solid var(--border-soft, #E8E5D8)' }}
    >
      {/* Header + inline search bar — single row on desktop, stacks on mobile.
          The search is the most-used micro-action so it gets prime real
          estate inside the card header rather than a separate row below. */}
      <div className="px-6 py-5 sm:px-8 sm:py-5 flex items-center justify-between gap-4 flex-wrap"
           style={{ borderBottom: '1px solid #F4F4EE' }}>
        <div>
          <div className="text-[10px]" style={{ color: '#1F1B16', letterSpacing: '0.3em', fontWeight: 700 }}>
            — QUICK ACTIONS
          </div>
          <h2 className="serif" style={{
            fontSize: '22px', color: '#1F1B16', marginTop: '4px',
            fontWeight: 500, letterSpacing: '-0.01em',
          }}>
            What can I help you start?
          </h2>
        </div>

        {/* Inline employee search — types name or PSN, shows up to 6
            matches in a dropdown. Each result is a button that opens
            an inline summary panel below the search rather than a
            full modal — quicker for the 'just check their PSN'
            micro-task. */}
        <div ref={inputRef} className="relative w-full sm:w-80">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2"
                    style={{ color: '#1F1B16', opacity: 0.5 }}/>
            <input
              type="text"
              value={search}
              onChange={e => { setSearch(e.target.value); setShowResults(true); }}
              onFocus={() => setShowResults(true)}
              placeholder="Find staff — name or PSN"
              className="w-full pl-10 pr-9 py-2.5 rounded-lg text-sm focus:outline-none"
              style={{
                background: '#FAFAF7',
                border: '1px solid var(--border-soft, #E8E5D8)',
                color: '#0A0A0A',
              }}
            />
            {search && (
              <button onClick={() => { setSearch(''); setShowResults(false); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-gray-100">
                <X className="w-3.5 h-3.5" style={{ color: '#1F1B16', opacity: 0.5 }}/>
              </button>
            )}
          </div>
          {showResults && search.length >= 2 && (
            <SearchResults results={searchResults} onSelect={() => setShowResults(false)} />
          )}
        </div>
      </div>

      {/* Action tiles — 5 chunky chips in a responsive grid. Each tile
          is brand-color-accented (subtle tint + saturated icon) so the
          card has visual rhythm without becoming a peacock display. */}
      <div className="px-6 py-5 sm:px-8 sm:py-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <ActionTile
            label="APPLY LEAVE"
            caption="On behalf of staff"
            icon={Plus}
            accent="#0F4C2A"
            tint="#ECFDF5"
            onClick={onNewRequest}
          />
          <ActionTile
            label="REVIEW QUEUE"
            caption={pendingCount > 0 ? `${pendingCount} pending` : 'All clear'}
            icon={ArrowRight}
            accent={pendingCount > 0 ? '#C2410C' : '#9CA3AF'}
            tint={pendingCount > 0 ? '#FFFBEB' : '#F8F8F2'}
            badge={pendingCount > 0 ? pendingCount : null}
            onClick={onGoToReviews || onGoToRequests}
          />
          <ActionTile
            label="PRINT FORM"
            caption="Vacation / rejoining"
            icon={Printer}
            accent="#4F46E5"
            tint="#EEF2FF"
            onClick={onGoToRequests}
          />
          <ActionTile
            label="SICK CERT"
            caption="Upload Sehhaty PDF"
            icon={Mail}
            accent="#BE123C"
            tint="#FFF1F2"
            onClick={onUploadCert}
          />
          <ActionTile
            label="ORG CHART"
            caption="Roster & reporting"
            icon={Network}
            accent="#0E7490"
            tint="#ECFEFF"
            onClick={onOpenOrgChart}
          />
        </div>
      </div>
    </section>
  );
}

// =============================================================================
// SearchResults — dropdown attached to the search input
// =============================================================================
function SearchResults({ results, onSelect }) {
  if (results.length === 0) {
    return (
      <div className="absolute z-20 mt-1 w-full rounded-lg shadow-md p-3"
           style={{ background: '#FFFFFF', border: '1px solid var(--border-soft, #E8E5D8)' }}>
        <div className="text-[12px] italic" style={{ color: '#1F1B16', opacity: 0.6 }}>
          No matches. Try a different name or PSN.
        </div>
      </div>
    );
  }
  return (
    <div className="absolute z-20 mt-1 w-full rounded-lg shadow-md overflow-hidden"
         style={{ background: '#FFFFFF', border: '1px solid var(--border-soft, #E8E5D8)' }}>
      {results.map((emp, idx) => (
        <button
          key={emp.id}
          onClick={onSelect}
          className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-gray-50 transition-colors"
          style={{
            borderTop: idx === 0 ? 'none' : '1px solid #F4F4EE',
            color: '#0A0A0A',
          }}
        >
          <div className="min-w-0 flex-1">
            <div className="text-[13px] truncate" style={{ fontWeight: 500 }}>
              {salutationFor(emp)} <span className="opacity-60">· {emp.name}</span>
            </div>
            <div className="text-[11px] truncate" style={{ opacity: 0.65 }}>
              {emp.id} · {emp.department || '—'}{emp.location ? ` · ${emp.location}` : ''}
            </div>
          </div>
          <ArrowRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#1F1B16', opacity: 0.4 }}/>
        </button>
      ))}
    </div>
  );
}

// =============================================================================
// ActionTile — large clickable action chip
// =============================================================================
function ActionTile({ label, caption, icon: Icon, accent, tint, badge, onClick }) {
  const isDisabled = !onClick;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isDisabled}
      className="text-left rounded-xl p-4 transition-all"
      style={{
        background: isDisabled ? '#F8F8F2' : tint,
        border: `1px solid ${isDisabled ? 'var(--border-soft, #E8E5D8)' : accent}33`,
        cursor: isDisabled ? 'default' : 'pointer',
        minHeight: '110px',
      }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="rounded-lg p-2"
             style={{ background: isDisabled ? '#FFFFFF' : `${accent}1F` }}>
          <Icon className="w-5 h-5" style={{ color: isDisabled ? '#9CA3AF' : accent }}/>
        </div>
        {badge != null && (
          <span className="text-[10px] px-2 py-0.5 rounded-full"
                style={{
                  background: accent, color: '#FFFFFF',
                  fontWeight: 700, letterSpacing: '0.06em',
                }}>
            {badge}
          </span>
        )}
      </div>
      <div className="text-[11px]" style={{
        color: '#1F1B16', letterSpacing: '0.14em', fontWeight: 700,
      }}>
        {label}
      </div>
      <div className="text-[11px] mt-1" style={{ color: '#1F1B16', opacity: 0.7 }}>
        {caption}
      </div>
    </button>
  );
}
