// Checks how runs sit on the x axis and how a zoom window maps to the runs at its ends.

import assert from "node:assert/strict";
import { test } from "node:test";
import { percentOfRun, runAtPercent, runsIn, windowAt, zoomOf } from "../site/benchtrail/core/viewport.js";

const DAY = 86_400_000;

// Five runs from the history's fourth run on, recorded on days 0, 1, 2, 8, and 10, so places by
// run and by date differ.
const RUNS = /** @type {import("../site/benchtrail/core/history.js").Run[]} */ (
  /** @type {unknown} */ ([0, 1, 2, 8, 10].map((day, i) => ({ index: i + 3, key: `r${i}`, date: day * DAY })))
);

test("a run's place on the axis follows its position, or its date", () => {
  assert.equal(percentOfRun(RUNS, 2, "run"), 50);
  assert.equal(percentOfRun(RUNS, 3, "date"), 80);
  // A single run, or runs on one date, sit at the start.
  assert.equal(percentOfRun(RUNS.slice(0, 1), 0, "run"), 0);
  assert.equal(runAtPercent(RUNS, 80, "date").key, "r3");
  assert.equal(runAtPercent(RUNS, 80, "run").key, "r3");
});

test("a zoom window reads as the runs at its ends, and back", () => {
  // The same window names different runs on each axis, so it is read on the axis it was made on.
  assert.deepEqual(windowAt(RUNS, { start: 25, end: 75 }, "run"), { kind: "between", from: "r1", to: "r3" });
  assert.deepEqual(windowAt(RUNS, { start: 25, end: 75 }, "date"), { kind: "between", from: "r2", to: "r3" });
  // A window over the whole axis, or over no runs, is no window.
  assert.deepEqual(windowAt(RUNS, { start: 0, end: 100 }, "run"), { kind: "full" });
  assert.deepEqual(windowAt([], { start: 20, end: 40 }, "run"), { kind: "full" });
  // A link's window maps to the places of its runs, with an end the runs lack left open.
  assert.deepEqual(zoomOf(RUNS, { kind: "between", from: "r1", to: "r3" }, "run"), { start: 25, end: 75 });
  assert.deepEqual(zoomOf(RUNS, { kind: "between", from: "gone", to: "r3" }, "date"), { start: 0, end: 80 });
});

test("the runs in a zoom window are counted from the first run in view", () => {
  assert.deepEqual(runsIn(RUNS, { start: 25, end: 75 }, "run"), { first: 1, last: 3 });
  assert.deepEqual(runsIn(RUNS, { start: 0, end: 100 }, "date"), { first: 0, last: 4 });
});
