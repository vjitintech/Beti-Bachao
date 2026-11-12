// Second pre-release round: duplicate contacts, police auto-call (station ≤30 km → 1091 → 112),
// honest police count, evidence audit trail, "still waiting" SMS, admin user search, HEAD /health.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.js';
import { client, world, ADMIN, HER } from './helpers.js';

const calls = [];
async function fakeFetch(url, opts = {}) {
  calls.push({ url: String(url), body: opts.body ? String(opts.body) : '' });
  return { status: 200, ok: true, json: async () => ({ type: 'success' }) };
}
const smsTo = (tpl) => calls.filter((c) => c.url.includes('msg91') && JSON.parse(c.body).template_id === tpl).map((c) => JSON.parse(c.body).recipients[0].mobiles);
const wait = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };

let S, W;
after(() => S?.app.server.close());

test('setup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-rel2-'));
  const env = { DATA_FILE: path.join(dir, 'db.json'), ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ADMIN_MFA_SECRET: ADMIN.mfaSecret, RATE_LIMIT_MULTIPLIER: '50', BACKUP_DIR: 'off', ROUTING_URL: 'off',
    SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_SOS: 't-sos', MSG91_TEMPLATE_POLICE: 't-pol', PUBLIC_URL: 'https://bb.example' };
  const app = createServer({ env, tickMs: 100, fetchImpl: fakeFetch });
  await new Promise((r) => app.server.listen(0, r));
  S = { app, base: `http://127.0.0.1:${app.server.address().port}/api/v1`, root: `http://127.0.0.1:${app.server.address().port}` };
  W = await world(S.base);
});

test('uptime monitors: HEAD and /health work', async () => {
  for (const u of [`${S.root}/health`, `${S.root}/healthz`, `${S.base}/health`]) {
    const h = await fetch(u, { method: 'HEAD' });
    assert.equal(h.status, 200, u);
    const g = await fetch(u); assert.equal((await g.json()).ok, true, u);
  }
});

test('contacts: duplicate numbers are refused (any format), own number refused, per-place clash with important', async () => {
  const u = W.user;
  let r = await u.call('PUT', '/me/contacts', { contacts: [{ name: 'Amma', phone: '+919000000101' }, { name: 'Akka', phone: '09000000101' }] });
  assert.equal(r.status, 400); assert.equal(r.body.error.code, 'DUPLICATE_CONTACT');
  r = await u.call('PUT', '/me/contacts', { contacts: [{ name: 'Amma', phone: '+919000000101' }, { name: 'Akka', phone: '+919000000102' }] });
  assert.equal(r.status, 200);
  const place = (contacts) => ({ places: [{ label: 'Home', lat: HER.lat, lng: HER.lng, radiusM: 2000, contacts }] });
  r = await u.call('PUT', '/me/places', place([{ name: 'Neighbour', phone: '+919000000120' }, { name: 'Aunty', phone: '9000000120' }]));
  assert.equal(r.status, 400); assert.match(r.body.error.message, /same number/);
  r = await u.call('PUT', '/me/places', place([{ name: 'Amma again', phone: '9000000101' }]));
  assert.equal(r.status, 400); assert.match(r.body.error.message, /important contact/);
  r = await u.call('PUT', '/me/places', place([{ name: 'Neighbour', phone: '+919000000120' }, { name: 'Aunty', phone: '+919000000121' }]));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // Editing one contact of the place (the app sends the place back with that one contact changed).
  r = await u.call('PUT', '/me/places', place([{ name: 'Neighbour Uncle', phone: '+919000000120' }]));
  assert.equal(r.status, 200); assert.equal(r.body.places[0].contacts.length, 1); assert.equal(r.body.places[0].contacts[0].name, 'Neighbour Uncle');
});

test('police auto-call: no station within 30 km → 1091; her phone reports the call; only placed calls are counted', async () => {
  const a = W.admin;
  await a.call('POST', '/admin/police-stations/one', { name: 'Far PS', country: 'IN', state: 'X', lat: HER.lat + 0.6, lng: HER.lng, phone: '08518 220100' }); // ~67 km away
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'r2-pol-1', location: { ...HER, accuracyM: 10, source: 'gps', observedAt: new Date().toISOString() } });
  const id = sos.body.incident.id;
  const again = await W.user.call('POST', '/incidents', { idempotencyKey: 'r2-pol-2', location: { ...HER, accuracyM: 10, source: 'gps', observedAt: new Date().toISOString() } }); // second press → police now
  assert.equal(again.body.incident.id, id);
  let v = (await W.user.call('GET', `/incidents/${id}`)).body;
  assert.equal(v.police.dial.number, '1091'); assert.equal(v.police.dial.target, 'women_helpline'); assert.equal(v.police.station, null);
  // Her phone's location loop learns it must call.
  const loc = await W.user.call('POST', '/me/location', { ...HER, accuracyM: 8, source: 'gps', observedAt: new Date().toISOString() });
  assert.deepEqual(loc.body.policeCall, { incidentId: id, number: '1091' });
  let imp = (await a.call('GET', '/admin/dashboard?days=7')).body;
  const before = imp.period.policeAutoConnects;
  assert.equal(before, 0, 'not counted before a call is placed');
  const pc = await W.user.call('POST', `/incidents/${id}/police-call`, { number: '1091', result: 'placed' });
  assert.equal(pc.status, 200); assert.equal(pc.body.dial.result, 'PLACED');
  v = (await W.user.call('GET', `/incidents/${id}`)).body;
  assert.equal(v.police.status, 'CONTACTED');
  const loc2 = await W.user.call('POST', '/me/location', { ...HER, accuracyM: 8, source: 'gps', observedAt: new Date().toISOString() });
  assert.equal(loc2.body.policeCall, undefined, 'no more call requests once placed');
  imp = (await a.call('GET', '/admin/dashboard?days=7')).body;
  assert.equal(imp.period.policeAutoConnects, 1);
  const audit = (await a.call('GET', '/admin/audit-events?limit=500')).body.items || [];
  assert.ok(audit.some((x) => x.action === 'POLICE_CALL_PLACED'));
  await W.user.call('POST', `/incidents/${id}/cancel`, { confirm: true });
});

test('police auto-call: station within 30 km is called', async () => {
  await W.admin.call('POST', '/admin/police-stations/one', { name: 'Near PS', country: 'IN', state: 'X', lat: HER.lat + 0.02, lng: HER.lng, phone: '08518 220200' });
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'r2-pol-3', location: { ...HER, accuracyM: 10, source: 'gps', observedAt: new Date().toISOString() } });
  await W.user.call('POST', '/incidents', { idempotencyKey: 'r2-pol-4', location: { ...HER, accuracyM: 10, source: 'gps', observedAt: new Date().toISOString() } });
  const v = (await W.user.call('GET', `/incidents/${sos.body.incident.id}`)).body;
  assert.equal(v.police.station.name, 'Near PS'); assert.equal(v.police.dial.number, '+918518220200'); assert.equal(v.police.dial.target, 'station');
  assert.ok(await wait(() => smsTo('t-pol').includes('918518220200')), 'station also gets the SMS');
  await W.user.call('POST', `/incidents/${sos.body.incident.id}/cancel`, { confirm: true });
});

test('evidence: every step is audited; operators are told when a clip arrives', async () => {
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'r2-ev-1', location: { ...HER, accuracyM: 10, source: 'gps', observedAt: new Date().toISOString() } });
  const id = sos.body.incident.id;
  assert.equal((await W.user.call('POST', `/incidents/${id}/evidence-log`, { event: 'started', seconds: 15 })).status, 200);
  assert.equal((await W.user.call('POST', `/incidents/${id}/evidence-log`, { event: 'no_voice', seconds: 15 })).status, 200);
  assert.equal((await W.user.call('POST', `/incidents/${id}/evidence-log`, { event: 'hack' })).status, 400);
  const up = await W.user.call('POST', `/incidents/${id}/evidence`, { mime: 'audio/mp4', kind: 'audio', durationSec: 15, data: Buffer.alloc(4000, 7).toString('base64'), auto: true });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  const audit = (await W.admin.call('GET', '/admin/audit-events?limit=500')).body.items || [];
  for (const act of ['EVIDENCE_RECORDING_STARTED', 'EVIDENCE_DISCARDED_NO_VOICE', 'EVIDENCE_UPLOADED']) assert.ok(audit.some((x) => x.action === act), act);
  const ops = (await W.admin.call('GET', `/incidents/${id}`)).body;
  assert.equal((ops.evidence || ops.incident?.evidence || []).length, 1);
  await W.user.call('POST', `/incidents/${id}/cancel`, { confirm: true });
});

test('no responder → contacts get a second "still waiting for help" SMS, once', async () => {
  const pc = await W.admin.call('PATCH', '/admin/config', { contactsWaitingSec: 1, operatorAckSec: 300, policeAutoConnectSec: 600 });
  assert.equal(pc.status, 200, JSON.stringify(pc.body));
  const n0 = smsTo('t-sos').length;
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'r2-wait-1', location: { ...HER, accuracyM: 10, source: 'gps', observedAt: new Date().toISOString() } });
  assert.ok(await wait(() => smsTo('t-sos').length >= n0 + 3, 2000), 'first SOS SMS to 2 important + 1 place contact');
  const n1 = smsTo('t-sos').length;
  const ok2 = await wait(() => smsTo('t-sos').length >= n1 + 3, 4000);
  assert.ok(ok2, 'second "still waiting" SMS (WAITING falls back to the SOS template)');
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(smsTo('t-sos').length, n1 + 3, 'sent once only, to the same 3 people');
  const tl = (await W.user.call('GET', `/incidents/${sos.body.incident.id}/timeline`)).body.items;
  assert.ok(tl.some((x) => /still waiting/i.test(x.text)));
  await W.user.call('POST', `/incidents/${sos.body.incident.id}/cancel`, { confirm: true });
});

test('admin user search: name prefix, phone digits, status, role, location', async () => {
  const a = W.admin;
  const q = async (qs) => (await a.call('GET', `/admin/users?${qs}`)).body.items;
  const her = (await W.user.call('GET', '/me')).body.user;
  const pre = her.displayName.slice(0, 3);
  assert.ok((await q(`q=${encodeURIComponent(pre)}`)).some((u) => u.id === her.id), 'first 3 letters');
  assert.ok((await q(`q=${encodeURIComponent(her.phone.replace(/\D/g, '').slice(-6))}`)).some((u) => u.id === her.id), 'phone digits');
  const vols = await q('role=volunteer');
  assert.ok(vols.length >= 1 && vols.every((u) => u.role === 'volunteer'));
  assert.ok((await q('status=ACTIVE')).every((u) => u.status === 'ACTIVE'));
  const near = await q(`lat=${HER.lat}&lng=${HER.lng}&km=5`);
  const mine = near.find((u) => u.id === her.id);
  assert.ok(mine && mine.where.distanceKm <= 5, 'her saved place / last SOS is near');
  assert.ok((await q(`lat=${HER.lat + 3}&lng=${HER.lng}&km=5`)).every((u) => u.id !== her.id), 'not near a far point');
  assert.deepEqual(await q('q=ab'), []);
});
