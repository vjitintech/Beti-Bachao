// Browser end-to-end test of the real flows (headless Chromium via Playwright).
//   node scripts/smoke.mjs [--shots]
// Accounts are created through the real API (registration → training →
// verification request → admin approval); people then sign in through the UI.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { boot, world, ADMIN, PASSWORD, totp } from '../test/helpers.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = process.argv.includes('--shots');
const outDir = path.resolve('screenshots');
if (SHOTS) fs.mkdirSync(outDir, { recursive: true });
const S = await boot();
const W = await world(S.base);
await W.admin.call('POST', '/admin/staff', { displayName: 'Nandini', email: 'ops@test.betibachao.app', role: 'operator', password: 'temp-password-1234' });
const base = S.origin + '/';

const errors = [];
const browser = await chromium.launch();
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true };
async function page(name, opts = mobile) {
  const p = await (await browser.newContext(opts)).newPage();
  p.on('console', (m) => { if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`); });
  p.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  return p;
}
const shot = async (p, n) => { if (SHOTS) await p.screenshot({ path: path.join(outDir, `${n}.png`), fullPage: true }); };
async function signIn(p, email, password = PASSWORD, mfa = null) {
  await p.goto(base + '#/login');
  await p.fill('[name="email"]', email);
  await p.fill('[name="password"]', password);
  await p.click('[data-form="login"] button[type="submit"]');
  if (mfa) {
    await p.waitForSelector('.mfa:not(.hidden)');
    const enrol = await p.$('.mfa-enroll:not(.hidden)');
    const secret = enrol ? (await p.textContent('.mfa-secret')).replace(/\s/g, '') : mfa;
    await p.fill('[name="mfaCode"]', totp(secret));
    await p.click('[data-form="login"] button[type="submit"]');
  }
  await p.waitForFunction(() => !location.hash.startsWith('#/login'), null, { timeout: 10000 });
}
const step = (s) => console.log('✓', s);

try {
  const anon = await page('anon');
  await anon.goto(base);
  await anon.waitForSelector('.hero');
  if (await anon.$('.demo-banner')) throw new Error('demo banner still present');
  await shot(anon, '01-landing'); step('landing renders, no demo banner');
  await anon.goto(base + '#/login');
  await anon.waitForSelector('[data-form="login"]');
  if (await anon.$('[data-act="demo-login"]')) throw new Error('demo login buttons still present');
  step('login page has no demo accounts');

  const user = await page('user');
  await user.context().grantPermissions(['geolocation']);
  await user.context().setGeolocation({ latitude: 15.8281, longitude: 78.0373, accuracy: 12 });
  await signIn(user, 'aamani@test.betibachao.app');
  await user.waitForSelector('#sos-btn');
  await shot(user, '02-home'); step('woman signs in with her own account');

  const box = await (await user.$('#sos-btn')).boundingBox();
  await user.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await user.mouse.down(); await user.waitForTimeout(3300); await user.mouse.up();
  await user.waitForFunction(() => location.hash.startsWith('#/incident/'), null, { timeout: 15000 });
  await user.waitForSelector('.status-hero');
  const hero = await user.textContent('.status-hero');
  if (!/10 km/.test(hero)) throw new Error('expected 10 km stage: ' + hero);
  await shot(user, '03-incident'); step('hold-to-SOS with real device GPS → 10 km search');

  const vol = await page('volunteer');
  await signIn(vol, 'asha@test.betibachao.app');
  await vol.waitForSelector('.sos-incoming');
  if ((await vol.content()).includes('15.8281')) throw new Error('unassigned volunteer page leaked exact coordinates');
  await vol.click('.sos-incoming');
  await vol.click('[data-act="vol-accept"]');
  await vol.waitForSelector('.precise');
  await vol.click('[data-act="vol-status"]');
  await vol.waitForSelector('.ppi');
  await shot(vol, '04-volunteer'); step('approved volunteer gets alert, accepts, sees route + radar');

  const op = await page('operator', { viewport: { width: 1280, height: 900 } });
  await signIn(op, 'ops@test.betibachao.app', 'temp-password-1234', 'enrol');
  await op.waitForSelector('.ppi-grid');
  await shot(op, '05-operator'); step('new operator enrols authenticator at first login, sees radars');

  await user.waitForFunction(() => document.querySelector('.status-hero')?.className.includes('AMBER'), null, { timeout: 15000 });
  await user.click('[data-act="are-you-safe"]');
  await user.click('[data-modal="YES"]');
  await user.click('[data-modal="confirm"]');
  await user.waitForFunction(() => document.querySelector('.status-hero')?.className.includes('GREEN'), null, { timeout: 10000 });
  await shot(user, '06-safe'); step('explicit YES → confirm closes incident GREEN');
  await user.waitForSelector('.rate-form');
  await user.check('.rate-form input[name="stars"][value="5"]');
  await user.click('.rate-form button');
  await user.waitForFunction(() => document.body.innerText.includes('thank you'));
  step('she rates the volunteer after closing');

  const nv = await page('new-volunteer');
  await nv.goto(base + '#/register?as=volunteer');
  await nv.fill('[name="displayName"]', 'Lata');
  await nv.fill('[name="email"]', 'lata@test.betibachao.app');
  await nv.fill('[name="phone"]', '+919812345678');
  await nv.fill('[name="password"]', 'a-good-password-1');
  await nv.check('[name="consent"]');
  await nv.click('[data-form="register"] button[type="submit"]');
  await nv.waitForSelector('.onb');
  if (await nv.$('[data-act="vol-avail"]')) throw new Error('unapproved volunteer can go on duty');
  for (let i = 0; i < 5; i++) { await nv.click('.onb [data-act="vol-train"]'); await nv.check('.modal [name="ack"]'); await nv.click('[data-modal="done"]'); await nv.waitForTimeout(300); }
  await nv.click('[data-act="vol-verify"]');
  await nv.fill('.modal [name="phone"]', '+919812345678');
  await nv.click('[data-modal="ok"]');
  await nv.waitForFunction(() => document.body.innerText.includes('Waiting for the admin to book'));
  await shot(nv, '08-volunteer-onboarding'); step('new volunteer: training + verification request, duty locked');

  const adm = await page('admin', { viewport: { width: 1280, height: 900 } });
  await signIn(adm, ADMIN.email, ADMIN.password, ADMIN.mfaSecret);
  await adm.click('[data-tab="staff"]');
  await adm.waitForFunction(() => document.body.innerText.includes('Nandini'));
  await adm.click('[data-tab="volunteers"]');
  await adm.waitForSelector('[data-act="adm-call"]');
  await adm.click('[data-act="adm-call"]');
  await adm.click('[data-modal="go"]');
  await adm.waitForFunction(() => document.body.innerText.includes('Join'));
  await adm.click('[data-act="adm-approve"]');
  await adm.check('.modal [name="front"]'); await adm.check('.modal [name="back"]'); await adm.check('.modal [name="face"]');
  await adm.fill('.modal [name="last4"]', '4321');
  await adm.click('[data-modal="go"]');
  await adm.waitForFunction(() => document.body.innerText.includes('XXXX-XXXX-4321'));
  await shot(adm, '07b-admin-volunteers'); step('admin books video call and approves with Aadhaar checklist (masked)');
  await adm.click('[data-tab="audit"]');
  await adm.waitForFunction(() => document.body.innerText.includes('intact'));
  await shot(adm, '07-admin'); step('admin: staff list + intact audit chain');

  // ---- autonomous protection screens ----
  await adm.click('[data-tab="stations"]');
  await adm.fill('[name="csv"]', 'name,district,lat,lng,phone\nKurnool I Town PS,Kurnool,15.8306,78.0451,+918518000001');
  await adm.click('[data-form="stations"] button');
  await adm.waitForFunction(() => document.body.innerText.includes('1 stations loaded'));
  await adm.click('[data-tab="impact"]');
  await adm.waitForSelector('svg.chart');
  await shot(adm, '08-admin-impact'); step('admin: police station import + impact dashboard with chart');

  await user.goto(base + '#/places');
  await user.click('[data-act="place-new"]');
  await user.click('[data-act="place-here"]');
  await user.waitForFunction(() => document.body.innerText.includes('Set:'));
  await user.fill('[name="label"]', 'Home');
  for (const [i, n] of ['Amma', 'Akka', 'Neighbour'].entries()) {
    if (i > 0) await user.click('[data-form="place"] [data-act="row-add"]');
    await user.locator('[data-form="place"] [name="cname"]').nth(i).fill(n); await user.locator('[data-form="place"] [name="cphone"]').nth(i).fill(`+9190000001${i}0`);
  }
  if (await user.locator('[data-form="place"] [data-act="row-add"]').isVisible()) throw new Error('+ button should hide at 3 contacts');
  await user.click('[data-form="place"] button.btn-primary');
  await user.waitForFunction(() => document.body.innerText.includes('You are at Home'));
  await user.locator('[data-form="important"] [name="cname"]').first().fill('Maa'); await user.locator('[data-form="important"] [name="cphone"]').first().fill('+919000000999');
  await user.click('[data-form="important"] [data-act="row-add"]');
  await user.locator('[data-form="important"] [name="cname"]').nth(1).fill('Papa'); await user.locator('[data-form="important"] [name="cphone"]').nth(1).fill('+919000000998');
  await user.click('[data-form="important"] button.btn-primary');
  await user.waitForFunction(() => document.body.innerText.includes('Maa, Papa'));
  await shot(user, '09-places'); step('places: 3–5 contacts per place, active place detected from location');
  await user.goto(base + '#/home');
  await user.waitForFunction(() => document.body.innerText.includes('SOS goes to your Home contacts'));
  step('home shows who the SOS goes to here');
  await user.goto(base + '#/trip');
  await user.selectOption('[name="dest"]', 'link');
  await user.fill('[name="where"]', 'https://maps.google.com/?q=15.8600,78.0600'); await user.fill('[name="label"]', 'College');
  await user.fill('[name="minutes"]', '20'); await user.fill('[name="vehicle"]', 'AP39TX1234');
  await user.click('[data-form="trip"] button');
  await user.waitForFunction(() => document.body.innerText.includes('On the way to College'));
  const link = await user.textContent('.phrase');
  await shot(user, '10-trip'); step('Track my travel started with vehicle number');
  const fam = await page('family');
  await fam.goto(link.trim());
  await fam.waitForFunction(() => document.body.innerText.includes("trip to College"));
  await shot(fam, '11-trip-family'); step('family opens the live trip link without logging in');
  await user.click('[data-act="trip-safe"]');
  await user.waitForFunction(() => document.body.innerText.includes('reached safely'));
  await user.goto(base + '#/help');
  await user.waitForFunction(() => document.body.innerText.includes('Kurnool I Town PS'));
  await shot(user, '12-help'); step('nearby help lists the nearest police station');
  await user.goto(base + '#/dashboard');
  await user.waitForSelector('svg.meter');
  await shot(user, '13-dashboard'); step('her safety dashboard');

  const cam = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const bctx = await cam.newContext({ ...mobile, permissions: ['camera'] });
  for (const c of await user.context().cookies()) await bctx.addCookies([c]);
  const bp = await bctx.newPage();
  bp.on('console', (m) => { if (m.type() === 'error') errors.push(`[blink] ${m.text()}`); });
  bp.on('pageerror', (e) => errors.push(`[blink] ${e.message}`));
  await bp.goto(base + '#/blink');
  await bp.waitForFunction(() => /Looking for your face|Ready/.test(document.getElementById('blink-status')?.textContent || ''), null, { timeout: 60000 });
  await shot(bp, '14-blink'); step('Blink SOS: on-device face model loads and runs on the camera (no face in fake feed)');
  await cam.close();

  const reg = await page('register');
  await reg.goto(base + '#/register');
  await reg.fill('[name="displayName"]', 'New Person');
  await reg.fill('[name="email"]', 'new@test.betibachao.app');
  await reg.fill('[name="phone"]', '+919876543210');
  await reg.fill('[name="password"]', 'a-good-password-1');
  await reg.check('[name="consent"]');
  await reg.click('[data-form="register"] button[type="submit"]');
  await reg.waitForSelector('#sos-btn');
  step('self-registration with consent works');
} catch (e) {
  console.error('✗', e.message);
  process.exitCode = 1;
} finally {
  const real = errors.filter((e) => !/status of 401|maps\.google|ERR_|net::/i.test(e));
  if (real.length) { console.error('Browser errors:\n' + real.join('\n')); process.exitCode = 1; } else console.log('✓ no browser console errors / CSP violations');
  await browser.close();
  S.app.server.close();
}
