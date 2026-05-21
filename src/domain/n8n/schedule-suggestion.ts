/**
 * Imported n8n schedules are suggestions only.
 * Quorum never silently activates a contract from connector metadata.
 */

export interface N8nScheduleHint {
  cronExpression?: string | null;
  timezone?: string | null;
  intervalMinutes?: number | null;
}

export interface CadenceScheduleSuggestion {
  cadenceType: "cron" | "interval" | null;
  cadenceValue: string | null;
  timezone: string | null;
  requiresExplicitConfirmation: true;
  confirmationFields: ReadonlyArray<
    | "cadence"
    | "timezone"
    | "schedule_anchor"
    | "allowed_lateness"
    | "empty_result_policy"
  >;
}

const CONFIRMATION_FIELDS = [
  "cadence",
  "timezone",
  "schedule_anchor",
  "allowed_lateness",
  "empty_result_policy",
] as const;

export function suggestCadenceFromN8nSchedule(
  hint: N8nScheduleHint,
): CadenceScheduleSuggestion {
  if (hint.cronExpression && hint.cronExpression.trim().length > 0) {
    return {
      cadenceType: "cron",
      cadenceValue: hint.cronExpression.trim(),
      timezone: hint.timezone?.trim() || null,
      requiresExplicitConfirmation: true,
      confirmationFields: CONFIRMATION_FIELDS,
    };
  }
  if (
    hint.intervalMinutes !== undefined &&
    hint.intervalMinutes !== null &&
    Number.isInteger(hint.intervalMinutes) &&
    hint.intervalMinutes > 0
  ) {
    return {
      cadenceType: "interval",
      cadenceValue: String(hint.intervalMinutes),
      timezone: hint.timezone?.trim() || null,
      requiresExplicitConfirmation: true,
      confirmationFields: CONFIRMATION_FIELDS,
    };
  }
  return {
    cadenceType: null,
    cadenceValue: null,
    timezone: hint.timezone?.trim() || null,
    requiresExplicitConfirmation: true,
    confirmationFields: CONFIRMATION_FIELDS,
  };
}
