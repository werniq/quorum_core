# Self-hosted remediation report

Date: 2026-07-19  
Baseline: CONDITIONAL GO (design partners); hosted SaaS NO-GO / Preview

## 1. Baseline status

- `npm run release:check` was green before remediation (203 unit tests in an earlier window).
- Gaps: no `format:check`, no CI workflow, incomplete Compose / n8n / restart black-box automation, inconclusive HMAC mutation, incomplete audit coverage, waiting stored as `ignored`, shutdown without drain.

## 2. Files changed (high level)

- Prettier: `.prettierrc.json`, `.prettierignore`, `package.json` scripts
- CI: `.github/workflows/ci.yml`
- Migrations: `0014_reconciliation_waiting_status`, `0015_ops_audit_events` (sqlite + postgres + journals)
- Runtime: `graceful-shutdown.ts`, `main.ts` (drain + `self_hosted_local` poll policy)
- Security: `secure-outbound-http.ts` network policy
- Audit wiring: ops audit repos + UI/credential/connector/alert paths; heartbeat resolve via `resolveIncident`
- Scripts: `scripts/verify-*.mjs` (+ `.sh` wrappers), `docker-compose.e2e.yml`
- Tests: ops-audit, hmac-guards, graceful-shutdown, connector network, waiting persistence
- Docs: verification packet + this report

## 3. Formatting result

- `npm run format:check` exists and passes.
- Mutation: introducing a formatting defect fails the check; restored.
- Wired into `release:check` as the first stage.

## 4. CI workflow result

- Added `.github/workflows/ci.yml` (PR/push static gates; Compose/n8n on main/tags/nightly/dispatch).
- Locally validated YAML parse (`js-yaml` / Python).
- Not claimed as executed on GitHub Actions.

## 5. Clean Compose result

- `npm run test:compose` **passed** (exit 0) after Docker Desktop was running.
- Stages: clean tree copy, build, readiness, setup, login, `/catalog`, health endpoints, cleanup.

## 6. Real n8n push result

- `npm run test:e2e:n8n` with pinned `n8nio/n8n:1.95.3` and real Quorum container.
- Invalid signature, idempotency, hard-failure, empty-result exercised against real Quorum.
- n8n-authored Code-node push may fall back to host-signed HMAC when API key / execute API is unavailable on the pinned build (documented in `n8n-e2e-limitations.md`). Containers are still real.

## 7. Real n8n polling result

- Self-hosted `networkPolicy: "self_hosted_local"` allows compose-internal `http://n8n:5678` (metadata still blocked).
- E2E creates connector + poll workflow; bound-poll ingest / checkpoint / two-worker claims remain covered by `tests/n8n/*`.
- See limitations doc for UI connector bind gaps.

## 8. Restart persistence result

- `npm run test:restart` **passed** (exit 0): setup, protect flow, incident, SIGTERM, same DB+KEK restore, resolve, wrong-KEK rejection without printing KEK.

## 9. Graceful shutdown result

- `createGracefulShutdownController` stops new timer work, awaits in-flight up to `SHUTDOWN_GRACE_MS` (default 10s), then closes; forced exit documented on grace exceed.
- `tests/runtime/graceful-shutdown.test.ts` passes.

## 10. HMAC mutation result

| Mutation                                 | Command                                         | Result                          |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------- |
| `verifyHeartbeatSignature` always `true` | `vitest` hmac-guards + security-and-concurrency | **Failed** (exit 1) as required |
| Restored                                 | same                                            | **Passed** (exit 0)             |

## 11. Audit coverage result

- `ops_audit_events` + immutable triggers; matrix in `docs/verification/audit-coverage-matrix.md`.
- `tests/security/ops-audit-coverage.test.ts` passes.

## 12. Reconciliation waiting-state result

- DB CHECK includes `waiting`; historical `ignored` → `waiting`.
- Persistence no longer remaps waiting→ignored.
- UI shows Waiting count / label.
- Tests cover waiting→matched and waiting→missing.

## 13. Full command results

| Command                    | Exit                                                              |
| -------------------------- | ----------------------------------------------------------------- |
| `npm run format:check`     | 0                                                                 |
| `npm run lint`             | 0 (after unused-import fix)                                       |
| `npm run typecheck`        | 0                                                                 |
| `npm test`                 | 0 — **43** files, **218** tests                                   |
| `npm run test:integration` | 0 — 5 tests                                                       |
| `npm run test:repository`  | 0 — 12 tests                                                      |
| `npm run test:migrations`  | 0 — 15 tests                                                      |
| `npm run test:security`    | 0 — 26 tests                                                      |
| `npm run test:cov`         | 0 — 42 tests; **98.92%** stmts / **95.68%** branch                |
| `npm run build`            | 0                                                                 |
| `npm run release:check`    | **0**                                                             |
| `npm run test:restart`     | **0**                                                             |
| `npm run test:compose`     | **0**                                                             |
| `npm run test:e2e:n8n`     | **0** (with documented limitations; one retry after port cleanup) |

## 14. Remaining limitations

- Heartbeat ≠ destination proof; HubSpot→Zoom Preview; Zapier/Make Planned; hosted SaaS Preview/NO-GO.
- Metrics off by default.
- n8n e2e may use host-signed push when n8n API key/execute is unavailable.
- Poll UI connector bind incomplete; unit tests cover scheduler claims.
- Silent-absence full 60s wait not in e2e budget.

## 15. Updated release decision

- **Self-hosted design partners: GO** when `npm run verify:self-hosted` is green on a machine with Docker, with published limitations accepted.
- **Hosted SaaS: NO-GO** (unchanged Preview).
- Not broad GA.
