// The page's settings, as `benchtrail.json` beside it gives them.
// The page and the GitHub Action read them by the same rules: a value that breaks one is left out
// and reported, so the page draws with the rest while the action fails the deploy.

import { SMOOTHING } from "./link.js";

/**
 * A metric's settings.
 * `order` places its charts, lower first; `splitEnvironment` and `ignoreEnvironment` replace the
 * suite's lists for this metric alone.
 * @typedef {object} MetricSettings
 * @property {string} [label]
 * @property {"lower" | "higher"} [direction]
 * @property {string} [unit]
 * @property {number} [order]
 * @property {string[]} [splitEnvironment]
 * @property {string[]} [ignoreEnvironment]
 */

/**
 * A dimension's settings.
 * @typedef {{ label?: string, order?: number }} DimensionSettings
 */

/**
 * The settings that apply to every suite at the top level, or to one suite under `suites`.
 * @typedef {object} Settings
 * @property {string} [names] a regular expression whose named groups read an untyped name
 * @property {string} [label] a template for a benchmark's label
 * @property {string} [lineLabel] a template for a line's label inside its chart
 * @property {Map<string, MetricSettings>} [metrics]
 * @property {Map<string, DimensionSettings>} [dimensions]
 * @property {string} [colorBy]
 * @property {string} [dashBy]
 * @property {string[]} [ignoreEnvironment]
 * @property {string[]} [splitEnvironment]
 * @property {number} [smoothing]
 */

/**
 * A link the masthead shows, such as one back to the project's documentation.
 * @typedef {{ label: string, url: string }} SiteLink
 */

/**
 * A setting that breaks a rule; `suite` names the suite whose own settings hold it, if any.
 * @typedef {{ suite: string | null, message: string }} Problem
 */

/**
 * The page's settings, checked.
 * @typedef {object} Config
 * @property {string | null} title
 * @property {string | null} dataUrl
 * @property {SiteLink[]} links
 * @property {number} threshold
 * @property {Settings} defaults
 * @property {Map<string, Settings>} suites
 * @property {Problem[]} problems
 */

/**
 * One suite's settings: its own over the top-level ones, ready to read runs with.
 * @typedef {object} SuiteSettings
 * @property {RegExp | null} names
 * @property {string | null} label
 * @property {string | null} lineLabel
 * @property {Map<string, MetricSettings>} metrics
 * @property {Map<string, DimensionSettings>} dimensions
 * @property {string | null} colorBy
 * @property {string | null} dashBy
 * @property {Set<string>} ignoreEnvironment
 * @property {Set<string>} splitEnvironment
 * @property {number} smoothing
 * @property {string[]} problems the problems in the settings this suite reads
 */

/** @typedef {(path: readonly string[], rule: string) => void} Report */

export const DEFAULT_THRESHOLD = 0.05;

// Keys that apply to the page as a whole, so they are not settings a suite can override.
const PAGE_KEYS = new Set(["title", "dataUrl", "links", "threshold", "suites"]);

/**
 * Reads a parsed `benchtrail.json`.
 * @param {unknown} raw
 * @returns {Config}
 */
export function readConfig(raw) {
  /** @type {Problem[]} */
  const problems = [];
  /** @type {Config} */
  const config = { title: null, dataUrl: null, links: [], threshold: DEFAULT_THRESHOLD, defaults: {}, suites: new Map(), problems };
  /** @type {(suite: string | null) => Report} */
  const reporter = (suite) => (path, rule) => problems.push({ suite, message: `The setting ${settingPath(path)} ${rule}.` });
  const report = reporter(null);
  if (!isObject(raw)) {
    problems.push({ suite: null, message: "The settings must be a JSON object." });
    return config;
  }

  if (raw.title !== undefined) config.title = text(raw.title, ["title"], report) ?? null;
  if (raw.dataUrl !== undefined) config.dataUrl = text(raw.dataUrl, ["dataUrl"], report) ?? null;
  if (raw.links !== undefined) config.links = readLinks(raw.links, report);
  if (raw.threshold !== undefined) {
    if (typeof raw.threshold === "number" && Number.isFinite(raw.threshold) && raw.threshold >= 0) config.threshold = raw.threshold;
    else report(["threshold"], "must be a number of at least 0");
  }
  if (raw.suites !== undefined) {
    if (!isObject(raw.suites)) report(["suites"], "must map suite names to their settings");
    else
      for (const [name, own] of Object.entries(raw.suites)) {
        if (isObject(own)) config.suites.set(name, readSettings(own, ["suites", name], reporter(name)));
        else reporter(name)(["suites", name], "must be an object");
      }
  }
  config.defaults = readSettings(Object.fromEntries(Object.entries(raw).filter(([key]) => !PAGE_KEYS.has(key))), [], report);
  return config;
}

/**
 * The masthead's links, keeping each one that holds.
 * A link's address is relative to the page, such as `../` for a site the dashboard sits in, or an
 * absolute http(s) address.
 * @param {unknown} raw
 * @param {Report} report
 * @returns {SiteLink[]}
 */
function readLinks(raw, report) {
  if (!Array.isArray(raw)) {
    report(["links"], "must be a list of links");
    return [];
  }
  /** @type {SiteLink[]} */
  const links = [];
  for (const [i, link] of raw.entries()) {
    const at = ["links", String(i)];
    if (!isObject(link)) {
      report(at, 'must be an object with a "label" and a "url"');
      continue;
    }
    const label = text(link.label, [...at, "label"], report);
    const url = text(link.url, [...at, "url"], report);
    for (const key of Object.keys(link)) if (key !== "label" && key !== "url") report([...at, key], "is not a link setting");
    if (url !== undefined && !webAddress(url)) report([...at, "url"], "must be a relative address or an http(s) one");
    else if (label !== undefined && url !== undefined) links.push({ label, url });
  }
  return links;
}

/**
 * Whether an address leads to a web page: relative to the page, or absolute over http(s).
 * @param {string} url
 */
function webAddress(url) {
  try {
    return ["http:", "https:"].includes(new URL(url, "https://page.invalid/").protocol);
  } catch {
    return false;
  }
}

/**
 * One scope's settings, keeping each value that holds.
 * @param {Record<string, unknown>} raw
 * @param {readonly string[]} at
 * @param {Report} report
 * @returns {Settings}
 */
function readSettings(raw, at, report) {
  /** @type {Settings} */
  const settings = {};
  for (const [key, value] of Object.entries(raw)) {
    const path = [...at, key];
    switch (key) {
      case "names": {
        const source = text(value, path, report);
        const error = source === undefined ? null : patternError(source);
        if (error) report(path, `is not a valid regular expression: ${error}`);
        else if (source !== undefined) settings.names = source;
        break;
      }
      case "label":
      case "lineLabel":
      case "colorBy":
      case "dashBy": {
        const checked = text(value, path, report);
        if (checked !== undefined) settings[key] = checked;
        break;
      }
      case "metrics":
        settings.metrics = entries(value, path, report, (metric, where) => {
          /** @type {MetricSettings} */
          const checked = {};
          for (const [field, given] of Object.entries(metric)) {
            if (field === "label" || field === "unit") {
              const string = text(given, [...where, field], report);
              if (string !== undefined) checked[field] = string;
            } else if (field === "direction") {
              if (given === "lower" || given === "higher") checked.direction = given;
              else report([...where, field], 'must be "lower" or "higher"');
            } else if (field === "order") {
              if (typeof given === "number" && Number.isFinite(given)) checked.order = given;
              else report([...where, field], "must be a number");
            } else if (field === "splitEnvironment" || field === "ignoreEnvironment") {
              const names = environmentNames(given, [...where, field], report);
              if (names) checked[field] = names;
            } else report([...where, field], "is not a metric setting");
          }
          return checked;
        });
        break;
      case "dimensions":
        settings.dimensions = entries(value, path, report, (dimension, where) => {
          /** @type {DimensionSettings} */
          const checked = {};
          for (const [field, given] of Object.entries(dimension)) {
            if (field === "label") {
              const string = text(given, [...where, field], report);
              if (string !== undefined) checked.label = string;
            } else if (field === "order") {
              if (typeof given === "number" && Number.isFinite(given)) checked.order = given;
              else report([...where, field], "must be a number");
            } else report([...where, field], "is not a dimension setting");
          }
          return checked;
        });
        break;
      case "ignoreEnvironment":
      case "splitEnvironment": {
        const names = environmentNames(value, path, report);
        if (names) settings[key] = names;
        break;
      }
      case "smoothing":
        if (SMOOTHING.some((option) => option.key === value)) settings.smoothing = /** @type {number} */ (value);
        else report(path, `must be one of ${SMOOTHING.map((option) => option.key).join(", ")}`);
        break;
      default:
        report(path, PAGE_KEYS.has(key) ? "applies to the whole page, so it belongs at the top level" : "is not a setting");
    }
  }
  return settings;
}

/**
 * The settings one suite reads runs with: its own over the top-level ones.
 * A suite's metric or dimension entry overrides the top-level entry of the same name field by
 * field, so it never drops a field it does not give.
 * @param {Config} config
 * @param {string} name
 * @returns {SuiteSettings}
 */
export function suiteSettings(config, name) {
  const own = config.suites.get(name) ?? {};
  const merged = { ...config.defaults, ...own };
  return {
    names: merged.names === undefined ? null : new RegExp(merged.names),
    label: merged.label ?? null,
    lineLabel: merged.lineLabel ?? null,
    metrics: mergeEntries(config.defaults.metrics, own.metrics),
    dimensions: mergeEntries(config.defaults.dimensions, own.dimensions),
    colorBy: merged.colorBy ?? null,
    dashBy: merged.dashBy ?? null,
    ignoreEnvironment: new Set(merged.ignoreEnvironment ?? []),
    splitEnvironment: new Set(merged.splitEnvironment ?? []),
    smoothing: merged.smoothing ?? 0,
    problems: config.problems.filter((problem) => problem.suite === null || problem.suite === name).map((problem) => problem.message),
  };
}

/**
 * Merges named entries field by field, with the suite's own values over the top-level ones.
 * @template {object} T
 * @param {Map<string, T> | undefined} shared
 * @param {Map<string, T> | undefined} own
 * @returns {Map<string, T>}
 */
function mergeEntries(shared, own) {
  const merged = new Map(shared);
  for (const [name, entry] of own ?? []) merged.set(name, { ...merged.get(name), ...entry });
  return merged;
}

/**
 * Each entry of an object of named settings, as `read` checks it.
 * @template T
 * @param {unknown} value
 * @param {readonly string[]} path
 * @param {Report} report
 * @param {(entry: Record<string, unknown>, path: readonly string[]) => T} read
 * @returns {Map<string, T> | undefined}
 */
function entries(value, path, report, read) {
  if (!isObject(value)) {
    report(path, "must map names to their settings");
    return undefined;
  }
  /** @type {Map<string, T>} */
  const checked = new Map();
  for (const [name, entry] of Object.entries(value)) {
    if (isObject(entry)) checked.set(name, read(entry, [...path, name]));
    else report([...path, name], "must be an object");
  }
  return checked;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} path
 * @param {Report} report
 * @returns {string[] | undefined}
 */
function environmentNames(value, path, report) {
  if (Array.isArray(value) && value.every((name) => typeof name === "string")) return value;
  report(path, "must be a list of environment names");
  return undefined;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} path
 * @param {Report} report
 * @returns {string | undefined}
 */
function text(value, path, report) {
  if (typeof value === "string") return value;
  report(path, "must be a string");
  return undefined;
}

/**
 * Why a regular expression does not compile, or null when it does.
 * @param {string} source
 */
function patternError(source) {
  try {
    new RegExp(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// A setting's path as `benchtrail.json` spells it, with keys that are not plain names quoted, such
// as metrics["peak rss"].label.
/** @param {readonly string[]} path */
function settingPath(path) {
  const parts = path.map((key, i) => {
    if (/^\d+$/.test(key)) return `[${key}]`;
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${i ? "." : ""}${key}` : `[${JSON.stringify(key)}]`;
  });
  return `\`${parts.join("")}\``;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
