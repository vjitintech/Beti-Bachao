// Firebase Cloud Messaging (HTTP v1) — native push to the Android and iPhone apps.
// Configure with FCM_SERVICE_ACCOUNT (the Firebase service-account JSON, raw or base64).
// OAuth2 service-account JWT is signed with Node crypto; no Google SDK needed.
import crypto from 'node:crypto';

const b64u = (x) => Buffer.from(typeof x === 'string' ? x : JSON.stringify(x)).toString('base64url');

export function parseServiceAccount(raw) {
  if (!raw) return null;
  const txt = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(txt);
  if (!sa.client_email || !sa.private_key || !sa.project_id) throw new Error('FCM service account JSON is missing fields');
  return sa;
}

export class Fcm {
  constructor(serviceAccount, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.sa = serviceAccount;
    this.fetch = fetchImpl;
    this.now = now;
    this.cached = null;
  }

  assertion() {
    const iat = Math.floor(this.now() / 1000);
    const head = b64u({ alg: 'RS256', typ: 'JWT' });
    const body = b64u({ iss: this.sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: this.sa.token_uri || 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 });
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${body}`), this.sa.private_key).toString('base64url');
    return `${head}.${body}.${sig}`;
  }

  async accessToken() {
    if (this.cached && this.cached.exp > this.now() + 60000) return this.cached.token;
    const res = await this.fetch(this.sa.token_uri || 'https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: this.assertion() }).toString(),
    });
    const j = await res.json();
    if (!j.access_token) throw new Error('FCM auth failed: ' + (j.error_description || j.error || res.status));
    this.cached = { token: j.access_token, exp: this.now() + (j.expires_in || 3600) * 1000 };
    return j.access_token;
  }

  // Android gets a data-only high-priority message so the app itself raises the
  // alarm notification (loud channel, lock-screen, full-screen when allowed).
  // iOS gets a visible alert (time-sensitive for urgent alerts).
  message(device, p) {
    const data = Object.fromEntries(Object.entries({ kind: p.kind, title: p.title, body: p.body, url: p.url, tag: p.tag, urgent: p.urgent ? '1' : '0', incidentId: p.incidentId || '' }).map(([k, v]) => [k, String(v ?? '')]));
    if (device.platform === 'android') return { token: device.token, data, android: { priority: 'HIGH', ttl: p.urgent ? '120s' : '3600s' } };
    return { token: device.token, data, apns: { headers: { 'apns-priority': '10', 'apns-push-type': 'alert' }, payload: { aps: { alert: { title: p.title, body: p.body }, sound: 'default', 'interruption-level': p.urgent ? 'time-sensitive' : 'active', 'thread-id': p.tag || 'beti' } } } };
  }

  async send(device, payload) {
    try {
      const token = await this.accessToken();
      const res = await this.fetch(`https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: this.message(device, payload) }),
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
      const j = await res.json().catch(() => ({}));
      const code = j.error?.details?.find?.((d) => d.errorCode)?.errorCode || j.error?.status;
      return { ok: false, status: res.status, gone: res.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT', error: code };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }
}
