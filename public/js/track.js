// Live trip page for her trusted contacts (opened from the SMS link, no login).
const token = location.pathname.split('/t/')[1] || '';
const main = document.getElementById('main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
let lastKey = '';
async function load() {
  let d;
  try { const r = await fetch(`/api/v1/t/${encodeURIComponent(token)}`, { cache: 'no-store' }); d = await r.json(); if (!r.ok) throw new Error(d.error?.message || 'Link not valid'); }
  catch (e) { main.innerHTML = `<section class="card"><h1>Link not available</h1><p>${esc(e.message)}</p></section>`; return; }
  if (d.expired) { main.innerHTML = '<section class="card"><h1>This trip has ended</h1><p>Live sharing has stopped.</p></section>'; return; }
  const status = d.status === 'ARRIVED' ? '💚 Reached safely' : d.status === 'SOS' ? '🔴 SOS raised — help is on the way. Call her or 112.' : d.status === 'ACTIVE' ? '🚕 On the way' : 'Trip ended';
  const late = d.status === 'ACTIVE' && Date.parse(d.dueAt) < Date.now();
  const key = JSON.stringify([d.status, d.last?.lat, d.last?.lng]);
  if (key === lastKey) { document.getElementById('upd').textContent = d.last ? `Location updated ${time(d.last.at)}` : ''; return; }
  lastKey = key;
  main.innerHTML = `<section class="card"><h1>${esc(d.name)}'s trip to ${esc(d.destination)}</h1>
    <p class="${d.status === 'SOS' || late ? 'danger-text' : ''}"><b>${esc(status)}</b>${late ? ' · running late' : ''}</p>
    <p>Started ${esc(time(d.startedAt))} · expected by ${esc(time(d.dueAt))}${d.vehicle ? ` · vehicle <b>${esc(d.vehicle)}</b>` : ''}</p>
    <p class="small muted" id="upd">${d.last ? `Location updated ${esc(time(d.last.at))}` : ''}</p></section>
    ${d.last ? `<section class="card"><div class="gmap"><iframe title="Her live location" src="https://maps.google.com/maps?q=${d.last.lat},${d.last.lng}&z=15&output=embed" loading="lazy" referrerpolicy="no-referrer"></iframe></div>
      <a class="btn btn-secondary" href="https://maps.google.com/?q=${d.last.lat},${d.last.lng}" target="_blank" rel="noopener">Open in Google Maps</a></section>` : ''}
    <section class="card"><p class="small">If you think she is in danger, call her, or call <a href="tel:112"><b>112</b></a>. This page updates by itself.</p></section>`;
}
load();
setInterval(load, 15000);
