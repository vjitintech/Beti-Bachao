# Localisation

14 languages in `public/js/i18n.js` (English source; per-key fallback). Urdu and Arabic switch the layout to RTL. Voice-trigger keywords per language are in `VOICE_KEYWORDS`.

All non-English strings are **first drafts** and must be reviewed by native speakers — especially safety-critical lines (SOS, "Are you safe now?", duress PIN, simulated-dispatch label). Volunteer, operator and admin screens are English-only for now.

Add a language: add an entry to `LANGS`, a dictionary in `D`, and keywords in `VOICE_KEYWORDS`; run `node -e "import('./public/js/i18n.js').then(m=>console.log(m.missingKeys()))"`.
