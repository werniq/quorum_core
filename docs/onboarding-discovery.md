# n8n workflow discovery and cadence inference

Quorum’s simplified onboarding discovers workflows through the selected n8n connection (`GET /api/v1/workflows` with pagination, then `GET /api/v1/workflows/:id` for each row so schedule parameters are complete; capped at 500 workflows).

## Supported inference

| Pattern                                                 | Result                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| Schedule / interval trigger with resolvable amount+unit | Interval cadence (e.g. `15m`) labelled “Detected from n8n”  |
| Cron expression on a schedule node                      | Cron cadence preserved verbatim                             |
| Webhook / app event / manual trigger                    | No invented schedule — quiet-window or failure-only options |
| Multiple trigger nodes                                  | Ambiguous — user must choose expectations                   |

## Unsupported / fallback

- Dynamic expressions or missing interval amounts → ask the user to confirm cadence (Quorum does **not** invent “every 1 minute”).
- Discovery API unavailable → collapsed “Enter a workflow ID manually” fallback.
- Names from n8n are treated as untrusted and HTML-escaped in the UI.
- After changing a schedule in n8n, save (and publish/activate if your n8n version uses versions), then **Refresh workflow list** in Quorum.

Polling and heartbeats still do not independently prove the final downstream business outcome.
