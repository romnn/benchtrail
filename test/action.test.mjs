// Checks the GitHub Action: what an install replaces and keeps in the directory, how it treats the
// settings, and how the entry point reports to the runner.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { install, SETTINGS_FILE } from "../action/install.mjs";

const MAIN = fileURLToPath(new URL("../action/main.mjs", import.meta.url));

/**
 * A fresh directory as github-action-benchmark leaves it: its history and its own page.
 * @param {import("node:test").TestContext} t
 */
async function pagesDir(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "benchtrail action "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "data.js"), "window.BENCHMARK_DATA = { entries: {} };\n");
  await writeFile(path.join(dir, "index.html"), "<p>the action's chart</p>\n");
  return dir;
}

const read = (dir, file) => readFile(path.join(dir, file), "utf8");

test("an install replaces the page and keeps the history and other files", async (t) => {
  const dir = await pagesDir(t);
  await writeFile(path.join(dir, "notes.txt"), "kept\n");
  // A module an earlier release had and this one does not.
  await mkdir(path.join(dir, "benchtrail"));
  await writeFile(path.join(dir, "benchtrail", "gone.js"), "");

  const outcome = await install({ dir, settings: null });
  assert.deepEqual(outcome, { problems: [], warnings: [] });

  assert.match(await read(dir, "index.html"), /<script type="module" src="benchtrail.js">/);
  assert.equal(await read(dir, "data.js"), "window.BENCHMARK_DATA = { entries: {} };\n");
  assert.equal(await read(dir, "notes.txt"), "kept\n");
  const modules = await readdir(path.join(dir, "benchtrail"), { recursive: true });
  assert.ok(modules.includes(path.join("core", "config.js")));
  assert.ok(!modules.includes("gone.js"));
  // Without settings, the page gets an empty set.
  assert.equal(await read(dir, SETTINGS_FILE), "{}\n");
});

test("given settings replace the directory's, and without them its own stay", async (t) => {
  const dir = await pagesDir(t);
  await install({ dir, settings: '{ "title": "Compile cost" }' });
  assert.deepEqual(JSON.parse(await read(dir, SETTINGS_FILE)), { title: "Compile cost" });

  // A later install without settings, such as an upgrade, keeps the file as it is.
  await writeFile(path.join(dir, SETTINGS_FILE), '{"title":"Edited"}');
  await install({ dir, settings: null });
  assert.equal(await read(dir, SETTINGS_FILE), '{"title":"Edited"}');
});

test("settings that break a rule leave the directory untouched", async (t) => {
  const dir = await pagesDir(t);
  assert.deepEqual(await install({ dir, settings: '{ "threshold": "high", "colour": "doc" }' }), {
    problems: ["The setting `threshold` must be a number of at least 0.", "The setting `colour` is not a setting."],
    warnings: [],
  });
  assert.match((await install({ dir, settings: "{ title: 1 }" })).problems[0], /^The settings are not valid JSON/);

  // The directory's settings are checked too, when the install keeps them.
  await writeFile(path.join(dir, SETTINGS_FILE), '{ "smoothing": 3 }');
  assert.match((await install({ dir, settings: null })).problems[0], /`smoothing` must be one of/);

  assert.equal(await read(dir, "index.html"), "<p>the action's chart</p>\n");
  assert.deepEqual((await readdir(dir)).sort(), ["benchtrail.json", "data.js", "index.html"]);
});

test("a directory without the history is installed, with a warning", async (t) => {
  const dir = await pagesDir(t);
  await rm(path.join(dir, "data.js"));
  const outcome = await install({ dir, settings: null });
  assert.deepEqual(outcome.problems, []);
  assert.match(outcome.warnings[0], /holds no data\.js/);
  // Settings that name the history elsewhere make no claim about this directory.
  assert.deepEqual(await install({ dir, settings: '{ "dataUrl": "../data.js" }' }), { problems: [], warnings: [] });
});

test("the entry point reads its inputs and fails the step on a problem", async (t) => {
  const dir = await pagesDir(t);
  const run = (inputs) => spawnSync(process.execPath, [MAIN], { env: { ...process.env, ...inputs }, encoding: "utf8" });

  const installed = run({ INPUT_PATH: dir, INPUT_SETTINGS: '{ "title": "Compile cost" }' });
  assert.equal(installed.status, 0);
  assert.deepEqual(JSON.parse(await read(dir, SETTINGS_FILE)), { title: "Compile cost" });

  // Each problem is one annotation, with line breaks escaped so the runner reads it as one.
  const failed = run({ INPUT_PATH: dir, INPUT_SETTINGS: '{ "names": "(" }' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^::error::The setting `names` is not a valid regular expression: /m);
  const escaped = run({ INPUT_PATH: dir, INPUT_SETTINGS: '{ "50%": 1 }' });
  assert.match(escaped.stdout, /^::error::The setting `\["50%25"\]` is not a setting\.$/m);
  const empty = run({ INPUT_PATH: " ", INPUT_SETTINGS: "" });
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /^::error::The path input is empty/m);
});

test("a directory that cannot be written fails the step with an annotation", async (t) => {
  const dir = await pagesDir(t);
  // A directory inside a file cannot be created.
  const run = spawnSync(process.execPath, [MAIN], { env: { ...process.env, INPUT_PATH: path.join(dir, "data.js", "bench") }, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^::error::benchtrail could not be installed into /m);
});
