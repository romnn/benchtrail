// Checks the preview server against a small fixture tree instead of the repository.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { serve } from "../scripts/serve.mjs";

// The served root sits beside a secret file, so a confinement failure would answer 200 rather than
// the 404 of a file that does not exist.
const fixture = mkdtempSync(join(tmpdir(), "benchtrail-serve-"));
const root = join(fixture, "root");
let server;

before(async () => {
  mkdirSync(join(root, "site"), { recursive: true });
  writeFileSync(join(root, "site", "index.html"), "<!doctype html>\n");
  writeFileSync(join(root, "site", "benchtrail.js"), "export {};\n");
  writeFileSync(join(fixture, "secret.txt"), "secret\n");
  symlinkSync(join(fixture, "secret.txt"), join(root, "site", "link.txt"));
  server = await serve({ root });
});

after(async () => {
  await server.close();
  rmSync(fixture, { recursive: true, force: true });
});

const fetchPath = (path) => fetch(new URL(path, server.url), { redirect: "manual" });

test("serves module scripts with a JavaScript type", async () => {
  const response = await fetchPath("site/benchtrail.js");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^text\/javascript/);
});

// The page resolves `benchtrail.js` and `?data=` against its own URL, which must end in a slash.
test("redirects a directory to its slash form and keeps the query", async () => {
  const response = await fetchPath("site?data=../sample/data.js");
  assert.equal(response.status, 301);
  assert.equal(response.headers.get("location"), "/site/?data=../sample/data.js");

  const index = await fetchPath("site/");
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type"), /^text\/html/);
});

// URL parsing removes `..` segments, even percent-encoded ones, so the escape attempt encodes its
// slashes instead and only becomes `../..` once the server decodes the path.
test("refuses paths outside the root", async () => {
  const response = await fetchPath("site/..%2f..%2fsecret.txt");
  assert.equal(response.status, 404);
});

test("refuses a symbolic link that leads outside the root", async () => {
  const response = await fetchPath("site/link.txt");
  assert.equal(response.status, 404);
});

// fetch cannot send a request target that is not a valid URL, so this one is written by hand.
test("answers a malformed request target with 400 and keeps serving", async () => {
  const { port } = new URL(server.url);
  const reply = await new Promise((done, fail) => {
    const socket = connect(Number(port), "127.0.0.1", () => socket.end("GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"));
    let text = "";
    socket.on("data", (chunk) => {
      text += chunk;
    });
    socket.on("end", () => done(text));
    socket.on("error", fail);
  });
  assert.match(String(reply), /^HTTP\/1\.1 400/);

  const response = await fetchPath("site/benchtrail.js");
  assert.equal(response.status, 200);
});

test("answers a missing file with 404", async () => {
  const response = await fetchPath("site/missing.js");
  assert.equal(response.status, 404);
});
