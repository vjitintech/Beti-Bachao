// Runs the app's ANDROID code paths in headless Chromium with a simulated phone
// (window.Capacitor + the BetiNative plugin), to catch what a plain browser test can't:
// the first-run permission screen, the automatic police call, screens that redraw in a
// loop (flicker), and errors in native-only code.   node scripts/android-sim.mjs
import { createRequire } from 'node:module';
import { boot, world, HER, PASSWORD, totp, ADMIN } from '../test/helpers.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const S = await boot();
const W = await world(S.base);
const steps = []; const errors = []; const nativeCalls = [];
const step = (s) => { steps.push(s); console.log('✓', s); };
const fail = (m) => { throw new Error(m); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
  geolocation: { latitude: HER.lat, longitude: HER.lng, accuracy: 12 }, permissions: ['geolocation'] });
await ctx.exposeFunction('__nativeCall', (m, a) => { nativeCalls.push({ m, a }); });
await ctx.addInitScript(({ server }) => {
  localStorage.setItem('bb.server', server);
  const secure = {};
  const perms = { location: 'granted', locationAllTheTime: 'granted', sms: 'granted', 'microphone (voice SOS, evidence)': 'granted', notifications: 'granted', 'phone calls (police auto-call)': 'granted', fullScreenAlerts: 'allowed', batteryOptimisation: 'off (good)' };
  const impl = {
    secureGet: ({ key }) => ({ value: secure[key] || null }),
    secureSet: ({ key, value }) => { secure[key] = value; return {}; },
    permissionStatus: () => perms, requestPermissions: () => perms,
    sendSos: ({ numbers }) => ({ sent: (numbers || []).length }),
    placeCall: () => ({ placed: true }),
    takeLaunchAction: () => null, takeLastCrash: () => ({ crash: null }),
    getPushToken: () => null, screenReader: () => ({ on: false }),
  };
  const plugin = new Proxy({}, { get: (_, m) => async (a = {}) => { window.__nativeCall(String(m), JSON.parse(JSON.stringify(a || {}))); return impl[m] ? impl[m](a) : {}; } });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { BetiNative: plugin } };
}, { server: S.origin });

const p = await ctx.newPage();
p.on('pageerror', (e) => { if (!/Access is denied for this document/.test(e.message)) errors.push(e.message); }); // that one comes from the embedded Google map frame
p.on('console', (m) => { if (m.type() === 'error' && !/favicon|ERR_|net::|status of 401/.test(m.text())) errors.push(m.text()); });
// Flicker detector: counts full re-draws of the screen (#app innerHTML replaced).
await p.addInitScript(() => {
  window.__redraws = 0; window.__why = [];
  const d = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
  Object.defineProperty(Element.prototype, 'innerHTML', { set(v) { if (this.id === 'app') window.__why.push((new Error().stack || '').split('\n').slice(2, 6).join(' | ')); return d.set.call(this, v); }, get() { return d.get.call(this); } });
  document.addEventListener('DOMContentLoaded', () => new MutationObserver((ms) => { for (const m of ms) if (m.target.id === 'app' && m.type === 'childList' && m.addedNodes.length) window.__redraws++; })
    .observe(document.body, { childList: true, subtree: true }));
});
const redrawsIn = async (ms) => { const a = await p.evaluate(() => window.__redraws); await p.waitForTimeout(ms); return (await p.evaluate(() => window.__redraws)) - a; };

try {
  const put = await W.user.call('PUT', '/me/contacts', { contacts: [{ name: 'Amma', phone: '+919000000101' }, { name: 'Akka', phone: '+919000000102' }] });
  if (put.status !== 200) fail('could not save contacts ' + JSON.stringify(put.body));
  await p.goto(S.origin + '/#/login');
  await p.fill('[name="email"]', 'aamani@test.betibachao.app'); await p.fill('[name="password"]', PASSWORD);
  await p.click('[data-form="login"] button[type="submit"]');
  await p.waitForSelector('[data-form="perm-setup"]', { timeout: 15000 });
  if ((await p.locator('[data-form="perm-setup"] input[type="checkbox"]:not(:checked)').count()) !== 0) fail('all permissions should be on by default');
  step('first run in the app: "Set up your phone" with everything switched on');
  await p.click('[data-form="perm-setup"] button.btn-primary');
  await p.waitForSelector('#sos-btn');
  if (!nativeCalls.some((c) => c.m === 'requestPermissions' && (c.a.aliases || []).includes('phone'))) fail('phone-call permission not requested');
  step('permissions requested together (location, SMS, phone calls, microphone…) and Home opens');
  if (await p.locator('text=This browser can\'t receive SOS alerts').count()) fail('browser push warning shown inside the app');
  const idle = await redrawsIn(7000);
  if (idle > 1) fail(`home screen redraws by itself (${idle} in 7 s) — would flicker`);
  step(`home screen is steady (${idle} full redraws in 7 s)`);

  // Police station 2 km away, police connect after the minimum wait.
  await W.admin.call('POST', '/admin/police-stations/one', { name: 'Kurnool Test PS', country: 'IN', state: 'Andhra Pradesh', lat: HER.lat + 0.018, lng: HER.lng, phone: '08518 220100', phone2: '08518 220101' });
  await W.admin.call('PATCH', '/admin/config', { operatorAckSec: 5, policeAutoConnectSec: 8 });
  // Hold SOS.
  await p.evaluate(() => window.scrollTo(0, 0)); await p.locator('#sos-btn').scrollIntoViewIfNeeded();
  const b = await p.locator('#sos-btn').boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.waitForTimeout(600);
  await p.waitForTimeout(2700); await p.mouse.up();
  await p.waitForFunction(() => location.hash.startsWith('#/incident/'), null, { timeout: 15000 });
  if (!nativeCalls.some((c) => c.m === 'sendSos')) fail('SOS SMS not sent through the phone');
  step('SOS: SMS handed to the phone straight away');
  await p.waitForFunction(() => /Calling|called/.test(document.querySelector('.police-card')?.innerText || ''), null, { timeout: 30000 });
  await p.waitForTimeout(1500);
  const calls = nativeCalls.filter((c) => c.m === 'placeCall');
  if (calls.length !== 1) fail(`expected exactly 1 automatic call, got ${calls.length}: ${JSON.stringify(calls)}`);
  if (calls[0].a.number !== '+918518220100') fail(`called ${calls[0].a.number}, expected the station's first number`);
  step('police auto-connect: ONE automatic call, to the admin-loaded station\'s first number (+918518220100), not 1091 / 112');
  const sosRedraws = await redrawsIn(9000);
  if (sosRedraws > 1) console.log('WHY', JSON.stringify((await p.evaluate(() => window.__why)).slice(-4), null, 1));
  if (sosRedraws > 1) fail(`SOS screen redraws fully ${sosRedraws}× in 9 s — would flicker`);
  const toasts = await p.locator('#toasts .toast').allInnerTexts();
  if (new Set(toasts).size !== toasts.length || toasts.length > 3) fail(`repeated messages: ${JSON.stringify(toasts)}`);
  if ((nativeCalls.filter((c) => c.m === 'placeCall')).length !== 1) fail('police called more than once');
  step(`SOS screen steady (${sosRedraws} full redraws in 9 s), no repeated messages, police called once`);
  if (!(await p.locator('.cancel-zone [data-act="cancel-sos"]').isVisible())) fail('Cancel SOS not visible');
  // She is safe → straight to Home, no "SOS ended" screen.
  await p.click('[data-act="are-you-safe"]');
  await p.waitForSelector('.modal button:has-text("I am safe")');
  await p.locator('.modal button:has-text("I am safe")').first().click();
  if (await p.locator('.modal button:has-text("Confirm")').count()) await p.locator('.modal button:has-text("Confirm")').first().click();
  await p.waitForFunction(() => location.hash.startsWith('#/home'), null, { timeout: 15000 });
  if (await p.locator('text=This SOS has ended').count()) fail('"This SOS has ended" still shown');
  step('marked safe → straight back to Home (no "SOS ended" screen, no extra Home button)');
  if (errors.length) fail('page errors: ' + errors.join(' | '));
  step('no JavaScript errors in the Android code paths');
} catch (e) {
  console.error('✗', e.message, '\n  page errors:', errors.join(' | '), '\n  app errors:', JSON.stringify((S.app.store.db.clientErrors || []).slice(-3).map((x) => x.message + ' @ ' + x.stack.split('\n').slice(0, 3).join(' '))));
  await p.screenshot({ path: 'screenshots/android-sim-fail.png', fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close(); S.app.server.close(); setTimeout(() => process.exit(), 200);
}
