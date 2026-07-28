import type Database from "better-sqlite3";
import { createId } from "../../domain/ids.js";
import type { SqliteAlertingRepositories } from "../db/repositories/sqlite-alerting-repositories.js";

/**
 * Clears open/acknowledged connector_unavailable incidents after n8n
 * connectivity succeeds again. Catalog badges otherwise keep showing the
 * last failure summary while the Connectors page already says healthy.
 */
export function resolveN8nConnectorUnavailableIncidents(input: {
  sqlite: Database.Database;
  alerting: SqliteAlertingRepositories;
  tenantId: string;
  nowIso: string;
  actor: string;
  workflowId?: string;
  connectorId?: string;
}): void {
  const seen = new Set<string>();
  const resolveOne = (incidentId: string, incidentType: string) => {
    if (seen.has(incidentId)) {
      return;
    }
    seen.add(incidentId);
    input.alerting.resolveIncident(input.tenantId, incidentId, {
      actor: input.actor,
      at: input.nowIso,
    });
    input.alerting.enqueueOutbox(input.tenantId, {
      id: createId(),
      incidentId,
      eventType: "resolved",
      payloadJson: JSON.stringify({
        incidentId,
        incidentType,
      }),
      availableAt: input.nowIso,
    });
  };

  if (input.workflowId) {
    const open = input.alerting.getUnresolvedIncident(
      input.tenantId,
      "workflow",
      input.workflowId,
      "connector_unavailable",
    );
    if (open) {
      resolveOne(open.id, open.incidentType);
    }
  }

  if (!input.connectorId) {
    return;
  }

  const system = input.alerting.getUnresolvedIncident(
    input.tenantId,
    "system",
    "",
    "connector_unavailable",
  );
  if (system) {
    resolveOne(system.id, system.incidentType);
  }

  const workflows = input.sqlite
    .prepare(
      `SELECT id FROM workflows
       WHERE tenant_id = ? AND connector_id = ?`,
    )
    .all(input.tenantId, input.connectorId) as Array<{ id: string }>;

  for (const row of workflows) {
    const open = input.alerting.getUnresolvedIncident(
      input.tenantId,
      "workflow",
      row.id,
      "connector_unavailable",
    );
    if (open) {
      resolveOne(open.id, open.incidentType);
    }
  }
}
