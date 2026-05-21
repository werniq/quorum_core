import type { Clock } from "../clock.js";

/**
 * Re-notification follows contract backoff from last_notified_at (or opened_at
 * when never notified). One operational problem stays one incident.
 */
export function shouldEnqueueRenotification(input: {
  lastNotifiedAt: Date | null;
  openedAt: Date;
  backoffMinutes: number;
  clock: Clock;
}): boolean {
  if (input.backoffMinutes <= 0) {
    return false;
  }
  const anchor = input.lastNotifiedAt ?? input.openedAt;
  const dueAt = anchor.getTime() + input.backoffMinutes * 60_000;
  return input.clock.now().getTime() >= dueAt;
}
