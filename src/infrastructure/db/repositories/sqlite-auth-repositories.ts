import type Database from "better-sqlite3";
import {
  generateOpaqueToken,
  hashPassword,
  hashToken,
  isAcceptableAdminPassword,
  verifyPassword,
} from "../../../domain/auth/passwords.js";
import { createId } from "../../../domain/ids.js";

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const SETUP_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

export class SqliteAuthRepositories {
  constructor(private readonly sqlite: Database.Database) {}

  hasAdminUser(): boolean {
    const row = this.sqlite
      .prepare(`SELECT COUNT(*) AS c FROM admin_users`)
      .get() as { c: number };
    return row.c > 0;
  }

  /**
   * Issues a fresh setup token when no admin exists. Plaintext is returned once;
   * only the hash is stored. Prefer `QUORUM_SETUP_TOKEN` in production bootstrap.
   */
  issueSetupToken(now: Date): { token: string } | null {
    if (this.hasAdminUser()) {
      return null;
    }
    const token = generateOpaqueToken(32);
    const nowIso = now.toISOString();
    this.sqlite
      .prepare(`DELETE FROM setup_tokens WHERE consumed_at IS NULL`)
      .run();
    this.sqlite
      .prepare(
        `INSERT INTO setup_tokens (token_hash, expires_at, consumed_at, created_at)
         VALUES (?, ?, NULL, ?)`,
      )
      .run(
        hashToken(token),
        new Date(now.getTime() + SETUP_TTL_MS).toISOString(),
        nowIso,
      );
    return { token };
  }

  /** Registers an operator-supplied setup token (hashed) when no admin exists. */
  registerSetupTokenFromEnv(token: string, now: Date): void {
    if (this.hasAdminUser() || token.length < 24) {
      return;
    }
    this.sqlite
      .prepare(`DELETE FROM setup_tokens WHERE consumed_at IS NULL`)
      .run();
    this.sqlite
      .prepare(
        `INSERT INTO setup_tokens (token_hash, expires_at, consumed_at, created_at)
         VALUES (?, ?, NULL, ?)`,
      )
      .run(
        hashToken(token),
        new Date(now.getTime() + SETUP_TTL_MS).toISOString(),
        now.toISOString(),
      );
  }

  createAdminWithSetupToken(input: {
    setupToken: string;
    username: string;
    password: string;
    now: Date;
  }): { ok: true; adminId: string } | { ok: false; code: string } {
    if (this.hasAdminUser()) {
      return { ok: false, code: "admin_exists" };
    }
    if (!isAcceptableAdminPassword(input.password)) {
      return { ok: false, code: "weak_password" };
    }
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(input.username)) {
      return { ok: false, code: "invalid_username" };
    }
    const tokenRow = this.sqlite
      .prepare(
        `SELECT token_hash, expires_at, consumed_at FROM setup_tokens
         WHERE token_hash = ? LIMIT 1`,
      )
      .get(hashToken(input.setupToken)) as
      | { token_hash: string; expires_at: string; consumed_at: string | null }
      | undefined;
    if (
      !tokenRow ||
      tokenRow.consumed_at ||
      tokenRow.expires_at < input.now.toISOString()
    ) {
      return { ok: false, code: "invalid_setup_token" };
    }

    const adminId = createId();
    const nowIso = input.now.toISOString();
    const run = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(
          `INSERT INTO admin_users (id, username, password_hash, role, created_at, updated_at)
           VALUES (?, ?, ?, 'admin', ?, ?)`,
        )
        .run(
          adminId,
          input.username,
          hashPassword(input.password),
          nowIso,
          nowIso,
        );
      this.sqlite
        .prepare(`UPDATE setup_tokens SET consumed_at = ? WHERE token_hash = ?`)
        .run(nowIso, tokenRow.token_hash);
    });
    run();
    return { ok: true, adminId };
  }

  tryLogin(input: {
    username: string;
    password: string;
    ipKey: string;
    now: Date;
  }):
    | { ok: true; sessionId: string; csrfToken: string }
    | { ok: false; code: "rate_limited" | "invalid_credentials" } {
    if (!this.consumeLoginAttempt(input.ipKey, input.now)) {
      return { ok: false, code: "rate_limited" };
    }
    const user = this.sqlite
      .prepare(`SELECT id, password_hash FROM admin_users WHERE username = ?`)
      .get(input.username) as { id: string; password_hash: string } | undefined;
    if (!user || !verifyPassword(input.password, user.password_hash)) {
      return { ok: false, code: "invalid_credentials" };
    }
    const sessionId = generateOpaqueToken(32);
    const csrfToken = generateOpaqueToken(24);
    const expiresAt = new Date(
      input.now.getTime() + SESSION_TTL_MS,
    ).toISOString();
    const nowIso = input.now.toISOString();
    const rotate = this.sqlite.transaction(() => {
      this.sqlite
        .prepare(`DELETE FROM admin_sessions WHERE admin_user_id = ?`)
        .run(user.id);
      this.sqlite
        .prepare(
          `INSERT INTO admin_sessions (id, admin_user_id, csrf_token, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(sessionId, user.id, csrfToken, expiresAt, nowIso);
    });
    rotate();
    return { ok: true, sessionId, csrfToken };
  }

  getSession(
    sessionId: string,
    now: Date,
  ): {
    adminUserId: string;
    csrfToken: string;
    role: "admin" | "operator" | "viewer";
  } | null {
    const row = this.sqlite
      .prepare(
        `SELECT s.admin_user_id, s.csrf_token, s.expires_at, COALESCE(u.role, 'admin') AS role
         FROM admin_sessions s
         JOIN admin_users u ON u.id = s.admin_user_id
         WHERE s.id = ? LIMIT 1`,
      )
      .get(sessionId) as
      | {
          admin_user_id: string;
          csrf_token: string;
          expires_at: string;
          role: string;
        }
      | undefined;
    if (!row || row.expires_at < now.toISOString()) {
      return null;
    }
    return {
      adminUserId: row.admin_user_id,
      csrfToken: row.csrf_token,
      role:
        row.role === "viewer"
          ? "viewer"
          : row.role === "operator"
            ? "operator"
            : "admin",
    };
  }

  setUserRole(
    adminUserId: string,
    role: "admin" | "operator" | "viewer",
    nowIso: string,
  ): void {
    this.sqlite
      .prepare(`UPDATE admin_users SET role = ?, updated_at = ? WHERE id = ?`)
      .run(role, nowIso, adminUserId);
  }

  createViewer(input: {
    username: string;
    password: string;
    now: Date;
  }): { ok: true; adminId: string } | { ok: false; code: string } {
    return this.createUserWithRole({ ...input, role: "viewer" });
  }

  createUserWithRole(input: {
    username: string;
    password: string;
    role: "admin" | "operator" | "viewer";
    now: Date;
  }): { ok: true; adminId: string } | { ok: false; code: string } {
    if (!isAcceptableAdminPassword(input.password)) {
      return { ok: false, code: "weak_password" };
    }
    if (!/^[a-zA-Z0-9._-]{3,64}$/.test(input.username)) {
      return { ok: false, code: "invalid_username" };
    }
    const adminId = createId();
    const nowIso = input.now.toISOString();
    try {
      this.sqlite
        .prepare(
          `INSERT INTO admin_users (id, username, password_hash, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          adminId,
          input.username,
          hashPassword(input.password),
          input.role,
          nowIso,
          nowIso,
        );
    } catch {
      return { ok: false, code: "username_taken" };
    }
    return { ok: true, adminId };
  }

  destroySession(sessionId: string): void {
    this.sqlite
      .prepare(`DELETE FROM admin_sessions WHERE id = ?`)
      .run(sessionId);
  }

  private consumeLoginAttempt(key: string, now: Date): boolean {
    const nowIso = now.toISOString();
    const row = this.sqlite
      .prepare(
        `SELECT window_started_at, attempt_count FROM login_rate_limits WHERE key = ?`,
      )
      .get(key) as
      | { window_started_at: string; attempt_count: number }
      | undefined;
    if (
      !row ||
      now.getTime() - new Date(row.window_started_at).getTime() >
        LOGIN_WINDOW_MS
    ) {
      this.sqlite
        .prepare(
          `INSERT INTO login_rate_limits (key, window_started_at, attempt_count)
           VALUES (?, ?, 1)
           ON CONFLICT(key) DO UPDATE SET window_started_at = excluded.window_started_at,
             attempt_count = 1`,
        )
        .run(key, nowIso);
      return true;
    }
    if (row.attempt_count >= LOGIN_MAX_ATTEMPTS) {
      return false;
    }
    this.sqlite
      .prepare(
        `UPDATE login_rate_limits SET attempt_count = attempt_count + 1 WHERE key = ?`,
      )
      .run(key);
    return true;
  }
}
