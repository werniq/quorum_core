import { describe, expect, it, vi } from "vitest";
import { createGracefulShutdownController } from "../../src/infrastructure/runtime/graceful-shutdown.js";
import { createN8nPollScheduler } from "../../src/infrastructure/n8n/run-poll-scheduler.js";
import { FixedClock } from "../../src/domain/clock.js";
import type Database from "better-sqlite3";

describe("graceful shutdown coordination", () => {
  it("stops accepting new tracked work after shutdown begins and completes within grace", async () => {
    let forceExitCode: number | null = null;
    const ctl = createGracefulShutdownController({
      graceMs: 200,
      forceExit: (code) => {
        forceExitCode = code;
      },
      log: () => undefined,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    let ticksStarted = 0;
    const slow = ctl.track(
      new Promise<void>((resolve) => {
        ticksStarted += 1;
        setTimeout(resolve, 50);
      }),
    );

    expect(ctl.isShuttingDown()).toBe(false);

    const shutdownPromise = ctl.shutdown({
      stopAccepting: () => {
        // timer callbacks check isShuttingDown before starting work
      },
      close: async () => {
        // simulated app.close + sqlite.close
      },
    });

    expect(ctl.isShuttingDown()).toBe(true);
    // New work must not be started by timers after shutdown begins.
    if (!ctl.isShuttingDown()) {
      ticksStarted += 1;
    }

    const result = await shutdownPromise;
    await slow;
    expect(result).toBe("completed");
    expect(forceExitCode).toBeNull();
    expect(ticksStarted).toBe(1);
  });

  it("forces exit when in-flight work exceeds grace", async () => {
    let forceExitCode: number | null = null;
    const ctl = createGracefulShutdownController({
      graceMs: 30,
      forceExit: (code) => {
        forceExitCode = code;
      },
      log: () => undefined,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    ctl.track(
      new Promise<void>((resolve) => {
        setTimeout(resolve, 500);
      }),
    );

    const result = await ctl.shutdown({
      stopAccepting: () => undefined,
      close: async () => undefined,
    });
    expect(result).toBe("forced");
    expect(forceExitCode).toBe(1);
  });

  it("pollScheduler.stop prevents further tick work", async () => {
    const runTick = vi.fn(async () => ({
      status: "ok" as const,
      ingested: 0,
      skipped: 0,
    }));
    const scheduler = createN8nPollScheduler({
      sqlite: {
        prepare: () => ({
          all: () => [],
          get: () => undefined,
          run: () => ({ changes: 0 }),
        }),
      } as unknown as Database.Database,
      clock: new FixedClock(new Date("2026-07-19T12:00:00.000Z")),
      claimOwner: "test",
      claimTtlMs: 55_000,
      getSchemaReadiness: () => ({ status: "ready", appliedMigrations: [] }),
      pollWorkflow: runTick as never,
    });

    scheduler.stop();
    const result = await scheduler.runTick();
    expect(result).toEqual({
      considered: 0,
      claimed: 0,
      polled: 0,
      skipped: 0,
      failed: 0,
    });
    expect(runTick).not.toHaveBeenCalled();
  });
});
