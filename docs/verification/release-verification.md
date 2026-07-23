# Release verification — Quorum Community

**Date:** 2026-07-21  
**Host:** Windows 11, Node v24.17.0, Docker 28.4.0  
**Package:** `quorum@0.1.0`

Canonical packet for the latest self-hosted Community gate. Prior cycle remediation notes and raw JSON evidence were archival only and are not retained in-tree; re-run the commands below for fresh machine evidence.

**Decisions:** Self-hosted Community **CONDITIONAL GO** (owner 24–48 h soak still required). Hosted SaaS **NO-GO**.

Related: [release-decision.md](../release-decision.md) · [known-limitations.md](../known-limitations.md)

## Commands run

| Step | Command | Exit |
| ---- | ------- | ---- |
| Clean install | `Remove-Item -Recurse -Force node_modules; npm ci` | 0 |
| Full gate | `npm run verify:self-hosted` | 0 |
| Real n8n | `npm run test:e2e:n8n:real` | 0 |
| Manual Compose | `docker compose down -v --remove-orphans` then `docker compose up -d --build` with inline `QUORUM_CREDENTIAL_KEK` + `QUORUM_SETUP_TOKEN` | 0 |

## 1. Clean install + `verify:self-hosted`

**First attempt:** exit 1 at `format:check` (12 files). Fixed with `npm run format`.  
**Second attempt:** exit 1 at `lint` (2 unused imports). Fixed.  
**Third attempt:** exit 1 at `test:compose` (Docker daemon stopped). Started Docker Desktop; re-ran.

**Final `verify:self-hosted`:** exit **0**

| Stage | Result |
| ----- | ------ |
| format:check | pass |
| lint | pass |
| typecheck | pass |
| test | **246 passed**, 0 skipped (46 files) |
| test:integration | 5 passed |
| test:repository | 12 passed |
| test:migrations | 15 passed |
| test:security | 26 passed |
| test:cov | 42 passed; **98.92%** stmts/lines (gated domain files); branches ~95.7%; functions 100% |
| build | pass |
| test:compose | pass (setup → login → catalog, `/readyz`, `/health/watcher`) |
| test:restart | pass (persistence, wrong KEK → 401, no KEK in logs) |
| test:e2e:n8n | pass (n8n `1.95.3`, webhook HMAC, auth, idempotency, poll UI) |

**Warnings (non-failing):** `npm warn Unknown env config "devdir"`; `DEP0190` child_process shell deprecation; Docker build deprecation notices; `npm audit` 4 moderate / 1 high (dev tree). Full 60 s silent absence is **not** in `test:e2e:n8n` (see `test:e2e:n8n:real` and [known-limitations.md](../known-limitations.md)).

**Retries:** none automated; manual re-runs after format/lint/Docker fixes only.

## 2. Clean Docker

With env vars passed inline (not written to `.env`):

- `docker compose up -d --build` after `down -v`
- `/readyz` → `status: ready`, 16 migrations applied including `0011_schema_placeholder`
- `/health/watcher` → `status: ok`
- `/setup` and `/login` → HTTP 200
- Sampled logs: **0** matches for supplied KEK/setup token strings

`verify:self-hosted` `test:compose` also performed a **no-cache** image build in an isolated temp project.

Entrypoints exercised: `src/main.ts` (self-hosted path), `docker-compose.yml`, `docker-compose.e2e.yml` + validation override. Graceful shutdown drains up to `SHUTDOWN_GRACE_MS` (default 10s).

## 3. Real n8n validation (`test:e2e:n8n:real`)

Machine evidence from this cycle: `ok: true`. Re-runs write `docs/verification/artifacts/real-n8n-run.json` (gitignored).

| Item | Value |
| ---- | ----- |
| n8n image | `n8nio/n8n:1.95.3` (pinned, no fallback) |
| Compose | `docker-compose.e2e.yml` + `docker-compose.e2e.validation.yml` |
| Example workflow | `examples/n8n/quorum-signed-heartbeat.json` |
| Alert destination | Host alert mock webhook (no Slack/SMTP credentials) |

**n8n-authored HMAC:** Success, recovery, hard-failure, and empty-result heartbeats were signed inside an n8n Code node (`NODE_FUNCTION_ALLOW_BUILTIN=crypto`). Host `signHeartbeat` was used only for adversarial auth cases and idempotency conflict bodies.

| Check | Result |
| ----- | ------ |
| ≥2 success heartbeats → catalog Healthy + Basic | yes |
| Invalid signature / stale timestamp / wrong workflow / revoked credential | 401 |
| Idempotency replay (n8n-signed) | 1 row; conflict body → 409 |
| Hard failure incident | opened (`01KY24MF7M69VX1XGXSA95WN8G`) |
| Empty-result allowed | no empty_result incident; `last_nonempty_success_at` unchanged |
| Empty-result warning | open empty_result severity `warning` |
| Empty-result failure | open empty_result severity `critical` |
| Poll UI + checkpoint | `last_seen_execution_id=15` |
| Restart Quorum container | heartbeats 15→15, checkpoint unchanged |
| Invalid API key connector | `auth_failed` |

## 4. Silent absence (wall clock)

Cadence: 1 minute, `since_last_success`, `allowed_lateness_minutes=0`.

| Event | UTC timestamp |
| ----- | ------------- |
| Last successful heartbeat | `2026-07-21T10:46:32.235Z` |
| Workflow deactivated | `2026-07-21T10:46:32.617Z` |
| Expected deadline (~last + 1m) | `2026-07-21T10:47:32.235Z` |
| `silent_absence` opened | `2026-07-21T10:47:34.665Z` |
| Same incident resolved | `2026-07-21T10:47:59.710Z` |
| Resolution outbox processed | `2026-07-21T10:48:04.703Z` |

**Detection latency (last success → incident open):** ~**62.4 s** (~2.4 s after the 60 s deadline).  
**Duplicate incident after open:** none within two watcher cycles.  
**Alerts (mock):** silent-absence open 2 deliveries / 2 attempts; resolution processed with attempt evidence. Renotify backoff 30 min.

## 5. Alerts, persistence, KEK

Covered inside `verify:self-hosted` / real n8n:

- Webhook test + incident + resolution paths
- Failed delivery visibility via channel health
- SQLite + incidents survive process restart
- Wrong KEK restart → heartbeat 401, **no KEK printed**

## 6. Security checks (this cycle)

Still green: JSON API tenant trust (`resolveTrustedTenantId`); metrics disabled by default.

Confirmed this pass:

| Check | Result |
| ----- | ------ |
| Force `verifyHeartbeatSignature` always true | required suites **fail** |
| Restore HMAC | suites **pass** (`tests/security/heartbeat-hmac-guards.test.ts`) |
| Ops audit (`ops_audit_events`) | covered; immutable table + secret-stripping details ([security.md](../security.md)) |
| `networkPolicy: self_hosted_local` | private HTTP n8n allowed; cloud metadata still blocked |

Remaining: single-tenant JSON APIs; hosted SaaS not in Community tree.

## 7. UI review

| Item | Status |
| ---- | ------ |
| Catalog expectation labels (`interval:5@UTC` raw) | fixed — e.g. `Every 5 minutes (UTC)` |
| Contract detail cadence subtitle | same formatter |
| Alert banner vs summary vs card | consistent (`tests/ui/catalog-product-ux.test.ts`) |
| Waiting / Paused health labels | present |
| Evidence level | badge + expandable explanation |
| Workflow health vs alert health | separate badges |

Screenshots for README: `docs/screenshots/*.png` via `npx tsx scripts/generate-ui-previews.mjs` then `node scripts/capture-readme-screenshots.mjs` (preview HTML is generated locally under `docs/verification/ui-preview/`, gitignored, not committed).

## 8. Re-running the gate

```bash
rm -rf node_modules   # or Remove-Item -Recurse -Force node_modules on Windows
npm ci
npm run verify:self-hosted
npm run test:e2e:n8n:real
```

Do not weaken or skip tests to make gates pass. Owner soak: [known-limitations.md](../known-limitations.md#owner-soak-24–48-h).
