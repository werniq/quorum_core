import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import { normalizeN8nExecution } from "../../domain/n8n/normalize-execution.js";
import { createId } from "../../domain/ids.js";
import { decryptCredentialSecret } from "../security/credential-secrets.js";
import type { SecureOutboundHttpOptions } from "../security/secure-outbound-http.js";
import { SqliteAlertingRepositories } from "../db/repositories/sqlite-alerting-repositories.js";
import { SqliteN8nConnectorRepositories } from "../db/repositories/sqlite-n8n-connector-repositories.js";
import {
  listN8nExecutions,
  validateN8nConnectorConnectivity,
} from "./n8n-api-client.js";
import type { IngestPolledEvidenceResult } from "../ingestion/ingest-polled-evidence.js";
import type { createIngestPolledEvidenceHandler } from "../ingestion/ingest-polled-evidence.js";
import {
  assertProcessingAllowed,
  type SchemaReadinessState,
} from "../../application/schema-readiness.js";

export type PollN8nWorkflowResult =
  | {
      status: "polled";
      ingested: number;
      skipped: number;
      replays: number;
    }
  | {
      status: "connector_error";
      health: string;
      code: string;
      summary: string;
    }
  | { status: "contract_inactive" }
  | { status: "not_found" }
  | { status: "not_ready" }
  | { status: "wrong_monitoring_method" };

export function createN8nPollingAdapter(deps: {
  sqlite: Database.Database;
  clock: Clock;
  kek: string;
  httpOptions: SecureOutboundHttpOptions;
  getSchemaReadiness: () => SchemaReadinessState;
  ingestPolledEvidence: ReturnType<typeof createIngestPolledEvidenceHandler>;
}) {
  const connectors = new SqliteN8nConnectorRepositories(deps.sqlite);
  const alerting = new SqliteAlertingRepositories(deps.sqlite);

  async function validateConnectivity(input: {
    tenantId: string;
    connectorId: string;
  }) {
    try {
      assertProcessingAllowed(deps.getSchemaReadiness(), "ingestion");
    } catch {
      return { status: "not_ready" as const };
    }

    const connector = connectors.getConnector(
      input.tenantId,
      input.connectorId,
    );
    if (!connector || connector.status !== "active") {
      return { status: "not_found" as const };
    }

    let apiKey: string;
    try {
      apiKey = decryptCredentialSecret(connector.encryptedApiKey, deps.kek);
    } catch {
      connectors.updateConnectorHealth(input.tenantId, input.connectorId, {
        health: "misconfigured",
        checkedAtIso: deps.clock.now().toISOString(),
        errorCode: "decrypt_failed",
        errorSummary: "connector_secret_unavailable",
      });
      return {
        status: "connector_error" as const,
        health: "misconfigured",
        code: "decrypt_failed",
        summary: "connector_secret_unavailable",
      };
    }

    const result = await validateN8nConnectorConnectivity(
      { baseUrl: connector.baseUrl, apiKey },
      deps.httpOptions,
    );
    const checkedAt = deps.clock.now().toISOString();
    if (!result.ok) {
      connectors.updateConnectorHealth(input.tenantId, input.connectorId, {
        health: result.health,
        checkedAtIso: checkedAt,
        errorCode: result.code,
        errorSummary: result.summary,
      });
      recordConnectorIncident(
        input.tenantId,
        result.code,
        result.summary,
        checkedAt,
      );
      return {
        status: "connector_error" as const,
        health: result.health,
        code: result.code,
        summary: result.summary,
      };
    }

    connectors.updateConnectorHealth(input.tenantId, input.connectorId, {
      health: "healthy",
      checkedAtIso: checkedAt,
      success: true,
      errorCode: null,
      errorSummary: null,
    });
    return {
      status: "healthy" as const,
      health: connectors.getConnectorHealthView(
        input.tenantId,
        input.connectorId,
      ),
    };
  }

  async function pollWorkflow(input: {
    tenantId: string;
    workflowId: string;
  }): Promise<PollN8nWorkflowResult> {
    try {
      assertProcessingAllowed(deps.getSchemaReadiness(), "ingestion");
    } catch {
      return { status: "not_ready" };
    }

    const workflow = deps.sqlite
      .prepare(
        `SELECT id, tenant_id, is_active, monitoring_method, external_workflow_id, connector_id
         FROM workflows
         WHERE tenant_id = ? AND id = ?
         LIMIT 1`,
      )
      .get(input.tenantId, input.workflowId) as
      | {
          id: string;
          tenant_id: string;
          is_active: number;
          monitoring_method: string;
          external_workflow_id: string;
          connector_id: string | null;
        }
      | undefined;

    if (!workflow || !workflow.is_active || !workflow.connector_id) {
      return { status: "not_found" };
    }
    if (workflow.monitoring_method !== "poll") {
      return { status: "wrong_monitoring_method" };
    }

    const contract = deps.sqlite
      .prepare(
        `SELECT is_active FROM workflow_contracts
         WHERE tenant_id = ? AND workflow_id = ? AND contract_type = 'heartbeat'
         LIMIT 1`,
      )
      .get(input.tenantId, input.workflowId) as
      | { is_active: number }
      | undefined;
    if (!contract) {
      return { status: "not_found" };
    }
    if (!contract.is_active) {
      return { status: "contract_inactive" };
    }

    const connector = connectors.getConnector(
      input.tenantId,
      workflow.connector_id,
    );
    if (!connector || connector.status !== "active") {
      return { status: "not_found" };
    }

    let apiKey: string;
    try {
      apiKey = decryptCredentialSecret(connector.encryptedApiKey, deps.kek);
    } catch {
      const checkedAt = deps.clock.now().toISOString();
      connectors.updateConnectorHealth(input.tenantId, connector.id, {
        health: "misconfigured",
        checkedAtIso: checkedAt,
        errorCode: "decrypt_failed",
        errorSummary: "connector_secret_unavailable",
      });
      return {
        status: "connector_error",
        health: "misconfigured",
        code: "decrypt_failed",
        summary: "connector_secret_unavailable",
      };
    }

    const listed = await listN8nExecutions({
      endpoint: { baseUrl: connector.baseUrl, apiKey },
      externalWorkflowId: workflow.external_workflow_id,
      options: deps.httpOptions,
    });
    const checkedAt = deps.clock.now().toISOString();
    if (!listed.ok) {
      connectors.updateConnectorHealth(input.tenantId, connector.id, {
        health: listed.health,
        checkedAtIso: checkedAt,
        errorCode: listed.code,
        errorSummary: listed.summary,
      });
      recordConnectorIncident(
        input.tenantId,
        listed.code,
        listed.summary,
        checkedAt,
        input.workflowId,
      );
      return {
        status: "connector_error",
        health: listed.health,
        code: listed.code,
        summary: listed.summary,
      };
    }

    connectors.updateConnectorHealth(input.tenantId, connector.id, {
      health: "healthy",
      checkedAtIso: checkedAt,
      success: true,
      errorCode: null,
      errorSummary: null,
    });

    const checkpoint = connectors.getCheckpoint(
      input.tenantId,
      input.workflowId,
    );
    const finished = listed.value
      .map((execution) => normalizeN8nExecution(execution))
      .filter((result) => result.ok)
      .map((result) => result.evidence);

    // Process oldest first for stable checkpoints.
    finished.sort((a, b) => a.executedAt.getTime() - b.executedAt.getTime());

    const unseen = finished.filter((evidence) => {
      if (!checkpoint?.lastSeenExecutionId) {
        return true;
      }
      if (evidence.externalExecutionRef === checkpoint.lastSeenExecutionId) {
        return false;
      }
      if (
        checkpoint.lastFinishedAt &&
        evidence.executedAt.getTime() <
          new Date(checkpoint.lastFinishedAt).getTime()
      ) {
        return false;
      }
      if (
        checkpoint.lastFinishedAt &&
        evidence.executedAt.getTime() ===
          new Date(checkpoint.lastFinishedAt).getTime()
      ) {
        return (
          compareExecutionId(
            evidence.externalExecutionRef,
            checkpoint.lastSeenExecutionId,
          ) > 0
        );
      }
      return true;
    });

    let ingested = 0;
    let skipped = 0;
    let replays = 0;
    let latestId = checkpoint?.lastSeenExecutionId ?? null;
    let latestFinished = checkpoint?.lastFinishedAt ?? null;

    for (const evidence of unseen) {
      const result: IngestPolledEvidenceResult = deps.ingestPolledEvidence({
        tenantId: input.tenantId,
        workflowId: input.workflowId,
        executedAt: evidence.executedAt,
        evidenceStatus: evidence.evidenceStatus,
        itemsProcessed: evidence.itemsProcessed,
        externalExecutionRef: evidence.externalExecutionRef,
        idempotencyKey: evidence.idempotencyKey,
        metadata: evidence.metadata,
      });

      if (result.status === "accepted") {
        if (result.idempotentReplay) {
          replays += 1;
        } else {
          ingested += 1;
        }
        latestId = evidence.externalExecutionRef;
        latestFinished = evidence.executedAt.toISOString();
      } else if (result.status === "contract_inactive") {
        return { status: "contract_inactive" };
      } else {
        skipped += 1;
      }
    }

    connectors.upsertCheckpoint(input.tenantId, input.workflowId, {
      connectorId: connector.id,
      lastSeenExecutionId: latestId,
      lastFinishedAt: latestFinished,
      updatedAtIso: checkedAt,
    });

    return { status: "polled", ingested, skipped, replays };
  }

  function recordConnectorIncident(
    tenantId: string,
    code: string,
    summary: string,
    observedAt: string,
    workflowId?: string,
  ): void {
    const incident = alerting.openOrObserveIncident(tenantId, {
      id: createId(),
      contractKind: workflowId ? "workflow" : "system",
      workflowId: workflowId ?? null,
      incidentType: "connector_unavailable",
      severity: code === "auth_failed" ? "critical" : "warning",
      summary: `n8n connector ${code}: ${summary}`,
      observedAt,
    });
    alerting.enqueueOutbox(tenantId, {
      id: createId(),
      incidentId: incident.id,
      eventType: "opened",
      payloadJson: JSON.stringify({
        incidentId: incident.id,
        code,
      }),
      availableAt: observedAt,
    });
  }

  return {
    validateConnectivity,
    pollWorkflow,
    getHealthView: (tenantId: string, connectorId: string) =>
      connectors.getConnectorHealthView(tenantId, connectorId),
    repositories: connectors,
  };
}

function compareExecutionId(a: string, b: string): number {
  const an = Number(a);
  const bn = Number(b);
  if (Number.isFinite(an) && Number.isFinite(bn)) {
    return an - bn;
  }
  return a.localeCompare(b);
}
