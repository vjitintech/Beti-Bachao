// Live trip page for her trusted contacts (opened from the SMS link, no login).
const kind = location.pathname.startsWith('/s/') ? 's' : 't'; // s = live SOS, t = Track my travel
const token = location.pathname.slice(3);
const main = document.getElementById('main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
let lastKey = '';
async function load() {
  let d;
  try { const r = await fetch(`/api/v1/${kind}/${encodeURIComponent(token)}`, { cache: 'no-store' }); d = await r.json(); if (!r.ok) throw new Error(d.error?.message || 'Link not valid'); }
  catch (e) { main.innerHTML = `<section class="card"><h1>Link not available</h1><p>${esc(e.message)}</p></section>`; return; }
  if (kind === 's') return renderSos(d);
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
function renderSos(d) {
  if (d.expired) { main.innerHTML = '<section class="card"><h1>This SOS has ended</h1><p>Live sharing has stopped.</p></section>'; return; }
  const em = esc(d.emergency || '112');
  const head = d.status === 'ACTIVE' ? `🔴 ${esc(d.name)} has raised an SOS` : d.status === 'SAFE' ? `💚 ${esc(d.name)} is safe` : `${esc(d.name)}'s SOS has ended`;
  const key = JSON.stringify([d.status, d.last?.lat, d.last?.lng, d.responders?.coming, d.responders?.arrived, d.responders?.nearestEtaMin, d.police?.name]);
  if (key === lastKey) { const u = document.getElementById('upd'); if (u) u.textContent = d.last ? `Location updated ${time(d.last.at)}` : ''; return; }
  lastKey = key;
  const r = d.responders || {};
  main.innerHTML = `<section class="card ${d.status === 'ACTIVE' ? 'sos-live' : ''}"><h1>${head}</h1>
      <p>Started ${esc(time(d.startedAt))}${d.closedAt ? ` · ended ${esc(time(d.closedAt))}` : ''}</p>
      ${d.message ? `<p>${esc(d.message)}</p>` : ''}
      ${d.status === 'ACTIVE' ? `<p><b>${r.arrived ? `${r.arrived} verified volunteer(s) are with her.` : r.coming ? `${r.coming} verified volunteer(s) on the way${r.nearestEtaMin != null ? ` — nearest about ${r.nearestEtaMin} min away` : ''}.` : 'Looking for verified volunteers nearby…'}</b></p>` : ''}
      ${d.police ? `<p>🚓 Police contacted${d.police.name ? `: ${esc(d.police.name)}` : ''}.</p>` : ''}
      <p class="small muted" id="upd">${d.last ? `Location updated ${esc(time(d.last.at))}` : ''}</p></section>
    ${d.last ? `<section class="card"><div class="gmap"><iframe title="Her live location" src="https://maps.google.com/maps?q=${d.last.lat},${d.last.lng}&z=16&output=embed" loading="lazy" referrerpolicy="no-referrer"></iframe></div>
      <a class="btn btn-secondary" href="https://maps.google.com/?q=${d.last.lat},${d.last.lng}" target="_blank" rel="noopener">Open in Google Maps / get directions</a></section>` : ''}
    ${d.status === 'ACTIVE' ? `<section class="card"><p><b>What you can do:</b> call her; if you can't reach her and think she is in danger, call <a href="tel:${em}"><b>${em}</b></a> and tell them this location.</p><a class="btn btn-call" href="tel:${em}">📞 Call ${em}</a></section>` : ''}
    <p class="small muted">Shared by Beti Bachao. This page updates by itself and stops showing her location when the SOS ends.</p>`;
  document.title = d.status === 'ACTIVE' ? `🔴 SOS — ${d.name}` : `Beti Bachao — ${d.name}`;
}
load();
setInterval(load, kind === 's' ? 7000 : 15000);
