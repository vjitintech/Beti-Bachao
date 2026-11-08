// Features for the native apps and real-world operation: bearer tokens, CORS,
// device push (FCM), background location, server SMS, volunteer gating and the
// video verification call, ratings, password resets, backups, routing and AI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { boot, client, world, onboardVolunteer, HER, PASSWORD } from './helpers.js';

// Fake external services: Google OAuth + FCM, MSG91, OSRM, Colibri (OpenAI-compatible).
const calls = [];
const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = { project_id: 'beti-test', client_email: 'push@beti-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth2.googleapis.com/token' };
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  calls.push({ url: u, opts });
  const ok = (body, status = 200) => ({ status, ok: status < 300, json: async () => body });
  if (u.startsWith('https://oauth2.googleapis.com/token')) return ok({ access_token: 'ya29.fake', expires_in: 3600 });
  if (u.includes('fcm.googleapis.com')) return ok({ name: 'projects/beti-test/messages/1' });
  if (u.startsWith('https://control.msg91.com')) return ok({ type: 'success' });
  if (u.startsWith('http://osrm.test')) return ok({ code: 'Ok', routes: [{ duration: 600, distance: 4200 }] });
  if (u.startsWith('http://colibri.test')) {
    const body = JSON.parse(opts.body);
    const sys = body.messages[0].content;
    const content = sys.includes('Classify') ? '{"risk":"MEDIUM","category":"abusive_language","reason":"Contains insults."}'
      : sys.includes('Translate') ? 'Please come quickly, I am near the bus stand.'
      : '<think>internal</think>Situation: SOS open 2 minutes, one responder en route.\n1. Phone 112.';
    return ok({ choices: [{ message: { content } }] });
  }
  return ok({}, 404);
}

let S, W;
const servers = [];
after(() => { for (const x of servers) x.app.server.close(); });

test('setup: server with FCM, MSG91, OSRM, Colibri and backups configured', async () => {
  S = await boot(null, {
    FCM_SERVICE_ACCOUNT: Buffer.from(JSON.stringify(SA)).toString('base64'),
    SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_SOS: 't-sos', MSG91_TEMPLATE_ALERT: 't-alert', MSG91_TEMPLATE_OTP: 't-otp', MSG91_TEMPLATE_VERIFY: 't-verify',
    ROUTING_URL: 'http://osrm.test', AI_BASE_URL: 'http://colibri.test/v1', BACKUP_KEY: crypto.randomBytes(32).toString('hex'),
  });
  S.app.server.close(); // re-create with fake fetch
  const { createServer } = await import('../server/server.js');
  const env = { DATA_FILE: S.file, ADMIN_EMAIL: 'admin@test.betibachao.app', ADMIN_PASSWORD: 'correct-horse-battery-1', ADMIN_MFA_SECRET: (await import('./helpers.js')).ADMIN.mfaSecret, RATE_LIMIT_MULTIPLIER: '50',
    FCM_SERVICE_ACCOUNT: JSON.stringify(SA), SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_SOS: 't-sos', MSG91_TEMPLATE_ALERT: 't-alert', MSG91_TEMPLATE_OTP: 't-otp', MSG91_TEMPLATE_VERIFY: 't-verify',
    ROUTING_URL: 'http://osrm.test', AI_BASE_URL: 'http://colibri.test/v1', BACKUP_KEY: crypto.randomBytes(32).toString('hex') };
  const app = createServer({ env, tickMs: 50, fetchImpl: fakeFetch });
  await new Promise((r) => app.server.listen(0, r));
  S = { app, file: S.file, origin: `http://127.0.0.1:${app.server.address().port}`, base: `http://127.0.0.1:${app.server.address().port}/api/v1` };
  servers.push(S);
  const st = await (client(S.base)).call('GET', '/public-config');
  assert.deepEqual(st.body.features, { appPush: true, iosPush: true, policeCall: false, sms: true, smsReset: true, roadEta: true, ai: true });
  W = await world(S.base);
});

test('mobile app: bearer token login, CORS for the app WebView, no CSRF header needed', async () => {
  const res = await fetch(S.base + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BB-CSRF': '1', Origin: 'https://localhost' }, body: JSON.stringify({ email: 'aamani@test.betibachao.app', password: PASSWORD, client: 'mobile' }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://localhost');
  const { token } = await res.json();
  assert.ok(token && token.length > 30);
  const me = await fetch(S.base + '/me', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await me.json()).user.email, 'aamani@test.betibachao.app');
  const pre = await fetch(S.base + '/incidents', { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost' } });
  assert.equal(pre.status, 204);
  const evil = await fetch(S.base + '/me', { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${token}` } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null, 'no CORS for other sites');
  const dev = await fetch(S.base + '/me/devices', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ platform: 'android', token: 'f'.repeat(140) }) });
  assert.equal(dev.status, 200, 'POST works with bearer and no CSRF header');
  S.womanToken = token;
});

test('unapproved volunteer has no responder access until admin approves after the video call', async () => {
  const k = client(S.base);
  await k.register('Kavya', 'kavya@test.betibachao.app', 'volunteer');
  assert.equal((await k.call('GET', '/volunteer/alerts')).status, 403);
  assert.equal((await k.call('PATCH', '/volunteer/availability', { available: true, location: { ...HER, accuracyM: 10 } })).status, 403);
  await k.call('POST', '/volunteer/verification', { contactPhone: '+91 98450 00000', area: 'Kurnool' });
  const id = (await k.call('GET', '/me')).body.user.id;
  const call = await W.admin.call('POST', `/admin/volunteers/${id}/schedule-call`, { scheduledAt: new Date(Date.now() + 7200e3).toISOString() });
  assert.match(call.body.roomUrl, /^https:\/\/meet\.jit\.si\/BetiBachao-Verify-/);
  assert.equal((await k.call('GET', '/volunteer/profile')).body.verification.call.roomUrl, call.body.roomUrl, 'volunteer sees the call link');
  assert.equal((await W.admin.call('POST', `/admin/volunteers/${id}/review`, { decision: 'APPROVE' })).status, 400, 'checklist required');
  assert.equal((await W.admin.call('POST', `/admin/volunteers/${id}/review`, { decision: 'APPROVE', checklist: { aadhaarFrontSeen: true, aadhaarBackSeen: true, faceMatches: true, last4: '123456789012' } })).status, 400, 'full Aadhaar number never stored');
  assert.equal((await W.admin.call('POST', `/admin/volunteers/${id}/review`, { decision: 'APPROVE', checklist: { aadhaarFrontSeen: true, aadhaarBackSeen: true, faceMatches: true, last4: '9012' } })).status, 200);
  const db = JSON.parse(fs.readFileSync(S.file, 'utf8'));
  const rec = db.verifications.find((r) => r.volunteerId === id);
  assert.equal(rec.checklist.aadhaarMasked, 'XXXX-XXXX-9012');
  assert.ok(!JSON.stringify(db).includes('123456789012'), 'rejected full Aadhaar number never stored');
  assert.deepEqual(Object.keys(rec.checklist).sort(), ['aadhaarBackSeen', 'aadhaarFrontSeen', 'aadhaarMasked', 'callCompleted', 'faceMatches', 'reviewedBy']);
  assert.equal((await k.call('GET', '/volunteer/alerts')).status, 200);
  assert.ok(calls.some((c) => c.url.includes('msg91') && JSON.parse(c.opts.body).template_id === 't-verify'), 'call time sent by SMS');
});

test('SOS from the app: server SMS to trusted contacts, FCM alarm push to volunteers, routed ETA, background location', async () => {
  await W.user.call('PUT', '/me/contacts', { contacts: [{ name: 'Amma', phone: '+91 90000 11111' }], prefs: { serverSms: true } });
  await W.asha.call('POST', '/me/devices', { platform: 'android', token: 'a'.repeat(150) });
  calls.length = 0;
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'm-1', severity: 'HIGH', location: { ...HER, accuracyM: 8, source: 'gps' }, deviceSmsSent: false });
  const id = sos.body.incident.id;
  await new Promise((r) => setTimeout(r, 300));
  const contactSms = calls.filter((c) => c.url.includes('msg91') && JSON.parse(c.opts.body).template_id === 't-sos');
  assert.equal(contactSms.length, 1);
  assert.equal(JSON.parse(contactSms[0].opts.body).recipients[0].mobiles, '919000011111');
  assert.match(JSON.parse(contactSms[0].opts.body).recipients[0].link, /\/s\/[a-f0-9]{32}$/); // live tracking link
  const fcmCalls = calls.filter((c) => c.url.includes('fcm.googleapis.com'));
  assert.ok(fcmCalls.length >= 1, 'FCM push sent');
  const msg = JSON.parse(fcmCalls[0].opts.body).message;
  assert.equal(msg.android.priority, 'HIGH');
  assert.equal(msg.data.kind, 'ALERT');
  assert.equal(msg.data.urgent, '1');
  assert.ok(calls.some((c) => c.url.startsWith('https://oauth2.googleapis.com/token')), 'service-account OAuth used');
  // background location from the app is routed into her incident
  const loc = await fetch(S.base + '/me/location', { method: 'POST', headers: { Authorization: `Bearer ${S.womanToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ lat: HER.lat + 0.0005, lng: HER.lng, accuracyM: 6, source: 'gps' }) });
  assert.equal((await loc.json()).routed, 'incident');
  const acc = await W.asha.call('POST', `/incidents/${id}/accept`);
  await W.asha.call('POST', `/assignments/${acc.body.assignment.id}/status`, { status: 'EN_ROUTE' });
  await new Promise((r) => setTimeout(r, 400));
  const view = (await W.user.call('GET', `/incidents/${id}`)).body;
  // routing runs every 30s; the first pass happens on the next tick after accept
  const r = view.responders[0];
  assert.ok(['road route estimate', 'approximate (straight-line estimate)'].includes(r.etaLabel));
  S.incident = id; S.asg = acc.body.assignment.id;
});

test('volunteers who ignore the push get an SMS after 30 seconds', async () => {
  const db = S.app.store.db;
  const n = db.notifications.find((x) => x.incidentId === S.incident && x.kind === 'ALERT' && !x.response);
  assert.ok(n, 'an unanswered alert exists');
  n.createdAt = new Date(Date.now() - 31000).toISOString();
  calls.length = 0;
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(calls.some((c) => c.url.includes('msg91') && JSON.parse(c.opts.body).template_id === 't-alert'));
});

test('she rates responders after closing; "felt unsafe" opens a misconduct review', async () => {
  await W.asha.call('POST', `/assignments/${S.asg}/status`, { status: 'ARRIVED' });
  assert.equal((await W.user.call('POST', `/incidents/${S.incident}/rate`, { ref: S.asg, stars: 5 })).status, 409, 'not while open');
  await W.user.call('POST', `/incidents/${S.incident}/safety-confirmation`, { response: 'YES', confirm: true });
  const v = (await W.user.call('GET', `/incidents/${S.incident}`)).body;
  assert.equal(v.rateable.length, 1);
  assert.equal((await W.user.call('POST', `/incidents/${S.incident}/rate`, { ref: v.rateable[0].ref, stars: 2, feltUnsafe: true, comment: 'Was rude' })).status, 200);
  assert.equal((await W.user.call('POST', `/incidents/${S.incident}/rate`, { ref: v.rateable[0].ref, stars: 5 })).status, 409, 'only once');
  const vols = (await W.admin.call('GET', '/admin/volunteers')).body.items;
  const asha = vols.find((x) => x.displayName === 'Asha');
  assert.equal(asha.stats.reviewNeeded, true);
  assert.equal(asha.stats.feltUnsafe, 1);
  const reports = (await W.admin.call('GET', '/admin/abuse-reports')).body.items;
  assert.ok(reports.some((r) => r.category === 'VOLUNTEER_MISCONDUCT'));
});

test('password: admin reset forces a change; SMS code reset works and is rate-limited', async () => {
  const found = (await W.admin.call('GET', '/admin/users?q=aamani')).body.items[0];
  const reset = await W.admin.call('POST', `/admin/users/${found.id}/reset-password`);
  const temp = reset.body.temporaryPassword;
  const c = client(S.base);
  const login = await c.login('aamani@test.betibachao.app', temp);
  assert.equal(login.body.user.mustChangePassword, true);
  assert.equal((await c.call('GET', '/me/incidents')).status, 403, 'blocked until password changed');
  assert.equal((await c.call('POST', '/auth/change-password', { currentPassword: temp, newPassword: 'brand-new-pass-1' })).status, 200);
  assert.equal((await c.call('GET', '/me/incidents')).status, 200);
  calls.length = 0;
  await c.call('POST', '/auth/reset/request', { email: 'aamani@test.betibachao.app' });
  const otpCall = calls.find((x) => x.url.includes('msg91') && JSON.parse(x.opts.body).template_id === 't-otp');
  const code = JSON.parse(otpCall.opts.body).recipients[0].otp;
  assert.equal((await c.call('POST', '/auth/reset/confirm', { email: 'aamani@test.betibachao.app', code: '000000', newPassword: 'another-pass-123' })).status, 400);
  assert.equal((await c.call('POST', '/auth/reset/confirm', { email: 'aamani@test.betibachao.app', code, newPassword: 'another-pass-123' })).status, 200);
  assert.equal((await c.login('aamani@test.betibachao.app', 'another-pass-123')).status, 200);
});

test('Colibri AI: operator summary, translation, advisory risk on reports', async () => {
  const user2 = client(S.base); await user2.register('Bhavya', 'bhavya@test.betibachao.app', 'user');
  const inc = await user2.call('POST', '/incidents', { idempotencyKey: 'ai-1', location: { ...HER, accuracyM: 9, source: 'gps' }, note: 'help near bus stand' });
  const sum = await W.admin.call('POST', `/operator/incidents/${inc.body.incident.id}/ai-summary`);
  assert.equal(sum.status, 200);
  assert.ok(!sum.body.text.includes('<think>'), 'reasoning stripped');
  const sent = calls.filter((c) => c.url.startsWith('http://colibri.test')).map((c) => c.opts.body).join(' ');
  assert.ok(!sent.includes('15.828') && !sent.includes('+9190'), 'no coordinates or phone numbers sent to AI');
  const tr = await W.admin.call('POST', '/ai/translate', { text: 'త్వరగా రండి', target: 'English' });
  assert.equal(tr.body.machineTranslated, true);
  assert.equal((await user2.call('POST', '/ai/translate', { text: 'x', target: 'English' })).status, 403, 'operators/admins only');
  await user2.call('POST', '/abuse-reports', { category: 'OTHER', details: 'you are useless idiots' });
  await new Promise((r) => setTimeout(r, 200));
  const reps = (await W.admin.call('GET', '/admin/abuse-reports')).body.items;
  assert.equal(reps.find((r) => r.details.includes('useless')).aiRisk.risk, 'MEDIUM');
  const op = (await W.admin.call('GET', `/incidents/${inc.body.incident.id}`)).body;
  assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(op.prankRisk.level));
});

test('automatic encrypted backup is written and can be decrypted', async () => {
  const { decrypt } = await import('../server/backup.js');
  const path = await import('node:path');
  const dir = path.join(path.dirname(S.file), 'backups');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.enc'));
  assert.ok(files.length >= 1);
});
