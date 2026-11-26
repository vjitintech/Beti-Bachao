// Live map: her location and the responders coming to her, as dots that glide along a real
// street map. Leaflet is bundled in /vendor/leaflet and only loaded when a live map is on
// screen. Map tiles default to OpenStreetMap; set MAP_TILE_URL on the server for a paid
// or keyed provider. If Leaflet or the tiles can't load, the old Google map is shown instead.
import { esc } from './ui.js?v=mwxjyzqb';

const GLIDE_MS = 4500;      // a dot travels from its old to its new position over this long
let leaflet = null, loading = null, failed = false;
const maps = new Map();     // key -> state (map survives screen refreshes)
const fellBack = new Set(); // maps whose tiles failed: they stay on the Google map

function loadLeaflet() {
  if (leaflet || failed) return Promise.resolve(leaflet);
  if (loading) return loading;
  loading = new Promise((resolve) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = 'vendor/leaflet/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'vendor/leaflet/leaflet.js';
    js.onload = () => { leaflet = window.L || null; failed = !leaflet; resolve(leaflet); };
    js.onerror = () => { failed = true; resolve(null); };
    document.head.appendChild(js);
  });
  return loading;
}

/**
 * Placeholder for a live map. `data` = { her:{lat,lng,accuracyM}, items:[{ref, kind, lat, lng, id,
 * label, dist, etaMin, etaText, stale, onScene, track:[[lat,lng]…]}], fallback: html }.
 * The map element itself is never re-rendered (data-live), only the data attribute next to it.
 */
export function liveMapHtml(key, data, { tall = false } = {}) {
  return `<div class="livemap-wrap ${tall ? 'livemap-tall' : ''}">
    <div class="livemap" data-live="map" data-map="${esc(key)}" role="img" aria-label="Map of her location and the responders coming to her"></div>
    <i hidden data-mapdata="${esc(key)}" data-json="${esc(JSON.stringify(data))}"></i>
    <button type="button" class="btn btn-ghost btn-sm livemap-centre" data-act="map-recentre" data-key="${esc(key)}">⌖ Re-centre</button>
  </div>`;
}

const kindClass = (it) => `lm-${it.kind || 'responder'}${it.stale ? ' lm-stale' : ''}${it.onScene ? ' lm-onscene' : ''}`;
const tagHtml = (it) => {
  if (it.kind === 'alerted' || it.kind === 'declined') return '';
  const eta = it.etaText ? (it.ref && it.etaMin != null ? `<b data-live="eta" data-k="${esc(it.ref)}" data-min="${esc(it.etaMin)}">${esc(it.etaText)}</b>` : `<b>${esc(it.etaText)}</b>`) : '';
  return `<span class="lm-tag">${esc(it.id || '')}${it.dist ? ` · ${esc(it.dist)}` : ''}${eta ? ` · ${eta}` : ''}${it.stale ? ' · <i>last seen</i>' : ''}</span>`;
};

function makeIcon(L, it) {
  return L.divIcon({ className: `lm-pin ${kindClass(it)}`, html: `<span class="lm-dot"></span>${tagHtml(it)}`, iconSize: [0, 0] });
}

function ensureMap(L, host, key, data, tiles) {
  let s = maps.get(key);
  if (s && s.box.parentElement !== host) {            // screen was fully redrawn: move the map over
    host.appendChild(s.box);
    setTimeout(() => s.map.invalidateSize(), 0);
  }
  if (s) return s;
  const box = document.createElement('div');
  box.className = 'livemap-box';
  host.appendChild(box);
  const map = L.map(box, { zoomControl: true, attributionControl: true, scrollWheelZoom: false, tap: true });
  const layer = L.tileLayer(tiles.url, { maxZoom: 19, attribution: tiles.attribution, referrerPolicy: 'strict-origin-when-cross-origin' });
  let tileErrors = 0, tileOk = 0;
  layer.on('tileload', () => { tileOk++; });
  // No tile has ever loaded and several failed (blocked network, provider down): use the Google map.
  layer.on('tileerror', () => { if (++tileErrors >= 3 && tileOk === 0) fallBack(key); });
  setTimeout(() => { if (tileErrors > 0 && tileOk === 0 && maps.get(key)?.map === map) fallBack(key); }, 8000);
  layer.addTo(map);
  s = { key, box, map, items: new Map(), her: null, acc: null, trails: new Map(), userMoved: false, prog: false, fitCount: -1, lastJson: '' };
  map.on('movestart zoomstart', () => { if (!s.prog) s.userMoved = true; });
  maps.set(key, s);
  return s;
}

function fallBack(key) {
  const s = maps.get(key);
  const host = document.querySelector(`[data-map="${CSS.escape(key)}"]`);
  const data = readData(key);
  if (s) { try { s.map.remove(); } catch {} maps.delete(key); }
  fellBack.add(key);
  if (host && data?.fallback) host.innerHTML = data.fallback;
}

function readData(key) {
  const el = document.querySelector(`[data-mapdata="${CSS.escape(key)}"]`);
  if (!el) return null;
  try { return { json: el.dataset.json, ...JSON.parse(el.dataset.json) }; } catch { return null; }
}

function fit(s, data) {
  const L = leaflet;
  const pts = [[data.her.lat, data.her.lng], ...data.items.filter((i) => i.kind !== 'alerted' && i.kind !== 'declined').map((i) => [i.lat, i.lng])];
  s.prog = true;
  if (pts.length === 1) s.map.setView(pts[0], 16);
  else s.map.fitBounds(L.latLngBounds(pts), { padding: [46, 46], maxZoom: 17 });
  setTimeout(() => { s.prog = false; }, 400);
}

function update(s, data) {
  const L = leaflet, now = performance.now();
  // Her: pulsing red dot + accuracy circle.
  const herLL = [data.her.lat, data.her.lng];
  if (!s.her) {
    s.her = L.marker(herLL, { icon: L.divIcon({ className: 'lm-pin lm-her', html: '<span class="lm-pulse"></span><span class="lm-dot"></span>', iconSize: [0, 0] }), zIndexOffset: 1000, keyboard: false }).addTo(s.map);
    s.acc = L.circle(herLL, { radius: Math.max(15, data.her.accuracyM || 30), className: 'lm-acc', interactive: false }).addTo(s.map);
  } else { s.her.setLatLng(herLL); s.acc.setLatLng(herLL); s.acc.setRadius(Math.max(15, data.her.accuracyM || 30)); }
  // Responders / alerted volunteers.
  const seen = new Set();
  for (const it of data.items) {
    const k = it.ref || `${it.kind}:${it.lat},${it.lng}`;
    seen.add(k);
    let m = s.items.get(k);
    const icon = makeIcon(L, it);
    const iconKey = icon.options.className + icon.options.html;
    if (!m) {
      const marker = L.marker([it.lat, it.lng], { icon, keyboard: false, zIndexOffset: it.kind === 'alerted' || it.kind === 'declined' ? -100 : 500 }).addTo(s.map);
      m = { marker, from: [it.lat, it.lng], to: [it.lat, it.lng], t0: now, iconKey };
      s.items.set(k, m);
    } else {
      if (m.iconKey !== iconKey) { m.marker.setIcon(icon); m.iconKey = iconKey; }
      if (m.to[0] !== it.lat || m.to[1] !== it.lng) { m.from = current(m, now); m.to = [it.lat, it.lng]; m.t0 = now; }
    }
    if (it.track?.length) {
      const line = [...it.track, [it.lat, it.lng]];
      let t = s.trails.get(k);
      if (!t) { t = L.polyline(line, { className: 'lm-trail', interactive: false }).addTo(s.map); s.trails.set(k, t); } else t.setLatLngs(line);
    }
  }
  for (const [k, m] of s.items) if (!seen.has(k)) { m.marker.remove(); s.items.delete(k); s.trails.get(k)?.remove(); s.trails.delete(k); }
  // Fit everyone in view the first time, and again when someone new appears — unless she moved the map.
  const count = data.items.filter((i) => i.kind !== 'alerted' && i.kind !== 'declined').length;
  if (s.fitCount < 0 || (!s.userMoved && count !== s.fitCount)) { fit(s, data); s.fitCount = count; }
}

function current(m, now) {
  const p = Math.min(1, (now - m.t0) / GLIDE_MS), e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
  return [m.from[0] + (m.to[0] - m.from[0]) * e, m.from[1] + (m.to[1] - m.from[1]) * e];
}

/** Create / feed every live map on screen. Cheap to call often: does nothing if data is unchanged. */
export async function syncMaps(tiles) {
  const hosts = [...document.querySelectorAll('[data-live="map"][data-map]')];
  for (const [key, s] of maps) {
    if (!document.body.contains(s.box) && !hosts.some((h) => h.dataset.map === key)) { try { s.map.remove(); } catch {} maps.delete(key); }
  }
  if (!hosts.length) return;
  const L = await loadLeaflet();
  for (const host of hosts) {
    const key = host.dataset.map;
    const data = readData(key);
    if (!data?.her) continue;
    if (!L || fellBack.has(key)) { if (!host.firstChild && data.fallback) host.innerHTML = data.fallback; continue; }
    const s = ensureMap(L, host, key, data, tiles);
    if (s.box.offsetWidth && s.lastWidth !== s.box.offsetWidth) { s.lastWidth = s.box.offsetWidth; s.map.invalidateSize(); }
    if (s.lastJson === data.json) continue;
    s.lastJson = data.json;
    update(s, data);
  }
}

/** One animation frame: glide every responder dot towards its latest position. */
export function animateMaps(now) {
  for (const s of maps.values()) for (const m of s.items.values()) {
    if (now - m.t0 > GLIDE_MS + 50) continue;
    m.marker.setLatLng(current(m, now));
  }
}

export function recentre(key) {
  const s = maps.get(key); const data = readData(key);
  if (!s || !data) return;
  s.userMoved = false; fit(s, data);
}
