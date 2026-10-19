// Runs the sample generators and checks that what they write is a history the page can load.
// Each generator runs from a copy in a temporary directory, because it writes next to itself and the
// checked-out samples belong to whoever is previewing the page.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const SAMPLE = fileURLToPath(new URL("../sample/", import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "benchtrail-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

// Runs `script` from a fresh copy and returns the text it wrote to `output`.
function generate(script, output) {
  const dir = mkdtempSync(join(scratch, "run-"));
  copyFileSync(join(SAMPLE, script), join(dir, script));
  execFileSync(process.execPath, [join(dir, script)], { stdio: "pipe" });
  return readFileSync(join(dir, output), "utf8");
}

// Evaluates a history script the way the page does: as a script that assigns `window.BENCHMARK_DATA`.
function load(source) {
  const window = {};
  runInNewContext(source, { window });
  return window.BENCHMARK_DATA;
}

// Checks the layout github-action-benchmark commits, which the page reads before anything typed.
function assertHistory(data) {
  assert.equal(typeof data, "object");
  assert.equal(typeof data.lastUpdate, "number");
  assert.equal(typeof data.repoUrl, "string");
  const suites = Object.entries(data.entries);
  assert.ok(suites.length > 0, "the history has no suites");
  for (const [suite, runs] of suites) {
    assert.ok(Array.isArray(runs) && runs.length > 0, `${suite} has no runs`);
    for (const run of runs) {
      assert.equal(typeof run.commit.id, "string", `${suite}: a run has no commit id`);
      assert.ok(!Number.isNaN(Date.parse(run.commit.timestamp)), `${suite}: ${run.commit.id} has no valid timestamp`);
      assert.equal(typeof run.date, "number");
      assert.equal(typeof run.tool, "string");
      assert.ok(Array.isArray(run.benches), `${suite}: ${run.commit.id} has no benches`);
      for (const bench of run.benches) {
        assert.equal(typeof bench.name, "string");
        assert.equal(typeof bench.unit, "string");
        if (bench.extra !== undefined) assert.equal(typeof bench.extra, "string", `${suite}: ${bench.name} has a non-string extra`);
      }
    }
  }
}

describe("sample/generate.mjs", () => {
  const source = generate("generate.mjs", "data.js");
  const data = load(source);

  test("writes a loadable history", () => {
    assertHistory(data);
  });

  // The script documents its output as deterministic, so regenerating the sample never shows a diff
  // unless the script changed.
  test("writes the same history every time", () => {
    assert.equal(generate("generate.mjs", "data.js"), source);
  });

  // Every value is a real measurement and every typed payload is valid, so the page reports no
  // problems for the main sample; the irregular cases live in sample/edge-cases.mjs.
  test("records only valid values and typed payloads", () => {
    for (const runs of Object.values(data.entries)) {
      for (const run of runs) {
        for (const bench of run.benches) {
          assert.ok(Number.isFinite(bench.value), `${bench.name} has value ${bench.value}`);
          if (bench.extra === undefined || !bench.extra.startsWith("{")) continue;
          const payload = JSON.parse(bench.extra).benchtrail;
          if (payload === undefined) continue;
          assert.equal(payload.version, 1, `${bench.name}: unsupported version`);
          assert.equal(typeof payload.metric?.id, "string", `${bench.name}: no metric id`);
          assert.notEqual(payload.metric.id, "", `${bench.name}: empty metric id`);
          for (const tags of [payload.dimensions ?? {}, payload.environment ?? {}]) {
            for (const [key, value] of Object.entries(tags)) {
              const scalar = typeof value === "string" || typeof value === "boolean" || Number.isFinite(value);
              assert.ok(scalar, `${bench.name}: ${key} is not a string, finite number, or boolean`);
            }
          }
        }
      }
    }
  });
});

describe("sample/edge-cases.mjs", () => {
  test("writes a loadable history", () => {
    assertHistory(load(generate("edge-cases.mjs", "edge-cases.js")));
  });
});
