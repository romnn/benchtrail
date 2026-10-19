// The GitHub Action's entry point: reads its inputs, reads the history from its storage branch,
// installs the dashboard, and reports what went wrong as annotations on the step.
// It uses no packages, so the action runs from the repository as tagged, with nothing to build.

import path from "node:path";
import { fetchHistory, MissingHistory } from "./history.mjs";
import { install } from "./install.mjs";

/**
 * An input as the runner passes it.
 * @param {string} name
 */
function input(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
}

/**
 * A yes-or-no input, or `fallback` when it is empty.
 * @param {string} name
 * @param {boolean} fallback
 */
function flag(name, fallback) {
  const value = input(name);
  if (value === "") return fallback;
  if (value === "true" || value === "false") return value === "true";
  throw new Error(`The ${name} input must be true or false, not ${JSON.stringify(value)}.`);
}

// Writes a workflow command that annotates the step.
// The runner reads one command per line, so the message escapes `%` and line breaks.
/**
 * @param {"error" | "warning"} kind
 * @param {string} message
 */
function annotate(kind, message) {
  console.log(`::${kind}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
}

/**
 * Reads the inputs and installs the dashboard.
 * @returns {Promise<{ problems: string[], warnings: string[] }>}
 */
async function run() {
  const dir = input("path");
  if (!dir) return { problems: ["The path input is empty; name the directory to install the dashboard into."], warnings: [] };

  // Read the history before anything is installed, so a failed read leaves the directory as it was.
  /** @type {string | null} */
  let history = null;
  /** @type {string[]} */
  const warnings = [];
  if (flag("fetch-history", true)) {
    const source = {
      api: process.env.GITHUB_API_URL || "https://api.github.com",
      repository: input("repository"),
      branch: input("gh-pages-branch"),
      dir: input("benchmark-data-dir-path"),
      token: input("token"),
    };
    try {
      const fetched = await fetchHistory(source);
      history = fetched.text;
      console.log(`Read the history from ${source.repository}@${fetched.commit}.`);
    } catch (error) {
      if (!(error instanceof MissingHistory) || !flag("allow-missing-history", false)) return { problems: [error.message], warnings };
      warnings.push(`${error.message} The dashboard is installed without a history.`);
    }
  }

  // A directory that cannot be written fails the step with an annotation, as a problem does.
  const outcome = await install({ dir: path.resolve(dir), settings: input("settings") || null, history }).catch((error) => ({
    problems: [`benchtrail could not be installed into ${dir}: ${error.message}`],
    warnings: [],
  }));
  if (!outcome.problems.length) console.log(`Installed benchtrail into ${dir}.`);
  return { problems: outcome.problems, warnings: [...warnings, ...outcome.warnings] };
}

const outcome = await run().catch((error) => ({ problems: [error.message], warnings: [] }));
for (const problem of outcome.problems) annotate("error", problem);
for (const warning of outcome.warnings) annotate("warning", warning);
if (outcome.problems.length) process.exitCode = 1;
