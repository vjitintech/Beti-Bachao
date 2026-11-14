// Checks "Search my nearest police station" on the Places screen (simulated Android phone).
import { createRequire } from 'node:module';
import { boot, world, HER } from '../test/helpers.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || '/tmp';
const S = await boot(); const W = await world(S.base);
const add = (b) => W.admin.call('POST', '/admin/police-stations/one', b);
console.log((await add({ name: 'kurnool III town', district: 'Kurnool', country: 'IN', lat: HER.lat + 0.01, lng: HER.lng, phone: '08518 223456', phone2: '94407 95555' })).status);
console.log((await add({ name: 'Kurnool Taluk PS', district: 'Kurnool', country: 'IN', lat: HER.lat + 0.05, lng: HER.lng, phone: '08518 220000' })).status);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: { latitude: HER.lat, longitude: HER.lng, accuracy: 12 }, permissions: ['geolocation'] });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
await p.goto(S.origin + '/#/register'); await p.waitForSelector('[data-form="register"]');
await p.fill('[name="displayName"]', 'Priya'); await p.fill('[name="email"]', 'priya2@example.com');
await p.selectOption('[name="phone_cc"]', 'IN'); await p.fill('[name="phone"]', '98765 43219');
await p.fill('[name="password"]', 'my-safe-password-1'); await p.check('input[name="role"][value="user"]'); await p.check('[name="consent"]');
await p.click('[data-form="register"] button[type="submit"]');
await p.waitForSelector('[data-form="perm-setup"], #sos-btn', { timeout: 15000 });
if (await p.$('[data-form="perm-setup"]')) { await p.click('[data-form="perm-setup"] button.btn-primary'); await p.waitForSelector('#sos-btn'); }
await p.goto(S.origin + '/#/places'); await p.waitForSelector('[data-form="important"]');
await p.locator('[data-form="important"] [name="cname"]').first().fill('Amma');
await p.locator('[data-form="important"] [name="cphone"]').first().fill('94400 12345');
await p.click('[data-form="important"] button.btn-primary'); await p.waitForTimeout(800);
await p.evaluate(() => document.querySelector('.station-note')?.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
await p.screenshot({ path: `${out}/st-note.png` });
await p.click('[data-act="station-contact"]'); await p.waitForSelector('.modal select[name="pick"]');
console.log('options:', await p.$$eval('.modal select[name="pick"] option', (o) => o.map((x) => x.textContent)));
console.log('dests:', await p.$$eval('.modal select[name="dest"] option', (o) => o.map((x) => x.textContent)));
await p.selectOption('.modal select[name="pick"]', { index: 1 });
await p.screenshot({ path: `${out}/st-modal.png` });
await p.click('[data-modal="add"]'); await p.waitForTimeout(1000);
console.log('saved:', JSON.stringify((await W.user.call('GET', '/me/contacts')).body));
// adding the same number again must be refused (same-group duplicate)
await p.click('[data-act="station-contact"]'); await p.waitForSelector('.modal select[name="pick"]');
await p.selectOption('.modal select[name="pick"]', { index: 1 }); await p.click('[data-modal="add"]'); await p.waitForTimeout(600);
console.log('toast:', await p.$$eval('#toasts > *', (t) => t.map((x) => x.textContent)));
console.log('errors:', errs);
await browser.close(); await S.stop?.(); process.exit(0);
