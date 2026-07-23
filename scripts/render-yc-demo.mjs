/**
 * YC-style short product demo from title cards + README screenshots.
 * Output: docs/demo/quorum-demo.mp4
 *
 * Usage: node scripts/render-yc-demo.mjs
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
const demoDir = path.join(root, "docs", "demo");
const framesDir = path.join(demoDir, "_frames");
const shotDir = path.join(root, "docs", "screenshots");

const W = 1920;
const H = 1080;

/** @type {{ id: string; seconds: number; kind: "card" | "shot"; html?: string; shot?: string; crop?: "top" | "full" }} */
const beats = [
  {
    id: "01-silent",
    seconds: 3.2,
    kind: "card",
    html: card({
      eyebrow: "The problem",
      title: "n8n workflows fail quietly.",
      sub: "No crash. No page. Just missing work.",
    }),
  },
  {
    id: "02-client",
    seconds: 3.0,
    kind: "card",
    html: card({
      eyebrow: "The cost",
      title: "Your client finds out first.",
      sub: "Silent absence is still a broken promise.",
    }),
  },
  {
    id: "03-quorum",
    seconds: 2.8,
    kind: "card",
    html: card({
      eyebrow: "Quorum",
      title: "A Contract Catalog for n8n.",
      sub: "Expect a cadence. Prove evidence. Alert on absence.",
    }),
  },
  {
    id: "04-catalog",
    seconds: 4.5,
    kind: "shot",
    shot: "contract-catalog.png",
    crop: "top",
  },
  {
    id: "05-connect",
    seconds: 4.0,
    kind: "shot",
    shot: "onboarding-method.png",
    crop: "full",
  },
  {
    id: "06-connect-copy",
    seconds: 2.6,
    kind: "card",
    html: card({
      eyebrow: "Easiest path",
      title: "Connect n8n. No workflow edits.",
      sub: "URL + API key. Quorum polls executions for you.",
    }),
  },
  {
    id: "07-detail",
    seconds: 4.2,
    kind: "shot",
    shot: "contract-detail.png",
    crop: "top",
  },
  {
    id: "08-incidents",
    seconds: 3.8,
    kind: "shot",
    shot: "incidents.png",
    crop: "top",
  },
  {
    id: "09-close",
    seconds: 3.5,
    kind: "card",
    html: card({
      eyebrow: "Self-hosted",
      title: "Quorum",
      sub: "Monitoring that proves the contract — not just the run.",
      end: true,
    }),
  },
];

function card({ eyebrow, title, sub, end = false }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  @import url("https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=IBM+Plex+Sans:wght@400;500&display=swap");
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; }
  body {
    background: #070908;
    color: #f7f7f5;
    font-family: "IBM Plex Sans", system-ui, sans-serif;
    display: grid;
    place-items: center;
    position: relative;
  }
  body::before {
    content: "";
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse 70% 50% at 20% 20%, rgba(13,107,92,0.28), transparent 55%),
      radial-gradient(ellipse 50% 40% at 85% 80%, rgba(13,107,92,0.12), transparent 50%);
  }
  .frame {
    position: relative;
    width: 100%;
    max-width: 1400px;
    padding: 0 120px;
  }
  .eyebrow {
    font-size: 22px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #7dbeaf;
    font-weight: 500;
    margin-bottom: 28px;
  }
  h1 {
    font-family: Syne, sans-serif;
    font-weight: 800;
    font-size: ${end ? 120 : 84}px;
    line-height: 1.02;
    letter-spacing: -0.03em;
    max-width: 16ch;
  }
  .sub {
    margin-top: 28px;
    font-size: 28px;
    line-height: 1.35;
    color: #b7bdb9;
    max-width: 32ch;
    font-weight: 400;
  }
  .mark {
    position: absolute;
    top: 64px;
    left: 80px;
    font-family: Syne, sans-serif;
    font-weight: 700;
    font-size: 22px;
    letter-spacing: 0.04em;
    color: #e8f5f1;
    opacity: 0.9;
  }
</style>
</head>
<body>
  <div class="mark">QUORUM</div>
  <div class="frame">
    <div class="eyebrow">${escapeHtml(eyebrow)}</div>
    <h1>${escapeHtml(title)}</h1>
    <p class="sub">${escapeHtml(sub)}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shotHtml(imgPath, crop) {
  const objectPos =
    crop === "top"
      ? "object-position: top center;"
      : "object-position: center;";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${W}px; height: ${H}px; overflow: hidden; background: #0b0d0c; }
  .stage {
    width: 100%; height: 100%;
    display: grid; place-items: center;
    padding: 48px 64px 56px;
  }
  .chrome {
    width: 100%; height: 100%;
    border-radius: 18px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,0.08);
    box-shadow:
      0 40px 120px rgba(0,0,0,0.55),
      0 0 0 1px rgba(13,107,92,0.15);
    background: #111;
    position: relative;
  }
  .chrome img {
    width: 100%; height: 100%;
    object-fit: cover;
    ${objectPos}
    display: block;
  }
  .label {
    position: absolute; left: 64px; bottom: 22px;
    font-family: system-ui, sans-serif;
    font-size: 14px; letter-spacing: 0.14em; text-transform: uppercase;
    color: rgba(247,247,245,0.45);
  }
</style>
</head>
<body>
  <div class="stage">
    <div class="chrome">
      <img src="${pathToFileURL(imgPath).href}" alt="" />
    </div>
  </div>
  <div class="label">Quorum · Contract Catalog</div>
</body>
</html>`;
}

fs.mkdirSync(framesDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });

const concatLines = [];

for (const beat of beats) {
  const htmlPath = path.join(framesDir, `${beat.id}.html`);
  const pngPath = path.join(framesDir, `${beat.id}.png`);

  if (beat.kind === "card") {
    fs.writeFileSync(htmlPath, beat.html, "utf8");
  } else {
    const shotPath = path.join(shotDir, beat.shot);
    if (!fs.existsSync(shotPath)) {
      throw new Error(`Missing screenshot: ${shotPath}`);
    }
    fs.writeFileSync(htmlPath, shotHtml(shotPath, beat.crop ?? "top"), "utf8");
  }

  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
  // Allow webfonts a moment
  await page.waitForTimeout(400);
  await page.screenshot({ path: pngPath, type: "png" });
  console.log(`frame ${beat.id}`);

  // ffmpeg concat demuxer: file + duration
  const rel = path.resolve(pngPath).replace(/\\/g, "/");
  concatLines.push(`file '${rel}'`);
  concatLines.push(`duration ${beat.seconds}`);
}

// Last image must be listed again without duration for concat demuxer
const lastPng = path
  .resolve(framesDir, `${beats[beats.length - 1].id}.png`)
  .replace(/\\/g, "/");
concatLines.push(`file '${lastPng}'`);

await browser.close();

const listPath = path.join(framesDir, "concat.txt");
fs.writeFileSync(listPath, concatLines.join("\n"), "utf8");

const outMp4 = path.join(demoDir, "quorum-demo.mp4");
const args = [
  "-y",
  "-f",
  "concat",
  "-safe",
  "0",
  "-i",
  listPath,
  "-vf",
  "fps=30,format=yuv420p",
  "-c:v",
  "libx264",
  "-preset",
  "medium",
  "-crf",
  "18",
  "-movflags",
  "+faststart",
  "-pix_fmt",
  "yuv420p",
  outMp4,
];

console.log("encoding", outMp4);
const result = spawnSync(ffmpegPath, args, { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const total = beats.reduce((s, b) => s + b.seconds, 0);
console.log(`Wrote ${outMp4} (~${total.toFixed(1)}s)`);
