// ─── GovernmentDataSync.jsx ──────────────────────────────────────────
//
// Admin tool for reconciling the portal's employees table against
// the MOL/GOSI subscriber list (the file Jafar shares periodically
// from the government system). Workflow:
//
//   1. The component loads with the bundled molSnapshot.json — the
//      most recent file Nadeem committed to the repo. Admin can
//      also upload a fresh xlsx to replace it.
//   2. Reconciliation runs in the browser: each MOL subscriber is
//      matched against the portal's employees by exact National ID
//      first, then by fuzzy transliterated-name overlap.
//   3. Admin reviews each suggested match. They can:
//        • Confirm  — apply the MOL record to that portal employee
//        • Swap     — pick a different portal employee from the
//                     suggestions or the full list
//        • Skip     — leave it for later (no DB write)
//   4. Apply selected — writes confirmed matches in a batch using
//      directPatch. Unmatched MOL rows stay unmatched (not yet
//      onboarded into portal); orphaned portal rows are listed for
//      attention but not modified.
//
// The component does NOT delete portal employees or auto-create new
// ones — that's an HR judgment call Nadeem must make explicitly.

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Database, Upload, CheckCircle2, AlertCircle, X, Search,
  ChevronDown, ChevronUp, Loader2, Save, FileText, RefreshCw,
  Link2, Users,
} from 'lucide-react';
import { directGet, directPatch } from '../supabaseClient.js';
import { parseMolFile, reconcile, reconcileWithRoster, nameSimilarity, englishNameSimilarity } from '../lib/molSync.js';
import bundledSnapshot from '../data/molSnapshot.json';
import bundledRoster from '../data/badriaRoster.json';
import { logAction } from '../lib/audit.js';

const PALETTE = {
  green:  '#0F4C2A',
  cream:  '#FAFAF6',
  ink:    '#1F1B16',
  mute:   '#0A0A0A',
  amber:  '#854F0B',
  amberBg:'#FEF3C7',
  red:    '#991B1B',
  redBg:  '#FEE2E2',
  greenBg:'#ECFDF5',
};

export default function GovernmentDataSync({ me }) {
  // ─── Snapshot state ────────────────────────────────────────────
  // The "current" snapshot is either the bundled JSON or one freshly
  // parsed from an upload. Same shape: { establishmentName,
  // gosiSubscriptionId, subscribers[] }.
  const [snapshot, setSnapshot] = useState(bundledSnapshot);
  const [snapshotSource, setSnapshotSource] = useState('bundled'); // 'bundled' | 'upload'
  const [uploadErr, setUploadErr] = useState(null);
  const [uploading, setUploading] = useState(false);

  // ─── Portal employees ──────────────────────────────────────────
  const [employees, setEmployees] = useState([]);
  const [empLoading, setEmpLoading] = useState(true);
  const [empErr, setEmpErr] = useState(null);

  // ─── Reconciliation result ─────────────────────────────────────
  const [reconciliation, setReconciliation] = useState(null);

  // ─── Per-row decisions ─────────────────────────────────────────
  // Map: national_id → { action: 'apply'|'skip', employeeId: chosen target }
  const [decisions, setDecisions] = useState({});

  // ─── Apply state ───────────────────────────────────────────────
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState(null); // { ok:N, failed:N, errors:[] }

  // ─── UI state ──────────────────────────────────────────────────
  const [search, setSearch] = useState('');
  const [showOrphaned, setShowOrphaned] = useState(false);
  const [showUnmatched, setShowUnmatched] = useState(false);

  // ─── Load portal employees ─────────────────────────────────────
  const loadEmployees = useCallback(async () => {
    setEmpLoading(true);
    setEmpErr(null);
    try {
      const emps = await directGet(
        'employees',
        'select=*&order=name',
        { timeoutMs: 12000 }
      );
      setEmployees(Array.isArray(emps) ? emps : []);
    } catch (e) {
      setEmpErr(String(e?.message || e));
    } finally {
      setEmpLoading(false);
    }
  }, []);
  useEffect(() => { loadEmployees(); }, [loadEmployees]);

  // ─── Run reconciliation when snapshot or employees change ──────
  // Uses Badria's roster as the primary key bridge: every PSN in
  // Badria's file deterministically maps to a portal employee and
  // (usually) an MOL Iqama. MOL records that aren't in Badria's
  // roster fall through to fuzzy name matching.
  useEffect(() => {
    if (!snapshot?.subscribers || empLoading) return;
    const result = reconcileWithRoster(
      bundledRoster.entries || [],
      snapshot.subscribers,
      employees
    );
    setReconciliation(result);

    // Initialize per-row decisions. Decision keyed by employeeId
    // (not national_id, since some matches don't have an MOL record
    // — they're roster-only). Roster-driven matches default to
    // 'apply' (deterministic, confidence 1.0). Fuzzy matches default
    // by their confidence threshold.
    const init = {};
    for (const m of result.matches) {
      init[m.employeeId] = {
        action: (m.source === 'roster_full' || m.source === 'roster_only' || m.confidence >= 0.7) ? 'apply' : 'skip',
        employeeId: m.employeeId,
      };
    }
    setDecisions(init);
  }, [snapshot, employees, empLoading]);

  // ─── File upload ───────────────────────────────────────────────
  const handleFile = useCallback(async (file) => {
    if (!file) return;
    setUploading(true);
    setUploadErr(null);
    try {
      const parsed = await parseMolFile(file);
      setSnapshot({
        source_file: file.name,
        fetched_at: new Date().toISOString().slice(0, 10),
        establishment_name_ar: parsed.establishmentName,
        gosi_subscription_id: parsed.gosiSubscriptionId,
        subscribers: parsed.subscribers,
      });
      setSnapshotSource('upload');
      setApplyResult(null);
    } catch (e) {
      setUploadErr(String(e?.message || e));
    } finally {
      setUploading(false);
    }
  }, []);

  // ─── Apply confirmed matches ───────────────────────────────────
  // Each match has up to two data sources:
  //   • m.mol — the MOL/GOSI record (Arabic name, DOB, profession,
  //     gender, MOL join date, eligibility). May be null for
  //     roster-only matches (Badria has the PSN+Iqama but the
  //     Iqama hasn't yet appeared in the GOSI subscriber list,
  //     usually a recent hire).
  //   • m.roster — Badria's row (PSN, Iqama, Latin name, location,
  //     department). Present for roster-driven matches.
  //
  // The patch combines both sources with MOL winning where it has
  // data (formal Arabic name → canonical transliteration), and
  // Badria's roster filling location, department, and the fallback
  // English name when MOL is absent.
  const applyDecisions = useCallback(async (overrideDecisions) => {
    if (!reconciliation) return;
    const decisionsToUse = overrideDecisions || decisions;
    const toApply = reconciliation.matches.filter(m => {
      const d = decisionsToUse[m.employeeId];
      return d?.action === 'apply' && d?.employeeId;
    });
    if (toApply.length === 0) {
      setApplyResult({ ok: 0, failed: 0, errors: [], message: 'Nothing selected to apply.' });
      return;
    }

    setApplying(true);
    setApplyResult(null);
    let ok = 0, failed = 0;
    const errors = [];
    const now = new Date().toISOString();

    for (const m of toApply) {
      const d = decisionsToUse[m.employeeId];
      const empId = d.employeeId;
      try {
        const patch = { mol_synced_at: now };

        // National ID: prefer MOL (it's the canonical source) but
        // fall back to roster (which by definition has it).
        const nid = m.mol?.national_id || m.roster?.national_id || null;
        if (nid) patch.national_id = nid;

        // MOL fields — only present when m.mol exists
        if (m.mol) {
          if (m.mol.arabic_name)        patch.arabic_name       = m.mol.arabic_name;
          if (m.mol.date_of_birth)      patch.date_of_birth     = m.mol.date_of_birth;
          if (m.mol.gender)             patch.gender            = m.mol.gender;
          if (m.mol.arabic_profession)  patch.arabic_profession = m.mol.arabic_profession;
          if (m.mol.mol_join_date)      patch.mol_join_date     = m.mol.mol_join_date;
          if (m.mol.gosi_eligibility)   patch.gosi_eligibility  = m.mol.gosi_eligibility;
          if (m.mol.nationality)        patch.nationality       = m.mol.nationality;
        }

        // English name — m.proposedName is set by reconcileWithRoster.
        // For roster_full matches: MOL canonical (transliterated
        // from formal Arabic name). For roster_only: Badria's name
        // uppercased. For fuzzy_mol: MOL canonical. Always uppercase.
        if (m.proposedName) {
          patch.name = String(m.proposedName).toUpperCase().replace(/\s+/g, ' ').trim();
        } else if (m.mol?.canonical_name) {
          patch.name = m.mol.canonical_name;
        }

        // Roster-driven fields: location and department from Badria.
        // Only overwrite if Badria has a value AND it differs from
        // what the portal already holds (defensive — don't blank
        // good data).
        if (m.roster?.location) {
          patch.location = String(m.roster.location).toUpperCase().trim();
        }
        if (m.roster?.department) {
          patch.department = String(m.roster.department).toUpperCase().trim();
        }

        await directPatch(
          'employees', 'id', empId, patch,
          { timeoutMs: 9000 }
        );
        ok++;
      } catch (e) {
        failed++;
        errors.push({ employeeId: empId, message: String(e?.message || e) });
      }
    }

    setApplying(false);
    setApplyResult({ ok, failed, errors });

    if (ok > 0) {
      loadEmployees();
      try {
        await logAction(me, 'mol_sync_apply', {
          targetType: 'employees',
          targetLabel: `${ok} employees synced from MOL/Badria roster${failed ? ` (${failed} failed)` : ''}`,
        });
      } catch {}
    }
  }, [reconciliation, decisions, loadEmployees, me]);

  // ─── Auto-sync — applies all confident matches in one click ──
  // "Confident" means:
  //   • National ID match (perfect — confidence === 1.0). After
  //     the first sync these dominate, since national_id is then
  //     populated for all already-synced staff and future MOL
  //     uploads match deterministically on that column.
  //   • Name match with confidence >= 0.7 (token overlap is high
  //     enough that the Arabic name almost certainly identifies
  //     this portal employee).
  // Lower-confidence rows still need manual review via the per-
  // row checkbox.
  const autoSyncConfident = useCallback(() => {
    if (!reconciliation) return;
    const next = {};
    for (const m of reconciliation.matches) {
      const eligible =
        m.source === 'roster_full' ||
        m.source === 'roster_only' ||
        m.confidence >= 0.7;
      next[m.employeeId] = {
        action: eligible ? 'apply' : 'skip',
        employeeId: m.employeeId,
      };
    }
    setDecisions(next);
    applyDecisions(next);
  }, [reconciliation, applyDecisions]);

  // ─── Filtered display ─────────────────────────────────────────
  const filteredMatches = useMemo(() => {
    if (!reconciliation) return [];
    const q = search.trim().toLowerCase();
    if (!q) return reconciliation.matches;
    return reconciliation.matches.filter(m => {
      const emp = employees.find(e => e.id === m.employeeId);
      const haystack = [
        m.mol?.arabic_name,
        m.mol?.national_id,
        m.mol?.arabic_profession,
        m.roster?.national_id,
        m.roster?.name,
        m.proposedName,
        emp?.name,
        emp?.id,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }, [reconciliation, search, employees]);

  // ─── Counts for header ─────────────────────────────────────────
  const counts = useMemo(() => {
    if (!reconciliation) return null;
    const willApply = Object.values(decisions).filter(d => d.action === 'apply').length;
    const rosterFull  = reconciliation.matches.filter(m => m.source === 'roster_full').length;
    const rosterOnly  = reconciliation.matches.filter(m => m.source === 'roster_only').length;
    const fuzzy       = reconciliation.matches.filter(m => m.source === 'fuzzy_mol').length;
    return {
      total: reconciliation.matches.length + reconciliation.unmatched.length,
      matched: reconciliation.matches.length,
      unmatched: reconciliation.unmatched.length,
      orphaned: reconciliation.orphaned.length,
      ghosts: reconciliation.rosterGhosts?.length || 0,
      rosterFull,
      rosterOnly,
      fuzzy,
      willApply,
    };
  }, [reconciliation, decisions]);

  return (
    <section
      className="rounded-2xl"
      style={{
        background: '#FFFFFF',
        border: '1px solid #E5E5E5',
        padding: 18,
        fontFamily: 'Calibri, "Segoe UI", Arial, sans-serif',
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-4">
        <div className="flex items-start gap-3">
          <div
            className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: '#E8F5E9', color: PALETTE.green }}
          >
            <Database className="w-5 h-5" />
          </div>
          <div>
            <div className="text-[10px] mb-1" style={{ color: PALETTE.green, fontWeight: 700, letterSpacing: '0.22em' }}>
              MOL · GOSI
            </div>
            <h3 style={{ fontSize: 18, fontWeight: 700, color: PALETTE.ink, lineHeight: 1.2 }}>
              Government data sync
            </h3>
            <p className="text-[12px] mt-0.5" style={{ color: PALETTE.mute, opacity: 0.75, maxWidth: 540 }}>
              Match each MOL subscriber to a portal employee, then apply the official Arabic name, National ID, DOB, profession, and GOSI status.
            </p>
          </div>
        </div>
        <button
          onClick={loadEmployees}
          disabled={empLoading}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px]"
          style={{ background: '#FFFFFF', border: '1px solid #D4D4D4', color: PALETTE.ink, fontWeight: 600, cursor: empLoading ? 'not-allowed' : 'pointer' }}
        >
          {empLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
          Refresh
        </button>
      </div>

      {/* Source bar — both data sources stacked */}
      <div className="mb-4 space-y-2">
        <div
          className="flex items-center gap-3 flex-wrap p-3 rounded-lg"
          style={{ background: PALETTE.cream, border: '1px solid #E5E5E5' }}
        >
          <FileText className="w-4 h-4 flex-shrink-0" style={{ color: PALETTE.ink, opacity: 0.6 }} />
          <div className="text-[12px]" style={{ color: PALETTE.ink, flex: '1 1 240px' }}>
            <span style={{ fontWeight: 700 }}>GOSI:</span>{' '}
            {snapshotSource === 'bundled' ? 'bundled MOLFile.xlsx' : (snapshot.source_file || 'uploaded file')}
            {snapshot.fetched_at && (
              <span style={{ opacity: 0.65 }}> · fetched {snapshot.fetched_at}</span>
            )}
            {snapshot.gosi_subscription_id && (
              <span style={{ opacity: 0.65 }}> · sub. {snapshot.gosi_subscription_id}</span>
            )}
            <span style={{ opacity: 0.65 }}> · {snapshot.subscribers?.length || 0} subscribers</span>
          </div>
          <label
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px]"
            style={{ background: PALETTE.ink, color: '#FFFFFF', fontWeight: 600, cursor: 'pointer' }}
          >
            {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
            Upload new MOL file
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
                e.target.value = '';
              }}
              style={{ display: 'none' }}
            />
          </label>
        </div>
        <div
          className="flex items-center gap-3 flex-wrap p-3 rounded-lg"
          style={{ background: PALETTE.cream, border: '1px solid #E5E5E5' }}
        >
          <Link2 className="w-4 h-4 flex-shrink-0" style={{ color: PALETTE.ink, opacity: 0.6 }} />
          <div className="text-[12px]" style={{ color: PALETTE.ink }}>
            <span style={{ fontWeight: 700 }}>Roster:</span>{' '}
            {bundledRoster.source_file}
            <span style={{ opacity: 0.65 }}> · provided by {bundledRoster.provided_by}</span>
            <span style={{ opacity: 0.65 }}> · {bundledRoster.entries?.length || 0} PSN ↔ Iqama pairs</span>
          </div>
        </div>
      </div>

      {uploadErr && (
        <div
          className="flex items-start gap-2 p-3 rounded-lg mb-3 text-[12px]"
          style={{ background: PALETTE.redBg, border: `1px solid #FCA5A5`, color: PALETTE.red }}
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <strong>Upload failed:</strong> {uploadErr}
          </div>
        </div>
      )}

      {empErr && (
        <div
          className="flex items-start gap-2 p-3 rounded-lg mb-3 text-[12px]"
          style={{ background: PALETTE.redBg, border: `1px solid #FCA5A5`, color: PALETTE.red }}
        >
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>Failed to load portal employees: {empErr}</div>
        </div>
      )}

      {/* Counts — Roster-aware. Badria's PSN↔Iqama bridge gives
          deterministic matches; fuzzy MOL matching only kicks in
          for MOL records not in Badria's roster. */}
      {counts && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          <CountTile label="Roster + GOSI" value={counts.rosterFull} bg="#ECFDF5" fg={PALETTE.green} border="#A7F3D0" />
          <CountTile label="Roster only"   value={counts.rosterOnly} bg={PALETTE.amberBg} fg={PALETTE.amber} border="#FCD34D" />
          <CountTile label="Fuzzy MOL"     value={counts.fuzzy}      bg="#E0E7FF" fg="#3730A3" border="#A5B4FC" />
          <CountTile label="Will apply"    value={counts.willApply}  bg="#F5F5F5" fg="#525252" border="#D4D4D4" />
        </div>
      )}

      {/* Auto-sync banner — Roster-driven. Badria provided PSN↔Iqama
          mapping for nearly the entire roster, so deterministic
          matching dominates. The button applies all roster-driven
          matches (confidence 1.0) plus any fuzzy MOL matches with
          ≥70% confidence in one click. */}
      {counts && counts.matched > 0 && (() => {
        const confidentCount = reconciliation.matches.filter(m =>
          m.source === 'roster_full' || m.source === 'roster_only' || m.confidence >= 0.7
        ).length;
        const uncertainCount = counts.matched - confidentCount;
        return (
          <div
            className="mb-4 p-3 rounded-lg flex items-center gap-3 flex-wrap"
            style={{
              background: 'linear-gradient(135deg, #ECFDF5 0%, #DCFCE7 100%)',
              border: '1px solid #A7F3D0',
            }}
          >
            <CheckCircle2 className="w-5 h-5 flex-shrink-0" style={{ color: PALETTE.green }} />
            <div style={{ flex: '1 1 240px', minWidth: 0 }}>
              <div className="text-[12px]" style={{ color: PALETTE.green, fontWeight: 700 }}>
                Sync via Badria's roster + GOSI
              </div>
              <div className="text-[11px] mt-0.5" style={{ color: PALETTE.green, opacity: 0.85 }}>
                Apply {confidentCount} match{confidentCount === 1 ? '' : 'es'} in one click — Badria's PSN↔National ID mapping bridges to GOSI for the official Arabic name, DOB, profession, and eligibility status. All English names normalized to UPPERCASE.
                {uncertainCount > 0 && ` ${uncertainCount} uncertain match${uncertainCount === 1 ? '' : 'es'} left for manual review below.`}
              </div>
            </div>
            <button
              onClick={autoSyncConfident}
              disabled={applying || confidentCount === 0}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px] flex-shrink-0"
              style={{
                background: applying || confidentCount === 0 ? '#A3A3A3' : PALETTE.green,
                color: '#FFFFFF',
                border: 'none',
                fontWeight: 700,
                cursor: applying || confidentCount === 0 ? 'not-allowed' : 'pointer',
                boxShadow: confidentCount > 0 && !applying ? '0 2px 6px rgba(15,76,42,0.18)' : 'none',
                fontFamily: 'inherit',
              }}
            >
              {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              Sync {confidentCount} now
            </button>
          </div>
        );
      })()}

      {/* Search */}
      {reconciliation && (
        <div className="relative mb-3" style={{ maxWidth: 360 }}>
          <Search
            className="w-3.5 h-3.5"
            style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              color: PALETTE.mute, opacity: 0.5, pointerEvents: 'none',
            }}
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, ID, profession…"
            style={{
              width: '100%',
              padding: '7px 28px 7px 32px',
              border: '1px solid #D4D4D4',
              borderRadius: 999,
              fontSize: 12,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                width: 20, height: 20, borderRadius: 999, border: 'none',
                background: '#F5F5F5', color: PALETTE.ink, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      )}

      {/* Match list */}
      {empLoading ? (
        <div className="flex items-center gap-2 py-8 justify-center text-[13px]" style={{ color: PALETTE.mute, opacity: 0.6 }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading portal employees…
        </div>
      ) : reconciliation && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filteredMatches.map((m) => {
            const emp = employees.find(e => e.id === m.employeeId);
            const decision = decisions[m.employeeId] || { action: 'skip' };
            // Build a synthetic mol-shape for the row UI, falling
            // back to roster fields when MOL is absent. This keeps
            // MatchRow's contract simple — it doesn't need to know
            // about source types.
            const rowData = m.mol || {
              arabic_name:       null,
              national_id:       m.roster?.national_id || null,
              canonical_name:    m.proposedName,
              arabic_profession: null,
              date_of_birth:     null,
            };
            return (
              <MatchRow
                key={m.employeeId}
                mol={rowData}
                emp={emp}
                confidence={m.confidence}
                reason={m.reason}
                source={m.source}
                roster={m.roster}
                proposedName={m.proposedName}
                alternatives={m.alternatives || []}
                allEmployees={employees}
                decision={decision}
                onChangeAction={(action) => {
                  setDecisions(prev => ({
                    ...prev,
                    [m.employeeId]: { ...prev[m.employeeId], action, employeeId: m.employeeId },
                  }));
                }}
                onChangeEmployee={(empId) => {
                  setDecisions(prev => ({
                    ...prev,
                    [m.employeeId]: { action: 'apply', employeeId: empId },
                  }));
                }}
              />
            );
          })}
          {filteredMatches.length === 0 && (
            <div className="text-center py-6 text-[12px]" style={{ color: PALETTE.mute, opacity: 0.5 }}>
              No matches for "{search}".
            </div>
          )}
        </div>
      )}

      {/* Unmatched MOL section — collapsed by default */}
      {reconciliation && reconciliation.unmatched.length > 0 && (
        <div className="mt-5">
          <button
            onClick={() => setShowUnmatched(v => !v)}
            className="flex items-center gap-2 text-[12px]"
            style={{ background: 'none', border: 'none', color: PALETTE.amber, fontWeight: 700, cursor: 'pointer', padding: 0 }}
          >
            {showUnmatched ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {reconciliation.unmatched.length} MOL subscriber{reconciliation.unmatched.length === 1 ? '' : 's'} with no portal match
          </button>
          {showUnmatched && (
            <div
              className="mt-2 p-3 rounded-lg text-[12px]"
              style={{ background: PALETTE.amberBg, border: `1px solid #FCD34D`, color: PALETTE.amber }}
            >
              <p style={{ fontWeight: 600, marginBottom: 6 }}>
                These staff are registered with MOL/GOSI but have no portal record. They likely need onboarding into the portal:
              </p>
              <ul style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {reconciliation.unmatched.map((u, idx) => (
                  <li key={idx} style={{ fontFamily: 'system-ui', direction: 'rtl' }}>
                    {u.mol.arabic_name} · <span style={{ direction: 'ltr', display: 'inline-block', fontFamily: 'inherit' }}>{u.mol.national_id}</span> · {u.mol.arabic_profession || '—'}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Roster ghosts — Badria PSNs not in the portal. These need
          investigation: probably PSNs Badria added to her file before
          the staff member was onboarded into the portal, or PSNs that
          have since been retired. Surfaced with a red-amber tone so
          admin notices but doesn't see it as an error. */}
      {reconciliation?.rosterGhosts?.length > 0 && (
        <div className="mt-3">
          <div
            className="p-3 rounded-lg text-[12px]"
            style={{ background: PALETTE.amberBg, border: '1px solid #FCD34D', color: PALETTE.amber }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              {reconciliation.rosterGhosts.length} PSN{reconciliation.rosterGhosts.length === 1 ? '' : 's'} in Badria's roster but missing from the portal:
            </div>
            <ul style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {reconciliation.rosterGhosts.map((g, idx) => (
                <li key={idx}>
                  <span style={{ fontFamily: 'system-ui' }}>{g.roster.psn}</span> · {g.roster.national_id} · {g.roster.name}{g.roster.department ? ` · ${g.roster.department}` : ''}
                  {g.mol ? <span style={{ opacity: 0.7 }}> (GOSI: {g.mol.canonical_name})</span> : <span style={{ opacity: 0.7 }}> (no GOSI record)</span>}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Orphaned portal employees — collapsed by default */}
      {reconciliation && reconciliation.orphaned.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setShowOrphaned(v => !v)}
            className="flex items-center gap-2 text-[12px]"
            style={{ background: 'none', border: 'none', color: '#525252', fontWeight: 700, cursor: 'pointer', padding: 0 }}
          >
            {showOrphaned ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            {reconciliation.orphaned.length} portal employee{reconciliation.orphaned.length === 1 ? '' : 's'} not in roster or MOL
          </button>
          {showOrphaned && (
            <div
              className="mt-2 p-3 rounded-lg text-[12px]"
              style={{ background: '#F5F5F5', border: `1px solid #D4D4D4`, color: '#525252' }}
            >
              <p style={{ fontWeight: 600, marginBottom: 6 }}>
                These portal employees aren't in Badria's roster and weren't fuzzy-matched in MOL. They may be ex-staff still active in the portal, or recently-added staff not yet registered with GOSI:
              </p>
              <ul style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {reconciliation.orphaned.map((e) => (
                  <li key={e.id}>
                    {e.name} · {e.id} · {e.department}{e.location ? ` · ${e.location}` : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* Apply bar */}
      {reconciliation && (
        <div
          className="mt-5 pt-4 flex items-center justify-between gap-3 flex-wrap"
          style={{ borderTop: '1px solid #E5E5E5' }}
        >
          <div className="text-[12px]" style={{ color: PALETTE.mute, opacity: 0.7 }}>
            {counts.willApply} of {counts.matched} matches will be applied.
            {counts.willApply !== counts.matched && (
              <> The remaining {counts.matched - counts.willApply} will be skipped.</>
            )}
          </div>
          <button
            onClick={applyDecisions}
            disabled={applying || counts.willApply === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[12px]"
            style={{
              background: counts.willApply === 0 ? '#A3A3A3' : PALETTE.green,
              color: '#FFFFFF',
              border: 'none',
              fontWeight: 700,
              cursor: applying || counts.willApply === 0 ? 'not-allowed' : 'pointer',
              boxShadow: counts.willApply > 0 ? '0 2px 6px rgba(15,76,42,0.18)' : 'none',
            }}
          >
            {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Apply {counts.willApply} {counts.willApply === 1 ? 'match' : 'matches'}
          </button>
        </div>
      )}

      {/* Apply result */}
      {applyResult && (
        <div
          className="mt-3 p-3 rounded-lg text-[12px]"
          style={{
            background: applyResult.failed > 0 ? PALETTE.amberBg : PALETTE.greenBg,
            border: `1px solid ${applyResult.failed > 0 ? '#FCD34D' : '#A7F3D0'}`,
            color: applyResult.failed > 0 ? PALETTE.amber : PALETTE.green,
          }}
        >
          <div className="flex items-start gap-2">
            <CheckCircle2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <div style={{ fontWeight: 700 }}>
                {applyResult.message
                  ? applyResult.message
                  : `${applyResult.ok} ${applyResult.ok === 1 ? 'employee' : 'employees'} updated successfully${applyResult.failed > 0 ? ` · ${applyResult.failed} failed` : ''}.`}
              </div>
              {applyResult.errors?.length > 0 && (
                <ul className="mt-1" style={{ fontWeight: 400, opacity: 0.85 }}>
                  {applyResult.errors.slice(0, 3).map((e, i) => (
                    <li key={i}>{e.employeeId}: {e.message}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────

function CountTile({ label, value, bg, fg, border }) {
  return (
    <div
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        padding: '8px 10px',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 18, fontWeight: 700, color: fg, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: 9, fontWeight: 700, color: fg, opacity: 0.75, letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 3 }}>
        {label}
      </div>
    </div>
  );
}

function MatchRow({ mol, emp, confidence, reason, source, roster, proposedName, alternatives, allEmployees, decision, onChangeAction, onChangeEmployee }) {
  const [expanded, setExpanded] = useState(false);
  const apply = decision.action === 'apply';
  const conf = Math.round(confidence * 100);

  // Confidence color — roster-driven matches always look green
  // (deterministic) regardless of the underlying score.
  const isRoster = source === 'roster_full' || source === 'roster_only';
  const confColor = isRoster              ? '#0F4C2A'
                  : confidence >= 0.95   ? '#0F4C2A'
                  : confidence >= 0.7    ? '#854F0B'
                  : '#991B1B';
  const confBg    = isRoster              ? '#ECFDF5'
                  : confidence >= 0.95   ? '#ECFDF5'
                  : confidence >= 0.7    ? '#FEF3C7'
                  : '#FEE2E2';

  // Source badge label — shown next to the confidence pill so admin
  // can see at a glance whether the row came from Badria's roster
  // (deterministic) or fuzzy MOL matching.
  const sourceBadge = source === 'roster_full' ? 'BADRIA + GOSI'
                    : source === 'roster_only' ? 'BADRIA ONLY'
                    : source === 'fuzzy_mol'   ? 'FUZZY'
                    : null;

  return (
    <div
      style={{
        background: apply ? '#ECFDF5' : '#FFFFFF',
        border: `1px solid ${apply ? '#A7F3D0' : '#E5E5E5'}`,
        borderRadius: 8,
        padding: '8px 10px',
        transition: 'background 0.15s ease, border-color 0.15s ease',
      }}
    >
      <div className="flex items-start gap-3 flex-wrap">
        {/* Apply checkbox */}
        <label
          className="inline-flex items-center gap-1.5 cursor-pointer flex-shrink-0"
          style={{ paddingTop: 2 }}
        >
          <input
            type="checkbox"
            checked={apply}
            onChange={(e) => onChangeAction(e.target.checked ? 'apply' : 'skip')}
            style={{ width: 16, height: 16, accentColor: PALETTE.green, cursor: 'pointer' }}
          />
        </label>

        {/* MOL / Roster source side */}
        <div style={{ flex: '1 1 240px', minWidth: 0 }}>
          {mol.arabic_name ? (
            <div
              style={{
                fontSize: 13,
                color: PALETTE.ink,
                fontWeight: 700,
                fontFamily: 'system-ui',
                direction: 'rtl',
                lineHeight: 1.3,
              }}
            >
              {mol.arabic_name}
            </div>
          ) : (
            // Roster-only — no Arabic name available. Show Badria's
            // Latin name in the same slot so the row isn't blank.
            <div style={{ fontSize: 13, color: PALETTE.ink, fontWeight: 700, lineHeight: 1.3 }}>
              {roster?.name || '—'}
            </div>
          )}
          <div className="text-[11px] mt-0.5 flex items-center gap-2 flex-wrap" style={{ color: PALETTE.mute, opacity: 0.7 }}>
            <span style={{ fontFamily: 'inherit' }}>{mol.national_id}</span>
            {mol.arabic_profession && <span style={{ fontFamily: 'system-ui', direction: 'rtl' }}>· {mol.arabic_profession}</span>}
            {mol.date_of_birth && <span>· DOB {mol.date_of_birth}</span>}
            {roster?.location && <span>· {roster.location}</span>}
            {roster?.department && <span>· {roster.department}</span>}
          </div>
        </div>

        {/* Arrow */}
        <div className="flex-shrink-0 flex items-center" style={{ color: PALETTE.mute, opacity: 0.5, paddingTop: 4 }}>
          →
        </div>

        {/* Portal side — shows what the row will look like after
            apply: the proposed name (canonical from MOL or Badria),
            with the current portal name struck-through if different. */}
        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          {emp ? (
            <>
              <div style={{ fontSize: 13, color: PALETTE.ink, fontWeight: 700, lineHeight: 1.3 }}>
                {proposedName || mol.canonical_name || emp.name}
              </div>
              {(proposedName || mol.canonical_name) && emp.name && (proposedName || mol.canonical_name) !== emp.name && (
                <div className="text-[10.5px] mt-0.5" style={{ color: PALETTE.mute, opacity: 0.55, textDecoration: 'line-through' }}>
                  was: {emp.name}
                </div>
              )}
              <div className="text-[11px] mt-0.5" style={{ color: PALETTE.mute, opacity: 0.7 }}>
                {emp.id} · {emp.department}{emp.location ? ` · ${emp.location}` : ''}
              </div>
            </>
          ) : (
            <div className="text-[12px]" style={{ color: PALETTE.red, fontWeight: 600 }}>
              No portal match — pick one below
            </div>
          )}
        </div>

        {/* Confidence pill + source badge */}
        <div className="flex-shrink-0 flex items-center gap-2 flex-wrap" style={{ paddingTop: 2 }}>
          {sourceBadge && (
            <span
              className="px-1.5 py-0.5 rounded-full text-[9px]"
              style={{
                background: isRoster ? '#0F4C2A' : '#F5F5F5',
                color:      isRoster ? '#FFFFFF' : '#525252',
                fontWeight: 700,
                letterSpacing: '0.06em',
              }}
            >
              {sourceBadge}
            </span>
          )}
          <span
            className="px-2 py-0.5 rounded-full text-[10px]"
            style={{
              background: confBg,
              color: confColor,
              border: `1px solid ${confColor}33`,
              fontWeight: 700,
              letterSpacing: '0.04em',
            }}
            title={reason}
          >
            {conf}%
          </span>
          {(alternatives.length > 0 || !emp) && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="text-[11px]"
              style={{ background: 'none', border: 'none', color: PALETTE.ink, opacity: 0.6, cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit' }}
            >
              {expanded ? 'Hide' : 'Change'}
            </button>
          )}
        </div>
      </div>

      {/* Expanded alternative selector */}
      {expanded && (
        <div className="mt-2 pt-2" style={{ borderTop: '1px dashed #E5E5E5' }}>
          <div className="text-[10px] mb-1.5" style={{ color: PALETTE.ink, fontWeight: 700, letterSpacing: '0.08em' }}>
            ALTERNATIVE PORTAL EMPLOYEES
          </div>
          <select
            value={decision.employeeId || ''}
            onChange={(e) => onChangeEmployee(e.target.value)}
            style={{
              width: '100%',
              padding: '6px 10px',
              border: '1px solid #D4D4D4',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'inherit',
              background: '#FFFFFF',
              color: PALETTE.ink,
              cursor: 'pointer',
            }}
          >
            <option value="">— pick a portal employee —</option>
            {allEmployees
              .map(e => ({
                e,
                // Prefer canonical-vs-portal English comparison; falls
                // back to Arabic-romanized only if canonical is missing.
                // Same priority as the reconcile() function so the
                // dropdown's sort matches the suggested top match.
                score: mol.canonical_name
                  ? englishNameSimilarity(mol.canonical_name, e.name)
                  : nameSimilarity(mol.arabic_name, e.name),
              }))
              .sort((a, b) => b.score - a.score)
              .map(({ e, score }) => (
                <option key={e.id} value={e.id}>
                  {e.name} · {e.id} · {e.department}{score > 0 ? ` · ${Math.round(score * 100)}%` : ''}
                </option>
              ))}
          </select>
        </div>
      )}
    </div>
  );
}
