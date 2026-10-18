// Writes `sample/edge-cases.js`: a small history full of the irregular data real projects produce,
// for checking that the page handles each case.
//
// Usage: node sample/edge-cases.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "https://github.com/benchtrail/sample";
const start = Date.UTC(2026, 8, 1, 12);
const sha = (n) => n.toString(16).padStart(8, "0").repeat(5);

const runs = [];
for (let i = 0; i < 24; i += 1) {
  // Run 12 re-runs the commit of run 11, as a retried workflow does.
  const id = sha(i === 12 ? 11 : i);
  const benches = [
    // The unit switches from seconds to milliseconds at run 8; the value does not change.
    { name: "build total", value: i < 8 ? 2.5 : 2500, unit: i < 8 ? "s" : "ms" },
    // Missing, null, and empty values must show as gaps, not zeros.
    { name: "build link", value: i === 5 ? null : i === 6 ? "" : 0.8 + (i % 3) * 0.01, unit: "s" },
    { name: "build size", value: 48_000_000 + i * 10_000, unit: "B" },
  ];
  // A benchmark added mid-history.
  if (i >= 15) benches.push({ name: "build incremental", value: 0.3, unit: "s" });
  // A metric that changes unit family, which must start a separate history.
  benches.push({ name: "throughput docs", value: i < 18 ? 120 : 0.12, unit: i < 18 ? "ops/s" : "ms" });
  runs.push({
    commit: {
      author: { name: "Sam Rivera", username: "samrivera" },
      id,
      message: i === 3 ? `fix: ${"a very long subject that keeps going ".repeat(4)}(#${i})` : `chore: change ${i} (#${i})`,
      timestamp: new Date(start + i * 3_600_000).toISOString(),
      url: `${REPO}/commit/${id}`,
    },
    date: start + i * 3_600_000,
    tool: "customSmallerIsBetter",
    benches,
  });
}

const data = {
  lastUpdate: start + 24 * 3_600_000,
  repoUrl: REPO,
  entries: {
    "Edge cases": runs,
    "One run": [runs[0]],
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), "edge-cases.js");
writeFileSync(out, `window.BENCHMARK_DATA = ${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${out}`);
