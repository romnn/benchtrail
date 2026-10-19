// Checks the chart options built from a view: value axis ranges, the change scale, and the trail.

import assert from "node:assert/strict";
import { test } from "node:test";
import { lineOption, trailOption, yRange } from "../site/benchtrail/core/chart-option.js";
import { buildSuite, readSettings, suiteSettings } from "../site/benchtrail/core/history.js";
import { parseLink } from "../site/benchtrail/core/link.js";
import { buildView } from "../site/benchtrail/core/view.js";

const THEME = {
  bg: "#fff",
  ink: "#000",
  ink2: "#333",
  muted: "#666",
  grid: "#eee",
  axis: "#999",
  rule: "#ddd",
  accent: "#07f",
  worse: "#f00",
  better: "#0a0",
  noise: "#ccc",
  font: "sans-serif",
  series: ["#07f", "#f80", "#0aa", "#a5d", "#da0", "#c4a", "#a72", "#48b"],
};

// Twenty runs of one benchmark that regresses by 30% at run 12.
const settings = readSettings({});
const suite = buildSuite(
  "main",
  Array.from({ length: 20 }, (_, i) => ({
    commit: { id: `c${i}`.padEnd(7, "0"), message: `commit ${i}` },
    date: Date.UTC(2026, 0, i + 1),
    benches: [{ name: "parse", value: i >= 12 ? 1.3 : 1, unit: "s" }],
  })),
  suiteSettings(settings, "main"),
  settings.threshold,
);

/**
 * @param {string} query
 * @returns {import("../site/benchtrail/core/chart-option.js").Plot}
 */
function plot(query) {
  const link = parseLink(query);
  const view = buildView([suite], link);
  return {
    view,
    axis: link.axis,
    scale: link.scale,
    smoothing: 0,
    zoom: { start: 0, end: 100 },
    window: () => ({ first: 0, last: view.runs.length - 1 }),
    theme: THEME,
    smoothCache: new Map(),
  };
}

test("a value axis snaps to a round step around the values in the zoom window", () => {
  /** @param {{ min: number | null, max: number | null, interval: number | null }} range */
  const rounded = (range) => [range.min, range.max, range.interval].map((x) => (x === null ? null : Number(x.toFixed(9))));
  // Values from 1 to 1.3 get a step of 0.1, with a little room either side.
  assert.deepEqual(rounded(yRange({ first: 0, last: 2 }, [[1, 1.3, 1.1]], false)), [0.9, 1.4, 0.1]);
  // Only the runs inside the window count; a single value gets a tenth of itself as its span.
  assert.deepEqual(rounded(yRange({ first: 2, last: 2 }, [[1, 1.3, 5]], false)), [4.8, 5.2, 0.2]);
  // A log axis snaps to 1, 2, or 5 times a power of ten.
  assert.deepEqual(yRange({ first: 0, last: 1 }, [[3, 700]], true), { min: 2, max: 1000, interval: null });
  // Without values the chart picks its own range.
  assert.deepEqual(yRange({ first: 0, last: 1 }, [[null, null]], false), { min: null, max: null, interval: null });
});

test("the change scale plots each line relative to its first value in range", () => {
  const { option, unitLabel } = lineOption(plot("?values=change"), suite.sections[0].metrics[0], buildView([suite], parseLink("")).lines, false);
  const series = /** @type {{ data: Array<number | null> }[]} */ (option.series);
  assert.equal(series[0].data[0], 0);
  assert.ok(Math.abs((series[0].data[19] ?? 0) - 30) < 1e-9);
  assert.match(unitLabel, /^% since /);
});

test("the trail stands a bar at each run that shifted, and a tick at every other judged run", () => {
  const option = trailOption(plot(""), 600);
  const [worse, , , ticks] = /** @type {{ data: Array<number | null> }[]} */ (option.series);
  // The regression at run 12 stands one line tall; runs judged without a shift get a short tick.
  assert.equal(worse.data[12], 1);
  assert.equal(worse.data[10], null);
  assert.ok((ticks.data[10] ?? 0) > 0);
  // Runs before a baseline fills, from the start or after the shift, have no judgement.
  assert.equal(ticks.data[3], null);
  assert.equal(ticks.data[14], null);
});
