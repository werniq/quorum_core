import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import {
  classifyHeartbeatEvidence,
  isAcceptableSuccess,
  type HeartbeatEvidenceStatus,
} from "../../domain/evidence/empty-result.js";
import { sanitizeHeartbeatMetadata } from "../../domain/evidence/heartbeat-metadata.js";
import { unverifiedDimensionsForEvidenceLevel } from "../../domain/evidence/unverified-dimensions.js";
import {
  buildHardFailureDetails,
  formatHardFailureSummary,
  parseHardFailureDetails,
} from "../../domain/incidents/hard-failure.js";
import { createId } from "../../domain/ids.js";
import { SqliteAlertingRepositories } from "../db/repositories/sqlite-alerting-repositories.js";
import {
  assertProcessingAllowed,
  type SchemaReadinessState,
} from "../../application/schema-readiness.js";
import {
  computeNextExpectedIso,
  openOrUpdateEmptyResultIncident,
  resolveOpenIncidentsOfTypes,
  upsertWorkflowStateAfterHeartbeat,
} from "./apply-heartbeat-state.js";

export interface PolledEvidenceCommand {
  tenantId: string;
  workflowId: string;
  executedAt: Date;
  evidenceStatus: HeartbeatEvidenceStatus;
  itemsProcessed: number | null;
  externalExecutionRef: string;
  idempotencyKey: string;
  metadata: Record<string, unknown>;
}

export type IngestPolledEvidenceResult =
  | { status: "accepted"; eventId: string; idempotentReplay: boolean }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "contract_inactive" }
  | { status: "bad_request"; code: string }
  | { status: "not_ready" }
  | { status: "wrong_monitoring_method" };

/**
 * Applies polled n8n evidence through the same durable heartbeat/state path as push.
 * Never activates contracts; inactive heartbeat contracts are skipped.
 */
export function createIngestPolledEvidenceHandler(deps: {
  sqlite: Database.Database;
  clock: Clock;
  getSchemaReadiness: () => SchemaReadinessState;
}): (command: PolledEvidenceCommand) => IngestPolledEvidenceResult {
  const alerting = new SqliteAlertingRepositories(deps.sqlite);

  return (command) => {
    try {
      assertProcessingAllowed(deps.getSchemaReadiness(), "ingestion");
    } catch {
      return { status: "not_ready" };
    }

    const workflow = deps.sqlite
      .prepare(
        `SELECT id, tenant_id, is_active, monitoring_method
         FROM workflows
         WHERE id = ? AND tenant_id = ?
         LIMIT 1`,
      )
      .get(command.workflowId, command.tenantId) as
      | {
          id: string;
          tenant_id: string;
          is_active: number;
          monitoring_method: string;
        }
      | undefined;

    if (!workflow || !workflow.is_active) {
      return { status: "not_found" };
    }
    if (workflow.monitoring_method !== "poll") {
      return { status: "wrong_monitoring_method" };
    }

    const contract = deps.sqlite
      .prepare(
        `SELECT * FROM workflow_contracts
         WHERE tenant_id = ? AND workflow_id = ? AND contract_type = 'heartbeat'
         LIMIT 1`,
      )
      .get(command.tenantId, command.workflowId) as
      | Record<string, unknown>
      | undefined;

    if (!contract) {
      return { status: "not_found" };
    }
    if (!contract.is_active) {
      return { status: "contract_inactive" };
    }

    const existing = deps.sqlite
      .prepare(
        `SELECT id FROM heartbeat_events
         WHERE tenant_id = ? AND workflow_id = ? AND idempotency_key = ?`,
      )
      .get(command.tenantId, command.workflowId, command.idempotencyKey) as
      | { id: string }
      | undefined;
    if (existing) {
      return {
        status: "accepted",
        eventId: existing.id,
        idempotentReplay: true,
      };
    }

    const emptyPolicy = contract.empty_result_policy as
      | "allowed"
      | "warning"
      | "failure";
    const evidenceClass = classifyHeartbeatEvidence(
      command.evidenceStatus,
      emptyPolicy,
    );

    if (
      command.evidenceStatus === "success" &&
      command.itemsProcessed === null &&
      !contract.count_less_success_allowed
    ) {
      return { status: "bad_request", code: "ITEMS_REQUIRED" };
    }

    const sanitized = sanitizeHeartbeatMetadata(command.metadata);
    if (!sanitized.ok) {
      return { status: "bad_request", code: "INVALID_METADATA" };
    }

    const now = deps.clock.now();
    const eventId = createId();
    const receivedAt = now.toISOString();
    const executedAt = command.executedAt.toISOString();

    const run = deps.sqlite.transaction(() => {
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
          command.tenantId,
          command.workflowId,
          receivedAt,
          executedAt,
          command.evidenceStatus,
          command.itemsProcessed,
          command.externalExecutionRef,
          command.idempotencyKey,
          sanitized.metadataJson,
          receivedAt,
        );

      const acceptable = isAcceptableSuccess(evidenceClass);
      const previous = deps.sqlite
        .prepare(
          `SELECT * FROM workflow_states WHERE tenant_id = ? AND workflow_id = ?`,
        )
        .get(command.tenantId, command.workflowId) as
        | Record<string, unknown>
        | undefined;

      const unverified = unverifiedDimensionsForEvidenceLevel("basic");
      const nextExpectedAt = computeNextExpectedIso({
        contract,
        lastReportAt: executedAt,
        clock: deps.clock,
      });

      upsertWorkflowStateAfterHeartbeat({
        sqlite: deps.sqlite,
        tenantId: command.tenantId,
        workflowId: command.workflowId,
        executedAt,
        receivedAt,
        evidenceStatus: command.evidenceStatus,
        itemsProcessed: command.itemsProcessed,
        externalExecutionRef: command.externalExecutionRef,
        previous,
        nextExpectedAt,
        evidenceSummaryCode: "heartbeat_basic_polled",
        unverifiedJson: JSON.stringify(unverified),
      });

      resolveOpenIncidentsOfTypes({
        alerting,
        sqlite: deps.sqlite,
        tenantId: command.tenantId,
        workflowId: command.workflowId,
        at: receivedAt,
        actor: "system:ingest-polled",
        types: ["silent_absence"],
      });

      if (command.evidenceStatus === "failure") {
        const workflowMeta = deps.sqlite
          .prepare(
            `SELECT name, monitoring_method FROM workflows
             WHERE tenant_id = ? AND id = ?`,
          )
          .get(command.tenantId, command.workflowId) as
          | { name: string; monitoring_method: string }
          | undefined;
        const before = alerting.getUnresolvedIncident(
          command.tenantId,
          "workflow",
          command.workflowId,
          "hard_failure",
        );
        const details = buildHardFailureDetails({
          existing: parseHardFailureDetails(before?.detailsJson),
          workflowName: workflowMeta?.name ?? "Workflow",
          monitoringMethod:
            workflowMeta?.monitoring_method === "poll" ||
            workflowMeta?.monitoring_method === "push"
              ? workflowMeta.monitoring_method
              : "poll",
          observedAt: executedAt,
          latestStatus: "failure",
          itemsProcessed: command.itemsProcessed,
          externalExecutionRef: command.externalExecutionRef,
        });
        const incident = alerting.openOrObserveIncident(command.tenantId, {
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
          alerting.enqueueOutbox(command.tenantId, {
            id: createId(),
            incidentId: incident.id,
            eventType: "opened",
            payloadJson: JSON.stringify({ incidentId: incident.id }),
            availableAt: receivedAt,
          });
        }
      } else if (command.evidenceStatus === "empty_result") {
        resolveOpenIncidentsOfTypes({
          alerting,
          sqlite: deps.sqlite,
          tenantId: command.tenantId,
          workflowId: command.workflowId,
          at: receivedAt,
          actor: "system:ingest-polled",
          types: ["hard_failure"],
        });
        if (emptyPolicy === "warning" || emptyPolicy === "failure") {
          openOrUpdateEmptyResultIncident({
            alerting,
            sqlite: deps.sqlite,
            tenantId: command.tenantId,
            workflowId: command.workflowId,
            receivedAt,
            executedAt,
            policy: emptyPolicy,
            itemsProcessed: command.itemsProcessed ?? 0,
            externalExecutionRef: command.externalExecutionRef,
            lastNonEmptySuccessAt:
              (previous?.last_nonempty_success_at as string | null) ?? null,
            enqueueOpened: (incidentId) => {
              alerting.enqueueOutbox(command.tenantId, {
                id: createId(),
                incidentId,
                eventType: "opened",
                payloadJson: JSON.stringify({ incidentId }),
                availableAt: receivedAt,
              });
            },
          });
        } else {
          resolveOpenIncidentsOfTypes({
            alerting,
            sqlite: deps.sqlite,
            tenantId: command.tenantId,
            workflowId: command.workflowId,
            at: receivedAt,
            actor: "system:ingest-polled",
            types: ["empty_result"],
          });
        }
      } else if (acceptable) {
        resolveOpenIncidentsOfTypes({
          alerting,
          sqlite: deps.sqlite,
          tenantId: command.tenantId,
          workflowId: command.workflowId,
          at: receivedAt,
          actor: "system:ingest-polled",
          types: ["hard_failure", "empty_result"],
        });
      }
    });

    try {
      run();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("UNIQUE") || message.includes("unique")) {
        const again = deps.sqlite
          .prepare(
            `SELECT id FROM heartbeat_events
             WHERE tenant_id = ? AND workflow_id = ? AND idempotency_key = ?`,
          )
          .get(command.tenantId, command.workflowId, command.idempotencyKey) as
          | { id: string }
          | undefined;
        if (again) {
          return {
            status: "accepted",
            eventId: again.id,
            idempotentReplay: true,
          };
        }
        return { status: "conflict" };
      }
      throw error;
    }

    return { status: "accepted", eventId, idempotentReplay: false };
  };
}
