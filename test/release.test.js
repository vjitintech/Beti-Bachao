// Pre-release checks for: country-code phone numbers, police stations by country/state,
// instant SOS SMS, and road/traffic-aware ETA.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/server.js';
import { createRouting } from '../server/routing.js';
import { toE164, phoneProblem, splitE164, dialInfo } from '../public/core/dial.js';
import { client, world, ADMIN, HER, boot } from './helpers.js';

test('dial codes: local numbers become E.164 for the chosen country', () => {
  assert.equal(toE164('IN', '98765 43210'), '+919876543210');
  assert.equal(toE164('IN', '09876543210'), '+919876543210');
  assert.equal(toE164('IN', '919876543210'), '+919876543210');
  assert.equal(toE164('GB', '07700 900123'), '+447700900123');
  assert.equal(toE164('US', '(415) 555-2671'), '+14155552671');
  assert.equal(toE164('AE', '050 123 4567'), '+971501234567');
  assert.equal(toE164('IN', '+1 415 555 2671'), '+14155552671', 'typed + wins over the picker');
  assert.equal(toE164('IN', '0044 7700 900123'), '+447700900123');
  assert.equal(phoneProblem('IN', '+919876543210'), null);
  assert.match(phoneProblem('IN', '+9198765'), /too short|digits/);
  assert.deepEqual(splitE164('+14155552671', 'IN'), ['US', '4155552671']);
  assert.deepEqual(splitE164('+919876543210', 'IN'), ['IN', '9876543210']);
  assert.ok(dialInfo('NG') && dialInfo('BR') && dialInfo('SA'), 'all countries present');
});

test('routing: Google live traffic first, OSRM road route as fallback, cached, off switch', async () => {
  const seen = [];
  const google = async (url, o) => { seen.push(url); if (url.includes('googleapis')) return { status: 200, json: async () => ({ routes: [{ duration: '900s', staticDuration: '600s', distanceMeters: 5200 }] }) }; return { status: 404, json: async () => ({}) }; };
  const g = createRouting({ GOOGLE_MAPS_API_KEY: 'k', ROUTING_URL: 'off' }, { fetchImpl: google });
  const r = await g.eta({ lat: 15.8, lng: 78.0 }, { lat: 15.83, lng: 78.04 });
  assert.equal(r.source, 'google'); assert.equal(r.traffic, true); assert.equal(r.min, 15); assert.equal(r.km, 5.2); assert.equal(r.delayMin, 5);
  const n = seen.length; await g.eta({ lat: 15.8, lng: 78.0 }, { lat: 15.83, lng: 78.04 }); assert.equal(seen.length, n, 'second call served from cache');

  const osrmOnly = async (url) => (url.startsWith('http://osrm.x') ? { status: 200, json: async () => ({ code: 'Ok', routes: [{ duration: 600, distance: 4200 }] }) } : { status: 500, json: async () => ({}) });
  const o = createRouting({ ROUTING_URL: 'http://osrm.x', ROUTING_TRAFFIC_FACTOR: '1.5' }, { fetchImpl: osrmOnly });
  const ro = await o.eta({ lat: 15.8, lng: 78.0 }, { lat: 15.83, lng: 78.04 });
  assert.equal(ro.source, 'osrm'); assert.equal(ro.traffic, false); assert.equal(ro.min, 15); assert.equal(ro.km, 4.2);

  const failG = async (url) => (url.includes('googleapis') ? { status: 403, json: async () => ({}) } : osrmOnly(url));
  const both = createRouting({ GOOGLE_MAPS_API_KEY: 'k', ROUTING_URL: 'http://osrm.x' }, { fetchImpl: failG });
  assert.equal((await both.eta({ lat: 15.8, lng: 78.0 }, { lat: 15.9, lng: 78.1 })).source, 'osrm', 'falls back when Google fails');
  assert.equal(createRouting({ ROUTING_URL: 'off' }), null);
  assert.ok(createRouting({}), 'public OSRM by default');
});

// ---- end-to-end through the HTTP API with fake gateways ----
const calls = [];
async function fakeFetch(url, opts = {}) {
  const u = String(url);
  calls.push({ url: u, body: opts.body ? String(opts.body) : '' });
  const ok = (b, status = 200) => ({ status, ok: status < 300, json: async () => b });
  if (u.startsWith('https://control.msg91.com')) return ok({ type: 'success' });
  if (u.includes('routes.googleapis.com')) return ok({ routes: [{ duration: '1260s', staticDuration: '840s', distanceMeters: 6100 }] });
  return ok({}, 404);
}
const sms = (tpl) => calls.filter((c) => c.url.startsWith('https://control.msg91.com') && JSON.parse(c.body).template_id === tpl).map((c) => JSON.parse(c.body).recipients[0]);
const wait = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)); } return false; };

let S, W;
after(() => S?.app.server.close());

test('e2e setup', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-rel-'));
  const env = { DATA_FILE: path.join(dir, 'db.json'), ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ADMIN_MFA_SECRET: ADMIN.mfaSecret, RATE_LIMIT_MULTIPLIER: '50', BACKUP_DIR: 'off',
    SMS_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_SOS: 't-sos', MSG91_TEMPLATE_ALERT: 't-alert', PUBLIC_URL: 'https://bb.example', GOOGLE_MAPS_API_KEY: 'g', ROUTING_URL: 'off' };
  // A slow scheduler (5 s) proves the SOS SMS does not wait for the next tick.
  const app = createServer({ env, tickMs: 5000, fetchImpl: fakeFetch });
  await new Promise((r) => app.server.listen(0, r));
  S = { app, base: `http://127.0.0.1:${app.server.address().port}/api/v1` };
  W = await world(S.base);
});

test('register with a local number + country stores E.164', async () => {
  const c = client(S.base);
  const r = await c.call('POST', '/auth/register', { displayName: 'Old App', email: 'oldapp@test.x', role: 'user', phone: '07700 900123', password: 'test-password-123', countryCode: 'GB', consent: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.phone, '+447700900123');
  const r2 = await client(S.base).call('POST', '/auth/register', { displayName: 'US', email: 'us@test.x', role: 'user', phone: '+14155552671', password: 'test-password-123', countryCode: 'US', consent: true });
  assert.equal(r2.body.user.phone, '+14155552671');
});

test('police stations: add one with a local number, CSV by country/state, replace only that state', async () => {
  const a = W.admin;
  const one = await a.call('POST', '/admin/police-stations/one', { name: 'Kurnool I Town PS', district: 'Kurnool', state: 'Andhra Pradesh', country: 'IN', lat: 15.8306, lng: 78.0451, phone: '08518 220100' });
  assert.equal(one.status, 200, JSON.stringify(one.body));
  let list = (await a.call('GET', '/admin/police-stations')).body.items;
  const k = list.find((s) => s.name === 'Kurnool I Town PS');
  assert.equal(k.phone, '+918518220100'); assert.equal(k.state, 'Andhra Pradesh'); assert.equal(k.country, 'IN');
  const upd = await a.call('POST', '/admin/police-stations/one', { id: k.id, name: 'Kurnool I Town PS', district: 'Kurnool', state: 'Andhra Pradesh', country: 'IN', lat: 15.8306, lng: 78.0451, phone: '08518 220100', phone2: '94407 95500' });
  assert.equal(upd.body.updated, true);
  const bad = await a.call('POST', '/admin/police-stations/one', { name: 'X', country: 'IN', lat: 999, lng: 0, phone: '0851' });
  assert.equal(bad.status, 400);
  const csvTs = await a.call('POST', '/admin/police-stations', { country: 'IN', state: 'Telangana', csv: 'name,district,latitude,longitude,phone\nBanjara Hills PS,Hyderabad,17.4156,78.4347,040 2785 2425\nJubilee Hills PS,Hyderabad,17.4300,78.4100,"040 2785 3800"' });
  assert.equal(csvTs.status, 200, JSON.stringify(csvTs.body)); assert.equal(csvTs.body.imported, 2);
  list = (await a.call('GET', '/admin/police-stations')).body.items;
  assert.equal(list.find((s) => s.name === 'Banjara Hills PS').phone, '+914027852425');
  assert.equal(list.find((s) => s.name === 'Banjara Hills PS').state, 'Telangana');
  const uk = await a.call('POST', '/admin/police-stations', { country: 'GB', state: 'England', csv: 'name,lat,lng,phone\nCharing Cross PS,51.5098,-0.1246,020 7240 1212' });
  assert.equal(uk.body.imported, 1);
  list = (await a.call('GET', '/admin/police-stations')).body.items;
  assert.equal(list.find((s) => s.name === 'Charing Cross PS').phone, '+442072401212');
  // Replace Telangana only: AP and UK stations stay.
  await a.call('POST', '/admin/police-stations', { country: 'IN', state: 'Telangana', mode: 'replace', csv: 'name,lat,lng,phone\nSR Nagar PS,17.4400,78.4400,040 2771 3500' });
  list = (await a.call('GET', '/admin/police-stations')).body.items;
  const names = list.map((s) => s.name);
  assert.ok(names.includes('SR Nagar PS') && !names.includes('Banjara Hills PS'));
  assert.ok(names.includes('Kurnool I Town PS') && names.includes('Charing Cross PS'));
});

test('SOS SMS to contacts goes out immediately — even before a GPS fix and before the next scheduler tick', async () => {
  const put = await W.user.call('PUT', '/me/contacts', { contacts: [{ name: 'Amma', phone: '+919000000101' }, { name: 'Akka', phone: '+919000000102' }] });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const t0 = Date.now();
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'rel-fast-1', shareToken: 'a'.repeat(32) });
  assert.equal(sos.status, 201);
  assert.ok(await wait(() => sms('t-sos').length >= 2, 1500), 'contact SMS sent within 1.5 s with no location');
  assert.ok(Date.now() - t0 < 1500);
  const r = sms('t-sos')[0];
  assert.match(r.link, /^https:\/\/bb\.example\/s\/a{32}$/, 'SMS carries the live link');
  assert.ok(sms('t-sos').every((x) => /^91\d{10}$/.test(x.mobiles)));
  await W.user.call('POST', `/incidents/${sos.body.incident.id}/cancel`, { confirm: true });
});

test('radar ETA uses the road route with live traffic once a volunteer accepts', async () => {
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'rel-eta-1', location: { ...HER, accuracyM: 10, source: 'gps', observedAt: new Date().toISOString() } });
  assert.equal(sos.status, 201);
  const id = sos.body.incident.id;
  const acc = await W.asha.call('POST', `/incidents/${id}/accept`, {});
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  assert.ok(await wait(() => calls.some((c) => c.url.includes('routes.googleapis.com')), 1500), 'route asked right after accept');
  let mine;
  for (let i = 0; i < 40 && !mine; i++) {
    const v = await W.user.call('GET', `/incidents/${id}`);
    mine = (v.body.responders || v.body.incident?.responders || []).find((x) => x.etaBasis === 'traffic');
    if (!mine) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(mine, 'traffic-aware ETA visible');
  assert.ok(mine.approxEtaMin >= 1 && mine.approxEtaMin <= 21);
  const body = JSON.parse(calls.find((c) => c.url.includes('routes.googleapis.com')).body);
  assert.equal(body.routingPreference, 'TRAFFIC_AWARE');
});
