import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../server/server.js';
import { DEMO_CENTER } from '../public/core/seed.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
const DATA_FILE = path.join(dir, 'db.json');
const servers = [];
after(() => { for (const s of servers) s.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function boot() {
  const app = createServer({ env: { DEMO_MODE: 'true', DATA_FILE }, tickMs: 50 });
  await new Promise((r) => app.server.listen(0, r));
  servers.push(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  return { app, base };
}

function client(base) {
  let cookie = '';
  const call = async (method, p, body, { csrf = true } = {}) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-BB-CSRF': '1' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };
  return { call, login: (email, extra = {}) => call('POST', '/auth/login', { email, password: 'demo1234', ...extra }) };
}

let shared;
test('server: health, security headers, CSRF and auth', async () => {
  shared = await boot();
  const c = client(shared.base);
  const h = await c.call('GET', '/health');
  assert.equal(h.status, 200);
  assert.match(h.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await c.call('GET', '/me')).status, 401);
  const noCsrf = await c.call('POST', '/auth/login', { email: 'aamani@demo.betibachao.app', password: 'demo1234' }, { csrf: false });
  assert.equal(noCsrf.status, 403);
  assert.equal((await c.login('aamani@demo.betibachao.app', { password: 'wrong' })).status, 401);
  const ok = await c.login('aamani@demo.betibachao.app');
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.equal((await c.call('GET', '/me')).body.user.role, 'user');
});

test('server: operator login requires MFA', async () => {
  const c = client(shared.base);
  const first = await c.login('operator@demo.betibachao.app');
  assert.equal(first.body.mfaRequired, true);
  assert.equal((await c.call('GET', '/operator/incidents')).status, 401);
  assert.equal((await c.login('operator@demo.betibachao.app', { mfaCode: '000000' })).status, 401);
  const { body } = await c.call('GET', '/demo/mfa-code');
  assert.equal((await c.login('operator@demo.betibachao.app', { mfaCode: body.code })).status, 200);
  assert.equal((await c.call('GET', '/operator/incidents')).status, 200);
});

test('server: SOS → volunteer privacy → accept → safety confirmation end-to-end', async () => {
  const user = client(shared.base), ravi = client(shared.base), asha = client(shared.base), deepa = client(shared.base);
  await user.login('aamani@demo.betibachao.app');
  await ravi.login('ravi@demo.betibachao.app');
  await asha.login('asha@demo.betibachao.app');
  await deepa.login('deepa@demo.betibachao.app');
  const exact = { lat: 15.82901, lng: 78.03777 };
  const sos = await user.call('POST', '/incidents', { idempotencyKey: 'e2e-1', location: { ...exact, accuracyM: 9, source: 'synthetic' } });
  assert.equal(sos.status, 201);
  const id = sos.body.incident.id;
  assert.equal((await user.call('POST', '/incidents', { idempotencyKey: 'e2e-1' })).status, 200, 'retry is idempotent');

  const rv = await ravi.call('GET', `/incidents/${id}`);
  assert.equal(rv.status, 200);
  assert.ok(!JSON.stringify(rv.body).includes('15.82901'), 'unassigned volunteer gets no exact coordinates');
  assert.equal((await deepa.call('GET', `/incidents/${id}`)).status, 403, 'untrained volunteer was never alerted');
  assert.equal((await user.call('POST', `/incidents/${id}/accept`)).status, 403, 'user cannot accept');

  const acc = await asha.call('POST', `/incidents/${id}/accept`);
  assert.equal(acc.status, 200);
  const av = await asha.call('GET', `/incidents/${id}`);
  assert.equal(av.body.location.lat, exact.lat);
  await asha.call('POST', `/assignments/${acc.body.assignment.id}/status`, { status: 'EN_ROUTE' });
  await asha.call('POST', `/assignments/${acc.body.assignment.id}/status`, { status: 'ARRIVED' });
  let me = await user.call('GET', `/incidents/${id}`);
  assert.equal(me.body.status, 'ARRIVED');
  assert.equal(me.body.closed, false, 'arrival does not close');
  assert.equal((await user.call('POST', `/incidents/${id}/safety-confirmation`, { response: 'YES' })).status, 400);
  assert.equal((await user.call('POST', `/incidents/${id}/safety-confirmation`, { response: 'YES', confirm: true })).status, 200);
  me = await user.call('GET', `/incidents/${id}`);
  assert.equal(me.body.status, 'CLOSED');
  assert.equal(me.body.color, 'GREEN');
  const tl = await user.call('GET', `/incidents/${id}/timeline`);
  assert.ok(tl.body.items.some((x) => x.text === 'SAFE_CONFIRMED'));
});

test('server: durable stage timer survives restart', async () => {
  const user = client(shared.base);
  await user.login('aamani@demo.betibachao.app');
  const sos = await user.call('POST', '/incidents', { idempotencyKey: 'restart-1', location: { ...DEMO_CENTER, accuracyM: 20, source: 'synthetic' } });
  const id = sos.body.incident.id;
  await new Promise((r) => shared.app.server.close(r));
  servers.splice(servers.indexOf(shared.app.server), 1);
  // Rewind the persisted deadline to simulate the timeout passing while the worker was down.
  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  db.incidents.find((i) => i.id === id).stageDeadline = new Date(Date.now() - 1000).toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(db));
  const again = await boot();
  await new Promise((r) => setTimeout(r, 200));
  const c = client(again.base);
  await c.login('aamani@demo.betibachao.app');
  const v = await c.call('GET', `/incidents/${id}`);
  assert.equal(v.body.status, 'ALERTING_20KM');
  shared = again;
});

test('server: admin-only config, path traversal blocked', async () => {
  const v = client(shared.base);
  await v.login('asha@demo.betibachao.app');
  assert.equal((await v.call('PATCH', '/admin/config', { lowAccuracyM: 10 })).status, 403);
  const port = new URL(shared.base).port;
  const res = await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`);
  assert.notEqual(res.status, 200);
});
