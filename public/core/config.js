// Default operating policy. Every value is admin-configurable (Admin console →
// Policy) and validated by validateConfig(). Timers are deliberately short so
// a demo can walk through all three search stages in a few minutes; a pilot
// must tune these with emergency-service partners.

export const DEFAULT_CONFIG = Object.freeze({
  countryCode: 'IN',
  radiusStagesKm: [10, 20, 30],
  stageTimeoutsSec: [45, 45, 60],
  highSeverityStageTimeoutsSec: [20, 20, 30],
  targetResponders: 2, // keep searching for backup until this many have accepted
  maxResponders: 3, // hard cap on simultaneous assignments per incident
  acceptToEnRouteStallSec: 120, // accepted but never left → backup + escalation
  enRouteStallFactor: 2, // en-route for longer than ETA × factor → stalled
  enRouteStallMinSec: 600,
  locationStaleSec: 120,
  lowAccuracyM: 100,
  volunteerLocationMaxAgeMin: 30,
  approxGridDeg: 0.02, // ≈2 km grid for unassigned volunteers
  roadFactor: 1.4,
  responderSpeedKmh: 25,
  maxPlausibleSpeedKmh: 250, // faster implied movement → location flagged as suspect
  sosPerHourLimit: 6,
  preciseAccessAuditWindowSec: 60,
});

// Emergency numbers. `verified: true` only where an official source was
// checked for this build; everything else must be confirmed with local
// authorities before any pilot. The UI always shows the verification state.
export const COUNTRIES = {
  IN: { name: 'India', emergency: '112', emergencyLabel: 'Police · Ambulance · Fire', verified: true, extra: [{ label: 'Women helpline · 24x7', number: '181' }, { label: 'Women police helpline', number: '1091' }, { label: 'Ambulance · medical help', number: '108', medical: true }], locale: 'hi' },
  US: { name: 'United States', emergency: '911', verified: false, extra: [{ label: 'Domestic violence hotline', number: '18007997233' }], locale: 'en' },
  GB: { name: 'United Kingdom', emergency: '999', verified: false, extra: [{ label: 'Emergency (EU/intl)', number: '112' }], locale: 'en' },
  EU: { name: 'European Union', emergency: '112', verified: false, extra: [], locale: 'en' },
  CA: { name: 'Canada', emergency: '911', verified: false, extra: [], locale: 'en' },
  AU: { name: 'Australia', emergency: '000', verified: false, extra: [{ label: 'Emergency from mobile', number: '112' }], locale: 'en' },
  AE: { name: 'United Arab Emirates', emergency: '999', verified: false, extra: [{ label: 'Ambulance · medical help', number: '998', medical: true }], locale: 'ar' },
  SA: { name: 'Saudi Arabia', emergency: '911', verified: false, extra: [{ label: 'Ambulance · medical help', number: '997', medical: true }], locale: 'ar' },
  PK: { name: 'Pakistan', emergency: '15', verified: false, extra: [{ label: 'Rescue & ambulance', number: '1122', medical: true }], locale: 'ur' },
  BD: { name: 'Bangladesh', emergency: '999', verified: false, extra: [{ label: 'Women & child helpline', number: '109' }], locale: 'bn' },
  NP: { name: 'Nepal', emergency: '100', verified: false, extra: [{ label: 'Ambulance · medical help', number: '102', medical: true }], locale: 'hi' },
  LK: { name: 'Sri Lanka', emergency: '119', verified: false, extra: [{ label: 'Ambulance · medical help', number: '1990', medical: true }], locale: 'ta' },
  BR: { name: 'Brazil', emergency: '190', verified: false, extra: [{ label: 'Women helpline (Ligue 180)', number: '180' }], locale: 'pt' },
  MX: { name: 'Mexico', emergency: '911', verified: false, extra: [], locale: 'es' },
  ES: { name: 'Spain', emergency: '112', verified: false, extra: [{ label: 'Gender violence helpline', number: '016' }], locale: 'es' },
  FR: { name: 'France', emergency: '112', verified: false, extra: [{ label: 'Violence against women', number: '3919' }], locale: 'fr' },
  ZA: { name: 'South Africa', emergency: '10111', verified: false, extra: [{ label: 'Emergency from mobile', number: '112' }], locale: 'en' },
  NG: { name: 'Nigeria', emergency: '112', verified: false, extra: [], locale: 'en' },
  KE: { name: 'Kenya', emergency: '999', verified: false, extra: [{ label: 'Gender violence helpline', number: '1195' }], locale: 'sw' },
  SG: { name: 'Singapore', emergency: '999', verified: false, extra: [], locale: 'en' },
  MY: { name: 'Malaysia', emergency: '999', verified: false, extra: [], locale: 'en' },
  PH: { name: 'Philippines', emergency: '911', verified: false, extra: [], locale: 'en' },
  ID: { name: 'Indonesia', emergency: '112', verified: false, extra: [], locale: 'en' },
};

const isIntArr = (a, len) => Array.isArray(a) && a.length === len && a.every((n) => Number.isInteger(n) && n > 0);

export function validateConfig(patch, current = DEFAULT_CONFIG) {
  const next = { ...current, ...patch };
  const errors = [];
  if (!isIntArr(next.radiusStagesKm, 3)) errors.push('radiusStagesKm must be 3 positive integers');
  else if (!(next.radiusStagesKm[0] < next.radiusStagesKm[1] && next.radiusStagesKm[1] < next.radiusStagesKm[2])) errors.push('radiusStagesKm must be increasing');
  else if (next.radiusStagesKm[2] > 100) errors.push('largest radius may not exceed 100 km');
  for (const k of ['stageTimeoutsSec', 'highSeverityStageTimeoutsSec']) {
    if (!isIntArr(next[k], 3) || next[k].some((n) => n < 5 || n > 900)) errors.push(`${k} must be 3 integers between 5 and 900`);
  }
  for (const k of ['targetResponders', 'maxResponders', 'acceptToEnRouteStallSec', 'enRouteStallMinSec', 'locationStaleSec', 'lowAccuracyM', 'volunteerLocationMaxAgeMin', 'sosPerHourLimit']) {
    if (!Number.isInteger(next[k]) || next[k] < 1) errors.push(`${k} must be a positive integer`);
  }
  if (next.targetResponders > next.maxResponders) errors.push('targetResponders cannot exceed maxResponders');
  if (!COUNTRIES[next.countryCode]) errors.push('unknown countryCode');
  const allowed = new Set(Object.keys(DEFAULT_CONFIG));
  for (const k of Object.keys(patch)) if (!allowed.has(k)) errors.push(`unknown config key: ${k}`);
  return { ok: errors.length === 0, errors, config: next };
}
