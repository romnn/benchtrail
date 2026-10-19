// Checks how recorded runs become suites: identity of benchmarks and their values, link ids,
// sections, and the problems reported for invalid entries.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSuite, readSettings, suiteSettings } from "../site/benchtrail/core/history.js";
import { urlText } from "../site/benchtrail/core/identity.js";

// A typed entry as a custom github-action-benchmark tool records it.
function entry(name, value, payload, unit = "s") {
  return { name, value, unit, extra: JSON.stringify({ benchtrail: { version: 1, ...payload } }) };
}

// One recorded run per element of `benches`, each a list of entries.
function suite(benches, config = {}) {
  const runs = benches.map((entries, i) => ({
    commit: { id: `${i}`.padStart(7, "0"), message: `commit ${i}`, timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString() },
    date: Date.UTC(2026, 0, i + 1),
    tool: "customSmallerIsBetter",
    benches: entries,
  }));
  const settings = readSettings(config);
  return buildSuite("test", runs, suiteSettings(settings, "test"), settings.threshold);
}

const traces = (s) => s.sections.flatMap((section) => section.traces);

test("dimension values keep their type, in memory and in links", () => {
  const s = suite([
    [entry("a", 1, { dimensions: { threads: 4 }, metric: { id: "time" } }), entry("b", 2, { dimensions: { threads: "4" }, metric: { id: "time" } })],
  ]);

  // The number 4 and the string "4" are two benchmarks, and their link ids differ.
  assert.equal(traces(s).length, 2);
  assert.deepEqual(
    traces(s)
      .map((t) => t.slug)
      .sort(),
    ["time:threads=4", "time:threads=s%3A4"],
  );

  // A string that could read as another kind of value is prefixed in links; plain strings are not.
  assert.equal(urlText(4), "4");
  assert.equal(urlText("4"), "s:4");
  assert.equal(urlText("true"), "s:true");
  assert.equal(urlText("oxide"), "oxide");
  assert.equal(urlText(undefined), "-");
});

test("a benchmark id keeps one history across changing dimensions, with a trace per value set", () => {
  const run = (threads) => [entry("parse", 1 + threads, { benchmarkId: "parse", dimensions: { threads }, metric: { id: "time" } })];
  const s = suite([run(1), run(1), run(2)]);
  const all = traces(s);

  // Both traces belong to the same history, so detection sees one continuous benchmark.
  assert.equal(all.length, 2);
  assert.equal(all[0].history, all[1].history);
  assert.deepEqual(
    all.map((t) => [...t.own]),
    [[0, 1], [2]],
  );
});

test("link ids escape their separators, so different benchmarks never share one", () => {
  // Without escaping, both would read `time:#a/p=x/p=y`.
  const s = suite([
    [
      entry("one", 1, { benchmarkId: "a/p=x", dimensions: { p: "y" }, metric: { id: "time" } }),
      entry("two", 2, { benchmarkId: "a", dimensions: { p: "x/p=y" }, metric: { id: "time" } }),
    ],
  ]);
  const slugs = traces(s).map((t) => t.slug);
  assert.equal(new Set(slugs).size, 2);
  assert.ok(slugs.includes("time:#a%2Fp%3Dx/p=y"));
});

test("a metric id first seen keeps its plain link id when another unit family appears later", () => {
  const s = suite([
    [entry("a", 1, { metric: { id: "size" } }, "B")],
    [entry("a", 1, { metric: { id: "size" } }, "B"), entry("b", 5, { metric: { id: "size" } }, "ops/s")],
  ]);
  assert.deepEqual([...s.metrics.values()].map((m) => m.slug).sort(), ["size", "size@ops/s"]);
});

test("sections group benchmarks that share dimensions, and keep an id's metrics together", () => {
  const s = suite([
    [
      entry("parse", 1, { dimensions: { input: "small" }, metric: { id: "time" } }),
      entry("emit", 1, { dimensions: { target: "x86" }, metric: { id: "time" } }),
      // One benchmark records two metrics without dimensions, and only one of them gains one.
      entry("build", 1, { benchmarkId: "build", metric: { id: "time" } }),
      entry("build", 9, { benchmarkId: "build", metric: { id: "size" } }, "B"),
    ],
    [
      entry("build", 1, { benchmarkId: "build", dimensions: { threads: 4 }, metric: { id: "time" } }),
      entry("build", 9, { benchmarkId: "build", metric: { id: "size" } }, "B"),
    ],
  ]);
  const labels = s.sections.map((section) => section.label).sort();
  assert.deepEqual(labels, ["Input", "Target", "Threads"]);
  const build = s.sections.find((section) => section.label === "Threads");
  assert.deepEqual(build.metrics.map((m) => m.id).sort(), ["size", "time"]);
});

test("entries that differ only in their environment are reported as duplicates", () => {
  const s = suite([
    [
      entry("multi", 1, { benchmarkId: "multi", metric: { id: "time" }, environment: { os: "linux" } }),
      entry("multi", 2, { benchmarkId: "multi", metric: { id: "time" }, environment: { os: "macos" } }),
    ],
  ]);
  const problems = [...s.problems.keys()];
  assert.equal(problems.length, 1);
  assert.match(problems[0], /record concurrent variants as dimensions/);
});

test("an invalid payload is reported and kept apart from valid histories", () => {
  const s = suite([[entry("future", 1, { version: 2, metric: { id: "time" } }), entry("ok", 1, { metric: { id: "time" } })]]);
  assert.ok([...s.problems.keys()].some((p) => /unsupported version 2/.test(p)));
});

test("an invalid name pattern is reported, and names are read as they are", () => {
  const s = suite([[{ name: "parse small", value: 1, unit: "s" }]], { names: "(?<broken" });
  assert.ok([...s.problems.keys()].some((p) => /name pattern for test is not a valid regular expression/.test(p)));
  assert.equal(traces(s)[0].dims.benchmark, "parse small");
});
