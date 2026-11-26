// Duress PIN: after a "cancel" with the duress PIN her phone must get nothing that reveals the SOS is live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, world, HER } from './helpers.js';

test('duress: no alerts or police call reach her phone; operators and volunteers still work', async () => {
  const S = await boot();
  const W = await world(S.base);
  await W.admin.call('POST', '/admin/police-stations/one', { name: 'Test PS', country: 'IN', lat: HER.lat + 0.01, lng: HER.lng, phone: '+919000000001' });
  await W.user.call('PATCH', '/me/pins', { cancelPin: '1111', duressPin: '2222' });
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'duress-1', location: { ...HER, accuracyM: 10, source: 'gps' } });
  const id = sos.body.incident.id;
  const c = await W.user.call('POST', `/incidents/${id}/cancel`, { pin: '2222' });
  assert.equal(c.body.status, 'USER_CANCELLED');
  assert.equal((await W.asha.call('POST', `/incidents/${id}/accept`, {})).status, 200); // help still comes
  const db = S.app.store.db; const inc = db.incidents.find((i) => i.id === id);
  S.app.engine.autoPolice(inc, 'test: no operator acknowledged');
  const toHer = db.notifications.filter((n) => n.incidentId === id && n.recipientId === inc.requesterId);
  assert.ok(toHer.length >= 1, 'notifications are recorded for the audit trail');
  assert.ok(toHer.every((n) => n.status === 'SUPPRESSED_DURESS'), 'nothing is delivered to her phone');
  assert.equal(inc.policeConnect.dial, null, 'her phone is never asked to dial');
  assert.equal(inc.policeConnect.status, 'PENDING', 'the station still gets the SMS job');
  const loc = await W.user.call('POST', '/me/location', { ...HER, accuracyM: 10, source: 'gps' });
  assert.equal(loc.body.policeCall, undefined, 'no police call in the background location reply');
  assert.ok(db.notifications.some((n) => n.incidentId === id && n.kind === 'ESCALATION' && n.status !== 'SUPPRESSED_DURESS'), 'operators are alerted');
  const view = await W.user.call('GET', `/incidents/${id}`);
  assert.equal(view.body.status, 'USER_CANCELLED');
  S.app.server.closeAllConnections?.(); S.app.server.close();
});

test('normal SOS: her phone still gets updates and the police call', async () => {
  const S = await boot();
  const W = await world(S.base);
  await W.admin.call('POST', '/admin/police-stations/one', { name: 'Test PS', country: 'IN', lat: HER.lat + 0.01, lng: HER.lng, phone: '+919000000001' });
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'normal-1', location: { ...HER, accuracyM: 10, source: 'gps' } });
  const id = sos.body.incident.id;
  await W.asha.call('POST', `/incidents/${id}/accept`, {});
  const db = S.app.store.db; const inc = db.incidents.find((i) => i.id === id);
  S.app.engine.autoPolice(inc, 'test');
  const toHer = db.notifications.filter((n) => n.incidentId === id && n.recipientId === inc.requesterId).map((n) => n.kind);
  assert.deepEqual(toHer.sort(), ['POLICE_CONNECTED', 'RESPONDER_ACCEPTED']);
  const loc = await W.user.call('POST', '/me/location', { ...HER, accuracyM: 10, source: 'gps' });
  assert.equal(loc.body.policeCall?.number, '+919000000001');
  S.app.server.closeAllConnections?.(); S.app.server.close();
});
