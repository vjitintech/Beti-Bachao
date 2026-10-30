// One API surface, two backends:
//   ServerApi     → the Node backend (/api/v1), real auth, SSE, server-side timers
//   StandaloneApi → runs the same engine inside the browser (GitHub Pages demo).
//                   Clearly labelled; data lives only in this browser.
import { Engine, EngineError, emptyDb, SIMULATED_LABEL } from '../core/engine.js?v=mvuiiaym';
import { COUNTRIES } from '../core/config.js?v=mvuiiaym';
import { seedDemo, refreshDemoVolunteers, simulateDemoMovement, DEMO_CENTER, DEMO_PASSWORD } from '../core/seed.js?v=mvuiiaym';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15); return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

export class ApiError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }

// ------------------------------------------------------------------ server
class ServerApi {
  constructor() { this.mode = 'server'; this.listeners = new Set(); this.es = null; }
  async req(method, path, body) {
    let res;
    try {
      res = await fetch('api/v1' + path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-BB-CSRF': '1' }, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new ApiError(0, 'NETWORK', 'No connection'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error?.code || 'ERROR', data.error?.message || 'Request failed');
    return data;
  }
  connect() {
    if (this.es) this.es.close();
    this.es = new EventSource('api/v1/events');
    this.es.addEventListener('incident', (e) => { const d = JSON.parse(e.data); this.listeners.forEach((f) => f(d)); });
    this.es.addEventListener('hello', () => this.listeners.forEach((f) => f({ type: 'resync' })));
  }
  disconnect() { this.es?.close(); this.es = null; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  publicConfig() { return this.req('GET', '/public-config'); }
  me() { return this.req('GET', '/me'); }
  login(email, password, mfaCode) { return this.req('POST', '/auth/login', { email, password, mfaCode }); }
  register(b) { return this.req('POST', '/auth/register', b); }
  logout() { this.disconnect(); return this.req('POST', '/auth/logout'); }
  demoAccounts() { return this.req('GET', '/demo/accounts'); }
  demoMfaCode() { return this.req('GET', '/demo/mfa-code'); }
  setPins(b) { return this.req('PATCH', '/me/pins', b); }
  myIncidents() { return this.req('GET', '/me/incidents'); }
  exportData() { return this.req('GET', '/me/export'); }
  deleteAccount() { return this.req('DELETE', '/me'); }

  createIncident(b) { return this.req('POST', '/incidents', b); }
  getIncident(id) { return this.req('GET', `/incidents/${id}`); }
  addLocation(id, loc) { return this.req('POST', `/incidents/${id}/locations`, loc); }
  cancel(id, b) { return this.req('POST', `/incidents/${id}/cancel`, b); }
  timeline(id) { return this.req('GET', `/incidents/${id}/timeline`); }
  accept(id) { return this.req('POST', `/incidents/${id}/accept`); }
  decline(id, b) { return this.req('POST', `/incidents/${id}/decline`, b); }
  safety(id, b) { return this.req('POST', `/incidents/${id}/safety-confirmation`, b); }
  escalate(id, b) { return this.req('POST', `/incidents/${id}/escalations`, b); }
  assignmentStatus(aid, b) { return this.req('POST', `/assignments/${aid}/status`, b); }
  reportAbuse(b) { return this.req('POST', '/abuse-reports', b); }

  volunteerProfile() { return this.req('GET', '/volunteer/profile'); }
  setAvailability(b) { return this.req('PATCH', '/volunteer/availability', b); }
  completeTraining(moduleId) { return this.req('POST', '/volunteer/training', { moduleId }); }
  submitVerification(b) { return this.req('POST', '/volunteer/verification', b); }
  volunteerAlerts() { return this.req('GET', '/volunteer/alerts'); }

  opIncidents(all) { return this.req('GET', '/operator/incidents' + (all ? '?all=1' : '')); }
  reassign(id, b) { return this.req('POST', `/operator/incidents/${id}/reassign`, b); }
  handoff(id, b) { return this.req('POST', `/operator/incidents/${id}/handoff`, b); }
  closureException(id, b) { return this.req('POST', `/operator/incidents/${id}/closure-exception`, b); }
  adminConfig() { return this.req('GET', '/admin/config'); }
  patchConfig(b) { return this.req('PATCH', '/admin/config', b); }
  adminVolunteers() { return this.req('GET', '/admin/volunteers'); }
  reviewVolunteer(id, b) { return this.req('POST', `/admin/volunteers/${id}/review`, b); }
  abuseList() { return this.req('GET', '/admin/abuse-reports'); }
  resolveAbuse(id, b) { return this.req('POST', `/admin/abuse-reports/${id}/resolve`, b); }
  audit(limit = 100) { return this.req('GET', `/admin/audit-events?limit=${limit}`); }
  integrations() { return this.req('GET', '/admin/integrations'); }

  demoAdvance(seconds) { return this.req('POST', '/demo/advance', { seconds }); }
  demoFail(count) { return this.req('POST', '/demo/fail-notifications', { count }); }
  demoRelocate(lat, lng) { return this.req('POST', '/demo/relocate-volunteers', { lat, lng }); }
  demoVolunteerAction(email, incidentId, action) { return this.req('POST', '/demo/volunteer-action', { email, incidentId, action }); }
  demoReset() { return this.req('POST', '/demo/reset'); }
}

// ------------------------------------------------------------------ standalone
// Non-cryptographic hash (FNV-1a, 2×32-bit) — demo integrity only; the server uses SHA-256/scrypt.
function fnv(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2246822507) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
const KEY = 'bb.standalone.db.v2';

class StandaloneApi {
  constructor() {
    this.mode = 'standalone';
    this.listeners = new Set();
    this.deps = { uuid, hash: fnv, hashSecret: (s, salt) => fnv(salt + ':' + s), now: () => Date.now() };
    this.lastSeq = 0;
    if (!this.load()) this.reset();
    this.lastSeq = this.db.eventSeq;
    window.addEventListener('storage', (e) => { if (e.key === KEY) { this.load(); this.fanout(); } });
    this.timer = setInterval(() => this.run(() => { refreshDemoVolunteers(this.engine); simulateDemoMovement(this.engine); return this.engine.tick(); }, { quiet: true }), 1000);
  }
  load() {
    try { const raw = localStorage.getItem(KEY); if (!raw) return false; this.db = JSON.parse(raw); this.engine = new Engine(this.db, this.deps); return true; } catch { return false; }
  }
  save() { try { localStorage.setItem(KEY, JSON.stringify(this.db)); } catch {} }
  reset() {
    this.db = emptyDb();
    this.engine = new Engine(this.db, this.deps);
    seedDemo(this.engine);
    this.save();
    try { sessionStorage.removeItem('bb.actor'); } catch {}
  }
  fanout() {
    const evs = this.db.events.filter((e) => e.seq > this.lastSeq);
    if (evs.length) this.lastSeq = evs[evs.length - 1].seq;
    for (const e of evs) this.listeners.forEach((f) => f(e));
  }
  get actor() { try { const id = sessionStorage.getItem('bb.actor'); return id ? { id } : null; } catch { return null; } }
  run(fn, { quiet = false } = {}) {
    this.load();
    try {
      const r = fn();
      this.save();
      this.fanout();
      return Promise.resolve(r === undefined ? { ok: true } : JSON.parse(JSON.stringify(r)));
    } catch (e) {
      this.save();
      if (quiet) return Promise.resolve(null);
      if (e instanceof EngineError) return Promise.reject(new ApiError(e.status, e.code, e.message));
      console.error(e);
      return Promise.reject(new ApiError(500, 'INTERNAL', 'Something went wrong'));
    }
  }
  as(fn) { return this.run(() => fn(this.actor)); }
  connect() {} disconnect() {}
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  publicConfig() { return Promise.resolve({ demo: true, standalone: true, mfaRequired: false, countries: COUNTRIES, defaultCountry: this.db.config.countryCode, simulatedLabel: SIMULATED_LABEL, demoCenter: DEMO_CENTER, radiusStagesKm: this.db.config.radiusStagesKm }); }
  meView(u) { return { id: u.id, displayName: u.displayName, email: u.email, role: u.role, countryCode: u.countryCode, hasPins: !!u.pins, hasDuressPin: !!u.pins?.duress, demo: true }; }
  me() { return this.run(() => { const a = this.actor; const u = a && this.engine.user(a.id); if (!u || u.status !== 'ACTIVE') throw new EngineError(401, 'UNAUTHENTICATED'); return { user: this.meView(u) }; }); }
  login(email) {
    return this.run(() => {
      const u = this.db.users.find((x) => x.email === String(email).toLowerCase() && x.status === 'ACTIVE');
      if (!u) throw new EngineError(401, 'INVALID_CREDENTIALS', 'Pick one of the demo accounts');
      sessionStorage.setItem('bb.actor', u.id);
      this.engine.audit(u.id, 'LOGIN', 'user', u.id, 'standalone demo');
      return { user: this.meView(u) };
    });
  }
  register(b) { return this.run(() => { if (!['user', 'volunteer'].includes(b.role)) throw new EngineError(400, 'INVALID_ROLE'); const u = this.engine.createUser({ displayName: b.displayName, email: b.email, role: b.role, demo: true, countryCode: b.countryCode }); sessionStorage.setItem('bb.actor', u.id); return { user: this.meView(u) }; }); }
  logout() { sessionStorage.removeItem('bb.actor'); return Promise.resolve({ ok: true }); }
  demoAccounts() { return this.run(() => ({ password: DEMO_PASSWORD, accounts: this.db.users.filter((u) => u.demo && u.status === 'ACTIVE').map((u) => ({ email: u.email, role: u.role, displayName: u.displayName })) })); }
  demoMfaCode() { return Promise.resolve({ code: null }); }
  setPins(b) { return this.as((a) => this.engine.setPins(a, b)); }
  myIncidents() { return this.as((a) => ({ items: this.engine.myIncidents(a) })); }
  exportData() { return this.as((a) => this.engine.exportMyData(a)); }
  deleteAccount() { return this.as((a) => { const r = this.engine.deleteMyAccount(a); sessionStorage.removeItem('bb.actor'); return r; }); }

  createIncident(b) { return this.as((a) => this.engine.createIncident(a, b)); }
  getIncident(id) { return this.as((a) => this.engine.viewIncident(a, id)); }
  addLocation(id, loc) { return this.as((a) => this.engine.addLocation(a, id, loc)); }
  cancel(id, b) { return this.as((a) => this.engine.cancelIncident(a, id, b)); }
  timeline(id) { return this.as((a) => ({ items: this.engine.timeline(a, id) })); }
  accept(id) { return this.as((a) => this.engine.acceptIncident(a, id)); }
  decline(id, b) { return this.as((a) => this.engine.declineIncident(a, id, b)); }
  safety(id, b) { return this.as((a) => this.engine.safetyConfirmation(a, id, b)); }
  escalate(id, b) { return this.as((a) => this.engine.requestEscalation(a, id, b)); }
  assignmentStatus(aid, b) { return this.as((a) => this.engine.updateAssignment(a, aid, b)); }
  reportAbuse(b) { return this.as((a) => this.engine.reportAbuse(a, b)); }

  volunteerProfile() { return this.as((a) => this.engine.volunteerProfile(a)); }
  setAvailability(b) { return this.as((a) => this.engine.setAvailability(a, b)); }
  completeTraining(moduleId) { return this.as((a) => this.engine.completeTraining(a, { moduleId })); }
  submitVerification(b) { return this.as((a) => this.engine.submitVerification(a, b)); }
  volunteerAlerts() { return this.as((a) => ({ items: this.engine.volunteerAlerts(a) })); }

  opIncidents(all) { return this.as((a) => ({ items: this.engine.operatorIncidents(a, { includeClosed: !!all }) })); }
  reassign(id, b) { return this.as((a) => this.engine.operatorReassign(a, id, b)); }
  handoff(id, b) { return this.as((a) => this.engine.operatorHandoff(a, id, b)); }
  closureException(id, b) { return this.as((a) => this.engine.operatorClosureException(a, id, b)); }
  adminConfig() { return this.as((a) => this.engine.getConfig(a)); }
  patchConfig(b) { return this.as((a) => this.engine.patchConfig(a, b)); }
  adminVolunteers() { return this.as((a) => ({ items: this.engine.listVolunteers(a) })); }
  reviewVolunteer(id, b) { return this.as((a) => this.engine.reviewVolunteer(a, id, b)); }
  abuseList() { return this.as((a) => ({ items: this.engine.listAbuse(a) })); }
  resolveAbuse(id, b) { return this.as((a) => this.engine.resolveAbuse(a, id, b)); }
  audit(limit = 100) { return this.as((a) => this.engine.auditEvents(a, { limit })); }
  integrations() { return this.as((a) => { this.engine.requireRole(a, 'admin', 'operator'); return { items: [
    { name: 'Emergency services', status: 'SIMULATED', note: SIMULATED_LABEL },
    { name: 'Backend', status: 'STANDALONE', note: 'Running in-browser. Timers stop when every tab is closed. Use the Node server for durable timers.' },
    { name: 'Identity verification', status: 'MOCK', note: 'No real ID collected.' },
  ] }; }); }

  demoAdvance(seconds) { return this.run(() => { this.db.demo.clockOffsetMs += seconds * 1000; refreshDemoVolunteers(this.engine); return { changed: this.engine.tick() }; }); }
  demoFail(count) { return this.run(() => { this.db.demo.failNextNotifications = count; return { pending: count }; }); }
  demoRelocate(lat, lng) { return this.run(() => { refreshDemoVolunteers(this.engine, { lat, lng }); }); }
  demoVolunteerAction(email, incidentId, action) {
    return this.run(() => {
      const v = this.db.users.find((u) => u.email === email && u.role === 'volunteer');
      if (!v) throw new EngineError(404, 'NOT_FOUND');
      const a = { id: v.id };
      if (action === 'ACCEPT') return this.engine.acceptIncident(a, incidentId);
      if (action === 'DECLINE') return this.engine.declineIncident(a, incidentId, { reason: 'demo' });
      const asg = this.db.assignments.find((x) => x.incidentId === incidentId && x.volunteerId === v.id && ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ASSISTING'].includes(x.status));
      if (!asg) throw new EngineError(409, 'NOT_ASSIGNED', 'That volunteer is not assigned');
      return this.engine.updateAssignment(a, asg.id, { status: action, reason: 'demo' });
    });
  }
  demoReset() { this.reset(); this.fanout(); return Promise.resolve({ ok: true }); }
}

export async function createApi() {
  let known = null;
  try { known = localStorage.getItem('bb.mode'); } catch {}
  try {
    const res = await fetch('api/v1/health', { cache: 'no-store' });
    if (res.ok && (res.headers.get('content-type') || '').includes('json')) {
      try { localStorage.setItem('bb.mode', 'server'); } catch {}
      return new ServerApi();
    }
  } catch {
    // Network failure on a real deployment must NOT silently drop into demo
    // mode — stay on the server API so the offline SOS queue is used.
    if (known === 'server') return new ServerApi();
  }
  return new StandaloneApi();
}
export { uuid };
