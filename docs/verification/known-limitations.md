# Known limitations

Updated 2026-07-21 after Community pre-release verification (`docs/verification/final-release-verification.md`).

## Product scope

1. Heartbeat evidence proves a signed execution report arrived. It does not prove destination delivery.
2. Volume-band checks use heartbeat-reported `items_processed` only. They remain Basic evidence and do not prove destination correctness or independent delivery.
3. HubSpot → Zoom is the only named outcome path, and it remains Preview.
4. Zapier and Make are Planned only.
5. Public copy must not claim end-to-end verification of all n8n workflows.
6. Volume rules are created in the data model and evaluated by the watcher. There is no Protect-wizard step for volume rules yet.
7. Incident triage fields exist in the database and repositories. Full triage UI is not complete.
8. Hosted multi-tenant SaaS, Stripe checkout, and agency billing are **not** in the Community AGPL tree. Hosted production remains **NO-GO**.

## Runtime and ops

9. CI workflow exists at `.github/workflows/ci.yml`. This pass did not publish a GitHub Actions run; validate on the remote when pushed.
10. `npm run format:check` is part of `release:check` / `verify:self-hosted`.
11. `npm run verify:self-hosted` passed on 2026-07-21 (Windows, Docker 28.4.0) after format/lint fixes and starting Docker Desktop.
12. Shorter e2e (`npm run test:e2e:n8n`) uses pinned `n8nio/n8n:1.95.3`. REST execute is often unavailable; production webhook trigger is used. Happy-path signing stays in n8n Code (no host-signed fallback). Silent absence is **not** waited in that script.
13. Full quiet-window silent absence, empty-result policies, poll bind/restart, and resolution outbox checks run in `npm run test:e2e:n8n:real` (passed 2026-07-21; detection latency ~62 s for 1-minute cadence).
14. Graceful shutdown drains in-flight work up to `SHUTDOWN_GRACE_MS` (default 10s), then may force exit.
15. n8n `/healthz` can succeed while migrations still run; verification scripts wait for `/rest/settings` JSON before owner setup.

## Data model

16. Reconciliation `waiting` is a first-class DB status (migration `0014`). Historical `ignored` rows that meant in-delay waiting were converted to `waiting`.
17. Migration `0011_schema_placeholder` is a no-op in Community; agency billing tables are not created in this tree.

## Security posture notes

18. Self-hosted JSON APIs resolve the local tenant via `resolveTrustedTenantId`; foreign tenant headers are rejected.
19. HMAC mutation checks are conclusive via `tests/security/heartbeat-hmac-guards.test.ts`.
20. Metrics stay disabled unless explicitly enabled with token or loopback controls.
21. Self-hosted n8n poll may use HTTP on LAN (`networkPolicy: self_hosted_local`). Cloud metadata stays blocked.

## Alerts

22. Automated validation uses a local webhook mock. Real Slack or SMTP delivery is an owner manual check when credentials exist.
23. Outbox `resolved` rows may process with zero `notification_attempts` rows depending on channel path; validation accepts processed `resolved` outbox evidence.

## Design-partner framing

Self-hosted Contract Catalog + n8n heartbeat push/poll + alerts: **CONDITIONAL GO** for design partners when:

- `npm run verify:self-hosted` is green
- `npm run test:e2e:n8n:real` is green
- these limitations are accepted
- owner completes 24–48 h soak ([manual-soak-test.md](./manual-soak-test.md))

Hosted SaaS is **NO-GO** and is not shipped from this repository.
