# Manual soak test (24–48 hours)

This is an owner-run soak. Scripts collect evidence; they do not declare production readiness.

## Start

```bash
# Git Bash / Linux / macOS
export QUORUM_CREDENTIAL_KEK='...long secret...'
export QUORUM_SETUP_TOKEN='...min 24 chars...'
bash scripts/start-soak-test.sh
```

Complete Quorum setup in the browser. Import `examples/n8n/quorum-signed-heartbeat.json` (set n8n env placeholders). Configure at least:

| Workflow                                  | Purpose                            |
| ----------------------------------------- | ---------------------------------- |
| Scheduled signed heartbeat (1–5 min)      | Baseline healthy evidence          |
| Webhook-triggered signed heartbeat        | On-demand recovery / failure tests |
| Zero-items success path                   | Empty-result policy                |
| External test API call                    | Connector / outbound noise         |
| Intentionally disabled or broken schedule | Silent absence / overdue           |

Configure a real alert channel when credentials are available (Slack or SMTP). Otherwise keep the local webhook from validation.

## Periodic check

```bash
bash scripts/check-soak-test.sh
```

Reports land under `docs/verification/artifacts/`. Inspect:

- process/container state
- `/readyz`, `/health/live`, `/health/watcher`
- open incidents and failed notifications
- connector health and last poll time
- database / volume growth
- container CPU and memory
- repeated errors in logs (secrets redacted by the check script)

## Pass criteria (owner judgment)

- No unexplained duplicate incidents for the same contract+type
- No alert storms
- Watcher health stays fresh
- Memory does not grow without bound over 24–48h
- After planned interruptions, recovery resolves the same incident

A short automated validation session does not replace this soak.
