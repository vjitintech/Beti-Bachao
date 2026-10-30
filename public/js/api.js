// API client for the Beti Bachao server (/api/v1): real auth, SSE realtime,
// server-side timers. The app always talks to its own origin.
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

  savePushSubscription(sub) { return this.req('POST', '/me/push-subscriptions', sub); }
  staffList() { return this.req('GET', '/admin/staff'); }
  createStaff(b) { return this.req('POST', '/admin/staff', b); }
  setStaffStatus(id, status) { return this.req('POST', `/admin/staff/${id}/status`, { status }); }
}

export async function createApi() {
  const api = new ServerApi();
  try {
    const res = await fetch('api/v1/health', { cache: 'no-store' });
    api.unreachable = !(res.ok && (res.headers.get('content-type') || '').includes('json'));
  } catch { api.unreachable = true; }
  return api;
}
export { uuid };
