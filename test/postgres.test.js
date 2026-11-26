// PostgreSQL storage (set TEST_DATABASE_URL to run; CI provides a postgres service).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PgClient } from '../server/pg.js';
import { openPostgres } from '../server/pgstore.js';
import { createServer } from '../server/server.js';
import { client, ADMIN } from './helpers.js';

const URL_ = process.env.TEST_DATABASE_URL;
const skip = !URL_ && 'TEST_DATABASE_URL not set';

test('pg client: SCRAM login, parameters, NULLs, unicode, errors', { skip }, async () => {
  const pg = await new PgClient(URL_).connect();
  const [r] = await pg.query("SELECT $1::text AS a, $2::int + 1 AS b, $3::text AS c, 'नमस्ते' AS d", ['x', '41', null]);
  assert.deepEqual(r, { a: 'x', b: '42', c: null, d: 'नमस्ते' });
  await assert.rejects(pg.query('SELECT * FROM no_such_table'), /42P01/);
  const [again] = await pg.query('SELECT 1 AS ok'); // connection still usable after an error
  assert.equal(again.ok, '1');
  pg.end();
});

test('server state survives a wiped disk when DATABASE_URL is set', { skip }, async () => {
  const pg0 = await new PgClient(URL_).connect();
  await pg0.query('DROP TABLE IF EXISTS bb_state');
  pg0.end();
  const env = (file) => ({ DATA_FILE: file, ADMIN_EMAIL: ADMIN.email, ADMIN_PASSWORD: ADMIN.password, ADMIN_MFA_SECRET: ADMIN.mfaSecret, RATE_LIMIT_MULTIPLIER: '50', BACKUP_DIR: 'off' });

  // First "deploy": register a user.
  const file1 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbpg-')), 'db.json');
  const pg1 = await openPostgres(URL_, file1);
  const a = createServer({ env: env(file1), tickMs: 50, pg: pg1, pgUrl: URL_ });
  await new Promise((r) => a.server.listen(0, r));
  const base1 = `http://127.0.0.1:${a.server.address().port}/api/v1`;
  const u = client(base1);
  assert.equal((await u.register('Lakshmi', 'lakshmi@test.betibachao.app', 'user')).status, 200);
  await a.store.pg.flush();
  assert.equal(a.store.pg.status.ok, true);
  const admin = client(base1); await admin.adminLogin();
  const ints = await admin.call('GET', '/admin/integrations');
  assert.equal(ints.body.items.find((x) => x.name === 'Database').status, 'POSTGRESQL');
  await new Promise((r) => a.server.close(r));
  await a.store.pg.flush(); a.store.pg.close();

  // Second "deploy" on a fresh, empty disk: data comes back from PostgreSQL.
  const file2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbpg-')), 'db.json');
  const pg2 = await openPostgres(URL_, file2);
  const b = createServer({ env: env(file2), tickMs: 50, pg: pg2, pgUrl: URL_ });
  await new Promise((r) => b.server.listen(0, r));
  const base2 = `http://127.0.0.1:${b.server.address().port}/api/v1`;
  const again = client(base2);
  assert.equal((await again.login('lakshmi@test.betibachao.app')).status, 200);
  await new Promise((r) => b.server.close(r));
  await b.store.pg.flush(); b.store.pg.close();
});

test('mirror writes are spaced out and identical snapshots are skipped', { skip }, async () => {
  const { attachPostgres } = await import('../server/pgstore.js');
  const pg = await new PgClient(URL_).connect();
  await pg.query('DROP TABLE IF EXISTS bb_state');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbpg-')), 'db.json');
  const pgc = await openPostgres(URL_, file);
  const store = { db: { n: 0 }, save() {} };
  attachPostgres(store, pgc, { url: URL_, intervalMs: 300 });
  for (let i = 0; i < 50; i++) { store.db.n = i; store.save(); await new Promise((r) => setTimeout(r, 10)); }
  await store.pg.flush();
  assert.ok(store.pg.status.writes <= 4, `expected few writes, got ${store.pg.status.writes}`);
  const [row] = await pg.query("SELECT doc->>'n' AS n FROM bb_state WHERE id = 1");
  assert.equal(row.n, '49'); // latest state always lands
  const before = store.pg.status.writes;
  await store.pg.flush(); // nothing changed → no write
  assert.equal(store.pg.status.writes, before);
  store.pg.close(); pg.end();
});

test('a newer disk copy is kept (and copied up) instead of being rolled back', { skip }, async () => {
  const pg = await new PgClient(URL_).connect();
  await pg.query('DROP TABLE IF EXISTS bb_state');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbpg-')), 'db.json');
  fs.writeFileSync(file, JSON.stringify({ v: 'old' }));
  (await openPostgres(URL_, file)).end(); // PostgreSQL now holds "old"
  await pg.query("UPDATE bb_state SET updated_at = now() - interval '1 hour'");
  fs.writeFileSync(file, JSON.stringify({ v: 'new' })); // saved to disk while the database was down
  (await openPostgres(URL_, file)).end();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 'new');
  const [row] = await pg.query("SELECT doc->>'v' AS v FROM bb_state WHERE id = 1");
  assert.equal(row.v, 'new');
  // And a fresh, empty disk still restores from PostgreSQL.
  const file2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bbpg-')), 'db.json');
  (await openPostgres(URL_, file2)).end();
  assert.equal(JSON.parse(fs.readFileSync(file2, 'utf8')).v, 'new');
  pg.end();
});
