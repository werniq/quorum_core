/**
 * Normalized n8n workflow discovery DTO (untrusted upstream → sanitized fields).
 */
export type DiscoveredTriggerKind =
  | "schedule"
  | "webhook"
  | "event"
  | "manual"
  | "unknown";

export type InferredCadence =
  | {
      type: "interval";
      value: string;
      timezone?: string;
      label: string;
    }
  | {
      type: "cron";
      value: string;
      timezone?: string;
      label: string;
    };

export interface DiscoveredWorkflow {
  externalWorkflowId: string;
  name: string;
  active: boolean;
  triggerKind: DiscoveredTriggerKind;
  /** Null when cadence cannot be inferred safely (event/manual/ambiguous). */
  inferredCadence: InferredCadence | null;
  /** True when multiple trigger nodes were found. */
  multipleTriggers: boolean;
  /** Human-readable schedule/trigger summary for the UI. */
  triggerSummary: string;
}
