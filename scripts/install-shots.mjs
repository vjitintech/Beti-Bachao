// Real app screenshots for the install guide (women + volunteers), taken in a simulated
// Android phone (same simulation as android-sim.mjs).   node scripts/install-shots.mjs <outdir>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { boot, world, HER, PASSWORD } from '../test/helpers.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const out = process.argv[2] || 'screenshots/install';
fs.mkdirSync(out, { recursive: true });
const S = await boot();
const W = await world(S.base);
const browser = await chromium.launch();

async function phone({ native = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, colorScheme: 'light',
    geolocation: { latitude: HER.lat, longitude: HER.lng, accuracy: 12 }, permissions: ['geolocation'] });
  if (native) await ctx.addInitScript(({ server }) => {
    localStorage.setItem('bb.server', server);
    const secure = {}; const perms = { location: 'granted', sms: 'granted', notifications: 'granted' };
    const impl = { secureGet: ({ key }) => ({ value: secure[key] || null }), secureSet: ({ key, value }) => { secure[key] = value; return {}; }, permissionStatus: () => perms, requestPermissions: () => perms, sendSos: () => ({ sent: 1 }), takeLaunchAction: () => null, takeLastCrash: () => ({ crash: null }), getPushToken: () => null, screenReader: () => ({ on: false }) };
    const plugin = new Proxy({}, { get: (_, m) => async (a = {}) => (impl[m] ? impl[m](a) : {}) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { BetiNative: plugin } };
  }, { server: S.origin });
  const p = await ctx.newPage();
  return p;
}
// Viewport-only shots (what the phone screen shows), clean: no toasts.
const shot = async (p, name, top = false) => { if (top) { await p.evaluate(() => window.scrollTo(0, 0)); await p.waitForTimeout(200); } await p.evaluate(() => { document.querySelectorAll('#toasts > *').forEach((t) => t.remove()); }); await p.waitForTimeout(250); await p.screenshot({ path: `${out}/${name}.png` }); console.log('📸', name); };
const scrollTo = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); if (e) window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 70); }, sel);

try {
  // Download page (web)
  const web = await phone({ native: false });
  await web.goto(S.origin + '/download'); await web.waitForTimeout(600);
  await shot(web, 'download-page');

  // ---------- Woman ----------
  const w = await phone();
  await w.goto(S.origin + '/#/'); await w.waitForTimeout(1200);
  await shot(w, 'w-welcome', true);
  await w.goto(S.origin + '/#/register'); await w.waitForSelector('[data-form="register"]');
  await w.fill('[name="displayName"]', 'Priya'); await w.fill('[name="email"]', 'priya@example.com');
  await w.selectOption('[name="phone_cc"]', 'IN'); await w.fill('[name="phone"]', '98765 43210');
  await w.fill('[name="password"]', 'my-safe-password-1'); await w.check('input[name="role"][value="user"]');
  await shot(w, 'w-register-1');
  await scrollTo(w, 'fieldset'); await w.check('[name="consent"]'); await shot(w, 'w-register-2');
  await w.click('[data-form="register"] button[type="submit"]');
  await w.waitForSelector('[data-form="perm-setup"]', { timeout: 15000 });
  await shot(w, 'w-permissions', true);
  await w.click('[data-form="perm-setup"] button.btn-primary'); await w.waitForSelector('#sos-btn');
  await w.goto(S.origin + '/#/places'); await w.waitForSelector('[data-form="important"]');
  await w.locator('[data-form="important"] [name="cname"]').first().fill('Amma');
  await w.locator('[data-form="important"] [name="cphone"]').first().fill('94400 12345');
  await w.click('[data-form="important"] [data-act="row-add"]');
  await w.locator('[data-form="important"] [name="cname"]').nth(1).fill('Papa');
  await w.locator('[data-form="important"] [name="cphone"]').nth(1).fill('94400 67890');
  await scrollTo(w, '[data-form="important"]'); await shot(w, 'w-contacts');
  await w.click('[data-form="important"] button.btn-primary'); await w.waitForTimeout(800);
  await w.goto(S.origin + '/#/home'); await w.waitForSelector('#sos-btn'); await w.waitForTimeout(800);
  await shot(w, 'w-home', true);

  // ---------- Volunteer ----------
  const v = await phone();
  await v.goto(S.origin + '/#/register?as=volunteer'); await v.waitForSelector('[data-form="register"]');
  await v.fill('[name="displayName"]', 'Ravi Kumar'); await v.fill('[name="email"]', 'ravi@example.com');
  await v.selectOption('[name="phone_cc"]', 'IN'); await v.fill('[name="phone"]', '91234 56789');
  await v.fill('[name="password"]', 'my-safe-password-1'); await v.check('input[name="role"][value="volunteer"]');
  await scrollTo(v, '[name="displayName"]'); await shot(v, 'v-register');
  await scrollTo(v, 'fieldset'); await v.check('[name="consent"]');
  await v.click('[data-form="register"] button[type="submit"]');
  await v.waitForSelector('[data-form="perm-setup"]', { timeout: 15000 });
  await shot(v, 'v-permissions', true);
  await v.click('[data-form="perm-setup"] button.btn-primary'); await v.waitForTimeout(1500);
  await shot(v, 'v-verify', true);
  // An approved, on-duty volunteer (Asha, already verified in the test world) with an SOS alert.
  const a = await phone();
  await a.goto(S.origin + '/#/login'); await a.fill('[name="email"]', 'asha@test.betibachao.app'); await a.fill('[name="password"]', PASSWORD);
  await a.click('[data-form="login"] button[type="submit"]');
  await a.waitForSelector('[data-form="perm-setup"]', { timeout: 15000 }); await a.click('[data-form="perm-setup"] button.btn-primary');
  await a.waitForTimeout(1500); await shot(a, 'v-on-duty', true);
  await W.user.call('PUT', '/me/contacts', { contacts: [{ name: 'Amma', phone: '+919000000101' }] });
  await W.user.call('POST', '/incidents', { idempotencyKey: 'shots-1', location: { ...HER, accuracyM: 10, source: 'gps', observedAt: new Date().toISOString() } });
  await a.waitForTimeout(4000); await a.goto(S.origin + '/#/volunteer'); await a.waitForTimeout(1800);
  await shot(a, 'v-alert', true);
} catch (e) { console.error('✗', e.message); process.exitCode = 1; }
finally { await browser.close(); S.app.server.close(); setTimeout(() => process.exit(), 200); }
