import type { Clock } from "../../domain/clock.js";

/** Infrastructure adapter for wall-clock time. Domain code must inject Clock. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
