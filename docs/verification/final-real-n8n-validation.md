# Final real n8n validation

Date: 2026-07-21  
Command: `npm run test:e2e:n8n:real`  
Evidence: `docs/verification/payloads/real-n8n-run.json`  
Exit: **0** (`ok: true`)

## Environment

| Item              | Value                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| Quorum package    | `0.1.0`                                                                      |
| n8n image         | `n8nio/n8n:1.95.3` (pinned, no fallback)                                     |
| Docker Engine     | 28.4.0                                                                       |
| Host OS           | Windows 10 (win32 10.0.26200)                                                |
| Compose           | `docker-compose.e2e.yml` + `docker-compose.e2e.validation.yml`               |
| Example workflow  | `examples/n8n/quorum-signed-heartbeat.json`                                  |
| Alert destination | Host alert mock (`host.docker.internal`) webhook. No Slack/SMTP credentials. |

## n8n-authored HMAC

**Yes.** Success, recovery, hard-failure, and empty-result heartbeats were signed inside an n8n Code node (`require('crypto')` with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`). Host only POSTed the n8n webhook path. Host `signHeartbeat` was used only for adversarial auth cases and idempotency conflict bodies.

Push result: ≥2 non-empty success heartbeats persisted; catalog showed Healthy + Basic evidence.

## Silent absence (wall clock)

Cadence: interval 1 minute, `since_last_success`, `allowed_lateness_minutes=0`.

| Event                                  | Timestamp (UTC)            |
| -------------------------------------- | -------------------------- |
| Last successful heartbeat              | `2026-07-21T10:46:32.235Z` |
| Expected deadline (lastSuccess + 1m)   | `2026-07-21T10:47:32.235Z` |
| Workflow deactivated / silence started | `2026-07-21T10:46:32.617Z` |
| `silent_absence` incident opened       | `2026-07-21T10:47:34.665Z` |
| Same incident resolved                 | `2026-07-21T10:47:59.710Z` |
| Resolution outbox processed            | `2026-07-21T10:48:04.703Z` |

Detection latency (last success → incident open): **~62.4 s** (~2.4 s after the 60 s deadline).

After open: no duplicate open incident within two watcher cycles; renotify backoff 30 min.

## Hard failure

n8n Code signed `status: "failure"`. Incident `hard_failure` opened immediately. Incident id: `01KY24MF7M69VX1XGXSA95WN8G`.

## Empty-result policies

n8n-signed zero-item successes after SQL policy changes:

| Policy    | Result                                                                   |
| --------- | ------------------------------------------------------------------------ |
| `allowed` | No empty_result incident; `last_nonempty_success_at` unchanged           |
| `warning` | Open empty_result with severity `warning`; nonempty timestamp unchanged  |
| `failure` | Open empty_result with severity `critical`; nonempty timestamp unchanged |

## Authentication and idempotency

| Case                                                 | Result           |
| ---------------------------------------------------- | ---------------- |
| Invalid signature                                    | 401              |
| Stale timestamp                                      | 401              |
| Credential for another workflow                      | 401              |
| Revoked credential                                   | 401              |
| Same idempotency key + same body (n8n-signed replay) | 1 heartbeat row  |
| Same idempotency key + different body                | 409; still 1 row |

## Polling product flow

1. `POST /connectors/n8n` (base URL `http://n8n:5678` + API key)
2. Protect poll contract + workflow connector bind
3. Checkpoint `last_seen_execution_id=15`
4. Quorum container restart: heartbeat count 15→15, checkpoint unchanged
5. Connector disable; invalid API key → `auth_failed`

## Alert delivery (mock)

Silent-absence open: 2 mock deliveries / 2 attempts. Resolution: processed `resolved` outbox + 1 attempt row. Full counts in payload JSON.
