import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  SchemaDialect,
  SchemaReadinessState,
} from "../../application/schema-readiness.js";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export function migrationsDirectory(dialect: SchemaDialect): string {
  return path.join(packageRoot, "drizzle", dialect);
}

export interface MigrationJournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface MigrationJournal {
  version: string;
  dialect: string;
  entries: MigrationJournalEntry[];
}

export function readMigrationJournal(dialect: SchemaDialect): MigrationJournal {
  const journalPath = path.join(
    migrationsDirectory(dialect),
    "meta",
    "_journal.json",
  );
  const raw = fs.readFileSync(journalPath, "utf8");
  return JSON.parse(raw) as MigrationJournal;
}

export function listMigrationTags(dialect: SchemaDialect): string[] {
  return readMigrationJournal(dialect).entries.map((entry) => entry.tag);
}

export function readMigrationSql(dialect: SchemaDialect, tag: string): string {
  const filePath = path.join(migrationsDirectory(dialect), `${tag}.sql`);
  return fs.readFileSync(filePath, "utf8");
}

/** Splits Drizzle breakpoint-separated migration SQL into statements. */
export function splitMigrationStatements(sql: string): string[] {
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function buildReadinessState(input: {
  expectedTags: string[];
  appliedTags: string[];
  failedError?: string | null;
}): SchemaReadinessState {
  if (input.failedError) {
    return {
      status: "failed_migration",
      error: input.failedError,
      appliedMigrations: input.appliedTags,
    };
  }

  const pending = input.expectedTags.filter(
    (tag) => !input.appliedTags.includes(tag),
  );
  if (pending.length > 0) {
    return {
      status: "pending_migrations",
      pendingMigrations: pending,
      appliedMigrations: input.appliedTags,
    };
  }

  return {
    status: "ready",
    appliedMigrations: input.appliedTags,
  };
}
