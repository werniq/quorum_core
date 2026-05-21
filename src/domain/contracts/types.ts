import type {
  Edition,
  EvidenceLevel,
  SupportedAutomationPlatform,
} from "../terminology.js";

export type { Edition, EvidenceLevel };

export type ClientStatus = "onboarding" | "protected" | "paused" | "archived";

export type SourcePlatform = SupportedAutomationPlatform;

export type MonitoringMethod = "push" | "poll";

export type ContractType = "heartbeat" | "reconciliation" | "aggregate_check";

export type CadenceType = "interval" | "cron" | "event_driven";

export type IntervalMode = "fixed_rate" | "since_last_success";

export type EmptyResultPolicy = "allowed" | "warning" | "failure";

export interface WorkflowContractInput {
  workflowId: string;
  name: string;
  businessPurpose: string;
  contractType: ContractType;
  cadenceType: CadenceType;
  cadenceValue: string;
  intervalMode: IntervalMode | null;
  scheduleAnchorAt: Date | null;
  timezone: string | null;
  allowedLatenessMinutes: number;
  maxQuietWindowMinutes: number | null;
  initialGraceMinutes: number;
  emptyResultPolicy: EmptyResultPolicy;
  countLessSuccessAllowed: boolean;
  notificationBackoffMinutes: number;
  evidenceLevel: EvidenceLevel;
  schemaVersion: number;
  isActive: boolean;
}

export interface ExistingActiveHeartbeat {
  contractId: string;
  workflowId: string;
}

export interface ActivationContext {
  /** True when at least one active alert route exists for the contract/workflow. */
  hasActiveAlertRoute: boolean;
  /**
   * Self-hosted development only: operator explicitly acknowledged
   * running without alert delivery.
   */
  acknowledgedNoAlertMode: boolean;
  edition: Edition;
}
