# n8n workflow discovery and cadence inference

Quorum’s simplified onboarding discovers workflows through the selected n8n connection (`GET /api/v1/workflows` with pagination, capped at 500 workflows).

## Supported inference

| Pattern                                                 | Result                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------- |
| Schedule / interval trigger with resolvable amount+unit | Interval cadence (e.g. `15m`) labelled “Detected from n8n”  |
| Cron expression on a schedule node                      | Cron cadence preserved verbatim                             |
| Webhook / app event / manual trigger                    | No invented schedule — quiet-window or failure-only options |
| Multiple trigger nodes                                  | Ambiguous — user must choose expectations                   |

## Unsupported / fallback

- Dynamic expressions Quorum cannot resolve → ask the user to confirm cadence.
- Discovery API unavailable → collapsed “Enter a workflow ID manually” fallback.
- Names from n8n are treated as untrusted and HTML-escaped in the UI.

Polling and heartbeats still do not independently prove the final downstream business outcome.
