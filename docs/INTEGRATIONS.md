# Optional server integrations

Each one is **off until its environment variables are set**, and the app works without any of them. You can see the current status in Admin → Integrations.

## Database (PostgreSQL) — recommended
`DATABASE_URL=postgres://user:password@host:5432/dbname` (add `?sslmode=require` for managed databases; this is the default for remote hosts).
Every change is also written to PostgreSQL. On start, the latest data is loaded from it, so accounts and incidents survive redeploys on hosts that wipe the disk. Works with Neon, Supabase, Render Postgres, AWS RDS and similar. The server creates its own table (`bb_state`). Without it, data lives in `DATA_FILE` on a persistent disk.

## SMS gateway (India: MSG91 with DLT)
Used for:
- SOS SMS to trusted contacts when the phone couldn't send them (iPhone, no SIM, offline);
- an SMS fallback to volunteers who haven't opened the push within 30 seconds;
- password-reset codes.

```
SMS_PROVIDER=msg91
MSG91_AUTH_KEY=...
MSG91_TEMPLATE_SOS=...      # "{#var#} needs help. Live location: {#var#} - Beti Bachao"
MSG91_TEMPLATE_ALERT=...    # "SOS {#var#} km from you. Open Beti Bachao to respond."
MSG91_TEMPLATE_OTP=...      # "Your Beti Bachao code is {#var#}. Valid 10 minutes."
MSG91_TEMPLATE_VERIFY=...   # "Your volunteer verification call is at {#var#}. Keep your Aadhaar ready."
```
India requires a DLT registration (sender ID + templates) with an operator portal (Jio, Airtel, Vi, BSNL) before any SMS is delivered. Outside India: `SMS_PROVIDER=twilio`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.

## Phone push
- Android: `FCM_SERVICE_ACCOUNT` (see [MOBILE_APPS.md](MOBILE_APPS.md)).
- iPhone/iPad: `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID` (+ `APNS_SANDBOX=1` for development builds).
- Browsers: Web Push works automatically (VAPID keys are generated on the first start).

## Road-route ETA (OSRM)
`ROUTING_URL=https://your-osrm-server` (self-host OSRM with the India extract from Geofabrik, about 8 GB RAM). Volunteers' ETAs then follow real roads, refreshed every 30 s. Without it, the app uses a straight-line estimate.

## Local AI — Colibri (free, runs on your own server)
`AI_BASE_URL=http://your-colibri-host:PORT/v1` (any OpenAI-compatible server), and optionally `AI_MODEL` and `AI_API_KEY`.
- **Operator assistant**: a one-tap summary of an open SOS with suggested next steps.
- **Translate**: notes and abuse reports, into the operator's language.
- **Fake-SOS & abuse flags**: a risk badge on abuse reports and SOS notes.

**Safety rules (enforced in code):** the AI is *advisory only* and never sits in the SOS path. An SOS is dispatched the same way whether the AI is up, slow or off. The AI is never sent coordinates or phone numbers. Every AI output is labelled as such in the console.
For hardware, follow Colibri's `docs/AI_SETUP.md`: a 7–8B model in 4-bit fits in 16 GB RAM on CPU, and a GPU makes summaries near-instant. The women's and volunteers' apps never call the AI.

## Encrypted backups
On by default: an encrypted backup is written daily to `BACKUP_DIR` (default: next to the data file), keeping `BACKUP_KEEP=14`. Set `BACKUP_KEY` (64 hex characters, from `openssl rand -hex 32`) and **keep it safe**: backups are AES-256-GCM encrypted with it. `BACKUP_DIR=off` disables them.
