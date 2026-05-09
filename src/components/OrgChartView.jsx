import React, { useMemo, useState, useCallback } from 'react';
import { X, Download, LayoutGrid, Users2, Building2 } from 'lucide-react';

// =============================================================================
// OrgChartView
//
// Live organizational chart for Evergreen Shipping Agency Saudi Co.
// Pulls the employee list from the AppShell-loaded employees prop and
// builds a parent-child tree using each employee's manager_id field.
// Renders the tree as horizontal tiers with connecting lines, mirroring
// the preview design Nadeem approved 2026-05-09.
//
// Two view modes:
//   • Summary — top three tiers only (CEO + their direct reports +
//     their direct reports). Best for at-a-glance presentations.
//   • Full    — every employee on every tier. Best for HR auditing.
//
// Two output paths:
//   • Modal — render in an overlay inside the portal (default action
//     when the user opens the view).
//   • Download — produce a fully self-contained HTML file with all
//     styles inlined, suitable for emailing or printing offline.
//
// Per Nadeem 2026-05-09:
//   • All managers ultimately roll up to John Ho (the CEO is the
//     tree's single root via manager_id = null).
//   • Sharique (H94460) and Sadakathullah (H94076) are both DJVPs
//     reporting directly to John Ho — peers, not stacked. A circular
//     manager_id reference between them in the live data has been
//     resolved by treating both as direct reports of the CEO.
//   • Nadeem (H94152) sits in the BIZ team under Sadakathullah —
//     his admin status is a portal flag, not an org role.
//   • On-leave staff render plainly — no special chip in the chart.
// =============================================================================

// Initials for the avatar — first letter of first name + first letter
// of last name. Falls back to first two characters of the PSN if the
// name is too short or missing.
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

// Department code → human-readable label. The chart shows the code
// in a chip but the tooltip on hover gives the full label so people
// unfamiliar with the codes can still read the chart.
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

// Build a tree from a flat employee array using manager_id pointers.
// Returns the root array (people with no manager, ie the CEO). Cycles
// in the data are broken by treating any node whose manager_id chain
// loops back on itself as a root — this protects against the known
// bad data where Sharique and Sadakath used to point at each other.
function buildTree(employees) {
  const byId = new Map();
  for (const emp of employees) {
    if (!emp?.id) continue;
    byId.set(emp.id, { ...emp, children: [] });
  }
  const roots = [];
  for (const node of byId.values()) {
    const mgrId = node.manager_id;
    // No manager → root. Also root if manager_id points to a non-
    // existent employee (e.g. retired manager not yet reassigned)
    // or if the chain loops back to this node within 10 hops.
    if (!mgrId || !byId.has(mgrId) || mgrId === node.id) {
      roots.push(node);
      continue;
    }
    // Cycle guard — walk up the chain, abort if we hit ourselves
    // within 10 hops (org charts realistically never go that deep).
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
  // Sort children alphabetically within each parent so the chart
  // renders deterministically across reloads.
  const sortRecursive = (nodes) => {
    nodes.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    nodes.forEach(n => sortRecursive(n.children));
  };
  sortRecursive(roots);
  return roots;
}

// Flatten the tree into tiers for horizontal-row rendering. Each
// tier is an array of nodes at the same depth. Tier 0 is the root.
function flattenTiers(roots) {
  const tiers = [];
  let current = roots;
  while (current.length > 0) {
    tiers.push(current);
    current = current.flatMap(node => node.children || []);
  }
  return tiers;
}

// Card colour scheme decided by tier and special roles. Tier 0 = CEO
// (evergreen), Tier 1 = DJVPs (bronze), Tier 2 = managers (warm tan),
// Tier 3+ = staff (neutral grey). Bashaier gets an HR-distinct green
// border because the chart should let admin spot HR roles fast.
function styleFor(node, tier) {
  if (tier === 0) {
    return {
      borderColor: '#2D5F3F',
      borderWidth: 2,
      avatarBg: '#2D5F3F',
      tagBg: 'rgba(45,95,63,0.12)',
      tagColor: '#2D5F3F',
      gradient: true,
    };
  }
  if (tier === 1) {
    return {
      borderColor: '#8B5A1F',
      borderWidth: 2,
      avatarBg: '#8B5A1F',
      tagBg: 'rgba(139,90,31,0.18)',
      tagColor: '#5A3A14',
    };
  }
  // HR reviewer (Bashaier) + admin (Nadeem) get distinct accents so
  // they're recognisable in dense tier 2/3 rows even without titles.
  if (node.is_hr_reviewer) {
    return {
      borderColor: '#2D5F3F',
      borderWidth: 1.5,
      avatarBg: '#2D5F3F',
      tagBg: 'rgba(45,95,63,0.12)',
      tagColor: '#2D5F3F',
    };
  }
  if (node.is_admin) {
    return {
      borderColor: '#1F1B16',
      borderWidth: 1.5,
      avatarBg: '#1F1B16',
      tagBg: 'rgba(31,27,22,0.10)',
      tagColor: '#1F1B16',
    };
  }
  if (tier === 2) {
    return {
      borderColor: '#C49B61',
      borderWidth: 1.5,
      avatarBg: '#9B6D3D',
      tagBg: 'rgba(196,155,97,0.18)',
      tagColor: '#8B5A1F',
    };
  }
  return {
    borderColor: '#1F1B16',
    borderWidth: 1.5,
    avatarBg: '#6B7280',
    tagBg: 'rgba(107,114,128,0.12)',
    tagColor: '#4B5563',
  };
}

// Role label shown in the chip. CEO at tier 0 gets "MGT · CEO"
// regardless of department; everyone else gets "DEPT · LOC".
function roleLabel(node, tier) {
  if (tier === 0) return 'MGT · CEO';
  const d = node.department || '—';
  const l = node.location || '—';
  return `${d} · ${l}`;
}

// Render a single card. Used both for the live chart and for the
// downloadable HTML — the standalone version inlines the same styles
// so the file looks identical when opened offline.
function NodeCard({ node, tier }) {
  const s = styleFor(node, tier);
  const initials = initialsOf(node.name, node.id);
  const role = roleLabel(node, tier);
  const reportCount = (node.children || []).length;
  const deptFull = DEPT_LABEL[node.department] || node.department || '';
  const locFull = LOC_LABEL[node.location] || node.location || '';
  const isCeo = tier === 0;

  return (
    <div
      title={`${node.name}\n${node.id}\n${deptFull}${locFull ? ' · ' + locFull : ''}`}
      style={{
        background: s.gradient
          ? 'linear-gradient(180deg, #FFFFFF 0%, #F0F8F0 100%)'
          : '#FFFFFF',
        border: `${s.borderWidth}px solid ${s.borderColor}`,
        borderRadius: 12,
        padding: isCeo ? '18px 16px' : 14,
        minWidth: isCeo ? 240 : tier >= 3 ? 160 : 180,
        maxWidth: isCeo ? 280 : 220,
        boxShadow: '0 4px 14px rgba(31,27,22,0.08)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <div
          style={{
            width: isCeo ? 44 : tier === 1 ? 40 : 36,
            height: isCeo ? 44 : tier === 1 ? 40 : 36,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: isCeo ? 14 : tier === 1 ? 13 : 12,
            fontWeight: 500,
            color: '#FFFFFF',
            background: s.avatarBg,
            flexShrink: 0,
          }}
        >
          {initials}
        </div>
        <div>
          <span
            style={{
              fontSize: 9,
              letterSpacing: '0.18em',
              fontWeight: 500,
              padding: '2px 8px',
              borderRadius: 999,
              display: 'inline-block',
              background: s.tagBg,
              color: s.tagColor,
            }}
          >
            {role}
          </span>
        </div>
      </div>
      <div
        style={{
          fontSize: isCeo ? 15 : tier === 1 ? 14 : 13,
          fontWeight: 500,
          color: '#1F1B16',
          lineHeight: 1.25,
        }}
      >
        {node.name}
      </div>
      <div
        style={{
          fontSize: 10,
          color: '#6B6660',
          fontFamily: 'SF Mono, Consolas, monospace',
          marginTop: 2,
        }}
      >
        {node.id}
      </div>
      {(reportCount > 0 || isCeo) && (
        <div
          style={{
            fontSize: 11,
            color: '#6B6660',
            marginTop: 6,
            paddingTop: 6,
            borderTop: '1px solid #F0EBDF',
            lineHeight: 1.4,
          }}
        >
          {isCeo && (
            <>{deptFull || 'Evergreen Shipping Agency Saudi Co.'}<br /></>
          )}
          {reportCount > 0 && (
            <span style={{ fontSize: 10, color: '#2D5F3F', fontWeight: 500 }}>
              ↓ {reportCount} direct report{reportCount === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Render the full chart given tiers. Used both for the inline modal
// view and for the exportable HTML — the export path serialises
// each NodeCard via React's renderToStaticMarkup.
function ChartBody({ tiers, mode, totalEmployees }) {
  return (
    <div
      style={{
        fontFamily: '"Anthropic Sans", -apple-system, sans-serif',
        padding: '24px 0',
        background: '#FFFBF1',
        borderRadius: 16,
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 28, padding: '0 24px' }}>
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.28em',
            color: '#2D5F3F',
            fontWeight: 500,
          }}
        >
          EVERGREEN SHIPPING AGENCY SAUDI CO. (LLC)
        </div>
        <div style={{ fontSize: 22, color: '#1F1B16', fontWeight: 500, marginTop: 6 }}>
          Organization Chart
        </div>
        <div style={{ fontSize: 12, color: '#6B6660', marginTop: 4 }}>
          As of {new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
          {' · '}{totalEmployees} employee{totalEmployees === 1 ? '' : 's'}
          {' · '}{mode === 'summary' ? 'Summary view' : 'Full view'}
        </div>
      </div>

      {tiers.map((tier, tierIdx) => (
        <React.Fragment key={tierIdx}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              gap: tierIdx >= 3 ? 16 : 24,
              flexWrap: 'wrap',
              padding: '0 24px',
              rowGap: 24,
            }}
          >
            {tier.map(node => (
              <NodeCard key={node.id} node={node} tier={tierIdx} />
            ))}
          </div>
          {/* Connector strip between tiers — single thin tan vertical
              centred under the row, visible only when there's a next
              tier to draw. The strip is purely decorative; the actual
              parent-child relationship is implicit in tier ordering. */}
          {tierIdx < tiers.length - 1 && (
            <div
              style={{
                width: 1.5,
                height: 28,
                background: '#C49B61',
                opacity: 0.5,
                margin: '0 auto',
              }}
            />
          )}
        </React.Fragment>
      ))}

      <div
        style={{
          textAlign: 'center',
          marginTop: 24,
          padding: '12px 24px 0',
          borderTop: '1px solid #F0EBDF',
          fontSize: 10,
          color: '#9B928A',
          letterSpacing: '0.15em',
        }}
      >
        GENERATED FROM EVERGREEN HR PORTAL · esauhr.netlify.app
      </div>
    </div>
  );
}

// Generate a self-contained HTML string for download. Inlines all
// styles using styled spans rather than referencing external CSS, so
// the recipient can open the .html file offline and see the chart
// exactly as it appears in the portal. Uses the same NodeCard
// renderer via React's static-markup serialiser so the HTML output
// stays in sync with the live view automatically.
function buildStandaloneHtml(tiers, totalEmployees, mode) {
  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric',
  });
  // Render each tier to inline HTML strings. Cards use the same
  // styling logic as the live chart so the file is visually
  // identical to what's on screen.
  const renderCardHtml = (node, tier) => {
    const s = styleFor(node, tier);
    const initials = initialsOf(node.name, node.id);
    const role = roleLabel(node, tier);
    const reportCount = (node.children || []).length;
    const deptFull = DEPT_LABEL[node.department] || node.department || '';
    const isCeo = tier === 0;
    const cardStyle = [
      `background:${s.gradient ? 'linear-gradient(180deg,#FFFFFF 0%,#F0F8F0 100%)' : '#FFFFFF'}`,
      `border:${s.borderWidth}px solid ${s.borderColor}`,
      `border-radius:12px`,
      `padding:${isCeo ? '18px 16px' : '14px'}`,
      `min-width:${isCeo ? 240 : tier >= 3 ? 160 : 180}px`,
      `max-width:${isCeo ? 280 : 220}px`,
      `box-shadow:0 4px 14px rgba(31,27,22,0.08)`,
    ].join(';');
    const avatarSize = isCeo ? 44 : tier === 1 ? 40 : 36;
    const avatarFontSize = isCeo ? 14 : tier === 1 ? 13 : 12;
    const nameFontSize = isCeo ? 15 : tier === 1 ? 14 : 13;
    return `
    <div style="${cardStyle}" title="${escapeHtml(node.name)}\n${escapeHtml(node.id)}">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="width:${avatarSize}px;height:${avatarSize}px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:${avatarFontSize}px;font-weight:500;color:#FFFFFF;background:${s.avatarBg};flex-shrink:0;">${escapeHtml(initials)}</div>
        <div><span style="font-size:9px;letter-spacing:0.18em;font-weight:500;padding:2px 8px;border-radius:999px;display:inline-block;background:${s.tagBg};color:${s.tagColor};">${escapeHtml(role)}</span></div>
      </div>
      <div style="font-size:${nameFontSize}px;font-weight:500;color:#1F1B16;line-height:1.25;">${escapeHtml(node.name || '')}</div>
      <div style="font-size:10px;color:#6B6660;font-family:SF Mono,Consolas,monospace;margin-top:2px;">${escapeHtml(node.id || '')}</div>
      ${(reportCount > 0 || isCeo) ? `
      <div style="font-size:11px;color:#6B6660;margin-top:6px;padding-top:6px;border-top:1px solid #F0EBDF;line-height:1.4;">
        ${isCeo ? `${escapeHtml(deptFull || 'Evergreen Shipping Agency Saudi Co.')}<br/>` : ''}
        ${reportCount > 0 ? `<span style="font-size:10px;color:#2D5F3F;font-weight:500;">↓ ${reportCount} direct report${reportCount === 1 ? '' : 's'}</span>` : ''}
      </div>
      ` : ''}
    </div>`;
  };

  const tiersHtml = tiers.map((tier, tierIdx) => `
    <div style="display:flex;justify-content:center;gap:${tierIdx >= 3 ? 16 : 24}px;flex-wrap:wrap;padding:0 24px;row-gap:24px;">
      ${tier.map(node => renderCardHtml(node, tierIdx)).join('\n')}
    </div>
    ${tierIdx < tiers.length - 1 ? `<div style="width:1.5px;height:28px;background:#C49B61;opacity:0.5;margin:0 auto;"></div>` : ''}
  `).join('\n');

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
    }
  </style>
</head>
<body>
  <div class="org-shell" style="max-width: 1100px; margin: 0 auto; background: #FFFBF1; border-radius: 16px; box-shadow: 0 8px 32px rgba(31,27,22,0.10); padding: 24px 0; font-family: 'Calibri','Segoe UI',Arial,sans-serif;">
    <div style="text-align:center;margin-bottom:28px;padding:0 24px;">
      <div style="font-size:10px;letter-spacing:0.28em;color:#2D5F3F;font-weight:500;">EVERGREEN SHIPPING AGENCY SAUDI CO. (LLC)</div>
      <div style="font-size:22px;color:#1F1B16;font-weight:500;margin-top:6px;">Organization Chart</div>
      <div style="font-size:12px;color:#6B6660;margin-top:4px;">As of ${today} · ${totalEmployees} employee${totalEmployees === 1 ? '' : 's'} · ${mode === 'summary' ? 'Summary view' : 'Full view'}</div>
    </div>
    ${tiersHtml}
    <div style="text-align:center;margin-top:24px;padding:12px 24px 0;border-top:1px solid #F0EBDF;font-size:10px;color:#9B928A;letter-spacing:0.15em;">
      GENERATED FROM EVERGREEN HR PORTAL · esauhr.netlify.app
    </div>
  </div>
</body>
</html>`;
}

// Tiny HTML-escape helper for the static export. The live chart
// uses React which auto-escapes; the standalone export builds raw
// strings so it needs explicit escaping to prevent injection.
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Trigger a browser download for the given HTML content. Creates a
// Blob, an object URL, and a synthetic anchor click — same pattern
// used elsewhere in the portal for docx/pdf exports.
function downloadHtmlFile(html, filename) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke the URL on the next tick so the browser has finished the
  // download dialog by the time we clean up.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Public component. Rendered as a fullscreen modal — wraps the chart
// in a card with toolbar (mode toggle + download + close) and a
// scrollable body so wide tiers don't push the toolbar off-screen.
export default function OrgChartView({ employees, onClose }) {
  const [mode, setMode] = useState('summary');
  const tree = useMemo(() => buildTree(employees || []), [employees]);
  const allTiers = useMemo(() => flattenTiers(tree), [tree]);
  // Summary cuts off at three tiers (CEO + DJVPs + their reports).
  // Anything deeper rolls up into a "↓ N reports" count on the
  // tier-2 cards rather than rendering its own row.
  const tiers = useMemo(() => (
    mode === 'summary' ? allTiers.slice(0, 3) : allTiers
  ), [allTiers, mode]);
  const totalEmployees = (employees || []).filter(e => e?.employment_status !== 'left').length;

  const handleDownload = useCallback(() => {
    const html = buildStandaloneHtml(tiers, totalEmployees, mode);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadHtmlFile(html, `esau_org_chart_${mode}_${stamp}.html`);
  }, [tiers, totalEmployees, mode]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(15,31,26,0.55)',
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
          maxWidth: 1100,
          width: '100%',
          boxShadow: '0 24px 64px rgba(31,27,22,0.32)',
          marginBottom: 24,
        }}
      >
        {/* Toolbar — sticky-ish header with the mode toggle and
            download/close actions. Stays at the top of the modal so
            it's always visible even when the chart scrolls vertically. */}
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
            {/* Mode toggle. Two-button segmented control — keeps the
                summary/full distinction obvious without a dropdown. */}
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
                  boxShadow: mode === 'summary' ? '0 1px 3px rgba(31,27,22,0.12)' : 'none',
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
                  boxShadow: mode === 'full' ? '0 1px 3px rgba(31,27,22,0.12)' : 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <Users2 className="w-3.5 h-3.5" /> Full
              </button>
            </div>
            <button
              onClick={handleDownload}
              title="Download as standalone HTML"
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

        {/* Scrollable chart body. The full-mode chart can grow tall
            on a 28-employee company; the modal handles this with
            its own outer scroll. The horizontal overflow comes from
            the chart container itself when a tier is wider than
            the modal. */}
        <div style={{ overflowX: 'auto' }}>
          <ChartBody tiers={tiers} mode={mode} totalEmployees={totalEmployees} />
        </div>
      </div>
    </div>
  );
}
