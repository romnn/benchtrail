// Installs the dashboard into a directory of a static site, with the history it shows.

import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig } from "../site/benchtrail/core/config.js";

const SITE = fileURLToPath(new URL("../site/", import.meta.url));

// The dashboard's own files.
// An install replaces exactly these, so the history and anything else in the directory stay.
const PAGE_FILES = ["index.html", "benchtrail.css", "benchtrail.js"];
const MODULES = "benchtrail";

export const SETTINGS_FILE = "benchtrail.json";

/**
 * The outcome of an install: why nothing was installed, if anything kept it from installing, and
 * what the installed page may lack.
 * @typedef {{ problems: string[], warnings: string[] }} Outcome
 */

/**
 * Installs the dashboard into `dir`, with `settings` as its settings, or with the ones the
 * directory already holds when `settings` is null, and with `history` as its `data.js`, or with
 * the one the directory already holds when `history` is null.
 * Settings are checked first, so a directory never ends up with a page and settings that break a
 * rule.
 * @param {{ dir: string, settings: string | null, history?: string | null }} options
 * @returns {Promise<Outcome>}
 */
export async function install({ dir, settings, history = null }) {
  const settingsPath = path.join(dir, SETTINGS_FILE);
  const existing = await readIfPresent(settingsPath);
  const text = settings ?? existing;

  // Check the settings before anything in the directory changes.
  /** @type {unknown} */
  let raw = {};
  if (text !== null) {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      const source = settings === null ? `The settings in ${settingsPath}` : "The settings";
      return { problems: [`${source} are not valid JSON: ${error.message}`], warnings: [] };
    }
  }
  const config = readConfig(raw);
  if (config.problems.length) return { problems: config.problems.map((problem) => problem.message), warnings: [] };

  // Replace the page.
  // Its modules are replaced as a whole, so none that an earlier release had stays behind.
  await mkdir(dir, { recursive: true });
  for (const file of PAGE_FILES) await cp(path.join(SITE, file), path.join(dir, file));
  await rm(path.join(dir, MODULES), { recursive: true, force: true });
  await cp(path.join(SITE, MODULES), path.join(dir, MODULES), { recursive: true });

  // Write the settings, or an empty set when there are none, so the page finds a file either way.
  if (settings !== null) await writeFile(settingsPath, `${JSON.stringify(raw, null, 2)}\n`);
  else if (existing === null) await writeFile(settingsPath, "{}\n");
  // The history is written as received; the page loads it as a script, and nothing here runs it.
  if (history !== null) await writeFile(path.join(dir, "data.js"), history);

  /** @type {string[]} */
  const warnings = [];
  if (config.dataUrl === null && !(await present(path.join(dir, "data.js")))) {
    warnings.push(`${dir} holds no data.js, so the dashboard has no history to show.`);
  }
  return { problems: [], warnings };
}

/** @param {string} file */
async function readIfPresent(file) {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** @param {string} file */
async function present(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
