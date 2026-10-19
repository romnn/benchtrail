// Checks the GitHub Action: what an install replaces and keeps in the directory, how it treats the
// settings, and how the entry point reports to the runner.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fetchHistory, MissingHistory } from "../action/history.mjs";
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

/**
 * Runs the entry point with the given inputs, as the runner passes them.
 * The history is read from the directory unless the inputs say otherwise.
 * @param {Record<string, string>} inputs
 * @returns {Promise<{ status: number, stdout: string }>}
 */
function runMain(inputs) {
  const env = { ...process.env, "INPUT_FETCH-HISTORY": "false", ...inputs };
  return new Promise((resolve) => {
    execFile(process.execPath, [MAIN], { env, encoding: "utf8" }, (error, stdout) => resolve({ status: error ? Number(error.code ?? 1) : 0, stdout }));
  });
}

/**
 * A stand-in for GitHub's REST API that answers from `routes`, by path and query, with a status
 * and a body; every request it receives is recorded in `requests`.
 * @param {import("node:test").TestContext} t
 * @param {Record<string, Array<[number, string]>>} routes answers per request, used in turn
 */
async function fakeGitHub(t, routes) {
  /** @type {import("node:http").IncomingMessage[]} */
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request);
    const [status, body] = routes[request.url]?.shift() ?? [404, '{"message":"Not Found"}'];
    response.writeHead(status).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  t.after(() => server.close());
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return { api: `http://127.0.0.1:${port}`, requests };
}

const HISTORY = "window.BENCHMARK_DATA = { entries: { main: [] } };\n";

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
  const run = runMain;

  const installed = await run({ INPUT_PATH: dir, INPUT_SETTINGS: '{ "title": "Compile cost" }' });
  assert.equal(installed.status, 0);
  assert.deepEqual(JSON.parse(await read(dir, SETTINGS_FILE)), { title: "Compile cost" });

  // Each problem is one annotation, with line breaks escaped so the runner reads it as one.
  const failed = await run({ INPUT_PATH: dir, INPUT_SETTINGS: '{ "names": "(" }' });
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^::error::The setting `names` is not a valid regular expression: /m);
  const escaped = await run({ INPUT_PATH: dir, INPUT_SETTINGS: '{ "50%": 1 }' });
  assert.match(escaped.stdout, /^::error::The setting `\["50%25"\]` is not a setting\.$/m);
  const empty = await run({ INPUT_PATH: " ", INPUT_SETTINGS: "" });
  assert.equal(empty.status, 1);
  assert.match(empty.stdout, /^::error::The path input is empty/m);
});

test("a directory that cannot be written fails the step with an annotation", async (t) => {
  const dir = await pagesDir(t);
  // A directory inside a file cannot be created.
  const run = await runMain({ INPUT_PATH: path.join(dir, "data.js", "bench") });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^::error::benchtrail could not be installed into /m);
});

test("the history is read at the branch's latest commit", async (t) => {
  const github = await fakeGitHub(t, {
    "/repos/romnn/progeny/commits/gh-pages": [[200, "abc123\n"]],
    "/repos/romnn/progeny/contents/bench/data.js?ref=abc123": [[200, HISTORY]],
  });
  const source = { api: github.api, repository: "romnn/progeny", branch: "gh-pages", dir: "bench", token: "secret" };
  assert.deepEqual(await fetchHistory(source), { commit: "abc123", text: HISTORY });
  // Every request carries the token and asks for the raw content.
  assert.equal(github.requests[1].headers.authorization, "Bearer secret");
  assert.equal(github.requests[1].headers.accept, "application/vnd.github.raw+json");
});

test("a missing history and a failed read are told apart, and a server error is retried", async (t) => {
  const source = { repository: "romnn/progeny", branch: "gh-pages", dir: "dev/bench", token: "" };
  const quick = { tries: 2, pause: 0 };

  // No branch, or no access: GitHub answers 404 for both.
  const missing = await fakeGitHub(t, {});
  await assert.rejects(fetchHistory({ ...source, api: missing.api }, quick), MissingHistory);

  // A server error is retried, and the second answer counts.
  const flaky = await fakeGitHub(t, {
    "/repos/romnn/progeny/commits/gh-pages": [
      [502, "bad gateway"],
      [200, "abc123"],
    ],
    "/repos/romnn/progeny/contents/dev/bench/data.js?ref=abc123": [[200, HISTORY]],
  });
  assert.equal((await fetchHistory({ ...source, api: flaky.api }, quick)).text, HISTORY);

  // A refused token is final, and not a missing history.
  const refused = await fakeGitHub(t, { "/repos/romnn/progeny/commits/gh-pages": [[401, "Bad credentials"]] });
  await assert.rejects(fetchHistory({ ...source, api: refused.api }, quick), (error) => !(error instanceof MissingHistory) && /401/.test(String(error)));
  assert.equal(refused.requests.length, 1);
});

test("the entry point installs the history it reads, and fails when there is none", async (t) => {
  const dir = await pagesDir(t);
  const github = await fakeGitHub(t, {
    "/repos/romnn/progeny/commits/gh-pages": [[200, "abc123"]],
    "/repos/romnn/progeny/contents/bench/data.js?ref=abc123": [[200, HISTORY]],
  });
  const inputs = {
    GITHUB_API_URL: github.api,
    "INPUT_FETCH-HISTORY": "true",
    INPUT_PATH: dir,
    INPUT_REPOSITORY: "romnn/progeny",
    "INPUT_GH-PAGES-BRANCH": "gh-pages",
    "INPUT_BENCHMARK-DATA-DIR-PATH": "bench",
  };
  const installed = await runMain(inputs);
  assert.equal(installed.status, 0);
  assert.match(installed.stdout, /Read the history from romnn\/progeny@abc123/);
  assert.equal(await read(dir, "data.js"), HISTORY);

  // Without a history on the branch the step fails and leaves the directory as it was, unless a
  // missing history is allowed.
  const before = await read(dir, "index.html");
  await rm(path.join(dir, "data.js"));
  const failed = await runMain(inputs);
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /^::error::GitHub has no romnn\/progeny@gh-pages/m);
  assert.equal(await read(dir, "index.html"), before);
  const allowed = await runMain({ ...inputs, "INPUT_ALLOW-MISSING-HISTORY": "true" });
  assert.equal(allowed.status, 0);
  assert.match(allowed.stdout, /^::warning::GitHub has no romnn\/progeny@gh-pages.*installed without a history/m);
});
