# Real n8n validation matrix

Use a disposable n8n instance (or the Vitest harness that simulates the same control points) with:

- scheduled workflow
- webhook-triggered workflow
- legitimate zero-item workflow
- polling-monitored workflow
- push-monitored workflow

| #   | Scenario                                       | Expected Quorum behavior                                                     |
| --- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Trigger disabled while config exists           | Silent absence / overdue after grace; one stateful incident                  |
| 2   | Workflow stops executing                       | Overdue; catalog health degrades; alert outbox enqueued                      |
| 3   | Hard failure heartbeat                         | Failure incident; evidence remains honest                                    |
| 4   | 200 / zero-item execution                      | Follows empty-result policy; not a false positive when allowed               |
| 5   | Invalid signature                              | Rejected; no state mutation                                                  |
| 6   | Duplicate heartbeat                            | Idempotent accept; no duplicate incidents                                    |
| 7   | n8n API unavailable                            | Connector failure recorded; no undeclared retry hosts                        |
| 8   | Notification endpoint 500                      | Channel health failing; failure visible locally                              |
| 9   | SMTP timeout                                   | Channel failure sanitized in logs / Network & Privacy                        |
| 10  | Watcher killed or stalled                      | `/health/watcher` non-200 after `WATCHER_STALE_MS`                           |
| 11  | Late fixed-rate execution                      | Schedule anchor does not shift                                               |
| 12  | Healthy heartbeat, destination outcome missing | Catalog stays **healthy / basic**; UI states destination delivery unverified |

Record detection latency, alert-attempt latency, duplicates, recovery, false positives, channel failure visibility, evidence-level correctness, and setup steps when running against real n8n.

Automated coverage: `tests/self-hosted/n8n-validation-harness.test.ts`.
