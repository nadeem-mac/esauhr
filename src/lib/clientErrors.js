// ─── Client error reporter ─────────────────────────────────────────
//
// Tier 2 fix (#5 / item 1): centralised capture for runtime errors
// caught by React error boundaries and other top-level handlers. The
// goal is a paper trail — when something crashes for Bashaier, we
// want to be able to ask "what error, when, on which page" without
// requiring her to read the DevTools console.
//
// Two outputs:
//   1. Console — tagged with a stable session ID for cross-event
//      correlation. Always on.
//   2. localStorage ring buffer (last 50 events). Lets us inspect
//      historical errors on the same browser.
//
// No DB write. We're keeping this client-only for now — adding a
// `client_errors` table would close the loop but requires a migration
// and a write path that doesn't fail when the network is the source
// of the error. Defer until Tier 3.

const STORAGE_KEY = 'esauhr_client_errors_v1';
const MAX_BUFFER = 50;

// Stable per-session id — generated on first import, persisted to
// sessionStorage so it survives navigations within the tab but
// resets on tab close. Helps correlate multiple errors from the same
// session.
function getSessionId() {
  try {
    let sid = window.sessionStorage.getItem('esauhr_session_id');
    if (!sid) {
      sid = 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      window.sessionStorage.setItem('esauhr_session_id', sid);
    }
    return sid;
  } catch {
    return 's_unknown';
  }
}

/**
 * reportClientError — log an error with structured context.
 *
 * @param {object} args
 * @param {string} args.label    — surface-area label (e.g. "Monthly attendance calendar")
 * @param {Error}  args.error    — the caught error
 * @param {object} [args.info]   — React error info ({ componentStack }) when from a boundary
 * @param {string} [args.kind]   — e.g. 'boundary' (default), 'unhandled_rejection', 'mailto_failed'
 * @param {object} [args.extra]  — any extra context (e.g. { uploadId, csvDate })
 */
export function reportClientError({ label, error, info, kind = 'boundary', extra }) {
  const sessionId = getSessionId();
  const event = {
    sessionId,
    timestamp: new Date().toISOString(),
    kind,
    label: label || null,
    message: error?.message || String(error),
    stack: error?.stack ? String(error.stack).split('\n').slice(0, 12).join('\n') : null,
    componentStack: info?.componentStack ? String(info.componentStack).split('\n').slice(0, 12).join('\n') : null,
    url: (typeof window !== 'undefined' && window.location) ? window.location.pathname + window.location.search : null,
    userAgent: (typeof navigator !== 'undefined') ? navigator.userAgent : null,
    extra: extra || null,
  };

  // 1) Console — tagged for filtering in DevTools.
  try {
    // eslint-disable-next-line no-console
    console.error(`[esauhr/${kind}]`, sessionId, event.label || '', event.message, event);
  } catch { /* ignore */ }

  // 2) localStorage ring buffer.
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.unshift(event);
    while (arr.length > MAX_BUFFER) arr.pop();
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(arr));
  } catch { /* localStorage may be unavailable (private mode, full); non-fatal */ }

  return sessionId;
}

/**
 * getRecentClientErrors — read the buffered events back. Used by the
 * "Report this issue" dialog to let the user copy a paper trail.
 */
export function getRecentClientErrors() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * clearClientErrors — wipe the buffer. Called from settings if needed.
 */
export function clearClientErrors() {
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

/**
 * installGlobalHandlers — one-time setup that wires the reporter to
 * window.onerror and window.onunhandledrejection. Call once at app
 * boot so async failures (e.g. promise rejections in event handlers
 * that bypass React's boundary) are still captured.
 */
let installed = false;
export function installGlobalHandlers() {
  if (installed) return;
  installed = true;
  try {
    window.addEventListener('error', (ev) => {
      reportClientError({
        kind: 'window_error',
        label: ev?.filename || null,
        error: ev?.error || new Error(ev?.message || 'window error'),
      });
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev?.reason;
      const err = (reason instanceof Error) ? reason : new Error(String(reason || 'unhandled rejection'));
      reportClientError({
        kind: 'unhandled_rejection',
        label: null,
        error: err,
      });
    });
  } catch { /* ignore */ }
}

export const __sessionId = getSessionId;
