// Checks how recorded runs become suites: identity of benchmarks and their values, link ids,
// sections, environment names that split benchmarks, and the problems reported for invalid entries.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig, suiteSettings } from "../site/benchtrail/core/config.js";
import { buildSuite, valueText } from "../site/benchtrail/core/history.js";
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
  const settings = readConfig(config);
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
  assert.ok([...s.problems.keys()].some((p) => /The setting `names` is not a valid regular expression/.test(p)));
  assert.equal(traces(s)[0].dims.benchmark, "parse small");
});

// A runner pool of mixed hardware: four runs from before the CPU was recorded, then two CPU models
// in turn, where the first regresses by 30% over its last three runs.
const CPUS = ["AMD EPYC 7763 64-Core Processor", "AMD EPYC 9V74 80-Core Processor"];
function pool(payload = {}) {
  const runs = [];
  for (let i = 0; i < 4; i += 1)
    runs.push([entry("run", 40, { dimensions: { chart: "a" }, metric: { id: "cpu" }, environment: { rustc: "1.99.0" }, ...payload })]);
  for (let i = 0; i < 22; i += 1) {
    const cpu = CPUS[i % 2];
    const value = cpu === CPUS[0] ? (i >= 16 ? 56 : 42 + (i % 4) * 0.1) : 22 + (i % 3) * 0.1;
    runs.push([entry("run", value, { dimensions: { chart: "a" }, metric: { id: "cpu" }, environment: { rustc: "1.99.0", cpu }, ...payload })]);
  }
  return runs;
}
const shiftsOf = (history) => history.shifts.flatMap((shift, i) => (shift ? [[i, shift.kind]] : []));

test("an environment name the settings split by makes one benchmark per value, unknown where unrecorded", () => {
  const s = suite(pool(), { splitEnvironment: ["cpu"], label: "{{chart}} / {{cpu}}" });
  const all = traces(s);

  // The runs from before the CPU was recorded and each CPU model are separate histories.
  assert.equal(all.length, 3);
  assert.equal(new Set(all.map((t) => t.history)).size, 3);
  const byCpu = new Map(all.map((t) => [t.dims.cpu, t]));
  assert.deepEqual([...byCpu.keys()], [undefined, ...CPUS]);

  // The CPU is a dimension now, which leaves the environment, and no value of it reads as unknown.
  const [section] = s.sections;
  const cpu = section.dims.find((d) => d.key === "cpu");
  assert.equal(cpu.environment, true);
  assert.deepEqual(
    cpu.values.map((v) => v.text),
    ["7763 64", "9V74 80", "unknown"],
  );
  assert.equal(valueText(cpu, undefined), "unknown cpu");
  assert.equal(byCpu.get(undefined).label, "a / unknown");
  assert.equal(byCpu.get(CPUS[0]).label, `a / ${CPUS[0]}`);
  assert.deepEqual({ ...byCpu.get(CPUS[0]).history.envAt[4] }, { rustc: "1.99.0" });

  // Each CPU's history is judged on its own, so the regression is found within its series.
  assert.deepEqual(shiftsOf(byCpu.get(CPUS[0]).history), [[20, "worse"]]);
  assert.deepEqual(shiftsOf(byCpu.get(CPUS[1]).history), []);
  assert.deepEqual(shiftsOf(byCpu.get(undefined).history), []);

  // In the environment, the alternating CPU would cut one history into segments too short to judge.
  const unsplit = traces(suite(pool()));
  assert.equal(unsplit.length, 1);
  assert.deepEqual(shiftsOf(unsplit[0].history), []);
});

test("an environment name the settings split by splits a benchmark id too", () => {
  const s = suite(pool({ benchmarkId: "run" }), { splitEnvironment: ["cpu"] });
  assert.equal(new Set(traces(s).map((t) => t.history)).size, 3);
  // A dimension keeps a value the environment also records under its name, and the clash is reported.
  const clash = suite([[entry("run", 1, { dimensions: { cpu: "arm" }, metric: { id: "cpu" }, environment: { cpu: "x86" } })]], { splitEnvironment: ["cpu"] });
  assert.equal(traces(clash)[0].dims.cpu, "arm");
  assert.deepEqual([...clash.problems.keys()], ["run records cpu both as a dimension and in its environment; the dimension is kept."]);
});

test("a metric's own environment lists replace the suite's, and its order places it", () => {
  // Each run records a time that depends on the CPU and a count that does not, from the pool above.
  const runs = pool().map(([time], i) => {
    const { environment } = JSON.parse(time.extra).benchtrail;
    return [time, entry("run", 1000 + (i % 2), { dimensions: { chart: "a" }, metric: { id: "instructions" }, environment }, "count")];
  });
  const s = suite(runs, {
    splitEnvironment: ["cpu"],
    label: "{{chart}} / {{cpu}}",
    metrics: { instructions: { order: 0, splitEnvironment: [], ignoreEnvironment: ["cpu"] } },
  });
  const [section] = s.sections;
  // The count comes first, and is one history across every CPU, judged without a segment break.
  assert.deepEqual(
    section.metrics.map((m) => m.id),
    ["instructions", "cpu"],
  );
  const counts = section.traces.filter((t) => t.history.metric.id === "instructions");
  assert.equal(counts.length, 1);
  assert.equal(counts[0].own.size, 26);
  assert.ok(counts[0].history.segment.every((segment) => segment === 0));
  // The CPU does not apply to it: it is neither unknown nor a value, and its label leaves it out,
  // which leaves no varying dimension, so the label is the benchmark's name.
  assert.deepEqual([...counts[0].inapplicable], ["cpu"]);
  assert.equal(counts[0].label, "run");
  const cpu = section.dims.find((d) => d.key === "cpu");
  assert.deepEqual(
    cpu.values.map((v) => v.text),
    ["7763 64", "9V74 80", "unknown"],
  );
  // The times still split by CPU, with the runs from before it was recorded as unknown.
  assert.equal(section.traces.filter((t) => t.history.metric.id === "cpu").length, 3);
});

test("a split name absent from a metric is inapplicable, while compiler changes still segment it", () => {
  const runs = pool().map(([time], i) => [
    time,
    entry(
      "memory",
      100,
      {
        benchmarkId: "memory",
        dimensions: { chart: "a" },
        metric: { id: "rss" },
        environment: { rustc: i < 13 ? "1.99.0" : "1.100.0" },
      },
      "MiB",
    ),
  ]);
  const s = suite(runs, { splitEnvironment: ["cpu"], label: "{{chart}} ({{cpu}})" });
  const memory = traces(s).filter((t) => t.history.metric.id === "rss");
  assert.equal(memory.length, 1);
  assert.equal(memory[0].own.size, 26);
  assert.deepEqual([...memory[0].inapplicable], ["cpu"]);
  assert.equal(memory[0].label, "memory");
  assert.deepEqual(memory[0].history.segment, [...Array(13).fill(0), ...Array(13).fill(1)]);
  assert.deepEqual(memory[0].history.boundary[13], ["rustc 1.99.0 → 1.100.0"]);
  // Earlier time readings without CPU remain an unknown series alongside the two recorded CPUs.
  assert.equal(traces(s).filter((t) => t.history.metric.id === "cpu").length, 3);
});
