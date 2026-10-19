// Serves the repository root over HTTP for previewing the page, so `site/` can load `../sample/data.js`.
//
// Usage: node scripts/serve.mjs [port]
//
// It binds to 127.0.0.1 only and sends no caching headers, so a reload always picks up edits.

import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Module scripts only run when served with a JavaScript type, so every extension the page loads is listed.
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * Starts a static file server for `root` on 127.0.0.1.
 * Port 0 picks a free port; the returned URL names the one in use.
 *
 * @param {{ root?: string, port?: number }} [options]
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function serve({ root = ROOT, port = 0 } = {}) {
  const base = await realpath(resolve(root));
  // Every failure ends in a response, or in a destroyed one once the headers are out, so no
  // request can leave a rejection unhandled and stop the server.
  const server = createServer((request, response) => {
    answer(base, request, response).catch(() => {
      if (response.headersSent) response.destroy();
      else response.writeHead(500, { "content-type": "text/plain; charset=utf-8" }).end("Internal error\n");
    });
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", () => done(undefined));
  });
  const address = server.address();
  const actual = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    close: () =>
      new Promise((done) => {
        server.close(() => done(undefined));
        // A browser keeps idle connections open, which would otherwise hold the close for minutes.
        server.closeAllConnections();
      }),
  };
}

/**
 * @param {string} base
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 */
async function answer(base, request, response) {
  let url;
  try {
    url = new URL(request.url ?? "/", "http://localhost");
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Bad request\n");
    return;
  }
  const { pathname, search } = url;
  const found = await resolveFile(base, pathname);
  if (!found) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found\n");
    return;
  }
  // The page's relative URLs only resolve against a directory path that ends in a slash.
  if (found.directory && !pathname.endsWith("/")) {
    response.writeHead(301, { location: `${pathname}/${search}` }).end();
    return;
  }
  const path = found.path;
  response.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
  if (request.method === "HEAD") response.end();
  else await pipeline(createReadStream(path), response);
}

// Maps a request path to the file under `base` that answers it, or null.
// A directory answers with its index.html.
// Containment is checked on the real path, after symbolic links are followed, so a link inside
// `base` cannot reach a file outside it.
async function resolveFile(base, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const inside = (path) => path === base || path.startsWith(base + sep);
  try {
    let path = await realpath(resolve(join(base, decoded)));
    if (!inside(path)) return null;
    let info = await stat(path);
    const directory = info.isDirectory();
    if (directory) {
      path = await realpath(join(path, "index.html"));
      if (!inside(path)) return null;
      info = await stat(path);
    }
    return info.isFile() ? { path, directory } : null;
  } catch {
    return null;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? 8765);
  const { url } = await serve({ port });
  console.log(`serving ${ROOT} at ${url}`);
  console.log(`open ${url}site/?data=../sample/data.js`);
}
