// Durable JSON store with atomic writes (write temp file → fsync → rename).
// MVP persistence adapter. Production target is PostgreSQL + PostGIS — see
// db/migrations/001_init.sql, which mirrors these collections table-for-table.
import fs from 'node:fs';
import path from 'node:path';
import { emptyDb } from '../public/core/engine.js';

export class JsonStore {
  constructor(file) {
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyDb();
    this.db.sessions ||= [];
    this.dirty = false;
  }
  get fresh() { return this.db.users.length === 0; }
  markDirty() { this.dirty = true; }
  save() {
    const tmp = this.file + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, JSON.stringify(this.db));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
  flush() { if (this.dirty) this.save(); }
  reset() { this.db = { ...emptyDb(), sessions: [] }; this.save(); }
}
