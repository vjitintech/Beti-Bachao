// Browser end-to-end smoke test (headless Chromium via Playwright).
//   node scripts/smoke.mjs            → server mode (boots the demo server)
//   node scripts/smoke.mjs --shots    → also writes screenshots to ./screenshots
import { createRequire } from 'node:module';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { createServer } from '../server/server.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.argv.includes('--shots');
const outDir = path.resolve('screenshots');
if (SHOTS) fs.mkdirSync(outDir, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-smoke-'));
const app = createServer({ env: { DEMO_MODE: 'true', DATA_FILE: path.join(tmp, 'db.json') } });
await new Promise((r) => app.server.listen(0, r));
const base = `http://127.0.0.1:${app.server.address().port}/`;

const errors = [];
const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, permissions: [] };
async function ctx(name, opts = mobile) {
  const c = await browser.newContext(opts);
  const p = await c.newPage();
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  return p;
}
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: path.join(outDir, `${n}.png`), fullPage: true }); };
const login = async (p, email) => {
  await p.goto(base + '#/login');
  await p.waitForSelector(`[data-email="${email}"]`);
  await p.click(`[data-email="${email}"]`);
  await p.waitForFunction(() => !location.hash.startsWith('#/login'));
};
const step = (s) => console.log('✓', s);

try {
  const user = await ctx('user');
  await user.goto(base);
  await user.waitForSelector('.hero');
  await shot(user, '01-landing'); step('landing renders');

  await login(user, 'priya@demo.betibachao.app');
  await user.waitForSelector('#sos-btn');
  await shot(user, '02-home'); step('user home with SOS button');

  const box = await (await user.$('#sos-btn')).boundingBox();
  await user.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await user.mouse.down();
  await user.waitForTimeout(3300);
  await user.mouse.up();
  await user.waitForFunction(() => location.hash.startsWith('#/incident/'), null, { timeout: 10000 });
  await user.waitForSelector('.status-hero');
  const incidentId = user.url().split('#/incident/')[1].split('?')[0];
  const heroText = await user.textContent('.status-hero');
  if (!/10 km/.test(heroText)) throw new Error('expected 10 km stage, got: ' + heroText);
  await shot(user, '03-incident-red'); step('hold-to-SOS created incident, 10 km search shown');

  const vol = await ctx('volunteer');
  await login(vol, 'asha@demo.betibachao.app');
  await vol.waitForSelector('.alert-item');
  const before = await vol.content();
  if (before.includes('15.8281') || before.includes('78.0373')) throw new Error('unassigned volunteer page leaked exact coordinates');
  await shot(vol, '04-volunteer-alert'); step('volunteer sees alert with approximate area only');
  await vol.click('[data-act="vol-accept"]');
  await vol.waitForSelector('.precise');
  await vol.click('[data-act="vol-status"]');
  await vol.waitForFunction(() => document.body.innerText.includes("I've arrived"));
  await shot(vol, '05-volunteer-assigned'); step('volunteer accepted, sees precise location, en route');

  const op = await ctx('operator', { viewport: { width: 1280, height: 900 } });
  await login(op, 'operator@demo.betibachao.app');
  await op.waitForSelector('.ops-detail');
  await op.waitForSelector('.radar');
  const opText = await op.textContent('.ops-detail');
  if (!/Asha/.test(opText)) throw new Error('operator does not see assignment');
  await shot(op, '06-operator'); step('operator console with radar and responders (MFA auto-filled in demo)');

  await user.waitForFunction(() => document.querySelector('.status-hero')?.className.includes('AMBER'), null, { timeout: 15000 });
  await shot(user, '07-incident-amber'); step('user sees AMBER "help is on the way" with responder ETA');

  await user.click('[data-act="more-help"]');
  await user.waitForSelector('.alert-warn');
  step('NEED MORE HELP escalates (simulated label shown)');

  await user.click('[data-act="are-you-safe"]');
  await user.click('[data-modal="YES"]');
  await user.click('[data-modal="confirm"]');
  await user.waitForFunction(() => document.querySelector('.status-hero')?.className.includes('GREEN'), null, { timeout: 10000 });
  await shot(user, '08-incident-green'); step('explicit YES → confirm closes incident GREEN');

  await user.goto(base + '#/home');
  await user.selectOption('#lang-select', 'te');
  await user.waitForFunction(() => document.documentElement.lang === 'te');
  await shot(user, '09-telugu'); step('language switch to Telugu');
  await user.selectOption('#lang-select', 'ur');
  await user.waitForFunction(() => document.documentElement.dir === 'rtl');
  await shot(user, '10-urdu-rtl'); step('Urdu renders right-to-left');
  await user.selectOption('#lang-select', 'en');

  const adm = await ctx('admin', { viewport: { width: 1280, height: 900 } });
  await login(adm, 'admin@demo.betibachao.app');
  await adm.click('[data-tab="audit"]');
  await adm.waitForFunction(() => document.body.innerText.includes('intact'));
  await shot(adm, '11-admin-audit'); step('admin audit log hash chain intact');

  await user.goto(base + '#/tools');
  await user.waitForSelector('[data-form="safewalk"]');
  await shot(user, '12-tools'); step('safety tools page');
  console.log('incident', incidentId);
} catch (e) {
  console.error('✗', e.message);
  process.exitCode = 1;
} finally {
  const real = errors.filter((e) => !/geolocation|Permission|NotAllowedError|favicon|status of 401/i.test(e));
  if (real.length) { console.error('Browser errors:\n' + real.join('\n')); process.exitCode = 1; } else console.log('✓ no browser console errors / CSP violations');
  await browser.close();
  app.server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
