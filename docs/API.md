# API v1

Base `/api/v1`. JSON. Errors: `{ "error": { "code", "message" } }`. All non-GET requests require header `X-BB-CSRF: 1`. Auth via `bb_session` cookie.

| Method | Path | Role | Notes |
|---|---|---|---|
| GET | /health, /public-config | public | |
| POST | /auth/register | public | user/volunteer only; `consent:true` required; password 10+; 20/h/IP |
| POST | /auth/login | public | staff: `{mfaEnroll:{secret,otpauthUri}}` on first login, then `{mfaRequired:true}` until `mfaCode` sent |
| POST | /auth/logout · GET /me | any | |
| PATCH | /me/pins | user | `{cancelPin, duressPin?}` 4–6 digits |
| GET | /me/incidents · /me/export · DELETE /me | user/volunteer | |
| POST | /incidents | user | `{idempotencyKey, location?, severity, trigger, silent, battery}` → 201 (200 on duplicate) |
| GET | /incidents/:id · /incidents/:id/timeline | scoped | role-filtered |
| POST | /incidents/:id/locations | requester | `{lat,lng,accuracyM,observedAt,source,altitudeM?,verticalAccuracyM?,userFloor?}` |
| POST | /incidents/:id/cancel | requester | `{pin}` or `{confirm:true}` |
| POST | /incidents/:id/safety-confirmation | requester | `{response: YES|NO|NEED_MORE_HELP, confirm}` |
| POST | /incidents/:id/escalations | requester / assigned volunteer / ops | |
| POST | /incidents/:id/accept · /decline | alerted volunteer | |
| POST | /assignments/:id/status | assigned volunteer | `EN_ROUTE|ARRIVED|ASSISTING|UNABLE` |
| GET/PATCH | /volunteer/profile · /volunteer/availability | volunteer | |
| POST | /volunteer/training · /volunteer/verification | volunteer | mock provider |
| GET | /volunteer/alerts | volunteer | |
| POST | /abuse-reports | any | |
| GET | /operator/incidents?all=1 | operator/admin | |
| POST | /operator/incidents/:id/reassign · /handoff · /closure-exception | operator/admin | reasons required |
| GET/PATCH | /admin/config | admin (GET also operator) | validated |
| GET | /admin/volunteers · /admin/abuse-reports · /admin/audit-events · /admin/integrations | admin | |
| POST | /admin/volunteers/:id/review · /admin/abuse-reports/:id/resolve | admin | |
| GET | /events | any | SSE |
| POST | /me/push-subscriptions | any | Web Push subscription (validated) |
| GET/POST | /admin/staff · /admin/staff/:id/status | admin | add operators/admins (temp password, 12+ chars); suspend/reactivate |
| GET | /admin/backup | admin | full data export (no sessions), audited |
