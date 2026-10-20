// Checks the one-off cleanup of a recorded history: merging a suite into another by commit, dropping
// a suite, and reading and writing github-action-benchmark's layout unchanged.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applySteps, formatHistory, parseHistory, readSteps } from "../scripts/suites.mjs";

const run = (/** @type {string} */ id, /** @type {number} */ date, /** @type {string[]} */ names) => ({
  commit: { id, message: id },
  date,
  tool: "customSmallerIsBetter",
  benches: names.map((name) => ({ name, unit: "s", value: 1 })),
});

const HISTORY = {
  lastUpdate: 5,
  repoUrl: "https://github.com/o/r",
  entries: {
    main: [run("a", 1, ["cpu"]), run("b", 3, ["cpu"]), run("b", 4, ["cpu"])],
    counts: [run("b", 4, ["count"]), run("c", 2, ["count"])],
    old: [run("a", 1, ["x"])],
  },
};

test("a merge appends a suite's entries to the runs of the same commits, and drops it", () => {
  const merged = applySteps(HISTORY, readSteps(["--merge", "counts=main", "--drop", "old"]));
  assert.deepEqual(Object.keys(merged.entries), ["main"]);
  // The count of commit b joins b's re-run nearest in time; commit c, which main lacks, is added
  // in date order.
  assert.deepEqual(
    merged.entries.main.map((r) => [r.commit.id, r.date, r.benches.map((b) => b.name)]),
    [
      ["a", 1, ["cpu"]],
      ["c", 2, ["count"]],
      ["b", 3, ["cpu"]],
      ["b", 4, ["cpu", "count"]],
    ],
  );
  // The history given is left as it was.
  assert.equal(HISTORY.entries.main[2].benches.length, 1);
});

test("a step that names a missing suite, or a malformed option, fails before anything is written", () => {
  assert.throws(() => applySteps(HISTORY, readSteps(["--drop", "gone"])), /no suite "gone"/);
  assert.throws(() => applySteps(HISTORY, readSteps(["--merge", "main=main"])), /into itself/);
  assert.throws(() => readSteps(["--merge", "main"]), /FROM=INTO/);
  assert.throws(() => readSteps(["--prune", "x"]), /unknown option/);
  assert.throws(() => readSteps(["--drop"]), /needs a value/);
});

test("a history reads and writes back in github-action-benchmark's layout", () => {
  const text = formatHistory(HISTORY);
  assert.ok(text.startsWith("window.BENCHMARK_DATA = {\n"));
  assert.equal(formatHistory(parseHistory(text)), text);
  assert.throws(() => parseHistory("window.OTHER = {}"), /no benchmark history/);
});
