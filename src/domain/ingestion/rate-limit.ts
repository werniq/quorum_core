export interface RateLimitPolicy {
  acceptedPerMinute: number;
  burstAllowance: number;
  sustainedRejectionWarningThreshold: number;
  tenantAcceptedPerMinute: number | null;
  globalAcceptedPerMinute: number | null;
}

export interface RateLimitDecision {
  allowed: boolean;
  acceptedCount: number;
  rejectedCount: number;
  windowStartedAt: Date;
  sustainedRejections: boolean;
}

/**
 * Sliding fixed-window limiter for one workflow credential.
 * Cap per window = acceptedPerMinute + burstAllowance.
 */
export function evaluateCredentialRateLimit(input: {
  now: Date;
  windowStartedAt: Date | null;
  acceptedCount: number;
  rejectedCount: number;
  policy: RateLimitPolicy;
  accepting: boolean;
}): RateLimitDecision {
  const windowMs = 60_000;
  let windowStartedAt = input.windowStartedAt;
  let acceptedCount = input.acceptedCount;
  let rejectedCount = input.rejectedCount;

  if (
    windowStartedAt === null ||
    input.now.getTime() - windowStartedAt.getTime() >= windowMs
  ) {
    windowStartedAt = input.now;
    acceptedCount = 0;
    rejectedCount = 0;
  }

  const cap = input.policy.acceptedPerMinute + input.policy.burstAllowance;
  if (input.accepting) {
    if (acceptedCount >= cap) {
      rejectedCount += 1;
      return {
        allowed: false,
        acceptedCount,
        rejectedCount,
        windowStartedAt,
        sustainedRejections:
          rejectedCount >= input.policy.sustainedRejectionWarningThreshold,
      };
    }
    acceptedCount += 1;
    return {
      allowed: true,
      acceptedCount,
      rejectedCount,
      windowStartedAt,
      sustainedRejections: false,
    };
  }

  rejectedCount += 1;
  return {
    allowed: false,
    acceptedCount,
    rejectedCount,
    windowStartedAt,
    sustainedRejections:
      rejectedCount >= input.policy.sustainedRejectionWarningThreshold,
  };
}

/** Process-local emergency caps for SaaS (isolated from other tenants). */
export class EmergencyRateLimitTracker {
  private readonly tenantCounts = new Map<
    string,
    { windowStart: number; count: number }
  >();
  private global = { windowStart: 0, count: 0 };

  constructor(private readonly windowMs = 60_000) {}

  tryConsume(input: {
    tenantId: string;
    tenantLimit: number | null;
    globalLimit: number | null;
    nowMs: number;
  }): boolean {
    if (input.tenantLimit !== null) {
      const entry = this.tenantCounts.get(input.tenantId) ?? {
        windowStart: input.nowMs,
        count: 0,
      };
      if (input.nowMs - entry.windowStart >= this.windowMs) {
        entry.windowStart = input.nowMs;
        entry.count = 0;
      }
      if (entry.count >= input.tenantLimit) {
        this.tenantCounts.set(input.tenantId, entry);
        return false;
      }
      entry.count += 1;
      this.tenantCounts.set(input.tenantId, entry);
    }

    if (input.globalLimit !== null) {
      if (input.nowMs - this.global.windowStart >= this.windowMs) {
        this.global = { windowStart: input.nowMs, count: 0 };
      }
      if (this.global.count >= input.globalLimit) {
        return false;
      }
      this.global.count += 1;
    }

    return true;
  }
}
