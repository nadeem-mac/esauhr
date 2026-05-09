import React, { useMemo, useState, useCallback } from 'react';
import { X, Download, LayoutGrid, Users2, Building2, ZoomIn, ZoomOut } from 'lucide-react';

// =============================================================================
// OrgChartView — tree edition (rev. 2)
//
// Per Nadeem 2026-05-09 (second pass): the previous tier-based layout
// rendered each level as a flat horizontal row. That works for shallow
// trees but stops feeling like an org chart once a parent has more
// than 3-4 reports — the children look like a list, not a hierarchy.
//
// This rewrite renders a proper hierarchical tree using the classic
// `<ul><li>` CSS pattern with connector lines drawn by ::before /
// ::after pseudo-elements. Each parent sits over its children with a
// vertical drop, a horizontal sibling bar, and short verticals down
// to each child. Same connector convention used in printed org charts
// for decades — instantly readable.
//
// Card design also got a polish pass to the visual quality the user
// asked for: subtle gradients, layered shadows, ringed avatars,
// refined typography hierarchy. Tier-distinct accents preserve the
// scan-at-a-glance role recognition from rev 1.
//
// Two view modes via segmented toggle:
//   • Summary — depth-limited to 3 tiers (CEO + DJVPs + managers).
//     Clipped subtrees still surface their report count via a
//     "↓ N reports" tail on the parent card so depth is implicit.
//   • Full — every employee, every level. Horizontal scroll handles
//     wide trees on narrower screens.
//
// Two output paths preserved from rev 1:
//   • Modal — render in an overlay inside the portal.
//   • Download HTML — fully self-contained file with the same tree
//     CSS inlined, suitable for emailing or printing offline.
//
// Tree-build invariants:
//   • Root = anyone with no manager_id, manager_id pointing to a
//     non-existent employee, or manager_id pointing to themselves.
//   • Cycle guard breaks loops within 10 hops (defense against
//     bad data — Sharique/Sadakathullah used to point at each other).
//   • Children sorted alphabetically inside each parent so reload
//     order is deterministic.
// =============================================================================

// Initials for the avatar — first letter of first + first letter of
// last name. Fall back to the last two PSN chars if the name is
// missing or one-word.
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

// Department/location code → human label. Used in the tooltip and
// in the card subtitle. Codes the user adds in future automatically
// fall back to the raw code if not in the lookup.
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

// Build a tree from a flat employee array. Returns the array of
// roots. See file header for invariants.
function buildTree(employees) {
  const byId = new Map();
  for (const emp of employees) {
    if (!emp?.id) continue;
    byId.set(emp.id, { ...emp, children: [] });
  }
  const roots = [];
  for (const node of byId.values()) {
    const mgrId = node.manager_id;
    if (!mgrId || !byId.has(mgrId) || mgrId === node.id) {
      roots.push(node);
      continue;
    }
    // Cycle guard — walk up the chain, abort if we hit ourselves
    // within 10 hops. Org charts realistically never go that deep.
    let cursor = byId.get(mgrId);
    let cyclic = false;
    let hops = 0;
    while (cursor && hops < 10) {
      if (cursor.id === node.id) { cyclic = true; break; }
      cursor = cursor.manager_id ? byId.get(cursor.manager_id) : null;
      hops++;
    }
    if (cyclic) {
      roots.push(node);
      continue;
    }
    byId.get(mgrId).children.push(node);
  }
  const sortRecursive = (nodes) => {
    nodes.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    nodes.forEach(n => sortRecursive(n.children));
  };
  sortRecursive(roots);
  return roots;
}

// Clip the tree to a maximum depth. At the cutoff layer, children
// are collapsed and replaced with a `_clippedCount` marker so the
// card can render "↓ N reports" instead of recursing further. The
// clipping happens by depth, not by tier, so each subtree gets its
// own depth budget — works correctly for non-uniform trees.
function clipDepth(nodes, maxDepth, currentDepth = 0) {
  return nodes.map(node => {
    if (currentDepth >= maxDepth - 1) {
      return { ...node, children: [], _clippedCount: countDescendants(node) };
    }
    return {
      ...node,
      children: clipDepth(node.children || [], maxDepth, currentDepth + 1),
      _clippedCount: 0,
    };
  });
}

// Total number of descendants under a node (recursively, all levels).
// Used by clipDepth to populate the "↓ N reports" tail when summary
// mode hides the actual subtree.
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

// Tier-aware visual styling. Tier 0 is the CEO. The DJVPs Nadeem
// designated (Sharique, Sadakathullah) sit at tier 1. Tier 2 is
// usually department managers / supervisors. Tier 3+ is staff.
// HR reviewer (Bashaier) and admin (Nadeem) get distinct accents
// regardless of tier so they're recognisable in dense subtrees.
function styleFor(node, tier) {
  if (tier === 0) {
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
  if (tier === 1) {
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
  if (node.is_hr_reviewer) {
    return {
      borderColor: '#2D5F3F',
      borderWidth: 1.5,
      avatarBg: 'linear-gradient(135deg, #3D7A52 0%, #2D5F3F 100%)',
      avatarRing: 'rgba(45, 95, 63, 0.14)',
      tagBg: 'rgba(45, 95, 63, 0.10)',
      tagColor: '#2D5F3F',
      cardBg: '#FFFFFF',
      shadow: '0 4px 14px rgba(45, 95, 63, 0.10), 0 1px 3px rgba(31, 27, 22, 0.05)',
    };
  }
  if (node.is_admin) {
    return {
      borderColor: '#1F1B16',
      borderWidth: 1.5,
      avatarBg: 'linear-gradient(135deg, #3A342B 0%, #1F1B16 100%)',
      avatarRing: 'rgba(31, 27, 22, 0.14)',
      tagBg: 'rgba(31, 27, 22, 0.08)',
      tagColor: '#1F1B16',
      cardBg: '#FFFFFF',
      shadow: '0 4px 14px rgba(31, 27, 22, 0.10), 0 1px 3px rgba(31, 27, 22, 0.05)',
    };
  }
  if (tier === 2) {
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

function roleLabel(node, tier) {
  if (tier === 0) return 'MGT · CEO';
  const d = node.department || '—';
  const l = node.location || '—';
  return `${d} · ${l}`;
}

// =============================================================================
// Tree CSS — drawn via pseudo-elements on the nested ul/li structure.
// One <style> block kept here so the live and exported chart share
// the exact same connector geometry. Class names are namespaced under
// .esau-tree- so they can't collide with anything else on the page.
// =============================================================================
const TREE_CSS = `
.esau-tree-wrap {
  display: inline-block;
  padding: 24px 48px 32px;
  text-align: center;
  font-family: 'Anthropic Sans', -apple-system, 'Segoe UI', sans-serif;
}
.esau-tree-wrap ul {
  position: relative;
  padding: 28px 0 0 0;
  margin: 0;
  list-style: none;
  display: inline-flex;
  justify-content: center;
}
/* Vertical drop from the parent down into the children-row */
.esau-tree-wrap ul::before {
  content: '';
  position: absolute;
  top: 0;
  left: 50%;
  border-left: 1.5px solid #C49B61;
  height: 14px;
  opacity: 0.55;
}
.esau-tree-wrap li {
  position: relative;
  padding: 14px 14px 0 14px;
  text-align: center;
}
/* Horizontal bar across siblings (left and right halves) */
.esau-tree-wrap li::before,
.esau-tree-wrap li::after {
  content: '';
  position: absolute;
  top: 0;
  border-top: 1.5px solid #C49B61;
  width: 50%;
  height: 14px;
  opacity: 0.55;
}
.esau-tree-wrap li::before { right: 50%; }
.esau-tree-wrap li::after  { left: 50%; }
/* Single child — drop a centred vertical only, no horizontal bar */
.esau-tree-wrap li:only-child::before,
.esau-tree-wrap li:only-child::after { display: none; }
/* End-of-row siblings — half-bar is trimmed at the outer edge so
   the connector doesn't extend past the outermost child */
.esau-tree-wrap li:first-child::before,
.esau-tree-wrap li:last-child::after { border: 0 none; }
/* Rounded corners at the bend so the right-angle joins look polished */
.esau-tree-wrap li:first-child::after  { border-radius: 6px 0 0 0; border-left: 1.5px solid #C49B61; }
.esau-tree-wrap li:last-child::before  { border-radius: 0 6px 0 0; border-right: 1.5px solid #C49B61; }
/* The root <ul>'s own ::before drop is unwanted — we want the
   tree to start with the root card, not a dangling line above it. */
.esau-tree-wrap > ul::before { display: none; }
.esau-tree-wrap > ul > li { padding-top: 0; }
.esau-tree-wrap > ul > li::before,
.esau-tree-wrap > ul > li::after { display: none; }
/* Card hover — subtle lift for interactivity */
.esau-tree-wrap .esau-card {
  transition: transform 140ms ease-out, box-shadow 140ms ease-out;
}
.esau-tree-wrap .esau-card:hover {
  transform: translateY(-2px);
}
@media print {
  .esau-tree-wrap .esau-card { transition: none; }
  .esau-tree-wrap .esau-card:hover { transform: none; }
}
`;

// =============================================================================
// NodeCard — the visible block per person. Uses pre-computed style
// from styleFor() so the card matches its tier accent without any
// ternaries in JSX.
// =============================================================================
function NodeCard({ node, tier }) {
  const s = styleFor(node, tier);
  const initials = initialsOf(node.name, node.id);
  const role = roleLabel(node, tier);
  const directReports = (node.children || []).length;
  const clippedReports = node._clippedCount || 0;
  const totalReports = directReports + clippedReports;
  const deptFull = DEPT_LABEL[node.department] || node.department || '';
  const locFull = LOC_LABEL[node.location] || node.location || '';
  const isCeo = tier === 0;
  const isDjvp = tier === 1;
  const tooltip = `${node.name}\n${node.id}${deptFull ? '\n' + deptFull : ''}${locFull ? ' · ' + locFull : ''}`;

  return (
    <div
      className="esau-card"
      title={tooltip}
      style={{
        background: s.cardBg,
        border: `${s.borderWidth}px solid ${s.borderColor}`,
        borderRadius: 14,
        padding: isCeo ? '20px 18px' : isDjvp ? '16px 16px' : '14px 14px',
        minWidth: isCeo ? 230 : isDjvp ? 200 : tier >= 3 ? 168 : 184,
        maxWidth: isCeo ? 270 : 220,
        boxShadow: s.shadow,
        textAlign: 'left',
        cursor: 'default',
        display: 'inline-block',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 9 }}>
        <div
          style={{
            width: isCeo ? 46 : isDjvp ? 42 : 36,
            height: isCeo ? 46 : isDjvp ? 42 : 36,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: isCeo ? 14 : isDjvp ? 13 : 12,
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
              fontSize: 9,
              letterSpacing: '0.18em',
              fontWeight: 600,
              padding: '3px 9px',
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
          fontSize: isCeo ? 15 : isDjvp ? 14 : 13,
          fontWeight: 600,
          color: '#1F1B16',
          lineHeight: 1.25,
          letterSpacing: '-0.005em',
        }}
      >
        {node.name}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3 }}>
        <span
          style={{
            fontSize: 10.5,
            color: '#6B6660',
            fontFamily: '"SF Mono", Consolas, monospace',
            letterSpacing: '0.02em',
          }}
        >
          {node.id}
        </span>
        {totalReports > 0 && (
          <span
            style={{
              fontSize: 9.5,
              color: s.tagColor,
              fontWeight: 700,
              padding: '1.5px 7px',
              borderRadius: 999,
              background: s.tagBg,
              letterSpacing: '0.04em',
            }}
            title={clippedReports > 0
              ? `${directReports} direct + ${clippedReports} below — toggle to Full view to see all`
              : `${directReports} direct report${directReports === 1 ? '' : 's'}`}
          >
            ↓ {totalReports}
          </span>
        )}
      </div>
      {isCeo && (
        <div
          style={{
            fontSize: 10.5,
            color: '#6B6660',
            marginTop: 8,
            paddingTop: 8,
            borderTop: '1px solid #F0EBDF',
            lineHeight: 1.35,
            fontStyle: 'italic',
          }}
        >
          Evergreen Shipping Agency Saudi Co. (LLC)
        </div>
      )}
    </div>
  );
}

// =============================================================================
// TreeNode — recursive renderer. Each node is an <li> wrapping a
// card and (if it has children) a nested <ul> that the CSS lays
// out as a row of <li>s with the connector lines drawn between.
// =============================================================================
function TreeNode({ node, tier }) {
  return (
    <li>
      <NodeCard node={node} tier={tier} />
      {node.children && node.children.length > 0 && (
        <ul>
          {node.children.map(child => (
            <TreeNode key={child.id} node={child} tier={tier + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

// =============================================================================
// ChartBody — wrapping element used by both the live modal view and
// the standalone HTML export. Contains the centred header (kicker,
// title, subtitle), the tree, and the footer mark.
// =============================================================================
function ChartBody({ roots, mode, totalEmployees, headOnly = false }) {
  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  return (
    <div style={{ background: '#FFFBF1', borderRadius: 16, paddingBottom: 8 }}>
      <style>{TREE_CSS}</style>
      <div style={{ textAlign: 'center', padding: '28px 24px 8px' }}>
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.28em',
            color: '#2D5F3F',
            fontWeight: 600,
          }}
        >
          EVERGREEN SHIPPING AGENCY SAUDI CO. (LLC)
        </div>
        <div
          style={{
            fontSize: 24,
            color: '#1F1B16',
            fontWeight: 500,
            marginTop: 8,
            letterSpacing: '-0.01em',
            fontFamily: 'Georgia, serif',
          }}
        >
          Organization Chart
        </div>
        <div style={{ fontSize: 12, color: '#6B6660', marginTop: 6 }}>
          As of {today}{' · '}{totalEmployees} employee{totalEmployees === 1 ? '' : 's'}
          {' · '}{mode === 'summary' ? 'Summary view' : 'Full view'}
        </div>
      </div>

      <div style={{ overflowX: 'auto', overflowY: 'visible', padding: '8px 0 0 0' }}>
        <div className="esau-tree-wrap">
          <ul>
            {roots.map(root => (
              <TreeNode key={root.id} node={root} tier={0} />
            ))}
          </ul>
        </div>
      </div>

      <div
        style={{
          textAlign: 'center',
          margin: '8px 24px 0',
          padding: '14px 0 8px',
          borderTop: '1px solid #F0EBDF',
          fontSize: 10,
          color: '#9B928A',
          letterSpacing: '0.18em',
          fontWeight: 600,
        }}
      >
        GENERATED FROM EVERGREEN HR PORTAL · esauhr.netlify.app
      </div>
    </div>
  );
}

// Tiny escape helper for the standalone export. The live React path
// auto-escapes; the standalone export builds raw strings.
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Recursively render tree HTML for the standalone export. Mirrors
// the React TreeNode/NodeCard pair but emits inline styles in plain
// HTML. Same TREE_CSS is embedded in the page <style> block for the
// connector geometry.
function renderTreeHtml(nodes, tier) {
  return `<ul>${nodes.map(node => {
    const s = styleFor(node, tier);
    const initials = initialsOf(node.name, node.id);
    const role = roleLabel(node, tier);
    const directReports = (node.children || []).length;
    const clippedReports = node._clippedCount || 0;
    const totalReports = directReports + clippedReports;
    const isCeo = tier === 0;
    const isDjvp = tier === 1;

    const cardStyle = [
      `background:${s.cardBg}`,
      `border:${s.borderWidth}px solid ${s.borderColor}`,
      `border-radius:14px`,
      `padding:${isCeo ? '20px 18px' : isDjvp ? '16px 16px' : '14px 14px'}`,
      `min-width:${isCeo ? 230 : isDjvp ? 200 : tier >= 3 ? 168 : 184}px`,
      `max-width:${isCeo ? 270 : 220}px`,
      `box-shadow:${s.shadow}`,
      `text-align:left`,
      `display:inline-block`,
    ].join(';');

    const avatarSize = isCeo ? 46 : isDjvp ? 42 : 36;
    const avatarFontSize = isCeo ? 14 : isDjvp ? 13 : 12;
    const nameFontSize = isCeo ? 15 : isDjvp ? 14 : 13;

    const cardHtml = `
      <div class="esau-card" title="${escapeHtml(node.name)}\n${escapeHtml(node.id)}" style="${cardStyle}">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:9px;">
          <div style="width:${avatarSize}px;height:${avatarSize}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:${avatarFontSize}px;font-weight:600;letter-spacing:0.04em;color:#FFFFFF;background:${s.avatarBg};box-shadow:0 0 0 3px ${s.avatarRing};flex-shrink:0;">${escapeHtml(initials)}</div>
          <div><span style="font-size:9px;letter-spacing:0.18em;font-weight:600;padding:3px 9px;border-radius:999px;display:inline-block;background:${s.tagBg};color:${s.tagColor};text-transform:uppercase;">${escapeHtml(role)}</span></div>
        </div>
        <div style="font-size:${nameFontSize}px;font-weight:600;color:#1F1B16;line-height:1.25;letter-spacing:-0.005em;">${escapeHtml(node.name || '')}</div>
        <div style="display:flex;align-items:center;gap:8px;margin-top:3px;">
          <span style="font-size:10.5px;color:#6B6660;font-family:'SF Mono',Consolas,monospace;letter-spacing:0.02em;">${escapeHtml(node.id || '')}</span>
          ${totalReports > 0 ? `<span style="font-size:9.5px;color:${s.tagColor};font-weight:700;padding:1.5px 7px;border-radius:999px;background:${s.tagBg};letter-spacing:0.04em;">↓ ${totalReports}</span>` : ''}
        </div>
        ${isCeo ? `<div style="font-size:10.5px;color:#6B6660;margin-top:8px;padding-top:8px;border-top:1px solid #F0EBDF;line-height:1.35;font-style:italic;">Evergreen Shipping Agency Saudi Co. (LLC)</div>` : ''}
      </div>
    `;

    const childrenHtml = (node.children && node.children.length > 0)
      ? renderTreeHtml(node.children, tier + 1)
      : '';

    return `<li>${cardHtml}${childrenHtml}</li>`;
  }).join('')}</ul>`;
}

// Build a fully self-contained HTML document for download. All
// styles (including the TREE_CSS connector pseudo-elements) are
// embedded in a <style> tag so the file opens correctly offline.
function buildStandaloneHtml(roots, totalEmployees, mode) {
  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  const treeHtml = renderTreeHtml(roots, 0);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Evergreen Org Chart — ${today}</title>
  <style>
    body { margin: 0; padding: 24px; background: #F4EFE3; font-family: 'Calibri', 'Segoe UI', Arial, sans-serif; }
    @media print {
      body { background: #FFFFFF; padding: 0; }
      .org-shell { box-shadow: none !important; }
      .esau-card { transition: none !important; }
    }
    ${TREE_CSS}
  </style>
</head>
<body>
  <div class="org-shell" style="max-width: 1400px; margin: 0 auto; background: #FFFBF1; border-radius: 16px; box-shadow: 0 8px 32px rgba(31,27,22,0.10); padding-bottom: 8px;">
    <div style="text-align:center;padding:28px 24px 8px;">
      <div style="font-size:10px;letter-spacing:0.28em;color:#2D5F3F;font-weight:600;">EVERGREEN SHIPPING AGENCY SAUDI CO. (LLC)</div>
      <div style="font-size:24px;color:#1F1B16;font-weight:500;margin-top:8px;letter-spacing:-0.01em;font-family:Georgia,serif;">Organization Chart</div>
      <div style="font-size:12px;color:#6B6660;margin-top:6px;">As of ${today} · ${totalEmployees} employee${totalEmployees === 1 ? '' : 's'} · ${mode === 'summary' ? 'Summary view' : 'Full view'}</div>
    </div>
    <div style="overflow-x:auto;padding:8px 0 0 0;">
      <div class="esau-tree-wrap">
        ${treeHtml}
      </div>
    </div>
    <div style="text-align:center;margin:8px 24px 0;padding:14px 0 8px;border-top:1px solid #F0EBDF;font-size:10px;color:#9B928A;letter-spacing:0.18em;font-weight:600;">
      GENERATED FROM EVERGREEN HR PORTAL · esauhr.netlify.app
    </div>
  </div>
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
// OrgChartView — public component. Modal shell with toolbar +
// scrollable tree body. Lazy-loaded by AppShell so its bundle cost
// stays out of the main chunk.
// =============================================================================
export default function OrgChartView({ employees, onClose }) {
  const [mode, setMode] = useState('summary');
  const [zoom, setZoom] = useState(1);

  // Build the full tree once; clip a copy for summary mode. Memoised
  // so the heavy traversal only re-runs when employees or mode change.
  const fullTree = useMemo(() => buildTree(employees || []), [employees]);
  const displayTree = useMemo(() => (
    mode === 'summary' ? clipDepth(fullTree, 3) : fullTree
  ), [fullTree, mode]);

  const totalEmployees = (employees || []).filter(e => e?.employment_status !== 'left').length;

  const handleDownload = useCallback(() => {
    const html = buildStandaloneHtml(displayTree, totalEmployees, mode);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadHtmlFile(html, `esau_org_chart_${mode}_${stamp}.html`);
  }, [displayTree, totalEmployees, mode]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(15, 31, 26, 0.55)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        padding: 24,
        overflowY: 'auto',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        style={{
          background: '#FFFBF1',
          borderRadius: 16,
          maxWidth: 1400,
          width: '100%',
          boxShadow: '0 24px 64px rgba(31, 27, 22, 0.32)',
          marginBottom: 24,
        }}
      >
        {/* Toolbar — branding + segmented mode toggle + zoom + actions */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid #F0EBDF',
            gap: 16,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Building2 className="w-5 h-5" style={{ color: '#2D5F3F' }} />
            <div>
              <div style={{ fontSize: 10, letterSpacing: '0.2em', color: '#6B6660', fontWeight: 600 }}>
                ORG CHART
              </div>
              <div style={{ fontSize: 14, color: '#1F1B16', fontWeight: 500 }}>
                Evergreen Shipping Agency Saudi Co.
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            {/* Mode toggle */}
            <div
              style={{
                display: 'inline-flex',
                background: '#F0EBDF',
                borderRadius: 999,
                padding: 3,
              }}
            >
              <button
                onClick={() => setMode('summary')}
                style={{
                  padding: '6px 14px',
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  background: mode === 'summary' ? '#FFFFFF' : 'transparent',
                  color: mode === 'summary' ? '#1F1B16' : '#6B6660',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: mode === 'summary' ? '0 1px 3px rgba(31, 27, 22, 0.12)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <LayoutGrid className="w-3.5 h-3.5" /> Summary
              </button>
              <button
                onClick={() => setMode('full')}
                style={{
                  padding: '6px 14px',
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  background: mode === 'full' ? '#FFFFFF' : 'transparent',
                  color: mode === 'full' ? '#1F1B16' : '#6B6660',
                  border: 'none',
                  cursor: 'pointer',
                  boxShadow: mode === 'full' ? '0 1px 3px rgba(31, 27, 22, 0.12)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Users2 className="w-3.5 h-3.5" /> Full
              </button>
            </div>
            {/* Zoom controls — useful for full-view tall charts. Range
                clamped 0.6×–1.4× so the tree never gets unreadably small
                or crashes the modal layout. */}
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
                onClick={() => setZoom(z => Math.max(0.6, +(z - 0.1).toFixed(2)))}
                title="Zoom out"
                style={{
                  width: 28, height: 28, borderRadius: 999, background: 'transparent',
                  border: 'none', cursor: 'pointer', color: '#6B6660',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span style={{ fontSize: 11, color: '#6B6660', minWidth: 32, textAlign: 'center', fontWeight: 600 }}>
                {Math.round(zoom * 100)}%
              </span>
              <button
                onClick={() => setZoom(z => Math.min(1.4, +(z + 0.1).toFixed(2)))}
                title="Zoom in"
                style={{
                  width: 28, height: 28, borderRadius: 999, background: 'transparent',
                  border: 'none', cursor: 'pointer', color: '#6B6660',
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
            <button
              onClick={handleDownload}
              title="Download as standalone HTML file"
              style={{
                padding: '7px 14px',
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                background: '#2D5F3F',
                color: '#FFFFFF',
                border: 'none',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Download className="w-3.5 h-3.5" /> Download HTML
            </button>
            <button
              onClick={onClose}
              title="Close"
              style={{
                padding: 6,
                borderRadius: 999,
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: '#6B6660',
              }}
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scrollable chart body. Zoom applies via CSS transform so
            the tree connector geometry isn't affected — only the
            visual scale. transform-origin centred-top so zooming
            doesn't shift the CEO offscreen. */}
        <div style={{ overflowX: 'auto', overflowY: 'visible' }}>
          <div
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center top',
              transition: 'transform 160ms ease-out',
            }}
          >
            <ChartBody roots={displayTree} mode={mode} totalEmployees={totalEmployees} />
          </div>
        </div>
      </div>
    </div>
  );
}
