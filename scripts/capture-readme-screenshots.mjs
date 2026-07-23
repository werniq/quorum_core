import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

const previewDir = path.join("docs", "verification", "ui-preview");
const outDir = path.join("docs", "screenshots");
const shots = [
  {
    file: "catalog.html",
    name: "contract-catalog.png",
    width: 1280,
    height: 900,
    fullPage: true,
  },
  {
    file: "contract-detail.html",
    name: "contract-detail.png",
    width: 1280,
    height: 1600,
    fullPage: true,
  },
  {
    file: "incidents.html",
    name: "incidents.png",
    width: 1280,
    height: 1200,
    fullPage: true,
  },
  {
    file: "onboarding-method.html",
    name: "onboarding-method.png",
    width: 1280,
    height: 820,
    fullPage: false,
  },
];

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();

for (const shot of shots) {
  const filePath = path.join(previewDir, shot.file);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing preview: ${filePath}`);
  }
  await page.setViewportSize({ width: shot.width, height: shot.height });
  await page.goto(pathToFileURL(path.resolve(filePath)).href, {
    waitUntil: "networkidle",
  });
  await page.screenshot({
    path: path.join(outDir, shot.name),
    fullPage: shot.fullPage ?? true,
  });
  console.log(`Wrote ${path.join(outDir, shot.name)}`);
}

await browser.close();
