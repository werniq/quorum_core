import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";

/**
 * Online SQLite backup using the native backup API (safe while readers exist;
 * prefer quiescing writers for consistency of in-flight transactions).
 */
export async function backupSqliteDatabase(
  sqlite: Database.Database,
  destinationPath: string,
): Promise<void> {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  await sqlite.backup(destinationPath);
}

/**
 * Behavior when KEK is missing after restore: credentials cannot be decrypted.
 */
export function describeMissingKekFailure(): string {
  return "QUORUM_CREDENTIAL_KEK is required after restore; push credentials and alert channel configs cannot be decrypted without it.";
}
