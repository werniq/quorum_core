export interface CatalogContractRowLike {
  isActive: boolean;
  health: string;
  evidenceLevel: string;
  contractKind: string;
  missingCount: number | null;
  alertChannelHealth: string;
  activeIncident: { severity: string } | null;
}

export interface CatalogBusinessSummary {
  contractsCurrentlySatisfied: number;
  clientProcessesNeedingAttention: number;
  outcomesMissingOrDelayed: number;
  contractsWithOnlyBasicEvidence: number;
  clientsWithFailingAlertDelivery: number;
  contractsNotYetActivated: number;
}

/** Business-language catalog summary — never lead with ping volume. */
export function summarizeCatalog(
  rows: CatalogContractRowLike[],
): CatalogBusinessSummary {
  const active = rows.filter((r) => r.isActive);
  const satisfied = active.filter(
    (r) =>
      r.health === "healthy" &&
      (!r.activeIncident || r.activeIncident.severity !== "critical"),
  ).length;
  const needingAttention = active.filter(
    (r) =>
      r.health === "overdue" ||
      r.health === "warning" ||
      r.activeIncident != null ||
      r.alertChannelHealth === "failing" ||
      r.alertChannelHealth === "degraded",
  ).length;
  const outcomesMissing = active.filter(
    (r) =>
      r.contractKind === "outcome" &&
      r.missingCount != null &&
      r.missingCount > 0,
  ).length;
  const basicOnly = active.filter((r) => r.evidenceLevel === "basic").length;
  const failingAlerts = active.filter(
    (r) => r.alertChannelHealth === "failing",
  ).length;
  const notActivated = rows.filter((r) => !r.isActive).length;

  return {
    contractsCurrentlySatisfied: satisfied,
    clientProcessesNeedingAttention: needingAttention,
    outcomesMissingOrDelayed: outcomesMissing,
    contractsWithOnlyBasicEvidence: basicOnly,
    clientsWithFailingAlertDelivery: failingAlerts,
    contractsNotYetActivated: notActivated,
  };
}

export interface CatalogFilters {
  clientId?: string | null;
  health?: string | null;
  evidenceLevel?: string | null;
  contractKind?: string | null;
  connectorHealth?: string | null;
  alertChannelHealth?: string | null;
}

export function applyCatalogFilters<
  T extends {
    clientId: string | null;
    health: string;
    evidenceLevel: string;
    contractKind: string;
    connectorHealth: string | null;
    alertChannelHealth: string;
  },
>(rows: T[], filters: CatalogFilters): T[] {
  return rows.filter((row) => {
    if (filters.clientId && row.clientId !== filters.clientId) return false;
    if (filters.health && row.health !== filters.health) return false;
    if (filters.evidenceLevel && row.evidenceLevel !== filters.evidenceLevel) {
      return false;
    }
    if (filters.contractKind && row.contractKind !== filters.contractKind) {
      return false;
    }
    if (
      filters.connectorHealth &&
      (row.connectorHealth ?? "none") !== filters.connectorHealth
    ) {
      return false;
    }
    if (
      filters.alertChannelHealth &&
      row.alertChannelHealth !== filters.alertChannelHealth
    ) {
      return false;
    }
    return true;
  });
}
