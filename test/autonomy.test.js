// End-to-end automation through the HTTP API with fake SMS (MSG91) and call (Exotel) gateways.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.js';
import { client, world, ADMIN, HER, PASSWORD } from './helpers.js';

const calls = [];
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  calls.push({ url: u, body: opts.body ? String(opts.body) : '' });
  const ok = (b, status = 200) => ({ status, ok: status < 300, json: async () => b });
  if (u.startsWith('https://control.msg91.com')) return ok({ type: 'success' });
  if (u.includes('exotel.com')) return ok({ Call: { Sid: 'x' } });
  return ok({}, 404);
}
const sentSms = (tpl) => calls.filter((c) => c.url.startsWith('https://control.msg91.com') && JSON.parse(c.body).template_id === tpl).map((c) => JSON.parse(c.body).recipients[0]);
const wait = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 30)); } return false; };
const off = (km, brg) => { const R = 6371.0088, b = (brg * Math.PI) / 180, d = km / R, la = (HER.lat * Math.PI) / 180, lo = (HER.lng * Math.PI) / 180; const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b)); const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2)); return { lat: (la2 * 180) / Math.PI, lng: (lo2 * 180) / Math.PI }; };

let S, W;
after(() => S?.app.server.close());

test('setup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-auto-'));
  const env = { DATA_FILE: path.join(dir, 'db.json'), ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ADMIN_MFA_SECRET: ADMIN.mfaSecret, RATE_LIMIT_MULTIPLIER: '50', BACKUP_DIR: 'off',
    SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_SOS: 't-sos', MSG91_TEMPLATE_POLICE: 't-police', MSG91_TEMPLATE_TRIP_START: 't-trip', MSG91_TEMPLATE_TRIP_SAFE: 't-safe', MSG91_TEMPLATE_ALERT: 't-alert',
    VOICE_PROVIDER: 'exotel', EXOTEL_SID: 'sid', EXOTEL_API_KEY: 'key', EXOTEL_API_TOKEN: 'tok', EXOTEL_CALLER_ID: '08047000000', EXOTEL_SUBDOMAIN: 'api.in.exotel.com', PUBLIC_URL: 'https://bb.example' };
  const app = createServer({ env, tickMs: 50, fetchImpl: fakeFetch });
  await new Promise((r) => app.server.listen(0, r));
  S = { app, base: `http://127.0.0.1:${app.server.address().port}/api/v1`, origin: `http://127.0.0.1:${app.server.address().port}` };
  W = await world(S.base);
  const st = await W.admin.call('POST', '/admin/police-stations', { csv: `name,district,lat,lng,phone\nKurnool I Town PS,Kurnool,${off(1, 90).lat},${off(1, 90).lng},+918518000001\nFar PS,Kurnool,${off(30, 0).lat},${off(30, 0).lng},+918518000002` });
  assert.equal(st.status, 200); assert.equal(st.body.imported, 2);
});

test('place contacts get the SOS SMS; second SOS press auto-connects police: SMS + call bridging station and her phone', async () => {
  const C = (n) => ({ name: `C${n}`, phone: `+91900000001${n}` });
  const put = await W.user.call('PUT', '/me/places', { places: [{ label: 'Home', lat: HER.lat, lng: HER.lng, contacts: [C(1), C(2), C(3)] }, { label: 'College', ...off(12, 180), contacts: [C(4), C(5), C(6)] }] });
  assert.equal(put.status, 200);
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'auto-1', location: { ...HER, accuracyM: 10, source: 'gps', observedAt: new Date(Date.now() - 3600e3).toISOString() } });
  assert.equal(sos.status, 201);
  assert.ok(await wait(() => sentSms('t-sos').length === 3));
  assert.deepEqual(sentSms('t-sos').map((r) => r.mobiles).sort(), ['919000000011', '919000000012', '919000000013']);
  assert.match(sentSms('t-sos')[0].link, /^https:\/\/bb\.example\/s\/[a-f0-9]{32}$/); // live tracking link in the SMS
  const live = await fetch(`${S.base}/s/${sentSms('t-sos')[0].link.split('/s/')[1]}`).then((r) => r.json());
  assert.equal(live.status, 'ACTIVE'); assert.ok(live.last);
  assert.equal((await fetch(`${S.origin}/s/${sentSms('t-sos')[0].link.split('/s/')[1]}`)).status, 200);
  // She moves to college during the SOS → the college contacts are added automatically.
  await W.user.call('POST', `/incidents/${sos.body.incident.id}/locations`, { ...off(12, 180), accuracyM: 10, source: 'gps' });
  assert.ok(await wait(() => sentSms('t-sos').length === 6));
  // She presses SOS again; no operator has acknowledged → nearest police station connected.
  const again = await W.user.call('POST', '/incidents', { idempotencyKey: 'auto-2', location: { ...off(12, 180), accuracyM: 10, source: 'gps' } });
  assert.equal(again.body.duplicate, true);
  assert.ok(await wait(() => calls.some((c) => c.url.includes('exotel.com'))));
  const call = calls.find((c) => c.url.includes('exotel.com'));
  assert.match(call.url, /^https:\/\/api\.in\.exotel\.com\/v1\/Accounts\/sid\/Calls\/connect\.json$/);
  const form = new URLSearchParams(call.body);
  assert.equal(form.get('From'), '+918518000001'); // nearest station to where she is now
  assert.equal(form.get('To'), (await W.user.call('GET', '/me')).body.user.phone);
  assert.ok(await wait(() => sentSms('t-police').length >= 1));
  await new Promise((r) => setTimeout(r, 200));
  const v2 = await W.user.call('GET', `/incidents/${sos.body.incident.id}`);
  assert.equal(v2.body.police.status, 'CONTACTED');
  assert.equal(v2.body.police.call, 'PLACED');
  const ops = await W.admin.call('GET', `/incidents/${sos.body.incident.id}`);
  assert.equal(ops.body.policeConnect.station.name, 'Kurnool I Town PS');
});

test('operator acknowledgement endpoint; evidence upload is encrypted at rest and access-controlled', async () => {
  const id = (await W.user.call('GET', '/me/incidents')).body.items[0].id;
  const ack = await W.admin.call('POST', `/operator/incidents/${id}/ack`);
  assert.equal(ack.status, 200);
  const audio = crypto.randomBytes(3000);
  const up = await W.user.call('POST', `/incidents/${id}/evidence`, { mime: 'audio/mp4', data: audio.toString('base64'), durationSec: 15 });
  assert.equal(up.status, 200);
  const files = fs.readdirSync(path.join(path.dirname(S.app.store.file), 'evidence')).filter((f) => f.endsWith('.bbm'));
  assert.equal(files.length, 1);
  assert.ok(!fs.readFileSync(path.join(path.dirname(S.app.store.file), 'evidence', files[0])).includes(audio.subarray(0, 64)), 'stored encrypted');
  const ops = await W.admin.call('GET', `/incidents/${id}`);
  assert.equal(ops.body.evidence.length, 1);
  const dl = await W.admin.call('GET', `/incidents/${id}/evidence/${up.body.id}`);
  assert.equal(dl.status, 200);
  const denied = await W.asha.call('GET', `/incidents/${id}/evidence/${up.body.id}`);
  assert.equal(denied.status, 403);
});

test('Track my travel: contacts get the live link by SMS; public page works without login; arrival SMS', async () => {
  const r0 = await W.user.call('POST', `/incidents/${(await W.user.call('GET', '/me/incidents')).body.items[0].id}/safety-confirmation`, { response: 'YES', confirm: true });
  assert.equal(r0.status, 200);
  const dest = off(4, 45);
  const t = await W.user.call('POST', '/me/trip', { destination: { ...dest, label: 'Hostel' }, expectedMin: 25, vehicle: 'AP39TX1234', location: { ...HER, accuracyM: 10 } });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.ok(await wait(() => sentSms('t-trip').length >= 3));
  const link = sentSms('t-trip')[0].link;
  assert.ok(link.startsWith('https://bb.example/t/'));
  const token = link.split('/t/')[1];
  const page = await fetch(`${S.origin}/t/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /track\.js/);
  const pub = await fetch(`${S.base}/t/${token}`).then((r) => r.json());
  assert.equal(pub.destination, 'Hostel'); assert.equal(pub.vehicle, 'AP39TX1234'); assert.equal(pub.live, true);
  assert.equal((await fetch(`${S.base}/t/${'0'.repeat(32)}`)).status, 404);
  await W.user.call('POST', '/me/location', { ...dest, accuracyM: 10, source: 'gps' });
  assert.equal((await W.user.call('GET', '/me/trip')).body.trip.status, 'ARRIVED');
  assert.ok(await wait(() => sentSms('t-safe').length >= 3));
});

test('dashboards and public impact counter', async () => {
  const mine = await W.user.call('GET', '/me/dashboard');
  assert.equal(mine.status, 200);
  assert.equal(mine.body.trips.arrived, 1);
  assert.equal(mine.body.setup.placesReady, 2);
  const adm = await W.admin.call('GET', '/admin/dashboard?days=7');
  assert.equal(adm.status, 200); assert.equal(adm.body.series.length, 7);
  assert.ok(adm.body.period.policeAutoConnects >= 1);
  const pub = await fetch(`${S.base}/impact`).then((r) => r.json());
  assert.ok(pub.womenRegistered >= 1); assert.ok('womenProtected' in pub);
  assert.equal((await W.user.call('GET', '/admin/dashboard')).status, 403);
});
