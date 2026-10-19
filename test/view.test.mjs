// Checks what a link selects from a suite: lines and their ownership, filters, the pivot, the
// rules that settle a link against the data, and the tallies and movers drawn from the view.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSuite, readSettings, suiteSettings } from "../site/benchtrail/core/history.js";
import { formatLink, parseLink } from "../site/benchtrail/core/link.js";
import { buildView, rankMovers, settle } from "../site/benchtrail/core/view.js";

/**
 * A typed entry as a custom github-action-benchmark tool records it.
 * @param {string} name
 * @param {number | null} value
 * @param {Record<string, unknown>} payload
 */
function entry(name, value, payload) {
  return { name, value, unit: "s", extra: JSON.stringify({ benchtrail: { version: 1, metric: { id: "time" }, ...payload } }) };
}

/**
 * Suites from one list of runs per suite, each run a list of entries.
 * @param {Record<string, unknown[][]>} bySuite
 */
function suites(bySuite) {
  const settings = readSettings({});
  return Object.entries(bySuite).map(([name, runs]) =>
    buildSuite(
      name,
      runs.map((entries, i) => ({ commit: { id: `c${i}`.padEnd(7, "0"), message: `commit ${i}` }, date: Date.UTC(2026, 0, i + 1), benches: entries })),
      suiteSettings(settings, name),
      settings.threshold,
    ),
  );
}

// Twelve runs of two documents, where `b` regresses by 30% from run 8 on.
const DOCS = suites({
  main: Array.from({ length: 12 }, (_, i) => [
    entry("a", 100 + (i % 2), { dimensions: { doc: "a" } }),
    entry("b", i >= 8 ? 130 : 100, { dimensions: { doc: "b" } }),
  ]),
  other: [[entry("x", 1, { dimensions: { os: "linux" } })]],
});

test("a line answers only for the runs its trace owns", () => {
  // One benchmark id whose dimension changes at run 2 becomes two lines of one history.
  const s = suites({ main: [0, 1, 2, 3].map((i) => [entry("p", 10 + i, { benchmarkId: "p", dimensions: { threads: i < 2 ? 1 : 2 } })]) });
  const view = buildView(s, parseLink(""));
  const [one, two] = view.lines;
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => one.value(i)),
    [10, 11, null, null],
  );
  assert.deepEqual(
    [0, 1, 2, 3].map((i) => two.value(i)),
    [null, null, 12, 13],
  );
  // The change into the second trace is not compared across the boundary.
  assert.equal(two.change(2), null);
  assert.deepEqual(two.boundary(2), ["threads 1 → 2"]);
});

test("filters and the range select the lines and runs in view", () => {
  const view = buildView(DOCS, parseLink("?doc=b&runs=30"));
  assert.deepEqual(
    view.lines.map((line) => line.label),
    ["b"],
  );
  assert.equal(view.runs.length, 12);
  // A filter that keeps nothing leaves no lines rather than all of them.
  assert.equal(buildView(DOCS, parseLink("?doc=~")).lines.length, 0);
});

test("the tallies count judged values and collect shifts at their run", () => {
  const view = buildView(DOCS, parseLink(""));
  const step = view.runs[8];
  assert.deepEqual(view.counts(step), { worse: 1, better: 0, moved: 0, measured: 2 });
  assert.deepEqual(
    view.moves(step).map((move) => [move.line.label, move.kind]),
    [["b", "worse"]],
  );
});

test("movers rank a line by its net change within its latest segment", () => {
  const view = buildView(DOCS, parseLink(""));
  const [first, second] = rankMovers(view.lines, view.runs, 0.05);
  assert.equal(first.line.label, "b");
  assert.equal(first.kind, "worse");
  assert.ok(Math.abs((first.net ?? 0) - 0.3) < 1e-9);
  assert.equal(second.kind, "noise");
});

test("settling a link leaves out what follows from the data", () => {
  const settled = (/** @type {string} */ query) => formatLink(settle(DOCS, parseLink(query)));
  // The first suite stays implicit, and an unknown one falls back to it.
  assert.equal(settled("?suite=main"), "");
  assert.equal(settled("?suite=nope"), "");
  assert.equal(settled("?suite=other"), "suite=other");
  // A filter on a dimension the section lacks is dropped; an explicit list stays as written.
  assert.equal(settled("?os=linux&doc=a,b"), "doc=a,b");
  // A run outside the range follows the newest; a window covering the range is dropped.
  assert.equal(settled("?run=nope"), "");
  assert.equal(settled(`?from=${DOCS[0].runs[0].key}&to=${DOCS[0].runs[11].key}`), "");
  assert.equal(settled(`?to=${DOCS[0].runs[5].key}`), `from=${DOCS[0].runs[0].key}&to=${DOCS[0].runs[5].key}`);
  // A color choice the pivot cannot honor is dropped.
  assert.equal(settled("?color=nope"), "");
});
