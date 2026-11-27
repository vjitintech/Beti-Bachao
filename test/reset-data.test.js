// Admin "clear all women and volunteer data": keeps staff, stations and settings; backup first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { boot, world, client, HER, ADMIN, PASSWORD } from './helpers.js';

test('reset data removes women, volunteers and SOS history; keeps admins, operators, stations, settings', async () => {
  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-bk-'));
  const S = await boot(null, { BACKUP_DIR: backupDir });
  const W = await world(S.base);
  await W.admin.call('POST', '/admin/staff', { displayName: 'Op One', email: 'op1@test.betibachao.app', role: 'operator', password: 'operator-pass-123' });
  await W.admin.call('POST', '/admin/police-stations/one', { name: 'Test PS', country: 'IN', lat: HER.lat + 0.01, lng: HER.lng, phone: '+919000000001' });
  await W.admin.call('PATCH', '/admin/config', { targetResponders: 3 });
  const sos = await W.user.call('POST', '/incidents', { idempotencyKey: 'r-1', location: { ...HER, accuracyM: 10, source: 'gps' } });
  await W.asha.call('POST', `/incidents/${sos.body.incident.id}/accept`, {});
  const db = () => S.app.store.db;
  const cfgBefore = JSON.stringify(db().config);
  assert.ok(db().incidents.length && db().volunteers.length && db().audit.length > 5);

  // Guards: wrong word, wrong password, non-admin.
  assert.equal((await W.admin.call('POST', '/admin/reset-data', { confirm: 'reset', password: ADMIN.password })).status, 400);
  assert.equal((await W.admin.call('POST', '/admin/reset-data', { confirm: 'RESET', password: 'nope' })).status, 400);
  assert.equal((await W.user.call('POST', '/admin/reset-data', { confirm: 'RESET', password: PASSWORD })).status, 403);
  assert.ok(db().incidents.length, 'nothing deleted by refused calls');

  const r = await W.admin.call('POST', '/admin/reset-data', { confirm: 'RESET', password: ADMIN.password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.removed.users, 1); assert.equal(r.body.removed.volunteers, 4); assert.equal(r.body.removed.incidents, 1);
  assert.ok(r.body.backup && fs.existsSync(path.join(backupDir, r.body.backup)), 'backup written first');
  const backup = JSON.parse(fs.readFileSync(path.join(backupDir, r.body.backup), 'utf8'));
  assert.equal(backup.incidents.length, 1, 'backup holds the old data');

  assert.deepEqual(db().users.map((u) => u.role).sort(), ['admin', 'operator']);
  for (const k of ['volunteers', 'verifications', 'incidents', 'locations', 'assignments', 'notifications', 'trips', 'evidence', 'events']) assert.equal(db()[k].length, 0, k);
  assert.equal(db().eventSeq, 0);
  assert.equal(db().policeStations.length, 1, 'stations kept');
  assert.equal(JSON.stringify(db().config), cfgBefore, 'settings kept');
  assert.equal(db().audit.length, 1); assert.equal(db().audit[0].action, 'DATA_RESET');
  assert.ok(S.app.engine.verifyAuditChain().ok, 'fresh audit chain is intact');

  // Deleted accounts are signed out; staff still work; new sign-ups and SOS start from zero.
  assert.equal((await W.user.call('GET', '/me')).status, 401);
  assert.equal((await W.asha.call('GET', '/me')).status, 401);
  assert.equal((await W.admin.call('GET', '/me')).status, 200);
  const op = client(S.base); assert.equal((await op.login('op1@test.betibachao.app', 'operator-pass-123')).status, 200);
  const again = client(S.base); assert.equal((await again.register('Aamani', 'aamani@test.betibachao.app', 'user')).status, 200, 'same email can register again');
  const s2 = await again.call('POST', '/incidents', { idempotencyKey: 'r-2', location: { ...HER, accuracyM: 10, source: 'gps' } });
  assert.ok([200, 201].includes(s2.status), JSON.stringify(s2.body));
  S.app.server.closeAllConnections?.(); S.app.server.close();
});
