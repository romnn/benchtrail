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
  "page=runs&section=s:%23odd,threads&q=walk+refs&only=changes&sort=time:threads%3D4&order=best&in=window",
  "chart=time:doc%3Da/threads%3D4&suite=main&section=doc,threads&os=linux&from=70fba8d&to=16ad5ea",
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

test("the run list's search, sort, and window only reach the link on the runs page", () => {
  const elsewhere = { ...emptyLink(), query: "walk", sort: /** @type {const} */ ({ line: "time:", order: "worst" }), inWindow: true };
  assert.equal(formatLink(elsewhere), "");
  assert.equal(formatLink({ ...elsewhere, route: { kind: "runs" } }), "page=runs&q=walk&sort=time:&in=window");
});

test("a link opens the overview, the runs page, or one chart, named by the chart alone", () => {
  assert.deepEqual(parseLink("").route, { kind: "overview" });
  assert.deepEqual(parseLink("?page=runs").route, { kind: "runs" });
  assert.deepEqual(parseLink("?page=nope").route, { kind: "overview" });
  // A chart id keeps its escaped parts through the round trip, and a chart wins over a page name.
  const chart = parseLink("?page=runs&chart=time:doc%3Da%252Fb/threads%3D4");
  assert.deepEqual(chart.route, { kind: "chart", chart: "time:doc=a%2Fb/threads=4" });
  assert.equal(formatLink(chart), "chart=time:doc%3Da%252Fb/threads%3D4");
});

test("opening a page keeps what the link shows, with any changes the page asks for", () => {
  const zoomed = parseLink("?doc=a&from=a&to=b&values=change");
  const opened = reduce(zoomed, { type: "open", route: { kind: "chart", chart: "time" }, changes: { run: { kind: "at", key: "c" } } });
  assert.equal(formatLink(opened), "chart=time&doc=a&values=change&from=a&to=b&run=c");
  assert.equal(formatLink(reduce(opened, { type: "open", route: { kind: "overview" } })), "doc=a&values=change&from=a&to=b&run=c");
});

test("switching suite or section starts the section's choices afresh", () => {
  const busy = parseLink("?page=runs&suite=A&metrics=cpu&threads=4&color=threads&run=abc&from=a&to=b&sort=time:&values=change");
  const next = reduce(busy, { type: "suite", suite: "B" });
  // Choices about what to show reset; how to show it, and the page, stay.
  assert.equal(formatLink(next), "page=runs&suite=B&values=change");
  assert.equal(formatLink(reduce(busy, { type: "section", section: { kind: "keys", keys: ["os"] } })), "page=runs&suite=A&section=os&values=change");
  // A chart belongs to its section, so a chart page gives way to the overview.
  assert.equal(formatLink(reduce(parseLink("?chart=time&suite=A"), { type: "suite", suite: "B" })), "suite=B");
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
