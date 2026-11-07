// Apple Push Notification service (token-based, HTTP/2) — alerts to the iPhone/iPad app.
// Configure with APNS_KEY (the .p8 key text or base64), APNS_KEY_ID, APNS_TEAM_ID,
// APNS_BUNDLE_ID (default app.betibachao.safety) and APNS_SANDBOX=1 for development builds.
// The provider JWT is signed with Node crypto (ES256); no Apple SDK needed.
import crypto from 'node:crypto';
import http2 from 'node:http2';

const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

export function createApns(env, { connect = http2.connect, now = () => Date.now() } = {}) {
  if (!env.APNS_KEY || !env.APNS_KEY_ID || !env.APNS_TEAM_ID) return null;
  const pem = env.APNS_KEY.includes('BEGIN') ? env.APNS_KEY.replace(/\\n/g, '\n') : Buffer.from(env.APNS_KEY, 'base64').toString('utf8');
  const key = crypto.createPrivateKey(pem);
  const topic = env.APNS_BUNDLE_ID || 'app.betibachao.safety';
  const origin = env.APNS_SANDBOX === '1' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
  let jwt = null;
  let session = null;

  function token() {
    if (jwt && jwt.at > now() - 40 * 60e3) return jwt.value; // Apple: refresh every 20–60 min
    const head = b64u({ alg: 'ES256', kid: env.APNS_KEY_ID });
    const body = b64u({ iss: env.APNS_TEAM_ID, iat: Math.floor(now() / 1000) });
    const sig = crypto.sign('SHA256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    jwt = { at: now(), value: `${head}.${body}.${sig}` };
    return jwt.value;
  }

  function client() {
    if (session && !session.closed && !session.destroyed) return session;
    session = connect(origin);
    session.on('error', () => { session = null; });
    session.on('goaway', () => { session = null; });
    session.unref?.();
    return session;
  }

  function payload(p) {
    return {
      aps: { alert: { title: p.title, body: p.body }, sound: p.urgent ? 'default' : 'default', 'interruption-level': p.urgent ? 'time-sensitive' : 'active', 'thread-id': p.tag || 'beti' },
      kind: p.kind, url: p.url, incidentId: p.incidentId || '',
    };
  }

  function send(device, p) {
    return new Promise((resolve) => {
      let req;
      try {
        req = client().request({
          ':method': 'POST', ':path': `/3/device/${device.token}`,
          authorization: `bearer ${token()}`, 'apns-topic': topic, 'apns-push-type': 'alert',
          'apns-priority': '10', 'apns-expiration': String(Math.floor(now() / 1000) + (p.urgent ? 120 : 3600)),
          ...(p.tag ? { 'apns-collapse-id': String(p.tag).slice(0, 64) } : {}),
          'content-type': 'application/json',
        });
      } catch (e) { resolve({ ok: false, status: 0, error: e.message }); return; }
      let status = 0; let data = '';
      req.setTimeout(10000, () => { req.close(); resolve({ ok: false, status: 0, error: 'timeout' }); });
      req.on('response', (h) => { status = h[':status']; });
      req.on('data', (c) => { data += c; });
      req.on('error', (e) => resolve({ ok: false, status: 0, error: e.message }));
      req.on('end', () => {
        if (status === 200) return resolve({ ok: true, status });
        let reason = '';
        try { reason = JSON.parse(data).reason || ''; } catch {}
        resolve({ ok: false, status, error: reason, gone: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' });
      });
      req.end(JSON.stringify(payload(p)));
    });
  }

  return { send, payload, token, topic, origin };
}
