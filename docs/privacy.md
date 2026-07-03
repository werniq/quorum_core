# Quorum privacy (self-hosted)

**We do not need your workflow data.**

Self-hosted Quorum is local-first by architecture, not by a settings checkbox:

- no telemetry
- no analytics SDK
- no license check
- no remote feature flags
- no execution-data upload
- no required cloud account
- no undeclared outbound requests

Quorum verifies contracts and evidence you explicitly configure. It does not exfiltrate n8n execution payloads or require a Quorum cloud account to operate.

## Allowed outbound destinations

Only admin-configured:

- n8n API base URLs (HTTPS public polling)
- webhook alert endpoints
- SMTP servers for email alerts

The in-app **Network and Privacy** screen lists configured destinations and the last attempt to each. That screen does not phone home.

## Operational health checks

Operators must configure an **external uptime check** against `GET /health/watcher`.
That endpoint returns non-200 when the watcher has not completed a successful evaluation
within the configured staleness window (`WATCHER_STALE_MS`).

Internal `/healthz` / `/readyz` are not complete self-monitoring. Also configure a
**secondary alert channel** for critical clients and periodically test channels.
See [operations.md](./operations.md).

Local `GET /metrics` stays on-host and is never transmitted by default.

## Independent privacy verification

1. Start Quorum with network policy that denies all egress except configured n8n/webhook/SMTP hosts.
2. Complete setup, browse the catalog, run watcher ticks, and test an alert channel.
3. Confirm no requests leave for analytics, fonts, CDNs, or Quorum cloud.
4. Confirm `getTelemetryQueueLength()` stays `0` (see privacy tests).
5. Confirm logs never contain raw credentials or full personal records.
