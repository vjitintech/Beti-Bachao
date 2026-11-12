// Autonomous protection features, mixed into Engine (see bottom of engine.js):
//  • location-based trusted contacts (3–5 per saved place, switch automatically)
//  • operator acknowledgement clock → automatic nearest-police-station connection
//  • police station registry + nearby help
//  • "Track my travel" trips with auto-arrival and auto-SOS when overdue
//  • SOS evidence (audio/video) metadata — bytes are stored encrypted by the server
//  • dashboards: hers, admin impact, public impact counter
import { haversineKm, isValidLatLng } from './geo.js?v=mwdsq0ev';
import { COUNTRIES } from './config.js?v=mwdsq0ev';
import { toE164, dialInfo } from './dial.js?v=mwdsq0ev';

const SAFE_CLOSURES = new Set(['USER_CONFIRMED_SAFE', 'HANDED_TO_EMERGENCY_SERVICES_CONFIRMED_SAFE']);
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const day = (iso) => iso.slice(0, 10);

// Shared by the server and the phone app (so the phone texts the same people the server would).
// Same person whatever the format: "+91 98765 43210", "098765 43210" and "9876543210".
export const phoneKey = (p) => String(p || '').replace(/\D/g, '').slice(-10);
// First duplicate number in a list of contacts, or null.
export function duplicateIn(list) {
  const seen = new Map();
  for (const c of list || []) { const k = phoneKey(c.phone); if (!k) continue; if (seen.has(k)) return { a: seen.get(k), b: c }; seen.set(k, c); }
  return null;
}
export function pickContacts(places, defaults, loc) {
  const always = defaults || []; // important contacts: told about every SOS
  let place = null;
  if (loc && places?.length) {
    const ranked = places.map((p) => ({ p, d: haversineKm(loc, p) * 1000 })).sort((a, b) => a.d - b.d);
    const inside = ranked.find((x) => x.d <= x.p.radiusM);
    place = inside?.p || (ranked[0].d <= 25000 ? ranked[0].p : null);
  }
  const base = place ? place.contacts : [];
  const seen = new Set(); const out = [];
  for (const c of [...always, ...base]) { const k = phoneKey(c.phone); if (!seen.has(k)) { seen.add(k); out.push(c); } }
  return { place: place ? { id: place.id, label: place.label } : null, contacts: out };
}

// "kurnool i town ps" → "Kurnool I Town PS" (only when typed all in lowercase; PS / SHO / CP stay capitals).
export function stationName(raw) {
  const t = String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (t !== t.toLowerCase()) return t;
  return t.split(' ').map((w) => (/^(ps|sho|cp|dcp|acp|ii|iii|iv|vi|i)$/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

export const protectMethods = {
  // ================= places & location-based contacts =================
  cleanContact(c) {
    const ph = this.normPhone(c?.phone);
    if (!ph) this.fail(400, 'INVALID_PHONE', `Invalid phone for ${String(c?.name || '').slice(0, 30) || 'a contact'}`);
    return { name: String(c.name || '').trim().slice(0, 40) || 'Contact', phone: ph, always: !!c.always };
  },

  getPlaces(actor) {
    const u = this.requireRole(actor, 'user');
    return { places: u.places || [], defaultContacts: u.contacts || [] };
  },

  // Each saved place (home, college, office, parents' town…) has its own 3–5 contacts.
  setPlaces(actor, { places } = {}) {
    const u = this.requireRole(actor, 'user');
    if (!Array.isArray(places) || places.length > 10) this.fail(400, 'INVALID_PLACES', 'Up to 10 places');
    const clean = places.map((p, i) => {
      const label = String(p.label || '').trim().slice(0, 40);
      if (!label) this.fail(400, 'INVALID_PLACE', `Place ${i + 1} needs a name`);
      if (!isValidLatLng(Number(p.lat), Number(p.lng))) this.fail(400, 'INVALID_PLACE', `Set the location of "${label}"`);
      const contacts = Array.isArray(p.contacts) ? p.contacts.map((c) => this.cleanContact(c)) : [];
      if (contacts.length < 1 || contacts.length > 3) this.fail(400, 'PLACE_CONTACTS', `"${label}" needs 1 to 3 contacts`);
      const dup = duplicateIn(contacts);
      if (dup) this.fail(400, 'DUPLICATE_CONTACT', `"${label}": ${dup.b.name} has the same number as ${dup.a.name}`);
      const radiusM = Math.min(50000, Math.max(200, Math.round(Number(p.radiusM) || 2000)));
      return { id: p.id && /^[\w-]{4,40}$/.test(p.id) ? p.id : this.deps.uuid(), label, lat: +Number(p.lat).toFixed(5), lng: +Number(p.lng).toFixed(5), radiusM, contacts };
    });
    u.places = clean;
    this.audit(u.id, 'PLACES_UPDATED', 'user', u.id, null, { count: clean.length });
    return this.getPlaces(actor);
  },

  // Who is told when she raises an SOS at `loc`: the contacts of the saved place she is at
  // (or the nearest one within 25 km), plus every "always" contact. Falls back to her default list.
  contactsFor(userId, loc) {
    const u = this.user(userId);
    return u ? pickContacts(u.places, u.contacts, loc) : { place: null, contacts: [] };
  },

  // ================= operator acknowledgement & police auto-connect =================
  operatorAck(actor, incidentId) {
    const op = this.requireRole(actor, 'operator', 'admin');
    const inc = this.incident(incidentId);
    if (!inc.opAckAt) {
      inc.opAckAt = this.iso(); inc.opAckBy = op.id;
      this.audit(op.id, 'OPERATOR_ACKNOWLEDGED', 'incident', inc.id);
      this.emit('incident.acknowledged', inc.id);
    }
    return { ok: true, opAckAt: inc.opAckAt };
  },
  markAck(inc, opId) { if (!inc.opAckAt) { inc.opAckAt = this.iso(); inc.opAckBy = opId; } },

  // ---- police station registry (admin imports the official list) ----
  listStations(actor) { this.requireRole(actor, 'operator', 'admin'); return { items: this.db.policeStations || [] }; },

  // Station phone: a local number ("0851 8xxxxxx", "100") gets the station's country code; "+..." is kept.
  stationPhone(raw, iso) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    return this.normPhone(s.startsWith('+') || s.startsWith('00') || !dialInfo(iso) ? s : toE164(iso, s));
  },

  // One station from the admin form. Same merge key as the CSV import (name + phone).
  addStation(actor, b = {}) {
    const a = this.requireRole(actor, 'admin');
    const country = dialInfo(b.country) ? String(b.country).toUpperCase() : (this.cfg.countryCode || 'IN');
    const lat = Number(b.lat), lng = Number(b.lng);
    const name = stationName(b.name);
    const phone = this.stationPhone(b.phone, country); const phone2 = this.stationPhone(b.phone2, country);
    if (!name) this.fail(400, 'STATION_NAME', 'Enter the station name');
    if (!isValidLatLng(lat, lng)) this.fail(400, 'STATION_LOCATION', 'Set the station location (paste a Google Maps link or lat,lng)');
    if (!phone) this.fail(400, 'STATION_PHONE', 'Enter a valid station phone number');
    const row = { name, country, state: String(b.state || '').trim().slice(0, 60), district: String(b.district || '').trim().slice(0, 60), lat, lng, phone, phone2 };
    if (!this.db.policeStations) this.db.policeStations = [];
    const old = b.id ? this.db.policeStations.find((s) => s.id === b.id) : this.db.policeStations.find((s) => s.name.toLowerCase() === name.toLowerCase() && s.phone === phone);
    if (old) Object.assign(old, row); else this.db.policeStations.push({ id: this.deps.uuid(), ...row });
    this.audit(a.id, old ? 'POLICE_STATION_UPDATED' : 'POLICE_STATION_ADDED', 'config', old?.id || 'police_stations', null, { country, state: row.state });
    return { ok: true, updated: !!old, total: this.db.policeStations.length };
  },

  // CSV import. The admin picks the country (and optionally the state) above the box, so the CSV
  // only needs name,lat,lng,phone — district, state, country and phone2 columns are optional and win when present.
  importStations(actor, { csv, mode = 'merge', country, state } = {}) {
    const a = this.requireRole(actor, 'admin');
    const lines = String(csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) this.fail(400, 'EMPTY', 'Paste the station list (CSV)');
    const header = splitCsv(lines[0]).map((h) => String(h).trim().toLowerCase().replace(/^latitude$/, 'lat').replace(/^(lon|long|longitude)$/, 'lng'));
    const col = (n) => header.indexOf(n);
    for (const need of ['name', 'lat', 'lng', 'phone']) if (col(need) < 0) this.fail(400, 'CSV_HEADER', 'Header must include: name,lat,lng,phone (district,state,country,phone2 optional)');
    const defC = dialInfo(country) ? String(country).toUpperCase() : (this.cfg.countryCode || 'IN');
    const defS = String(state || '').trim().slice(0, 60);
    const get = (f, n) => (col(n) >= 0 ? String(f[col(n)] ?? '').trim() : '');
    const rows = []; const errors = [];
    for (const [i, line] of lines.slice(1).entries()) {
      const f = splitCsv(line);
      const lat = Number(get(f, 'lat')), lng = Number(get(f, 'lng'));
      const cc = dialInfo(get(f, 'country')) ? get(f, 'country').toUpperCase() : defC;
      const phone = this.stationPhone(get(f, 'phone'), cc); const phone2 = this.stationPhone(get(f, 'phone2'), cc);
      const name = stationName(get(f, 'name'));
      if (!name || !isValidLatLng(lat, lng) || !phone) { errors.push(`row ${i + 2}`); continue; }
      rows.push({ id: this.deps.uuid(), name, country: cc, state: (get(f, 'state') || defS).slice(0, 60), district: get(f, 'district').slice(0, 60), lat, lng, phone, phone2 });
    }
    if (!rows.length) this.fail(400, 'NO_VALID_ROWS', `No valid rows (${errors.slice(0, 5).join(', ')})`);
    if (!this.db.policeStations) this.db.policeStations = [];
    // "Replace" only replaces the chosen country/state, so loading Telangana never wipes Andhra Pradesh.
    if (mode === 'replace') this.db.policeStations = this.db.policeStations.filter((s) => (s.country || defC) !== defC || (defS && (s.state || '') !== defS));
    const key = (s) => `${s.name.toLowerCase()}|${s.phone}`;
    const have = new Map(this.db.policeStations.map((s) => [key(s), s]));
    for (const r of rows) { const old = have.get(key(r)); if (old) Object.assign(old, { ...r, id: old.id }); else this.db.policeStations.push(r); }
    this.audit(a.id, 'POLICE_STATIONS_IMPORTED', 'config', 'police_stations', null, { added: rows.length, skipped: errors.length, mode, country: defC, state: defS });
    return { imported: rows.length, skipped: errors.length, total: this.db.policeStations.length, skippedRows: errors.slice(0, 20) };
  },

  deleteStation(actor, id) {
    const a = this.requireRole(actor, 'admin');
    this.db.policeStations = (this.db.policeStations || []).filter((s) => s.id !== id);
    this.audit(a.id, 'POLICE_STATION_DELETED', 'config', id);
    return { ok: true };
  },

  nearestStations(loc, n = 5) {
    if (!loc) return [];
    return (this.db.policeStations || []).map((s) => ({ ...s, distanceKm: +haversineKm(loc, s).toFixed(1) })).sort((a, b) => a.distanceKm - b.distanceKm).slice(0, n);
  },

  nearbyHelp(actor, { lat, lng } = {}) {
    if (!actor) this.fail(401, 'UNAUTHENTICATED');
    const u = this.user(actor.id);
    const loc = isValidLatLng(Number(lat), Number(lng)) ? { lat: Number(lat), lng: Number(lng) } : null;
    const cc = COUNTRIES[u?.countryCode || this.cfg.countryCode] || COUNTRIES.IN;
    const q = loc ? `${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}` : '';
    return {
      stations: this.nearestStations(loc, 5).map(({ id, name, district, phone, phone2, distanceKm, lat: sl, lng: sg }) => ({ id, name, district, phone, phone2, distanceKm, mapUrl: `https://maps.google.com/?q=${sl},${sg}` })),
      emergency: cc.emergency, helplines: cc.extra || [], chat: cc.chat || [],
      search: loc ? [
        { label: 'Hospitals near me', url: `https://www.google.com/maps/search/hospital/@${q},14z` },
        { label: 'Police stations near me', url: `https://www.google.com/maps/search/police+station/@${q},14z` },
        { label: 'Pharmacies open now', url: `https://www.google.com/maps/search/pharmacy/@${q},14z` },
      ] : [],
    };
  },

  // Who her phone calls automatically: ONLY the first phone number of the nearest admin-loaded
  // police station within policeMaxKm. No station that close → no automatic call (she and the
  // operators still have one-tap 112 / 1091 buttons).
  policeTarget(inc, loc) {
    const max = Number(this.cfg.policeMaxKm) || 30;
    const near = this.nearestStations(loc, 1)[0] || null;
    const st = near && near.distanceKm <= max ? near : null;
    if (st) return { st, dial: { number: st.phone, target: 'station', label: `${st.name} (${st.distanceKm} km)` } };
    return { st: null, dial: null };
  },

  // Connects the police: her phone calls the station / 1091 / 112 straight away, the server
  // sends the station an SMS with her live location (and bridges a call if a voice gateway is set).
  autoPolice(inc, reason) {
    if (inc.policeConnect || !this.isOpen(inc)) return null;
    const loc = this.latestLocation(inc.id);
    const { st, dial } = this.policeTarget(inc, loc);
    const emergency = COUNTRIES[inc.countryCode]?.emergency || '112';
    inc.policeConnect = { at: this.iso(), reason, status: dial ? 'PENDING' : 'NO_STATION', station: st ? { id: st.id, name: st.name, phone: st.phone, phone2: st.phone2 || null, distanceKm: st.distanceKm } : null, emergency, sms: null, call: null, dial: dial ? { ...dial, placedAt: null, result: null } : null };
    const label = dial ? `Her phone is calling ${dial.label}` : `No police station loaded within ${Number(this.cfg.policeMaxKm) || 30} km — operators must call ${emergency}`;
    this.db.escalations.push({ id: this.deps.uuid(), incidentId: inc.id, type: 'POLICE_AUTO_CONNECT', status: 'ATTEMPTED', label, reason, attemptedAt: this.iso(), acknowledgedAt: null, recordedBy: 'system', metadata: { stationId: st?.id || null, number: dial?.number || null } });
    inc.escalationStatus = 'ATTEMPTED';
    if (inc.status !== 'ESCALATION_REQUIRED' && inc.status !== 'EMERGENCY_HANDOFF') { try { this.transition(inc, 'ESCALATION_REQUIRED', 'system', `Police auto-connect: ${reason}`, 'scheduler'); } catch { /* keep current state */ } }
    if (dial) this.notify(inc.id, inc.requesterId, 'POLICE_CONNECTED', { station: st.name, phone: dial.number, callNumber: dial.number, target: dial.target });
    for (const op of this.db.users.filter((u) => ['operator', 'admin'].includes(u.role) && u.status === 'ACTIVE')) this.notify(inc.id, op.id, 'ESCALATION', { type: 'POLICE_AUTO_CONNECT' });
    this.audit('system', 'POLICE_AUTO_CONNECT', 'incident', inc.id, reason, { station: st?.name || null, number: dial?.number || null });
    this.emit('police.connect_needed', inc.id);
    return inc.policeConnect;
  },

  // Her phone reports the automatic call: placed (the call went out) or failed (no permission / no SIM).
  recordPoliceCall(actor, incidentId, { number, result } = {}) {
    const u = this.requireRole(actor, 'user');
    const inc = this.incident(incidentId);
    if (inc.requesterId !== u.id) this.fail(403, 'FORBIDDEN');
    const pc = inc.policeConnect;
    if (!pc?.dial) this.fail(409, 'NO_POLICE_CONNECT', 'No automatic police call for this SOS');
    const ok = result === 'placed';
    pc.dial = { ...(pc.dial || {}), number: String(number || pc.dial?.number || '').slice(0, 20), result: ok ? 'PLACED' : 'FAILED', placedAt: ok ? (pc.dial?.placedAt || this.iso()) : pc.dial?.placedAt || null };
    if (ok) pc.status = 'CONTACTED';
    this.audit(u.id, ok ? 'POLICE_CALL_PLACED' : 'POLICE_CALL_FAILED', 'incident', inc.id, null, { number: pc.dial.number, target: pc.dial.target || null });
    this.emit('police.updated', inc.id);
    return { ok: true, dial: pc.dial };
  },

  // A police connection counts as made only when a call actually went out (her phone or the voice gateway).
  policeCallMade(inc) { return !!(inc.policeConnect && (inc.policeConnect.dial?.result === 'PLACED' || inc.policeConnect.call === 'PLACED')); },

  // Automatic evidence: every step is audited (started, no voice → discarded, upload failed…).
  evidenceLog(actor, incidentId, { event, seconds } = {}) {
    const u = this.requireRole(actor, 'user');
    const inc = this.incident(incidentId);
    if (inc.requesterId !== u.id) this.fail(403, 'FORBIDDEN');
    const ev = { started: 'EVIDENCE_RECORDING_STARTED', no_voice: 'EVIDENCE_DISCARDED_NO_VOICE', upload_failed: 'EVIDENCE_UPLOAD_FAILED', mic_denied: 'EVIDENCE_MIC_DENIED', unsupported: 'EVIDENCE_UNSUPPORTED' }[event];
    if (!ev) this.fail(400, 'BAD_EVENT', 'Unknown evidence event');
    this.audit(u.id, ev, 'incident', inc.id, null, seconds ? { seconds: Number(seconds) || null } : null);
    return { ok: true };
  },

  setPoliceResult(incId, patch) {
    const inc = this.db.incidents.find((i) => i.id === incId);
    if (!inc?.policeConnect) return;
    Object.assign(inc.policeConnect, patch);
    this.emit('police.updated', inc.id);
  },

  // Called from tick(): the operator clock.
  protectTick(inc, now) {
    const changed = [];
    const age = now - Date.parse(inc.createdAt);
    if (!inc.opAckAt && !inc.policeConnect) {
      if (age > this.cfg.operatorAckSec * 1000 && !inc.ackReminderAt) {
        inc.ackReminderAt = this.iso();
        this.escalate(inc, 'system', 'OPERATOR_NO_ACK', `No operator acknowledged within ${this.cfg.operatorAckSec} s — second alert to all operators`);
        changed.push(inc.id);
      }
      if (age > this.cfg.policeAutoConnectSec * 1000) { this.autoPolice(inc, `No operator acknowledged within ${this.cfg.policeAutoConnectSec} s`); changed.push(inc.id); }
    }
    return changed;
  },

  // ================= Track my travel =================
  startTrip(actor, { destination, expectedMin, vehicle = '', note = '', location = null } = {}) {
    const u = this.requireRole(actor, 'user');
    if (!destination || !isValidLatLng(Number(destination.lat), Number(destination.lng))) this.fail(400, 'INVALID_DESTINATION', 'Choose where you are going');
    const mins = Math.round(Number(expectedMin));
    if (!Number.isFinite(mins) || mins < 5 || mins > 720) this.fail(400, 'INVALID_TIME', 'Expected travel time must be 5–720 minutes');
    this.db.trips ||= [];
    for (const t of this.db.trips.filter((x) => x.userId === u.id && x.status === 'ACTIVE')) { t.status = 'REPLACED'; t.endedAt = this.iso(); }
    const t = {
      id: this.deps.uuid(), userId: u.id, token: (this.deps.uuid() + this.deps.uuid()).replace(/-/g, '').slice(0, 32), status: 'ACTIVE',
      destination: { lat: +Number(destination.lat).toFixed(5), lng: +Number(destination.lng).toFixed(5), label: String(destination.label || 'Destination').slice(0, 60) },
      vehicle: String(vehicle || '').toUpperCase().replace(/[^A-Z0-9 -]/g, '').slice(0, 20), note: String(note || '').slice(0, 140),
      startedAt: this.iso(), dueAt: this.iso(this.now() + mins * 60000), expectedMin: mins, last: null, points: [], checkPromptAt: null, endedAt: null, smsStartAt: null, smsEndAt: null, incidentId: null,
    };
    if (location && isValidLatLng(location.lat, location.lng)) this.tripPoint(t, location);
    this.db.trips.push(t);
    this.audit(u.id, 'TRIP_STARTED', 'trip', t.id, null, { expectedMin: mins, vehicle: !!t.vehicle });
    return this.tripView(t);
  },

  tripPoint(t, loc) {
    t.last = { lat: +loc.lat.toFixed(5), lng: +loc.lng.toFixed(5), accuracyM: Math.round(loc.accuracyM || 0), at: this.iso() };
    t.points.push({ lat: t.last.lat, lng: t.last.lng, at: t.last.at });
    if (t.points.length > 60) t.points.splice(0, t.points.length - 60);
    if (t.status === 'ACTIVE' && haversineKm(t.last, t.destination) * 1000 <= Math.max(200, Math.min(500, loc.accuracyM || 0))) this.finishTrip(t, 'ARRIVED', 'Reached destination (automatic)');
  },

  finishTrip(t, status, reason) {
    t.status = status; t.endedAt = this.iso();
    this.audit(t.userId, 'TRIP_' + status, 'trip', t.id, reason);
    this.notify(null, t.userId, 'TRIP_ENDED', { status });
  },

  myTrip(actor) {
    const u = this.requireRole(actor, 'user');
    const t = [...(this.db.trips || [])].reverse().find((x) => x.userId === u.id);
    return { trip: t ? this.tripView(t) : null };
  },

  endTrip(actor, { safe = true } = {}) {
    const u = this.requireRole(actor, 'user');
    const t = (this.db.trips || []).find((x) => x.userId === u.id && x.status === 'ACTIVE');
    if (!t) this.fail(404, 'NO_TRIP', 'No active trip');
    this.finishTrip(t, safe ? 'ARRIVED' : 'ENDED', safe ? 'She marked herself safe' : 'Ended by her');
    return { trip: this.tripView(t) };
  },

  extendTrip(actor, { minutes = 15 } = {}) {
    const u = this.requireRole(actor, 'user');
    const t = (this.db.trips || []).find((x) => x.userId === u.id && x.status === 'ACTIVE');
    if (!t) this.fail(404, 'NO_TRIP');
    const m = Math.min(120, Math.max(5, Math.round(Number(minutes) || 15)));
    t.dueAt = this.iso(Math.max(Date.parse(t.dueAt), this.now()) + m * 60000); t.checkPromptAt = null;
    this.audit(u.id, 'TRIP_EXTENDED', 'trip', t.id, null, { minutes: m });
    return { trip: this.tripView(t) };
  },

  tripView(t) { const { token, points, ...rest } = t; return { ...rest, shareUrlPath: `/t/${token}`, pointsCount: points.length }; },

  // Public view for her contacts via the shared link (no login, ends with the trip).
  publicTrip(token) {
    const t = (this.db.trips || []).find((x) => x.token === token);
    if (!t) return null;
    const live = t.status === 'ACTIVE' || (t.status === 'SOS' && this.db.incidents.some((i) => i.id === t.incidentId && this.isOpen(i)));
    const endedLongAgo = t.endedAt && this.now() - Date.parse(t.endedAt) > 3600e3;
    if (!live && endedLongAgo) return { expired: true };
    const u = this.user(t.userId);
    return { name: String(u?.displayName || 'She').split(' ')[0], status: t.status, live, destination: t.destination.label, vehicle: t.vehicle, startedAt: t.startedAt, dueAt: t.dueAt, last: live ? t.last : null, endedAt: t.endedAt };
  },

  tripTick(now) {
    const changed = [];
    for (const t of (this.db.trips || [])) {
      if (t.status !== 'ACTIVE') continue;
      const overdue = now - Date.parse(t.dueAt) - this.cfg.tripGraceMin * 60000;
      if (overdue > 0 && !t.checkPromptAt) {
        t.checkPromptAt = this.iso();
        this.notify(null, t.userId, 'TRIP_OVERDUE', { seconds: this.cfg.tripCheckSec });
        this.audit('system', 'TRIP_OVERDUE_CHECK', 'trip', t.id);
        changed.push(t.id);
      } else if (t.checkPromptAt && now - Date.parse(t.checkPromptAt) > this.cfg.tripCheckSec * 1000) {
        // No answer: start the SOS for her automatically.
        const r = this.createIncident({ id: t.userId }, { idempotencyKey: 'trip-' + t.id, location: t.last ? { ...t.last, accuracyM: t.last.accuracyM || 50, source: 'gps', observedAt: t.last.at } : null, trigger: 'trip_overdue', note: `Did not reach "${t.destination.label}" on time${t.vehicle ? ` · vehicle ${t.vehicle}` : ''}` });
        t.status = 'SOS'; t.incidentId = r.incident.id; t.endedAt = this.iso();
        this.audit('system', 'TRIP_AUTO_SOS', 'trip', t.id, null, { incidentId: r.incident.id });
        changed.push(t.id);
      }
    }
    return changed;
  },

  // ================= live SOS link for her contacts =================
  // The phone makes the token (so the link can go out in an SMS even with no internet);
  // the server accepts it if it is a fresh 128-bit hex value, otherwise makes its own.
  addShareToken(inc, token) {
    inc.shareTokens ||= [];
    const ok = typeof token === 'string' && /^[a-f0-9]{32}$/.test(token) && !this.db.incidents.some((i) => i.shareTokens?.includes(token));
    if (ok) inc.shareTokens.push(token);
    else if (!inc.shareTokens.length) inc.shareTokens.push((this.deps.uuid() + this.deps.uuid()).replace(/-/g, '').slice(0, 32));
    return inc.shareTokens.at(-1);
  },
  shareTokenFor(incId) { return this.db.incidents.find((i) => i.id === incId)?.shareTokens?.[0] || null; },

  // What her contacts see at /s/<token>: live position while the SOS is open, then only the outcome.
  publicSos(token) {
    if (!/^[a-f0-9]{32}$/.test(String(token))) return null;
    const inc = this.db.incidents.find((i) => i.shareTokens?.includes(token));
    if (!inc) return null;
    const name = String(this.user(inc.requesterId)?.displayName || 'She').split(' ')[0];
    // Duress PIN: her screen says "cancelled", so this page must say the same (it may be seen by the attacker).
    if (inc.duress) return { name, status: 'ENDED', live: false, startedAt: inc.createdAt, message: 'The SOS was cancelled from her phone. If you are worried, call her — or call 112.' };
    const open = this.isOpen(inc);
    if (!open && inc.closedAt && this.now() - Date.parse(inc.closedAt) > 24 * 3600e3) return { expired: true };
    const loc = open ? this.latestLocation(inc.id) : null;
    const asg = this.activeAssignments(inc.id);
    const tracks = asg.map((a, i) => this.responderTrack(a, loc, i));
    const coming = tracks.filter((x) => x.approxEtaMin != null && x.approxEtaMin > 0).sort((a, b) => a.approxEtaMin - b.approxEtaMin);
    return {
      name, live: open, startedAt: inc.createdAt, closedAt: inc.closedAt,
      status: open ? 'ACTIVE' : this.isProtected(inc) ? 'SAFE' : 'ENDED',
      last: loc ? { lat: +loc.lat.toFixed(5), lng: +loc.lng.toFixed(5), accuracyM: loc.accuracyM, at: loc.observedAt } : null,
      responders: { coming: coming.length, arrived: tracks.filter((x) => x.approxEtaMin === 0).length, nearestEtaMin: coming[0]?.approxEtaMin ?? null },
      police: inc.policeConnect?.station ? { name: inc.policeConnect.station.name, phone: inc.policeConnect.station.phone } : inc.policeConnect ? { name: null, phone: inc.policeConnect.emergency } : null,
      emergency: COUNTRIES[inc.countryCode]?.emergency || '112',
    };
  },

  // ================= evidence (metadata; bytes stored encrypted by the server) =================
  canSeeEvidence(actor, inc) {
    const u = this.user(actor?.id);
    if (!u || u.status !== 'ACTIVE') return false;
    return (u.role === 'user' && inc.requesterId === u.id) || ['operator', 'admin'].includes(u.role);
  },

  addEvidence(actor, incidentId, { kind, mime, durationSec, bytes, storageKey }) {
    const u = this.requireRole(actor, 'user');
    const inc = this.incident(incidentId);
    if (inc.requesterId !== u.id) this.fail(403, 'FORBIDDEN');
    this.db.evidence ||= [];
    if (this.db.evidence.filter((e) => e.incidentId === inc.id).length >= 10) this.fail(409, 'EVIDENCE_LIMIT', 'Up to 10 recordings per SOS');
    const e = { id: this.deps.uuid(), incidentId: inc.id, kind: kind === 'video' ? 'video' : 'audio', mime: String(mime).slice(0, 60), durationSec: Math.round(Number(durationSec) || 0), bytes, storageKey, createdAt: this.iso(), hold: false };
    this.db.evidence.push(e);
    this.audit(u.id, 'EVIDENCE_UPLOADED', 'incident', inc.id, null, { kind: e.kind, bytes, durationSec: e.durationSec });
    for (const op of this.db.users.filter((x) => ['operator', 'admin'].includes(x.role) && x.status === 'ACTIVE')) this.notify(inc.id, op.id, 'EVIDENCE', { kind: e.kind, durationSec: e.durationSec });
    this.emit('evidence.added', inc.id);
    return { id: e.id, kind: e.kind, createdAt: e.createdAt };
  },

  evidenceFor(actor, incidentId, evidenceId) {
    const inc = this.incident(incidentId);
    if (!this.canSeeEvidence(actor, inc)) { this.audit(actor?.id, 'EVIDENCE_ACCESS_DENIED', 'incident', inc.id); this.fail(403, 'FORBIDDEN'); }
    const e = (this.db.evidence || []).find((x) => x.id === evidenceId && x.incidentId === inc.id);
    if (!e) this.fail(404, 'NOT_FOUND');
    this.audit(actor.id, 'EVIDENCE_ACCESSED', 'incident', inc.id, null, { evidenceId: e.id });
    return e;
  },

  evidenceList(incId) { return (this.db.evidence || []).filter((e) => e.incidentId === incId).map((e) => ({ id: e.id, kind: e.kind, mime: e.mime, durationSec: e.durationSec, createdAt: e.createdAt })); },

  // Returns storage keys whose retention ran out (server deletes the files).
  expiredEvidence(now = this.now()) {
    const limit = this.cfg.evidenceRetentionDays * 864e5;
    const out = [];
    this.db.evidence = (this.db.evidence || []).filter((e) => {
      const inc = this.db.incidents.find((i) => i.id === e.incidentId);
      const keep = e.hold || (inc && this.isOpen(inc)) || now - Date.parse(e.createdAt) < limit;
      if (!keep) out.push(e.storageKey);
      return keep;
    });
    return out;
  },

  // ================= dashboards =================
  incidentTimes(inc) {
    const asg = this.db.assignments.filter((a) => a.incidentId === inc.id);
    const t0 = Date.parse(inc.createdAt);
    const firstAccept = asg.map((a) => Date.parse(a.acceptedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    const firstArrive = asg.map((a) => Date.parse(a.arrivedAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    return { acceptMin: firstAccept ? (firstAccept - t0) / 60000 : null, arriveMin: firstArrive ? (firstArrive - t0) / 60000 : null, ackSec: inc.opAckAt ? (Date.parse(inc.opAckAt) - t0) / 1000 : null };
  },

  isProtected(inc) { return SAFE_CLOSURES.has(inc.closureReason) && !inc.duress; },

  myDashboard(actor) {
    const u = this.requireRole(actor, 'user');
    const mine = this.db.incidents.filter((i) => i.requesterId === u.id && !i.duress);
    const trips = (this.db.trips || []).filter((t) => t.userId === u.id);
    const times = mine.map((i) => this.incidentTimes(i));
    const anchor = u.places?.[0] || null;
    const since = this.now() - 30 * 864e5;
    const area = anchor ? this.db.incidents.filter((i) => Date.parse(i.createdAt) > since && !i.duress && (() => { const l = this.latestLocation(i.id); return l && haversineKm(l, anchor) <= 10; })()) : [];
    const areaTimes = area.map((i) => this.incidentTimes(i)).map((t) => t.arriveMin).filter((x) => x != null);
    const onDutyNear = anchor ? this.db.volunteers.filter((v) => this.volunteerEligibility(v).eligible && haversineKm(v.lastLocation, anchor) <= 10).length : null;
    return {
      sos: { total: mine.length, safe: mine.filter((i) => this.isProtected(i)).length, open: mine.filter((i) => this.isOpen(i)).length, medianAcceptMin: round1(median(times.map((t) => t.acceptMin).filter((x) => x != null))), medianArriveMin: round1(median(times.map((t) => t.arriveMin).filter((x) => x != null))) },
      trips: {
        total: trips.length, arrived: trips.filter((t) => t.status === 'ARRIVED').length, autoSos: trips.filter((t) => t.status === 'SOS').length,
        stopped: trips.filter((t) => t.status === 'ENDED' || t.status === 'REPLACED').length, active: trips.filter((t) => t.status === 'ACTIVE').length,
        recent: trips.slice(-10).reverse().map((t) => ({ destination: t.destination.label, startedAt: t.startedAt, endedAt: t.endedAt, status: t.status })),
      },
      setup: { places: (u.places || []).length, placesReady: (u.places || []).filter((p) => p.contacts.length >= 1).length, defaultContacts: (u.contacts || []).length, alwaysContacts: (u.contacts || []).filter((c) => c.always).length, pins: !!u.pins, phone: !!u.phone },
      area: anchor ? { label: anchor.label, radiusKm: 10, sos30d: area.length, protected30d: area.filter((i) => this.isProtected(i)).length, medianArriveMin: round1(median(areaTimes)), volunteersOnDutyNow: onDutyNear } : null,
      community: this.publicImpact(),
      history: mine.slice(-10).reverse().map((i) => ({ id: i.id, createdAt: i.createdAt, status: i.status, protected: this.isProtected(i), trigger: i.trigger, ...this.incidentTimes(i) })),
    };
  },

  publicImpact() {
    const women = this.db.users.filter((u) => u.role === 'user' && u.status === 'ACTIVE').length;
    const real = this.db.incidents.filter((i) => !i.duress || !this.isOpen(i));
    const protectedCount = this.db.incidents.filter((i) => this.isProtected(i)).length;
    const safeTrips = (this.db.trips || []).filter((t) => t.status === 'ARRIVED').length;
    const vols = this.db.volunteers.filter((v) => v.verificationStatus === 'VERIFIED' && !v.suspendedReason);
    const arrive = real.map((i) => this.incidentTimes(i).arriveMin).filter((x) => x != null);
    return { womenRegistered: women, womenProtected: protectedCount, safeTrips, volunteersVerified: vols.length, volunteersOnDutyNow: vols.filter((v) => this.volunteerEligibility(v).eligible).length, medianArriveMin: round1(median(arrive)) };
  },

  adminDashboard(actor, { days = 30 } = {}) {
    this.requireRole(actor, 'admin', 'operator');
    const d = Math.min(365, Math.max(7, Math.round(Number(days) || 30)));
    const since = this.now() - d * 864e5;
    const incs = this.db.incidents.filter((i) => Date.parse(i.createdAt) > since);
    const times = incs.map((i) => this.incidentTimes(i));
    const series = {};
    for (let k = d - 1; k >= 0; k--) series[day(this.iso(this.now() - k * 864e5))] = { sos: 0, protected: 0, police: 0 };
    for (const i of incs) { const s = series[day(i.createdAt)]; if (!s) continue; s.sos++; if (this.isProtected(i)) s.protected++; if (this.policeCallMade(i)) s.police++; }
    const byTrigger = {}; for (const i of incs) byTrigger[i.trigger] = (byTrigger[i.trigger] || 0) + 1;
    const closed = incs.filter((i) => !this.isOpen(i));
    const outcome = { protected: closed.filter((i) => this.isProtected(i)).length, cancelled: closed.filter((i) => i.status === 'USER_CANCELLED' || i.closureReason === 'USER_CANCELLED').length, falseAlarm: closed.filter((i) => i.closureReason === 'VERIFIED_FALSE_ALARM').length, other: 0 };
    outcome.other = closed.length - outcome.protected - outcome.cancelled - outcome.falseAlarm;
    const newWomen = this.db.users.filter((u) => u.role === 'user' && Date.parse(u.createdAt) > since).length;
    return {
      days: d, impact: this.publicImpact(),
      period: {
        sos: incs.length, open: incs.filter((i) => this.isOpen(i)).length, protected: outcome.protected, newWomen,
        policeAutoConnects: incs.filter((i) => this.policeCallMade(i)).length, policeAttempts: incs.filter((i) => i.policeConnect).length, tripsAutoSos: (this.db.trips || []).filter((t) => t.status === 'SOS' && Date.parse(t.startedAt) > since).length,
        medianAckSec: round1(median(times.map((t) => t.ackSec).filter((x) => x != null))), unacknowledged: incs.filter((i) => !i.opAckAt).length,
        medianAcceptMin: round1(median(times.map((t) => t.acceptMin).filter((x) => x != null))), medianArriveMin: round1(median(times.map((t) => t.arriveMin).filter((x) => x != null))),
      },
      outcome, byTrigger, series: Object.entries(series).map(([date, v]) => ({ date, ...v })),
      stations: (this.db.policeStations || []).length,
    };
  },
};

function splitCsv(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
