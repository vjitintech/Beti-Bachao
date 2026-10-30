// Beti Bachao API + static PWA server. Zero runtime dependencies (Node ≥ 20).
//   node server/server.js                    production-style (MFA on, no demo routes)
//   DEMO_MODE=true node server/server.js     seeded synthetic data + demo controls
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Engine, EngineError, SIMULATED_LABEL } from '../public/core/engine.js';
import { COUNTRIES } from '../public/core/config.js';
import { seedDemo, refreshDemoVolunteers, DEMO_PASSWORD, DEMO_CENTER } from '../public/core/seed.js';
import { JsonStore } from './store.js';
import { uuid, sha256, hashPassword, verifyPassword, hashSecret, newTotpSecret, verifyTotp, totp, RateLimiter, securityHeaders } from './security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

export function createServer(opts = {}) {
  const env = { ...process.env, ...opts.env };
  const DEMO = env.DEMO_MODE === 'true';
  const MFA_REQUIRED = env.MFA_REQUIRED ? env.MFA_REQUIRED === 'true' : true;
  const SECURE = env.COOKIE_SECURE === 'true';
  const SESSION_TTL_MS = 12 * 3600 * 1000;
  const store = new JsonStore(env.DATA_FILE || path.join(ROOT, 'data', DEMO ? 'demo-db.json' : 'db.json'));
  const limiter = new RateLimiter();
  let demoMfaSecret = store.db.demoMfaSecret || null;
  let clockOffset = 0;
  const deps = { uuid, hash: sha256, hashSecret, now: () => Date.now() + clockOffset };
  let engine = new Engine(store.db, deps);

  function seedIfNeeded() {
    if (!store.fresh) return;
    if (DEMO) {
      demoMfaSecret = newTotpSecret();
      store.db.demoMfaSecret = demoMfaSecret;
      seedDemo(engine, { passwordHash: hashPassword(DEMO_PASSWORD), mfaSecret: demoMfaSecret });
    } else if (env.ADMIN_EMAIL && env.ADMIN_PASSWORD) {
      const secret = newTotpSecret();
      engine.createUser({ displayName: 'Administrator', email: env.ADMIN_EMAIL, role: 'admin', passwordHash: hashPassword(env.ADMIN_PASSWORD), mfaSecret: secret });
      console.log(`[bootstrap] admin created. TOTP secret (add to authenticator app, shown once): ${secret}`);
    }
    store.save();
  }
  seedIfNeeded();

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
      if (DEMO) refreshDemoVolunteers(engine);
      const changed = engine.tick();
      if (changed.length || DEMO) store.markDirty();
      store.flush();
      broadcast();
    } catch (err) { console.error('[scheduler]', err); }
  }, opts.tickMs || 1000);
  const heartbeat = setInterval(() => { for (const c of clients) c.res.write(': hb\n\n'); }, 20000);

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
  function sessionUser(req) {
    const tok = parseCookies(req).bb_session;
    if (!tok) return null;
    const h = sha256(tok);
    const s = store.db.sessions.find((x) => x.tokenHash === h);
    if (!s || Date.now() > s.expiresAt) return null;
    const u = engine.user(s.userId);
    return u && u.status === 'ACTIVE' ? { id: u.id, role: u.role, session: s } : null;
  }
  function startSession(res, user) {
    const tok = crypto.randomBytes(32).toString('base64url');
    store.db.sessions = store.db.sessions.filter((s) => Date.now() < s.expiresAt);
    store.db.sessions.push({ tokenHash: sha256(tok), userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    return `bb_session=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${SECURE ? '; Secure' : ''}`;
  }
  const ip = (req) => (env.TRUST_PROXY === 'true' ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
  const meView = (u) => ({ id: u.id, displayName: u.displayName, email: u.email, role: u.role, countryCode: u.countryCode, hasPins: !!u.pins, hasDuressPin: !!u.pins?.duress, demo: !!u.demo });

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, { auth = true, limit = null } = {}) => {
    const keys = [];
    const re = new RegExp('^/api/v1' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([A-Za-z0-9-]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth, limit });
  };

  route('GET', '/health', () => ({ ok: true, demo: DEMO, time: new Date(deps.now()).toISOString(), auditChain: engine.verifyAuditChain().ok }), { auth: false });
  route('GET', '/public-config', () => ({ demo: DEMO, mfaRequired: MFA_REQUIRED, countries: COUNTRIES, defaultCountry: engine.cfg.countryCode, simulatedLabel: SIMULATED_LABEL, demoCenter: DEMO ? DEMO_CENTER : null, radiusStagesKm: engine.cfg.radiusStagesKm }), { auth: false });

  route('POST', '/auth/register', async ({ body, res }) => {
    if (!['user', 'volunteer'].includes(body.role)) throw new EngineError(400, 'INVALID_ROLE', 'Only user or volunteer accounts can self-register');
    if (typeof body.password !== 'string' || body.password.length < 8) throw new EngineError(400, 'WEAK_PASSWORD', 'Password must be at least 8 characters');
    const u = engine.createUser({ displayName: body.displayName, email: body.email, role: body.role, passwordHash: hashPassword(body.password), countryCode: COUNTRIES[body.countryCode] ? body.countryCode : null });
    res.setHeader('Set-Cookie', startSession(res, u));
    return { user: meView(u) };
  }, { auth: false, limit: [5, 3600e3] });

  route('POST', '/auth/login', async ({ body, res }) => {
    const u = store.db.users.find((x) => x.email === String(body.email || '').trim().toLowerCase());
    const okPw = u && u.status === 'ACTIVE' && verifyPassword(body.password || '', u.passwordHash);
    if (!okPw) { engine.audit(u?.id || 'anonymous', 'LOGIN_FAILED', 'user', u?.id || 'unknown'); throw new EngineError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect'); }
    if (['operator', 'admin'].includes(u.role) && MFA_REQUIRED) {
      if (!body.mfaCode) return { mfaRequired: true };
      if (!verifyTotp(u.mfaSecret, body.mfaCode)) { engine.audit(u.id, 'MFA_FAILED', 'user', u.id); throw new EngineError(401, 'INVALID_MFA', 'Authenticator code is incorrect'); }
    }
    res.setHeader('Set-Cookie', startSession(res, u));
    engine.audit(u.id, 'LOGIN', 'user', u.id);
    return { user: meView(u) };
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

  route('GET', '/volunteer/profile', ({ actor }) => engine.volunteerProfile(actor));
  route('PATCH', '/volunteer/availability', ({ actor, body }) => engine.setAvailability(actor, body), { limit: [120, 600e3] });
  route('POST', '/volunteer/training', ({ actor, body }) => engine.completeTraining(actor, body));
  route('POST', '/volunteer/verification', ({ actor, body }) => engine.submitVerification(actor, body), { limit: [5, 3600e3] });
  route('GET', '/volunteer/alerts', ({ actor }) => ({ items: engine.volunteerAlerts(actor) }));

  route('POST', '/incidents', ({ actor, body }) => engine.createIncident(actor, body), { limit: [12, 3600e3] });
  route('GET', '/incidents/:id', ({ actor, p }) => engine.viewIncident(actor, p.id));
  route('POST', '/incidents/:id/locations', ({ actor, p, body }) => engine.addLocation(actor, p.id, body), { limit: [240, 600e3] });
  route('POST', '/incidents/:id/cancel', ({ actor, p, body }) => engine.cancelIncident(actor, p.id, body), { limit: [8, 600e3] });
  route('GET', '/incidents/:id/timeline', ({ actor, p }) => ({ items: engine.timeline(actor, p.id) }));
  route('POST', '/incidents/:id/accept', ({ actor, p }) => engine.acceptIncident(actor, p.id), { limit: [30, 600e3] });
  route('POST', '/incidents/:id/decline', ({ actor, p, body }) => engine.declineIncident(actor, p.id, body), { limit: [30, 600e3] });
  route('POST', '/incidents/:id/safety-confirmation', ({ actor, p, body }) => engine.safetyConfirmation(actor, p.id, body), { limit: [20, 600e3] });
  route('POST', '/incidents/:id/escalations', ({ actor, p, body }) => engine.requestEscalation(actor, p.id, body), { limit: [20, 600e3] });
  route('POST', '/assignments/:id/status', ({ actor, p, body }) => engine.updateAssignment(actor, p.id, body), { limit: [240, 600e3] });
  route('POST', '/abuse-reports', ({ actor, body }) => engine.reportAbuse(actor, body), { limit: [10, 3600e3] });

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
    { name: 'Emergency services (112 / ERSS)', status: 'SIMULATED', note: SIMULATED_LABEL },
    { name: 'Push notifications', status: 'IN_APP_ONLY', note: 'In-app + SSE. FCM/APNs adapter not connected.' },
    { name: 'SMS gateway', status: 'NOT_CONNECTED', note: 'User device composes SMS to trusted contacts.' },
    { name: 'Identity verification', status: 'MOCK', note: 'No real ID collected. Production provider needs legal review.' },
    { name: 'Routing / ETA provider', status: 'NOT_CONNECTED', note: 'Straight-line × road factor; always labelled approximate.' },
  ] }; });

  if (DEMO) {
    const demoOnly = (fn) => (ctx) => fn(ctx);
    route('GET', '/demo/accounts', () => ({ password: DEMO_PASSWORD, accounts: store.db.users.filter((u) => u.demo).map((u) => ({ email: u.email, role: u.role, displayName: u.displayName })) }), { auth: false });
    route('GET', '/demo/mfa-code', () => ({ code: demoMfaSecret ? totp(demoMfaSecret) : null, note: 'Demo only — production uses an authenticator app' }), { auth: false });
    route('POST', '/demo/advance', demoOnly(({ body }) => { const s = Math.max(1, Math.min(600, Number(body.seconds) || 30)); clockOffset += s * 1000; refreshDemoVolunteers(engine); return { changed: engine.tick(), clockOffsetSec: clockOffset / 1000 }; }));
    route('POST', '/demo/fail-notifications', demoOnly(({ body }) => { store.db.demo.failNextNotifications = Math.max(0, Math.min(20, Number(body.count) || 1)); return { pending: store.db.demo.failNextNotifications }; }));
    route('POST', '/demo/relocate-volunteers', demoOnly(({ body }) => { refreshDemoVolunteers(engine, { lat: Number(body.lat), lng: Number(body.lng) }); return { ok: true }; }));
    route('POST', '/demo/volunteer-action', demoOnly(({ body }) => {
      const v = store.db.users.find((u) => u.email === body.email && u.role === 'volunteer' && u.demo);
      if (!v) throw new EngineError(404, 'NOT_FOUND', 'Demo volunteer not found');
      const a = { id: v.id };
      if (body.action === 'ACCEPT') return engine.acceptIncident(a, body.incidentId);
      if (body.action === 'DECLINE') return engine.declineIncident(a, body.incidentId, { reason: 'demo' });
      const asg = store.db.assignments.find((x) => x.incidentId === body.incidentId && x.volunteerId === v.id && ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ASSISTING'].includes(x.status));
      if (!asg) throw new EngineError(409, 'NOT_ASSIGNED', 'That volunteer is not assigned');
      return engine.updateAssignment(a, asg.id, { status: body.action, reason: 'demo' });
    }));
    route('POST', '/demo/reset', demoOnly(() => { store.reset(); engine = new Engine(store.db, deps); clockOffset = 0; seedIfNeeded(); lastBroadcastSeq = 0; return { ok: true }; }));
  }

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

    if (url.pathname === '/api/v1/events' && req.method === 'GET') {
      const actor = sessionUser(req);
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
      if (req.method !== 'GET' && req.headers['x-bb-csrf'] !== '1') throw new EngineError(403, 'CSRF', 'Missing CSRF header');
      const actor = sessionUser(req);
      if (r.auth && !actor) throw new EngineError(401, 'UNAUTHENTICATED', 'Please log in');
      if (r.limit && !limiter.check(`${r.re}:${actor?.id || ip(req)}`, r.limit[0], r.limit[1])) throw new EngineError(429, 'RATE_LIMITED', 'Too many requests. In an emergency call your local emergency number.');
      const m = url.pathname.match(r.re);
      const p = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      const body = req.method === 'GET' ? {} : await readBody(req);
      const result = await r.handler({ req, res, actor, body, p, q: url.searchParams });
      store.markDirty();
      store.flush();
      broadcast();
      json(res, req.method === 'POST' && /\/incidents$/.test(url.pathname) && !result.duplicate ? 201 : 200, result);
    } catch (e) {
      store.flush();
      if (e instanceof EngineError) return err(res, e.status, e.code, e.message);
      console.error('[api]', e);
      err(res, 500, 'INTERNAL', 'Something went wrong. If you are in danger, call your local emergency number.');
    }
  });

  server.on('close', () => { clearInterval(timer); clearInterval(heartbeat); for (const c of clients) c.res.end(); store.flush(); });
  return { server, store, get engine() { return engine; } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const port = Number(process.env.PORT || 8080);
  const { server } = createServer();
  server.listen(port, () => console.log(`Beti Bachao listening on http://localhost:${port}${process.env.DEMO_MODE === 'true' ? '  (DEMO MODE — synthetic data, simulated dispatch)' : ''}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
