/**
 * Volume band rules — coexist with cadence on the same workflow contract.
 */

export const VOLUME_WINDOW_TYPES = ["daily", "weekly", "monthly"] as const;
export type VolumeWindowType = (typeof VOLUME_WINDOW_TYPES)[number];

export const VOLUME_EVALUATION_RESULTS = [
  "collecting",
  "within_band",
  "below_minimum",
  "above_maximum",
  "inconclusive",
] as const;
export type VolumeEvaluationResult = (typeof VOLUME_EVALUATION_RESULTS)[number];

export const VOLUME_VIOLATION_SEVERITIES = ["warning", "critical"] as const;
export type VolumeViolationSeverity =
  (typeof VOLUME_VIOLATION_SEVERITIES)[number];

/** Monday = 1 … Sunday = 0 (JS Date.getDay()). */
export const DEFAULT_WEEK_STARTS_ON = 1;

export interface ContractVolumeRule {
  id: string;
  tenantId: string;
  workflowContractId: string;
  minimumCount: number;
  maximumCount: number | null;
  windowType: VolumeWindowType;
  timezone: string;
  weekStartsOn: number | null;
  evaluationGraceMinutes: number;
  violationSeverity: VolumeViolationSeverity;
  isActive: boolean;
  activatedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface VolumeBandEvaluation {
  id: string;
  tenantId: string;
  ruleId: string;
  workflowContractId: string;
  windowStart: Date;
  windowEnd: Date;
  evaluatedAt: Date | null;
  totalItems: number | null;
  countedEvents: number;
  unknownCountEvents: number;
  result: VolumeEvaluationResult;
  minimumCount: number;
  maximumCount: number | null;
  isFinalized: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface HeartbeatVolumeContribution {
  executedAt: Date;
  itemsProcessed: number | null;
  status: "success" | "failure" | "empty_result";
}

export interface VolumeWindowBounds {
  windowStart: Date;
  windowEnd: Date;
  /** True when the rule was activated after this window started. */
  isFirstPartialWindow: boolean;
}

export interface VolumeEvaluationInput {
  rule: Pick<
    ContractVolumeRule,
    | "minimumCount"
    | "maximumCount"
    | "windowType"
    | "timezone"
    | "weekStartsOn"
    | "evaluationGraceMinutes"
    | "activatedAt"
  >;
  now: Date;
  heartbeats: HeartbeatVolumeContribution[];
}

export interface VolumeEvaluationOutcome {
  window: VolumeWindowBounds;
  result: VolumeEvaluationResult;
  totalItems: number | null;
  countedEvents: number;
  unknownCountEvents: number;
  canEvaluate: boolean;
  evaluationDeadline: Date;
}
