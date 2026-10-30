// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption
// (RFC 8188 / RFC 8291), implemented with Node's built-in crypto — no dependencies.
// Payloads are end-to-end encrypted: the browser's push service cannot read them.
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

function privateKeyObject(vapid) {
  const pub = unb64u(vapid.publicKey);
  return crypto.createPrivateKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: vapid.privateKey } });
}

export function vapidAuthHeader(endpoint, vapid, subject, now = Date.now()) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKeyObject(vapid), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${vapid.publicKey}`;
}

// Encrypts one push message for a subscription { keys: { p256dh, auth } }.
export function encryptPayload(subscription, plaintext, { salt = crypto.randomBytes(16), ecdh = null } = {}) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('invalid subscription keys');
  const as = ecdh || crypto.createECDH('prime256v1');
  if (!ecdh) as.generateKeys();
  const asPublic = as.getPublicKey();
  const shared = as.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Sends one notification. Resolves { ok, status, gone } — gone=true means the
// subscription expired (404/410) and should be deleted.
export async function sendPush(subscription, payload, { vapid, subject, ttl = 120, urgency = 'high', fetchImpl = fetch } = {}) {
  const endpoint = String(subscription.endpoint || '');
  if (!endpoint.startsWith('https://')) return { ok: false, status: 0, gone: true };
  let body;
  try { body = encryptPayload(subscription, JSON.stringify(payload)); } catch (e) { return { ok: false, status: 0, gone: true, error: 'invalid subscription keys' }; }
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { TTL: String(ttl), Urgency: urgency, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidAuthHeader(endpoint, vapid, subject) },
      body,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: e.message };
  }
}

export function isValidSubscription(sub) {
  try { encryptPayload(sub, 'probe'); return true; } catch { return false; }
}
