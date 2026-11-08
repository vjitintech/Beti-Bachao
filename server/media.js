// Encrypted storage for SOS evidence recordings (audio/video).
// Each file is AES-256-GCM encrypted at rest ("BBM1" | iv | tag | ciphertext).
// Key: MEDIA_KEY (64 hex chars) — otherwise one is generated once and kept in
// <dir>/.media-key (0600). Keep a copy of that key: without it recordings cannot be read.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createMediaStore({ dir, keyHex = null }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let key;
  if (keyHex) {
    if (!/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error('MEDIA_KEY must be 64 hex characters');
    key = Buffer.from(keyHex, 'hex');
  } else {
    const kf = path.join(dir, '.media-key');
    if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    key = Buffer.from(fs.readFileSync(kf, 'utf8').trim(), 'hex');
  }
  const file = (k) => { if (!/^[a-f0-9]{32}$/.test(k)) throw new Error('bad media key'); return path.join(dir, k + '.bbm'); };
  return {
    dir,
    put(buf) {
      const k = crypto.randomBytes(16).toString('hex');
      const iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv('aes-256-gcm', key, iv);
      const enc = Buffer.concat([c.update(buf), c.final()]);
      fs.writeFileSync(file(k), Buffer.concat([Buffer.from('BBM1'), iv, c.getAuthTag(), enc]), { mode: 0o600 });
      return k;
    },
    get(k) {
      const b = fs.readFileSync(file(k));
      if (b.subarray(0, 4).toString() !== 'BBM1') throw new Error('not a media file');
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(4, 16));
      d.setAuthTag(b.subarray(16, 32));
      return Buffer.concat([d.update(b.subarray(32)), d.final()]);
    },
    del(k) { try { fs.unlinkSync(file(k)); } catch {} },
  };
}
