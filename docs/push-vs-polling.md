# Push versus polling

Quorum can watch an n8n workflow in two ways. Start with **polling** unless you already know you need signed reports from inside the workflow.

Under one workflow registration, Quorum evaluates **three dimensions**:

| Dimension     | Question                                    | Typical source                        |
| ------------- | ------------------------------------------- | ------------------------------------- |
| **Schedule**  | Did it run within the grace window?         | Polling or push cadence               |
| **Output**    | Did items/policy predicates hold (after N)? | Push (and polled counts when present) |
| **Freshness** | Did a source watermark advance?             | Push metadata (`sourceWatermark`)     |

Trust signals (not workflow breaches):

- **Monitor unknown** — Quorum cannot reach the n8n API (poll connector unreachable / auth failed / misconfigured). The Catalog **badge** shows Monitor unknown; open schedule/output/freshness breaches stay visible on the card and are not auto-resolved.
- **Watchdog** — Quorum’s own watcher liveness (`GET /health/watcher` + Catalog **Test watchdog**, read-only — does not open incidents or change workflows).

## Polling (recommended)

Quorum connects to n8n with a base URL and API key, then reads execution history on a schedule.

- No edits inside the n8n workflow
- No HMAC secrets or Quorum workflow IDs for the normal path
- Best first path for **schedule** (“did it run when it should?”)
- Evidence stays **basic** — Quorum saw n8n’s execution record, not a custom payload you signed
- If the API is down, Catalog shows **Monitor unknown**, not Overdue silence

Use this for most contracts, including the [Poll invoices](demo/poll-invoices-example.md) silent-absence walkthrough.

## Push heartbeats

The n8n workflow posts a signed heartbeat to Quorum after (or during) a run.

- Requires a push credential (Key ID + HMAC secret) and a small setup in the workflow
- Richer **output** reporting: status, items processed, external execution refs
- Optional **freshness**: set contract `source_watermark_required`, choose `watermark_comparison_type` (`auto` / `numeric` / `iso_datetime` / `lexicographic`), and optionally `freshness_allowed_staleness_seconds` (how long an unchanged watermark may remain before counting as stale). Send `metadata.sourceWatermark` (or `source_watermark` / `source_max_updated_at`). If freshness is not configured, Catalog shows **Not configured**.
- Optional **effect receipt** (experimental): nest **`metadata.receipt`** (canonical; `metadata.effect` accepted as an alias) with optional fields (`inputBatchId`, `expectedCount`, `writtenCount`, `rejectedCount`, `skippedCount`, `destinationName`, `watermarkBefore`, `watermarkAfter`, `exceptionOwner`, `requiredFieldsValid`). Stored in existing `metadata_json` (denylist only; ≤8KB). **Only `expectedCount` versus `writtenCount` is evaluated today**; the other fields are retained as evidence for future checks. Evaluation runs only when `effect_reconciliation_enabled=1` and both counts are valid integers. Missing, partial, or malformed receipts do **not** fail ingest and do **not** resolve an open count-mismatch incident — only a later matching pair resolves it. Catalog shows **Not configured** by default, or **Experimental · …** when enabled. Not part of onboarding.
- Empty-result policy is per-workflow (`allowed` / `warning` / `failure`) with a **consecutive-breach threshold** (default 1) — zero items is not a global `items >= 1` rule
- Import [examples/n8n/quorum-signed-heartbeat.json](../examples/n8n/quorum-signed-heartbeat.json)

## Choose in one line

| Need                                         | Path            |
| -------------------------------------------- | --------------- |
| Fastest setup, no workflow changes           | Polling         |
| Schedule / silent absence                    | Polling         |
| Signed success / failure / empty-result body | Push            |
| Source watermark freshness                   | Push            |
| Fleet secret injection via Docker/K8s env    | Push (advanced) |

Setup details: [connect-n8n.md](connect-n8n.md) · [push-heartbeats.md](push-heartbeats.md) · [examples/n8n/README.md](../examples/n8n/README.md).
