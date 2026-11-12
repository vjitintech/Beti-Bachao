// Road-route ETA for responders on the radar. Providers, best first:
//   1. Google Routes API (GOOGLE_MAPS_API_KEY) — follows real roads and uses LIVE traffic,
//      closures and incidents (routingPreference TRAFFIC_AWARE).
//   2. OSRM (ROUTING_URL, default the public OSRM server) — real road network from OpenStreetMap,
//      no live traffic, so the free-flow time is multiplied by a traffic factor (ROUTING_TRAFFIC_FACTOR,
//      default 1.3; peak hours in Indian cities are slower — set what matches your city).
// Set ROUTING_URL=off to disable routing (the app then shows the straight-line estimate, labelled as such).
// Results are cached per (from, to) cell for 45 s so a crowded SOS never floods the provider.
const PUBLIC_OSRM = 'https://router.project-osrm.org';

export function createRouting(env, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const off = String(env.ROUTING_URL || '').toLowerCase() === 'off';
  const googleKey = env.GOOGLE_MAPS_API_KEY || env.GOOGLE_ROUTES_API_KEY || '';
  if (off && !googleKey) return null;
  const osrmBase = off ? '' : (env.ROUTING_URL || PUBLIC_OSRM).replace(/\/$/, '');
  const factor = Math.min(3, Math.max(1, Number(env.ROUTING_TRAFFIC_FACTOR) || 1.3));
  const mode = String(env.ROUTING_MODE || 'TWO_WHEELER').toUpperCase(); // most volunteers ride a scooter/bike
  const timeout = (ms) => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  const cache = new Map();
  const cell = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`; // ~11 m

  async function google(from, to, travelMode) {
    const ll = (p) => ({ location: { latLng: { latitude: p.lat, longitude: p.lng } } });
    const res = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST', signal: timeout(8000),
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': googleKey, 'X-Goog-FieldMask': 'routes.duration,routes.staticDuration,routes.distanceMeters' },
      body: JSON.stringify({ origin: ll(from), destination: ll(to), travelMode, routingPreference: 'TRAFFIC_AWARE', units: 'METRIC' }),
    });
    if (res.status < 200 || res.status >= 300) return null;
    const j = await res.json();
    const r = j.routes?.[0];
    const sec = parseFloat(r?.duration);
    if (!r || !Number.isFinite(sec)) return null;
    const free = parseFloat(r.staticDuration);
    return { min: sec / 60, km: +((r.distanceMeters || 0) / 1000).toFixed(1), source: 'google', traffic: true, delayMin: Number.isFinite(free) ? Math.max(0, Math.round((sec - free) / 60)) : null };
  }

  async function osrm(from, to) {
    const url = `${osrmBase}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false&alternatives=false`;
    const res = await fetchImpl(url, { signal: timeout(8000), headers: { 'User-Agent': 'BetiBachao/1.0 (safety app)' } });
    const j = await res.json();
    const r = j.routes?.[0];
    if (j.code !== 'Ok' || !r) return null;
    return { min: (r.duration / 60) * factor, km: +(r.distance / 1000).toFixed(1), source: 'osrm', traffic: false };
  }

  return {
    provider: googleKey ? 'google' : 'osrm',
    describe: googleKey ? 'Google Routes — live traffic, closures and incidents' : `OSRM road network (${osrmBase === PUBLIC_OSRM ? 'public server' : 'your server'}) × ${factor} traffic factor`,
    async eta(from, to) {
      const key = `${cell(from)}>${cell(to)}`;
      const hit = cache.get(key);
      if (hit && now() - hit.at < 45000) return hit.r;
      let r = null;
      try { if (googleKey) r = await google(from, to, mode); } catch { r = null; }
      if (!r && googleKey && mode !== 'DRIVE') { try { r = await google(from, to, 'DRIVE'); } catch { r = null; } } // TWO_WHEELER isn't offered everywhere
      if (!r && osrmBase) { try { r = await osrm(from, to); } catch { r = null; } }
      if (r) { cache.set(key, { at: now(), r }); if (cache.size > 500) cache.delete(cache.keys().next().value); }
      return r;
    },
  };
}
