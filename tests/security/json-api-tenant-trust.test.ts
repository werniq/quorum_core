import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type BetterSqliteDatabase from "better-sqlite3";
import {
  migrateSqliteToLatest,
  openSqliteDatabase,
} from "../../src/infrastructure/db/sqlite-migrator.js";
import { SqliteCoreRepositories } from "../../src/infrastructure/db/repositories/sqlite-core-repositories.js";
import { FixedClock } from "../../src/domain/clock.js";
import { createId } from "../../src/domain/ids.js";
import { buildApp } from "../../src/infrastructure/http/app.js";
import { loadEnv } from "../../src/infrastructure/config/env.js";

const openConnections: BetterSqliteDatabase.Database[] = [];
const tempFiles: string[] = [];

function openDb(): BetterSqliteDatabase.Database {
  const filePath = path.join(
    os.tmpdir(),
    `quorum-tenant-api-${Date.now()}-${Math.random().toString(16).slice(2)}.db`,
  );
  tempFiles.push(filePath);
  const { sqlite } = openSqliteDatabase(filePath);
  openConnections.push(sqlite);
  migrateSqliteToLatest(sqlite);
  return sqlite;
}

afterEach(() => {
  while (openConnections.length > 0) {
    try {
      openConnections.pop()?.close();
    } catch {
      // ignore
    }
  }
  for (const filePath of tempFiles.splice(0, tempFiles.length)) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        const candidate = `${filePath}${suffix}`;
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      } catch {
        // ignore
      }
    }
  }
});

describe("JSON API tenant trust", () => {
  it("self-hosted rejects forged foreign x-quorum-tenant-id", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const core = new SqliteCoreRepositories(sqlite);
    const local = core.ensureSelfHostedTenant();
    const foreign = createId();
    sqlite
      .prepare(
        `INSERT INTO tenants (id, name, edition, created_at, updated_at)
         VALUES (?, 'Foreign', 'saas', ?, ?)`,
      )
      .run(foreign, clock.now().toISOString(), clock.now().toISOString());

    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
      }),
      clock,
      sqlite,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: [],
      }),
    });

    const forged = await app.inject({
      method: "GET",
      url: "/api/v1/catalog/contracts",
      headers: { "x-quorum-tenant-id": foreign },
    });
    expect(forged.statusCode).toBe(403);

    const ok = await app.inject({
      method: "GET",
      url: "/api/v1/catalog/contracts",
      headers: { "x-quorum-tenant-id": local.id },
    });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });

  it("non-self-hosted edition returns edition_not_supported", async () => {
    const sqlite = openDb();
    const clock = new FixedClock(new Date("2026-07-19T12:00:00.000Z"));
    const app = await buildApp({
      env: loadEnv({
        NODE_ENV: "test",
        QUORUM_EDITION: "saas",
        QUORUM_CREDENTIAL_KEK: "quorum-test-credential-kek",
      }),
      clock,
      sqlite,
      getSchemaReadiness: () => ({
        status: "ready",
        appliedMigrations: [],
      }),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/catalog/contracts",
    });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({ error: "edition_not_supported" });
    await app.close();
  });
});
