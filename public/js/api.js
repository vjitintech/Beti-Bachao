// API client for the Beti Bachao server (/api/v1): real auth, SSE realtime,
// server-side timers. The app always talks to its own origin.
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15); return (c === 'x' ? r : (r & 3) | 8).toString(16); }));

export class ApiError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }

// ------------------------------------------------------------------ server
import { isNative, native, serverUrl } from './native.js?v=mw85m40y';

class ServerApi {
  constructor() { this.mode = isNative ? 'app' : 'server'; this.listeners = new Set(); this.es = null; this.token = null; }
  base() { return isNative ? `${serverUrl()}/api/v1` : 'api/v1'; }
  async init() { if (isNative) this.token = await native.getToken(); }
  async setToken(t) { this.token = t || null; if (isNative) await native.setToken(this.token); }
  async req(method, path, body) {
    let res;
    const headers = { 'Content-Type': 'application/json', 'X-BB-CSRF': '1', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) };
    try {
      res = await fetch(this.base() + path, { method, credentials: isNative ? 'omit' : 'same-origin', headers, body: body ? JSON.stringify(body) : undefined });
    } catch { throw new ApiError(0, 'NETWORK', 'No connection'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && this.token && path !== '/auth/login') await this.setToken(null);
      throw new ApiError(res.status, data.error?.code || 'ERROR', data.error?.message || 'Request failed');
    }
    return data;
  }
  connect() {
    if (this.es) this.es.close();
    const url = this.base() + '/events' + (isNative && this.token ? `?access_token=${encodeURIComponent(this.token)}` : '');
    this.es = new EventSource(url);
    this.es.addEventListener('incident', (e) => { const d = JSON.parse(e.data); this.listeners.forEach((f) => f(d)); });
    this.es.addEventListener('hello', () => this.listeners.forEach((f) => f({ type: 'resync' })));
  }
  disconnect() { this.es?.close(); this.es = null; }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  publicConfig() { return this.req('GET', '/public-config'); }
  me() { return this.req('GET', '/me'); }
  async login(email, password, mfaCode) { const r = await this.req('POST', '/auth/login', { email, password, mfaCode, ...(isNative ? { client: 'mobile' } : {}) }); if (r.token) await this.setToken(r.token); return r; }
  async register(b) { const r = await this.req('POST', '/auth/register', { ...b, ...(isNative ? { client: 'mobile' } : {}) }); if (r.token) await this.setToken(r.token); return r; }
  async logout() { this.disconnect(); try { await this.req('POST', '/auth/logout'); } finally { await this.setToken(null); } }
  changePassword(b) { return this.req('POST', '/auth/change-password', b); }
  resetRequest(email) { return this.req('POST', '/auth/reset/request', { email }); }
  resetConfirm(b) { return this.req('POST', '/auth/reset/confirm', b); }
  getContacts() { return this.req('GET', '/me/contacts'); }
  saveContacts(b) { return this.req('PUT', '/me/contacts', b); }
  registerDevice(b) { return this.req('POST', '/me/devices', b); }
  rate(id, b) { return this.req('POST', `/incidents/${id}/rate`, b); }
  scheduleCall(id, scheduledAt) { return this.req('POST', `/admin/volunteers/${id}/schedule-call`, { scheduledAt }); }
  findUsers(q) { return this.req('GET', `/admin/users?q=${encodeURIComponent(q)}`); }
  resetUserPassword(id) { return this.req('POST', `/admin/users/${id}/reset-password`); }
  aiSummary(id) { return this.req('POST', `/operator/incidents/${id}/ai-summary`); }
  translate(text, target) { return this.req('POST', '/ai/translate', { text, target }); }
  setPins(b) { return this.req('PATCH', '/me/pins', b); }
  myIncidents() { return this.req('GET', '/me/incidents'); }
  exportData() { return this.req('GET', '/me/export'); }
  deleteAccount() { return this.req('DELETE', '/me'); }

  createIncident(b) { return this.req('POST', '/incidents', b); }
  getPlaces() { return this.req('GET', '/me/places'); }
  savePlaces(places) { return this.req('PUT', '/me/places', { places }); }
  myDashboard() { return this.req('GET', '/me/dashboard'); }
  nearby(loc) { return this.req('GET', `/help/nearby${loc ? `?lat=${loc.lat}&lng=${loc.lng}` : ''}`); }
  impact() { return this.req('GET', '/impact'); }
  myTrip() { return this.req('GET', '/me/trip'); }
  startTrip(b) { return this.req('POST', '/me/trip', b); }
  endTrip(b) { return this.req('POST', '/me/trip/end', b); }
  extendTrip(b) { return this.req('POST', '/me/trip/extend', b); }
  postLocation(loc) { return this.req('POST', '/me/location', loc); }
  uploadEvidence(id, b) { return this.req('POST', `/incidents/${id}/evidence`, b); }
  async evidenceBlob(id, eid) {
    const res = await fetch(`${this.base()}/incidents/${id}/evidence/${eid}`, { credentials: isNative ? 'omit' : 'same-origin', headers: this.token ? { Authorization: `Bearer ${this.token}` } : {} });
    if (!res.ok) throw new ApiError(res.status, 'EVIDENCE', 'Could not load recording');
    return res.blob();
  }
  opAck(id) { return this.req('POST', `/operator/incidents/${id}/ack`); }
  adminDashboard(days) { return this.req('GET', `/admin/dashboard?days=${days || 30}`); }
  stations() { return this.req('GET', '/admin/police-stations'); }
  importStations(b) { return this.req('POST', '/admin/police-stations', b); }
  deleteStation(id) { return this.req('DELETE', `/admin/police-stations/${id}`); }
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

  setup(b) { return this.req('POST', '/setup', b); }
  savePushSubscription(sub) { return this.req('POST', '/me/push-subscriptions', sub); }
  staffList() { return this.req('GET', '/admin/staff'); }
  createStaff(b) { return this.req('POST', '/admin/staff', b); }
  setStaffStatus(id, status) { return this.req('POST', `/admin/staff/${id}/status`, { status }); }
}

export async function createApi() {
  const api = new ServerApi();
  await api.init();
  try {
    const res = await fetch(api.base() + '/health', { cache: 'no-store' });
    api.unreachable = !(res.ok && (res.headers.get('content-type') || '').includes('json'));
  } catch { api.unreachable = true; }
  return api;
}
export { uuid };
