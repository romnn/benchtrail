// Reads the history that github-action-benchmark records on its storage branch, through the GitHub
// REST API, so the job that assembles a site needs no checkout of that branch.

/**
 * Where a history is stored.
 * @typedef {object} Source
 * @property {string} api the REST API's base address, such as https://api.github.com
 * @property {string} repository the repository as `owner/name`
 * @property {string} branch the storage branch, as github-action-benchmark's `gh-pages-branch`
 * @property {string} dir the history's directory on it, as its `benchmark-data-dir-path`
 * @property {string} token a token that can read the repository's contents, or empty
 */

/**
 * How requests are retried: how many tries a request gets, the pause before the first retry,
 * which doubles with each retry, and the pause after a rate limit that names no time to wait, all
 * in milliseconds.
 * @typedef {{ tries: number, pause: number, limitPause: number }} Retries
 */

// GitHub asks to wait at least a minute after a secondary rate limit that names no time.
const RETRIES = { tries: 3, pause: 1000, limitPause: 60_000 };

// A wait longer than this fails the step rather than holding the runner.
const LONGEST_WAIT = 5 * 60_000;

// The branch or the file is not there, or the token cannot see the repository: GitHub answers 404
// for a private repository it does not show the token, so the two cannot be told apart.
export class MissingHistory extends Error {}

/**
 * The history at the branch's latest commit, and that commit.
 * The branch is resolved first, so the file is read at one commit even if the branch moves.
 * @param {Source} source
 * @param {Retries} [retries]
 * @returns {Promise<{ commit: string, text: string }>}
 */
export async function fetchHistory(source, retries = RETRIES) {
  const segments = (/** @type {string} */ path) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const base = `${source.api.replace(/\/+$/, "")}/repos/${segments(source.repository)}`;
  const where = `${source.repository}@${source.branch}`;
  const branch = JSON.parse(await get(source, `${base}/branches/${segments(source.branch)}`, "application/vnd.github+json", retries, `branch ${where}`));
  const commit = String(branch.commit?.sha ?? "");
  if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error(`GitHub named no commit for the branch ${where}.`);
  const file = `${segments(source.dir)}${source.dir.split("/").some(Boolean) ? "/" : ""}data.js`;
  const text = await get(source, `${base}/contents/${file}?ref=${commit}`, "application/vnd.github.raw+json", retries, `${where}:${file}`);
  return { commit, text };
}

/**
 * The body of a successful answer.
 * A network failure, a server error, or a rate limit is retried; any other failure is final.
 * @param {Source} source
 * @param {string} url
 * @param {string} accept
 * @param {Retries} retries
 * @param {string} what the resource, as messages name it
 * @returns {Promise<string>}
 */
async function get(source, url, accept, retries, what) {
  /** @type {Record<string, string>} */
  const headers = { accept, "user-agent": "benchtrail", "x-github-api-version": "2022-11-28" };
  if (source.token) headers.authorization = `Bearer ${source.token}`;
  for (let attempt = 1; ; attempt += 1) {
    let failure = "";
    let wait = retries.pause * 2 ** (attempt - 1);
    try {
      // The body is read inside the attempt, so a connection that drops while it arrives is retried.
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
      const body = await response.text();
      if (response.ok) return body;
      if (response.status === 404) throw new MissingHistory(`GitHub has no ${what}, or the token cannot read the repository.`);
      failure = `GitHub answered ${response.status} ${response.statusText}: ${body.slice(0, 200)}`;
      const limit = rateLimitWait(response, body, retries);
      if (limit === null && response.status < 500) throw new Error(`Reading ${what} failed. ${failure}`);
      if (limit !== null) wait = limit;
    } catch (error) {
      if (error instanceof MissingHistory || failure) throw error;
      failure = error.message;
    }
    if (attempt >= retries.tries || wait > LONGEST_WAIT) throw new Error(`Reading ${what} failed. ${failure}`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/**
 * How long a rate limit asks to wait, in milliseconds, or null when the answer is no rate limit.
 * GitHub answers a rate limit with 429, or with 403 and either the limit's headers or, for a
 * secondary limit, a message that names it.
 * @param {Response} response
 * @param {string} body
 * @param {Retries} retries
 */
function rateLimitWait(response, body, retries) {
  const after = Number(response.headers.get("retry-after"));
  const exhausted = response.headers.get("x-ratelimit-remaining") === "0";
  const limited = after > 0 || exhausted || /secondary rate limit/i.test(body);
  if (response.status !== 429 && !(response.status === 403 && limited)) return null;
  if (after > 0) return after * 1000;
  // An exhausted limit names when it resets, in seconds since the epoch.
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (exhausted && reset > 0) return Math.max(0, reset * 1000 - Date.now()) + 1000;
  return retries.limitPause;
}
