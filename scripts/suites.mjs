// Merges and drops suites of a recorded history, for a one-off cleanup of the storage branch, such
// as folding a suite that a benchmark no longer records into the one it records now.
//
// Usage: node scripts/suites.mjs <data.js> [--merge FROM=INTO]... [--drop NAME]...
//
// The file is rewritten in place in github-action-benchmark's layout. Merges run before drops, each
// in the order given; a suite a step names that the history lacks fails the whole run, which then
// writes nothing.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

// The line github-action-benchmark writes before the history's JSON.
const PREFIX = "window.BENCHMARK_DATA = ";

/**
 * A recorded history as github-action-benchmark writes it.
 * @typedef {{ lastUpdate?: number, repoUrl?: string, entries: Record<string, Array<Record<string, any>>> }} History
 */

/**
 * One step of a cleanup.
 * @typedef {{ kind: "merge", from: string, into: string } | { kind: "drop", name: string }} Step
 */

/**
 * Applies the steps to a history and returns the new one; the given history is not changed.
 * A merge appends each run's entries of `from` to the run of `into` that recorded the same commit
 * nearest in time, or adds the run to `into` in date order when `into` has no run of that commit,
 * and then removes `from`.
 * @param {History} history
 * @param {readonly Step[]} steps
 * @returns {History}
 */
export function applySteps(history, steps) {
  /** @type {History} */
  const next = structuredClone(history);
  const entries = next.entries;
  const need = (/** @type {string} */ name) => {
    if (!Object.hasOwn(entries, name)) throw new Error(`the history has no suite ${JSON.stringify(name)}`);
    return entries[name];
  };
  for (const step of steps) {
    if (step.kind === "drop") {
      need(step.name);
      delete entries[step.name];
      continue;
    }
    const from = need(step.from);
    const into = need(step.into);
    if (step.from === step.into) throw new Error(`cannot merge the suite ${JSON.stringify(step.from)} into itself`);
    for (const run of from) {
      const same = into.filter((other) => other.commit?.id === run.commit?.id);
      if (same.length) {
        const nearest = same.reduce((best, other) => (Math.abs(other.date - run.date) < Math.abs(best.date - run.date) ? other : best));
        nearest.benches = [...(nearest.benches ?? []), ...(run.benches ?? [])];
      } else {
        const at = into.findIndex((other) => other.date > run.date);
        into.splice(at < 0 ? into.length : at, 0, run);
      }
    }
    delete entries[step.from];
  }
  return next;
}

/**
 * Reads the steps from the command line's arguments after the file.
 * @param {readonly string[]} args
 * @returns {Step[]}
 */
export function readSteps(args) {
  /** @type {Step[]} */
  const merges = [];
  /** @type {Step[]} */
  const drops = [];
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--drop") drops.push({ kind: "drop", name: value });
    else if (flag === "--merge") {
      const at = value.indexOf("=");
      if (at <= 0 || at === value.length - 1) throw new Error(`--merge needs FROM=INTO, not ${JSON.stringify(value)}`);
      merges.push({ kind: "merge", from: value.slice(0, at), into: value.slice(at + 1) });
    } else throw new Error(`unknown option ${flag}`);
  }
  return [...merges, ...drops];
}

/**
 * Reads a `data.js` the way the page does: as a script that assigns `window.BENCHMARK_DATA`.
 * @param {string} text
 * @returns {History}
 */
export function parseHistory(text) {
  /** @type {{ BENCHMARK_DATA?: History }} */
  const window = {};
  runInNewContext(text, { window });
  if (!window.BENCHMARK_DATA || typeof window.BENCHMARK_DATA.entries !== "object") throw new Error("the file holds no benchmark history");
  return window.BENCHMARK_DATA;
}

/**
 * @param {History} history
 * @returns {string}
 */
export function formatHistory(history) {
  return `${PREFIX}${JSON.stringify(history, null, 2)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [file, ...args] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node scripts/suites.mjs <data.js> [--merge FROM=INTO]... [--drop NAME]...");
    process.exit(2);
  }
  try {
    const history = applySteps(parseHistory(readFileSync(file, "utf8")), readSteps(args));
    writeFileSync(file, formatHistory(history));
    for (const [name, runs] of Object.entries(history.entries)) console.log(`${name}: ${runs.length} runs`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
