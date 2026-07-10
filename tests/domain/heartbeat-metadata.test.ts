import { describe, expect, it } from "vitest";
import {
  assertItemsProcessedValid,
  HEARTBEAT_METADATA_MAX_BYTES,
  sanitizeHeartbeatMetadata,
} from "../../src/domain/evidence/heartbeat-metadata.js";

describe("sanitizeHeartbeatMetadata", () => {
  it("allows null metadata", () => {
    expect(sanitizeHeartbeatMetadata(null)).toEqual({
      ok: true,
      metadataJson: null,
      issues: [],
    });
  });

  it("rejects secret-like keys and raw payload fields", () => {
    const result = sanitizeHeartbeatMetadata({
      api_key: "x",
      payload: { huge: true },
      source: "n8n",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("api_key"))).toBe(true);
    expect(result.issues.some((i) => i.includes("payload"))).toBe(true);
  });

  it("rejects oversized metadata", () => {
    const result = sanitizeHeartbeatMetadata({
      note: "x".repeat(HEARTBEAT_METADATA_MAX_BYTES),
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes("exceeds"))).toBe(true);
  });

  it("serializes sanitized metadata", () => {
    const result = sanitizeHeartbeatMetadata({
      trigger: "manual",
      node: "Webhook",
    });
    expect(result.ok).toBe(true);
    expect(result.metadataJson).toBe(
      JSON.stringify({ trigger: "manual", node: "Webhook" }),
    );
  });
});

describe("assertItemsProcessedValid", () => {
  it("allows null and non-negative integers", () => {
    expect(assertItemsProcessedValid(null)).toBe(true);
    expect(assertItemsProcessedValid(0)).toBe(true);
    expect(assertItemsProcessedValid(3)).toBe(true);
    expect(assertItemsProcessedValid(-1)).toBe(false);
  });
});
