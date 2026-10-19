// Checks how values, units, and changes read, through the page's own formatting module.

import assert from "node:assert/strict";
import { test } from "node:test";
import { changeParts, displayUnit, formatTick, formatValue, parseUnit, unitFactor } from "../site/benchtrail/format.js";

test("units in one family convert into each other, and others stay as recorded", () => {
  // Seconds and milliseconds share the time family; bytes in IEC and SI steps do not mix families.
  assert.equal(unitFactor("ms", "s"), 1e-3);
  assert.equal(unitFactor("MiB", "KiB"), 1024);
  assert.equal(unitFactor("ops/s", "ops/s"), 1);
  assert.equal(unitFactor("pts", "s"), 1);

  // An alias and a rate tail are kept apart from the unit's step.
  assert.deepEqual(parseUnit("us/iter"), { family: "time", size: 1e-6, tail: "/iter" });
  assert.equal(parseUnit("widgets"), null);
});

test("a value reads in the step that keeps it at one or more", () => {
  assert.deepEqual(displayUnit("s", 0.0042), { label: "ms", factor: 1e3 });
  // Times stay in seconds up to ten minutes.
  assert.equal(displayUnit("s", 300).label, "s");
  assert.equal(displayUnit("s", 900).label, "min");
  // Bare bytes read in IEC steps.
  assert.equal(formatValue(1536, "B"), "1.50 KiB");
});

test("neighbouring ticks never read the same", () => {
  // A step of 0.05 needs two decimals, so 45.80 and 45.85 stay distinct.
  assert.notEqual(formatTick(45.8, 0.05), formatTick(45.85, 0.05));
});

test("a change reads with its sign, and only a judged change gets an arrow", () => {
  assert.deepEqual(changeParts(0.123, "worse"), { text: "+12%", arrow: "up", label: "regression" });
  assert.deepEqual(changeParts(-0.004, "noise"), { text: "−0.4%", arrow: null, label: "within noise" });
  assert.equal(changeParts(null, "none").text, "–");
  assert.equal(changeParts(Infinity, "worse").text, "–");
});
