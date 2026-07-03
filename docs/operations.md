# Quorum operations: observability, backups, secrets, and self-monitoring

Self-hosted Quorum **never transmits** metrics or logs by default. Local `/metrics` and application logs stay on your host.

## Health and external self-monitoring

Quorum exposes watcher freshness but **cannot fully prove its own availability from inside itself**.

Recommended:

1. External uptime check on `GET /health/watcher` (and optionally `/readyz`).
2. At least **two** alert channels for critical SaaS/client retainers.
3. Periodic **Send test** on each channel (catalog banner links to this when failing).
4. Scheduled backup/restore drills (below).

Do **not** treat internal `/healthz` alone as complete self-monitoring.

| Endpoint              | Purpose                                     |
| --------------------- | ------------------------------------------- |
| `GET /healthz`        | Process up                                  |
| `GET /readyz`         | Migrations applied; workers allowed         |
| `GET /health/watcher` | Watcher tick freshness                      |
| `GET /metrics`        | Local Prometheus-text metrics (not shipped) |
| `GET /metrics.json`   | Local JSON snapshot                         |

Metric labels never include secrets, payloads, record IDs, or customer PII.

## Structured logs

Safe fields: request ID (`x-request-id`), tenant/client/contract/workflow/incident/connector/outbox IDs, event name, sanitized error category.

Never logged: HMAC secrets, API keys, SMTP passwords, raw `Authorization`, full lead/customer records, unrestricted payloads, expiring report tokens.

## Alert-channel health

Delivery attempts are durable. Non-2xx / timeout / SMTP errors update channel health (`degraded` while retries remain, `failing` when exhausted). Catalog banner appears until a successful delivery/test. Underlying incident truth is unchanged by notification failures.

## Secrets and KEK rotation

- Self-hosted: `QUORUM_CREDENTIAL_KEK` (AES-256-GCM envelope via scrypt-derived key).
- Supply the KEK through a secret mechanism. Do not keep the only KEK copy on the same volume as the database backup.
- Optional rotation window: set `QUORUM_CREDENTIAL_KEK` to the new key and `QUORUM_CREDENTIAL_KEK_PREVIOUS` to the old key, re-encrypt stored blobs, then remove the previous key.
- After restore, a missing or wrong KEK means push credentials and alert configs cannot be decrypted. That loss is unrecoverable for those secrets.
- Never log the KEK. It must not appear in diagnostics, exports, or health responses.

## Backups

### Self-hosted (SQLite)

1. Quiesce writers (`docker compose stop quorum`) or use the online backup helper.
2. Copy the SQLite database file from the data volume.
3. Separately retrieve `QUORUM_CREDENTIAL_KEK` from the secret store.
4. Restore the DB to a clean install, set the correct KEK, run migrations, confirm `/readyz`.
5. Validate a sealed credential decrypts with the restored KEK. A wrong KEK must fail clearly.

### SaaS (Postgres)

- Use provider scheduled backups / PITR.
- Never run workers against partial migrations (`/readyz` fails; processors refuse work).
- After restore, validate connector secret decryption and tenant isolation.

## Deployment upgrades

1. Backup DB + KEK.
2. Apply versioned migrations.
3. Confirm `/readyz` ready before enabling watchers/outbox.
4. Job claims expire after crashes; duplicate workers must not open duplicate incidents for the same contract problem.

## Security controls

- CSP and related headers on all responses.
- CSRF tokens on cookie session forms.
- Login, heartbeat, and share-token rate limits.
- Hosted connector SSRF denylist (private/metadata).
- Export and report share links: scoped, expiring, revocable.
- `npm audit` / lockfile committed for dependency scanning.
