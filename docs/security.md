# Security notes

- Lockfile: `package-lock.json` is committed; install with `npm ci`.
- Dependency scanning: `npm run security:deps` (fails on high/critical when network available).
- Dashboard: CSP `default-src 'self'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, CSRF on session POSTs.
- Tenant isolation is enforced in repositories and covered by regression tests under `tests/security`.
- Secrets use local envelope encryption (`QUORUM_CREDENTIAL_KEK`); see [operations.md](./operations.md) for rotation and restore.
