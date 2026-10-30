# Pilot launch checklist

Done in the app: real accounts, admin bootstrap, staff authenticator enrolment, manual volunteer verification workflow, phone push alerts, consent record, backups, one-click deploy (docs/DEPLOY.md).

Still needed before a public launch:

- [ ] Formal agreement with AP Police / ERSS 112 on handoff procedure; replace SIMULATED adapter only with a confirmed integration
- [ ] Partner NGOs for volunteer recruitment, training delivery and survivor support
- [ ] Lawful ID-verification provider + background screening with consent and appeals
- [ ] Legal review: DPDP Act 2023, children's data, consent records, terms & volunteer agreement (no arbitrary fines — proportionate accountability policy)
- [ ] Native Android app (background location, hardware-button & lock-screen trigger, FCM push); iOS next
- [ ] Postgres/PostGIS store adapter, backups, encryption at rest, multi-worker scheduler
- [ ] SMS gateway fallback for volunteers without push; routing provider for real ETAs; password-reset by email/OTP
- [ ] Independent penetration test & privacy review (OWASP MASVS/ASVS)
- [ ] Native-speaker review of all 14 languages; accessibility audit with screen-reader users
- [ ] Field tests: GPS drift indoors/rural, low battery, poor network, simultaneous SOS, malicious volunteer scenarios
- [ ] Tune radii/timeouts with responders; define KPIs (time to first acknowledgement, time to responder, safe-handoff rate, false-alert rate, misconduct incidents)
- [ ] Scheduled retention purges; incident-response plan; 24×7 operator staffing
- [ ] Controlled pilot in one area (e.g. Kurnool) before expansion
