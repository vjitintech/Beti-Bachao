import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { generateVapidKeys, vapidAuthHeader, encryptPayload, sendPush } from '../server/webpush.js';

const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();

// Acts like the browser: decrypt an aes128gcm push message with the subscription's private key.
function browserDecrypt(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = uaEcdh.getPublicKey();
  const shared = uaEcdh.computeSecret(asPublic);
  const ikm = hmac(hmac(authSecret, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(pt[pt.length - 1], 2, 'last-record delimiter');
  return pt.subarray(0, pt.length - 1).toString();
}

function fakeSubscription() {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ua, auth, sub: { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}

test('web push payload encryption round-trips like a browser would decrypt it', () => {
  const { ua, auth, sub } = fakeSubscription();
  const msg = JSON.stringify({ title: '🚨 SOS nearby', body: 'A woman needs help 2.1 km away' });
  const body = encryptPayload(sub, msg);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(browserDecrypt(body, ua, auth), msg);
});

test('VAPID JWT is a valid ES256 signature for the push service origin', () => {
  const vapid = generateVapidKeys();
  const h = vapidAuthHeader('https://fcm.googleapis.com/fcm/send/xyz', vapid, 'mailto:ops@example.org');
  const [, jwt, k] = h.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(k, vapid.publicKey);
  const [hd, pl, sig] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(pl, 'base64url'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.equal(claims.sub, 'mailto:ops@example.org');
  const pub = Buffer.from(vapid.publicKey, 'base64url');
  const key = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') } });
  assert.ok(crypto.verify('sha256', Buffer.from(`${hd}.${pl}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
});

test('sendPush posts correct headers and reports expired subscriptions', async () => {
  const { sub } = fakeSubscription();
  const vapid = generateVapidKeys();
  let seen;
  const ok = await sendPush(sub, { title: 't' }, { vapid, subject: 'mailto:a@b.c', fetchImpl: async (url, opts) => { seen = opts; return { status: 201 }; } });
  assert.equal(ok.ok, true);
  assert.equal(seen.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(seen.headers.Urgency, 'high');
  const gone = await sendPush(sub, { title: 't' }, { vapid, subject: 'mailto:a@b.c', fetchImpl: async () => ({ status: 410 }) });
  assert.equal(gone.gone, true);
});
