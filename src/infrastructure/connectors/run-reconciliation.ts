import type Database from "better-sqlite3";
import type { Clock } from "../../domain/clock.js";
import { createId } from "../../domain/ids.js";
import {
  evaluateMissingAgainstPolicy,
  matchByNormalizedEmail,
  oldestMissingAgeSeconds,
} from "../../domain/outcome/match-email.js";
import {
  planOutcomeIncidents,
  shouldResolveMissingIncidents,
} from "../../domain/outcome/incidents.js";
import {
  evidenceLevelAchievedForRun,
  FIRST_SUPPORTED_PATH,
} from "../../domain/outcome/types.js";
import { isConnectorReadable } from "../../domain/outcome/connector-policy.js";
import { decryptCredentialSecret } from "../security/credential-secrets.js";
import type { SecureOutboundHttpOptions } from "../security/secure-outbound-http.js";
import { SqliteOutboundDestinationRepositories } from "../db/repositories/sqlite-outbound-destinations.js";
import { SqliteOutcomeConnectorRepositories } from "../db/repositories/sqlite-outcome-connector-repositories.js";
import { SqliteOutcomeContractRepositories } from "../db/repositories/sqlite-outcome-contract-repositories.js";
import { SqliteReconciliationRepositories } from "../db/repositories/sqlite-reconciliation-repositories.js";
import { SqliteAlertingRepositories } from "../db/repositories/sqlite-alerting-repositories.js";
import {
  fetchHubSpotWebinarRegistrations,
  probeHubSpotHealth,
  type HubSpotCredentials,
} from "./hubspot-webinar.js";
import {
  fetchZoomWebinarRegistrants,
  probeZoomHealth,
  type ZoomCredentials,
} from "./zoom-webinar.js";

export class ConnectorRevokedError extends Error {
  constructor() {
    super("connector_revoked_or_unreadable");
    this.name = "ConnectorRevokedError";
  }
}

export function createReconciliationRunner(deps: {
  sqlite: Database.Database;
  clock: Clock;
  kek: string;
  identifierHmacKey: string;
  http: SecureOutboundHttpOptions;
}) {
  const connectors = new SqliteOutcomeConnectorRepositories(deps.sqlite);
  const contracts = new SqliteOutcomeContractRepositories(deps.sqlite);
  const runs = new SqliteReconciliationRepositories(deps.sqlite);
  const outbound = new SqliteOutboundDestinationRepositories(deps.sqlite);
  const alerting = new SqliteAlertingRepositories(deps.sqlite);

  async function probeConnector(tenantId: string, connectorId: string) {
    const connector = connectors.get(tenantId, connectorId);
    if (!connector) {
      throw new Error("connector_not_found");
    }
    const nowIso = deps.clock.now().toISOString();
    const credsJson = decryptCredentialSecret(
      connector.encryptedCredentials,
      deps.kek,
    );
    if (connector.provider === "hubspot") {
      const creds = JSON.parse(credsJson) as HubSpotCredentials;
      const result = await probeHubSpotHealth({
        credentials: creds,
        http: deps.http,
      });
      outbound.recordAttempt({
        tenantId,
        kind: "webhook",
        destination: "https://api.hubapi.com/",
        status: result.ok ? "success" : "failure",
        errorSummary: result.ok ? null : result.message,
        nowIso,
      });
      connectors.recordHealth(tenantId, connectorId, {
        ok: result.ok,
        nowIso,
        errorCode: result.ok ? null : result.code,
        errorSummary: result.ok ? null : result.message,
      });
      if (!result.ok) {
        openConnectorIncident(tenantId, connectorId, result.message);
      }
      return result;
    }

    const creds = JSON.parse(credsJson) as ZoomCredentials;
    const result = await probeZoomHealth({
      credentials: creds,
      http: deps.http,
    });
    outbound.recordAttempt({
      tenantId,
      kind: "webhook",
      destination: "https://zoom.us/",
      status: result.ok ? "success" : "failure",
      errorSummary: result.ok ? null : result.message,
      nowIso,
    });
    connectors.recordHealth(tenantId, connectorId, {
      ok: result.ok,
      nowIso,
      errorCode: result.ok ? null : result.code,
      errorSummary: result.ok ? null : result.message,
    });
    if (!result.ok) {
      openConnectorIncident(tenantId, connectorId, result.message);
    }
    return result;
  }

  function openConnectorIncident(
    tenantId: string,
    connectorId: string,
    message: string,
  ): void {
    const linked = contracts
      .list(tenantId)
      .filter(
        (c) =>
          c.sourceConnectorId === connectorId ||
          c.destinationConnectorId === connectorId,
      );
    for (const contract of linked) {
      const before = alerting.getUnresolvedIncident(
        tenantId,
        "outcome",
        contract.id,
        "connector_unavailable",
      );
      const incident = alerting.openOrObserveIncident(tenantId, {
        id: createId(),
        clientId: contract.clientId,
        contractKind: "outcome",
        outcomeContractId: contract.id,
        incidentType: "connector_unavailable",
        severity: "critical",
        summary: `Connector unavailable for outcome contract`,
        detailsJson: JSON.stringify({
          connectorId,
          error: message,
          suggestedRecoveryBoundary:
            "Restore connector credentials/network, probe health, then re-run reconciliation. Prior High evidence is stale until a fresh verified window.",
        }),
        observedAt: deps.clock.now().toISOString(),
      });
      if (!before) {
        alerting.enqueueOutbox(tenantId, {
          id: createId(),
          incidentId: incident.id,
          eventType: "opened",
          payloadJson: JSON.stringify({
            incidentId: incident.id,
            incidentType: "connector_unavailable",
          }),
          availableAt: deps.clock.now().toISOString(),
        });
      }
    }
  }

  async function runWindow(input: {
    tenantId: string;
    outcomeContractId: string;
    windowStart: Date;
    windowEnd: Date;
    force?: boolean;
  }) {
    const contract = contracts.get(input.tenantId, input.outcomeContractId);
    if (!contract) {
      throw new Error("outcome_contract_not_found");
    }
    if (!contract.isActive) {
      throw new Error("outcome_contract_inactive");
    }

    const source = connectors.get(input.tenantId, contract.sourceConnectorId);
    const destination = connectors.get(
      input.tenantId,
      contract.destinationConnectorId,
    );
    if (!source || !destination) {
      throw new Error("connector_not_found");
    }
    if (
      !isConnectorReadable(source.status) ||
      !isConnectorReadable(destination.status)
    ) {
      openConnectorIncident(
        input.tenantId,
        !isConnectorReadable(source.status) ? source.id : destination.id,
        "revoked_or_unreadable",
      );
      throw new ConnectorRevokedError();
    }

    const windowStart = input.windowStart.toISOString();
    const windowEnd = input.windowEnd.toISOString();
    const nowIso = deps.clock.now().toISOString();
    const existing = runs.findByWindow(
      input.tenantId,
      contract.id,
      windowStart,
      windowEnd,
    );

    let runId: string;
    if (existing && existing.status !== "running" && !input.force) {
      runs.recordAudit({
        tenantId: input.tenantId,
        outcomeContractId: contract.id,
        reconciliationRunId: existing.id,
        eventType: "run_idempotent_hit",
        createdAt: nowIso,
      });
      return existing;
    }

    if (existing) {
      runId = existing.id;
      runs.deleteItemsForRun(input.tenantId, runId);
      runs.markRunning(input.tenantId, runId, nowIso);
      runs.recordAudit({
        tenantId: input.tenantId,
        outcomeContractId: contract.id,
        reconciliationRunId: runId,
        eventType: "run_resumed",
        createdAt: nowIso,
      });
    } else {
      const started = runs.createRun(input.tenantId, {
        outcomeContractId: contract.id,
        windowStart,
        windowEnd,
        sourceCount: 0,
        destinationCount: 0,
        matchedCount: 0,
        missingCount: 0,
        duplicateCount: 0,
        lateCount: 0,
        status: "running",
        evidenceLevelAchieved: "medium",
        startedAt: nowIso,
        completedAt: null,
        detailsLocationOrJson: null,
      });
      runId = started.id;
    }

    try {
      const sourceCreds = JSON.parse(
        decryptCredentialSecret(source.encryptedCredentials, deps.kek),
      ) as HubSpotCredentials;
      const destCreds = JSON.parse(
        decryptCredentialSecret(destination.encryptedCredentials, deps.kek),
      ) as ZoomCredentials;

      let sourceRows;
      let destRows;
      try {
        sourceRows = await fetchHubSpotWebinarRegistrations({
          credentials: sourceCreds,
          marketingEventId: contract.matchKeyDefinition.sourceObjectId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          http: deps.http,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "hubspot_failed";
        if (
          msg.includes("auth") ||
          (error as { code?: string }).code === "auth_failed"
        ) {
          // schema_drift not appropriate; connector auth
        }
        openConnectorIncident(input.tenantId, source.id, msg);
        throw error;
      }

      outbound.recordAttempt({
        tenantId: input.tenantId,
        kind: "webhook",
        destination: "https://api.hubapi.com/",
        status: "success",
        nowIso: deps.clock.now().toISOString(),
      });

      try {
        destRows = await fetchZoomWebinarRegistrants({
          credentials: destCreds,
          webinarId: contract.matchKeyDefinition.destinationObjectId,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
          http: deps.http,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "zoom_failed";
        openConnectorIncident(input.tenantId, destination.id, msg);
        throw error;
      }

      outbound.recordAttempt({
        tenantId: input.tenantId,
        kind: "webhook",
        destination: "https://api.zoom.us/",
        status: "success",
        nowIso: deps.clock.now().toISOString(),
      });

      connectors.recordHealth(input.tenantId, source.id, {
        ok: true,
        nowIso: deps.clock.now().toISOString(),
      });
      connectors.recordHealth(input.tenantId, destination.id, {
        ok: true,
        nowIso: deps.clock.now().toISOString(),
      });

      if (contract.contractType === "aggregate_check") {
        const sourceCount = sourceRows.length;
        const destinationCount = destRows.length;
        const missingCount = Math.max(0, sourceCount - destinationCount);
        const status = evaluateMissingAgainstPolicy({
          sourceCount,
          missingCount,
          acceptableMissingCount: contract.acceptableMissingCount,
          acceptableMissingPercentage: contract.acceptableMissingPercentage,
        });
        const evidence = evidenceLevelAchievedForRun({
          contractType: contract.contractType,
          evidenceLevelTarget: contract.evidenceLevelTarget,
          matchedExactly: false,
          aggregateOnly: true,
        });
        deps.sqlite
          .prepare(
            `UPDATE reconciliation_runs
             SET source_count = ?, destination_count = ?, matched_count = ?,
                 missing_count = ?, duplicate_count = 0, late_count = 0,
                 status = ?, evidence_level_achieved = ?, completed_at = ?,
                 details_location_or_json = ?
             WHERE tenant_id = ? AND id = ?`,
          )
          .run(
            sourceCount,
            destinationCount,
            Math.min(sourceCount, destinationCount),
            missingCount,
            status,
            evidence,
            deps.clock.now().toISOString(),
            JSON.stringify({
              path: FIRST_SUPPORTED_PATH.id,
              mode: "aggregate_check",
            }),
            input.tenantId,
            runId,
          );
        applyIncidentsForAggregate(input.tenantId, contract, {
          sourceCount,
          destinationCount,
          missingCount,
          evidence,
          status,
        });
        return runs.getRun(input.tenantId, runId)!;
      }

      const matched = matchByNormalizedEmail({
        source: sourceRows,
        destination: destRows,
        now: deps.clock.now(),
        maximumDeliveryDelayMinutes: contract.maximumDeliveryDelayMinutes,
        identifierHmacKey: deps.identifierHmacKey,
      });
      const status = evaluateMissingAgainstPolicy({
        sourceCount: matched.sourceCount,
        missingCount: matched.missingCount,
        acceptableMissingCount: contract.acceptableMissingCount,
        acceptableMissingPercentage: contract.acceptableMissingPercentage,
      });
      const evidence = evidenceLevelAchievedForRun({
        contractType: contract.contractType,
        evidenceLevelTarget: contract.evidenceLevelTarget,
        matchedExactly:
          matched.missingCount === 0 &&
          matched.duplicateCount === 0 &&
          matched.waitingCount === 0,
        aggregateOnly: false,
      });
      // Late deliveries still count as record-level proof when nothing is missing/waiting
      const evidenceFinal =
        matched.missingCount === 0 &&
        matched.waitingCount === 0 &&
        matched.duplicateCount === 0 &&
        contract.evidenceLevelTarget === "high"
          ? "high"
          : evidence;

      runs.insertItems(
        input.tenantId,
        matched.items.map((item) => ({
          reconciliationRunId: runId,
          sourceIdentifierHash: item.sourceIdentifierHash,
          destinationIdentifierHash: item.destinationIdentifierHash,
          matchStatus: item.matchStatus,
          sourceObservedAt: item.sourceObservedAt?.toISOString() ?? null,
          destinationObservedAt:
            item.destinationObservedAt?.toISOString() ?? null,
          metadataJsonSanitized: JSON.stringify({
            path: FIRST_SUPPORTED_PATH.id,
          }),
        })),
      );

      const oldestAge = oldestMissingAgeSeconds({
        now: deps.clock.now(),
        items: matched.items,
      });

      deps.sqlite
        .prepare(
          `UPDATE reconciliation_runs
           SET source_count = ?, destination_count = ?, matched_count = ?,
               missing_count = ?, duplicate_count = ?, late_count = ?,
               status = ?, evidence_level_achieved = ?, completed_at = ?,
               details_location_or_json = ?
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(
          matched.sourceCount,
          matched.destinationCount,
          matched.matchedCount,
          matched.missingCount,
          matched.duplicateCount,
          matched.lateCount,
          status === "healthy" && matched.waitingCount > 0 ? "warning" : status,
          evidenceFinal,
          deps.clock.now().toISOString(),
          JSON.stringify({
            path: FIRST_SUPPORTED_PATH.id,
            mode: "record_match",
            waitingCount: matched.waitingCount,
            oldestMissingAgeSeconds: oldestAge,
          }),
          input.tenantId,
          runId,
        );

      syncOutcomeIncidents(input.tenantId, contract, {
        match: matched,
        evidenceLevel: evidenceFinal,
        oldestMissingAgeSeconds: oldestAge,
        runStatus:
          status === "healthy" && matched.waitingCount > 0 ? "warning" : status,
        runId,
      });

      const retainAfter = new Date(
        deps.clock.now().getTime() -
          contract.retentionDays * 24 * 60 * 60 * 1000,
      ).toISOString();
      runs.purgeExpiredEvidence(
        input.tenantId,
        contract.id,
        retainAfter,
        deps.clock.now().toISOString(),
      );

      return runs.getRun(input.tenantId, runId)!;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "reconciliation_failed";
      deps.sqlite
        .prepare(
          `UPDATE reconciliation_runs
           SET status = 'failed', completed_at = ?, details_location_or_json = ?,
               evidence_level_achieved = 'medium'
           WHERE tenant_id = ? AND id = ?`,
        )
        .run(
          deps.clock.now().toISOString(),
          JSON.stringify({ error: message }),
          input.tenantId,
          runId,
        );
      throw error;
    }
  }

  function applyIncidentsForAggregate(
    tenantId: string,
    contract: { id: string; clientId: string | null; businessPurpose: string },
    input: {
      sourceCount: number;
      destinationCount: number;
      missingCount: number;
      evidence: "medium" | "high";
      status: "healthy" | "warning" | "failed";
    },
  ): void {
    if (input.missingCount <= 0) {
      resolveOutcomeMissing(tenantId, contract.id);
      return;
    }
    const before = alerting.getUnresolvedIncident(
      tenantId,
      "outcome",
      contract.id,
      "missing_destination_records",
    );
    const incident = alerting.openOrObserveIncident(tenantId, {
      id: createId(),
      clientId: contract.clientId,
      contractKind: "outcome",
      outcomeContractId: contract.id,
      incidentType: "missing_destination_records",
      severity: input.status === "failed" ? "critical" : "warning",
      summary: `Aggregate gap — ${input.missingCount} missing`,
      detailsJson: JSON.stringify({
        expectedBusinessOutcome: contract.businessPurpose,
        sourceCount: input.sourceCount,
        destinationCount: input.destinationCount,
        missingCount: input.missingCount,
        evidenceLevel: input.evidence,
      }),
      observedAt: deps.clock.now().toISOString(),
    });
    if (!before) {
      alerting.enqueueOutbox(tenantId, {
        id: createId(),
        incidentId: incident.id,
        eventType: "opened",
        payloadJson: JSON.stringify({ incidentId: incident.id }),
        availableAt: deps.clock.now().toISOString(),
      });
    }
  }

  function syncOutcomeIncidents(
    tenantId: string,
    contract: {
      id: string;
      clientId: string | null;
      businessPurpose: string;
    },
    input: {
      match: ReturnType<typeof matchByNormalizedEmail>;
      evidenceLevel: "medium" | "high";
      oldestMissingAgeSeconds: number | null;
      runStatus: "healthy" | "warning" | "failed";
      runId: string;
    },
  ): void {
    if (shouldResolveMissingIncidents(input.match)) {
      resolveOutcomeMissing(tenantId, contract.id);
      return;
    }

    const plans = planOutcomeIncidents({
      businessPurpose: contract.businessPurpose,
      match: input.match,
      evidenceLevel: input.evidenceLevel,
      oldestMissingAgeSeconds: input.oldestMissingAgeSeconds,
      runStatus: input.runStatus,
    });

    for (const plan of plans) {
      const before = alerting.getUnresolvedIncident(
        tenantId,
        "outcome",
        contract.id,
        plan.incidentType,
      );
      const incident = alerting.openOrObserveIncident(tenantId, {
        id: createId(),
        clientId: contract.clientId,
        contractKind: "outcome",
        outcomeContractId: contract.id,
        incidentType: plan.incidentType,
        severity: plan.severity,
        summary: plan.summary,
        detailsJson: JSON.stringify({
          ...plan.details,
          reconciliationRunId: input.runId,
          missingIdentifierExport:
            "Request authenticated expiring export of source_identifier_hash values",
        }),
        observedAt: deps.clock.now().toISOString(),
      });
      // Anti-spam: only enqueue notification on first open
      if (!before) {
        alerting.enqueueOutbox(tenantId, {
          id: createId(),
          incidentId: incident.id,
          eventType: "opened",
          payloadJson: JSON.stringify({
            incidentId: incident.id,
            incidentType: plan.incidentType,
          }),
          availableAt: deps.clock.now().toISOString(),
        });
      }
    }
  }

  function resolveOutcomeMissing(
    tenantId: string,
    outcomeContractId: string,
  ): void {
    for (const type of [
      "missing_destination_records",
      "partial_delivery",
    ] as const) {
      const open = alerting.getUnresolvedIncident(
        tenantId,
        "outcome",
        outcomeContractId,
        type,
      );
      if (open) {
        alerting.resolveIncident(tenantId, open.id, {
          actor: "reconciliation_recovery",
          at: deps.clock.now().toISOString(),
        });
      }
    }
  }

  function waiveMissing(input: {
    tenantId: string;
    outcomeContractId: string;
    actor: string;
  }): void {
    resolveOutcomeMissing(input.tenantId, input.outcomeContractId);
    runs.recordAudit({
      tenantId: input.tenantId,
      outcomeContractId: input.outcomeContractId,
      eventType: "waive_missing",
      actor: input.actor,
      createdAt: deps.clock.now().toISOString(),
      detailsJson: JSON.stringify({ waived: true }),
    });
  }

  return { probeConnector, runWindow, waiveMissing, runs };
}
