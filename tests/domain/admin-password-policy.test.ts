import { describe, expect, it } from "vitest";
import {
  BANNED_ADMIN_PASSWORDS,
  MIN_ADMIN_PASSWORD_LENGTH,
  isAcceptableAdminPassword,
} from "../../src/domain/auth/passwords.js";

describe("isAcceptableAdminPassword", () => {
  it("requires at least MIN_ADMIN_PASSWORD_LENGTH characters", () => {
    expect(MIN_ADMIN_PASSWORD_LENGTH).toBe(12);
    expect(isAcceptableAdminPassword("a".repeat(11))).toBe(false);
    expect(isAcceptableAdminPassword("a".repeat(12))).toBe(true);
  });

  it("rejects exact case-insensitive blocklist matches", () => {
    for (const banned of BANNED_ADMIN_PASSWORDS) {
      expect(isAcceptableAdminPassword(banned)).toBe(false);
      expect(isAcceptableAdminPassword(banned.toUpperCase())).toBe(false);
    }
    expect(isAcceptableAdminPassword("password1234")).toBe(false);
    expect(isAcceptableAdminPassword("PASSWORD1234")).toBe(false);
  });

  it("does not require charset mixture or entropy scoring", () => {
    expect(isAcceptableAdminPassword("strong-local-password")).toBe(true);
    expect(isAcceptableAdminPassword("aaaaaaaaaaaa")).toBe(true);
    expect(isAcceptableAdminPassword("password1234x")).toBe(true);
  });
});
