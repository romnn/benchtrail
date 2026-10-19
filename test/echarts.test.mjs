// The type check reads ECharts' types from the dev dependency while the page loads the library from
// its CDN, so the two versions have to move together.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the ECharts dev dependency matches the version index.html loads", () => {
  const cdn = read("site/index.html").match(/cdn\.jsdelivr\.net\/npm\/echarts@([^/]+)\//)?.[1];
  assert.ok(cdn, "index.html does not load ECharts from jsDelivr");
  assert.equal(JSON.parse(read("package.json")).devDependencies.echarts, cdn);
});

// The browser refuses a script whose integrity hash does not match, so a version bump that keeps
// the old hash would leave the page without ECharts.
test("the integrity hash in index.html matches the pinned ECharts build", () => {
  const html = read("site/index.html");
  const integrity = html.match(/echarts\.min\.js"\s+integrity="sha384-([^"]+)"/)?.[1];
  assert.ok(integrity, "index.html loads ECharts without an integrity hash");
  const build = readFileSync(new URL("../node_modules/echarts/dist/echarts.min.js", import.meta.url));
  assert.equal(createHash("sha384").update(build).digest("base64"), integrity);
});
