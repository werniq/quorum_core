import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import { classifyInboundHeartbeatPayload } from "../../domain/ingestion/classify-payload.js";
import {
  evaluateCredentialRateLimit,
  EmergencyRateLimitTracker,
  type RateLimitPolicy,
} from "../../domain/ingestion/rate-limit.js";
import {
  classifyHeartbeatEvidence,
  isAcceptableSuccess,
} from "../../domain/evidence/empty-result.js";
import { sanitizeHeartbeatMetadata } from "../../domain/evidence/heartbeat-metadata.js";
import { unverifiedDimensionsForEvidenceLevel } from "../../domain/evidence/unverified-dimensions.js";
import { createId } from "../../domain/ids.js";
import { decryptCredentialSecret } from "../security/credential-secrets.js";
import {
  isTimestampWithinTolerance,
  sha256Hex,
  verifyHeartbeatSignature,
} from "../security/heartbeat-hmac.js";
import { SqliteAlertingRepositories } from "../db/repositories/sqlite-alerting-repositories.js";
import type { QuorumEnv } from "../config/env.js";
import {
  assertProcessingAllowed,
  type SchemaReadinessState,
} from "../../application/schema-readiness.js";
import {
  buildHardFailureDetails,
  formatHardFailureSummary,
  parseHardFailureDetails,
} from "../../domain/incidents/hard-failure.js";
import {
  evaluateWatermarkFreshness,
  type WatermarkComparisonType,
} from "../../domain/evidence/source-watermark.js";
import { evaluateEffectReceipt } from "../../domain/evidence/effect-receipt.js";
import { nextConsecutiveEmptyResults } from "../../domain/health/contract-dimensions.js";
import {
  computeNextExpectedIso,
  openOrUpdateEmptyResultIncident,
  openOrUpdateEffectCountMismatchIncident,
  openOrUpdateFreshnessIncident,
  resolveOpenIncidentsOfTypes,
  upsertWorkflowStateAfterHeartbeat,
} from "./apply-heartbeat-state.js";

export type IngestHeartbeatResult =
  | { status: "accepted"; eventId: string; idempotentReplay: boolean }
  | { status: "conflict" }
  | { status: "unauthorized" }
  | { status: "not_found" }
  | {
      status: "contract_not_active";
      /** Optional human hint; clients may ignore and read only `code`. */
      message: string;
    }
  | { status: "bad_request"; code: string }
  | { status: "rate_limited" }
  | { status: "not_ready" };

const CONTRACT_NOT_ACTIVE_MESSAGE =
  "Monitoring is not active for this Quorum workflow id. Define a contract and activate monitoring in Quorum (Workflows → Protect), then retry. Do not use the n8n workflow id from the n8n URL here.";

export interface IngestHeartbeatCommand {
  workflowId: string;
  method: string;
  path: string;
  keyId: string;
  timestampSeconds: string;
  idempotencyKey: string;
  signatureHex: string;
  rawBody: Buffer;
}

const emergencyTracker = new EmergencyRateLimitTracker();

export function createIngestHeartbeatHandler(deps: {
  sqlite: Database.Database;
  env: QuorumEnv;
  clock: Clock;
  getSchemaReadiness: () => SchemaReadinessState;
}): (command: IngestHeartbeatCommand) => IngestHeartbeatResult {
  const alerting = new SqliteAlertingRepositories(deps.sqlite);

  return (command) => {
    const readiness = deps.getSchemaReadiness();
    try {
      assertProcessingAllowed(readiness, "ingestion");
    } catch {
      return { status: "not_ready" };
    }

    const workflow = deps.sqlite
      .prepare(
        `SELECT id, tenant_id, is_active FROM workflows WHERE id = ? LIMIT 1`,
      )
      .get(command.workflowId) as
      | { id: string; tenant_id: string; is_active: number }
      | undefined;

    if (!workflow) {
      return { status: "not_found" };
    }
    if (!workflow.is_active) {
      return {
        status: "contract_not_active",
        message: CONTRACT_NOT_ACTIVE_MESSAGE,
      };
    }

    const tenantId = workflow.tenant_id;
    const now = deps.clock.now();
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const timestampSeconds = Number(command.timestampSeconds);
    if (
      !isTimestampWithinTolerance({
        timestampSeconds,
        nowSeconds,
        toleranceSeconds: deps.env.HEARTBEAT_TIMESTAMP_TOLERANCE_SECONDS,
      })
    ) {
      return { status: "unauthorized" };
    }

    const credential = deps.sqlite
      .prepare(
        `SELECT id, key_id, encrypted_secret_or_verification_material, status
         FROM workflow_credentials
         WHERE tenant_id = ? AND workflow_id = ? AND key_id = ?
         LIMIT 1`,
      )
      .get(tenantId, command.workflowId, command.keyId) as
      | {
          id: string;
          key_id: string;
          encrypted_secret_or_verification_material: string;
          status: string;
        }
      | undefined;

    if (!credential || credential.status !== "active") {
      return { status: "unauthorized" };
    }

    let secret: string;
    try {
      secret = decryptCredentialSecret(
        credential.encrypted_secret_or_verification_material,
        deps.env.QUORUM_CREDENTIAL_KEK,
      );
    } catch {
      return { status: "unauthorized" };
    }

    const signatureOk = verifyHeartbeatSignature({
      secret,
      method: command.method,
      path: command.path,
      timestampSeconds: command.timestampSeconds,
      idempotencyKey: command.idempotencyKey,
      rawBody: command.rawBody,
      providedSignatureHex: command.signatureHex,
    });
    if (!signatureOk) {
      return { status: "unauthorized" };
    }

    const bodySha = sha256Hex(command.rawBody);
    const existing = deps.sqlite
      .prepare(
        `SELECT id, metadata_json FROM heartbeat_events
         WHERE tenant_id = ? AND workflow_id = ? AND idempotency_key = ?`,
      )
      .get(tenantId, command.workflowId, command.idempotencyKey) as
      | { id: string; metadata_json: string | null }
      | undefined;

    if (existing) {
      const prevHash = readBodyHash(existing.metadata_json);
      if (prevHash === bodySha) {
        return {
          status: "accepted",
          eventId: existing.id,
          idempotentReplay: true,
        };
      }
      return { status: "conflict" };
    }

    const policy: RateLimitPolicy = {
      acceptedPerMinute: deps.env.HEARTBEAT_RATE_LIMIT_PER_MINUTE,
      burstAllowance: deps.env.HEARTBEAT_RATE_LIMIT_BURST,
      sustainedRejectionWarningThreshold:
        deps.env.HEARTBEAT_SUSTAINED_REJECTION_THRESHOLD,
      tenantAcceptedPerMinute:
        deps.env.QUORUM_EDITION === "saas"
          ? deps.env.HEARTBEAT_TENANT_RATE_LIMIT_PER_MINUTE
          : null,
      globalAcceptedPerMinute:
        deps.env.QUORUM_EDITION === "saas"
          ? deps.env.HEARTBEAT_GLOBAL_RATE_LIMIT_PER_MINUTE
          : null,
    };

    if (
      !emergencyTracker.tryConsume({
        tenantId,
        tenantLimit: policy.tenantAcceptedPerMinute,
        globalLimit: policy.globalAcceptedPerMinute,
        nowMs: now.getTime(),
      })
    ) {
      recordRejection(deps.sqlite, {
        tenantId,
        workflowId: command.workflowId,
        credentialId: credential.id,
        now,
        policy,
        accepting: false,
      });
      return { status: "rate_limited" };
    }

    const rateRow = deps.sqlite
      .prepare(
        `SELECT window_started_at, accepted_count, rejected_count
         FROM ingestion_rate_limit_states
         WHERE tenant_id = ? AND workflow_id = ? AND credential_id = ?`,
      )
      .get(tenantId, command.workflowId, credential.id) as
      | {
          window_started_at: string;
          accepted_count: number;
          rejected_count: number;
        }
      | undefined;

    const rateDecision = evaluateCredentialRateLimit({
      now,
      windowStartedAt: rateRow ? new Date(rateRow.window_started_at) : null,
      acceptedCount: rateRow?.accepted_count ?? 0,
      rejectedCount: rateRow?.rejected_count ?? 0,
      policy,
      accepting: true,
    });

    if (!rateDecision.allowed) {
      upsertRateLimit(deps.sqlite, {
        tenantId,
        workflowId: command.workflowId,
        credentialId: credential.id,
        decision: rateDecision,
        now,
      });
      if (rateDecision.sustainedRejections) {
        markSustainedRejectionWarning(
          deps.sqlite,
          tenantId,
          command.workflowId,
          now,
        );
      }
      return { status: "rate_limited" };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(command.rawBody.toString("utf8"));
    } catch {
      return { status: "bad_request", code: "INVALID_JSON" };
    }

    const contract = deps.sqlite
      .prepare(
        `SELECT * FROM workflow_contracts
         WHERE tenant_id = ? AND workflow_id = ? AND is_active = 1
           AND contract_type = 'heartbeat'
         LIMIT 1`,
      )
      .get(tenantId, command.workflowId) as Record<string, unknown> | undefined;

    if (!contract) {
      return {
        status: "contract_not_active",
        message: CONTRACT_NOT_ACTIVE_MESSAGE,
      };
    }

    const classified = classifyInboundHeartbeatPayload(parsed, {
      countLessSuccessAllowed: Boolean(contract.count_less_success_allowed),
    });
    if (!classified.ok) {
      return { status: "bad_request", code: classified.code };
    }

    const emptyPolicy = contract.empty_result_policy as
      | "allowed"
      | "warning"
      | "failure";
    const evidenceClass = classifyHeartbeatEvidence(
      classified.evidenceStatus,
      emptyPolicy,
    );

    const sanitized = sanitizeHeartbeatMetadata(classified.metadata);
    if (!sanitized.ok) {
      return { status: "bad_request", code: "INVALID_METADATA" };
    }
    const metadataObject = sanitized.metadataJson
      ? (JSON.parse(sanitized.metadataJson) as Record<string, unknown>)
      : {};
    metadataObject.requestBodySha256 = bodySha;
    const metadataJson = JSON.stringify(metadataObject);

    const eventId = createId();
    const receivedAt = now.toISOString();
    const executedAt = classified.executedAt.toISOString();

    const run = deps.sqlite.transaction(() => {
      upsertRateLimit(deps.sqlite, {
        tenantId,
        workflowId: command.workflowId,
        credentialId: credential.id,
        decision: rateDecision,
        now,
      });

      deps.sqlite
        .prepare(
          `INSERT INTO heartbeat_events (
             id, tenant_id, workflow_id, received_at, executed_at, status,
             items_processed, external_execution_ref, idempotency_key,
             payload_schema_version, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .run(
          eventId,
          tenantId,
          command.workflowId,
          receivedAt,
          executedAt,
          classified.evidenceStatus,
          classified.itemsProcessed,
          classified.externalExecutionRef,
          command.idempotencyKey,
          metadataJson,
          receivedAt,
        );

      const acceptable = isAcceptableSuccess(evidenceClass);
      const previous = deps.sqlite
        .prepare(
          `SELECT * FROM workflow_states WHERE tenant_id = ? AND workflow_id = ?`,
        )
        .get(tenantId, command.workflowId) as
        | Record<string, unknown>
        | undefined;

      const unverified = unverifiedDimensionsForEvidenceLevel("basic");
      const nextExpectedAt = computeNextExpectedIso({
        contract,
        lastReportAt: executedAt,
        clock: deps.clock,
      });

      const breachThreshold = Math.max(
        1,
        Number(contract.empty_result_breach_threshold ?? 1),
      );
      const consecutiveEmptyResults = nextConsecutiveEmptyResults({
        evidenceStatus: classified.evidenceStatus,
        itemsProcessed: classified.itemsProcessed,
        previous: Number(previous?.consecutive_empty_results ?? 0),
      });

      const watermarkRequired = Boolean(contract.source_watermark_required);
      const comparisonType = (contract.watermark_comparison_type ??
        "auto") as WatermarkComparisonType;
      const allowedStalenessSeconds = Number(
        contract.freshness_allowed_staleness_seconds ?? 0,
      );
      const watermarkEval = evaluateWatermarkFreshness({
        required: watermarkRequired && classified.evidenceStatus === "success",
        previousWatermark:
          (previous?.last_source_watermark as string | null) ?? null,
        previousWatermarkAt:
          (previous?.last_source_watermark_at as string | null) ?? null,
        observedAt: executedAt,
        metadata: metadataObject,
        consecutiveStale: Number(previous?.consecutive_stale_watermarks ?? 0),
        breachThreshold,
        comparisonType,
        allowedStalenessSeconds,
      });

      const effectEval = evaluateEffectReceipt({
        enabled:
          Boolean(contract.effect_reconciliation_enabled) &&
          classified.evidenceStatus === "success",
        metadata: metadataObject,
      });

      upsertWorkflowStateAfterHeartbeat({
        sqlite: deps.sqlite,
        tenantId,
        workflowId: command.workflowId,
        executedAt,
        receivedAt,
        evidenceStatus: classified.evidenceStatus,
        itemsProcessed: classified.itemsProcessed,
        externalExecutionRef: classified.externalExecutionRef,
        previous,
        nextExpectedAt,
        evidenceSummaryCode:
          watermarkEval.status === "stale" || watermarkEval.status === "missing"
            ? "freshness_stale"
            : acceptable
              ? "healthy_occurrence_satisfied"
              : classified.evidenceStatus === "empty_result"
                ? "empty_result_received"
                : "failure_received",
        unverifiedJson: JSON.stringify(unverified),
        consecutiveEmptyResults,
        lastSourceWatermark: watermarkEval.nextWatermark,
        lastSourceWatermarkAt: watermarkEval.nextWatermarkAt,
        consecutiveStaleWatermarks: watermarkEval.consecutiveStale,
        lastEffectReconciliationStatus:
          effectEval.status === "not_configured"
            ? ((previous?.last_effect_reconciliation_status as string | null) ??
              null)
            : effectEval.status,
      });

      // Any valid report clears silent absence.
      resolveOpenIncidentsOfTypes({
        alerting,
        sqlite: deps.sqlite,
        tenantId,
        workflowId: command.workflowId,
        at: receivedAt,
        actor: "system:ingest-heartbeat",
        types: ["silent_absence"],
      });

      const workflowMeta = deps.sqlite
        .prepare(
          `SELECT name, monitoring_method FROM workflows WHERE tenant_id = ? AND id = ?`,
        )
        .get(tenantId, command.workflowId) as
        | { name: string; monitoring_method: string }
        | undefined;

      if (classified.evidenceStatus === "failure") {
        const before = alerting.getUnresolvedIncident(
          tenantId,
          "workflow",
          command.workflowId,
          "hard_failure",
        );
        const existingDetails = parseHardFailureDetails(before?.detailsJson);
        const details = buildHardFailureDetails({
          existing: existingDetails,
          workflowName: workflowMeta?.name ?? "Workflow",
          monitoringMethod:
            workflowMeta?.monitoring_method === "poll" ||
            workflowMeta?.monitoring_method === "push"
              ? workflowMeta.monitoring_method
              : null,
          observedAt: executedAt,
          latestStatus: "failure",
          itemsProcessed: classified.itemsProcessed,
          externalExecutionRef: classified.externalExecutionRef,
        });
        const incident = alerting.openOrObserveIncident(tenantId, {
          id: createId(),
          contractKind: "workflow",
          workflowId: command.workflowId,
          incidentType: "hard_failure",
          severity: "critical",
          summary: formatHardFailureSummary(details),
          detailsJson: JSON.stringify(details),
          observedAt: receivedAt,
        });
        if (!before) {
          enqueueOpened(alerting, tenantId, incident.id, receivedAt);
        }
      } else if (classified.evidenceStatus === "empty_result") {
        // Empty is not a hard failure — resolve hard_failure if open.
        resolveOpenIncidentsOfTypes({
          alerting,
          sqlite: deps.sqlite,
          tenantId,
          workflowId: command.workflowId,
          at: receivedAt,
          actor: "system:ingest-heartbeat",
          types: ["hard_failure"],
        });
        if (emptyPolicy === "warning" || emptyPolicy === "failure") {
          const stampsPrevious =
            (previous?.last_nonempty_success_at as string | null) ?? null;
          openOrUpdateEmptyResultIncident({
            alerting,
            sqlite: deps.sqlite,
            tenantId,
            workflowId: command.workflowId,
            receivedAt,
            executedAt,
            policy: emptyPolicy,
            itemsProcessed: classified.itemsProcessed ?? 0,
            externalExecutionRef: classified.externalExecutionRef,
            lastNonEmptySuccessAt: stampsPrevious,
            consecutiveEmpties: consecutiveEmptyResults,
            breachThreshold,
            enqueueOpened: (incidentId) =>
              enqueueOpened(alerting, tenantId, incidentId, receivedAt),
          });
        } else {
          resolveOpenIncidentsOfTypes({
            alerting,
            sqlite: deps.sqlite,
            tenantId,
            workflowId: command.workflowId,
            at: receivedAt,
            actor: "system:ingest-heartbeat",
            types: ["empty_result"],
          });
        }
      } else if (acceptable) {
        resolveOpenIncidentsOfTypes({
          alerting,
          sqlite: deps.sqlite,
          tenantId,
          workflowId: command.workflowId,
          at: receivedAt,
          actor: "system:ingest-heartbeat",
          types: ["hard_failure", "empty_result", "freshness_stale"],
        });
        if (watermarkEval.shouldOpenIncident) {
          openOrUpdateFreshnessIncident({
            alerting,
            tenantId,
            workflowId: command.workflowId,
            receivedAt,
            summary: `${workflowMeta?.name ?? "Workflow"}: source watermark did not advance`,
            detailsJson: JSON.stringify({
              status: watermarkEval.status,
              consecutiveStale: watermarkEval.consecutiveStale,
              watermark: watermarkEval.nextWatermark,
            }),
            enqueueOpened: (incidentId) =>
              enqueueOpened(alerting, tenantId, incidentId, receivedAt),
          });
        }
        if (effectEval.shouldResolveIncident) {
          resolveOpenIncidentsOfTypes({
            alerting,
            sqlite: deps.sqlite,
            tenantId,
            workflowId: command.workflowId,
            at: receivedAt,
            actor: "system:ingest-heartbeat",
            types: ["effect_count_mismatch"],
          });
        } else if (effectEval.shouldOpenIncident) {
          openOrUpdateEffectCountMismatchIncident({
            alerting,
            tenantId,
            workflowId: command.workflowId,
            receivedAt,
            summary: `${workflowMeta?.name ?? "Workflow"}: effect receipt count mismatch`,
            detailsJson: JSON.stringify({
              status: effectEval.status,
              expectedCount: effectEval.receipt.expectedCount,
              writtenCount: effectEval.receipt.writtenCount,
              inputBatchId: effectEval.receipt.inputBatchId,
              destinationName: effectEval.receipt.destinationName,
            }),
            enqueueOpened: (incidentId) =>
              enqueueOpened(alerting, tenantId, incidentId, receivedAt),
          });
        }
      }
    });

    run();
    return { status: "accepted", eventId, idempotentReplay: false };
  };
}

function readBodyHash(metadataJson: string | null): string | null {
  if (!metadataJson) {
    return null;
  }
  try {
    const parsed = JSON.parse(metadataJson) as { requestBodySha256?: string };
    return parsed.requestBodySha256 ?? null;
  } catch {
    return null;
  }
}

function upsertRateLimit(
  sqlite: Database.Database,
  input: {
    tenantId: string;
    workflowId: string;
    credentialId: string;
    decision: ReturnType<typeof evaluateCredentialRateLimit>;
    now: Date;
  },
): void {
  sqlite
    .prepare(
      `INSERT INTO ingestion_rate_limit_states (
         tenant_id, workflow_id, credential_id, window_started_at,
         accepted_count, rejected_count, last_rejected_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, workflow_id, credential_id) DO UPDATE SET
         window_started_at = excluded.window_started_at,
         accepted_count = excluded.accepted_count,
         rejected_count = excluded.rejected_count,
         last_rejected_at = excluded.last_rejected_at,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.tenantId,
      input.workflowId,
      input.credentialId,
      input.decision.windowStartedAt.toISOString(),
      input.decision.acceptedCount,
      input.decision.rejectedCount,
      input.decision.allowed ? null : input.now.toISOString(),
      input.now.toISOString(),
    );
}

function recordRejection(
  sqlite: Database.Database,
  input: {
    tenantId: string;
    workflowId: string;
    credentialId: string;
    now: Date;
    policy: RateLimitPolicy;
    accepting: boolean;
  },
): void {
  const rateRow = sqlite
    .prepare(
      `SELECT window_started_at, accepted_count, rejected_count
       FROM ingestion_rate_limit_states
       WHERE tenant_id = ? AND workflow_id = ? AND credential_id = ?`,
    )
    .get(input.tenantId, input.workflowId, input.credentialId) as
    | {
        window_started_at: string;
        accepted_count: number;
        rejected_count: number;
      }
    | undefined;
  const decision = evaluateCredentialRateLimit({
    now: input.now,
    windowStartedAt: rateRow ? new Date(rateRow.window_started_at) : null,
    acceptedCount: rateRow?.accepted_count ?? 0,
    rejectedCount: rateRow?.rejected_count ?? 0,
    policy: input.policy,
    accepting: input.accepting,
  });
  upsertRateLimit(sqlite, {
    tenantId: input.tenantId,
    workflowId: input.workflowId,
    credentialId: input.credentialId,
    decision,
    now: input.now,
  });
}

function markSustainedRejectionWarning(
  sqlite: Database.Database,
  tenantId: string,
  workflowId: string,
  now: Date,
): void {
  const ts = now.toISOString();
  sqlite
    .prepare(
      `INSERT INTO workflow_states (
         tenant_id, workflow_id, last_status, current_health, evidence_level,
         evidence_summary_code, unverified_dimensions_json, consecutive_stale_checks,
         updated_at
       ) VALUES (?, ?, 'unknown', 'warning', 'basic', 'sustained_ingestion_rejections', ?, 0, ?)
       ON CONFLICT(tenant_id, workflow_id) DO UPDATE SET
         current_health = 'warning',
         evidence_level = 'basic',
         evidence_summary_code = 'sustained_ingestion_rejections',
         updated_at = excluded.updated_at`,
    )
    .run(
      tenantId,
      workflowId,
      JSON.stringify(["destination_delivery_not_checked"]),
      ts,
    );
}

function enqueueOpened(
  alerting: SqliteAlertingRepositories,
  tenantId: string,
  incidentId: string,
  at: string,
): void {
  alerting.enqueueOutbox(tenantId, {
    id: createId(),
    incidentId,
    eventType: "opened",
    payloadJson: JSON.stringify({ incidentId }),
    availableAt: at,
  });
}
