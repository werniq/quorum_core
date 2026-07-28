import { describe, expect, it } from "vitest";
import { inferWorkflowDiscovery } from "../../src/domain/n8n/infer-cadence.js";
import { escapeHtml } from "../../src/presentation/html/layout.js";

describe("n8n cadence inference", () => {
  it("infers interval schedule from schedule trigger", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "1",
      name: "Lead sync",
      active: true,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: {
              interval: [{ field: "minutes", minutesInterval: 15 }],
            },
          },
        },
      ],
    });
    expect(discovered.triggerKind).toBe("schedule");
    expect(discovered.inferredCadence).toEqual({
      type: "interval",
      value: "15m",
      label: "Every 15 minutes",
    });
    expect(discovered.triggerSummary).toContain("15 minutes");
  });

  it("infers cron cadence", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "2",
      name: "Weekly",
      active: false,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            cronExpression: "0 9 * * 1",
            timezone: "Europe/Warsaw",
          },
        },
      ],
    });
    expect(discovered.inferredCadence?.type).toBe("cron");
    expect(discovered.inferredCadence?.value).toBe("0 9 * * 1");
    expect(discovered.inferredCadence?.timezone).toBe("Europe/Warsaw");
  });

  it("does not invent cadence for webhook workflows", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "3",
      name: "Inbound",
      active: true,
      nodes: [{ type: "n8n-nodes-base.webhook", parameters: {} }],
    });
    expect(discovered.triggerKind).toBe("webhook");
    expect(discovered.inferredCadence).toBeNull();
    expect(discovered.triggerSummary.toLowerCase()).toContain("webhook");
  });

  it("marks multiple triggers as ambiguous without a single cadence", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "4",
      name: "Mixed",
      active: true,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: { interval: [{ field: "hours", hoursInterval: 1 }] },
          },
        },
        { type: "n8n-nodes-base.webhook", parameters: {} },
      ],
    });
    expect(discovered.multipleTriggers).toBe(true);
    expect(discovered.inferredCadence).toBeNull();
    expect(discovered.triggerSummary.toLowerCase()).toContain("multiple");
  });

  it("falls back when schedule cannot be resolved", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "5",
      name: "Dynamic",
      active: true,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: { interval: [{ field: "cronExpression" }] },
          },
        },
      ],
    });
    expect(discovered.inferredCadence).toBeNull();
    expect(discovered.triggerSummary.toLowerCase()).toContain(
      "could not infer",
    );
  });

  it("applies n8n default of 1 hour when hoursInterval is omitted", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "5b",
      name: "Hourly default",
      active: true,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: { rule: { interval: [{ field: "hours" }] } },
        },
      ],
    });
    expect(discovered.triggerSummary).toBe("Every 1 hour");
    expect(discovered.inferredCadence?.value).toBe("1h");
  });

  it("does not invent every-1-minute when interval amount is missing", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "6",
      name: "Minutes without amount",
      active: true,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: { interval: [{ field: "minutes" }] },
          },
        },
      ],
    });
    // n8n omits minutesInterval when it equals the node default (5).
    expect(discovered.triggerSummary).toBe("Every 5 minutes");
    expect(discovered.inferredCadence?.value).toBe("5m");
  });

  it("uses explicit minutesInterval over the n8n default", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "6b",
      name: "One minute",
      active: true,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: {
              interval: [{ field: "minutes", minutesInterval: 1 }],
            },
          },
        },
      ],
    });
    expect(discovered.triggerSummary).toBe("Every 1 minute");
    expect(discovered.inferredCadence?.value).toBe("1m");
  });

  it("infers five-minute schedule", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "7",
      name: "Five",
      active: true,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: {
              interval: [{ field: "minutes", minutesInterval: 5 }],
            },
          },
        },
      ],
    });
    expect(discovered.triggerSummary).toBe("Every 5 minutes");
    expect(discovered.inferredCadence?.value).toBe("5m");
  });

  it("infers daily schedule when n8n omits default field days", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "8",
      name: "Daily",
      active: true,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            // Default Schedule Trigger: field "days" is often omitted from JSON.
            rule: { interval: [{ triggerAtHour: 9, triggerAtMinute: 0 }] },
          },
        },
      ],
    });
    expect(discovered.triggerSummary).toBe("Every 1 day");
    expect(discovered.inferredCadence?.value).toBe("1d");
  });

  it("infers multi-day interval when daysInterval is set", () => {
    const discovered = inferWorkflowDiscovery({
      externalWorkflowId: "9",
      name: "Every 3 days",
      active: true,
      nodes: [
        {
          type: "n8n-nodes-base.scheduleTrigger",
          parameters: {
            rule: {
              interval: [{ field: "days", daysInterval: 3, triggerAtHour: 8 }],
            },
          },
        },
      ],
    });
    expect(discovered.triggerSummary).toBe("Every 3 days");
    expect(discovered.inferredCadence?.value).toBe("3d");
  });

  it("escapes hostile workflow names for HTML rendering", () => {
    const name = `<img src=x onerror="alert(1)">Evil`;
    expect(escapeHtml(name)).not.toContain("<img");
    expect(escapeHtml(name)).toContain("&lt;img");
  });
});
