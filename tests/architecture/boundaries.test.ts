import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(".");

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

describe("architecture boundaries", () => {
  it("keeps domain free of Fastify, Drizzle, drivers, and system clock adapters", () => {
    const domainRoot = path.join(root, "src", "domain");
    const forbidden =
      /from\s+["'](fastify|drizzle-orm|better-sqlite3|pg|nodemailer)["']|from\s+["'][^"']*\/infrastructure\//;

    const offenders: string[] = [];
    for (const file of walkTsFiles(domainRoot)) {
      const content = fs.readFileSync(file, "utf8");
      if (forbidden.test(content) || /new Date\(\)/.test(content)) {
        offenders.push(path.relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("provides the required layer directories", () => {
    for (const dir of [
      "src/domain",
      "src/application",
      "src/infrastructure",
      "src/presentation",
    ]) {
      expect(fs.existsSync(path.join(root, dir))).toBe(true);
    }
  });

  it("documents architecture and zero-telemetry privacy invariants", () => {
    const privacy = fs.readFileSync(path.join(root, "docs/privacy.md"), "utf8");
    const architecture = fs.readFileSync(
      path.join(root, "docs/architecture.md"),
      "utf8",
    );
    expect(privacy).toContain("We do not need your workflow data.");
    expect(privacy).toContain("no telemetry");
    expect(privacy).toContain("no undeclared outbound");
    expect(privacy).toContain("GET /health/watcher");
    expect(architecture).toContain("Domain");
    expect(architecture).toContain("Presentation");
    expect(architecture).toContain("injected `Clock`");
    expect(architecture).toContain("/health/watcher");
    const operations = fs.readFileSync(
      path.join(root, "docs/operations.md"),
      "utf8",
    );
    expect(operations).toContain("External uptime check");
    expect(operations).toContain("two");
    expect(operations).toContain("never transmits");
    const license = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
    expect(license).toContain("Apache License");
    const limitations = fs.readFileSync(
      path.join(root, "docs/known-limitations.md"),
      "utf8",
    );
    expect(limitations).toContain(
      "do not independently prove destination delivery",
    );
    expect(limitations).toContain("HubSpot webinar registrations");
  });
});
