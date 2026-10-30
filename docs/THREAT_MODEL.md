# Threat model (MVP)

| Threat | Mitigation in MVP | Still needed |
|---|---|---|
| Stalker registers as volunteer to locate a woman | Alerts only to verified+trained volunteers; unassigned see ≈2 km area only; precise access audited; one active assignment per volunteer; admin suspension | Real ID + background checks, anomaly detection on accept patterns, periodic re-verification |
| Abuser forces victim to cancel | Cancel PIN; **duress PIN** silently escalates; YES during duress doesn't close; duress can't be closed as false alarm | Covert operator call-back protocol with partners |
| Fake/spoofed GPS | Implied-speed outlier detection beyond accuracy circles; suspect points excluded from matching and shown to ops | Device integrity attestation (Play Integrity / App Attest) in native apps |
| SOS spam / false alarms | Rate limits per user (6/h) and per route; FALSE_ALARM_REVIEW state; abuse reports | Reputation & graduated sanctions |
| Session theft / CSRF / XSS | HttpOnly SameSite=Strict cookies, CSRF header, strict CSP (no inline script/style), output escaping, no third-party scripts | Independent penetration test (OWASP MASVS/ASVS) |
| Operator/admin account takeover | TOTP MFA, audit of all admin actions | Hardware keys, IP allow-listing, just-in-time access |
| Log tampering | SHA-256 hash-chained append-only audit; integrity check in admin | Write-once external log sink |
| Location data leakage via logs/events | SSE events carry no payload; audit metadata excludes coordinates | Encryption at rest (DB/KMS), field-level encryption |
| False sense of safety | SIMULATED label on every escalation; arrival ≠ safe; ETA labelled estimate; floor never inferred from GPS | Field-tested accuracy figures before any claims |
| Server outage during SOS | PWA offline shell; idempotent queued SOS; SMS & call always available | Multi-region deployment, SMS fallback gateway |
