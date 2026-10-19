// The GitHub Action's entry point: reads its inputs, installs the dashboard, and reports what went
// wrong as annotations on the step.
// It uses no packages, so the action runs from the repository as tagged, with nothing to build.

import path from "node:path";
import { install } from "./install.mjs";

/**
 * An input as the runner passes it.
 * @param {string} name
 */
function input(name) {
  return (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim();
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

const dir = input("path");
const settings = input("settings");
if (!dir) {
  annotate("error", "The path input is empty; name the directory that holds the history.");
  process.exitCode = 1;
} else {
  const outcome = await install({ dir: path.resolve(dir), settings: settings || null });
  for (const problem of outcome.problems) annotate("error", problem);
  for (const warning of outcome.warnings) annotate("warning", warning);
  if (outcome.problems.length) process.exitCode = 1;
  else console.log(`Installed benchtrail into ${dir}.`);
}
