// Beti Bachao API + PWA server. Zero runtime dependencies (Node ≥ 20).
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node server/server.js
// The first admin is created from those variables on first start and sets up
// two-step login (authenticator app) at first sign-in. See docs/DEPLOY.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Engine, EngineError, SIMULATED_LABEL } from '../public/core/engine.js';
import { COUNTRIES } from '../public/core/config.js';
import { generateVapidKeys, sendPush, isValidSubscription } from './webpush.js';
import { JsonStore } from './store.js';
import { Fcm, parseServiceAccount } from './fcm.js';
import { createApns } from './apns.js';
import { openPostgres, attachPostgres } from './pgstore.js';
import { createSms } from './sms.js';
import { createRouting } from './routing.js';
import { createAi } from './ai.js';
import { createBackups } from './backup.js';
import { uuid, sha256, hashPassword, verifyPassword, hashSecret, newTotpSecret, verifyTotp, totp, RateLimiter, securityHeaders } from './security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

export function createServer(opts = {}) {
  const env = { ...process.env, ...opts.env };
  const MFA_REQUIRED = env.MFA_REQUIRED ? env.MFA_REQUIRED === 'true' : true;
  const SECURE = env.COOKIE_SECURE === 'true';
  const SESSION_TTL_MS = 12 * 3600 * 1000;
  const RATE_MULT = Math.max(1, Number(env.RATE_LIMIT_MULTIPLIER) || 1); // tests only
  const store = new JsonStore(env.DATA_FILE || path.join(ROOT, 'data', 'db.json'));
  if (opts.pg) attachPostgres(store, opts.pg, { url: opts.pgUrl || null });
  const limiter = new RateLimiter();
  const deps = { uuid, hash: sha256, hashSecret, now: () => Date.now(), notify: (n) => { queuePush(n); return { ok: true }; } };
  let engine = new Engine(store.db, deps);
  const fetchImpl = opts.fetchImpl || fetch;
  // Optional integrations — each is off until its environment variables are set.
  const fcm = (() => { try { const sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT); return sa ? new Fcm(sa, { fetchImpl }) : null; } catch (e) { console.error('[fcm]', e.message); return null; } })();
  const apns = (() => { try { return createApns(env, opts.apnsConnect ? { connect: opts.apnsConnect } : {}); } catch (e) { console.error('[apns]', e.message); return null; } })();
  const sms = (() => { try { return createSms(env, { fetchImpl }); } catch (e) { console.error('[sms]', e.message); return null; } })();
  const routing = createRouting(env, { fetchImpl });
  const ai = createAi(env, { fetchImpl });
  const backups = env.BACKUP_DIR === 'off' ? null : createBackups({ dir: env.BACKUP_DIR || path.join(path.dirname(store.file), 'backups'), keep: Number(env.BACKUP_KEEP) || 14, keyHex: env.BACKUP_KEY || null });
  store.db.devices ||= [];
  store.db.otps ||= [];

  // ---------- first admin ----------
  function bootstrapAdmin() {
    if (store.db.users.some((u) => u.role === 'admin' && u.status === 'ACTIVE')) return;
    if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
      // First-time setup in the browser, protected by a one-time code shown only in the server log.
      store.db.setupToken ||= crypto.randomBytes(9).toString('base64url');
      store.save();
      const host = env.CODESPACE_NAME && env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN ? `https://${env.CODESPACE_NAME}-${env.PORT || 8080}.${env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}` : `http://localhost:${env.PORT || 8080}`;
      console.log(`\n[setup] No admin yet. Open ${host}/#/setup?code=${store.db.setupToken}\n[setup] One-time setup code: ${store.db.setupToken}\n`);
      return;
    }
    if (String(env.ADMIN_PASSWORD).length < 12) { console.warn('[bootstrap] ADMIN_PASSWORD must be at least 12 characters.'); return; }
    const u = engine.createUser({ displayName: env.ADMIN_NAME || 'Administrator', email: env.ADMIN_EMAIL, role: 'admin', passwordHash: hashPassword(env.ADMIN_PASSWORD) });
    if (env.ADMIN_MFA_SECRET) { u.mfaSecret = env.ADMIN_MFA_SECRET; u.mfaEnrolled = true; } else u.mfaEnrolled = false;
    console.log(`[bootstrap] Admin ${u.email} created. Sign in to set up two-step login.`);
    store.save();
  }
  bootstrapAdmin();

  // ---------- web push ----------
  store.db.pushSubs ||= [];
  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) store.db.vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  if (!store.db.vapid) { store.db.vapid = generateVapidKeys(); store.save(); }
  const VAPID_SUBJECT = env.VAPID_SUBJECT || `mailto:${env.ADMIN_EMAIL || 'admin@localhost'}`;
  const PUSH_TEXT = {
    ALERT: (n) => ({ title: '🚨 SOS nearby — help needed', body: `A woman needs help about ${n.meta?.distanceKm ?? '?'} km from you. Tap to respond.`, url: '#/volunteer', tag: 'sos-' + n.incidentId, urgent: true }),
    RESPONDER_ACCEPTED: () => ({ title: '✅ A verified volunteer is coming', body: 'Open Beti Bachao to see their distance and ETA.', url: '#/home', tag: 'status' }),
    RESPONDER_ARRIVED: () => ({ title: '📍 Your volunteer has arrived', body: 'Confirm in the app when you are safe.', url: '#/home', tag: 'status' }),
    RESPONDER_LOST: () => ({ title: '⚠️ A volunteer dropped out', body: 'We are finding another responder. Call 112 if you are in danger.', url: '#/home', tag: 'status' }),
    INCIDENT_CANCELLED: () => ({ title: 'SOS cancelled', body: 'You can stand down. Thank you.', url: '#/volunteer', tag: 'stand-down' }),
    INCIDENT_CLOSED: () => ({ title: '💚 She confirmed she is safe', body: 'You can stand down. Thank you for responding.', url: '#/volunteer', tag: 'stand-down' }),
    UNASSIGNED_BY_OPERATOR: () => ({ title: 'You were stood down by an operator', body: 'Another responder has been assigned.', url: '#/volunteer', tag: 'stand-down' }),
    VERIFICATION_CALL: (n) => ({ title: '📹 Verification video call booked', body: `Join from the app at ${new Date(n.meta?.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. Keep your Aadhaar card ready.`, url: '#/volunteer', tag: 'verify' }),
    VERIFICATION_RESULT: (n) => ({ title: n.meta?.decision === 'APPROVE' ? '✅ You are an approved Beti Bachao volunteer' : 'Volunteer verification update', body: n.meta?.decision === 'APPROVE' ? 'Go on duty in the app to start receiving SOS alerts nearby.' : 'Open the app for details.', url: '#/volunteer', tag: 'verify' }),
    ESCALATION: (n) => ({ title: '🚩 SOS needs an operator', body: `Escalation: ${String(n.meta?.type || '').replace(/_/g, ' ').toLowerCase()}. Open the operations console.`, url: '#/ops', tag: 'ops-' + n.incidentId, urgent: true }),
  };
  function queuePush(n) {
    const make = PUSH_TEXT[n.kind];
    if (!make) return;
    const payload = { ...make(n), kind: n.kind, incidentId: n.incidentId };
    for (const d of store.db.devices.filter((x) => x.userId === n.recipientId)) {
      const sender = d.platform === 'ios' && apns ? apns : fcm;
      if (!sender) continue;
      sender.send(d, payload).then((r) => {
        if (r.gone) { store.db.devices = store.db.devices.filter((x) => x.token !== d.token); store.markDirty(); }
        else if (!r.ok) engine.audit('system', 'FCM_FAILED', 'notification', n.id, `status ${r.status} ${r.error || ''}`);
      }).catch((e) => console.error('[fcm]', e.message));
    }
    const subs = store.db.pushSubs.filter((x) => x.userId === n.recipientId);
    if (!subs.length) return;
    for (const sub of subs) {
      sendPush(sub, payload, { vapid: store.db.vapid, subject: VAPID_SUBJECT, urgency: payload.urgent ? 'high' : 'normal' }).then((r) => {
        if (r.gone) { store.db.pushSubs = store.db.pushSubs.filter((x) => x.endpoint !== sub.endpoint); store.markDirty(); }
        else if (!r.ok) engine.audit('system', 'PUSH_FAILED', 'notification', n.id, `status ${r.status}`);
      }).catch((e) => console.error('[push]', e.message));
    }
  }

  // ---------- realtime (SSE) ----------
  const clients = new Set();
  let lastBroadcastSeq = store.db.eventSeq;
  function canSee(user, incidentId) {
    const inc = store.db.incidents.find((i) => i.id === incidentId);
    if (!inc || !user) return false;
    if (['operator', 'admin'].includes(user.role)) return true;
    if (user.role === 'user') return inc.requesterId === user.id;
    if (user.role === 'volunteer') return store.db.notifications.some((n) => n.incidentId === incidentId && n.recipientId === user.id) || store.db.assignments.some((a) => a.incidentId === incidentId && a.volunteerId === user.id);
    return false;
  }
  function broadcast() {
    const evs = store.db.events.filter((e) => e.seq > lastBroadcastSeq);
    if (!evs.length) return;
    lastBroadcastSeq = evs[evs.length - 1].seq;
    for (const c of clients) {
      const user = engine.user(c.userId);
      for (const ev of evs) {
        if (!canSee(user, ev.incident_id)) continue;
        // Payload is deliberately minimal; clients refetch an authorised snapshot.
        c.res.write(`id: ${ev.seq}\nevent: incident\ndata: ${JSON.stringify({ seq: ev.seq, event_id: ev.event_id, schema_version: 1, type: ev.type, incident_id: ev.incident_id, timestamp: ev.timestamp })}\n\n`);
      }
    }
  }

  // ---------- durable scheduler ----------
  const timer = setInterval(() => {
    try {
      const changed = engine.tick();
      if (changed.length) store.markDirty();
      sideJobs();
      store.flush();
      broadcast();
    } catch (err) { console.error('[scheduler]', err); }
  }, opts.tickMs || 1000);
  const heartbeat = setInterval(() => { for (const c of clients) c.res.write(': hb\n\n'); }, 20000);

  // ---------- side jobs (SMS, routing, backups) ----------
  const mapsLink = (l) => `https://maps.google.com/?q=${l.lat.toFixed(5)},${l.lng.toFixed(5)}`;
  let lastRouting = 0, routingBusy = false;
  function sideJobs() {
    const now = Date.now();
    // 1) Server-side SMS to trusted contacts when her phone could not send it (iPhone, no SIM permission).
    if (sms) for (const inc of store.db.incidents) {
      if (inc.contactsSmsAt || inc.deviceSmsSent || inc.duress || !engine.isOpen(inc)) continue;
      const u = engine.user(inc.requesterId);
      const loc = engine.latestLocation(inc.id);
      if (!u?.contacts?.length || u.prefs?.serverSms === false) { inc.contactsSmsAt = 'skipped'; continue; }
      if (!loc && now - Date.parse(inc.createdAt) < 20000) continue; // wait briefly for a GPS fix
      inc.contactsSmsAt = new Date().toISOString();
      store.markDirty();
      for (const c of u.contacts) sms.send(c.phone, 'SOS', { name: u.displayName, link: loc ? mapsLink(loc) : '(location pending — call her)' })
        .then((r) => engine.audit('system', r.ok ? 'CONTACT_SMS_SENT' : 'CONTACT_SMS_FAILED', 'incident', inc.id, r.ok ? null : String(r.error || r.status)));
    }
    // 2) SMS fallback to alerted volunteers who have not responded within 30 s.
    if (sms) for (const n of store.db.notifications) {
      if (n.kind !== 'ALERT' || n.response || n.smsAt || now - Date.parse(n.createdAt) < 30000) continue;
      const inc = store.db.incidents.find((i) => i.id === n.incidentId);
      n.smsAt = new Date().toISOString(); store.markDirty();
      if (!inc || !engine.isOpen(inc)) continue;
      const vu = engine.user(n.recipientId);
      if (vu?.phone) sms.send(vu.phone, 'ALERT', { distance: n.meta?.distanceKm ?? '?' }).then((r) => { if (!r.ok) engine.audit('system', 'ALERT_SMS_FAILED', 'notification', n.id); });
    }
    // 3) Road-route ETA for active responders (every 30 s).
    if (routing && !routingBusy && now - lastRouting > 30000) {
      lastRouting = now; routingBusy = true;
      const jobs = store.db.assignments.filter((a) => ['ACCEPTED', 'EN_ROUTE'].includes(a.status)).map(async (a) => {
        const v = engine.vol(a.volunteerId); const her = engine.latestLocation(a.incidentId);
        if (!v?.lastLocation || !her) return;
        const r = await routing.eta(v.lastLocation, her);
        if (r) { engine.setRouteEta(a.id, r); store.markDirty(); }
      });
      Promise.allSettled(jobs).finally(() => { routingBusy = false; });
    }
    // 4) Daily automatic backup.
    if (backups && backups.due()) { try { const f = backups.run(store.db); engine.audit('system', 'BACKUP_CREATED', 'system', f); } catch (e) { console.error('[backup]', e.message); } }
  }

  // ---------- helpers ----------
  const json = (res, status, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(SECURE), ...extra });
    res.end(JSON.stringify(body));
  };
  const err = (res, status, code, message) => json(res, status, { error: { code, message: message || code } });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > 32 * 1024) { reject(new EngineError(413, 'PAYLOAD_TOO_LARGE')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(new EngineError(400, 'INVALID_JSON')); }
      });
      req.on('error', reject);
    });
  }
  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    return out;
  }
  const bearer = (req, url) => {
    const h = String(req.headers.authorization || '');
    if (h.startsWith('Bearer ')) return h.slice(7).trim();
    if (url && url.pathname === '/api/v1/events') return url.searchParams.get('access_token');
    return null;
  };
  function sessionUser(req, url = null) {
    const tok = bearer(req, url) || parseCookies(req).bb_session;
    if (!tok) return null;
    const h = sha256(tok);
    const s = store.db.sessions.find((x) => x.tokenHash === h);
    if (!s || Date.now() > s.expiresAt) return null;
    const u = engine.user(s.userId);
    return u && u.status === 'ACTIVE' ? { id: u.id, role: u.role, session: s, mustChangePassword: !!u.mustChangePassword } : null;
  }
  // Phone apps get a long-lived bearer token (30 days, renewed on use) stored in the
  // device keystore; browsers get an HttpOnly cookie (12 h).
  const MOBILE_TTL_MS = 30 * 24 * 3600 * 1000;
  function issueToken(user, mobile) {
    const tok = crypto.randomBytes(32).toString('base64url');
    store.db.sessions = store.db.sessions.filter((s) => Date.now() < s.expiresAt);
    store.db.sessions.push({ tokenHash: sha256(tok), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + (mobile ? MOBILE_TTL_MS : SESSION_TTL_MS), mobile: !!mobile });
    return tok;
  }
  function startSession(res, user, body = {}) {
    if (body.client === 'mobile') { res.bbToken = issueToken(user, true); return `bb_session=; Path=/; Max-Age=0`; }
    const tok = crypto.randomBytes(32).toString('base64url');
    store.db.sessions = store.db.sessions.filter((s) => Date.now() < s.expiresAt);
    store.db.sessions.push({ tokenHash: sha256(tok), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    return `bb_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${SECURE ? '; Secure' : ''}`;
  }
  const ip = (req) => (env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
  const meView = (u) => ({ id: u.id, displayName: u.displayName, email: u.email, phone: u.phone || null, role: u.role, countryCode: u.countryCode, hasPins: !!u.pins, hasDuressPin: !!u.pins?.duress, mustChangePassword: !!u.mustChangePassword });

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, { auth = true, limit = null } = {}) => {
    const keys = [];
    const re = new RegExp('^/api/v1' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9-]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth, limit });
  };

  route('GET', '/health', () => ({ ok: true, time: new Date(deps.now()).toISOString(), auditChain: engine.verifyAuditChain().ok }), { auth: false });
  route('POST', '/setup', ({ body }) => {
    if (store.db.users.some((u) => u.role === 'admin')) throw new EngineError(409, 'ALREADY_SET_UP', 'Setup is already complete. Please log in.');
    const tok = String(body.code || '');
    const want = String(store.db.setupToken || '');
    if (!want || tok.length !== want.length || !crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(want))) throw new EngineError(403, 'BAD_SETUP_CODE', 'Setup code is incorrect');
    if (typeof body.password !== 'string' || body.password.length < 12) throw new EngineError(400, 'WEAK_PASSWORD', 'Password must be at least 12 characters');
    const u = engine.createUser({ displayName: body.displayName || 'Administrator', email: body.email, role: 'admin', passwordHash: hashPassword(body.password) });
    u.mfaEnrolled = false;
    delete store.db.setupToken;
    engine.audit(u.id, 'ADMIN_SETUP', 'user', u.id);
    return { ok: true };
  }, { auth: false, limit: [10, 3600e3] });
  route('GET', '/public-config', () => ({ setupNeeded: !store.db.users.some((u) => u.role === 'admin'), demo: false, mfaRequired: MFA_REQUIRED, countries: COUNTRIES, defaultCountry: engine.cfg.countryCode, simulatedLabel: SIMULATED_LABEL, radiusStagesKm: engine.cfg.radiusStagesKm, vapidPublicKey: store.db.vapid.publicKey, features: { appPush: !!(fcm || apns), iosPush: !!(apns || fcm), sms: !!sms, smsReset: !!sms, roadEta: !!routing, ai: !!ai } }), { auth: false });

  route('POST', '/auth/register', async ({ body, res }) => {
    if (!['user', 'volunteer'].includes(body.role)) throw new EngineError(400, 'INVALID_ROLE', 'Only user or volunteer accounts can self-register');
    if (typeof body.password !== 'string' || body.password.length < 10) throw new EngineError(400, 'WEAK_PASSWORD', 'Password must be at least 10 characters');
    if (body.consent !== true) throw new EngineError(400, 'CONSENT_REQUIRED', 'Please accept the location-sharing notice');
    if (!body.phone) throw new EngineError(400, 'PHONE_REQUIRED', 'Mobile number is required (for SOS SMS and password reset)');
    const u = engine.createUser({ phone: body.phone, displayName: body.displayName, email: body.email, role: body.role, passwordHash: hashPassword(body.password), countryCode: COUNTRIES[body.countryCode] ? body.countryCode : null });
    u.consentAt = new Date().toISOString();
    engine.audit(u.id, 'CONSENT_RECORDED', 'user', u.id, 'location sharing during SOS');
    res.setHeader('Set-Cookie', startSession(res, u, body));
    return { user: meView(u), ...(res.bbToken ? { token: res.bbToken } : {}) };
  }, { auth: false, limit: [20, 3600e3] });

  route('POST', '/auth/login', async ({ body, res }) => {
    const u = store.db.users.find((x) => x.email === String(body.email || '').trim().toLowerCase());
    const okPw = u && u.status === 'ACTIVE' && verifyPassword(body.password || '', u.passwordHash);
    if (!okPw) { engine.audit(u?.id || 'anonymous', 'LOGIN_FAILED', 'user', u?.id || 'unknown'); throw new EngineError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect'); }
    if (['operator', 'admin'].includes(u.role) && MFA_REQUIRED) {
      if (!u.mfaEnrolled) {
        // First staff sign-in: enrol an authenticator app before any access.
        if (!u.pendingMfaSecret || !body.mfaCode) {
          u.pendingMfaSecret ||= newTotpSecret();
          store.markDirty();
          const label = encodeURIComponent(`Beti Bachao:${u.email}`);
          return { mfaEnroll: { secret: u.pendingMfaSecret, otpauthUri: `otpauth://totp/${label}?secret=${u.pendingMfaSecret}&issuer=Beti%20Bachao&algorithm=SHA1&digits=6&period=30` } };
        }
        if (!verifyTotp(u.pendingMfaSecret, body.mfaCode)) { engine.audit(u.id, 'MFA_ENROLL_FAILED', 'user', u.id); throw new EngineError(401, 'INVALID_MFA', 'Code does not match. Check the key and your phone clock.'); }
        u.mfaSecret = u.pendingMfaSecret; u.pendingMfaSecret = null; u.mfaEnrolled = true;
        engine.audit(u.id, 'MFA_ENROLLED', 'user', u.id);
      } else {
        if (!body.mfaCode) return { mfaRequired: true };
        if (!verifyTotp(u.mfaSecret, body.mfaCode)) { engine.audit(u.id, 'MFA_FAILED', 'user', u.id); throw new EngineError(401, 'INVALID_MFA', 'Authenticator code is incorrect'); }
      }
    }
    res.setHeader('Set-Cookie', startSession(res, u, body));
    engine.audit(u.id, 'LOGIN', 'user', u.id, body.client === 'mobile' ? 'mobile app' : 'web');
    return { user: meView(u), ...(res.bbToken ? { token: res.bbToken } : {}) };
  }, { auth: false, limit: [10, 600e3] });

  route('POST', '/auth/logout', ({ actor, res }) => {
    store.db.sessions = store.db.sessions.filter((s) => s !== actor.session);
    res.setHeader('Set-Cookie', `bb_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${SECURE ? '; Secure' : ''}`);
    return { ok: true };
  });
  route('GET', '/me', ({ actor }) => ({ user: meView(engine.user(actor.id)) }));
  route('PATCH', '/me/pins', ({ actor, body }) => engine.setPins(actor, body), { limit: [10, 3600e3] });
  route('GET', '/me/incidents', ({ actor }) => ({ items: engine.myIncidents(actor) }));
  route('GET', '/me/export', ({ actor }) => engine.exportMyData(actor));
  route('DELETE', '/me', ({ actor }) => { const r = engine.deleteMyAccount(actor); store.db.sessions = store.db.sessions.filter((s) => s.userId !== actor.id); return r; });

  route('POST', '/me/push-subscriptions', ({ actor, body }) => {
    const endpoint = String(body.endpoint || '');
    if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !body.keys?.p256dh || !body.keys?.auth || !isValidSubscription({ keys: body.keys })) throw new EngineError(400, 'INVALID_SUBSCRIPTION');
    store.db.pushSubs = store.db.pushSubs.filter((x) => x.endpoint !== endpoint);
    const mine = store.db.pushSubs.filter((x) => x.userId === actor.id);
    if (mine.length >= 5) store.db.pushSubs = store.db.pushSubs.filter((x) => x !== mine[0]);
    store.db.pushSubs.push({ userId: actor.id, endpoint, keys: { p256dh: String(body.keys.p256dh).slice(0, 200), auth: String(body.keys.auth).slice(0, 100) }, createdAt: new Date().toISOString() });
    engine.audit(actor.id, 'PUSH_SUBSCRIBED', 'user', actor.id);
    return { ok: true };
  }, { limit: [20, 3600e3] });
  // --- mobile apps & safety integrations ---
  route('POST', '/me/devices', ({ actor, body }) => {
    const token = String(body.token || '');
    if (!['android', 'ios'].includes(body.platform) || token.length < 20 || token.length > 4096) throw new EngineError(400, 'INVALID_DEVICE');
    store.db.devices = store.db.devices.filter((d) => d.token !== token);
    const mine = store.db.devices.filter((d) => d.userId === actor.id);
    if (mine.length >= 5) store.db.devices = store.db.devices.filter((d) => d !== mine[0]);
    store.db.devices.push({ userId: actor.id, platform: body.platform, token, appVersion: String(body.appVersion || '').slice(0, 20), createdAt: new Date().toISOString() });
    engine.audit(actor.id, 'DEVICE_REGISTERED', 'user', actor.id, body.platform);
    return { ok: true, push: body.platform === 'ios' ? !!(apns || fcm) : !!fcm };
  }, { limit: [30, 3600e3] });
  route('POST', '/me/location', ({ actor, body }) => engine.ingestDeviceLocation(actor, body), { limit: [600, 3600e3] });
  route('GET', '/me/contacts', ({ actor }) => engine.getContacts(actor));
  route('PUT', '/me/contacts', ({ actor, body }) => engine.setContacts(actor, body), { limit: [30, 3600e3] });
  route('POST', '/incidents/:id/rate', ({ actor, p, body }) => engine.rateResponder(actor, p.id, body), { limit: [20, 3600e3] });
  route('POST', '/admin/volunteers/:id/schedule-call', ({ actor, p, body }) => {
    const call = engine.scheduleVerificationCall(actor, p.id, body);
    const vu = engine.user(p.id);
    if (sms && vu?.phone) sms.send(vu.phone, 'VERIFY', { time: new Date(call.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) });
    return call;
  });
  route('GET', '/admin/users', ({ actor, q }) => ({ items: engine.findUsers(actor, q.get('q')) }));
  route('POST', '/admin/users/:id/reset-password', ({ actor, p }) => {
    const temp = crypto.randomBytes(6).toString('base64url') + '-' + crypto.randomInt(100, 999);
    engine.adminResetPassword(actor, p.id, hashPassword(temp));
    store.db.sessions = store.db.sessions.filter((x) => x.userId !== p.id);
    return { temporaryPassword: temp, note: 'Share privately. They must choose a new password at next login.' };
  }, { limit: [30, 3600e3] });
  route('POST', '/auth/change-password', ({ actor, body }) => {
    const u = engine.user(actor.id);
    if (!verifyPassword(body.currentPassword || '', u.passwordHash)) throw new EngineError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
    const min = ['operator', 'admin'].includes(u.role) ? 12 : 10;
    if (typeof body.newPassword !== 'string' || body.newPassword.length < min) throw new EngineError(400, 'WEAK_PASSWORD', `New password must be at least ${min} characters`);
    u.passwordHash = hashPassword(body.newPassword); u.mustChangePassword = false;
    store.db.sessions = store.db.sessions.filter((x) => x.userId !== u.id || x === actor.session);
    engine.audit(u.id, 'PASSWORD_CHANGED', 'user', u.id);
    return { ok: true };
  }, { limit: [10, 3600e3] });
  // Self-service reset with a 6-digit code by SMS (needs an SMS gateway).
  route('POST', '/auth/reset/request', ({ body }) => {
    const u = store.db.users.find((x) => x.email === String(body.email || '').trim().toLowerCase() && x.status === 'ACTIVE');
    if (!sms) throw new EngineError(503, 'NO_SMS', 'Password reset by SMS is not set up. Ask the Beti Bachao admin to reset your password.');
    if (u?.phone) {
      const code = String(crypto.randomInt(100000, 999999));
      store.db.otps = store.db.otps.filter((o) => o.userId !== u.id && Date.now() < o.exp);
      store.db.otps.push({ userId: u.id, hash: sha256(u.id + code), exp: Date.now() + 600000, tries: 0 });
      sms.send(u.phone, 'OTP', { otp: code });
      engine.audit(u.id, 'RESET_CODE_SENT', 'user', u.id);
    }
    return { ok: true, note: 'If the account exists, a code was sent to its mobile number.' };
  }, { auth: false, limit: [5, 3600e3] });
  route('POST', '/auth/reset/confirm', ({ body }) => {
    const u = store.db.users.find((x) => x.email === String(body.email || '').trim().toLowerCase() && x.status === 'ACTIVE');
    const o = u && store.db.otps.find((x) => x.userId === u.id && Date.now() < x.exp);
    if (!o) throw new EngineError(400, 'INVALID_CODE', 'Code is wrong or expired');
    o.tries += 1;
    if (o.tries > 5 || o.hash !== sha256(u.id + String(body.code || ''))) { if (o.tries > 5) store.db.otps = store.db.otps.filter((x) => x !== o); throw new EngineError(400, 'INVALID_CODE', 'Code is wrong or expired'); }
    const min = ['operator', 'admin'].includes(u.role) ? 12 : 10;
    if (typeof body.newPassword !== 'string' || body.newPassword.length < min) throw new EngineError(400, 'WEAK_PASSWORD', `New password must be at least ${min} characters`);
    u.passwordHash = hashPassword(body.newPassword); u.mustChangePassword = false;
    store.db.otps = store.db.otps.filter((x) => x !== o);
    store.db.sessions = store.db.sessions.filter((x) => x.userId !== u.id);
    engine.audit(u.id, 'PASSWORD_RESET_BY_SMS', 'user', u.id);
    return { ok: true };
  }, { auth: false, limit: [10, 3600e3] });
  // --- optional local AI (Colibri) ---
  route('POST', '/operator/incidents/:id/ai-summary', async ({ actor, p }) => {
    engine.requireRole(actor, 'operator', 'admin');
    if (!ai) throw new EngineError(503, 'AI_OFF', 'AI assistant is not configured (set AI_BASE_URL to a Colibri server)');
    const v = engine.viewIncident(actor, p.id);
    const facts = { status: v.status, severity: v.severity, duress: v.duress, minutesOpen: Math.round((Date.now() - Date.parse(v.createdAt)) / 60000), escalationStatus: v.escalationStatus, search: v.search, alerted: v.alertedCount, battery: v.battery,
      location: v.location ? { accuracyM: v.location.accuracyM, ageSec: v.location.ageSec, stale: v.location.stale } : null,
      responders: v.assignments.map((a) => ({ status: a.status, distanceKm: a.distanceKm, etaMin: a.approxEtaMin, stalled: a.stallFlagged, closing: a.closing })),
      escalations: v.escalations.map((e) => ({ type: e.type, status: e.status })), prankRisk: v.prankRisk.level };
    const out = await ai.incidentSummary(facts);
    if (!out) throw new EngineError(502, 'AI_UNAVAILABLE', 'The AI server did not answer. Continue with the standard procedure.');
    const inc = engine.incident(p.id); inc.ai = { ...(inc.ai || {}), summary: out };
    engine.audit(actor.id, 'AI_SUMMARY', 'incident', p.id);
    return out;
  }, { limit: [60, 3600e3] });
  route('POST', '/ai/translate', async ({ actor, body }) => {
    engine.requireRole(actor, 'operator', 'admin');
    if (!ai) throw new EngineError(503, 'AI_OFF', 'Translation is not configured (set AI_BASE_URL)');
    const target = String(body.target || 'English').slice(0, 30);
    const out = await ai.translate(String(body.text || '').slice(0, 2000), target);
    if (!out) throw new EngineError(502, 'AI_UNAVAILABLE', 'The AI server did not answer');
    return { text: out, target, machineTranslated: true };
  }, { limit: [120, 3600e3] });
  route('GET', '/admin/integrations/status', ({ actor }) => { engine.requireRole(actor, 'admin'); return { database: store.pg ? { kind: 'postgresql', ...store.pg.status } : { kind: 'file' }, fcm: !!fcm, apns: apns ? apns.origin : null, sms: sms?.name || null, routing: !!routing, ai: ai ? ai.model : null, backups: backups ? backups.dir : null }; });

  route('GET', '/admin/staff', ({ actor }) => ({ items: engine.listStaff(actor) }));
  route('GET', '/admin/backup', ({ actor, res }) => {
    engine.requireRole(actor, 'admin');
    engine.audit(actor.id, 'BACKUP_DOWNLOADED', 'system', 'db');
    res.setHeader('Content-Disposition', `attachment; filename="beti-bachao-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    const { sessions, ...rest } = store.db; // never export live session tokens
    return rest;
  }, { limit: [10, 3600e3] });
  route('POST', '/admin/staff', ({ actor, body }) => {
    if (typeof body.password !== 'string' || body.password.length < 12) throw new EngineError(400, 'WEAK_PASSWORD', 'Temporary password must be at least 12 characters');
    return engine.createStaff(actor, { displayName: body.displayName, email: body.email, role: body.role, passwordHash: hashPassword(body.password) });
  }, { limit: [30, 3600e3] });
  route('POST', '/admin/staff/:id/status', ({ actor, p, body }) => { const r = engine.setStaffStatus(actor, p.id, body.status); if (body.status !== 'ACTIVE') store.db.sessions = store.db.sessions.filter((x) => x.userId !== p.id); return r; });

  route('GET', '/volunteer/profile', ({ actor }) => engine.volunteerProfile(actor));
  route('PATCH', '/volunteer/availability', ({ actor, body }) => engine.setAvailability(actor, body), { limit: [120, 600e3] });
  route('POST', '/volunteer/training', ({ actor, body }) => engine.completeTraining(actor, body));
  route('POST', '/volunteer/verification', ({ actor, body }) => engine.submitVerification(actor, body), { limit: [5, 3600e3] });
  route('GET', '/volunteer/alerts', ({ actor }) => ({ items: engine.volunteerAlerts(actor) }));

  route('POST', '/incidents', ({ actor, body }) => {
    const r = engine.createIncident(actor, body);
    if (ai && !r.duplicate && body.note) ai.riskAssessment('sos_note', body.note, {}).then((risk) => { const inc = store.db.incidents.find((x) => x.id === r.incident.id); if (inc && risk) { inc.ai = { ...(inc.ai || {}), risk }; store.markDirty(); } });
    return r;
  }, { limit: [12, 3600e3] });
  route('GET', '/incidents/:id', ({ actor, p }) => engine.viewIncident(actor, p.id));
  route('POST', '/incidents/:id/locations', ({ actor, p, body }) => engine.addLocation(actor, p.id, body), { limit: [240, 600e3] });
  route('POST', '/incidents/:id/cancel', ({ actor, p, body }) => engine.cancelIncident(actor, p.id, body), { limit: [8, 600e3] });
  route('GET', '/incidents/:id/timeline', ({ actor, p }) => ({ items: engine.timeline(actor, p.id) }));
  route('POST', '/incidents/:id/accept', ({ actor, p }) => engine.acceptIncident(actor, p.id), { limit: [30, 600e3] });
  route('POST', '/incidents/:id/decline', ({ actor, p, body }) => engine.declineIncident(actor, p.id, body), { limit: [30, 600e3] });
  route('POST', '/incidents/:id/safety-confirmation', ({ actor, p, body }) => engine.safetyConfirmation(actor, p.id, body), { limit: [20, 600e3] });
  route('POST', '/incidents/:id/escalations', ({ actor, p, body }) => engine.requestEscalation(actor, p.id, body), { limit: [20, 600e3] });
  route('POST', '/assignments/:id/status', ({ actor, p, body }) => engine.updateAssignment(actor, p.id, body), { limit: [240, 600e3] });
  route('POST', '/abuse-reports', ({ actor, body }) => {
    const r = engine.reportAbuse(actor, body);
    if (ai) ai.riskAssessment('abuse_report', body.details, { category: body.category }).then((risk) => { const rec = store.db.abuseReports.find((x) => x.id === r.id); if (rec && risk) { rec.aiRisk = risk; store.markDirty(); } });
    return r;
  }, { limit: [10, 3600e3] });

  route('GET', '/operator/incidents', ({ actor, q }) => ({ items: engine.operatorIncidents(actor, { includeClosed: q.get('all') === '1' }) }));
  route('POST', '/operator/incidents/:id/reassign', ({ actor, p, body }) => engine.operatorReassign(actor, p.id, body));
  route('POST', '/operator/incidents/:id/handoff', ({ actor, p, body }) => engine.operatorHandoff(actor, p.id, body));
  route('POST', '/operator/incidents/:id/closure-exception', ({ actor, p, body }) => engine.operatorClosureException(actor, p.id, body));
  route('GET', '/admin/audit-events', ({ actor, q }) => engine.auditEvents(actor, { limit: Number(q.get('limit')) || 100, offset: Number(q.get('offset')) || 0 }));
  route('GET', '/admin/config', ({ actor }) => engine.getConfig(actor));
  route('PATCH', '/admin/config', ({ actor, body }) => engine.patchConfig(actor, body));
  route('GET', '/admin/volunteers', ({ actor }) => ({ items: engine.listVolunteers(actor) }));
  route('POST', '/admin/volunteers/:id/review', ({ actor, p, body }) => engine.reviewVolunteer(actor, p.id, body));
  route('GET', '/admin/abuse-reports', ({ actor }) => ({ items: engine.listAbuse(actor) }));
  route('POST', '/admin/abuse-reports/:id/resolve', ({ actor, p, body }) => engine.resolveAbuse(actor, p.id, body));
  route('GET', '/admin/integrations', ({ actor }) => { engine.requireRole(actor, 'admin', 'operator'); return { items: [
    { name: 'Database', status: store.pg ? (store.pg.status.ok ? 'POSTGRESQL' : 'POSTGRESQL ERROR') : 'LOCAL FILE', note: store.pg ? (store.pg.status.ok ? `Every change is saved to PostgreSQL${store.pg.status.lastWriteAt ? ` (last ${store.pg.status.lastWriteAt})` : ''}.` : `Last write failed: ${store.pg.status.lastError}. Data is kept locally and retried.`) : 'Set DATABASE_URL so data survives redeploys on hosts that wipe disks.' },
    { name: 'Police / ambulance (112)', status: 'MANUAL', note: 'Not contacted automatically. Operators phone 112 and record the handoff in the console.' },
    { name: 'App push (Firebase, Android + iPhone)', status: fcm ? 'ACTIVE' : 'NOT CONFIGURED', note: fcm ? `${store.db.devices.length} app device(s) registered.` : 'Set FCM_SERVICE_ACCOUNT to send alarm alerts to the phone apps.' },
    { name: 'iPhone push (Apple APNs)', status: apns ? 'ACTIVE' : 'NOT CONFIGURED', note: apns ? `${store.db.devices.filter((d) => d.platform === 'ios').length} iPhone/iPad device(s) registered.` : 'Set APNS_KEY, APNS_KEY_ID and APNS_TEAM_ID to send alerts to the iPhone app.' },
    { name: 'SMS gateway', status: sms ? sms.name.toUpperCase() : 'NOT CONFIGURED', note: sms ? 'Sends SOS SMS for iPhone users, alert fallback to volunteers, reset codes.' : 'Set SMS_PROVIDER (msg91/twilio). Android phones still send SOS SMS themselves.' },
    { name: 'Road-route ETA', status: routing ? 'ACTIVE' : 'ESTIMATE', note: routing ? 'OSRM routing.' : 'Set ROUTING_URL (OSRM). Until then straight-line estimate.' },
    { name: 'Local AI (Colibri)', status: ai ? 'ACTIVE' : 'OFF', note: ai ? `Model ${ai.model}. Advisory only.` : 'Set AI_BASE_URL to enable operator summaries, translation and risk flags.' },
    { name: 'Automatic backups', status: backups ? 'ACTIVE' : 'OFF', note: backups ? `Daily, kept ${Number(env.BACKUP_KEEP) || 14}${env.BACKUP_KEY ? ', encrypted' : ''}.` : 'Disabled.' },
    { name: 'Browser push notifications', status: 'ACTIVE', note: `${store.db.pushSubs.length} device(s) subscribed. Android Chrome; iPhone only when installed to Home Screen (iOS 16.4+).` },
    { name: 'SMS to trusted contacts', status: 'ON DEVICE', note: "Opens the user's own SMS app pre-filled; no SMS gateway." },
    { name: 'Volunteer identity verification', status: 'MANUAL', note: 'Trust team verifies ID by video call / in person; no ID documents stored.' },
    { name: 'Route ETA', status: 'ESTIMATE', note: 'Straight-line × road factor; always labelled approximate.' },
  ] }; });

  // ---------- static ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return err(res, 400, 'BAD_PATH');
    fs.stat(file, (e, st) => {
      if (e || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain', ...securityHeaders(SECURE) }); return res.end('Not found'); }
      const ext = path.extname(file);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : 'public, max-age=300', ...securityHeaders(SECURE) });
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);

    // CORS only for the native apps' WebView origins (bearer tokens, no cookies).
    const origin = req.headers.origin;
    const APP_ORIGINS = ['capacitor://localhost', 'https://localhost', 'http://localhost', 'ionic://localhost'];
    if (origin && APP_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-BB-CSRF');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }
    if (url.pathname === '/api/v1/events' && req.method === 'GET') {
      const actor = sessionUser(req, url);
      if (!actor) return err(res, 401, 'UNAUTHENTICATED');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...securityHeaders(SECURE) });
      const c = { res, userId: actor.id };
      clients.add(c);
      const since = Number(req.headers['last-event-id'] || url.searchParams.get('since') || 0);
      res.write(`event: hello\ndata: ${JSON.stringify({ seq: store.db.eventSeq })}\n\n`);
      if (since) { const user = engine.user(actor.id); for (const ev of store.db.events.filter((e) => e.seq > since && canSee(user, e.incident_id))) res.write(`id: ${ev.seq}\nevent: incident\ndata: ${JSON.stringify({ seq: ev.seq, type: ev.type, incident_id: ev.incident_id, timestamp: ev.timestamp })}\n\n`); }
      req.on('close', () => clients.delete(c));
      return;
    }

    const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
    if (!r) return err(res, 404, 'NOT_FOUND', 'Unknown endpoint');
    try {
      // CSRF: state-changing requests need a custom header (not sendable cross-site
      // without CORS preflight, which we never grant) plus SameSite=Strict cookies.
      const isBearer = !!bearer(req);
      if (req.method !== 'GET' && !isBearer && req.headers['x-bb-csrf'] !== '1') throw new EngineError(403, 'CSRF', 'Missing CSRF header');
      const actor = sessionUser(req);
      if (r.auth && !actor) throw new EngineError(401, 'UNAUTHENTICATED', 'Please log in');
      if (actor?.mustChangePassword && !/\/(me|auth\/change-password|auth\/logout|public-config|health)$/.test(url.pathname)) throw new EngineError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please choose a new password first');
      if (r.limit && !limiter.check(`${r.re}:${actor?.id || ip(req)}`, r.limit[0] * RATE_MULT, r.limit[1])) throw new EngineError(429, 'RATE_LIMITED', 'Too many requests. In an emergency call your local emergency number.');
      const m = url.pathname.match(r.re);
      const p = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await r.handler({ req, res, actor, body, p, q: url.searchParams });
      store.markDirty();
      store.flush();
      broadcast();
      json(res, req.method === 'POST' && /\/incidents$/.test(url.pathname) && !result.duplicate ? 201 : 200, result, origin && APP_ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});
    } catch (e) {
      store.flush();
      if (e instanceof EngineError) return json(res, e.status, { error: { code: e.code, message: e.message } }, origin && APP_ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});
      console.error('[api]', e);
      err(res, 500, 'INTERNAL', 'Something went wrong. If you are in danger, call your local emergency number.');
    }
  });

  server.on('close', () => { clearInterval(timer); clearInterval(heartbeat); for (const c of clients) c.res.end(); store.flush(); });
  return { server, store, get engine() { return engine; } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 8080);
  const env = process.env;
  const dataFile = env.DATA_FILE || path.join(ROOT, 'data', 'db.json');
  const pg = env.DATABASE_URL ? await openPostgres(env.DATABASE_URL, dataFile).catch((e) => { console.error('[db] Cannot reach PostgreSQL:', e.message); process.exit(1); }) : null;
  const { server, store } = createServer({ pg, pgUrl: env.DATABASE_URL });
  server.listen(port, () => console.log(`Beti Bachao listening on port ${port}${pg ? ' (PostgreSQL storage)' : ''}`));
  const stop = () => server.close(async () => { if (store.pg) { await store.pg.flush().catch(() => {}); store.pg.close(); } process.exit(0); });
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
