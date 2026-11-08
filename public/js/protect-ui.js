// Screens and automation for the autonomous-protection features:
// places & location-based contacts, Track my travel, nearby help, dashboards,
// police auto-connect status, operator acknowledgement, evidence, admin impact &
// police-station import, blink trigger page, spoken guidance for blind users.
import { pickContacts } from '../core/protect.js?v=mw7qzel4';
import { announce, speakStatus, listenOnce, a11y } from './a11y.js?v=mw7qzel4';
import { blinkGuard } from './blink.js?v=mw7qzel4';

export function initProtect(c) {
  const { st, esc, toast, modal, showErr, go, render, geo, contacts, prefs, store, native, platform, telHref, fmtTime, pretty, nativeShare, serverUrl, isNative } = c;
  const api = () => st.api;
  const places = () => store.get('places', []);
  const fmtMin = (m) => (m == null ? '—' : m < 1 ? '<1 min' : `${Math.round(m * 10) / 10} min`);
  const origin = () => (isNative ? serverUrl() : location.origin + location.pathname.replace(/[^/]*$/, '').replace(/\/$/, ''));

  // Who gets the SOS message right now (same rule as the server).
  const activeContacts = (loc = geo.last) => pickContacts(places(), contacts.list(), loc);

  async function pullPlaces() { try { const r = await api().getPlaces(); store.set('places', r.places || []); } catch {} }

  // ---------------- places & contacts ----------------
  const parseLatLng = (s) => {
    const txt = decodeURIComponent(String(s || ''));
    const m = txt.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  };
  function placeForm(p) {
    const cs = [...(p?.contacts || []), {}, {}, {}, {}, {}].slice(0, 5);
    const d = st.placeDraft || (p ? { lat: p.lat, lng: p.lng } : null);
    return `<form class="card form" data-form="place" data-i="${esc(st.placeEdit)}">
      <h2>${p ? `Edit ${esc(p.label)}` : 'Add a place'}</h2>
      <label>Place name<input name="label" required maxlength="40" value="${esc(p?.label || '')}" placeholder="Home, College, Office, Parents' house…"></label>
      <fieldset class="fs"><legend>Where is it?</legend>
        <p>${d ? `📍 Set: ${esc(d.lat.toFixed(5))}, ${esc(d.lng.toFixed(5))}` : '<span class="muted">Not set yet</span>'}</p>
        <div class="row"><button type="button" class="btn btn-secondary btn-sm" data-act="place-here">📍 Use where I am now</button></div>
        <label>…or paste a Google Maps link / "lat, lng"<input name="where" inputmode="url" placeholder="https://maps.google.com/?q=15.83,78.04"></label>
      </fieldset>
      <label>Area size<select name="radiusM">${[[500, '500 m'], [1000, '1 km'], [2000, '2 km'], [5000, '5 km'], [10000, '10 km'], [25000, 'Whole town (25 km)']].map(([v, l]) => `<option value="${v}" ${(p?.radiusM || 2000) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <fieldset class="fs"><legend>Contacts for this place — 3 to 5 people who can reach you quickly here</legend>
        ${cs.map((x, i) => `<div class="contact-row"><label>Name ${i + 1}${i < 3 ? ' (required)' : ''}<input name="cn${i}" maxlength="40" value="${esc(x.name || '')}" ${i < 3 ? 'required' : ''}></label><label>Phone ${i + 1}<input name="cp${i}" type="tel" value="${esc(x.phone || '')}" ${i < 3 ? 'required' : ''}></label></div>`).join('')}
      </fieldset>
      <div class="row"><button class="btn btn-primary">Save place</button><button type="button" class="btn btn-ghost" data-act="place-cancel">Cancel</button></div>
    </form>`;
  }
  async function viewPlaces() {
    await pullPlaces();
    const list = places();
    const now = activeContacts();
    if (st.placeEdit != null) return c.shell(`<h1>📍 Places & contacts</h1>${placeForm(st.placeEdit === 'new' ? null : list[Number(st.placeEdit)])}`);
    return c.shell(`
      <h1>📍 Places & contacts</h1>
      <div class="alert alert-info"><strong>Automatic:</strong> when you raise an SOS, the contacts of the place you are at get your live location. Move to another place and its contacts are added automatically — you never have to change contacts by hand.</div>
      <section class="card"><h2>Right now</h2><p>${now.place ? `You are at <b>${esc(now.place.label)}</b>` : geo.last ? 'You are not near any saved place — your default contacts will be used' : 'Location is off — your default contacts will be used'}: ${now.contacts.map((x) => esc(x.name)).join(', ') || '<span class="danger-text">nobody yet</span>'}</p></section>
      ${list.map((p, i) => `<section class="card place-card"><div class="row space"><h2>${esc(p.label)}</h2><span class="badge ${p.contacts.length >= 3 ? 'badge-ok' : 'badge-warn'}">${p.contacts.length} contacts</span></div>
        <p class="small muted">Within ${p.radiusM >= 1000 ? `${p.radiusM / 1000} km` : `${p.radiusM} m`} of ${esc(p.lat.toFixed(4))}, ${esc(p.lng.toFixed(4))}</p>
        <ul class="contact-list">${p.contacts.map((x) => `<li><span>${esc(x.name)} · ${esc(x.phone)}</span><a class="btn btn-ghost btn-sm" href="${telHref(x.phone)}" aria-label="Call ${esc(x.name)}">📞</a></li>`).join('')}</ul>
        <div class="row"><button class="btn btn-secondary btn-sm" data-act="place-edit" data-i="${i}">Edit</button><button class="btn btn-ghost btn-sm danger-text" data-act="place-del" data-i="${i}">Delete</button></div></section>`).join('')}
      ${list.length < 10 ? '<button class="btn btn-primary btn-lg" data-act="place-new">＋ Add a place (home, college, office…)</button>' : ''}
      <section class="card"><h2>⭐ Important contacts & default list</h2>
        <p class="muted small">Mark someone ⭐ <b>important</b> (for example your mother) and they are told about every SOS, wherever you are. The rest of this list is used when you are away from all saved places.</p>
        <ul class="contact-list">${contacts.list().map((x, i) => `<li><span>${x.always ? '⭐ ' : ''}${esc(x.name)} · ${esc(x.phone)}</span><span><button class="btn btn-ghost btn-sm" data-act="contact-always" data-i="${i}" aria-pressed="${!!x.always}">${x.always ? 'Important ✓' : 'Mark important'}</button><button class="btn btn-ghost btn-sm" data-act="contact-del" data-i="${i}" aria-label="Remove ${esc(x.name)}">✕</button></span></li>`).join('') || '<li class="muted">No default contacts yet.</li>'}</ul>
        <form class="inline-form" data-form="contact"><label>Name<input name="name" required maxlength="40"></label><label>Phone<input name="phone" type="tel" required></label><button class="btn btn-secondary">Add</button></form>
      </section>`);
  }

  // ---------------- Track my travel ----------------
  async function viewTrip() {
    let trip = null;
    try { trip = (await api().myTrip()).trip; } catch {}
    const active = trip && trip.status === 'ACTIVE';
    store.set('tripActive', active ? trip.id : null);
    if (active) {
      const link = origin() + trip.shareUrlPath;
      return c.shell(`
        <h1>🚕 Track my travel</h1>
        ${trip.checkPromptAt ? `<div class="alert alert-danger" role="alert"><strong>Have you reached safely?</strong> Your SOS will start automatically if you don't answer.<div class="row"><button class="btn btn-safe btn-lg" data-act="trip-safe">✅ I'm safe</button><button class="btn btn-secondary" data-act="trip-extend">⏱️ Need 15 more minutes</button></div></div>` : ''}
        <section class="card"><h2>On the way to ${esc(trip.destination.label)}</h2>
          ${trip.vehicle ? `<p>Vehicle: <b>${esc(trip.vehicle)}</b></p>` : ''}
          <p>Expected by <b>${esc(fmtTime(trip.dueAt))}</b> · <span data-live="due" data-at="${esc(trip.dueAt)}"></span></p>
          <p class="small muted">Your phone shares your location while you travel. You arrive → the trip ends by itself and your contacts are told you reached safely. If you are late and don't answer "Are you OK?", an SOS starts for you.</p>
          <div class="row"><button class="btn btn-safe" data-act="trip-safe">✅ I've reached safely</button><button class="btn btn-secondary" data-act="trip-extend">＋15 min</button><button class="btn btn-ghost" data-act="trip-end">Stop sharing</button></div>
        </section>
        <section class="card"><h2>Live link for your contacts</h2><p class="small">${st.cfg?.features?.sms ? 'Your contacts got this link by SMS automatically.' : 'Send this link to your contacts:'}</p>
          <p class="phrase small">${esc(link)}</p>
          <div class="row"><button class="btn btn-secondary" data-act="trip-share" data-link="${esc(link)}">📤 Share link</button><a class="btn btn-ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`Follow my trip live: ${link}`)}">🟢 WhatsApp</a></div></section>
        ${c.emergencyBar()}`);
    }
    const pl = places();
    return c.shell(`
      <h1>🚕 Track my travel</h1>
      <p class="lead">Going somewhere alone — by auto, cab, bus or on foot? Start a trip. Your contacts can follow you live, and help starts automatically if you don't arrive.</p>
      ${trip && ['ARRIVED', 'ENDED', 'SOS'].includes(trip.status) ? `<div class="alert ${trip.status === 'ARRIVED' ? 'alert-info' : 'alert-warn'}">Last trip to ${esc(trip.destination.label)}: ${trip.status === 'ARRIVED' ? 'reached safely 💚' : trip.status === 'SOS' ? 'SOS was started automatically' : 'ended'}</div>` : ''}
      <form class="card form" data-form="trip">
        <label>Where are you going?<select name="dest">${pl.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join('')}<option value="link">Somewhere else (paste a Google Maps link)</option></select></label>
        <label>Google Maps link or "lat, lng" (for "somewhere else")<input name="where" inputmode="url"></label>
        <label>Name of the place (for "somewhere else")<input name="label" maxlength="60" placeholder="e.g. Friend's house"></label>
        <label>How long should it take? (minutes)<input name="minutes" type="number" min="5" max="720" value="30" required></label>
        <label>Vehicle number (auto/cab — optional)<input name="vehicle" maxlength="20" autocapitalize="characters" placeholder="AP 39 TX 1234"></label>
        <button class="btn btn-primary btn-lg">▶ Start trip</button>
      </form>
      ${pl.length ? '' : '<a class="alert alert-info alert-link" href="#/places">Tip: save your home, college or office in Places & contacts to pick them here.</a>'}
      ${c.emergencyBar()}`);
  }

  // ---------------- nearby help ----------------
  async function viewHelp() {
    let h = null;
    try { h = await api().nearby(geo.last); } catch (e) { return c.shell(`<div class="alert alert-danger">${esc(e.message)}</div>`); }
    return c.shell(`
      <h1>🚓 Nearby help</h1>
      ${c.emergencyBar()}
      <section class="card"><h2>Nearest police stations</h2>
        ${!geo.last ? `<p class="muted">Turn on location to see the stations nearest to you.</p><button class="btn btn-secondary" data-act="share-location">Allow location</button>` : ''}
        <ul class="contact-list">${h.stations.map((s) => `<li><span><b>${esc(s.name)}</b>${s.district ? ` · ${esc(s.district)}` : ''}<br><small>${esc(s.distanceKm)} km away</small></span><span><a class="btn btn-call-alt btn-sm" href="${telHref(s.phone)}">📞 Call</a> <a class="btn btn-ghost btn-sm" href="${esc(s.mapUrl)}" target="_blank" rel="noopener">Map</a></span></li>`).join('') || (geo.last ? '<li class="muted">The admin has not loaded the police station list for this area yet. Call 112.</li>' : '')}</ul>
      </section>
      ${h.chat.length ? `<section class="card"><h2>Chat helplines</h2>${h.chat.map((x) => `<a class="btn btn-secondary" target="_blank" rel="noopener" href="https://wa.me/${esc(x.whatsapp)}">🟢 ${esc(x.label)}</a>${x.region ? `<p class="small muted">${esc(x.region)}</p>` : ''}`).join('')}</section>` : ''}
      ${h.search.length ? `<section class="card"><h2>Find near me</h2><div class="row">${h.search.map((x) => `<a class="btn btn-ghost" target="_blank" rel="noopener" href="${esc(x.url)}">${esc(x.label)}</a>`).join('')}</div></section>` : ''}`);
  }

  // ---------------- her dashboard ----------------
  const tile = (n, label, sub = '') => `<div class="stat-tile"><span class="stat-n">${esc(n)}</span><span class="stat-l">${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  async function viewDashboard() {
    let d;
    try { d = await api().myDashboard(); } catch (e) { return c.shell(`<div class="alert alert-danger">${esc(e.message)}</div>`); }
    const p = prefs.get();
    const checks = [
      [d.setup.placesReady > 0, 'Saved at least one place with 3–5 contacts', '#/places'],
      [d.setup.alwaysContacts > 0, 'Marked an important contact (told everywhere)', '#/places'],
      [d.setup.pins, 'Set cancel & duress PINs', '#/settings'],
      [d.setup.phone, 'Added your mobile number (police can call you back)', '#/settings'],
      [!!p.armed || !native.available(), native.available() ? 'Background protection on (lock-screen / power button / shake)' : 'Install the phone app for background protection', '#/settings'],
      [!!p.voice || !!p.voiceNative, 'Voice SOS keyword on', '#/settings'],
    ];
    const done = checks.filter((x) => x[0]).length;
    return c.shell(`
      <h1>📊 My safety</h1>
      <section class="card"><h2>Protection set-up · ${done}/${checks.length}</h2>
        <svg class="meter" viewBox="0 0 100 8" preserveAspectRatio="none" role="meter" aria-valuemin="0" aria-valuemax="${checks.length}" aria-valuenow="${done}" aria-label="Set-up complete: ${done} of ${checks.length}"><rect class="meter-bg" width="100" height="8" rx="4"/><rect class="meter-fg" width="${Math.max(2, Math.round((done / checks.length) * 100))}" height="8" rx="4"/></svg>
        <ul class="checklist">${checks.map(([ok, label, href]) => `<li>${ok ? '✅' : '⬜'} ${ok ? esc(label) : `<a href="${href}">${esc(label)}</a>`}</li>`).join('')}</ul></section>
      <section class="card"><h2>My SOS & trips</h2><div class="stat-row">
        ${tile(d.sos.total, 'SOS raised')}${tile(d.sos.safe, 'Ended safely')}${tile(fmtMin(d.sos.medianAcceptMin), 'Typical time to a volunteer accepting')}${tile(fmtMin(d.sos.medianArriveMin), 'Typical time to arrival')}
        ${tile(d.trips.arrived, 'Trips reached safely')}${tile(d.trips.autoSos, 'Trips where help started automatically')}</div></section>
      ${d.area ? `<section class="card"><h2>Around ${esc(d.area.label)} (${d.area.radiusKm} km, last 30 days)</h2><div class="stat-row">
        ${tile(d.area.volunteersOnDutyNow, 'Verified volunteers on duty now')}${tile(d.area.sos30d, 'SOS raised')}${tile(d.area.protected30d, 'Women protected')}${tile(fmtMin(d.area.medianArriveMin), 'Typical arrival time')}</div></section>` : '<a class="alert alert-info alert-link" href="#/places">Save your home in Places & contacts to see how many volunteers protect your area.</a>'}
      <section class="card impact-card"><h2>💚 Beti Bachao community</h2><div class="stat-row">
        ${tile(d.community.womenProtected, 'Women helped to safety')}${tile(d.community.safeTrips, 'Trips completed safely')}${tile(d.community.volunteersVerified, 'Verified volunteers')}${tile(d.community.volunteersOnDutyNow, 'On duty right now')}</div>
        <p class="small muted">Every SOS that ends with "I'm safe" is counted here. Thank you for being part of it.</p></section>
      <section class="card"><h2>History</h2><ul class="history">${d.history.map((h) => `<li><a href="#/incident/${esc(h.id)}">${esc(new Date(h.createdAt).toLocaleString())}</a> — ${h.protected ? '💚 safe' : esc(pretty(h.status))}${h.arriveMin != null ? ` · help arrived in ${esc(fmtMin(h.arriveMin))}` : ''}</li>`).join('') || '<li class="muted">No SOS yet — stay safe.</li>'}</ul></section>`);
  }

  // ---------------- charts (admin) ----------------
  // Single-series daily columns; 4 px rounded tops on the baseline, recessive axis,
  // per-column hover/focus tooltip, table view below. Colors: reference palette slot 1.
  function columnChart(series, key, label) {
    const W = 640, H = 180, P = { l: 30, r: 8, t: 10, b: 22 };
    const max = Math.max(1, ...series.map((s) => s[key]));
    const step = (W - P.l - P.r) / series.length;
    const bw = Math.max(2, Math.min(18, step - 2));
    const y = (v) => H - P.b - ((H - P.t - P.b) * v) / max;
    const ticks = [0, Math.ceil(max / 2), max];
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)} per day, last ${series.length} days">
      ${ticks.map((v) => `<line class="ch-grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ch-axis" x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')}
      ${series.map((s, i) => { const h = H - P.b - y(s[key]); const x = P.l + i * step + (step - bw) / 2; const r = Math.min(4, bw / 2, h); return `<g class="ch-col" tabindex="0" data-tip="${esc(s.date)}: ${s[key]} ${esc(label.toLowerCase())}">${s[key] ? `<path class="ch-bar" d="M${x},${H - P.b} v${-(h - r)} q0,${-r} ${r},${-r} h${bw - 2 * r} q${r},0 ${r},${r} v${h - r} z"/>` : ''}<rect class="ch-hit" x="${P.l + i * step}" y="${P.t}" width="${step}" height="${H - P.t - P.b}"/></g>`; }).join('')}
      <text class="ch-axis" x="${P.l}" y="${H - 6}">${esc(series[0]?.date.slice(5) || '')}</text><text class="ch-axis" x="${W - P.r}" y="${H - 6}" text-anchor="end">${esc(series.at(-1)?.date.slice(5) || '')}</text>
    </svg>`;
  }
  function outcomeBar(o) {
    const parts = [['protected', 'Ended safely', 1], ['cancelled', 'Cancelled by her', 2], ['falseAlarm', 'False alarm', 3], ['other', 'Other / handed to services', 4]].map(([k, l, slot]) => ({ k, l, slot, v: o[k] || 0 }));
    const total = parts.reduce((s, p) => s + p.v, 0);
    if (!total) return '<p class="muted">No closed SOS in this period.</p>';
    // Tall segmented bar: one whole split into parts, 2 px surface gaps, share printed inside when it fits.
    const W = 600, H = 28, gap = 2, shown = parts.filter((p) => p.v);
    const avail = W - gap * (shown.length - 1);
    let x = 0;
    const blocks = shown.map((p) => { const w = (avail * p.v) / total; const pct = Math.round((p.v / total) * 100); const b = `<g tabindex="0" data-tip="${esc(p.l)}: ${p.v} (${pct}%)"><rect class="seg s${p.slot}" x="${x.toFixed(1)}" y="0" width="${Math.max(1, w).toFixed(1)}" height="${H}" rx="4"/>${w > 44 ? `<text class="seg-t s${p.slot}" x="${(x + 8).toFixed(1)}" y="${H / 2 + 5}">${pct}%</text>` : ''}</g>`; x += w + gap; return b; }).join('');
    return `<svg class="seg-bar" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(parts.map((p) => `${p.l} ${p.v}`).join(', '))}">${blocks}</svg>
      <ul class="legend">${parts.map((p) => `<li><i class="sw s${p.slot}" aria-hidden="true"></i>${esc(p.l)} <b>${p.v}</b></li>`).join('')}</ul>`;
  }
  async function adminImpactTab() {
    const days = st.impactDays || 30;
    const d = await api().adminDashboard(days);
    const P = d.period;
    return `<section class="card impact-card"><div class="row space"><h2>💚 Impact</h2><label>Period <select data-change="impact-days">${[7, 30, 90, 365].map((n) => `<option value="${n}" ${n === days ? 'selected' : ''}>Last ${n} days</option>`).join('')}</select></label></div>
        <div class="stat-row">${tile(d.impact.womenProtected, 'Women helped to safety (all time)')}${tile(d.impact.womenRegistered, 'Women registered')}${tile(d.impact.volunteersVerified, 'Verified volunteers')}${tile(d.impact.volunteersOnDutyNow, 'On duty now')}${tile(d.impact.safeTrips, 'Safe trips')}</div></section>
      <section class="card"><h2>Last ${d.days} days</h2><div class="stat-row">
        ${tile(P.sos, 'SOS raised')}${tile(P.protected, 'Ended safely')}${tile(P.newWomen, 'New women')}${tile(P.medianAckSec == null ? '—' : `${P.medianAckSec}s`, 'Typical operator acknowledgement')}
        ${tile(P.unacknowledged, 'Never acknowledged by an operator')}${tile(P.policeAutoConnects, 'Police connected automatically')}${tile(fmtMin(P.medianAcceptMin), 'Typical time to volunteer accept')}${tile(fmtMin(P.medianArriveMin), 'Typical time to arrival')}</div>
        <h3>SOS raised per day</h3>${columnChart(d.series, 'sos', 'SOS raised')}
        <h3>How SOS ended</h3>${outcomeBar(d.outcome)}
        <details><summary>Table view</summary><table class="tbl small"><thead><tr><th>Date</th><th>SOS</th><th>Ended safely</th><th>Police auto-connect</th></tr></thead><tbody>${d.series.filter((s) => s.sos).map((s) => `<tr><td>${esc(s.date)}</td><td>${s.sos}</td><td>${s.protected}</td><td>${s.police}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No SOS in this period.</td></tr>'}</tbody></table>
          <table class="tbl small"><thead><tr><th>Trigger</th><th>SOS</th></tr></thead><tbody>${Object.entries(d.byTrigger).map(([k, v]) => `<tr><td>${esc(pretty(k))}</td><td>${v}</td></tr>`).join('')}</tbody></table></details>
        ${d.stations ? '' : '<div class="alert alert-warn">No police station list loaded — automatic police connection can only tell her to call 112. Load it in the "Police stations" tab.</div>'}</section>`;
  }
  async function adminStationsTab() {
    const { items } = await api().stations();
    return `<section class="card form"><h2>🚓 Police stations</h2>
        <p class="muted small">Used for <b>automatic police connection</b> (when no operator acknowledges an SOS in time, or she presses SOS again) and for "Nearby help". Paste the official list as CSV with a header row. Get the list from the district police / AP Police website — check each phone number before loading.</p>
        <form data-form="stations"><label>CSV (name,district,lat,lng,phone,phone2)<textarea name="csv" rows="6" required placeholder="name,district,lat,lng,phone,phone2&#10;Kurnool I Town PS,Kurnool,15.8306,78.0451,+9108518000000,"></textarea></label>
          <label class="switch"><input type="checkbox" name="replace"> Replace the whole list (otherwise add / update)</label><button class="btn btn-primary">Import</button></form></section>
      <section class="card"><h2>${items.length} stations loaded</h2><table class="tbl small"><thead><tr><th>Name</th><th>District</th><th>Phone</th><th>Location</th><th></th></tr></thead><tbody>
        ${items.slice(0, 500).map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(s.district)}</td><td>${esc(s.phone)}${s.phone2 ? `<br>${esc(s.phone2)}` : ''}</td><td>${esc(s.lat.toFixed(4))}, ${esc(s.lng.toFixed(4))}</td><td><button class="btn btn-ghost btn-sm danger-text" data-act="station-del" data-id="${esc(s.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}</tbody></table></section>`;
  }

  // ---------------- incident (her) & operations additions ----------------
  function incidentPolice(v) {
    if (!v || v.closed) return '';
    const pc = v.police;
    if (pc) {
      const st2 = { PENDING: 'Contacting…', CONTACTED: 'Contacted ✓', NO_GATEWAY: 'Your phone is sending them your location', NO_STATION: 'Call 112 now', FAILED: 'Could not reach them automatically — call now' }[pc.status] || pretty(pc.status);
      return `<section class="alert alert-danger police-card" role="alert"><h2>🚓 Police ${pc.station ? `— ${esc(pc.station.name)}` : ''}</h2>
        <p>${esc(st2)}${pc.station ? ` · ${esc(pc.station.distanceKm)} km away` : ''}${pc.call === 'PLACED' ? ' · they are being connected to your phone — answer the call' : ''}</p>
        <div class="row">${pc.station ? `<a class="btn btn-call" href="${telHref(pc.station.phone)}">📞 Call the station</a>` : ''}<a class="btn btn-call" href="${telHref(pc.emergency || '112')}">📞 ${esc(pc.emergency || '112')}</a></div></section>`;
    }
    return v.operatorAcknowledged
      ? '<p class="alert alert-info">👩‍💼 A Beti Bachao operator is handling your SOS.</p>'
      : '<p class="alert alert-warn">👩‍💼 Waiting for an operator. If none responds within 2 minutes — or you press SOS again — the nearest police station is contacted automatically.</p>';
  }
  function opsAck(d) {
    if (d.closed) return '';
    const pc = d.policeConnect;
    return `${!d.opAckAt && !pc ? `<div class="alert alert-danger ack-box" role="alert"><strong>Acknowledge this SOS</strong> — otherwise the nearest police station is contacted automatically in <b data-live="ack-countdown" data-deadline="${esc(d.ackDeadline)}"></b>.<button class="btn btn-danger btn-lg" data-act="op-ack" data-id="${esc(d.id)}">✋ I'm handling this</button></div>` : ''}
      ${d.opAckAt ? `<p class="small">✋ Acknowledged by ${esc(d.opAckBy || 'operator')} at ${esc(fmtTime(d.opAckAt))}</p>` : ''}
      ${pc ? `<div class="alert alert-warn"><strong>🚓 Police auto-connect:</strong> ${pc.station ? `${esc(pc.station.name)} (${esc(pc.station.distanceKm)} km, ${esc(pc.station.phone)})` : 'no station list — her phone texts 112'} · ${esc(pretty(pc.status))}${pc.sms ? ` · SMS ${esc(pretty(pc.sms))}` : ''}${pc.call ? ` · call ${esc(pretty(pc.call))}` : ''}<br><small>${esc(pc.reason)} · ${esc(fmtTime(pc.at))}</small></div>` : ''}
      ${d.sosPresses > 1 ? `<p class="badge badge-danger">She pressed SOS ${esc(d.sosPresses)} times</p>` : ''}
      ${d.contactsPlace ? `<p class="small">Contacts notified for place: <b>${esc(d.contactsPlace)}</b></p>` : ''}
      ${(d.nearestStations || []).length ? `<p class="small">Nearest stations: ${d.nearestStations.map((s) => `<a href="${telHref(s.phone)}">${esc(s.name)} (${esc(s.distanceKm)} km)</a>`).join(' · ')}</p>` : ''}
      ${(d.evidence || []).length ? `<h3>🎙️ Evidence recordings</h3><ul class="clip-list">${d.evidence.map((e) => `<li><span>${e.kind === 'video' ? '🎥' : '🎙️'} ${esc(fmtTime(e.createdAt))} · ${esc(e.durationSec)}s</span><button class="btn btn-ghost btn-sm" data-act="evidence-play" data-id="${esc(d.id)}" data-eid="${esc(e.id)}" data-kind="${esc(e.kind)}">▶ Play</button></li>`).join('')}</ul><div id="evidence-player"></div>` : ''}`;
  }

  // ---------------- automatic evidence (15 s audio after an in-app SOS) ----------------
  async function captureEvidence(incidentId, seconds = 15) {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return; }
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
    const rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    st.evidenceRecording = true;
    const done = new Promise((r) => { rec.onstop = r; });
    rec.start();
    setTimeout(() => rec.state !== 'inactive' && rec.stop(), seconds * 1000);
    await done;
    stream.getTracks().forEach((t) => t.stop());
    st.evidenceRecording = false;
    const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
    if (blob.size < 200) return;
    const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
    try { await api().uploadEvidence(incidentId, { mime: blob.type, data: b64, durationSec: seconds, kind: 'audio' }); } catch { store.set('evidenceRetry', { incidentId, at: Date.now() }); }
  }

  // ---------------- landing impact counter ----------------
  function landingImpact() {
    const i = st.impact;
    if (!i) return '';
    return `<section class="impact-strip" aria-label="Beti Bachao impact"><div><b>${esc(i.womenProtected)}</b><span>women helped to safety</span></div><div><b>${esc(i.volunteersVerified)}</b><span>verified volunteers</span></div><div><b>${esc(i.volunteersOnDutyNow)}</b><span>on duty now</span></div><div><b>${esc(i.safeTrips)}</b><span>trips completed safely</span></div></section>`;
  }

  // ---------------- blink SOS page ----------------
  function viewBlink() {
    return c.shell(`<h1>👁️ Blink SOS</h1>
      <p class="lead">Hold the phone in front of your face. <b>Blink slowly three times</b> (close your eyes for about half a second each time) to start an SOS. Nobody watching will see you press anything.</p>
      <section class="card blink-card"><iframe id="blink-frame" src="blink-frame.html" allow="camera" title="Front camera for Blink SOS"></iframe><p id="blink-status" class="blink-status" aria-live="assertive">Starting camera…</p>
        <p class="small muted">Everything runs on your phone — no video is sent anywhere. Works while this screen is open. After the third blink you get 5 seconds to cancel.</p>
        <button class="btn btn-ghost" data-act="blink-stop">Stop</button></section>`);
  }
  // Messages from the isolated camera frame.
  addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.data?.src !== 'bb-blink' || !location.hash.startsWith('#/blink')) return;
    const out = document.getElementById('blink-status');
    if (e.data.type === 'status' && out) out.textContent = e.data.text;
    if (e.data.type === 'blink') { c.vibrate(60); announce(`Blink ${e.data.n} of 3`); }
    if (e.data.type === 'trigger') c.startCountdown('blink');
  });
  function afterRenderBlink() {}
  function stopBlink() { const f = document.getElementById('blink-frame'); try { f?.contentWindow?.postMessage('stop', location.origin); } catch {} }

  // ---------------- tooltips for charts (hover + keyboard focus) ----------------
  let tipEl = null;
  const showTip = (el) => {
    tipEl ||= Object.assign(document.createElement('div'), { className: 'ch-tip', role: 'tooltip' });
    if (!tipEl.isConnected) document.body.appendChild(tipEl);
    tipEl.textContent = el.dataset.tip;
    const r = el.getBoundingClientRect();
    tipEl.style.left = `${Math.min(window.innerWidth - 180, Math.max(8, r.left + r.width / 2 - 80))}px`;
    tipEl.style.top = `${window.scrollY + r.top - 36}px`;
    tipEl.hidden = false;
  };
  const hideTip = () => { if (tipEl) tipEl.hidden = true; };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest?.('[data-tip]'); el ? showTip(el) : hideTip(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest?.('[data-tip]'); el ? showTip(el) : hideTip(); });

  // ---------------- voice commands (blind & low-vision users) ----------------
  async function voiceCommand() {
    announce('Listening. Say help, status, call police, or I am safe.');
    const heard = (await listenOnce({ lang: st.langTag || 'en-IN' })) || '';
    const s = heard.toLowerCase();
    if (!s) return announce("Sorry, I didn't hear anything. Tap again to try.");
    if (/\b(help|sos|bachao|bachav|kapadandi|kaapaadu|madad|emergency|danger)\b/.test(s)) { announce('Starting SOS.'); return c.triggerSOS({ trigger: 'voice_command' }); }
    if (/status|update|where|kitna|ఎంత/.test(s)) return speakStatus(st.incident, { force: true });
    if (/police|112|call/.test(s)) { announce('Calling 112.'); return c.openExternal(telHref(c.country().emergency)); }
    if (/safe|surakshit|సురక్షిత/.test(s)) {
      if (!st.incident || st.incident.closed) return announce('You have no active SOS.');
      announce('To confirm you are safe, say: yes I am safe.');
      const again = ((await listenOnce({ lang: st.langTag || 'en-IN' })) || '').toLowerCase();
      if (/yes/.test(again) && /safe/.test(again)) { await api().safety(st.incident.id, { response: 'YES', confirm: true }); announce('Thank you. Your SOS is closed and volunteers are released.'); return render(); }
      return announce('Not closed. Your SOS is still active.');
    }
    announce(`I heard: ${heard}. Say help, status, call police, or I am safe.`);
  }

  // ---------------- actions / forms / changes ----------------
  const actions = {
    'place-new'() { st.placeEdit = 'new'; st.placeDraft = null; render(); },
    'place-edit'(el) { st.placeEdit = el.dataset.i; st.placeDraft = null; render(); },
    'place-cancel'() { st.placeEdit = null; st.placeDraft = null; render(); },
    async 'place-here'() { try { const l = await geo.once(10000); st.placeDraft = { lat: l.lat, lng: l.lng }; toast('Location set', 'ok'); st.softRefresh = true; render(); } catch { toast('Could not get your location', 'error'); } },
    async 'place-del'(el) {
      const r = await modal({ title: 'Delete this place?', body: '<p>Its contacts will no longer be told when you are there.</p>', actions: [{ id: 'del', label: 'Delete', kind: 'danger' }, { id: 'no', label: 'Cancel' }] });
      if (r.id !== 'del') return;
      const list = places().filter((_, i) => i !== Number(el.dataset.i));
      try { const res = await api().savePlaces(list); store.set('places', res.places); c.syncNative(); render(); } catch (e) { showErr(e); }
    },
    'contact-always'(el) { contacts.toggleAlways(Number(el.dataset.i)); c.syncContactsToServer(); render(); },
    async 'trip-safe'() { try { await api().endTrip({ safe: true }); store.set('tripActive', null); if (native.available()) prefs.get().armed ? native.startSafety('armed') : native.stopSafety(); toast('💚 Trip ended — your contacts are told you are safe', 'ok'); announce('Trip ended. You are marked safe.'); render(); } catch (e) { showErr(e); } },
    async 'trip-end'() { try { await api().endTrip({ safe: false }); store.set('tripActive', null); if (native.available()) prefs.get().armed ? native.startSafety('armed') : native.stopSafety(); render(); } catch (e) { showErr(e); } },
    async 'trip-extend'() { try { await api().extendTrip({ minutes: 15 }); toast('15 more minutes', 'ok'); render(); } catch (e) { showErr(e); } },
    async 'trip-share'(el) { if (!(await nativeShare(`Follow my trip live: ${el.dataset.link}`))) { try { await navigator.clipboard.writeText(el.dataset.link); toast('Link copied', 'ok'); } catch { toast(el.dataset.link, 'info', 10000); } } },
    async 'op-ack'(el) { try { await api().opAck(el.dataset.id); toast('Acknowledged — you are handling this SOS', 'ok'); render(); } catch (e) { showErr(e); } },
    async 'evidence-play'(el) {
      try {
        const blob = await api().evidenceBlob(el.dataset.id, el.dataset.eid);
        const url = URL.createObjectURL(blob);
        const box = document.getElementById('evidence-player');
        if (box) box.innerHTML = el.dataset.kind === 'video' ? `<video controls autoplay src="${url}"></video>` : `<audio controls autoplay src="${url}"></audio>`;
      } catch (e) { showErr(e); }
    },
    async 'station-del'(el) { try { await api().deleteStation(el.dataset.id); render(); } catch (e) { showErr(e); } },
    'blink-stop'() { stopBlink(); go('#/home'); },
    'voice-command'() { voiceCommand(); },
    'speak-status'() { speakStatus(st.incident, { force: true }); },
  };
  const forms = {
    async place(f) {
      const list = [...places()];
      const i = f.dataset.i === 'new' ? -1 : Number(f.dataset.i);
      const where = parseLatLng(f.where.value) || st.placeDraft || (i >= 0 ? { lat: list[i].lat, lng: list[i].lng } : null);
      if (!where) return toast('Set the location: tap "Use where I am now" or paste a Google Maps link', 'error');
      const cs = [0, 1, 2, 3, 4].map((k) => ({ name: f[`cn${k}`].value.trim(), phone: f[`cp${k}`].value.trim() })).filter((x) => x.name || x.phone);
      if (cs.length < 3) return toast('Add at least 3 contacts for this place', 'error');
      const p = { id: i >= 0 ? list[i].id : undefined, label: f.label.value.trim(), lat: where.lat, lng: where.lng, radiusM: Number(f.radiusM.value), contacts: cs };
      if (i >= 0) list[i] = p; else list.push(p);
      try { const r = await api().savePlaces(list); store.set('places', r.places); st.placeEdit = null; st.placeDraft = null; c.syncNative(); toast('Saved — contacts will switch automatically with your location', 'ok'); render(); } catch (e) { showErr(e); }
    },
    async trip(f) {
      let dest = null;
      if (f.dest.value === 'link') { const ll = parseLatLng(f.where.value); if (!ll) return toast('Paste a Google Maps link or "lat, lng"', 'error'); dest = { ...ll, label: f.label.value.trim() || 'Destination' }; }
      else { const p = places()[Number(f.dest.value)]; dest = { lat: p.lat, lng: p.lng, label: p.label }; }
      let loc = geo.last;
      if (!loc) { try { loc = await geo.once(8000); } catch {} }
      try {
        await api().startTrip({ destination: dest, expectedMin: Number(f.minutes.value), vehicle: f.vehicle.value, location: loc });
        geo.start();
        if (native.available()) native.startSafety('trip');
        toast('Trip started — your contacts can follow you live', 'ok'); announce(`Trip to ${dest.label} started.`);
        render();
      } catch (e) { showErr(e); }
    },
    async stations(f) { try { const r = await api().importStations({ csv: f.csv.value, mode: f.replace.checked ? 'replace' : 'merge' }); toast(`Imported ${r.imported}, skipped ${r.skipped} — ${r.total} stations`, r.skipped ? 'warn' : 'ok', 7000); render(); } catch (e) { showErr(e); } },
  };
  const changes = {
    'impact-days'(el) { st.impactDays = Number(el.value); render(); },
    autoEvidence(el) { prefs.set({ autoEvidence: el.checked }); c.syncNative(); },
    voiceGuide(el) { prefs.set({ voiceGuide: el.checked }); a11y.setGuide(el.checked); if (el.checked) announce('Spoken guidance is on.'); },
    async voiceNative(el) { prefs.set({ voiceNative: el.checked }); if (el.checked) await native.requestPermissions('microphone'); await c.syncNative(); toast(el.checked ? 'Listening for your SOS word in the background' : 'Voice SOS off', 'ok'); },
  };

  // iPhone: Voice SOS while the app is on screen (Android listens in its background service;
  // a locked iPhone uses "Hey Siri, Beti Bachao SOS").
  const SOS_WORDS = /\b(bachao|bachav|help|kapadandi|kaapaadu|kapadu|madad|save me|sos)\b/i;
  let voiceLoop = false;
  async function runVoiceLoop() {
    voiceLoop = true;
    while (prefs.get().voiceNative && platform === 'ios' && st.me?.role === 'user' && document.visibilityState === 'visible' && !st.countdown && !st.sendingSos) {
      const heard = await listenOnce({ timeoutMs: 6000 });
      if (heard && SOS_WORDS.test(heard)) { c.startCountdown('voice'); break; }
      await new Promise((r) => setTimeout(r, 300));
    }
    voiceLoop = false;
  }

  // Called every second by the app: trip location sharing + trip "are you OK?" prompt.
  let lastTripPost = 0, lastTripCheck = 0;
  async function tick() {
    if (st.me?.role !== 'user') return;
    if (!voiceLoop && platform === 'ios' && prefs.get().voiceNative && document.visibilityState === 'visible' && !st.countdown && !location.hash.startsWith('#/incident')) runVoiceLoop();
    const tripId = store.get('tripActive', null);
    if (tripId && Date.now() - lastTripPost > 30000 && geo.last && !native.available()) {
      lastTripPost = Date.now();
      try { const r = await api().postLocation(geo.last); if (r.routed === 'none') store.set('tripActive', null); } catch {}
    }
    if (tripId && Date.now() - lastTripCheck > 20000) {
      lastTripCheck = Date.now();
      try {
        const { trip } = await api().myTrip();
        if (!trip || trip.status !== 'ACTIVE') { store.set('tripActive', null); if (trip?.status === 'ARRIVED') { toast('💚 Reached safely — trip ended automatically', 'ok', 6000); announce('You have reached safely. Your trip has ended.'); } if (location.hash.startsWith('#/trip')) render(); }
        else if (trip.checkPromptAt && !location.hash.startsWith('#/trip')) { c.vibrate([400, 200, 400]); announce('Have you reached safely? Open the app and tap I am safe, or SOS will start.'); go('#/trip'); }
      } catch {}
    }
  }

  return {
    views: { places: viewPlaces, trip: viewTrip, help: viewHelp, dashboard: viewDashboard, blink: viewBlink },
    adminImpactTab, adminStationsTab, incidentPolice, opsAck, landingImpact, captureEvidence, activeContacts, pullPlaces,
    afterRender(route) { if (route === 'blink') afterRenderBlink(); },
    actions, forms, changes, tick,
  };
}
