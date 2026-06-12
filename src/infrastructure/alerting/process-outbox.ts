import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import type { AlertNotificationPayload } from "../../domain/alerting/notification-payload.js";
import {
  evidenceExplanationForLevel,
  verifiedDimensionsForEvidenceLevel,
} from "../../domain/catalog/evidence-explanation.js";
import { unverifiedDimensionsForEvidenceLevel } from "../../domain/evidence/unverified-dimensions.js";
import { createId } from "../../domain/ids.js";
import { decryptCredentialSecret } from "../security/credential-secrets.js";
import { sanitizeDeliveryErrorMessage } from "../../domain/alerting/sanitize-delivery-error.js";
import { SqliteAlertingRepositories } from "../db/repositories/sqlite-alerting-repositories.js";
import {
  assertProcessingAllowed,
  type SchemaReadinessState,
} from "../../application/schema-readiness.js";
import { localMetrics } from "../observability/metrics.js";
import type {
  AlertDeliveryProviders,
  SmtpChannelConfig,
  WebhookChannelConfig,
} from "./delivery-providers.js";

export interface ProcessOutboxResult {
  processed: number;
  delivered: number;
  failed: number;
  retried: number;
}

export function createOutboxProcessor(deps: {
  sqlite: Database.Database;
  clock: Clock;
  kek: string;
  claimOwner: string;
  claimTtlMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  deliveryTimeoutMs: number;
  publicBaseUrl: string;
  providers: AlertDeliveryProviders;
  getSchemaReadiness: () => SchemaReadinessState;
  edition: "self_hosted" | "saas";
}) {
  const alerting = new SqliteAlertingRepositories(deps.sqlite);

  async function processBatch(limit = 20): Promise<ProcessOutboxResult> {
    assertProcessingAllowed(deps.getSchemaReadiness(), "outbox");
    const now = deps.clock.now();
    const nowIso = now.toISOString();
    const claimed = alerting.claimOutboxBatch(null, {
      nowIso,
      claimOwner: deps.claimOwner,
      claimExpiresAtIso: new Date(
        now.getTime() + deps.claimTtlMs,
      ).toISOString(),
      limit,
    });

    let processed = 0;
    let delivered = 0;
    let failed = 0;
    let retried = 0;

    for (const item of claimed) {
      const outcome = await processOne(item.id, item.tenantId, nowIso);
      processed += 1;
      if (outcome === "delivered") delivered += 1;
      else if (outcome === "failed") failed += 1;
      else retried += 1;
    }

    localMetrics.inc("quorum_outbox_processed_total", undefined, processed);
    localMetrics.inc("quorum_outbox_delivered_total", undefined, delivered);
    localMetrics.inc("quorum_outbox_failed_total", undefined, failed);
    localMetrics.inc("quorum_outbox_retried_total", undefined, retried);

    return { processed, delivered, failed, retried };
  }

  async function processOne(
    outboxId: string,
    tenantId: string,
    nowIso: string,
  ): Promise<"delivered" | "failed" | "retried"> {
    const outbox = deps.sqlite
      .prepare(
        `SELECT * FROM notification_outbox WHERE tenant_id = ? AND id = ?`,
      )
      .get(tenantId, outboxId) as Record<string, unknown> | undefined;
    if (!outbox || outbox.processed_at) {
      return "delivered";
    }

    const incidentId = outbox.incident_id as string | null;
    const eventType = String(outbox.event_type);

    if (eventType === "channel_test") {
      return processChannelTest(
        tenantId,
        outboxId,
        nowIso,
        String(outbox.payload_json),
      );
    }

    if (!incidentId) {
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      return "delivered";
    }

    const incident = alerting.getIncident(tenantId, incidentId);
    if (!incident || !incident.workflowId) {
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      return "delivered";
    }

    const payload = buildPayload(
      tenantId,
      incident.workflowId,
      incident,
      String(outbox.event_type),
    );
    const routes = listWorkflowAlertRoutes(
      deps.sqlite,
      alerting,
      tenantId,
      incident.workflowId,
    );

    if (routes.length === 0) {
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      return "delivered";
    }

    let anyFailure = false;
    let anySuccess = false;

    for (const route of routes) {
      const channel = alerting.getAlertChannel(tenantId, route.alertChannelId);
      if (!channel || !channel.isActive) {
        continue;
      }

      let configJson: string;
      try {
        configJson = decryptCredentialSecret(channel.encryptedConfig, deps.kek);
      } catch {
        anyFailure = true;
        alerting.recordNotificationAttempt(tenantId, {
          id: createId(),
          incidentId,
          alertChannelId: channel.id,
          outboxId,
          status: "failed",
          attemptedAt: nowIso,
          deliveredAt: null,
          externalMessageId: null,
          externalThreadId: null,
          responseStatusCode: null,
          errorCode: "config_decrypt_failed",
          errorMessageSanitized: "channel_config_unavailable",
        });
        alerting.applyChannelDeliveryResult(
          tenantId,
          channel.id,
          {
            type: "delivery_failed",
            retriesRemaining: false,
            errorCode: "config_decrypt_failed",
            errorMessage: "channel_config_unavailable",
          },
          nowIso,
        );
        continue;
      }

      const existingThread = alerting.findLatestExternalThreadId(
        tenantId,
        incidentId,
        channel.id,
      );

      let result;
      try {
        if (channel.type === "webhook") {
          const config = JSON.parse(configJson) as WebhookChannelConfig;
          result = await deps.providers.deliverWebhook(config, payload, {
            timeoutMs: deps.deliveryTimeoutMs,
            existingThreadId: existingThread,
          });
        } else {
          const config = JSON.parse(configJson) as SmtpChannelConfig;
          result = await deps.providers.deliverSmtp(config, payload, {
            timeoutMs: deps.deliveryTimeoutMs,
            existingThreadId: existingThread,
          });
        }
      } catch (error) {
        result = {
          ok: false as const,
          errorCode: "delivery_exception",
          errorMessage:
            error instanceof Error ? error.message : "delivery_failed",
          responseStatusCode: null,
        };
      }

      const attemptCount = Number(outbox.attempt_count) + 1;
      if (result.ok) {
        anySuccess = true;
        alerting.recordNotificationAttempt(tenantId, {
          id: createId(),
          incidentId,
          alertChannelId: channel.id,
          outboxId,
          status: "sent",
          attemptedAt: nowIso,
          deliveredAt: nowIso,
          externalMessageId: result.externalMessageId,
          externalThreadId: result.externalThreadId ?? existingThread,
          responseStatusCode: result.responseStatusCode,
          errorCode: null,
          errorMessageSanitized: null,
        });
        alerting.applyChannelDeliveryResult(
          tenantId,
          channel.id,
          { type: "delivery_succeeded" },
          nowIso,
        );
      } else {
        anyFailure = true;
        const retriesRemaining = attemptCount < deps.maxAttempts;
        alerting.recordNotificationAttempt(tenantId, {
          id: createId(),
          incidentId,
          alertChannelId: channel.id,
          outboxId,
          status: "failed",
          attemptedAt: nowIso,
          deliveredAt: null,
          externalMessageId: null,
          externalThreadId: existingThread,
          responseStatusCode: result.responseStatusCode,
          errorCode: result.errorCode,
          errorMessageSanitized: sanitizeDeliveryErrorMessage(
            result.errorMessage,
          ),
        });
        alerting.applyChannelDeliveryResult(
          tenantId,
          channel.id,
          {
            type: "delivery_failed",
            retriesRemaining,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
          },
          nowIso,
        );
      }
    }

    // Incident commit already happened; delivery failure never rolls it back.
    if (anySuccess && !anyFailure) {
      alerting.markIncidentNotified(tenantId, incidentId, nowIso);
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      return "delivered";
    }

    const nextAttempt = Number(outbox.attempt_count) + 1;
    if (nextAttempt >= deps.maxAttempts) {
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      alerting.openOrObserveIncident(tenantId, {
        id: createId(),
        contractKind: "system",
        incidentType: "alert_delivery_failure",
        severity: "warning",
        summary: "Alert delivery retries exhausted",
        detailsJson: JSON.stringify({ outboxId, incidentId }),
        observedAt: nowIso,
      });
      return "failed";
    }

    const delay = deps.retryBaseMs * nextAttempt;
    alerting.scheduleOutboxRetry(tenantId, outboxId, {
      availableAtIso: new Date(
        deps.clock.now().getTime() + delay,
      ).toISOString(),
      attemptCount: nextAttempt,
      lastError: "delivery_failed",
    });
    return "retried";
  }

  async function processChannelTest(
    tenantId: string,
    outboxId: string,
    nowIso: string,
    payloadJson: string,
  ): Promise<"delivered" | "failed" | "retried"> {
    let alertChannelId: string | null = null;
    try {
      const parsed = JSON.parse(payloadJson) as { alertChannelId?: string };
      alertChannelId = parsed.alertChannelId ?? null;
    } catch {
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      return "failed";
    }
    if (!alertChannelId) {
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      return "failed";
    }
    const channel = alerting.getAlertChannel(tenantId, alertChannelId);
    if (!channel) {
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      return "failed";
    }

    let configJson: string;
    try {
      configJson = decryptCredentialSecret(channel.encryptedConfig, deps.kek);
    } catch {
      alerting.applyChannelDeliveryResult(
        tenantId,
        channel.id,
        {
          type: "delivery_failed",
          retriesRemaining: false,
          errorCode: "config_decrypt_failed",
          errorMessage: "channel_config_unavailable",
        },
        nowIso,
      );
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      return "failed";
    }

    let result;
    const testPayload = {
      schemaVersion: 1,
      eventType: "channel_test",
      alertChannelId: channel.id,
    };
    try {
      if (channel.type === "webhook") {
        const config = JSON.parse(configJson) as WebhookChannelConfig;
        result = await deps.providers.deliverWebhook(config, testPayload, {
          timeoutMs: deps.deliveryTimeoutMs,
          existingThreadId: null,
        });
      } else {
        const config = JSON.parse(configJson) as SmtpChannelConfig;
        result = await deps.providers.deliverSmtp(config, testPayload, {
          timeoutMs: deps.deliveryTimeoutMs,
          existingThreadId: null,
        });
      }
    } catch (error) {
      result = {
        ok: false as const,
        errorCode: "delivery_exception",
        errorMessage:
          error instanceof Error ? error.message : "delivery_failed",
        responseStatusCode: null,
      };
    }

    alerting.recordNotificationAttempt(tenantId, {
      id: createId(),
      incidentId: null,
      alertChannelId: channel.id,
      outboxId,
      status: result.ok ? "sent" : "failed",
      attemptedAt: nowIso,
      deliveredAt: result.ok ? nowIso : null,
      externalMessageId: result.ok ? result.externalMessageId : null,
      externalThreadId: result.ok ? result.externalThreadId : null,
      responseStatusCode: result.responseStatusCode,
      errorCode: result.ok ? null : result.errorCode,
      errorMessageSanitized: result.ok
        ? null
        : sanitizeDeliveryErrorMessage(result.errorMessage),
    });

    if (result.ok) {
      alerting.applyChannelDeliveryResult(
        tenantId,
        channel.id,
        { type: "test_succeeded" },
        nowIso,
      );
      alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
      return "delivered";
    }

    alerting.applyChannelDeliveryResult(
      tenantId,
      channel.id,
      {
        type: "delivery_failed",
        retriesRemaining: false,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      },
      nowIso,
    );
    alerting.markOutboxProcessed(tenantId, outboxId, nowIso);
    return "failed";
  }

  function buildPayload(
    tenantId: string,
    workflowId: string,
    incident: NonNullable<
      ReturnType<SqliteAlertingRepositories["getIncident"]>
    >,
    eventType: string,
  ): AlertNotificationPayload {
    const contract = deps.sqlite
      .prepare(
        `SELECT * FROM workflow_contracts
         WHERE tenant_id = ? AND workflow_id = ? AND contract_type = 'heartbeat'
         LIMIT 1`,
      )
      .get(tenantId, workflowId) as Record<string, unknown> | undefined;
    const state = deps.sqlite
      .prepare(
        `SELECT * FROM workflow_states WHERE tenant_id = ? AND workflow_id = ?`,
      )
      .get(tenantId, workflowId) as Record<string, unknown> | undefined;
    const client = incident.clientId
      ? (deps.sqlite
          .prepare(
            `SELECT id, name FROM clients WHERE tenant_id = ? AND id = ?`,
          )
          .get(tenantId, incident.clientId) as
          | { id: string; name: string }
          | undefined)
      : undefined;

    const evidenceLevel =
      (state?.evidence_level as "basic" | "medium" | "high" | undefined) ??
      "basic";
    const unverified = unverifiedDimensionsForEvidenceLevel(evidenceLevel);
    const overdueSince = state?.overdue_since
      ? new Date(String(state.overdue_since))
      : null;
    const overdueDurationSeconds =
      overdueSince !== null
        ? Math.max(
            0,
            Math.floor(
              (deps.clock.now().getTime() - overdueSince.getTime()) / 1000,
            ),
          )
        : null;

    let details: {
      expectedAt?: string | null;
      deadlineAt?: string | null;
      overdueSince?: string | null;
    } = {};
    if (incident.detailsJson) {
      try {
        details = JSON.parse(incident.detailsJson) as typeof details;
      } catch {
        details = {};
      }
    }

    return {
      schemaVersion: 1,
      eventType,
      incident: {
        id: incident.id,
        type: incident.incidentType,
        severity: incident.severity,
        status: incident.status,
        summary: incident.summary,
      },
      client: {
        id: client?.id ?? null,
        name: client?.name ?? null,
      },
      contract: {
        id: String(contract?.id ?? workflowId),
        kind: "workflow",
        name: String(contract?.name ?? "contract"),
        businessPurpose: String(contract?.business_purpose ?? ""),
      },
      expectation: {
        expectedAt: details.expectedAt ?? null,
        deadlineAt:
          details.deadlineAt ??
          (state?.next_expected_at ? String(state.next_expected_at) : null),
        overdueSince:
          details.overdueSince ??
          (state?.overdue_since ? String(state.overdue_since) : null),
        overdueDurationSeconds,
      },
      observation: {
        lastStatus: state?.last_status ? String(state.last_status) : null,
        lastAcceptableEvidenceAt: state?.last_acceptable_success_at
          ? String(state.last_acceptable_success_at)
          : null,
        currentHealth: state?.current_health
          ? String(state.current_health)
          : "unknown",
      },
      evidence: {
        level: evidenceLevel,
        explanation: evidenceExplanationForLevel(evidenceLevel, unverified),
        verifiedDimensions: [
          ...verifiedDimensionsForEvidenceLevel(evidenceLevel),
        ],
        unverifiedDimensions: [...unverified],
      },
      catalogEntryUrl: `${deps.publicBaseUrl.replace(/\/+$/, "")}/catalog/contracts/${workflowId}`,
    };
  }

  return { processBatch };
}

/** Resolve alert routes stored under workflow_contracts.id or legacy workflows.id. */
function listWorkflowAlertRoutes(
  sqlite: Database.Database,
  alerting: SqliteAlertingRepositories,
  tenantId: string,
  workflowId: string,
) {
  const contractIds = sqlite
    .prepare(
      `SELECT id FROM workflow_contracts WHERE tenant_id = ? AND workflow_id = ?`,
    )
    .all(tenantId, workflowId) as Array<{ id: string }>;
  const keys = new Set<string>([workflowId, ...contractIds.map((c) => c.id)]);
  const byChannel = new Map<
    string,
    ReturnType<SqliteAlertingRepositories["listRoutesForContract"]>[number]
  >();
  for (const key of keys) {
    for (const route of alerting.listRoutesForContract(
      tenantId,
      "workflow",
      key,
    )) {
      byChannel.set(route.alertChannelId, route);
    }
  }
  return [...byChannel.values()];
}
