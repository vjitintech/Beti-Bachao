// Autonomous protection: place-based contacts, operator clock → police auto-connect,
// second SOS press, Track my travel (auto-arrival + auto-SOS), evidence rules, dashboards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Engine, emptyDb, S } from '../public/core/engine.js';
import { seedDemo, DEMO_CENTER, offset } from './fixtures.js';

function setup() {
  let clock = Date.parse('2026-11-08T10:00:00Z');
  const deps = { uuid: () => crypto.randomUUID(), hash: (s) => crypto.createHash('sha256').update(s).digest('hex'), hashSecret: (s, salt) => crypto.createHash('sha256').update(salt + ':' + s).digest('hex'), now: () => clock };
  const db = emptyDb();
  const e = new Engine(db, deps);
  seedDemo(e);
  const by = (email) => ({ id: db.users.find((u) => u.email === email).id });
  return { e, db, advance: (sec) => { clock += sec * 1000; return e.tick(); }, her: by('aamani@demo.betibachao.app'), op: by('operator@demo.betibachao.app'), admin: by('admin@demo.betibachao.app'), asha: by('asha@demo.betibachao.app'), loc: (x = {}) => ({ ...DEMO_CENTER, accuracyM: 12, source: 'gps', ...x }) };
}
const C = (n) => ({ name: `C${n}`, phone: `+9190000000${String(n).padStart(2, '0')}` });
const STATIONS = `name,district,lat,lng,phone,phone2
Nearby PS,Kurnool,${offset(DEMO_CENTER, 1.2, 90).lat},${offset(DEMO_CENTER, 1.2, 90).lng},+918518000001,
"Far PS, Town",Kurnool,${offset(DEMO_CENTER, 15, 0).lat},${offset(DEMO_CENTER, 15, 0).lng},+918518000002,+918518000003
broken row,,999,0,+91,`;

test('places: 1–3 contacts each; contacts switch automatically with her location; important contacts (1–5) everywhere', () => {
  const t = setup();
  assert.throws(() => t.e.setPlaces(t.her, { places: [{ ...DEMO_CENTER, label: 'Home', contacts: [] }] }), /1 to 3 contacts/);
  assert.throws(() => t.e.setPlaces(t.her, { places: [{ ...DEMO_CENTER, label: 'Home', contacts: [C(1), C(2), C(3), C(4)] }] }), /1 to 3 contacts/);
  assert.throws(() => t.e.setContacts(t.her, { contacts: [C(11), C(12), C(13), C(14), C(15), C(16)] }), /Up to 5 important/);
  const office = offset(DEMO_CENTER, 8, 90);
  t.e.setContacts(t.her, { contacts: [C(9), C(10)] });
  t.e.setPlaces(t.her, { places: [{ ...DEMO_CENTER, label: 'Home', radiusM: 1500, contacts: [C(1), C(2), C(3)] }, { label: 'Office', ...office, contacts: [C(4)] }] });
  const atHome = t.e.contactsFor(t.her.id, DEMO_CENTER);
  assert.equal(atHome.place.label, 'Home');
  assert.deepEqual(atHome.contacts.map((c) => c.name), ['C9', 'C10', 'C1', 'C2', 'C3']);
  const atOffice = t.e.contactsFor(t.her.id, offset(office, 0.3, 10));
  assert.equal(atOffice.place.label, 'Office');
  assert.deepEqual(atOffice.contacts.map((c) => c.name), ['C9', 'C10', 'C4']);
  const faraway = t.e.contactsFor(t.her.id, offset(DEMO_CENTER, 200, 0));
  assert.equal(faraway.place, null);
  assert.deepEqual(faraway.contacts.map((c) => c.name), ['C9', 'C10']); // important contacts when far from every place
  const { incident } = t.e.createIncident(t.her, { idempotencyKey: 'p1', location: t.loc(offset(office, 0.2, 0)) });
  assert.equal(incident.contactsPlace, 'Office');
});

test('police registry: CSV import (quoted names, bad rows skipped), nearest station lookup', () => {
  const t = setup();
  const r = t.e.importStations(t.admin, { csv: STATIONS });
  assert.equal(r.imported, 2); assert.equal(r.skipped, 1);
  assert.equal(t.e.nearestStations(DEMO_CENTER, 1)[0].name, 'Nearby PS');
  assert.ok(t.db.policeStations.some((s) => s.name === 'Far PS, Town' && s.phone2 === '+918518000003'));
  assert.throws(() => t.e.importStations(t.op, { csv: STATIONS }), /permission/);
  const help = t.e.nearbyHelp(t.her, DEMO_CENTER);
  assert.equal(help.stations[0].name, 'Nearby PS');
  assert.ok(help.chat.some((c) => c.whatsapp === '917993485111'));
});

test('operator clock: 60 s second alert, 120 s nearest police station connected; ack stops it', () => {
  const t = setup();
  t.e.importStations(t.admin, { csv: STATIONS });
  const { incident } = t.e.createIncident(t.her, { idempotencyKey: 'a', location: t.loc() });
  t.advance(61);
  assert.ok(t.db.escalations.some((x) => x.incidentId === incident.id && x.type === 'OPERATOR_NO_ACK'));
  assert.equal(incident.policeConnect, null);
  t.advance(60);
  assert.equal(incident.policeConnect.station.name, 'Nearby PS');
  assert.equal(incident.policeConnect.status, 'PENDING');
  assert.ok(t.db.notifications.some((n) => n.recipientId === t.her.id && n.kind === 'POLICE_CONNECTED'));
  const v = t.e.viewIncident(t.her, incident.id);
  assert.equal(v.police.station.phone, '+918518000001');

  // Acknowledged in time → no police auto-connect.
  const t2 = setup();
  const r2 = t2.e.createIncident(t2.her, { idempotencyKey: 'b', location: t2.loc() });
  t2.advance(30); t2.e.operatorAck(t2.op, r2.incident.id); t2.advance(200);
  assert.equal(r2.incident.policeConnect, null);
});

test('second SOS press before any operator acknowledges connects the police immediately', () => {
  const t = setup();
  t.e.importStations(t.admin, { csv: STATIONS });
  const first = t.e.createIncident(t.her, { idempotencyKey: 'x1', location: t.loc() });
  assert.equal(first.incident.policeConnect, null);
  const again = t.e.createIncident(t.her, { idempotencyKey: 'x2', location: t.loc() });
  assert.equal(again.duplicate, true);
  assert.match(first.incident.policeConnect.reason, /pressed SOS again/);
  // Without a station list she is still told to use 112 (her Android phone texts 112).
  const t2 = setup();
  const f2 = t2.e.createIncident(t2.her, { idempotencyKey: 'y1', location: t2.loc() });
  t2.e.createIncident(t2.her, { idempotencyKey: 'y2', location: t2.loc() });
  assert.equal(f2.incident.policeConnect.station, null);
  assert.equal(f2.incident.policeConnect.emergency, '112');
});

test('Track my travel: auto-arrival near destination; overdue → "Are you OK?" → automatic SOS', () => {
  const t = setup();
  const dest = offset(DEMO_CENTER, 5, 45);
  const v = t.e.startTrip(t.her, { destination: { ...dest, label: 'Hostel' }, expectedMin: 20, vehicle: 'ap 39 tx 1234', location: t.loc() });
  assert.equal(v.vehicle, 'AP 39 TX 1234');
  assert.ok(v.shareUrlPath.startsWith('/t/'));
  t.e.ingestDeviceLocation(t.her, t.loc(offset(DEMO_CENTER, 2, 45)));
  assert.equal(t.e.myTrip(t.her).trip.status, 'ACTIVE');
  t.e.ingestDeviceLocation(t.her, t.loc(offset(dest, 0.05, 0)));
  assert.equal(t.e.myTrip(t.her).trip.status, 'ARRIVED');

  t.e.startTrip(t.her, { destination: { ...dest, label: 'Hostel' }, expectedMin: 20, location: t.loc() });
  t.advance(20 * 60 + 10 * 60 + 1); // due + grace
  assert.ok(t.db.notifications.some((n) => n.recipientId === t.her.id && n.kind === 'TRIP_OVERDUE'));
  assert.equal(t.db.incidents.length, 0);
  t.advance(121);
  const trip = t.e.myTrip(t.her).trip;
  assert.equal(trip.status, 'SOS');
  const inc = t.db.incidents.find((i) => i.id === trip.incidentId);
  assert.equal(inc.trigger, 'trip_overdue');
  assert.match(inc.note, /Hostel/);
  // public link stays live while the SOS is open, hides location once over
  const token = t.db.trips.find((x) => x.id === trip.id).token;
  assert.equal(t.e.publicTrip(token).live, true);
});

test('evidence: only she and operators can access; retention purges after closure', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.her, { idempotencyKey: 'e', location: t.loc() });
  const ev = t.e.addEvidence(t.her, incident.id, { kind: 'audio', mime: 'audio/mp4', durationSec: 15, bytes: 1000, storageKey: 'k1' });
  assert.ok(t.e.evidenceFor(t.op, incident.id, ev.id));
  assert.throws(() => t.e.evidenceFor(t.asha, incident.id, ev.id), /FORBIDDEN/);
  assert.deepEqual(t.e.expiredEvidence(), []); // open incident → kept
  t.e.safetyConfirmation(t.her, incident.id, { response: 'YES', confirm: true });
  t.advance(31 * 86400);
  assert.deepEqual(t.e.expiredEvidence(), ['k1']);
});

test('dashboards: her stats, admin impact with daily series, public counter', () => {
  const t = setup();
  t.e.setPlaces(t.her, { places: [{ ...DEMO_CENTER, label: 'Home', contacts: [C(1), C(2), C(3)] }] });
  const { incident } = t.e.createIncident(t.her, { idempotencyKey: 'd', location: t.loc() });
  t.e.operatorAck(t.op, incident.id);
  t.advance(10);
  t.e.acceptIncident(t.asha, incident.id);
  t.advance(240);
  const asg = t.db.assignments.find((a) => a.incidentId === incident.id);
  t.e.updateAssignment(t.asha, asg.id, { status: 'ARRIVED' });
  t.e.safetyConfirmation(t.her, incident.id, { response: 'YES', confirm: true });
  const mine = t.e.myDashboard(t.her);
  assert.equal(mine.sos.total, 1); assert.equal(mine.sos.safe, 1);
  assert.ok(mine.sos.medianArriveMin > 4 && mine.sos.medianArriveMin < 4.5);
  assert.equal(mine.setup.placesReady, 1);
  assert.equal(mine.area.label, 'Home');
  const adm = t.e.adminDashboard(t.admin, { days: 30 });
  assert.equal(adm.period.protected, 1);
  assert.equal(adm.series.length, 30);
  assert.equal(adm.series.at(-1).protected, 1);
  assert.equal(adm.period.medianAckSec, 0);
  assert.equal(t.e.publicImpact().womenProtected, 1);
  assert.throws(() => t.e.adminDashboard(t.her), /permission/);
});

test('live SOS link: phone-made token works, shows live position until safe, hides location after; duress never revealed', () => {
  const t = setup();
  const tok = 'ab'.repeat(16);
  const { incident } = t.e.createIncident(t.her, { idempotencyKey: 'L1', location: t.loc(), shareToken: tok });
  let v = t.e.publicSos(tok);
  assert.equal(v.status, 'ACTIVE'); assert.equal(v.live, true);
  assert.ok(Math.abs(v.last.lat - DEMO_CENTER.lat) < 1e-4);
  assert.equal(v.name, t.e.user(t.her.id).displayName.split(' ')[0]);
  assert.equal(t.e.viewIncident(t.her, incident.id).liveSharePath, `/s/${tok}`);
  // second SOS press sends a new SMS with a new token — both links work
  const tok2 = 'cd'.repeat(16);
  t.e.createIncident(t.her, { idempotencyKey: 'L2', location: t.loc(), shareToken: tok2 });
  assert.equal(t.e.publicSos(tok2).status, 'ACTIVE');
  // bad / reused tokens are not accepted; unknown token → null
  assert.equal(t.e.publicSos('zz'), null);
  assert.equal(t.e.publicSos('00'.repeat(16)), null);
  t.e.acceptIncident(t.asha, incident.id);
  assert.equal(t.e.publicSos(tok).responders.coming + t.e.publicSos(tok).responders.arrived, 1);
  t.e.safetyConfirmation(t.her, incident.id, { response: 'YES', confirm: true });
  v = t.e.publicSos(tok);
  assert.equal(v.status, 'SAFE'); assert.equal(v.last, null); assert.equal(v.live, false);
  t.advance(25 * 3600);
  assert.equal(t.e.publicSos(tok).expired, true);

  const t2 = setup();
  t2.e.setPins?.(t2.her, { cancelPin: '1111', duressPin: '9999' });
  const r = t2.e.createIncident(t2.her, { idempotencyKey: 'D1', location: t2.loc(), shareToken: 'ef'.repeat(16) });
  r.incident.duress = true; // duress PIN entered (her screen now says "cancelled")
  const dv = t2.e.publicSos('ef'.repeat(16));
  assert.equal(dv.status, 'ENDED'); assert.equal(dv.last, undefined); assert.equal(dv.live, false);
});

test('trip counts: reached safely vs stopped sharing vs replaced, with her trip history', () => {
  const t = setup();
  const dest = { ...offset(DEMO_CENTER, 5, 45), label: 'Hostel' };
  t.e.startTrip(t.her, { destination: dest, expectedMin: 20, location: t.loc() }); t.e.endTrip(t.her, { safe: true });
  t.e.startTrip(t.her, { destination: dest, expectedMin: 20, location: t.loc() }); t.e.endTrip(t.her, { safe: true });
  t.e.startTrip(t.her, { destination: dest, expectedMin: 20, location: t.loc() }); t.e.endTrip(t.her, { safe: false });
  t.e.startTrip(t.her, { destination: dest, expectedMin: 20, location: t.loc() });
  t.e.startTrip(t.her, { destination: dest, expectedMin: 20, location: t.loc() }); // replaces the one before
  const d = t.e.myDashboard(t.her);
  assert.equal(d.trips.arrived, 2);
  assert.equal(d.community.safeTrips, 2);
  assert.equal(t.e.publicImpact().safeTrips, 2);
  assert.equal(d.trips.stopped, 2);
  assert.equal(d.trips.active, 1);
  assert.deepEqual(d.trips.recent.map((x) => x.status), ['ACTIVE', 'REPLACED', 'ENDED', 'ARRIVED', 'ARRIVED']);
});
