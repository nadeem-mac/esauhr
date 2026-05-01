// pdfmake browser font setup — synchronous, no network.
//
// Wires Roboto (from pdfmake's bundled vfs_fonts) and Amiri (from
// pre-encoded base64 modules in ./fonts/) into pdfmake at module
// load time, so any caller that runs createPdf() after this module
// is imported is guaranteed to have working fonts.

import pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';
import { AMIRI_REGULAR_BASE64 } from './fonts/amiriRegular.js';
import { AMIRI_BOLD_BASE64 }    from './fonts/amiriBold.js';

// --- VFS shape normalization ---
//
// pdfmake 0.2.20's vfs_fonts.js ends with `module.exports = vfs`, so
// the default ESM import gives us the VFS object directly — a flat
// map { "Roboto-Regular.ttf": "<base64>", ... }. Older builds wrapped
// it as { pdfMake: { vfs } } or { vfs }. Accept every shape so a
// future pdfmake bump won't break us silently.
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

const robotoVfs = resolveRobotoVfs(pdfFonts) || {};

// --- The crucial bit: use addVirtualFileSystem, NOT pdfMake.vfs ---
//
// In pdfmake 0.2.20 there's an internal VirtualFileSystem object with
// its own `dataSystem` map. createPdf() reads from THAT, not from
// pdfMake.vfs. Setting pdfMake.vfs = { ... } looks correct but pdfmake
// never consults it — getBlob then hangs/rejects with
// "File 'Amiri-Regular.ttf' not found in virtual file system".
//
// The actual API is pdfMake.addVirtualFileSystem(combinedVfs), which
// stores the map in the internal globalVfs and passes it to bindFS()
// when createPdf runs. The auto-init at the bottom of vfs_fonts.js
// would do this for us — but only if window.pdfMake is defined when
// the module loads, which doesn't happen in an ESM build because
// `import pdfMake` binds locally instead of going through window.
const combinedVfs = {
  ...robotoVfs,
  'Amiri-Regular.ttf': AMIRI_REGULAR_BASE64,
  'Amiri-Bold.ttf':    AMIRI_BOLD_BASE64,
};

if (typeof pdfMake.addVirtualFileSystem === 'function') {
  pdfMake.addVirtualFileSystem(combinedVfs);
} else {
  // Pre-0.2 fallback — set pdfMake.vfs and hope for the best.
  pdfMake.vfs = combinedVfs;
}

// pdfMake.fonts is read by createPdf() directly (not via the VFS),
// so plain assignment is correct here.
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
if (!combinedVfs['Roboto-Regular.ttf']) {
  // eslint-disable-next-line no-console
  console.error('[pdfFontLoader] Roboto VFS missing — pdfmake will fail.');
}
if (!combinedVfs['Amiri-Regular.ttf']) {
  // eslint-disable-next-line no-console
  console.error('[pdfFontLoader] Amiri VFS missing — Arabic text will fail.');
}

// Kept as a no-op for backwards compatibility with the old async API.
export async function ensureFontsLoaded() {
  return pdfMake;
}

// Wrap pdfmake's callback-style getBlob in a Promise with a timeout.
// pdfmake 0.2.x can silently never invoke the callback if anything
// goes sideways during PDF rendering. A 30s timeout converts that
// hang into a thrown error the calling modal can show to the user.
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
