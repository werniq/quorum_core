# Security notes

- Lockfile: `package-lock.json` is committed; install with `npm ci`.
- Dependency scanning: `npm run security:deps` (fails on high/critical when network available).
- Dashboard: CSP `default-src 'self'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, CSRF on session POSTs.
- Tenant isolation is enforced in repositories and covered by regression tests under `tests/security`.
- Self-hosted JSON APIs resolve the local tenant via `resolveTrustedTenantId`; foreign tenant headers are rejected.
- Secrets use local envelope encryption (`QUORUM_CREDENTIAL_KEK`); see [operations.md](./operations.md) for rotation and restore.
- Heartbeat HMAC: mutation checks are conclusive in `tests/security/heartbeat-hmac-guards.test.ts` (forcing always-true signature verification fails required suites).
- Metrics stay disabled unless explicitly enabled with token or loopback controls.
- Self-hosted n8n poll may use LAN HTTP (`networkPolicy: self_hosted_local`); cloud metadata destinations remain blocked.

## Ops audit

Migration `0015_ops_audit_events` adds immutable `ops_audit_events` (UPDATE/DELETE blocked by triggers). `SqliteOpsAuditRepositories.recordOpsAudit` strips secrets from `details_json`.

Audited sensitive mutations include admin setup, credential create/rotate/revoke, contract create/activate/cadence/deactivate, alert channel create/test/disable, n8n and outcome connector create/update/disable, and incident acknowledge/resolve (including heartbeat auto-resolve via `resolveIncident`).

- Actor is the session `adminUserId` when available; system auto-resolve uses `system:ingest-heartbeat`.
- `details_json` never stores passwords, API keys, tokens, or encrypted credential material.
- Rows are tenant-scoped; there is no public cross-tenant query API.
- Coverage tests: `tests/security/ops-audit-coverage.test.ts`.
