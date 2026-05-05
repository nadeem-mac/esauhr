// =============================================================================
// MigrationsPanel.jsx
//
// Admin-only Settings card that lists every bundled migration with
// its current status and lets the admin run pending or
// changed-since-last-run migrations with one click.
//
// States per migration row:
//   never_run — has never been applied to this database
//   success   — applied successfully and the bundled SQL still matches
//   changed   — applied successfully but the bundled SQL has been
//               edited since (sha mismatch); admin may re-run
//   failed    — last attempt failed; admin can retry after fixing
//
// Each row shows: name, status pill, byte size, last run timestamp +
// who ran it, and a Run button (or Re-run for already-applied ones).
//
// Clicking Run calls the migrationRunner library, which invokes the
// run_schema_migration RPC. The result lands as a toast-style row
// banner on the card so the admin sees confirmation immediately.
// =============================================================================

import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Play, RotateCw, CheckCircle2, AlertTriangle, Database, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { Card } from './Dashboard.jsx';
import { listMigrationsWithStatus, runMigration, sqlByteSize } from '../lib/migrationRunner.js';

export default function MigrationsPanel({ me, onChanged }) {
  const [items, setItems]               = useState([]);
  const [installed, setInstalled]       = useState(true);
  const [loading, setLoading]           = useState(true);
  const [loadError, setLoadError]       = useState('');
  const [runningName, setRunningName]   = useState(null);
  const [recentResult, setRecentResult] = useState(null);  // {name, ok, error_message, duration_ms}
  const [expandedName, setExpandedName] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const { items, installed } = await listMigrationsWithStatus();
      setItems(items);
      setInstalled(installed);
      // Notify the parent so the Settings tab badge + sidebar badge
      // update without a page reload. Wrapped in try so a parent
      // that hasn't passed a handler doesn't error.
      try { onChanged?.(); } catch { /* ignore */ }
    } catch (err) {
      setLoadError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [onChanged]);

  useEffect(() => { refresh(); }, [refresh]);

  const onRun = useCallback(async (item) => {
    if (runningName) return;
    setRunningName(item.name);
    setRecentResult(null);
    try {
      const result = await runMigration({
        name: item.name,
        sql: item.sql,
        callerPsn: me?.id,
      });
      setRecentResult(result);
      // Re-fetch so the row's status updates without a full reload.
      await refresh();
    } catch (err) {
      setRecentResult({
        ok: false,
        status: 'client_error',
        error_message: err?.message || String(err),
        name: item.name,
      });
    } finally {
      setRunningName(null);
    }
  }, [runningName, me, refresh]);

  const summary = countByStatus(items);

  return (
    <Card
      title={<span className="inline-flex items-center gap-2"><Database className="w-4 h-4 opacity-70"/> Schema migrations</span>}
      subtitle={summary.never_run > 0
        ? `${summary.never_run} pending — apply to keep the database in sync with the codebase`
        : summary.failed > 0
          ? `${summary.failed} failed — retry after fixing`
          : summary.changed > 0
            ? `${summary.changed} changed since last run`
            : 'All bundled migrations are applied and up to date'}
    >
      {!installed && !loading && (
        <SetupPrompt items={items} me={me} onAfterRun={refresh} />
      )}

      {loadError && (
        <div className="rounded-lg p-3 text-[12px] mb-3"
          style={{ background: '#FEE2E2', color: '#991B1B', border: '1px solid #FCA5A5' }}>
          Failed to load migration history: {loadError}
        </div>
      )}

      {recentResult && (
        <div className="rounded-lg p-3 text-[12px] mb-3"
          style={{
            background: recentResult.ok ? '#ECFDF5' : '#FEE2E2',
            color: recentResult.ok ? '#065F46' : '#991B1B',
            border: '1px solid ' + (recentResult.ok ? '#A7F3D0' : '#FCA5A5'),
          }}>
          {recentResult.ok ? (
            <>
              <CheckCircle2 className="w-4 h-4 inline-block mr-1.5 align-text-bottom"/>
              <strong>{recentResult.name}</strong> applied successfully in {recentResult.duration_ms}ms.
            </>
          ) : (
            <>
              <AlertTriangle className="w-4 h-4 inline-block mr-1.5 align-text-bottom"/>
              <strong>{recentResult.name}</strong> failed: {recentResult.error_message}
            </>
          )}
        </div>
      )}

      {loading ? (
        <div className="text-center py-6 text-sm opacity-60">
          <Loader2 className="w-4 h-4 inline-block mr-2 animate-spin"/>
          Loading migration status…
        </div>
      ) : items.length === 0 ? (
        <div className="text-center py-6 text-sm opacity-60">
          No migration files bundled in this build.
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((m) => (
            <MigrationRow
              key={m.name}
              item={m}
              expanded={expandedName === m.name}
              onToggleExpand={() => setExpandedName(expandedName === m.name ? null : m.name)}
              running={runningName === m.name}
              disabled={runningName != null && runningName !== m.name}
              onRun={() => onRun(m)}
            />
          ))}
        </ul>
      )}

      <div className="mt-4 pt-3 text-[10px] italic" style={{ borderTop: '1px dashed var(--border-soft, #E8DEC4)', color: '#0A0A0A', opacity: 0.6 }}>
        Migrations run inside a server-side function with elevated privileges; only admins can invoke it.
        Each run is logged with your PSN, the SQL hash, duration, and outcome to <code>schema_migrations</code>.
      </div>
    </Card>
  );
}

// ─── SetupPrompt — shown when schema_migrations table doesn't exist ─────────
//
// First-time setup: the runner itself needs to be installed before
// it can manage other migrations. We special-case the
// migration_schema_runner.sql file so the admin can paste it once
// in Supabase's SQL editor; thereafter every other migration is
// one-click from this panel.
function SetupPrompt({ items, me, onAfterRun }) {
  const setupItem = items.find((i) => i.name === 'migration_schema_runner.sql');
  const [copied, setCopied] = useState(false);

  if (!setupItem) {
    return (
      <div className="rounded-lg p-3 text-[12px] mb-3"
        style={{ background: '#FEF3C7', color: '#92400E', border: '1px solid #FCD34D' }}>
        <strong>Migration runner not installed.</strong> The bootstrap migration
        <code className="px-1 rounded mx-1" style={{ background: '#FFFFFF' }}>migration_schema_runner.sql</code>
        is missing from this build. Re-deploy and try again.
      </div>
    );
  }

  const onCopy = () => {
    navigator.clipboard.writeText(setupItem.sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="rounded-lg p-4 mb-3"
      style={{ background: '#FFFBEB', border: '1px solid #FCD34D' }}>
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="w-4 h-4" style={{ color: '#B45309' }}/>
        <div className="text-xs tracking-widest font-bold" style={{ color: '#B45309' }}>
          ONE-TIME SETUP REQUIRED
        </div>
      </div>
      <p className="text-[12px] mb-3" style={{ color: '#0A0A0A' }}>
        The migration runner needs its own SQL infrastructure (a tracking table and an RPC function) before it can manage other migrations.
        Run <code style={{ background: '#FFFFFF', padding: '1px 4px', borderRadius: 3 }}>migration_schema_runner.sql</code> once in
        the Supabase SQL editor. After that, every future migration is one-click from this panel.
      </p>
      <div className="flex gap-2 flex-wrap">
        <button onClick={onCopy}
          className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full"
          style={{ background: '#0F4C2A', color: '#FFFFFF', fontWeight: 600 }}>
          <Copy className="w-3 h-3"/> {copied ? 'Copied!' : 'Copy SQL to clipboard'}
        </button>
        <a href="https://supabase.com/dashboard/project/_/sql/new" target="_blank" rel="noopener noreferrer"
          className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border"
          style={{ borderColor: '#B45309', color: '#B45309', background: '#FFFFFF', fontWeight: 600 }}>
          Open Supabase SQL editor →
        </a>
        <button onClick={onAfterRun}
          className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border"
          style={{ borderColor: 'var(--border-soft)', color: '#0A0A0A', background: '#FFFFFF' }}>
          <RotateCw className="w-3 h-3"/> I've run it — refresh
        </button>
      </div>
    </div>
  );
}

// ─── MigrationRow ────────────────────────────────────────────────────────────
function MigrationRow({ item, expanded, onToggleExpand, running, disabled, onRun }) {
  const { color, label, bg, border } = statusVisuals(item.status);

  return (
    <li className="rounded-xl"
        style={{ border: `1px solid ${border}`, background: '#FFFFFF' }}>
      <div className="flex items-center gap-2 px-3 py-2.5 flex-wrap">
        <button
          onClick={onToggleExpand}
          className="opacity-60 hover:opacity-100"
          aria-label={expanded ? 'Collapse SQL' : 'Show SQL'}>
          {expanded ? <ChevronDown className="w-3.5 h-3.5"/> : <ChevronRight className="w-3.5 h-3.5"/>}
        </button>

        <code className="text-[12px] font-mono flex-1 min-w-[200px]" style={{ color: '#0A0A0A' }}>
          {item.name}
        </code>

        <span className="text-[10px] opacity-60 font-mono whitespace-nowrap">
          {prettyBytes(sqlByteSize(item.sql))}
        </span>

        <span className="text-[10px] tracking-wider font-bold px-2 py-0.5 rounded-full"
          style={{ background: bg, color, letterSpacing: '0.06em' }}>
          {label}
        </span>

        <button
          onClick={onRun}
          disabled={disabled || running}
          className="text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full"
          style={{
            background: item.status === 'success' ? '#FFFFFF' : '#0F4C2A',
            color: item.status === 'success' ? '#0A0A0A' : '#FFFFFF',
            border: item.status === 'success' ? '1px solid var(--border-soft)' : 'none',
            cursor: (disabled || running) ? 'not-allowed' : 'pointer',
            opacity: (disabled || running) ? 0.6 : 1,
            fontWeight: 600,
          }}>
          {running
            ? <><Loader2 className="w-3 h-3 animate-spin"/> Running…</>
            : item.status === 'success' || item.status === 'changed'
              ? <><RotateCw className="w-3 h-3"/> Re-run</>
              : <><Play className="w-3 h-3"/> Run</>}
        </button>
      </div>

      {(item.lastRun || item.lastError) && (
        <div className="px-9 pb-2 text-[10px]" style={{ color: '#0A0A0A', opacity: 0.7 }}>
          {item.lastRun && (
            <span>
              Last run: {new Date(item.lastRun).toLocaleString('en-GB', {
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit',
              })}
              {item.lastBy ? ` by ${item.lastBy}` : ''}
              {item.durationMs != null ? ` · ${item.durationMs}ms` : ''}
            </span>
          )}
          {item.lastError && (
            <div className="mt-1 px-2 py-1 rounded font-mono text-[10px]"
              style={{ background: '#FEE2E2', color: '#991B1B', wordBreak: 'break-word' }}>
              {item.lastError}
            </div>
          )}
        </div>
      )}

      {expanded && (
        <div className="px-9 pb-3">
          <pre className="text-[10px] font-mono p-3 rounded-lg overflow-x-auto"
            style={{
              background: '#1F1B16',
              color: '#F4EFDC',
              maxHeight: 320,
              overflowY: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
            {item.sql}
          </pre>
        </div>
      )}
    </li>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function statusVisuals(status) {
  switch (status) {
    case 'never_run':
      return { label: 'PENDING',  color: '#B45309', bg: '#FEF3C7', border: '#FCD34D' };
    case 'success':
      return { label: 'APPLIED',  color: '#065F46', bg: '#D1FAE5', border: '#86EFAC' };
    case 'changed':
      return { label: 'CHANGED',  color: '#A16207', bg: '#FEF9C3', border: '#FDE68A' };
    case 'failed':
      return { label: 'FAILED',   color: '#991B1B', bg: '#FEE2E2', border: '#FCA5A5' };
    default:
      return { label: 'UNKNOWN',  color: '#374151', bg: '#F3F4F6', border: '#D1D5DB' };
  }
}

function countByStatus(items) {
  const counts = { never_run: 0, success: 0, changed: 0, failed: 0 };
  for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1;
  return counts;
}

function prettyBytes(n) {
  if (n < 1024) return n + 'B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1024 / 1024).toFixed(1) + 'MB';
}
