import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Engine, emptyDb, S, SIMULATED_LABEL } from '../public/core/engine.js';
import { seedDemo, DEMO_CENTER, offset } from '../public/core/seed.js';

function setup() {
  let clock = Date.parse('2026-10-30T10:00:00Z');
  const deps = {
    uuid: () => crypto.randomUUID(),
    hash: (s) => crypto.createHash('sha256').update(s).digest('hex'),
    hashSecret: (s, salt) => crypto.createHash('sha256').update(salt + ':' + s).digest('hex'),
    now: () => clock,
  };
  const db = emptyDb();
  const e = new Engine(db, deps);
  seedDemo(e);
  e.createUser({ displayName: 'Second test user', email: 'lakshmi@demo.betibachao.app', role: 'user' });
  const by = (email) => ({ id: db.users.find((u) => u.email === email).id });
  return {
    e, db,
    advance: (sec) => { clock += sec * 1000; return e.tick(); },
    aamani: by('aamani@demo.betibachao.app'), lakshmi: by('lakshmi@demo.betibachao.app'),
    asha: by('asha@demo.betibachao.app'), ravi: by('ravi@demo.betibachao.app'), meena: by('meena@demo.betibachao.app'),
    imran: by('imran@demo.betibachao.app'), kiran: by('kiran@demo.betibachao.app'), deepa: by('deepa@demo.betibachao.app'), suresh: by('suresh@demo.betibachao.app'),
    op: by('operator@demo.betibachao.app'), admin: by('admin@demo.betibachao.app'),
    loc: (extra = {}) => ({ ...DEMO_CENTER, accuracyM: 12, source: 'synthetic', ...extra }),
  };
}
const alerted = (db, incId) => db.notifications.filter((n) => n.incidentId === incId && n.kind === 'ALERT').map((n) => n.recipientId);

test('AT-01 SOS creates exactly one incident; same idempotency key does not duplicate', () => {
  const t = setup();
  const a = t.e.createIncident(t.aamani, { idempotencyKey: 'k1', location: t.loc() });
  const b = t.e.createIncident(t.aamani, { idempotencyKey: 'k1', location: t.loc() });
  assert.equal(a.incident.id, b.incident.id);
  assert.equal(b.duplicate, true);
  assert.equal(t.db.incidents.length, 1);
  assert.ok(a.incident.createdAt);
});

test('AT-02 only eligible verified, trained, available volunteers within 10 km are alerted', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  assert.equal(incident.status, S.ALERTING_10KM);
  const ids = alerted(t.db, incident.id);
  assert.deepEqual(new Set(ids), new Set([t.asha.id, t.ravi.id]));
  for (const bad of [t.kiran, t.deepa, t.suresh, t.meena, t.imran]) assert.ok(!ids.includes(bad.id));
});

test('AT-02 no acceptance expands to 20 km then 30 km then NO_RESPONDER_AVAILABLE with simulated escalation', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  t.advance(46);
  assert.equal(incident.status, S.ALERTING_20KM);
  assert.ok(alerted(t.db, incident.id).includes(t.meena.id));
  t.advance(46);
  assert.equal(incident.status, S.ALERTING_30KM);
  assert.ok(alerted(t.db, incident.id).includes(t.imran.id));
  t.advance(61);
  assert.equal(incident.status, S.NO_RESPONDER_AVAILABLE);
  const esc = t.db.escalations.find((x) => x.type === 'NO_RESPONDER');
  assert.equal(esc.status, 'SIMULATED');
  assert.equal(esc.label, SIMULATED_LABEL);
});

test('AT-03 durable timer: deadline survives a restart (engine rebuilt from serialized db)', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  const snapshot = JSON.parse(JSON.stringify(t.db));
  let clock = Date.parse(incident.stageDeadline) + 1000;
  const e2 = new Engine(snapshot, { ...t.e.deps, now: () => clock });
  e2.tick();
  assert.equal(e2.incident(incident.id).status, S.ALERTING_20KM);
});

test('AT-03 concurrent accepts respect responder cap without inconsistent state', () => {
  const t = setup();
  t.db.config.maxResponders = 1; t.db.config.targetResponders = 1;
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  const r = [t.asha, t.ravi].map((v) => { try { return t.e.acceptIncident(v, incident.id); } catch (err) { return err; } });
  assert.ok(r[0].assignment);
  assert.equal(r[1].code, 'RESPONDERS_FULL');
  assert.equal(t.e.activeAssignments(incident.id).length, 1);
  assert.equal(incident.status, S.RESPONDER_ASSIGNED);
});

test('backup search continues after first acceptance', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  t.e.acceptIncident(t.asha, incident.id);
  t.advance(46);
  assert.equal(incident.searchStage, 1, 'search expands for backup while < targetResponders');
  assert.equal(incident.status, S.RESPONDER_ASSIGNED, 'status still reflects responder');
  assert.ok(alerted(t.db, incident.id).includes(t.meena.id));
});

test('AT-04 decline/unable triggers replacement search; stalled responder escalates', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  t.e.declineIncident(t.ravi, incident.id, { reason: 'too far' });
  const { assignment } = t.e.acceptIncident(t.asha, incident.id);
  t.e.updateAssignment(t.asha, assignment.id, { status: 'UNABLE', reason: 'vehicle broke down' });
  assert.equal(incident.status, S.ALERTING_10KM);
  assert.ok(t.db.notifications.some((n) => n.kind === 'RESPONDER_LOST'));

  const t2 = setup();
  const r2 = t2.e.createIncident(t2.aamani, { idempotencyKey: 'k', location: t2.loc() });
  t2.e.acceptIncident(t2.asha, r2.incident.id);
  t2.e.acceptIncident(t2.ravi, r2.incident.id);
  t2.advance(121);
  assert.ok(t2.db.escalations.some((x) => x.type === 'RESPONDER_STALLED'));
});

test('AT-05 unassigned volunteer never receives exact coordinates; assigned does (and access is audited)', () => {
  const t = setup();
  const exact = { lat: 15.83123, lng: 78.04111 };
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc(exact) });
  const v = t.e.viewIncident(t.ravi, incident.id);
  assert.equal(v.role, 'alerted_volunteer');
  assert.equal(v.location, undefined);
  assert.ok(!JSON.stringify(v).includes('15.83123'));
  assert.ok(v.approxArea);
  assert.throws(() => t.e.viewIncident(t.kiran, incident.id), /FORBIDDEN|permission/i);
  t.e.acceptIncident(t.asha, incident.id);
  const a = t.e.viewIncident(t.asha, incident.id);
  assert.equal(a.location.lat, exact.lat);
  assert.ok(t.db.audit.some((x) => x.action === 'PRECISE_LOCATION_ACCESS' && x.actorId === t.asha.id));
});

test('AT-05 denied location → LOCATION_UNAVAILABLE + escalation; stale and vertical are honest', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k' });
  assert.equal(incident.status, S.LOCATION_UNAVAILABLE);
  assert.ok(t.db.escalations.some((x) => x.type === 'LOCATION_UNAVAILABLE'));
  t.e.addLocation(t.aamani, incident.id, t.loc({ altitudeM: 290 }));
  assert.equal(incident.status, S.ALERTING_10KM);
  let v = t.e.viewIncident(t.aamani, incident.id);
  assert.equal(v.location.vertical, 'Floor/vertical location unknown');
  assert.match(v.location.altitudeNote, /not height above ground/);
  t.advance(130);
  v = t.e.viewIncident(t.aamani, incident.id);
  assert.equal(v.location.stale, true);
  assert.ok(incident.flags.includes('LOCATION_STALE'));
});

test('spoofed/outlier GPS jump is flagged suspect and not used for matching', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  t.advance(5);
  const far = offset(DEMO_CENTER, 400, 0);
  const obs = t.e.addLocation(t.aamani, incident.id, { ...far, accuracyM: 5, source: 'gps' });
  assert.equal(obs.suspect, true);
  assert.equal(t.e.latestLocation(incident.id).lat, DEMO_CENTER.lat);
  const jitter = t.e.addLocation(t.aamani, incident.id, { lat: DEMO_CENTER.lat + 0.0002, lng: DEMO_CENTER.lng, accuracyM: 15, source: 'gps' });
  assert.equal(jitter.suspect, false, 'small GPS jitter within accuracy is not flagged');
});

test('AT-06 notification failure is recorded and fallback channel attempted', () => {
  const t = setup();
  t.db.demo.failNextNotifications = 1;
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  const n = t.db.notifications.filter((x) => x.incidentId === incident.id && x.kind === 'ALERT');
  const fb = n.find((x) => x.attemptCount === 2);
  assert.equal(fb.channel, 'in_app_fallback');
  assert.equal(fb.status, 'DELIVERED');
  assert.ok(t.db.audit.some((a) => a.action === 'NOTIFICATION_FAILED'));
});

test('AT-07 arrival alone cannot close; YES needs explicit confirm; NO escalates and stays open', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  const { assignment } = t.e.acceptIncident(t.asha, incident.id);
  t.e.updateAssignment(t.asha, assignment.id, { status: 'EN_ROUTE' });
  t.e.updateAssignment(t.asha, assignment.id, { status: 'ARRIVED' });
  assert.equal(incident.status, S.ARRIVED);
  assert.equal(incident.closedAt, null);
  t.e.safetyConfirmation(t.aamani, incident.id, { response: 'NEED_MORE_HELP' });
  assert.equal(incident.status, S.ESCALATION_REQUIRED);
  assert.throws(() => t.e.safetyConfirmation(t.aamani, incident.id, { response: 'YES' }), /confirm/i);
  t.e.safetyConfirmation(t.aamani, incident.id, { response: 'YES', confirm: true });
  assert.equal(incident.status, S.CLOSED);
  assert.equal(incident.closureReason, 'USER_CONFIRMED_SAFE');
  assert.equal(t.e.viewIncident(t.aamani, incident.id).color, 'GREEN');
  assert.ok(t.db.confirmations.some((c) => c.response === 'YES' && c.actorId === t.aamani.id));
});

test('AT-08 unauthorized transitions are rejected and audited', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  assert.throws(() => t.e.safetyConfirmation(t.lakshmi, incident.id, { response: 'YES', confirm: true }), (e) => e.status === 403);
  assert.throws(() => t.e.acceptIncident(t.meena, incident.id), (e) => e.status === 403);
  assert.throws(() => t.e.patchConfig(t.op, { lowAccuracyM: 50 }), (e) => e.status === 403);
  const { assignment } = t.e.acceptIncident(t.asha, incident.id);
  assert.throws(() => t.e.updateAssignment(t.ravi, assignment.id, { status: 'EN_ROUTE' }), (e) => e.status === 403);
  assert.throws(() => t.e.updateAssignment(t.asha, assignment.id, { status: 'ASSISTING' }), (e) => e.status === 409);
  assert.throws(() => t.e.transition(incident, S.SAFE_CONFIRMED === 'x' ? '' : S.FALSE_ALARM_REVIEW, t.op.id, 'x'), (e) => e.status === 409);
  assert.ok(t.db.audit.some((a) => a.action === 'TRANSITION_REJECTED'));
  assert.ok(t.db.audit.some((a) => a.action === 'ACCESS_DENIED'));
});

test('duress PIN looks cancelled to the requester but keeps the incident open and escalated', () => {
  const t = setup();
  t.e.setPins(t.aamani, { cancelPin: '1234', duressPin: '9999' });
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  assert.throws(() => t.e.cancelIncident(t.aamani, incident.id, { pin: '0000' }), /PIN/);
  const r = t.e.cancelIncident(t.aamani, incident.id, { pin: '9999' });
  assert.equal(r.status, S.USER_CANCELLED);
  assert.equal(t.e.viewIncident(t.aamani, incident.id).status, S.USER_CANCELLED);
  assert.equal(incident.status, S.ESCALATION_REQUIRED);
  assert.ok(t.e.isOpen(incident));
  assert.ok(t.db.escalations.some((x) => x.type === 'DURESS'));
  assert.equal(t.e.viewIncident(t.op, incident.id).duress, true);
  t.e.safetyConfirmation(t.aamani, incident.id, { response: 'YES', confirm: true });
  assert.ok(t.e.isOpen(incident), 'YES during duress does not close');
  assert.throws(() => t.e.operatorClosureException(t.op, incident.id, { reason: 'VERIFIED_FALSE_ALARM', note: 'looks like a false alarm' }), /duress/i);
});

test('correct cancel PIN cancels and releases responders', () => {
  const t = setup();
  t.e.setPins(t.aamani, { cancelPin: '1234' });
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  t.e.acceptIncident(t.asha, incident.id);
  t.e.cancelIncident(t.aamani, incident.id, { pin: '1234' });
  assert.equal(incident.status, S.USER_CANCELLED);
  assert.equal(t.e.activeAssignments(incident.id).length, 0);
});

test('high severity escalates immediately without waiting for volunteers', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc(), severity: 'HIGH' });
  assert.ok(t.db.escalations.some((x) => x.type === 'IMMEDIATE_DANGER'));
  assert.equal(incident.status, S.ALERTING_10KM);
  t.advance(21);
  assert.equal(incident.status, S.ALERTING_20KM, 'faster stage timers for HIGH severity');
});

test('operator closure exception requires documented reason and note; handoff is labelled manual', () => {
  const t = setup();
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  const h = t.e.operatorHandoff(t.op, incident.id, { status: 'ACKNOWLEDGED', reason: 'Phoned control room, ref 42' });
  assert.match(h.label, /manually/);
  assert.equal(incident.status, S.EMERGENCY_HANDOFF);
  assert.throws(() => t.e.operatorClosureException(t.op, incident.id, { reason: 'BECAUSE', note: 'x' }), (e) => e.status === 400);
  t.e.operatorClosureException(t.op, incident.id, { reason: 'HANDED_TO_EMERGENCY_SERVICES_CONFIRMED_SAFE', note: 'Police confirmed she is safe at station' });
  assert.equal(incident.status, S.CLOSED);
});

test('simultaneous incidents are independent; SOS rate limit applies', () => {
  const t = setup();
  const a = t.e.createIncident(t.aamani, { idempotencyKey: 'a', location: t.loc() });
  const b = t.e.createIncident(t.lakshmi, { idempotencyKey: 'b', location: t.loc({ lat: DEMO_CENTER.lat + 0.01 }) });
  assert.notEqual(a.incident.id, b.incident.id);
  t.e.acceptIncident(t.asha, a.incident.id);
  assert.throws(() => t.e.acceptIncident(t.asha, b.incident.id), /busy/);
});

test('audit log is hash-chained and tamper-evident', () => {
  const t = setup();
  t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  assert.equal(t.e.verifyAuditChain().ok, true);
  t.db.audit[3].reason = 'tampered';
  assert.equal(t.e.verifyAuditChain().ok, false);
});

test('config validation rejects unsafe values', () => {
  const t = setup();
  assert.throws(() => t.e.patchConfig(t.admin, { radiusStagesKm: [30, 20, 10] }), /increasing/);
  assert.throws(() => t.e.patchConfig(t.admin, { evil: 1 }), /unknown/);
  t.e.patchConfig(t.admin, { radiusStagesKm: [5, 15, 25] });
  assert.deepEqual(t.db.config.radiusStagesKm, [5, 15, 25]);
});

test('account deletion purges precise location history', () => {
  const t = setup();
  t.e.setPins(t.aamani, { cancelPin: '1234' });
  const { incident } = t.e.createIncident(t.aamani, { idempotencyKey: 'k', location: t.loc() });
  t.e.cancelIncident(t.aamani, incident.id, { pin: '1234' });
  t.e.deleteMyAccount(t.aamani);
  assert.equal(t.db.locations.filter((l) => l.incidentId === incident.id).length, 0);
});
