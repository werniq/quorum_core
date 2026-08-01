/**
 * Source watermark freshness: a comparable token that must advance
 * (within an allowed staleness window) when the contract requires it.
 */

export type WatermarkComparisonType =
  | "auto"
  | "numeric"
  | "iso_datetime"
  | "lexicographic";

export type WatermarkComparison =
  | { ok: true; advanced: boolean; watermark: string; deltaMs: number | null }
  | { ok: false; reason: "missing" | "invalid" };

export function extractSourceWatermark(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata) return null;
  const raw =
    metadata.sourceWatermark ??
    metadata.source_watermark ??
    metadata.source_max_updated_at ??
    metadata.sourceMaxUpdatedAt;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }
  return null;
}

function isNumericToken(value: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(value.trim());
}

/**
 * Compare watermarks using an explicit type (or auto: numeric → ISO → lex).
 * Equal values do not advance.
 */
export function compareSourceWatermarks(
  previous: string | null,
  next: string,
  comparisonType: WatermarkComparisonType = "auto",
): WatermarkComparison {
  const watermark = next.trim();
  if (!watermark) {
    return { ok: false, reason: "invalid" };
  }
  if (previous === null || previous === "") {
    return { ok: true, advanced: true, watermark, deltaMs: null };
  }

  const type = comparisonType;

  if (
    type === "numeric" ||
    (type === "auto" && isNumericToken(previous) && isNumericToken(watermark))
  ) {
    const prevNum = Number(previous);
    const nextNum = Number(watermark);
    if (!Number.isFinite(prevNum) || !Number.isFinite(nextNum)) {
      return { ok: false, reason: "invalid" };
    }
    return {
      ok: true,
      advanced: nextNum > prevNum,
      watermark,
      deltaMs: null,
    };
  }

  if (type === "iso_datetime" || type === "auto") {
    const prevDate = Date.parse(previous);
    const nextDate = Date.parse(watermark);
    if (!Number.isNaN(prevDate) && !Number.isNaN(nextDate)) {
      return {
        ok: true,
        advanced: nextDate > prevDate,
        watermark,
        deltaMs: nextDate - prevDate,
      };
    }
    if (type === "iso_datetime") {
      return { ok: false, reason: "invalid" };
    }
  }

  return {
    ok: true,
    advanced: watermark > previous,
    watermark,
    deltaMs: null,
  };
}

/**
 * Evaluate freshness for one success report.
 * - When not required: hold prior watermark counters (do not reset).
 * - Allowed staleness: unchanged watermark is OK until
 *   (observedAt - previousWatermarkAt) exceeds allowedStalenessSeconds.
 */
export function evaluateWatermarkFreshness(input: {
  required: boolean;
  previousWatermark: string | null;
  /** When the previous watermark was last accepted as advanced/stored. */
  previousWatermarkAt?: string | null;
  observedAt?: string;
  metadata: Record<string, unknown> | null | undefined;
  consecutiveStale: number;
  breachThreshold: number;
  comparisonType?: WatermarkComparisonType;
  /** Seconds the watermark may remain unchanged before counting as stale. */
  allowedStalenessSeconds?: number;
}): {
  status: "not_configured" | "advanced" | "stale" | "missing";
  nextWatermark: string | null;
  nextWatermarkAt: string | null;
  consecutiveStale: number;
  shouldOpenIncident: boolean;
} {
  const previousAt = input.previousWatermarkAt ?? null;
  if (!input.required) {
    return {
      status: "not_configured",
      nextWatermark: input.previousWatermark,
      nextWatermarkAt: previousAt,
      consecutiveStale: input.consecutiveStale,
      shouldOpenIncident: false,
    };
  }
  const comparisonType = input.comparisonType ?? "auto";
  const allowedStalenessSeconds = Math.max(
    0,
    input.allowedStalenessSeconds ?? 0,
  );
  const observedAt = input.observedAt ?? previousAt ?? "";
  const extracted = extractSourceWatermark(input.metadata);
  if (extracted === null) {
    const consecutive = input.consecutiveStale + 1;
    return {
      status: "missing",
      nextWatermark: input.previousWatermark,
      nextWatermarkAt: previousAt,
      consecutiveStale: consecutive,
      shouldOpenIncident: consecutive >= Math.max(1, input.breachThreshold),
    };
  }
  const compared = compareSourceWatermarks(
    input.previousWatermark,
    extracted,
    comparisonType,
  );
  if (!compared.ok) {
    const consecutive = input.consecutiveStale + 1;
    return {
      status: "missing",
      nextWatermark: input.previousWatermark,
      nextWatermarkAt: previousAt,
      consecutiveStale: consecutive,
      shouldOpenIncident: consecutive >= Math.max(1, input.breachThreshold),
    };
  }
  if (compared.advanced) {
    return {
      status: "advanced",
      nextWatermark: compared.watermark,
      nextWatermarkAt: observedAt,
      consecutiveStale: 0,
      shouldOpenIncident: false,
    };
  }

  // Unchanged watermark: within allowed staleness window → not yet a stale tick.
  if (allowedStalenessSeconds > 0 && previousAt) {
    const prevAtMs = Date.parse(previousAt);
    const obsAtMs = Date.parse(observedAt);
    if (
      !Number.isNaN(prevAtMs) &&
      !Number.isNaN(obsAtMs) &&
      obsAtMs - prevAtMs <= allowedStalenessSeconds * 1000
    ) {
      return {
        status: "advanced",
        nextWatermark: compared.watermark,
        nextWatermarkAt: previousAt,
        consecutiveStale: input.consecutiveStale,
        shouldOpenIncident: false,
      };
    }
  }

  const consecutive = input.consecutiveStale + 1;
  return {
    status: "stale",
    nextWatermark: compared.watermark,
    nextWatermarkAt: previousAt,
    consecutiveStale: consecutive,
    shouldOpenIncident: consecutive >= Math.max(1, input.breachThreshold),
  };
}
