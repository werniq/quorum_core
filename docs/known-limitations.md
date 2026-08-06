# Known limitations

Updated 2026-07-31 after Community beta.5 verification ([release-verification.md](./verification/release-verification.md)).

## Product scope

1. Heartbeat and volume-band evidence can be self-reported. They do not independently prove destination delivery.
2. Heartbeat evidence proves a signed execution report arrived. It does not prove destination delivery.
3. Volume-band checks use heartbeat-reported `items_processed` only. They remain Basic evidence and do not prove destination correctness or independent delivery.
4. **Freshness** (source watermark) is available when `source_watermark_required` is set, with explicit `watermark_comparison_type` and optional `freshness_allowed_staleness_seconds`. Push metadata must include `sourceWatermark`. When unset, Catalog shows **Not configured**. It is not inferred for all polling workflows and is not general outcome verification.
   4a. **Effect receipt reconciliation** is experimental and opt-in (`effect_reconciliation_enabled`). Push workflows may nest optional fields under canonical **`metadata.receipt`** (`metadata.effect` is an accepted alias) in existing `metadata_json`. **Only `expectedCount` vs `writtenCount` is evaluated today**; other receipt fields are retained for future checks. Count-mismatch incidents open only when both counts are valid on an enabled contract. Missing, partial, or malformed receipts leave an open `effect_count_mismatch` unresolved until a later matching receipt. This is self-reported and does not query destinations. Catalog shows **Not configured** by default.
5. HubSpot webinar registrations → Zoom webinar registrants is the only named outcome path, and it remains **Preview**. For that path, Quorum independently verifies supported business outcomes and identifies records that failed to reach their destination. Do not generalize to every n8n workflow.
6. Zapier and Make are **Planned** only.
7. Public copy must not claim general outcome verification across the entire n8n estate.
8. Volume rules are created in the data model and evaluated by the watcher. There is no Protect-wizard step for volume rules yet.
9. Basic acknowledgement and post-recovery review are supported (operators can acknowledge active incidents without marking them recovered, and mark recovered incidents as reviewed). Advanced triage — assignment, severity changes, response targets, and editable resolution notes — remains incomplete.
10. Hosted multi-tenant SaaS, Stripe checkout, and agency billing are **not** in the Community Apache-2.0 tree. Hosted production remains **NO-GO**.
11. A zero-item run can be legitimate. Empty-result handling is per-contract (`allowed` / `warning` / `failure`) with an optional consecutive-breach threshold — not a global `items >= 1` rule.
12. When the n8n poll connector is unreachable, Catalog shows **Monitor unknown** and does not open new silent-absence incidents for that reason alone. An already-open schedule breach remains visible (dimensions + incident); the badge still reads Monitor unknown until the connector recovers.

## Runtime and ops

13. CI workflow exists at `.github/workflows/ci.yml`. Master pushes run `static-and-tests` and `compose-and-e2e`; latest green runs are linked from [release-verification.md](./verification/release-verification.md).
14. `npm run format:check` is part of `release:check` / `verify:self-hosted`.
15. Local unit + coverage gates passed on 2026-07-31 (`npm test` 322; `test:cov` ≥90%). Full `verify:self-hosted` / Compose path is exercised on CI and was green for the empty-result and beta-kit pushes.
16. Graceful shutdown drains in-flight work up to `SHUTDOWN_GRACE_MS` (default 10s), then may force exit.
17. n8n `/healthz` can succeed while migrations still run; verification scripts wait for `/rest/settings` JSON before owner setup.

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

18. Reconciliation `waiting` is a first-class DB status (migration `0014`). Historical `ignored` rows that meant in-delay waiting were converted to `waiting`.
19. Migration `0011_schema_placeholder` is a no-op in Community; agency billing tables are not created in this tree.

## Security posture notes

20. Self-hosted JSON APIs resolve the local tenant via `resolveTrustedTenantId`; foreign tenant headers are rejected.
21. HMAC mutation checks are conclusive via `tests/security/heartbeat-hmac-guards.test.ts`.
22. Metrics stay disabled unless explicitly enabled with token or loopback controls.
23. Self-hosted n8n poll may use HTTP on LAN (`networkPolicy: self_hosted_local`). Cloud metadata stays blocked.
24. Sensitive mutations write immutable `ops_audit_events` (migration `0015`); see [security.md](./security.md). Coverage: `tests/security/ops-audit-coverage.test.ts`.

## Alerts

25. Automated validation uses a local webhook mock. Real Slack or SMTP delivery is an owner manual check when credentials exist.
26. Outbox `resolved` rows may process with zero `notification_attempts` rows depending on channel path; validation accepts processed `resolved` outbox evidence.

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
