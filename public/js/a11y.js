// Accessibility for blind and low-vision women:
//  • every important change is announced through an ARIA live region (TalkBack/VoiceOver read it)
//  • "Spoken guidance" speaks it aloud for people not using a screen reader
//  • status read-out of the SOS (who is coming, how far, how long) — repeats every minute
//  • one-tap voice commands ("help", "status", "call police", "I am safe")
import { native } from './native.js?v=mw8jxb86';

let guide = false, screenReader = false, lang = 'en-IN';
export const a11y = {
  setGuide(v) { guide = !!v; },
  setLang(l) { lang = l || 'en-IN'; },
  get screenReader() { return screenReader; },
  get speaking() { return guide && !screenReader; },
  async init(prefs) {
    guide = !!prefs.voiceGuide;
    try { const r = await native.screenReader(); screenReader = !!r?.on; } catch {}
    // A blind user with TalkBack/VoiceOver gets the accessible defaults automatically.
    if (screenReader) document.documentElement.classList.add('sr-user');
    return screenReader;
  },
};

function region(assertive) {
  const id = assertive ? 'sr-alert' : 'sr-status';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id; el.className = 'sr-only';
    el.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
    el.setAttribute('role', assertive ? 'alert' : 'status');
    document.body.appendChild(el);
  }
  return el;
}

export function say(text) {
  if (!text) return;
  if (native.available()) { native.speak({ text, lang }); return; }
  try { const u = new SpeechSynthesisUtterance(text); u.lang = lang; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch {}
}

export function announce(text, { assertive = false, speak = true } = {}) {
  if (!text) return;
  const el = region(assertive);
  el.textContent = ''; setTimeout(() => { el.textContent = text; }, 50);
  if (native.available() && screenReader) native.announce({ text });
  if (speak && a11y.speaking) say(text);
}

let lastStatus = '', lastSpokenAt = 0;
export function statusSentence(v) {
  if (!v) return 'You have no active SOS.';
  if (v.closed) return v.closureReason === 'USER_CONFIRMED_SAFE' ? 'Your SOS is closed. You confirmed you are safe.' : 'Your SOS has ended.';
  const parts = [];
  const rs = v.responders || [];
  if (!rs.length) parts.push(`Your SOS is active. Searching for volunteers within ${v.search?.radiusKm || 10} kilometres. ${v.alertedCount || 0} volunteers alerted.`);
  else for (const r of rs) {
    const dist = r.distanceKm == null ? '' : r.distanceKm < 1 ? `${Math.round(r.distanceKm * 1000)} metres away` : `${r.distanceKm} kilometres away`;
    parts.push(r.status === 'ARRIVED' || r.status === 'ASSISTING' ? `${r.label} has arrived.` : `${r.label} is coming, ${dist}${r.approxEtaMin != null ? `, about ${r.approxEtaMin} minutes` : ''}.`);
  }
  if (v.police?.station) parts.push(`Police station ${v.police.station.name} has been contacted.`);
  else if (v.police) parts.push('Call 112 now.');
  return parts.join(' ');
}

// Announce SOS changes; while spoken guidance is on, repeat the status every minute.
export function speakStatus(v, { force = false } = {}) {
  const text = statusSentence(v);
  const changed = text !== lastStatus;
  if (force || changed || (a11y.speaking && v && !v.closed && Date.now() - lastSpokenAt > 60000)) {
    lastStatus = text; lastSpokenAt = Date.now();
    announce(text, { assertive: changed && !force, speak: true });
    if (force && !a11y.speaking) say(text);
  }
}

// One spoken phrase → text. Native recognizer in the phone apps, Web Speech in browsers.
export async function listenOnce({ lang: l = lang, timeoutMs = 7000 } = {}) {
  if (native.available()) { const r = await native.listenOnce({ lang: l, timeoutMs }); return r?.text || ''; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { announce('Voice commands are not supported in this browser.'); return ''; }
  return new Promise((resolve) => {
    const rec = new SR(); rec.lang = l; rec.interimResults = false; rec.maxAlternatives = 1;
    let done = false; const fin = (t) => { if (!done) { done = true; try { rec.stop(); } catch {} resolve(t); } };
    rec.onresult = (e) => fin(e.results?.[0]?.[0]?.transcript || '');
    rec.onerror = () => fin(''); rec.onend = () => fin('');
    setTimeout(() => fin(''), timeoutMs);
    try { rec.start(); } catch { fin(''); }
  });
}
