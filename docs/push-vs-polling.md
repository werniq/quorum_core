# Push versus polling

Quorum can watch an n8n workflow in two ways. Start with **polling** unless you already know you need signed reports from inside the workflow.

## Polling (recommended)

Quorum connects to n8n with a base URL and API key, then reads execution history on a schedule.

- No edits inside the n8n workflow
- No HMAC secrets or Quorum workflow IDs for the normal path
- Best first path for silent absence (“did it run when it should?”)
- Evidence stays **basic** — Quorum saw n8n’s execution record, not a custom payload you signed

Use this for most contracts, including the [Poll invoices](demo/poll-invoices-example.md) silent-absence walkthrough.

## Push heartbeats

The n8n workflow posts a signed heartbeat to Quorum after (or during) a run.

- Requires a push credential (Key ID + HMAC secret) and a small setup in the workflow
- Richer reporting from inside the run: status, items processed, external execution refs
- Useful when you want signed failure or empty-result heartbeats, not only what the n8n executions API exposes
- Import [examples/n8n/quorum-signed-heartbeat.json](../examples/n8n/quorum-signed-heartbeat.json)

## Choose in one line

| Need                                         | Path            |
| -------------------------------------------- | --------------- |
| Fastest setup, no workflow changes           | Polling         |
| Silent absence on a schedule you already run | Polling         |
| Signed success / failure / empty-result body | Push            |
| Fleet secret injection via Docker/K8s env    | Push (advanced) |

Setup details: [connect-n8n.md](connect-n8n.md) · [push-heartbeats.md](push-heartbeats.md) · [examples/n8n/README.md](../examples/n8n/README.md).
