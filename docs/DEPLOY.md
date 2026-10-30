# Deploying Beti Bachao for real use

Beti Bachao needs its **server running all the time**: it holds accounts, runs the 10 → 20 → 30 km search timers, and sends phone alerts to volunteers. GitHub Pages cannot do that, so the GitHub Pages link only shows emergency numbers.

## Option A — Render (easiest, about 10 minutes)

1. Open **https://render.com/deploy?repo=https://github.com/vjitintech/Beti-Bachao** and sign in with GitHub.
2. Render reads `render.yaml` and shows one web service (`beti-bachao`, Singapore region, Starter plan, 1 GB disk).
3. Fill in the two secret values:
   - `ADMIN_EMAIL`: your email (first admin account)
   - `ADMIN_PASSWORD`: a strong password, **12+ characters**
4. Click **Apply**. When the deploy is "Live", Render gives you an address like `https://beti-bachao.onrender.com`. This is the app link to share.
5. Open that link → **Log in** with the admin email and password → the app shows a **two-step login key**. Add it in an authenticator app (Google Authenticator, Microsoft Authenticator…) and type the 6-digit code.
6. **Admin → Operators → Add operator** for each person who will watch the operations console. They set up their own authenticator at first login.
7. Optional: add your own domain in Render → Settings → Custom domains.

**Cost:** the Starter plan plus the disk is a small monthly fee (check Render's current pricing). Do **not** use the free plan: it sleeps when idle, so the first SOS after a quiet period could wait about a minute, and it has no disk, so accounts would be lost on every restart.

## Option B — any Docker host (Railway, Fly.io, a VPS)

```bash
docker build -t beti-bachao .
docker run -d --restart=always -p 8080:8080 -v beti-data:/data \
  -e ADMIN_EMAIL=you@example.org -e ADMIN_PASSWORD='a-long-password' \
  -e TRUST_PROXY=true beti-bachao
```

Put it behind HTTPS (a reverse proxy such as Caddy or NGINX, or the platform's TLS). **HTTPS is mandatory**: browsers only allow location, notifications and the installable app on HTTPS. Mount `/data` on a persistent volume and run **exactly one instance**.

## After launch

- **Volunteers** register → finish 5 training modules → **Request verification** (they enter a phone number). The admin calls them, checks ID on a video call or in person, then **Admin → Volunteers → Approve**. Never ask volunteers to upload ID documents.
- **Volunteers must tap "Go on duty" and enable alerts** (🔔). On iPhone they must first **Share → Add to Home Screen** and open the app from there (iOS 16.4+) for alerts to work.
- **Women** register with **"I need safety"**, add trusted contacts, and set Cancel/Duress PINs in Settings.
- **Backups:** Admin → Integrations → **Download backup**, daily during the pilot. Store copies encrypted.
- **Updates:** pushing to `main` on GitHub redeploys on Render automatically. Run `node scripts/version.mjs` before pushing changes to `public/` so phones load fresh files.
- Tell Claude the live link and it can put it on the GitHub Pages page.

## What the app does and doesn't do

| Does | Doesn't (yet) |
|---|---|
| Real accounts, verified volunteers, staged 10/20/30 km search, live tracking, operator console | Contact police/ambulance automatically. Operators phone 112 and record the handoff |
| Phone push alerts (Android Chrome; iPhone when installed to Home Screen) | Send SMS automatically. The woman's own SMS app opens pre-filled; she taps Send |
| Works in any modern mobile browser and installs like an app | Background GPS or a power-button SOS. Those need a native Android/iOS app |
| Single server with a data file on a persistent disk | Scale to multiple servers. Move to PostgreSQL (`db/migrations/001_init.sql`) before a large rollout |
