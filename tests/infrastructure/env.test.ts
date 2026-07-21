import { describe, expect, it } from "vitest";
import {
  EnvValidationError,
  isUiOpenWithoutLogin,
  loadEnv,
} from "../../src/infrastructure/config/env.js";

describe("loadEnv", () => {
  it("loads self-hosted defaults with telemetry disabled and UI auth on", () => {
    const env = loadEnv({
      NODE_ENV: "test",
    });
    expect(env.QUORUM_EDITION).toBe("self_hosted");
    expect(env.QUORUM_TELEMETRY_ENABLED).toBe(false);
    expect(env.QUORUM_UI_AUTH_ENABLED).toBe(true);
    expect(env.QUORUM_DEMO_MODE).toBe(false);
    expect(env.PORT).toBe(3000);
  });

  it("disables UI auth when QUORUM_UI_AUTH_ENABLED=false", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      QUORUM_UI_AUTH_ENABLED: "false",
    });
    expect(env.QUORUM_UI_AUTH_ENABLED).toBe(false);
    expect(isUiOpenWithoutLogin(env)).toBe(true);
  });

  it("enables demo mode on localhost and opens UI without login", () => {
    const env = loadEnv({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      QUORUM_DEMO_MODE: "true",
    });
    expect(env.QUORUM_DEMO_MODE).toBe(true);
    expect(isUiOpenWithoutLogin(env)).toBe(true);
  });

  it("rejects demo mode when HOST is not loopback", () => {
    expect(() =>
      loadEnv({
        NODE_ENV: "test",
        HOST: "0.0.0.0",
        QUORUM_DEMO_MODE: "true",
      }),
    ).toThrow(EnvValidationError);
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
