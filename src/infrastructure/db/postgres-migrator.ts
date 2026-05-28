import type { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  buildReadinessState,
  listMigrationTags,
  readMigrationSql,
  splitMigrationStatements,
} from "./migrations.js";
import * as schema from "./schema/postgres/index.js";
import type { SchemaReadinessState } from "../../application/schema-readiness.js";
import type { PostgresPoolLike } from "./postgres-runtime.js";

const MIGRATIONS_TABLE = "__quorum_migrations";
const FAILURE_TABLE = "__quorum_migration_failure";

export type PostgresDb = NodePgDatabase<typeof schema>;

export function createPostgresDb(pool: Pool): PostgresDb {
  return drizzle(pool, { schema });
}

/** Normalize pg.Pool or PGlite adapter to a single queryable surface. */
function asPoolLike(pool: Pool | PostgresPoolLike): PostgresPoolLike {
  return pool as PostgresPoolLike;
}

async function ensureMetaTables(pool: PostgresPoolLike): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id SERIAL PRIMARY KEY,
      tag TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${FAILURE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      error TEXT NOT NULL,
      failed_at TIMESTAMPTZ NOT NULL
    )
  `);
}

export async function getAppliedPostgresMigrationTags(
  pool: Pool | PostgresPoolLike,
): Promise<string[]> {
  const p = asPoolLike(pool);
  await ensureMetaTables(p);
  const result = await p.query<{ tag: string }>(
    `SELECT tag FROM ${MIGRATIONS_TABLE} ORDER BY id ASC`,
  );
  return result.rows.map((row) => row.tag);
}

export async function getPostgresMigrationFailure(
  pool: Pool | PostgresPoolLike,
): Promise<string | null> {
  const p = asPoolLike(pool);
  await ensureMetaTables(p);
  const result = await p.query<{ error: string }>(
    `SELECT error FROM ${FAILURE_TABLE} WHERE id = 1`,
  );
  return result.rows[0]?.error ?? null;
}

export async function evaluatePostgresReadiness(
  pool: Pool | PostgresPoolLike,
): Promise<SchemaReadinessState> {
  const p = asPoolLike(pool);
  await ensureMetaTables(p);
  return buildReadinessState({
    expectedTags: listMigrationTags("postgres"),
    appliedTags: await getAppliedPostgresMigrationTags(p),
    failedError: await getPostgresMigrationFailure(p),
  });
}

export async function migratePostgresToLatest(
  pool: Pool | PostgresPoolLike,
): Promise<void> {
  const p = asPoolLike(pool);
  await ensureMetaTables(p);
  const existingFailure = await getPostgresMigrationFailure(p);
  if (existingFailure) {
    throw new Error(
      `Cannot migrate: previous migration failed: ${existingFailure}`,
    );
  }

  const applied = new Set(await getAppliedPostgresMigrationTags(p));
  const expected = listMigrationTags("postgres");

  for (const tag of expected) {
    if (applied.has(tag)) {
      continue;
    }
    const sql = readMigrationSql("postgres", tag);
    const statements = splitMigrationStatements(sql);
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES ($1, NOW())`,
        [tag],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      const message =
        error instanceof Error ? error.message : "Unknown migration failure";
      await p.query(
        `INSERT INTO ${FAILURE_TABLE} (id, error, failed_at)
         VALUES (1, $1, NOW())
         ON CONFLICT (id) DO UPDATE
         SET error = EXCLUDED.error, failed_at = EXCLUDED.failed_at`,
        [message],
      );
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function migratePostgresUpTo(
  pool: Pool | PostgresPoolLike,
  inclusiveTag: string,
): Promise<void> {
  const p = asPoolLike(pool);
  await ensureMetaTables(p);
  const applied = new Set(await getAppliedPostgresMigrationTags(p));
  const expected = listMigrationTags("postgres");
  const stopIndex = expected.indexOf(inclusiveTag);
  if (stopIndex < 0) {
    throw new Error(`Unknown migration tag: ${inclusiveTag}`);
  }

  for (const tag of expected.slice(0, stopIndex + 1)) {
    if (applied.has(tag)) {
      continue;
    }
    const sql = readMigrationSql("postgres", tag);
    const statements = splitMigrationStatements(sql);
    const client = await p.connect();
    try {
      await client.query("BEGIN");
      for (const statement of statements) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES ($1, NOW())`,
        [tag],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
