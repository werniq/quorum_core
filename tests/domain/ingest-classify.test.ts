import { describe, expect, it } from "vitest";
import { classifyInboundHeartbeatPayload } from "../../src/domain/ingestion/classify-payload.js";
import { evaluateCredentialRateLimit } from "../../src/domain/ingestion/rate-limit.js";

describe("classifyInboundHeartbeatPayload", () => {
  it("maps failure, empty success, and nonempty success", () => {
    expect(
      classifyInboundHeartbeatPayload(
        {
          schemaVersion: 1,
          executedAt: "2026-07-18T08:00:00Z",
          status: "failure",
        },
        { countLessSuccessAllowed: true },
      ),
    ).toMatchObject({ ok: true, evidenceStatus: "failure" });

    expect(
      classifyInboundHeartbeatPayload(
        {
          schemaVersion: 1,
          executedAt: "2026-07-18T08:00:00Z",
          status: "success",
          itemsProcessed: 0,
        },
        { countLessSuccessAllowed: false },
      ),
    ).toMatchObject({ ok: true, evidenceStatus: "empty_result" });

    expect(
      classifyInboundHeartbeatPayload(
        {
          schemaVersion: 1,
          executedAt: "2026-07-18T08:00:00Z",
          status: "success",
          itemsProcessed: 12,
        },
        { countLessSuccessAllowed: false },
      ),
    ).toMatchObject({ ok: true, evidenceStatus: "success" });
  });

  it("requires itemsProcessed when countLessSuccessAllowed is false", () => {
    expect(
      classifyInboundHeartbeatPayload(
        {
          schemaVersion: 1,
          executedAt: "2026-07-18T08:00:00Z",
          status: "success",
        },
        { countLessSuccessAllowed: false },
      ),
    ).toEqual({ ok: false, code: "ITEMS_REQUIRED" });

    expect(
      classifyInboundHeartbeatPayload(
        {
          schemaVersion: 1,
          executedAt: "2026-07-18T08:00:00Z",
          status: "success",
        },
        { countLessSuccessAllowed: true },
      ),
    ).toMatchObject({ ok: true, evidenceStatus: "success" });
  });
});

describe("evaluateCredentialRateLimit", () => {
  it("isolates accepted capacity per window with burst", () => {
    const policy = {
      acceptedPerMinute: 2,
      burstAllowance: 1,
      sustainedRejectionWarningThreshold: 2,
      tenantAcceptedPerMinute: null,
      globalAcceptedPerMinute: null,
    };
    const now = new Date("2026-07-18T08:00:00Z");
    const first = evaluateCredentialRateLimit({
      now,
      windowStartedAt: null,
      acceptedCount: 0,
      rejectedCount: 0,
      policy,
      accepting: true,
    });
    expect(first.allowed).toBe(true);

    const blocked = evaluateCredentialRateLimit({
      now,
      windowStartedAt: first.windowStartedAt,
      acceptedCount: 3,
      rejectedCount: 0,
      policy,
      accepting: true,
    });
    expect(blocked.allowed).toBe(false);
    expect(blocked.rejectedCount).toBe(1);
  });
});
