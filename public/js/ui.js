// Tiny UI toolkit: escaping, toasts, modals, radar map. No framework, no inline
// scripts/styles (strict CSP).

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, kind = 'info', ms = 3500) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// Modal returning a promise. `body` is trusted HTML built with esc().
export function modal({ title, body, actions = [{ id: 'ok', label: 'OK', kind: 'primary' }], dismissable = true, cls = '' }) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `<div class="modal ${esc(cls)}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <h2 id="modal-title">${esc(title)}</h2>
      <div class="modal-body">${body || ''}</div>
      <div class="modal-actions">${actions.map((a) => `<button type="button" class="btn btn-${esc(a.kind || 'ghost')}" data-modal="${esc(a.id)}">${esc(a.label)}</button>`).join('')}</div>
    </div>`;
    const done = (id) => {
      const data = Object.fromEntries($$('input,select,textarea', wrap).map((i) => [i.name, i.type === 'checkbox' ? i.checked : i.value]));
      wrap.remove(); document.removeEventListener('keydown', onKey); resolve({ id, data });
    };
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) done('dismiss'); };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-modal]');
      if (b) done(b.dataset.modal);
      else if (e.target === wrap && dismissable) done('dismiss');
    });
    wrap.addEventListener('submit', (e) => { e.preventDefault(); done(actions[0].id); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    (wrap.querySelector('input,select,textarea') || wrap.querySelector('[data-modal]'))?.focus();
  });
}

export function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
export function ago(sec) {
  if (sec == null) return '—';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

// Relative radar map (no tiles, works offline): incident at centre, search rings,
// markers placed by true bearing/distance. Only rendered for authorised roles.
export function radarSvg({ center, radii = [10, 20, 30], activeStage = null, markers = [], zoomKm = null }) {
  if (zoomKm) { const z = Math.max(0.5, zoomKm); radii = [z / 3, (2 * z) / 3, z].map((r) => +r.toFixed(r < 3 ? 1 : 0)); activeStage = null; }
  const S = 300, C = S / 2, maxR = radii[radii.length - 1];
  const scale = (C - 14) / maxR;
  const toXY = (p) => {
    const dy = (p.lat - center.lat) * 111.32;
    const dx = (p.lng - center.lng) * 111.32 * Math.cos((center.lat * Math.PI) / 180);
    let x = dx * scale, y = -dy * scale;
    const r = Math.hypot(x, y), lim = C - 8;
    if (r > lim) { x = (x / r) * lim; y = (y / r) * lim; }
    return [C + x, C + y];
  };
  const rings = radii.map((r, i) => `<circle cx="${C}" cy="${C}" r="${(r * scale).toFixed(1)}" class="ring ${activeStage === i ? 'ring-active' : ''}"/><text x="${C + 4}" y="${(C - r * scale + 12).toFixed(1)}" class="ring-label">${r < 1 ? Math.round(r * 1000) + ' m' : r + ' km'}</text>`).join('');
  const pins = markers.filter((m) => m.position).map((m) => { const [x, y] = toXY(m.position); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" class="pin pin-${esc(m.kind)}"><title>${esc(m.title || '')}</title></circle>`; }).join('');
  return `<svg viewBox="0 0 ${S} ${S}" class="radar" role="img" aria-label="Relative map of search rings and responders">${rings}<line x1="${C}" y1="6" x2="${C}" y2="${S - 6}" class="axis"/><line x1="6" y1="${C}" x2="${S - 6}" y2="${C}" class="axis"/><text x="${C - 4}" y="16" class="ring-label">N</text>${pins}<circle cx="${C}" cy="${C}" r="8" class="pin pin-incident"/></svg>`;
}

// ---------------------------------------------------------------------------
// PPI (Plan Position Indicator) radar scope: polar display, range = radius,
// bearing = angle (000° = north, clockwise). Black scope, rotating sweep,
// range rings, bearing ring, crosshair axes, red dot = her (scope centre),
// blue dots = volunteers, green = track history. Pure SVG, works offline.
const NICE = [0.25, 0.5, 1, 2, 3, 5, 8, 10, 15, 20, 30, 50, 100];
export const niceRange = (km) => NICE.find((n) => n >= km) || Math.ceil(km / 50) * 50;
// Move `steps` along the nice-range ladder (negative = zoom in / smaller range).
export function stepRange(km, steps) { const i = Math.max(0, NICE.indexOf(niceRange(km))); return NICE[Math.max(0, Math.min(NICE.length - 1, i + steps))]; }
const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} m` : `${+km.toFixed(km < 10 ? 1 : 0)} km`);

export function ppiSvg({ center, rangeKm, rings = null, activeRing = null, targets = [], title = 'PPI' }) {
  const V = 360, C = V / 2, R = 150;
  const range = rangeKm || 1;
  const ringKms = rings || [range / 4, range / 2, (3 * range) / 4, range];
  const k = R / range;
  const cosLat = Math.cos((center.lat * Math.PI) / 180);
  const xy = (p) => {
    let x = (p.lng - center.lng) * 111.32 * cosLat * k, y = -(p.lat - center.lat) * 111.32 * k;
    const r = Math.hypot(x, y);
    if (r > R - 3) { x = (x / r) * (R - 3); y = (y / r) * (R - 3); }
    return [C + x, C + y];
  };
  const polar = (deg, r) => [C + r * Math.sin((deg * Math.PI) / 180), C - r * Math.cos((deg * Math.PI) / 180)];
  let g = '';
  // bearing ring ticks + labels
  for (let d = 0; d < 360; d += 5) {
    const long = d % 30 === 0, mid = d % 10 === 0;
    const [x1, y1] = polar(d, R), [x2, y2] = polar(d, R + (long ? 9 : mid ? 6 : 3));
    g += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" class="ppi-tick"/>`;
    if (long) { const [lx, ly] = polar(d, R + 19); g += `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" class="ppi-brg">${String(d).padStart(3, '0')}</text>`; }
  }
  // range rings
  ringKms.forEach((rk, i) => {
    const r = Math.min(R, rk * k);
    g += `<circle cx="${C}" cy="${C}" r="${r.toFixed(1)}" class="ppi-ring ${activeRing === i ? 'ppi-ring-active' : ''}"/>`;
    const [lx, ly] = polar(45, r);
    g += `<text x="${(lx + 3).toFixed(1)}" y="${(ly - 3).toFixed(1)}" class="ppi-rng">${esc(fmtKm(rk))}</text>`;
  });
  // axes: horizontal, vertical, and faint diagonals
  g += `<line x1="${C - R}" y1="${C}" x2="${C + R}" y2="${C}" class="ppi-axis"/><line x1="${C}" y1="${C - R}" x2="${C}" y2="${C + R}" class="ppi-axis"/>`;
  for (const d of [45, 135]) { const [a1, b1] = polar(d, R), [a2, b2] = polar(d + 180, R); g += `<line x1="${a1.toFixed(1)}" y1="${b1.toFixed(1)}" x2="${a2.toFixed(1)}" y2="${b2.toFixed(1)}" class="ppi-axis ppi-diag"/>`; }
  // sweep (rotates clockwise; fading phosphor wedge trails behind the beam)
  let sweep = '';
  for (let i = 0; i < 18; i++) {
    const a0 = -i * 2.2, a1 = -(i + 1) * 2.2;
    const [x0, y0] = polar(a0, R), [x1, y1] = polar(a1, R);
    sweep += `<path d="M${C},${C} L${x0.toFixed(1)},${y0.toFixed(1)} A${R},${R} 0 0 0 ${x1.toFixed(1)},${y1.toFixed(1)} Z" class="ppi-wedge" fill-opacity="${(0.32 * (1 - i / 18)).toFixed(3)}"/>`;
  }
  sweep += `<line x1="${C}" y1="${C}" x2="${C}" y2="${C - R}" class="ppi-beam"/>`;
  // tracks + targets
  let tracks = '', tgts = '';
  for (const t of targets) {
    if (!t.position) continue;
    const pts = [...(t.track || []), t.position].map(xy);
    if (pts.length > 1) {
      tracks += `<polyline points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" class="ppi-track"/>`;
      tracks += pts.slice(0, -1).map(([x, y], i) => (i % 3 === 0 ? `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.3" class="ppi-track-dot"/>` : '')).join('');
    }
    const [x, y] = pts[pts.length - 1];
    tgts += `<g class="ppi-tgt ppi-${esc(t.kind || 'responder')}"><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9" class="ppi-halo"/><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4.6" class="ppi-dot"><title>${esc(t.title || t.id)}</title></circle>`
      + (t.id ? `<text x="${(x + 8).toFixed(1)}" y="${(y - 7).toFixed(1)}" class="ppi-lbl">${esc(t.id)}${t.sub ? ` <tspan class="ppi-sub">${esc(t.sub)}</tspan>` : ''}</text>` : '') + '</g>';
  }
  return `<svg viewBox="0 0 ${V} ${V}" class="ppi" role="img" aria-label="Radar plan position indicator: her location at centre, volunteers by range and bearing">
    <defs><radialGradient id="ppiBg"><stop offset="0" stop-color="#03200f"/><stop offset="1" stop-color="#000"/></radialGradient>
      <filter id="ppiGlow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
    <rect width="${V}" height="${V}" rx="18" class="ppi-bezel"/>
    <circle cx="${C}" cy="${C}" r="${R}" fill="url(#ppiBg)" class="ppi-scope"/>
    ${g}
    <g class="ppi-sweep">${sweep}</g>
    <g filter="url(#ppiGlow)">${tracks}${tgts}</g>
    <circle cx="${C}" cy="${C}" r="11" class="ppi-her-ring"/><circle cx="${C}" cy="${C}" r="6" class="ppi-her" filter="url(#ppiGlow)"><title>Her location</title></circle>
    <text x="12" y="20" class="ppi-hud">${esc(title)}</text><text x="${V - 12}" y="20" class="ppi-hud" text-anchor="end">RNG ${esc(fmtKm(range))}</text>
    <text x="12" y="${V - 10}" class="ppi-hud">TRK ${targets.filter((t) => t.position && t.kind !== 'alerted' && t.kind !== 'declined').length}</text><text x="${V - 12}" y="${V - 10}" class="ppi-hud" text-anchor="end">N ↑ 000°</text>
  </svg>`;
}

const STATE_CODE = { ACCEPTED: 'ACPT', 'EN ROUTE': 'ENRT', ARRIVED: 'ONSC', ASSISTING: 'ASST' };
// Multi-target readout table (track id, range, bearing, speed, ETA, state).
export function ppiTable(rows) {
  if (!rows.length) return '';
  return `<div class="ppi-table-wrap"><table class="ppi-table"><thead><tr><th>TRK</th><th>RNG</th><th>BRG</th><th>SPD</th><th>ETA</th><th>STATE</th></tr></thead><tbody>${rows.map((r) => `<tr class="${r.you ? 'ppi-row-you' : ''}"><td>${esc(r.id)}</td><td>${r.km != null ? esc(fmtKm(r.km)) : '—'}</td><td>${r.brg != null ? esc(String(r.brg).padStart(3, '0')) + '°' : '—'}</td><td>${r.spd != null ? esc(r.spd) + ' km/h' : '—'}</td><td>${r.eta != null ? (r.eta === 0 ? 'ON SCENE' : '≈' + esc(r.eta) + 'm') : '—'}</td><td>${esc(STATE_CODE[r.state] || r.state || '')}${r.closing ? ` <span class="ppi-${esc(r.closing.toLowerCase())}">${r.closing === 'CLOSING' ? '▼CLS' : r.closing === 'OPENING' ? '▲OPN' : '■STD'}</span>` : ''}</td></tr>`).join('')}</tbody></table><p class="ppi-key">ACPT accepted · ENRT en route · ONSC on scene · ▼CLS closing in · ▲OPN moving away</p></div>`;
}
