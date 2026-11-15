// Simulated Android phone: Settings → SOS button pair / test / remove (no real Bluetooth).
import { createRequire } from 'node:module';
import { boot, HER } from '../test/helpers.js';
const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || '/tmp';
const S = await boot();
const browser = await chromium.launch(); const errs = [];
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, geolocation: { latitude: HER.lat, longitude: HER.lng, accuracy: 12 }, permissions: ['geolocation'] });
await ctx.addInitScript(({ server }) => {
  localStorage.setItem('bb.server', server); window.BB_APP_BUILD = '1.0.40 (abc1234)';
  const secure = {}; const perms = { location: 'granted', sms: 'granted', notifications: 'granted' };
  const bt = { supported: true, bluetoothOn: true, permission: true, paired: false, connected: false, battery: -1, name: null, address: null };
  const listeners = []; window.__bt = { bt, fire: (e) => listeners.forEach((f) => f(e)), calls: [] };
  const impl = { secureGet: ({ key }) => ({ value: secure[key] || null }), secureSet: ({ key, value }) => { secure[key] = value; return {}; }, permissionStatus: () => perms, requestPermissions: () => perms, sendSos: () => ({ sent: 1 }), takeLaunchAction: () => null, takeLastCrash: () => ({ crash: null }), getPushToken: () => null, screenReader: () => ({ on: false }),
    btState: () => ({ ...bt }),
    btScan: () => new Promise((r) => setTimeout(() => r({ devices: [{ address: 'FF:FF:10:20:AB:CD', name: 'iTAG', rssi: -50, likely: true }, { address: '11:22:33:44:55:66', name: 'Galaxy Buds', rssi: -70, likely: false }] }), 300)),
    btPair: ({ address, name }) => { Object.assign(bt, { paired: true, address, name }); setTimeout(() => { bt.connected = true; bt.battery = 87; }, 1200); return {}; },
    btForget: () => { Object.assign(bt, { paired: false, connected: false, address: null, name: null }); return {}; },
    btTest: (a) => { window.__bt.calls.push(['btTest', a.on]); return {}; }, btEnable: () => ({}),
    addListener: (name, cb) => { listeners.push(cb); return { remove() {} }; } };
  const plugin = new Proxy({}, { get: (_, m) => async (a = {}) => (impl[m] ? (m === 'addListener' ? impl[m](a, arguments[1]) : impl[m](a)) : {}) });
  const plugin2 = new Proxy({}, { get: (_, m) => (m === 'addListener' ? async (n, cb) => impl.addListener(n, cb) : async (a = {}) => (impl[m] ? impl[m](a) : {})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { BetiNative: plugin2 } };
}, { server: S.origin });
const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
await p.goto(S.origin + '/#/register'); await p.waitForSelector('[data-form="register"]');
await p.fill('[name="displayName"]', 'Priya'); await p.fill('[name="email"]', 'bt@example.com');
await p.selectOption('[name="phone_cc"]', 'IN'); await p.fill('[name="phone"]', '98765 43288');
await p.fill('[name="password"]', 'my-safe-password-1'); await p.check('input[name="role"][value="user"]'); await p.check('[name="consent"]');
await p.click('[data-form="register"] button[type="submit"]');
await p.waitForSelector('[data-form="perm-setup"], #sos-btn', { timeout: 15000 });
if (await p.$('[data-form="perm-setup"]')) { await p.click('[data-form="perm-setup"] button.btn-primary'); await p.waitForSelector('#sos-btn'); }
await p.goto(S.origin + '/#/settings'); await p.waitForSelector('.bt-card');
const shot = async (n) => { await p.evaluate(() => document.querySelectorAll('#toasts > *').forEach((t) => t.remove())); await p.evaluate(() => document.querySelector('.bt-card').scrollIntoView({ block: 'center' })); await p.waitForTimeout(250); await p.screenshot({ path: `${out}/bt-${n}.png` }); };
await shot('1-unpaired');
await p.click('[data-act="bt-pair"]'); await p.waitForSelector('.modal select[name="addr"]');
console.log('options:', await p.$$eval('.modal option', (o) => o.map((x) => x.textContent)));
await p.screenshot({ path: `${out}/bt-2-choose.png` });
await p.click('[data-modal="pair"]'); await p.waitForSelector('.bt-card .ver-new', { timeout: 15000 });
await shot('3-connected');
await p.click('[data-act="bt-test"]'); await p.waitForSelector('.modal [data-modal="stop"]');
await p.evaluate(() => window.__bt.fire({ type: 'press' })); await p.waitForTimeout(200);
await p.screenshot({ path: `${out}/bt-4-test.png` });
await p.evaluate(() => window.__bt.fire({ type: 'test-ok' })); await p.waitForTimeout(500);
console.log('modal closed after test:', !(await p.$('.modal')), 'toasts:', await p.$$eval('#toasts > *', (t) => t.map((x) => x.textContent)), 'btTest calls:', JSON.stringify(await p.evaluate(() => window.__bt.calls)));
await p.click('[data-act="bt-forget"]'); await p.click('.modal [data-modal="rm"]'); await p.waitForSelector('[data-act="bt-pair"]');
console.log('removed ok; errors:', errs);
await browser.close(); process.exit(0);
