// pdfmake browser font setup — synchronous, no network.
//
// We import Roboto from pdfmake's built-in vfs_fonts and Amiri from
// pre-encoded base64 modules in ./fonts/. Everything is wired up at
// module load time, so by the time any caller runs createPdf(),
// pdfMake.vfs and pdfMake.fonts are guaranteed populated.
//
// Why pre-encoded instead of fetch:
//   • No 404 risk if Netlify caching or a service worker misbehaves.
//   • No async race between font fetch and createPdf().
//   • The TTFs sit inside the main JS bundle — gzip squeezes the
//     base64 well, and they're only loaded the first time HR opens
//     a page that imports a letter generator.

import pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';
import { AMIRI_REGULAR_BASE64 } from './fonts/amiriRegular.js';
import { AMIRI_BOLD_BASE64 }    from './fonts/amiriBold.js';

// --- VFS normalization across pdfmake versions ---
//
// pdfmake 0.2.20's vfs_fonts.js ends with `module.exports = vfs`, so the
// default ES-module import gives us the VFS *object itself* — a flat
// map { "Roboto-Regular.ttf": "<base64>", ... }. Older builds wrapped
// it as { pdfMake: { vfs } } or { vfs }. We accept every shape so a
// future pdfmake bump won't silently break things.
function resolveRobotoVfs(mod) {
  if (!mod) return null;
  if (mod.pdfMake?.vfs) return mod.pdfMake.vfs;
  if (mod.vfs) return mod.vfs;
  if (mod.default?.pdfMake?.vfs) return mod.default.pdfMake.vfs;
  if (mod.default?.vfs) return mod.default.vfs;
  if (mod.default && typeof mod.default === 'object') return mod.default;
  if (typeof mod === 'object') return mod;
  return null;
}

const robotoVfs = resolveRobotoVfs(pdfFonts);

// Always materialize a real, writable VFS object.
if (!pdfMake.vfs || typeof pdfMake.vfs !== 'object') {
  pdfMake.vfs = {};
}
if (robotoVfs && typeof robotoVfs === 'object') {
  Object.assign(pdfMake.vfs, robotoVfs);
}
pdfMake.vfs['Amiri-Regular.ttf'] = AMIRI_REGULAR_BASE64;
pdfMake.vfs['Amiri-Bold.ttf']    = AMIRI_BOLD_BASE64;

pdfMake.fonts = {
  Roboto: {
    normal:      'Roboto-Regular.ttf',
    bold:        'Roboto-Medium.ttf',
    italics:     'Roboto-Italic.ttf',
    bolditalics: 'Roboto-MediumItalic.ttf',
  },
  Amiri: {
    normal: 'Amiri-Regular.ttf',
    bold:   'Amiri-Bold.ttf',
  },
};

// Sanity self-check at load time — surfaced once via console so any
// future regression shows up in dev tools instead of a silent hang.
if (!pdfMake.vfs['Roboto-Regular.ttf']) {
  // eslint-disable-next-line no-console
  console.error('[pdfFontLoader] Roboto VFS missing — pdfmake will hang on createPdf().');
}
if (!pdfMake.vfs['Amiri-Regular.ttf']) {
  // eslint-disable-next-line no-console
  console.error('[pdfFontLoader] Amiri VFS missing — Arabic text will fail to render.');
}

// Kept as a no-op for backwards compatibility with the old async API.
// Existing callers do `await ensureFontsLoaded()` before createPdf();
// the await now resolves immediately because everything is already
// wired synchronously above.
export async function ensureFontsLoaded() {
  return pdfMake;
}

// Wrap pdfmake's callback-style getBlob in a Promise with a timeout.
//
// pdfmake 0.2.x has a long-standing failure mode where, if anything
// goes sideways during PDF rendering (font reference mismatch, bad
// image data URL, malformed docDef), the getBlob callback is silently
// never invoked. The download button then sits on "Generating…"
// forever. A 30-second timeout converts that hang into a thrown
// error the calling modal can show to the user.
export function createPdfBlob(docDef, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(
        'PDF generation timed out after ' + (timeoutMs / 1000) +
        's. Check the browser console for pdfmake errors.'
      ));
    }, timeoutMs);

    try {
      pdfMake.createPdf(docDef).getBlob((blob) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!blob) {
          reject(new Error('pdfmake returned an empty blob.'));
          return;
        }
        resolve(blob);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}

export default pdfMake;
