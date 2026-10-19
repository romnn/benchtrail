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
 * How requests are retried: how many tries a request gets, and the pause before the first retry,
 * in milliseconds, which doubles with each retry.
 * @typedef {{ tries: number, pause: number }} Retries
 */

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
export async function fetchHistory(source, retries = { tries: 3, pause: 1000 }) {
  const repository = source.repository.split("/").map(encodeURIComponent).join("/");
  const base = `${source.api.replace(/\/+$/, "")}/repos/${repository}`;
  const where = `${source.repository}@${source.branch}`;
  const commit = (await get(source, `${base}/commits/${encodeURIComponent(source.branch)}`, "application/vnd.github.sha", retries, where)).trim();
  const file = [...source.dir.split("/").filter(Boolean), "data.js"].map(encodeURIComponent).join("/");
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
    /** @type {Response | null} */
    let response = null;
    let failure = "";
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
    } catch (error) {
      failure = error.message;
    }
    if (response?.ok) return response.text();
    if (response?.status === 404) throw new MissingHistory(`GitHub has no ${what}, or the token cannot read the repository.`);
    if (response) failure = `GitHub answered ${response.status} ${response.statusText}: ${(await response.text()).slice(0, 200)}`;
    if (attempt >= retries.tries || (response && !retryable(response))) throw new Error(`Reading ${what} failed. ${failure}`);
    const after = Number(response?.headers.get("retry-after"));
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(after) && after > 0 ? after * 1000 : retries.pause * 2 ** (attempt - 1)));
  }
}

/** @param {Response} response */
function retryable(response) {
  // GitHub answers a rate limit with 429, or with 403 and the limit's headers.
  const limited = response.status === 403 && (response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0");
  return response.status >= 500 || response.status === 429 || limited;
}
