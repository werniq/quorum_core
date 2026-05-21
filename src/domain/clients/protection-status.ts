import type { ClientStatus } from "../contracts/types.js";
import type { CatalogContractRowLike } from "../catalog/summary.js";

export interface ClientCoverage {
  status: ClientStatus;
  activeContracts: number;
  basicEvidence: number;
  mediumEvidence: number;
  highEvidence: number;
  coverageNote: string;
}

/**
 * Derive client protection status without implying every process is covered.
 */
export function deriveClientProtectionStatus(input: {
  hasAnyContract: boolean;
  activeContractsWithTestedAlert: number;
  allContractsPaused: boolean;
  archived: boolean;
}): ClientStatus {
  if (input.archived) {
    return "archived";
  }
  if (input.allContractsPaused && input.hasAnyContract) {
    return "paused";
  }
  if (input.activeContractsWithTestedAlert >= 1) {
    return "protected";
  }
  return "onboarding";
}

export function summarizeClientCoverage(
  contracts: CatalogContractRowLike[],
  status: ClientStatus,
): ClientCoverage {
  const active = contracts.filter((c) => c.isActive);
  const basicEvidence = active.filter(
    (c) => c.evidenceLevel === "basic",
  ).length;
  const mediumEvidence = active.filter(
    (c) => c.evidenceLevel === "medium",
  ).length;
  const highEvidence = active.filter((c) => c.evidenceLevel === "high").length;
  return {
    status,
    activeContracts: active.length,
    basicEvidence,
    mediumEvidence,
    highEvidence,
    coverageNote:
      active.length === 0
        ? "No active contracts yet — this client is not fully protected."
        : `${active.length} active contract${active.length === 1 ? "" : "s"} · ${basicEvidence} basic · ${mediumEvidence} medium · ${highEvidence} high. Other processes may be uncovered.`,
  };
}
