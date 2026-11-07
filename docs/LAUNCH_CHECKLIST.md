# Pilot launch checklist

Done in the app:
- real accounts, admin bootstrap and staff authenticator enrolment;
- volunteer approval by **Aadhaar video call** (masked last-4 only), with no access before approval;
- native **Android and iPhone/iPad apps**: background location, tile/widget/power-button/Siri triggers, auto SMS on Android, FCM + APNs alarm push;
- SMS gateway (MSG91/Twilio) with a 30 s volunteer fallback and SMS-code password reset;
- OSRM road ETAs; PostgreSQL storage; encrypted daily backups;
- responder ratings and misconduct reviews;
- advisory local AI (Colibri) for operators;
- consent record; one-click deploy (docs/DEPLOY.md).

Still needed before a public launch:

- [ ] Formal agreement with AP Police / ERSS 112 on handoff procedure; replace SIMULATED adapter only with a confirmed integration
- [ ] Partner NGOs for volunteer recruitment, training delivery and survivor support
- [ ] Written SOP for the Aadhaar video call (no screenshots/recording, two-person review for rejections, appeal route); police background checks intentionally not used
- [ ] Legal review: DPDP Act 2023, children's data, consent records, terms & volunteer agreement (no arbitrary fines — proportionate accountability policy)
- [ ] Play Console: signing keystore, SMS / background-location / full-screen-intent permission declarations, Data safety form
- [ ] Apple Developer account, APNs key, TestFlight build, App Review notes for background location
- [ ] Firebase project (`GOOGLE_SERVICES_JSON` + `FCM_SERVICE_ACCOUNT`); DLT registration + MSG91 templates; `DATABASE_URL`; `BACKUP_KEY` stored offline
- [ ] Multi-worker scheduler / PostGIS tables if one server is no longer enough
- [ ] Independent penetration test & privacy review (OWASP MASVS/ASVS)
- [ ] Native-speaker review of all 14 languages; accessibility audit with screen-reader users
- [ ] Field tests: GPS drift indoors/rural, low battery, poor network, simultaneous SOS, malicious volunteer scenarios
- [ ] Tune radii/timeouts with responders; define KPIs (time to first acknowledgement, time to responder, safe-handoff rate, false-alert rate, misconduct incidents)
- [ ] Scheduled retention purges; incident-response plan; 24×7 operator staffing
- [ ] Controlled pilot in one area (e.g. Kurnool) before expansion
