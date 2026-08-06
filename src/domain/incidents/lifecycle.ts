import type { IncidentStatus } from "../terminology.js";

export class InvalidIncidentTransitionError extends Error {
  constructor(from: IncidentStatus, to: IncidentStatus) {
    super(`Invalid incident transition: ${from} → ${to}`);
    this.name = "InvalidIncidentTransitionError";
  }
}

/**
 * Legacy status transitions for resolve paths: open → acknowledged → resolved.
 * Operational recovery uses lifecycleStatus (active → recovered) separately from
 * human acknowledgement (acknowledgmentStatus). Acknowledgement does not imply
 * recovery, and recovery does not require acknowledgement.
 */
export function transitionIncidentStatus(
  current: IncidentStatus,
  next: IncidentStatus,
): IncidentStatus {
  const allowed: Record<IncidentStatus, IncidentStatus[]> = {
    open: ["acknowledged", "resolved"],
    acknowledged: ["resolved"],
    resolved: [],
  };

  if (!allowed[current].includes(next)) {
    throw new InvalidIncidentTransitionError(current, next);
  }
  return next;
}
