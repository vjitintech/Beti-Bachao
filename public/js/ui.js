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
