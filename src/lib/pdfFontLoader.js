// pdfmake browser font setup — runs once on first letter generation.
//
// pdfmake ships Roboto out-of-box (English). For Arabic we fetch the
// Amiri TTFs from /public/fonts/ at runtime, convert to base64, and
// inject into pdfMake.vfs. Cached after first fetch so subsequent
// letter generations are instant.
//
// Why this pattern:
//   • Keeps the main JS bundle small — Amiri is ~600KB total, only
//     loaded when an HR user actually generates a letter.
//   • No build-time TTF embedding needed (Vite handles /public/ as
//     static assets).
//   • Browser caches the TTF after first fetch, so even cross-session
//     loads are fast.

import pdfMake from 'pdfmake/build/pdfmake';
import pdfFonts from 'pdfmake/build/vfs_fonts';

// Wire up Roboto VFS that ships with pdfmake.
// vfs_fonts exports the VFS object directly in 0.2.x.
if (pdfFonts?.pdfMake?.vfs) {
  pdfMake.vfs = pdfFonts.pdfMake.vfs;
} else if (pdfFonts?.vfs) {
  pdfMake.vfs = pdfFonts.vfs;
}

let amiriPromise = null;

async function loadAmiri() {
  if (amiriPromise) return amiriPromise;
  amiriPromise = (async () => {
    const [reg, bold] = await Promise.all([
      fetch('/fonts/Amiri-Regular.ttf').then(r => r.arrayBuffer()),
      fetch('/fonts/Amiri-Bold.ttf').then(r => r.arrayBuffer()),
    ]);
    const toBase64 = (buf) => {
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    };
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
