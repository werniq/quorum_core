/**
 * Render the Healthy → Missing → Incident → Recovered composition.
 *
 * Usage: node scripts/render-lifecycle-screenshot.mjs
 * Output: docs/screenshots/lifecycle.png
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const root = process.cwd();
const htmlPath = path.join(root, "docs", "demo", "lifecycle.html");
const outDir = path.join(root, "docs", "screenshots");
const outPath = path.join(outDir, "lifecycle.png");

if (!fs.existsSync(htmlPath)) {
  throw new Error(`Missing ${htmlPath}`);
}

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 2,
});

await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
await page.waitForTimeout(600);
await page.screenshot({ path: outPath, type: "png", fullPage: false });
await browser.close();

console.log(`Wrote ${path.relative(root, outPath)}`);
