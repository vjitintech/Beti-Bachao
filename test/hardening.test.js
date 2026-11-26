// Fixes from the Nov 2026 security audit: trusted client IP, per-account reset limits,
// no Host-header links on Render, one-time tickets for the app's live-update stream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createServer } from '../server/server.js';
import { ADMIN, client } from './helpers.js';

async function start(extra = {}, fetchImpl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-hard-'));
  const app = createServer({ env: { DATA_FILE: path.join(dir, 'db.json'), ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ADMIN_MFA_SECRET: ADMIN.mfaSecret, ROUTING_URL: 'off', ACCESS_LOG: 'off', APK_RELEASE_API: 'off', BACKUP_DIR: 'off', ...extra }, tickMs: 100, ...(fetchImpl ? { fetchImpl } : {}) });
  await new Promise((r) => app.server.listen(0, r));
  const port = app.server.address().port;
  return { app, base: `http://127.0.0.1:${port}/api/v1`, port, stop: () => { app.server.closeAllConnections?.(); app.server.close(); } };
}
const post = (base, p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BB-CSRF': '1', ...headers }, body: JSON.stringify(body) });
const fakeSms = async () => ({ status: 200, ok: true, json: async () => ({ type: 'success' }) });

test('spoofed X-Forwarded-For entries do not bypass per-IP limits', async () => {
  const S = await start({ TRUST_PROXY: 'true', SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_OTP: 't' }, fakeSms);
  const codes = [];
  for (let i = 0; i < 7; i++) codes.push((await post(S.base, '/auth/reset/request', { email: 'x@example.com' }, { 'X-Forwarded-For': `198.51.100.${i}, 203.0.113.9` })).status);
  assert.deepEqual(codes, [200, 200, 200, 200, 200, 429, 429]);
  const cf = (await post(S.base, '/auth/reset/request', { email: 'x@example.com' }, { 'True-Client-IP': '192.0.2.44', 'X-Forwarded-For': '203.0.113.9' })).status;
  assert.equal(cf, 200, "Cloudflare's True-Client-IP is a separate client");
  S.stop();
});

test('reset codes are limited per account, whatever the IP', async () => {
  let sent = 0;
  const S = await start({ TRUST_PROXY: 'true', RATE_LIMIT_MULTIPLIER: '50', SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_OTP: 't' }, async (u) => { if (String(u).includes('msg91')) sent++; return fakeSms(); });
  const c = client(S.base); await c.register('Riya', 'riya@example.com', 'user');
  for (let i = 0; i < 6; i++) await post(S.base, '/auth/reset/request', { email: 'riya@example.com' }, { 'True-Client-IP': `192.0.2.${i}` });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent, 3, 'only 3 codes an hour reach her phone');
  const tries = [];
  for (let i = 0; i < 12; i++) { await post(S.base, '/auth/reset/request', { email: 'riya@example.com' }); tries.push((await post(S.base, '/auth/reset/confirm', { email: 'riya@example.com', code: '000000', newPassword: 'a-new-password-1' }, { 'True-Client-IP': `192.0.2.${100 + i}` })).status); }
  assert.ok(tries.slice(0, 10).every((s) => s === 400) && tries.slice(10).every((s) => s === 429 || s === 400), JSON.stringify(tries));
  S.stop();
});

test('on Render, SMS links never come from the Host header', async () => {
  const S = await start({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://beti.onrender.com' });
  await fetch(S.base + '/health', { headers: { Host: 'evil.example' } });
  const c = client(S.base); await c.register('Asha', 'asha2@example.com', 'user');
  const sos = await c.call('POST', '/incidents', { idempotencyKey: 'h1', location: { lat: 15.8, lng: 78.0, accuracyM: 10, source: 'gps' } });
  assert.equal(sos.status, 201);
  const S2 = await start({ RENDER: 'true' });
  await fetch(S2.base + '/health', { headers: { Host: 'evil.example' } });
  S.stop(); S2.stop();
  const src = fs.readFileSync(new URL('../server/server.js', import.meta.url), 'utf8');
  assert.match(src, /originFromHost && req\.headers\.host/);
});

test('app live updates use a one-time ticket, not the login token in the URL', async () => {
  const S = await start();
  const reg = await fetch(S.base + '/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BB-CSRF': '1' }, body: JSON.stringify({ displayName: 'Meera', email: 'meera@example.com', role: 'user', phone: '+919000000123', password: 'test-password-123', consent: true, client: 'mobile' }) });
  const { token } = await reg.json();
  const t = await (await fetch(S.base + '/events/ticket', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' })).json();
  assert.ok(t.ticket && !t.ticket.includes(token));
  const ac = new AbortController();
  const first = await fetch(`${S.base}/events?ticket=${encodeURIComponent(t.ticket)}`, { signal: ac.signal });
  assert.equal(first.status, 200); ac.abort();
  const again = await fetch(`${S.base}/events?ticket=${encodeURIComponent(t.ticket)}`);
  assert.equal(again.status, 401, 'a ticket works once');
  assert.equal((await fetch(S.base + '/events?ticket=nope')).status, 401);
  S.stop();
});
