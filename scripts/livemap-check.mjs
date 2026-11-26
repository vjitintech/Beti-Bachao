// Checks the live map + gliding radar on all three screens (woman, volunteer, operator/admin).
// Volunteers move closer between screenshots; map tiles are served locally (no network).
// Usage: node scripts/livemap-check.mjs [outDir] [tilePng]
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { boot, world, HER, ADMIN, PASSWORD, totp } from '../test/helpers.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || '/tmp';
const tile = process.argv[3] && fs.existsSync(process.argv[3]) ? fs.readFileSync(process.argv[3]) : null;
const S = await boot(); const W = await world(S.base);
const step = (s) => console.log('✓', s);
const off = (km, brg) => {
  const R = 6371.0088, b = (brg * Math.PI) / 180, d = km / R, la = (HER.lat * Math.PI) / 180, lo = (HER.lng * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: +((la2 * 180) / Math.PI).toFixed(6), lng: +((lo2 * 180) / Math.PI).toFixed(6), accuracyM: 15 };
};
async function cookieFor(email, password = PASSWORD, extra = {}) {
  const r = await fetch(S.base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BB-CSRF': '1' }, body: JSON.stringify({ email, password, ...extra }) });
  const [nv] = (r.headers.get('set-cookie') || '').split(';'); const i = nv.indexOf('=');
  return { name: nv.slice(0, i), value: nv.slice(i + 1), url: S.origin };
}
const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'map-1', location: { ...HER, accuracyM: 12, source: 'gps' } });
const id = sos.body.incident?.id || sos.body.id;
const asg = {};
for (const [name, c] of [['asha', W.asha], ['ravi', W.ravi]]) {
  const a = await c.call('POST', `/incidents/${id}/accept`, {});
  asg[name] = a.body.assignment?.id || a.body.id;
  await c.call('POST', `/assignments/${asg[name]}/status`, { status: 'EN_ROUTE' });
}
step(`SOS ${id.slice(0, 8)} with two volunteers en route`);

const browser = await chromium.launch(); const errs = [];
async function page(cookie, viewport = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2, geolocation: { latitude: HER.lat, longitude: HER.lng, accuracy: 12 }, permissions: ['geolocation'] });
  await ctx.addCookies([cookie]);
  await ctx.route('https://tile.openstreetmap.org/**', (r) => (tile ? r.fulfill({ status: 200, contentType: 'image/png', body: tile }) : r.abort()));
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/tile|favicon|maps\.google/i.test(m.text())) errs.push(m.text()); });
  return p;
}
const markerPos = (p) => p.$$eval('.lm-pin:not(.lm-her)', (els) => els.map((e) => e.style.transform));
const etaTexts = (p) => p.$$eval('[data-live="eta"]', (els) => els.map((e) => e.textContent));

// Woman
const her = await page(await cookieFor('aamani@test.betibachao.app'));
await her.goto(`${S.origin}/#/incident/${id}`);
await her.waitForSelector('.livemap .leaflet-container', { timeout: 15000 });
await her.waitForSelector('.lm-pin:not(.lm-her)', { state: 'attached' });
await her.waitForTimeout(1500);
await her.evaluate(() => document.querySelector('.track-card').scrollIntoView({ block: 'start' }));
await her.waitForTimeout(800);
await her.screenshot({ path: `${out}/lm-1-woman-map.png` });
const before = await markerPos(her), eta1 = await etaTexts(her);
// Asha rides closer: two location updates
await W.asha.call('PATCH', '/volunteer/availability', { available: true, location: off(2, 40) });
await W.ravi.call('PATCH', '/volunteer/availability', { available: true, location: off(6, 200) });
await her.waitForTimeout(7000);
const mid = await markerPos(her);
await her.waitForTimeout(3500);
const after = await markerPos(her), eta2 = await etaTexts(her);
await her.screenshot({ path: `${out}/lm-2-woman-map-moved.png` });
console.log('  markers before', before, '\n  markers after ', after, '\n  eta', eta1, '→', eta2);
if (JSON.stringify(before) === JSON.stringify(after)) throw new Error('markers did not move');
if (JSON.stringify(mid) === JSON.stringify(after) && JSON.stringify(mid) === JSON.stringify(before)) throw new Error('no glide observed');
if (!eta2.some((t) => /^\d+:\d\d$|min|arriving/.test(t))) throw new Error('ETA not counting down: ' + eta2);
step('woman: live map with responders gliding + ETA countdown');
await her.click('[data-act="track-view"][data-v="radar"]');
await her.waitForSelector('.ppi-box:not([hidden]) .ppi');
await her.waitForTimeout(500);
const g1 = await her.$$eval('[data-mv]', (els) => els.map((e) => e.getAttribute('transform') || ''));
await W.asha.call('PATCH', '/volunteer/availability', { available: true, location: off(1.2, 40) });
await her.waitForTimeout(6500);
const g2 = await her.$$eval('[data-mv]', (els) => els.map((e) => e.getAttribute('transform') || ''));
await her.evaluate(() => document.querySelector('.ppi-box').scrollIntoView({ block: 'center' }));
await her.screenshot({ path: `${out}/lm-3-woman-radar.png` });
console.log('  radar transforms', g1, '→', g2);
step('woman: radar view still works (map/radar switch)');

// Volunteer
const vol = await page(await cookieFor('asha@test.betibachao.app'));
await vol.goto(`${S.origin}/#/volunteer`);
await vol.waitForSelector('.track-card .leaflet-container', { timeout: 15000 });
await vol.waitForTimeout(1500);
await vol.evaluate(() => document.querySelector('.track-card').scrollIntoView({ block: 'start' }));
await vol.waitForTimeout(500);
await vol.screenshot({ path: `${out}/lm-4-volunteer.png` });
step('volunteer: team map');

// Admin (operator console)
const ad = await page(await cookieFor(ADMIN.email, ADMIN.password, { mfaCode: totp(ADMIN.mfaSecret) }), { width: 1280, height: 900 });
await ad.goto(`${S.origin}/#/ops`);
await ad.waitForSelector('.ops-detail .leaflet-container', { timeout: 15000 });
await ad.waitForTimeout(1500);
await ad.evaluate(() => document.querySelector('.ops-detail .livemap').scrollIntoView({ block: 'center' }));
await ad.waitForTimeout(500);
await ad.screenshot({ path: `${out}/lm-5-operator.png` });
const opsItems = await ad.$$eval('.ops-detail .lm-pin', (e) => e.length);
console.log('  operator map pins:', opsItems);
step('operator: live map with her, responders and alerted volunteers');

// Tiles fail → Google map fallback (its blocked-tile errors are expected)
const errsBefore = errs.length;
const fb = await page(await cookieFor('aamani@test.betibachao.app'));
await fb.context().unroute('https://tile.openstreetmap.org/**');
await fb.context().route('https://tile.openstreetmap.org/**', (r) => r.abort());
await fb.goto(`${S.origin}/#/incident/${id}`);
let fbFails = 0; fb.on('requestfailed', (r) => { if (r.url().includes('tile.openstreetmap')) fbFails++; });
try { await fb.waitForSelector('.livemap iframe', { state: 'attached', timeout: 20000 }); }
catch (e) { console.log('tile failures', fbFails, await fb.evaluate(() => document.querySelector('.livemap')?.innerHTML.slice(0, 200))); throw e; }
step('tiles unavailable → falls back to the Google map');
errs.length = errsBefore;

console.log('errors:', errs);
await browser.close(); process.exit(errs.length ? 1 : 0);
