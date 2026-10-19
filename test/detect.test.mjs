// Checks change detection on hand-built histories, and bounds its false alarms and misses on
// seeded noise, through the page's own detection module.

import assert from "node:assert/strict";
import { test } from "node:test";
import { detect, median, relative } from "../site/benchtrail/detect.js";

const THRESHOLD = 0.05;

// A history as detection reads it: values per run, the comparison segment of each observed run,
// and which runs observed the benchmark at all.
function history(values, { segment = null, direction = "lower" } = {}) {
  return {
    values,
    segment: segment ?? values.map(() => 0),
    observed: values.map(() => true),
    metric: { direction },
  };
}

function shifts(values, options) {
  const h = history(values, options);
  detect(h, THRESHOLD);
  return h.verdicts.flatMap((verdict, i) => (verdict ? [{ i, ...verdict }] : []));
}

const flat = (n, value = 100) => Array.from({ length: n }, () => value);

test("a step is reported once, at the run that started it, with that run's own change", () => {
  const found = shifts([...flat(12), 130, 131, 129, 130, 130]);
  assert.equal(found.length, 1);
  assert.equal(found[0].i, 12);
  assert.equal(found[0].kind, "worse");
  assert.equal(found[0].tentative, false);
  assert.ok(Math.abs(found[0].shift - 0.3) < 1e-9);
});

test("the direction decides whether a shift is worse or better", () => {
  assert.equal(shifts([...flat(12), 130, 130, 130], { direction: "higher" })[0].kind, "better");
  assert.equal(shifts([...flat(12), 130, 130, 130], { direction: "unknown" })[0].kind, "moved");
  // A rise from a negative baseline is still a rise.
  assert.equal(shifts([...flat(12, -100), -70, -70, -70], { direction: "higher" })[0].kind, "better");
});

test("noise and outliers that return to normal are never reported", () => {
  // A lone outlier.
  assert.deepEqual(shifts([...flat(12), 150, ...flat(8)]), []);
  // A spike interrupted by a return to the baseline.
  assert.deepEqual(shifts([...flat(8), 120, 100, 120, ...flat(10)]), []);
  // Noise that alternates between two levels has no median absolute deviation at all.
  assert.deepEqual(shifts([100, 100, 100, 100, 100, 120, 100, 120, 100, 100, 120, 120, 100]), []);
});

test("one earlier outlier does not hide a real step after it", () => {
  const found = shifts([...flat(10), 250, ...flat(5), 130, 130, 130, 130]);
  assert.deepEqual(
    found.map(({ i }) => i),
    [16],
  );
});

test("a shift at the last runs is tentative until later runs confirm it", () => {
  const found = shifts([...flat(12), 130, 130]);
  assert.equal(found.length, 1);
  assert.equal(found[0].tentative, true);
});

test("a candidate cut short by a new segment is not reported", () => {
  // The run after the jump starts a new segment, even though it recorded no value.
  const values = [...flat(8), 200, null];
  assert.deepEqual(shifts(values, { segment: [...flat(9, 0), 1] }), []);
});

test("comparisons that are not finite are never reported", () => {
  assert.deepEqual(shifts([...flat(8, 1e-320), 1, 1, 1]), []);
  // The midpoint and the relative change stay finite for huge values of opposite sign.
  assert.equal(median([-1e308, 1e308]), 0);
  assert.equal(relative(1e308, -1e308), 2);
});

// Deterministic noise, so the rates below are stable across runs.
function random(seed) {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rate(trials, make, predicate) {
  let hits = 0;
  for (let n = 0; n < trials; n += 1) if (predicate(shifts(make()).filter((s) => !s.tentative))) hits += 1;
  return hits / trials;
}

// Each history has 60 runs; a false alarm is any confirmed shift in a history without one.
// The bounds sit well above the rates these seeds produce, so they flag a regression in the
// detector rather than noise in the test.
test("stationary noise rarely raises a confirmed alarm", () => {
  const next = random(7);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  assert.ok(
    rate(
      400,
      () => Array.from({ length: 60 }, () => 100 * (1 + 0.1 * gauss())),
      (s) => s.length > 0,
    ) < 0.04,
  );
  assert.ok(
    rate(
      400,
      () => Array.from({ length: 60 }, () => (next() < 0.6 ? 100 : 120)),
      (s) => s.length > 0,
    ) < 0.06,
  );
  assert.ok(
    rate(
      400,
      () => Array.from({ length: 60 }, () => (next() < 0.8 ? 100 : 120)),
      (s) => s.length > 0,
    ) < 0.08,
  );
});

test("a clear step in mild noise is found at its onset", () => {
  const next = random(11);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  const step = () => Array.from({ length: 60 }, (_, i) => 100 * (i >= 30 ? 1.1 : 1) * (1 + 0.01 * gauss()));
  assert.ok(rate(200, step, (s) => s.some(({ i }) => Math.abs(i - 30) <= 1)) > 0.99);
});
