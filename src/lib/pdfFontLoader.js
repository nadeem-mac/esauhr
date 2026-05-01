// pdfmake browser font setup — runs once on first letter generation.
//
// pdfmake ships Roboto out-of-box (English). For Arabic we fetch the
// Amiri TTFs from /public/fonts/ at runtime, convert to base64, and
// inject into pdfMake.vfs. Cached after first fetch so subsequent
// letter generations are instant.

import pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';

// --- VFS normalization across pdfmake versions ---
//
// pdfmake 0.2.20's vfs_fonts.js ends with `module.exports = vfs`, so the
// default ES-module import gives us the VFS *object itself* — a flat
// map like { "Roboto-Regular.ttf": "<base64>", ... }.
//
// Older builds wrapped it as { pdfMake: { vfs: {...} } } or { vfs: {...} },
// and some bundlers put the real export under `.default`. We accept all
// shapes so a future pdfmake bump doesn't silently break letter
// generation again.
function resolveRobotoVfs(mod) {
  if (!mod) return null;
  if (mod.pdfMake?.vfs) return mod.pdfMake.vfs;       // legacy wrapper
  if (mod.vfs) return mod.vfs;                         // some builds
  if (mod.default?.pdfMake?.vfs) return mod.default.pdfMake.vfs;
  if (mod.default?.vfs) return mod.default.vfs;
  if (mod.default && typeof mod.default === 'object') return mod.default;
  if (typeof mod === 'object') return mod;             // 0.2.20 — mod IS the vfs
  return null;
}

const robotoVfs = resolveRobotoVfs(pdfFonts);

// Make sure pdfMake.vfs exists as a real, writable object before
// anyone tries to mutate it. The original bug: pdfMake.vfs was
// undefined and writing pdfMake.vfs['Amiri-Regular.ttf'] threw
// "_s.vfs is undefined".
if (!pdfMake.vfs || typeof pdfMake.vfs !== 'object') {
  pdfMake.vfs = {};
}
if (robotoVfs && typeof robotoVfs === 'object') {
  Object.assign(pdfMake.vfs, robotoVfs);
}

let amiriPromise = null;

async function loadAmiri() {
  if (amiriPromise) return amiriPromise;
  amiriPromise = (async () => {
    const fetchTtf = async (url) => {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch ${url}: ${res.status} ${res.statusText}`);
      }
      return res.arrayBuffer();
    };

    const [reg, bold] = await Promise.all([
      fetchTtf('/fonts/Amiri-Regular.ttf'),
      fetchTtf('/fonts/Amiri-Bold.ttf'),
    ]);

    const toBase64 = (buf) => {
      const bytes = new Uint8Array(buf);
      let bin = '';
      // Chunk to avoid call-stack overflow on large TTFs (~300KB each)
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      return btoa(bin);
    };

    // Final guard — if some other module reset pdfMake.vfs between
    // top-level init and now, recreate it.
    if (!pdfMake.vfs || typeof pdfMake.vfs !== 'object') {
      pdfMake.vfs = {};
      if (robotoVfs) Object.assign(pdfMake.vfs, robotoVfs);
    }

    pdfMake.vfs['Amiri-Regular.ttf'] = toBase64(reg);
    pdfMake.vfs['Amiri-Bold.ttf']    = toBase64(bold);

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
  })();

  // If loading fails, clear the cache so the next click retries
  // instead of permanently rejecting with the stale error.
  amiriPromise.catch(() => { amiriPromise = null; });

  return amiriPromise;
}

// Public entrypoint — every letter generator awaits this before
// calling pdfMake.createPdf(...).
export async function ensureFontsLoaded() {
  await loadAmiri();
  return pdfMake;
}

// Re-export for convenience — callers can do
//   import pdfMake, { ensureFontsLoaded } from './pdfFontLoader.js';
export default pdfMake;
