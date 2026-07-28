# Connect n8n

Polling is the recommended first path. Push heartbeats are optional when you need richer reporting from inside the workflow.

## Polling (recommended)

1. Open **Set up monitoring** (`/onboarding`), or use **Connectors** for an advanced setup.
2. Enter the n8n base URL and an API key (**Settings → n8n API** in n8n).
3. Test the connection, select workflows by name, confirm cadence expectations, optionally assign an alert channel, then **Start monitoring**.

No n8n workflow edits, HMAC secrets, or Quorum workflow IDs are required for polling.

### Docker networking

If Quorum and n8n run in the same Compose network (see [getting-started.md](getting-started.md) lab stack), use the service hostname from Quorum — for example `http://n8n:5678` — not `localhost`.

Discovery and cadence inference: [onboarding-discovery.md](onboarding-discovery.md).

## Push heartbeats

Use when you want signed execution reports from inside n8n.

1. Register the workflow with monitoring method **push**.
2. On **Workflows**, **Issue push credential** (copy Key ID and HMAC secret once).
3. Activate the contract.
4. Import [examples/n8n/quorum-signed-heartbeat.json](../examples/n8n/quorum-signed-heartbeat.json) and edit the setup node.

Step-by-step IDs and env injection: [push-heartbeats.md](push-heartbeats.md). Supported n8n versions and troubleshooting: [examples/n8n/README.md](../examples/n8n/README.md).

## Tested n8n versions

| Bound          | Image / version    |
| -------------- | ------------------ |
| Minimum        | `n8nio/n8n:1.95.3` |
| Current stable | `n8nio/n8n:2.31.4` |
