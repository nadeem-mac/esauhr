import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { X, Download, LayoutGrid, Users2, Building2, ZoomIn, ZoomOut, Printer, Maximize2 } from 'lucide-react';

// =============================================================================
// OrgChartView — rev. 3
//
// Per Nadeem 2026-05-09 (third pass):
//   • Tree should fit on a single screen page vertically (horizontal
//     scroll OK for wide trees, no vertical scroll inside the modal).
//   • Tree should print on a single A4 landscape page, shrunk to fit.
//   • John Ho is a synthetic CEO node — not in the employees table.
//   • All Riyadh staff (location='RUH') report to Zaher Abu Hosa
//     (H94432) regardless of their stored manager_id.
//   • Title taxonomy: CEO (John), DJVP (Sharique H94460,
//     Sadakathullah H94076), AM (Nadeem H94152, Zaher H94432),
//     M (anyone else with direct reports), S (leaf nodes).
//   • Nadeem renders as a normal AM under Sadakathullah — no admin
//     accent on his card.
//
// Implementation summary:
//   • buildTree() now synthesises the CEO root, repoints all
//     Riyadh-located staff (except Zaher himself) at Zaher,
//     repoints orphans/cycles at the CEO, and runs the same
//     deterministic alphabetical sort within each parent.
//   • titleFor() resolves the role abbreviation per the table
//     above; PSN-specific overrides win over the heuristic.
//   • Card styling drops the prior 'admin-distinct accent' for
//     Nadeem since he's now an ordinary AM in the chart.
//   • Fit-to-screen via JS-measured height ratio applied as a
//     CSS transform; recomputes on resize and on tree change.
//   • Print path uses beforeprint/afterprint listeners to set
//     a CSS variable --print-scale, applied via @media print
//     transform: scale(...). @page is A4 landscape with 8mm
//     margins; toolbar/chrome hidden for print.
// =============================================================================

const SYNTHETIC_CEO_ID = '__ceo_node__';
const ZAHER_PSN        = 'H94432';

// PSN-specific title overrides. Anything not in this map falls
// through to the role-from-tree heuristic in titleFor().
const TITLE_OVERRIDES = {
  [SYNTHETIC_CEO_ID]: 'CEO',
  'H94460': 'DJVP', // Sharique
  'H94076': 'DJVP', // Sadakathullah
  'H94152': 'AM',   // Nadeem
  'H94432': 'AM',   // Zaher
};

// Long-form labels for the title abbreviations. Surfaced in the
// tooltip on hover so the chart is self-explanatory even when
// printed and given to someone unfamiliar with the abbreviations.
const TITLE_LONG = {
  CEO:  'Chief Executive Officer',
  DJVP: 'Deputy Junior Vice President',
  AM:   'Assistant Manager',
  M:    'Manager',
  S:    'Staff',
};

const DEPT_LABEL = {
  MGT: 'Management',
  SUP: 'Supervisory',
  BIZ: 'Business',
  LOG: 'Logistics',
  OPS: 'Operations',
  CSD: 'Customer Service',
  FIN: 'Finance',
  HR:  'Human Resources',
};
const LOC_LABEL = {
  DAM: 'Dammam',
  JED: 'Jeddah',
  RUH: 'Riyadh',
};

function initialsOf(name, psn) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  if (parts.length === 1 && parts[0].length >= 2) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return String(psn || '??').slice(-2).toUpperCase();
}

// Synthesise the CEO node, repoint Riyadh staff at Zaher, and tag
// orphans/cycles for repointing at the CEO. Returns a flat array
// the buildTree pass can index by id.
function preprocessEmployees(rawEmployees) {
  const ceo = {
    id: SYNTHETIC_CEO_ID,
    name: 'JOHN HO',
    secondaryName: 'Chung Hsing Ho',
    department: 'MGT',
    location: 'DAM',
    manager_id: null,
    isSynthetic: true,
  };

  const out = [ceo];
  for (const e of (rawEmployees || [])) {
    if (!e?.id) continue;
    if (e.id === SYNTHETIC_CEO_ID) continue; // Defensive — never happens in practice
    // Riyadh override — anyone in RUH (except Zaher himself) reports
    // to Zaher in the chart, regardless of their stored manager_id.
    // This implements Nadeem's directive that Zaher coordinates the
    // Riyadh branch even though he's also tagged as AM in the title
    // taxonomy. Zaher's own manager_id stays as-is (he reports to
    // Sadakathullah).
    if (e.location === 'RUH' && e.id !== ZAHER_PSN) {
      out.push({ ...e, manager_id: ZAHER_PSN });
    } else {
      out.push({ ...e });
    }
  }
  return out;
}

// Build the tree. Roots collapse to a single virtual CEO node.
// Cycles and orphans are repointed at the CEO so the chart never
// shows dangling subtrees outside the main hierarchy.
function buildTree(rawEmployees) {
  const augmented = preprocessEmployees(rawEmployees);
  const byId = new Map();
  for (const emp of augmented) {
    byId.set(emp.id, { ...emp, children: [] });
  }
  const ceo = byId.get(SYNTHETIC_CEO_ID);

  for (const node of byId.values()) {
    if (node.id === SYNTHETIC_CEO_ID) continue;

    let mgrId = node.manager_id;

    // Orphan — no manager or manager not in our employee set →
    // attach to CEO. Covers freshly hired staff before
    // manager_id is set, deleted-manager cases, and any other
    // dangling reference.
    if (!mgrId || !byId.has(mgrId)) {
      mgrId = SYNTHETIC_CEO_ID;
    } else {
      // Cycle guard — walk up at most 10 hops; if we loop back
      // to ourselves, repoint at the CEO. Defends against the
      // known Sharique↔Sadakathullah circular reference and any
      // future bad data.
      let cursor = byId.get(mgrId);
      let cyclic = false;
      let hops = 0;
      while (cursor && hops < 10) {
        if (cursor.id === node.id) { cyclic = true; break; }
        if (cursor.id === SYNTHETIC_CEO_ID) break;
        cursor = cursor.manager_id ? byId.get(cursor.manager_id) : null;
        hops++;
      }
      if (cyclic) mgrId = SYNTHETIC_CEO_ID;
    }

    byId.get(mgrId).children.push(node);
  }

  // Alphabetical sort within each parent for deterministic render.
  const sortRecursive = (nodes) => {
    nodes.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    nodes.forEach(n => sortRecursive(n.children));
  };
  sortRecursive([ceo]);
  return [ceo];
}

// Compute the default collapsed set for "Summary" preset. Collapses
// every node at depth >= 2 that has children, so the visible tree is
// CEO + DJVPs + their direct reports — anything deeper is one click
// away. The returned Set is consumed by OrgChartView's collapsedIds
// state.
function computeSummaryCollapsed(roots) {
  const ids = new Set();
  const walk = (nodes, depth) => {
    nodes.forEach(n => {
      if (depth >= 2 && (n.children || []).length > 0) {
        ids.add(n.id);
      }
      walk(n.children || [], depth + 1);
    });
  };
  walk(roots, 0);
  return ids;
}

// Compute the "Collapse all" set — same as Summary but applied at
// depth >= 1, so only the CEO and his direct DJVPs/peers are
// visible. Used by the future Collapse-all toolbar button if added.
// Currently unused; preserved here as the Summary collapser depth
// doesn't reach this aggressive a state.
// eslint-disable-next-line no-unused-vars
function computeMaximalCollapsed(roots) {
  const ids = new Set();
  const walk = (nodes, depth) => {
    nodes.forEach(n => {
      if (depth >= 1 && (n.children || []).length > 0) {
        ids.add(n.id);
      }
      walk(n.children || [], depth + 1);
    });
  };
  walk(roots, 0);
  return ids;
}

function countDescendants(node) {
  let n = 0;
  const walk = (kids) => {
    for (const k of (kids || [])) {
      n++;
      walk(k.children);
    }
  };
  walk(node.children);
  return n;
}

// Resolve the role abbreviation for a given node. PSN overrides
// always win; otherwise tier 0 is CEO, leaf nodes are S, and
// anyone with at least one direct (or clipped) report is M.
function titleFor(node, tier) {
  if (TITLE_OVERRIDES[node.id]) return TITLE_OVERRIDES[node.id];
  if (tier === 0) return 'CEO';
  const reportCount = (node.children || []).length + (node._clippedCount || 0);
  if (reportCount > 0) return 'M';
  return 'S';
}

// Tier-aware visual styling. CEO and DJVPs get the most prominent
// borders/shadows. The HR-reviewer accent (Bashaier) and admin
// accent (Nadeem) are dropped per Nadeem's instruction — both
// render as ordinary tier nodes now.
function styleFor(node, tier) {
  const title = titleFor(node, tier);

  if (tier === 0 || title === 'CEO') {
    return {
      borderColor: '#2D5F3F',
      borderWidth: 2,
      avatarBg: 'linear-gradient(135deg, #2D5F3F 0%, #1F4429 100%)',
      avatarRing: 'rgba(45, 95, 63, 0.18)',
      tagBg: 'rgba(45, 95, 63, 0.10)',
      tagColor: '#1F4429',
      cardBg: 'linear-gradient(180deg, #FFFFFF 0%, #F0F8F0 100%)',
      shadow: '0 12px 32px rgba(45, 95, 63, 0.18), 0 2px 6px rgba(31, 27, 22, 0.08)',
    };
  }
  if (title === 'DJVP') {
    return {
      borderColor: '#8B5A1F',
      borderWidth: 2,
      avatarBg: 'linear-gradient(135deg, #B07840 0%, #8B5A1F 100%)',
      avatarRing: 'rgba(139, 90, 31, 0.18)',
      tagBg: 'rgba(139, 90, 31, 0.12)',
      tagColor: '#5A3A14',
      cardBg: 'linear-gradient(180deg, #FFFFFF 0%, #FFF7EC 100%)',
      shadow: '0 8px 24px rgba(139, 90, 31, 0.14), 0 2px 4px rgba(31, 27, 22, 0.06)',
    };
  }
  if (title === 'AM') {
    return {
      borderColor: '#A87543',
      borderWidth: 1.5,
      avatarBg: 'linear-gradient(135deg, #B17D45 0%, #8B5A1F 100%)',
      avatarRing: 'rgba(168, 117, 67, 0.16)',
      tagBg: 'rgba(168, 117, 67, 0.12)',
      tagColor: '#7A4F1F',
      cardBg: '#FFFFFF',
      shadow: '0 5px 14px rgba(168, 117, 67, 0.14), 0 1px 3px rgba(31, 27, 22, 0.05)',
    };
  }
  if (title === 'M') {
    return {
      borderColor: '#C49B61',
      borderWidth: 1.5,
      avatarBg: 'linear-gradient(135deg, #B17D45 0%, #8B5A1F 100%)',
      avatarRing: 'rgba(196, 155, 97, 0.18)',
      tagBg: 'rgba(196, 155, 97, 0.14)',
      tagColor: '#8B5A1F',
      cardBg: '#FFFFFF',
      shadow: '0 4px 12px rgba(196, 155, 97, 0.16), 0 1px 3px rgba(31, 27, 22, 0.05)',
    };
  }
  // 'S' — staff
  return {
    borderColor: '#D4D0C7',
    borderWidth: 1.5,
    avatarBg: 'linear-gradient(135deg, #8A8680 0%, #6B6660 100%)',
    avatarRing: 'rgba(107, 102, 96, 0.14)',
    tagBg: 'rgba(107, 102, 96, 0.10)',
    tagColor: '#4B463F',
    cardBg: '#FFFFFF',
    shadow: '0 3px 10px rgba(31, 27, 22, 0.06), 0 1px 2px rgba(31, 27, 22, 0.04)',
  };
}

// Role chip text. The new format (per Nadeem) appends the title
// abbreviation after dept · loc: 'BIZ · DAM · DJVP'. CEO node
// gets 'MGT · CEO' since location is irrelevant for him.
function roleLabel(node, tier) {
  const title = titleFor(node, tier);
  if (tier === 0 || title === 'CEO') return `MGT · ${title}`;
  const d = node.department || '—';
  const l = node.location || '—';
  return `${d} · ${l} · ${title}`;
}

// =============================================================================
// Tree CSS — connector geometry plus print/screen layout rules.
// Both the live React path and the standalone HTML export include
// this block so they render identically in any context.
// =============================================================================
const TREE_CSS = `
.esau-tree-wrap {
  display: inline-block;
  padding: 16px 32px 24px;
  text-align: center;
  font-family: 'Anthropic Sans', -apple-system, 'Segoe UI', sans-serif;
}
.esau-tree-wrap ul {
  position: relative;
  padding: 24px 0 0 0;
  margin: 0;
  list-style: none;
  display: inline-flex;
  justify-content: center;
}
.esau-tree-wrap ul::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  border-left: 1.5px solid #C49B61;
  height: 12px;
  opacity: 0.55;
}
.esau-tree-wrap li {
  position: relative;
  padding: 12px 10px 0 10px;
  text-align: center;
}
.esau-tree-wrap li::before,
.esau-tree-wrap li::after {
  content: '';
  position: absolute;
  top: 0;
  border-top: 1.5px solid #C49B61;
  width: 50%;
  height: 12px;
  opacity: 0.55;
}
.esau-tree-wrap li::before { right: 50%; }
.esau-tree-wrap li::after  { left: 50%; }
.esau-tree-wrap li:only-child::before,
.esau-tree-wrap li:only-child::after { display: none; }
.esau-tree-wrap li:first-child::before,
.esau-tree-wrap li:last-child::after { border: 0 none; }
.esau-tree-wrap li:first-child::after  { border-radius: 6px 0 0 0; border-left: 1.5px solid #C49B61; }
.esau-tree-wrap li:last-child::before  { border-radius: 0 6px 0 0; border-right: 1.5px solid #C49B61; }
.esau-tree-wrap > ul::before { display: none; }
.esau-tree-wrap > ul > li { padding-top: 0; }
.esau-tree-wrap > ul > li::before,
.esau-tree-wrap > ul > li::after { display: none; }
.esau-tree-wrap .esau-card {
  transition: transform 140ms ease-out, box-shadow 140ms ease-out;
}
.esau-tree-wrap .esau-card:hover {
  transform: translateY(-2px);
}

/* === Print rules ===
   A4 landscape, 8mm margins. The tree is wrapped in
   .esau-org-print-target which becomes the only thing visible
   when printing. Scale is set by JS via --print-scale calculated
   from the actual chart dimensions vs the printable area, applied
   here via transform. transform-origin: top left is critical so
   the scaled tree starts at the page corner instead of getting
   clipped on the right.
*/
@page {
  size: A4 landscape;
  margin: 8mm;
}
@media print {
  body * { visibility: hidden !important; }
  .esau-org-print-target,
  .esau-org-print-target * { visibility: visible !important; }
  .esau-org-print-target {
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    width: auto !important;
    height: auto !important;
    background: #FFFFFF !important;
    box-shadow: none !important;
    transform: scale(var(--print-scale, 1));
    transform-origin: top left;
  }
  .esau-tree-wrap .esau-card { transition: none !important; }
  .esau-tree-wrap .esau-card:hover { transform: none !important; }
  .esau-org-no-print { display: none !important; }
}
`;

// =============================================================================
// NodeCard — single visible block. tooltip exposes the long-form
// title so anyone unfamiliar with the abbreviations gets the
// expansion on hover (and on a printed sheet, by reference if
// they have access to the legend in the toolbar).
// =============================================================================
function NodeCard({ node, tier, isCollapsed, onToggle }) {
  const s = styleFor(node, tier);
  const initials = initialsOf(node.name, node.id);
  const title = titleFor(node, tier);
  const titleLong = TITLE_LONG[title] || title;
  const role = roleLabel(node, tier);
  const directReports = (node.children || []).length;
  const totalReports = directReports + countDescendants(node);
  const deptFull = DEPT_LABEL[node.department] || node.department || '';
  const locFull = LOC_LABEL[node.location] || node.location || '';
  const isCeo = tier === 0;
  const isDjvp = title === 'DJVP';
  const isSynth = !!node.isSynthetic;
  const hasChildren = directReports > 0;
  const tooltip = `${node.name}${node.secondaryName ? ' (' + node.secondaryName + ')' : ''}\n${titleLong}${deptFull ? '\n' + deptFull : ''}${locFull ? ' · ' + locFull : ''}${isSynth ? '' : '\n' + node.id}`;

  return (
    <div
      className="esau-card"
      title={tooltip}
      style={{
        background: s.cardBg,
        border: `${s.borderWidth}px solid ${s.borderColor}`,
        borderRadius: 14,
        padding: isCeo ? '16px 16px' : isDjvp ? '14px 14px' : '12px 12px',
        minWidth: isCeo ? 220 : isDjvp ? 196 : tier >= 3 ? 164 : 178,
        maxWidth: isCeo ? 260 : 216,
        boxShadow: s.shadow,
        textAlign: 'left',
        cursor: 'default',
        display: 'inline-block',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 7 }}>
        <div
          style={{
            width: isCeo ? 42 : isDjvp ? 38 : 34,
            height: isCeo ? 42 : isDjvp ? 38 : 34,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: isCeo ? 13 : isDjvp ? 12 : 11,
            fontWeight: 600,
            letterSpacing: '0.04em',
            color: '#FFFFFF',
            background: s.avatarBg,
            boxShadow: `0 0 0 3px ${s.avatarRing}`,
            flexShrink: 0,
          }}
        >
          {initials}
        </div>
        <div style={{ minWidth: 0 }}>
          <span
            style={{
              fontSize: 8.5,
              letterSpacing: '0.18em',
              fontWeight: 600,
              padding: '2.5px 8px',
              borderRadius: 999,
              display: 'inline-block',
              background: s.tagBg,
              color: s.tagColor,
              textTransform: 'uppercase',
            }}
          >
            {role}
          </span>
        </div>
      </div>
      <div
        style={{
          fontSize: isCeo ? 14 : isDjvp ? 13 : 12,
          fontWeight: 600,
          color: '#1F1B16',
          lineHeight: 1.25,
          letterSpacing: '-0.005em',
        }}
      >
        {node.name}
      </div>
      {node.secondaryName && (
        <div style={{ fontSize: 10.5, color: '#6B6660', fontStyle: 'italic', marginTop: 1 }}>
          {node.secondaryName}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
        {!isSynth && (
          <span
            style={{
              fontSize: 10,
              color: '#6B6660',
              fontFamily: '"SF Mono", Consolas, monospace',
              letterSpacing: '0.02em',
            }}
          >
            {node.id}
          </span>
        )}
        {/* Toggle button — replaces the static '↓ N' chip when the
            node has children. Click to expand/collapse the subtree
            (Option A from the redesign meeting). When collapsed, the
            label flips to '+ N' and the tooltip cues the user. The
            stopPropagation guards against the parent card's hover/
            click logic firing when the user actually wanted just the
            toggle. */}
        {hasChildren && onToggle && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(node.id);
            }}
            title={isCollapsed
              ? `Expand — ${directReports} direct${totalReports > directReports ? ` (${totalReports} total below)` : ''}`
              : `Collapse — ${directReports} direct${totalReports > directReports ? ` (${totalReports} total below)` : ''}`}
            style={{
              fontSize: 10,
              color: s.tagColor,
              fontWeight: 700,
              padding: '2px 8px',
              borderRadius: 999,
              background: isCollapsed ? s.tagBg : 'transparent',
              border: isCollapsed ? `1px solid ${s.tagColor}33` : `1px solid ${s.tagColor}33`,
              letterSpacing: '0.04em',
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              lineHeight: 1.2,
              transition: 'background 120ms, border-color 120ms',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = s.tagBg; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = isCollapsed ? s.tagBg : 'transparent'; }}
          >
            <span style={{ fontSize: 12, fontWeight: 700, lineHeight: 1, marginTop: -1 }}>
              {isCollapsed ? '+' : '−'}
            </span>
            {' '}{isCollapsed ? totalReports : directReports}
          </button>
        )}
        {/* Static descriptor when no children — keeps card heights
            roughly aligned across siblings without faking a button. */}
        {!hasChildren && totalReports === 0 && tier > 0 && (
          <span style={{ fontSize: 9, color: '#9B928A', fontStyle: 'italic', letterSpacing: '0.04em' }}>
            individual contributor
          </span>
        )}
      </div>
    </div>
  );
}

function TreeNode({ node, tier, collapsedIds, onToggle }) {
  const isCollapsed = collapsedIds && collapsedIds.has(node.id);
  return (
    <li>
      <NodeCard
        node={node}
        tier={tier}
        isCollapsed={isCollapsed}
        onToggle={onToggle}
      />
      {!isCollapsed && node.children && node.children.length > 0 && (
        <ul>
          {node.children.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              tier={tier + 1}
              collapsedIds={collapsedIds}
              onToggle={onToggle}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

// =============================================================================
// ChartBody — wraps the tree with the centred header & footer.
// Used by both the live modal and the standalone HTML export.
// =============================================================================
function ChartBody({ roots, collapsedIds, onToggle, totalEmployees, treeRef, viewLabel }) {
  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  return (
    <div style={{ background: '#FFFBF1', borderRadius: 16, paddingBottom: 8 }}>
      <style>{TREE_CSS}</style>
      <div style={{ textAlign: 'center', padding: '18px 24px 4px' }}>
        <div style={{ fontSize: 10, letterSpacing: '0.28em', color: '#2D5F3F', fontWeight: 600 }}>
          EVERGREEN SHIPPING AGENCY SAUDI CO. (LLC)
        </div>
        <div style={{ fontSize: 22, color: '#1F1B16', fontWeight: 500, marginTop: 6, letterSpacing: '-0.01em', fontFamily: 'Georgia, serif' }}>
          Organization Chart
        </div>
        <div style={{ fontSize: 11, color: '#6B6660', marginTop: 4 }}>
          As of {today}{' · '}{totalEmployees} employee{totalEmployees === 1 ? '' : 's'}
          {viewLabel ? ' · ' + viewLabel : ''}
        </div>
      </div>

      <div ref={treeRef} className="esau-tree-wrap">
        <ul>
          {roots.map(root => (
            <TreeNode
              key={root.id}
              node={root}
              tier={0}
              collapsedIds={collapsedIds}
              onToggle={onToggle}
            />
          ))}
        </ul>
      </div>

      <div
        style={{
          textAlign: 'center',
          margin: '4px 24px 0',
          padding: '10px 0 6px',
          borderTop: '1px solid #F0EBDF',
          fontSize: 9,
          color: '#9B928A',
          letterSpacing: '0.18em',
          fontWeight: 600,
        }}
      >
        CEO · DJVP · M (MANAGER) · AM (ASSISTANT MANAGER) · S (STAFF)
        {' · '}GENERATED FROM EVERGREEN HR PORTAL · esauhr.netlify.app
      </div>
    </div>
  );
}

// =============================================================================
// Standalone HTML export
// =============================================================================
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderTreeHtml(nodes, tier, collapsedIds) {
  return `<ul>${nodes.map(node => {
    const s = styleFor(node, tier);
    const initials = initialsOf(node.name, node.id);
    const title = titleFor(node, tier);
    const role = roleLabel(node, tier);
    const directReports = (node.children || []).length;
    const totalReports = directReports + countDescendants(node);
    const isCeo = tier === 0;
    const isDjvp = title === 'DJVP';
    const isSynth = !!node.isSynthetic;
    const isCollapsed = !!(collapsedIds && collapsedIds.has(node.id));

    const cardStyle = [
      `background:${s.cardBg}`,
      `border:${s.borderWidth}px solid ${s.borderColor}`,
      `border-radius:14px`,
      `padding:${isCeo ? '16px 16px' : isDjvp ? '14px 14px' : '12px 12px'}`,
      `min-width:${isCeo ? 220 : isDjvp ? 196 : tier >= 3 ? 164 : 178}px`,
      `max-width:${isCeo ? 260 : 216}px`,
      `box-shadow:${s.shadow}`,
      `text-align:left`,
      `display:inline-block`,
    ].join(';');

    const avatarSize = isCeo ? 42 : isDjvp ? 38 : 34;
    const avatarFontSize = isCeo ? 13 : isDjvp ? 12 : 11;
    const nameFontSize = isCeo ? 14 : isDjvp ? 13 : 12;
    const reportLabel = directReports > 0
      ? `<span style="font-size:10px;color:${s.tagColor};font-weight:700;padding:2px 8px;border-radius:999px;background:${s.tagBg};letter-spacing:0.04em;border:1px solid ${s.tagColor}33;">${isCollapsed ? '+' : '−'} ${isCollapsed ? totalReports : directReports}</span>`
      : '';

    const cardHtml = `
      <div class="esau-card" style="${cardStyle}">
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:7px;">
          <div style="width:${avatarSize}px;height:${avatarSize}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:${avatarFontSize}px;font-weight:600;letter-spacing:0.04em;color:#FFFFFF;background:${s.avatarBg};box-shadow:0 0 0 3px ${s.avatarRing};flex-shrink:0;">${escapeHtml(initials)}</div>
          <div><span style="font-size:8.5px;letter-spacing:0.18em;font-weight:600;padding:2.5px 8px;border-radius:999px;display:inline-block;background:${s.tagBg};color:${s.tagColor};text-transform:uppercase;">${escapeHtml(role)}</span></div>
        </div>
        <div style="font-size:${nameFontSize}px;font-weight:600;color:#1F1B16;line-height:1.25;letter-spacing:-0.005em;">${escapeHtml(node.name || '')}</div>
        ${node.secondaryName ? `<div style="font-size:10.5px;color:#6B6660;font-style:italic;margin-top:1px;">${escapeHtml(node.secondaryName)}</div>` : ''}
        <div style="display:flex;align-items:center;gap:6px;margin-top:3px;flex-wrap:wrap;">
          ${!isSynth ? `<span style="font-size:10px;color:#6B6660;font-family:'SF Mono',Consolas,monospace;letter-spacing:0.02em;">${escapeHtml(node.id || '')}</span>` : ''}
          ${reportLabel}
        </div>
      </div>
    `;
    // Hide children entirely when collapsed — same behaviour as the
    // live React path. The user's expanded snapshot is what gets
    // exported; recipients see exactly what the user prepared.
    const childrenHtml = (!isCollapsed && node.children && node.children.length > 0)
      ? renderTreeHtml(node.children, tier + 1, collapsedIds)
      : '';
    return `<li>${cardHtml}${childrenHtml}</li>`;
  }).join('')}</ul>`;
}

function buildStandaloneHtml(roots, totalEmployees, collapsedIds, viewLabel) {
  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const treeHtml = renderTreeHtml(roots, 0, collapsedIds);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Evergreen Org Chart — ${today}</title>
  <style>
    body { margin: 0; padding: 24px; background: #F4EFE3; font-family: 'Calibri', 'Segoe UI', Arial, sans-serif; }
    .org-shell { max-width: 1400px; margin: 0 auto; background: #FFFBF1; border-radius: 16px; box-shadow: 0 8px 32px rgba(31,27,22,0.10); padding-bottom: 8px; }
    /* On-screen for the standalone file: scale-to-fit logic via JS
       runs after window load; defaults to 1× before the script
       sees the chart dimensions. */
    .esau-fit-wrap { transform-origin: top center; }
    ${TREE_CSS}
  </style>
</head>
<body>
  <div class="org-shell esau-org-print-target">
    <div style="text-align:center;padding:18px 24px 4px;">
      <div style="font-size:10px;letter-spacing:0.28em;color:#2D5F3F;font-weight:600;">EVERGREEN SHIPPING AGENCY SAUDI CO. (LLC)</div>
      <div style="font-size:22px;color:#1F1B16;font-weight:500;margin-top:6px;letter-spacing:-0.01em;font-family:Georgia,serif;">Organization Chart</div>
      <div style="font-size:11px;color:#6B6660;margin-top:4px;">As of ${today} · ${totalEmployees} employee${totalEmployees === 1 ? '' : 's'}${viewLabel ? ' · ' + viewLabel : ''}</div>
    </div>
    <div style="overflow-x:auto;padding:8px 0 0 0;">
      <div class="esau-tree-wrap" id="esau-tree-root">
        ${treeHtml}
      </div>
    </div>
    <div style="text-align:center;margin:4px 24px 0;padding:10px 0 6px;border-top:1px solid #F0EBDF;font-size:9px;color:#9B928A;letter-spacing:0.18em;font-weight:600;">
      CEO · DJVP · M (MANAGER) · AM (ASSISTANT MANAGER) · S (STAFF) · GENERATED FROM EVERGREEN HR PORTAL · esauhr.netlify.app
    </div>
  </div>
  <script>
    // Compute the print scale so the entire chart fits A4 landscape
    // (1063 x 734 px usable after 8mm margins). Fires before each
    // print and restores after, so users can still resize/zoom the
    // page on screen without affecting print output.
    (function() {
      function computePrintScale() {
        var tree = document.getElementById('esau-tree-root');
        if (!tree) return;
        var w = tree.scrollWidth;
        var h = tree.scrollHeight;
        // Headroom for the title block and footer in the print
        // target — about 80px combined at 96dpi
        var pageW = 1063;
        var pageH = 734 - 90;
        var s = Math.min(pageW / w, pageH / h, 1);
        document.documentElement.style.setProperty('--print-scale', String(s));
      }
      window.addEventListener('beforeprint', computePrintScale);
      // Also compute once on load so screen view can use it for
      // the initial fit hint (CSS doesn't apply outside print).
      window.addEventListener('load', computePrintScale);
    })();
  </script>
</body>
</html>`;
}

function downloadHtmlFile(html, filename) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// =============================================================================
// OrgChartView — public component
// =============================================================================
export default function OrgChartView({ employees, onClose }) {
  // Zoom can be a number (manual zoom) or 'fit' (auto-fit to height).
  // 'fit' is the default so the chart starts at one-page-on-screen.
  const [zoom, setZoom] = useState('fit');
  const [computedFit, setComputedFit] = useState(1);
  const treeRef = useRef(null);
  const containerRef = useRef(null);
  const printTargetRef = useRef(null);

  const fullTree = useMemo(() => buildTree(employees || []), [employees]);
  // Default-collapsed set computed from the live tree. Anything at
  // depth 2 with children is collapsed by default — visible tree at
  // open is CEO + DJVPs + their direct reports, with [+ N] toggles
  // ready for the user to expand specific subtrees one at a time.
  const summaryCollapsed = useMemo(() => computeSummaryCollapsed(fullTree), [fullTree]);
  const [collapsedIds, setCollapsedIds] = useState(summaryCollapsed);
  // Track which preset matches the current state so the toolbar can
  // highlight the active button. 'custom' = user has manually
  // toggled at least one node since the last preset click. Recomputed
  // when collapsedIds changes against the canonical Summary set.
  const preset = useMemo(() => {
    if (collapsedIds.size === 0) return 'full';
    if (collapsedIds.size === summaryCollapsed.size
        && Array.from(summaryCollapsed).every(id => collapsedIds.has(id))) return 'summary';
    return 'custom';
  }, [collapsedIds, summaryCollapsed]);

  // Re-default the collapsed set whenever the underlying tree
  // changes (a hire/move would re-run buildTree). Keeps the user on
  // the Summary preset unless they had moved off it intentionally.
  useEffect(() => {
    setCollapsedIds(summaryCollapsed);
  }, [summaryCollapsed]);

  const totalEmployees = (employees || []).filter(e => e?.employment_status !== 'left').length;

  // Compute the fit-to-screen scale. Constraint is height only —
  // user wants horizontal scroll for wide trees, just no vertical
  // scroll inside the modal. Recomputes on tree change, expand/
  // collapse, and on window resize.
  useEffect(() => {
    if (zoom !== 'fit') return;
    const recompute = () => {
      const treeEl = treeRef.current;
      const containerEl = containerRef.current;
      if (!treeEl || !containerEl) return;
      // Available height = modal body height (already constrained
      // to 95vh by the parent flex). Subtract the static header +
      // footer chrome heights so we measure only the tree area.
      const naturalH = treeEl.scrollHeight;
      const availableH = containerEl.clientHeight - 130; // header + footer
      if (naturalH > 0 && availableH > 0) {
        const scale = Math.min(1, availableH / naturalH);
        setComputedFit(scale);
      }
    };
    // Defer initial compute one frame so the tree has finished
    // its first paint and scrollHeight is accurate.
    const id = requestAnimationFrame(recompute);
    window.addEventListener('resize', recompute);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('resize', recompute);
    };
  }, [zoom, fullTree, collapsedIds]);

  // Print scale handler. Computes when 'beforeprint' fires so the
  // value reflects the current chart size (post any zoom or expand/
  // collapse changes). Cleaned up on 'afterprint' so the screen view
  // returns to normal scale.
  useEffect(() => {
    const computePrintScale = () => {
      const treeEl = treeRef.current;
      if (!treeEl) return;
      const w = treeEl.scrollWidth;
      const h = treeEl.scrollHeight;
      // A4 landscape printable area at 96dpi minus 8mm margins
      // and chart-header headroom (~90px combined for title +
      // subtitle + footer + page padding)
      const pageW = 1063;
      const pageH = 734 - 90;
      const s = Math.min(pageW / w, pageH / h, 1);
      document.documentElement.style.setProperty('--print-scale', String(s));
    };
    const restore = () => {
      document.documentElement.style.removeProperty('--print-scale');
    };
    window.addEventListener('beforeprint', computePrintScale);
    window.addEventListener('afterprint', restore);
    return () => {
      window.removeEventListener('beforeprint', computePrintScale);
      window.removeEventListener('afterprint', restore);
    };
  }, []);

  const effectiveScale = zoom === 'fit' ? computedFit : zoom;

  // Toggle a single node's collapsed state. Uses the functional
  // setState form so concurrent clicks don't race. Drops the user
  // into 'custom' preset implicitly — preset is derived from the
  // resulting set, not stored separately.
  const handleToggle = useCallback((id) => {
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handlePresetSummary = useCallback(() => {
    setCollapsedIds(summaryCollapsed);
  }, [summaryCollapsed]);

  const handlePresetFull = useCallback(() => {
    setCollapsedIds(new Set());
  }, []);

  const viewLabel = preset === 'summary' ? 'Summary view'
                  : preset === 'full' ? 'Full view'
                  : 'Custom view';

  const handleDownload = useCallback(() => {
    const html = buildStandaloneHtml(fullTree, totalEmployees, collapsedIds, viewLabel);
    const stamp = new Date().toISOString().slice(0, 10);
    const slug = preset === 'custom' ? 'custom' : preset;
    downloadHtmlFile(html, `esau_org_chart_${slug}_${stamp}.html`);
  }, [fullTree, totalEmployees, collapsedIds, viewLabel, preset]);

  const handlePrint = useCallback(() => {
    // Native print — beforeprint listener computes the scale,
    // afterprint listener restores. The print stylesheet hides
    // body * and shows only .esau-org-print-target.
    window.print();
  }, []);

  const handleZoomIn = () => setZoom(z => {
    const cur = z === 'fit' ? computedFit : z;
    return Math.min(1.4, +(cur + 0.1).toFixed(2));
  });
  const handleZoomOut = () => setZoom(z => {
    const cur = z === 'fit' ? computedFit : z;
    return Math.max(0.4, +(cur - 0.1).toFixed(2));
  });

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(15, 31, 26, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2.5vh 16px',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        ref={printTargetRef}
        className="esau-org-print-target"
        style={{
          background: '#FFFBF1',
          borderRadius: 16,
          maxWidth: 1400,
          width: '100%',
          height: '95vh',
          boxShadow: '0 24px 64px rgba(31, 27, 22, 0.32)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Toolbar — flex-shrink:0 so it stays at fixed height while
            the body fills the rest. Hidden in print via the global
            .esau-org-no-print rule plus the parent visibility:hidden
            print rule (which hides everything else outside the
            print target). */}
        <div
          className="esau-org-no-print"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 18px',
            borderBottom: '1px solid #F0EBDF',
            gap: 12,
            flexWrap: 'wrap',
            flexShrink: 0,
            background: '#FFFBF1',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Building2 className="w-5 h-5" style={{ color: '#2D5F3F' }} />
            <div>
              <div style={{ fontSize: 10, letterSpacing: '0.2em', color: '#6B6660', fontWeight: 600 }}>
                ORG CHART
              </div>
              <div style={{ fontSize: 13, color: '#1F1B16', fontWeight: 500 }}>
                Evergreen Shipping Agency Saudi Co.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <div
              style={{
                display: 'inline-flex',
                background: '#F0EBDF',
                borderRadius: 999,
                padding: 3,
              }}
            >
              <button
                onClick={handlePresetSummary}
                title="Show CEO + DJVPs + their direct reports. Use [+ N] to expand specific subtrees."
                style={{
                  padding: '5px 12px',
                  borderRadius: 999,
                  fontSize: 11.5,
                  fontWeight: 600,
                  background: preset === 'summary' ? '#FFFFFF' : 'transparent',
                  color: preset === 'summary' ? '#1F1B16' : '#6B6660',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: preset === 'summary' ? '0 1px 3px rgba(31, 27, 22, 0.12)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <LayoutGrid className="w-3.5 h-3.5" /> Summary
              </button>
              <button
                onClick={handlePresetFull}
                title="Expand every subtree — show every employee."
                style={{
                  padding: '5px 12px',
                  borderRadius: 999,
                  fontSize: 11.5,
                  fontWeight: 600,
                  background: preset === 'full' ? '#FFFFFF' : 'transparent',
                  color: preset === 'full' ? '#1F1B16' : '#6B6660',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: preset === 'full' ? '0 1px 3px rgba(31, 27, 22, 0.12)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                <Users2 className="w-3.5 h-3.5" /> Full
              </button>
              {preset === 'custom' && (
                <span
                  title="You've manually expanded/collapsed subtrees. Click Summary or Full to reset."
                  style={{
                    padding: '5px 10px',
                    borderRadius: 999,
                    fontSize: 11.5,
                    fontWeight: 600,
                    background: '#FFFFFF',
                    color: '#8B5A1F',
                    boxShadow: '0 1px 3px rgba(31, 27, 22, 0.12)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  Custom
                </span>
              )}
            </div>
            <div
              style={{
                display: 'inline-flex',
                background: '#F0EBDF',
                borderRadius: 999,
                padding: 3,
                alignItems: 'center',
              }}
            >
              <button
                onClick={handleZoomOut}
                title="Zoom out"
                style={{
                  width: 26, height: 26, borderRadius: 999, background: 'transparent',
                  border: 'none', cursor: 'pointer', color: '#6B6660',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setZoom('fit')}
                title="Fit to screen"
                style={{
                  padding: '0 8px', height: 26, borderRadius: 999,
                  background: zoom === 'fit' ? '#FFFFFF' : 'transparent',
                  border: 'none', cursor: 'pointer',
                  color: zoom === 'fit' ? '#1F1B16' : '#6B6660',
                  fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em',
                  boxShadow: zoom === 'fit' ? '0 1px 3px rgba(31, 27, 22, 0.12)' : 'none',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
              >
                <Maximize2 className="w-3 h-3" />
                {zoom === 'fit' ? `FIT ${Math.round(effectiveScale * 100)}%` : `${Math.round(effectiveScale * 100)}%`}
              </button>
              <button
                onClick={handleZoomIn}
                title="Zoom in"
                style={{
                  width: 26, height: 26, borderRadius: 999, background: 'transparent',
                  border: 'none', cursor: 'pointer', color: '#6B6660',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={handlePrint}
              title="Print (A4 landscape, fitted to one page)"
              style={{
                padding: '6px 12px',
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: 600,
                background: '#FFFFFF',
                color: '#1F1B16',
                border: '1px solid #C49B61',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Printer className="w-3.5 h-3.5" /> Print
            </button>
            <button
              onClick={handleDownload}
              title="Download as standalone HTML file"
              style={{
                padding: '6px 12px',
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: 600,
                background: '#2D5F3F',
                color: '#FFFFFF',
                border: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <Download className="w-3.5 h-3.5" /> HTML
            </button>
            <button
              onClick={onClose}
              title="Close"
              style={{
                padding: 5,
                borderRadius: 999,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: '#6B6660',
              }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body — flex:1 fills remaining height. overflow-x:auto for
            wide trees; overflow-y:hidden so the modal doesn't grow
            beyond its 95vh limit. The fit-to-screen scale shrinks
            tall trees to fit; manual zoom can push past that. */}
        <div
          ref={containerRef}
          style={{
            flex: 1,
            overflowX: 'auto',
            overflowY: 'hidden',
            position: 'relative',
          }}
        >
          <div
            style={{
              transform: `scale(${effectiveScale})`,
              transformOrigin: 'top center',
              transition: 'transform 160ms ease-out',
              minWidth: 'fit-content',
            }}
          >
            <ChartBody
              roots={fullTree}
              collapsedIds={collapsedIds}
              onToggle={handleToggle}
              totalEmployees={totalEmployees}
              treeRef={treeRef}
              viewLabel={viewLabel}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
