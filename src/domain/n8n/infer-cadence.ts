import type {
  DiscoveredTriggerKind,
  DiscoveredWorkflow,
  InferredCadence,
} from "./discovered-workflow.js";

type RawNode = {
  type?: unknown;
  name?: unknown;
  parameters?: Record<string, unknown> | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function unitToInterval(
  amount: number,
  unit: string,
): { value: string; label: string } | null {
  const u = unit.toLowerCase();
  if (amount <= 0) {
    return null;
  }
  const plural = amount === 1 ? "" : "s";
  if (u.startsWith("sec")) {
    return {
      value: `${amount}s`,
      label: `Every ${amount} second${plural}`,
    };
  }
  if (u.startsWith("min")) {
    return {
      value: `${amount}m`,
      label: `Every ${amount} minute${plural}`,
    };
  }
  if (u.startsWith("hour")) {
    return {
      value: `${amount}h`,
      label: `Every ${amount} hour${plural}`,
    };
  }
  if (u.startsWith("day")) {
    return {
      value: `${amount}d`,
      label: `Every ${amount} day${plural}`,
    };
  }
  if (u.startsWith("week")) {
    return {
      value: `${amount * 7}d`,
      label: `Every ${amount} week${plural}`,
    };
  }
  if (u.startsWith("month")) {
    return {
      value: `${amount * 30}d`,
      label: `Every ${amount} month${plural}`,
    };
  }
  return null;
}

function intervalAmountForField(
  first: Record<string, unknown>,
  field: string,
): number | null {
  const normalized = field.toLowerCase();
  const keyed = readNumber(first[`${normalized}Interval`]);
  if (keyed !== null) {
    return keyed;
  }
  // Prefer the field-specific key only — other *Interval leftovers from a
  // previous UI selection must not win (e.g. hoursInterval after switching to days).
  // n8n Schedule Trigger omits keys that still equal the node default.
  const n8nDefaults: Record<string, number> = {
    seconds: 30,
    minutes: 5,
    hours: 1,
    days: 1,
    weeks: 1,
    months: 1,
  };
  return n8nDefaults[normalized] ?? null;
}

function inferFromScheduleNode(node: RawNode): {
  kind: DiscoveredTriggerKind;
  cadence: InferredCadence | null;
  summary: string;
  ambiguous: boolean;
} {
  const params = asRecord(node.parameters) ?? {};
  const rule = asRecord(params.rule) ?? params;
  const interval = asRecord(rule.interval) ?? asRecord(params.interval);
  const timezone =
    readString(params.timezone) ??
    readString(rule.timezone) ??
    readString(params.timezoneId) ??
    undefined;

  // n8n interval form: rule.interval[0].field / hoursInterval etc.
  // Schedule Trigger defaults to field "days"; n8n often omits that key when
  // unchanged, while minutes/hours are always written explicitly.
  if (Array.isArray(rule.interval) && rule.interval.length > 0) {
    const first = asRecord(rule.interval[0]);
    if (first) {
      const field = (readString(first.field) ?? "days").toLowerCase();
      if (field === "cronexpression") {
        const cron =
          readString(first.expression) ??
          readString(first.cronExpression) ??
          null;
        if (cron) {
          const cadence: InferredCadence = {
            type: "cron",
            value: cron,
            label: `Cron: ${cron}`,
            ...(timezone ? { timezone } : {}),
          };
          return {
            kind: "schedule",
            cadence,
            summary: `Cron (${cron})`,
            ambiguous: false,
          };
        }
      } else {
        const amount = intervalAmountForField(first, field);
        if (amount !== null) {
          const mapped = unitToInterval(amount, field);
          if (mapped) {
            const cadence: InferredCadence = {
              type: "interval",
              value: mapped.value,
              label: mapped.label,
              ...(timezone ? { timezone } : {}),
            };
            return {
              kind: "schedule",
              cadence,
              summary: mapped.label,
              ambiguous: false,
            };
          }
        }
      }
    }
  }

  if (interval) {
    const amount =
      readNumber(interval.amount) ??
      readNumber(interval.value) ??
      readNumber(params.intervalAmount) ??
      null;
    const unit =
      readString(interval.unit) ??
      readString(params.unit) ??
      readString(params.intervalUnit) ??
      "minutes";
    if (amount !== null) {
      const mapped = unitToInterval(amount, unit);
      if (mapped) {
        const cadence: InferredCadence = {
          type: "interval",
          value: mapped.value,
          label: mapped.label,
          ...(timezone ? { timezone } : {}),
        };
        return {
          kind: "schedule",
          cadence,
          summary: mapped.label,
          ambiguous: false,
        };
      }
    }
  }

  const cron =
    readString(params.cronExpression) ??
    readString(rule.cronExpression) ??
    readString(params.expression) ??
    null;
  if (cron) {
    const cadence: InferredCadence = {
      type: "cron",
      value: cron,
      label: `Cron: ${cron}`,
      ...(timezone ? { timezone } : {}),
    };
    return {
      kind: "schedule",
      cadence,
      summary: `Cron (${cron})`,
      ambiguous: false,
    };
  }

  // Trigger found but expression/dynamic config unresolved — never invent "every 1 …".
  return {
    kind: "schedule",
    cadence: null,
    summary:
      "Schedule detected, but Quorum could not infer its exact frequency",
    ambiguous: true,
  };
}

function classifyNode(node: RawNode): {
  kind: DiscoveredTriggerKind;
  cadence: InferredCadence | null;
  summary: string;
  ambiguous: boolean;
} | null {
  const type = readString(node.type)?.toLowerCase() ?? "";
  if (!type) {
    return null;
  }

  if (
    type.includes("scheduletrigger") ||
    type.includes("cron") ||
    type === "n8n-nodes-base.interval"
  ) {
    return inferFromScheduleNode(node);
  }

  if (type.includes("webhook")) {
    return {
      kind: "webhook",
      cadence: null,
      summary: "Triggered by webhook",
      ambiguous: false,
    };
  }

  if (
    type.includes("manualtrigger") ||
    type.endsWith(".manualtrigger") ||
    type.includes("manual")
  ) {
    return {
      kind: "manual",
      cadence: null,
      summary: "Manual trigger",
      ambiguous: false,
    };
  }

  // Common event/app triggers (HubSpot, Slack, etc.)
  if (
    type.includes("trigger") &&
    !type.includes("errors") &&
    !type.includes("executeworkflow")
  ) {
    return {
      kind: "event",
      cadence: null,
      summary: "Event-driven trigger",
      ambiguous: false,
    };
  }

  return null;
}

/**
 * Deterministic cadence/trigger inference from an n8n workflow payload.
 * Never invents a schedule for event/webhook/manual workflows.
 */
export function inferWorkflowDiscovery(input: {
  externalWorkflowId: string;
  name: string;
  active: boolean;
  nodes?: unknown;
}): DiscoveredWorkflow {
  const nodes = Array.isArray(input.nodes) ? (input.nodes as RawNode[]) : [];
  const triggers = nodes
    .map((node) => classifyNode(node))
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (triggers.length === 0) {
    return {
      externalWorkflowId: input.externalWorkflowId,
      name: input.name,
      active: input.active,
      triggerKind: "unknown",
      inferredCadence: null,
      multipleTriggers: false,
      triggerSummary: "Trigger type unknown — confirm expected cadence",
    };
  }

  if (triggers.length > 1) {
    const kinds = [...new Set(triggers.map((t) => t.kind))];
    return {
      externalWorkflowId: input.externalWorkflowId,
      name: input.name,
      active: input.active,
      triggerKind: kinds.length === 1 ? kinds[0]! : "unknown",
      inferredCadence: null,
      multipleTriggers: true,
      triggerSummary: `Multiple triggers detected (${kinds.join(", ")}) — choose monitoring expectations`,
    };
  }

  const only = triggers[0]!;
  return {
    externalWorkflowId: input.externalWorkflowId,
    name: input.name,
    active: input.active,
    triggerKind: only.kind,
    inferredCadence: only.cadence,
    multipleTriggers: false,
    triggerSummary: only.summary,
  };
}
