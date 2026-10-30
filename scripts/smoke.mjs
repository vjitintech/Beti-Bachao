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

  const adm = await page('admin', { viewport: { width: 1280, height: 900 } });
  await signIn(adm, ADMIN.email, ADMIN.password, ADMIN.mfaSecret);
  await adm.click('[data-tab="staff"]');
  await adm.waitForFunction(() => document.body.innerText.includes('Nandini'));
  await adm.click('[data-tab="audit"]');
  await adm.waitForFunction(() => document.body.innerText.includes('intact'));
  await shot(adm, '07-admin'); step('admin: staff list + intact audit chain');

  const reg = await page('register');
  await reg.goto(base + '#/register');
  await reg.fill('[name="displayName"]', 'New Person');
  await reg.fill('[name="email"]', 'new@test.betibachao.app');
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
