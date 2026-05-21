import type { IncidentStatus } from "../terminology.js";

export class InvalidIncidentTransitionError extends Error {
  constructor(from: IncidentStatus, to: IncidentStatus) {
    super(`Invalid incident transition: ${from} → ${to}`);
    this.name = "InvalidIncidentTransitionError";
  }
}

/**
 * Incidents are stateful: open → acknowledged → resolved.
 * Repeated observations update one incident; they do not create a new lifecycle.
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
