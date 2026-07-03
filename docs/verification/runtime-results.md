# Runtime results

Updated 2026-07-19 after final real n8n pre-release validation.

## Entrypoints

| Entrypoint                                       | Role                                                                        | Posture                                           |
| ------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------- |
| `src/main.ts`                                    | Self-hosted SQLite + UI + ingest + watcher + outbox + poll + graceful drain | Design-partner GO path                            |
| `src/main-saas.ts`                               | Hosted Postgres smoke                                                       | Preview / NO-GO                                   |
| `docker-compose.yml`                             | Self-hosted stack                                                           | Clean Compose black-box **passed**                |
| `docker-compose.e2e.yml` (+ validation override) | Quorum + n8n 1.95.3 + alert-mock                                            | `test:e2e:n8n` and `test:e2e:n8n:real` **passed** |

## Commands exercised this session

| Command                      | Result                                                      |
| ---------------------------- | ----------------------------------------------------------- |
| `npm ci`                     | exit 0                                                      |
| `npm run test:e2e:n8n`       | exit 0 (n8n-signed webhook push; no host-signed happy path) |
| `npm run test:e2e:n8n:real`  | exit 0 (full matrix; evidence JSON)                         |
| `npm run verify:self-hosted` | **exit 0** (all stages including `test:e2e:n8n`)            |

Unit stage from prior green partial run: **219** tests in `npm run test` (44 files). Domain coverage gate (`test:cov`): statements **98.92%**, branches **95.65%**, functions **100%**, lines **98.92%**.

## Graceful shutdown

- `createGracefulShutdownController` drains in-flight work up to `SHUTDOWN_GRACE_MS` (default 10s)
- Tests: `tests/runtime/graceful-shutdown.test.ts`

## Restart persistence

- `npm run test:restart` **passed**
- Real poll path: Quorum restart kept poll checkpoint and did not duplicate imports (`heartbeats` 16→16)

## n8n

- Push: n8n Code node HMAC confirmed in `test:e2e:n8n:real`
- Silent absence: real ~62 s detection latency at 1-minute cadence
- Poll: UI connector create + workflow bind + checkpoint + restart + invalid key health

## Hosted

- Unchanged Preview / NO-GO
