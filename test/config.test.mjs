// Checks how `benchtrail.json` reads into the page's settings: values that hold are kept, and each
// one that breaks a rule is left out and reported with its path.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig, suiteSettings } from "../site/benchtrail/core/config.js";

const messages = (config) => config.problems.map((problem) => problem.message);

test("settings that hold are kept as given", () => {
  const config = readConfig({
    title: "Compile cost",
    threshold: 0.1,
    names: "^(?<document>[^.]+) (?<metric>.+)$",
    metrics: {
      "peak rss": { label: "Peak RSS", direction: "lower", unit: "MiB" },
      instructions: { order: -1, splitEnvironment: [], ignoreEnvironment: ["cpu"] },
    },
    dimensions: { document: { label: "Document", order: 1 } },
    colorBy: "document",
    lineLabel: "{{document}}",
    ignoreEnvironment: ["rustc"],
    splitEnvironment: ["cpu"],
    smoothing: 5,
  });
  assert.deepEqual(config.problems, []);
  assert.equal(config.title, "Compile cost");
  assert.equal(config.threshold, 0.1);

  const settings = suiteSettings(config, "main");
  assert.equal(settings.names.exec("okta cpu").groups.document, "okta");
  assert.deepEqual(settings.metrics.get("peak rss"), { label: "Peak RSS", direction: "lower", unit: "MiB" });
  assert.deepEqual(settings.metrics.get("instructions"), { order: -1, splitEnvironment: [], ignoreEnvironment: ["cpu"] });
  assert.equal(settings.dimensions.get("document").order, 1);
  assert.deepEqual([...settings.ignoreEnvironment], ["rustc"]);
  assert.equal(settings.lineLabel, "{{document}}");
  assert.deepEqual([...settings.splitEnvironment], ["cpu"]);
  assert.equal(settings.smoothing, 5);
});

test("no settings read as the defaults", () => {
  const settings = suiteSettings(readConfig({}), "main");
  assert.equal(readConfig({}).threshold, 0.05);
  assert.equal(settings.names, null);
  assert.equal(settings.smoothing, 0);
  assert.deepEqual(settings.problems, []);
});

test("a value that breaks a rule is left out and reported by its path", () => {
  const config = readConfig({
    threshold: -1,
    names: "(?<broken",
    metrics: { "peak rss": { direction: "down", color: "red", order: "first", splitEnvironment: "cpu" }, cpu: "fast" },
    dimensions: { document: { order: "first" } },
    splitEnvironment: "cpu",
    smoothing: 7,
    colour: "document",
  });
  assert.deepEqual(messages(config), [
    "The setting `threshold` must be a number of at least 0.",
    "The setting `names` is not a valid regular expression: Invalid regular expression: /(?<broken/: Invalid capture group name.",
    'The setting `metrics["peak rss"].direction` must be "lower" or "higher".',
    'The setting `metrics["peak rss"].color` is not a metric setting.',
    'The setting `metrics["peak rss"].order` must be a number.',
    'The setting `metrics["peak rss"].splitEnvironment` must be a list of environment names.',
    "The setting `metrics.cpu` must be an object.",
    "The setting `dimensions.document.order` must be a number.",
    "The setting `splitEnvironment` must be a list of environment names.",
    "The setting `smoothing` must be one of 0, 5, 11, 21.",
    "The setting `colour` is not a setting.",
  ]);

  // The values that broke a rule fall back to their defaults, and the others stay.
  const settings = suiteSettings(config, "main");
  assert.equal(config.threshold, 0.05);
  assert.equal(settings.names, null);
  assert.deepEqual(settings.metrics.get("peak rss"), {});
  assert.equal(settings.metrics.has("cpu"), false);
  assert.equal(settings.smoothing, 0);
});

test("settings that are not an object are reported, and the defaults apply", () => {
  for (const raw of [null, [], "names", 3]) assert.deepEqual(messages(readConfig(raw)), ["The settings must be a JSON object."]);
});

test("a suite's own settings override the top-level ones, and its problems stay with it", () => {
  const config = readConfig({
    label: "{{document}}",
    metrics: { cpu: { label: "CPU time" }, rss: { label: "RSS" } },
    suites: { "Compile cost": { label: "{{strategy}}", metrics: { cpu: { direction: "lower" } }, threshold: 0.2, smoothing: 4 } },
  });
  const own = suiteSettings(config, "Compile cost");
  const other = suiteSettings(config, "Throughput");
  assert.equal(own.label, "{{strategy}}");
  assert.equal(other.label, "{{document}}");
  // A suite's metric entry overrides the top-level one field by field.
  assert.deepEqual(own.metrics.get("cpu"), { label: "CPU time", direction: "lower" });
  assert.deepEqual(own.metrics.get("rss"), { label: "RSS" });

  // A setting of the whole page cannot be set per suite, and a suite's problems are its own.
  assert.deepEqual(own.problems, [
    'The setting `suites["Compile cost"].threshold` applies to the whole page, so it belongs at the top level.',
    'The setting `suites["Compile cost"].smoothing` must be one of 0, 5, 11, 21.',
  ]);
  assert.deepEqual(other.problems, []);
});

test("suite and metric names never reach inherited object properties", () => {
  const config = readConfig({ suites: {} });
  const settings = suiteSettings(config, "constructor");
  assert.equal(settings.label, null);
  assert.equal(settings.metrics.get("constructor"), undefined);
});

test("a suite's value that breaks a rule leaves the top-level value in force", () => {
  const config = readConfig({
    metrics: { cpu: { direction: "higher" } },
    dimensions: { doc: { order: 1 } },
    suites: { main: { metrics: { cpu: { direction: "down" } }, dimensions: { doc: { order: "first" } } }, other: null },
  });
  const settings = suiteSettings(config, "main");
  assert.deepEqual(settings.metrics.get("cpu"), { direction: "higher" });
  assert.deepEqual(settings.dimensions.get("doc"), { order: 1 });
  // A suite whose settings are not an object reports to itself alone.
  assert.deepEqual(suiteSettings(config, "other").problems, ["The setting `suites.other` must be an object."]);
  assert.equal(settings.problems.length, 2);
});

test("links lead to the page's own site or to http(s) addresses", () => {
  const config = readConfig({
    links: [
      { label: "Documentation", url: "../" },
      { label: "Repository", url: "https://github.com/romnn/benchtrail" },
      { label: "Script", url: "javascript:alert(1)" },
      { label: "Mail", url: "mailto:a@b.c", target: "_blank" },
      "Home",
    ],
  });
  assert.deepEqual(config.links, [
    { label: "Documentation", url: "../" },
    { label: "Repository", url: "https://github.com/romnn/benchtrail" },
  ]);
  assert.deepEqual(messages(config), [
    "The setting `links[2].url` must be a relative address or an http(s) one.",
    "The setting `links[3].target` is not a link setting.",
    "The setting `links[3].url` must be a relative address or an http(s) one.",
    'The setting `links[4]` must be an object with a "label" and a "url".',
  ]);
  // Links belong to the page, so a suite cannot set its own.
  assert.match(messages(readConfig({ suites: { main: { links: [] } } }))[0], /applies to the whole page/);
});
