// Synthetic demo data only. Fictional names, no real phone numbers or addresses.
// Default centre: Kurnool, Andhra Pradesh (proposed pilot region).

export const DEMO_CENTER = { lat: 15.8281, lng: 78.0373, label: 'Kurnool (synthetic demo area)' };
export const DEMO_PASSWORD = 'demo1234';

// One-line role descriptions for the demo login screen (max 30 characters).
export const DEMO_BLURBS = {
  'aamani@demo.betibachao.app': 'Woman who raises the SOS',
  'asha@demo.betibachao.app': 'Verified · 3 km · 1st ring',
  'ravi@demo.betibachao.app': 'Verified · 7.5 km · 1st ring',
  'meena@demo.betibachao.app': 'Verified · 14 km · 2nd ring',
  'imran@demo.betibachao.app': 'Verified · 24 km · 3rd ring',
  'kiran@demo.betibachao.app': 'Not verified · never alerted',
  'deepa@demo.betibachao.app': 'Training pending · no alerts',
  'suresh@demo.betibachao.app': 'Off duty · no alerts',
  'operator@demo.betibachao.app': 'Monitors & escalates SOS',
  'admin@demo.betibachao.app': 'Approves volunteers, rules',
};

// bearing in degrees, distance in km from centre
const VOLUNTEERS = [
  { name: 'Asha (demo volunteer)', email: 'asha@demo.betibachao.app', km: 3, brg: 40, verified: true, trained: true, available: true },
  { name: 'Ravi (demo volunteer)', email: 'ravi@demo.betibachao.app', km: 7.5, brg: 200, verified: true, trained: true, available: true },
  { name: 'Meena (demo volunteer)', email: 'meena@demo.betibachao.app', km: 14, brg: 120, verified: true, trained: true, available: true },
  { name: 'Imran (demo volunteer)', email: 'imran@demo.betibachao.app', km: 24, brg: 300, verified: true, trained: true, available: true },
  { name: 'Kiran (unverified)', email: 'kiran@demo.betibachao.app', km: 2, brg: 90, verified: false, trained: true, available: true },
  { name: 'Deepa (training pending)', email: 'deepa@demo.betibachao.app', km: 2.5, brg: 10, verified: true, trained: false, available: true },
  { name: 'Suresh (off duty)', email: 'suresh@demo.betibachao.app', km: 1.5, brg: 250, verified: true, trained: true, available: false },
];

export function offset(center, km, bearingDeg) {
  const R = 6371.0088, br = (bearingDeg * Math.PI) / 180, d = km / R;
  const lat1 = (center.lat * Math.PI) / 180, lng1 = (center.lng * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br));
  const lng2 = lng1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: +((lat2 * 180) / Math.PI).toFixed(6), lng: +((lng2 * 180) / Math.PI).toFixed(6) };
}

export function seedDemo(engine, { passwordHash = null, mfaSecret = null } = {}) {
  const mk = (displayName, email, role, extra = {}) => engine.createUser({ displayName, email, role, passwordHash, demo: true, countryCode: 'IN', ...extra });
  const aamani = mk('Aamani (demo user)', 'aamani@demo.betibachao.app', 'user');
  for (const v of VOLUNTEERS) {
    const u = mk(v.name, v.email, 'volunteer');
    const p = engine.vol(u.id);
    p.demoKm = v.km; p.demoBearing = v.brg;
    if (v.verified) { p.verificationStatus = 'VERIFIED'; p.verificationExpiresAt = engine.iso(engine.now() + 365 * 864e5); }
    if (v.trained) p.trainingCompleted = ['code-of-conduct', 'de-escalation', 'emergency-calling', 'privacy', 'safe-handover'];
    p.available = v.available;
    p.lastLocation = { ...offset(DEMO_CENTER, v.km, v.brg), accuracyM: 15 };
    p.lastLocationAt = engine.iso();
  }
  mk('Operator Nandini (demo)', 'operator@demo.betibachao.app', 'operator', { mfaSecret });
  mk('Admin Farah (demo)', 'admin@demo.betibachao.app', 'admin', { mfaSecret });
  engine.audit('system', 'DEMO_SEEDED', 'system', 'demo', 'synthetic data only');
  return { aamani };
}

// Keep demo volunteers' locations fresh and optionally move them around a new centre.
export function refreshDemoVolunteers(engine, center = null) {
  const busy = new Set(engine.db.assignments.filter((a) => ['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ASSISTING'].includes(a.status)).map((a) => a.volunteerId));
  for (const v of engine.db.volunteers) {
    const u = engine.user(v.userId);
    if (!u?.demo || v.demoKm == null) continue;
    if (center && !busy.has(v.userId)) v.lastLocation = { ...offset(center, v.demoKm, v.demoBearing), accuracyM: 15 };
    v.lastLocationAt = engine.iso();
  }
}

// Demo only: demo volunteers who are EN_ROUTE drive toward her latest location so
// live distance tracking can be seen. Travel is sped up (DEMO_SPEED_KMH) and labelled.
export const DEMO_SPEED_KMH = 120;
export function simulateDemoMovement(engine) {
  const now = engine.now();
  for (const a of engine.db.assignments) {
    if (a.status !== 'EN_ROUTE') continue;
    const u = engine.user(a.volunteerId);
    const v = engine.vol(a.volunteerId);
    if (!u?.demo || !v?.lastLocation) continue;
    const target = engine.latestLocation(a.incidentId);
    if (!target) continue;
    const last = a.demoMovedAt ? Date.parse(a.demoMovedAt) : now;
    const dt = Math.min(5, Math.max(0, (now - last) / 1000));
    a.demoMovedAt = new Date(now).toISOString();
    const R = 6371.0088, toR = Math.PI / 180;
    const dLat = (target.lat - v.lastLocation.lat) * toR, dLng = (target.lng - v.lastLocation.lng) * toR;
    const distKm = 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(v.lastLocation.lat * toR) * Math.cos(target.lat * toR) * Math.sin(dLng / 2) ** 2));
    const stopKm = 0.04; // stop ~40 m away; the volunteer marks "Arrived" herself
    if (distKm <= stopKm || dt === 0) continue;
    const step = Math.min(distKm - stopKm, (DEMO_SPEED_KMH * dt) / 3600);
    const f = step / distKm;
    v.lastLocation = { lat: +(v.lastLocation.lat + (target.lat - v.lastLocation.lat) * f).toFixed(6), lng: +(v.lastLocation.lng + (target.lng - v.lastLocation.lng) * f).toFixed(6), accuracyM: 12 };
    v.lastLocationAt = new Date(now).toISOString();
    engine.db.responderLocations.push({ id: engine.deps.uuid(), assignmentId: a.id, lat: v.lastLocation.lat, lng: v.lastLocation.lng, accuracyM: 12, observedAt: v.lastLocationAt, demo: true });
    if (engine.db.responderLocations.length > 3000) engine.db.responderLocations.splice(0, 1000);
  }
}
