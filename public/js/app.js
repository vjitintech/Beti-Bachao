import { createApi, uuid } from './api.js?v=mwdpd10v';
import { t, setLang, detectLang, LANGS, lang, sosWords, speechLang, ownSosWords, sosVoiceLang } from './i18n.js?v=mwdpd10v';
import { esc, $, $$, toast, modal, fmtTime, ago, radarSvg, ppiSvg, ppiTable, niceRange, stepRange } from './ui.js?v=mwdpd10v';
import { geo, battery, keepAwake, vibrate, siren, ringer, shake, voice, recorder, contacts, mapsLink, smsHref, whatsappHref, nativeShare, safeWalk, prefs, store } from './safety.js?v=mwdpd10v';
import { TRAINING_MODULES } from '../core/engine.js?v=mwdpd10v';
import { isNative, platform, native, serverUrl, setServerUrl } from './native.js?v=mwdpd10v';
import { initProtect } from './protect-ui.js?v=mwdpd10v';
import { a11y, announce, speakStatus } from './a11y.js?v=mwdpd10v';
import { phoneInput, readPhone, guessCountry, bindPhoneFields } from './phone.js?v=mwdpd10v';
let P = null; // autonomous-protection screens (protect-ui.js), set up in boot()

const st = { api: null, cfg: null, me: null, incident: null, timeline: [], pollTimer: null, countdown: null, sendingSos: false, lastLocPost: 0, opSel: null, adminTab: 'impact', volSel: null };
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
// A timeline entry as a readable sentence (escalations keep their own capitalised label).
const tlText = (it) => (it?.kind === 'escalation' && String(it.text).includes(': ') ? String(it.text).split(': ').slice(1).join(': ') : pretty(it?.text));
// Status codes (EN_ROUTE, POLICE_AUTO_CONNECT) → sentence case ("En route"); real text, names and
// labels keep their own capitals ("Kurnool Test PS", "SOS", "OTP").
const STATUS_TEXT = {
  CREATED: 'SOS received', ALERTING_10KM: 'Alerting volunteers within 10 km', ALERTING_20KM: 'Alerting volunteers within 20 km', ALERTING_30KM: 'Alerting volunteers within 30 km',
  RESPONDER_ASSIGNED: 'Volunteer accepted', EN_ROUTE: 'Volunteer on the way', ARRIVED: 'Volunteer arrived', ASSISTANCE_IN_PROGRESS: 'Volunteer is helping',
  ESCALATION_REQUIRED: 'Escalated to operators', NO_RESPONDER_AVAILABLE: 'No volunteer available yet', EMERGENCY_HANDOFF: 'Handed to emergency services',
  USER_CANCELLED: 'Cancelled by her', RESPONDER_CANCELLED: 'Volunteer stood down', LOCATION_UNAVAILABLE: 'Waiting for her location', SAFE_CONFIRMED: 'She confirmed she is safe',
  CLOSED: 'Closed', FALSE_ALARM_REVIEW: 'Under review as a false alarm', IMMEDIATE_DANGER: 'Immediate danger', OPERATOR_NO_ACK: 'No operator acknowledged yet',
  NO_RESPONDER: 'No volunteer accepted', POLICE_AUTO_CONNECT: 'Police auto-connect', USER_REPORTED_DANGER: 'She reported danger', CONTACTS_STILL_WAITING: 'Contacts told she is still waiting',
  ATTEMPTED: 'Attempted', REQUIRED: 'Required', DELIVERED: 'Delivered', ACKNOWLEDGED: 'Acknowledged', ACCEPTED: 'Accepted', DECLINED: 'Declined', UNABLE: 'Unable to help', COMPLETED: 'Completed',
};
const KEEP_UPPER = new Set(['sos', 'otp', 'sms', 'gps', 'eta', 'id', 'ps', 'mfa', 'pin', 'ai']);
const pretty = (s) => {
  const t = String(s || '');
  if (STATUS_TEXT[t]) return STATUS_TEXT[t];
  if (!/^[A-Z0-9_ ]+$/.test(t) || !/[A-Z]/.test(t)) return t; // already human text: leave it alone
  const words = t.replace(/_/g, ' ').toLowerCase().split(' ').map((w) => (KEEP_UPPER.has(w) ? w.toUpperCase() : w));
  const out = words.join(' ');
  return out.charAt(0).toUpperCase() + out.slice(1);
};

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

// A change worth telling someone about: vibrate, speak it and show it (skipped on first load).
// Announces a NEW update once. Each distinct message is shown at most once per incident,
// however often the screen refreshes (distances and ETAs change every few seconds).
function notifyChange(key, sig, message, kind = 'ok') {
  const seen = (st.lastSig ||= {});
  const shown = (st.shownMsgs ||= {});
  const before = seen[key]; seen[key] = sig;
  if (before == null || before === sig || !message) return;
  const done = (shown[key] ||= new Set(store.get('shown:' + key, [])));
  if (done.has(message)) return;
  done.add(message); store.set('shown:' + key, [...done].slice(-50));
  vibrate([250, 120, 250]);
  toast(message, kind, 8000);
  try { announce(message); } catch {}
}
const infoTip = (label, html) => `<details class="info-tip"><summary aria-label="${esc(label)}">ⓘ <span>${esc(label)}</span></summary><div class="small">${html}</div></details>`;

// Live tracking of every accepted responder on a PPI radar scope + multi-target readout.
const distText = (km) => (km == null ? '' : km < 1 ? `${Math.round(km * 1000)} m` : `${km} km`);
const etaText = (status, eta) => (status === 'ARRIVED' || status === 'ASSISTING' ? 'on scene' : eta == null ? '' : eta <= 1 ? '<1 min' : `${eta} min`);
// One line under the radar saying what the ETA is based on.
const etaBasisNote = (list) => {
  const live = (list || []).filter((r) => !['ARRIVED', 'ASSISTING'].includes(r.status) && r.approxEtaMin != null);
  if (!live.length) return '';
  const b = live.some((r) => r.etaBasis === 'traffic') ? 'traffic' : live.some((r) => r.etaBasis === 'road') ? 'road' : 'straight';
  const delay = Math.max(0, ...live.map((r) => r.trafficDelayMin || 0));
  const txt = b === 'traffic' ? `🚦 ETA by road with live traffic${delay ? ` (traffic adds ~${delay} min)` : ''}` : b === 'road' ? '🛣️ ETA by actual road route (usual traffic)' : '📏 ETA is a straight-line estimate — road route not available yet';
  return `<p class="small muted eta-basis">${esc(txt)}. The radar shows direction as a straight line; the time follows the roads.</p>`;
};
const trkId = (r) => (r.isYou ? 'YOU' : (r.label.match(/ ([A-Z])$/) || [])[1] || r.label.slice(0, 3).toUpperCase());
function trackingCard(list, center, radii, { title = 'Live tracking', map = true, note = '', key = 'track', viewer = 'her' } = {}) {
  list = list || [];
  const rows = list.map((r) => ({ id: trkId(r), you: r.isYou, km: r.distanceKm, brg: r.bearingDeg, spd: r.speedKmh, eta: r.status === 'ARRIVED' || r.status === 'ASSISTING' ? 0 : r.approxEtaMin, state: pretty(r.status).toUpperCase(), closing: r.status === 'EN_ROUTE' ? r.closing : null }));
  const targets = list.filter((r) => r.position).map((r) => ({ id: trkId(r), kind: r.isYou ? 'you' : 'responder', position: r.position, track: r.track, distText: distText(r.distanceKm), etaText: etaText(r.status, r.approxEtaMin), moving: r.status === 'EN_ROUTE' && r.closing !== 'OPENING', title: `${r.label} · ${pretty(r.status)}` }));
  const range = ppiRange(key, niceRange(Math.max(0.5, ...list.map((r) => r.distanceKm || 0)) * 1.15));
  return `<section class="card track-card"><h2>🛰️ ${esc(title)}</h2>
    ${list.length ? `<div class="ppi-wrap">${map && center && targets.length ? `<div class="ppi-box">${ppiSvg({ center, rangeKm: range, targets, title: 'PPI · LIVE' })}${zoomBar('ppi-zoom', key, 'Radar')}</div>
      <div class="ppi-legend"><span><i class="l-her"></i>HER</span><span><i class="l-vol"></i>VOLUNTEER</span>${viewer === 'volunteer' ? '<span><i class="l-you"></i>YOU</span>' : ''}<span><i class="l-trk"></i>TRACK</span></div>
      ${infoTip('What do the radar and table show?', `<p>Each box shows that volunteer's distance and ETA; it counts down as they get closer. A blinking dot is on the move towards her.</p><p>${viewer === 'volunteer'
        ? 'She is the red dot in the centre. Blue dots are the volunteers who accepted (you are the light-blue dot); green lines show the path each one has travelled.'
        : 'You are the red dot in the centre. Blue dots are verified volunteers who accepted your SOS; green lines show the path each one has travelled.'} Distance from the centre = how far away; the angle = direction (000° = north). The rotating line only shows the scope is live.</p><p>RNG straight-line range · BRG bearing · SPD speed · ETA travel time by road (with live traffic when available). ACPT accepted · ENRT en route · ONSC on scene · ▼CLS closing in · ▲OPN moving away.</p><p>Live from each responder's phone GPS. ${esc(note)}</p>`)}` : ''}
      ${ppiTable(rows).replace(/<p class="ppi-key">[\s\S]*?<\/p>/, '')}${etaBasisNote(list)}</div>
      <ul class="track-list">${list.map((r) => `<li class="track-row ${r.isYou ? 'is-you' : ''}"><span class="track-who"><strong>${esc(r.label)}</strong> ${r.verified ? '<span class="badge badge-ok">Verified</span>' : ''}<br><small>${esc(pretty(r.status))}${r.locationUpdatedAt ? ` · GPS <span data-live="age" data-fmt="short" data-at="${esc(r.locationUpdatedAt)}"></span> ago` : ''}</small></span></li>`).join('')}</ul>`
      : `<p class="muted">${esc(t('status_red'))}</p>`}
    </section>`;
}

// Phone push notifications (Web Push). Volunteers need this to hear about an SOS
// when the app isn't open. iPhone: only after "Add to Home Screen" (iOS 16.4+).
function pushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !st.cfg?.vapidPublicKey) return 'unsupported';
  return Notification.permission;
}
function pushCard(why) {
  if (native.available()) return ''; // the Android/iPhone app gets alerts through the phone's own push service, not the browser
  const ps = pushState();
  if (ps === 'granted' && store.get('pushOk', false)) return '';
  if (ps === 'unsupported') return `<div class="alert alert-warn">🔔 This browser can't receive SOS alerts in the background. ${/iPhone|iPad/.test(navigator.userAgent) ? 'On iPhone: tap Share → "Add to Home Screen", open Beti Bachao from there, then enable alerts.' : 'Use Chrome on Android, or keep this app open.'}</div>`;
  if (ps === 'denied') return `<div class="alert alert-warn">🔔 Notifications are blocked for this site. Allow them in your browser's site settings to receive SOS alerts.</div>`;
  return `<button class="alert alert-info alert-link push-cta" data-act="enable-push">🔔 ${esc(why)} — tap to enable</button>`;
}
const b64ToU8 = (b) => { const p = '='.repeat((4 - (b.length % 4)) % 4); const raw = atob((b + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...raw].map((c) => c.charCodeAt(0))); };
async function enablePush(silent = false) {
  try {
    if (pushState() === 'unsupported') return false;
    if (Notification.permission !== 'granted' && (silent || (await Notification.requestPermission()) !== 'granted')) return false;
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(st.cfg.vapidPublicKey) }));
    await st.api.savePushSubscription(sub.toJSON());
    store.set('pushOk', true);
    return true;
  } catch (e) { if (!silent) toast('Could not enable alerts: ' + (e.message || e), 'error'); return false; }
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
    user: [['#/home', '🛡️', t('home')], ['#/trip', '🚕', 'Travel'], ['#/dashboard', '📊', 'My safety'], ['#/settings', '⚙️', t('settings')]],
    volunteer: [['#/volunteer', '🤝', 'Volunteer'], ['#/settings', '⚙️', t('settings')]],
    operator: [['#/ops', '🛰️', 'Operations'], ['#/settings', '⚙️', t('settings')]],
    admin: [['#/admin', '🗂️', 'Admin'], ['#/ops', '🛰️', 'Operations'], ['#/settings', '⚙️', t('settings')]],
  }[role] || [];
  const cur = location.hash.split('/').slice(0, 2).join('/');
  return `
    <header class="topbar">
      <a href="${role ? roleHome(role) : '#/'}" class="brand" aria-label="Beti Bachao home"><img src="icons/icon-192.png" alt="" width="30" height="30" class="brand-icon"><span>Beti Bachao</span></a>
      <div class="topbar-right">
        <label class="sr-only" for="lang-select">${esc(t('language'))}</label>
        <select id="lang-select" class="lang-select" data-change="lang">${LANGS.map((l) => `<option value="${l.code}" ${l.code === lang() ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}</select>
        ${role ? `<button class="btn btn-ghost btn-sm" data-act="logout">${esc(t('logout'))}</button>` : `<a class="btn btn-ghost btn-sm" href="#/login">${esc(t('login'))}</a>`}
      </div>
    </header>
    ${st.offline ? `<div class="offline-banner" role="alert"><b>No connection to Beti Bachao.</b> Your SOS will be sent as soon as you're back online. In danger, call ${esc(country().emergency)} now.</div>` : ''}
    <main id="main" tabindex="-1">${content}</main>
    ${nav && links.length ? `<nav class="bottom-nav" aria-label="Primary">${links.map(([h, i, l]) => `<a href="${h}" class="${cur === h ? 'active' : ''}" ${cur === h ? 'aria-current="page"' : ''}><span aria-hidden="true">${i}</span>${esc(l)}</a>`).join('')}</nav>` : ''}
  `;
}

// ------------------------------------------------------------------ landing / auth
function viewLanding() {
  st.api?.impact?.().then((i) => { const was = JSON.stringify(st.impact); st.impact = i; if (was !== JSON.stringify(i) && !st.me && !location.hash.replace('#', '').replace('/', '')) render(); }).catch(() => {});
  return shell(`
    ${st.cfg?.setupNeeded ? '<a class="alert alert-warn alert-link" href="#/setup">⚙️ No administrator yet — finish first-time setup</a>' : ''}
    <section class="hero">
      <img src="icons/logo.webp" alt="Beti Bachao — 24×7 Women's Freedom. A woman's freedom has no time limit. Safety has no closing hours." class="hero-logo" width="900" height="600" decoding="async">
      <h1>Beti Bachao</h1>
      <p class="lead">${esc(t('tagline'))}</p>
      <div class="hero-actions">
        <a href="#/login?as=user" class="btn btn-primary btn-lg heartbeat"><svg class="woman-icon" viewBox="0 0 24 32" aria-hidden="true" focusable="false"><circle cx="12" cy="4.6" r="3.4"/><circle cx="14.6" cy="2.2" r="1.7"/><path d="M9.4 9.4h5.2c.9 0 1.6.6 1.8 1.4l3.4 11.4c.2.6-.3 1.2-.9 1.2h-3.3v6.5a1.3 1.3 0 0 1-2.6 0v-6.5h-2v6.5a1.3 1.3 0 0 1-2.6 0v-6.5H5.1c-.6 0-1.1-.6-.9-1.2L7.6 10.8c.2-.8.9-1.4 1.8-1.4z"/><path d="M7.4 11.6 4.6 17.4a1.1 1.1 0 0 0 2 1l2.1-4.6zM16.6 11.6l2.8 5.8a1.1 1.1 0 0 1-2 1l-2.1-4.6z"/></svg>${esc(t('need_safety'))}</a>
        <a href="#/login?as=volunteer" class="btn btn-secondary btn-lg">${esc(t('want_volunteer'))}</a>
      </div>
    </section>
    ${P?.landingImpact() || ''}
    ${emergencyBar()}
    <section class="cards-3">
      <div class="card"><h2 class="h3">🚨 SOS that doesn't stop at "sent"</h2><p>Hold, shake, voice keyword, silent or safe-walk timer. Staged 10 → 20 → 30 km search for verified volunteers, backup responders, and escalation if anything stalls.</p></div>
      <div class="card"><h2 class="h3">🔐 Privacy by design</h2><p>Volunteers see only an approximate area until they are assigned. Every precise-location access is logged. A duress PIN looks like "cancel" but quietly escalates.</p></div>
      <div class="card"><h2 class="h3">✅ Never "safe" without you</h2><p>Arrival never closes an SOS. Only your explicit "Yes, I am safe" — or an audited operator exception — ends it.</p></div>
    </section>
    <section class="card limits">
      <h3>Please know</h3>
      <ul>
        <li><strong>Not a replacement for 112.</strong> Beti Bachao does not automatically contact police or ambulance. Our operators may call them for you, but in immediate danger always call your local emergency number yourself.</li>
        <li>Location accuracy depends on your device. We show accuracy, age and "floor unknown" honestly — never a fake precise position.</li>
        <li>Browsers cannot send SMS silently. "Text my contacts" opens your SMS app pre-filled; you press send.</li>
        <li>Volunteers are verified people, not police. They are trained to help you reach safety and to call emergency services — never to fight.</li>
      </ul>
    </section>
  `);
}

async function viewLogin(params) {
  const want = params.get('as');
  return shell(`
    <section class="narrow">
      <h1>${esc(t('login'))}</h1>
      <form class="card form" data-form="login" autocomplete="on">
        <label>Email<input name="email" type="email" required autocomplete="username"></label>
        <label>Password<input name="password" type="password" required autocomplete="current-password"></label>
        <div class="mfa-enroll hidden card"><h3>Set up two-step login</h3>
          <p class="small">Operators and admins must use an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…). Add a new account in the app using this key, then enter the 6-digit code it shows:</p>
          <p class="phrase mfa-secret"></p><p class="small"><a class="mfa-uri" href="#">Open in authenticator app</a></p></div>
        <label class="mfa hidden">Authenticator code<input name="mfaCode" inputmode="numeric" pattern="\\d{6}" autocomplete="one-time-code"></label>
        <button class="btn btn-primary" type="submit">${esc(t('login'))}</button>
        <p class="muted">New here? <a href="#/register${want ? `?as=${esc(want)}` : ''}">Create an account</a> · <a href="#" data-act="forgot">Forgot password?</a></p>
      </form>
    </section>`);
}

function viewChangePassword() {
  const forced = !!st.me?.mustChangePassword, min = ['operator', 'admin'].includes(st.me?.role) ? 12 : 10;
  return shell(`<section class="narrow"><h1>Choose a new password</h1><p class="muted">${forced ? 'Your password was reset by the admin. Choose your own new password to continue — you will use it from now on.' : 'Enter your current password, then the new one twice.'}</p>
    <form class="card form" data-form="change-pw">
    ${forced ? '' : '<label>Current password<input name="cur" type="password" required autocomplete="current-password"></label>'}
    <label>New password (${min}+ characters)<input name="pw" type="password" minlength="${min}" required autocomplete="new-password" autocapitalize="off" spellcheck="false"></label>
    <label>Type the new password again<input name="pw2" type="password" minlength="${min}" required autocomplete="new-password" autocapitalize="off" spellcheck="false"></label>
    <label class="switch"><input type="checkbox" data-change="show-pw"> Show passwords</label>
    <button class="btn btn-primary">Save new password</button></form></section>`, { nav: false });
}

// The official server. Phone apps start with it filled in; admins can still point to another one.
export const OFFICIAL_SERVER = 'https://betibachao24x7.com';
function viewConnect() {
  return shell(`<section class="narrow"><h1>Connect to Beti Bachao</h1><p class="muted">Tap Connect to use the official Beti Bachao server. Change the address only if your organisation runs its own server.</p>
    <form class="card form" data-form="connect"><label>Server address<input name="url" type="url" required placeholder="${OFFICIAL_SERVER}" value="${esc(serverUrl() || OFFICIAL_SERVER)}" autocapitalize="off" spellcheck="false"></label><button class="btn btn-primary btn-lg">Connect</button></form>
    <p class="small muted">Backup address: https://beti-bachao.onrender.com</p></section>`, { nav: false });
}

function viewSetup(params) {
  return shell(`
    <section class="narrow">
      <h1>First-time setup</h1>
      <p class="muted">Create the administrator account. The one-time setup code is printed in the server terminal (on GitHub Codespaces: the terminal, or run <code>cat /tmp/beti-bachao.log</code>).</p>
      <form class="card form" data-form="setup">
        <label>Setup code<input name="code" required value="${esc(params.get('code') || '')}" autocomplete="off"></label>
        <label>Your name<input name="displayName" required maxlength="60"></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Password (12+ characters)<input name="password" type="password" minlength="12" required autocomplete="new-password"></label>
        <button class="btn btn-primary">Create admin</button>
      </form>
    </section>`);
}

// Country preselected on the sign-up form: device locale if supported, else the server default.
function regCountry() { const g = guessCountry(); return st.cfg?.countries?.[g] ? g : (st.cfg?.defaultCountry || 'IN'); }

function viewRegister(params) {
  const asVol = params?.get('as') === 'volunteer';
  return shell(`
    <section class="narrow">
      <h1>Create account</h1>
      <form class="card form" data-form="register">
        <label>Display name<input name="displayName" required maxlength="60"></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Mobile number (for SOS SMS and password reset)${phoneInput('phone', { required: true, lang: lang() })}<small class="muted">Pick your country code, then type your number.</small></label>
        <label>Password (10+ characters)<input name="password" type="password" minlength="10" required autocomplete="new-password"></label>
        <fieldset><legend>I am joining as</legend>
          <label class="radio"><input type="radio" name="role" value="user" ${asVol ? '' : 'checked'}> ${esc(t('need_safety'))}</label>
          <label class="radio"><input type="radio" name="role" value="volunteer" ${asVol ? 'checked' : ''}> ${esc(t('want_volunteer'))} (identity check + training required)</label>
        </fieldset>
        <label>Country (sets emergency number and police rules)<select name="countryCode">${Object.entries(st.cfg.countries).map(([c, v]) => `<option value="${c}" ${c === regCountry() ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <label class="switch"><input type="checkbox" name="consent" required> I agree that when I raise an SOS my live location is shared with verified volunteers who accept it and with Beti Bachao operators, and that this app does not automatically contact police or ambulance.</label>
        <button class="btn btn-primary" type="submit">Create account</button>
      </form>
    </section>`);
}

// ------------------------------------------------------------------ user: home
function locationCard(loc, { live = false } = {}) {
  const p = prefs.get();
  if (!loc) {
    return `<div class="card loc-card"><div class="loc-head"><strong>📍 ${esc(t('location'))}</strong><span class="badge badge-warn">${esc(t('location_off'))}</span></div>
      ${infoTip('More info', `${geo.supported ? 'Location helps volunteers find you. You can still send SOS without it.' : 'This browser has no location support.'}`)}
      ${geo.supported ? `<button class="btn btn-secondary" data-act="share-location">${esc(t('allow_location'))}</button>` : ''}
</div>`;
  }
  const ageSec = loc.ageSec ?? Math.round((Date.now() - Date.parse(loc.observedAt)) / 1000);
  const staleNow = loc.stale || ageSec > 120;
  return `<div class="card loc-card">
    <div class="loc-head"><strong>📍 ${esc(t('location'))}</strong><span class="badge badge-ok">${esc(t('location_on'))}</span></div>
    <div class="loc-grid">
      <div><span class="k">${esc(t('accuracy', { m: loc.accuracyM }))}</span>${loc.lowAccuracy || loc.accuracyM > 100 ? `<span class="badge badge-warn">${esc(t('low_accuracy'))}</span>` : ''}</div>
      <div><span class="k" data-live="age" data-at="${esc(loc.observedAt)}"></span>${staleNow ? `<span class="badge badge-warn">${esc(t('stale'))}</span>` : ''}</div>
      <div class="full"><span class="k">${esc(loc.vertical || t('floor_unknown'))}</span>${loc.altitudeNote ? `<small class="muted">${esc(loc.altitudeNote)}</small>` : ''}</div>
    </div>
    ${live ? `<form class="inline-form" data-form="floor"><label>Floor (optional, if safe)<input name="floor" type="number" min="-5" max="200" inputmode="numeric"></label><button class="btn btn-ghost btn-sm">Add</button></form>` : ''}
  </div>`;
}

function currentLoc() { return geo.last; }

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
    <h1 class="sr-only">Beti Bachao — SOS</h1>
    <section class="sos-wrap">
      <button class="sos-btn" id="sos-btn" aria-describedby="sos-hint" data-hold="sos">
        <svg viewBox="0 0 120 120" class="sos-ring" aria-hidden="true"><circle cx="60" cy="60" r="54" class="sos-track"/><circle cx="60" cy="60" r="54" class="sos-progress" id="sos-progress"/></svg>
        <span class="sos-label">${esc(t('sos'))}</span>
      </button>
      <p id="sos-hint" class="sos-hint">${esc(t('hold_to_send'))}</p>
      ${(() => { const ac = P.activeContacts(); return ac.contacts.length ? `<a class="contacts-now" href="#/places">👥 SOS goes to ${ac.place ? `your <b>${esc(ac.place.label)}</b> contacts` : 'your contacts'}: ${ac.contacts.map((x) => esc(x.name)).join(', ')}</a>` : `<a class="alert alert-info alert-link" href="#/places">👥 ${esc(t('add_contacts_hint'))}</a>`; })()}
      <p class="hint-strong">${esc(t('call_now_hint'))}</p>
    </section>
    ${emergencyBar()}
    ${locationCard(loc)}
    <section class="tool-grid" aria-label="${esc(t('tools'))}">
      <a class="tool" href="#/trip">🚕<span>Track my travel</span></a>
      <a class="tool" href="#/places">📍<span>Places & contacts</span></a>
      <a class="tool" href="#/help">🚓<span>Nearby help</span></a>
      <a class="tool" href="#/blink">👁️<span>Blink SOS</span></a>
      <button class="tool" data-act="voice-command">🎤<span>Voice command</span></button>
      <a class="tool" href="#/dashboard">📊<span>My safety</span></a>
      <button class="tool" data-act="siren">📢<span>${esc(t('siren'))}</span></button>
      <button class="tool" data-act="fake-call">📱<span>${esc(t('fake_call'))}</span></button>
      <button class="tool" data-act="record-toggle">🎙️<span>${esc(recorder.recording ? t('stop') : t('record'))}</span></button>
      <a class="tool" href="#/tools">🧰<span>${esc(t('tools'))}</span></a>
      <button class="tool" data-act="share-now">📤<span>${esc(t('text_contacts'))}</span></button>
    </section>
  `);
}

function sosMessage(loc, shareToken = null) {
  const base = t('sms_message', { link: loc ? mapsLink(loc) : '(location unavailable)', m: loc?.accuracyM ?? '?' });
  return shareToken ? `${base} 🔴 Live: ${liveLink(`/s/${shareToken}`)}` : base;
}
// Address of the live page her contacts open (the server this app talks to).
function liveLink(p) { return (isNative ? serverUrl() : location.origin + location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '')) + p; }
const newShareToken = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
// The SMS her phone sends by itself: short, plain GSM-7 English (no emoji / Indic script),
// so it fits in 1–2 SMS parts and goes out and arrives fastest on every network.
function sosSmsText(loc, shareToken) {
  const where = loc ? `https://maps.google.com/?q=${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}${loc.accuracyM ? ` (+/-${Math.round(loc.accuracyM)}m)` : ''}` : 'see live link';
  const live = shareToken ? ` Live: ${liveLink(`/s/${shareToken}`)}` : '';
  return `SOS! I need help (Beti Bachao). Location: ${where}.${live} Call me or 112.`;
}
function smsButtons() {
  const loc = geo.last || currentLoc();
  const nums = contacts.list().map((c) => c.phone);
  const msg = sosMessage(loc);
  return `${nums.length ? `<a class="btn btn-secondary" href="${esc(smsHref(nums, msg))}">💬 ${esc(t('text_contacts'))}</a>` : '<a class="btn btn-ghost" href="#/settings">+ Add trusted contacts</a>'}
    <a class="btn btn-ghost" href="${esc(whatsappHref(msg))}" target="_blank" rel="noopener">🟢 ${esc(t('share_whatsapp'))}</a>`;
}

// ------------------------------------------------------------------ native app glue
// Gives the native layer everything it needs to raise an SOS while the app is
// closed (lock-screen button, quick tile, widget, power button, Siri).
async function syncNative() {
  if (!native.available() || !st.me) return;
  const p = prefs.get();
  await native.configure({ serverUrl: serverUrl(), token: st.api.token, role: st.me.role, armed: !!p.armed, displayName: st.me.displayName,
    contacts: contacts.list(), places: store.get('places', []), sms112: !!p.sms112, autoSms: p.autoSms !== false, shake: !!p.shake, powerButton: p.powerButton !== false,
    voice: !!p.voiceNative, keywords: sosWords(lang(), p.customSosWords || []), voiceLang: sosVoiceLang(p.customSosWords || []), autoEvidence: p.autoEvidence !== false, lang: lang(),
    message: sosMessage(null), emergencyNumber: country().emergency });
  if (st.me.role === 'user') { if (p.armed) native.startSafety('armed'); }
}
async function syncContactsToServer() { try { await st.api.saveContacts({ contacts: contacts.list() }); } catch {} syncNative(); }
async function registerAppPush() {
  if (!native.available()) return;
  const r = await native.getPushToken();
  if (r?.token) { try { await st.api.registerDevice({ platform, token: r.token, appVersion: r.appVersion }); } catch {} }
}

// ------------------------------------------------------------------ SOS
async function triggerSOS({ severity = 'HIGH', silent = false, trigger = 'button' } = {}) {
  if (st.sendingSos) return;
  st.sendingSos = true;
  const isRetry = !!store.get('pendingSos', null);
  const pending = store.get('pendingSos', null) || { key: uuid(), createdAt: new Date().toISOString(), severity, silent, trigger, shareToken: newShareToken() };
  store.set('pendingSos', pending);
  // Open the pre-filled "I am in danger + location" SMS to trusted contacts right away,
  // while the tap/hold still counts as a user gesture. Browsers cannot send SMS silently;
  // the phone's SMS app opens ready to send. The SOS continues in the background.
  let deviceSmsSent = false;
  let deviceSmsNumbers = [];
  // Location: use the last fix at once if it is recent; otherwise ask for a fresh one *in parallel*
  // with the SMS (the SMS never waits for GPS — a follow-up SMS carries the location if it was missing).
  const fresh = (l) => l && Date.now() - Date.parse(l.observedAt) < 120000;
  const loc0 = fresh(geo.last) ? geo.last : null;
  const locP = loc0 && Date.now() - Date.parse(loc0.observedAt) < 30000 ? Promise.resolve(loc0)
    : Promise.race([geo.once(6000).catch(() => null), new Promise((r) => setTimeout(() => r(null), 3500))]).then((l) => l || loc0);
  geo.start();
  let smsP = Promise.resolve();
  if (!isRetry && prefs.get().autoSms !== false && (P.activeContacts().contacts.length || prefs.get().sms112)) {
    const nums = P.activeContacts(loc0).contacts.map((c) => c.phone); // contacts for the place she is at
    deviceSmsNumbers = nums;
    store.set('autoSmsAt', Date.now());
    if (native.available()) {
      smsP = native.sendSos({ numbers: nums, message: sosSmsText(loc0, pending.shareToken), sms112: !!prefs.get().sms112 })
        .then((r) => { deviceSmsSent = !!(r && r.sent > 0); })
        .catch(() => {});
    } else if (nums.length) openExternal(smsHref(nums, sosMessage(loc0, pending.shareToken)));
  }
  if (!silent) vibrate([200, 100, 200]);
  keepAwake(true);
  if (!silent) toast(t('sending'), 'warn');
  const p = prefs.get();
  // Wait only for the first SMS hand-off (milliseconds) and the location race (≤3.5 s), side by side.
  const [loc] = await Promise.all([locP, smsP.catch(() => {})]);
  const body = { idempotencyKey: pending.key, location: loc, severity: pending.severity, trigger: pending.trigger, silent: pending.silent, battery: await battery(), deviceSmsSent, deviceSmsNumbers: deviceSmsSent ? deviceSmsNumbers : [], shareToken: pending.shareToken };
  try {
    const r = await st.api.createIncident(body);
    store.set('pendingSos', null);
    store.set('lastIncident', r.incident.id);
    if (native.available()) native.startSafety('sos'); // background GPS even with the screen locked
    st.sendingSos = false;
    announce('SOS sent. Help is being searched for. Stay on this screen if you can.', { assertive: true });
    if (!r.duplicate && prefs.get().autoEvidence !== false && !(silent && !recorder.supported)) P.captureEvidence(r.incident.id).catch(() => {});
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
  const label = { shake: 'shake_detected', voice: 'voice_detected', safewalk: 'safe_walk_expired', blink: 'blink_detected' }[kind] || 'voice_detected';
  const el = document.createElement('div');
  el.className = 'countdown';
  el.setAttribute('role', 'alertdialog');
  el.innerHTML = `<p class="countdown-text"></p><button class="btn btn-light btn-lg" data-cd="cancel">${esc(t('cancel'))}</button><button class="btn btn-primary btn-lg" data-cd="now">SOS now</button>`;
  document.body.appendChild(el);
  let left = seconds;
  const upd = () => { el.querySelector('.countdown-text').textContent = t(label, { s: left }); vibrate(150); announce(t(label, { s: left }), { assertive: true }); };
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
  try { v = await st.api.getIncident(id); } catch (e) { return failView(e); }
  st.incident = v;
  if (v.search?.deadline && v.search.secondsLeft != null) st.skew = (Date.parse(v.search.deadline) - v.search.secondsLeft * 1000) - Date.now();
  let tl = [];
  try { tl = (await st.api.timeline(id)).items; } catch {}
  const silent = params.get('silent') === '1';
  if (v.role !== 'requester') return shell('<p>Not your incident.</p>');
  // SOS over: no "ended" screen. Straight back to Home (after the optional volunteer rating).
  if (v.closed) {
    clearInterval(st.pollTimer); keepAwake(false);
    const unrated = (v.rateable || []).filter((r) => !r.rated);
    if (!unrated.length) {
      if (!store.get('endedToast:' + v.id, false)) { store.set('endedToast:' + v.id, true); toast(v.closureReason === 'USER_CONFIRMED_SAFE' ? '💚 You are marked safe. Responders were released.' : 'Your SOS has ended.', 'ok', 5000); }
      setTimeout(() => go('#/home'), 0);
      return null;
    }
  }
  speakStatus(v);
  // Police auto-connect: her phone calls the admin-loaded station's first number once — no dialler tap.
  if (v.police?.dial?.number && v.police.dial.result !== 'PLACED' && !v.closed && !store.get('policeDial:' + v.id, false)) {
    store.set('policeDial:' + v.id, true);
    toast(`📞 Calling ${v.police.dial.label || v.police.dial.number}…`, 'warn', 6000);
    setTimeout(() => placePoliceCall(v.id, v.police.dial.number), 400);
  }
  const open = !v.closed;
  // Nobody has responded yet → her phone tells her contacts she is still waiting (when the server can't text them).
  if (open && !st.cfg?.features?.sms && native.available() && platform === 'android' && !v.operatorAcknowledged && !(v.responders || []).length
    && Date.now() - Date.parse(v.createdAt) > (st.cfg?.contactsWaitingSec || 180) * 1000 && !store.get('waitSms:' + v.id, false)) {
    store.set('waitSms:' + v.id, true);
    const nums = P.activeContacts(v.location || geo.last).contacts.map((c) => c.phone);
    if (nums.length) native.sendSos({ numbers: nums, message: `STILL WAITING for help - no responder yet (Beti Bachao).${v.liveSharePath ? ` Live: ${liveLink(v.liveSharePath)}` : ''} Please call me or 112.`, sms112: false });
  }
  { const last = tl[tl.length - 1]; notifyChange('her:' + v.id, last ? `${last.at}|${last.text}` : '', last ? tlText(last) : '', 'ok'); }
  const radii = st.cfg?.radiusStagesKm || [10, 20, 30];
  const stages = [0, 1, 2].map((i) => `<li class="${v.search?.stage === i ? 'on' : v.search?.stage > i ? 'done' : ''}">${esc(radii[i])} km</li>`).join('');
  return shell(`
    ${open ? `<section class="status-hero status-${esc(v.color)} ${silent ? 'discreet' : ''}" aria-live="polite">
      <div class="status-dot" aria-hidden="true"></div>
      <h1>${esc(statusText(v))}</h1>
      ${open && v.search?.radiusKm ? `<p>${esc(t('searching_within', { km: v.search.radiusKm }))} · ${esc(t('volunteers_alerted', { n: v.alertedCount }))}</p>` : ''}
      ${open && v.search?.secondsLeft != null && (v.responders?.length || 0) < 2 ? `<p class="small"><span data-live="stage-countdown" data-deadline="${esc(v.search.deadline)}"></span></p>` : ''}
      <ol class="stage-bar" aria-label="Search stages">${stages}</ol>
    </section>` : ''}
    ${open ? (() => { const last = tl[tl.length - 1]; return last ? `<section class="latest-update" aria-live="assertive"><span class="lu-label">Latest update · ${esc(fmtTime(last.at))}</span><strong>${esc(tlText(last))}</strong>${(v.responders || []).length ? `<span class="lu-sub">${(v.responders || []).map((r) => `${esc(r.label)}: ${esc(pretty(r.status))}${r.approxEtaMin && r.status === 'EN_ROUTE' ? ` (≈${esc(r.approxEtaMin)} min)` : ''}`).join(' · ')}</span>` : ''}</section>` : ''; })() : ''}
    ${open ? `<section class="action-grid">
      <button class="btn btn-safe btn-lg" data-act="are-you-safe">✅ ${esc(t('are_you_safe'))}</button>
      <button class="btn btn-danger" data-act="more-help">🆘 ${esc(t('need_help'))}</button>
      <button class="btn btn-warn" data-act="report-danger">⚠️ ${esc(t('report_danger'))}</button>
    </section>` : ''}
    ${P.incidentPolice(v)}
    ${open && v.status === 'LOCATION_UNAVAILABLE' ? `<div class="alert alert-danger" role="alert"><strong>📍 We don't have your location yet, so volunteers can't be matched.</strong> Call a number below now, and allow location for this site.<div class="row"><button class="btn btn-secondary" data-act="share-location">${esc(t('allow_location'))}</button></div></div>` : ''}
    ${open ? emergencyBar() : ''}
    ${open ? pushCard('Get updates on your phone when a volunteer accepts or arrives') : ''}
    ${v.escalations?.length ? `<div class="alert alert-warn esc-compact"><strong>⚠️ Escalated</strong> — ${v.police ? 'operators alerted and police contacted' : 'all operators alerted'}. In danger, call 112 yourself too.
      ${infoTip('What happened', `<ul class="esc-list">${[...new Map(v.escalations.map((e) => [e.type, e])).values()].map((e) => `<li><b>${esc(pretty(e.type))}</b> · ${esc(fmtTime(e.attemptedAt))}</li>`).join('')}</ul>`)}</div>` : ''}
    ${open ? `
    ${trackingCard(v.responders, v.location, v.radiusStagesKm, { title: t('responders') })}
    <section class="action-grid">
      <button class="btn btn-secondary" data-act="siren">📢 ${esc(t('siren'))}</button>
      <button class="btn btn-secondary" data-act="record-toggle">🎙️ ${esc(recorder.recording ? t('stop') : t('record'))}</button>
      <button class="btn btn-secondary" data-act="speak-status">🔊 Read status aloud</button>
      <button class="btn btn-secondary" data-act="voice-command">🎤 Voice command</button>
    </section>
    ${open && v.liveSharePath ? `<section class="card"><h2>🔴 Live link for your family</h2><p class="small">Your contacts got this link by SMS — it shows where you are until you mark yourself safe.</p><p class="phrase small">${esc(liveLink(v.liveSharePath))}</p><div class="row"><button class="btn btn-secondary" data-act="trip-share" data-link="${esc(liveLink(v.liveSharePath))}">📤 Share with someone else</button><a class="btn btn-ghost" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(`I need help. Follow my live location: ${liveLink(v.liveSharePath)}`)}">🟢 WhatsApp</a></div></section>` : ''}
    ${v.evidenceCount ? `<p class="small muted">🎙️ ${v.evidenceCount} evidence recording(s) sent securely to the operators.</p>` : st.evidenceRecording ? '<p class="small">🎙️ Recording 15 seconds of audio as evidence…</p>' : ''}
    ${contacts.list().length ? `<div class="card"><h2>📞 ${esc(t('contacts'))}</h2><p class="small muted">${esc(t('text_contacts'))}: <a href="${esc(smsHref(P.activeContacts(v.location || geo.last).contacts.map((c) => c.phone), sosMessage(v.location || geo.last, v.liveSharePath?.slice(3))))}">💬 SMS with live tracking link</a></p><div class="row">${contacts.list().map((c) => `<a class="btn btn-secondary" href="${telHref(c.phone)}">📞 ${esc(c.name)}</a>`).join('')}</div></div>` : ''}
    <div class="card"><div class="row">${smsButtons()}<button class="btn btn-ghost" data-act="native-share">📤 Share…</button></div></div>
    ${locationCard(v.location, { live: true })}
    ${v.location ? `<section class="card"><h2>📍 Your live location (as shared)</h2>${googleMap(v.location, 'Your live location', 'mine')}</section>` : ''}
    <section class="cancel-zone"><button class="btn btn-cancel-sos btn-block" data-act="cancel-sos" data-id="${esc(v.id)}">✖ ${esc(t('cancel_sos'))} — false alarm</button><p class="small muted">Only if you are safe. ${st.me?.hasPins ? 'Needs your PIN.' : ''}</p></section>
    ` : `
    ${(v.rateable || []).length ? `<section class="card"><h2>How did the volunteers do?</h2>${infoTip('More info', `Your rating is private and helps the trust team keep volunteers safe and accountable.`)}
      ${v.rateable.map((r) => r.rated ? `<p>${esc(r.label)}: ${'★'.repeat(r.stars || 0)} — thank you</p>` : `<form class="card form rate-form" data-form="rate" data-id="${esc(v.id)}" data-ref="${esc(r.ref)}"><strong>${esc(r.label)}</strong>
        <div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<label class="star"><input type="radio" name="stars" value="${n}" required> ${'★'.repeat(n)}</label>`).join('')}</div>
        <label class="switch"><input type="checkbox" name="feltUnsafe"> I felt unsafe with this volunteer (the trust team will review)</label>
        <label>Comment (optional)<input name="comment" maxlength="500"></label><button class="btn btn-primary btn-sm">Submit rating</button></form>`).join('')}<button class="btn btn-ghost btn-sm" data-act="skip-rating" data-id="${esc(v.id)}">Skip</button></section>` : ''}`}
    <details class="card" data-keep="user-timeline"><summary>${esc(t('timeline'))} (${tl.length})</summary><ol class="timeline">${tl.map((x) => `<li><time>${esc(fmtTime(x.at))}</time> ${esc(tlText(x))}${x.reason ? ` <small class="muted">— ${esc(x.reason)}</small>` : ''}</li>`).join('')}</ol></details>
  `);
}

let lastDutyPost = 0;
async function streamDutyLocation() {
  if (st.me?.role !== 'volunteer' || st.activeAsg || !store.get('onDuty', false) || Date.now() - lastDutyPost < 120000) return;
  lastDutyPost = Date.now();
  geo.start();
  if (!geo.last) return;
  try { await st.api.setAvailability({ location: geo.last }); } catch {}
}
let lastVolPost = 0;
async function streamVolunteerLocation() {
  if (st.me?.role !== 'volunteer' || !st.activeAsg || Date.now() - lastVolPost < 10000) return;
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
  try { await st.api.addLocation(v.id, loc); } catch {}
}

// The SOS currently on screen — from state, or from the address if a refresh is mid-way.
const incId = () => st.incident?.id || (location.hash.match(/^#\/incident\/([^/?]+)/) || [])[1] || null;

async function askSafe() {
  const v = { id: incId() };
  if (!v.id) return;
  const r = await modal({ title: t('are_you_safe'), cls: 'safe-modal', body: '<p class="muted">Responders stay with you until you say you are safe.</p>', actions: [{ id: 'YES', label: t('yes_safe'), kind: 'safe' }, { id: 'NO', label: t('not_safe'), kind: 'danger' }, { id: 'NEED_MORE_HELP', label: t('need_help'), kind: 'warn' }] });
  if (r.id === 'dismiss') return;
  try {
    if (r.id === 'YES') {
      const c = await modal({ title: t('confirm_safe'), body: '<p>This will close your SOS and release volunteers.</p>', actions: [{ id: 'confirm', label: t('confirm_safe'), kind: 'safe' }, { id: 'no', label: t('cancel') }] });
      if (c.id !== 'confirm') return;
      await st.api.safety(v.id, { response: 'YES', confirm: true });
      siren.stop(); keepAwake(false); geo.stop();
      if (native.available()) prefs.get().armed ? native.startSafety('armed') : native.stopSafety();
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
      ${infoTip('More info', `Keep this app open during the trip.`)}
      ${sw ? `<p><strong data-live="safewalk"></strong></p><div class="row"><button class="btn btn-primary" data-act="safewalk-checkin">${esc(t('check_in'))}</button><button class="btn btn-ghost" data-act="safewalk-stop">${esc(t('stop'))}</button></div>`
        : `<form class="inline-form" data-form="safewalk"><label>${esc(t('minutes'))}<input name="minutes" type="number" min="1" max="240" value="15" required></label><button class="btn btn-primary">${esc(t('start'))}</button></form>`}
    </section>
    <section class="card"><h2>📢 ${esc(t('siren'))}</h2>${infoTip('More info', `Loud alarm with a flashing screen to draw attention.`)}<button class="btn btn-danger" data-act="siren">${esc(siren.on ? t('stop') : t('start'))}</button></section>
    <section class="card"><h2>📱 ${esc(t('fake_call'))}</h2>${infoTip('More info', `Simulates an incoming call so you have a reason to leave.`)}
      <form class="inline-form" data-form="fakecall"><label>Caller<input name="caller" value="${esc(prefs.get().fakeCaller)}" maxlength="30"></label><label>Delay (s)<input name="delay" type="number" min="0" max="300" value="5"></label><button class="btn btn-secondary">${esc(t('start'))}</button></form></section>
    <section class="card"><h2>🎙️ ${esc(t('record'))}</h2>
      ${infoTip('More info', `Recordings stay on this device only (not uploaded). Download them to keep a copy.`)}
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
    <a class="alert alert-info alert-link" href="#/places">📍 <b>Places & contacts</b> — who gets your SOS, by place</a>
    <section class="card"><h2>👥 ${esc(t('contacts'))}</h2>
      <p>⭐ Important: ${contacts.list().map((x) => esc(x.name)).join(', ') || '<span class="danger-text">none yet — add at least 1</span>'}</p>
      <a class="btn btn-secondary" href="#/places">Edit important contacts & places</a>
    </section>
    <section class="card form"><h2>🔐 ${esc(t('your_safety_pin'))}</h2>
      ${infoTip('More info', `${me.hasPins ? 'PINs are set.' : 'Without a PIN, cancelling needs only a confirmation tap.'} The <strong>duress PIN</strong> makes the app show "cancelled" while it secretly keeps help coming — useful if someone forces you to cancel.`)}
      <form data-form="pins" class="inline-form"><label>${esc(t('cancel_pin'))}<input name="cancelPin" inputmode="numeric" pattern="\\d{4,6}" required maxlength="6" type="password"></label><label>${esc(t('duress_pin'))}<input name="duressPin" inputmode="numeric" pattern="\\d{4,6}" maxlength="6" type="password"></label><button class="btn btn-secondary">${esc(t('save'))}</button></form>
    </section>
    <section class="card form"><h2>⚡ ${esc(t('triggers'))}</h2>
      <label class="switch"><input type="checkbox" data-change="autoSms" ${p.autoSms !== false ? 'checked' : ''}> ${esc(t('auto_sms'))}${platform === 'android' ? ' <small>(sent automatically by this phone)</small>' : ''}</label>
      ${platform === 'android' ? `<label class="switch"><input type="checkbox" data-change="sms112" ${p.sms112 ? 'checked' : ''}> Also send an SOS SMS with my location to <b>112</b> (India ERSS accepts SMS)</label>` : ''}
      ${st.cfg?.features?.sms ? `<label class="switch"><input type="checkbox" data-change="serverSms" ${p.serverSms !== false ? 'checked' : ''}> If my phone can't send SMS, let Beti Bachao text my contacts</label>` : ''}
      ${native.available() ? `<label class="switch"><input type="checkbox" data-change="armed" ${p.armed ? 'checked' : ''}> <b>Background protection</b>: SOS button on the lock screen${platform === 'android' ? ', quick-settings tile and press power button 5 times' : ' and "Hey Siri, Beti Bachao SOS"'}</label>
        <div class="row"><button class="btn btn-ghost btn-sm" data-act="perm-setup">Phone permissions setup</button><button class="btn btn-ghost btn-sm" data-act="native-perms">Check status</button></div>` : ''}
      <label class="switch"><input type="checkbox" data-change="shake" ${p.shake ? 'checked' : ''}> ${esc(t('shake_trigger'))}</label>
      ${native.available()
        ? `<label class="switch"><input type="checkbox" data-change="voiceNative" ${p.voiceNative ? 'checked' : ''}> <b>Voice SOS</b> — say your SOS word${platform === 'android' ? ' (works with the screen locked)' : ''}</label>`
        : `<label class="switch"><input type="checkbox" data-change="voice" ${p.voice ? 'checked' : ''} ${voice.supported ? '' : 'disabled'}> <b>Voice SOS</b> — say your SOS word ${voice.supported ? '' : '<small>(not supported in this browser)</small>'}</label>`}
      <label class="sos-words-field">Your SOS words<input data-change="customSosWords" value="${esc(ownSosWords(p.customSosWords || []).join(', '))}" maxlength="120" placeholder="bachao"></label>
      ${infoTip('About SOS words', `Voice SOS starts only when you say one of <b>your</b> words — nothing else. Default is <b>bachao</b>. Use a word an attacker won't recognise, e.g. <i>pineapple</i>; separate several words with commas. After the app hears it you get 5 seconds to cancel.${platform === 'android' ? ' With background protection on, it also works when the phone is locked.' : ''}`)}
      <label class="switch"><input type="checkbox" data-change="autoEvidence" ${p.autoEvidence !== false ? 'checked' : ''}> Record 15 s of audio after my SOS is active and send it to the operators and admin as evidence</label>
      ${infoTip('About evidence recording', 'Recording starts silently once your SOS has reached the server. It is saved only if a voice is heard — silence is discarded. Nothing to confirm: it is sent automatically, encrypted, and every step is written to the audit log.')}
      <a class="btn btn-ghost btn-sm" href="#/blink">👁️ Blink SOS (3 slow blinks at the front camera)</a>
    </section>
    <section class="card form"><h2>♿ Accessibility</h2>
      <label class="switch"><input type="checkbox" data-change="voiceGuide" ${p.voiceGuide ? 'checked' : ''}> <b>Spoken guidance</b> — the app speaks every update (who is coming, how far, police contacted) and repeats your SOS status every minute</label>
      ${infoTip('More info', `${a11y.screenReader ? 'Screen reader detected — updates are announced through TalkBack/VoiceOver.' : 'Works with TalkBack and VoiceOver.'} Hold-to-SOS works with a screen reader: double-tap and hold the SOS button, or press shake/power button/voice. Tap 🎤 Voice command and say "help", "status", "call police" or "I am safe".`)}
      ${infoTip('More info', `Shake and voice triggers start a 5-second countdown you can cancel, then send SOS. They work while this app is open on screen; browsers pause sensors in the background.`)}
    </section>
    <section class="card"><h2>📜 ${esc(t('history'))}</h2><ul class="history">${history.map((h) => `<li><a href="#/incident/${esc(h.id)}">${esc(new Date(h.createdAt).toLocaleString())}</a> — ${esc(pretty(h.status))}</li>`).join('') || '<li class="muted">No SOS yet.</li>'}</ul></section>` : ''}
    <section class="card"><h2>🛡️ ${esc(t('privacy'))}</h2>
      <p class="muted">Signed in as ${esc(me.displayName)} (${esc(me.role)}).${window.BB_APP_BUILD ? ` · App ${esc(String(window.BB_APP_BUILD).replace(/\((\w{7})\w*\)/, '($1)'))}` : ''}</p>
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

function viewVolunteerOnboarding(prof) {
  const ver = prof.verification;
  const trained = prof.trainingCompleted.length >= prof.trainingModules.length;
  const step = (n, done, title, body) => `<li class="onb-step ${done ? 'done' : ''}"><span class="onb-n">${done ? '✓' : n}</span><div><strong>${esc(title)}</strong>${body}</div></li>`;
  const call = ver?.call;
  return shell(`
    <h1>Become a verified volunteer</h1>
    ${infoTip('More info', `You can respond to SOS alerts only after the admin approves you. Until then, alerts and duty are locked.`)}
    ${prof.verificationStatus === 'REJECTED' ? `<div class="alert alert-danger">Your verification was not approved${ver?.rejectReason ? `: ${esc(ver.rejectReason)}` : ''}. Contact the Beti Bachao team.</div>` : ''}
    <ol class="onb">
      ${step(1, trained, `Training (${prof.trainingCompleted.length}/${prof.trainingModules.length})`, trained ? '' : `<ul class="training">${prof.trainingModules.map((m) => `<li>${prof.trainingCompleted.includes(m.id) ? '✅' : `<button class="btn btn-ghost btn-sm" data-act="vol-train" data-id="${esc(m.id)}">Start</button>`} ${esc(m.title)}</li>`).join('')}</ul>`)}
      ${step(2, !!ver, 'Request verification', ver ? `<p class="small muted">Requested ${esc(new Date(ver.submittedAt).toLocaleString())}</p>` : `<p class="small">The admin will book a short video call.</p><button class="btn btn-primary" data-act="vol-verify" ${trained ? '' : 'disabled'}>Request verification</button>`)}
      ${step(3, !!call, 'Video verification call', call ? `<p>📅 <strong>${esc(new Date(call.scheduledAt).toLocaleString())}</strong></p>
          <p class="small">On the call, show the <strong>front and back of your Aadhaar card</strong> to the camera, next to your face. The call is not recorded and no photo of your Aadhaar is kept.</p>
          <a class="btn btn-primary" href="${esc(call.roomUrl)}" target="_blank" rel="noopener">📹 Join video call</a>` : '<p class="small muted">Waiting for the admin to book a time. You will get a notification and SMS.</p>')}
      ${step(4, prof.approved, 'Admin approval', prof.approved ? '' : '<p class="small muted">After the call, the admin approves your account. Then you can go on duty.</p>')}
    </ol>
    <details class="card" data-keep="conduct"><summary>Volunteer Code of Conduct</summary><ol>${CONDUCT.map((c) => `<li>${esc(c)}</li>`).join('')}</ol></details>`);
}

async function viewVolunteer() {
  let prof, alerts = [];
  try { prof = await st.api.volunteerProfile(); } catch (e) { return failView(e); }
  if (!prof.approved) { if (native.available()) native.stopSafety(); return viewVolunteerOnboarding(prof); }
  try { alerts = (await st.api.volunteerAlerts()).items; } catch (e) { return failView(e); }
  const el = prof.eligibility;
  const check = (ok, label) => `<li class="${ok ? 'ok' : 'no'}">${ok ? '✅' : '⬜'} ${esc(label)}</li>`;
  const sel = alerts.find((a) => a.id === st.volSel) || alerts.find((a) => a.open);
  const reasons = el.reasons;
  const fresh = alerts.filter((a) => a.open && !a.alertResponse && !a.assignment);
  st.activeAsg = alerts.find((a) => a.open && a.assignment)?.assignment.id || null;
  if (native.available()) { const mode = st.activeAsg ? 'assigned' : prof.available ? 'duty' : null; if (mode !== st.nativeMode) { st.nativeMode = mode; mode ? native.startSafety(mode) : native.stopSafety(); } }
  return shell(`
    ${fresh.length ? `<button class="alert alert-danger alert-link sos-incoming" data-act="vol-select" data-id="${esc(fresh[0].id)}">🚨 New SOS nearby (${esc(fresh[0].distanceBand)}) — tap to respond</button>` : ''}
    <h1>Volunteer</h1>
    ${sel?.assignment && sel.open ? volunteerDetail(sel) : ''}
    ${native.available() ? '' : pushCard('Get SOS alerts even when the app is closed')}
    ${native.available() && platform === 'android' ? '<button class="alert alert-info alert-link" data-act="native-alert-setup">🔔 Make SOS alerts ring loudly on the lock screen — tap to check settings</button>' : ''}
    <section class="card">
      <div class="row space"><h2>Readiness</h2><span class="badge ${el.eligible ? 'badge-ok' : 'badge-warn'}">${el.eligible ? 'Ready to receive alerts' : 'Not receiving alerts'}</span></div>
      <ul class="checklist">
        ${check(prof.verificationStatus === 'VERIFIED' && !reasons.includes('verification expired'), `Identity verified (${pretty(prof.verificationStatus)})`)}
        ${check(!reasons.includes('training incomplete'), `Training ${prof.trainingCompleted.length}/${prof.trainingModules.length}`)}
        ${check(prof.available, 'Available')}
        ${check(!reasons.includes('location stale'), 'Location shared recently')}
        ${check(!reasons.includes('busy on another incident'), 'Not on another incident')}
        ${reasons.includes('suspended') ? '<li class="no">⛔ Account suspended — contact the trust team</li>' : ''}
      </ul>
      <div class="row">
        <button class="btn ${prof.available ? 'btn-ghost' : 'btn-primary'}" data-act="vol-avail" data-on="${prof.available ? '0' : '1'}">${prof.available ? 'Go off duty' : 'Go on duty'}</button>
        <button class="btn btn-secondary" data-act="vol-locate">📍 Update my location</button>
      </div>
    </section>
    ${prof.verificationStatus !== 'VERIFIED' ? `<section class="card"><h2>Identity verification</h2>
      ${prof.verificationStatus === 'PENDING' ? '<p>Submitted. Waiting for admin review.</p>' : `<p class="muted">The Beti Bachao trust team verifies every volunteer personally (ID shown on a video call or in person, plus a live check). <strong>Never upload ID documents in this app.</strong> Request verification and the team will contact you.</p><button class="btn btn-primary" data-act="vol-verify">Request verification</button>`}
    </section>` : ''}
    ${prof.trainingCompleted.length < prof.trainingModules.length ? `<section class="card"><h2>Training</h2><ul class="training">${prof.trainingModules.map((m) => `<li>${prof.trainingCompleted.includes(m.id) ? '✅' : `<button class="btn btn-ghost btn-sm" data-act="vol-train" data-id="${esc(m.id)}">Start</button>`} ${esc(m.title)}</li>`).join('')}</ul></section>` : ''}
    <section class="card"><h2>Alerts</h2>
      ${alerts.length ? `<ul class="alert-list">${alerts.map((a) => `<li><button class="alert-item status-${esc(a.color)} ${sel?.id === a.id ? 'sel' : ''}" data-act="vol-select" data-id="${esc(a.id)}"><span class="dot"></span><span>${a.severity === 'HIGH' ? '🔥 ' : ''}${esc(a.open ? pretty(a.status) : 'Ended')} · ${esc(a.distanceBand)}</span><small>${esc(fmtTime(a.createdAt))}${a.assignment ? ' · <b>assigned</b>' : ''}</small></button></li>`).join('')}</ul>` : '<p class="muted">No alerts. Stay on duty with a fresh location to receive them.</p>'}
    </section>
    ${sel && !(sel.assignment && sel.open) ? volunteerDetail(sel) : ''}
    <details class="card" data-keep="conduct"><summary>Volunteer Code of Conduct</summary><ol>${CONDUCT.map((c) => `<li>${esc(c)}</li>`).join('')}</ol></details>
  `);
}

function volunteerDetail(a) {
  const asg = a.assignment;
  const next = { ACCEPTED: ['EN_ROUTE', "I'm on my way"], EN_ROUTE: ['ARRIVED', "I've arrived"], ARRIVED: ['ASSISTING', 'Assisting now'] }[asg?.status];
  const steps = [['ACCEPTED', 'Accepted'], ['EN_ROUTE', 'On my way'], ['ARRIVED', 'Arrived'], ['ASSISTING', 'Assisting']];
  const at = steps.findIndex((x) => x[0] === asg?.status);
  if (asg) notifyChange('vol:' + a.id, `${a.status}|${a.open}|` + (a.team || []).map((x) => x.label + x.status).join(','), !a.open ? 'She has confirmed she is safe — you can stand down. Thank you.' : `SOS update: ${pretty(a.status)}`, a.open ? 'warn' : 'ok');
  const stepper = asg && a.open ? `<section class="vol-steps" aria-label="Your status">
      <p class="lu-label">Your status — update it as you go</p>
      <ol class="stepper">${steps.map((x, i) => `<li class="${i < at ? 'done' : i === at ? 'now' : ''}">${i < at ? '✓ ' : ''}${esc(x[1])}</li>`).join('')}</ol>
      ${next ? `<button class="btn btn-primary btn-lg btn-block" data-act="vol-status" data-aid="${esc(asg.id)}" data-status="${next[0]}">👉 Tap now: ${esc(next[1])}</button>` : '<p><strong>You are assisting.</strong> Stay with her until she confirms she is safe in her app.</p>'}
    </section>` : '';
  return `<section class="card vol-detail status-border-${esc(a.color)}">
    <h2>${a.severity === 'HIGH' ? '🔥 Immediate danger · ' : ''}${esc(a.open ? pretty(a.status) : 'Incident ended — she is safe')}</h2>
    ${stepper}
    <p>Distance: <strong>${esc(a.distanceBand)}</strong>${a.approxEtaMin ? ` · ≈${esc(a.approxEtaMin)} min (${esc(a.etaLabel || 'estimate')}${a.roadKm ? `, ${esc(a.roadKm)} km by road` : ''})` : ''}</p>
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
      <div class="row">
        <button class="btn btn-warn" data-act="vol-escalate" data-id="${esc(a.id)}">Request emergency escalation</button>
        <button class="btn btn-ghost" data-act="vol-unable" data-aid="${esc(asg.id)}">Unable to help</button></div>
    ` : a.open && !a.alertResponse ? `
      <p class="muted">${esc(a.precisionNote || '')}</p>
      ${a.approxArea ? `<p>Approximate area (±${esc(a.approxArea.uncertaintyKm)} km) — exact position after acceptance.</p>` : ''}
      <div class="row"><button class="btn btn-primary btn-lg" data-act="vol-accept" data-id="${esc(a.id)}">Accept & respond</button><button class="btn btn-ghost" data-act="vol-decline" data-id="${esc(a.id)}">Decline</button></div>
      ${infoTip('More info', `By accepting you agree to the Code of Conduct. Accepting does not end the search — backup is kept looking.`)}
    ` : `<p class="muted">${a.alertResponse ? `You responded: ${esc(pretty(a.alertResponse))}.` : ''}</p>`}
    <button class="btn btn-ghost btn-sm" data-act="report-abuse" data-id="${esc(a.id)}">Report a concern</button>
  </section>`;
}

// ------------------------------------------------------------------ operations
async function viewOps() {
  let list = [];
  const all = store.get('ops.all', false);
  try { list = (await st.api.opIncidents(all)).items; } catch (e) { return failView(e); }
  const selId = st.opSel && list.some((i) => i.id === st.opSel) ? st.opSel : list[0]?.id;
  let d = null, tl = [], cfg = null;
  if (selId) { try { d = await st.api.getIncident(selId); if (d.search?.deadline && d.search.secondsLeft != null) st.skew = (Date.parse(d.search.deadline) - d.search.secondsLeft * 1000) - Date.now(); tl = (await st.api.timeline(selId)).items; if (!st.cfgCache || Date.now() - st.cfgCache.at > 300000) st.cfgCache = { at: Date.now(), cfg: (await st.api.adminConfig()).config }; cfg = st.cfgCache.cfg; } catch {} }
  return shell(`
    <div class="row space"><h1>Operations console</h1><label class="switch"><input type="checkbox" data-change="ops-all" ${all ? 'checked' : ''}> Show closed</label></div>
    <div class="ops-layout">
      <section class="card ops-list"><h2>Incidents (${list.length})</h2>
        <ul>${list.map((i) => `<li><button class="alert-item status-${esc(i.color)} ${i.id === selId ? 'sel' : ''}" data-act="op-select" data-id="${esc(i.id)}"><span class="dot"></span>
          <span>${i.duress ? '🚩 DURESS · ' : ''}${!i.opAckAt && !i.police && !['CLOSED', 'USER_CANCELLED'].includes(i.status) ? '✋ Needs acknowledgement · ' : ''}${i.police ? '🚓 ' : ''}${i.severity === 'HIGH' ? '🔥 ' : ''}${esc(pretty(i.status))}</span>
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
    ...live.map((a) => ({ id: a.volunteerName.split(' ')[0].toUpperCase(), kind: 'responder', position: a.position, track: a.track, distText: distText(a.distanceKm), etaText: etaText(a.status, a.approxEtaMin), moving: a.status === 'EN_ROUTE' && a.closing !== 'OPENING', title: `${a.volunteerName} ${a.status}` })),
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
        <p class="ppi-explain">Zoomed in on only the volunteers who accepted, with their travelled path (green). The table gives each one's range (distance), bearing (direction from her), speed, ETA and whether they are closing in. Use it to spot a responder who has stopped or is moving away.</p>${ppiTable(rows)}${etaBasisNote(live)}</div>`
      : `<div class="ppi-wrap"><h3 class="ppi-title">② APPROACH radar</h3><p class="ppi-explain">Appears when a volunteer accepts. It zooms in on accepted volunteers and tracks them closing in on her.</p></div>`}
    </div>` : '';
  return `<section class="card ops-detail">
    <div class="row space"><h2>${esc(d.requester?.displayName)} · <span class="status-text-${esc(d.color)}">${esc(pretty(d.status))}</span></h2><span class="badge">${esc(d.severity)}</span></div>
    ${P.opsAck(d)}
    ${d.duress ? '<div class="alert alert-danger"><strong>🚩 DURESS PIN USED.</strong> The user\'s app shows "cancelled". Treat as active danger. Do not contact her in a way that could reveal this.</div>' : ''}
    <p>Trigger: ${esc(pretty(String(d.trigger || "").toUpperCase()))}${d.silent ? ' (silent)' : ''} · Escalation: <strong>${esc(pretty(d.escalationStatus))}</strong> · Alerted: ${esc(d.alertedCount)} · Battery: ${d.battery ? Math.round(d.battery.level * 100) + '%' : 'unknown'}</p>
    ${d.location ? `${scope}
      <h3>📍 Her live location</h3>${googleMap(d.location, 'Her live location', 'ops')}
      <p>📍 ${esc(d.location.lat.toFixed(5))}, ${esc(d.location.lng.toFixed(5))} · ±${esc(d.location.accuracyM)} m · ${esc(d.location.source)} · <span data-live="age" data-fmt="short" data-at="${esc(d.location.observedAt)}"></span> old ${d.location.stale ? '<span class="badge badge-warn">STALE</span>' : ''} · ${esc(d.location.vertical)}</p>
      ${d.locationHistory.some((l) => l.suspect) ? `<p class="badge badge-warn">Suspect location jumps ignored: ${d.locationHistory.filter((l) => l.suspect).map((l) => esc(l.suspectReason)).join('; ')}</p>` : ''}` : '<div class="alert alert-warn">No usable location. Contact the user through official channels if possible.</div>'}
    ${d.search?.secondsLeft != null ? `<p>Search stage ${d.search.stage + 1}/3 (${esc(d.search.radiusKm)} km) · next expansion in <span data-live="stage-countdown-raw" data-deadline="${esc(d.search.deadline)}"></span></p>` : ''}
    <h3>Responders</h3>
    <table class="tbl"><thead><tr><th>Volunteer</th><th>Role</th><th>Status</th><th>Dist.</th><th></th></tr></thead><tbody>
      ${d.assignments.map((a) => `<tr><td>${esc(a.volunteerName)}</td><td>${esc(a.role)}</td><td>${esc(pretty(a.status))}${a.stallFlagged ? ' ⚠️ stalled' : ''}</td><td>${a.distanceKm != null ? esc(a.distanceKm) + ' km' : '—'}</td><td>${['ACCEPTED', 'EN_ROUTE', 'ARRIVED', 'ASSISTING'].includes(a.status) && !d.closed ? `<button class="btn btn-ghost btn-sm" data-act="op-reassign" data-id="${esc(d.id)}" data-aid="${esc(a.id)}">Remove</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">None yet</td></tr>'}
    </tbody></table>
    <div class="ai-box">
      <p><strong>Prank-risk (advisory):</strong> <span class="badge ${d.prankRisk?.level === 'HIGH' ? 'badge-danger' : d.prankRisk?.level === 'MEDIUM' ? 'badge-warn' : 'badge-ok'}">${esc(d.prankRisk?.level || 'LOW')}</span> ${esc((d.prankRisk?.reasons || []).join('; '))} <small class="muted">${esc(d.prankRisk?.note || '')}</small>
      ${d.ai?.risk ? `<br><strong>AI note check:</strong> ${esc(d.ai.risk.risk)} — ${esc(d.ai.risk.reason)}` : ''}</p>
      ${st.cfg?.features?.ai ? `<button class="btn btn-sm btn-secondary" data-act="ai-summary" data-id="${esc(d.id)}">🤖 AI summary & next steps</button>` : ''}
      ${d.ai?.summary ? `<pre class="ai-text">${esc(d.ai.summary.text)}</pre><small class="muted">AI (${esc(d.ai.summary.model)}) — advisory, verify before acting.</small>` : ''}
    </div>
    ${d.requester?.phone ? `<p>📞 Her number: <a href="tel:${esc(d.requester.phone)}">${esc(d.requester.phone)}</a>${d.duress ? ' <strong class="danger-text">— DURESS: do not call openly</strong>' : ''}</p>` : ''}
    <h3>Escalations</h3>
    <ul>${d.escalations.map((e) => `<li><strong>${esc(pretty(e.type))}</strong> · ${esc(pretty(e.status))} · ${esc(e.label)} · ${esc(fmtTime(e.attemptedAt))}${e.reason ? ` — ${esc(e.reason)}` : ''}</li>`).join('') || '<li class="muted">None</li>'}</ul>
    <h3>Notifications</h3>
    <p class="small">${d.notifications.length} sent · ${d.notifications.filter((n) => n.status === 'FAILED').length} failed · ${d.notifications.filter((n) => n.attemptCount > 1).length} used fallback</p>
    ${!d.closed ? `
    <div class="ops-actions">
      <form class="card form" data-form="handoff" data-id="${esc(d.id)}"><h3>Record emergency-service handoff</h3><p class="muted small">Record what you did (e.g. phoned the control room). Automatic police contact is shown above.</p>
        <label>Status<select name="status"><option value="ATTEMPTED">Attempted</option><option value="DELIVERED">Delivered</option><option value="ACKNOWLEDGED">Acknowledged</option><option value="FAILED">Failed</option></select></label>
        <label>Details / reference<input name="reason" required minlength="5" maxlength="300"></label><button class="btn btn-warn">Record handoff</button></form>
      <form class="card form" data-form="closure" data-id="${esc(d.id)}"><h3>Closure exception</h3><p class="muted small">Only when the user cannot confirm safety. Fully audited.</p>
        <label>Reason<select name="reason"><option value="HANDED_TO_EMERGENCY_SERVICES_CONFIRMED_SAFE">Handed to emergency services — confirmed safe</option><option value="USER_UNREACHABLE_EMERGENCY_SERVICES_IN_CHARGE">User unreachable — emergency services in charge</option><option value="DUPLICATE_INCIDENT">Duplicate incident</option><option value="VERIFIED_FALSE_ALARM">Verified false alarm</option></select></label>
        <label>Note (10+ chars)<textarea name="note" required minlength="10" maxlength="500"></textarea></label><button class="btn btn-ghost danger-text">Close with exception</button></form>
      <button class="btn btn-danger" data-act="op-escalate" data-id="${esc(d.id)}">Mark escalation required</button>
    </div>` : `<p>Closed: ${esc(pretty(d.closureReason))}</p>`}
    <details data-keep="ops-timeline"><summary>Timeline (${tl.length})</summary><ol class="timeline">${tl.map((x) => `<li><time>${esc(fmtTime(x.at))}</time> ${esc(tlText(x))}${x.reason ? ` <small class="muted">— ${esc(x.reason)}</small>` : ''}</li>`).join('')}</ol></details>
  </section>`;
}

// ------------------------------------------------------------------ admin
async function viewAdmin() {
  const tab = st.adminTab;
  const tabs = [['impact', 'Impact'], ['policy', 'Policy'], ['stations', 'Police stations'], ['volunteers', 'Volunteers'], ['users', 'Users'], ['staff', 'Operators'], ['abuse', 'Abuse reports'], ['audit', 'Audit log'], ['integrations', 'Integrations']];
  let body = '';
  try {
    if (tab === 'impact') body = await P.adminImpactTab();
    else if (tab === 'stations') body = await P.adminStationsTab();
    else if (tab === 'policy') {
      const { config } = await st.api.adminConfig();
      const f = (k, label, v = config[k]) => `<label>${esc(label)}<input name="${k}" value="${esc(Array.isArray(v) ? v.join(',') : v)}" required></label>`;
      body = `<form class="card form grid-2" data-form="config"><h2 class="full">Dispatch policy</h2>
        ${f('radiusStagesKm', 'Search radii km (3, increasing)')}${f('stageTimeoutsSec', 'Stage timeouts sec')}${f('highSeverityStageTimeoutsSec', 'High-severity timeouts sec')}
        ${f('targetResponders', 'Target responders (backup search until reached)')}${f('maxResponders', 'Max responders')}${f('acceptToEnRouteStallSec', 'Accepted→en-route stall sec')}
        ${f('enRouteStallMinSec', 'Min en-route stall sec')}${f('locationStaleSec', 'Location stale after sec')}${f('lowAccuracyM', 'Low accuracy threshold m')}
        ${f('volunteerLocationMaxAgeMin', 'Volunteer location max age min')}${f('sosPerHourLimit', 'SOS per user per hour')}
        <h3 class="full">Automatic protection</h3>
        ${f('operatorAckSec', 'Operator must acknowledge within (sec) — then all operators re-alerted')}${f('policeAutoConnectSec', 'Her phone calls the police automatically after (sec)')}${f('policeMaxKm', 'Call a loaded police station only within (km) — else 1091 / 112')}
        <label>Police auto-connect when no volunteer accepts<select name="autoPoliceOnNoResponder"><option value="true" ${config.autoPoliceOnNoResponder ? 'selected' : ''}>Yes</option><option value="false" ${config.autoPoliceOnNoResponder ? '' : 'selected'}>No</option></select></label>
        ${f('tripGraceMin', 'Travel: minutes late before "Are you OK?"')}${f('tripCheckSec', 'Travel: seconds to answer before automatic SOS')}${f('evidenceRetentionDays', 'Delete SOS recordings after (days)')}
        <label>Default country<select name="countryCode">${Object.entries(st.cfg.countries).map(([k, v]) => `<option value="${k}" ${k === config.countryCode ? 'selected' : ''}>${esc(v.name)}</option>`).join('')}</select></label>
        <div class="full"><button class="btn btn-primary">Save policy</button></div></form>`;
    } else if (tab === 'volunteers') {
      const { items } = await st.api.adminVolunteers();
      const order = { PENDING: 0, NOT_STARTED: 1, VERIFIED: 2, REJECTED: 3 };
      items.sort((a, b) => (b.stats?.reviewNeeded - a.stats?.reviewNeeded) || (order[a.verificationStatus] - order[b.verificationStatus]));
      body = `<section class="card"><h2>Volunteers</h2>${infoTip('More info', `Verification: book a video call → on the call the volunteer shows the Aadhaar front and back next to their face → approve with the checklist. Never photograph, record or store the Aadhaar.`)}
        <table class="tbl"><thead><tr><th>Name</th><th>Phone · area</th><th>Status</th><th>Call</th><th>Training</th><th>Rating</th><th>Duty</th><th>Actions</th></tr></thead><tbody>
        ${items.map((v) => `<tr class="${v.stats?.reviewNeeded ? 'row-flag' : ''}"><td>${esc(v.displayName)}${v.stats?.reviewNeeded ? ' <span class="badge badge-danger">review</span>' : ''}<br><small>${esc(v.email || '')}</small></td>
          <td>${esc(v.request?.contactPhone || '—')}<br><small>${esc(v.request?.area || '')}</small></td>
          <td>${esc(pretty(v.verificationStatus))}${v.request?.aadhaarMasked ? `<br><small>${esc(v.request.aadhaarMasked)}</small>` : ''}${v.suspendedReason ? '<br><small class="danger-text">suspended</small>' : ''}</td>
          <td>${v.request?.call ? `<small>${esc(new Date(v.request.call.scheduledAt).toLocaleString())}</small><br><a href="${esc(v.request.call.roomUrl)}" target="_blank" rel="noopener">Join</a>` : '—'}</td>
          <td>${v.trainingDone}/${v.trainingTotal}</td>
          <td>${v.stats?.avgRating != null ? `${esc(v.stats.avgRating)}★ (${v.stats.ratings})` : '—'}${v.stats?.feltUnsafe ? `<br><small class="danger-text">${v.stats.feltUnsafe} felt unsafe</small>` : ''}${v.stats?.noShows ? `<br><small>${v.stats.noShows} no-show</small>` : ''}</td>
          <td>${v.available ? 'On' : 'Off'}</td>
          <td class="actions">${v.verificationStatus === 'PENDING' ? `<button class="btn btn-sm btn-secondary" data-act="adm-call" data-id="${esc(v.userId)}">📹 ${v.request?.call ? 'Re-book' : 'Book'} call</button><button class="btn btn-sm btn-primary" data-act="adm-approve" data-id="${esc(v.userId)}" data-name="${esc(v.displayName)}">Approve</button><button class="btn btn-sm btn-ghost" data-act="adm-review" data-id="${esc(v.userId)}" data-d="REJECT">Reject</button>` : ''}
          ${v.suspendedReason ? `<button class="btn btn-sm btn-ghost" data-act="adm-review" data-id="${esc(v.userId)}" data-d="REINSTATE">Reinstate</button>` : v.verificationStatus === 'VERIFIED' ? `<button class="btn btn-sm btn-ghost danger-text" data-act="adm-review" data-id="${esc(v.userId)}" data-d="SUSPEND">Suspend</button>` : ''}</td></tr>`).join('')}
        </tbody></table></section>`;
    } else if (tab === 'users') {
      const f = st.userFilter || {};
      const res = st.userResults;
      body = `<section class="card form"><h2>Find users</h2>
        <form data-form="find-users">
          <div class="grid2">
            <label>Name (first 3 letters), email or phone<input name="q" value="${esc(f.q || '')}" placeholder="e.g. pri, 98765, @gmail" autocomplete="off"></label>
            <label>Status<select name="status">${[['', 'Any status'], ['ACTIVE', 'Active'], ['SUSPENDED', 'Suspended'], ['PENDING', 'Volunteer awaiting approval']].map(([v, l]) => `<option value="${v}" ${f.status === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label>Role<select name="role">${[['', 'Any role'], ['user', 'Women'], ['volunteer', 'Volunteers'], ['operator', 'Operators'], ['admin', 'Admins']].map(([v, l]) => `<option value="${v}" ${f.role === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label>Near (Google Maps link or "lat, lng")<input name="where" value="${esc(f.where || '')}" placeholder="optional — 15.8306, 78.0451"></label>
            <label>Within<select name="km">${[2, 5, 10, 25, 50, 100].map((k) => `<option value="${k}" ${Number(f.km || 10) === k ? 'selected' : ''}>${k} km</option>`).join('')}</select></label>
          </div>
          <div class="row"><button class="btn btn-primary">Search</button><button type="button" class="btn btn-ghost btn-sm" data-act="users-near-me">📍 Near me</button><button type="button" class="btn btn-ghost btn-sm" data-act="users-clear">Clear</button></div>
          ${infoTip('How search works', 'Type at least 3 letters of a name (matches the start of any name), part of an email, or 3+ digits of a phone number. Or leave it empty and filter by status, role or location. Location matches saved places, the last SOS and volunteers\' duty position.')}
        </form></section>
        <section class="card"><h2>${res ? `${res.length}${res.length === 100 ? '+' : ''} user${res.length === 1 ? '' : 's'}` : 'Results'}</h2>
        <div class="tbl-wrap"><table class="tbl small"><thead><tr><th>Name</th><th>Phone</th><th>Role · status</th><th>Location</th><th></th></tr></thead><tbody>${(res || []).map((u) => `<tr>
          <td><b>${esc(u.displayName)}</b><br><small class="muted">${esc(u.email)}</small></td>
          <td>${esc(u.phone || '—')}</td>
          <td>${esc(u.role)}${u.volunteer ? ` <small>(${u.volunteer.approved ? 'approved' : esc(pretty(u.volunteer.verification || 'pending'))}${u.volunteer.onDuty ? ', on duty' : ''})</small>` : ''}<br><span class="badge ${u.status === 'ACTIVE' ? 'badge-ok' : 'badge-danger'}">${esc(u.status)}</span></td>
          <td>${u.where ? `${esc(u.where.label)} · ${esc(u.where.distanceKm)} km` : esc((u.places || []).join(', ') || '—')}</td>
          <td><button class="btn btn-sm btn-ghost" data-act="adm-reset" data-id="${esc(u.id)}" data-name="${esc(u.displayName)}">Reset password</button></td></tr>`).join('') || `<tr><td colspan="5" class="muted">${res ? 'No users match.' : 'Search to see users.'}</td></tr>`}</tbody></table></div></section>`;
    } else if (tab === 'staff') {
      const { items } = await st.api.staffList();
      body = `<section class="card"><h2>Operators & admins</h2>${infoTip('More info', `Operators watch live SOS incidents and record handoffs to police/ambulance. Every staff account must set up an authenticator app at first login.`)}
        <table class="tbl"><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>2-step</th><th>Status</th><th></th></tr></thead><tbody>${items.map((u) => `<tr><td>${esc(u.displayName)}</td><td>${esc(u.email)}</td><td>${esc(u.role)}</td><td>${u.mfaEnrolled ? '✅' : 'pending'}</td><td>${esc(u.status)}</td><td>${u.id !== st.me.id ? `<button class="btn btn-sm btn-ghost danger-text" data-act="adm-staff-toggle" data-id="${esc(u.id)}" data-s="${u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'}">${u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}</button>` : ''}</td></tr>`).join('')}</tbody></table></section>
        <form class="card form" data-form="add-staff"><h2>Add operator</h2>
          <label>Name<input name="displayName" required maxlength="60"></label><label>Email<input name="email" type="email" required></label>
          <label>Temporary password (12+ characters — share it privately)<input name="password" type="text" minlength="12" required autocomplete="off"></label>
          <label>Role<select name="role"><option value="operator">Operator</option><option value="admin">Admin</option></select></label>
          <button class="btn btn-primary">Create account</button></form>`;
    } else if (tab === 'abuse') {
      const { items } = await st.api.abuseList();
      body = `<section class="card"><h2>Abuse & safety reports</h2><ul class="history">${items.map((r) => `<li><strong>${esc(pretty(r.category))}</strong> by ${esc(r.reporter)} · ${esc(fmtTime(r.createdAt))} · ${esc(r.status)}${r.aiRisk ? ` <span class="badge ${r.aiRisk.risk === 'HIGH' ? 'badge-danger' : r.aiRisk.risk === 'MEDIUM' ? 'badge-warn' : 'badge-info'}" title="${esc(r.aiRisk.reason)}">AI: ${esc(r.aiRisk.risk)} · ${esc(r.aiRisk.category)}</span>` : ''}<br><span class="tr-src">${esc(r.details)}</span>${st.cfg?.features?.ai && r.details ? ` <button class="btn btn-sm btn-ghost" data-act="ai-translate" data-text="${esc(r.details)}">Translate</button>` : ''}${r.status === 'OPEN' ? ` <button class="btn btn-sm btn-ghost" data-act="adm-resolve" data-id="${esc(r.id)}">Resolve</button>` : ` <small>— ${esc(r.resolution || '')}</small>`}</li>`).join('') || '<li class="muted">No reports.</li>'}</ul></section>`;
    } else if (tab === 'audit') {
      const a = await st.api.audit(150);
      body = `<section class="card"><h2>Audit log</h2><p>Hash chain: ${a.chain.ok ? `<span class="badge badge-ok">intact (${a.chain.length} events)</span>` : '<span class="badge badge-danger">BROKEN — investigate</span>'}</p>
        <table class="tbl small"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Entity</th><th>Reason</th></tr></thead><tbody>${a.items.map((x) => `<tr><td>${esc(fmtTime(x.timestamp))}</td><td>${esc(x.actorId.slice(0, 8))}</td><td>${esc(x.action)}</td><td>${esc(x.entityType)}:${esc(String(x.entityId).slice(0, 8))}</td><td>${esc(x.reason || '')}</td></tr>`).join('')}</tbody></table></section>`;
    } else {
      const { items } = await st.api.integrations();
      let errs = []; try { errs = (await st.api.clientErrors()).items; } catch {}
      const errCard = `<section class="card"><h2>App errors ${errs.length ? `<span class="badge badge-danger">${errs.length}</span>` : '<span class="badge badge-ok">none</span>'}</h2>${infoTip('More info', 'Crashes and unexpected errors from phones and browsers, newest first, with the screen they happened on. Send these to the developer to fix.')}
        ${errs.slice(0, 30).map((x) => `<details class="err-item"><summary><b>${esc(x.kind)}</b> · ${esc(fmtTime(x.at))} · ${esc(x.message.slice(0, 90))}</summary><p class="small muted">${esc(x.app)} · ${esc(x.role || 'not signed in')} · ${esc(x.where)}</p><pre class="err-stack">${esc(x.stack)}</pre></details>`).join('')}</section>`;
      body = errCard + `<section class="card"><h2>Backup</h2>${infoTip('More info', `Download a full copy of the data (contains personal and location data — store it encrypted, delete old copies). Do this daily during the pilot.`)}<a class="btn btn-secondary" href="api/v1/admin/backup" download>⬇ Download backup</a></section><section class="card"><h2>Integration health</h2><ul class="history">${items.map((i) => `<li><strong>${esc(i.name)}</strong> <span class="badge ${i.status === 'SIMULATED' || i.status === 'MOCK' ? 'badge-warn' : 'badge-info'}">${esc(i.status)}</span><br><small>${esc(i.note)}</small></li>`).join('')}</ul></section>`;
    }
  } catch (e) { body = `<div class="alert alert-danger">${esc(e.message)}</div>`; }
  return shell(`<h1>Admin & trust</h1><div class="tabs" role="tablist">${tabs.map(([k, l]) => `<button role="tab" aria-selected="${k === tab}" class="tab ${k === tab ? 'active' : ''}" data-act="adm-tab" data-tab="${k}">${esc(l)}</button>`).join('')}</div>${body}`);
}

// ------------------------------------------------------------------ offline
// The server can be unreachable (no signal, server restarting). The woman must still
// have SOS (texts her contacts from the phone and is sent when back online) and the
// emergency numbers — never an empty page. Retries calmly with back-off; no flicker.
let offlineRetry = null, offlineDelay = 5000;
function failView(e) {
  if (e?.code !== 'NETWORK' && e?.status !== 502 && e?.status !== 503 && e?.status !== 504) return shell(`<div class="alert alert-danger">${esc(e?.message || 'Something went wrong')}</div>`);
  st.offline = true;
  clearTimeout(offlineRetry);
  offlineRetry = setTimeout(() => { offlineDelay = Math.min(30000, offlineDelay * 1.6); st.softRefresh = true; render(); }, offlineDelay);
  const user = st.me?.role === 'user';
  return shell(`
    <div class="alert alert-warn offline-card" role="status">
      <strong>📶 Can't reach the Beti Bachao server.</strong>
      <p>Check your internet. Retrying automatically…</p>
      ${user ? '<p>SOS still works: it texts your contacts from this phone and alerts volunteers as soon as the connection is back.</p>' : '<p>New SOS alerts will appear when the connection is back. In an emergency call the numbers below.</p>'}
      <button class="btn btn-secondary btn-sm" data-act="retry-now">↻ Try again now</button>
    </div>
    ${user ? `<section class="sos-wrap"><button class="sos-btn" id="sos-btn" aria-describedby="sos-hint" data-hold="sos"><svg viewBox="0 0 120 120" class="sos-ring" aria-hidden="true"><circle cx="60" cy="60" r="54" class="sos-track"/><circle cx="60" cy="60" r="54" class="sos-progress" id="sos-progress"/></svg><span class="sos-label">${esc(t('sos'))}</span></button><p id="sos-hint" class="sos-hint">${esc(t('hold_to_send'))}</p></section>` : ''}
    ${emergencyBar()}`);
}
function backOnline() { if (st.offline) { st.offline = false; offlineDelay = 5000; clearTimeout(offlineRetry); } }

// ------------------------------------------------------------------ router
// Never leave a blank screen: if anything throws while drawing, show a recovery card
// (with SOS still usable for her and emergency numbers for everyone).
// Renders never overlap: a refresh that arrives while one is drawing is folded into one
// more pass afterwards. Each pass keeps its own "soft" flag — two overlapping background
// refreshes used to clear each other's flag and redraw the whole screen (the flicker).
let renderBusy = null, renderAgain = null;
function render() {
  const soft = !!st.softRefresh; st.softRefresh = false;
  if (renderBusy) { renderAgain = { soft: (renderAgain ? renderAgain.soft : true) && soft }; return renderBusy; }
  renderBusy = (async () => {
    let next = { soft };
    while (next) { renderAgain = null; await renderSafe(next.soft); next = renderAgain; }
  })().finally(() => { renderBusy = null; });
  return renderBusy;
}
async function renderSafe(soft) {
  try { st.softRefresh = soft; await renderScreen(); }
  catch (e) {
    console.error('[render]', e); reportError('render', e?.message, e?.stack);
    try { app().innerHTML = failView(e?.code ? e : { message: 'Something went wrong on this screen. Pull down or tap Home to try again. In danger, call 112.' }); bindHold(); } catch { app().innerHTML = '<main id="main"><p style="padding:24px">Something went wrong. <a href="#/">Reload</a> · In danger call 112.</p></main>'; }
  }
}
async function renderScreen() {
  const soft = !!st.softRefresh; // read once, synchronously: later refreshes can't change this pass
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(qs || '');
  const parts = path.split('/').filter(Boolean);
  const guard = (roles) => { if (!st.me) { go('#/login'); return false; } if (roles && !roles.includes(st.me.role)) { go(roleHome(st.me.role)); return false; } return true; };
  let html;
  clearInterval(st.pollTimer);
  if (parts[0] !== 'incident' || st.incident?.id !== parts[1]) st.incident = null;
  if (isNative && !serverUrl() && parts[0] !== 'connect') { location.hash = '#/connect'; return; }
  if (st.me?.mustChangePassword && parts[0] !== 'change-password') { location.hash = '#/change-password'; return; }
  try {
  switch (parts[0]) {
    case 'connect': html = viewConnect(); break;
    case 'change-password': if (!st.me) return go('#/login'); html = viewChangePassword(); break;
    case 'permissions': if (!st.me) return go('#/login'); html = viewPermissions(); break;
    case undefined: html = st.me ? null : viewLanding(); if (!html) return go(roleHome(st.me.role)); break;
    case 'login': if (st.me) return go(roleHome(st.me.role)); html = await viewLogin(params); break;
    case 'register': html = viewRegister(params); break;
    case 'setup': html = viewSetup(params); break;
    case 'home': if (!guard(['user'])) return; html = await viewHome(); break;
    case 'incident': if (!guard(['user'])) return; html = await viewIncident(parts[1], params); if (!html) return; if (!st.incident?.closed) st.pollTimer = setInterval(refreshSoft, 5000); break;
    case 'tools': if (!guard(['user'])) return; html = await viewTools(); break;
    case 'places': case 'trip': case 'help': case 'dashboard': case 'blink': if (!guard(['user'])) return; html = await P.views[parts[0]](); if (parts[0] === 'trip') st.pollTimer = setInterval(refreshSoft, 15000); break;
    case 'settings': if (!guard()) return; html = await viewSettings(); break;
    case 'volunteer': if (!guard(['volunteer'])) return; html = await viewVolunteer(); st.pollTimer = setInterval(refreshSoft, 6000); break;
    case 'ops': if (!guard(['operator', 'admin'])) return; html = await viewOps(); st.pollTimer = setInterval(refreshSoft, 6000); break;
    case 'admin': if (!guard(['admin'])) return; html = await viewAdmin(); break;
    default: html = shell('<p>Page not found.</p>');
  }
  } catch (e) { html = failView(e); }
  if (html && !html.includes('offline-card')) backOnline();
  // Background refresh: only touch the screen when something actually changed.
  if (soft && html === st.lastHtml) { updateLive(); return; }
  st.lastHtml = html;
  const y = window.scrollY;
  const focusedForm = document.activeElement?.closest?.('form') && document.activeElement.name;
  const openKeys = new Set($$('details[data-keep][open]').map((d) => d.dataset.keep));
  if (soft && patchMain(html)) { for (const d of $$('details[data-keep]')) if (openKeys.has(d.dataset.keep)) d.open = true; bindHold(); updateLive(); return; }
  app().innerHTML = html;
  rememberMain();
  for (const d of $$('details[data-keep]')) if (openKeys.has(d.dataset.keep)) d.open = true;
  if (soft) window.scrollTo(0, y);
  if (focusedForm) document.querySelector(`[name="${focusedForm}"]`)?.focus();
  bindHold();
  updateLive();
  P.afterRender(parts[0]);
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
// Live refreshes are coalesced: at most one every 3 s, however many live events arrive
// (each location ping from each phone used to trigger its own reload).
function refreshSoft() {
  const wait = 3000 - (Date.now() - (st.lastSoft || 0));
  if (wait > 0) { if (!st.softPending) st.softPending = setTimeout(() => { st.softPending = null; refreshSoft(); }, wait); return; }
  st.lastSoft = Date.now();
  const a = document.activeElement;
  if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return; // typing or choosing
  if ($('.modal-backdrop')) return;
  // While someone is filling in a form (handoff note, closure reason, police station…), live updates
  // wait until they submit or leave it alone for 30 s, so nothing they typed or picked is lost.
  if (Date.now() < (st.editingUntil || 0)) { clearTimeout(st.editRetry); st.editRetry = setTimeout(refreshSoft, 2000); return; }
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
  for (const el of $$('[data-live="ack-countdown"]')) { const left = Math.max(0, Math.round((Date.parse(el.dataset.deadline) - now) / 1000)); el.textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`; }
  for (const el of $$('[data-live="due"]')) { const left = Math.round((Date.parse(el.dataset.at) - Date.now()) / 60000); el.textContent = left >= 0 ? `${left} min left` : `${-left} min late`; }
  for (const el of $$('[data-live="stage-countdown"],[data-live="stage-countdown-raw"]')) {
    const left = Math.max(0, Math.round((Date.parse(el.dataset.deadline) - now) / 1000));
    el.textContent = el.dataset.live === 'stage-countdown' ? t('next_stage_in', { s: left }) : `${left}s`;
  }
}

// ------------------------------------------------------------------ actions
const actions = {
  'retry-now'() { offlineDelay = 5000; render(); },
  async logout() {
    // Sign out on this device at once; the server session is ended in the background.
    st.me = null; store.set('meCache', null); geo.stop();
    if (native.available()) { native.stopSafety(); native.configure({ token: null }); }
    const done = st.api.logout().catch(() => {});
    go('#/'); await done;
  },
  async forgot() {
    const a = await modal({ title: 'Reset your password', body: `<label>Email<input name="email" type="email" required></label><p class="small muted">${st.cfg?.features?.smsReset ? 'We will send a 6-digit code to your registered mobile number.' : 'Ask the Beti Bachao admin to reset it for you.'}</p>`, actions: st.cfg?.features?.smsReset ? [{ id: 'go', label: 'Send code', kind: 'primary' }, { id: 'no', label: t('cancel') }] : [{ id: 'no', label: 'OK', kind: 'primary' }] });
    if (a.id !== 'go') return;
    try { await st.api.resetRequest(a.data.email); } catch (e) { return showErr(e); }
    const b = await modal({ title: 'Enter the code', body: '<label>6-digit code<input name="code" inputmode="numeric" maxlength="6" required></label><label>New password (10+ characters)<input name="pw" type="password" minlength="10" required autocomplete="new-password"></label>', actions: [{ id: 'go', label: 'Set new password', kind: 'primary' }, { id: 'no', label: t('cancel') }] });
    if (b.id !== 'go') return;
    try { await st.api.resetConfirm({ email: a.data.email, code: b.data.code, newPassword: b.data.pw }); toast('Password changed. Please log in.', 'ok'); } catch (e) { showErr(e); }
  },
  async 'share-location'() {
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
  async 'more-help'() { try { await st.api.safety(incId(), { response: 'NEED_MORE_HELP' }); toast('Escalated — search continues', 'warn'); render(); } catch (e) { showErr(e); } },
  async 'report-danger'() {
    const r = await modal({ title: t('report_danger'), body: '<label>What is happening? (optional)<input name="reason" maxlength="200"></label>', actions: [{ id: 'go', label: t('report_danger'), kind: 'danger' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'go') return;
    try { await st.api.escalate(incId(), { type: 'USER_REPORTED_DANGER', reason: r.data.reason || 'User reported danger' }); toast('Escalated', 'warn'); render(); } catch (e) { showErr(e); }
  },
  async 'cancel-sos'(el) {
    const id = el?.dataset?.id || incId();
    if (!id || st.incident?.closed || (st.incident && st.incident.id !== id)) return toast('There is no active SOS to cancel', 'info');
    const hasPin = st.me.hasPins;
    const r = await modal({ title: t('cancel_sos'), body: hasPin ? `<label>${esc(t('enter_pin'))}<input name="pin" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label>` : '<p>Only cancel if this SOS was a mistake. If you are in danger, keep it open.</p>', actions: [{ id: 'go', label: t('cancel_sos'), kind: 'ghost' }, { id: 'no', label: 'Keep SOS open', kind: 'primary' }] });
    if (r.id !== 'go') return;
    try {
      await st.api.cancel(id, hasPin ? { pin: r.data.pin } : { confirm: true });
      siren.stop(); keepAwake(false); geo.stop();
      if (native.available()) prefs.get().armed ? native.startSafety('armed') : native.stopSafety();
      toast(t('status_grey'), 'info'); go('#/home');
    } catch (e) { showErr(e); }
  },
  async 'safewalk-checkin'() { safeWalk.extend(); toast(t('check_in'), 'ok'); render(); },
  'safewalk-stop'() { safeWalk.stop(); render(); },
  async 'contact-del'(el) { contacts.remove(Number(el.dataset.i)); syncContactsToServer(); render(); },
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
  async 'native-alert-setup'() {
    const fs = await native.canUseFullScreenAlerts();
    const r = await modal({ title: 'Loud SOS alerts', body: `<p>For alerts to ring and show over the lock screen:</p><ol><li>Allow notifications for Beti Bachao.</li><li>Allow <b>full-screen alerts</b>${fs?.allowed ? ' ✅' : ''}.</li><li>Turn off battery optimisation for Beti Bachao so alerts are not delayed.</li></ol>`, actions: [{ id: 'fs', label: 'Full-screen alerts setting', kind: 'primary' }, { id: 'bat', label: 'Battery setting', kind: 'secondary' }, { id: 'no', label: 'Done' }] });
    if (r.id === 'fs') native.openSystemSettings('fullScreenIntent');
    if (r.id === 'bat') native.openSystemSettings('batteryOptimization');
  },
  async 'users-near-me'(el) {
    const f = el.closest('form');
    try { const l = await geo.once(10000); f.where.value = `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}`; f.requestSubmit(); } catch { toast('Could not get your location', 'error'); }
  },
  'users-clear'() { st.userFilter = {}; st.userResults = null; render(); },
  'skip-rating'() { go('#/home'); },
  'perm-skip'() { store.set('permsDone:' + st.me.role, true); go(roleHome(st.me.role)); },
  'perm-setup'() { go('#/permissions'); },
  async 'native-perms'() { const r = await native.requestPermissions('all'); const s2 = await native.permissionStatus(); await modal({ title: 'Phone permissions', body: `<ul>${Object.entries(s2 || r || {}).map(([k, v]) => `<li>${esc(k)}: <b>${esc(v)}</b></li>`).join('')}</ul><p class="small muted">For background protection allow location <b>"All the time"</b>, SMS and notifications.</p>`, actions: [{ id: 'set', label: 'Open app settings', kind: 'secondary' }, { id: 'ok', label: 'OK', kind: 'primary' }] }).then((x) => { if (x.id === 'set') native.openSystemSettings('app'); }); },
  async 'enable-push'() { if (await enablePush()) { toast('Alerts enabled on this phone', 'ok'); render(); } },
  // volunteer
  async 'vol-avail'(el) {
    const on = el.dataset.on === '1';
    const loc = on ? await volLoc() : null;
    if (on && !loc) return toast('Allow location so nearby SOS alerts can reach you', 'error');
    try { await st.api.setAvailability({ available: on, location: loc }); store.set('onDuty', on); if (on) enablePush(true); render(); } catch (e) { showErr(e); }
  },
  async 'vol-locate'() { try { const loc = await volLoc(); if (!loc) return toast('No location available', 'error'); await st.api.setAvailability({ location: loc }); toast('Location updated', 'ok'); render(); } catch (e) { showErr(e); } },
  async 'vol-verify'() {
    const r = await modal({ title: 'Request identity verification', body: `<label>Phone number for the trust team to call you${phoneInput('phone', { value: st.me?.phone || '', country: st.me?.countryCode, required: true, lang: lang() })}</label><label>Your town / area<input name="area" maxlength="60"></label><p class="muted small">Your number is used only for verification. Do not send ID photos anywhere except to the verified team during the call.</p>`, actions: [{ id: 'ok', label: 'Send request', kind: 'primary' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'ok') return;
    const vp = readPhone(r.data, 'phone');
    if (vp.problem) return toast(vp.problem, 'error');
    try { await st.api.submitVerification({ contactPhone: vp.e164, area: r.data.area }); toast('Request sent. The trust team will contact you.', 'ok'); render(); } catch (e) { showErr(e); }
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
  async 'ai-summary'(el) { el.disabled = true; el.textContent = '🤖 Thinking…'; try { await st.api.aiSummary(el.dataset.id); } catch (e) { showErr(e); } st.softRefresh = false; render(); },
  async 'ai-translate'(el) {
    try { const r = await st.api.translate(el.dataset.text, (LANGS.find((l) => l.code === lang())?.name) || 'English'); await modal({ title: 'Machine translation', body: `<p>${esc(r.text)}</p><p class="muted small">Translated by local AI — may contain mistakes.</p>`, actions: [{ id: 'ok', label: 'OK', kind: 'primary' }] }); } catch (e) { showErr(e); }
  },
  'op-select'(el) { st.opSel = el.dataset.id; render(); },
  async 'op-reassign'(el) {
    const r = await modal({ title: 'Remove responder', body: '<label>Reason (5+ chars)<input name="reason" required minlength="5"></label>', actions: [{ id: 'go', label: 'Remove & search again', kind: 'warn' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'go') return;
    try { await st.api.reassign(el.dataset.id, { assignmentId: el.dataset.aid, reason: r.data.reason }); render(); } catch (e) { showErr(e); }
  },
  async 'op-escalate'(el) { try { await st.api.escalate(el.dataset.id, { type: 'OPERATOR', reason: 'Operator marked escalation required' }); render(); } catch (e) { showErr(e); } },
  // admin
  async 'adm-staff-toggle'(el) { try { await st.api.setStaffStatus(el.dataset.id, el.dataset.s); render(); } catch (e) { showErr(e); } },
  'adm-tab'(el) { st.adminTab = el.dataset.tab; render(); },
  async 'adm-call'(el) {
    const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    const r = await modal({ title: 'Book verification video call', body: `<label>Date & time<input type="datetime-local" name="at" value="${local}" required></label><p class="muted small">The volunteer gets a notification and SMS with the time and a private video-call link.</p>`, actions: [{ id: 'go', label: 'Book call', kind: 'primary' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'go' || !r.data.at) return;
    try { await st.api.scheduleCall(el.dataset.id, new Date(r.data.at).toISOString()); toast('Call booked', 'ok'); render(); } catch (e) { showErr(e); }
  },
  async 'adm-approve'(el) {
    const r = await modal({ title: `Approve ${el.dataset.name}`, body: `<p class="small">Confirm what you saw on the video call:</p>
      <label class="switch"><input type="checkbox" name="front"> Aadhaar <b>front</b> shown clearly</label>
      <label class="switch"><input type="checkbox" name="back"> Aadhaar <b>back</b> shown clearly</label>
      <label class="switch"><input type="checkbox" name="face"> Photo and name match the person on the call</label>
      <label>Last 4 digits of Aadhaar (optional — never the full number)<input name="last4" inputmode="numeric" pattern="\\d{4}" maxlength="4"></label>
      <p class="muted small">Do not take screenshots or keep any copy of the Aadhaar card.</p>`, actions: [{ id: 'go', label: 'Approve volunteer', kind: 'primary' }, { id: 'no', label: t('cancel') }] });
    if (r.id !== 'go') return;
    if (!(r.data.front && r.data.back && r.data.face)) return toast('All three checks are required to approve', 'error');
    try { await st.api.reviewVolunteer(el.dataset.id, { decision: 'APPROVE', checklist: { aadhaarFrontSeen: true, aadhaarBackSeen: true, faceMatches: true, last4: r.data.last4 || null } }); toast('Volunteer approved', 'ok'); render(); } catch (e) { showErr(e); }
  },
  async 'adm-reset'(el) {
    const c = await modal({ title: `Reset password for ${el.dataset.name}?`, body: '<p>They will be logged out everywhere and must choose a new password at next login.</p>', actions: [{ id: 'go', label: 'Reset', kind: 'danger' }, { id: 'no', label: t('cancel') }] });
    if (c.id !== 'go') return;
    try { const r = await st.api.resetUserPassword(el.dataset.id); await modal({ title: 'Temporary password', body: `<p class="phrase">${esc(r.temporaryPassword)}</p><p class="small">${esc(r.note)}</p>`, actions: [{ id: 'ok', label: 'Done', kind: 'primary' }] }); } catch (e) { showErr(e); }
  },
  async 'adm-review'(el) {
    let reason = null;
    if (el.dataset.d !== 'APPROVE') { const r = await modal({ title: `${pretty(el.dataset.d)} volunteer`, body: '<label>Reason (5+ chars)<input name="reason" required minlength="5"></label>', actions: [{ id: 'go', label: 'Confirm', kind: 'primary' }, { id: 'no', label: t('cancel') }] }); if (r.id !== 'go') return; reason = r.data.reason; }
    try { await st.api.reviewVolunteer(el.dataset.id, { decision: el.dataset.d, reason }); render(); } catch (e) { showErr(e); }
  },
  async 'adm-resolve'(el) { const r = await modal({ title: 'Resolve report', body: '<label>Resolution<input name="resolution" maxlength="300"></label>', actions: [{ id: 'go', label: 'Resolve', kind: 'primary' }, { id: 'no', label: t('cancel') }] }); if (r.id !== 'go') return; try { await st.api.resolveAbuse(el.dataset.id, { resolution: r.data.resolution }); render(); } catch (e) { showErr(e); } },
};

function mergeProtect() {
  P = initProtect({ st, esc, toast, modal, showErr, go, render, geo, contacts, prefs, store, native, platform, telHref, fmtTime, pretty, nativeShare, serverUrl, isNative, recorder,
    shell, emergencyBar, triggerSOS, startCountdown, syncNative, syncContactsToServer, vibrate, country, openExternal, speechLang });
  Object.assign(actions, P.actions); Object.assign(forms, P.forms); Object.assign(changes, P.changes);
}

async function volLoc() {
  try { return await geo.once(8000); } catch { return null; }
}

// Only one fake call at a time (scheduled or ringing/connected).
function fakeCall(name, delaySec) {
  if (st.fakeCallActive) { toast('A fake call is already scheduled or in progress', 'warn'); return false; }
  st.fakeCallActive = true;
  setTimeout(() => {
    const el = document.createElement('div');
    const end = () => { ringer.stop(); el.remove(); st.fakeCallActive = false; };
    el.className = 'fake-call';
    el.innerHTML = `<div class="fc-top"><div class="fc-avatar" aria-hidden="true">${esc((name || '?')[0])}</div><h2>${esc(name)}</h2><p>mobile · incoming call</p></div><div class="fc-btns"><button class="fc-decline" data-fc="end" aria-label="Decline">✕</button><button class="fc-accept" data-fc="accept" aria-label="Accept">✆</button></div>`;
    document.body.appendChild(el);
    ringer.start();
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-fc]'); if (!b) return;
      ringer.stop();
      if (b.dataset.fc === 'accept') { el.querySelector('.fc-top p').textContent = 'connected 00:00'; b.remove(); let s = 0; const iv = setInterval(() => { s++; const p = el.querySelector('.fc-top p'); if (!p) return clearInterval(iv); p.textContent = `connected ${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }, 1000); }
      else end();
    });
  }, Math.max(0, delaySec) * 1000);
  return true;
}

const forms = {
  async 'perm-setup'(f) {
    const items = permItems(st.me.role);
    const on = (k) => !!f.elements[k]?.checked;
    const aliases = items.filter((x) => x.alias && on(x.k)).map((x) => x.alias);
    if (aliases.length) await native.requestPermissions({ aliases });
    const status = (await native.permissionStatus()) || {};
    const granted = (alias) => String(Object.entries(status).find(([k]) => k.startsWith(alias))?.[1] || '').toLowerCase() === 'granted';
    const patch = {};
    for (const x of items.filter((y) => y.pref)) patch[x.k] = on(x.k) && (!x.needs || (on(x.needs) && granted(x.needs)));
    if (st.me.role === 'user') prefs.set(patch);
    store.set('permsDone:' + st.me.role, true);
    await syncNative();
    if (st.me.role === 'user' && !patch.armed) native.stopSafety();
    const off = items.filter((x) => x.pref && on(x.k) && !patch[x.k]).map((x) => x.t);
    if (off.length) toast(`${off.join(', ')} stay off until the microphone is allowed`, 'warn', 7000);
    if (items.some((x) => x.system && on(x.k))) native.openSystemSettings('batteryOptimization');
    go(roleHome(st.me.role));
  },
  async login(f) {
    try {
      const r = await st.api.login(f.email.value, f.password?.value, f.mfaCode?.value || undefined);
      if (r.mfaEnroll) {
        $('.mfa-enroll').classList.remove('hidden'); $('.mfa').classList.remove('hidden');
        $('.mfa-secret').textContent = r.mfaEnroll.secret.replace(/(.{4})/g, '$1 ').trim();
        $('.mfa-uri').href = r.mfaEnroll.otpauthUri;
        f.mfaCode.focus(); return;
      }
      if (r.mfaRequired) { $('.mfa').classList.remove('hidden'); f.mfaCode.focus(); toast('Enter your authenticator code', 'info'); return; }
      st.me = r.user; st.api.connect(); afterLogin();
    } catch (e) { showErr(e); }
  },
  async register(f) {
    if (!f.consent.checked) return toast('Please read and accept the location-sharing notice', 'warn');
    const ph = readPhone(f, 'phone');
    if (ph.problem) { f.phone.focus(); return toast(ph.problem, 'error'); }
    try { const r = await st.api.register({ displayName: f.displayName.value, email: f.email.value, password: f.password.value, role: f.role.value, countryCode: f.countryCode.value, phone: ph.e164, consent: true }); st.me = r.user; st.api.connect(); afterLogin(); } catch (e) { showErr(e); }
  },
  async pins(f) { try { await st.api.setPins({ cancelPin: f.cancelPin.value, duressPin: f.duressPin.value || null }); st.me = (await st.api.me()).user; toast('PINs saved', 'ok'); render(); } catch (e) { showErr(e); } },
  contact(f) { if (contacts.add(f.name.value, f.phone.value)) { syncContactsToServer(); render(); } else toast('Enter a name and a valid phone (max 10 contacts)', 'error'); },
  safewalk(f) { safeWalk.start(Math.max(1, Math.min(240, Number(f.minutes.value) || 15))); toast(t('safe_walk') + ' ✓', 'ok'); render(); },
  fakecall(f) { prefs.set({ fakeCaller: f.caller.value || 'Maa' }); if (fakeCall(f.caller.value || 'Maa', Number(f.delay.value) || 0)) toast('Fake call scheduled', 'ok'); },
  async floor(f) {
    const n = parseInt(f.floor.value, 10);
    if (!Number.isInteger(n)) return;
    const loc = currentLoc();
    if (!loc) return toast('Location needed first', 'warn');
    try { await st.api.addLocation(incId(), { ...loc, userFloor: n }); toast('Floor added (marked as user-provided)', 'ok'); render(); } catch (e) { showErr(e); }
  },
  async config(f) {
    const nums = (s) => s.split(',').map((x) => parseInt(x.trim(), 10));
    const patch = {};
    for (const k of ['radiusStagesKm', 'stageTimeoutsSec', 'highSeverityStageTimeoutsSec']) patch[k] = nums(f[k].value);
    for (const k of ['targetResponders', 'maxResponders', 'acceptToEnRouteStallSec', 'enRouteStallMinSec', 'locationStaleSec', 'lowAccuracyM', 'volunteerLocationMaxAgeMin', 'sosPerHourLimit', 'operatorAckSec', 'policeAutoConnectSec', 'policeMaxKm', 'tripGraceMin', 'tripCheckSec', 'evidenceRetentionDays']) patch[k] = parseInt(f[k].value, 10);
    patch.autoPoliceOnNoResponder = f.autoPoliceOnNoResponder.value === 'true';
    patch.countryCode = f.countryCode.value;
    try { await st.api.patchConfig(patch); toast('Policy saved & audited', 'ok'); } catch (e) { showErr(e); }
  },
  async 'change-pw'(f) {
    if (f.pw.value !== f.pw2.value) return toast('The two new passwords do not match — type them again', 'error', 5000);
    try {
      await st.api.changePassword({ currentPassword: f.cur ? f.cur.value : '', newPassword: f.pw.value });
      st.me = (await st.api.me()).user;
      toast('✅ Password changed. Use your new password next time you log in.', 'ok', 6000);
      afterLogin();
      go(roleHome(st.me.role));
    } catch (e) { showErr(e); }
  },
  async connect(f) {
    const url = normalizeServerUrl(f.url.value);
    if (!url) return toast(`Type the server address, e.g. ${OFFICIAL_SERVER}`, 'error', 6000);
    f.url.value = url;
    const btn = f.querySelector('button'); if (btn) btn.disabled = true;
    // A free server can take up to a minute to wake: keep trying for ~75 s before giving up.
    const until = Date.now() + 75000; let ok = false, n = 0;
    while (!ok && Date.now() < until) {
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
        const r = await fetch(url + '/api/v1/health', { signal: ctl.signal, cache: 'no-store' }); clearTimeout(t);
        ok = r.ok && (await r.json().catch(() => ({}))).ok === true;
      } catch { /* asleep or unreachable: retry */ }
      if (!ok) { if (n++ === 0) toast('Waking the server… this can take up to a minute', 'info', 8000); await new Promise((r) => setTimeout(r, 4000)); }
    }
    if (btn) btn.disabled = false;
    if (!ok) return toast(`Could not reach ${url}. Check the address and your internet, then try again.`, 'error', 8000);
    setServerUrl(url); location.hash = '#/'; location.reload();
  },
  async setup(f) { try { await st.api.setup({ code: f.code.value.trim(), displayName: f.displayName.value, email: f.email.value, password: f.password.value }); st.cfg.setupNeeded = false; toast('Admin created. Log in to set up two-step login.', 'ok'); go('#/login'); } catch (e) { showErr(e); } },
  async rate(f) { try { await st.api.rate(f.dataset.id, { ref: f.dataset.ref, stars: Number(f.stars.value), feltUnsafe: f.feltUnsafe.checked, comment: f.comment.value }); toast('Thank you for your feedback', 'ok'); render(); } catch (e) { showErr(e); } },
  async 'find-users'(f) {
    const where = f.where.value.trim();
    const ll = where ? P.parseLatLng(where) : null;
    if (where && !ll) return toast('Location: paste a Google Maps link or "lat, lng"', 'error');
    st.userFilter = { q: f.q.value.trim(), status: f.status.value, role: f.role.value, where, km: f.km.value };
    if (st.userFilter.q && st.userFilter.q.length < 3) return toast('Type at least 3 letters or digits', 'error');
    if (!st.userFilter.q && !st.userFilter.status && !st.userFilter.role && !ll) return toast('Type a name/phone or choose a filter', 'error');
    try { st.userResults = (await st.api.findUsers(st.userFilter.q, { status: st.userFilter.status, role: st.userFilter.role, km: st.userFilter.km, ...(ll ? { lat: ll.lat, lng: ll.lng } : {}) })).items; render(); } catch (e) { showErr(e); }
  },
  async 'add-staff'(f) { try { await st.api.createStaff({ displayName: f.displayName.value, email: f.email.value, password: f.password.value, role: f.role.value }); toast('Account created. They will set up 2-step login on first sign-in.', 'ok'); render(); } catch (e) { showErr(e); } },
  async handoff(f) { try { await st.api.handoff(f.dataset.id, { status: f.status.value, reason: f.reason.value }); toast('Handoff recorded', 'ok'); render(); } catch (e) { showErr(e); } },
  async closure(f) { try { await st.api.closureException(f.dataset.id, { reason: f.reason.value, note: f.note.value }); toast('Closed with documented exception', 'ok'); render(); } catch (e) { showErr(e); } },
};

const changes = {
  customSosWords(el) { const words = el.value.split(',').map((w) => w.trim()).filter((w) => w.length >= 3).slice(0, 5); prefs.set({ customSosWords: words }); syncNative(); toast(`SOS words: ${ownSosWords(words).join(', ')}`, 'ok'); if (!words.length) el.value = ownSosWords([]).join(', '); },
  lang(el) { setLang(el.value); render(); syncNative(); if (voice.active) { voice.stop(); voice.start(() => startCountdown('voice')); } },
  country(el) { prefs.set({ country: el.value }); render(); },
  'show-pw'(el) { el.closest('form').querySelectorAll('input[name^="pw"], input[name="cur"]').forEach((i) => { i.type = el.checked ? 'text' : 'password'; }); },
  async shake(el) {
    if (el.checked) { const r = await shake.enable(() => startCountdown('shake')); if (r !== 'on') { el.checked = false; return toast(r === 'denied' ? 'Motion permission denied' : 'Motion sensors not available', 'error'); } }
    else shake.disable();
    prefs.set({ shake: el.checked });
  },
  voice(el) {
    if (el.checked) { const r = voice.start(() => startCountdown('voice')); if (r !== 'on') { el.checked = false; return toast('Voice recognition not supported', 'error'); } toast(`Listening for "${ownSosWords(prefs.get().customSosWords || []).join('", "')}" while the app is open`, 'info'); }
    else voice.stop();
    prefs.set({ voice: el.checked });
  },
  sms112(el) { prefs.set({ sms112: el.checked }); syncNative(); },
  serverSms(el) { prefs.set({ serverSms: el.checked }); st.api.saveContacts({ prefs: { serverSms: el.checked } }).catch(() => {}); },
  async armed(el) { prefs.set({ armed: el.checked }); await native.requestPermissions('safety'); await syncNative(); if (!el.checked) native.stopSafety(); toast(el.checked ? 'Background protection on — look for the Beti Bachao notification' : 'Background protection off', 'ok'); },
  autoSms(el) { prefs.set({ autoSms: el.checked }); syncNative(); },
  'ops-all'(el) { store.set('ops.all', el.checked); render(); },
};

async function pullContacts() {
  try { const c = await st.api.getContacts(); if (!contacts.list().length && c.contacts?.length) store.set('contacts', c.contacts); else if (contacts.list().length && !c.contacts?.length) await st.api.saveContacts({ contacts: contacts.list() }); } catch {}
}
function afterLogin() {
  store.set('meCache', st.me);
  if (st.me?.mustChangePassword) return go('#/change-password'); // the rest runs once she has chosen her own password
  const p = prefs.get();
  if (['user', 'volunteer'].includes(st.me.role)) { pullContacts().then(() => st.me?.role === 'user' && P.pullPlaces()).then(syncNative); registerAppPush(); }
  if (st.me.role === 'user') {
    if (p.shake) shake.enable(() => startCountdown('shake'));
    if (p.voice && !native.available()) voice.start(() => startCountdown('voice'));
    geo.permission().then((s) => { if (s === 'granted') geo.start(); });
  }
  if (store.get('pendingSos', null)) scheduleSosRetry();
  go(permsDone() ? roleHome(st.me.role) : '#/permissions');
}

// ------------------------------------------------------------------ police call
async function placePoliceCall(id, number) {
  if (native.available() && platform === 'android') await native.placeCall({ number, key: id }); // the phone reports the call to the server
  else openExternal(telHref(number));
}

// ------------------------------------------------------------------ phone permissions (first run in the app)
// Everything is ON by default; she can switch off what she doesn't want. A feature that needs
// a permission is switched off with it (e.g. no microphone → no Voice SOS / evidence).
function permItems(role) {
  if (role === 'user') return [
    { k: 'location', alias: 'location', icon: '📍', t: 'Location — "Allow all the time"', d: 'Sends your exact place to helpers during an SOS and picks the right contacts for where you are.' },
    { k: 'notifications', alias: 'notifications', icon: '🔔', t: 'Notifications', d: 'Who is coming, how far they are, and police updates.' },
    { k: 'sms', alias: 'sms', icon: '💬', t: 'Send SMS', d: 'Your phone texts your contacts the moment SOS starts — works even without internet.' },
    { k: 'phone', alias: 'phone', icon: '📞', t: 'Phone calls', d: 'Calls the nearest police station (or 1091 / 112) by itself if no operator responds.' },
    { k: 'microphone', alias: 'microphone', icon: '🎙️', t: 'Microphone', d: 'Needed for Voice SOS and the 15-second evidence clip.' },
    { k: 'armed', pref: true, icon: '🛡️', t: 'Background protection', d: 'SOS from the lock screen, quick-settings tile and pressing power 5 times.' },
    { k: 'voiceNative', pref: true, needs: 'microphone', icon: '🗣️', t: 'Voice SOS', d: 'Say your SOS word (default "bachao") — even with the screen locked.' },
    { k: 'autoEvidence', pref: true, needs: 'microphone', icon: '🎧', t: 'Evidence recording', d: '15 s of audio after your SOS is active, sent silently to operators and admin.' },
    { k: 'shake', pref: true, icon: '📳', t: 'Shake for SOS', d: 'Shake the phone firmly 3 times.' },
    { k: 'battery', system: 'batteryOptimization', icon: '🔋', t: 'Battery: don\'t restrict Beti Bachao', d: 'Stops the phone from pausing protection to save battery.' },
  ];
  if (role === 'volunteer') return [
    { k: 'location', alias: 'location', icon: '📍', t: 'Location — "Allow all the time"', d: 'So SOS alerts near you reach you, and she can see you coming.' },
    { k: 'notifications', alias: 'notifications', icon: '🔔', t: 'Notifications & full-screen alerts', d: 'SOS alerts ring loudly, even on the lock screen.' },
    { k: 'battery', system: 'batteryOptimization', icon: '🔋', t: 'Battery: don\'t restrict Beti Bachao', d: 'Alerts arrive instantly while you are on duty.' },
  ];
  return [{ k: 'notifications', alias: 'notifications', icon: '🔔', t: 'Notifications', d: 'Escalations and new SOS.' }];
}
function viewPermissions() {
  const items = permItems(st.me.role);
  return shell(`<h1>Set up your phone</h1>
    <p class="muted">Everything is <b>on</b> — that gives you the strongest protection. Turn off anything you don't want; you can change it later in Settings.</p>
    <form class="card form perm-form" data-form="perm-setup">
      ${items.map((x) => `<label class="perm-row"><input type="checkbox" name="${esc(x.k)}" checked ${x.needs ? `data-needs="${esc(x.needs)}"` : ''}><span class="perm-ic" aria-hidden="true">${x.icon}</span><span><b>${esc(x.t)}</b><small class="muted">${esc(x.d)}</small></span></label>`).join('')}
      <button class="btn btn-primary btn-lg btn-block">Allow selected</button>
      <button type="button" class="btn btn-ghost btn-block" data-act="perm-skip">Not now</button>
    </form>`);
}
function permsDone() { return !native.available() || store.get('permsDone:' + st.me?.role, false); }

// ------------------------------------------------------------------ boot
// Error tracking: every unexpected error in the app (and the last native crash) is sent to
// the server, so it shows in Admin → Integrations → App errors with its stack trace.
let errSent = 0;
function reportError(kind, message, stack = '', where = location.hash) {
  if (++errSent > 20 || !st.api) return;
  st.api.reportError({ kind, message: String(message || ''), stack: String(stack || ''), where, app: `${platform} ${window.BB_APP_BUILD || 'web'}` }).catch(() => {});
}
window.addEventListener('error', (e) => reportError('js', e.message, e.error?.stack || `${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => reportError('promise', e.reason?.message || String(e.reason), e.reason?.stack || ''));

async function boot() {
  setLang(detectLang());
  mergeProtect();
  a11y.init(prefs.get());
  st.api = await createApi();
  st.offline = !!st.api.unreachable;
  native.takeLastCrash?.().then((r) => { if (r?.crash) reportError('native_crash', r.crash.split('\n')[1] || 'crash', r.crash); });
  try { st.cfg = await st.api.publicConfig(); } catch { st.offline = true; st.cfg = { demo: false, countries: { IN: { name: 'India', emergency: '112', extra: [], verified: true } }, defaultCountry: 'IN', simulatedLabel: 'SIMULATED — NOT SENT TO EMERGENCY SERVICES' }; }
  try { st.me = (await st.api.me()).user; store.set('meCache', st.me); st.api.connect(); }
  catch (e) {
    // No network at start-up ≠ logged out: keep her signed in (SOS must keep working) and reconnect later.
    st.me = e?.code === 'NETWORK' || e?.status >= 500 ? store.get('meCache', null) : null;
    if (st.me) { st.offline = true; const retry = async () => { try { st.me = (await st.api.me()).user; store.set('meCache', st.me); st.api.connect(); st.offline = false; render(); } catch { setTimeout(retry, 8000); } }; setTimeout(retry, 5000); }
  }
  if (!st.me) { try { st.impact = await st.api.impact(); } catch {} }

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
  for (const ev of ['input', 'change', 'focusin']) document.addEventListener(ev, (e) => { if (e.target.closest?.('form:not([data-form="login"])') && !e.target.closest('[data-change]')) st.editingUntil = Date.now() + 30000; });
  document.addEventListener('submit', () => { st.editingUntil = 0; }, true);
  // Phone country picker ↔ sign-up "Country" select stay in step.
  bindPhoneFields(document, (iso, sel) => { const c = sel.form?.countryCode; if (c && [...c.options].some((o) => o.value === iso)) c.value = iso; });
  document.addEventListener('change', (e) => { const c = e.target; if (c.name !== 'countryCode' || !c.form) return; const p = c.form.querySelector('[name="phone_cc"]'); if (p && !c.form.phone?.value) p.value = c.value; });
  window.addEventListener('hashchange', () => { render(); $('#main')?.focus({ preventScroll: true }); });
  window.addEventListener('online', () => { if (store.get('pendingSos', null)) triggerSOS(store.get('pendingSos')); });

  st.api.subscribe((ev) => {
    if (ev.type === 'volunteer.alerted' && st.me?.role === 'volunteer') vibrate([300, 100, 300]);
    const route = location.hash.split('/')[1];
    if (['incident', 'volunteer', 'ops', 'trip'].includes(route)) refreshSoft();
  });

  setInterval(() => {
    updateLive();
    streamLocation();
    streamVolunteerLocation();
    streamDutyLocation();
    P.tick();
    const sw = safeWalk.get();
    if (sw && Date.now() >= sw.endsAt && st.me?.role === 'user') { safeWalk.stop(); startCountdown('safewalk', 30); }
  }, 1000);

  if (st.me?.role === 'user' || st.me?.role === 'volunteer') afterLoginSilent();
  render();
  // Opened from the lock-screen button, quick tile, widget, power button or Siri.
  if (native.available()) {
    const act = await native.takeLaunchAction();
    if (act?.action === 'sos' && st.me?.role === 'user') triggerSOS({ trigger: act.trigger || 'native' });
    if (act?.url) location.hash = act.url;
    document.addEventListener('resume', async () => { const a = await native.takeLaunchAction(); if (a?.action === 'sos' && st.me?.role === 'user') triggerSOS({ trigger: a.trigger || 'native' }); if (a?.url) location.hash = a.url; });
  }
  if (st.me && pushState() === 'granted') enablePush(true);
  if ('serviceWorker' in navigator && location.protocol !== 'file:' && !isNative) {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => r.update()).catch(() => {});
    // A new version took over: reload once so every file is the same version (never during an SOS).
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController && !location.hash.startsWith('#/incident')) location.reload(); });
  }
}
function afterLoginSilent() {
  if (st.me?.mustChangePassword) return;
  const p = prefs.get();
  if (['user', 'volunteer'].includes(st.me.role)) { pullContacts().then(() => st.me?.role === 'user' && P.pullPlaces()).then(syncNative); registerAppPush(); }
  if (p.shake) shake.enable(() => startCountdown('shake'));
  if (p.voice && !native.available()) voice.start(() => startCountdown('voice'));
  geo.permission().then((s) => { if (s === 'granted') geo.start(); });
  if (store.get('pendingSos', null)) scheduleSosRetry();
  if (!permsDone() && !/^#\/(incident|permissions)/.test(location.hash)) go('#/permissions'); // existing users see the setup once after updating
}

boot().catch((e) => { console.error('[boot]', e); const m = document.getElementById('app'); if (m) m.innerHTML = '<main id="main" style="padding:24px"><h1>Beti Bachao</h1><p>Could not start. Check your internet and <a href="#/" onclick="location.reload()">try again</a>.</p><p><a class="btn btn-call" href="tel:112">📞 Call 112</a></p></main>'; });

// Accept what people actually type: no https://, spaces, trailing slashes, capitals, render.com for onrender.com.
export function normalizeServerUrl(raw) {
  let u = String(raw || '').trim().replace(/\s+/g, '-');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const x = new URL(u);
    let host = x.hostname.toLowerCase();
    if (/^[a-z0-9-]+\.render\.com$/.test(host) && !host.startsWith('dashboard.')) host = host.replace(/\.render\.com$/, '.onrender.com');
    const proto = /^(localhost|127\.|10\.|192\.168\.)/.test(host) ? x.protocol : 'https:';
    return `${proto}//${host}${x.port ? ':' + x.port : ''}${x.pathname.replace(/\/+$/, '')}`;
  } catch { return ''; }
}
