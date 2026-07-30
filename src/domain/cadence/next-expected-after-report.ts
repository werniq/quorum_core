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
  return evaluation.expectedAt;
}
