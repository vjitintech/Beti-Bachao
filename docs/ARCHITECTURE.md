# Architecture

Modular monolith. One engine (`public/core/engine.js`) holds every safety rule and is used by:

- **Node server** (`server/server.js`) — authoritative in real deployments. Sessions (HttpOnly, SameSite=Strict cookies), scrypt passwords, TOTP MFA for operator/admin, CSRF header check, per-route rate limits, strict CSP/security headers, SSE realtime, 1 s durable scheduler, atomic JSON persistence.
- **Standalone browser host** (`public/js/api.js` → `StandaloneApi`) — demo only, for static hosting.

## Incident state machine

```mermaid
stateDiagram-v2
  [*] --> CREATED
  CREATED --> ALERTING_10KM: location ok
  CREATED --> LOCATION_UNAVAILABLE: no location (+ escalation)
  LOCATION_UNAVAILABLE --> ALERTING_10KM: location arrives
  ALERTING_10KM --> ALERTING_20KM: timeout, < target responders
  ALERTING_20KM --> ALERTING_30KM: timeout
  ALERTING_30KM --> NO_RESPONDER_AVAILABLE: timeout (+ escalation)
  ALERTING_10KM --> RESPONDER_ASSIGNED: accept
  ALERTING_20KM --> RESPONDER_ASSIGNED: accept
  ALERTING_30KM --> RESPONDER_ASSIGNED: accept
  NO_RESPONDER_AVAILABLE --> RESPONDER_ASSIGNED: late accept
  RESPONDER_ASSIGNED --> EN_ROUTE
  EN_ROUTE --> ARRIVED
  ARRIVED --> ASSISTANCE_IN_PROGRESS
  RESPONDER_ASSIGNED --> RESPONDER_CANCELLED: unable / removed
  RESPONDER_CANCELLED --> ALERTING_10KM: replacement search
  note right of ESCALATION_REQUIRED: reachable from any open state\n(user NO / need help / danger,\nstall, duress, operator)
  ESCALATION_REQUIRED --> EMERGENCY_HANDOFF: operator records handoff
  ASSISTANCE_IN_PROGRESS --> SAFE_CONFIRMED: user YES + confirm
  EMERGENCY_HANDOFF --> CLOSED: operator closure exception
  ESCALATION_REQUIRED --> CLOSED: operator closure exception
  SAFE_CONFIRMED --> CLOSED
  CREATED --> USER_CANCELLED: correct PIN
  USER_CANCELLED --> FALSE_ALARM_REVIEW
  FALSE_ALARM_REVIEW --> CLOSED
```

`incident.status`, `searchStage`, assignment status and `escalationStatus` are separate fields. Every transition stores actor, time, reason and source, and writes an audit event. Rejected transitions return 409 and are audited.

**Duress PIN** → status `ESCALATION_REQUIRED`, `duress=true`, simulated escalation; the requester's view is masked as `USER_CANCELLED`.

## Durable timers
Each open incident stores `stageDeadline`. The scheduler calls `engine.tick()` every second, which compares deadlines with the clock; because the deadline is persisted, a restart resumes correctly (tested). With Postgres, run the tick under `SELECT … FOR UPDATE SKIP LOCKED` for multiple workers.

## Realtime
`GET /api/v1/events` (SSE). Events carry only `{seq, type, incident_id, timestamp}`; clients refetch a role-filtered snapshot, so no location ever travels in an event. `Last-Event-ID` replays missed events.

## Privacy filter (`viewIncident`)
| Viewer | Gets |
|---|---|
| Requester | full own incident, anonymised responders ("Verified volunteer A"), distance bands, approx ETA |
| Alerted volunteer | distance band, ≈2 km grid area, severity, status — **no coordinates** |
| Assigned volunteer | precise location, accuracy/age, vertical honesty note, battery, navigation link (access audited, throttled to 1/min) |
| Operator/admin | everything incl. history, suspect flags, responder positions (audited) |
