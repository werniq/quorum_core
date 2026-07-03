# Final real n8n validation

Date: 2026-07-19  
Command: `npm run test:e2e:n8n:real`  
Evidence: `docs/verification/payloads/real-n8n-run.json`  
Exit: **0** (`ok: true`)

## Environment

| Item              | Value                                                                          |
| ----------------- | ------------------------------------------------------------------------------ |
| Quorum package    | `0.1.0`                                                                        |
| n8n image         | `n8nio/n8n:1.95.3` (pinned, no fallback)                                       |
| Docker Engine     | 28.4.0                                                                         |
| Host OS           | Windows 10 (win32 10.0.26200)                                                  |
| Compose           | `docker-compose.e2e.yml` + `docker-compose.e2e.validation.yml`                 |
| Example workflow  | `examples/n8n/quorum-signed-heartbeat.json`                                    |
| Alert destination | Compose `alert-mock:8080` webhook (local). No Slack/SMTP credentials provided. |

## n8n-authored HMAC

**Yes.** Success, recovery, hard-failure, and empty-result heartbeats were signed inside an n8n Code node (`require('crypto')` with `NODE_FUNCTION_ALLOW_BUILTIN=crypto`). Host only POSTed the n8n webhook path. Host `signHeartbeat` was used only for adversarial auth cases (invalid/stale/revoked/wrong-workflow) and for the idempotency conflict body.

Push result: ≥2 non-empty success heartbeats persisted; catalog showed Healthy + Basic evidence.

## Silent absence (wall clock)

Cadence: interval 1 minute, `since_last_success`, `allowed_lateness_minutes=0`.

| Event                                  | Timestamp (UTC)                                               |
| -------------------------------------- | ------------------------------------------------------------- |
| Last successful heartbeat              | `2026-07-19T15:26:34.899Z`                                    |
| Expected deadline (lastSuccess + 1m)   | `2026-07-19T15:27:34.899Z`                                    |
| Workflow deactivated / silence started | `2026-07-19T15:26:36.765Z`                                    |
| `silent_absence` incident opened       | `2026-07-19T15:27:37.129Z`                                    |
| First open alert delivery evidence     | outbox processed + `notification_attempts` count 1 after open |
| Same incident resolved                 | `2026-07-19T15:28:05.200Z`                                    |
| Resolution outbox row processed        | `2026-07-19T15:28:07.169Z`                                    |

Detection latency (last success → incident open): **~62.2 s** (≈2.2 s after the 60 s deadline).

After open: two watcher cycles with no duplicate open incident and no immediate duplicate alert (renotify backoff 30 min).

## Hard failure

n8n Code signed `status: "failure"`. Incident `hard_failure` opened immediately (no cadence wait). Incident id in evidence: `01KXXFVWH70AMC28R05000D2J4`.

## Empty-result policies

Mutated `empty_result_policy` via SQL (Protect UI defaults to `allowed`), then n8n-signed zero-item successes:

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

Rejected requests did not leave the contract Healthy via adversarial paths.

## Polling product flow

UI forms used:

1. `POST /connectors/n8n` (base URL `http://n8n:5678` + API key)
2. Protect poll contract + `POST /workflows/:id/connector` bind
3. Runtime poll produced checkpoint `last_seen_execution_id=16`
4. Quorum container restart: heartbeat count unchanged (16→16), checkpoint unchanged
5. Connector disable via UI
6. Invalid API key connector health: `auth_failed`

**Label: Available** for self-hosted (UI bind path exists and was exercised).

## Alerts

Local webhook mock on the compose network received deliveries. Open path: outbox processed + attempts. Resolution: `notification_outbox` row with `event_type=resolved` and `processed_at` set. Slack/SMTP not tested (no owner credentials).

## Stability snapshot (short session)

After the full matrix: `/readyz` 200, open incidents 0, pending outbox 0, failed attempts 0, 31 heartbeat events. This is not a 24–48 h soak.

## Problems found and fixes made during this validation

1. `format:check` failed on unformatted docs/scripts → Prettier write.
2. `test:e2e:n8n` raced `/healthz` before n8n REST was ready → `waitForN8nRestReady`.
3. n8n activate via PATCH returned 405 → prefer `POST .../activate`.
4. HTTP node JSON re-encoding broke HMAC → send exact `bodyRaw`.
5. Resolution assert required mock count bump → accept `resolved` outbox row.
6. Second Protect client reused the default name → unique `clientName` per protect call.
7. Script syntax break after a sleep edit → restored `hbCountAfterRestart` query.

## Remaining manual checks

See `docs/verification/manual-owner-checklist.md` and `docs/verification/manual-soak-test.md`.
