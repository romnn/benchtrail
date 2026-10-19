// Checks how runs are found and ranked by what a reader remembers of them.

import assert from "node:assert/strict";
import { test } from "node:test";
import { searchRun, searchTokens } from "../site/benchtrail/core/search.js";

/**
 * A run with just the fields search reads.
 * @param {string} id
 * @param {string} subject
 * @param {{ author?: string, body?: string }} [extra]
 * @returns {import("../site/benchtrail/core/history.js").Run}
 */
function run(id, subject, { author = "Sam Rivera", body = "" } = {}) {
  return { index: 0, id, short: id.slice(0, 7), key: id.slice(0, 7), message: subject, subject, body, url: null, author, date: 0, tool: null };
}

/**
 * @param {import("../site/benchtrail/core/history.js").Run} r
 * @param {string} query
 */
const search = (r, query) => searchRun(r, searchTokens(query), query);

test("a commit or pull request named in the query ranks above any word match", () => {
  const byPr = search(run("aaaa111", "fix(codegen): drop impls (#303)"), "303");
  const bySha = search(run("bbbb222abc", "feat: something"), "bbbb22");
  const byWord = search(run("cccc333", "303 tests pass"), "303");
  assert.equal(byPr?.tier, 3);
  assert.equal(bySha?.tier, 3);
  assert.equal(byWord?.tier, 1);
});

test("every word must match, and a whole phrase in the subject ranks next", () => {
  const r = run("dddd444", "perf(resolve): intern schema names");
  assert.equal(search(r, "intern nothing"), null);
  assert.equal(search(r, "intern schema")?.tier, 2);
  // The phrase is marked in the subject.
  assert.ok(search(r, "intern schema")?.marks.some(([a, b]) => r.subject.slice(a, b) === "intern schema"));
});

test("a whole word scores above a prefix, and a prefix above letters in order", () => {
  const r = run("eeee555", "refactor(doc): bundle root types");
  const whole = search(r, "bundle")?.score ?? 0;
  const prefix = search(r, "bun")?.score ?? 0;
  const loose = search(r, "bndl")?.score ?? 0;
  assert.ok(whole > prefix && prefix > loose && loose > 0);
});

test("the body matches only whole words, word starts, or long fragments, and counts for less than the subject", () => {
  const r = run("ffff666", "chore: tidy", { body: "Moves the resolver onto an explicit stack." });
  assert.equal(search(r, "ck"), null);
  assert.ok((search(r, "resolver")?.score ?? 0) < (search(run("ffff667", "resolver tweaks"), "resolver")?.score ?? 0));
});
