/**
 * Product-functionality demo (no pitch slides).
 * Story: Catalog → contract detail → incidents → alerts → workflows → Catalog.
 * Omits Protect / create-workflow onboarding.
 *
 * Usage: node scripts/render-product-demo.mjs
 * Output: docs/demo/quorum-demo.mp4
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const ffmpegPath = require("ffmpeg-static");

const root = process.cwd();
const previewDir = path.join(root, "docs", "verification", "ui-preview");
const demoDir = path.join(root, "docs", "demo");
const videoDir = path.join(demoDir, "_record");

const W = 1440;
const H = 900;

function previewUrl(name) {
  const p = path.join(previewDir, name);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Missing preview ${p}. Run: npx tsx scripts/generate-ui-previews.mjs`,
    );
  }
  return pathToFileURL(path.resolve(p)).href;
}

async function pause(page, ms) {
  await page.waitForTimeout(ms);
}

async function moveClick(page, locator, opts = {}) {
  const el =
    typeof locator === "string"
      ? page.locator(locator).first()
      : locator.first();
  await el.waitFor({ state: "visible", timeout: 10_000 });
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  if (!box) {
    throw new Error("No bounding box for click target");
  }
  const x = box.x + box.width * (opts.x ?? 0.5);
  const y = box.y + box.height * (opts.y ?? 0.5);
  await page.mouse.move(x, y, { steps: opts.steps ?? 16 });
  await pause(page, opts.dwell ?? 240);
  await page.mouse.down();
  await pause(page, 80);
  await page.mouse.up();
  await pause(page, opts.after ?? 320);
}

async function go(page, file) {
  await page.goto(previewUrl(file), { waitUntil: "networkidle" });
  await pause(page, 650);
}

fs.rmSync(videoDir, { recursive: true, force: true });
fs.mkdirSync(videoDir, { recursive: true });
fs.mkdirSync(demoDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: videoDir, size: { width: W, height: H } },
});
const page = await context.newPage();

// --- Existing estate --------------------------------------------------------
await go(page, "catalog.html");
await pause(page, 1200);
await page.mouse.wheel(0, 360);
await pause(page, 1000);
await page.mouse.wheel(0, 280);
await pause(page, 900);

// Open an existing healthy contract
const existingContract = page
  .locator("a")
  .filter({ hasText: /Lead sync|Order handoff|Claims|dispatch/i })
  .first();
if ((await existingContract.count()) > 0) {
  await moveClick(page, existingContract, { after: 400 });
}
await go(page, "contract-detail.html");
await pause(page, 900);
await page.mouse.wheel(0, 380);
await pause(page, 1000);
await page.mouse.wheel(0, 420);
await pause(page, 1100);

// Incidents already firing
await go(page, "incidents.html");
await pause(page, 1000);
const openIncident = page
  .locator("table tbody tr")
  .filter({ hasText: /Silent absence|Hard failure|open/i })
  .first();
if ((await openIncident.count()) > 0) {
  await moveClick(page, openIncident, { after: 700 });
}
await page.mouse.wheel(0, 260);
await pause(page, 900);

// Alert channel health / config
await go(page, "alerts.html");
await pause(page, 1000);
const testAlert = page
  .locator("button")
  .filter({ hasText: /Send test alert/i })
  .first();
if ((await testAlert.count()) > 0) {
  await moveClick(page, testAlert, { after: 800 });
}
await page.mouse.wheel(0, 200);
await pause(page, 800);

// Existing workflows + binds
await go(page, "workflow-registration.html");
await pause(page, 1100);
await page.mouse.wheel(0, 320);
await pause(page, 1000);

// Close on Catalog (feature tour only — no Protect / create flow)
await go(page, "catalog.html");
await pause(page, 1400);

await context.close();
await browser.close();

const recorded = fs
  .readdirSync(videoDir)
  .filter((f) => f.endsWith(".webm"))
  .map((f) => path.join(videoDir, f))[0];

if (!recorded) {
  throw new Error("Playwright did not produce a .webm recording");
}

const outMp4 = path.join(demoDir, "quorum-demo.mp4");
const args = [
  "-y",
  "-i",
  recorded,
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-pix_fmt",
  "yuv420p",
  "-movflags",
  "+faststart",
  "-an",
  outMp4,
];

console.log("encoding", outMp4);
const result = spawnSync(ffmpegPath, args, { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`Wrote ${outMp4}`);
console.log(`Source recording: ${recorded}`);
