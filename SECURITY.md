# Security Policy

## Supported versions

Quorum Community is **beta** software. Security fixes are applied on the default branch of this repository. There is no long-term support window yet.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email a clear description (and a proof of concept if you have one) to the maintainers via the contact listed in the repository profile or release notes. Include:

- Quorum version / commit SHA
- Deployment mode (Docker Compose, local `npm`, etc.)
- Impact and reproduction steps

We will acknowledge receipt when we can and coordinate a fix before any public disclosure.

## Security baseline

Operator-facing security notes live in [docs/security.md](docs/security.md). In short:

- Install with `npm ci` (lockfile committed)
- Keep `QUORUM_CREDENTIAL_KEK` secret and backed up separately from the database
- HTML UI uses session cookies, CSRF on mutating POSTs, and restrictive browser headers
- Heartbeat ingestion requires HMAC credentials; do not put real secrets in exported n8n workflows
- Metrics stay off unless explicitly enabled

Run `npm run security:deps` for dependency advisories when you have network access.
