# Self-hosted ops audit coverage matrix

Migration: `0015_ops_audit_events` (after existing `0014_reconciliation_waiting_status`).
Table: `ops_audit_events` — immutable via UPDATE/DELETE triggers.
Helper: `SqliteOpsAuditRepositories.recordOpsAudit` (strips secrets from `details_json`).

| Sensitive mutation               | Path / entrypoint                                                               | Audited?                                       | Audit action                   |
| -------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------ |
| Admin setup completion           | `POST /setup`                                                                   | Yes                                            | `admin.setup_completed`        |
| Credential creation              | `POST /workflows/:id/credentials`                                               | Yes                                            | `credential.created`           |
| Credential rotation              | `POST /workflows/:id/credentials/:credId/rotate`                                | Yes                                            | `credential.rotated`           |
| Credential revocation            | `POST /workflows/:id/credentials/:credId/revoke`                                | Yes                                            | `credential.revoked`           |
| Contract creation                | `POST /onboarding/contracts`, `POST /protect/contract`                          | Yes                                            | `contract.created`             |
| Contract activation              | `POST /onboarding/activate`, `POST /protect/activate`                           | Yes                                            | `contract.activated`           |
| Contract cadence change          | `POST /contracts/:id/cadence`                                                   | Yes                                            | `contract.cadence_changed`     |
| Contract deactivation            | `POST /contracts/:id/deactivate`                                                | Yes                                            | `contract.deactivated`         |
| Alert channel creation           | `POST /alerts`, onboarding/protect alert steps                                  | Yes                                            | `alert_channel.created`        |
| Alert channel test               | `POST /alerts/:id/test`, `POST /api/v1/alert-channels/:id/test`, protect alerts | Yes                                            | `alert_channel.tested`         |
| Alert channel disable            | `POST /alerts/:id/disable`                                                      | Yes                                            | `alert_channel.disabled`       |
| n8n connector create             | `POST /connectors/n8n`                                                          | Yes                                            | `connector.created`            |
| n8n connector credential update  | `POST /connectors/n8n/:id/credential`                                           | Yes                                            | `connector.credential_updated` |
| n8n connector disable            | `POST /connectors/n8n/:id/disable`                                              | Yes                                            | `connector.disabled`           |
| Outcome connector create         | `POST /api/v1/outcome/connectors`                                               | Yes                                            | `connector.created`            |
| Outcome connector revoke/disable | `POST /api/v1/outcome/connectors/:id/revoke`                                    | Yes                                            | `connector.disabled`           |
| Incident acknowledge             | incident API / alerting repo                                                    | Yes (via `incident_audit_events`)              | `acknowledged`                 |
| Incident resolve                 | incident API / alerting `resolveIncident`                                       | Yes (via `incident_audit_events`)              | `resolved`                     |
| Heartbeat auto-resolve           | `ingest-heartbeat.ts`                                                           | Yes — calls `resolveIncident` (not raw UPDATE) | `resolved`                     |

Notes:

- Actor is the session `adminUserId` when available; system auto-resolve uses `system:ingest-heartbeat`.
- `details_json` never stores passwords, API keys, tokens, or encrypted credential material.
- Ops audit rows are tenant-scoped; listing is filtered by `tenant_id`. No public cross-tenant query API.
- Coverage tests: `tests/security/ops-audit-coverage.test.ts`.
