# Push heartbeats (advanced)

Polling is the recommended first path. Use push heartbeats when you need richer execution reporting from inside the n8n workflow.

## Identifiers

| ID                     | Where it comes from                                                        | Used for                                                                    |
| ---------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **n8n workflow ID**    | n8n URL: `…/workflow/{id}`                                                 | Registration field “n8n workflow ID” / external id                          |
| **Quorum workflow ID** | Assigned by Quorum (**Workflows**, credential page, URL `/workflows/<id>`) | Push setup node / advanced env `QUORUM_WORKFLOW_ID`                         |
| **Key ID**             | Quorum “Issue push credential”                                             | Push setup node / advanced `QUORUM_KEY_ID`                                  |
| **HMAC secret**        | Shown once with the credential                                             | n8n Crypto credential or Crypto HMAC Secret / advanced `QUORUM_HMAC_SECRET` |

Do not mix the n8n URL id with the Quorum workflow id.

## Checklist

1. Register the workflow with monitoring method **push** (onboarding advanced settings, or **Workflows**). Prefer an existing registration when it already exists.
2. On **Workflows**, **Issue push credential**. Copy Key ID and HMAC secret immediately; the secret is not shown again.
3. Define monitoring expectations and **activate**. Until then, push heartbeats return HTTP **409** `CONTRACT_NOT_ACTIVE`. An unknown Quorum workflow id returns **404** `NOT_FOUND`.
4. Import [examples/n8n/quorum-signed-heartbeat.json](../examples/n8n/quorum-signed-heartbeat.json) (Crypto Hash + Crypto HMAC; no `NODE_FUNCTION_ALLOW_BUILTIN`).
5. Edit **Quorum Setup (edit me)**: Quorum base URL, Quorum workflow ID, Key ID. Put the HMAC secret in a Crypto credential (n8n ≥ 2.7) or the Crypto HMAC Secret field.
6. Activate and run. Expect **HTTP 202** and `{ "status": "accepted", ... }`.

Credentials alone do not activate monitoring.

## Advanced: n8n process environment variables

Only when you inject secrets via Docker/K8s. Set `QUORUM_WORKFLOW_ID`, `QUORUM_KEY_ID`, `QUORUM_HMAC_SECRET`, `QUORUM_BASE_URL` on the n8n process (and often `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` on n8n 2.x). Not required for the normal UI push path.

Full n8n range and troubleshooting: [examples/n8n/README.md](../examples/n8n/README.md).
