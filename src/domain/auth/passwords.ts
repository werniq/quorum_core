import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

/** Admin / viewer passwords must be at least this many Unicode code units. */
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

/**
 * Exact-match blocklist (compared case-insensitively). No charset, entropy,
 * or zxcvbn score is required beyond length + this list.
 */
export const BANNED_ADMIN_PASSWORDS = [
  "password",
  "password123",
  "password1234",
  "password12345",
  "admin",
  "admin123",
  "adminpassword",
  "quorum",
  "quorum123",
  "quorum123456",
  "changeme",
  "changeme1234",
  "changeme12345",
  "letmein12345",
  "welcome12345",
] as const;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") {
    return false;
  }
  const salt = Buffer.from(parts[1]!, "base64url");
  const expected = Buffer.from(parts[2]!, "base64url");
  const actual = scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Acceptable local admin/viewer password for setup and user creation.
 * Criteria: length ≥ {@link MIN_ADMIN_PASSWORD_LENGTH}, and not an exact
 * case-insensitive match of {@link BANNED_ADMIN_PASSWORDS}. Setup tokens
 * (`QUORUM_SETUP_TOKEN`) are separate (≥24 chars) and do not use this check.
 */
export function isAcceptableAdminPassword(password: string): boolean {
  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return false;
  }
  const banned = new Set(
    BANNED_ADMIN_PASSWORDS.map((value) => value.toLowerCase()),
  );
  return !banned.has(password.toLowerCase());
}
