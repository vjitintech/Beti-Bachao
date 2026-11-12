// Country-code picker for phone number fields. Every phone input in the app is a pair:
// <select name="X_cc"> (country + dial code) and <input name="X"> (the number as typed).
// readPhone() joins them into +E.164 so SMS gateways and the native SMS sender get one format.
import { DIAL, dialInfo, flag, toE164, phoneProblem, splitE164, countryName } from '../core/dial.js?v=mwdjqued';
import { esc } from './ui.js?v=mwdjqued';

let fallback = null;
// Best guess for a new user: chosen country > device locale region > India.
export function guessCountry(pref) {
  if (pref && dialInfo(pref)) return pref.toUpperCase();
  if (fallback) return fallback;
  try {
    const locs = [...(navigator.languages || []), navigator.language].filter(Boolean);
    for (const l of locs) { const m = String(l).match(/[-_]([A-Za-z]{2})\b/); if (m && dialInfo(m[1])) return (fallback = m[1].toUpperCase()); }
  } catch {}
  return (fallback = 'IN');
}

let cache = { lang: null, html: null };
function options(lang) {
  if (cache.lang !== lang) {
    const rows = DIAL.map((r) => [r[0], countryName(r[0], lang), r[2]]).sort((a, b) => a[1].localeCompare(b[1], lang || undefined));
    cache = { lang, html: rows.map(([iso, name, cc]) => `<option value="${iso}">${flag(iso)} +${cc} ${esc(name)}</option>`).join('') };
  }
  return cache.html;
}

// HTML for a phone field. `value` may be an E.164 number (it is split back into country + number).
export function phoneInput(name, { value = '', country, required = false, lang, placeholder, extra = '' } = {}) {
  const [iso, national] = value ? splitE164(value, guessCountry(country)) : [guessCountry(country), ''];
  const info = dialInfo(iso);
  const ph = placeholder ?? (info ? `${'9'.repeat(Math.min(info[4], 10)).replace(/^(\d{5})/, '$1 ')}` : '');
  return `<span class="phone-field"><select name="${esc(name)}_cc" aria-label="Country code" data-phone-cc>${options(lang).replace(`value="${iso}"`, `value="${iso}" selected`)}</select><input name="${esc(name)}" type="tel" inputmode="tel" autocomplete="tel-national" value="${esc(national)}" placeholder="${esc(ph)}" maxlength="20" ${required ? 'required' : ''} ${extra}></span>`;
}

// Read one phone pair from a form, row or modal-data object. Returns { e164, iso, problem }.
export function readPhone(scope, name) {
  let iso, raw;
  if (scope && typeof scope.querySelector === 'function') {
    iso = scope.querySelector(`[name="${name}_cc"]`)?.value; raw = scope.querySelector(`[name="${name}"]`)?.value;
  } else { iso = scope?.[`${name}_cc`]; raw = scope?.[name]; }
  const e164 = toE164(iso, raw);
  return { e164, iso, problem: String(raw || '').trim() ? phoneProblem(iso, e164) : 'Enter a mobile number' };
}

// Changing one country picker on a form: update placeholder and keep a sibling country <select name="countryCode"> in step.
export function bindPhoneFields(root, onCountry) {
  root.addEventListener('change', (e) => {
    const sel = e.target.closest?.('[data-phone-cc]');
    if (!sel) return;
    const info = dialInfo(sel.value);
    const input = sel.parentElement?.querySelector('input[type="tel"]');
    if (input && info) input.placeholder = '9'.repeat(Math.min(info[4], 10)).replace(/^(\d{5})/, '$1 ');
    onCountry?.(sel.value, sel);
  });
}
