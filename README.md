# Beti Bachao — women's safety SOS-to-safety platform (MVP)

> **Every emergency is acknowledged, every response is tracked, every location has an honest confidence estimate, and no incident is marked safe without a verified outcome.**

Beti Bachao is not "another panic button". It coordinates the whole response — from SOS, through a staged search for **verified, trained volunteers** within 10 → 20 → 30 km, backup responders, escalation and operator oversight — until **the woman herself confirms she is safe**.

> ⚠️ **This is an MVP, not an emergency service.** Dispatch to police/emergency services is **SIMULATED — NOT SENT TO EMERGENCY SERVICES** until an approved integration exists. In immediate danger, always call your local emergency number (112 in India). The app shows that button on every screen.

## What's in it

**For women & girls (installable phone app, 14 languages)**
- **Hold-to-SOS** (3 s, prevents pocket triggers) · **Silent SOS** (no sound, dark discreet screen) · **"I'm in immediate danger"** (escalates instantly, faster search timers)
- **Shake ×3** and **voice keyword** triggers ("bachao", "kapadandi", "help"…) with a 5 s cancellable countdown
- **Safe-walk timer**: miss your check-in → 30 s countdown → automatic SOS
- **Duress PIN**: entering it "cancels" the SOS on screen, but secretly keeps help coming and flags the operator 🚩
- Live status in **RED / AMBER / GREEN**, search stage, responders with approximate ETA, and an honest location card (accuracy, age, "floor/vertical location unknown")
- **"Are you safe now?" → YES / NO / NEED MORE HELP**. YES needs a second confirmation; NO/need-help escalates
- **Offline-first**: the app shell works offline; an SOS made offline is queued (idempotent) and sent on reconnect, while SMS-to-contacts and call buttons still work
- Pre-filled **SMS / WhatsApp** to trusted contacts with a maps link · **siren + strobe** · **fake incoming call** · **audio/video evidence recorder** (stays on the device) · battery level shared with responders
- Country-aware emergency numbers and helplines (India: 112, 181, 1091); others marked "verify locally"
- Data export & account deletion

**For volunteers** — readiness checklist (verified, 5 training modules, on duty, fresh location, not busy), mock live-identity check, alert inbox with **approximate area only** until accepted, then precise location + navigation, En route → Arrived → Assisting, "Unable to help" (instant replacement search), escalation, Code of Conduct.

**For operators** — live incident queue, relative **radar map** with search rings and responders, location confidence & suspect-GPS flags, remove/reassign responders, record manual emergency-service handoffs, audited closure exceptions.

**For admins** — dispatch policy (radii, timeouts, responder targets…), volunteer approval/suspension, abuse reports, hash-chained audit log with integrity check, integration health.

**Languages**: English, हिन्दी, తెలుగు, தமிழ், ಕನ್ನಡ, മലയാളം, বাংলা, मराठी, ગુજરાતી, اردو (RTL), العربية (RTL), Español, Français, Português.

## Run it

Requires Node.js ≥ 20. **No npm install needed** — zero runtime dependencies.

```bash
npm run demo        # http://localhost:8080 — seeded synthetic accounts, demo controls
npm test            # 26 engine + API acceptance tests
npm run smoke       # headless-browser end-to-end walkthrough (needs Playwright/Chromium)
npm start           # production-style: MFA on, no demo routes (set ADMIN_EMAIL/ADMIN_PASSWORD on first boot)
```

Demo accounts (password `demo1234`, one tap on the login screen): Priya & Lakshmi (users), Asha 3 km, Ravi 7.5 km, Meena 14 km, Imran 24 km (eligible volunteers), Kiran (unverified), Deepa (untrained), Suresh (off duty), Operator, Admin. Operator/admin MFA codes are auto-filled in demo mode only.

**Try the full story**: log in as Priya in one tab, Asha in a second, Operator in a third. Hold SOS → watch 10 km search → advance time in *Demo* to see 20/30 km → Asha accepts (now sees exact location) → En route → Priya taps *I need more help* (escalation) → *Yes, I am safe* → GREEN.

### Static hosting (GitHub Pages)

`public/` is a complete static site. Without the server it runs in **standalone demo mode**: the same engine runs inside the browser and tabs share state via localStorage. A workflow in `.github/workflows/pages.yml` publishes it. Standalone mode is for demos only — timers stop when every tab closes. Use the Node server for durable timers.

## Architecture

```
public/core/engine.js   ← all safety rules: state machine, staged search, privacy filter, escalation, audit
public/core/{geo,config,seed}.js
server/                 ← zero-dependency Node API (/api/v1), sessions, TOTP MFA, CSRF, rate limits, SSE, durable scheduler
public/js/              ← PWA: app.js (screens), api.js (server or standalone), safety.js (device features), i18n.js
db/migrations/          ← PostgreSQL + PostGIS production schema
docs/                   ← architecture, API, threat model, retention, launch checklist, localisation
```

The engine is shared by server and browser, so the rules are enforced the same way everywhere and covered by one test suite. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Safety principles enforced in code (and tested)

| Rule | Where |
|---|---|
| One incident per SOS (idempotency key); one open incident per user | `createIncident` · AT-01 |
| Only verified + trained + available + fresh-location + not-busy volunteers are alerted | `volunteerEligibility` · AT-02 |
| 10 → 20 → 30 km expansion on persisted deadlines; survives restart | `tick` · AT-02/03, server restart test |
| Backup search continues after the first acceptance | `tick` (`targetResponders`) |
| Responder cap, atomic accept; decline/unable/stall → replacement search + escalation | AT-03/04 |
| Unassigned volunteers never receive exact coordinates; precise access is audited | `viewIncident` · AT-05 |
| Denied/stale/low-accuracy location shown honestly; GPS altitude never presented as floor; spoofed jumps flagged | AT-05 |
| Notification failure logged, fallback channel attempted | AT-06 |
| Arrival never closes; YES needs explicit confirmation; NO/more-help escalates | AT-07 |
| Unauthorised actions → 403/409 and audited; hash-chained tamper-evident audit log | AT-08 |
| Duress PIN looks cancelled but stays open & escalated; can't be closed as false alarm | duress test |

## Status & what's next

Done: functional MVP of the full SOS-to-safety workflow, four role interfaces, demo mode, tests. **Not done (needs partners, not just code):** official 112/ERSS integration, real identity-verification & background-check provider, push/SMS gateways, native Android/iOS apps for background location and hardware-button triggers, routing-based ETA, Postgres adapter, native-speaker translation review, independent security audit, DPDP Act 2023 legal review, and a controlled pilot (e.g. Kurnool). See [docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md).
