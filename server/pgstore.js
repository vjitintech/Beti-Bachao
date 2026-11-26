// PostgreSQL durability for the state store (set DATABASE_URL).
// The server keeps working from its in-memory state + local file (fast, simple),
// and every save is also written to PostgreSQL, so the data survives restarts and
// redeploys on hosts whose disks are wiped (Render free tier, containers, Codespaces).
// On start the latest state is pulled from PostgreSQL before the server opens.
import fs from 'node:fs';
import path from 'node:path';
import { PgClient } from './pg.js';

const DDL = `CREATE TABLE IF NOT EXISTS bb_state (
  id INT PRIMARY KEY,
  doc JSONB NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

export async function openPostgres(url, file) {
  const pg = await new PgClient(url).connect();
  await pg.query(DDL);
  const rows = await pg.query("SELECT doc::text AS doc, version::text AS version, (extract(epoch from updated_at) * 1000)::bigint::text AS at FROM bb_state WHERE id = 1");
  const local = fs.existsSync(file) ? fs.statSync(file) : null;
  if (rows.length && local && local.size > 0 && local.mtimeMs > Number(rows[0].at) + 5000) {
    // The disk copy is newer (e.g. the database was down while the app kept saving to disk):
    // keep it and bring PostgreSQL up to date instead of rolling the data back.
    await pg.query('UPDATE bb_state SET doc = $1::jsonb, version = version + 1, updated_at = now() WHERE id = 1', [fs.readFileSync(file, 'utf8')]);
    console.log(`[db] Local data is newer than PostgreSQL (version ${rows[0].version}) — kept it and copied it to PostgreSQL.`);
  } else if (rows.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.pg.tmp';
    fs.writeFileSync(tmp, rows[0].doc, { mode: 0o600 });
    fs.renameSync(tmp, file);
    console.log(`[db] Loaded state from PostgreSQL (version ${rows[0].version}).`);
  } else if (local) {
    await pg.query('INSERT INTO bb_state (id, doc) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [fs.readFileSync(file, 'utf8')]);
    console.log('[db] PostgreSQL was empty — copied the existing local data into it.');
  } else console.log('[db] PostgreSQL connected (empty; first run).');
  return pg;
}

// Write-behind mirror: every save() queues the latest snapshot; writes are coalesced
// so PostgreSQL always ends up with the newest state, at most one write in flight.
// Write-behind mirror: save() queues the latest snapshot; writes are coalesced and
// spaced at least PG_WRITE_INTERVAL_MS apart (default 15 s), and identical snapshots are
// skipped. Each write replaces the whole document, so writing on every save (location
// pings every few seconds) filled a 1 GB database with WAL. The disk file is still saved
// on every change; PostgreSQL is the off-host copy, and flush() writes immediately.
export function attachPostgres(store, pg, { url = null, intervalMs = Number(process.env.PG_WRITE_INTERVAL_MS || 15000), onError = (e) => console.error('[db]', e.message) } = {}) {
  const save = store.save.bind(store);
  let writing = null; let again = false; let timer = null; let lastAt = 0; let lastDoc = null;
  const status = { ok: true, lastWriteAt: null, lastError: null, writes: 0 };
  // Throttle the error log while the database is unreachable.
  let lastLog = 0; const log = onError; onError = (e) => { if (Date.now() - lastLog > 60000) { lastLog = Date.now(); log(e); } };
  const write = () => {
    if (writing) { again = true; return writing; }
    const doc = JSON.stringify(store.db);
    if (doc === lastDoc && status.ok) return Promise.resolve();
    lastAt = Date.now();
    const conn = pg.dead && url ? new PgClient(url).connect().then((c) => { pg = c; return c; }) : Promise.resolve(pg);
    writing = conn.then((c) => c.query('INSERT INTO bb_state (id, doc) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = bb_state.version + 1, updated_at = now()', [doc]))
      .then(() => { lastDoc = doc; status.ok = true; status.lastWriteAt = new Date().toISOString(); status.writes++; })
      .catch((e) => { status.ok = false; status.lastError = e.message; onError(e); again = true; })
      .finally(() => { writing = null; if (again) { again = false; schedule(status.ok ? 0 : 2000); } });
    return writing;
  };
  const schedule = (minDelay = 0) => {
    if (writing) { again = true; return; }
    if (timer) return;
    const wait = Math.max(minDelay, lastAt + intervalMs - Date.now(), 0);
    timer = setTimeout(() => { timer = null; write(); }, wait); timer.unref?.();
  };
  store.save = () => { save(); schedule(); };
  store.pg = {
    status,
    flush: async () => { clearTimeout(timer); timer = null; while (writing) await writing; again = false; await write(); while (writing) await writing; },
    close: () => { clearTimeout(timer); timer = null; pg.end(); },
  };
  return store.pg;
}
