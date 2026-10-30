// Beti Bachao incident engine.
//
// Pure, storage-agnostic business logic shared by the Node server and the
// in-browser standalone demo. Every rule that keeps someone safe lives here so
// it is enforced identically everywhere and covered by tests:
//   • explicit server-side state machine with validated transitions
//   • idempotent SOS creation
//   • staged 10/20/30 km volunteer search with durable, persisted deadlines
//   • backup search continues after the first acceptance
//   • atomic assignment with a responder cap
//   • role-filtered views: unassigned volunteers never receive precise location
//   • arrival can never close an incident; only explicit YES or an audited
//     operator exception can
//   • duress PIN: looks cancelled to anyone watching, silently escalates
//   • escalation adapter is SIMULATED until a real integration is approved
//   • append-only, hash-chained audit log

import { haversineKm, isValidLatLng, approxPoint, distanceBand, approxEtaMinutes, impliedSpeedKmh, bearingDeg } from './geo.js?v=mvukvmhy';
import { DEFAULT_CONFIG, COUNTRIES, validateConfig } from './config.js?v=mvukvmhy';

export const S = Object.freeze({
  CREATED: 'CREATED',
  ALERTING_10KM: 'ALERTING_10KM',
  ALERTING_20KM: 'ALERTING_20KM',
  ALERTING_30KM: 'ALERTING_30KM',
  RESPONDER_ASSIGNED: 'RESPONDER_ASSIGNED',
  EN_ROUTE: 'EN_ROUTE',
  ARRIVED: 'ARRIVED',
  ASSISTANCE_IN_PROGRESS: 'ASSISTANCE_IN_PROGRESS',
  ESCALATION_REQUIRED: 'ESCALATION_REQUIRED',
  NO_RESPONDER_AVAILABLE: 'NO_RESPONDER_AVAILABLE',
  EMERGENCY_HANDOFF: 'EMERGENCY_HANDOFF',
  USER_CANCELLED: 'USER_CANCELLED',
  RESPONDER_CANCELLED: 'RESPONDER_CANCELLED',
  LOCATION_UNAVAILABLE: 'LOCATION_UNAVAILABLE',
  SAFE_CONFIRMED: 'SAFE_CONFIRMED',
  CLOSED: 'CLOSED',
  FALSE_ALARM_REVIEW: 'FALSE_ALARM_REVIEW',
});

const ALERTING = [S.ALERTING_10KM, S.ALERTING_20KM, S.ALERTING_30KM];
const PROGRESS = [S.RESPONDER_ASSIGNED, S.EN_ROUTE, S.ARRIVED, S.ASSISTANCE_IN_PROGRESS];
const TERMINAL = new Set([S.CLOSED, S.USER_CANCELLED, S.FALSE_ALARM_REVIEW]);
const ALWAYS = [S.ESCALATION_REQUIRED, S.EMERGENCY_HANDOFF, S.USER_CANCELLED, S.SAFE_CONFIRMED];

// Allowed transitions. Anything not listed is rejected with 409.
export const TRANSITIONS = {
  [S.CREATED]: [S.ALERTING_10KM, S.LOCATION_UNAVAILABLE, ...ALWAYS],
  [S.LOCATION_UNAVAILABLE]: [S.ALERTING_10KM, ...ALWAYS],
  [S.ALERTING_10KM]: [S.ALERTING_20KM, S.RESPONDER_ASSIGNED, ...ALWAYS],
  [S.ALERTING_20KM]: [S.ALERTING_30KM, S.RESPONDER_ASSIGNED, ...ALWAYS],
  [S.ALERTING_30KM]: [S.NO_RESPONDER_AVAILABLE, S.RESPONDER_ASSIGNED, ...ALWAYS],
  [S.NO_RESPONDER_AVAILABLE]: [S.RESPONDER_ASSIGNED, ...ALWAYS],
  [S.RESPONDER_ASSIGNED]: [S.EN_ROUTE, S.ARRIVED, S.RESPONDER_CANCELLED, ...ALWAYS],
  [S.EN_ROUTE]: [S.ARRIVED, S.RESPONDER_ASSIGNED, S.RESPONDER_CANCELLED, ...ALWAYS],
  [S.ARRIVED]: [S.ASSISTANCE_IN_PROGRESS, S.EN_ROUTE, S.RESPONDER_ASSIGNED, S.RESPONDER_CANCELLED, ...ALWAYS],
  [S.ASSISTANCE_IN_PROGRESS]: [S.ARRIVED, S.EN_ROUTE, S.RESPONDER_ASSIGNED, S.RESPONDER_CANCELLED, ...ALWAYS],
  [S.RESPONDER_CANCELLED]: [...ALERTING, ...PROGRESS, S.NO_RESPONDER_AVAILABLE, ...ALWAYS],
  [S.ESCALATION_REQUIRED]: [...ALERTING, ...PROGRESS, S.NO_RESPONDER_AVAILABLE, S.RESPONDER_CANCELLED, S.EMERGENCY_HANDOFF, S.USER_CANCELLED, S.SAFE_CONFIRMED, S.CLOSED],
  [S.EMERGENCY_HANDOFF]: [...PROGRESS, S.RESPONDER_CANCELLED, S.ESCALATION_REQUIRED, S.USER_CANCELLED, S.SAFE_CONFIRMED, S.CLOSED],
  [S.SAFE_CONFIRMED]: [S.CLOSED],
  [S.USER_CANCELLED]: [S.FALSE_ALARM_REVIEW, S.ESCALATION_REQUIRED],
  [S.FALSE_ALARM_REVIEW]: [S.CLOSED],
  [S.CLOSED]: [],
};
// Operator closure exception may close any open incident (documented reason + audit).
const OPERATOR_CLOSURE_REASONS = [
  'HANDED_TO_EMERGENCY_SERVICES_CONFIRMED_SAFE',
  'USER_UNREACHABLE_EMERGENCY_SERVICES_IN_CHARGE',
  'DUPLICATE_INCIDENT',
  'VERIFIED_FALSE_ALARM',
];

export const ESC = Object.freeze({ NONE: 'NONE', REQUIRED: 'REQUIRED', SIMULATED: 'SIMULATED', ATTEMPTED: 'ATTEMPTED', DELIVERED: 'DELIVERED', ACKNOWLEDGED: 'ACKNOWLEDGED', FAILED: 'FAILED' });
// Escalations go to Beti Bachao operators (push + console). Police/ambulance are
// never contacted automatically: an operator calls them and records it as a handoff.
export const ESCALATION_LABEL = 'Operators alerted — police/ambulance NOT contacted automatically. Call 112.';
export const SIMULATED_LABEL = ESCALATION_LABEL; // backwards-compatible name

const ASG_ORDER = ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ASSISTING'];
const ASG_TO_INCIDENT = { ACCEPTED: S.RESPONDER_ASSIGNED, EN_ROUTE: S.EN_ROUTE, ARRIVED: S.ARRIVED, ASSISTING: S.ASSISTANCE_IN_PROGRESS };
const ACTIVE_ASG = new Set(ASG_ORDER);

export const TRAINING_MODULES = [
  { id: 'code-of-conduct', title: 'Volunteer Code of Conduct (no vigilantism, consent first)' },
  { id: 'de-escalation', title: 'De-escalation and personal safety' },
  { id: 'emergency-calling', title: 'When and how to call emergency services' },
  { id: 'privacy', title: 'Privacy: never share location, screenshots or identity' },
  { id: 'safe-handover', title: 'Safe public locations, handover and closure' },
];

export class EngineError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const fail = (status, code, msg) => { throw new EngineError(status, code, msg); };

export function emptyDb() {
  return {
    schemaVersion: 1,
    config: { ...DEFAULT_CONFIG },
    users: [],
    volunteers: [],
    verifications: [],
    incidents: [],
    locations: [],
    assignments: [],
    responderLocations: [],
    notifications: [],
    escalations: [],
    confirmations: [],
    transitions: [],
    abuseReports: [],
    audit: [],
    events: [],
    eventSeq: 0,
    demo: { clockOffsetMs: 0, failNextNotifications: 0 },
  };
}

export class Engine {
  /**
   * @param {object} db   mutable data object (see emptyDb)
   * @param {object} deps { uuid(), hash(str) -> hex, now() -> ms, hashSecret(secret, salt) -> hex, notify?(n) -> {ok} }
   */
  constructor(db, deps) {
    this.db = db;
    this.deps = deps;
  }

  // ---------- basics ----------
  now() { return this.deps.now() + (this.db.demo?.clockOffsetMs || 0); }
  iso(ms = this.now()) { return new Date(ms).toISOString(); }
  get cfg() { return this.db.config; }
  user(id) { return this.db.users.find((u) => u.id === id); }
  vol(userId) { return this.db.volunteers.find((v) => v.userId === userId); }
  incident(id) {
    const inc = this.db.incidents.find((i) => i.id === id);
    if (!inc) fail(404, 'NOT_FOUND', 'Incident not found');
    return inc;
  }
  isOpen(inc) { return !TERMINAL.has(inc.status) && inc.status !== S.SAFE_CONFIRMED; }
  activeAssignments(incId) { return this.db.assignments.filter((a) => a.incidentId === incId && ACTIVE_ASG.has(a.status)); }
  latestLocation(incId, { includeSuspect = false } = {}) {
    let best = null;
    for (const l of this.db.locations) {
      if (l.incidentId !== incId || (!includeSuspect && l.suspect)) continue;
      if (!best || l.observedAt > best.observedAt) best = l;
    }
    return best;
  }

  requireRole(actor, ...roles) {
    if (!actor) fail(401, 'UNAUTHENTICATED', 'Login required');
    const u = this.user(actor.id);
    if (!u || u.status !== 'ACTIVE') fail(403, 'ACCOUNT_INACTIVE', 'Account is not active');
    if (!roles.includes(u.role)) {
      this.audit(actor.id, 'ACCESS_DENIED', 'role', u.role, `requires ${roles.join('|')}`);
      fail(403, 'FORBIDDEN', 'You do not have permission for this action');
    }
    return u;
  }

  emit(type, incidentId, audience = null) {
    this.db.eventSeq += 1;
    const ev = { seq: this.db.eventSeq, event_id: this.deps.uuid(), schema_version: 1, type, incident_id: incidentId, timestamp: this.iso(), audience };
    this.db.events.push(ev);
    if (this.db.events.length > 2000) this.db.events.splice(0, this.db.events.length - 2000);
    return ev;
  }

  audit(actorId, action, entityType, entityId, reason = null, meta = null) {
    const prev = this.db.audit[this.db.audit.length - 1];
    const body = { id: this.deps.uuid(), actorId: actorId || 'system', action, entityType, entityId, timestamp: this.iso(), reason, meta };
    body.prevHash = prev ? prev.hash : 'GENESIS';
    body.hash = this.deps.hash(body.prevHash + JSON.stringify([body.id, body.actorId, body.action, body.entityType, body.entityId, body.timestamp, body.reason, body.meta]));
    this.db.audit.push(body);
    return body;
  }

  verifyAuditChain() {
    let prevHash = 'GENESIS';
    for (const a of this.db.audit) {
      const h = this.deps.hash(prevHash + JSON.stringify([a.id, a.actorId, a.action, a.entityType, a.entityId, a.timestamp, a.reason, a.meta]));
      if (a.prevHash !== prevHash || a.hash !== h) return { ok: false, brokenAt: a.id };
      prevHash = a.hash;
    }
    return { ok: true, length: this.db.audit.length };
  }

  transition(inc, to, actorId, reason, source = 'api') {
    if (inc.status === to) return false;
    const allowed = TRANSITIONS[inc.status] || [];
    if (!allowed.includes(to)) {
      this.audit(actorId, 'TRANSITION_REJECTED', 'incident', inc.id, `${inc.status} → ${to}`);
      fail(409, 'INVALID_TRANSITION', `Cannot move incident from ${inc.status} to ${to}`);
    }
    const from = inc.status;
    inc.status = to;
    inc.updatedAt = this.iso();
    this.db.transitions.push({ id: this.deps.uuid(), incidentId: inc.id, from, to, actorId: actorId || 'system', at: inc.updatedAt, reason, source });
    this.audit(actorId, 'INCIDENT_TRANSITION', 'incident', inc.id, reason, { from, to, source });
    this.emit('incident.status_changed', inc.id);
    return true;
  }

  // ---------- accounts ----------
  createUser({ displayName, email, role, passwordHash = null, mfaSecret = null, status = 'ACTIVE', countryCode = null, demo = false }) {
    if (!['user', 'volunteer', 'operator', 'admin'].includes(role)) fail(400, 'INVALID_ROLE');
    const em = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) fail(400, 'INVALID_EMAIL', 'A valid email is required');
    if (this.db.users.some((u) => u.email === em)) fail(409, 'EMAIL_TAKEN', 'An account with this email exists');
    const name = String(displayName || '').trim().slice(0, 60);
    if (!name) fail(400, 'INVALID_NAME', 'Display name is required');
    const u = { id: this.deps.uuid(), displayName: name, email: em, role, passwordHash, mfaSecret, status, countryCode, demo, pins: null, createdAt: this.iso(), updatedAt: this.iso() };
    this.db.users.push(u);
    if (role === 'volunteer') {
      this.db.volunteers.push({ userId: u.id, available: false, trainingCompleted: [], verificationStatus: 'NOT_STARTED', verificationExpiresAt: null, capabilities: ['escort', 'first-aid-basic'], lastLocation: null, lastLocationAt: null, noShowCount: 0, suspendedReason: null });
    }
    this.audit(u.id, 'USER_CREATED', 'user', u.id, null, { role });
    return u;
  }

  setPins(actor, { cancelPin, duressPin }) {
    const u = this.requireRole(actor, 'user');
    const ok = (p) => typeof p === 'string' && /^\d{4,6}$/.test(p);
    if (!ok(cancelPin)) fail(400, 'INVALID_PIN', 'Cancel PIN must be 4–6 digits');
    if (duressPin != null && duressPin !== '' && !ok(duressPin)) fail(400, 'INVALID_PIN', 'Duress PIN must be 4–6 digits');
    if (duressPin && duressPin === cancelPin) fail(400, 'PINS_MATCH', 'Duress PIN must differ from cancel PIN');
    const salt = this.deps.uuid();
    u.pins = { salt, cancel: this.deps.hashSecret(cancelPin, salt), duress: duressPin ? this.deps.hashSecret(duressPin, salt) : null };
    this.audit(u.id, 'PINS_UPDATED', 'user', u.id);
    return { ok: true, hasDuress: !!duressPin };
  }

  // ---------- volunteers ----------
  volunteerEligibility(v, now = this.now()) {
    const u = this.user(v.userId);
    const reasons = [];
    if (!u || u.status !== 'ACTIVE') reasons.push('account inactive');
    if (v.suspendedReason) reasons.push('suspended');
    if (v.verificationStatus !== 'VERIFIED') reasons.push('not verified');
    else if (v.verificationExpiresAt && Date.parse(v.verificationExpiresAt) < now) reasons.push('verification expired');
    if (TRAINING_MODULES.some((m) => !v.trainingCompleted.includes(m.id))) reasons.push('training incomplete');
    if (!v.available) reasons.push('unavailable');
    if (!v.lastLocation || !v.lastLocationAt || now - Date.parse(v.lastLocationAt) > this.cfg.volunteerLocationMaxAgeMin * 60000) reasons.push('location stale');
    if (this.db.assignments.some((a) => a.volunteerId === v.userId && ACTIVE_ASG.has(a.status))) reasons.push('busy on another incident');
    return { eligible: reasons.length === 0, reasons };
  }

  volunteerProfile(actor) {
    this.requireRole(actor, 'volunteer');
    const v = this.vol(actor.id);
    return { ...v, eligibility: this.volunteerEligibility(v), trainingModules: TRAINING_MODULES };
  }

  setAvailability(actor, { available, location }) {
    this.requireRole(actor, 'volunteer');
    const v = this.vol(actor.id);
    if (typeof available === 'boolean') v.available = available;
    if (location) {
      if (!isValidLatLng(location.lat, location.lng)) fail(400, 'INVALID_LOCATION');
      v.lastLocation = { lat: location.lat, lng: location.lng, accuracyM: location.accuracyM ?? null };
      v.lastLocationAt = this.iso();
    }
    this.audit(actor.id, 'VOLUNTEER_AVAILABILITY', 'volunteer', actor.id, null, { available: v.available });
    return this.volunteerProfile(actor);
  }

  completeTraining(actor, { moduleId }) {
    this.requireRole(actor, 'volunteer');
    const v = this.vol(actor.id);
    if (!TRAINING_MODULES.some((m) => m.id === moduleId)) fail(400, 'UNKNOWN_MODULE');
    if (!v.trainingCompleted.includes(moduleId)) v.trainingCompleted.push(moduleId);
    this.audit(actor.id, 'TRAINING_COMPLETED', 'volunteer', actor.id, moduleId);
    return this.volunteerProfile(actor);
  }

  // Manual verification request: the trust team calls the volunteer, checks ID on a
  // video call / in person and approves. Raw ID images are never accepted or stored.
  submitVerification(actor, { contactPhone, area } = {}) {
    this.requireRole(actor, 'volunteer');
    const v = this.vol(actor.id);
    if (v.verificationStatus === 'VERIFIED') fail(409, 'ALREADY_VERIFIED');
    const phone = String(contactPhone || '').replace(/[^\d+]/g, '');
    if (phone.replace(/\D/g, '').length < 8 || phone.length > 16) fail(400, 'INVALID_PHONE', 'A valid phone number is required');
    const rec = { id: this.deps.uuid(), volunteerId: actor.id, provider: 'MANUAL_REVIEW', status: 'PENDING', referenceToken: 'req_' + this.deps.uuid().slice(0, 8), contactPhone: phone, area: String(area || '').slice(0, 60), submittedAt: this.iso(), reviewedAt: null, expiresAt: null };
    this.db.verifications.push(rec);
    v.verificationStatus = 'PENDING';
    this.audit(actor.id, 'VERIFICATION_SUBMITTED', 'volunteer', actor.id);
    return rec;
  }

  // ---------- incidents ----------
  createIncident(actor, { idempotencyKey, location = null, severity = 'NORMAL', trigger = 'button', silent = false, battery = null, note = null } = {}) {
    const u = this.requireRole(actor, 'user');
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.length > 100) fail(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const dup = this.db.incidents.find((i) => i.requesterId === u.id && i.idempotencyKey === idempotencyKey);
    if (dup) return { incident: dup, duplicate: true };
    const open = this.db.incidents.find((i) => i.requesterId === u.id && this.isOpen(i));
    if (open) {
      if (open.duress) { open.duress = false; this.audit(u.id, 'DURESS_INCIDENT_RESUMED', 'incident', open.id); }
      if (location) this.addLocation(actor, open.id, location);
      return { incident: open, duplicate: true };
    }
    const hourAgo = this.now() - 3600000;
    if (this.db.incidents.filter((i) => i.requesterId === u.id && Date.parse(i.createdAt) > hourAgo).length >= this.cfg.sosPerHourLimit) {
      this.audit(u.id, 'SOS_RATE_LIMITED', 'user', u.id);
      fail(429, 'RATE_LIMITED', 'Too many SOS requests. Call your local emergency number directly.');
    }
    const sev = severity === 'HIGH' ? 'HIGH' : 'NORMAL';
    const inc = {
      id: this.deps.uuid(), requesterId: u.id, status: S.CREATED, searchStage: null, stageStartedAt: null, stageDeadline: null,
      severity: sev, trigger: String(trigger).slice(0, 20), silent: !!silent, escalationStatus: ESC.NONE, idempotencyKey,
      countryCode: u.countryCode || this.cfg.countryCode, battery: sanitizeBattery(battery), note: note ? String(note).slice(0, 280) : null,
      duress: false, flags: [], createdAt: this.iso(), updatedAt: this.iso(), closedAt: null, safeConfirmedAt: null, closureReason: null,
    };
    this.db.incidents.push(inc);
    this.db.transitions.push({ id: this.deps.uuid(), incidentId: inc.id, from: null, to: S.CREATED, actorId: u.id, at: inc.createdAt, reason: `SOS via ${inc.trigger}`, source: 'api' });
    this.audit(u.id, 'SOS_CREATED', 'incident', inc.id, null, { severity: sev, trigger: inc.trigger });
    this.emit('incident.created', inc.id);

    // Immediate danger never waits for the volunteer search.
    if (sev === 'HIGH') this.escalate(inc, u.id, 'IMMEDIATE_DANGER', 'User reported immediate danger at SOS time');

    if (location) {
      this.recordLocation(inc, u.id, location);
    }
    if (this.latestLocation(inc.id)) this.startStage(inc, 0, u.id, 'Location received');
    else {
      this.transition(inc, S.LOCATION_UNAVAILABLE, u.id, 'No usable location yet', 'system');
      this.escalate(inc, 'system', 'LOCATION_UNAVAILABLE', 'Volunteers cannot be matched without location');
    }
    return { incident: inc, duplicate: false };
  }

  recordLocation(inc, actorId, loc) {
    if (!loc || !isValidLatLng(loc.lat, loc.lng)) fail(400, 'INVALID_LOCATION', 'Latitude/longitude out of range');
    const acc = Number(loc.accuracyM);
    if (!Number.isFinite(acc) || acc < 0 || acc > 100000) fail(400, 'INVALID_ACCURACY', 'Horizontal accuracy (m) required');
    const observedAt = loc.observedAt && !Number.isNaN(Date.parse(loc.observedAt)) ? new Date(Math.min(Date.parse(loc.observedAt), this.now())).toISOString() : this.iso();
    const obs = {
      id: this.deps.uuid(), incidentId: inc.id, lat: loc.lat, lng: loc.lng, accuracyM: Math.round(acc),
      altitudeM: Number.isFinite(loc.altitudeM) ? loc.altitudeM : null,
      verticalAccuracyM: Number.isFinite(loc.verticalAccuracyM) ? loc.verticalAccuracyM : null,
      floor: Number.isInteger(loc.userFloor) ? { value: loc.userFloor, source: 'USER_PROVIDED' } : null,
      source: ['gps', 'network', 'manual', 'synthetic', 'unknown'].includes(loc.source) ? loc.source : 'unknown',
      observedAt, receivedAt: this.iso(), suspect: false, suspectReason: null,
    };
    const prev = this.latestLocation(inc.id);
    if (prev) {
      const speed = impliedSpeedKmh(prev, obs);
      // Ignore jitter inside the combined uncertainty circles (+200 m margin).
      const jumpM = haversineKm(prev, obs) * 1000;
      if (jumpM > prev.accuracyM + obs.accuracyM + 200 && speed > this.cfg.maxPlausibleSpeedKmh) { obs.suspect = true; obs.suspectReason = `implied speed ${Math.round(speed)} km/h`; }
    }
    this.db.locations.push(obs);
    this.audit(actorId, obs.suspect ? 'LOCATION_SUSPECT' : 'LOCATION_RECORDED', 'incident', inc.id, obs.suspectReason, { accuracyM: obs.accuracyM, source: obs.source });
    this.emit('location.updated', inc.id);
    return obs;
  }

  addLocation(actor, incidentId, loc) {
    const u = this.requireRole(actor, 'user');
    const inc = this.incident(incidentId);
    if (inc.requesterId !== u.id) fail(403, 'FORBIDDEN');
    if (!this.isOpen(inc)) fail(409, 'INCIDENT_CLOSED');
    const obs = this.recordLocation(inc, u.id, loc);
    if (inc.status === S.LOCATION_UNAVAILABLE && !obs.suspect) this.startStage(inc, 0, u.id, 'Location now available');
    return obs;
  }

  stageTimeouts(inc) { return inc.severity === 'HIGH' ? this.cfg.highSeverityStageTimeoutsSec : this.cfg.stageTimeoutsSec; }

  startStage(inc, idx, actorId, reason) {
    inc.searchStage = idx;
    inc.stageStartedAt = this.iso();
    inc.stageDeadline = this.iso(this.now() + this.stageTimeouts(inc)[idx] * 1000);
    if (this.activeAssignments(inc.id).length === 0) this.transition(inc, ALERTING[idx], actorId, reason, 'system');
    this.emit('search_stage.changed', inc.id);
    this.alertVolunteers(inc);
  }

  alertVolunteers(inc) {
    const loc = this.latestLocation(inc.id);
    if (!loc || inc.searchStage == null) return 0;
    const radius = this.cfg.radiusStagesKm[inc.searchStage];
    let n = 0;
    for (const v of this.db.volunteers) {
      if (v.userId === inc.requesterId) continue;
      if (!this.volunteerEligibility(v).eligible) continue;
      const d = haversineKm(loc, v.lastLocation);
      if (d > radius) continue;
      if (this.db.notifications.some((x) => x.incidentId === inc.id && x.recipientId === v.userId && x.kind === 'ALERT')) continue;
      this.notify(inc.id, v.userId, 'ALERT', { stage: inc.searchStage, distanceKm: +d.toFixed(2) });
      n++;
    }
    if (n) this.emit('volunteer.alerted', inc.id);
    return n;
  }

  notify(incidentId, recipientId, kind, meta = {}) {
    const n = { id: this.deps.uuid(), incidentId, recipientId, kind, channel: 'in_app', status: 'PENDING', attemptCount: 0, createdAt: this.iso(), acknowledgedAt: null, respondedAt: null, response: null, providerReference: null, meta };
    this.db.notifications.push(n);
    this.deliver(n);
    return n;
  }

  // Notification adapter with failure injection and fallback attempt.
  deliver(n) {
    n.attemptCount += 1;
    let ok = true;
    if (this.db.demo.failNextNotifications > 0) { this.db.demo.failNextNotifications -= 1; ok = false; }
    else if (this.deps.notify) ok = this.deps.notify(n)?.ok !== false;
    if (ok) { n.status = 'DELIVERED'; n.providerReference = n.channel + ':' + n.id.slice(0, 8); return true; }
    n.status = 'FAILED';
    this.audit('system', 'NOTIFICATION_FAILED', 'notification', n.id, `channel ${n.channel}`, { incidentId: n.incidentId });
    if (n.attemptCount < 2) {
      n.channel = 'in_app_fallback';
      this.audit('system', 'NOTIFICATION_FALLBACK', 'notification', n.id, 'retrying via fallback channel');
      return this.deliver(n);
    }
    return false;
  }

  escalate(inc, actorId, type, reason) {
    const ev = { id: this.deps.uuid(), incidentId: inc.id, type, status: ESC.REQUIRED, label: ESCALATION_LABEL, reason, attemptedAt: this.iso(), acknowledgedAt: null, recordedBy: actorId || 'system', metadata: { channel: 'operators', country: inc.countryCode, emergencyNumber: COUNTRIES[inc.countryCode]?.emergency || null } };
    this.db.escalations.push(ev);
    if (![ESC.ATTEMPTED, ESC.DELIVERED, ESC.ACKNOWLEDGED].includes(inc.escalationStatus)) inc.escalationStatus = ESC.REQUIRED;
    for (const op of this.db.users.filter((u) => ['operator', 'admin'].includes(u.role) && u.status === 'ACTIVE')) this.notify(inc.id, op.id, 'ESCALATION', { type });
    inc.updatedAt = this.iso();
    this.audit(actorId, 'ESCALATION_RAISED', 'incident', inc.id, reason, { type });
    this.emit('escalation.attempted', inc.id);
    return ev;
  }

  // ---------- volunteer response ----------
  acceptIncident(actor, incidentId) {
    this.requireRole(actor, 'volunteer');
    const inc = this.incident(incidentId);
    const alert = this.db.notifications.find((n) => n.incidentId === inc.id && n.recipientId === actor.id && n.kind === 'ALERT');
    if (!alert) { this.audit(actor.id, 'ACCEPT_DENIED_NOT_ALERTED', 'incident', inc.id); fail(403, 'NOT_ALERTED', 'You were not alerted for this incident'); }
    if (!this.isOpen(inc)) fail(409, 'INCIDENT_CLOSED', 'This incident is no longer active');
    const existing = this.db.assignments.find((a) => a.incidentId === inc.id && a.volunteerId === actor.id && ACTIVE_ASG.has(a.status));
    if (existing) return { assignment: existing, duplicate: true };
    const v = this.vol(actor.id);
    const elig = this.volunteerEligibility(v);
    if (!elig.eligible) fail(409, 'NOT_ELIGIBLE', 'Not eligible: ' + elig.reasons.join(', '));
    // The JS event loop makes this check-and-insert atomic within one process.
    const active = this.activeAssignments(inc.id);
    if (active.length >= this.cfg.maxResponders) {
      alert.response = 'TOO_LATE'; alert.respondedAt = this.iso();
      this.audit(actor.id, 'ACCEPT_REJECTED_CAP', 'incident', inc.id);
      fail(409, 'RESPONDERS_FULL', 'Enough responders are already assigned. Thank you — please stay available.');
    }
    const loc = this.latestLocation(inc.id);
    const distKm = loc ? haversineKm(loc, v.lastLocation) : null;
    const a = { id: this.deps.uuid(), incidentId: inc.id, volunteerId: actor.id, status: 'ACCEPTED', role: active.length === 0 ? 'PRIMARY' : 'BACKUP', acceptedAt: this.iso(), enRouteAt: null, arrivedAt: null, assistingAt: null, completedAt: null, cancelledAt: null, cancellationReason: null, distanceKmAtAccept: distKm != null ? +distKm.toFixed(2) : null, etaMinAtAccept: approxEtaMinutes(distKm, this.cfg), stallFlagged: false };
    this.db.assignments.push(a);
    this.db.responderLocations.push({ id: this.deps.uuid(), assignmentId: a.id, lat: v.lastLocation.lat, lng: v.lastLocation.lng, accuracyM: v.lastLocation.accuracyM ?? null, observedAt: this.iso() });
    alert.response = 'ACCEPTED'; alert.respondedAt = this.iso();
    this.audit(actor.id, 'VOLUNTEER_ACCEPTED', 'incident', inc.id, null, { assignmentId: a.id, role: a.role });
    this.emit('volunteer.accepted', inc.id);
    this.notify(inc.id, inc.requesterId, 'RESPONDER_ACCEPTED', { etaMin: a.etaMinAtAccept });
    this.syncProgress(inc, actor.id);
    return { assignment: a, duplicate: false };
  }

  declineIncident(actor, incidentId, { reason } = {}) {
    this.requireRole(actor, 'volunteer');
    const inc = this.incident(incidentId);
    const alert = this.db.notifications.find((n) => n.incidentId === inc.id && n.recipientId === actor.id && n.kind === 'ALERT');
    if (!alert) fail(403, 'NOT_ALERTED');
    alert.response = 'DECLINED'; alert.respondedAt = this.iso();
    this.audit(actor.id, 'VOLUNTEER_DECLINED', 'incident', inc.id, reason ? String(reason).slice(0, 120) : null);
    return { ok: true };
  }

  updateAssignment(actor, assignmentId, { status, reason, location } = {}) {
    this.requireRole(actor, 'volunteer');
    const a = this.db.assignments.find((x) => x.id === assignmentId);
    if (!a) fail(404, 'NOT_FOUND');
    if (a.volunteerId !== actor.id) { this.audit(actor.id, 'ASSIGNMENT_ACCESS_DENIED', 'assignment', a.id); fail(403, 'FORBIDDEN'); }
    const inc = this.incident(a.incidentId);
    if (!ACTIVE_ASG.has(a.status)) fail(409, 'ASSIGNMENT_INACTIVE', 'This assignment has ended');
    if (location) this.updateResponderLocation(actor, a.id, location);
    if (!status) return a;
    if (status === 'UNABLE') {
      a.status = 'CANCELLED'; a.cancelledAt = this.iso(); a.cancellationReason = String(reason || 'unable to respond').slice(0, 160);
      this.audit(actor.id, 'RESPONDER_UNABLE', 'assignment', a.id, a.cancellationReason);
      this.emit('responder.status_changed', inc.id);
      this.onResponderLost(inc, actor.id, 'Responder reported unable to continue');
      return a;
    }
    const from = ASG_ORDER.indexOf(a.status), to = ASG_ORDER.indexOf(status);
    if (to < 0) fail(400, 'INVALID_STATUS');
    if (to !== from + 1 && !(status === 'ARRIVED' && a.status === 'ACCEPTED')) fail(409, 'INVALID_TRANSITION', `Cannot go from ${a.status} to ${status}`);
    if (!this.isOpen(inc)) fail(409, 'INCIDENT_CLOSED');
    a.status = status;
    const key = { EN_ROUTE: 'enRouteAt', ARRIVED: 'arrivedAt', ASSISTING: 'assistingAt' }[status];
    a[key] = this.iso();
    a.stallFlagged = false;
    this.audit(actor.id, 'RESPONDER_STATUS', 'assignment', a.id, status, { incidentId: inc.id });
    this.emit('responder.status_changed', inc.id);
    if (status === 'ARRIVED') this.notify(inc.id, inc.requesterId, 'RESPONDER_ARRIVED');
    this.syncProgress(inc, actor.id);
    return a;
  }

  updateResponderLocation(actor, assignmentId, loc) {
    const a = this.db.assignments.find((x) => x.id === assignmentId);
    if (!a || a.volunteerId !== actor.id) fail(403, 'FORBIDDEN');
    if (!isValidLatLng(loc.lat, loc.lng)) fail(400, 'INVALID_LOCATION');
    this.db.responderLocations.push({ id: this.deps.uuid(), assignmentId: a.id, lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM ?? null, observedAt: this.iso() });
    const v = this.vol(actor.id);
    v.lastLocation = { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM ?? null }; v.lastLocationAt = this.iso();
    this.emit('responder.location_updated', a.incidentId);
    return { ok: true };
  }

  // Incident status follows the most advanced active responder (unless escalated/handed off).
  syncProgress(inc, actorId) {
    if (!this.isOpen(inc)) return;
    const active = this.activeAssignments(inc.id);
    if (!active.length) return;
    const best = Math.max(...active.map((a) => ASG_ORDER.indexOf(a.status)));
    const target = ASG_TO_INCIDENT[ASG_ORDER[best]];
    if ([S.ESCALATION_REQUIRED, S.EMERGENCY_HANDOFF].includes(inc.status) && best === 0) return;
    if (inc.status !== target) this.transition(inc, target, actorId, 'Responder progress', 'system');
  }

  onResponderLost(inc, actorId, reason) {
    if (!this.isOpen(inc)) return;
    if (this.activeAssignments(inc.id).length) { this.syncProgress(inc, actorId); this.alertVolunteers(inc); return; }
    if (![S.ESCALATION_REQUIRED, S.EMERGENCY_HANDOFF].includes(inc.status)) this.transition(inc, S.RESPONDER_CANCELLED, actorId, reason, 'system');
    // Replacement search: restart at current stage with a fresh deadline.
    const idx = inc.searchStage ?? 0;
    inc.stageStartedAt = this.iso();
    inc.stageDeadline = this.iso(this.now() + this.stageTimeouts(inc)[idx] * 1000);
    if (inc.status === S.RESPONDER_CANCELLED) this.transition(inc, ALERTING[idx], 'system', 'Replacement search', 'system');
    this.alertVolunteers(inc);
    this.notify(inc.id, inc.requesterId, 'RESPONDER_LOST');
  }

  // ---------- user actions ----------
  cancelIncident(actor, incidentId, { pin, confirm } = {}) {
    const u = this.requireRole(actor, 'user');
    const inc = this.incident(incidentId);
    if (inc.requesterId !== u.id) fail(403, 'FORBIDDEN');
    if (!this.isOpen(inc)) fail(409, 'INCIDENT_CLOSED');
    if (u.pins) {
      const h = this.deps.hashSecret(String(pin || ''), u.pins.salt);
      if (u.pins.duress && h === u.pins.duress) {
        // Duress: appear cancelled, silently escalate and keep responders coming.
        inc.duress = true;
        if (inc.status !== S.ESCALATION_REQUIRED) this.transition(inc, S.ESCALATION_REQUIRED, u.id, 'Duress PIN entered', 'api');
        this.escalate(inc, u.id, 'DURESS', 'Duress PIN used to "cancel" — treat as active danger');
        this.audit(u.id, 'DURESS_PIN_USED', 'incident', inc.id);
        return { ok: true, status: S.USER_CANCELLED };
      }
      if (h !== u.pins.cancel) { this.audit(u.id, 'CANCEL_PIN_WRONG', 'incident', inc.id); fail(403, 'WRONG_PIN', 'Incorrect PIN'); }
    } else if (confirm !== true) fail(400, 'CONFIRM_REQUIRED', 'Confirm cancellation');
    this.transition(inc, S.USER_CANCELLED, u.id, 'User cancelled (accidental SOS)', 'api');
    inc.closedAt = this.iso(); inc.closureReason = 'USER_CANCELLED';
    for (const a of this.activeAssignments(inc.id)) { a.status = 'CANCELLED'; a.cancelledAt = this.iso(); a.cancellationReason = 'incident cancelled by user'; this.notify(inc.id, a.volunteerId, 'INCIDENT_CANCELLED'); }
    this.emit('incident.closed', inc.id);
    return { ok: true, status: S.USER_CANCELLED };
  }

  safetyConfirmation(actor, incidentId, { response, confirm } = {}) {
    const u = this.requireRole(actor, 'user');
    const inc = this.incident(incidentId);
    if (inc.requesterId !== u.id) fail(403, 'FORBIDDEN');
    if (!this.isOpen(inc)) fail(409, 'INCIDENT_CLOSED');
    if (!['YES', 'NO', 'NEED_MORE_HELP'].includes(response)) fail(400, 'INVALID_RESPONSE');
    if (inc.duress && response === 'YES') {
      // A YES during an active duress incident is recorded but does not close it.
      this.db.confirmations.push({ id: this.deps.uuid(), incidentId: inc.id, actorId: u.id, response, createdAt: this.iso(), method: 'app', note: 'ignored: duress active' });
      this.audit(u.id, 'SAFE_CONFIRMATION_IGNORED_DURESS', 'incident', inc.id);
      return { ok: true, closed: true };
    }
    if (response === 'YES' && confirm !== true) fail(400, 'CONFIRM_REQUIRED', 'Please confirm that you are safe');
    this.db.confirmations.push({ id: this.deps.uuid(), incidentId: inc.id, actorId: u.id, response, createdAt: this.iso(), method: 'app' });
    this.emit('safety.confirmation_received', inc.id);
    if (response === 'YES') {
      this.transition(inc, S.SAFE_CONFIRMED, u.id, 'User confirmed safe', 'api');
      inc.safeConfirmedAt = this.iso();
      this.closeIncident(inc, u.id, 'USER_CONFIRMED_SAFE');
      return { ok: true, closed: true };
    }
    this.transition(inc, S.ESCALATION_REQUIRED, u.id, response === 'NO' ? 'User is NOT safe' : 'User needs more help', 'api');
    this.escalate(inc, u.id, response, 'User did not confirm safety');
    if (!this.activeAssignments(inc.id).length || this.activeAssignments(inc.id).length < this.cfg.targetResponders) {
      if (inc.searchStage == null && this.latestLocation(inc.id)) this.startStage(inc, 0, u.id, 'Search after user requested help');
      else this.alertVolunteers(inc);
    }
    return { ok: true, closed: false };
  }

  closeIncident(inc, actorId, reason) {
    for (const a of this.activeAssignments(inc.id)) { a.status = 'COMPLETED'; a.completedAt = this.iso(); this.notify(inc.id, a.volunteerId, 'INCIDENT_CLOSED'); }
    this.transition(inc, S.CLOSED, actorId, reason, 'api');
    inc.closedAt = this.iso(); inc.closureReason = reason; inc.stageDeadline = null;
    this.emit('incident.closed', inc.id);
  }

  requestEscalation(actor, incidentId, { type = 'MANUAL', reason } = {}) {
    if (!actor) fail(401, 'UNAUTHENTICATED');
    const u = this.user(actor.id);
    const inc = this.incident(incidentId);
    const isRequester = u?.role === 'user' && inc.requesterId === u.id;
    const isAssigned = u?.role === 'volunteer' && this.activeAssignments(inc.id).some((a) => a.volunteerId === u.id);
    const isOps = ['operator', 'admin'].includes(u?.role);
    if (!isRequester && !isAssigned && !isOps) { this.audit(actor.id, 'ESCALATION_DENIED', 'incident', inc.id); fail(403, 'FORBIDDEN'); }
    if (!this.isOpen(inc)) fail(409, 'INCIDENT_CLOSED');
    if (inc.status !== S.ESCALATION_REQUIRED && inc.status !== S.EMERGENCY_HANDOFF) this.transition(inc, S.ESCALATION_REQUIRED, u.id, reason || 'Escalation requested', 'api');
    return this.escalate(inc, u.id, String(type).slice(0, 30), String(reason || 'Escalation requested').slice(0, 200));
  }

  // ---------- scheduler ----------
  // Called every second by the server (and the browser demo). Deadlines are
  // persisted on the incident, so a restart resumes exactly where it left off.
  tick() {
    const now = this.now();
    const changed = [];
    for (const inc of this.db.incidents) {
      if (!this.isOpen(inc)) continue;
      const active = this.activeAssignments(inc.id);
      // Stage expansion while fewer than targetResponders have accepted.
      if (inc.stageDeadline && now >= Date.parse(inc.stageDeadline) && active.length < this.cfg.targetResponders) {
        if (inc.searchStage < 2) {
          this.startStage(inc, inc.searchStage + 1, 'system', `No ${active.length ? 'backup ' : ''}responder within ${this.cfg.radiusStagesKm[inc.searchStage]} km before timeout`);
        } else {
          inc.stageDeadline = null;
          if (!active.length) {
            if (inc.status === S.ALERTING_30KM) this.transition(inc, S.NO_RESPONDER_AVAILABLE, 'system', 'No responder within largest radius', 'scheduler');
            this.escalate(inc, 'system', 'NO_RESPONDER', 'No volunteer accepted within all search stages');
          }
        }
        changed.push(inc.id);
      } else if (inc.stageDeadline && active.length >= this.cfg.targetResponders) {
        inc.stageDeadline = null; // enough responders; stop expanding
      }
      // Stalled responders → backup search + escalation.
      for (const a of active) {
        if (a.stallFlagged) continue;
        let stalled = false;
        if (a.status === 'ACCEPTED' && now - Date.parse(a.acceptedAt) > this.cfg.acceptToEnRouteStallSec * 1000) stalled = true;
        if (a.status === 'EN_ROUTE') {
          const limit = Math.max(this.cfg.enRouteStallMinSec, (a.etaMinAtAccept || 10) * 60 * this.cfg.enRouteStallFactor) * 1000;
          if (now - Date.parse(a.enRouteAt) > limit) stalled = true;
        }
        if (stalled) {
          a.stallFlagged = true;
          this.audit('system', 'RESPONDER_STALLED', 'assignment', a.id, a.status);
          this.escalate(inc, 'system', 'RESPONDER_STALLED', `Responder stalled in ${a.status}`);
          if (inc.searchStage != null && inc.searchStage < 2 && !inc.stageDeadline) this.startStage(inc, inc.searchStage + 1, 'system', 'Backup search: responder stalled');
          else this.alertVolunteers(inc);
          changed.push(inc.id);
        }
      }
      // Location freshness flag (display only — never fabricates a position).
      const loc = this.latestLocation(inc.id);
      const stale = !loc || now - Date.parse(loc.observedAt) > this.cfg.locationStaleSec * 1000;
      if (stale !== inc.flags.includes('LOCATION_STALE')) {
        inc.flags = stale ? [...inc.flags, 'LOCATION_STALE'] : inc.flags.filter((f) => f !== 'LOCATION_STALE');
        this.emit('location.updated', inc.id);
        changed.push(inc.id);
      }
    }
    return changed;
  }

  // ---------- views (role filtered) ----------
  colorOf(inc) {
    if (inc.closureReason === 'USER_CONFIRMED_SAFE' || inc.closureReason === 'HANDED_TO_EMERGENCY_SERVICES_CONFIRMED_SAFE') return 'GREEN';
    if (!this.isOpen(inc)) return 'GREY';
    return this.activeAssignments(inc.id).length ? 'AMBER' : 'RED';
  }

  locationView(loc, now = this.now()) {
    if (!loc) return null;
    const ageSec = Math.max(0, Math.round((now - Date.parse(loc.observedAt)) / 1000));
    return {
      lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM, source: loc.source, observedAt: loc.observedAt, ageSec,
      stale: ageSec > this.cfg.locationStaleSec, lowAccuracy: loc.accuracyM > this.cfg.lowAccuracyM,
      altitudeM: loc.altitudeM, verticalAccuracyM: loc.verticalAccuracyM,
      vertical: loc.floor ? `Floor ${loc.floor.value} (user-provided, unverified)` : 'Floor/vertical location unknown',
      altitudeNote: loc.altitudeM != null ? 'GPS altitude above sea level — not height above ground or floor' : null,
    };
  }

  auditPreciseAccess(actorId, inc) {
    const win = this.cfg.preciseAccessAuditWindowSec * 1000;
    const recent = [...this.db.audit].reverse().find((a) => a.action === 'PRECISE_LOCATION_ACCESS' && a.actorId === actorId && a.entityId === inc.id);
    if (!recent || this.now() - Date.parse(recent.timestamp) > win) this.audit(actorId, 'PRECISE_LOCATION_ACCESS', 'incident', inc.id);
  }

  // Live tracking view of one accepted responder relative to her latest location.
  responderTrack(a, loc, i, { withPosition = false, selfId = null } = {}) {
    const v = this.vol(a.volunteerId);
    const d = loc && v?.lastLocation ? haversineKm(loc, v.lastLocation) : null;
    const onScene = a.status === 'ARRIVED' || a.status === 'ASSISTING';
    return {
      label: a.volunteerId === selfId ? 'You' : `Verified volunteer ${String.fromCharCode(65 + i)}`,
      isYou: a.volunteerId === selfId, role: a.role, status: a.status, verified: v?.verificationStatus === 'VERIFIED',
      distanceKm: d != null ? +d.toFixed(d < 1 ? 2 : 1) : null, distanceBand: distanceBand(d),
      approxEtaMin: onScene ? 0 : approxEtaMinutes(d, this.cfg), etaLabel: 'approximate (straight-line estimate)',
      locationUpdatedAt: v?.lastLocationAt || null,
      position: withPosition && v?.lastLocation ? { lat: +v.lastLocation.lat.toFixed(4), lng: +v.lastLocation.lng.toFixed(4) } : undefined,
      ...this.motion(a, loc, withPosition),
    };
  }

  // Multi-target tracking data: bearing from her, ground speed, closing/opening, recent track.
  motion(a, loc, withTrack) {
    const v = this.vol(a.volunteerId);
    if (!loc || !v?.lastLocation) return { bearingDeg: null, speedKmh: null, closing: null, track: withTrack ? [] : undefined };
    const pts = this.db.responderLocations.filter((p) => p.assignmentId === a.id);
    const recent = pts.slice(-40);
    let speedKmh = null, closing = null;
    if (recent.length >= 2) {
      const p1 = recent[recent.length - 1];
      const p0 = recent.find((p) => Date.parse(p1.observedAt) - Date.parse(p.observedAt) <= 30000) || recent[recent.length - 2];
      const hrs = (Date.parse(p1.observedAt) - Date.parse(p0.observedAt)) / 3.6e6;
      if (hrs > 0) {
        speedKmh = Math.round(haversineKm(p0, p1) / hrs);
        const dd = haversineKm(loc, p1) - haversineKm(loc, p0);
        closing = Math.abs(dd) < 0.005 ? 'STEADY' : dd < 0 ? 'CLOSING' : 'OPENING';
      }
    }
    return {
      bearingDeg: bearingDeg(loc, v.lastLocation), speedKmh, closing,
      track: withTrack ? recent.map((p) => ({ lat: +p.lat.toFixed(4), lng: +p.lng.toFixed(4) })) : undefined,
    };
  }

  viewIncident(actor, incidentId) {
    if (!actor) fail(401, 'UNAUTHENTICATED');
    const u = this.user(actor.id);
    if (!u || u.status !== 'ACTIVE') fail(403, 'ACCOUNT_INACTIVE');
    const inc = this.incident(incidentId);
    const now = this.now();
    const loc = this.latestLocation(inc.id);
    const base = { id: inc.id, severity: inc.severity, createdAt: inc.createdAt, countryCode: inc.countryCode };
    const searchView = { stage: inc.searchStage, radiusKm: inc.searchStage != null ? this.cfg.radiusStagesKm[inc.searchStage] : null, deadline: inc.stageDeadline, secondsLeft: inc.stageDeadline ? Math.max(0, Math.round((Date.parse(inc.stageDeadline) - now) / 1000)) : null };
    const alertedCount = this.db.notifications.filter((n) => n.incidentId === inc.id && n.kind === 'ALERT').length;

    if (u.role === 'user') {
      if (inc.requesterId !== u.id) { this.audit(u.id, 'INCIDENT_ACCESS_DENIED', 'incident', inc.id); fail(403, 'FORBIDDEN'); }
      if (inc.duress) return { ...base, status: S.USER_CANCELLED, color: 'GREY', role: 'requester', masked: true, closed: true };
      const active = this.activeAssignments(inc.id);
      return {
        ...base, role: 'requester', status: inc.status, color: this.colorOf(inc), escalationStatus: inc.escalationStatus, closed: !this.isOpen(inc),
        closureReason: inc.closureReason, safeConfirmedAt: inc.safeConfirmedAt, search: searchView, alertedCount, flags: inc.flags,
        location: this.locationView(loc, now),
        responders: active.map((a, i) => this.responderTrack(a, loc, i, { withPosition: true })),
        radiusStagesKm: this.cfg.radiusStagesKm,
        escalations: this.db.escalations.filter((e) => e.incidentId === inc.id).map((e) => ({ type: e.type, status: e.status, label: e.label, attemptedAt: e.attemptedAt })),
      };
    }

    if (u.role === 'volunteer') {
      const mine = this.db.assignments.find((a) => a.incidentId === inc.id && a.volunteerId === u.id && ACTIVE_ASG.has(a.status));
      const alert = this.db.notifications.find((n) => n.incidentId === inc.id && n.recipientId === u.id && n.kind === 'ALERT');
      if (!mine && !alert) { this.audit(u.id, 'INCIDENT_ACCESS_DENIED', 'incident', inc.id); fail(403, 'FORBIDDEN'); }
      const v = this.vol(u.id);
      const d = loc && v.lastLocation ? haversineKm(loc, v.lastLocation) : null;
      // Every accepted responder's live distance to her is shared with the volunteers on this
      // incident; map positions only with fellow assigned responders (never with merely alerted ones).
      const amAssigned = this.activeAssignments(inc.id).some((a) => a.volunteerId === u.id) && this.isOpen(inc);
      const team = this.activeAssignments(inc.id).map((a, i) => this.responderTrack(a, loc, i, { withPosition: amAssigned, selfId: u.id }));
      const others = team.filter((x) => !x.isYou);
      const common = { ...base, role: mine ? 'assigned_responder' : 'alerted_volunteer', status: this.isOpen(inc) ? (inc.duress ? S.ESCALATION_REQUIRED : inc.status) : inc.status, open: this.isOpen(inc), color: this.colorOf(inc), distanceBand: distanceBand(d), approxEtaMin: approxEtaMinutes(d, this.cfg), otherResponders: others, team, radiusStagesKm: this.cfg.radiusStagesKm, alertResponse: alert?.response || null, escalationStatus: inc.escalationStatus };
      if (mine && this.isOpen(inc)) {
        this.auditPreciseAccess(u.id, inc);
        return { ...common, assignment: { id: mine.id, status: mine.status, role: mine.role }, location: this.locationView(loc, now), navigationUrl: loc ? `https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}` : null, battery: inc.battery };
      }
      return { ...common, approxArea: loc ? approxPoint(loc.lat, loc.lng, this.cfg.approxGridDeg) : null, precisionNote: 'Exact location is shared only after you accept and are assigned.' };
    }

    // operator / admin
    this.auditPreciseAccess(u.id, inc);
    return {
      ...base, role: u.role, status: inc.status, color: this.colorOf(inc), duress: inc.duress, escalationStatus: inc.escalationStatus, flags: inc.flags, trigger: inc.trigger, silent: inc.silent, battery: inc.battery, note: inc.note,
      requester: { id: inc.requesterId, displayName: this.user(inc.requesterId)?.displayName },
      search: searchView, alertedCount, closed: !this.isOpen(inc), closureReason: inc.closureReason,
      location: this.locationView(loc, now),
      locationHistory: this.db.locations.filter((l) => l.incidentId === inc.id).slice(-20).map((l) => ({ lat: l.lat, lng: l.lng, accuracyM: l.accuracyM, observedAt: l.observedAt, suspect: l.suspect, suspectReason: l.suspectReason })),
      assignments: this.db.assignments.filter((a) => a.incidentId === inc.id).map((a) => {
        const v = this.vol(a.volunteerId);
        const d = loc && v?.lastLocation ? haversineKm(loc, v.lastLocation) : null;
        const active = ACTIVE_ASG.has(a.status);
        return { ...a, volunteerName: this.user(a.volunteerId)?.displayName, position: active ? v?.lastLocation : null, distanceKm: d != null ? +d.toFixed(2) : null, approxEtaMin: approxEtaMinutes(d, this.cfg), ...(active ? this.motion(a, loc, true) : {}) };
      }),
      alertedPositions: this.db.notifications.filter((n) => n.incidentId === inc.id && n.kind === 'ALERT').map((n) => ({ response: n.response, distanceKm: n.meta?.distanceKm ?? null, position: this.vol(n.recipientId)?.lastLocation || null })),
      notifications: this.db.notifications.filter((n) => n.incidentId === inc.id).map((n) => ({ id: n.id, kind: n.kind, recipient: this.user(n.recipientId)?.displayName, status: n.status, channel: n.channel, attemptCount: n.attemptCount, response: n.response })),
      escalations: this.db.escalations.filter((e) => e.incidentId === inc.id),
    };
  }

  timeline(actor, incidentId) {
    const view = this.viewIncident(actor, incidentId); // enforces access
    if (view.masked) return [{ at: view.createdAt, text: 'SOS cancelled' }];
    const items = this.db.transitions.filter((t) => t.incidentId === incidentId).map((t) => ({ at: t.at, kind: 'status', text: t.to, reason: t.reason }));
    if (view.role !== 'alerted_volunteer') {
      for (const e of this.db.escalations.filter((x) => x.incidentId === incidentId)) items.push({ at: e.attemptedAt, kind: 'escalation', text: `${e.type}: ${e.label}`, reason: e.reason });
      for (const c of this.db.confirmations.filter((x) => x.incidentId === incidentId)) items.push({ at: c.createdAt, kind: 'confirmation', text: `Safety answer: ${c.response}` });
    }
    if (view.role === 'operator' || view.role === 'admin') {
      for (const n of this.db.notifications.filter((x) => x.incidentId === incidentId && x.status === 'FAILED')) items.push({ at: n.createdAt, kind: 'notification', text: `Notification FAILED (${n.kind})` });
    }
    return items.sort((a, b) => a.at.localeCompare(b.at));
  }

  myIncidents(actor) {
    const u = this.requireRole(actor, 'user');
    return this.db.incidents.filter((i) => i.requesterId === u.id).slice(-20).reverse().map((i) => ({ id: i.id, createdAt: i.createdAt, status: i.duress ? S.USER_CANCELLED : i.status, open: !i.duress && this.isOpen(i), closureReason: i.duress ? 'USER_CANCELLED' : i.closureReason }));
  }

  volunteerAlerts(actor) {
    this.requireRole(actor, 'volunteer');
    const ids = new Set(this.db.notifications.filter((n) => n.recipientId === actor.id && n.kind === 'ALERT').map((n) => n.incidentId));
    for (const a of this.db.assignments) if (a.volunteerId === actor.id) ids.add(a.incidentId);
    return [...ids].map((id) => this.viewIncident(actor, id)).sort((a, b) => (b.open - a.open) || b.createdAt.localeCompare(a.createdAt)).slice(0, 30);
  }

  // ---------- operations ----------
  operatorIncidents(actor, { includeClosed = false } = {}) {
    this.requireRole(actor, 'operator', 'admin');
    const list = this.db.incidents.filter((i) => includeClosed || this.isOpen(i)).slice(-100).reverse();
    return list.map((inc) => {
      const loc = this.latestLocation(inc.id);
      return { id: inc.id, status: inc.status, color: this.colorOf(inc), severity: inc.severity, duress: inc.duress, escalationStatus: inc.escalationStatus, createdAt: inc.createdAt, searchStage: inc.searchStage, radiusKm: inc.searchStage != null ? this.cfg.radiusStagesKm[inc.searchStage] : null, responders: this.activeAssignments(inc.id).length, flags: inc.flags, location: loc ? { lat: loc.lat, lng: loc.lng, accuracyM: loc.accuracyM, ageSec: Math.round((this.now() - Date.parse(loc.observedAt)) / 1000) } : null };
    });
  }

  operatorReassign(actor, incidentId, { assignmentId, reason }) {
    const op = this.requireRole(actor, 'operator', 'admin');
    if (!reason || String(reason).trim().length < 5) fail(400, 'REASON_REQUIRED', 'A reason (≥5 chars) is required');
    const inc = this.incident(incidentId);
    const a = this.db.assignments.find((x) => x.id === assignmentId && x.incidentId === inc.id);
    if (!a || !ACTIVE_ASG.has(a.status)) fail(404, 'NOT_FOUND', 'Active assignment not found');
    a.status = 'CANCELLED'; a.cancelledAt = this.iso(); a.cancellationReason = `Operator: ${reason}`;
    const v = this.vol(a.volunteerId); v.noShowCount += 1;
    this.notify(inc.id, a.volunteerId, 'UNASSIGNED_BY_OPERATOR');
    this.audit(op.id, 'OPERATOR_REASSIGN', 'assignment', a.id, reason);
    this.emit('responder.status_changed', inc.id);
    this.onResponderLost(inc, op.id, 'Operator removed responder');
    return { ok: true };
  }

  operatorHandoff(actor, incidentId, { status, reason }) {
    const op = this.requireRole(actor, 'operator', 'admin');
    if (!['ATTEMPTED', 'DELIVERED', 'ACKNOWLEDGED', 'FAILED'].includes(status)) fail(400, 'INVALID_STATUS');
    if (!reason || String(reason).trim().length < 5) fail(400, 'REASON_REQUIRED');
    const inc = this.incident(incidentId);
    if (!this.isOpen(inc)) fail(409, 'INCIDENT_CLOSED');
    const ev = { id: this.deps.uuid(), incidentId: inc.id, type: 'OPERATOR_HANDOFF', status, label: `Recorded manually by operator (${status}) — no automated integration`, reason: String(reason).slice(0, 300), attemptedAt: this.iso(), acknowledgedAt: status === 'ACKNOWLEDGED' ? this.iso() : null, recordedBy: op.id, metadata: { adapter: 'manual' } };
    this.db.escalations.push(ev);
    inc.escalationStatus = status;
    if (status !== 'FAILED' && inc.status !== S.EMERGENCY_HANDOFF) this.transition(inc, S.EMERGENCY_HANDOFF, op.id, `Operator recorded handoff: ${status}`, 'operator');
    if (status === 'ACKNOWLEDGED') this.emit('escalation.acknowledged', inc.id);
    this.audit(op.id, 'OPERATOR_HANDOFF', 'incident', inc.id, reason, { status });
    return ev;
  }

  operatorClosureException(actor, incidentId, { reason, note }) {
    const op = this.requireRole(actor, 'operator', 'admin');
    const inc = this.incident(incidentId);
    if (!OPERATOR_CLOSURE_REASONS.includes(reason)) fail(400, 'INVALID_REASON', 'Choose a documented closure reason');
    if (!note || String(note).trim().length < 10) fail(400, 'NOTE_REQUIRED', 'A note of at least 10 characters is required');
    if (inc.status === S.USER_CANCELLED) {
      this.transition(inc, S.FALSE_ALARM_REVIEW, op.id, note, 'operator');
    } else if (!this.isOpen(inc)) fail(409, 'INCIDENT_CLOSED');
    if (inc.duress && reason === 'VERIFIED_FALSE_ALARM') fail(409, 'DURESS_ACTIVE', 'A duress incident cannot be closed as a false alarm');
    if (inc.status !== S.ESCALATION_REQUIRED && inc.status !== S.EMERGENCY_HANDOFF && inc.status !== S.FALSE_ALARM_REVIEW) this.transition(inc, S.ESCALATION_REQUIRED, op.id, 'Operator exception review', 'operator');
    this.audit(op.id, 'OPERATOR_CLOSURE_EXCEPTION', 'incident', inc.id, note, { reason });
    this.closeIncident(inc, op.id, reason);
    return { ok: true };
  }

  // ---------- admin ----------
  getConfig(actor) { this.requireRole(actor, 'operator', 'admin'); return { config: this.cfg, countries: COUNTRIES, closureReasons: OPERATOR_CLOSURE_REASONS }; }

  patchConfig(actor, patch) {
    const a = this.requireRole(actor, 'admin');
    const { ok, errors, config } = validateConfig(patch || {}, this.cfg);
    if (!ok) fail(400, 'INVALID_CONFIG', errors.join('; '));
    this.db.config = config;
    this.audit(a.id, 'CONFIG_UPDATED', 'config', 'global', null, { keys: Object.keys(patch) });
    return { config };
  }

  listVolunteers(actor) {
    this.requireRole(actor, 'admin', 'operator');
    return this.db.volunteers.filter((v) => this.user(v.userId)?.status !== 'DELETED').map((v) => ({ userId: v.userId, displayName: this.user(v.userId)?.displayName, email: this.user(v.userId)?.email, request: (({ contactPhone, area, submittedAt } = {}) => ({ contactPhone, area, submittedAt }))([...this.db.verifications].reverse().find((r) => r.volunteerId === v.userId) || {}), accountStatus: this.user(v.userId)?.status, verificationStatus: v.verificationStatus, trainingDone: v.trainingCompleted.length, trainingTotal: TRAINING_MODULES.length, available: v.available, noShowCount: v.noShowCount, suspendedReason: v.suspendedReason, eligibility: this.volunteerEligibility(v) }));
  }

  reviewVolunteer(actor, volunteerId, { decision, reason }) {
    const a = this.requireRole(actor, 'admin');
    const v = this.vol(volunteerId);
    if (!v) fail(404, 'NOT_FOUND');
    if (!['APPROVE', 'REJECT', 'SUSPEND', 'REINSTATE'].includes(decision)) fail(400, 'INVALID_DECISION');
    if (decision !== 'APPROVE' && (!reason || reason.trim().length < 5)) fail(400, 'REASON_REQUIRED');
    const rec = [...this.db.verifications].reverse().find((r) => r.volunteerId === volunteerId);
    if (decision === 'APPROVE') {
      v.verificationStatus = 'VERIFIED'; v.verificationExpiresAt = this.iso(this.now() + 365 * 864e5); v.suspendedReason = null;
      if (rec) { rec.status = 'VERIFIED'; rec.reviewedAt = this.iso(); rec.expiresAt = v.verificationExpiresAt; }
    } else if (decision === 'REJECT') {
      v.verificationStatus = 'REJECTED'; if (rec) { rec.status = 'REJECTED'; rec.reviewedAt = this.iso(); }
    } else if (decision === 'SUSPEND') {
      v.suspendedReason = reason; v.available = false;
      for (const asg of this.db.assignments.filter((x) => x.volunteerId === volunteerId && ACTIVE_ASG.has(x.status))) {
        asg.status = 'CANCELLED'; asg.cancellationReason = 'volunteer suspended'; asg.cancelledAt = this.iso();
        this.onResponderLost(this.incident(asg.incidentId), a.id, 'Responder suspended');
      }
    } else v.suspendedReason = null;
    this.audit(a.id, 'VOLUNTEER_REVIEW', 'volunteer', volunteerId, reason || null, { decision });
    return { ok: true, verificationStatus: v.verificationStatus, suspended: !!v.suspendedReason };
  }

  listStaff(actor) {
    this.requireRole(actor, 'admin');
    return this.db.users.filter((u) => ['operator', 'admin'].includes(u.role) && u.status !== 'DELETED').map((u) => ({ id: u.id, displayName: u.displayName, email: u.email, role: u.role, status: u.status, mfaEnrolled: !!u.mfaEnrolled, createdAt: u.createdAt }));
  }

  createStaff(actor, { displayName, email, role, passwordHash }) {
    const a = this.requireRole(actor, 'admin');
    if (!['operator', 'admin'].includes(role)) fail(400, 'INVALID_ROLE');
    const u = this.createUser({ displayName, email, role, passwordHash });
    u.mfaEnrolled = false;
    this.audit(a.id, 'STAFF_CREATED', 'user', u.id, null, { role });
    return { id: u.id };
  }

  setStaffStatus(actor, userId, status) {
    const a = this.requireRole(actor, 'admin');
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) fail(400, 'INVALID_STATUS');
    const u = this.user(userId);
    if (!u || !['operator', 'admin'].includes(u.role)) fail(404, 'NOT_FOUND');
    if (u.id === a.id) fail(409, 'CANNOT_CHANGE_SELF');
    u.status = status; u.updatedAt = this.iso();
    this.audit(a.id, 'STAFF_STATUS', 'user', u.id, status);
    return { ok: true };
  }

  reportAbuse(actor, { incidentId = null, category, details }) {
    if (!actor) fail(401, 'UNAUTHENTICATED');
    if (!['VOLUNTEER_MISCONDUCT', 'STALKING', 'FALSE_ALERT', 'PRIVACY_BREACH', 'OTHER'].includes(category)) fail(400, 'INVALID_CATEGORY');
    const r = { id: this.deps.uuid(), reporterId: actor.id, incidentId, category, details: String(details || '').slice(0, 1000), status: 'OPEN', reviewedBy: null, createdAt: this.iso() };
    this.db.abuseReports.push(r);
    this.audit(actor.id, 'ABUSE_REPORTED', 'abuse_report', r.id, category);
    return { id: r.id, status: r.status };
  }

  listAbuse(actor) { this.requireRole(actor, 'admin', 'operator'); return this.db.abuseReports.slice().reverse().map((r) => ({ ...r, reporter: this.user(r.reporterId)?.displayName })); }

  resolveAbuse(actor, id, { resolution }) {
    const a = this.requireRole(actor, 'admin');
    const r = this.db.abuseReports.find((x) => x.id === id);
    if (!r) fail(404, 'NOT_FOUND');
    r.status = 'RESOLVED'; r.reviewedBy = a.id; r.resolution = String(resolution || '').slice(0, 300);
    this.audit(a.id, 'ABUSE_RESOLVED', 'abuse_report', id);
    return r;
  }

  auditEvents(actor, { limit = 100, offset = 0 } = {}) {
    const a = this.requireRole(actor, 'admin');
    this.audit(a.id, 'AUDIT_LOG_VIEWED', 'audit', 'all');
    const list = this.db.audit.slice().reverse();
    return { total: list.length, items: list.slice(offset, offset + Math.min(limit, 500)), chain: this.verifyAuditChain() };
  }

  // Data-subject rights: export and delete own data (requester).
  exportMyData(actor) {
    const u = this.requireRole(actor, 'user', 'volunteer');
    const incIds = new Set(this.db.incidents.filter((i) => i.requesterId === u.id).map((i) => i.id));
    this.audit(u.id, 'DATA_EXPORTED', 'user', u.id);
    return { user: { id: u.id, displayName: u.displayName, email: u.email, role: u.role, createdAt: u.createdAt }, incidents: this.db.incidents.filter((i) => incIds.has(i.id)), locations: this.db.locations.filter((l) => incIds.has(l.incidentId)), confirmations: this.db.confirmations.filter((c) => incIds.has(c.incidentId)), volunteerProfile: this.vol(u.id) || null };
  }

  deleteMyAccount(actor) {
    const u = this.requireRole(actor, 'user', 'volunteer');
    if (this.db.incidents.some((i) => i.requesterId === u.id && this.isOpen(i))) fail(409, 'OPEN_INCIDENT', 'Close your active SOS before deleting your account');
    const incIds = new Set(this.db.incidents.filter((i) => i.requesterId === u.id).map((i) => i.id));
    this.db.locations = this.db.locations.filter((l) => !incIds.has(l.incidentId));
    u.status = 'DELETED'; u.email = `deleted+${u.id}@invalid`; u.displayName = 'Deleted user'; u.passwordHash = null; u.pins = null;
    const v = this.vol(u.id); if (v) { v.lastLocation = null; v.available = false; }
    this.audit(u.id, 'ACCOUNT_DELETED', 'user', u.id, 'precise location history purged; incident skeletons retained for audit');
    return { ok: true };
  }
}

function sanitizeBattery(b) {
  if (!b || typeof b !== 'object') return null;
  const level = Number(b.level);
  return Number.isFinite(level) ? { level: Math.max(0, Math.min(1, level)), charging: !!b.charging } : null;
}
