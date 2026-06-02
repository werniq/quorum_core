/**
 * Coordinates graceful process shutdown under load:
 * - stops accepting new timer work once shutdown begins
 * - awaits tracked in-flight work up to a bounded grace period
 * - then runs close hooks; if grace is exceeded, documents forced exit
 */

export type GracefulShutdownResult = "completed" | "forced";

export interface GracefulShutdownController {
  isShuttingDown(): boolean;
  /** Track an in-flight async unit of work (watcher/outbox/poll). */
  track<T>(work: Promise<T>): Promise<T>;
  /**
   * Begin shutdown: stop accepting, await in-flight (bounded), then close.
   * When grace is exceeded, invokes forceExit after close (best-effort).
   */
  shutdown(hooks: {
    signal?: string;
    stopAccepting: () => void;
    close: () => Promise<void>;
  }): Promise<GracefulShutdownResult>;
}

export function createGracefulShutdownController(options?: {
  graceMs?: number;
  forceExit?: (code: number) => void;
  log?: (message: string, meta?: Record<string, unknown>) => void;
  sleep?: (ms: number) => Promise<void>;
}): GracefulShutdownController {
  const graceMs = options?.graceMs ?? 10_000;
  const forceExit =
    options?.forceExit ?? ((code: number) => process.exit(code));
  const log =
    options?.log ??
    ((message: string, meta?: Record<string, unknown>) => {
      if (meta) {
        console.info(message, meta);
      } else {
        console.info(message);
      }
    });
  const sleep =
    options?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let shuttingDown = false;
  const inFlight = new Set<Promise<unknown>>();

  return {
    isShuttingDown(): boolean {
      return shuttingDown;
    },

    track<T>(work: Promise<T>): Promise<T> {
      inFlight.add(work);
      void work.finally(() => {
        inFlight.delete(work);
      });
      return work;
    },

    async shutdown(hooks): Promise<GracefulShutdownResult> {
      if (shuttingDown) {
        return "completed";
      }
      shuttingDown = true;
      if (hooks.signal) {
        log(`Received ${hooks.signal}; shutting down gracefully`, {
          graceMs,
          inFlight: inFlight.size,
        });
      } else {
        log("Shutting down gracefully", { graceMs, inFlight: inFlight.size });
      }

      hooks.stopAccepting();

      const pending = [...inFlight];
      let result: GracefulShutdownResult = "completed";
      if (pending.length > 0) {
        const settled = Promise.allSettled(pending).then(
          () => "completed" as const,
        );
        const timedOut = sleep(graceMs).then(() => "forced" as const);
        result = await Promise.race([settled, timedOut]);
        if (result === "forced") {
          log(
            "Shutdown grace exceeded; forcing exit after close (in-flight work may be interrupted)",
            { graceMs, remainingInFlight: inFlight.size },
          );
        }
      }

      try {
        await hooks.close();
      } catch (error) {
        log("shutdown_close_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if (result === "forced") {
        forceExit(1);
      }
      return result;
    },
  };
}
