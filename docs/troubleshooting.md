# Troubleshooting

## Connection and onboarding

- Quorum reached n8n, but the API key was rejected → create or copy an n8n API key and try again.
- Quorum could not connect → check that n8n is reachable from the Quorum container. If both run in Docker Compose, use `http://n8n:5678` (not `localhost`).
- Workflow list empty or discovery failed → refresh the list, or use the collapsed manual workflow ID fallback ([onboarding-discovery.md](onboarding-discovery.md)).

## Push heartbeats

- `CONTRACT_NOT_ACTIVE` → the workflow has no active contract. Finish monitoring activation.
- `NOT_FOUND` → you used the n8n workflow URL id instead of the **Quorum** workflow id ([push-heartbeats.md](push-heartbeats.md)).
- Signature failures → confirm Key ID and HMAC secret match the issued credential; check clock skew / `HEARTBEAT_TIMESTAMP_TOLERANCE_SECONDS`.

## What “healthy” means

- **Contract Catalog — Healthy:** cadence and evidence look satisfied for the active contract. Basic evidence means Quorum accepted what was reported; it does not prove destination delivery.
- **Client — protected:** at least one active contract with a tested alert route. **onboarding** until that bar is met; **paused** if all contracts are paused.
- **Workflow Active** only means an active contract exists — not that the last run was healthy.
- **Alert channel failing** is separate: delivery problems show in the catalog banner without rewriting contract overdue state by themselves.
- After setup, workflows may show **Waiting for first execution** until evidence arrives — that is expected, not a failure.

## Restore and KEK

A wrong `QUORUM_CREDENTIAL_KEK` after restore causes decrypt failures. Quorum does not print the key in logs or responses. Always back up the KEK separately from the SQLite file ([operations.md](operations.md)).
