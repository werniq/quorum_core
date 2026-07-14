import { describe, expect, it } from "vitest";
import {
  EnvValidationError,
  loadEnv,
} from "../../src/infrastructure/config/env.js";

describe("loadEnv", () => {
  it("loads self-hosted defaults with telemetry disabled", () => {
    const env = loadEnv({
      NODE_ENV: "test",
    });
    expect(env.QUORUM_EDITION).toBe("self_hosted");
    expect(env.QUORUM_TELEMETRY_ENABLED).toBe(false);
    expect(env.PORT).toBe(3000);
  });

  it("rejects telemetry in the self-hosted edition", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "test",
        QUORUM_EDITION: "self_hosted",
        QUORUM_TELEMETRY_ENABLED: "true",
      }),
    ).toThrow(EnvValidationError);
  });

  it("rejects invalid edition values", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "test",
        QUORUM_EDITION: "zapier_cloud",
      } as NodeJS.ProcessEnv),
    ).toThrow(EnvValidationError);
  });
});
