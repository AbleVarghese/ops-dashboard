#!/usr/bin/env node
// M9 FIRST-SCREEN + M3 VISUAL CLARITY evidence: screenshots every tab at every required
// viewport/theme combination to a PREDICTABLE path so a reviewer (or CI) can diff them run to run.
//
// HONEST EXCEPTION TO THE PROJECT'S ZERO-NPM-DEPS RULE: this script needs a real browser engine
// (Playwright/Chromium) to render the page and take pixel screenshots — that is not something
// Node's built-ins can do, and it is NOT a product dependency (server.mjs/lib/*.mjs ship zero
// deps, always) — it's VERIFICATION TOOLING only, same category as a CI's own test runner. Point
// PLAYWRIGHT_REQUIRE_PATH at any local checkout that already has `playwright` in node_modules
// (this repo intentionally does not vendor one); see verify/README.md for the reasoning and how
// to get one for free if you don't already have a project with it installed.
//
// Usage:  PLAYWRIGHT_REQUIRE_PATH=/path/to/some/repo node verify/screenshots.mjs [--tabs a,b,c]
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";

const DASH_URL = process.env.DASH_URL || "http://127.0.0.1:4650";
const OUT_DIR = path.join(import.meta.dirname, "screenshots");
const requireFrom = process.env.PLAYWRIGHT_REQUIRE_PATH || process.cwd();
const require = createRequire(path.join(path.resolve(requireFrom), "package.json"));

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (err) {
  console.error(
    "[verify/screenshots] Could not load `playwright` from",
    requireFrom,
    "\nSet PLAYWRIGHT_REQUIRE_PATH to a directory whose node_modules has playwright installed" +
      " (e.g. any other local project that already uses it), or `npm install --no-save playwright`" +
      " in a scratch dir and point there. This is verification tooling only — never a product dep."
  );
  process.exit(1);
}

const ALL_TABS = ["overview", "lanes", "feed", "agents", "kanban", "tests", "git", "control", "settings"];
const TABS = process.argv.includes("--tabs")
  ? process.argv[process.argv.indexOf("--tabs") + 1].split(",")
  : ALL_TABS;
const VIEWPORTS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "390", width: 390, height: 844 },
];
const THEMES = ["dark", "light"];

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();
  const manifest = { targetUrl: DASH_URL, ranAt: new Date().toISOString(), shots: [] };

  for (const theme of THEMES) {
    for (const vp of VIEWPORTS) {
      const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
      const consoleErrors = [];
      page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
      page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

      await page.goto(DASH_URL, { waitUntil: "domcontentloaded" });
      if (theme === "light") await page.evaluate(() => localStorage.setItem("opsDashTheme", "light"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .waitForFunction(
          () => document.getElementById("narrativeText")?.textContent && !/Loading live state/.test(document.getElementById("narrativeText").textContent),
          { timeout: 15000 }
        )
        .catch(() => {});

      for (const tab of TABS) {
        await page.click(`button[data-tab="${tab}"]`);
        await page.waitForTimeout(400);
        const hScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        const overflowPx = await page.evaluate(() => document.documentElement.scrollHeight - document.documentElement.clientHeight);
        const filename = `${tab}-${vp.name}-${theme}.png`;
        await page.screenshot({ path: path.join(OUT_DIR, filename) });
        manifest.shots.push({ tab, viewport: vp.name, theme, file: `screenshots/${filename}`, hScroll, overflowPx: tab === "overview" && vp.name === "1440" ? overflowPx : undefined, consoleErrorsSoFar: consoleErrors.length });
      }
      await page.close();
    }
  }
  await browser.close();

  fs.writeFileSync(path.join(import.meta.dirname, "results", "screenshots-manifest.json"), JSON.stringify(manifest, null, 2));
  const bad = manifest.shots.filter((s) => s.hScroll || s.consoleErrorsSoFar > 0);
  console.log(`[verify/screenshots] wrote ${manifest.shots.length} screenshots to ${OUT_DIR}`);
  console.log(bad.length ? `ISSUES: ${JSON.stringify(bad, null, 2)}` : "PASS — zero horizontal scroll, zero console errors across every tab/viewport/theme.");
  process.exit(bad.length ? 1 : 0);
}

main().catch((err) => {
  console.error("[verify/screenshots] ERROR:", err.message);
  process.exit(1);
});
