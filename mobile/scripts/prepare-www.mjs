// Copies the shared app screens (../public) into www/ and bakes in the server
// address: BB_SERVER_URL=https://your-server node scripts/prepare-www.mjs
import fs from 'node:fs';
import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname);
const src = path.resolve(here, '../../public');
const out = path.resolve(here, '../www');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(src, out, { recursive: true });
fs.rmSync(path.join(out, 'sw.js'), { force: true }); // apps ship their files; no web service worker
const server = (process.env.BB_SERVER_URL || '').replace(/\/$/, '');
fs.writeFileSync(path.join(out, 'config.js'), `window.BB_SERVER_URL = ${JSON.stringify(server)};\nwindow.BB_APP_BUILD = ${JSON.stringify(process.env.BB_APP_VERSION || 'dev')};\n`);
const idx = path.join(out, 'index.html');
let html = fs.readFileSync(idx, 'utf8');
html = html.replace('<script type="module"', '<script src="config.js"></script>\n  <script type="module"');
html = html.replace('<link rel="manifest" href="manifest.webmanifest">', '');
fs.writeFileSync(idx, html);
console.log(`www prepared (server: ${server || 'ask on first launch'})`);
