import crypto from 'node:crypto';

export const uuid = () => crypto.randomUUID();
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Passwords: scrypt with per-user salt.
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return `scrypt$${salt}$${h}`;
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.startsWith('scrypt$')) return false;
  const [, salt, h] = stored.split('$');
  const got = crypto.scryptSync(String(pw), salt, 32, { N: 16384, r: 8, p: 1 });
  const want = Buffer.from(h, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
// PINs: keyed hash with per-user salt (short secrets — rate limited at the API).
export const hashSecret = (secret, salt) => crypto.scryptSync(String(secret), 'pin:' + salt, 32, { N: 4096, r: 8, p: 1 }).toString('hex');

// ---- TOTP (RFC 6238) for operator/admin MFA ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newTotpSecret() {
  const bytes = crypto.randomBytes(20);
  let bits = '', out = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function b32decode(s) {
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secret, t = Date.now(), step = 30) {
  const counter = Math.floor(t / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}
export function verifyTotp(secret, code, t = Date.now()) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  return [-1, 0, 1].some((w) => totp(secret, t + w * 30000) === String(code));
}

// ---- rate limiting (fixed window per key) ----
export class RateLimiter {
  constructor() { this.hits = new Map(); }
  check(key, limit, windowMs) {
    const now = Date.now();
    const e = this.hits.get(key);
    if (!e || now > e.reset) { this.hits.set(key, { n: 1, reset: now + windowMs }); return true; }
    e.n += 1;
    if (this.hits.size > 50000) this.hits.clear();
    return e.n <= limit;
  }
}

export function securityHeaders(secure) {
  const h = {
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; frame-src https://maps.google.com https://www.google.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'geolocation=(self), microphone=(self), camera=(self), accelerometer=(self)',
  };
  if (secure) h['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return h;
}
