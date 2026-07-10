import { describe, expect, it } from "vitest";
import {
  matchByNormalizedEmail,
  oldestMissingAgeSeconds,
} from "../../src/domain/outcome/match-email.js";
import { planOutcomeIncidents } from "../../src/domain/outcome/incidents.js";

describe("reconciliation engine matching", () => {
  const sourceAt = new Date("2026-07-19T10:00:00.000Z");
  const hmacKey = "test-identifier-hmac-key";

  it("does not declare missing inside the delivery delay window", () => {
    const result = matchByNormalizedEmail({
      source: [
        {
          providerRecordId: "1",
          email: "wait@ex.com",
          observedAt: sourceAt,
        },
      ],
      destination: [],
      now: new Date("2026-07-19T10:03:00.000Z"),
      maximumDeliveryDelayMinutes: 5,
      identifierHmacKey: hmacKey,
    });
    expect(result.missingCount).toBe(0);
    expect(result.waitingCount).toBe(1);
    expect(result.items[0]?.matchStatus).toBe("waiting");
    expect(
      planOutcomeIncidents({
        businessPurpose: "deliver",
        match: result,
        evidenceLevel: "basic",
        oldestMissingAgeSeconds: null,
        runStatus: "warning",
      }),
    ).toEqual([]);
  });

  it("transitions waiting to matched when destination arrives within delay", () => {
    const matched = matchByNormalizedEmail({
      source: [
        {
          providerRecordId: "1",
          email: "ok@ex.com",
          observedAt: sourceAt,
        },
      ],
      destination: [
        {
          providerRecordId: "z",
          email: "ok@ex.com",
          observedAt: new Date("2026-07-19T10:02:00.000Z"),
        },
      ],
      now: new Date("2026-07-19T10:03:00.000Z"),
      maximumDeliveryDelayMinutes: 5,
      identifierHmacKey: hmacKey,
    });
    expect(matched.waitingCount).toBe(0);
    expect(matched.matchedCount).toBe(1);
    expect(matched.missingCount).toBe(0);
    expect(matched.items[0]?.matchStatus).toBe("matched");
    expect(
      planOutcomeIncidents({
        businessPurpose: "deliver",
        match: matched,
        evidenceLevel: "high",
        oldestMissingAgeSeconds: null,
        runStatus: "healthy",
      }),
    ).toEqual([]);
  });

  it("declares missing after the delay and marks late arrivals", () => {
    const missing = matchByNormalizedEmail({
      source: [
        {
          providerRecordId: "1",
          email: "gone@ex.com",
          observedAt: sourceAt,
        },
      ],
      destination: [],
      now: new Date("2026-07-19T10:06:00.000Z"),
      maximumDeliveryDelayMinutes: 5,
      identifierHmacKey: hmacKey,
    });
    expect(missing.missingCount).toBe(1);
    expect(missing.waitingCount).toBe(0);
    expect(missing.items[0]?.matchStatus).toBe("missing");

    const late = matchByNormalizedEmail({
      source: [
        {
          providerRecordId: "1",
          email: "late@ex.com",
          observedAt: sourceAt,
        },
      ],
      destination: [
        {
          providerRecordId: "z",
          email: "late@ex.com",
          observedAt: new Date("2026-07-19T10:08:00.000Z"),
        },
      ],
      now: new Date("2026-07-19T10:10:00.000Z"),
      maximumDeliveryDelayMinutes: 5,
      identifierHmacKey: hmacKey,
    });
    expect(late.lateCount).toBe(1);
    expect(late.matchedCount).toBe(0);
    expect(late.items[0]?.matchStatus).toBe("late");
    expect(
      oldestMissingAgeSeconds({
        now: new Date("2026-07-19T10:30:00.000Z"),
        items: missing.items,
      }),
    ).toBe(30 * 60);
  });

  it("plans partial_delivery when some matched and some missing", () => {
    const match = matchByNormalizedEmail({
      source: [
        {
          providerRecordId: "1",
          email: "ok@ex.com",
          observedAt: sourceAt,
        },
        {
          providerRecordId: "2",
          email: "miss@ex.com",
          observedAt: sourceAt,
        },
      ],
      destination: [
        {
          providerRecordId: "z",
          email: "ok@ex.com",
          observedAt: new Date("2026-07-19T10:01:00.000Z"),
        },
      ],
      now: new Date("2026-07-19T10:20:00.000Z"),
      maximumDeliveryDelayMinutes: 5,
      identifierHmacKey: hmacKey,
    });
    const plans = planOutcomeIncidents({
      businessPurpose: "Webinar sync",
      match,
      evidenceLevel: "medium",
      oldestMissingAgeSeconds: 1200,
      runStatus: "failed",
    });
    expect(plans[0]?.incidentType).toBe("partial_delivery");
    expect(plans[0]?.severity).toBe("critical");
    expect(plans[0]?.details).toMatchObject({
      sourceCount: 2,
      missingCount: 1,
      suggestedRecoveryBoundary: expect.stringContaining("Re-check"),
    });
  });
});
