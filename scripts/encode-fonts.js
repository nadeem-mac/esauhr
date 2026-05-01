#!/usr/bin/env node
// Regenerate src/lib/fonts/amiri{Regular,Bold}.js from public/fonts/.
// Run this manually after replacing the Amiri TTF files:
//   node scripts/encode-fonts.js
//
// We pre-encode at build time so pdfmake never has to fetch the
// fonts at runtime — no 404 risk, no service-worker interference,
// no async race with pdfMake.createPdf().

const fs = require('fs');
const path = require('path');

const targets = [
  { src: 'public/fonts/Amiri-Regular.ttf', dst: 'src/lib/fonts/amiriRegular.js', name: 'AMIRI_REGULAR_BASE64' },
  { src: 'public/fonts/Amiri-Bold.ttf',    dst: 'src/lib/fonts/amiriBold.js',    name: 'AMIRI_BOLD_BASE64' },
];

const ROOT = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(ROOT, 'src/lib/fonts'), { recursive: true });

for (const { src, dst, name } of targets) {
  const buf = fs.readFileSync(path.join(ROOT, src));
  const b64 = buf.toString('base64');
  let body = `// Auto-generated from ${src}\n`;
  body += `// DO NOT EDIT — regenerate with scripts/encode-fonts.js if Amiri changes.\n`;
  body += `export const ${name} =\n`;
  for (let i = 0; i < b64.length; i += 100) {
    const chunk = b64.slice(i, i + 100);
    body += `  ${JSON.stringify(chunk)}${i + 100 < b64.length ? ' +\n' : ';\n'}`;
  }
  fs.writeFileSync(path.join(ROOT, dst), body);
  console.log(`wrote ${dst} (${(buf.length / 1024).toFixed(1)} KB → ${(b64.length / 1024).toFixed(1)} KB base64)`);
}
