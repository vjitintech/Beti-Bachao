// Beti Bachao API + PWA server. Zero runtime dependencies (Node ≥ 20).
//   ADMIN_EMAIL=… ADMIN_PASSWORD=… node server/server.js
// The first admin is created from those variables on first start and sets up
// two-step login (authenticator app) at first sign-in. See docs/DEPLOY.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Engine, EngineError, SIMULATED_LABEL } from '../public/core/engine.js';
import { COUNTRIES } from '../public/core/config.js';
import { haversineKm } from '../public/core/geo.js';
import { generateVapidKeys, sendPush, isValidSubscription } from './webpush.js';
import { JsonStore } from './store.js';
import { Fcm, parseServiceAccount } from './fcm.js';
import { createApns } from './apns.js';
import { createVoice } from './voice.js';
import { createMediaStore } from './media.js';
import { openPostgres, attachPostgres } from './pgstore.js';
import { createSms } from './sms.js';
import { createRouting } from './routing.js';
import { createAi } from './ai.js';
import { createBackups } from './backup.js';
import { uuid, sha256, hashPassword, verifyPassword, hashSecret, newTotpSecret, verifyTotp, totp, RateLimiter, securityHeaders, blinkFrameHeaders } from './security.js';

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
  let flushTimer = null;
  const scheduleFlush = () => { if (!flushTimer) flushTimer = setTimeout(() => { flushTimer = null; try { store.flush(); } catch (e) { console.error('[store]', e.message); } }, 1000); };
  const loginFails = new Map(); // email → recent failed-login times (account lockout)
  const deps = { uuid, hash: sha256, hashSecret, now: () => Date.now(), notify: (n) => { queuePush(n); return { ok: true }; } };
  let engine = new Engine(store.db, deps);
  const fetchImpl = opts.fetchImpl || fetch;
  // Optional integrations — each is off until its environment variables are set.
  const fcm = (() => { try { const sa = parseServiceAccount(env.FCM_SERVICE_ACCOUNT); return sa ? new Fcm(sa, { fetchImpl }) : null; } catch (e) { console.error('[fcm]', e.message); return null; } })();
  const apns = (() => { try { return createApns(env, opts.apnsConnect ? { connect: opts.apnsConnect } : {}); } catch (e) { console.error('[apns]', e.message); return null; } })();
  const sms = (() => { try { return createSms(env, { fetchImpl }); } catch (e) { console.error('[sms]', e.message); return null; } })();
  const routing = createRouting(env, { fetchImpl });
  const voice = (() => { try { return createVoice(env, { fetchImpl }); } catch (e) { console.error('[voice]', e.message); return null; } })();
  const media = createMediaStore({ dir: env.MEDIA_DIR || path.join(path.dirname(store.file), 'evidence'), keyHex: env.MEDIA_KEY || null });
  let publicOrigin = (env.PUBLIC_URL || '').replace(/\/$/, '');
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
    POLICE_CONNECTED: (n) => ({ title: '🚓 Calling the police for you', body: n.meta?.station ? `Your phone is calling ${n.meta.station} (${n.meta.phone}). They also got your live location.` : `Your phone is calling ${n.meta?.phone || '112'} now.`, url: n.incidentId ? `#/incident/${n.incidentId}` : '#/home', tag: 'police-' + n.incidentId, urgent: true, callNumber: n.meta?.callNumber || '' }),
    EVIDENCE: (n) => ({ title: '🎙️ SOS evidence received', body: `A ${n.meta?.durationSec || 15}-second ${n.meta?.kind || 'audio'} recording was added to an SOS. Open the operations console.`, url: '#/ops', tag: 'evidence-' + n.incidentId }),
    TRIP_OVERDUE: (n) => ({ title: '⏰ Have you reached safely?', body: `Tap "I'm safe" — otherwise SOS starts automatically in ${Math.round((n.meta?.seconds || 120) / 60)} minutes.`, url: '#/trip', tag: 'trip', urgent: true }),
    TRIP_ENDED: (n) => ({ title: n.meta?.status === 'ARRIVED' ? '💚 Reached safely' : 'Trip ended', body: n.meta?.status === 'ARRIVED' ? 'Your contacts have been told you arrived.' : 'Live sharing has stopped.', url: '#/trip', tag: 'trip' }),
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
  let lastRouting = 0, routingBusy = false, lastPurge = 0;
  function sideJobs() {
    const now = Date.now();
    // 1) SMS to the trusted contacts for the place she is at. Contacts her phone already
    //    texted are skipped; if she moves to another saved place, that place's contacts are added.
    if (sms) for (const inc of store.db.incidents) {
      if (inc.duress || !engine.isOpen(inc)) continue;
      const u = engine.user(inc.requesterId);
      if (!u || u.prefs?.serverSms === false) continue;
      const loc = engine.latestLocation(inc.id);
      const tok0 = publicOrigin ? engine.shareTokenFor(inc.id) : null;
      // The live link shows her location as soon as it arrives, so SMS go out at once.
      // Only without a live link do we wait a few seconds for a GPS fix to put in the message.
      if (!loc && !tok0 && now - Date.parse(inc.createdAt) < 8000) continue;
      const { place, contacts } = engine.contactsFor(u.id, loc);
      inc.smsSentTo ||= [];
      const key = (ph) => String(ph).replace(/\D/g, '').slice(-10); // +91 98… and 98… are the same person
      const sent = new Set(inc.smsSentTo.map(key));
      const todo = contacts.filter((c) => { const k = key(c.phone); if (sent.has(k)) return false; sent.add(k); return true; });
      // Second message: nobody has responded yet → tell the same people she is still waiting.
      if (!inc.waitingSmsAt && inc.smsSentTo.length && now - Date.parse(inc.createdAt) > engine.cfg.contactsWaitingSec * 1000 && !inc.opAckAt && !engine.hasResponder(inc.id)) {
        inc.waitingSmsAt = new Date().toISOString(); store.markDirty();
        const tokW = engine.shareTokenFor(inc.id);
        const linkW = publicOrigin && tokW ? `${publicOrigin}/s/${tokW}` : loc ? mapsLink(loc) : '(location pending — call her)';
        const toW = [...new Map(inc.smsSentTo.map((ph) => [key(ph), ph])).values()];
        for (const ph of toW) sms.send(ph, 'WAITING', { name: u.displayName, link: linkW })
          .then((r) => engine.audit('system', r.ok ? 'CONTACT_WAITING_SMS_SENT' : 'CONTACT_WAITING_SMS_FAILED', 'incident', inc.id, r.ok ? null : String(r.error || r.status)));
        store.db.escalations.push({ id: crypto.randomUUID(), incidentId: inc.id, type: 'CONTACTS_STILL_WAITING', status: 'ATTEMPTED', label: 'No responder yet — your contacts were sent a second SMS: still waiting for help', reason: 'no volunteer or operator response', attemptedAt: new Date().toISOString(), acknowledgedAt: null, recordedBy: 'system', metadata: { contacts: toW.length } });
      }
      if (!todo.length) continue;
      inc.contactsSmsAt ||= new Date().toISOString();
      if (place && inc.contactsPlace !== place.label) inc.contactsPlace = place.label;
      inc.smsSentTo.push(...todo.map((c) => c.phone));
      store.markDirty();
      const tok = engine.shareTokenFor(inc.id);
      const link = publicOrigin && tok ? `${publicOrigin}/s/${tok}` : loc ? mapsLink(loc) : '(location pending — call her)';
      for (const c of todo) sms.send(c.phone, 'SOS', { name: u.displayName, link })
        .then((r) => engine.audit('system', r.ok ? 'CONTACT_SMS_SENT' : 'CONTACT_SMS_FAILED', 'incident', inc.id, r.ok ? null : String(r.error || r.status), { place: place?.label || null }));
    }
    // 1b) Automatic police connection: SMS with her live location + call bridging station ↔ her phone.
    for (const inc of store.db.incidents) {
      const pc = inc.policeConnect;
      if (!pc || pc.jobAt || pc.status !== 'PENDING') continue;
      pc.jobAt = new Date().toISOString(); store.markDirty();
      const u = engine.user(inc.requesterId);
      const loc = engine.latestLocation(inc.id);
      if (!pc.station) { engine.setPoliceResult(inc.id, { status: 'NO_STATION' }); continue; }
      const vars = { name: u?.displayName || 'A woman', phone: u?.phone || 'unknown', link: loc ? mapsLink(loc) : 'location pending', ref: inc.id.slice(0, 8) };
      const jobs = [];
      if (sms) jobs.push(Promise.all([pc.station.phone, pc.station.phone2].filter(Boolean).map((ph) => sms.send(ph, 'POLICE', vars))).then((rs) => ({ sms: rs.some((r) => r.ok) ? 'SENT' : 'FAILED' })));
      if (voice && u?.phone) jobs.push(voice.bridge({ first: pc.station.phone, second: u.phone, message: `Emergency from Beti Bachao. ${vars.name} raised an SOS near your station and needs police help. Her location has been sent to you by SMS. Reference ${vars.ref.split('').join(' ')}.` }).then((r) => ({ call: r.ok ? 'PLACED' : 'FAILED' })));
      if (!jobs.length) { engine.setPoliceResult(inc.id, { status: 'NO_GATEWAY' }); continue; }
      Promise.all(jobs).then((parts) => {
        const patch = Object.assign({}, ...parts);
        patch.status = patch.sms === 'SENT' || patch.call === 'PLACED' ? 'CONTACTED' : 'FAILED';
        engine.setPoliceResult(inc.id, patch);
        engine.audit('system', 'POLICE_CONTACT_' + patch.status, 'incident', inc.id, null, patch);
        store.markDirty(); broadcast();
      });
    }
    // 1c) Track my travel: SMS the live link to her contacts at start, "reached safely" at the end.
    if (sms) for (const t of store.db.trips || []) {
      const u = engine.user(t.userId);
      if (!u || u.prefs?.serverSms === false) continue;
      if (t.status === 'ACTIVE' && !t.smsStartAt && publicOrigin) {
        t.smsStartAt = new Date().toISOString();
        t.smsTo = engine.contactsFor(u.id, t.last || t.destination).contacts.map((c) => c.phone);
        store.markDirty();
        for (const ph of t.smsTo) sms.send(ph, 'TRIP_START', { name: u.displayName, dest: t.destination.label, link: `${publicOrigin}/t/${t.token}`, vehicle: t.vehicle || '-' });
      } else if (t.status === 'ARRIVED' && t.smsStartAt && !t.smsEndAt) {
        t.smsEndAt = new Date().toISOString(); store.markDirty();
        for (const ph of t.smsTo || []) sms.send(ph, 'TRIP_SAFE', { name: u.displayName, dest: t.destination.label });
      }
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
    // 3) Road-route ETA for active responders: at once for a new responder, then every 30 s
    //    (or sooner if they moved > 300 m). Provider results are cached in routing.js.
    if (routing && !routingBusy && now - lastRouting > 2000) {
      const due = store.db.assignments.filter((a) => ['ACCEPTED', 'EN_ROUTE'].includes(a.status)).map((a) => {
        const v = engine.vol(a.volunteerId); const her = engine.latestLocation(a.incidentId);
        if (!v?.lastLocation || !her) return null;
        const d = haversineKm(v.lastLocation, her);
        const r = a.routeEta; const age = r ? now - Date.parse(r.at) : Infinity;
        return !r || age > 30000 || (r.fromKm != null && Math.abs(r.fromKm - d) > 0.3 && age > 8000) ? { a, from: v.lastLocation, her, d } : null;
      }).filter(Boolean).slice(0, 10);
      if (due.length) {
        lastRouting = now; routingBusy = true;
        Promise.allSettled(due.map(async ({ a, from, her, d }) => {
          const r = await routing.eta(from, her);
          if (r) { engine.setRouteEta(a.id, { ...r, fromKm: +d.toFixed(3) }); store.markDirty(); }
        })).finally(() => { routingBusy = false; });
      }
    }
    // 4) Daily automatic backup.
    if (now - lastPurge > 3600e3) { lastPurge = now; for (const k of engine.expiredEvidence()) media.del(k); store.markDirty(); }
    if (backups && backups.due()) { try { const f = backups.run(store.db); engine.audit('system', 'BACKUP_CREATED', 'system', f); } catch (e) { console.error('[backup]', e.message); } }
  }

  // ---------- helpers ----------
  // Responses over 1 KB are gzip-compressed when the phone/browser accepts it (≈ 75 % less data).
  const gzipOk = (res) => /\bgzip\b/.test(String(res.req?.headers['accept-encoding'] || ''));
  const json = (res, status, body, extra = {}) => {
    const text = JSON.stringify(body);
    if (text.length > 1024 && gzipOk(res)) {
      const z = zlib.gzipSync(text, { level: 6 });
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': z.length, 'Cache-Control': 'no-store', ...securityHeaders(SECURE), ...extra });
      return res.end(z);
    }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders(SECURE), ...extra });
    res.end(text);
  };
  const err = (res, status, code, message) => json(res, status, { error: { code, message: message || code } });

  function readBody(req, max = 32 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > max) { reject(new EngineError(413, 'PAYLOAD_TOO_LARGE')); req.destroy(); } else chunks.push(c); });
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
  const TRUST_PROXY = env.TRUST_PROXY === 'true' || (env.RENDER === 'true' && env.TRUST_PROXY !== 'false'); // Render's proxy sets X-Forwarded-For
  const ip = (req) => (TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
  const meView = (u) => ({ id: u.id, displayName: u.displayName, email: u.email, phone: u.phone || null, role: u.role, countryCode: u.countryCode, hasPins: !!u.pins, hasDuressPin: !!u.pins?.duress, mustChangePassword: !!u.mustChangePassword });

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, { auth = true, limit = null, maxBody = 32 * 1024, batchWrite = false } = {}) => {
    const keys = [];
    const re = new RegExp('^/api/v1' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9-]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth, limit, maxBody, batchWrite });
  };

  let chainCheck = { at: 0, ok: true }; // the audit-chain check walks every entry — monitors probe often, so cache it a minute
  route('GET', '/health', () => {
    if (deps.now() - chainCheck.at > 60000) chainCheck = { at: deps.now(), ok: engine.verifyAuditChain().ok };
    const db = store.pg ? { kind: 'postgresql', ok: store.pg.status.ok, lastWriteAt: store.pg.status.lastWriteAt } : { kind: 'file', ok: true };
    return { ok: db.ok, time: new Date(deps.now()).toISOString(), auditChain: chainCheck.ok, db };
  }, { auth: false });
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
  route('GET', '/public-config', () => ({ setupNeeded: !store.db.users.some((u) => u.role === 'admin'), demo: false, mfaRequired: MFA_REQUIRED, countries: COUNTRIES, defaultCountry: engine.cfg.countryCode, simulatedLabel: SIMULATED_LABEL, radiusStagesKm: engine.cfg.radiusStagesKm, policeAutoConnectSec: engine.cfg.policeAutoConnectSec, policeMaxKm: engine.cfg.policeMaxKm, contactsWaitingSec: engine.cfg.contactsWaitingSec, vapidPublicKey: store.db.vapid.publicKey, features: { appPush: !!(fcm || apns), iosPush: !!(apns || fcm), policeCall: !!voice, sms: !!sms, smsReset: !!sms, roadEta: !!routing, ai: !!ai } }), { auth: false });

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
    const email = String(body.email || '').trim().toLowerCase();
    const u = store.db.users.find((x) => x.email === email);
    // Account lockout: 5 wrong passwords in 15 min locks that account for 15 min (any IP).
    const lk = (loginFails.get(email) || []).filter((t) => Date.now() - t < 15 * 60000);
    if (lk.length >= 5) { engine.audit(u?.id || 'anonymous', 'LOGIN_LOCKED', 'user', u?.id || 'unknown'); throw new EngineError(429, 'ACCOUNT_LOCKED', 'Too many wrong passwords. Try again in 15 minutes, or use "Forgot password". In danger, call 112.'); }
    const okPw = u && u.status === 'ACTIVE' && verifyPassword(body.password || '', u.passwordHash);
    if (!okPw) { lk.push(Date.now()); loginFails.set(email, lk); if (loginFails.size > 5000) loginFails.delete(loginFails.keys().next().value); engine.audit(u?.id || 'anonymous', 'LOGIN_FAILED', 'user', u?.id || 'unknown'); throw new EngineError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect'); }
    loginFails.delete(email);
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
  route('DELETE', '/me', ({ actor }) => {
    const { evidenceKeys = [], ...r } = engine.deleteMyAccount(actor);
    for (const k of evidenceKeys) media.del(k);
    store.db.sessions = store.db.sessions.filter((s) => s.userId !== actor.id);
    store.db.devices = (store.db.devices || []).filter((d) => d.userId !== actor.id);
    store.db.pushSubs = (store.db.pushSubs || []).filter((d) => d.userId !== actor.id);
    return r;
  });

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
  // Location pings are ~95 % of traffic: saved to disk in a batch (≤1 s later), not one full write each.
  route('POST', '/me/location', ({ actor, body }) => engine.ingestDeviceLocation(actor, body), { limit: [600, 3600e3], batchWrite: true });
  route('GET', '/me/contacts', ({ actor }) => engine.getContacts(actor));
  route('GET', '/me/places', ({ actor }) => engine.getPlaces(actor));
  route('PUT', '/me/places', ({ actor, body }) => engine.setPlaces(actor, body), { limit: [30, 3600e3] });
  route('GET', '/me/dashboard', ({ actor }) => engine.myDashboard(actor));
  route('GET', '/help/nearby', ({ actor, q }) => engine.nearbyHelp(actor, { lat: q.get('lat'), lng: q.get('lng') }));
  route('GET', '/impact', () => engine.publicImpact(), { auth: false, limit: [120, 3600e3] });
  route('GET', '/me/trip', ({ actor }) => engine.myTrip(actor));
  route('POST', '/me/trip', ({ actor, body }) => engine.startTrip(actor, body), { limit: [30, 3600e3] });
  route('POST', '/me/trip/end', ({ actor, body }) => engine.endTrip(actor, body));
  route('POST', '/me/trip/extend', ({ actor, body }) => engine.extendTrip(actor, body));
  route('GET', '/t/:token', ({ p }) => { const v = engine.publicTrip(p.token); if (!v) throw new EngineError(404, 'NOT_FOUND', 'This link is not valid'); return v; }, { auth: false, limit: [600, 3600e3] });
  route('GET', '/s/:token', ({ p }) => { const v = engine.publicSos(p.token); if (!v) throw new EngineError(404, 'NOT_FOUND', 'This link is not valid'); return v; }, { auth: false, limit: [1200, 3600e3] });
  route('POST', '/incidents/:id/evidence', ({ actor, p, body }) => {
    const mime = String(body.mime || '');
    if (!/^(audio|video)\/[\w.+-]+(;.*)?$/.test(mime)) throw new EngineError(400, 'INVALID_MEDIA', 'Audio or video only');
    const buf = Buffer.from(String(body.data || ''), 'base64');
    if (buf.length < 100 || buf.length > 4 * 1024 * 1024) throw new EngineError(400, 'INVALID_MEDIA', 'Recording must be under 4 MB');
    const inc = engine.incident(p.id);
    if (inc.requesterId !== actor.id) throw new EngineError(403, 'FORBIDDEN');
    const storageKey = media.put(buf);
    try { return engine.addEvidence(actor, p.id, { kind: body.kind || mime.split('/')[0], mime, durationSec: body.durationSec, bytes: buf.length, storageKey }); } catch (e) { media.del(storageKey); throw e; }
  }, { maxBody: 6 * 1024 * 1024, limit: [30, 3600e3] });
  // App error tracking: browser/WebView errors and native crash traces (sent on next start).
  route('POST', '/client-errors', ({ actor, body, req }) => {
    const e = { at: new Date().toISOString(), userId: actor?.id || null, role: actor?.role || null, kind: String(body.kind || 'js').slice(0, 20), message: String(body.message || '').slice(0, 500), stack: String(body.stack || '').slice(0, 6000), where: String(body.where || '').slice(0, 200), app: String(body.app || '').slice(0, 80), ua: String(req.headers['user-agent'] || '').slice(0, 200) };
    console.error(JSON.stringify({ level: 'error', type: 'client_error', ...e, stack: e.stack.slice(0, 800) }));
    store.db.clientErrors = [...(store.db.clientErrors || []), e].slice(-200); store.markDirty();
    return { ok: true };
  }, { auth: false, limit: [60, 3600e3], maxBody: 16 * 1024 });
  route('GET', '/admin/client-errors', ({ actor }) => { engine.requireRole(actor, 'admin'); return { items: (store.db.clientErrors || []).slice().reverse() }; });
  route('POST', '/incidents/:id/evidence-log', ({ actor, p, body }) => engine.evidenceLog(actor, p.id, body), { limit: [120, 3600e3] });
  route('POST', '/incidents/:id/police-call', ({ actor, p, body }) => engine.recordPoliceCall(actor, p.id, body), { limit: [60, 3600e3] });
  route('GET', '/incidents/:id/evidence/:eid', ({ actor, p }) => { const e = engine.evidenceFor(actor, p.id, p.eid); return { __raw: true, type: e.mime.split(';')[0], body: media.get(e.storageKey) }; });
  route('POST', '/operator/incidents/:id/ack', ({ actor, p }) => engine.operatorAck(actor, p.id));
  route('GET', '/admin/dashboard', ({ actor, q }) => engine.adminDashboard(actor, { days: q.get('days') }));
  route('GET', '/admin/police-stations', ({ actor }) => engine.listStations(actor));
  route('POST', '/admin/police-stations', ({ actor, body }) => engine.importStations(actor, body), { maxBody: 2 * 1024 * 1024 });
  route('POST', '/admin/police-stations/one', ({ actor, body }) => engine.addStation(actor, body));
  route('DELETE', '/admin/police-stations/:id', ({ actor, p }) => engine.deleteStation(actor, p.id));
  route('PUT', '/me/contacts', ({ actor, body }) => engine.setContacts(actor, body), { limit: [30, 3600e3] });
  route('POST', '/incidents/:id/rate', ({ actor, p, body }) => engine.rateResponder(actor, p.id, body), { limit: [20, 3600e3] });
  route('POST', '/admin/volunteers/:id/schedule-call', ({ actor, p, body }) => {
    const call = engine.scheduleVerificationCall(actor, p.id, body);
    const vu = engine.user(p.id);
    if (sms && vu?.phone) sms.send(vu.phone, 'VERIFY', { time: new Date(call.scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) });
    return call;
  });
  route('GET', '/admin/users', ({ actor, q }) => ({ items: engine.findUsers(actor, q.get('q'), { status: q.get('status') || '', role: q.get('role') || '', km: q.get('km'), near: q.get('lat') && q.get('lng') ? { lat: Number(q.get('lat')), lng: Number(q.get('lng')) } : null }) }));
  route('POST', '/admin/users/:id/reset-password', ({ actor, p }) => {
    const temp = crypto.randomBytes(6).toString('base64url') + '-' + crypto.randomInt(100, 999);
    engine.adminResetPassword(actor, p.id, hashPassword(temp));
    store.db.sessions = store.db.sessions.filter((x) => x.userId !== p.id);
    return { temporaryPassword: temp, note: 'Share privately. They must choose a new password at next login.' };
  }, { limit: [30, 3600e3] });
  route('POST', '/auth/change-password', ({ actor, body }) => {
    const u = engine.user(actor.id);
    // Right after an admin reset she has just signed in with the temporary password,
    // so that session itself proves it: no need to type the temporary password again.
    const freshAfterReset = u.mustChangePassword && actor.session && actor.session.createdAt >= (u.passwordResetAt || 0);
    // 400, not 401: a wrong current password must not look like an expired session (the app would log her out).
    if (!freshAfterReset && !verifyPassword(body.currentPassword || '', u.passwordHash)) throw new EngineError(400, 'WRONG_CURRENT_PASSWORD', 'Current password is incorrect');
    const min = ['operator', 'admin'].includes(u.role) ? 12 : 10;
    if (typeof body.newPassword !== 'string' || body.newPassword.length < min) throw new EngineError(400, 'WEAK_PASSWORD', `New password must be at least ${min} characters`);
    u.passwordHash = hashPassword(body.newPassword); u.mustChangePassword = false; u.passwordResetAt = null;
    store.db.sessions = store.db.sessions.filter((x) => x.userId !== u.id || x.tokenHash === actor.session?.tokenHash);
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
    if (!r.duplicate) setImmediate(() => { try { sideJobs(); store.flush(); broadcast(); } catch (err) { console.error('[sos-fast]', err); } }); // SMS/push now, not at the next tick
    if (ai && !r.duplicate && body.note) ai.riskAssessment('sos_note', body.note, {}).then((risk) => { const inc = store.db.incidents.find((x) => x.id === r.incident.id); if (inc && risk) { inc.ai = { ...(inc.ai || {}), risk }; store.markDirty(); } });
    return r;
  }, { limit: [12, 3600e3] });
  route('GET', '/incidents/:id', ({ actor, p }) => engine.viewIncident(actor, p.id));
  route('POST', '/incidents/:id/locations', ({ actor, p, body }) => engine.addLocation(actor, p.id, body), { limit: [240, 600e3], batchWrite: true });
  route('POST', '/incidents/:id/cancel', ({ actor, p, body }) => engine.cancelIncident(actor, p.id, body), { limit: [8, 600e3] });
  route('GET', '/incidents/:id/timeline', ({ actor, p }) => ({ items: engine.timeline(actor, p.id) }));
  route('POST', '/incidents/:id/accept', ({ actor, p }) => { const r = engine.acceptIncident(actor, p.id); setImmediate(() => { try { sideJobs(); } catch (err) { console.error('[accept-route]', err); } }); return r; }, { limit: [30, 600e3] });
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
    { name: 'Police auto-connect', status: (store.db.policeStations || []).length ? `${store.db.policeStations.length} STATIONS` : 'NO STATION LIST', note: `If no operator acknowledges an SOS within ${engine.cfg.policeAutoConnectSec} s (or she presses SOS again), her phone automatically calls the nearest station within ${engine.cfg.policeMaxKm} km (else 1091, else 112) and the station gets an SMS${voice ? ' plus a bridged call' : ''}. ${voice ? `Calls via ${voice.name}.` : 'Set VOICE_PROVIDER (exotel/twilio) for the automatic call.'} Import stations in Admin → Police stations.` },
    { name: 'Road-route ETA', status: routing ? 'ACTIVE' : 'ESTIMATE', note: routing ? routing.describe + '. Set GOOGLE_MAPS_API_KEY (Routes API) for live traffic.' : 'Routing is off (ROUTING_URL=off). Straight-line estimate.' },
    { name: 'Local AI (Colibri)', status: ai ? 'ACTIVE' : 'OFF', note: ai ? `Model ${ai.model}. Advisory only.` : 'Set AI_BASE_URL to enable operator summaries, translation and risk flags.' },
    { name: 'Automatic backups', status: backups ? 'ACTIVE' : 'OFF', note: backups ? `Daily, kept ${Number(env.BACKUP_KEEP) || 14}${env.BACKUP_KEY ? ', encrypted' : ''}.` : 'Disabled.' },
    { name: 'Browser push notifications', status: 'ACTIVE', note: `${store.db.pushSubs.length} device(s) subscribed. Android Chrome; iPhone only when installed to Home Screen (iOS 16.4+).` },
    { name: 'SMS to trusted contacts', status: 'ON DEVICE', note: "Opens the user's own SMS app pre-filled; no SMS gateway." },
    { name: 'Volunteer identity verification', status: 'MANUAL', note: 'Trust team verifies ID by video call / in person; no ID documents stored.' },
    { name: 'Route ETA', status: 'ESTIMATE', note: 'Straight-line × road factor; always labelled approximate.' },
  ] }; });

  // ---------- static ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.webp': 'image/webp', '.wasm': 'application/wasm', '.data': 'application/octet-stream', '.binarypb': 'application/octet-stream' };
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC + path.sep)) return err(res, 400, 'BAD_PATH');
    fs.stat(file, (e, st) => {
      if (e || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain', ...securityHeaders(SECURE) }); return res.end('Not found'); }
      const ext = path.extname(file);
      const gz = /\.(js|css|html|json|svg|webmanifest|txt)$/.test(file) && gzipOk(res);
      res.writeHead(200, { ...(gz ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}), 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' || file.endsWith('sw.js') ? 'no-cache' : file.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=2592000, immutable' : 'public, max-age=300', ...(file.endsWith(`${path.sep}blink-frame.html`) ? blinkFrameHeaders(SECURE) : securityHeaders(SECURE)) });
      if (gz) { fs.createReadStream(file).pipe(zlib.createGzip({ level: 6 })).pipe(res); return; }
      fs.createReadStream(file).pipe(res);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://local');
    // Structured access log (one JSON line per API call; no bodies, no tokens) + request id.
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/v1/events') {
      const rid = crypto.randomBytes(6).toString('hex'); const t0 = process.hrtime.bigint();
      res.setHeader('X-Request-Id', rid);
      res.on('finish', () => { if (env.ACCESS_LOG === 'off' || (url.pathname === '/api/v1/health' && res.statusCode < 400)) return; console.log(JSON.stringify({ level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info', type: 'http', rid, method: req.method, path: url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/g, ':id').replace(/\/[a-f0-9]{32}$/, '/:token'), status: res.statusCode, ms: Number((process.hrtime.bigint() - t0) / 1000000n) })); });
    }
    if (/^\/[ts]\/[a-f0-9]{32}$/.test(url.pathname)) return serveStatic(req, res, '/track.html');
    if (url.pathname === '/privacy' || url.pathname === '/delete-account' || url.pathname === '/download') return serveStatic(req, res, url.pathname + '.html');
    // Short, permanent link to the newest Android app (fixed destination: our own GitHub release).
    if (url.pathname === '/apk') { res.writeHead(302, { Location: env.APK_URL || 'https://github.com/vjitintech/Beti-Bachao/releases/download/android-latest/BetiBachao-debug.apk', 'Cache-Control': 'no-store' }); return res.end(); }
    // Uptime monitors (UptimeRobot etc.) often probe /health with HEAD — answer like the API health check.
    if (url.pathname === '/health' || url.pathname === '/healthz') url.pathname = '/api/v1/health';
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

    const method = req.method === 'HEAD' ? 'GET' : req.method; // HEAD = GET without a body (Node drops the body)
    const r = routes.find((x) => x.method === method && x.re.test(url.pathname));
    if (!r) return err(res, 404, 'NOT_FOUND', 'Unknown endpoint');
    try {
      // CSRF: state-changing requests need a custom header (not sendable cross-site
      // without CORS preflight, which we never grant) plus SameSite=Strict cookies.
      const isBearer = !!bearer(req);
      if (method !== 'GET' && !isBearer && req.headers['x-bb-csrf'] !== '1') throw new EngineError(403, 'CSRF', 'Missing CSRF header');
      const actor = sessionUser(req);
      if (r.auth && !actor) throw new EngineError(401, 'UNAUTHENTICATED', 'Please log in');
      if (actor?.mustChangePassword && !/\/(me|auth\/change-password|auth\/logout|public-config|health)$/.test(url.pathname)) throw new EngineError(403, 'PASSWORD_CHANGE_REQUIRED', 'Please choose a new password first');
      if (r.limit && !limiter.check(`${r.re}:${actor?.id || ip(req)}`, r.limit[0] * RATE_MULT, r.limit[1])) throw new EngineError(429, 'RATE_LIMITED', 'Too many requests. In an emergency call your local emergency number.');
      const m = url.pathname.match(r.re);
      const p = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const body = method === 'GET' ? {} : await readBody(req, r.maxBody);
      if (!env.PUBLIC_URL && req.headers.host) publicOrigin = `${TRUST_PROXY ? String(req.headers['x-forwarded-proto'] || 'https').split(',')[0] : (SECURE ? 'https' : 'http')}://${req.headers.host}`;
      const result = await r.handler({ req, res, actor, body, p, q: url.searchParams });
      if (result && result.__raw) {
        res.writeHead(200, { 'Content-Type': result.type, 'Content-Length': result.body.length, 'Cache-Control': 'no-store', ...securityHeaders(SECURE), ...(origin && APP_ORIGINS.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}) });
        return res.end(result.body);
      }
      store.markDirty();
      if (r.batchWrite) scheduleFlush(); else store.flush(); // SOS, cancel, safety answers, accounts: written before we answer
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
  // Timeouts: slow or stuck clients can't hold connections forever (SSE streams are long-lived by design).
  server.headersTimeout = 20000; server.requestTimeout = 60000; server.keepAliveTimeout = 65000;
  // Graceful shutdown (Render sends SIGTERM on every deploy): stop accepting, end live streams,
  // write the last changes to disk / PostgreSQL, then exit. Forced exit after 10 s.
  async function shutdown() {
    for (const c of clients) { try { c.res.end(); } catch {} }
    clients.clear();
    await new Promise((r) => { server.close(() => r()); server.closeIdleConnections?.(); setTimeout(r, 8000).unref?.(); });
    clearTimeout(flushTimer); try { store.flush(); } catch (e) { console.error('[shutdown] save', e.message); }
    if (store.pg) { await store.pg.flush().catch(() => {}); try { store.pg.close(); } catch {} }
  }
  return { server, store, shutdown, get engine() { return engine; } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 8080);
  const env = process.env;
  const dataFile = env.DATA_FILE || path.join(ROOT, 'data', 'db.json');
  const pg = env.DATABASE_URL ? await openPostgres(env.DATABASE_URL, dataFile).catch((e) => { console.error('[db] Cannot reach PostgreSQL:', e.message); process.exit(1); }) : null;
  // An SOS server must not die from one unexpected background error: log it loudly and keep serving.
  process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
  process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));
  const { server, shutdown } = createServer({ pg, pgUrl: env.DATABASE_URL });
  server.listen(port, () => console.log(`Beti Bachao listening on port ${port}${pg ? ' (PostgreSQL storage)' : ''}`));
  let stopping = false;
  const stop = async (sig) => { if (stopping) return; stopping = true; console.log(JSON.stringify({ level: 'info', type: 'shutdown', signal: sig })); setTimeout(() => process.exit(1), 10000).unref(); await shutdown(); process.exit(0); };
  process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
}
