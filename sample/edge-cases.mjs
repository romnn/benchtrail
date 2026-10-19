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

// Typed payloads that are malformed, conflicting, or unusual, each of which the page must report or
// render without merging it into a good history.
const typed = (benchtrail, text) => JSON.stringify({ benchtrail, ...(text ? { text } : {}) });
const typedRuns = runs.map((run, i) => ({
  ...run,
  benches: [
    // `4` and `"4"` are different values, and a value may contain a comma.
    { name: "mix int", value: 1 + i * 0.01, unit: "s", extra: typed({ version: 1, dimensions: { threads: 4, mode: "a,b" }, metric: { id: "time" } }) },
    { name: "mix str", value: 1.2, unit: "s", extra: typed({ version: 1, dimensions: { threads: "4", mode: "c" }, metric: { id: "time" } }) },
    // A dimension holding an array is invalid and must stay apart, shown by name.
    { name: "bad dims", value: 2, unit: "s", extra: typed({ version: 1, dimensions: { threads: [1] }, metric: { id: "time" } }) },
    // An unsupported version is reported, not guessed at.
    { name: "future", value: 3, unit: "s", extra: typed({ version: 2, dimensions: {}, metric: { id: "time" } }) },
    // The same metric declared as higher and lower is better leaves its verdicts unknown.
    { name: "score", value: 50 + (i % 4), unit: "pts", extra: typed({ version: 1, dimensions: { threads: 4, mode: "c" }, metric: { id: "score", direction: i < 12 ? "higher" : "lower" } }) },
    // Text that only looks like JSON stays plain text.
    { name: "text", value: 0.5, unit: "s", extra: "{not json, rustc 1.99" },
    // Recorded twice in one run: the first value counts and the duplicate is reported.
    ...(i === 9 ? [{ name: "mix int", value: 99, unit: "s", extra: typed({ version: 1, dimensions: { threads: 4, mode: "a,b" }, metric: { id: "time" } }) }] : []),
  ],
}));

const data = {
  lastUpdate: start + 24 * 3_600_000,
  repoUrl: REPO,
  entries: {
    "Edge cases": runs,
    "Typed edge cases": typedRuns,
    "One run": [runs[0]],
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), "edge-cases.js");
writeFileSync(out, `window.BENCHMARK_DATA = ${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${out}`);
