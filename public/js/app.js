import { createApi, uuid } from './api.js?v=mvuixxhg';
import { t, setLang, detectLang, LANGS, lang } from './i18n.js?v=mvuixxhg';
import { esc, $, $$, toast, modal, fmtTime, ago, radarSvg, ppiSvg, ppiTable, niceRange, stepRange } from './ui.js?v=mvuixxhg';
import { geo, syntheticLocation, battery, keepAwake, vibrate, siren, ringer, shake, voice, recorder, contacts, mapsLink, smsHref, whatsappHref, nativeShare, safeWalk, prefs, store } from './safety.js?v=mvuixxhg';
import { TRAINING_MODULES } from '../core/engine.js?v=mvuixxhg';
import { DEMO_BLURBS } from '../core/seed.js?v=mvuixxhg';

const st = { api: null, cfg: null, me: null, incident: null, timeline: [], pollTimer: null, countdown: null, sendingSos: false, lastLocPost: 0, opSel: null, adminTab: 'policy', volSel: null };
const app = () => $('#app');

// ------------------------------------------------------------------ helpers
const country = () => {
  const code = prefs.get().country || st.me?.countryCode || st.cfg?.defaultCountry || 'IN';
  return { code, ...(st.cfg?.countries?.[code] || { name: 'India', emergency: '112', extra: [], verified: true }) };
};
const medicalNumber = () => (country().extra || []).find((h) => h.medical)?.number || null;
const telHref = (n) => `tel:${String(n).replace(/[^\d+]/g, '')}`;
const showErr = (e) => toast(e?.message || 'Something went wrong', 'error', 5000);
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };
const isDemo = () => !!st.cfg?.demo;
const roleHome = (role) => ({ user: '#/home', volunteer: '#/volunteer', operator: '#/ops', admin: '#/admin' }[role] || '#/');
const statusText = (v) => {
  if (!v) return '';
  if (v.color === 'GREEN') return t('status_green');
  if (v.color === 'GREY') return t('status_grey');
  if (v.status === 'ARRIVED' || v.status === 'ASSISTANCE_IN_PROGRESS') return t('arrived');
  if (v.color === 'AMBER') return t('status_amber');
  if (v.status === 'NO_RESPONDER_AVAILABLE') return t('no_responder');
  return t('status_red');
};
// Opens sms:/tel: links in the phone's app without leaving this page.
function openExternal(href) { const a = document.createElement('a'); a.href = href; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove(); }
const pretty = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

// Google Maps embedded inside the app (no API key, nothing opens externally).
// Rounded to ~11 m so the frame only reloads when the position really changes.
const ll = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
const mapZoom = (key, def) => Math.max(3, Math.min(20, (st.mapZoom ||= {})[key] ?? def));
const zoomBar = (act, key, label) => `<div class="zoom-bar" role="group" aria-label="${esc(label)} zoom"><button type="button" class="zbtn" data-act="${act}" data-key="${esc(key)}" data-d="1" aria-label="Zoom in">＋</button><button type="button" class="zbtn" data-act="${act}" data-key="${esc(key)}" data-d="-1" aria-label="Zoom out">－</button></div>`;
function googleMap(loc, title, key = 'map') {
  if (!loc) return '';
  return `<div class="gmap"><iframe title="${esc(title)}" src="https://maps.google.com/maps?q=${ll(loc)}&z=${mapZoom(key, 16)}&output=embed" loading="lazy" referrerpolicy="no-referrer"></iframe>${zoomBar('map-zoom', key, title)}</div>`;
}
function googleDirections(from, to, title, key = 'route') {
  if (!from || !to) return googleMap(to, title, key);
  const z = (st.mapZoom ||= {})[key];
  return `<div class="gmap"><iframe title="${esc(title)}" src="https://maps.google.com/maps?saddr=${ll(from)}&daddr=${ll(to)}&dirflg=d${z ? `&z=${mapZoom(key, 14)}` : ''}&output=embed" loading="lazy" referrerpolicy="no-referrer"></iframe>${zoomBar('map-zoom', key, title)}</div>`;
}
// Radar range with user zoom (each step = next "nice" range).
function ppiRange(key, autoKm) { const steps = (st.ppiZoom ||= {})[key] || 0; return stepRange(autoKm, -steps); }

// Live tracking of every accepted responder on a PPI radar scope + multi-target readout.
const trkId = (r) => (r.isYou ? 'YOU' : (r.label.match(/ ([A-Z])$/) || [])[1] || r.label.slice(0, 3).toUpperCase());
function trackingCard(list, center, radii, { title = 'Live tracking', map = true, note = '', key = 'track', viewer = 'her' } = {}) {
  list = list || [];
  const rows = list.map((r) => ({ id: trkId(r), you: r.isYou, km: r.distanceKm, brg: r.bearingDeg, spd: r.speedKmh, eta: r.status === 'ARRIVED' || r.status === 'ASSISTING' ? 0 : r.approxEtaMin, state: pretty(r.status).toUpperCase(), closing: r.status === 'EN_ROUTE' ? r.closing : null }));
  const targets = list.filter((r) => r.position).map((r) => ({ id: trkId(r), kind: r.isYou ? 'you' : 'responder', position: r.position, track: r.track, sub: r.distanceKm != null ? (r.distanceKm < 1 ? Math.round(r.distanceKm * 1000) + 'm' : r.distanceKm + 'km') : '', title: `${r.label} · ${pretty(r.status)}` }));
  const range = ppiRange(key, niceRange(Math.max(0.5, ...list.map((r) => r.distanceKm || 0)) * 1.15));
  return `<section class="card track-card"><h2>🛰️ ${esc(title)}</h2>
    ${list.length ? `<div class="ppi-wrap">${map && center && targets.length ? `<div class="ppi-box">${ppiSvg({ center, rangeKm: range, targets, title: 'PPI · LIVE' })}${zoomBar('ppi-zoom', key, 'Radar')}</div>
      <div class="ppi-legend"><span><i class="l-her"></i>HER</span><span><i class="l-vol"></i>VOLUNTEER</span>${viewer === 'volunteer' ? '<span><i class="l-you"></i>YOU</span>' : ''}<span><i class="l-trk"></i>TRACK</span></div>
      <p class="ppi-explain">${viewer === 'volunteer'
        ? 'She is the red dot in the centre. Blue dots are the volunteers who accepted (you are the light-blue dot); green lines show the path each one has travelled. Distance from the centre = how far from her; the angle = which direction (000° = north). The rotating line only shows the scope is live.'
        : 'You are the red dot in the centre. Blue dots are verified volunteers who accepted your SOS; green lines show the path each one has travelled. Distance from the centre = how far away they are; the angle = which direction they are coming from (000° = north). The rotating line only shows the scope is live.'}</p>` : ''}
      ${ppiTable(rows)}</div>
      <ul class="track-list">${list.map((r) => `<li class="track-row ${r.isYou ? 'is-you' : ''}"><span class="track-who"><strong>${esc(r.label)}</strong> ${r.verified ? '<span class="badge badge-ok">Verified</span>' : ''}<br><small>${esc(pretty(r.status))}${r.locationUpdatedAt ? ` · GPS <span data-live="age" data-fmt="short" data-at="${esc(r.locationUpdatedAt)}"></span> ago` : ''}</small></span></li>`).join('')}</ul>`
      : `<p class="muted">${esc(t('status_red'))}</p>`}
    <p class="muted small">Range = distance from her, bearing = direction from her (000° = north). Live from each responder's phone GPS; ETA is a straight-line estimate.${isDemo() ? ' Demo volunteers travel at a sped-up 120 km/h once "on my way".' : ''} ${esc(note)}</p></section>`;
}

function emergencyBar() {
  const c = country();
  return `<div class="emergency-bar" role="region" aria-label="Emergency calling">
    <p class="eb-title">${esc(c.name)} · ${esc(t('helplines'))} <a href="#/settings" class="eb-change">change country</a></p>
    <a class="btn btn-call" href="${telHref(c.emergency)}"><span class="eb-main">📞 ${esc(t('call_emergency', { n: c.emergency }))}</span><small class="eb-sub">${esc(c.emergencyLabel || 'Emergency services')}</small></a>
    ${(c.extra || []).map((h) => `<a class="btn btn-call-alt ${h.medical ? 'btn-medical' : ''}" href="${telHref(h.number)}"><span class="eb-main">${h.medical ? '🚑 ' : '📞 '}<strong>${esc(h.number)}</strong></span><small class="eb-sub">${esc(h.label)}</small></a>`).join('')}
    ${c.verified ? '' : `<span class="verify-note">${esc(c.name)}: number configured — verify locally before relying on it</span>`}
  </div>`;
}

function shell(content, { nav = true } = {}) {
  const role = st.me?.role;
  const links = {
    user: [['#/home', '🛡️', t('home')], ['#/tools', '🧰', t('tools')], ['#/settings', '⚙️', t('settings')]],
    volunteer: [['#/volunteer', '🤝', 'Volunteer'], ['#/settings', '⚙️', t('settings')]],
    operator: [['#/ops', '🛰️', 'Operations'], ['#/settings', '⚙️', t('settings')]],
    admin: [['#/admin', '🗂️', 'Admin'], ['#/ops', '🛰️', 'Operations'], ['#/settings', '⚙️', t('settings')]],
  }[role] || [];
  if (role && isDemo()) links.push(['#/demo', '🧪', 'Demo']);
  const cur = location.hash.split('/').slice(0, 2).join('/');
  return `
    ${isDemo() ? `<div class="demo-banner" role="note">🧪 ${esc(t('demo_banner'))}${st.cfg.standalone ? ' · Standalone (in-browser) mode' : ''}</div>` : ''}
    <header class="topbar">
      <a href="${role ? roleHome(role) : '#/'}" class="brand" aria-label="Beti Bachao home"><img src="icons/icon.svg" alt="" width="28" height="28"><span>Beti Bachao</span></a>
      <div class="topbar-right">
        <label class="sr-only" for="lang-select">${esc(t('language'))}</label>
        <select id="lang-select" class="lang-select" data-change="lang">${LANGS.map((l) => `<option value="${l.code}" ${l.code === lang() ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
        ${role ? `<button class="btn btn-ghost btn-sm" data-act="logout">${esc(t('logout'))}</button>` : `<a class="btn btn-ghost btn-sm" href="#/login">${esc(t('login'))}</a>`}
      </div>
    </header>
    <main id="main" tabindex="-1">${content}</main>
    ${nav && links.length ? `<nav class="bottom-nav" aria-label="Primary">${links.map(([h, i, l]) => `<a href="${h}" class="${cur === h ? 'active' : ''}" ${cur === h ? 'aria-current="page"' : ''}><span aria-hidden="true">${i}</span>${esc(l)}</a>`).join('')}</nav>` : ''}
  `;
}

// ------------------------------------------------------------------ landing / auth
function viewLanding() {
  return shell(`
    <section class="hero">
      <img src="icons/icon.svg" alt="" class="hero-logo" width="84" height="84">
      <h1>Beti Bachao</h1>
      <p class="lead">${esc(t('tagline'))}</p>
      <div class="hero-actions">
        <a href="#/login?as=user" class="btn btn-primary btn-lg heartbeat"><svg class="woman-icon" viewBox="0 0 24 32" aria-hidden="true" focusable="false"><circle cx="12" cy="4.6" r="3.4"/><circle cx="14.6" cy="2.2" r="1.7"/><path d="M9.4 9.4h5.2c.9 0 1.6.6 1.8 1.4l3.4 11.4c.2.6-.3 1.2-.9 1.2h-3.3v6.5a1.3 1.3 0 0 1-2.6 0v-6.5h-2v6.5a1.3 1.3 0 0 1-2.6 0v-6.5H5.1c-.6 0-1.1-.6-.9-1.2L7.6 10.8c.2-.8.9-1.4 1.8-1.4z"/><path d="M7.4 11.6 4.6 17.4a1.1 1.1 0 0 0 2 1l2.1-4.6zM16.6 11.6l2.8 5.8a1.1 1.1 0 0 1-2 1l-2.1-4.6z"/></svg>${esc(t('need_safety'))}</a>
        <a href="#/login?as=volunteer" class="btn btn-secondary btn-lg">${esc(t('want_volunteer'))}</a>
      </div>
      ${isDemo() ? '<p class="muted">Demo accounts are pre-filled on the login screen.</p>' : ''}
    </section>
    ${emergencyBar()}
    <section class="cards-3">
      <div class="card"><h3>🚨 SOS that doesn't stop at "sent"</h3><p>Hold, shake, voice keyword, silent or safe-walk timer. Staged 10 → 20 → 30 km search for verified volunteers, backup responders, and escalation if anything stalls.</p></div>
      <div class="card"><h3>🔐 Privacy by design</h3><p>Volunteers see only an approximate area until they are assigned. Every precise-location access is logged. A duress PIN looks like "cancel" but quietly escalates.</p></div>
      <div class="card"><h3>✅ Never "safe" without you</h3><p>Arrival never closes an SOS. Only your explicit "Yes, I am safe" — or an audited operator exception — ends it.</p></div>
    </section>
    <section class="card limits">
      <h3>Honest limits of this MVP</h3>
      <ul>
        <li><strong>Not an emergency service.</strong> Emergency-service dispatch is <strong>${esc(st.cfg?.simulatedLabel || 'SIMULATED')}</strong> until an approved integration exists. Always call your local emergency number in immediate danger.</li>
        <li>Location accuracy depends on your device. We show accuracy, age and "floor unknown" honestly — never a fake precise position.</li>
        <li>Browsers cannot send SMS silently. "Text my contacts" opens your SMS app pre-filled; you press send.</li>
        <li>Translations are drafts pending native-speaker review.</li>
      </ul>
    </section>
  `);
}

async function viewLogin(params) {
  let demo = null;
  if (isDemo()) { try { demo = await st.api.demoAccounts(); } catch {} }
  const want = params.get('as');
  const accounts = (demo?.accounts || []).filter((a) => !want || a.role === want || want === 'all');
  const groups = ['user', 'volunteer', 'operator', 'admin'].map((r) => [r, (demo?.accounts || []).filter((a) => a.role === r)]);
  return shell(`
    <section class="narrow">
      <h1>${esc(t('login'))}</h1>
      ${demo ? `<div class="card"><h3>Demo accounts</h3><p class="muted">Synthetic people only. ${st.cfg.standalone ? 'No password needed in standalone mode.' : `Password: <code>${esc(demo.password)}</code>. Operator/Admin need the demo MFA code (auto-filled).`}</p>
        ${groups.map(([r, list]) => list.length ? `<div class="demo-group"><h4>${esc(pretty(r))}</h4><div class="chip-row">${list.map((a) => `<button class="chip ${accounts.includes(a) && want ? 'chip-hl' : ''}" data-act="demo-login" data-email="${esc(a.email)}" data-role="${esc(a.role)}"><span class="chip-name">${esc(a.displayName.replace(/ \(.*\)$/, ''))}</span>${DEMO_BLURBS[a.email] ? `<small class="chip-blurb">${esc(DEMO_BLURBS[a.email])}</small>` : ''}</button>`).join('')}</div></div>` : '').join('')}
      </div>` : ''}
      <form class="card form" data-form="login" autocomplete="on">
        <label>Email<input name="email" type="email" required autocomplete="username"></label>
        <label>Password<input name="password" type="password" ${st.cfg?.standalone ? '' : 'required'} autocomplete="current-password"></label>
        <label class="mfa hidden">Authenticator code (operators/admins)<input name="mfaCode" inputmode="numeric" pattern="\\d{6}" autocomplete="one-time-code"></label>
        <button class="btn btn-primary" type="submit">${esc(t('login'))}</button>
        <p class="muted">New here? <a href="#/register">Create an account</a></p>
      </form>
    </section>`);
}

function viewRegister() {
  return shell(`
    <section class="narrow">
      <h1>Create account</h1>
      <form class="card form" data-form="register">
        <label>Display name<input name="displayName" required maxlength="60"></label>
        <label>Email<input name="email" type="email" required></label>
        ${st.cfg?.standalone ? '' : '<label>Password (8+ characters)<input name="password" type="password" minlength="8" required></label>'}
        <fieldset><legend>I am joining as</legend>
          <label class="radio"><input type="radio" name="role" value="user" checked> Someone who wants safety tools</label>
          <label class="radio"><input type="radio" name="role" value="volunteer"> A volunteer responder (verification + training required)</label>
        </fieldset>
        <label>Country<select name="countryCode">${Object.entries(st.cfg.countries).map(([c, v]) => `<option value="${c}" ${c === 'IN' ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <button class="btn btn-primary" type="submit">Create account</button>
      </form>
    </section>`);
}

// ------------------------------------------------------------------ user: home
function locationCard(loc, { live = false } = {}) {
  const p = prefs.get();
  if (!loc) {
    return `<div class="card loc-card"><div class="loc-head"><strong>📍 ${esc(t('location'))}</strong><span class="badge badge-warn">${esc(t('location_off'))}</span></div>
      <p class="muted">${geo.supported ? 'Location helps volunteers find you. You can still send SOS without it.' : 'This browser has no location support.'}</p>
      ${geo.supported ? `<button class="btn btn-secondary" data-act="share-location">${esc(t('allow_location'))}</button>` : ''}
      ${isDemo() ? `<label class="switch"><input type="checkbox" data-change="synthetic" ${p.synthetic ? 'checked' : ''}> Use synthetic demo location (Kurnool)</label>` : ''}</div>`;
  }
  const ageSec = loc.ageSec ?? Math.round((Date.now() - Date.parse(loc.observedAt)) / 1000);
  const staleNow = loc.stale || ageSec > 120;
  return `<div class="card loc-card">
    <div class="loc-head"><strong>📍 ${esc(t('location'))}</strong><span class="badge ${loc.source === 'synthetic' ? 'badge-info' : 'badge-ok'}">${esc(loc.source === 'synthetic' ? 'Synthetic (demo)' : t('location_on'))}</span></div>
    <div class="loc-grid">
      <div><span class="k">${esc(t('accuracy', { m: loc.accuracyM }))}</span>${loc.lowAccuracy || loc.accuracyM > 100 ? `<span class="badge badge-warn">${esc(t('low_accuracy'))}</span>` : ''}</div>
      <div><span class="k" data-live="age" data-at="${esc(loc.observedAt)}"></span>${staleNow ? `<span class="badge badge-warn">${esc(t('stale'))}</span>` : ''}</div>
      <div class="full"><span class="k">${esc(loc.vertical || t('floor_unknown'))}</span>${loc.altitudeNote ? `<small class="muted">${esc(loc.altitudeNote)}</small>` : ''}</div>
    </div>
    ${live ? `<form class="inline-form" data-form="floor"><label>Floor (optional, if safe)<input name="floor" type="number" min="-5" max="200" inputmode="numeric"></label><button class="btn btn-ghost btn-sm">Add</button></form>` : ''}
    ${isDemo() && !live ? `<label class="switch"><input type="checkbox" data-change="synthetic" ${p.synthetic ? 'checked' : ''}> Use synthetic demo location (Kurnool)</label>` : ''}
  </div>`;
}

function currentLoc() {
  const p = prefs.get();
  if (isDemo() && p.synthetic && st.cfg.demoCenter) return syntheticLocation(st.cfg.demoCenter);
  return geo.last;
}

async function viewHome() {
  let open = null;
  try { const r = await st.api.myIncidents(); open = r.items.find((i) => i.open); } catch {}
  const pending = store.get('pendingSos', null);
  const sw = safeWalk.get();
  const loc = currentLoc();
  return shell(`
    ${pending ? `<div class="alert alert-danger" role="alert"><strong>${esc(t('offline_queued'))}</strong><div class="row">${smsButtons()}</div></div>` : ''}
    ${open ? `<a class="alert alert-danger alert-link" href="#/incident/${esc(open.id)}">🔴 Active SOS — ${esc(pretty(open.status))}. Tap to view.</a>` : ''}
    ${sw ? `<div class="alert alert-info"><strong>⏱️ ${esc(t('safe_walk'))}:</strong> <span data-live="safewalk"></span> <button class="btn btn-primary btn-sm" data-act="safewalk-checkin">${esc(t('check_in'))}</button></div>` : ''}
    <section class="sos-wrap">
      <button class="sos-btn" id="sos-btn" aria-describedby="sos-hint" data-hold="sos">
        <svg viewBox="0 0 120 120" class="sos-ring" aria-hidden="true"><circle cx="60" cy="60" r="54" class="sos-track"/><circle cx="60" cy="60" r="54" class="sos-progress" id="sos-progress"/></svg>
        <span class="sos-label">${esc(t('sos'))}</span>
      </button>
      <p id="sos-hint" class="sos-hint">${esc(t('hold_to_send'))}</p>
      ${contacts.list().length ? '' : `<a class="alert alert-info alert-link" href="#/settings">👥 ${esc(t('add_contacts_hint'))}</a>`}
      <p class="hint-strong">${esc(t('call_now_hint'))}</p>
    </section>
    ${emergencyBar()}
    ${locationCard(loc)}
    <section class="tool-grid" aria-label="${esc(t('tools'))}">
      <button class="tool" data-act="siren">📢<span>${esc(t('siren'))}</span></button>
      <button class="tool" data-act="fake-call">📱<span>${esc(t('fake_call'))}</span></button>
      <button class="tool" data-act="record-toggle">🎙️<span>${esc(recorder.recording ? t('stop') : t('record'))}</span></button>
      <a class="tool" href="#/tools">⏱️<span>${esc(t('safe_walk'))}</span></a>
      <button class="tool" data-act="share-now">📤<span>${esc(t('text_contacts'))}</span></button>
      <a class="tool" href="#/settings">👥<span>${esc(t('contacts'))} (${contacts.list().length})</span></a>
    </section>
  `);
}

function sosMessage(loc) {
  return t('sms_message', { link: loc ? mapsLink(loc) : '(location unavailable)', m: loc?.accuracyM ?? '?' });
}
function smsButtons() {
  const loc = geo.last || currentLoc();
  const nums = contacts.list().map((c) => c.phone);
  const msg = sosMessage(loc);
  return `${nums.length ? `<a class="btn btn-secondary" href="${esc(smsHref(nums, msg))}">💬 ${esc(t('text_contacts'))}</a>` : '<a class="btn btn-ghost" href="#/settings">+ Add trusted contacts</a>'}
    <a class="btn btn-ghost" href="${esc(whatsappHref(msg))}" target="_blank" rel="noopener">🟢 ${esc(t('share_whatsapp'))}</a>`;
}

// ------------------------------------------------------------------ SOS
async function triggerSOS({ severity = 'HIGH', silent = false, trigger = 'button' } = {}) {
  if (st.sendingSos) return;
  st.sendingSos = true;
  const isRetry = !!store.get('pendingSos', null);
  const pending = store.get('pendingSos', null) || { key: uuid(), createdAt: new Date().toISOString(), severity, silent, trigger };
  store.set('pendingSos', pending);
  // Open the pre-filled "I am in danger + location" SMS to trusted contacts right away,
  // while the tap/hold still counts as a user gesture. Browsers cannot send SMS silently;
  // the phone's SMS app opens ready to send. The SOS continues in the background.
  if (!isRetry && prefs.get().autoSms && contacts.list().length) {
    const nums = contacts.list().map((c) => c.phone);
    const loc0 = (isDemo() && prefs.get().synthetic && st.cfg.demoCenter) ? syntheticLocation(st.cfg.demoCenter) : geo.last;
    store.set('autoSmsAt', Date.now());
    openExternal(smsHref(nums, sosMessage(loc0)));
  }
  if (!silent) vibrate([200, 100, 200]);
  keepAwake(true);
  if (!silent) toast(t('sending'), 'warn');
  let loc = null;
  const p = prefs.get();
  if (isDemo() && p.synthetic && st.cfg.demoCenter) loc = syntheticLocation(st.cfg.demoCenter);
  else {
    if (geo.last && Date.now() - Date.parse(geo.last.observedAt) < 30000) loc = geo.last;
    else { try { loc = await Promise.race([geo.once(6000), new Promise((r) => setTimeout(() => r(null), 4000))]); } catch { loc = null; } }
    geo.start();
    // Demo only: if the phone can't get a GPS fix, use the synthetic area so the walkthrough still reaches volunteers.
    if (isDemo() && !loc && st.cfg.demoCenter) loc = syntheticLocation(st.cfg.demoCenter);
    if (isDemo() && loc && loc.source !== 'synthetic') { try { await st.api.demoRelocate(loc.lat, loc.lng); } catch {} }
  }
  const body = { idempotencyKey: pending.key, location: loc, severity: pending.severity, trigger: pending.trigger, silent: pending.silent, battery: await battery() };
  try {
    const r = await st.api.createIncident(body);
    store.set('pendingSos', null);
    store.set('lastIncident', r.incident.id);
    st.sendingSos = false;
    if (!silent && p.autoRecord && recorder.supported && !recorder.recording) { recorder.start('audio').catch(() => {}); }
    go(`#/incident/${r.incident.id}${silent ? '?silent=1' : ''}`);
  } catch (e) {
    st.sendingSos = false;
    if (e.code === 'NETWORK') { toast(t('offline_queued'), 'error', 8000); render(); scheduleSosRetry(); }
    else { store.set('pendingSos', null); showErr(e); }
  }
}
let retryTimer = null;
function scheduleSosRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => { const p = store.get('pendingSos', null); if (p && navigator.onLine !== false) await triggerSOS(p); else if (p) scheduleSosRetry(); }, 5000);
}

function startCountdown(kind, seconds = 5) {
  if (st.countdown) return;
  const label = { shake: 'shake_detected', voice: 'voice_detected', safewalk: 'safe_walk_expired' }[kind];
  const el = document.createElement('div');
  el.className = 'countdown';
  el.setAttribute('role', 'alertdialog');
  el.innerHTML = `<p class="countdown-text"></p><button class="btn btn-light btn-lg" data-cd="cancel">${esc(t('cancel'))}</button><button class="btn btn-primary btn-lg" data-cd="now">SOS now</button>`;
  document.body.appendChild(el);
  let left = seconds;
  const upd = () => { el.querySelector('.countdown-text').textContent = t(label, { s: left }); vibrate(150); };
  upd();
  const iv = setInterval(() => { left -= 1; if (left <= 0) { finish(true); } else upd(); }, 1000);
  const finish = (send) => { clearInterval(iv); el.remove(); st.countdown = null; if (send) triggerSOS({ trigger: kind }); };
  el.addEventListener('click', (e) => { const b = e.target.closest('[data-cd]'); if (b) finish(b.dataset.cd === 'now'); });
  st.countdown = { finish };
}

function bindHold() {
  const btn = $('#sos-btn');
  if (!btn) return;
  const ring = $('#sos-progress');
  const C = 2 * Math.PI * 54;
  ring.style.strokeDasharray = `${C}`;
  ring.style.strokeDashoffset = `${C}`;
  let start = 0, raf = 0;
  const HOLD = 3000;
  const tick = () => {
    const p = Math.min(1, (performance.now() - start) / HOLD);
    ring.style.strokeDashoffset = `${C * (1 - p)}`;
    if (p >= 1) { reset(); vibrate(300); triggerSOS({ trigger: 'hold' }); return; }
    raf = requestAnimationFrame(tick);
  };
  const reset = () => { cancelAnimationFrame(raf); start = 0; ring.style.strokeDashoffset = `${C}`; btn.classList.remove('holding'); };
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); btn.setPointerCapture?.(e.pointerId); start = performance.now(); btn.classList.add('holding'); vibrate(40); raf = requestAnimationFrame(tick); });
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) btn.addEventListener(ev, reset);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Keyboard / switch-access users: confirm dialog instead of hold.
  btn.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const r = await modal({ title: 'Send SOS now?', body: `<p>${esc(t('call_now_hint'))}</p>`, actions: [{ id: 'send', label: 'Send SOS', kind: 'danger' }, { id: 'no', label: t('cancel') }] });
    if (r.id === 'send') triggerSOS({ trigger: 'keyboard' });
  });
}

// ------------------------------------------------------------------ user: incident
async function viewIncident(id, params) {
  let v;
  try { v = await st.api.getIncident(id); } catch (e) { return shell(`<div class="alert alert-danger">${esc(e.message)}</div>`); }
  st.incident = v;
  if (v.search?.deadline && v.search.secondsLeft != null) st.skew = (Date.parse(v.search.deadline) - v.search.secondsLeft * 1000) - Date.now();
  let tl = [];
  try { tl = (await st.api.timeline(id)).items; } catch {}
  const silent = params.get('silent') === '1';
  if (v.role !== 'requester') return shell('<p>Not your incident.</p>');
  const open = !v.closed;
  const radii = st.cfg?.radiusStagesKm || [10, 20, 30];
  const stages = [0, 1, 2].map((i) => `<li class="${v.search?.stage === i ? 'on' : v.search?.stage > i ? 'done' : ''}">${esc(radii[i])} km</li>`).join('');
  return shell(`
    <section class="status-hero status-${esc(v.color)} ${silent ? 'discreet' : ''}" aria-live="polite">
      <div class="status-dot" aria-hidden="true"></div>
      <h1>${esc(statusText(v))}</h1>
      ${open && v.search?.radiusKm ? `<p>${esc(t('searching_within', { km: v.search.radiusKm }))} · ${esc(t('volunteers_alerted', { n: v.alertedCount }))}</p>` : ''}
      ${open && v.search?.secondsLeft != null && (v.responders?.length || 0) < 2 ? `<p class="small"><span data-live="stage-countdown" data-deadline="${esc(v.search.deadline)}"></span></p>` : ''}
      <ol class="stage-bar" aria-label="Search stages">${stages}</ol>
    </section>
    ${open && v.status === 'LOCATION_UNAVAILABLE' ? `<div class="alert alert-danger" role="alert"><strong>📍 We don't have your location yet, so volunteers can't be matched.</strong> Call a number below now, and allow location for this site.<div class="row"><button class="btn btn-secondary" data-act="share-location">${esc(t('allow_location'))}</button></div></div>` : ''}
    ${open ? emergencyBar() : ''}
    ${v.escalations?.length ? `<div class="alert alert-warn"><strong>Escalation:</strong> ${v.escalations.map((e) => `${esc(pretty(e.type))} — <em>${esc(e.label)}</em>`).join('<br>')}<p class="small">Call one of the numbers above yourself — this app has not contacted them.</p></div>` : ''}
    ${open ? `
    ${trackingCard(v.responders, v.location, v.radiusStagesKm, { title: t('responders') })}
    <section class="action-grid">
      <button class="btn btn-safe btn-lg" data-act="are-you-safe">✅ ${esc(t('are_you_safe'))}</button>
      <button class="btn btn-danger" data-act="more-help">🆘 ${esc(t('need_help'))}</button>
      <button class="btn btn-warn" data-act="report-danger">⚠️ ${esc(t('report_danger'))}</button>
      <button class="btn btn-secondary" data-act="siren">📢 ${esc(t('siren'))}</button>
      <button class="btn btn-secondary" data-act="record-toggle">🎙️ ${esc(recorder.recording ? t('stop') : t('record'))}</button>
      <button class="btn btn-ghost" data-act="cancel-sos">${esc(t('cancel_sos'))}</button>
    </section>
    ${contacts.list().length ? `<div class="card"><h2>📞 ${esc(t('contacts'))}</h2><p class="small muted">${esc(t('text_contacts'))}: <a href="${esc(smsHref(contacts.list().map((c) => c.phone), sosMessage(v.location || geo.last)))}">💬 SMS with latest location</a></p><div class="row">${contacts.list().map((c) => `<a class="btn btn-secondary" href="${telHref(c.phone)}">📞 ${esc(c.name)}</a>`).join('')}</div></div>` : ''}
    <div class="card"><div class="row">${smsButtons()}<button class="btn btn-ghost" data-act="native-share">📤 Share…</button></div></div>
    ${locationCard(v.location, { live: true })}
    ${v.location ? `<section class="card"><h2>📍 Your live location (as shared)</h2>${googleMap(v.location, 'Your live location', 'mine')}</section>` : ''}
    ` : `<section class="card"><p>${v.closureReason === 'USER_CONFIRMED_SAFE' ? '💚 You confirmed you are safe. Responders have been released.' : 'This SOS has ended.'}</p><a class="btn btn-primary" href="#/home">${esc(t('home'))}</a></section>${emergencyBar()}`}
    <details class="card" data-keep="user-timeline"><summary>${esc(t('timeline'))} (${tl.length})</summary><ol class="timeline">${tl.map((x) => `<li><time>${esc(fmtTime(x.at))}</time> ${esc(pretty(x.text))}${x.reason ? ` <small class="muted">— ${esc(x.reason)}</small>` : ''}</li>`).join('')}</ol></details>
  `);
}

let lastVolPost = 0;
async function streamVolunteerLocation() {
  if (st.me?.role !== 'volunteer' || !st.activeAsg || Date.now() - lastVolPost < 10000) return;
  if (isDemo() && prefs.get().synthetic) return; // demo volunteers' movement is simulated
  lastVolPost = Date.now();
  geo.start();
  if (!geo.last) return;
  try { await st.api.assignmentStatus(st.activeAsg, { location: geo.last }); } catch {}
}

async function streamLocation() {
  const v = st.incident;
  if (!v || v.closed || v.role !== 'requester') return;
  if (Date.now() - st.lastLocPost < 10000) return;
  const loc = currentLoc();
  if (!loc) return;
  st.lastLocPost = Date.now();
  if (isDemo() && !v.location && loc.source !== 'synthetic') { try { await st.api.demoRelocate(loc.lat, loc.lng); } catch {} }
  try { await st.api.addLocation(v.id, loc); } catch {}
}

async function askSafe() {
  const v = st.incident;
  const r = await modal({ title: t('are_you_safe'), cls: 'safe-modal', body: '<p class="muted">Responders stay with you until you say you are safe.</p>', actions: [{ id: 'YES', label: t('yes_safe'), kind: 'safe' }, { id: 'NO', label: t('not_safe'), kind: 'danger' }, { id: 'NEED_MORE_HELP', label: t('need_help'), kind: 'warn' }] });
  if (r.id === 'dismiss') return;
  try {
    if (r.id === 'YES') {
      const c = await modal({ title: t('confirm_safe'), body: '<p>This will close your SOS and release volunteers.</p>', actions: [{ id: 'confirm', label: t('confirm_safe'), kind: 'safe' }, { id: 'no', label: t('cancel') }] });
      if (c.id !== 'confirm') return;
      await st.api.safety(v.id, { response: 'YES', confirm: true });
      siren.stop(); keepAwake(false); geo.stop();
      if (recorder.recording) await recorder.stop();
      toast(t('status_green'), 'ok');
    } else {
      await st.api.safety(v.id, { response: r.id });
      toast('Escalated. Help search continues.', 'warn');
    }
    render();
  } catch (e) { showErr(e); }
}

// ------------------------------------------------------------------ tools
async function viewTools() {
  const clips = await recorder.list();
  const sw = safeWalk.get();
  return shell(`
    <h1>${esc(t('tools'))}</h1>
    <section class="card"><h2>⏱️ ${esc(t('safe_walk'))}</h2>
      <p><strong>For walking or travelling alone</strong> — e.g. walking home at night or taking a cab.</p>
      <ol class="small"><li>Set how long the trip should take (say 15 minutes) and tap Start.</li><li>When you arrive safely, tap <b>"I'm OK — check in"</b>.</li><li>If you <b>don't</b> check in in time — because something happened or your phone was taken — a 30-second countdown starts and then an SOS is sent automatically.</li></ol>
      <p class="muted small">Keep this app open during the trip.</p>
      ${sw ? `<p><strong data-live="safewalk"></strong></p><div class="row"><button class="btn btn-primary" data-act="safewalk-checkin">${esc(t('check_in'))}</button><button class="btn btn-ghost" data-act="safewalk-stop">${esc(t('stop'))}</button></div>`
        : `<form class="inline-form" data-form="safewalk"><label>${esc(t('minutes'))}<input name="minutes" type="number" min="1" max="240" value="15" required></label><button class="btn btn-primary">${esc(t('start'))}</button></form>`}
    </section>
    <section class="card"><h2>📢 ${esc(t('siren'))}</h2><p class="muted">Loud alarm with a flashing screen to draw attention.</p><button class="btn btn-danger" data-act="siren">${esc(siren.on ? t('stop') : t('start'))}</button></section>
    <section class="card"><h2>📱 ${esc(t('fake_call'))}</h2><p class="muted">Simulates an incoming call so you have a reason to leave.</p>
      <form class="inline-form" data-form="fakecall"><label>Caller<input name="caller" value="${esc(prefs.get().fakeCaller)}" maxlength="30"></label><label>Delay (s)<input name="delay" type="number" min="0" max="300" value="5"></label><button class="btn btn-secondary">${esc(t('start'))}</button></form></section>
    <section class="card"><h2>🎙️ ${esc(t('record'))}</h2>
      <p class="muted">Recordings stay on this device only (not uploaded). Download them to keep a copy.</p>
      ${recorder.supported ? `<div class="row"><button class="btn btn-secondary" data-act="record-toggle">${esc(recorder.recording ? t('stop') : '🎙️ Audio')}</button>${recorder.recording ? '' : '<button class="btn btn-ghost" data-act="record-video">🎥 Video</button>'}</div>` : '<p>Recording is not supported in this browser.</p>'}
      <ul class="clip-list">${clips.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((c) => `<li><span>${c.kind === 'video' ? '🎥' : '🎙️'} ${esc(new Date(c.createdAt).toLocaleString())} · ${esc(c.durationSec)}s</span><span><button class="btn btn-ghost btn-sm" data-act="clip-dl" data-id="${esc(c.id)}">Download</button><button class="btn btn-ghost btn-sm" data-act="clip-del" data-id="${esc(c.id)}">Delete</button></span></li>`).join('') || '<li class="muted">No recordings yet.</li>'}</ul>
    </section>
    ${emergencyBar()}
  `);
}

// ------------------------------------------------------------------ settings
async function viewSettings() {
  const p = prefs.get();
  const me = st.me;
  let history = [];
  if (me.role === 'user') { try { history = (await st.api.myIncidents()).items; } catch {} }
  const c = country();
  return shell(`
    <h1>${esc(t('settings'))}</h1>
    <section class="card form"><h2>🌐 ${esc(t('language'))} & country</h2>
      <label>${esc(t('language'))}<select data-change="lang">${LANGS.map((l) => `<option value="${l.code}" ${l.code === lang() ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
      <label>Country (emergency numbers)<select data-change="country">${Object.entries(st.cfg.countries).map(([k, v]) => `<option value="${k}" ${k === c.code ? 'selected' : ''}>${esc(v.name)} — ${esc(v.emergency)}${v.verified ? '' : ' (verify)'}</option>`).join('')}</select></label>
      <p class="muted">${esc(t('helplines'))}: ${[`${c.emergency}`, ...(c.extra || []).map((h) => `${h.label} ${h.number}`)].map(esc).join(' · ')}</p>
    </section>
    ${me.role === 'user' ? `
    <section class="card"><h2>👥 ${esc(t('contacts'))}</h2>
      <ul class="contact-list">${contacts.list().map((x, i) => `<li><span>${esc(x.name)} · ${esc(x.phone)}</span><button class="btn btn-ghost btn-sm" data-act="contact-del" data-i="${i}" aria-label="Remove ${esc(x.name)}">✕</button></li>`).join('') || '<li class="muted">No contacts yet. They get a pre-filled SMS from your phone during an SOS.</li>'}</ul>
      <form class="inline-form" data-form="contact"><label>${esc(t('name'))}<input name="name" required maxlength="40"></label><label>${esc(t('phone'))}<input name="phone" type="tel" required></label><button class="btn btn-secondary">${esc(t('add'))}</button></form>
      <p class="muted small">Stored only on this device.</p>
    </section>
    <section class="card form"><h2>🔐 ${esc(t('your_safety_pin'))}</h2>
      <p class="muted">${me.hasPins ? 'PINs are set.' : 'Without a PIN, cancelling needs only a confirmation tap.'} The <strong>duress PIN</strong> makes the app show "cancelled" while it secretly keeps help coming — useful if someone forces you to cancel.</p>
      <form data-form="pins" class="inline-form"><label>${esc(t('cancel_pin'))}<input name="cancelPin" inputmode="numeric" pattern="\\d{4,6}" required maxlength="6" type="password"></label><label>${esc(t('duress_pin'))}<input name="duressPin" inputmode="numeric" pattern="\\d{4,6}" maxlength="6" type="password"></label><button class="btn btn-secondary">${esc(t('save'))}</button></form>
    </section>
    <section class="card form"><h2>⚡ ${esc(t('triggers'))}</h2>
      <label class="switch"><input type="checkbox" data-change="autoSms" ${p.autoSms ? 'checked' : ''}> ${esc(t('auto_sms'))}</label>
      <label class="switch"><input type="checkbox" data-change="shake" ${p.shake ? 'checked' : ''}> ${esc(t('shake_trigger'))}</label>
      <label class="switch"><input type="checkbox" data-change="voice" ${p.voice ? 'checked' : ''} ${voice.supported ? '' : 'disabled'}> ${esc(t('voice_trigger'))} ${voice.supported ? '' : '<small>(not supported in this browser)</small>'}</label>
      <label class="switch"><input type="checkbox" data-change="autoRecord" ${p.autoRecord ? 'checked' : ''}> ${esc(t('auto_record'))}</label>
      <p class="muted small">Shake and voice triggers start a 5-second countdown you can cancel, then send SOS. They work while this app is open on screen; browsers pause sensors in the background.</p>
    </section>
    <section class="card"><h2>📜 ${esc(t('history'))}</h2><ul class="history">${history.map((h) => `<li><a href="#/incident/${esc(h.id)}">${esc(new Date(h.createdAt).toLocaleString())}</a> — ${esc(pretty(h.status))}</li>`).join('') || '<li class="muted">No SOS yet.</li>'}</ul></section>` : ''}
    <section class="card"><h2>🛡️ ${esc(t('privacy'))}</h2>
      <p class="muted">Signed in as ${esc(me.displayName)} (${esc(me.role)}).</p>
      <div class="row">${['user', 'volunteer'].includes(me.role) ? '<button class="btn btn-ghost" data-act="export">Download my data</button><button class="btn btn-ghost danger-text" data-act="delete-account">Delete my account</button>' : ''}<button class="btn btn-ghost" data-act="report-abuse">Report a concern</button></div>
    </section>
  `);
}

// ------------------------------------------------------------------ volunteer
const CONDUCT = [
  'Do not fight, threaten, retaliate or act as a vigilante.',
  "Put the woman's wishes, safety and consent first.",
  'Do not confront an alleged offender or enter private property unlawfully.',
  'Call emergency services when violence, weapons, injury or imminent danger is suspected.',
  'Help her reach a safer public place only if she agrees — never force relocation.',
  'Never ask for money, favours, photos or contact details.',
  'Do not photograph, record, follow or share her location beyond the response.',
  'Never share screenshots, identity or incident details outside authorised channels.',
  'If you cannot continue safely, tap "Unable to help" immediately so someone else is assigned.',
  'You are accountable for your status, arrival and handover.',
];

async function viewVolunteer() {
  let prof, alerts = [];
  try { prof = await st.api.volunteerProfile(); alerts = (await st.api.volunteerAlerts()).items; } catch (e) { return shell(`<div class="alert alert-danger">${esc(e.message)}</div>`); }
  const el = prof.eligibility;
  const check = (ok, label) => `<li class="${ok ? 'ok' : 'no'}">${ok ? '✅' : '⬜'} ${esc(label)}</li>`;
  const sel = alerts.find((a) => a.id === st.volSel) || alerts.find((a) => a.open);
  const reasons = el.reasons;
  const fresh = alerts.filter((a) => a.open && !a.alertResponse && !a.assignment);
  st.activeAsg = alerts.find((a) => a.open && a.assignment)?.assignment.id || null;
  return shell(`
    ${fresh.length ? `<button class="alert alert-danger alert-link sos-incoming" data-act="vol-select" data-id="${esc(fresh[0].id)}">🚨 New SOS nearby (${esc(fresh[0].distanceBand)}) — tap to respond</button>` : ''}
    <h1>Volunteer</h1>
    <section class="card">
      <div class="row space"><h2>Readiness</h2><span class="badge ${el.eligible ? 'badge-ok' : 'badge-warn'}">${el.eligible ? 'Ready to receive alerts' : 'Not receiving alerts'}</span></div>
      <ul class="checklist">
        ${check(prof.verificationStatus === 'VERIFIED' && !reasons.includes('verification expired'), `Identity verified (${pretty(prof.verificationStatus)})`)}
        ${check(!reasons.includes('training incomplete'), `Training ${prof.trainingCompleted.length}/${prof.trainingModules.length}`)}
        ${check(prof.available, 'Available')}
        ${check(!reasons.includes('location stale'), 'Location shared in last 30 min')}
        ${check(!reasons.includes('busy on another incident'), 'Not on another incident')}
        ${reasons.includes('suspended') ? '<li class="no">⛔ Account suspended — contact the trust team</li>' : ''}
      </ul>
      <div class="row">
        <button class="btn ${prof.available ? 'btn-ghost' : 'btn-primary'}" data-act="vol-avail" data-on="${prof.available ? '0' : '1'}">${prof.available ? 'Go off duty' : 'Go on duty'}</button>
        <button class="btn btn-secondary" data-act="vol-locate">📍 Update my location</button>
      </div>
    </section>
    ${prof.verificationStatus !== 'VERIFIED' ? `<section class="card"><h2>Identity verification</h2>
      ${prof.verificationStatus === 'PENDING' ? '<p>Submitted. Waiting for admin review.</p>' : `<p class="muted">Demo uses a <strong>mock provider</strong>: no ID documents are collected. Production needs a lawful, reviewed provider plus background screening where permitted.</p><button class="btn btn-primary" data-act="vol-verify">Start verification</button>`}
    </section>` : ''}
    ${prof.trainingCompleted.length < prof.trainingModules.length ? `<section class="card"><h2>Training</h2><ul class="training">${prof.trainingModules.map((m) => `<li>${prof.trainingCompleted.includes(m.id) ? '✅' : `<button class="btn btn-ghost btn-sm" data-act="vol-train" data-id="${esc(m.id)}">Start</button>`} ${esc(m.title)}</li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>Alerts</h2>
      ${alerts.length ? `<ul class="alert-list">${alerts.map((a) => `<li><button class="alert-item status-${esc(a.color)} ${sel?.id === a.id ? 'sel' : ''}" data-act="vol-select" data-id="${esc(a.id)}"><span class="dot"></span><span>${a.severity === 'HIGH' ? '🔥 ' : ''}${esc(a.open ? pretty(a.status) : 'Ended')} · ${esc(a.distanceBand)}</span><small>${esc(fmtTime(a.createdAt))}${a.assignment ? ' · <b>assigned</b>' : ''}</small></button></li>`).join('')}</ul>` : '<p class="muted">No alerts. Stay on duty with a fresh location to receive them.</p>'}
    </section>
    ${sel ? volunteerDetail(sel) : ''}
    <details class="card" data-keep="conduct"><summary>Volunteer Code of Conduct</summary><ol>${CONDUCT.map((c) => `<li>${esc(c)}</li>`).join('')}</ol></details>
  `);
}

function volunteerDetail(a) {
  const asg = a.assignment;
  const next = { ACCEPTED: ['EN_ROUTE', "I'm on my way"], EN_ROUTE: ['ARRIVED', "I've arrived"], ARRIVED: ['ASSISTING', 'Assisting now'] }[asg?.status];
  return `<section class="card vol-detail status-border-${esc(a.color)}">
    <h2>${a.severity === 'HIGH' ? '🔥 Immediate danger · ' : ''}${esc(a.open ? pretty(a.status) : 'Incident ended')}</h2>
    <p>Distance: <strong>${esc(a.distanceBand)}</strong>${a.approxEtaMin ? ` · ≈${esc(a.approxEtaMin)} min (estimate)` : ''}</p>
    ${a.escalationStatus && a.escalationStatus !== 'NONE' ? `<p class="badge badge-warn">Escalation ${esc(a.escalationStatus)} — ${esc(st.cfg.simulatedLabel)}</p>` : ''}
    ${!asg && a.otherResponders?.length ? trackingCard(a.otherResponders, null, null, { title: 'Volunteers already responding', map: false, note: 'Exact positions are shown only to assigned responders.' }) : ''}
    ${asg && a.location ? `
      <div class="precise"><strong>Exact location (shared because you are assigned — access is logged)</strong>
        <p>±${esc(a.location.accuracyM)} m · <span data-live="age" data-fmt="short" data-at="${esc(a.location.observedAt)}"></span> old ${a.location.stale ? '<span class="badge badge-warn">stale</span>' : ''} · ${esc(a.location.vertical)}</p>
        ${a.battery ? `<p>Her battery: ${Math.round(a.battery.level * 100)}%${a.battery.charging ? ' (charging)' : ''}</p>` : ''}
      </div>
      <h3>🧭 Route to her</h3>
      ${googleDirections(a.team?.find((x) => x.isYou)?.position, a.location, 'Route to her', 'route')}
      ${trackingCard(a.team, a.location, a.radiusStagesKm, { title: 'Responding team', key: 'team', viewer: 'volunteer' })}
      <div class="row">${next ? `<button class="btn btn-primary" data-act="vol-status" data-aid="${esc(asg.id)}" data-status="${next[0]}">${esc(next[1])}</button>` : '<p>Stay with her until she confirms she is safe in the app.</p>'}
        <button class="btn btn-warn" data-act="vol-escalate" data-id="${esc(a.id)}">Request emergency escalation</button>
        <button class="btn btn-ghost" data-act="vol-unable" data-aid="${esc(asg.id)}">Unable to help</button></div>
    ` : a.open && !a.alertResponse ? `
      <p class="muted">${esc(a.precisionNote || '')}</p>
      ${a.approxArea ? `<p>Approximate area (±${esc(a.approxArea.uncertaintyKm)} km) — exact position after acceptance.</p>` : ''}
      <div class="row"><button class="btn btn-primary btn-lg" data-act="vol-accept" data-id="${esc(a.id)}">Accept & respond</button><button class="btn btn-ghost" data-act="vol-decline" data-id="${esc(a.id)}">Decline</button></div>
      <p class="muted small">By accepting you agree to the Code of Conduct. Accepting does not end the search — backup is kept looking.</p>
    ` : `<p class="muted">${a.alertResponse ? `You responded: ${esc(pretty(a.alertResponse))}.` : ''}</p>`}
    <button class="btn btn-ghost btn-sm" data-act="report-abuse" data-id="${esc(a.id)}">Report a concern</button>
  </section>`;
}

// ------------------------------------------------------------------ operations
async function viewOps() {
  let list = [];
  const all = store.get('ops.all', false);
  try { list = (await st.api.opIncidents(all)).items; } catch (e) { return shell(`<div class="alert alert-danger">${esc(e.message)}</div>`); }
  const selId = st.opSel && list.some((i) => i.id === st.opSel) ? st.opSel : list[0]?.id;
  let d = null, tl = [], cfg = null;
  if (selId) { try { d = await st.api.getIncident(selId); if (d.search?.deadline && d.search.secondsLeft != null) st.skew = (Date.parse(d.search.deadline) - d.search.secondsLeft * 1000) - Date.now(); tl = (await st.api.timeline(selId)).items; cfg = (await st.api.adminConfig()).config; } catch {} }
  return shell(`
    <div class="row space"><h1>Operations console</h1><label class="switch"><input type="checkbox" data-change="ops-all" ${all ? 'checked' : ''}> Show closed</label></div>
    <div class="ops-layout">
      <section class="card ops-list"><h2>Incidents (${list.length})</h2>
        <ul>${list.map((i) => `<li><button class="alert-item status-${esc(i.color)} ${i.id === selId ? 'sel' : ''}" data-act="op-select" data-id="${esc(i.id)}"><span class="dot"></span>
          <span>${i.duress ? '🚩 DURESS · ' : ''}${i.severity === 'HIGH' ? '🔥 ' : ''}${esc(pretty(i.status))}</span>
          <small>${esc(fmtTime(i.createdAt))} · ${i.radiusKm ? esc(i.radiusKm) + ' km' : '—'} · ${esc(i.responders)} resp · ${i.location ? `±${esc(i.location.accuracyM)}m` : 'no location'}${i.flags.includes('LOCATION_STALE') ? ' · stale' : ''}</small></button></li>`).join('') || '<li class="muted">No active incidents.</li>'}</ul>
      </section>
      ${d ? opsDetail(d, tl, cfg) : '<section class="card"><p class="muted">Select an incident.</p></section>'}
    </div>`);
}

function opsDetail(d, tl, cfg) {
  const radii = cfg?.radiusStagesKm || [10, 20, 30];
  const live = d.assignments.filter((a) => a.position);
  const targets = [
    ...(d.alertedPositions || []).filter((p) => p.response !== 'ACCEPTED').map((p) => ({ kind: p.response === 'DECLINED' ? 'declined' : 'alerted', position: p.position, title: `${p.response || 'alerted'} ${p.distanceKm ?? ''} km` })),
    ...live.map((a) => ({ id: a.volunteerName.split(' ')[0].toUpperCase(), kind: 'responder', position: a.position, track: a.track, sub: a.distanceKm != null ? a.distanceKm + 'km' : '', title: `${a.volunteerName} ${a.status}` })),
  ];
  const near = live.length ? ppiRange('ops-approach', niceRange(Math.max(0.5, ...live.map((a) => a.distanceKm || 0)) * 1.15)) : null;
  const searchRange = ppiRange('ops-search', radii[2]);
  const rows = live.map((a) => ({ id: a.volunteerName.split(' ')[0].toUpperCase(), km: a.distanceKm, brg: a.bearingDeg, spd: a.speedKmh, eta: a.status === 'ARRIVED' || a.status === 'ASSISTING' ? 0 : a.approxEtaMin, state: pretty(a.status).toUpperCase(), closing: a.status === 'EN_ROUTE' ? a.closing : null }));
  const scope = d.location ? `<div class="ppi-grid">
      <div class="ppi-wrap"><h3 class="ppi-title">① SEARCH radar — who was alerted</h3>
        <div class="ppi-box">${ppiSvg({ center: d.location, rangeKm: searchRange, rings: radii.filter((r) => r <= searchRange), activeRing: d.search?.stage ?? null, targets, title: 'PPI · SEARCH' })}${zoomBar('ppi-zoom', 'ops-search', 'Search radar')}</div>
        <div class="ppi-legend"><span><i class="l-her"></i>HER</span><span><i class="l-vol"></i>ACCEPTED</span><span><i class="l-alert"></i>ALERTED</span><span><i class="l-decl"></i>DECLINED</span></div>
        <p class="ppi-explain">The whole search area around her. Rings are the ${radii.join(' / ')} km search stages; the <b>bright ring</b> is the stage being searched now. Hollow circles = volunteers alerted but not yet accepted; grey = declined; solid blue = accepted. Use it to see if the search is reaching enough people.</p></div>
      ${near ? `<div class="ppi-wrap"><h3 class="ppi-title">② APPROACH radar — who is coming</h3>
        <div class="ppi-box">${ppiSvg({ center: d.location, rangeKm: near, targets: targets.filter((x) => x.kind === 'responder'), title: 'PPI · APPROACH' })}${zoomBar('ppi-zoom', 'ops-approach', 'Approach radar')}</div>
        <p class="ppi-explain">Zoomed in on only the volunteers who accepted, with their travelled path (green). The table gives each one's range (distance), bearing (direction from her), speed, ETA and whether they are closing in. Use it to spot a responder who has stopped or is moving away.</p>${ppiTable(rows)}</div>`
      : `<div class="ppi-wrap"><h3 class="ppi-title">② APPROACH radar</h3><p class="ppi-explain">Appears when a volunteer accepts. It zooms in on accepted volunteers and tracks them closing in on her.</p></div>`}
    </div>` : '';
  return `<section class="card ops-detail">
    <div class="row space"><h2>${esc(d.requester?.displayName)} · <span class="status-text-${esc(d.color)}">${esc(pretty(d.status))}</span></h2><span class="badge">${esc(d.severity)}</span></div>
    ${d.duress ? '<div class="alert alert-danger"><strong>🚩 DURESS PIN USED.</strong> The user\'s app shows "cancelled". Treat as active danger. Do not contact her in a way that could reveal this.</div>' : ''}
    <p>Trigger: ${esc(d.trigger)}${d.silent ? ' (silent)' : ''} · Escalation: <strong>${esc(d.escalationStatus)}</strong> · Alerted: ${esc(d.alertedCount)} · Battery: ${d.battery ? Math.round(d.battery.level * 100) + '%' : 'unknown'}</p>
    ${d.location ? `${scope}
      <h3>📍 Her live location</h3>${googleMap(d.location, 'Her live location', 'ops')}
      <p>📍 ${esc(d.location.lat.toFixed(5))}, ${esc(d.location.lng.toFixed(5))} · ±${esc(d.location.accuracyM)} m · ${esc(d.location.source)} · <span data-live="age" data-fmt="short" data-at="${esc(d.location.observedAt)}"></span> old ${d.location.stale ? '<span class="badge badge-warn">STALE</span>' : ''} · ${esc(d.location.vertical)}</p>
      ${d.locationHistory.some((l) => l.suspect) ? `<p class="badge badge-warn">Suspect location jumps ignored: ${d.locationHistory.filter((l) => l.suspect).map((l) => esc(l.suspectReason)).join('; ')}</p>` : ''}` : '<div class="alert alert-warn">No usable location. Contact the user through official channels if possible.</div>'}
    ${d.search?.secondsLeft != null ? `<p>Search stage ${d.search.stage + 1}/3 (${esc(d.search.radiusKm)} km) · next expansion in <span data-live="stage-countdown-raw" data-deadline="${esc(d.search.deadline)}"></span></p>` : ''}
    <h3>Responders</h3>
    <table class="tbl"><thead><tr><th>Volunteer</th><th>Role</th><th>Status</th><th>Dist.</th><th></th></tr></thead><tbody>
      ${d.assignments.map((a) => `<tr><td>${esc(a.volunteerName)}</td><td>${esc(a.role)}</td><td>${esc(pretty(a.status))}${a.stallFlagged ? ' ⚠️ stalled' : ''}</td><td>${a.distanceKm != null ? esc(a.distanceKm) + ' km' : '—'}</td><td>${['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ASSISTING'].includes(a.status) && !d.closed ? `<button class="btn btn-ghost btn-sm" data-act="op-reassign" data-id="${esc(d.id)}" data-aid="${esc(a.id)}">Remove</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet</td></tr>'}
    </tbody></table>
    <h3>Escalations</h3>
    <ul>${d.escalations.map((e) => `<li><strong>${esc(e.type)}</strong> · ${esc(e.status)} · <em>${esc(e.label)}</em> · ${esc(fmtTime(e.attemptedAt))}${e.reason ? ` — ${esc(e.reason)}` : ''}</li>`).join('') || '<li class="muted">None</li>'}</ul>
    <h3>Notifications</h3>
    <p class="small">${d.notifications.length} sent · ${d.notifications.filter((n) => n.status === 'FAILED').length} failed · ${d.notifications.filter((n) => n.attemptCount > 1).length} used fallback</p>
    ${!d.closed ? `
    <div class="ops-actions">
      <form class="card form" data-form="handoff" data-id="${esc(d.id)}"><h3>Record emergency-service handoff</h3><p class="muted small">Manual record of what you did (e.g. phoned the control room). There is no automated dispatch.</p>
        <label>Status<select name="status"><option>ATTEMPTED</option><option>DELIVERED</option><option>ACKNOWLEDGED</option><option>FAILED</option></select></label>
        <label>Details / reference<input name="reason" required minlength="5" maxlength="300"></label><button class="btn btn-warn">Record handoff</button></form>
      <form class="card form" data-form="closure" data-id="${esc(d.id)}"><h3>Closure exception</h3><p class="muted small">Only when the user cannot confirm safety. Fully audited.</p>
        <label>Reason<select name="reason"><option value="HANDED_TO_EMERGENCY_SERVICES_CONFIRMED_SAFE">Handed to emergency services — confirmed safe</option><option value="USER_UNREACHABLE_EMERGENCY_SERVICES_IN_CHARGE">User unreachable — emergency services in charge</option><option value="DUPLICATE_INCIDENT">Duplicate incident</option><option value="VERIFIED_FALSE_ALARM">Verified false alarm</option></select></label>
        <label>Note (10+ chars)<textarea name="note" required minlength="10" maxlength="500"></textarea></label><button class="btn btn-ghost danger-text">Close with exception</button></form>
      <button class="btn btn-danger" data-act="op-escalate" data-id="${esc(d.id)}">Mark escalation required</button>
    </div>` : `<p>Closed: ${esc(pretty(d.closureReason))}</p>`}
    <details data-keep="ops-timeline"><summary>Timeline (${tl.length})</summary><ol class="timeline">${tl.map((x) => `<li><time>${esc(fmtTime(x.at))}</time> ${esc(pretty(x.text))}${x.reason ? ` <small class="muted">— ${esc(x.reason)}</small>` : ''}</li>`).join('')}</ol></details>
  </section>`;
}

// ------------------------------------------------------------------ admin
async function viewAdmin() {
  const tab = st.adminTab;
  const tabs = [['policy', 'Policy'], ['volunteers', 'Volunteers'], ['abuse', 'Abuse reports'], ['audit', 'Audit log'], ['integrations', 'Integrations']];
  let body = '';
  try {
    if (tab === 'policy') {
      const { config } = await st.api.adminConfig();
      const f = (k, label, v = config[k]) => `<label>${esc(label)}<input name="${k}" value="${esc(Array.isArray(v) ? v.join(',') : v)}" required></label>`;
      body = `<form class="card form grid-2" data-form="config"><h2 class="full">Dispatch policy</h2>
        ${f('radiusStagesKm', 'Search radii km (3, increasing)')}${f('stageTimeoutsSec', 'Stage timeouts sec')}${f('highSeverityStageTimeoutsSec', 'High-severity timeouts sec')}
        ${f('targetResponders', 'Target responders (backup search until reached)')}${f('maxResponders', 'Max responders')}${f('acceptToEnRouteStallSec', 'Accepted→en-route stall sec')}
        ${f('enRouteStallMinSec', 'Min en-route stall sec')}${f('locationStaleSec', 'Location stale after sec')}${f('lowAccuracyM', 'Low accuracy threshold m')}
        ${f('volunteerLocationMaxAgeMin', 'Volunteer location max age min')}${f('sosPerHourLimit', 'SOS per user per hour')}
        <label>Default country<select name="countryCode">${Object.entries(st.cfg.countries).map(([k, v]) => `<option value="${k}" ${k === config.countryCode ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <div class="full"><button class="btn btn-primary">Save policy</button></div></form>`;
    } else if (tab === 'volunteers') {
      const { items } = await st.api.adminVolunteers();
      body = `<section class="card"><h2>Volunteers</h2><table class="tbl"><thead><tr><th>Name</th><th>Verification</th><th>Training</th><th>Duty</th><th>Eligible</th><th>No-shows</th><th>Actions</th></tr></thead><tbody>
        ${items.map((v) => `<tr><td>${esc(v.displayName)}</td><td>${esc(pretty(v.verificationStatus))}</td><td>${v.trainingDone}/${v.trainingTotal}</td><td>${v.available ? 'On' : 'Off'}</td><td>${v.eligibility.eligible ? '✅' : `<small>${esc(v.eligibility.reasons.join(', '))}</small>`}</td><td>${v.noShowCount}</td>
          <td class="actions">${v.verificationStatus === 'PENDING' ? `<button class="btn btn-sm btn-primary" data-act="adm-review" data-id="${esc(v.userId)}" data-d="APPROVE">Approve</button><button class="btn btn-sm btn-ghost" data-act="adm-review" data-id="${esc(v.userId)}" data-d="REJECT">Reject</button>` : ''}
          ${v.suspendedReason ? `<button class="btn btn-sm btn-ghost" data-act="adm-review" data-id="${esc(v.userId)}" data-d="REINSTATE">Reinstate</button>` : `<button class="btn btn-sm btn-ghost danger-text" data-act="adm-review" data-id="${esc(v.userId)}" data-d="SUSPEND">Suspend</button>`}</td></tr>`).join('')}
        </tbody></table></section>`;
    } else if (tab === 'abuse') {
      const { items } = await st.api.abuseList();
      body = `<section class="card"><h2>Abuse & safety reports</h2><ul class="history">${items.map((r) => `<li><strong>${esc(pretty(r.category))}</strong> by ${esc(r.reporter)} · ${esc(fmtTime(r.createdAt))} · ${esc(r.status)}<br>${esc(r.details)}${r.status === 'OPEN' ? ` <button class="btn btn-sm btn-ghost" data-act="adm-resolve" data-id="${esc(r.id)}">Resolve</button>` : ` <small>— ${esc(r.resolution || '')}</small>`}</li>`).join('') || '<li class="muted">No reports.</li>'}</ul></section>`;
    } else if (tab === 'audit') {
      const a = await st.api.audit(150);
      body = `<section class="card"><h2>Audit log</h2><p>Hash chain: ${a.chain.ok ? `<span class="badge badge-ok">intact (${a.chain.length} events)</span>` : '<span class="badge badge-danger">BROKEN — investigate</span>'}</p>
        <table class="tbl small"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Reason</th></tr></thead><tbody>${a.items.map((x) => `<tr><td>${esc(fmtTime(x.timestamp))}</td><td>${esc(x.actorId.slice(0, 8))}</td><td>${esc(x.action)}</td><td>${esc(x.entityType)}:${esc(String(x.entityId).slice(0, 8))}</td><td>${esc(x.reason || '')}</td></tr>`).join('')}</tbody></table></section>`;
    } else {
      const { items } = await st.api.integrations();
      body = `<section class="card"><h2>Integration health</h2><ul class="history">${items.map((i) => `<li><strong>${esc(i.name)}</strong> <span class="badge ${i.status === 'SIMULATED' || i.status === 'MOCK' ? 'badge-warn' : 'badge-info'}">${esc(i.status)}</span><br><small>${esc(i.note)}</small></li>`).join('')}</ul></section>`;
    }
  } catch (e) { body = `<div class="alert alert-danger">${esc(e.message)}</div>`; }
  return shell(`<h1>Admin & trust</h1><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" class="tab ${k === tab ? 'active' : ''}" data-act="adm-tab" data-tab="${k}">${esc(l)}</button>`).join('')}</div>${body}`);
}

// ------------------------------------------------------------------ demo
function viewDemo() {
  const last = store.get('lastIncident', '');
  const vols = [['asha@demo.betibachao.app', 'Asha (3 km)'], ['ravi@demo.betibachao.app', 'Ravi (7.5 km)'], ['meena@demo.betibachao.app', 'Meena (14 km)'], ['imran@demo.betibachao.app', 'Imran (24 km)']];
  return shell(`
    <h1>🧪 Demo controls</h1>
    <section class="card"><h2>Suggested walkthrough</h2><ol>
      <li>Log in as <b>Aamani</b> → hold SOS (synthetic Kurnool location). Watch the 10 km search.</li>
      <li>Advance time to see 10 → 20 → 30 km expansion, or act as a volunteer below.</li>
      <li>Open a second tab, log in as <b>Asha</b> (volunteer): note she only sees an approximate area until she accepts.</li>
      <li>Open a third tab as <b>Operator</b>: radar, escalations labelled <em>SIMULATED</em>, manual handoff record.</li>
      <li>As Aamani choose "I need more help" (escalates) and later "Yes, I am safe" → GREEN and closed.</li>
      <li>Try the duress PIN: set PINs in Settings, then cancel with the duress PIN — Aamani sees "cancelled", the operator sees 🚩 DURESS.</li>
    </ol></section>
    <section class="card"><h2>Clock & failures</h2><div class="row">
      <button class="btn btn-secondary" data-act="demo-advance" data-s="30">+30 s</button><button class="btn btn-secondary" data-act="demo-advance" data-s="60">+60 s</button><button class="btn btn-secondary" data-act="demo-advance" data-s="180">+3 min</button>
      <button class="btn btn-ghost" data-act="demo-fail">Fail next notification</button>
      <button class="btn btn-ghost" data-act="demo-relocate">Move volunteers around my real GPS</button></div></section>
    <form class="card form" data-form="demo-vol"><h2>Act as a demo volunteer</h2>
      <label>Incident ID<input name="incidentId" value="${esc(last)}" required></label>
      <label>Volunteer<select name="email">${vols.map(([e, l]) => `<option value="${e}">${esc(l)}</option>`).join('')}</select></label>
      <label>Action<select name="action"><option>ACCEPT</option><option>EN_ROUTE</option><option>ARRIVED</option><option>ASSISTING</option><option value="UNABLE">UNABLE (drop out)</option><option>DECLINE</option></select></label>
      <button class="btn btn-primary">Run</button></form>
    <section class="card"><h2>Reset</h2><p class="muted">Wipes all demo data and re-seeds synthetic accounts.</p><button class="btn btn-ghost danger-text" data-act="demo-reset">Reset demo data</button></section>
  `);
}

// ------------------------------------------------------------------ router
async function render() {
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  const guard = (roles) => { if (!st.me) { go('#/login'); return false; } if (roles && !roles.includes(st.me.role)) { go(roleHome(st.me.role)); return false; } return true; };
  let html;
  clearInterval(st.pollTimer);
  st.incident = null;
  switch (parts[0]) {
    case undefined: html = st.me ? null : viewLanding(); if (!html) return go(roleHome(st.me.role)); break;
    case 'login': html = await viewLogin(params); break;
    case 'register': html = viewRegister(); break;
    case 'home': if (!guard(['user'])) return; html = await viewHome(); break;
    case 'incident': if (!guard(['user'])) return; html = await viewIncident(parts[1], params); st.pollTimer = setInterval(refreshSoft, 3000); break;
    case 'tools': if (!guard(['user'])) return; html = await viewTools(); break;
    case 'settings': if (!guard()) return; html = await viewSettings(); break;
    case 'volunteer': if (!guard(['volunteer'])) return; html = await viewVolunteer(); st.pollTimer = setInterval(refreshSoft, 3000); break;
    case 'ops': if (!guard(['operator', 'admin'])) return; html = await viewOps(); st.pollTimer = setInterval(refreshSoft, 3000); break;
    case 'admin': if (!guard(['admin'])) return; html = await viewAdmin(); break;
    case 'demo': if (!guard()) return; html = viewDemo(); break;
    default: html = shell('<p>Page not found.</p>');
  }
  // Background refresh: only touch the screen when something actually changed.
  if (st.softRefresh && html === st.lastHtml) { st.softRefresh = false; updateLive(); return; }
  st.lastHtml = html;
  const y = window.scrollY;
  const focusedForm = document.activeElement?.closest?.('form') && document.activeElement.name;
  const openKeys = new Set($$('details[data-keep][open]').map((d) => d.dataset.keep));
  if (st.softRefresh && patchMain(html)) { for (const d of $$('details[data-keep]')) if (openKeys.has(d.dataset.keep)) d.open = true; st.softRefresh = false; bindHold(); updateLive(); return; }
  app().innerHTML = html;
  rememberMain();
  for (const d of $$('details[data-keep]')) if (openKeys.has(d.dataset.keep)) d.open = true;
  if (st.softRefresh) window.scrollTo(0, y);
  if (focusedForm) document.querySelector(`[name="${focusedForm}"]`)?.focus();
  st.softRefresh = false;
  bindHold();
  updateLive();
  if (parts[0] === 'login' && isDemo() && params.get('as')) $('[data-form="login"] [name="email"]')?.focus();
}

// Background refresh: swap only the blocks whose content changed, so the
// screen doesn't flash or jump. Returns false if the layout changed too much.
const srcHtml = new WeakMap(); // element → HTML it was rendered from (before live values were filled in)
function rememberMain() { for (const c of $('#main')?.children || []) srcHtml.set(c, c.outerHTML); }
function patchMain(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const nextMain = tpl.content.querySelector('#main');
  const curMain = $('#main');
  if (!nextMain || !curMain) return false;
  morph(curMain, nextMain);
  return true;
}

// Minimal DOM diff: walks old and new trees together and changes only the text
// and attributes that differ. Maps (iframes) are never reloaded unless their
// address changes; the radar sweep keeps spinning; open panels stay open.
const KEEP_ATTRS = new Set(['style', 'data-sync', 'open']);
function morph(a, b) {
  if (a.nodeType !== b.nodeType || a.nodeName !== b.nodeName) { a.replaceWith(b.cloneNode(true)); return; }
  if (a.nodeType === 3 || a.nodeType === 8) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
  if (a.nodeType !== 1) return;
  for (const at of [...b.attributes]) if (a.getAttribute(at.name) !== at.value) a.setAttribute(at.name, at.value);
  for (const at of [...a.attributes]) if (!b.hasAttribute(at.name) && !KEEP_ATTRS.has(at.name)) a.removeAttribute(at.name);
  if (a.tagName === 'IFRAME' || a.hasAttribute('data-live')) return; // live text is filled in by updateLive()
  const ac = [...a.childNodes], bc = [...b.childNodes];
  for (let i = 0; i < bc.length; i++) { if (i < ac.length) morph(ac[i], bc[i]); else a.appendChild(bc[i].cloneNode(true)); }
  for (let i = bc.length; i < ac.length; i++) ac[i].remove();
}

// Re-render without losing typing: skip if the user is in a form field.
function refreshSoft() {
  const a = document.activeElement;
  if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && a.closest('form')) return;
  if ($('.modal-backdrop')) return;
  st.softRefresh = true;
  render();
}

function updateLive() {
  const sw = safeWalk.get();
  for (const el of $$('[data-live="safewalk"]')) {
    if (!sw) { el.textContent = ''; continue; }
    const left = Math.max(0, Math.round((sw.endsAt - Date.now()) / 1000));
    el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }
  for (const el of $$('.ppi-sweep:not([data-sync])')) { el.style.animationDelay = `-${(Date.now() % 4000) / 1000}s`; el.dataset.sync = '1'; }
  const now = Date.now() + (st.skew || 0);
  for (const el of $$('[data-live="age"]')) {
    const s = Math.max(0, Math.round((now - Date.parse(el.dataset.at)) / 1000));
    el.textContent = el.dataset.fmt === 'short' ? ago(s) : t('updated_ago', { s });
  }
  for (const el of $$('[data-live="stage-countdown"],[data-live="stage-countdown-raw"]')) {
    const left = Math.max(0, Math.round((Date.parse(el.dataset.deadline) - now) / 1000));
    el.textContent = el.dataset.live === 'stage-countdown' ? t('next_stage_in', { s: left }) : `${left}s`;
  }
}

// ------------------------------------------------------------------ actions
const actions = {
  async logout() { try { await st.api.logout(); } catch {} st.me = null; geo.stop(); go('#/'); },
  async 'demo-login'(el) {
    const email = el.dataset.email;
    const f = $('[data-form="login"]');
    f.email.value = email;
    if (!st.cfg.standalone) f.password.value = 'demo1234';
    if (['operator', 'admin'].includes(el.dataset.role) && st.cfg.mfaRequired) {
      $('.mfa').classList.remove('hidden');
      try { f.mfaCode.value = (await st.api.demoMfaCode()).code || ''; } catch {}
    }
    f.requestSubmit();
  },
  async 'share-location'() {
    prefs.set({ synthetic: false });
    try { await geo.once(); geo.start(); toast(t('location_on'), 'ok'); } catch (e) { toast(e.code === 1 ? 'Location permission denied. You can still send SOS and call.' : 'Could not get a location fix.', 'error', 6000); }
    render();
  },
  siren() { siren.on ? siren.stop() : siren.start(); render(); },
  async 'fake-call'() { fakeCall(prefs.get().fakeCaller, 3); },
  async 'record-toggle'() {
    try {
      if (recorder.recording) { await recorder.stop(); toast('Saved on this device', 'ok'); }
      else if (await recorder.start('audio')) toast('Recording…', 'warn');
    } catch { toast('Microphone permission denied', 'error'); }
    render();
  },
  async 'record-video'() { try { await recorder.start('video'); toast('Recording video…', 'warn'); } catch { toast('Camera permission denied', 'error'); } render(); },
  async 'clip-dl'(el) { const c = (await recorder.list()).find((x) => x.id === el.dataset.id); if (!c) return; const a = document.createElement('a'); a.href = URL.createObjectURL(c.blob); a.download = `beti-bachao-${c.kind}-${c.createdAt.replace(/[:.]/g, '-')}.webm`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); },
  async 'clip-del'(el) { await recorder.remove(el.dataset.id); render(); },
  async 'share-now'() {
    const loc = geo.last || currentLoc();
    const nums = contacts.list().map((c) => c.phone);
    const msg = sosMessage(loc);
    if (nums.length) openExternal(smsHref(nums, msg));
    else if (!(await nativeShare(msg))) { toast('Add trusted contacts in Settings first', 'warn'); go('#/settings'); }
  },
  async 'native-share'() { if (!(await nativeShare(sosMessage(geo.last || currentLoc())))) toast('Sharing not supported — use SMS/WhatsApp', 'warn'); },
  'are-you-safe'() { askSafe(); },
  async 'more-help'() { try { await st.api.safety(st.incident.id, { response: 'NEED_MORE_HELP' }); toast('Escalated — search continues', 'warn'); render(); } catch (e) { showErr(e); } },
  async 'report-danger'() {
    const r = await modal({ title: t('report_danger'), body: '<label>What is happening? (optional)<input name="reason" maxlength="200"></label>', actions: [{ id: 'go', label: t('report_danger'), kind: 'danger' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'go') return;
    try { await st.api.escalate(st.incident.id, { type: 'USER_REPORTED_DANGER', reason: r.data.reason || 'User reported danger' }); toast('Escalated', 'warn'); render(); } catch (e) { showErr(e); }
  },
  async 'cancel-sos'() {
    const hasPin = st.me.hasPins;
    const r = await modal({ title: t('cancel_sos'), body: hasPin ? `<label>${esc(t('enter_pin'))}<input name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label>` : '<p>Only cancel if this SOS was a mistake. If you are in danger, keep it open.</p>', actions: [{ id: 'go', label: t('cancel_sos'), kind: 'ghost' }, { id: 'no', label: 'Keep SOS open', kind: 'primary' }] });
    if (r.id !== 'go') return;
    try {
      await st.api.cancel(st.incident.id, hasPin ? { pin: r.data.pin } : { confirm: true });
      siren.stop(); keepAwake(false); geo.stop();
      toast(t('status_grey'), 'info'); go('#/home');
    } catch (e) { showErr(e); }
  },
  async 'safewalk-checkin'() { safeWalk.extend(); toast(t('check_in'), 'ok'); render(); },
  'safewalk-stop'() { safeWalk.stop(); render(); },
  async 'contact-del'(el) { contacts.remove(Number(el.dataset.i)); render(); },
  async export() { try { const d = await st.api.exportData(); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); a.download = 'beti-bachao-my-data.json'; a.click(); } catch (e) { showErr(e); } },
  async 'delete-account'() {
    const r = await modal({ title: 'Delete account?', body: '<p>This removes your profile and precise location history. Incident records needed for audit are kept without your identity.</p>', actions: [{ id: 'del', label: 'Delete permanently', kind: 'danger' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'del') return;
    try { await st.api.deleteAccount(); st.me = null; go('#/'); } catch (e) { showErr(e); }
  },
  async 'report-abuse'(el) {
    const r = await modal({ title: 'Report a concern', body: `<label>Category<select name="category"><option value="VOLUNTEER_MISCONDUCT">Volunteer misconduct</option><option value="STALKING">Stalking / misuse of location</option><option value="FALSE_ALERT">False alert</option><option value="PRIVACY_BREACH">Privacy breach</option><option value="OTHER">Other</option></select></label><label>Details<textarea name="details" maxlength="1000"></textarea></label>`, actions: [{ id: 'send', label: 'Send report', kind: 'primary' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'send') return;
    try { await st.api.reportAbuse({ incidentId: el.dataset.id || null, category: r.data.category, details: r.data.details }); toast('Report sent to the trust team', 'ok'); } catch (e) { showErr(e); }
  },
  // volunteer
  async 'vol-avail'(el) { try { await st.api.setAvailability({ available: el.dataset.on === '1', location: await volLoc() }); render(); } catch (e) { showErr(e); } },
  async 'vol-locate'() { try { const loc = await volLoc(); if (!loc) return toast('No location available', 'error'); await st.api.setAvailability({ location: loc }); toast('Location updated', 'ok'); render(); } catch (e) { showErr(e); } },
  async 'vol-verify'() {
    const words = ['river', 'mango', 'lotus', 'kite', 'temple', 'monsoon', 'peacock', 'saffron'];
    const phrase = `${words[Math.floor(Math.random() * words.length)]} ${words[Math.floor(Math.random() * words.length)]} ${Math.floor(10 + Math.random() * 89)}`;
    const r = await modal({ title: 'Live identity check (mock)', body: `<p>In production you would record yourself saying this random phrase, alongside a lawful ID check:</p><p class="phrase">“${esc(phrase)}”</p><p class="muted small">Demo: nothing is recorded or uploaded.</p>`, actions: [{ id: 'ok', label: 'Submit for review', kind: 'primary' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'ok') return;
    try { await st.api.submitVerification({ liveChallengePhrase: phrase }); toast('Submitted for admin review', 'ok'); render(); } catch (e) { showErr(e); }
  },
  async 'vol-train'(el) {
    const m = TRAINING_MODULES.find((x) => x.id === el.dataset.id);
    const content = { 'code-of-conduct': CONDUCT.map((c) => `<li>${esc(c)}</li>`).join(''), 'de-escalation': '<li>Stay calm, keep distance, use a low voice.</li><li>Your job is to accompany and protect — not to confront.</li><li>Leave with her to a public, well-lit place if she agrees.</li>', 'emergency-calling': '<li>Call the local emergency number for violence, weapons, injury or imminent danger.</li><li>Give the exact location, what you see, and number of people.</li><li>Use "Request emergency escalation" in the app too.</li>', privacy: '<li>Never screenshot, share or store her location or identity.</li><li>Location access is logged and audited.</li><li>Misuse leads to removal and referral to authorities.</li>', 'safe-handover': '<li>Stay until she confirms she is safe in the app or emergency services take over.</li><li>Arrival alone never ends an incident.</li><li>Tap "Unable to help" immediately if you must leave.</li>' }[m.id];
    const r = await modal({ title: m.title, body: `<ul>${content}</ul><label class="switch"><input type="checkbox" name="ack"> I understand and will follow this</label>`, actions: [{ id: 'done', label: 'Complete module', kind: 'primary' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'done') return;
    if (!r.data.ack) return toast('Please tick "I understand"', 'warn');
    try { await st.api.completeTraining(m.id); render(); } catch (e) { showErr(e); }
  },
  'vol-select'(el) { st.volSel = el.dataset.id; render(); },
  async 'vol-accept'(el) { try { await st.api.accept(el.dataset.id); vibrate(200); toast('Assigned. Exact location now visible.', 'ok'); st.volSel = el.dataset.id; render(); } catch (e) { showErr(e); } },
  async 'vol-decline'(el) { try { await st.api.decline(el.dataset.id, { reason: 'declined' }); render(); } catch (e) { showErr(e); } },
  async 'vol-status'(el) { try { await st.api.assignmentStatus(el.dataset.aid, { status: el.dataset.status, location: await volLoc() }); render(); } catch (e) { showErr(e); } },
  async 'vol-unable'(el) {
    const r = await modal({ title: 'Unable to help?', body: '<label>Reason<input name="reason" maxlength="160" required></label><p class="muted small">Another responder will be searched for immediately. Genuine inability is never penalised.</p>', actions: [{ id: 'go', label: 'Hand back', kind: 'warn' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'go') return;
    try { await st.api.assignmentStatus(el.dataset.aid, { status: 'UNABLE', reason: r.data.reason || 'unable' }); render(); } catch (e) { showErr(e); }
  },
  async 'vol-escalate'(el) { try { await st.api.escalate(el.dataset.id, { type: 'RESPONDER_REQUEST', reason: 'Responder requested emergency services' }); toast(`Escalation recorded — ${st.cfg.simulatedLabel}. Call ${country().emergency} yourself if needed.`, 'warn', 7000); render(); } catch (e) { showErr(e); } },
  // ops
  'map-zoom'(el) { const m = (st.mapZoom ||= {}); const k = el.dataset.key; m[k] = Math.max(3, Math.min(20, (m[k] ?? (k === 'route' ? 13 : 16)) + Number(el.dataset.d))); st.softRefresh = true; render(); },
  'ppi-zoom'(el) { const z = (st.ppiZoom ||= {}); const k = el.dataset.key; z[k] = Math.max(-4, Math.min(6, (z[k] || 0) + Number(el.dataset.d))); st.softRefresh = true; render(); },
  'op-select'(el) { st.opSel = el.dataset.id; render(); },
  async 'op-reassign'(el) {
    const r = await modal({ title: 'Remove responder', body: '<label>Reason (5+ chars)<input name="reason" required minlength="5"></label>', actions: [{ id: 'go', label: 'Remove & search again', kind: 'warn' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'go') return;
    try { await st.api.reassign(el.dataset.id, { assignmentId: el.dataset.aid, reason: r.data.reason }); render(); } catch (e) { showErr(e); }
  },
  async 'op-escalate'(el) { try { await st.api.escalate(el.dataset.id, { type: 'OPERATOR', reason: 'Operator marked escalation required' }); render(); } catch (e) { showErr(e); } },
  // admin
  'adm-tab'(el) { st.adminTab = el.dataset.tab; render(); },
  async 'adm-review'(el) {
    let reason = null;
    if (el.dataset.d !== 'APPROVE') { const r = await modal({ title: `${pretty(el.dataset.d)} volunteer`, body: '<label>Reason (5+ chars)<input name="reason" required minlength="5"></label>', actions: [{ id: 'go', label: 'Confirm', kind: 'primary' }, { id: 'no', label: t('cancel') }] }); if (r.id !== 'go') return; reason = r.data.reason; }
    try { await st.api.reviewVolunteer(el.dataset.id, { decision: el.dataset.d, reason }); render(); } catch (e) { showErr(e); }
  },
  async 'adm-resolve'(el) { const r = await modal({ title: 'Resolve report', body: '<label>Resolution<input name="resolution" maxlength="300"></label>', actions: [{ id: 'go', label: 'Resolve', kind: 'primary' }, { id: 'no', label: t('cancel') }] }); if (r.id !== 'go') return; try { await st.api.resolveAbuse(el.dataset.id, { resolution: r.data.resolution }); render(); } catch (e) { showErr(e); } },
  // demo
  async 'demo-advance'(el) { try { await st.api.demoAdvance(Number(el.dataset.s)); toast(`Clock advanced ${el.dataset.s}s`, 'ok'); } catch (e) { showErr(e); } },
  async 'demo-fail'() { try { await st.api.demoFail(1); toast('Next notification will fail (then fall back)', 'ok'); } catch (e) { showErr(e); } },
  async 'demo-relocate'() { try { const l = await geo.once(); await st.api.demoRelocate(l.lat, l.lng); prefs.set({ synthetic: false }); toast('Demo volunteers moved around you', 'ok'); } catch { toast('Need location permission', 'error'); } },
  async 'demo-reset'() { try { await st.api.demoReset(); store.set('lastIncident', ''); st.me = null; toast('Demo reset', 'ok'); go('#/login'); } catch (e) { showErr(e); } },
};

async function volLoc() {
  if (isDemo() && prefs.get().synthetic) return null; // demo volunteers keep their seeded positions
  try { return await geo.once(8000); } catch { return null; }
}

function fakeCall(name, delaySec) {
  setTimeout(() => {
    const el = document.createElement('div');
    el.className = 'fake-call';
    el.innerHTML = `<div class="fc-top"><div class="fc-avatar" aria-hidden="true">${esc((name || '?')[0])}</div><h2>${esc(name)}</h2><p>mobile · incoming call</p></div><div class="fc-btns"><button class="fc-decline" data-fc="end" aria-label="Decline">✕</button><button class="fc-accept" data-fc="accept" aria-label="Accept">✆</button></div>`;
    document.body.appendChild(el);
    ringer.start();
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fc]'); if (!b) return;
      ringer.stop();
      if (b.dataset.fc === 'accept') { el.querySelector('.fc-top p').textContent = 'connected 00:00'; b.remove(); let s = 0; const iv = setInterval(() => { s++; const p = el.querySelector('.fc-top p'); if (!p) return clearInterval(iv); p.textContent = `connected ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 1000); }
      else el.remove();
    });
  }, Math.max(0, delaySec) * 1000);
}

const forms = {
  async login(f) {
    try {
      const r = await st.api.login(f.email.value, f.password?.value, f.mfaCode?.value || undefined);
      if (r.mfaRequired) { $('.mfa').classList.remove('hidden'); f.mfaCode.focus(); toast('Enter your authenticator code', 'info'); return; }
      st.me = r.user; st.api.connect(); afterLogin();
    } catch (e) { showErr(e); }
  },
  async register(f) {
    try { const r = await st.api.register({ displayName: f.displayName.value, email: f.email.value, password: f.password?.value, role: f.role.value, countryCode: f.countryCode.value }); st.me = r.user; st.api.connect(); afterLogin(); } catch (e) { showErr(e); }
  },
  async pins(f) { try { await st.api.setPins({ cancelPin: f.cancelPin.value, duressPin: f.duressPin.value || null }); st.me = (await st.api.me()).user; toast('PINs saved', 'ok'); render(); } catch (e) { showErr(e); } },
  contact(f) { if (contacts.add(f.name.value, f.phone.value)) render(); else toast('Enter a name and a valid phone (max 10 contacts)', 'error'); },
  safewalk(f) { safeWalk.start(Math.max(1, Math.min(240, Number(f.minutes.value) || 15))); toast(t('safe_walk') + ' ✓', 'ok'); render(); },
  fakecall(f) { prefs.set({ fakeCaller: f.caller.value || 'Maa' }); fakeCall(f.caller.value || 'Maa', Number(f.delay.value) || 0); toast('Fake call scheduled', 'ok'); },
  async floor(f) {
    const n = parseInt(f.floor.value, 10);
    if (!Number.isInteger(n)) return;
    const loc = currentLoc();
    if (!loc) return toast('Location needed first', 'warn');
    try { await st.api.addLocation(st.incident.id, { ...loc, userFloor: n }); toast('Floor added (marked as user-provided)', 'ok'); render(); } catch (e) { showErr(e); }
  },
  async config(f) {
    const nums = (s) => s.split(',').map((x) => parseInt(x.trim(), 10));
    const patch = {};
    for (const k of ['radiusStagesKm', 'stageTimeoutsSec', 'highSeverityStageTimeoutsSec']) patch[k] = nums(f[k].value);
    for (const k of ['targetResponders', 'maxResponders', 'acceptToEnRouteStallSec', 'enRouteStallMinSec', 'locationStaleSec', 'lowAccuracyM', 'volunteerLocationMaxAgeMin', 'sosPerHourLimit']) patch[k] = parseInt(f[k].value, 10);
    patch.countryCode = f.countryCode.value;
    try { await st.api.patchConfig(patch); toast('Policy saved & audited', 'ok'); } catch (e) { showErr(e); }
  },
  async handoff(f) { try { await st.api.handoff(f.dataset.id, { status: f.status.value, reason: f.reason.value }); toast('Handoff recorded', 'ok'); render(); } catch (e) { showErr(e); } },
  async closure(f) { try { await st.api.closureException(f.dataset.id, { reason: f.reason.value, note: f.note.value }); toast('Closed with documented exception', 'ok'); render(); } catch (e) { showErr(e); } },
  async 'demo-vol'(f) { try { await st.api.demoVolunteerAction(f.email.value, f.incidentId.value.trim(), f.action.value); toast(`Done: ${f.action.value}`, 'ok'); } catch (e) { showErr(e); } },
};

const changes = {
  lang(el) { setLang(el.value); render(); },
  country(el) { prefs.set({ country: el.value }); render(); },
  synthetic(el) { prefs.set({ synthetic: el.checked }); if (!el.checked) actions['share-location'](); else render(); },
  async shake(el) {
    if (el.checked) { const r = await shake.enable(() => startCountdown('shake')); if (r !== 'on') { el.checked = false; return toast(r === 'denied' ? 'Motion permission denied' : 'Motion sensors not available', 'error'); } }
    else shake.disable();
    prefs.set({ shake: el.checked });
  },
  voice(el) {
    if (el.checked) { const r = voice.start(() => startCountdown('voice')); if (r !== 'on') { el.checked = false; return toast('Voice recognition not supported', 'error'); } toast('Listening for your keyword while the app is open', 'info'); }
    else voice.stop();
    prefs.set({ voice: el.checked });
  },
  autoRecord(el) { prefs.set({ autoRecord: el.checked }); },
  autoSms(el) { prefs.set({ autoSms: el.checked }); },
  'ops-all'(el) { store.set('ops.all', el.checked); render(); },
};

function afterLogin() {
  const p = prefs.get();
  if (st.me.role === 'user') {
    if (p.shake) shake.enable(() => startCountdown('shake'));
    if (p.voice) voice.start(() => startCountdown('voice'));
    if (!isDemo() || !p.synthetic) geo.permission().then((s) => { if (s === 'granted') geo.start(); });
  }
  if (store.get('pendingSos', null)) scheduleSosRetry();
  go(roleHome(st.me.role));
}

// ------------------------------------------------------------------ boot
async function boot() {
  setLang(detectLang());
  st.api = await createApi();
  try { st.cfg = await st.api.publicConfig(); } catch { st.cfg = { demo: false, countries: { IN: { name: 'India', emergency: '112', extra: [], verified: true } }, defaultCountry: 'IN', simulatedLabel: 'SIMULATED — NOT SENT TO EMERGENCY SERVICES' }; }
  try { st.me = (await st.api.me()).user; st.api.connect(); } catch { st.me = null; }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const fn = actions[el.dataset.act];
    if (fn) { e.preventDefault(); fn(el, e); }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('[data-form]');
    if (!f || f.closest('.modal')) return;
    e.preventDefault();
    forms[f.dataset.form]?.(f);
  });
  document.addEventListener('change', (e) => { const el = e.target.closest('[data-change]'); if (el) changes[el.dataset.change]?.(el); });
  window.addEventListener('hashchange', () => { render(); $('#main')?.focus({ preventScroll: true }); });
  window.addEventListener('online', () => { if (store.get('pendingSos', null)) triggerSOS(store.get('pendingSos')); });

  st.api.subscribe((ev) => {
    if (ev.type === 'volunteer.alerted' && st.me?.role === 'volunteer') vibrate([300, 100, 300]);
    const route = location.hash.split('/')[1];
    if (['incident', 'volunteer', 'ops'].includes(route)) refreshSoft();
  });

  setInterval(() => {
    updateLive();
    streamLocation();
    streamVolunteerLocation();
    const sw = safeWalk.get();
    if (sw && Date.now() >= sw.endsAt && st.me?.role === 'user') { safeWalk.stop(); startCountdown('safewalk', 30); }
  }, 1000);

  if (st.me?.role === 'user') afterLoginSilent();
  render();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
    // A new version took over: reload once so every file is the same version (never during an SOS).
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !location.hash.startsWith('#/incident')) location.reload(); });
  }
}
function afterLoginSilent() {
  const p = prefs.get();
  if (p.shake) shake.enable(() => startCountdown('shake'));
  if (p.voice) voice.start(() => startCountdown('voice'));
  if (!isDemo() || !p.synthetic) geo.permission().then((s) => { if (s === 'granted') geo.start(); });
  if (store.get('pendingSos', null)) scheduleSosRetry();
}

boot();
