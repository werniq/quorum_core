/**
 * Self-hosted builds never enqueue telemetry. This module exists so privacy
 * tests can assert the queue stays empty under normal operation.
 */
export type TelemetryEvent = never;

const queue: TelemetryEvent[] = [];

export function enqueueTelemetry(_event: never): void {
  throw new Error("telemetry_forbidden_in_self_hosted");
}

export function getTelemetryQueueLength(): number {
  return queue.length;
}

export function drainTelemetryQueue(): TelemetryEvent[] {
  return queue.splice(0, queue.length);
}
