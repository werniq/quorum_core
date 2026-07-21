# Final release verification — Quorum Community

**Date:** 2026-07-21  
**Host:** Windows 10, Node v24.17.0, Docker 28.4.0  
**Package:** `quorum@0.1.0`

## Commands run

| Step           | Command                                                                                                                                  | Exit |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Clean install  | `Remove-Item -Recurse -Force node_modules; npm ci`                                                                                       | 0    |
| Full gate      | `npm run verify:self-hosted`                                                                                                             | 0    |
| Real n8n       | `npm run test:e2e:n8n:real`                                                                                                              | 0    |
| Manual Compose | `docker compose down -v --remove-orphans` then `docker compose up -d --build` with inline `QUORUM_CREDENTIAL_KEK` + `QUORUM_SETUP_TOKEN` | 0    |

## 1. Clean install + `verify:self-hosted`

**First attempt:** exit 1 at `format:check` (12 files). Fixed with `npm run format`.  
**Second attempt:** exit 1 at `lint` (2 unused imports). Fixed.  
**Third attempt:** exit 1 at `test:compose` (Docker daemon stopped). Started Docker Desktop; re-ran.

**Final `verify:self-hosted`:** exit **0**

| Stage            | Result                                                        |
| ---------------- | ------------------------------------------------------------- |
| format:check     | pass                                                          |
| lint             | pass                                                          |
| typecheck        | pass                                                          |
| test             | **246 passed**, 0 skipped (46 files)                          |
| test:integration | 5 passed                                                      |
| test:repository  | 12 passed                                                     |
| test:migrations  | 15 passed                                                     |
| test:security    | 26 passed                                                     |
| test:cov         | 42 passed; **98.92%** stmts/lines (gated domain files)        |
| build            | pass                                                          |
| test:compose     | pass (setup → login → catalog, `/readyz`, `/health/watcher`)  |
| test:restart     | pass (persistence, wrong KEK → 401, no KEK in logs)           |
| test:e2e:n8n     | pass (n8n `1.95.3`, webhook HMAC, auth, idempotency, poll UI) |

**Warnings (non-failing):**

- `npm warn Unknown env config "devdir"` on each npm invocation
- `DEP0190` child_process shell deprecation from `verify-self-hosted.mjs`
- Docker build: deprecated `prebuild-install`, `@esbuild-kit/*`, `glob@10.5.0`
- `npm audit`: 4 moderate, 1 high (dev tree)
- `test:e2e:n8n` documents that full 60s silent absence is **not** exercised in that script (see `test:e2e:n8n:real`)

**Retries:** none automated; manual re-runs after format/lint/Docker fixes only.

## 2. Clean Docker (project `docker-compose.yml`)

With env vars passed inline (not written to `.env`):

- `docker compose up -d --build` after `down -v`
- `/readyz` → `status: ready`, 16 migrations applied including `0011_schema_placeholder`
- `/health/watcher` → `status: ok`
- `/setup` and `/login` → HTTP 200
- Sampled logs: **0** matches for supplied KEK/setup token strings

`verify:self-hosted` `test:compose` also performed a **no-cache** image build in an isolated temp project (setup → login → catalog).

## 3. Real n8n validation (`test:e2e:n8n:real`)

Evidence: [payloads/real-n8n-run.json](./payloads/real-n8n-run.json)  
Image: `n8nio/n8n:1.95.3`  
Workflow pattern: `examples/n8n/quorum-signed-heartbeat.json` (Code node HMAC)

| Check                                                                     | Result                                 |
| ------------------------------------------------------------------------- | -------------------------------------- |
| n8n-authored HMAC for success/recovery/failure/empty                      | yes                                    |
| ≥2 success heartbeats → catalog Healthy + Basic                           | yes                                    |
| Invalid signature / stale timestamp / wrong workflow / revoked credential | 401                                    |
| Idempotency replay (n8n-signed)                                           | 1 row; conflict body → 409             |
| Hard failure incident                                                     | opened (`01KY24MF7M69VX1XGXSA95WN8G`)  |
| Empty-result allowed / warning / critical                                 | all behaved per policy                 |
| Poll UI + checkpoint                                                      | `last_seen_execution_id=15`            |
| Restart Quorum container                                                  | heartbeats 15→15, checkpoint unchanged |
| Invalid API key connector                                                 | `auth_failed`                          |

## 4. Silent absence (wall clock)

Cadence: 1 minute, `since_last_success`, `allowed_lateness_minutes=0`.

| Event                          | UTC timestamp              |
| ------------------------------ | -------------------------- |
| Last successful heartbeat      | `2026-07-21T10:46:32.235Z` |
| Workflow deactivated           | `2026-07-21T10:46:32.617Z` |
| Expected deadline (~last + 1m) | `2026-07-21T10:47:32.235Z` |
| `silent_absence` opened        | `2026-07-21T10:47:34.665Z` |
| Same incident resolved         | `2026-07-21T10:47:59.710Z` |

**Detection latency (last success → incident open):** ~**62.4 s** (~2.4 s after the 60 s deadline).  
**Duplicate incident after open:** none within two watcher cycles; alert deliveries counted without duplicate open incident.  
**Resolution alert:** outbox `resolved` processed; mock received delivery evidence.

## 5. Alerts, persistence, KEK

Covered inside `verify:self-hosted`:

- Webhook test + incident + resolution paths (`test:restart` with alert mock)
- Failed delivery visibility via channel health (catalog tests + real-n8n mock)
- SQLite + incidents survive process restart
- Wrong KEK restart → heartbeat 401, **no KEK printed**

## 6. UI review (this pass)

| Item                                              | Status                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Catalog expectation labels (`interval:5@UTC` raw) | fixed — cards show e.g. `Every 5 minutes (UTC)`                                             |
| Contract detail cadence subtitle                  | fixed — uses same formatter                                                                 |
| Alert banner vs summary vs card                   | consistent after prior catalog alert-health fix (see `tests/ui/catalog-product-ux.test.ts`) |
| Waiting / Paused health labels                    | present in filters and badges                                                               |
| Evidence level visible                            | badge + expandable explanation on cards                                                     |
| Workflow health vs alert health                   | separate badges                                                                             |

UI preview HTML regenerated: `node scripts/generate-ui-previews.mjs` (via `npx tsx`).

## 7. README

Rewritten in [README.md](../../README.md). Review notes: [readme-review.md](./readme-review.md).

## Decisions

| Edition                   | Decision           | Rationale                                                                                                                                          |
| ------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-hosted Community** | **CONDITIONAL GO** | `verify:self-hosted` and `test:e2e:n8n:real` green on 2026-07-21; owner 24–48 h soak still required ([manual-soak-test.md](./manual-soak-test.md)) |
| **Hosted SaaS**           | **NO-GO**          | Not shipped in this AGPL tree; Preview code removed from Community branch                                                                          |

## Files changed in this verification pass

- `README.md`
- `docs/verification/final-release-verification.md` (this file)
- `docs/verification/readme-review.md`
- `docs/verification/known-limitations.md`
- `docs/release-decision.md`
- `docs/security.md`
- `src/presentation/html/catalog-ui.ts` (export `formatExpectation`, detail subtitle)
- `tests/ui/workflow-registration-errors.test.ts` (lint)
- Prettier on 12 files from earlier edits
- `docs/verification/ui-preview/*.html` (regenerated)
- `docs/verification/payloads/real-n8n-run.json` (updated by `test:e2e:n8n:real`)
