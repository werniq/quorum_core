import { createHmac } from "node:crypto";
import { addMinutes } from "../cadence/duration.js";

/** Normalize email for HubSpot↔Zoom matching: trim + lowercase. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Keyed HMAC of a normalized identifier.
 * Plain SHA-256 of emails is not enough. Pseudonymized values may still be personal data.
 */
export function hashIdentifier(
  normalizedValue: string,
  identifierHmacKey: string,
): string {
  if (!identifierHmacKey || identifierHmacKey.length < 16) {
    throw new Error("identifier_hmac_key_required");
  }
  return createHmac("sha256", identifierHmacKey)
    .update(normalizedValue, "utf8")
    .digest("hex");
}

export function emailMatchKey(
  email: string,
  identifierHmacKey: string,
): {
  normalized: string;
  hash: string;
} {
  const normalized = normalizeEmail(email);
  return { normalized, hash: hashIdentifier(normalized, identifierHmacKey) };
}

export interface ObservationRecord {
  /** Provider-native id when available (not personal data). */
  providerRecordId: string | null;
  email: string;
  observedAt: Date;
}

export type MatchStatus =
  | "matched"
  | "missing"
  | "duplicate"
  | "late"
  | "waiting"
  | "ignored";

export interface MatchResultItem {
  sourceIdentifierHash: string;
  destinationIdentifierHash: string | null;
  matchStatus: MatchStatus;
  sourceObservedAt: Date | null;
  destinationObservedAt: Date | null;
}

export interface MatchByEmailResult {
  items: MatchResultItem[];
  sourceCount: number;
  destinationCount: number;
  matchedCount: number;
  missingCount: number;
  duplicateCount: number;
  lateCount: number;
  waitingCount: number;
}

/**
 * Exact record-level match on normalized email for HubSpot→Zoom.
 *
 * - Within maximum delivery delay and no destination yet → `waiting` (not missing).
 * - Past delay with no destination → `missing`.
 * - Destination after the delay deadline → `late`.
 * - Destination on time → `matched`.
 */
export function matchByNormalizedEmail(input: {
  source: ObservationRecord[];
  destination: ObservationRecord[];
  now: Date;
  maximumDeliveryDelayMinutes: number;
  identifierHmacKey: string;
}): MatchByEmailResult {
  const delayMs = Math.max(0, input.maximumDeliveryDelayMinutes) * 60_000;
  const destByHash = new Map<
    string,
    { hash: string; observedAt: Date; count: number }
  >();
  for (const row of input.destination) {
    const { hash } = emailMatchKey(row.email, input.identifierHmacKey);
    const existing = destByHash.get(hash);
    if (existing) {
      existing.count += 1;
      if (row.observedAt.getTime() < existing.observedAt.getTime()) {
        existing.observedAt = row.observedAt;
      }
    } else {
      destByHash.set(hash, {
        hash,
        observedAt: row.observedAt,
        count: 1,
      });
    }
  }

  let duplicateCount = 0;
  for (const entry of destByHash.values()) {
    if (entry.count > 1) {
      duplicateCount += entry.count - 1;
    }
  }

  const items: MatchResultItem[] = [];
  let matchedCount = 0;
  let missingCount = 0;
  let lateCount = 0;
  let waitingCount = 0;
  const seenSource = new Set<string>();

  for (const row of input.source) {
    const { hash } = emailMatchKey(row.email, input.identifierHmacKey);
    if (seenSource.has(hash)) {
      items.push({
        sourceIdentifierHash: hash,
        destinationIdentifierHash: null,
        matchStatus: "duplicate",
        sourceObservedAt: row.observedAt,
        destinationObservedAt: null,
      });
      duplicateCount += 1;
      continue;
    }
    seenSource.add(hash);
    const deadline = new Date(row.observedAt.getTime() + delayMs);
    const dest = destByHash.get(hash);

    if (!dest) {
      if (input.now.getTime() <= deadline.getTime()) {
        waitingCount += 1;
        items.push({
          sourceIdentifierHash: hash,
          destinationIdentifierHash: null,
          matchStatus: "waiting",
          sourceObservedAt: row.observedAt,
          destinationObservedAt: null,
        });
      } else {
        missingCount += 1;
        items.push({
          sourceIdentifierHash: hash,
          destinationIdentifierHash: null,
          matchStatus: "missing",
          sourceObservedAt: row.observedAt,
          destinationObservedAt: null,
        });
      }
      continue;
    }

    if (dest.observedAt.getTime() <= deadline.getTime()) {
      matchedCount += 1;
      items.push({
        sourceIdentifierHash: hash,
        destinationIdentifierHash: dest.hash,
        matchStatus: "matched",
        sourceObservedAt: row.observedAt,
        destinationObservedAt: dest.observedAt,
      });
    } else {
      lateCount += 1;
      items.push({
        sourceIdentifierHash: hash,
        destinationIdentifierHash: dest.hash,
        matchStatus: "late",
        sourceObservedAt: row.observedAt,
        destinationObservedAt: dest.observedAt,
      });
    }
  }

  return {
    items,
    sourceCount: input.source.length,
    destinationCount: input.destination.length,
    matchedCount,
    missingCount,
    duplicateCount,
    lateCount,
    waitingCount,
  };
}

export function evaluateMissingAgainstPolicy(input: {
  sourceCount: number;
  missingCount: number;
  acceptableMissingCount: number;
  acceptableMissingPercentage: number;
}): "healthy" | "warning" | "failed" {
  if (input.missingCount === 0) {
    return "healthy";
  }
  if (input.missingCount <= input.acceptableMissingCount) {
    return "warning";
  }
  const pct =
    input.sourceCount === 0
      ? 0
      : (input.missingCount / input.sourceCount) * 100;
  if (pct <= input.acceptableMissingPercentage) {
    return "warning";
  }
  return "failed";
}

/** Deterministic observation window ending at `now`, looking back `lookbackMinutes`. */
export function observationWindow(input: {
  now: Date;
  lookbackMinutes: number;
}): { windowStart: Date; windowEnd: Date } {
  const windowEnd = input.now;
  const windowStart = addMinutes(
    windowEnd,
    -Math.max(1, input.lookbackMinutes),
  );
  return { windowStart, windowEnd };
}

export function oldestMissingAgeSeconds(input: {
  now: Date;
  items: MatchResultItem[];
}): number | null {
  let oldest: Date | null = null;
  for (const item of input.items) {
    if (item.matchStatus !== "missing" || !item.sourceObservedAt) {
      continue;
    }
    if (!oldest || item.sourceObservedAt.getTime() < oldest.getTime()) {
      oldest = item.sourceObservedAt;
    }
  }
  if (!oldest) {
    return null;
  }
  return Math.max(
    0,
    Math.floor((input.now.getTime() - oldest.getTime()) / 1000),
  );
}
