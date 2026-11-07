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
  const rows = await pg.query('SELECT doc::text AS doc, version::text AS version FROM bb_state WHERE id = 1');
  if (rows.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.pg.tmp';
    fs.writeFileSync(tmp, rows[0].doc, { mode: 0o600 });
    fs.renameSync(tmp, file);
    console.log(`[db] Loaded state from PostgreSQL (version ${rows[0].version}).`);
  } else if (fs.existsSync(file)) {
    await pg.query('INSERT INTO bb_state (id, doc) VALUES (1, $1::jsonb) ON CONFLICT (id) DO NOTHING', [fs.readFileSync(file, 'utf8')]);
    console.log('[db] PostgreSQL was empty — copied the existing local data into it.');
  } else console.log('[db] PostgreSQL connected (empty; first run).');
  return pg;
}

// Write-behind mirror: every save() queues the latest snapshot; writes are coalesced
// so PostgreSQL always ends up with the newest state, at most one write in flight.
export function attachPostgres(store, pg, { url = null, onError = (e) => console.error('[db]', e.message) } = {}) {
  const save = store.save.bind(store);
  let writing = null; let again = false;
  const status = { ok: true, lastWriteAt: null, lastError: null, writes: 0 };
  const write = () => {
    if (writing) { again = true; return writing; }
    const doc = JSON.stringify(store.db);
    const conn = pg.dead && url ? new PgClient(url).connect().then((c) => { pg = c; return c; }) : Promise.resolve(pg);
    writing = conn.then((c) => c.query('INSERT INTO bb_state (id, doc) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, version = bb_state.version + 1, updated_at = now()', [doc]))
      .then(() => { status.ok = true; status.lastWriteAt = new Date().toISOString(); status.writes++; })
      .catch((e) => { status.ok = false; status.lastError = e.message; onError(e); again = true; })
      .finally(() => { writing = null; if (again) { again = false; setTimeout(write, status.ok ? 0 : 2000).unref?.(); } });
    return writing;
  };
  store.save = () => { save(); write(); };
  store.pg = { status, flush: async () => { while (writing) await writing; if (again) { again = false; await write(); } }, close: () => pg.end() };
  // Throttle the error log while the database is unreachable.
  let lastLog = 0; const log = onError; onError = (e) => { if (Date.now() - lastLog > 60000) { lastLog = Date.now(); log(e); } };
  return store.pg;
}
