import type {
  ContractVolumeRule,
  HeartbeatVolumeContribution,
  VolumeBandEvaluation,
  VolumeEvaluationResult,
  VolumeViolationSeverity,
  VolumeWindowType,
} from "../../domain/volume/types.js";

export interface CreateVolumeRuleInput {
  id: string;
  workflowContractId: string;
  minimumCount: number;
  maximumCount: number | null;
  windowType: VolumeWindowType;
  timezone: string;
  weekStartsOn: number | null;
  evaluationGraceMinutes: number;
  violationSeverity: VolumeViolationSeverity;
  activatedAt: string;
}

export interface UpsertVolumeEvaluationInput {
  id: string;
  ruleId: string;
  workflowContractId: string;
  windowStart: string;
  windowEnd: string;
  evaluatedAt: string | null;
  totalItems: number | null;
  countedEvents: number;
  unknownCountEvents: number;
  result: VolumeEvaluationResult;
  minimumCount: number;
  maximumCount: number | null;
  isFinalized: boolean;
}

/** Tenant-scoped volume rules, evaluations, and evaluation claims. */
export interface VolumeRepositories {
  createVolumeRule(
    tenantId: string,
    input: CreateVolumeRuleInput,
  ): ContractVolumeRule;
  listActiveVolumeRulesForContract(
    tenantId: string,
    workflowContractId: string,
  ): ContractVolumeRule[];
  listActiveVolumeRules(tenantId: string): ContractVolumeRule[];
  deactivateVolumeRule(tenantId: string, ruleId: string): void;
  getVolumeEvaluation(
    tenantId: string,
    ruleId: string,
    windowStart: string,
  ): VolumeBandEvaluation | null;
  upsertVolumeEvaluation(
    tenantId: string,
    input: UpsertVolumeEvaluationInput,
  ): VolumeBandEvaluation;
  listHeartbeatsForVolumeWindow(input: {
    tenantId: string;
    workflowId: string;
    windowStart: string;
    windowEnd: string;
    ruleActivatedAt: string;
  }): HeartbeatVolumeContribution[];
  tryClaimVolumeEvaluation(input: {
    tenantId: string;
    ruleId: string;
    windowStart: string;
    claimOwner: string;
    claimExpiresAt: string;
    nowIso: string;
  }): boolean;
  releaseVolumeEvaluationClaim(input: {
    tenantId: string;
    ruleId: string;
    windowStart: string;
    claimOwner: string;
  }): void;
  getLatestVolumeEvaluationForRule(
    tenantId: string,
    ruleId: string,
  ): VolumeBandEvaluation | null;
  listVolumeEvaluationsForContract(
    tenantId: string,
    workflowContractId: string,
    limit?: number,
  ): VolumeBandEvaluation[];
}
