// Geospatial helpers. Distances are great-circle (haversine) — a real,
// documented spatial abstraction. Production target: PostGIS ST_DWithin on
// geography columns (see db/migrations/001_init.sql). Nothing here is faked.

const R_KM = 6371.0088;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function isValidLatLng(lat, lng) {
  return (
    typeof lat === 'number' && typeof lng === 'number' &&
    Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
  );
}

// Snap to a coarse grid so unassigned volunteers only learn the general area.
export function approxPoint(lat, lng, gridDeg = 0.02) {
  const snap = (v) => Math.round(v / gridDeg) * gridDeg;
  return { lat: +snap(lat).toFixed(4), lng: +snap(lng).toFixed(4), uncertaintyKm: +(gridDeg * 111 * 0.75).toFixed(1) };
}

export function distanceBand(km) {
  if (km == null || !Number.isFinite(km)) return 'unknown';
  if (km < 1) return '< 1 km';
  if (km < 2) return '1–2 km';
  if (km < 5) return '2–5 km';
  if (km < 10) return '5–10 km';
  if (km < 20) return '10–20 km';
  if (km < 30) return '20–30 km';
  return '> 30 km';
}

// Straight-line estimate only. Always labelled "approximate" in the UI;
// a routing provider adapter can replace it with a road-network ETA.
export function approxEtaMinutes(km, cfg) {
  if (km == null || !Number.isFinite(km)) return null;
  const roadKm = km * (cfg.roadFactor || 1.4);
  const mins = (roadKm / (cfg.responderSpeedKmh || 25)) * 60;
  return Math.max(1, Math.round(mins));
}

// Implied travel speed between two observations — used to flag spoofed/outlier GPS.
export function impliedSpeedKmh(prev, next) {
  const hours = (Date.parse(next.observedAt) - Date.parse(prev.observedAt)) / 3.6e6;
  const km = haversineKm(prev, next);
  if (hours <= 0) return km > 0.5 ? Infinity : 0;
  return km / hours;
}

// Initial great-circle bearing from a to b, degrees clockwise from true north (0–359).
export function bearingDeg(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}
