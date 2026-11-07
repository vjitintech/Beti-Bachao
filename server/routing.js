// Road-route ETA via any OSRM-compatible server (ROUTING_URL), e.g. a self-hosted
// OSRM with the India extract from OpenStreetMap. Without it the app shows the
// straight-line estimate, always labelled as such.
export function createRouting(env, { fetchImpl = fetch } = {}) {
  const base = (env.ROUTING_URL || '').replace(/\/$/, '');
  if (!base) return null;
  return {
    async eta(from, to) {
      const url = `${base}/route/v1/driving/${from.lng},${from.lat};${to.lng},${to.lat}?overview=false&alternatives=false`;
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
        const j = await res.json();
        const r = j.routes?.[0];
        if (j.code !== 'Ok' || !r) return null;
        return { min: r.duration / 60, km: +(r.distance / 1000).toFixed(1), source: 'osrm' };
      } catch { return null; }
    },
  };
}
