# Data retention plan (proposal — needs legal review, incl. India DPDP Act 2023)

| Data | Retention | Notes |
|---|---|---|
| Precise incident locations | 30 days after closure, then deleted (keep only city-level) | Purged immediately on account deletion |
| Responder location trail | 7 days after closure | |
| Incident skeleton (status, timestamps, transitions) | 3 years | Needed for accountability; pseudonymised on account deletion |
| Audit events | 3 years, append-only | No coordinates stored |
| Verification records | Provider reference token only; no ID images stored | Expiry 12 months → re-verify |
| Evidence recordings | On user's device only | Never uploaded in MVP |
| Trusted contacts, PIN-free prefs | On user's device only | |
| Sessions | 12 h | |
MVP implements: account deletion (purges precise location history, anonymises user), data export. Scheduled purge jobs are a launch-checklist item.
