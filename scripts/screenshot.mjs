// Captures the sample dashboard or an installed site, in light and dark.
//
// Usage: node scripts/screenshot.mjs [--root DIR --path PATH] [--out DIR] [--full-page]
//
// By default it needs `sample/data.js` (`task samples`); --root serves an installed dashboard.
// It needs Playwright's Chromium (`task screenshot:setup`).
// The page loads ECharts from its CDN, so the capture also needs network access.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { serve } from "./serve.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    path: { type: "string" },
    out: { type: "string" },
    "full-page": { type: "boolean", default: false },
  },
});
const OUT = values.out ? resolve(values.out) : join(ROOT, "docs");
const VIEWPORT = { width: 1440, height: 900 };
// The sample history is a script of about 40 MB, which the page parses before it renders anything.
const LOAD_TIMEOUT = 180_000;
// Charts draw once the web font is ready, and charts below the fold catch up after a short delay,
// so the capture waits for both.
const SETTLE = 1_500;

/** @type {{ colorScheme: "light" | "dark", file: string }[]} */
const SHOTS = [
  { colorScheme: "light", file: "hero.png" },
  { colorScheme: "dark", file: "hero-dark.png" },
];

if (!values.root && !existsSync(join(ROOT, "sample", "data.js"))) {
  console.error("sample/data.js is missing; run `task samples` first.");
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const server = await serve({ root: values.root ? resolve(values.root) : ROOT });
const browser = await chromium.launch();
try {
  for (const shot of SHOTS) {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: shot.colorScheme });
    const page = await context.newPage();
    // The page reports a failed chart update on screen and in the console, without throwing.
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    // The default capture opens the changes list to lead with regressions and improvements.
    await page.goto(new URL(values.path ?? "site/?data=../sample/data.js&changes=open", server.url).href, {
      waitUntil: "load",
      timeout: LOAD_TIMEOUT,
    });

    // The page either draws its charts or movers table, or reports why it could not.
    await page.waitForSelector("#charts .chart svg, #charts .movers-table, #problem:not([hidden]), #failure:not([hidden])", {
      state: "attached",
      timeout: LOAD_TIMEOUT,
    });
    await page.waitForTimeout(SETTLE);

    // Failures are checked after the settling delay, so one from a late update still stops the
    // capture.
    for (const notice of ["#problem", "#failure"]) {
      if (await page.locator(`${notice}:not([hidden])`).count()) throw new Error(`the page reported a problem: ${await page.locator(notice).innerText()}`);
    }
    if (errors.length > 0) throw new Error(`the page reported errors: ${errors.join("; ")}`);
    const path = join(OUT, shot.file);
    await page.screenshot({ path, fullPage: values["full-page"] });
    console.log(`wrote ${path}`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
