import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export function sha256Hex(raw: Buffer | string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function buildHeartbeatSigningPayload(input: {
  method: string;
  path: string;
  timestampSeconds: string;
  idempotencyKey: string;
  bodySha256Hex: string;
}): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.timestampSeconds,
    input.idempotencyKey,
    input.bodySha256Hex,
  ].join("\n");
}

export function signHeartbeatHmacSha256(
  secret: string,
  signingPayload: string,
): string {
  return createHmac("sha256", secret).update(signingPayload).digest("hex");
}

/** Constant-time comparison of hex signatures. */
export function verifyHeartbeatSignature(input: {
  secret: string;
  method: string;
  path: string;
  timestampSeconds: string;
  idempotencyKey: string;
  rawBody: Buffer;
  providedSignatureHex: string;
}): boolean {
  const expected = signHeartbeatHmacSha256(
    input.secret,
    buildHeartbeatSigningPayload({
      method: input.method,
      path: input.path,
      timestampSeconds: input.timestampSeconds,
      idempotencyKey: input.idempotencyKey,
      bodySha256Hex: sha256Hex(input.rawBody),
    }),
  );

  const provided = input.providedSignatureHex.trim().toLowerCase();
  const expectedNorm = expected.toLowerCase();
  if (provided.length !== expectedNorm.length) {
    return false;
  }
  try {
    return timingSafeEqual(
      Buffer.from(provided, "utf8"),
      Buffer.from(expectedNorm, "utf8"),
    );
  } catch {
    return false;
  }
}

export function isTimestampWithinTolerance(input: {
  timestampSeconds: number;
  nowSeconds: number;
  toleranceSeconds: number;
}): boolean {
  if (!Number.isFinite(input.timestampSeconds)) {
    return false;
  }
  return (
    Math.abs(input.nowSeconds - input.timestampSeconds) <=
    input.toleranceSeconds
  );
}
