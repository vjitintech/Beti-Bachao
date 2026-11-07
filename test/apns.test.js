// iPhone/iPad push via Apple APNs (token auth, HTTP/2) — with a fake HTTP/2 connection.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createApns } from '../server/apns.js';
import { boot, client, TRAINING } from './helpers.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
const ENV = { APNS_KEY: Buffer.from(P8).toString('base64'), APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456', APNS_SANDBOX: '1' };

function fakeConnect(sent, status = 200, reply = '') {
  return (origin) => {
    const s = new EventEmitter();
    s.closed = false; s.destroyed = false; s.unref = () => {};
    s.request = (headers) => {
      const req = new EventEmitter();
      req.setTimeout = () => {}; req.close = () => {};
      req.end = (body) => {
        sent.push({ origin, headers, body: JSON.parse(body) });
        setImmediate(() => { req.emit('response', { ':status': status }); if (reply) req.emit('data', reply); req.emit('end'); });
      };
      return req;
    };
    return s;
  };
}

test('APNs: ES256 provider token, alert headers, time-sensitive urgent alerts', async () => {
  const sent = [];
  const apns = createApns(ENV, { connect: fakeConnect(sent) });
  const r = await apns.send({ platform: 'ios', token: 'a'.repeat(64) }, { kind: 'ALERT', title: 'SOS nearby', body: 'Help', url: '#/volunteer', tag: 'sos-1', urgent: true, incidentId: 'i1' });
  assert.equal(r.ok, true);
  const { origin, headers, body } = sent[0];
  assert.equal(origin, 'https://api.sandbox.push.apple.com');
  assert.equal(headers[':path'], '/3/device/' + 'a'.repeat(64));
  assert.equal(headers['apns-topic'], 'app.betibachao.safety');
  assert.equal(headers['apns-push-type'], 'alert');
  assert.equal(body.aps['interruption-level'], 'time-sensitive');
  assert.equal(body.url, '#/volunteer');
  const [h, p, sig] = headers.authorization.replace('bearer ', '').split('.');
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'ES256', kid: 'ABC123DEFG' });
  assert.equal(JSON.parse(Buffer.from(p, 'base64url')).iss, 'TEAM123456');
  assert.ok(crypto.verify('SHA256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('APNs: unregistered device tokens are reported as gone; unconfigured returns null', async () => {
  const apns = createApns(ENV, { connect: fakeConnect([], 410, '{"reason":"Unregistered"}') });
  const r = await apns.send({ platform: 'ios', token: 'b'.repeat(64) }, { title: 't', body: 'b' });
  assert.equal(r.gone, true);
  assert.equal(createApns({}), null);
});

const servers = [];
after(() => { for (const x of servers) x.app.server.close(); });

test('server sends iPhone device alerts through APNs (Android stays on FCM)', async () => {
  const S0 = await boot(null, ENV);
  S0.app.server.close();
  const sent = [];
  const { createServer } = await import('../server/server.js');
  const helpers = await import('./helpers.js');
  const app = createServer({ env: { DATA_FILE: S0.file, ADMIN_EMAIL: helpers.ADMIN.email, ADMIN_PASSWORD: helpers.ADMIN.password, ADMIN_MFA_SECRET: helpers.ADMIN.mfaSecret, RATE_LIMIT_MULTIPLIER: '50', ...ENV }, tickMs: 50, apnsConnect: fakeConnect(sent) });
  await new Promise((r) => app.server.listen(0, r));
  servers.push({ app });
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const cfg = await client(base).call('GET', '/public-config');
  assert.equal(cfg.body.features.iosPush, true);

  const admin = client(base); await admin.adminLogin();
  const v = client(base);
  await v.register('Meera', 'meera@test.betibachao.app', 'volunteer');
  for (const m of TRAINING) await v.call('POST', '/volunteer/training', { moduleId: m });
  await v.call('POST', '/volunteer/verification', { contactPhone: '+91 90000 00000', area: 'Kurnool' });
  const dev = await v.call('POST', '/me/devices', { platform: 'ios', token: 'c'.repeat(64) });
  assert.equal(dev.status, 200);
  assert.equal(dev.body.push, true);
  const me = (await v.call('GET', '/me')).body.user;
  await admin.call('POST', `/admin/volunteers/${me.id}/schedule-call`, { scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  for (let i = 0; i < 40 && !sent.length; i++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers[':path'], '/3/device/' + 'c'.repeat(64));
  assert.match(sent[0].body.aps.alert.title, /Verification video call/);
});
