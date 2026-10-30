# Beti Bachao — women's safety SOS-to-safety platform

> **Every emergency is acknowledged, every response is tracked, every location has an honest confidence estimate, and no incident is marked safe without a verified outcome.**

Beti Bachao is not "another panic button". It coordinates the whole response: SOS → staged search for **verified, trained volunteers** within 10 → 20 → 30 km → live tracking of every responder → operator oversight → closed only when **she confirms she is safe**.

> ⚠️ Beti Bachao **does not automatically contact police or ambulance**. Operators call 112 and record the handoff. In immediate danger, always call your local emergency number. The app shows those buttons on every screen.

**▶ Run it from GitHub now:** [![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/vjitintech/Beti-Bachao) — see [docs/RUN_ON_GITHUB.md](docs/RUN_ON_GITHUB.md) (for testing; it stops when idle).

**➡ For 24×7 real use: [docs/DEPLOY.md](docs/DEPLOY.md)** (one-click Render deploy, about 10 minutes).

## Features

**For women & girls** (installable phone app, 14 languages)
- **Hold-to-SOS** (3 s, prevents pocket triggers). Every SOS is treated as immediate danger, alerts operators instantly, and searches quickly.
- **Auto-message**: the moment SOS starts, the phone's SMS app opens pre-filled with "I am in danger" plus a Google Maps link, addressed to all trusted contacts.
- **Shake ×3**, **voice keyword** ("bachao", "kapadandi", "help"…), and **reach-home check-in timer** triggers.
- **Duress PIN**: "cancels" on screen but secretly keeps help coming and flags operators 🚩.
- **Live tracking**: PPI radar with every responder's distance and ETA counting down, plus an embedded Google Map.
- **"Are you safe now?"** YES (double-confirmed) / NO / NEED MORE HELP.
- Offline-first: SOS queued if offline; call and SMS always work.
- Siren, fake call, evidence recorder (stays on the phone).
- Helplines 112 · 181 · 1091 · 108 (India); other countries configurable.

**For volunteers**: register → 5 training modules → verification request (trust team calls; no ID uploads) → admin approval → on duty → **phone push alerts** even when the app is closed → accept → embedded route map and team radar → En route / Arrived / Assisting → stand-down.

**For operators** (authenticator-app login): live queue, ① SEARCH radar (who was alerted) and ② APPROACH radar (who is coming), push alerts on every escalation, reassign responders, record 112 handoffs, audited closure exceptions.

**For admins**: add operators, approve or suspend volunteers, dispatch policy (radii, timers, responder targets), abuse reports, hash-chained audit log, daily backup download.

**Languages**: English, हिन्दी, తెలుగు, தமிழ், ಕನ್ನಡ, മലയാളം, বাংলা, मराठी, ગુજરાતી, اردو, العربية, Español, Français, Português.

## Run locally

Node.js ≥ 20, **no npm install needed** (zero dependencies).

```bash
ADMIN_EMAIL=you@example.org ADMIN_PASSWORD='a-long-password' npm start   # http://localhost:8080
npm test          # 32 engine, API and Web Push tests
npm run smoke     # headless-browser end-to-end walkthrough (needs Playwright/Chromium)
node scripts/version.mjs   # run after editing public/ so phones load fresh files
```

## Architecture

```
public/core/engine.js   ← all safety rules: state machine, staged search, privacy filter, escalation, tracking, audit
server/server.js        ← API /api/v1, sessions, TOTP MFA + enrolment, CSRF, rate limits, SSE, durable scheduler, backups
server/webpush.js       ← Web Push (VAPID + aes128gcm) with Node crypto — no libraries
server/store.js         ← atomic JSON store on a persistent disk (single instance)
public/js/              ← PWA: screens, radar, maps, device safety features, 14 languages
db/migrations/          ← PostgreSQL + PostGIS schema for scaling beyond one server
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/API.md](docs/API.md), [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), [docs/RETENTION.md](docs/RETENTION.md), [docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md).

## Safety rules enforced in code (and tested)

| Rule | Test |
|---|---|
| One incident per SOS (idempotency); one open incident per user | AT-01 |
| Only verified + trained + on-duty + nearby volunteers are alerted | AT-02, server |
| 10 → 20 → 30 km on persisted deadlines; survives restart | AT-02/03, server restart |
| Backup search after the first acceptance; stalled or dropped responders trigger replacement + escalation | AT-03/04 |
| Unassigned volunteers never get exact coordinates; precise access is audited | AT-05, server, browser |
| Arrival never closes; YES needs explicit confirmation; NO escalates | AT-07, server, browser |
| Unauthorised actions → 403/409, audited; tamper-evident audit chain | AT-08 |
| Duress PIN looks cancelled, stays open and escalated | duress test |
| Staff must enrol an authenticator before any access | server |
| Push payloads end-to-end encrypted (RFC 8291) and VAPID-signed (RFC 8292) | webpush |
