import type { Clock } from "../clock.js";
import { evaluateCadence } from "./evaluate-cadence.js";
import type { CadenceContractFields } from "./evaluate-deadline.js";

/**
 * Next expected occurrence after a report at `lastEvidenceAt`.
 * Used by ingest so catalog deadlines update immediately.
 */
export function nextExpectedAfterReport(input: {
  contract: CadenceContractFields;
  initialGraceMinutes: number;
  isActive: boolean;
  clock: Clock;
}): Date | null {
  const evaluation = evaluateCadence(
    {
      isActive: input.isActive,
      initialGraceMinutes: input.initialGraceMinutes,
      contract: input.contract,
    },
    input.clock,
  );
  // Scheduled contracts expose their next expected occurrence. Event-driven
  // contracts have no predictable occurrence, so the useful "next" value is
  // the quiet-window deadline after the latest accepted report.
  return input.contract.cadenceType === "event_driven"
    ? evaluation.deadlineAt
    : evaluation.expectedAt;
}
