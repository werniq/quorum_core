# Known limitations

Updated 2026-07-31 after Community beta.5 verification ([release-verification.md](./verification/release-verification.md)).

## Product scope

1. Heartbeat and volume-band evidence can be self-reported. They do not independently prove destination delivery.
2. Heartbeat evidence proves a signed execution report arrived. It does not prove destination delivery.
3. Volume-band checks use heartbeat-reported `items_processed` only. They remain Basic evidence and do not prove destination correctness or independent delivery.
4. HubSpot webinar registrations → Zoom webinar registrants is the only named outcome path, and it remains **Preview**. For that path, Quorum independently verifies supported business outcomes and identifies records that failed to reach their destination. Do not generalize to every n8n workflow.
5. Zapier and Make are **Planned** only.
6. Public copy must not claim general outcome verification across the entire n8n estate.
7. Volume rules are created in the data model and evaluated by the watcher. There is no Protect-wizard step for volume rules yet.
8. Incident triage fields exist in the database and repositories. Full triage UI is not complete.
9. Hosted multi-tenant SaaS, Stripe checkout, and agency billing are **not** in the Community Apache-2.0 tree. Hosted production remains **NO-GO**.

## Runtime and ops

10. CI workflow exists at `.github/workflows/ci.yml`. Master pushes run `static-and-tests` and `compose-and-e2e`; latest green runs are linked from [release-verification.md](./verification/release-verification.md).
11. `npm run format:check` is part of `release:check` / `verify:self-hosted`.
12. Local unit + coverage gates passed on 2026-07-31 (`npm test` 322; `test:cov` ≥90%). Full `verify:self-hosted` / Compose path is exercised on CI and was green for the empty-result and beta-kit pushes.
13. Graceful shutdown drains in-flight work up to `SHUTDOWN_GRACE_MS` (default 10s), then may force exit.
14. n8n `/healthz` can succeed while migrations still run; verification scripts wait for `/rest/settings` JSON before owner setup.

## n8n e2e: short vs real

Pinned image: `n8nio/n8n:1.95.3`. The shorter suite may fall back to `n8nio/n8n:1.84.0` for pull only; `npm run test:e2e:n8n:real` pins **1.95.3 with no fallback**.

| Area                         | Short `test:e2e:n8n`                                                                                                                                                                                                                                                                                                                                                                                                           | Real `test:e2e:n8n:real`                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Happy-path HMAC              | Crypto Hash + HMAC nodes ([examples/n8n/quorum-signed-heartbeat.json](../examples/n8n/quorum-signed-heartbeat.json); setup-node CONFIG + Crypto typeVersion 1 Secret in UI, Crypto credentials preferred on n8n ≥ 2.7). Polling (URL + API key) is the easiest path with no workflow changes. E2e harness may still sign via Code node + `NODE_FUNCTION_ALLOW_BUILTIN=crypto` (legacy). **No host-signed happy-path fallback** | Same; requires n8n-authored signing for push                                       |
| Silent absence               | Full quiet-window wait (≥1 minute) is **not** in the default budget                                                                                                                                                                                                                                                                                                                                                            | Wall-clock wait; detection latency ~62 s for 1-minute cadence (2026-07-21)         |
| Empty-result failure         | Protect UI hardcodes `emptyResultPolicy: "allowed"`; asserts allowed                                                                                                                                                                                                                                                                                                                                                           | Mutates SQL for warning/failure policies                                           |
| Poll bind / restart          | Limited bind coverage                                                                                                                                                                                                                                                                                                                                                                                                          | UI bind (`POST /workflows/:id/connector`), checkpoint, Quorum restart              |
| Two-worker claim exclusivity | Not practical in single-compose e2e                                                                                                                                                                                                                                                                                                                                                                                            | Covered by `tests/security/worker-concurrency.test.ts` / poll-scheduler unit tests |

When a pinned-version API action cannot be completed, the shorter e2e prints `[limitation] ...` on stderr. It does **not** mock n8n or Quorum responses. Narrative results: [release-verification.md](./verification/release-verification.md). Re-runs of the real script write `docs/verification/artifacts/real-n8n-run.json` (gitignored).

Self-hosted poll uses `networkPolicy: "self_hosted_local"` so compose-internal `http://n8n:5678` is allowed (cloud metadata stays blocked). Hosted SaaS still requires public HTTPS.

## Data model

15. Reconciliation `waiting` is a first-class DB status (migration `0014`). Historical `ignored` rows that meant in-delay waiting were converted to `waiting`.
16. Migration `0011_schema_placeholder` is a no-op in Community; agency billing tables are not created in this tree.

## Security posture notes

17. Self-hosted JSON APIs resolve the local tenant via `resolveTrustedTenantId`; foreign tenant headers are rejected.
18. HMAC mutation checks are conclusive via `tests/security/heartbeat-hmac-guards.test.ts`.
19. Metrics stay disabled unless explicitly enabled with token or loopback controls.
20. Self-hosted n8n poll may use HTTP on LAN (`networkPolicy: self_hosted_local`). Cloud metadata stays blocked.
21. Sensitive mutations write immutable `ops_audit_events` (migration `0015`); see [security.md](./security.md). Coverage: `tests/security/ops-audit-coverage.test.ts`.

## Alerts

22. Automated validation uses a local webhook mock. Real Slack or SMTP delivery is an owner manual check when credentials exist.
23. Outbox `resolved` rows may process with zero `notification_attempts` rows depending on channel path; validation accepts processed `resolved` outbox evidence.

## Owner soak (24–48 h)

Automated gates do not replace an owner soak. Before calling design-partner install ready:

1. Accept these limitations.
2. Run `bash scripts/start-soak-test.sh`, complete setup, import [examples/n8n/quorum-signed-heartbeat.json](../examples/n8n/quorum-signed-heartbeat.json), configure cadence / empty-result / intentional quiet paths, and a real alert channel when credentials exist.
3. Periodically run `bash scripts/check-soak-test.sh` (reports under `docs/verification/artifacts/`, gitignored).
4. Owner judgment over 24–48 h: no unexplained duplicate incidents, no alert storms, watcher stays fresh, memory does not grow without bound, planned interruptions recover cleanly.

## Design-partner framing

Self-hosted Contract Catalog + n8n heartbeat push/poll + alerts: **CONDITIONAL GO** for design partners when:

- `npm run verify:self-hosted` is green
- `npm run test:e2e:n8n:real` is green
- these limitations are accepted
- owner completes the 24–48 h soak above

Hosted SaaS is **NO-GO** and is not shipped from this repository.
