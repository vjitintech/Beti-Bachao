// On-device safety capabilities. Everything degrades gracefully: if a browser
// lacks a sensor or permission is denied, the UI says so and offers the next
// best option (call / SMS). Nothing here pretends to work when it doesn't.
import { VOICE_KEYWORDS, lang, speechLang } from './i18n.js?v=mvuhugq0';

const store = {
  get(k, d) { try { const v = localStorage.getItem('bb.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bb.' + k, JSON.stringify(v)); } catch {} },
};
export { store };

// ---------------- location ----------------
export const geo = {
  supported: 'geolocation' in navigator,
  watchId: null,
  last: null,
  listeners: new Set(),
  async permission() {
    if (!this.supported) return 'unsupported';
    try { const p = await navigator.permissions.query({ name: 'geolocation' }); return p.state; } catch { return 'unknown'; }
  },
  fromPosition(p) {
    const c = p.coords;
    return {
      lat: c.latitude, lng: c.longitude, accuracyM: Math.round(c.accuracy || 9999),
      altitudeM: c.altitude ?? null, verticalAccuracyM: c.altitudeAccuracy ?? null,
      source: (c.accuracy || 9999) <= 100 ? 'gps' : 'network', observedAt: new Date(p.timestamp || Date.now()).toISOString(),
    };
  },
  once(timeout = 12000) {
    return new Promise((resolve, reject) => {
      if (!this.supported) return reject(new Error('unsupported'));
      navigator.geolocation.getCurrentPosition((p) => { this.last = this.fromPosition(p); this.emit(); resolve(this.last); }, (e) => reject(e), { enableHighAccuracy: true, timeout, maximumAge: 5000 });
    });
  },
  start() {
    if (!this.supported || this.watchId != null) return;
    this.watchId = navigator.geolocation.watchPosition((p) => { this.last = this.fromPosition(p); this.emit(); }, () => {}, { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 });
  },
  stop() { if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId); this.watchId = null; },
  emit() { this.listeners.forEach((f) => f(this.last)); },
  on(f) { this.listeners.add(f); return () => this.listeners.delete(f); },
};

export function syntheticLocation(center) {
  // small jitter so repeated observations look like a real fix, never claimed as GPS
  const j = () => (Math.random() - 0.5) * 0.00006;
  return { lat: +(center.lat + j()).toFixed(6), lng: +(center.lng + j()).toFixed(6), accuracyM: 15, altitudeM: null, verticalAccuracyM: null, source: 'synthetic', observedAt: new Date().toISOString() };
}

export async function battery() {
  try { const b = await navigator.getBattery(); return { level: b.level, charging: b.charging }; } catch { return null; }
}

let wakeLock = null;
export async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
export const vibrate = (p) => { try { navigator.vibrate?.(p); } catch {} };

// ---------------- siren ----------------
let ctx = null;
const audio = () => (ctx ||= new (window.AudioContext || window.webkitAudioContext)());
export const siren = {
  on: false, nodes: null,
  start() {
    if (this.on) return;
    const a = audio(); a.resume?.();
    const osc = a.createOscillator(), lfo = a.createOscillator(), lfoGain = a.createGain(), gain = a.createGain();
    osc.type = 'square'; osc.frequency.value = 1000;
    lfo.type = 'triangle'; lfo.frequency.value = 1.6; lfoGain.gain.value = 450;
    lfo.connect(lfoGain).connect(osc.frequency);
    gain.gain.value = 0.9;
    osc.connect(gain).connect(a.destination);
    osc.start(); lfo.start();
    this.nodes = { osc, lfo }; this.on = true;
    document.body.classList.add('strobe');
    vibrate([400, 200, 400, 200, 400]);
  },
  stop() {
    if (!this.on) return;
    try { this.nodes.osc.stop(); this.nodes.lfo.stop(); } catch {}
    this.on = false; document.body.classList.remove('strobe');
  },
};

// ---------------- fake call ----------------
export const ringer = {
  timer: null,
  start() {
    const a = audio(); a.resume?.();
    const ring = () => {
      for (const [f, t] of [[440, 0], [480, 0]]) {
        const o = a.createOscillator(), g = a.createGain();
        o.frequency.value = f; g.gain.value = 0.15; o.connect(g).connect(a.destination);
        o.start(a.currentTime + t); o.stop(a.currentTime + t + 1.2);
      }
      vibrate([800, 400, 800]);
    };
    ring(); this.timer = setInterval(ring, 3000);
  },
  stop() { clearInterval(this.timer); this.timer = null; vibrate(0); },
};

// ---------------- shake trigger ----------------
export const shake = {
  enabled: false, handler: null, hits: [], onTrigger: null,
  async enable(onTrigger) {
    this.onTrigger = onTrigger;
    if (typeof DeviceMotionEvent === 'undefined') return 'unsupported';
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try { if ((await DeviceMotionEvent.requestPermission()) !== 'granted') return 'denied'; } catch { return 'denied'; }
    }
    if (this.enabled) return 'on';
    this.handler = (e) => {
      const g = e.accelerationIncludingGravity || e.acceleration;
      if (!g) return;
      const mag = Math.sqrt((g.x || 0) ** 2 + (g.y || 0) ** 2 + (g.z || 0) ** 2);
      if (mag < 25) return; // ~2.5 g — deliberate, firm shakes only
      const now = Date.now();
      this.hits = this.hits.filter((t) => now - t < 1500);
      if (!this.hits.length || now - this.hits[this.hits.length - 1] > 250) this.hits.push(now);
      if (this.hits.length >= 3) { this.hits = []; this.onTrigger?.(); }
    };
    window.addEventListener('devicemotion', this.handler);
    this.enabled = true;
    return 'on';
  },
  disable() { if (this.handler) window.removeEventListener('devicemotion', this.handler); this.enabled = false; },
};

// ---------------- voice trigger ----------------
export const voice = {
  rec: null, active: false, onTrigger: null,
  supported: !!(window.SpeechRecognition || window.webkitSpeechRecognition),
  keywords() { return [...new Set([...(VOICE_KEYWORDS[lang()] || []), ...VOICE_KEYWORDS.en, 'beti bachao'])].map((k) => k.toLowerCase()); },
  start(onTrigger) {
    if (!this.supported) return 'unsupported';
    this.onTrigger = onTrigger;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = speechLang(); rec.continuous = true; rec.interimResults = true;
    rec.onresult = (ev) => {
      const words = this.keywords();
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const said = ev.results[i][0].transcript.toLowerCase();
        if (words.some((w) => said.includes(w))) { this.onTrigger?.(said); break; }
      }
    };
    rec.onend = () => { if (this.active) { try { rec.start(); } catch {} } };
    rec.onerror = (e) => { if (e.error === 'not-allowed') this.active = false; };
    this.rec = rec; this.active = true;
    try { rec.start(); } catch {}
    return 'on';
  },
  stop() { this.active = false; try { this.rec?.stop(); } catch {} },
};

// ---------------- evidence recorder (IndexedDB, stays on this device) ----------------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('beti-bachao-evidence', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('clips', { keyPath: 'id' });
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function tx(mode, fn) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction('clips', mode); const s = t.objectStore('clips'); const out = fn(s); t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error); }); }

export const recorder = {
  mr: null, chunks: [], startedAt: null, kind: null, stream: null,
  supported: !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder),
  get recording() { return !!this.mr && this.mr.state === 'recording'; },
  async start(kind = 'audio') {
    if (!this.supported || this.recording) return false;
    this.stream = await navigator.mediaDevices.getUserMedia(kind === 'video' ? { audio: true, video: { facingMode: 'environment' } } : { audio: true });
    this.chunks = []; this.kind = kind; this.startedAt = new Date();
    this.mr = new MediaRecorder(this.stream);
    this.mr.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.mr.start(1000); // 1 s chunks so an interrupted recording still keeps data
    return true;
  },
  stop() {
    return new Promise((resolve) => {
      if (!this.mr) return resolve(null);
      this.mr.onstop = async () => {
        const blob = new Blob(this.chunks, { type: this.mr.mimeType || (this.kind === 'video' ? 'video/webm' : 'audio/webm') });
        this.stream.getTracks().forEach((t) => t.stop());
        const clip = { id: crypto.randomUUID?.() || String(Date.now()), kind: this.kind, createdAt: this.startedAt.toISOString(), durationSec: Math.round((Date.now() - this.startedAt) / 1000), type: blob.type, blob };
        try { await tx('readwrite', (s) => s.put(clip)); } catch {}
        this.mr = null; resolve(clip);
      };
      this.mr.stop();
    });
  },
  async list() { try { return (await tx('readonly', (s) => s.getAll())) || []; } catch { return []; } },
  async remove(id) { try { await tx('readwrite', (s) => s.delete(id)); } catch {} },
};

// ---------------- trusted contacts + messaging ----------------
export const contacts = {
  list() { return store.get('contacts', []); },
  add(name, phone) {
    const p = String(phone).replace(/[^\d+]/g, '');
    if (!name.trim() || p.length < 6) return false;
    const l = this.list(); if (l.length >= 10) return false;
    l.push({ name: name.trim().slice(0, 40), phone: p }); store.set('contacts', l); return true;
  },
  remove(i) { const l = this.list(); l.splice(i, 1); store.set('contacts', l); },
};
export const mapsLink = (loc) => (loc ? `https://maps.google.com/?q=${loc.lat.toFixed(6)},${loc.lng.toFixed(6)}` : '');
export function smsHref(numbers, body) {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  return `sms:${numbers.join(',')}${ios ? '&' : '?'}body=${encodeURIComponent(body)}`;
}
export const whatsappHref = (body) => `https://wa.me/?text=${encodeURIComponent(body)}`;
export async function nativeShare(text) {
  if (!navigator.share) return false;
  try { await navigator.share({ title: 'SOS — Beti Bachao', text }); return true; } catch { return false; }
}

// ---------------- safe walk (dead-man's switch) ----------------
export const safeWalk = {
  get() { return store.get('safewalk', null); },
  start(minutes) { const s = { endsAt: Date.now() + minutes * 60000, minutes }; store.set('safewalk', s); return s; },
  extend() { const s = this.get(); if (s) return this.start(s.minutes); return null; },
  stop() { store.set('safewalk', null); },
};

// ---------------- settings ----------------
export const prefs = {
  get() { return { autoSms: true, shake: false, voice: false, autoRecord: false, synthetic: true, country: null, fakeCaller: 'Maa', ...store.get('prefs', {}) }; },
  set(patch) { const p = { ...this.get(), ...patch }; store.set('prefs', p); return p; },
};
