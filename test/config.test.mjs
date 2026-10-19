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
    metrics: { "peak rss": { label: "Peak RSS", direction: "lower", unit: "MiB" } },
    dimensions: { document: { label: "Document", order: 1 } },
    colorBy: "document",
    ignoreEnvironment: ["rustc"],
    smoothing: 5,
  });
  assert.deepEqual(config.problems, []);
  assert.equal(config.title, "Compile cost");
  assert.equal(config.threshold, 0.1);

  const settings = suiteSettings(config, "main");
  assert.equal(settings.names.exec("okta cpu").groups.document, "okta");
  assert.deepEqual(settings.metrics.get("peak rss"), { label: "Peak RSS", direction: "lower", unit: "MiB" });
  assert.equal(settings.dimensions.get("document").order, 1);
  assert.deepEqual([...settings.ignoreEnvironment], ["rustc"]);
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
    metrics: { "peak rss": { direction: "down", color: "red" }, cpu: "fast" },
    dimensions: { document: { order: "first" } },
    smoothing: 7,
    colour: "document",
  });
  assert.deepEqual(messages(config), [
    "The setting `threshold` must be a number of at least 0.",
    "The setting `names` is not a valid regular expression: Invalid regular expression: /(?<broken/: Invalid capture group name.",
    'The setting `metrics["peak rss"].direction` must be "lower" or "higher".',
    'The setting `metrics["peak rss"].color` is not a metric setting.',
    "The setting `metrics.cpu` must be an object.",
    "The setting `dimensions.document.order` must be a number.",
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
  // Metric entries merge by key, so a suite's entry replaces the top-level one with the same id.
  assert.deepEqual(own.metrics.get("cpu"), { direction: "lower" });
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
