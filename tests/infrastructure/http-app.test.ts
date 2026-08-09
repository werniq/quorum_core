import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/infrastructure/http/app.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";
import type { FastifyInstance } from "fastify";

describe("Fastify bootstrap", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  });

  it("exposes healthz without advertising unfinished product surfaces", async () => {
    app = await buildApp({
      env: loadEnv({ NODE_ENV: "test" }),
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0001_tenants_clients"],
      }),
    });

    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    const body = response.json() as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body).not.toHaveProperty("catalog");
    expect(body).not.toHaveProperty("billing");
    expect(body).not.toHaveProperty("reconciliation");
  });

  it("returns 503 from readyz when migrations are pending", async () => {
    app = await buildApp({
      env: loadEnv({ NODE_ENV: "test" }),
      getSchemaReadiness: () => ({
        status: "pending_migrations",
        pendingMigrations: ["0004_incidents_alerting_outbox"],
        appliedMigrations: [],
      }),
    });

    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "not_ready" });
  });

  it("returns ready when schema readiness is ready", async () => {
    app = await buildApp({
      env: loadEnv({ NODE_ENV: "test" }),
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0001_tenants_clients"],
      }),
    });

    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ready" });
  });

  it("serves incident interactions as a same-origin CSP-compatible asset", async () => {
    app = await buildApp({
      env: loadEnv({ NODE_ENV: "test" }),
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: ["0001_tenants_clients"],
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/assets/incidents.js",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain(
      "application/javascript",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect(response.body).toContain("data-incident-toggle");
    expect(response.body).toContain("aria-expanded");
  });
});
