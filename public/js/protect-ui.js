// Screens and automation for the autonomous-protection features:
// places & location-based contacts, Track my travel, nearby help, dashboards,
// police auto-connect status, operator acknowledgement, evidence, admin impact &
// police-station import, blink trigger page, spoken guidance for blind users.
import { sosWords, heardSosWord, lang as curLang } from './i18n.js?v=mwddwn7p';
import { pickContacts, duplicateIn, phoneKey } from '../core/protect.js?v=mwddwn7p';
import { announce, speakStatus, listenOnce, a11y } from './a11y.js?v=mwddwn7p';
import { blinkGuard } from './blink.js?v=mwddwn7p';
import { phoneInput, readPhone, guessCountry } from './phone.js?v=mwddwn7p';
import { DIAL, flag, countryName } from '../core/dial.js?v=mwddwn7p';

export function initProtect(c) {
  const { st, esc, toast, modal, showErr, go, render, geo, contacts, prefs, store, native, platform, telHref, fmtTime, pretty, nativeShare, serverUrl, isNative, recorder } = c;
  const api = () => st.api;
  const places = () => store.get('places', []);
  const fmtMin = (m) => (m == null ? '—' : m < 1 ? '<1 min' : `${Math.round(m * 10) / 10} min`);
  const origin = () => (isNative ? serverUrl() : location.origin + location.pathname.replace(/[^/]*$/, '').replace(/\/$/, ''));

  // Who gets the SOS message right now (same rule as the server).
  const infoTip = (label, html) => `<details class="info-tip"><summary aria-label="${esc(label)}">ⓘ <span>${esc(label)}</span></summary><div class="small">${html}</div></details>`;
  const activeContacts = (loc = geo.last) => pickContacts(places(), contacts.list(), loc);

  async function pullPlaces() { try { const r = await api().getPlaces(); store.set('places', r.places || []); } catch {} }

  // ---------------- places & contacts ----------------
  const parseLatLng = (s) => {
    const txt = decodeURIComponent(String(s || ''));
    const d = txt.match(/!3d(-?\d{1,2}\.\d+)!4d(-?\d{1,3}\.\d+)/); // exact pin in a Google place link
    if (d) return { lat: Number(d[1]), lng: Number(d[2]) };
    const m = txt.match(/(-?\d{1,2}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  };
  // One editable contact row; the first `min` rows are required, extra rows can be removed.
  const contactRow = (c = {}, n = 1, required = true) => `<div class="contact-row" data-row>
      <label>Name ${n}<input name="cname" maxlength="40" value="${esc(c.name || '')}" ${required ? 'required' : ''} autocomplete="off"></label>
      <label>Phone ${n}${phoneInput('cphone', { value: c.phone || '', country: st.me?.countryCode, required, lang: curLang() })}</label>
      <button type="button" class="btn btn-ghost btn-sm row-del" data-act="row-del" aria-label="Remove contact ${n}" ${n === 1 ? 'hidden' : ''}>✕</button>
    </div>`;
  const rowsFor = (list, min) => { const xs = list.length ? list : Array.from({ length: min }, () => ({})); return xs.map((c, i) => contactRow(c, i + 1, true)).join(''); };
  const addBtn = (count, max, label) => `<button type="button" class="btn btn-secondary btn-sm" data-act="row-add" data-max="${max}" data-label="${esc(label)}" ${count >= max ? 'hidden' : ''}>＋ ${esc(label)} (${count}/${max})</button>`;

  function placeForm(p) {
    const cs = p?.contacts || [];
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
      <fieldset class="fs" data-rows><legend>Contacts for this place — 1 to 3 people who can reach you quickly here</legend>
        ${rowsFor(cs, 1)}
        ${addBtn(Math.max(1, cs.length), 3, 'Add contact')}
      </fieldset>
      <div class="row"><button class="btn btn-primary">Save place</button><button type="button" class="btn btn-ghost" data-act="place-cancel">Cancel</button></div>
    </form>`;
  }
  function importantForm() {
    const cs = contacts.list();
    return `<form class="card form" data-form="important" id="important">
      <h2>⭐ Important contacts</h2>
      ${infoTip('More info', `Told about <b>every</b> SOS, wherever you are — for example your mother, father or husband. At least 1, up to 5. You can change names and numbers any time.`)}
      <fieldset class="fs" data-rows><legend class="sr-only">Important contacts</legend>
        ${rowsFor(cs, 1)}
        ${addBtn(Math.max(1, cs.length), 5, 'Add important contact')}
      </fieldset>
      <button class="btn btn-primary">Save important contacts</button>
    </form>`;
  }
  async function editPlaceContact(i, j) {
    const list = places(); const p = list[i];
    if (!p) return;
    const x = j >= 0 ? p.contacts[j] : {};
    const r = await modal({ title: j >= 0 ? `Edit contact — ${p.label}` : `Add a contact — ${p.label}`, body: `<label>Name<input name="cname" maxlength="40" value="${esc(x.name || '')}" required></label><label>Phone${phoneInput('cphone', { value: x.phone || '', country: st.me?.countryCode, required: true, lang: curLang() })}</label>`, actions: [{ id: 'save', label: 'Save', kind: 'primary' }, { id: 'no', label: 'Cancel' }] });
    if (r.id !== 'save') return;
    const name = String(r.data.cname || '').trim(); const ph = readPhone(r.data, 'cphone');
    if (!name) return toast('Enter a name', 'error');
    if (ph.problem) return toast(ph.problem, 'error');
    const others = p.contacts.filter((_, k) => k !== j);
    const pr = rowProblem([...others, { name, phone: ph.e164 }], { notIn: contacts.list(), what: 'important contact (they are told at every place)' });
    if (pr) return toast(pr, 'error');
    const updated = j >= 0 ? p.contacts.map((q, k) => (k === j ? { name, phone: ph.e164 } : q)) : [...p.contacts, { name, phone: ph.e164 }];
    const next = list.map((q, k) => (k === i ? { ...q, contacts: updated } : q));
    try { const res = await api().savePlaces(next); store.set('places', res.places); c.syncNative(); toast(j >= 0 ? `${name} updated` : `${name} added to ${p.label}`, 'ok'); render(); } catch (e) { showErr(e); }
  }

  async function viewPlaces() {
    await pullPlaces();
    const list = places();
    const now = activeContacts();
    if (st.placeEdit != null) return c.shell(`<h1>📍 Places & contacts</h1>${placeForm(st.placeEdit === 'new' ? null : list[Number(st.placeEdit)])}`);
    return c.shell(`
      <h1>📍 Places & contacts</h1>
      ${infoTip('How contacts are chosen', 'When you raise an SOS, your ⭐ important contacts and the contacts of the place you are at get your live location. Move to another place and its contacts are added automatically — you never have to change contacts by hand. A number can be used only once per list.')}
      ${contacts.list().length ? '' : '<div class="alert alert-warn" role="alert"><b>Add at least 1 important contact</b> below — otherwise nobody you know gets your SOS message.</div>'}
      <section class="card"><h2>Right now</h2><p>${now.place ? `You are at <b>${esc(now.place.label)}</b>` : geo.last ? 'You are not near any saved place — your default contacts will be used' : 'Location is off — your default contacts will be used'}: ${now.contacts.map((x) => esc(x.name)).join(', ') || '<span class="danger-text">nobody yet</span>'}</p></section>
      ${list.map((p, i) => `<section class="card place-card"><div class="row space"><h2>${esc(p.label)}</h2><span class="badge badge-ok">${p.contacts.length}/3 contacts</span></div>
        <p class="small muted">Within ${p.radiusM >= 1000 ? `${p.radiusM / 1000} km` : `${p.radiusM} m`} of ${esc(p.lat.toFixed(4))}, ${esc(p.lng.toFixed(4))}</p>
        <ul class="contact-list">${p.contacts.map((x, j) => `<li><span>${esc(x.name)} · ${esc(x.phone)}</span><span class="row-tight"><a class="btn btn-ghost btn-sm" href="${telHref(x.phone)}" aria-label="Call ${esc(x.name)}">📞</a><button class="btn btn-ghost btn-sm" data-act="pc-edit" data-i="${i}" data-j="${j}" aria-label="Edit ${esc(x.name)}">✏️</button><button class="btn btn-ghost btn-sm danger-text" data-act="pc-del" data-i="${i}" data-j="${j}" aria-label="Delete ${esc(x.name)}">🗑</button></span></li>`).join('')}</ul>
        <div class="row">${p.contacts.length < 3 ? `<button class="btn btn-secondary btn-sm" data-act="pc-add" data-i="${i}">＋ Add contact</button>` : ''}<button class="btn btn-ghost btn-sm" data-act="place-edit" data-i="${i}">Edit place</button><button class="btn btn-ghost btn-sm danger-text" data-act="place-del" data-i="${i}">Delete place</button></div></section>`).join('')}
      ${list.length < 10 ? '<button class="btn btn-primary btn-lg" data-act="place-new">＋ Add a place (home, college, office…)</button>' : ''}
      ${importantForm()}`);
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
          ${infoTip('More info', `Your phone shares your location while you travel. You arrive → the trip ends by itself and your contacts are told you reached safely. If you are late and don't answer "Are you OK?", an SOS starts for you.`)}
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
  const TRIP_OUTCOME = { ARRIVED: '💚 reached safely', ENDED: 'sharing stopped (not marked safe)', REPLACED: 'replaced by a new trip', SOS: '🔴 SOS started automatically', ACTIVE: '🚕 in progress' };
  const tile = (n, label, sub = '') => `<div class="stat-tile"><span class="stat-n">${esc(n)}</span><span class="stat-l">${esc(label)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`;
  async function viewDashboard() {
    let d;
    try { d = await api().myDashboard(); } catch (e) { return c.shell(`<div class="alert alert-danger">${esc(e.message)}</div>`); }
    const p = prefs.get();
    const checks = [
      [d.setup.placesReady > 0, 'Saved at least one place with its contacts', '#/places'],
      [d.setup.defaultContacts > 0, 'Added at least 1 important contact (told about every SOS)', '#/places'],
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
        ${tile(d.trips.arrived, 'Trips reached safely')}${tile(d.trips.autoSos, 'Trips where help started automatically')}${d.trips.stopped ? tile(d.trips.stopped, 'Trips stopped without "reached safely"') : ''}</div>
        ${d.trips.recent?.length ? `<h3>My trips</h3><ul class="history">${d.trips.recent.map((t) => `<li>${esc(new Date(t.startedAt).toLocaleString())} → ${esc(t.destination)} — ${esc(TRIP_OUTCOME[t.status] || pretty(t.status))}</li>`).join('')}</ul>` : ''}</section>
      ${d.area ? `<section class="card"><h2>Around ${esc(d.area.label)} (${d.area.radiusKm} km, last 30 days)</h2><div class="stat-row">
        ${tile(d.area.volunteersOnDutyNow, 'Verified volunteers on duty now')}${tile(d.area.sos30d, 'SOS raised')}${tile(d.area.protected30d, 'Women protected')}${tile(fmtMin(d.area.medianArriveMin), 'Typical arrival time')}</div></section>` : '<a class="alert alert-info alert-link" href="#/places">Save your home in Places & contacts to see how many volunteers protect your area.</a>'}
      <section class="card impact-card"><h2>💚 Beti Bachao community</h2><div class="stat-row">
        ${tile(d.community.womenProtected, 'Women helped to safety')}${tile(d.community.safeTrips, 'Trips completed safely')}${tile(d.community.volunteersVerified, 'Verified volunteers')}${tile(d.community.volunteersOnDutyNow, 'On duty right now')}</div>
        ${infoTip('More info', `Every SOS that ends with "I'm safe" is counted here. Thank you for being part of it.`)}</section>
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
        ${tile(P.unacknowledged, 'Never acknowledged by an operator')}${tile(P.policeAutoConnects, 'Police called automatically (call placed)')}${tile(fmtMin(P.medianAcceptMin), 'Typical time to volunteer accept')}${tile(fmtMin(P.medianArriveMin), 'Typical time to arrival')}</div>
        <h3>SOS raised per day</h3>${columnChart(d.series, 'sos', 'SOS raised')}
        <h3>How SOS ended</h3>${outcomeBar(d.outcome)}
        <details><summary>Table view</summary><table class="tbl small"><thead><tr><th>Date</th><th>SOS</th><th>Ended safely</th><th>Police called</th></tr></thead><tbody>${d.series.filter((s) => s.sos).map((s) => `<tr><td>${esc(s.date)}</td><td>${s.sos}</td><td>${s.protected}</td><td>${s.police}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No SOS in this period.</td></tr>'}</tbody></table>
          <table class="tbl small"><thead><tr><th>Trigger</th><th>SOS</th></tr></thead><tbody>${Object.entries(d.byTrigger).map(([k, v]) => `<tr><td>${esc(pretty(k))}</td><td>${v}</td></tr>`).join('')}</tbody></table></details>
        ${d.stations ? '' : '<div class="alert alert-warn">No police station list loaded — automatic police connection can only tell her to call 112. Load it in the "Police stations" tab.</div>'}</section>`;
  }
  const IN_STATES = ['Andaman and Nicobar Islands', 'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chandigarh', 'Chhattisgarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jammu and Kashmir', 'Jharkhand', 'Karnataka', 'Kerala', 'Ladakh', 'Lakshadweep', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal'];
  const stCountry = () => st.stCountry || st.cfg?.defaultCountry || guessCountry();
  const countryOpts = (sel) => DIAL.map((r) => `<option value="${r[0]}" ${r[0] === sel ? 'selected' : ''}>${flag(r[0])} ${esc(countryName(r[0], curLang()))} (+${r[2]})</option>`).join('');
  const statesFor = (iso, items) => [...new Set([...(iso === 'IN' ? IN_STATES : []), ...items.filter((s) => (s.country || 'IN') === iso && s.state).map((s) => s.state)])].sort();

  async function adminStationsTab() {
    const { items } = await api().stations();
    const iso = stCountry();
    const states = statesFor(iso, items);
    const fState = st.stFilterState || '';
    const q = (st.stQuery || '').toLowerCase();
    const inCountry = items.filter((s) => (s.country || 'IN') === iso);
    const shown = inCountry.filter((s) => (!fState || (s.state || '') === fState) && (!q || `${s.name} ${s.district} ${s.phone}`.toLowerCase().includes(q)));
    const byState = inCountry.reduce((m, s) => { const k = s.state || '(no state)'; m[k] = (m[k] || 0) + 1; return m; }, {});
    const countries = [...new Set(items.map((s) => s.country || 'IN'))];
    const draft = st.stationDraft || {};
    const ed = st.stationEdit ? items.find((s) => s.id === st.stationEdit) : null;
    const v = (k) => esc(draft[k] ?? ed?.[k] ?? '');
    return `<section class="card form"><h2>🚓 Police stations</h2>
        ${infoTip('More info', `Used for <b>automatic police connection</b> (when no operator acknowledges an SOS in time, or she presses SOS again) and for "Nearby help". Choose the country and state first — phone numbers are then typed the local way and the country code is added for you.`)}
        <div class="grid2">
          <label>Country<select data-change="st-country">${countryOpts(iso)}</select></label>
          <label>State / province<input list="st-states" data-change="st-state" value="${esc(st.stState ?? fState)}" placeholder="${iso === 'IN' ? 'e.g. Andhra Pradesh' : 'State, province or region'}"><datalist id="st-states">${states.map((x) => `<option value="${esc(x)}">`).join('')}</datalist></label>
        </div>
        ${countries.length > 1 || countries[0] !== iso ? `<p class="small">Loaded: ${countries.map((c2) => `${flag(c2)} ${esc(countryName(c2, curLang()))} ${items.filter((s) => (s.country || 'IN') === c2).length}`).join(' · ')}</p>` : ''}
      </section>

      <section class="card form"><h2>${ed ? '✏️ Edit station' : '➕ Add one station'}</h2>
        <form data-form="station-one" ${ed ? `data-id="${esc(ed.id)}"` : ''}><input type="hidden" name="state" value="${esc(st.stState || ed?.state || '')}">
          <div class="grid2">
            <label>Station name<input name="name" required maxlength="80" value="${v('name')}" placeholder="e.g. Kurnool I Town PS"></label>
            <label>District / city<input name="district" maxlength="60" value="${v('district')}"></label>
          </div>
          <div class="grid2">
            <label>Phone${phoneInput('phone', { value: draft.phone ?? ed?.phone ?? '', country: iso, required: true, lang: curLang(), placeholder: 'Station number' })}</label>
            <label>Second phone (optional)${phoneInput('phone2', { value: draft.phone2 ?? ed?.phone2 ?? '', country: iso, lang: curLang(), placeholder: 'Optional' })}</label>
          </div>
          <label>Location — paste a Google Maps link or "lat, lng"<input name="where" value="${esc(draft.where ?? (ed ? `${ed.lat}, ${ed.lng}` : ''))}" placeholder="https://www.google.com/maps/place/...  or  15.8306, 78.0451"></label>
          ${infoTip('More info', `In Google Maps: open the station, tap <b>Share → Copy link</b> on a computer, or long-press the pin and copy the numbers shown. Short "maps.app.goo.gl" links don't contain the location — open them first and copy the full address-bar link.`)}
          <div class="row"><button type="button" class="btn btn-secondary btn-sm" data-act="station-here">📍 I am at the station now</button>
            <button class="btn btn-primary">${ed ? 'Save changes' : 'Add station'}</button>${ed ? '<button type="button" class="btn btn-ghost" data-act="station-cancel">Cancel</button>' : ''}</div>
        </form></section>

      <section class="card form"><details ${st.stCsvOpen ? 'open' : ''}><summary><b>📄 Bulk upload (CSV / spreadsheet)</b></summary>
        ${infoTip('More info', `Stations go into <b>${flag(iso)} ${esc(countryName(iso, curLang()))}${st.stState ? ` → ${esc(st.stState)}` : ''}</b> (change above). Only <code>name,lat,lng,phone</code> are required; <code>district</code>, <code>phone2</code>, <code>state</code> and <code>country</code> columns are optional. Paste straight from Excel / Google Sheets (save as CSV) — local numbers like <code>08518 220100</code> are fine.`)}
        <form data-form="stations"><textarea name="csv" rows="6" required placeholder="name,district,lat,lng,phone,phone2&#10;Kurnool I Town PS,Kurnool,15.8306,78.0451,08518 220100,&#10;Kurnool II Town PS,Kurnool,15.8281,78.0373,08518 221200,9440795500"></textarea>
          <label class="switch"><input type="checkbox" name="replace"> Replace all stations of ${esc(st.stState || countryName(iso, curLang()))} (other states are kept)</label>
          <div class="row"><button class="btn btn-primary">Upload</button><button type="button" class="btn btn-ghost btn-sm" data-act="station-template">⬇ Download template</button></div></form></details></section>

      <section class="card"><h2>${inCountry.length} stations in ${flag(iso)} ${esc(countryName(iso, curLang()))}</h2>
        ${Object.keys(byState).length > 1 || fState ? `<div class="chip-row">${['', ...Object.keys(byState).sort()].map((k) => `<button type="button" class="chip ${k === fState ? 'chip-hl' : ''}" aria-pressed="${k === fState}" data-act="st-filter" data-state="${esc(k)}">${k ? esc(k) : 'All'} ${k ? byState[k] : inCountry.length}</button>`).join('')}</div>` : ''}
        <label class="sr-only" for="st-q">Search stations</label><input id="st-q" type="search" data-change="st-query" value="${esc(st.stQuery || '')}" placeholder="Search name, district or phone">
        <table class="tbl small"><thead><tr><th>Name</th><th>State · District</th><th>Phone</th><th>Location</th><th></th></tr></thead><tbody>
        ${shown.slice(0, 500).map((s) => `<tr><td>${esc(s.name)}</td><td>${esc([s.state, s.district].filter(Boolean).join(' · '))}</td><td>${esc(s.phone)}${s.phone2 ? `<br>${esc(s.phone2)}` : ''}</td><td><a href="https://maps.google.com/?q=${s.lat},${s.lng}" target="_blank" rel="noopener">${esc(s.lat.toFixed(4))}, ${esc(s.lng.toFixed(4))}</a></td><td><button class="btn btn-ghost btn-sm" data-act="station-edit" data-id="${esc(s.id)}">Edit</button><button class="btn btn-ghost btn-sm danger-text" data-act="station-del" data-id="${esc(s.id)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet.</td></tr>'}</tbody></table>
        ${shown.length > 500 ? `<p class="small muted">Showing 500 of ${shown.length} — use search or the state filter.</p>` : ''}</section>`;
  }

  // ---------------- incident (her) & operations additions ----------------
  function incidentPolice(v) {
    if (!v || v.closed) return '';
    const pc = v.police;
    if (pc) {
      const d = pc.dial || {};
      const who = pc.station ? `${esc(pc.station.name)} · ${esc(pc.station.distanceKm)} km` : d.target === 'women_helpline' ? 'Women police helpline 1091' : `Emergency ${esc(d.number || pc.emergency || '112')}`;
      const state = d.result === 'PLACED' ? `📞 Your phone called ${esc(d.number)} at ${esc(fmtTime(d.placedAt))}` : d.result === 'FAILED' ? '⚠️ Your phone could not place the call — tap a number below now' : `📞 Calling ${esc(d.number || pc.emergency || '112')} now…`;
      return `<section class="alert alert-danger police-card" role="alert"><h2>🚓 Police — ${who}</h2>
        <p>${state}${pc.sms === 'SENT' ? ' · they also got your live location by SMS' : ''}</p>
        <div class="row">${d.number ? `<a class="btn btn-call" href="${telHref(d.number)}">📞 Call ${esc(d.number)}</a>` : ''}${d.fallback && d.fallback !== d.number ? `<a class="btn btn-call-alt" href="${telHref(d.fallback)}">📞 ${esc(d.fallback)}</a>` : (pc.emergency && pc.emergency !== d.number ? `<a class="btn btn-call-alt" href="${telHref(pc.emergency)}">📞 ${esc(pc.emergency)}</a>` : '')}</div></section>`;
    }
    return v.operatorAcknowledged
      ? '<p class="alert alert-info">👩‍💼 A Beti Bachao operator is handling your SOS.</p>'
      : `<p class="alert alert-warn">👩‍💼 Waiting for an operator. If none responds within ${Math.round((st.cfg?.policeAutoConnectSec || 120) / 60)} minutes — or you press SOS again — your phone calls the nearest police station automatically.</p>`;
  }
  function opsAck(d) {
    if (d.closed) return '';
    const pc = d.policeConnect;
    return `${!d.opAckAt && !pc ? `<div class="alert alert-danger ack-box" role="alert"><strong>Acknowledge this SOS</strong> — otherwise her phone calls the nearest police station automatically in <b data-live="ack-countdown" data-deadline="${esc(d.ackDeadline)}"></b>.<button class="btn btn-danger btn-lg" data-act="op-ack" data-id="${esc(d.id)}">✋ I'm handling this</button></div>` : ''}
      ${d.opAckAt ? `<p class="small">✋ Acknowledged by ${esc(d.opAckBy || 'operator')} at ${esc(fmtTime(d.opAckAt))}</p>` : ''}
      ${pc ? `<div class="alert alert-warn"><strong>🚓 Police auto-connect:</strong> ${pc.station ? `${esc(pc.station.name)} (${esc(pc.station.distanceKm)} km, ${esc(pc.station.phone)})` : `no station within ${esc(st.cfg?.policeMaxKm || 30)} km`} · her phone ${pc.dial?.result === 'PLACED' ? `called <b>${esc(pc.dial.number)}</b> at ${esc(fmtTime(pc.dial.placedAt))}` : pc.dial?.result === 'FAILED' ? `<b>could not call ${esc(pc.dial.number)}</b> — phone her and call police` : `is calling <b>${esc(pc.dial?.number || pc.emergency)}</b>`}${pc.sms ? ` · SMS ${esc(pretty(pc.sms))}` : ''}${pc.call ? ` · call ${esc(pretty(pc.call))}` : ''}<br><small>${esc(pc.reason)} · ${esc(fmtTime(pc.at))}</small></div>` : ''}
      ${d.sosPresses > 1 ? `<p class="badge badge-danger">She pressed SOS ${esc(d.sosPresses)} times</p>` : ''}
      ${d.contactsPlace ? `<p class="small">Contacts notified for place: <b>${esc(d.contactsPlace)}</b></p>` : ''}
      ${(d.nearestStations || []).length ? `<p class="small">Nearest stations: ${d.nearestStations.map((s) => `<a href="${telHref(s.phone)}">${esc(s.name)} (${esc(s.distanceKm)} km)</a>`).join(' · ')}</p>` : ''}
      ${(d.evidence || []).length ? `<h3>🎙️ Evidence recordings</h3><ul class="clip-list">${d.evidence.map((e) => `<li><span>${e.kind === 'video' ? '🎥' : '🎙️'} ${esc(fmtTime(e.createdAt))} · ${esc(e.durationSec)}s</span><button class="btn btn-ghost btn-sm" data-act="evidence-play" data-id="${esc(d.id)}" data-eid="${esc(e.id)}" data-kind="${esc(e.kind)}">▶ Play</button></li>`).join('')}</ul><div id="evidence-player"></div>` : ''}`;
  }

  // ---------------- automatic evidence: 15 s of audio once the SOS is active ----------------
  // Silent (no beep, no prompt). Kept only if a voice is heard; then saved on this device and
  // sent to operators/admin without asking. Every step is written to the audit log.
  const evLog = (id, event, extra = {}) => api().evidenceLog(id, { event, ...extra }).catch(() => {});
  async function captureEvidence(incidentId, seconds = 15) {
    if (st.evidenceBusy === incidentId) return;
    st.evidenceBusy = incidentId;
    try {
      if (native.available() && platform === 'android') { await native.recordEvidence({ incidentId, seconds }); return; } // native recorder: works with the screen off too
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return evLog(incidentId, 'unsupported');
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false } }); } catch { return evLog(incidentId, 'mic_denied'); }
      evLog(incidentId, 'started', { seconds });
      // Voice detection: loudness of speech frequencies, sampled 10× a second.
      let voiced = 0, ac = null, an = null;
      try { ac = new (window.AudioContext || window.webkitAudioContext)(); an = ac.createAnalyser(); an.fftSize = 1024; ac.createMediaStreamSource(stream).connect(an); } catch { /* no analyser → keep the clip */ voiced = 99; }
      const buf = an ? new Uint8Array(an.fftSize) : null;
      const vad = an ? setInterval(() => { an.getByteTimeDomainData(buf); let sum = 0; for (const v of buf) sum += (v - 128) * (v - 128); if (Math.sqrt(sum / buf.length) > 6) voiced++; }, 100) : null;
      const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t)) || '';
      const rec = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      st.evidenceRecording = true;
      const done = new Promise((r) => { rec.onstop = r; });
      rec.start(1000);
      setTimeout(() => rec.state !== 'inactive' && rec.stop(), seconds * 1000);
      await done;
      clearInterval(vad); try { ac?.close(); } catch {}
      stream.getTracks().forEach((t) => t.stop());
      st.evidenceRecording = false;
      const blob = new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' });
      if (blob.size < 200 || voiced < 5) return evLog(incidentId, 'no_voice', { seconds }); // ≈0.5 s of speech needed — silence is discarded
      await recorder.saveClip({ id: crypto.randomUUID?.() || String(Date.now()), kind: 'audio', createdAt: new Date().toISOString(), durationSec: seconds, type: blob.type, blob, incidentId, auto: true });
      const b64 = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
      try { await api().uploadEvidence(incidentId, { mime: blob.type, data: b64, durationSec: seconds, kind: 'audio', auto: true }); }
      catch { store.set('evidenceRetry', { incidentId, at: Date.now() }); evLog(incidentId, 'upload_failed'); }
    } finally { if (st.evidenceBusy === incidentId) st.evidenceBusy = null; }
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
        ${infoTip('More info', `Everything runs on your phone — no video is sent anywhere. Works while this screen is open. After the third blink you get 5 seconds to cancel.`)}
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
    const heard = (await listenOnce({ lang: c.speechLang() })) || '';
    const s = heard.toLowerCase();
    if (!s) return announce("Sorry, I didn't hear anything. Tap again to try.");
    if (heardSosWord(s, sosWords(curLang(), prefs.get().customSosWords || [])) || /\bdanger\b/.test(s)) { announce('Starting SOS.'); return c.triggerSOS({ trigger: 'voice_command' }); }
    if (/status|update|where|kitna|ఎంత/.test(s)) return speakStatus(st.incident, { force: true });
    if (/police|112|call/.test(s)) { announce('Calling 112.'); return c.openExternal(telHref(c.country().emergency)); }
    if (/safe|surakshit|సురక్షిత/.test(s)) {
      if (!st.incident || st.incident.closed) return announce('You have no active SOS.');
      announce('To confirm you are safe, say: yes I am safe.');
      const again = ((await listenOnce({ lang: c.speechLang() })) || '').toLowerCase();
      if (/yes/.test(again) && /safe/.test(again)) { await api().safety(st.incident?.id || (location.hash.match(/^#\/incident\/([^/?]+)/) || [])[1], { response: 'YES', confirm: true }); announce('Thank you. Your SOS is closed and volunteers are released.'); return render(); }
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
    // One contact of a place: add / edit / delete without touching the rest of the place.
    async 'pc-add'(el) { await editPlaceContact(Number(el.dataset.i), -1); },
    async 'pc-edit'(el) { await editPlaceContact(Number(el.dataset.i), Number(el.dataset.j)); },
    async 'pc-del'(el) {
      const list = places(); const i = Number(el.dataset.i), j = Number(el.dataset.j); const p = list[i]; const x = p?.contacts[j];
      if (!x) return;
      if (p.contacts.length <= 1) return toast(`"${p.label}" needs at least 1 contact — add another first, or delete the place`, 'error');
      const r = await modal({ title: `Remove ${x.name}?`, body: `<p>${esc(x.name)} (${esc(x.phone)}) will no longer be told when you raise an SOS at ${esc(p.label)}.</p>`, actions: [{ id: 'del', label: 'Remove', kind: 'danger' }, { id: 'no', label: 'Cancel' }] });
      if (r.id !== 'del') return;
      const next = list.map((q, k) => (k === i ? { ...q, contacts: q.contacts.filter((_, m) => m !== j) } : q));
      try { const res = await api().savePlaces(next); store.set('places', res.places); c.syncNative(); toast(`${x.name} removed`, 'ok'); render(); } catch (e) { showErr(e); }
    },
    'row-add'(el) {
      const box = el.closest('[data-rows]'); const max = Number(el.dataset.max);
      const n = box.querySelectorAll('[data-row]').length;
      if (n >= max) return;
      el.insertAdjacentHTML('beforebegin', contactRow({}, n + 1, true));
      box.querySelectorAll('[data-row]')[n].querySelector('input')?.focus();
      el.textContent = `＋ ${el.dataset.label} (${n + 1}/${max})`;
      if (n + 1 >= max) el.hidden = true;
    },
    'row-del'(el) {
      const box = el.closest('[data-rows]'); const row = el.closest('[data-row]');
      if (box.querySelectorAll('[data-row]').length <= 1) return;
      row.remove();
      const rows = [...box.querySelectorAll('[data-row]')];
      rows.forEach((r, i) => { const [a, b] = r.querySelectorAll('label'); a.firstChild.textContent = `Name ${i + 1}`; b.firstChild.textContent = `Phone ${i + 1}`; r.querySelector('.row-del').hidden = i === 0; });
      const add = box.querySelector('[data-act="row-add"]'); add.hidden = false; add.textContent = `＋ ${add.dataset.label} (${rows.length}/${add.dataset.max})`;
    },
    async 'trip-safe'() { try { await api().endTrip({ safe: true }); store.set('tripActive', null); if (native.available()) prefs.get().armed ? native.startSafety('armed') : native.stopSafety(); toast('💚 Trip ended — your contacts are told you are safe', 'ok'); announce('Trip ended. You are marked safe.'); render(); } catch (e) { showErr(e); } },
    // "Stop sharing" first asks whether she reached safely, so a safe arrival is never lost.
    'trip-end'(el) {
      const row = el.closest('.row');
      if (!row || row.nextElementSibling?.matches('[data-trip-ask]')) return;
      row.insertAdjacentHTML('afterend', `<div class="alert alert-info" data-trip-ask role="alert"><strong>Did you reach safely?</strong><div class="row"><button class="btn btn-safe" data-act="trip-safe">✅ Yes, I'm safe</button><button class="btn btn-ghost" data-act="trip-stop">No — just stop sharing</button></div></div>`);
      announce('Did you reach safely? Choose yes, I am safe, or no, just stop sharing.');
    },
    async 'trip-stop'() { try { await api().endTrip({ safe: false }); store.set('tripActive', null); if (native.available()) prefs.get().armed ? native.startSafety('armed') : native.stopSafety(); render(); } catch (e) { showErr(e); } },
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
    async 'station-del'(el) {
      const r = await modal({ title: 'Delete this police station?', body: '<p>It will no longer be contacted automatically.</p>', actions: [{ id: 'del', label: 'Delete', kind: 'danger' }, { id: 'no', label: 'Cancel' }] });
      if (r.id !== 'del') return;
      try { await api().deleteStation(el.dataset.id); render(); } catch (e) { showErr(e); }
    },
    'station-edit'(el) { st.stationEdit = el.dataset.id; st.stationDraft = null; render(); setTimeout(() => document.querySelector('[data-form="station-one"] [name="name"]')?.focus(), 50); },
    'station-cancel'() { st.stationEdit = null; st.stationDraft = null; render(); },
    'st-filter'(el) { st.stFilterState = el.dataset.state || ''; render(); },
    async 'station-here'(el) {
      const f = el.closest('form');
      try { const l = await geo.once(10000); f.where.value = `${l.lat.toFixed(6)}, ${l.lng.toFixed(6)}`; toast(`Location set (±${Math.round(l.accuracy || 0)} m)`, 'ok'); } catch { toast('Could not get your location', 'error'); }
    },
    'station-template'() {
      const csv = 'name,district,lat,lng,phone,phone2\nExample Town PS,Example District,15.8306,78.0451,08518 220100,\n';
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `police-stations-${stCountry()}${st.stState ? '-' + st.stState.replace(/\W+/g, '-') : ''}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    },
    'blink-stop'() { stopBlink(); go('#/home'); },
    'voice-command'() { voiceCommand(); },
    'speak-status'() { speakStatus(st.incident, { force: true }); },
  };
  // Each row → { name, phone: +E.164 }; rows with a bad number carry `problem` so the form can say which one.
  const readRows = (f) => [...f.querySelectorAll('[data-row]')].map((r) => {
    const name = r.querySelector('[name="cname"]').value.trim(); const raw = r.querySelector('[name="cphone"]').value.trim();
    const ph = readPhone(r, 'cphone');
    return { name, phone: raw ? ph.e164 : '', problem: raw ? ph.problem : null };
  }).filter((x) => x.name || x.phone);
  const rowProblem = (cs, { notIn = [], what = 'important contact' } = {}) => {
    const i = cs.findIndex((x) => !x.name || !x.phone || x.problem);
    if (i >= 0) return `Contact ${i + 1}: ${!cs[i].name ? 'enter a name' : cs[i].problem || 'enter a phone number'}`;
    const dup = duplicateIn(cs);
    if (dup) return `${dup.b.name} has the same number as ${dup.a.name} — each contact needs a different number`;
    const clash = cs.find((x) => notIn.some((y) => phoneKey(y.phone) === phoneKey(x.phone)));
    if (clash) return `${clash.name} (${clash.phone}) is already an ${what}`;
    if (st.me?.phone && cs.some((x) => phoneKey(x.phone) === phoneKey(st.me.phone))) return 'That is your own number — add someone who can help you';
    return null;
  };
  const clean = (cs) => cs.map(({ name, phone }) => ({ name, phone }));
  const forms = {
    async important(f) {
      const cs = readRows(f);
      if (cs.length < 1) return toast('Add at least 1 important contact', 'error');
      if (cs.length > 5) return toast('Up to 5 important contacts', 'error');
      { const pr = rowProblem(cs); if (pr) return toast(pr, 'error'); }
      try { const r = await api().saveContacts({ contacts: clean(cs) }); contacts.replace(r.contacts || clean(cs)); c.syncNative(); toast('Important contacts saved', 'ok'); render(); } catch (e) { showErr(e); }
    },
    async place(f) {
      const list = [...places()];
      const i = f.dataset.i === 'new' ? -1 : Number(f.dataset.i);
      const where = parseLatLng(f.where.value) || st.placeDraft || (i >= 0 ? { lat: list[i].lat, lng: list[i].lng } : null);
      if (!where) return toast('Set the location: tap "Use where I am now" or paste a Google Maps link', 'error');
      const cs = readRows(f);
      if (cs.length < 1) return toast('Add at least 1 contact for this place', 'error');
      if (cs.length > 3) return toast('Up to 3 contacts per place', 'error');
      { const pr = rowProblem(cs, { notIn: contacts.list(), what: 'important contact (they are told at every place)' }); if (pr) return toast(pr, 'error'); }
      const p = { id: i >= 0 ? list[i].id : undefined, label: f.label.value.trim(), lat: where.lat, lng: where.lng, radiusM: Number(f.radiusM.value), contacts: clean(cs) };
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
    async 'station-one'(f) {
      const where = parseLatLng(f.where.value);
      const keep = () => { st.stationDraft = { name: f.name.value, district: f.district.value, where: f.where.value, phone: readPhone(f, 'phone').e164, phone2: f.phone2.value ? readPhone(f, 'phone2').e164 : '' }; };
      if (!where) return toast('Set the location: paste a Google Maps link / "lat, lng", or tap "I am at the station now"', 'error');
      const p1 = readPhone(f, 'phone'); const p2 = f.phone2.value.trim() ? readPhone(f, 'phone2') : null;
      if (p1.problem && p1.e164.replace(/\D/g, '').length < 8) return toast('Station phone: ' + p1.problem, 'error');
      try {
        const r = await api().addStation({ id: f.dataset.id || undefined, name: f.name.value, district: f.district.value, state: f.state.value, country: stCountry(), lat: where.lat, lng: where.lng, phone: p1.e164, phone2: p2?.e164 || null });
        st.stationEdit = null; st.stationDraft = null;
        toast(r.updated ? 'Station updated' : `Station added — ${r.total} in total`, 'ok'); render();
      } catch (e) { keep(); showErr(e); }
    },
    async stations(f) { st.stCsvOpen = true; try { const r = await api().importStations({ csv: f.csv.value, mode: f.replace.checked ? 'replace' : 'merge', country: stCountry(), state: st.stState || '' }); toast(`Imported ${r.imported}, skipped ${r.skipped} — ${r.total} stations`, r.skipped ? 'warn' : 'ok', 7000); render(); } catch (e) { showErr(e); } },
  };
  const changes = {
    'impact-days'(el) { st.impactDays = Number(el.value); render(); },
    'st-country'(el) { st.stCountry = el.value; st.stState = ''; st.stFilterState = ''; render(); },
    'st-state'(el) { st.stState = el.value.trim(); st.stFilterState = st.stState; render(); },
    'st-query'(el) { st.stQuery = el.value; render(); setTimeout(() => { const i = document.getElementById('st-q'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 0); },
    autoEvidence(el) { prefs.set({ autoEvidence: el.checked }); c.syncNative(); },
    voiceGuide(el) { prefs.set({ voiceGuide: el.checked }); a11y.setGuide(el.checked); if (el.checked) announce('Spoken guidance is on.'); },
    async voiceNative(el) { prefs.set({ voiceNative: el.checked }); if (el.checked) await native.requestPermissions('microphone'); await c.syncNative(); toast(el.checked ? 'Listening for your SOS word in the background' : 'Voice SOS off', 'ok'); },
  };

  // iPhone: Voice SOS while the app is on screen (Android listens in its background service;
  // a locked iPhone uses "Hey Siri, Beti Bachao SOS").
  let voiceLoop = false;
  async function runVoiceLoop() {
    voiceLoop = true;
    while (prefs.get().voiceNative && platform === 'ios' && st.me?.role === 'user' && document.visibilityState === 'visible' && !st.countdown && !st.sendingSos) {
      const heard = await listenOnce({ lang: c.speechLang(), timeoutMs: 6000 });
      if (heard && heardSosWord(heard, sosWords(curLang(), prefs.get().customSosWords || []))) { c.startCountdown('voice'); break; }
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
    adminImpactTab, adminStationsTab, incidentPolice, opsAck, landingImpact, captureEvidence, activeContacts, pullPlaces, parseLatLng,
    afterRender(route) { if (route === 'blink') afterRenderBlink(); },
    actions, forms, changes, tick,
  };
}
