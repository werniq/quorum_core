import type { CadenceType, MonitoringMethod } from "../contracts/types.js";

/** Durable onboarding draft (no secrets). Stored as JSON in onboarding_state.draft_json. */
export interface OnboardingWorkflowConfig {
  externalWorkflowId: string;
  name: string;
  activeInN8n: boolean;
  triggerSummary: string;
  cadenceType: CadenceType;
  cadenceValue: string;
  timezone: string | null;
  /** Quiet window hours for event-driven (stored as maxQuietWindowMinutes). */
  quietHours: number | null;
  monitorMissingRuns: boolean;
  monitorFailures: boolean;
  monitorEmptyResult: boolean;
  monitorVolumeRange: boolean;
  volumeMin: number | null;
  volumeMax: number | null;
  monitoringMethod: MonitoringMethod;
  /** Quorum workflow id after registration (internal). */
  workflowId?: string;
  /** Quorum contract id after create (internal). */
  contractId?: string;
  alreadyMonitored?: boolean;
}

export interface OnboardingDraft {
  clientId?: string;
  clientName?: string;
  connectorId?: string;
  connectorLabel?: string;
  connectionTestOk?: boolean;
  workflowCountHint?: number | null;
  selectedExternalWorkflowIds?: string[];
  workflowConfigs?: Record<string, OnboardingWorkflowConfig>;
  channelId?: string;
  channelName?: string;
  acknowledgedNoAlertMode?: boolean;
  alertTestOk?: boolean | null;
  heartbeatAcceptedWorkflowIds?: string[];
  activatedAt?: string;
  search?: string;
}

export function emptyOnboardingDraft(): OnboardingDraft {
  return {
    selectedExternalWorkflowIds: [],
    workflowConfigs: {},
  };
}

/** Later steps must follow the explicit selection, not stale config entries. */
export function selectedWorkflowConfigs(
  draft: OnboardingDraft,
): OnboardingWorkflowConfig[] {
  const configs = draft.workflowConfigs ?? {};
  return [...new Set(draft.selectedExternalWorkflowIds ?? [])]
    .map((id) => configs[id])
    .filter((config): config is OnboardingWorkflowConfig => Boolean(config));
}

export function parseOnboardingDraft(
  raw: string | null | undefined,
): OnboardingDraft {
  if (!raw || raw.trim() === "") {
    return emptyOnboardingDraft();
  }
  try {
    const parsed = JSON.parse(raw) as OnboardingDraft;
    if (!parsed || typeof parsed !== "object") {
      return emptyOnboardingDraft();
    }
    return parsed;
  } catch {
    return emptyOnboardingDraft();
  }
}

export function serializeOnboardingDraft(draft: OnboardingDraft): string {
  return JSON.stringify(draft);
}
