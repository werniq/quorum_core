import { CronExpressionParser } from "cron-parser";
import type {
  ActivationContext,
  ExistingActiveHeartbeat,
  WorkflowContractInput,
} from "./types.js";
import { parsePositiveDurationMinutes } from "../cadence/duration.js";

export type ContractValidationIssue =
  | { code: "ACTIVE_HEARTBEAT_EXISTS"; message: string }
  | { code: "INVALID_CRON"; message: string }
  | { code: "CRON_TIMEZONE_REQUIRED"; message: string }
  | { code: "INVALID_TIMEZONE"; message: string }
  | { code: "INTERVAL_MODE_REQUIRED"; message: string }
  | { code: "INTERVAL_DURATION_INVALID"; message: string }
  | { code: "FIXED_RATE_ANCHOR_REQUIRED"; message: string }
  | { code: "QUIET_WINDOW_REQUIRED"; message: string }
  | { code: "EVIDENCE_LEVEL_TOO_HIGH"; message: string }
  | { code: "ACTIVATION_ALERT_ROUTE_REQUIRED"; message: string };

export interface ContractValidationResult {
  ok: boolean;
  issues: ContractValidationIssue[];
}

const IANA_TIMEZONE_PATTERN = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$|^UTC$/;

export function isValidIanaTimezone(timezone: string): boolean {
  if (!IANA_TIMEZONE_PATTERN.test(timezone)) {
    return false;
  }
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export function validateWorkflowContract(
  input: WorkflowContractInput,
  options: {
    existingActiveHeartbeats?: ExistingActiveHeartbeat[];
    activation?: ActivationContext;
    excludingContractId?: string;
  } = {},
): ContractValidationResult {
  const issues: ContractValidationIssue[] = [];

  if (input.contractType === "heartbeat" && input.isActive) {
    const conflict = (options.existingActiveHeartbeats ?? []).find(
      (existing) =>
        existing.workflowId === input.workflowId &&
        existing.contractId !== options.excludingContractId,
    );
    if (conflict) {
      issues.push({
        code: "ACTIVE_HEARTBEAT_EXISTS",
        message: "Only one active heartbeat contract is allowed per workflow.",
      });
    }
  }

  if (input.contractType === "heartbeat" && input.evidenceLevel !== "basic") {
    issues.push({
      code: "EVIDENCE_LEVEL_TOO_HIGH",
      message:
        "Heartbeat-only contracts cannot declare an evidence level above basic.",
    });
  }

  if (input.cadenceType === "cron") {
    if (!input.timezone) {
      issues.push({
        code: "CRON_TIMEZONE_REQUIRED",
        message: "Cron cadence requires an IANA timezone.",
      });
    } else if (!isValidIanaTimezone(input.timezone)) {
      issues.push({
        code: "INVALID_TIMEZONE",
        message: `Timezone "${input.timezone}" is not a valid IANA name.`,
      });
    }

    if (input.timezone && isValidIanaTimezone(input.timezone)) {
      try {
        CronExpressionParser.parse(input.cadenceValue, {
          tz: input.timezone,
        });
      } catch (error) {
        issues.push({
          code: "INVALID_CRON",
          message:
            error instanceof Error
              ? error.message
              : "Cron expression is invalid.",
        });
      }
    } else if (!input.timezone) {
      // already reported timezone requirement
    } else {
      // invalid timezone already reported; still try to surface cron parse errors in UTC
      try {
        CronExpressionParser.parse(input.cadenceValue, { tz: "UTC" });
      } catch (error) {
        issues.push({
          code: "INVALID_CRON",
          message:
            error instanceof Error
              ? error.message
              : "Cron expression is invalid.",
        });
      }
    }
  }

  if (input.cadenceType === "interval") {
    if (!input.intervalMode) {
      issues.push({
        code: "INTERVAL_MODE_REQUIRED",
        message:
          "Interval cadence requires an explicit interval_mode (fixed_rate or since_last_success).",
      });
    }

    const durationMinutes = parsePositiveDurationMinutes(input.cadenceValue);
    if (durationMinutes === null) {
      issues.push({
        code: "INTERVAL_DURATION_INVALID",
        message: "Interval cadence requires a positive duration.",
      });
    }

    if (input.intervalMode === "fixed_rate" && !input.scheduleAnchorAt) {
      issues.push({
        code: "FIXED_RATE_ANCHOR_REQUIRED",
        message: "Fixed-rate interval cadence requires schedule_anchor_at.",
      });
    }
  }

  if (input.cadenceType === "event_driven") {
    if (
      input.maxQuietWindowMinutes === null ||
      input.maxQuietWindowMinutes <= 0
    ) {
      issues.push({
        code: "QUIET_WINDOW_REQUIRED",
        message:
          "Event-driven cadence requires a positive max_quiet_window_minutes.",
      });
    }
  }

  if (input.isActive && options.activation) {
    const { hasActiveAlertRoute, acknowledgedNoAlertMode, edition } =
      options.activation;
    const noAlertAllowed =
      edition === "self_hosted" && acknowledgedNoAlertMode === true;
    if (!hasActiveAlertRoute && !noAlertAllowed) {
      issues.push({
        code: "ACTIVATION_ALERT_ROUTE_REQUIRED",
        message:
          "Activation requires at least one active alert route, or an explicit acknowledged no-alert mode in self-hosted development.",
      });
    }
  }

  return { ok: issues.length === 0, issues };
}
