// Helpers that set up a realistic world purely through the public API:
// registration → training → verification request → admin approval → on duty.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/server.js';
import { totp, newTotpSecret } from '../server/security.js';

export const ADMIN = { email: 'admin@test.betibachao.app', password: 'correct-horse-battery-1', mfaSecret: newTotpSecret() };
export const HER = { lat: 15.8281, lng: 78.0373 };
export const PASSWORD = 'test-password-123';
export const TRAINING = ['code-of-conduct', 'de-escalation', 'emergency-calling', 'privacy', 'safe-handover'];

export async function boot(dataFile = null, extraEnv = {}) {
  const dir = dataFile ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  const file = dataFile || path.join(dir, 'db.json');
  const app = createServer({ env: { DATA_FILE: file, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ADMIN_MFA_SECRET: ADMIN.mfaSecret, RATE_LIMIT_MULTIPLIER: '50', ...extraEnv }, tickMs: 50 });
  await new Promise((r) => app.server.listen(0, r));
  return { app, file, dir, origin: `http://127.0.0.1:${app.server.address().port}`, base: `http://127.0.0.1:${app.server.address().port}/api/v1` };
}

export function client(base) {
  let cookie = '';
  const call = async (method, p, body, { csrf = true } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-BB-CSRF': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return {
    call,
    login: (email, password = PASSWORD, extra = {}) => call('POST', '/auth/login', { email, password, ...extra }),
    register: (displayName, email, role) => call('POST', '/auth/register', { displayName, email, role, password: PASSWORD, countryCode: 'IN', consent: true }),
    adminLogin: () => call('POST', '/auth/login', { email: ADMIN.email, password: ADMIN.password, mfaCode: totp(ADMIN.mfaSecret) }),
  };
}

const offset = (km, brg) => {
  const R = 6371.0088, b = (brg * Math.PI) / 180, d = km / R, la = (HER.lat * Math.PI) / 180, lo = (HER.lng * Math.PI) / 180;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: +((la2 * 180) / Math.PI).toFixed(6), lng: +((lo2 * 180) / Math.PI).toFixed(6), accuracyM: 15 };
};

// Registers a volunteer, completes training, requests verification, gets approved by admin, goes on duty `km` away.
export async function onboardVolunteer(base, admin, name, email, km, brg = 45) {
  const v = client(base);
  await v.register(name, email, 'volunteer');
  for (const m of TRAINING) await v.call('POST', '/volunteer/training', { moduleId: m });
  await v.call('POST', '/volunteer/verification', { contactPhone: '+91 90000 00000', area: 'Kurnool' });
  const me = (await v.call('GET', '/me')).body.user;
  const r = await admin.call('POST', `/admin/volunteers/${me.id}/review`, { decision: 'APPROVE' });
  if (r.status !== 200) throw new Error('approve failed ' + JSON.stringify(r.body));
  await v.call('PATCH', '/volunteer/availability', { available: true, location: offset(km, brg) });
  return v;
}

export async function world(base) {
  const admin = client(base);
  const a = await admin.adminLogin();
  if (a.status !== 200) throw new Error('admin login failed ' + JSON.stringify(a.body));
  const user = client(base);
  await user.register('Aamani', 'aamani@test.betibachao.app', 'user');
  const asha = await onboardVolunteer(base, admin, 'Asha', 'asha@test.betibachao.app', 3, 40);
  const ravi = await onboardVolunteer(base, admin, 'Ravi', 'ravi@test.betibachao.app', 7.5, 200);
  const meena = await onboardVolunteer(base, admin, 'Meena', 'meena@test.betibachao.app', 14, 120);
  const pending = client(base);
  await pending.register('Kiran', 'kiran@test.betibachao.app', 'volunteer'); // never approved
  return { admin, user, asha, ravi, meena, pending };
}
export { totp };
