// Screens for the app-update feature: website download card, old app (amber), latest app (green).
import { createRequire } from 'node:module';
import { boot, HER } from '../test/helpers.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || '/tmp';
const S = await boot(null, { APK_LATEST_BUILD: '45' });
const browser = await chromium.launch(); const errs = [];
async function phone(build) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: { latitude: HER.lat, longitude: HER.lng, accuracy: 12 }, permissions: ['geolocation'] });
  if (build) await ctx.addInitScript(({ server, build }) => {
    localStorage.setItem('bb.server', server); window.BB_APP_BUILD = build;
    const secure = {}; const perms = { location: 'granted', sms: 'granted', notifications: 'granted' };
    const impl = { secureGet: ({ key }) => ({ value: secure[key] || null }), secureSet: ({ key, value }) => { secure[key] = value; return {}; }, permissionStatus: () => perms, requestPermissions: () => perms, sendSos: () => ({ sent: 1 }), takeLaunchAction: () => null, takeLastCrash: () => ({ crash: null }), getPushToken: () => null, screenReader: () => ({ on: false }) };
    const plugin = new Proxy({}, { get: (_, m) => async (a = {}) => (impl[m] ? impl[m](a) : {}) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { BetiNative: plugin } };
  }, { server: S.origin, build });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message)); return p;
}
const web = await phone(null);
await web.goto(S.origin + '/#/'); await web.waitForSelector('.apk-card .ver-chip', { timeout: 10000 });
await web.evaluate(() => document.querySelector('.apk-card').scrollIntoView({ block: 'center' })); await web.waitForTimeout(300);
await web.screenshot({ path: `${out}/upd-web.png` });
await web.goto(S.origin + '/download'); await web.waitForSelector('#apk-ver:not([hidden])'); await web.screenshot({ path: `${out}/upd-download.png` });
let n = 0;
for (const [build, tag] of [['1.0.40 (abc1234)', 'old'], ['1.0.45 (def5678)', 'new']]) {
  const p = await phone(build); n++;
  await p.goto(S.origin + '/#/register'); await p.waitForSelector('[data-form="register"]');
  await p.fill('[name="displayName"]', 'Priya'); await p.fill('[name="email"]', `u${n}@example.com`);
  await p.selectOption('[name="phone_cc"]', 'IN'); await p.fill('[name="phone"]', `98765 4321${n}`);
  await p.fill('[name="password"]', 'my-safe-password-1'); await p.check('input[name="role"][value="user"]'); await p.check('[name="consent"]');
  await p.click('[data-form="register"] button[type="submit"]');
  await p.waitForSelector('[data-form="perm-setup"], #sos-btn', { timeout: 15000 });
  if (await p.$('[data-form="perm-setup"]')) { await p.click('[data-form="perm-setup"] button.btn-primary'); await p.waitForSelector('#sos-btn'); }
  await p.waitForTimeout(3500);
  console.log(tag, 'banner on home:', !!(await p.$('.app-update')), 'toasts:', await p.$$eval('#toasts > *', (t) => t.map((x) => x.textContent)));
  await p.evaluate(() => document.querySelectorAll('#toasts > *').forEach((t) => t.remove()));
  await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(200); console.log(tag, 'topbar:', await p.$eval('.topbar-right', (e) => e.textContent.replace(/\s+/g, ' ').slice(-20)), 'nav:', !!(await p.$('.bottom-nav')));
  if (tag === 'old') await p.screenshot({ path: `${out}/upd-home-old.png` });
  await p.goto(S.origin + '/#/settings'); await p.waitForSelector('.app-version .ver-chip.ver-' + tag, { timeout: 10000 });
  await p.evaluate(() => document.querySelector('.app-version').scrollIntoView({ block: 'center' })); await p.waitForTimeout(300);
  await p.evaluate(() => document.querySelectorAll('#toasts > *').forEach((t) => t.remove()));
  await p.screenshot({ path: `${out}/upd-settings-${tag}.png` });
}
console.log('errors:', errs);
await browser.close(); process.exit(0);
