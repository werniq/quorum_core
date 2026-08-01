import { describe, expect, it } from "vitest";
import {
  shouldSuppressSilentAbsence,
  isBadConnectorHealth,
} from "../../src/domain/health/monitor-reachability.js";
import {
  buildContractDimensions,
  nextConsecutiveEmptyResults,
  rollUpCatalogDisplayHealth,
} from "../../src/domain/health/contract-dimensions.js";
import {
  compareSourceWatermarks,
  evaluateWatermarkFreshness,
  extractSourceWatermark,
} from "../../src/domain/evidence/source-watermark.js";

describe("monitor reachability", () => {
  it("suppresses silent absence only for bad poll connectors", () => {
    expect(
      shouldSuppressSilentAbsence({
        monitoringMethod: "poll",
        connectorHealth: "unreachable",
      }),
    ).toBe(true);
    expect(
      shouldSuppressSilentAbsence({
        monitoringMethod: "push",
        connectorHealth: "unreachable",
      }),
    ).toBe(false);
    expect(
      shouldSuppressSilentAbsence({
        monitoringMethod: "poll",
        connectorHealth: "healthy",
      }),
    ).toBe(false);
    expect(isBadConnectorHealth("auth_failed")).toBe(true);
  });
});

describe("contract dimensions roll-up", () => {
  it("dominates badge with monitor_unknown while keeping schedule breach visible", () => {
    const dimensions = buildContractDimensions({
      monitoringMethod: "poll",
      connectorHealth: "unreachable",
      scheduleHealth: "overdue",
      hasOpenEmptyResult: false,
      emptyResultConfigured: true,
      volumeBreached: false,
      sourceWatermarkRequired: false,
      freshnessBreached: false,
      freshnessUnknown: false,
      effectReconciliationEnabled: false,
      reconciliationBreached: false,
      reconciliationUnknown: false,
      watcherHealth: "ok",
      monitorUnreachable: true,
    });
    expect(dimensions.monitor).toBe("unknown");
    expect(dimensions.schedule).toBe("breached");
    expect(dimensions.freshness).toBe("not_configured");
    expect(dimensions.reconciliation).toBe("not_configured");
    expect(
      rollUpCatalogDisplayHealth({
        scheduleHealth: "overdue",
        dimensions,
        monitorUnreachable: true,
      }),
    ).toBe("monitor_unknown");
  });

  it("marks output breached when an empty-result incident is open", () => {
    const dimensions = buildContractDimensions({
      monitoringMethod: "push",
      connectorHealth: null,
      scheduleHealth: "healthy",
      hasOpenEmptyResult: true,
      emptyResultConfigured: true,
      volumeBreached: false,
      sourceWatermarkRequired: false,
      freshnessBreached: false,
      freshnessUnknown: false,
      effectReconciliationEnabled: false,
      reconciliationBreached: false,
      reconciliationUnknown: false,
      watcherHealth: "ok",
      monitorUnreachable: false,
    });
    expect(dimensions.output).toBe("breached");
    expect(
      rollUpCatalogDisplayHealth({
        scheduleHealth: "healthy",
        dimensions,
        monitorUnreachable: false,
      }),
    ).toBe("warning");
  });

  it("shows freshness Not configured when watermark is unset", () => {
    const dimensions = buildContractDimensions({
      monitoringMethod: "push",
      connectorHealth: null,
      scheduleHealth: "healthy",
      hasOpenEmptyResult: false,
      emptyResultConfigured: false,
      volumeBreached: false,
      sourceWatermarkRequired: false,
      freshnessBreached: false,
      freshnessUnknown: false,
      effectReconciliationEnabled: false,
      reconciliationBreached: false,
      reconciliationUnknown: false,
      watcherHealth: "ok",
      monitorUnreachable: false,
    });
    expect(dimensions.freshness).toBe("not_configured");
  });
});

describe("consecutive empty results", () => {
  it("increments on empty, holds on failure, resets only on non-empty success", () => {
    expect(
      nextConsecutiveEmptyResults({
        evidenceStatus: "empty_result",
        itemsProcessed: 0,
        previous: 2,
      }),
    ).toBe(3);
    expect(
      nextConsecutiveEmptyResults({
        evidenceStatus: "failure",
        itemsProcessed: 5,
        previous: 2,
      }),
    ).toBe(2);
    expect(
      nextConsecutiveEmptyResults({
        evidenceStatus: "success",
        itemsProcessed: 0,
        previous: 2,
      }),
    ).toBe(2);
    expect(
      nextConsecutiveEmptyResults({
        evidenceStatus: "success",
        itemsProcessed: 3,
        previous: 2,
      }),
    ).toBe(0);
  });
});

describe("source watermark freshness", () => {
  it("extracts and compares watermarks", () => {
    expect(
      extractSourceWatermark({ sourceWatermark: "2026-07-31T12:00:00.000Z" }),
    ).toBe("2026-07-31T12:00:00.000Z");
    expect(compareSourceWatermarks("10", "11", "numeric")).toMatchObject({
      ok: true,
      advanced: true,
    });
    expect(compareSourceWatermarks("11", "11", "numeric")).toMatchObject({
      ok: true,
      advanced: false,
    });
  });

  it("opens after consecutive non-advancing successes", () => {
    const first = evaluateWatermarkFreshness({
      required: true,
      previousWatermark: "100",
      previousWatermarkAt: "2026-07-24T10:00:00.000Z",
      observedAt: "2026-07-24T10:05:00.000Z",
      metadata: { sourceWatermark: "100" },
      consecutiveStale: 0,
      breachThreshold: 2,
      comparisonType: "numeric",
    });
    expect(first.shouldOpenIncident).toBe(false);
    expect(first.consecutiveStale).toBe(1);
    const second = evaluateWatermarkFreshness({
      required: true,
      previousWatermark: "100",
      previousWatermarkAt: "2026-07-24T10:00:00.000Z",
      observedAt: "2026-07-24T10:10:00.000Z",
      metadata: { sourceWatermark: "100" },
      consecutiveStale: 1,
      breachThreshold: 2,
      comparisonType: "numeric",
    });
    expect(second.shouldOpenIncident).toBe(true);
  });

  it("allows unchanged watermark within the staleness window then recovers on advance", () => {
    const within = evaluateWatermarkFreshness({
      required: true,
      previousWatermark: "100",
      previousWatermarkAt: "2026-07-24T10:00:00.000Z",
      observedAt: "2026-07-24T10:02:00.000Z",
      metadata: { sourceWatermark: "100" },
      consecutiveStale: 0,
      breachThreshold: 1,
      comparisonType: "numeric",
      allowedStalenessSeconds: 300,
    });
    expect(within.status).toBe("advanced");
    expect(within.shouldOpenIncident).toBe(false);
    expect(within.consecutiveStale).toBe(0);

    const stale = evaluateWatermarkFreshness({
      required: true,
      previousWatermark: "100",
      previousWatermarkAt: "2026-07-24T10:00:00.000Z",
      observedAt: "2026-07-24T10:06:00.000Z",
      metadata: { sourceWatermark: "100" },
      consecutiveStale: 0,
      breachThreshold: 1,
      comparisonType: "numeric",
      allowedStalenessSeconds: 300,
    });
    expect(stale.status).toBe("stale");
    expect(stale.shouldOpenIncident).toBe(true);

    const recovered = evaluateWatermarkFreshness({
      required: true,
      previousWatermark: "100",
      previousWatermarkAt: "2026-07-24T10:00:00.000Z",
      observedAt: "2026-07-24T10:07:00.000Z",
      metadata: { sourceWatermark: "101" },
      consecutiveStale: 1,
      breachThreshold: 1,
      comparisonType: "numeric",
      allowedStalenessSeconds: 300,
    });
    expect(recovered.status).toBe("advanced");
    expect(recovered.consecutiveStale).toBe(0);
    expect(recovered.shouldOpenIncident).toBe(false);
    expect(recovered.nextWatermark).toBe("101");
  });

  it("holds consecutive stale when freshness is not evaluated", () => {
    const held = evaluateWatermarkFreshness({
      required: false,
      previousWatermark: "100",
      previousWatermarkAt: "2026-07-24T10:00:00.000Z",
      metadata: null,
      consecutiveStale: 2,
      breachThreshold: 1,
    });
    expect(held.status).toBe("not_configured");
    expect(held.consecutiveStale).toBe(2);
  });
});
