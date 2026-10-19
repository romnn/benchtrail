// Checks that links read and write the page's state faithfully, and that the reader's actions
// change it by the page's rules.

import assert from "node:assert/strict";
import { test } from "node:test";
import { dimensionParam, emptyLink, formatLink, parseLink } from "../site/benchtrail/core/link.js";
import { only, reduce } from "../site/benchtrail/core/selection.js";

// Links the page writes today, which must read back to exactly the same text.
const LINKS = [
  "",
  "data=../sample/edge-cases.js&suite=Typed+edge+cases&threads=s:4&smooth=5",
  "suite=Many+benchmarks&runs=100&metrics=cpu,peak+rss&document=oxide,okta&color=strategy&dash=~&values=change&x=date&from=70fba8d&to=16ad5ea&run=0728574~2&view=movers&more=1&charts=all&changes=all",
  "section=%23multi&metrics=~",
  "section=s:%23odd,threads&list=1&q=walk+refs&only=changes&sort=time:threads%3D4&order=best",
  "d.smooth=yes&d.d.x=1&smooth=21",
  "mode=a%2Cb,c",
];

test("links the page writes read back to the same text", () => {
  for (const link of LINKS) assert.equal(formatLink(parseLink(`?${link}`)), link);
});

test("a link reads into a complete state, never keeping values from an earlier one", () => {
  const first = parseLink("?runs=30&values=change&x=date&threads=4");
  assert.equal(first.range, "30");
  // Reading an empty query gives the defaults, whatever was read before.
  assert.deepEqual(parseLink(""), emptyLink());
});

test("dimension names that collide with the page's parameters are prefixed", () => {
  assert.equal(dimensionParam("smooth"), "d.smooth");
  assert.equal(dimensionParam("d.x"), "d.d.x");
  assert.equal(dimensionParam("threads"), "threads");

  const link = parseLink("?d.smooth=yes&smooth=5");
  assert.deepEqual(link.smoothing, { kind: "explicit", window: 5 });
  assert.deepEqual(link.dimensions.get("smooth"), { kind: "only", values: new Set(["yes"]) });
});

test("an empty selection, a missing value, and a value with a comma stay distinct", () => {
  const link = parseLink("?metrics=~&os=-,s:-&mode=a%2Cb");
  assert.deepEqual(link.metrics, { kind: "only", values: new Set() });
  assert.deepEqual(link.dimensions.get("os"), { kind: "only", values: new Set(["-", "s:-"]) });
  assert.deepEqual(link.dimensions.get("mode"), { kind: "only", values: new Set(["a,b"]) });
});

test("sections are named by their keys, or by their benchmark when they have none", () => {
  assert.deepEqual(parseLink("?section=%23build").section, { kind: "benchmark", link: "#build" });
  // A key that starts like a benchmark link is escaped.
  assert.deepEqual(parseLink("?section=s:%23odd,threads").section, { kind: "keys", keys: ["#odd", "threads"] });
});

test("the run list's search and sort only reach the link while the list is open", () => {
  const closed = { ...emptyLink(), query: "walk", sort: /** @type {const} */ ({ line: "time:", order: "worst" }) };
  assert.equal(formatLink(closed), "");
  assert.equal(formatLink({ ...closed, list: true }), "list=1&q=walk&sort=time:");
});

test("switching suite or section starts the section's choices afresh", () => {
  const busy = parseLink("?suite=A&metrics=cpu&threads=4&color=threads&run=abc&from=a&to=b&sort=time:&list=1&values=change");
  const next = reduce(busy, { type: "suite", suite: "B" });
  // Choices about what to show reset; how to show it stays.
  assert.equal(formatLink(next), "suite=B&values=change&list=1");
  assert.equal(formatLink(reduce(busy, { type: "section", section: { kind: "keys", keys: ["os"] } })), "suite=A&section=os&values=change&list=1");
});

test("a new range shows all of it", () => {
  const zoomed = parseLink("?from=a&to=b");
  assert.deepEqual(reduce(zoomed, { type: "range", range: "30" }).window, { kind: "full" });
});

test("a selection of every current value stays a list, so later values stay out of it", () => {
  assert.deepEqual(only(["a", "b"]), { kind: "only", values: new Set(["a", "b"]) });
  // Clearing a dimension's filter removes it from the link.
  const filtered = parseLink("?threads=4");
  assert.equal(formatLink(reduce(filtered, { type: "dimension", key: "threads", filter: { kind: "all" } })), "");
});
