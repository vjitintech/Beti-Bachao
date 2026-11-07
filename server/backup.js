// Automatic daily backups of the data file, kept on disk (BACKUP_DIR), optionally
// encrypted with AES-256-GCM (BACKUP_KEY = 64 hex chars). Restore with
// `node scripts/restore-backup.mjs <file> [key]`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function encrypt(buf, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== 32) throw new Error('BACKUP_KEY must be 64 hex characters');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('BBK1'), iv, c.getAuthTag(), enc]);
}
export function decrypt(buf, keyHex) {
  if (buf.subarray(0, 4).toString() !== 'BBK1') return buf; // plain backup
  const key = Buffer.from(keyHex, 'hex');
  const d = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16));
  d.setAuthTag(buf.subarray(16, 32));
  return Buffer.concat([d.update(buf.subarray(32)), d.final()]);
}

export function createBackups({ dir, keep = 14, keyHex = null, everyMs = 24 * 3600e3 }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let last = 0;
  for (const f of fs.readdirSync(dir)) { const t = fs.statSync(path.join(dir, f)).mtimeMs; if (t > last) last = t; }
  return {
    dir,
    due: () => Date.now() - last >= everyMs,
    run(db) {
      const { sessions, ...rest } = db;
      let buf = Buffer.from(JSON.stringify(rest));
      if (keyHex) buf = encrypt(buf, keyHex);
      const name = `beti-bachao-${new Date().toISOString().replace(/[:.]/g, '-')}.json${keyHex ? '.enc' : ''}`;
      fs.writeFileSync(path.join(dir, name), buf, { mode: 0o600 });
      last = Date.now();
      const files = fs.readdirSync(dir).filter((f) => f.startsWith('beti-bachao-')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
      return name;
    },
  };
}
