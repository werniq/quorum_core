import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  buildReadinessState,
  listMigrationTags,
  readMigrationSql,
  splitMigrationStatements,
} from "./migrations.js";
import * as schema from "./schema/sqlite/index.js";
import type { SchemaReadinessState } from "../../application/schema-readiness.js";

const MIGRATIONS_TABLE = "__quorum_migrations";
const FAILURE_TABLE = "__quorum_migration_failure";

export type SqliteDb = BetterSQLite3Database<typeof schema>;

export function openSqliteDatabase(filePath: string): {
  sqlite: Database.Database;
  db: SqliteDb;
} {
  const sqlite = new Database(filePath);
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

function ensureMetaTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tag TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${FAILURE_TABLE} (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      error TEXT NOT NULL,
      failed_at TEXT NOT NULL
    );
  `);
}

function applyMigration(
  sqlite: Database.Database,
  tag: string,
  appliedAt: string,
): void {
  const sql = readMigrationSql("sqlite", tag);
  const statements = splitMigrationStatements(sql);
  const controlsForeignKeys = statements.some((statement) =>
    /^PRAGMA\s+foreign_keys\s*=\s*OFF\s*;?$/i.test(statement.trim()),
  );
  const executableStatements = controlsForeignKeys
    ? statements.filter(
        (statement) =>
          !/^PRAGMA\s+foreign_keys\s*=\s*(?:ON|OFF)\s*;?$/i.test(
            statement.trim(),
          ),
      )
    : statements;
  const foreignKeysWereEnabled = Boolean(
    sqlite.pragma("foreign_keys", { simple: true }),
  );

  if (controlsForeignKeys) {
    // SQLite ignores changes to foreign_keys after a transaction begins.
    sqlite.pragma("foreign_keys = OFF");
  }
  try {
    sqlite.transaction(() => {
      for (const statement of executableStatements) {
        sqlite.exec(statement);
      }
      sqlite
        .prepare(
          `INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES (?, ?)`,
        )
        .run(tag, appliedAt);
    })();
  } finally {
    if (controlsForeignKeys && foreignKeysWereEnabled) {
      sqlite.pragma("foreign_keys = ON");
    }
  }
}

export function getAppliedSqliteMigrationTags(
  sqlite: Database.Database,
): string[] {
  ensureMetaTables(sqlite);
  const rows = sqlite
    .prepare(`SELECT tag FROM ${MIGRATIONS_TABLE} ORDER BY id ASC`)
    .all() as Array<{ tag: string }>;
  return rows.map((row) => row.tag);
}

export function getSqliteMigrationFailure(
  sqlite: Database.Database,
): string | null {
  ensureMetaTables(sqlite);
  const row = sqlite
    .prepare(`SELECT error FROM ${FAILURE_TABLE} WHERE id = 1`)
    .get() as { error: string } | undefined;
  return row?.error ?? null;
}

export function evaluateSqliteReadiness(
  sqlite: Database.Database,
): SchemaReadinessState {
  ensureMetaTables(sqlite);
  return buildReadinessState({
    expectedTags: listMigrationTags("sqlite"),
    appliedTags: getAppliedSqliteMigrationTags(sqlite),
    failedError: getSqliteMigrationFailure(sqlite),
  });
}

export function migrateSqliteToLatest(sqlite: Database.Database): void {
  ensureMetaTables(sqlite);
  const applied = new Set(getAppliedSqliteMigrationTags(sqlite));
  const expected = listMigrationTags("sqlite");
  const existingFailure = getSqliteMigrationFailure(sqlite);
  if (existingFailure) {
    const nextPending = expected.find((tag) => !applied.has(tag));
    const isRecoverable0020Failure =
      nextPending === "0020_effect_receipt_reconciliation" &&
      existingFailure === "FOREIGN KEY constraint failed";
    if (!isRecoverable0020Failure) {
      throw new Error(
        `Cannot migrate: previous migration failed: ${existingFailure}`,
      );
    }
    sqlite.prepare(`DELETE FROM ${FAILURE_TABLE} WHERE id = 1`).run();
  }

  for (const tag of expected) {
    if (applied.has(tag)) {
      continue;
    }
    try {
      applyMigration(sqlite, tag, new Date().toISOString());
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown migration failure";
      sqlite
        .prepare(
          `INSERT INTO ${FAILURE_TABLE} (id, error, failed_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET error = excluded.error, failed_at = excluded.failed_at`,
        )
        .run(message, new Date().toISOString());
      throw error;
    }
  }
}

export function migrateSqliteUpTo(
  sqlite: Database.Database,
  inclusiveTag: string,
): void {
  ensureMetaTables(sqlite);
  const applied = new Set(getAppliedSqliteMigrationTags(sqlite));
  const expected = listMigrationTags("sqlite");
  const stopIndex = expected.indexOf(inclusiveTag);
  if (stopIndex < 0) {
    throw new Error(`Unknown migration tag: ${inclusiveTag}`);
  }

  for (const tag of expected.slice(0, stopIndex + 1)) {
    if (applied.has(tag)) {
      continue;
    }
    applyMigration(sqlite, tag, new Date().toISOString());
  }
}
