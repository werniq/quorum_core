import type { CatalogContractRow } from "../../catalog/query-catalog.js";
import type { CatalogRowView } from "../../../presentation/html/catalog-ui.js";

export function toCatalogRowView(row: CatalogContractRow): CatalogRowView {
  return {
    contractId: row.contractId,
    workflowId: row.workflowId,
    clientId: row.clientId,
    clientName: row.clientName,
    businessPurposeName: row.businessPurposeName,
    health: row.health,
    evidenceLevel: row.evidenceLevel,
    evidenceExplanation: row.evidenceExplanation,
    expectedCadenceOrWindow: row.expectedCadenceOrWindow,
    lastAcceptableEvidenceAt: row.lastAcceptableEvidenceAt,
    nextDeadlineAt: row.nextDeadlineAt,
    overdueDurationSeconds: row.overdueDurationSeconds,
    alertChannelHealth: row.alertChannelHealth,
    connectorHealth: row.connectorHealth,
    activeIncident: row.activeIncident
      ? {
          severity: row.activeIncident.severity,
          summary: row.activeIncident.summary,
        }
      : null,
    contractKind: row.contractKind,
    sourceCount: row.sourceCount,
    destinationCount: row.destinationCount,
    missingCount: row.missingCount,
    oldestMissingAgeSeconds: row.oldestMissingAgeSeconds,
    evidenceStale: row.evidenceStale,
    isActive: row.isActive,
    verifiedDimensions: row.verifiedDimensions,
    unverifiedDimensions: row.unverifiedDimensions,
    volumeSummary: row.volumeSummary ?? null,
  };
}
