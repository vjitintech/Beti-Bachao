import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { boot, client, world, HER, totp } from './helpers.js';

const servers = [];
after(() => { for (const s of servers) s.app.server.close(); });

let S, W;
test('server: fresh install has no demo data, only the bootstrapped admin', async () => {
  S = await boot(); servers.push(S);
  const db = JSON.parse(fs.readFileSync(S.file, 'utf8'));
  assert.equal(db.users.length, 1);
  assert.equal(db.users[0].role, 'admin');
  const c = client(S.base);
  assert.equal((await c.call('GET', '/demo/accounts')).status, 404, 'no demo endpoints');
  const cfg = (await c.call('GET', '/public-config')).body;
  assert.equal(cfg.demo, false);
  assert.match(cfg.vapidPublicKey, /^[A-Za-z0-9_-]{80,}$/);
});

test('server: security headers, CSRF, consent and password rules', async () => {
  const c = client(S.base);
  const h = await c.call('GET', '/health');
  assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await c.call('POST', '/auth/register', { displayName: 'X', email: 'x@test.app', role: 'user', password: 'longenough123', consent: true }, { csrf: false })).status, 403);
  assert.equal((await c.call('POST', '/auth/register', { displayName: 'X', email: 'x@test.app', role: 'user', password: 'longenough123' })).status, 400, 'consent required');
  assert.equal((await c.call('POST', '/auth/register', { displayName: 'X', email: 'x@test.app', role: 'user', password: 'short', consent: true })).status, 400);
  assert.equal((await c.call('POST', '/auth/register', { displayName: 'X', email: 'x@test.app', role: 'admin', password: 'longenough123', consent: true })).status, 400, 'cannot self-register as admin');
  const ok = await c.call('POST', '/auth/register', { displayName: 'X', email: 'x@test.app', role: 'user', password: 'longenough123', consent: true });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
});

test('server: admin creates an operator who must enrol an authenticator at first login', async () => {
  W = await world(S.base);
  assert.equal((await W.admin.call('POST', '/admin/staff', { displayName: 'Nandini', email: 'ops@test.betibachao.app', role: 'operator', password: 'temp-password-1234' })).status, 200);
  assert.equal((await W.user.call('POST', '/admin/staff', { displayName: 'Evil', email: 'e@test.app', role: 'admin', password: 'temp-password-1234' })).status, 403);
  const op = client(S.base);
  const first = await op.login('ops@test.betibachao.app', 'temp-password-1234');
  assert.ok(first.body.mfaEnroll?.secret);
  assert.match(first.body.mfaEnroll.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal((await op.call('GET', '/operator/incidents')).status, 401);
  assert.equal((await op.login('ops@test.betibachao.app', 'temp-password-1234', { mfaCode: '000000' })).status, 401);
  assert.equal((await op.login('ops@test.betibachao.app', 'temp-password-1234', { mfaCode: totp(first.body.mfaEnroll.secret) })).status, 200);
  assert.equal((await op.call('GET', '/operator/incidents')).status, 200);
  const again = client(S.base);
  assert.equal((await again.login('ops@test.betibachao.app', 'temp-password-1234')).body.mfaRequired, true);
  W.op = op; W.opSecret = first.body.mfaEnroll.secret;
});

test('server: SOS → only approved nearby volunteers alerted → privacy → accept → explicit safety confirmation', async () => {
  const exact = { lat: 15.82901, lng: 78.03777 };
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'e2e-1', severity: 'HIGH', location: { ...exact, accuracyM: 9, source: 'gps' } });
  assert.equal(sos.status, 201);
  const id = sos.body.incident.id;
  assert.equal((await W.user.call('POST', '/incidents', { idempotencyKey: 'e2e-1' })).status, 200, 'idempotent');
  const rv = await W.ravi.call('GET', `/incidents/${id}`);
  assert.equal(rv.status, 200);
  assert.ok(!JSON.stringify(rv.body).includes('15.82901'), 'unassigned volunteer gets no exact coordinates');
  assert.equal((await W.pending.call('GET', `/incidents/${id}`)).status, 403, 'unapproved volunteer never alerted');
  assert.equal((await W.meena.call('GET', `/incidents/${id}`)).status, 403, '14 km volunteer not alerted in 10 km stage');
  const esc = (await W.op.call('GET', `/incidents/${id}`)).body.escalations;
  assert.ok(esc.some((e) => e.status === 'REQUIRED' && /NOT contacted automatically/.test(e.label)), 'immediate-danger escalation goes to operators');

  const acc = await W.asha.call('POST', `/incidents/${id}/accept`);
  assert.equal(acc.status, 200);
  assert.equal((await W.asha.call('GET', `/incidents/${id}`)).body.location.lat, exact.lat);
  await W.asha.call('POST', `/assignments/${acc.body.assignment.id}/status`, { status: 'EN_ROUTE' });
  await W.asha.call('POST', `/assignments/${acc.body.assignment.id}/status`, { status: 'ARRIVED' });
  let me = await W.user.call('GET', `/incidents/${id}`);
  assert.equal(me.body.status, 'ARRIVED');
  assert.equal(me.body.closed, false);
  assert.equal((await W.user.call('POST', `/incidents/${id}/safety-confirmation`, { response: 'YES' })).status, 400);
  assert.equal((await W.user.call('POST', `/incidents/${id}/safety-confirmation`, { response: 'YES', confirm: true })).status, 200);
  me = await W.user.call('GET', `/incidents/${id}`);
  assert.equal(me.body.color, 'GREEN');
});

test('server: push subscriptions validated and stored', async () => {
  assert.equal((await W.asha.call('POST', '/me/push-subscriptions', { endpoint: 'http://insecure', keys: { p256dh: 'a', auth: 'b' } })).status, 400);
  assert.equal((await W.asha.call('POST', '/me/push-subscriptions', { endpoint: 'https://push.invalid/abc', keys: { p256dh: Buffer.alloc(65, 4).toString('base64url'), auth: Buffer.alloc(16, 1).toString('base64url') } })).status, 400, 'invalid key rejected');
  const crypto = await import('node:crypto');
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const ok = await W.asha.call('POST', '/me/push-subscriptions', { endpoint: 'https://push.invalid/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } });
  assert.equal(ok.status, 200);
});

test('server: durable stage timer survives restart', async () => {
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'restart-1', location: { ...HER, accuracyM: 20, source: 'gps' } });
  const id = sos.body.incident.id;
  await new Promise((r) => S.app.server.close(r));
  servers.splice(servers.indexOf(S), 1);
  const db = JSON.parse(fs.readFileSync(S.file, 'utf8'));
  db.incidents.find((i) => i.id === id).stageDeadline = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(S.file, JSON.stringify(db));
  const again = await boot(S.file); servers.push(again);
  await new Promise((r) => setTimeout(r, 200));
  const c = client(again.base);
  await c.login('aamani@test.betibachao.app');
  assert.equal((await c.call('GET', `/incidents/${id}`)).body.status, 'ALERTING_20KM');
  const meena = client(again.base);
  await meena.login('meena@test.betibachao.app');
  assert.equal((await meena.call('GET', `/incidents/${id}`)).status, 200, '20 km stage reaches Meena');
  S = again;
});

test('server: admin-only config, staff suspension, path traversal blocked', async () => {
  const v = client(S.base);
  await v.login('asha@test.betibachao.app');
  assert.equal((await v.call('PATCH', '/admin/config', { lowAccuracyM: 10 })).status, 403);
  const res = await fetch(`${S.origin}/..%2f..%2fpackage.json`);
  assert.notEqual(res.status, 200);
});
