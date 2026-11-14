// Latest Android app info for the website download card and the in-app "update available" banner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './helpers.js';
import { createServer } from '../server/server.js';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

test('GET /app/latest: off in tests → null; APK_LATEST_BUILD override', async () => {
  const S = await boot();
  const r = await (await fetch(S.base + '/app/latest')).json();
  assert.equal(r.android, null);
  assert.match(r.download, /BetiBachao24x7\.apk$/);
  S.app.server.close(); await S.app.shutdown?.();
  const S2 = await boot(null, { APK_LATEST_BUILD: '41' });
  const r2 = await (await fetch(S2.base + '/app/latest')).json();
  assert.equal(r2.android.version, '1.0.41'); assert.equal(r2.android.build, 41);
  S2.app.server.close(); await S2.app.shutdown?.();
});

test('GET /app/latest reads the GitHub release (build #, size, date) and caches it', async () => {
  let hits = 0;
  const fetchImpl = async (url) => { hits++; return { ok: true, status: 200, json: async () => ({ name: 'Beti Bachao Android (latest build #57)', body: 'Built from abc1234.', published_at: '2026-11-14T10:00:00Z', assets: [{ name: 'BetiBachao-debug.apk', size: 1 }, { name: 'BetiBachao24x7.apk', size: 14620456, updated_at: '2026-11-14T10:05:00Z' }] }) }; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-'));
  const app = createServer({ env: { DATA_FILE: path.join(dir, 'db.json'), ACCESS_LOG: 'off', ROUTING_URL: 'off', APK_RELEASE_API: 'https://example.test/release' }, tickMs: 100, fetchImpl });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v1`;
  const a = await (await fetch(base + '/app/latest')).json();
  await fetch(base + '/app/latest');
  assert.equal(a.android.version, '1.0.57'); assert.equal(a.android.sha, 'abc1234');
  assert.equal(a.android.sizeMb, 13.9); assert.equal(a.android.publishedAt, '2026-11-14T10:05:00Z');
  assert.equal(hits, 1);
  app.server.close(); await app.shutdown?.();
});
