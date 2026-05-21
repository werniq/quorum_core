import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SHARE_TOKEN_BYTES = 32;
export const SHARE_TOKEN_RATE_LIMIT = 60;
export const SHARE_TOKEN_RATE_WINDOW_MS = 60_000;

export function generateShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}

export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function shareTokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isShareTokenExpired(
  expiresAtIso: string,
  nowIso: string,
): boolean {
  return expiresAtIso <= nowIso;
}

export function isShareTokenRevoked(revokedAt: string | null): boolean {
  return revokedAt != null;
}

/**
 * Returns whether the request is allowed under a simple sliding window counter.
 * Caller persists updated windowStart / count.
 */
export function nextShareTokenRateLimit(input: {
  windowStartIso: string | null;
  count: number;
  now: Date;
  limit?: number;
  windowMs?: number;
}): {
  allowed: boolean;
  windowStartIso: string;
  count: number;
} {
  const limit = input.limit ?? SHARE_TOKEN_RATE_LIMIT;
  const windowMs = input.windowMs ?? SHARE_TOKEN_RATE_WINDOW_MS;
  const nowIso = input.now.toISOString();
  if (
    !input.windowStartIso ||
    input.now.getTime() - Date.parse(input.windowStartIso) >= windowMs
  ) {
    return { allowed: true, windowStartIso: nowIso, count: 1 };
  }
  if (input.count >= limit) {
    return {
      allowed: false,
      windowStartIso: input.windowStartIso,
      count: input.count,
    };
  }
  return {
    allowed: true,
    windowStartIso: input.windowStartIso,
    count: input.count + 1,
  };
}
