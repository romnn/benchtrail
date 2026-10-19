// benchtrail renders a github-action-benchmark history (`window.BENCHMARK_DATA`) as a dashboard.
// It needs no build step: ECharts comes from the CDN script tag in index.html, and the page's own
// modules load from the `benchtrail/` directory beside this one.
//
// Each recorded entry becomes an observation: a set of named dimensions, a metric, a value, and the
// environment it ran in.
// Typed entries carry these in `extra` as JSON under a `benchtrail` key; untyped entries fall back
// to a configured name pattern, or to their name as the only dimension.

import { changeElement, h, icon, safeUrl } from "./benchtrail/dom.js";
import { displayUnit, FAMILY_LABELS, formatDate, formatDateTime, formatTick, formatValue, parseUnit, timeFormat, unitFactor } from "./benchtrail/format.js";

const echarts = window.echarts;
const PAGE_SIZE = 30;
// Past these, the readout under a chart and the grid of charts fold behind a "show all" toggle.
const READOUT_ROWS = 8;
const CHART_LIMIT = 12;
const CHANGES_SHOWN = 5;
const HISTORY_COLUMNS = 6;
// Change detection compares each value with the median of up to BASELINE_RUNS earlier values in
// its regime, and confirms a shift with the median of CONFIRM_RUNS values starting at the run.
const BASELINE_RUNS = 20;
const MIN_BASELINE = 8;
const CONFIRM_RUNS = 3;
// How many noise widths a confirmed shift must exceed, on top of the configured threshold.
const NOISE_WIDTHS = 4;
// The spread of a few values usually understates their noise, so the limit widens by a factor of
// 1 + SHORT_BASELINE / n for a baseline of n values.
const SHORT_BASELINE = 3;
const LOG_SPAN = 20;
// Past this many lines, the page opens on the ranked movers table instead of charts.
const MOVERS_FROM = 48;
const MOVERS_PAGE = 30;
// Values at each end of the window whose medians give a line's net change.
const MOVER_ENDS = 5;
const SLOTS = 8;
const DASHES = ["solid", "dashed", "dotted"];

// Tools whose values github-action-benchmark treats as "bigger is better"; every other tool
// records times or sizes.
const BIGGER_IS_BETTER = new Set(["customBiggerIsBetter", "benchmarkjs", "pytest"]);

const RANGES = [
  { key: "30", label: "Last 30", count: 30 },
  { key: "100", label: "Last 100", count: 100 },
  { key: "all", label: "All", count: Infinity },
];
const SCALES = [
  { key: "absolute", label: "Absolute" },
  { key: "change", label: "Change" },
];
// Window sizes for the rolling median, in runs; odd, so each window centers on its run.
const SMOOTHING = [
  { key: 0, label: "Off" },
  { key: 5, label: "5 runs" },
  { key: 11, label: "11 runs" },
  { key: 21, label: "21 runs" },
];
const READOUTS = [
  { key: "basic", label: "Value and change" },
  { key: "detailed", label: "With spread and baseline" },
];
const AXES = [
  { key: "run", label: "By run" },
  { key: "date", label: "By date" },
];

// Settings a config may give for every suite at its top level, or for one suite under `suites`.
const SETTING_KEYS = ["names", "label", "metrics", "dimensions", "colorBy", "dashBy", "ignoreEnvironment", "smoothing"];

// Filter tokens keep each value's type, so the number 4 and the string "4" stay apart, and the
// token for "no value" cannot equal any value's.
const MISSING = "\u0000missing";

const config = readConfig();
const narrow = matchMedia("(max-width: 720px)");
const state = {
  suite: null,
  section: null,
  range: "all",
  scale: "absolute",
  axis: "run",
  hiddenMetrics: new Set(),
  // Dimension key to the set of value tokens that are filtered out.
  hidden: new Map(),
  // Undefined picks automatically, an empty string means none, otherwise a dimension key.
  colorBy: undefined,
  dashBy: undefined,
  run: null,
  zoom: null,
  query: "",
  shown: PAGE_SIZE,
  pending: null,
  list: false,
  onlyChanges: false,
  sort: null,
  more: false,
  options: false,
  notes: false,
  // Rolling median window in runs, or 0 for raw values; a suite's config may set the default.
  smooth: null,
  // The open filter menu, as { key, focus, query }, or null.
  menu: null,
  allCharts: false,
  // Undefined picks charts or movers by the number of lines.
  layout: undefined,
  moversShown: MOVERS_PAGE,
  // The changes list is a one-line summary until opened; open shows the latest few, all shows every one.
  changes: "closed",
  // Charts whose readout shows every line.
  openReadouts: new Set(),
};

let data = null;
let suites = [];
let suite = null;
let section = null;
let view = null;
let charts = [];
let trail = null;
let zoomTimer = 0;

async function boot() {
  window.addEventListener("error", (event) => reportFailure(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportFailure(event.reason));
  wireTheme();
  if (!echarts) {
    showProblem(
      "The chart library did not load",
      "This page loads ECharts from cdn.jsdelivr.net. Check the network connection or any content blocker, then reload.",
    );
    return;
  }
  document.getElementById("summary").textContent = "Loading benchmark history…";
  try {
    data = await loadHistory(config.dataUrl);
  } catch (error) {
    showProblem("The benchmark history did not load", error.message);
    return;
  }
  suites = Object.entries(data.entries ?? {})
    .filter(([, runs]) => Array.isArray(runs) && runs.length > 0)
    .map(([name, runs]) => buildSuite(name, runs));
  suites = suites.filter((s) => s.sections.length > 0);
  if (suites.length === 0) {
    showProblem("No runs recorded yet", "The history file has no benchmark results. They appear after github-action-benchmark records its first run.");
    return;
  }
  for (const s of suites) for (const problem of s.problems.keys()) console.warn(`benchtrail: ${s.name}: ${problem}`);

  readUrl();
  suite = suites.find((s) => s.name === state.suite) ?? suites[0];
  state.suite = suite.name;
  section = findSection(suite, state.section);
  state.section = sectionWanted(section);
  applyPendingUrl();

  // Canvas text keeps whatever font is ready when it draws, so wait briefly for the web font.
  await Promise.race([document.fonts?.ready, new Promise((resolve) => setTimeout(resolve, 1500))]);

  renderMasthead();
  document.getElementById("main").hidden = false;
  document.getElementById("controls").hidden = false;
  wireControls();
  render();
}

// Configuration and loading

function readConfig() {
  let raw = {};
  try {
    raw = JSON.parse(document.getElementById("benchtrail-config")?.textContent || "{}");
  } catch (error) {
    console.warn("benchtrail: ignoring the config block because it is not valid JSON", error);
  }
  const fromQuery = new URLSearchParams(location.search).get("data");
  const defaults = {};
  for (const key of SETTING_KEYS) if (raw[key] !== undefined) defaults[key] = raw[key];
  return {
    title: raw.title ?? null,
    // The history is loaded as a script, so a URL from the query string must stay on this origin;
    // otherwise any link to the page could run foreign code on it.
    dataUrl: fromQuery && safeDataPath(fromQuery) ? fromQuery : (raw.dataUrl ?? "data.js"),
    threshold: Number.isFinite(Number(raw.threshold)) ? Number(raw.threshold) : 0.05,
    defaults,
    suites: isPlainObject(raw.suites) ? raw.suites : {},
  };
}

// A suite's own settings override the top-level ones; metric and dimension entries merge by key.
function suiteSettings(name) {
  const own = isPlainObject(config.suites[name]) ? config.suites[name] : {};
  const merged = { ...config.defaults, ...own };
  merged.metrics = { ...plainObject(config.defaults.metrics), ...plainObject(own.metrics) };
  merged.dimensions = { ...plainObject(config.defaults.dimensions), ...plainObject(own.dimensions) };
  merged.ignoreEnvironment = new Set(Array.isArray(merged.ignoreEnvironment) ? merged.ignoreEnvironment : []);
  let names = null;
  try {
    if (merged.names) names = new RegExp(merged.names);
  } catch (error) {
    console.warn(`benchtrail: ignoring the name pattern for ${name} because it is not a valid regex`, error);
  }
  merged.names = names;
  return merged;
}

// A data path from the query string must be a relative path to a .js file on this origin; the
// page config may name any source, since its author controls the page.
function safeDataPath(url) {
  return /^[\w./-]+\.js$/.test(url) && !url.includes("//") && sameOrigin(url);
}

function sameOrigin(url) {
  try {
    const target = new URL(url, location.href);
    return target.origin === location.origin && target.protocol === location.protocol;
  } catch {
    return false;
  }
}

function loadHistory(url) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => {
      if (window.BENCHMARK_DATA?.entries) resolve(window.BENCHMARK_DATA);
      else reject(new Error(`${url} loaded, but it does not define window.BENCHMARK_DATA.`));
    };
    script.onerror = () =>
      reject(
        new Error(
          `Could not load ${url}. Check that github-action-benchmark has pushed its history next to this page, or point "dataUrl" in the page's config block at it.`,
        ),
      );
    document.head.append(script);
  });
}

// Observations

// Reads one recorded entry into its benchmark identity, dimensions, metric, and environment.
// The action stores `extra` as a string, so typed metadata arrives as JSON text.
// Every tag map is a null-prototype object, so a dimension named `toString` or `__proto__` is an
// ordinary key.
function readEntry(entry, settings, note) {
  const name = String(entry.name ?? "");
  const extra = typeof entry.extra === "string" ? entry.extra : null;
  let parsed = null;
  if (extra?.trimStart().startsWith("{")) {
    try {
      parsed = JSON.parse(extra);
    } catch {
      parsed = null;
    }
  }

  // Typed entry
  if (isPlainObject(parsed) && Object.hasOwn(parsed, "benchtrail")) {
    const typed = readTyped(parsed.benchtrail);
    const text = typeof parsed.text === "string" ? parsed.text : null;
    if (typed.ok) return { ...typed.value, text };
    // A payload that does not validate keeps its raw history, apart from every other history, so a
    // broken producer never merges into or splits a good one.
    note(`${name}: ${typed.error}; it is shown on its own, by name.`);
    return {
      benchmarkId: `\u0000invalid\u0000${name}`,
      dimensions: tags({ benchmark: name }),
      metricId: "",
      metricLabel: null,
      direction: null,
      environment: tags({}),
      text,
    };
  }

  // Untyped entry, read through the configured name pattern when it matches
  const groups = settings.names?.exec(name)?.groups;
  if (groups) {
    const { metric = "", ...rest } = groups;
    const dimensions = tags({});
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) dimensions[key] = value;
    return { benchmarkId: null, dimensions, metricId: metric.trim(), metricLabel: null, direction: null, environment: tags({}), text: extra };
  }
  return { benchmarkId: null, dimensions: tags({ benchmark: name }), metricId: "", metricLabel: null, direction: null, environment: tags({}), text: extra };
}

// Validates version 1 of the typed payload.
// Unknown properties are allowed, so later additions stay readable; recognized ones must be
// valid when present, and an invalid one rejects the whole payload rather than being dropped.
function readTyped(payload) {
  if (!isPlainObject(payload)) return { ok: false, error: "extra.benchtrail is not an object" };
  if (payload.version !== 1) return { ok: false, error: `extra.benchtrail has unsupported version ${JSON.stringify(payload.version)}` };
  const dimensions = Object.hasOwn(payload, "dimensions") ? readTags(payload.dimensions) : tags({});
  if (!dimensions) return { ok: false, error: "extra.benchtrail.dimensions must map names to strings, finite numbers, or booleans" };
  const environment = Object.hasOwn(payload, "environment") ? readTags(payload.environment) : tags({});
  if (!environment) return { ok: false, error: "extra.benchtrail.environment must map names to strings, finite numbers, or booleans" };
  const metric = payload.metric;
  if (!isPlainObject(metric) || typeof metric.id !== "string" || metric.id === "") {
    return { ok: false, error: "extra.benchtrail.metric.id must be a non-empty string" };
  }
  if (Object.hasOwn(metric, "direction") && !["lower", "higher", "unknown"].includes(metric.direction)) {
    return { ok: false, error: `extra.benchtrail.metric.direction must be "lower", "higher", or "unknown"` };
  }
  if (Object.hasOwn(payload, "benchmarkId") && (typeof payload.benchmarkId !== "string" || payload.benchmarkId === "")) {
    return { ok: false, error: "extra.benchtrail.benchmarkId must be a non-empty string" };
  }
  return {
    ok: true,
    value: {
      benchmarkId: payload.benchmarkId ?? null,
      dimensions,
      metricId: metric.id,
      metricLabel: typeof metric.label === "string" && metric.label ? metric.label : null,
      direction: metric.direction ?? null,
      environment,
    },
  };
}

function readTags(value) {
  if (!isPlainObject(value)) return null;
  for (const item of Object.values(value)) {
    const scalar = typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item));
    if (!scalar) return null;
  }
  return tags(value);
}

// A null-prototype copy of a tag map.
function tags(source) {
  return Object.assign(Object.create(null), source);
}

// The direction a tool implies for an entry without a declared one.
// The custom tools state it outright; the other tools record times and sizes, except that a rate
// such as MB/s or ops/sec is a throughput, where higher is better.
function impliedDirection(tool, unit) {
  if (tool === "customBiggerIsBetter") return "higher";
  if (tool === "customSmallerIsBetter") return "lower";
  if (BIGGER_IS_BETTER.has(tool) || /\/\s*(s|sec|secs|second|seconds)$/i.test(unit.trim())) return "higher";
  return "lower";
}

// Model

function buildSuite(name, rawRuns) {
  const settings = suiteSettings(name);
  const problems = new Map();
  const note = (message) => problems.set(message, (problems.get(message) ?? 0) + 1);
  const valid = rawRuns.filter((raw) => isPlainObject(raw));
  if (valid.length < rawRuns.length) note(`${rawRuns.length - valid.length} recorded runs are not objects and are skipped.`);
  const runs = valid.map((raw, index) => normalizeRun(raw, index));

  // Read every entry once, before anything is keyed by it.
  const observations = [];
  for (const [index, raw] of valid.entries()) {
    const entries = Array.isArray(raw.benches) ? raw.benches : [];
    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        note(`run ${runs[index].short} has an entry that is not an object; it is skipped.`);
        continue;
      }
      const observation = readEntry(entry, settings, note);
      observations.push({ index, entry, tool: raw.tool, unit: String(entry.unit ?? ""), ...observation });
    }
  }

  // Group the observations into metrics and histories, in order of first appearance.
  const metrics = new Map();
  const histories = new Map();
  for (const o of observations) {
    const metric = metricFor(metrics, o.metricId, o.unit, settings);
    if (o.metricLabel) metric.rowLabel = o.metricLabel;
    if (o.direction) metric.explicit.add(o.direction);
    else metric.implied.add(impliedDirection(o.tool, o.unit));

    // A history is one benchmark measured in one metric.
    // An explicit id keeps a benchmark's history together while its dimensions change; without
    // one, the dimensions themselves are its identity.
    // The environment never takes part, so a history keeps its identity across a toolchain change.
    const benchmark = o.benchmarkId !== null ? `id:${o.benchmarkId}` : `dims:${canonical(o.dimensions)}`;
    const key = `${metric.key}\u0001${benchmark}`;
    let history = histories.get(key);
    if (!history) {
      history = {
        key,
        metric,
        benchmarkId: o.benchmarkId,
        name: "",
        observed: new Array(runs.length).fill(false),
        values: new Array(runs.length).fill(null),
        ranges: new Array(runs.length).fill(null),
        texts: new Array(runs.length).fill(null),
        dimsAt: new Array(runs.length).fill(null),
        envAt: new Array(runs.length).fill(null),
        segment: new Array(runs.length).fill(null),
        change: new Array(runs.length).fill(null),
        boundary: new Array(runs.length).fill(null),
      };
      histories.set(key, history);
    }
    // One run measures a benchmark once per metric.
    // Concurrent variants, such as two operating systems in one workflow, belong in dimensions.
    if (history.observed[o.index]) {
      const where = o.benchmarkId !== null ? "under the same benchmark id" : "with the same dimensions";
      const hint =
        canonical(history.envAt[o.index]) !== canonical(o.environment)
          ? " Its entries differ only in their environment; record concurrent variants as dimensions."
          : "";
      note(`${o.entry.name} is recorded more than once in run ${runs[o.index].short} ${where}; the page keeps the first value.${hint}`);
      continue;
    }
    history.observed[o.index] = true;
    history.name = String(o.entry.name ?? "");
    history.dimsAt[o.index] = o.dimensions;
    history.envAt[o.index] = o.environment;
    history.texts[o.index] = o.text;
    history.ranges[o.index] = rangeText(o.entry.range, o.unit, o.tool);
    const value = numeric(o.entry.value);
    const scaled = value === null ? null : value * unitFactor(o.unit, metric.unit);
    if (scaled !== null && Number.isFinite(scaled)) history.values[o.index] = scaled;
  }

  resolveMetrics(metrics, settings, note);
  for (const history of histories.values()) {
    trace(history, settings);
    detect(history);
  }

  // Runs are named by short commit SHA, with a suffix for re-runs of the same commit, so a link
  // can name each one.
  const seen = new Map();
  for (const run of runs) {
    const count = seen.get(run.short) ?? 0;
    seen.set(run.short, count + 1);
    run.key = count === 0 ? run.short : `${run.short}~${count + 1}`;
  }

  const sections = buildSections([...histories.values()], settings);
  return { name, runs, metrics, sections, settings, problems };
}

// A recorded spread, with the recorded unit added when the spread is a bare number, since values
// are rescaled to the metric's unit while the spread is not.
// pytest records a duration spread beside a throughput value, so its spread stays as recorded.
function rangeText(range, unit, tool) {
  if (range === undefined || range === null || range === "") return null;
  const text = String(range);
  if (tool !== "pytest" && unit && /^±?\s*[\d.,]+$/.test(text.trim())) return `${text} ${unit}`;
  return text;
}

// Metrics are keyed by id and unit family, so one id recorded in seconds and in ops/s never
// shares an axis, while seconds and milliseconds do.
function metricFor(metrics, id, unit, settings) {
  const parsed = parseUnit(unit);
  const family = parsed ? `${parsed.family}|${parsed.tail}` : `raw|${unit}`;
  const key = `${id}\u0000${family}`;
  let metric = metrics.get(key);
  if (!metric) {
    const preferred = settings.metrics[id]?.unit;
    const target = typeof preferred === "string" ? parseUnit(preferred) : null;
    const canonicalUnit = target && parsed && target.family === parsed.family && target.tail === parsed.tail ? preferred : unit;
    metric = { key, id, unit: canonicalUnit, rowLabel: null, explicit: new Set(), implied: new Set(), direction: "lower", label: "", slug: "" };
    metrics.set(key, metric);
  }
  return metric;
}

// Direction comes from the entries, then the config, then the tool that recorded them.
// Conflicting declarations leave it unknown rather than letting the latest run rewrite history.
function resolveMetrics(metrics, settings, note) {
  for (const metric of metrics.values()) {
    const configured = settings.metrics[metric.id] ?? {};
    const name = metric.id || metric.unit || "values";
    if (metric.explicit.size === 1) {
      metric.direction = [...metric.explicit][0];
    } else if (metric.explicit.size > 1) {
      metric.direction = "unknown";
      note(`metric ${name} declares conflicting directions; its changes are shown without a verdict.`);
    } else if (["lower", "higher"].includes(configured.direction)) {
      metric.direction = configured.direction;
    } else if (metric.implied.size === 1) {
      metric.direction = [...metric.implied][0];
    } else {
      metric.direction = "unknown";
      note(`metric ${name} was recorded by tools with opposite directions; set its direction in the config.`);
    }
    metric.label = configured.label ?? metric.rowLabel ?? metricLabel(metric.id, metric.unit);
  }
  const counts = countBy([...metrics.values()], (m) => m.label);
  for (const metric of metrics.values()) {
    if (counts.get(metric.label) > 1) metric.label = `${metric.label} (${metric.unit})`;
  }
  // Links name a metric by its id, or by its unit when the id is empty, never by its label.
  // Metrics are in order of first appearance, so the first family of an id keeps the plain id
  // and a family recorded later gets its unit added, which keeps existing links stable.
  const taken = new Set();
  for (const metric of metrics.values()) {
    const plain = metric.id || metric.unit || "value";
    // `~` is the empty selection in a link, so a metric named that way, or one that already starts
    // with the escape prefix, is prefixed.
    const base = plain === "~" || plain.startsWith("s:") ? `s:${plain}` : plain;
    let slug = taken.has(base) ? `${base}@${metric.unit}` : base;
    for (let n = 2; taken.has(slug); n += 1) slug = `${base}@${metric.unit}~${n}`;
    taken.add(slug);
    metric.slug = slug;
  }
}

// Walks one history in run order: splits it into comparable segments and computes each value's
// change against the previous value in the same segment.
// A segment ends when the dimensions or the environment change, so no automatic verdict compares
// runs across a toolchain upgrade or a changed parameter.
function trace(history, settings) {
  let segment = 0;
  let previousIndex = -1;
  let previousPrint = null;
  let previousValue = null;
  for (let i = 0; i < history.observed.length; i += 1) {
    if (!history.observed[i]) continue;
    const env = omit(history.envAt[i], settings.ignoreEnvironment);
    const print = `${canonical(history.dimsAt[i])}\u0000${canonical(env)}`;
    if (previousPrint !== null && print !== previousPrint) {
      segment += 1;
      previousValue = null;
      history.boundary[i] = [
        ...describeChanges(history.dimsAt[previousIndex], history.dimsAt[i]),
        ...describeChanges(omit(history.envAt[previousIndex], settings.ignoreEnvironment), env),
      ];
    }
    history.segment[i] = segment;
    previousIndex = i;
    previousPrint = print;
    const value = history.values[i];
    if (value === null) continue;
    const change = previousValue !== null && previousValue !== 0 ? relative(value, previousValue) : null;
    if (Number.isFinite(change)) history.change[i] = change;
    previousValue = value;
  }
  history.keys = new Set(history.dimsAt.filter(Boolean).flatMap((dims) => Object.keys(dims)));
}

// Finds the runs where a history's level shifted, and whether that made it worse or better.
//
// Each value is compared with the median of up to BASELINE_RUNS earlier values in its regime,
// where a regime starts at the beginning of a comparison segment or at the previous detected
// shift.
// The candidate level is the median of the run and the next CONFIRM_RUNS - 1 values, against
// that baseline, so a single outlier that returns to normal never counts.
// It must exceed the configured threshold and NOISE_WIDTHS times the uncertainty of the level's
// difference from the baseline.
// That uncertainty is the baseline's median absolute deviation, scaled to a standard deviation,
// times sqrt(1 / baseline + 1 / confirming) for the two medians, and widened for a short baseline.
// The run must also start the shift itself, so a step is reported once, at its onset, with the
// run's own change against the baseline.
//
// Noise that alternates between a few distinct levels can have no median absolute deviation at
// all, so every confirming value must also lie beyond all but one of the baseline's values.
// Allowing one keeps a single earlier outlier from hiding a real step.
//
// A shift at one of the last runs has fewer confirming values and is marked tentative.
// With only two, both must clear the limit on their own.
// A candidate cut short by the end of its segment is never reported, because later runs cannot
// confirm it; an observation without a usable value still ends the segment.
// A comparison that is not finite, such as against a vanishingly small baseline, is never
// reported.
// Without a known direction, a shift is still found but only reported as a move.
function detect(history) {
  const n = history.values.length;
  history.verdicts = new Array(n).fill(null);
  history.baseline = new Array(n).fill(null);
  const direction = history.metric.direction;
  const points = [];
  // The last observed run of each segment, valued or not, where confirmation must stop.
  const segmentEnd = new Map();
  let lastObserved = -1;
  for (let i = 0; i < n; i += 1) {
    if (history.observed[i]) {
      segmentEnd.set(history.segment[i], i);
      lastObserved = i;
    }
    if (history.values[i] !== null) points.push(i);
  }

  let regime = 0;
  for (let p = 0; p < points.length; p += 1) {
    const i = points[p];
    if (p > 0 && history.segment[i] !== history.segment[points[p - 1]]) regime = p;
    const before = points.slice(Math.max(regime, p - BASELINE_RUNS), p).map((k) => history.values[k]);
    if (before.length < MIN_BASELINE) continue;
    const base = median(before);
    // A zero baseline has no relative scale, so it leaves the run unjudged.
    if (!base) continue;
    history.baseline[i] = base;

    // Confirming values
    const end = segmentEnd.get(history.segment[i]);
    const after = [];
    for (let q = p; q < points.length && points[q] <= end && after.length < CONFIRM_RUNS; q += 1) after.push(history.values[points[q]]);
    if (after.length < CONFIRM_RUNS && end < lastObserved) continue;

    // Limit
    const middle = median(after);
    const level = relative(middle, base);
    const own = relative(history.values[i], base);
    const sigma = (1.4826 * median(before.map((x) => Math.abs(x - base)))) / Math.abs(base);
    const spread = Math.sqrt(1 / before.length + 1 / after.length) * (1 + SHORT_BASELINE / before.length);
    const limit = Math.max(config.threshold, NOISE_WIDTHS * 1.25 * sigma * spread);
    if (![level, own, limit].every(Number.isFinite)) continue;
    if (Math.abs(level) <= limit || Math.abs(own) <= limit || Math.sign(own) !== Math.sign(level)) continue;
    if (after.length === 2 && !after.every((x) => Math.sign(relative(x, base)) === Math.sign(level) && Math.abs(relative(x, base)) > limit)) continue;

    // Range gate
    const sorted = [...before].sort((a, b) => a - b);
    const beyond = level > 0 ? (x) => x > sorted.at(-2) : (x) => x < sorted[1];
    if (!after.every(beyond)) continue;

    // Detected shift
    regime = p;
    let kind = "moved";
    if (direction === "higher") kind = level < 0 ? "worse" : "better";
    else if (direction === "lower") kind = level > 0 ? "worse" : "better";
    history.verdicts[i] = { kind, shift: own, tentative: after.length < CONFIRM_RUNS };
  }
}

// The signed change from a reference, scaled by its magnitude, so a rise is positive even for a
// negative reference.
// Dividing before subtracting keeps the difference of two huge values of opposite sign finite;
// the result is still not finite for a vanishingly small reference, which callers reject.
function relative(value, reference) {
  return value / Math.abs(reference) - Math.sign(reference);
}

// The midpoint of two values of opposite sign is their halved sum, and of two values of the same
// sign a half step from the lower one, so neither form can overflow.
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2) return sorted[mid];
  const [a, b] = [sorted[mid - 1], sorted[mid]];
  return Math.sign(a) === Math.sign(b) ? a + (b - a) / 2 : (a + b) / 2;
}

function describeChanges(before, after) {
  const keys = unique([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return keys.filter((key) => token(before?.[key]) !== token(after?.[key])).map((key) => `${key} ${before?.[key] ?? "none"} → ${after?.[key] ?? "none"}`);
}

// Sections group histories that share at least one dimension, directly or through another history.
// Benchmarks with unrelated dimensions, such as two phases measured on different inputs, land in
// separate sections, while a benchmark that gains one dimension stays with its family.
// The metrics of one explicit benchmark id always share a section, even when only some of them
// gain dimensions, so a link to that benchmark keeps showing all of them.
// Without dimensions or an id, a history joins the one section of such histories.
function buildSections(histories, settings) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  const anchors = (history) => [
    ...[...history.keys].map((k) => `k:${k}`),
    ...(history.benchmarkId !== null || !history.keys.size ? [`b:${JSON.stringify(history.benchmarkId)}`] : []),
  ];
  for (const history of histories) {
    const keys = anchors(history);
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (const key of keys.slice(1)) union(keys[0], key);
  }
  const groups = new Map();
  for (const history of histories) {
    const root = find(anchors(history)[0]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(history);
  }

  const sections = [...groups.values()].map((members) => buildSection(members, settings));
  const counts = countBy(sections, (s) => s.label);
  for (const [i, s] of sections.entries()) if (counts.get(s.label) > 1) s.label = `${s.label} ${i + 1}`;
  return sections;
}

// A section's traces split each history by its dimension values, so an observation is always
// drawn, labelled, colored, and filtered by the dimensions it was recorded with, even after its
// benchmark's dimensions changed.
// Traces of one history stay linked through it, which keeps change detection continuous.
function buildSection(histories, settings) {
  const traces = [];
  for (const history of histories) {
    const bySignature = new Map();
    for (let i = 0; i < history.observed.length; i += 1) {
      if (!history.observed[i]) continue;
      const signature = canonical(history.dimsAt[i]);
      // A trace keeps the set of runs it owns rather than a mask over every run, so a benchmark
      // whose dimensions change on every run stays linear in memory.
      if (!bySignature.has(signature)) bySignature.set(signature, { history, dims: history.dimsAt[i], own: new Set() });
      bySignature.get(signature).own.add(i);
    }
    for (const [signature, trace] of bySignature) traces.push({ ...trace, key: `${history.key}\u0002${signature}` });
  }

  // Dimensions in config order, then in order of first appearance.
  const keys = unique(histories.flatMap((history) => [...history.keys]));
  const order = (key) => Number(settings.dimensions[key]?.order ?? Infinity);
  keys.sort((a, b) => order(a) - order(b));

  const dims = keys.map((key) => {
    const values = new Map();
    let missing = false;
    for (const trace of traces) {
      if (!Object.hasOwn(trace.dims, key)) missing = true;
      else if (!values.has(token(trace.dims[key]))) values.set(token(trace.dims[key]), trace.dims[key]);
    }
    const list = [...values.entries()].map(([tok, value]) => ({ token: tok, value, index: 0, text: "", param: "" }));
    // Numbers sort by size; strings and booleans keep their order of appearance.
    if (list.every(({ value }) => typeof value === "number")) list.sort((a, b) => a.value - b.value);
    if (missing) list.push({ token: MISSING, value: undefined, index: 0, text: "", param: "" });
    const texts = shortTexts(list.map(({ value }) => value));
    for (const [i, entry] of list.entries()) {
      entry.index = i;
      entry.text = texts[i];
    }
    // On screen, a string that reads like another value of the dimension is shown quoted.
    const plain = countBy(list, (v) => String(v.value));
    for (const entry of list) {
      entry.param = urlText(entry.value);
      if (plain.get(String(entry.value)) > 1 && typeof entry.value === "string") entry.text = `"${entry.value}"`;
    }
    return { key, label: dimensionLabel(key, settings), values: list, byToken: new Map(list.map((v) => [v.token, v])), varying: list.length > 1 };
  });

  // A section with dimensions is linked by their keys; one without is a single benchmark, linked
  // by its id after `#`, or by `#` alone for the benchmark recorded with neither.
  const benchmarkId = histories[0]?.benchmarkId ?? null;
  const section = {
    label: dims.map((d) => d.label).join(" × ") || "Benchmarks",
    keys,
    link: keys.length ? null : `#${benchmarkId === null ? "" : linkPart(benchmarkId)}`,
    histories,
    traces,
    dims,
    metrics: unique(histories.map((history) => history.metric)),
    settings,
  };
  for (const trace of traces) trace.label = traceLabel(trace, section);
  // Two traces with the same label in one metric get their recorded names to tell them apart.
  // A trace's link slug comes from its identity rather than its label, since labels change as
  // dimensions start or stop varying.
  for (const metric of section.metrics) {
    const members = traces.filter((trace) => trace.history.metric === metric);
    const counts = countBy(members, (trace) => trace.label);
    for (const trace of members) if (counts.get(trace.label) > 1) trace.label = `${trace.label} (${trace.history.name})`;
    for (const trace of members) trace.slug = `${linkPart(metric.slug)}:${traceIdentity(trace)}`;
  }
  return section;
}

// A trace's identity in a link: its benchmark id after `#` when it has one, then its dimensions in
// key order as `key=value`, joined by `/`, with every part escaped so the joins stay unambiguous.
// Together with the metric, these identify exactly one trace, whatever runs are added later.
function traceIdentity(trace) {
  const id = trace.history.benchmarkId;
  const dims = Object.keys(trace.dims)
    .sort()
    .map((key) => `${linkPart(key)}=${linkPart(urlText(trace.dims[key]))}`);
  return [...(id === null ? [] : [`#${linkPart(id)}`]), ...dims].join("/");
}

// A trace's label is the config template when every name it uses is one of the trace's
// dimensions, otherwise the values of the dimensions that vary in its section.
function traceLabel(trace, section) {
  const template = typeof section.settings.label === "string" ? section.settings.label : null;
  if (template) {
    const names = [...template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
    if (names.length && names.every((name) => Object.hasOwn(trace.dims, name))) {
      return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name) => String(trace.dims[name]));
    }
  }
  const parts = section.dims.filter((d) => d.varying).map((d) => valueText(d, trace.dims[d.key]));
  return parts.join(" / ") || trace.history.name;
}

function normalizeRun(raw, index) {
  const commit = isPlainObject(raw.commit) ? raw.commit : {};
  const message = String(commit.message ?? "");
  const id = String(commit.id ?? "");
  // Dates outside what Date can represent would throw when formatted.
  const date = [Number(raw.date), Date.parse(commit.timestamp)].find((ms) => Number.isFinite(ms) && Math.abs(ms) < 8.64e15) ?? 0;
  return {
    index,
    id,
    short: id.slice(0, 7) || `run${index + 1}`,
    message,
    subject: message.split("\n")[0].trim() || "(no commit message)",
    body: message.split("\n").slice(1).join("\n").trim(),
    url: safeUrl(commit.url),
    author: String(commit.author?.name || commit.author?.username || "unknown author"),
    date,
    tool: raw.tool,
  };
}

function metricLabel(id, unit) {
  if (!id) {
    // A unit with a tail, such as MB/s, is a rate rather than a size, so it names itself.
    const parsed = parseUnit(unit);
    return parsed && !parsed.tail ? FAMILY_LABELS[parsed.family] : unit || "Value";
  }
  return humanize(id);
}

function dimensionLabel(key, settings) {
  const label = settings.dimensions[key]?.label;
  return typeof label === "string" && label ? label : humanize(key);
}

function humanize(id) {
  const words = id.replace(/[_]+/g, " ").replace(/\b(cpu|rss|gc|io|ram|ipc|gpu|simd)\b/gi, (word) => word.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// How a dimension value reads inside a label: strings as themselves, numbers and booleans with
// their dimension's name, since a bare `8` says nothing.
function valueText(dim, value) {
  if (value === undefined) return `no ${dim.label.toLowerCase()}`;
  if (typeof value === "number") return `${dim.label.toLowerCase()} ${value}`;
  if (typeof value === "boolean") return value ? dim.label.toLowerCase() : `no ${dim.label.toLowerCase()}`;
  return dim.byToken.get(token(value))?.text ?? value;
}

// Drops a prefix and suffix that every string value shares, cut at a delimiter, so
// `okta.hand-written` and `oxide.hand-written` read as `okta` and `oxide`.
function shortTexts(values) {
  const strings = values.filter((v) => typeof v === "string");
  const fallback = values.map((v) => (v === undefined ? "none" : String(v)));
  if (strings.length < 2 || strings.length !== values.filter((v) => v !== undefined).length) return fallback;
  const delimiter = /[./:_\-\s]/;

  let prefix = strings.reduce((common, s) => {
    let i = 0;
    while (i < common.length && common[i] === s[i]) i += 1;
    return common.slice(0, i);
  });
  let end = prefix.length;
  while (end > 0 && !delimiter.test(prefix[end - 1])) end -= 1;
  prefix = prefix.slice(0, end);

  let suffix = strings.reduce((common, s) => {
    let i = 0;
    while (i < common.length && common[common.length - 1 - i] === s[s.length - 1 - i]) i += 1;
    return common.slice(common.length - i);
  });
  let start = 0;
  while (start < suffix.length && !delimiter.test(suffix[start])) start += 1;
  suffix = suffix.slice(start);

  const short = strings.map((s) => s.slice(prefix.length, s.length - suffix.length));
  if (short.some((s) => s.length === 0) || new Set(short).size !== strings.length) return fallback;
  let next = 0;
  return values.map((v) => (v === undefined ? "none" : short[next++]));
}

// View: the slice of the section that the filters select, and how it is laid out

// The dimensions that can color lines or dash them, given how many distinct styles each provides.
function colorable(d) {
  return d.varying && d.values.length <= SLOTS * 2;
}

function dashable(d, colorDim) {
  return d.varying && d.values.length <= DASHES.length && (!colorDim || colorDim.values.length <= SLOTS);
}

// The configured default window, when it is one of the offered sizes.
function defaultSmoothing() {
  const configured = Number(suite?.settings.smoothing ?? 0);
  return SMOOTHING.some((option) => option.key === configured) ? configured : 0;
}

// The smoothing window in effect: the reader's choice, or the current suite's default until the
// reader picks one, so switching suites follows each suite's own default.
function smoothing() {
  return state.smooth ?? defaultSmoothing();
}

// Picks which dimension colors the lines, which sets their dash, and which split the charts.
// Every varying dimension that neither colors nor dashes splits the charts, so no two lines in one
// chart ever look the same.
function choosePivot() {
  const varying = section.dims.filter((d) => d.varying);
  const size = (d) => d.values.length;
  const pick = (choice, configured, allowed, auto) => {
    if (choice === "") return null;
    if (choice && allowed.some((d) => d.key === choice)) return choice;
    if (typeof configured === "string" && allowed.some((d) => d.key === configured)) return configured;
    return auto();
  };

  const colorChoices = varying.filter(colorable);
  const color = pick(state.colorBy, section.settings.colorBy, colorChoices, () => {
    const fits = colorChoices.filter((d) => size(d) <= SLOTS);
    if (fits.length) return fits.reduce((best, d) => (size(d) > size(best) ? d : best)).key;
    return colorChoices.length ? colorChoices.reduce((best, d) => (size(d) < size(best) ? d : best)).key : null;
  });
  const colorDim = varying.find((d) => d.key === color);
  const dashChoices = varying.filter((d) => d.key !== color && dashable(d, colorDim));
  const dash = pick(state.dashBy, section.settings.dashBy, dashChoices, () => {
    if (!colorDim || !dashChoices.length) return null;
    return dashChoices.reduce((best, d) => (size(d) < size(best) ? d : best)).key;
  });
  const facet = varying.filter((d) => d.key !== color && d.key !== dash).map((d) => d.key);
  return { color, dash, facet };
}

function computeView() {
  const range = RANGES.find((r) => r.key === state.range) ?? RANGES.at(-1);
  const offset = Math.max(0, suite.runs.length - range.count);
  const runs = suite.runs.slice(offset);
  const pivot = choosePivot();
  const metrics = section.metrics.filter((m) => !state.hiddenMetrics.has(m.key));
  const dimsByKey = new Map(section.dims.map((d) => [d.key, d]));
  // A hover index belongs to the previous view's runs, so it never carries over.
  resetHover();

  const passes = (dims) => section.dims.every((d) => !state.hidden.get(d.key)?.has(token(dims[d.key])));

  // Each line keeps the runs in range that its trace owns, in run order, so per-line work scales
  // with its own observations rather than with every run.
  const lines = [];
  for (const trace of section.traces) {
    const history = trace.history;
    if (state.hiddenMetrics.has(history.metric.key) || !passes(trace.dims)) continue;
    const points = [];
    for (const i of trace.own) if (i >= offset) points.push(i);
    if (!points.some((i) => history.values[i] !== null)) continue;
    const facetDims = pivot.facet.map((key) => dimsByKey.get(key));
    const facetValues = facetDims.map((d) => d.byToken.get(token(trace.dims[d.key])));
    lines.push({
      history,
      trace,
      name: trace.key,
      metricId: history.metric.key,
      unit: history.metric.unit,
      points,
      label: trace.label,
      sortKey: trace.slug,
      style: lineStyle(trace, pivot, dimsByKey),
      facet: {
        token: facetValues.map((v) => v.token).join("\u0003"),
        label: facetDims.map((d, i) => valueText(d, facetValues[i].value)).join(" / "),
        order: facetValues.map((v) => v.index),
      },
    });
  }
  // Lines sort by facet, then color, then dash, so tables read in the same order as the charts.
  lines.sort((a, b) => compareOrder(a.facet.order, b.facet.order) || a.style.colorIndex - b.style.colorIndex || a.style.dashIndex - b.style.dashIndex);

  // The first value in the range is the baseline for the change view; a zero baseline has no
  // relative change, so that line is left out of the change view rather than rebased.
  const baseline = new Map();
  for (const line of lines) {
    const first = line.points.find((i) => line.history.values[i] !== null);
    baseline.set(line.name, first === undefined ? null : line.history.values[first]);
  }

  // Runs where a visible history crossed a comparison boundary, with what changed.
  const boundaries = new Map();
  for (const line of lines) {
    for (const i of line.points) {
      // An observation without a usable value still starts its segment, so it keeps its marker.
      const changes = line.history.boundary[i];
      if (!changes) continue;
      boundaries.set(i, unique([...(boundaries.get(i) ?? []), ...changes]));
    }
  }

  let selected = runs.findIndex((run) => state.run && run.key === state.run);
  if (selected < 0) selected = runs.length - 1;
  view = { runs, offset, benches: lines, metrics, baseline, boundaries, selected, pivot, counts: null, moves: null };
}

// A line's color comes from its value of the color dimension and its dash from the dash
// dimension, both by the value's fixed position, so filtering never repaints the lines that stay.
function lineStyle(trace, pivot, dimsByKey) {
  const colorDim = pivot.color ? dimsByKey.get(pivot.color) : null;
  const dashDim = pivot.dash ? dimsByKey.get(pivot.dash) : null;
  const colorIndex = colorDim ? colorDim.byToken.get(token(trace.dims[colorDim.key])).index : 0;
  let dashIndex = dashDim ? dashDim.byToken.get(token(trace.dims[dashDim.key])).index : 0;
  if (!dashDim && colorIndex >= SLOTS) dashIndex = 1;
  const parts = [colorDim, dashDim].filter(Boolean).map((d) => valueText(d, trace.dims[d.key]));
  return {
    slot: colorIndex % SLOTS,
    colorIndex,
    dashIndex,
    dash: DASHES[dashIndex % DASHES.length],
    label: parts.join(" / ") || trace.label,
  };
}

// A line's value and change at a run, read through its trace's own runs, so a history split into
// many traces never copies its full-length arrays once per trace.
function valueAt(line, runIndex) {
  return line.trace.own.has(runIndex) ? line.history.values[runIndex] : null;
}

function changeAt(line, runIndex) {
  return line.trace.own.has(runIndex) ? line.history.change[runIndex] : null;
}

// A line's recorded spread, note, and environment at a run, by ownership rather than by value,
// so they stay readable for an observation whose value is missing.
function rangeAt(line, runIndex) {
  return line.trace.own.has(runIndex) ? line.history.ranges[runIndex] : null;
}

function textAt(line, runIndex) {
  return line.trace.own.has(runIndex) ? line.history.texts[runIndex] : null;
}

function environmentAt(line, runIndex) {
  return line.trace.own.has(runIndex) ? line.history.envAt[runIndex] : null;
}

function badness(metric, change) {
  if (change === null || metric.direction === "unknown") return null;
  return metric.direction === "higher" ? -change : change;
}

// The detected verdict for a line at a run: worse or better at a shift, noise for any other
// value judged against a baseline, unjudged for a value without enough earlier runs to judge it,
// and none where nothing was measured.
function lineVerdict(line, runIndex) {
  if (valueAt(line, runIndex) === null) return "none";
  const detected = line.history.verdicts[runIndex];
  if (detected) return detected.kind;
  if (changeAt(line, runIndex) === null) return "none";
  return line.history.baseline[runIndex] === null ? "unjudged" : "noise";
}

// A verdict from a change ratio alone, against the configured threshold, for comparisons that are
// not change points, such as a value against its baseline.
function verdict(metric, change) {
  const bad = badness(metric, change);
  if (bad === null) return change === null ? "none" : "noise";
  if (bad > config.threshold) return "worse";
  if (bad < -config.threshold) return "better";
  return "noise";
}

// Rendering

// A render requested while another is running, such as from a chart event that a render itself
// triggered, is deferred to the next frame and coalesced, so renders can never recurse or pile up.
let rendering = false;
let renderQueued = false;

function render() {
  if (rendering) {
    queueRender();
    return;
  }
  rendering = true;
  try {
    computeView();
    renderSuites();
    renderFilters();
    renderSummary();
    renderChanges();
    renderTrail();
    renderCharts();
    renderSelected();
    renderMessage();
    renderHistory();
    renderNotes();
    writeUrl();
  } catch (error) {
    reportFailure(error);
  } finally {
    rendering = false;
  }
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

// An unexpected error leaves the page as it was and offers a reload, rather than a half-drawn
// page that silently stops responding.
// It is shown once; later errors are only logged.
let failureShown = false;

const failuresLogged = new Set();

function reportFailure(error) {
  const message = String(error?.stack ?? error);
  if (!failuresLogged.has(message)) {
    failuresLogged.add(message);
    console.error("benchtrail:", error);
  }
  if (failureShown) return;
  failureShown = true;
  const notice = document.getElementById("failure");
  if (!notice) return;
  notice.replaceChildren(
    h("span", {}, "Something went wrong while drawing this page, so it may be out of date."),
    h("button", { type: "button", class: "disclosure", onclick: () => location.reload() }, "Reload"),
  );
  notice.hidden = false;
}

// Runs an event handler so that an error inside it is reported instead of escaping into the
// chart library, where it could interrupt the library's own event dispatch.
function safely(handler) {
  return (...args) => {
    try {
      return handler(...args);
    } catch (error) {
      reportFailure(error);
      return undefined;
    }
  };
}

function renderMasthead() {
  const repo = safeUrl(data.repoUrl);
  const path = repo ? new URL(repo).pathname.split("/").filter(Boolean) : [];
  const name = config.title ?? (path.slice(-2).join("/") || "Benchmarks");
  const link = /** @type {HTMLAnchorElement} */ (document.getElementById("project-link"));
  link.textContent = name;
  if (repo) link.href = repo;
  document.title = name;
}

function renderSummary() {
  const runs = suite.runs;
  const count = `${runs.length} ${runs.length === 1 ? "run" : "runs"}`;
  const span = runs.length === 1 ? formatDate(runs[0].date, true) : `${formatDate(runs[0].date, true)} – ${formatDate(runs.at(-1).date, true)}`;
  document.getElementById("summary").textContent = `${count}, ${span}`;
}

function renderSuites() {
  const nav = document.getElementById("suites");
  nav.hidden = suites.length < 2;
  nav.replaceChildren(
    ...suites.map((s) =>
      h(
        "button",
        {
          type: "button",
          class: "option",
          role: "tab",
          "aria-selected": String(s === suite),
          onclick: () => {
            if (s === suite) return;
            suite = s;
            state.suite = s.name;
            switchSection(s.sections[0]);
          },
        },
        s.name,
      ),
    ),
  );

  const sections = document.getElementById("sections");
  sections.hidden = suite.sections.length < 2;
  sections.replaceChildren(
    ...suite.sections.map((s) =>
      h(
        "button",
        {
          type: "button",
          class: "option",
          role: "tab",
          "aria-selected": String(s === section),
          onclick: () => s !== section && switchSection(s),
        },
        s.label,
      ),
    ),
  );
}

// A link names a section by its dimension keys, which stay put as runs are added.
// When no section has exactly those keys, as after a section gained a dimension, the first
// section with all of them is chosen.
// A section without dimensions is named by its benchmark, which is found again in whichever
// section holds it once it gains dimensions.
function findSection(s, wanted) {
  if (!wanted) return s.sections[0];
  if (wanted.link !== undefined) {
    return (
      s.sections.find((candidate) => candidate.link === wanted.link) ??
      s.sections.find((candidate) =>
        candidate.histories.some((history) => `#${history.benchmarkId === null ? "" : linkPart(history.benchmarkId)}` === wanted.link),
      ) ??
      s.sections[0]
    );
  }
  const { keys } = wanted;
  const keyed = s.sections.filter((candidate) => candidate.keys.length);
  const exact = keyed.find((candidate) => candidate.keys.length === keys.length && keys.every((key) => candidate.keys.includes(key)));
  return exact ?? keyed.find((candidate) => keys.every((key) => candidate.keys.includes(key))) ?? s.sections[0];
}

// Section keys in a link, escaped when they could read as a benchmark link.
function sectionKeyText(key) {
  return key.startsWith("#") || key.startsWith("s:") ? `s:${key}` : key;
}

function sectionWanted(s) {
  return s.link === null ? { keys: s.keys } : { link: s.link };
}

function switchSection(next) {
  section = next;
  state.section = sectionWanted(next);
  state.hiddenMetrics = new Set();
  state.hidden.clear();
  state.menu = null;
  state.layout = undefined;
  state.moversShown = MOVERS_PAGE;
  state.colorBy = undefined;
  state.dashBy = undefined;
  state.run = null;
  state.zoom = null;
  state.sort = null;
  render();
}

function renderFilters() {
  segmented("range", RANGES, state.range, (key) => {
    state.range = key;
    state.zoom = null;
    render();
  });
  segmented("scale", SCALES, state.scale, (key) => {
    state.scale = key;
    render();
  });
  segmented("axis", AXES, state.axis, (key) => {
    state.axis = key;
    render();
  });
  segmented("smooth", SMOOTHING, smoothing(), (key) => {
    state.smooth = key;
    render();
  });
  renderTheme();
  segmented("readout", READOUTS, state.more ? "detailed" : "basic", (key) => {
    state.more = key === "detailed";
    render();
  });

  // Color and dash choices list the dimensions with few enough values to style apart, the same
  // ones the pivot accepts, plus none.
  const varying = section.dims.filter((d) => d.varying);
  const colorDim = varying.find((d) => d.key === view.pivot.color);
  const choices = (dims) => [...dims.map((d) => ({ key: d.key, label: d.label })), { key: "", label: "None" }];
  const colorChoices = varying.filter(colorable);
  const dashChoices = varying.filter((d) => d.key !== view.pivot.color && dashable(d, colorDim));
  document.getElementById("color-group").hidden = colorChoices.length === 0;
  segmented("color", choices(colorChoices), view.pivot.color ?? "", (key) => {
    state.colorBy = key;
    render();
  });
  document.getElementById("dash-group").hidden = dashChoices.length === 0 || !view.pivot.color;
  segmented("dash", choices(dashChoices), view.pivot.dash ?? "", (key) => {
    state.dashBy = key;
    render();
  });

  // Each filter is a list of values that can be toggled.
  // The color and dash dimensions stay inline, since their rows double as the legend; every other
  // filter collapses into a menu, so the header stays one or two lines however many dimensions
  // a suite has.
  const filters = [];
  if (section.metrics.length > 1) {
    filters.push({
      key: "\u0000metric",
      label: "Metric",
      inline: section.metrics.length <= 4,
      items: section.metrics.map((metric) => ({ token: metric.key, text: metric.label, style: null })),
      hidden: state.hiddenMetrics,
      setHidden: (tokens) => {
        state.hiddenMetrics = tokens;
      },
    });
  }
  for (const d of section.dims.filter((d) => d.values.length > 1)) {
    const legend = d.key === view.pivot.color || d.key === view.pivot.dash;
    const style = (value) => {
      if (d.key === view.pivot.color) return { slot: value.index % SLOTS, dash: !view.pivot.dash && value.index >= SLOTS ? "dashed" : "solid" };
      if (d.key === view.pivot.dash) return { slot: null, dash: DASHES[value.index % DASHES.length] };
      return null;
    };
    filters.push({
      key: d.key,
      label: d.label,
      inline: legend,
      items: d.values.map((value) => ({ token: value.token, text: value.token === MISSING ? "none" : value.text, style: style(value) })),
      hidden: state.hidden.get(d.key) ?? new Set(),
      setHidden: (tokens) => state.hidden.set(d.key, tokens),
    });
  }
  // Inline rows first, so the legend keeps its place while menus are opened and closed.
  filters.sort((a, b) => b.inline - a.inline);
  document.getElementById("filters").replaceChildren(...filters.map((filter) => (filter.inline ? inlineFilter(filter) : menuFilter(filter))));
  if (state.menu) restoreMenu();
}

function inlineFilter(filter) {
  return h(
    "div",
    { class: "filter", role: "group", "aria-label": filter.label },
    h("span", { class: "filter-label" }, filter.label),
    // The chips wrap in their own box, so a second line hangs under the first chip, not the label.
    h(
      "span",
      { class: "chips" },
      ...filter.items.map((item) =>
        toggleChip(item.text, !filter.hidden.has(item.token), item.style, () => {
          const next = new Set(filter.hidden);
          if (next.has(item.token)) next.delete(item.token);
          else next.add(item.token);
          filter.setHidden(next);
          render();
        }),
      ),
    ),
  );
}

// A menu button that summarizes the selection, over a panel of checkboxes.
// Each value also has an "only" action, since narrowing to one value is the common case.
// The page re-renders on every change, so the open menu, its search text, and its focus live in
// state and are restored afterwards.
function menuFilter(filter) {
  const total = filter.items.length;
  const visible = filter.items.filter((item) => !filter.hidden.has(item.token));
  const summary =
    visible.length === total
      ? "all"
      : visible.length === 0
        ? "none"
        : visible.length <= 2
          ? visible.map((item) => item.text).join(", ")
          : `${visible.length} of ${total}`;
  const open = state.menu?.key === filter.key;
  const apply = (next, focus) => {
    filter.setHidden(next);
    const panel = document.querySelector(`.menu[data-menu="${CSS.escape(filter.key)}"] .menu-panel`);
    state.menu = { ...state.menu, key: filter.key, focus, scroll: panel?.scrollTop ?? 0 };
    render();
  };

  const button = h(
    "button",
    {
      type: "button",
      class: "menu-button option",
      "aria-expanded": String(open),
      "aria-haspopup": "true",
      onclick: () => {
        // Opening or closing a menu changes no data, so only the filters are drawn again.
        state.menu = open ? null : { key: filter.key, focus: null, query: "", scroll: 0 };
        renderFilters();
      },
    },
    h("span", { class: "filter-label" }, filter.label),
    h("span", { class: "menu-summary" }, summary),
    icon("down", "chevron"),
  );
  if (!open) return h("div", { class: "menu", "data-menu": filter.key }, button);

  const search =
    total > 10
      ? h("input", {
          class: "search menu-search",
          type: "search",
          placeholder: `Filter ${filter.label.toLowerCase()}`,
          "aria-label": `Filter ${filter.label} values`,
          "data-focus": "\u0000search",
          oninput: (event) => {
            state.menu.query = event.target.value;
            filterMenuItems(event.target.closest(".menu"));
          },
        })
      : null;
  const all =
    visible.length < total
      ? h("button", { type: "button", class: "option menu-all", "data-focus": "\u0000all", onclick: () => apply(new Set(), "\u0000all") }, "Show all")
      : null;
  const items = filter.items.map((item) => {
    const id = `menu-${encodeURIComponent(filter.key)}-${encodeURIComponent(item.token)}`;
    return h(
      "div",
      { class: "menu-item", "data-text": item.text.toLowerCase() },
      h("input", {
        type: "checkbox",
        id,
        checked: !filter.hidden.has(item.token),
        "data-focus": item.token,
        onchange: () => {
          const next = new Set(filter.hidden);
          if (next.has(item.token)) next.delete(item.token);
          else next.add(item.token);
          apply(next, item.token);
        },
      }),
      h("label", { for: id }, item.style ? lineKey(item.style) : null, item.text),
      h(
        "button",
        {
          type: "button",
          class: "only",
          "aria-label": `Show only ${item.text}`,
          "data-focus": `\u0000only\u0000${item.token}`,
          onclick: () => apply(new Set(filter.items.map((other) => other.token).filter((tok) => tok !== item.token)), item.token),
        },
        "only",
      ),
    );
  });
  const panel = h("div", { class: "menu-panel", role: "group", "aria-label": filter.label }, search, all, h("div", { class: "menu-items" }, ...items));
  return h("div", { class: "menu", "data-menu": filter.key }, button, panel);
}

// A button that opens or closes a part of the page: a chevron that points at what it reveals,
// then its label.
function disclosure(button, open, label) {
  button.setAttribute("aria-expanded", String(open));
  button.replaceChildren(icon(open ? "down" : "right", "toggle-icon"), label);
}

function filterMenuItems(menu) {
  const query = (state.menu?.query ?? "").trim().toLowerCase();
  for (const item of menu.querySelectorAll(".menu-item")) item.hidden = Boolean(query) && !item.dataset.text.includes(query);
}

// Restores the open menu after a render: its search text, its focus, and a position that keeps
// the panel inside the viewport.
function restoreMenu() {
  const menu = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".menu"))].find((m) => m.dataset.menu === state.menu.key);
  if (!menu) {
    state.menu = null;
    return;
  }
  const search = /** @type {HTMLInputElement | null} */ (menu.querySelector(".menu-search"));
  if (search) {
    search.value = state.menu.query ?? "";
    filterMenuItems(menu);
  }
  const panel = /** @type {HTMLElement} */ (menu.querySelector(".menu-panel"));
  const overflow = panel.getBoundingClientRect().right - (document.documentElement.clientWidth - 16);
  if (overflow > 0) panel.style.left = `${-overflow}px`;
  panel.scrollTop = state.menu.scroll ?? 0;
  const focus = state.menu.focus;
  const focusable = /** @type {NodeListOf<HTMLElement>} */ (menu.querySelectorAll("[data-focus]"));
  const target = [...focusable].find((el) => el.dataset.focus === focus) ?? search ?? menu.querySelector("input");
  target?.focus({ preventScroll: true });
}

function closeMenu(returnFocus) {
  if (!state.menu) return;
  const key = state.menu.key;
  state.menu = null;
  renderFilters();
  if (returnFocus)
    /** @type {HTMLElement | null | undefined} */ (
      [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".menu"))].find((m) => m.dataset.menu === key)?.querySelector(".menu-button")
    )?.focus();
}

function segmented(id, options, current, onChange) {
  document.getElementById(id).replaceChildren(
    ...options.map((option) =>
      h(
        "button",
        {
          type: "button",
          class: "option",
          role: "radio",
          "aria-checked": String(option.key === current),
          onclick: () => option.key !== current && onChange(option.key),
        },
        option.label,
      ),
    ),
  );
}

function toggleChip(label, pressed, style, onClick) {
  const children = style ? [lineKey(style), label] : [label];
  return h("button", { type: "button", class: "option", "aria-pressed": String(pressed), onclick: onClick }, ...children);
}

function lineKey(style) {
  return h("span", {
    class: style.dash === "solid" ? "line-key" : `line-key ${style.dash}`,
    style: `--key: ${style.slot === null ? "var(--ink-2)" : `var(--s${style.slot + 1})`}`,
    "aria-hidden": "true",
  });
}

// Trail

function renderTrail() {
  const dom = document.getElementById("trail-chart");
  if (!trail) {
    trail = createChart(dom);
  }
  trail.setOption(trailOption(theme()), { notMerge: true });
}

// Each run gets a bar up for its regressions and a bar down for its improvements, sized by the
// square root of how many lines shifted, so one shift is plainly visible and a broad one stands
// taller without dwarfing it.
// Moves of unknown direction stack on top of the regressions, splitting the bar in proportion to
// their counts, so the stack stays as tall as the square root of their sum.
// A run without any shift gets a short neutral tick, so the trail still shows every run.
function trailOption(t) {
  const byDate = state.axis === "date";
  const counts = view.runs.map((run) => countVerdicts(run));
  const reach = Math.max(1, ...counts.map(({ worse, better, moved }) => Math.sqrt(Math.max(worse + moved, better))));
  const point = (run, y) => (byDate ? [run.date, y] : y);
  const up = (count, { worse, moved }) => (count ? (Math.sqrt(worse + moved) * count) / (worse + moved) : null);
  const bar = (color, opacity = 1) => ({ type: "bar", stack: "trail", barCategoryGap: "30%", barMaxWidth: 6, itemStyle: { color, opacity }, silent: true });
  return {
    animation: false,
    textStyle: { fontFamily: t.font, color: t.muted },
    grid: { left: 0, right: 0, top: 14, bottom: 44 },
    xAxis: xAxis(t, { line: false, width: document.getElementById("trail-chart").clientWidth }),
    yAxis: { type: "value", min: -reach, max: reach, show: false },
    tooltip: crosshair(t),
    dataZoom: dataZoom(t, true),
    series: [
      {
        ...bar(t.worse),
        id: "trail",
        data: view.runs.map((run, j) => point(run, up(counts[j].worse, counts[j]))),
        markLine: markers(t, { labels: true }),
      },
      { ...bar(t.better), id: "trail-better", data: view.runs.map((run, j) => point(run, counts[j].better ? -Math.sqrt(counts[j].better) : null)) },
      { ...bar(t.axis), id: "trail-moved", data: view.runs.map((run, j) => point(run, up(counts[j].moved, counts[j]))) },
      {
        ...bar(t.noise),
        id: "trail-runs",
        data: view.runs.map((run, j) => point(run, counts[j].worse || counts[j].better || counts[j].moved || !counts[j].measured ? null : reach * 0.12)),
      },
    ],
  };
}

// Metric charts

// Charts are updated in place and only created or removed when the set of charts changes, so
// changing a filter never tears the page down and rebuilds it.
// When dimensions split the charts, each metric gets a heading over its grid of small charts.
function renderCharts() {
  const container = document.getElementById("charts");
  // New charts are drawn with the current window, and the next sync must reach all of them.
  appliedZoom = "";
  const t = theme();
  const faceted = view.pivot.facet.length > 0;
  renderLayoutSwitch();
  if (currentLayout() === "movers") {
    for (const chart of charts) {
      chartObservers.get(chart.instance)?.disconnect();
      dragControllers.get(chart.instance)?.dispose();
      screenObserver.unobserve(chart.dom);
      onScreen.delete(chart.dom);
      pendingZoom.delete(chart);
      chart.instance.dispose();
    }
    charts = [];
    container.classList.remove("is-faceted");
    container.classList.add("is-movers");
    renderMovers(container);
    return;
  }
  container.classList.remove("is-movers");

  const groups = [];
  for (const metric of view.metrics) {
    const cells = new Map();
    for (const line of view.benches) {
      if (line.metricId !== metric.key) continue;
      if (!cells.has(line.facet.token)) {
        cells.set(line.facet.token, { key: `${metric.key}\u0002${line.facet.token}`, metric, title: faceted ? line.facet.label : metric.label, benches: [] });
      }
      cells.get(line.facet.token).benches.push(line);
    }
    if (cells.size) groups.push({ metric, cells: [...cells.values()] });
  }
  const total = groups.reduce((sum, group) => sum + group.cells.length, 0);
  if (!state.allCharts && total > CHART_LIMIT) {
    let left = CHART_LIMIT;
    for (const group of groups) {
      group.cells = group.cells.slice(0, left);
      left -= group.cells.length;
    }
  }
  const shownGroups = groups.filter((group) => group.cells.length);
  const wanted = shownGroups.flatMap((group) => group.cells);

  for (const chart of charts) {
    if (!wanted.some((cell) => cell.key === chart.key)) {
      chartObservers.get(chart.instance)?.disconnect();
      dragControllers.get(chart.instance)?.dispose();
      screenObserver.unobserve(chart.dom);
      onScreen.delete(chart.dom);
      pendingZoom.delete(chart);
      chart.instance.dispose();
    }
  }
  charts = wanted.map((cell) => {
    const existing = charts.find((chart) => chart.key === cell.key && !chart.instance.isDisposed());
    if (existing) return Object.assign(existing, cell);
    const dom = h("div", { class: "chart", role: "img", "aria-label": `${cell.metric.label} ${cell.title} per run` });
    const note = h("span", { class: "note" });
    const title = h("span", { class: "title" });
    const readout = h("div", { class: "readout" });
    const card = h("article", { class: "chart-card" }, h("h3", {}, title, " ", note), dom, readout);
    const instance = createChart(dom);
    screenObserver.observe(dom);
    return { ...cell, card, dom, note, readout, titleNode: title, instance };
  });

  container.classList.toggle("is-faceted", faceted);
  if (charts.length === 0) {
    container.replaceChildren(h("p", { class: "empty" }, "Nothing matches these filters."));
    return;
  }
  const allToggle =
    total > CHART_LIMIT
      ? h(
          "button",
          {
            type: "button",
            class: "option charts-more",
            onclick: () => {
              state.allCharts = !state.allCharts;
              render();
            },
          },
          state.allCharts ? `Show the first ${CHART_LIMIT} charts` : `Show all ${total} charts`,
        )
      : null;
  if (faceted) {
    container.replaceChildren(
      ...shownGroups.map((group) =>
        h(
          "section",
          { class: "metric-group" },
          h("h2", {}, group.metric.label, " ", h("span", { class: "note" }, `${groupUnitLabel(group)}, ${directionText(group.metric)}`)),
          h("div", { class: "multiples" }, ...group.cells.map((cell) => charts.find((chart) => chart.key === cell.key).card)),
        ),
      ),
    );
  } else {
    container.replaceChildren(...charts.map((chart) => chart.card));
  }
  if (allToggle) container.append(allToggle);
  for (const chart of charts) {
    // Small multiples of one metric share its display unit, so sibling charts read alike.
    const group = faceted ? shownGroups.find((g) => g.metric === chart.metric) : null;
    const { option, unitLabel, plotted, log, scale } = lineOption(
      chart.metric,
      chart.benches,
      t,
      faceted,
      group ? groupMagnitude(group) : null,
      chart.dom.clientWidth,
    );
    chart.plotted = plotted;
    chart.log = log;
    chart.scale = scale;
    chart.titleNode.textContent = chart.title;
    chart.note.textContent = faceted ? "" : `${unitLabel}, ${directionText(chart.metric)}`;
    buildReadout(chart);
    chart.instance.setOption(option, { notMerge: true });
    chart.instance.resize();
  }
}

// Each chart carries a readout under its plot: one row per line with its value and change at the
// hovered run, or the selected one, so the numbers sit next to the chart they belong to without an
// overlay covering it.
// It doubles as the chart's legend.
// The spread and median columns exist only when expanded, since a fixed table layout keeps the
// width of hidden columns.
function buildReadout(chart) {
  const open = state.openReadouts.has(chart.key);
  const lines = open ? chart.benches : chart.benches.slice(0, READOUT_ROWS);
  // The spread column appears only for lines that record one.
  const spread = state.more && chart.benches.some((line) => line.points.some((i) => line.history.ranges[i]));
  chart.readoutItems = lines.map((line) => {
    const cells = { value: h("td", { class: "readout-value" }), change: h("td"), spread: h("td"), median: h("td") };
    const row = h(
      "tr",
      {},
      h("td", { class: "readout-label", title: line.label }, lineKey(line.style), line.style.label),
      cells.value,
      cells.change,
      spread ? cells.spread : null,
      state.more ? cells.median : null,
    );
    return { line, cells, row };
  });
  const cols = [h("col"), h("col", { class: "num" }), h("col", { class: "num" })];
  if (spread) cols.push(h("col", { class: "num" }));
  if (state.more) cols.push(h("col", { class: "num" }));
  const head = state.more
    ? h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th"),
          h("th", {}, "Value"),
          h("th", {}, "Change"),
          spread ? h("th", {}, "Spread") : null,
          h("th", { title: `Change against the median of up to ${BASELINE_RUNS} earlier runs since the last shift` }, "vs baseline"),
        ),
      )
    : null;
  const rest = chart.benches.length - READOUT_ROWS;
  const toggle =
    rest > 0
      ? h(
          "button",
          {
            type: "button",
            class: "readout-more",
            onclick: () => {
              if (open) state.openReadouts.delete(chart.key);
              else state.openReadouts.add(chart.key);
              buildReadout(chart);
              renderSelected();
            },
          },
          open ? "Show fewer" : `Show ${rest} more`,
        )
      : null;
  chart.readout.replaceChildren(
    ...[h("table", { class: "readout-table" }, h("colgroup", {}, ...cols), head, h("tbody", {}, ...chart.readoutItems.map((item) => item.row))), toggle].filter(
      Boolean,
    ),
  );
}

function updateReadouts(run) {
  for (const chart of charts) {
    for (const { line, cells } of chart.readoutItems ?? []) {
      const value = valueAt(line, run.index);
      const change = changeAt(line, run.index);
      const kind = lineVerdict(line, run.index);
      cells.value.textContent = value === null ? "–" : formatValue(value, line.unit);
      cells.change.replaceChildren(changeElement(change, kind));
      // A row whose run regressed or improved is emphasized, so the lines that moved stand out.
      cells.value.parentElement.dataset.verdict = kind;
      if (state.more) {
        const base = line.history.baseline[run.index];
        const vsBase = value !== null && base ? relative(value, base) : null;
        cells.spread.textContent = rangeAt(line, run.index) ?? "–";
        cells.median.replaceChildren(changeElement(vsBase, verdict(chart.metric, vsBase)));
      }
    }
  }
}

function currentLayout() {
  if (state.layout) return state.layout;
  return view.benches.length > MOVERS_FROM ? "movers" : "charts";
}

// The switch between charts and the movers table, shown once there are enough lines to need it.
function renderLayoutSwitch() {
  const bar = document.getElementById("layout");
  bar.hidden = view.benches.length <= 8;
  if (bar.hidden) return;
  const current = currentLayout();
  bar.replaceChildren(
    ...[
      { key: "movers", label: "Movers" },
      { key: "charts", label: "Charts" },
    ].map((option) =>
      h(
        "button",
        {
          type: "button",
          class: "option",
          role: "radio",
          "aria-checked": String(option.key === current),
          onclick: () => {
            if (option.key === current) return;
            state.layout = option.key;
            render();
          },
        },
        option.label,
      ),
    ),
    h("span", { class: "layout-count" }, `${view.benches.length} lines`),
  );
}

// Movers: every visible line ranked by its net change across the window in view, worst first,
// with a sparkline.
// The net change compares the medians of the first and last MOVER_ENDS values, so a single noisy
// run at either end does not decide the rank.
// It only spans the latest comparison segment in the window, so a changed parameter or toolchain
// never counts as a move.
// Choosing a row narrows the filters to that line's chart and switches to charts.
function renderMovers(container) {
  const { first, last } = zoomWindow();
  const runs = view.runs.slice(first, last + 1);
  const from = runs[0]?.index ?? 0;
  const to = runs.at(-1)?.index ?? -1;

  // Rows are ranked from each line's own observations in the window; only the rows shown build
  // a sparkline across every run.
  const rows = [];
  for (const line of view.benches) {
    const history = line.history;
    const inWindow = line.points.filter((i) => i >= from && i <= to && history.values[i] !== null);
    if (!inWindow.length) continue;
    const segment = history.segment[inWindow.at(-1)];
    const measured = inWindow.filter((i) => history.segment[i] === segment).map((i) => history.values[i]);
    if (measured.length < 2) continue;
    // The two ends never overlap, so a short segment compares its first and second half.
    const ends = Math.min(MOVER_ENDS, Math.floor(measured.length / 2));
    const start = median(measured.slice(0, ends));
    const end = median(measured.slice(-ends));
    const change = start ? relative(end, start) : null;
    const net = Number.isFinite(change) ? change : null;
    const metric = line.history.metric;
    const bad = badness(metric, net);
    const kind = bad === null ? "noise" : bad > config.threshold ? "worse" : bad < -config.threshold ? "better" : "noise";
    const shifts = inWindow.filter((i) => history.verdicts[i]).length;
    rows.push({ line, net, bad: bad ?? 0, kind, shifts, latest: measured.at(-1) });
  }
  rows.sort((a, b) => b.bad - a.bad);
  // Regressions first, then improvements from the largest, then everything else by size.
  const ordered = [
    ...rows.filter((r) => r.kind === "worse"),
    ...rows.filter((r) => r.kind === "better").reverse(),
    ...rows.filter((r) => r.kind === "noise").sort((a, b) => Math.abs(b.net ?? 0) - Math.abs(a.net ?? 0)),
  ];

  const multipleMetrics = view.metrics.length > 1;
  const body = ordered.slice(0, state.moversShown).map((row) =>
    h(
      "tr",
      {
        onclick: () => openLine(row.line),
        title: "Show this line's chart",
      },
      h(
        "td",
        { class: "mover-label" },
        lineKey(row.line.style),
        row.line.label,
        multipleMetrics ? h("span", { class: "metric" }, row.line.history.metric.label) : null,
      ),
      h(
        "td",
        { class: "spark-cell" },
        sparkline(
          runs.map((run) => valueAt(row.line, run.index)),
          row.kind,
        ),
      ),
      h("td", {}, formatValue(row.latest, row.line.unit)),
      h("td", {}, changeElement(row.net, row.kind)),
      h("td", { class: "shifts" }, row.shifts ? `${row.shifts} ${row.shifts === 1 ? "shift" : "shifts"}` : ""),
    ),
  );
  const span = runs.length > 1 ? `${formatDate(runs[0].date, true)} – ${formatDate(runs.at(-1).date, true)}` : formatDate(runs[0]?.date, true);
  const table = h(
    "table",
    { class: "movers-table" },
    h("colgroup", {}, h("col"), h("col", { class: "spark" }), h("col", { class: "num" }), h("col", { class: "num" }), h("col", { class: "num" })),
    h("thead", {}, h("tr", {}, h("th", {}, span), h("th"), h("th", {}, "Latest"), h("th", {}, "Net change"), h("th"))),
    h("tbody", {}, ...body),
  );
  const more =
    ordered.length > state.moversShown
      ? h(
          "button",
          {
            type: "button",
            class: "more",
            onclick: () => {
              state.moversShown += MOVERS_PAGE;
              renderCharts();
            },
          },
          `Show ${Math.min(MOVERS_PAGE, ordered.length - state.moversShown)} more`,
        )
      : null;
  container.replaceChildren(...[h("div", { class: "table-wrap" }, table), more].filter(Boolean));
}

// A small inline chart of a line's values, drawn as one SVG path so hundreds of rows stay cheap.
function sparkline(values, kind) {
  const width = 120;
  const height = 24;
  const measured = values.filter((v) => v !== null);
  const lo = Math.min(...measured);
  const hi = Math.max(...measured);
  const y = (v) => (hi === lo ? height / 2 : height - 2 - ((v - lo) / (hi - lo)) * (height - 4));
  const x = (i) => (values.length === 1 ? width / 2 : (i / (values.length - 1)) * width);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    pen = true;
  });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", `sparkline ${kind}`);
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.append(path);
  return svg;
}

// Narrows the filters to the chart that holds a line, then shows charts.
function openLine(line) {
  for (const key of view.pivot.facet) {
    const dim = section.dims.find((d) => d.key === key);
    const keep = token(line.trace.dims[key]);
    state.hidden.set(key, new Set(dim.values.map((v) => v.token).filter((tok) => tok !== keep)));
  }
  if (view.metrics.length > 1) state.hiddenMetrics = new Set(view.metrics.map((m) => m.key).filter((key) => key !== line.metricId));
  state.layout = "charts";
  render();
  document.querySelector(".charts-area")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function directionText(metric) {
  if (metric.direction === "higher") return "higher is better";
  if (metric.direction === "lower") return "lower is better";
  return "direction unknown";
}

// Smoothed values are cached per trace for the inputs they depend on, so a render that changes
// nothing about a line, such as toggling another filter, does not smooth it again.
const smoothCache = new WeakMap();

function smoothedCached(line, ys, factor, base) {
  const key = `${smoothing()}|${state.scale}|${view.offset}|${view.runs.length}|${factor}|${base}`;
  const cached = smoothCache.get(line.trace);
  if (cached?.key === key) return cached.values;
  const values = smoothed(line, ys, smoothing());
  smoothCache.set(line.trace, { key, values });
  return values;
}

// A centered rolling median over `window` runs, within each comparison segment.
// A median drops one-off outliers, such as a slow runner, yet keeps a real step sharp at the run
// where it happened, where an average would smear it across the window.
function smoothed(line, ys, window) {
  const half = (window - 1) >> 1;
  const segment = (j) => line.history.segment[view.runs[j].index];
  return ys.map((y, j) => {
    if (y === null) return null;
    const near = [];
    for (let k = Math.max(0, j - half); k <= Math.min(ys.length - 1, j + half); k += 1) {
      if (ys[k] !== null && segment(k) === segment(j)) near.push(ys[k]);
    }
    return median(near);
  });
}

function groupMagnitude(group) {
  if (group.magnitude !== undefined) return group.magnitude;
  let magnitude = 0;
  for (const cell of group.cells) {
    for (const line of cell.benches) for (const run of view.runs) magnitude = Math.max(magnitude, Math.abs(valueAt(line, run.index) ?? 0));
  }
  // Computed once per group and render, since the heading and every chart of the group ask.
  group.magnitude = magnitude;
  return magnitude;
}

function groupUnitLabel(group) {
  if (state.scale === "change") return `% since ${formatDate(view.runs[0].date)}`;
  return displayUnit(group.metric.unit, groupMagnitude(group)).label || "value";
}

function lineOption(metric, benches, t, compact, sharedMagnitude = null, width = 0) {
  const byDate = state.axis === "date";
  const asChange = state.scale === "change";
  let magnitude = 0;
  let smallest = Infinity;
  for (const bench of benches) {
    for (const run of view.runs) {
      const value = valueAt(bench, run.index);
      if (value === null) continue;
      magnitude = Math.max(magnitude, Math.abs(value));
      smallest = Math.min(smallest, value);
    }
  }
  const unit = displayUnit(metric.unit, sharedMagnitude ?? magnitude);
  // Lines more than LOG_SPAN apart share a log axis, so a small line's steps stay as visible as a
  // large one's instead of lying flat along the bottom.
  const log = !asChange && smallest > 0 && magnitude / smallest > LOG_SPAN;
  const unitLabel = asChange ? `% since ${formatDate(view.runs[0].date)}` : `${unit.label || "value"}${log ? ", log scale" : ""}`;

  const series = [];
  const plotted = [];
  for (const [i, bench] of benches.entries()) {
    const color = t.series[bench.style.slot];
    const base = view.baseline.get(bench.name);
    const ys = view.runs.map((run) => {
      const value = valueAt(bench, run.index);
      if (value === null) return null;
      return asChange ? (base ? relative(value, base) * 100 : null) : value * unit.factor;
    });
    const shown = smoothing() ? smoothedCached(bench, ys, unit.factor, base) : ys;
    plotted.push(ys, shown);
    const points = shown.map((y, j) => (byDate ? [view.runs[j].date, y] : y));
    // With smoothing on, the recorded values stay visible as faint dots behind the trend.
    if (smoothing()) {
      series.push({
        id: `${bench.name}\u0004raw`,
        type: "scatter",
        data: ys.map((y, j) => (byDate ? [view.runs[j].date, y] : y)),
        symbolSize: 3,
        itemStyle: { color, opacity: 0.35 },
        silent: true,
        z: 1,
      });
    }
    series.push({
      id: bench.name,
      name: bench.style.label,
      type: "line",
      data: points,
      connectNulls: false,
      symbol: "circle",
      symbolSize: 7,
      showSymbol: view.runs.length <= 40,
      sampling: view.runs.length > 800 ? "lttb" : undefined,
      // Short round-capped dashes close up on noisy lines, so dashes are longer with square ends.
      lineStyle: {
        width: 1.75,
        color,
        type: bench.style.dash === "dashed" ? [8, 5] : bench.style.dash === "dotted" ? [1.5, 4] : "solid",
        cap: bench.style.dash === "dashed" ? "butt" : "round",
        join: "round",
      },
      itemStyle: { color, borderColor: t.bg, borderWidth: 2 },
      // Hovering marks each line's point at the crosshair, without fading the other lines.
      emphasis: { focus: "none", scale: false },
      // A click anywhere in the plot selects the run under the crosshair, so a line shows no
      // pointer of its own.
      cursor: "crosshair",
      labelLayout: { hideOverlap: true },
      markLine: i === 0 ? markers(t, { selection: view.selected !== view.runs.length - 1 }) : undefined,
    });
  }

  const range = yRange(plotted, log);
  // The tick step changes with every zoom, so labels read it from this object, which the zoom sync
  // updates, rather than from the value captured here.
  const scale = { interval: range.interval };
  const option = {
    animation: false,
    textStyle: { fontFamily: t.font, color: t.muted },
    grid: { left: 0, right: 8, top: 12, bottom: 26, containLabel: true },
    xAxis: xAxis(t, { line: true, width }),
    // The axis fits the data rather than starting at zero, since a benchmark's level matters less
    // than its movement.
    yAxis: {
      type: log ? "log" : "value",
      scale: true,
      ...range,
      splitNumber: compact ? 3 : 4,
      axisLabel: {
        color: t.muted,
        fontSize: 11,
        formatter: asChange ? (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Number(v.toFixed(1)))}%` : (v) => formatTick(v, scale.interval),
      },
      splitLine: { lineStyle: { color: t.grid, width: 1 } },
    },
    tooltip: crosshair(t),
    dataZoom: dataZoom(t, false),
    series,
  };
  return { option, unitLabel, plotted, log, scale };
}

// The value axis range for the runs inside the zoom window, rounded to a readable step, so zooming
// in magnifies the lines instead of keeping the whole history's range.
function yRange(plotted, log) {
  const { first, last } = zoomWindow();
  let lo = Infinity;
  let hi = -Infinity;
  for (const ys of plotted) {
    for (let j = first; j <= last; j += 1) {
      const y = ys[j];
      if (y === null || y === undefined || !Number.isFinite(y)) continue;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
  }
  const loose = { min: null, max: null, interval: null };
  if (!Number.isFinite(lo)) return loose;
  // A log axis snaps to the nearest 1, 2, or 5 times a power of ten around the data, which keeps
  // round end labels while still magnifying a zoomed window.
  if (log) {
    if (!(lo > 0)) return loose;
    const range = { min: niceBound(lo, Math.floor), max: niceBound(hi, Math.ceil), interval: null };
    return range.min > 0 && Number.isFinite(range.max) && range.min < range.max ? range : loose;
  }
  // A value axis snaps to a 1, 2, or 5 step with about four intervals, and that step is also the
  // tick interval, so every tick lands on a round number.
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  const step = niceStep(span / 4);
  const min = Math.floor((lo - span * 0.04) / step) * step;
  const max = Math.ceil((hi + span * 0.04) / step) * step;
  const range = { min: lo >= 0 ? Math.max(0, min) : min, max, interval: step };
  // Extreme values can overflow or underflow the arithmetic above; ECharts then gets its own range.
  const valid = [range.min, range.max, range.interval].every(Number.isFinite) && range.min < range.max && range.interval > 0;
  return valid ? range : loose;
}

// The nearest value of the form 1, 2, or 5 times a power of ten, below a positive value with
// Math.floor or above it with Math.ceil.
function niceBound(x, round) {
  const power = 10 ** Math.floor(Math.log10(x));
  const steps = round === Math.floor ? [5, 2, 1] : [1, 2, 5, 10];
  const fraction = x / power;
  const pick = round === Math.floor ? steps.find((m) => m <= fraction) : steps.find((m) => m >= fraction);
  return (pick ?? 1) * power;
}

function niceStep(x) {
  const power = 10 ** Math.floor(Math.log10(x));
  const fraction = x / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

// Shared chart parts

// Charts are linked by syncZoom and syncPointer, so zoom and the hover crosshair move together.
// Hovering shows no overlay: it previews the run in the run bar and the readouts instead.
// The resize observer of each chart, so a disposed chart stops being observed.
const chartObservers = new WeakMap();
// The drag controller of each chart, so removing a chart also ends a drag in progress on it.
const dragControllers = new WeakMap();

function createChart(dom) {
  const instance = echarts.init(dom, null, { renderer: "svg" });
  chartObservers.set(instance, observeSize(dom, instance));
  // The event carries the window, which avoids cloning every chart's option through getOption.
  instance.on(
    "datazoom",
    safely((/** @type {any} */ event) => {
      if (syncingZoom) return;
      const zoom = event.batch?.[0] ?? event;
      if (!Number.isFinite(zoom.start) || !Number.isFinite(zoom.end)) return;
      state.zoom = { start: zoom.start, end: zoom.end };
      syncZoom(instance);
      clearTimeout(zoomTimer);
      zoomTimer = setTimeout(
        safely(() => {
          renderChanges();
          renderHistory();
          // The movers table ranks lines over the window, so it follows the window once it settles.
          if (currentLayout() === "movers") renderMovers(document.getElementById("charts"));
          writeUrl();
        }),
        250,
      );
    }),
  );
  instance.on(
    "updateAxisPointer",
    safely((/** @type {any} */ event) => {
      if (syncingPointer) return;
      const x = event.axesInfo?.find((info) => info.axisDim === "x")?.value;
      if (x === undefined) return;
      const j = indexAtX(x);
      preview(j);
      syncPointer(instance, j);
    }),
  );
  instance.getZr().on(
    "globalout",
    safely(() => {
      preview(null);
      syncPointer(instance, null);
    }),
  );
  const drag = wireDragZoom(dom, instance);
  dragControllers.set(instance, drag);
  instance.getZr().on(
    "click",
    safely((event) => {
      // The click that ends a drag has already zoomed, so it selects nothing.
      if (drag.justZoomed()) return;
      selectAtPixel(instance, event);
    }),
  );
  return instance;
}

// Moves the crosshair of every other chart to the same run, or hides it, so hovering one chart
// reads across the page.
// The charts are linked by hand rather than through an ECharts group, whose own zoom relay would
// echo the zoom sync below without end.
// Broadcasts are coalesced to one per frame, and each chart's crosshair is placed by the run's
// position on its axis rather than by a point of one series, which may have no value there.
// A request remembers the view it was made in, since a run position means nothing in another.
// A broadcast is skipped only when both the run and the source chart are unchanged, because the
// chart the pointer just left hid its own crosshair and needs it back.
let syncingPointer = false;
let pointerAt = null;
let pointerFrom = null;
let pointerFrame = 0;
let pointerRequest = null;

function syncPointer(source, j) {
  pointerRequest = { source, view, j: Number.isInteger(j) && view.runs[j] ? j : null };
  if (pointerFrame) return;
  pointerFrame = requestAnimationFrame(() => {
    pointerFrame = 0;
    const request = pointerRequest;
    pointerRequest = null;
    if (!request || request.view !== view) return;
    const { source: from, j: at } = request;
    if (at !== null && !view.runs[at]) return;
    if (at === pointerAt && from === pointerFrom) return;
    pointerAt = at;
    pointerFrom = from;
    // Charts scrolled out of view are skipped, and catch up when they come back into view.
    for (const instance of allCharts()) {
      if (instance !== from && (instance === trail || onScreen.has(instance.getDom()))) placePointer(instance, at);
    }
  });
}

// Moves one chart's crosshair to a run, or hides it.
function placePointer(instance, at) {
  syncingPointer = true;
  try {
    guarded(() => {
      if (at === null || !view.runs[at]) {
        instance.dispatchAction({ type: "updateAxisPointer", currTrigger: "leave" });
        instance.dispatchAction({ type: "hideTip" });
        return;
      }
      const run = view.runs[at];
      const x = instance.convertToPixel({ xAxisIndex: 0 }, state.axis === "date" ? run.date : `r${run.index}`);
      if (Number.isFinite(x)) instance.dispatchAction({ type: "showTip", x, y: instance.getHeight() / 2 });
    });
  } finally {
    syncingPointer = false;
  }
}

function allCharts() {
  return [trail, ...charts.map((chart) => chart.instance)].filter((instance) => instance && !instance.isDisposed());
}

// Applies the zoom window to every other chart, so the trail's slider, a drag in any chart, and a
// zoom gesture all move the whole page together.
// Updates are coalesced to one per frame with the latest window, and each chart gets a single
// silent setOption carrying both its window and its refitted value axis: silent updates emit no
// datazoom events, so the sync cannot echo, and a continuous gesture costs one pass per frame.
let syncingZoom = false;
let zoomFrame = 0;
let zoomSource = null;
let appliedZoom = "";

function syncZoom(source) {
  zoomSource = source;
  if (zoomFrame) return;
  zoomFrame = requestAnimationFrame(() => {
    zoomFrame = 0;
    const key = `${state.zoom?.start}|${state.zoom?.end}|${charts.length}`;
    if (key === appliedZoom) return;
    appliedZoom = key;
    // A gesture on a chart moves its own window, but its value axis still needs refitting.
    pendingZoom.clear();
    const window = { start: state.zoom?.start ?? 0, end: state.zoom?.end ?? 100 };
    syncingZoom = true;
    try {
      if (trail && !trail.isDisposed() && trail !== zoomSource) guarded(() => trail.setOption({ dataZoom: [window, window] }, { silent: true }));
      // Charts on screen follow every frame; those scrolled out of view catch up once the gesture
      // pauses, since nobody sees them move.
      for (const chart of charts) {
        if (onScreen.has(chart.dom)) applyZoom(chart, window);
        else pendingZoom.add(chart);
      }
    } finally {
      syncingZoom = false;
    }
    clearTimeout(offscreenTimer);
    offscreenTimer = setTimeout(
      safely(() => {
        for (const chart of pendingZoom) applyZoom(chart, { start: state.zoom?.start ?? 0, end: state.zoom?.end ?? 100 });
        pendingZoom.clear();
      }),
      200,
    );
  });
}

const pendingZoom = new Set();
let offscreenTimer = 0;

function applyZoom(chart, window) {
  const instance = chart.instance;
  if (instance.isDisposed()) return;
  const yAxis = yRange(chart.plotted, chart.log);
  if (chart.scale) chart.scale.interval = yAxis.interval;
  const option = { yAxis };
  if (instance !== zoomSource) option.dataZoom = [window];
  guarded(() => instance.setOption(option, { silent: true }));
}

// The chart boxes currently on screen, kept by one observer for all charts.
const onScreen = new Set();
const screenObserver = new IntersectionObserver(
  safely((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) {
        onScreen.delete(entry.target);
        continue;
      }
      onScreen.add(entry.target);
      // A chart coming into view takes up the crosshair it missed while away.
      const instance = charts.find((chart) => chart.dom === entry.target)?.instance;
      if (instance && !instance.isDisposed() && instance !== pointerFrom) placePointer(instance, pointerAt);
    }
  }),
);

// Runs an update on one chart so that a failure there is reported without stopping the others.
function guarded(update) {
  try {
    update();
  } catch (error) {
    reportFailure(error);
  }
}

// Dragging across a plot zooms every chart to the runs it covers; a faint band follows the
// pointer meanwhile, and a double click shows all runs again.
// The plot allows vertical page scrolling on touch screens, so only a sideways drag zooms.
function wireDragZoom(dom, instance) {
  const DRAG_MIN = 5;
  let from = null;
  let pointer = null;
  let band = null;
  let zoomedAt = 0;
  const x = (event) => event.clientX - dom.getBoundingClientRect().left;
  const y = (event) => event.clientY - dom.getBoundingClientRect().top;

  // Moves and the release are followed on the window, so a drag that leaves the chart still ends
  // where the pointer is let go, while a plain click still reaches the chart and selects a run.
  // Every way a drag can end removes those listeners: release, cancellation, losing focus, and the
  // chart being removed.
  const cancel = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("blur", cancel);
    from = null;
    pointer = null;
    band?.remove();
    band = null;
  };
  const move = safely((event) => {
    if (from === null || event.pointerId !== pointer || Math.abs(x(event) - from) < DRAG_MIN) return;
    if (!band) band = dom.appendChild(h("div", { class: "drag-band", "aria-hidden": "true" }));
    const width = dom.clientWidth;
    const left = Math.max(0, Math.min(from, x(event)));
    band.style.left = `${left}px`;
    band.style.width = `${Math.min(width, Math.max(from, x(event))) - left}px`;
  });
  const up = safely((event) => {
    if (event.pointerId !== pointer) return;
    const start = from;
    const end = Math.max(0, Math.min(dom.clientWidth, x(event)));
    cancel();
    if (start === null || Math.abs(end - start) < DRAG_MIN || instance.isDisposed()) return;
    const top = instance.getHeight() / 2;
    const runAt = (px) => {
      const value = instance.convertFromPixel({ gridIndex: 0 }, [px, top])?.[0];
      return value === undefined || Number.isNaN(Number(value)) ? null : indexAtX(value);
    };
    const clamp = (j) => Math.min(view.runs.length - 1, Math.max(0, j));
    const a = runAt(Math.min(start, end));
    const b = runAt(Math.max(start, end));
    if (a === null || b === null || clamp(b) <= clamp(a)) return;
    zoomedAt = performance.now();
    instance.dispatchAction({ type: "dataZoom", start: percentOfRun(clamp(a)), end: percentOfRun(clamp(b)) });
  });
  dom.addEventListener(
    "pointerdown",
    safely((event) => {
      if (event.button !== 0 || !instance.containPixel({ gridIndex: 0 }, [x(event), y(event)])) return;
      cancel();
      from = x(event);
      pointer = event.pointerId;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    }),
  );
  dom.addEventListener(
    "dblclick",
    safely(() => {
      if (!instance.isDisposed()) instance.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
    }),
  );
  return { justZoomed: () => performance.now() - zoomedAt < 300, dispose: cancel };
}

function crosshair(t) {
  return {
    trigger: "axis",
    showContent: false,
    axisPointer: { type: "line", lineStyle: { color: t.axis, width: 1, type: "solid" }, label: { show: false } },
  };
}

function xAxis(t, { line, width }) {
  const label = { color: t.muted, fontSize: 11, hideOverlap: true };
  if (state.axis === "date") {
    return {
      type: "time",
      axisLine: { show: line, lineStyle: { color: t.rule } },
      axisTick: { show: false },
      axisLabel: label,
      splitLine: { show: false },
    };
  }
  return {
    type: "category",
    data: view.runs.map((run) => `r${run.index}`),
    boundaryGap: !line,
    axisLine: { show: line, onZero: !line, lineStyle: { color: t.rule } },
    axisTick: { show: false },
    // The first and last labels align inward, so they never run past the plot's edges, and any
    // labels that still collide at a narrow width are hidden.
    axisLabel: { ...label, alignMinLabel: "left", alignMaxLabel: "right", ...runLabels(width) },
    splitLine: { show: false },
  };
}

// Labels for the run axis: every k-th run of the zoom window, with k chosen so about one label fits
// per LABEL_SPACING pixels, so labels sit evenly across the plot whatever the run times are.
// Labels name the day, or the time of day when they fall less than a day apart, with the day
// shown where it changes; both callbacks read the zoom when ECharts lays out the axis, so the
// labels follow every zoom without rebuilding the chart.
const LABEL_SPACING = 96;

function runLabels(width) {
  let memo = null;
  const window = () => {
    const range = zoomWindow();
    if (memo?.range === range) return memo;
    const { first, last } = range;
    const target = Math.max(2, Math.min(10, Math.floor((width || 600) / LABEL_SPACING)));
    const step = Math.max(1, Math.ceil((last - first + 1) / target));
    const span = (view.runs[last]?.date ?? 0) - (view.runs[first]?.date ?? 0);
    memo = { range, first, last, step, byTime: span / target < 86_400_000 };
    return memo;
  };
  return {
    interval: (j) => {
      const { first, last, step } = window();
      return j >= first && j <= last && (j - first) % step === 0;
    },
    // The formatter is given the label's position among the shown labels, not the run's, so the
    // run comes from the category value, which names its run index.
    formatter: (value) => {
      const j = Number(String(value).slice(1)) - view.offset;
      const { first, step, byTime } = window();
      const date = view.runs[j]?.date;
      if (!byTime) return formatDate(date);
      const previous = view.runs[j - step]?.date;
      return j === first || formatDate(previous) !== formatDate(date) ? formatDate(date) : timeFormat.format(date);
    },
  };
}

function dataZoom(t, slider) {
  const zoom = state.zoom ?? { start: 0, end: 100 };
  // Plain wheel scrolling keeps moving the page; zooming needs a modifier or a pinch, which
  // browsers report as a wheel event with the control key held.
  const inside = {
    type: "inside",
    filterMode: "none",
    start: zoom.start,
    end: zoom.end,
    zoomOnMouseWheel: "ctrl",
    moveOnMouseWheel: "shift",
    // Dragging selects a range to zoom into instead of panning; see wireDragZoom.
    moveOnMouseMove: false,
  };
  if (!slider) return [inside];
  return [
    inside,
    {
      type: "slider",
      filterMode: "none",
      start: zoom.start,
      end: zoom.end,
      height: 16,
      bottom: 2,
      left: 0,
      right: 0,
      borderColor: t.rule,
      borderRadius: 3,
      backgroundColor: "transparent",
      fillerColor: withAlpha(t.accent, 0.08),
      showDataShadow: false,
      // Handles are rounded grips a little taller than the slider, so they are easy to catch.
      handleIcon: "path://M3,0 h4 a3,3 0 0 1 3,3 v18 a3,3 0 0 1 -3,3 h-4 a3,3 0 0 1 -3,-3 v-18 a3,3 0 0 1 3,-3 z",
      handleSize: "150%",
      handleStyle: { color: t.bg, borderColor: t.axis, borderWidth: 1 },
      moveHandleSize: 0,
      emphasis: { handleStyle: { color: t.bg, borderColor: t.accent, borderWidth: 1.5 } },
      // The axis above already dates the window, so the handles carry no labels of their own.
      showDetail: false,
      brushSelect: false,
    },
  ];
}

// Vertical rules for the selected run and for every comparison boundary in view, such as a
// toolchain upgrade, so a step in a line can be read against what changed.
// It always returns a mark line, even an empty one, so a merged update clears stale rules.
// With labels, each boundary names what it changed to, such as `rustc 1.97.0`.
function markers(t, { labels = false, selection = true } = {}) {
  const x = (run) => (state.axis === "date" ? run.date : `r${run.index}`);
  const rules = view.runs
    .filter((run) => view.boundaries.has(run.index))
    .map((run) => ({
      xAxis: x(run),
      lineStyle: { color: t.axis, width: 1, type: [2, 3] },
      label: labels
        ? {
            show: true,
            position: "end",
            distance: 2,
            color: t.muted,
            fontSize: 10,
            formatter: () => boundaryLabel(view.boundaries.get(run.index)),
          }
        : { show: false },
    }));
  const run = view.runs[view.selected];
  if (run && selection) rules.push({ xAxis: x(run), lineStyle: { color: t.ink2, width: 1, type: "solid", opacity: 0.6 } });
  return { symbol: ["none", "none"], silent: true, animation: false, label: { show: false }, data: rules };
}

// The new values a boundary changed to, e.g. `rustc 1.97.0` for `rustc 1.96.0 → 1.97.0`.
function boundaryLabel(changes) {
  const text = changes.map((change) => change.replace(/^(\S+) .* → /, "$1 ")).join(", ");
  return text.length > 32 ? `${text.slice(0, 31)}…` : text;
}

// Resizes a chart when its box changes size, and only then, so a layout change caused by the
// resize itself cannot feed back into another one.
function observeSize(dom, instance) {
  let size = "";
  const observer = new ResizeObserver(
    safely(() => {
      const next = `${dom.clientWidth}x${dom.clientHeight}`;
      if (next === size || instance.isDisposed()) return;
      size = next;
      instance.resize();
    }),
  );
  observer.observe(dom);
  return observer;
}

// Selection and hover

// Maps an x-axis value to a run position: a category index, or the nearest run in date mode.
function indexAtX(x) {
  if (state.axis !== "date") return Math.round(Number(x));
  let index = 0;
  for (let j = 1; j < view.runs.length; j += 1) {
    if (Math.abs(view.runs[j].date - x) < Math.abs(view.runs[index].date - x)) index = j;
  }
  return index;
}

function selectAtPixel(instance, event) {
  const point = [event.offsetX, event.offsetY];
  if (!instance.containPixel({ gridIndex: 0 }, point)) return;
  const x = instance.convertFromPixel({ gridIndex: 0 }, point)?.[0];
  if (x === undefined || Number.isNaN(x)) return;
  selectRun(indexAtX(x));
}

// Hover previews a run in the details panel; leaving the charts returns to the selected run.
// The return waits a moment, so moving between charts does not flicker back and forth.
let hovered = null;
let hoverTimer = 0;
let hoverFrame = 0;

function resetHover() {
  clearTimeout(hoverTimer);
  cancelAnimationFrame(hoverFrame);
  cancelAnimationFrame(pointerFrame);
  pointerFrame = 0;
  pointerRequest = null;
  hovered = null;
  pointerAt = null;
  pointerFrom = null;
}

function preview(index) {
  clearTimeout(hoverTimer);
  if (index === null) {
    hoverTimer = setTimeout(() => showDetails(null), 120);
    return;
  }
  showDetails(index);
}

function showDetails(index) {
  if (index === hovered) return;
  hovered = index;
  cancelAnimationFrame(hoverFrame);
  hoverFrame = requestAnimationFrame(renderSelected);
}

function selectRun(index) {
  const clamped = Math.min(view.runs.length - 1, Math.max(0, index));
  if (clamped === view.selected) return;
  view.selected = clamped;
  state.run = view.runs[clamped].key;
  const t = theme();
  const marker = markers(t, { selection: clamped !== view.runs.length - 1 });
  trail?.setOption({ series: [{ id: "trail", markLine: markers(t, { labels: true }) }] });
  for (const chart of charts) {
    chart.instance.setOption({ series: [{ id: chart.benches[0].name, markLine: marker }] });
  }
  renderSelected();
  renderMessage();
  markHistorySelection();
  writeUrl();
}

// The visible lines that regressed or improved at a run, regressions first, then by size.
function significantMoves(run) {
  tallyView();
  return view.moves.get(run.index) ?? [];
}

// A wrapping list of moves, each a signed change beside the line it belongs to.
function movesElement(moves, limit) {
  const multipleMetrics = view.metrics.length > 1;
  const shown = moves.slice(0, limit);
  return h(
    "span",
    { class: "moves" },
    ...shown.map(({ line, change, kind }) =>
      h(
        "span",
        { class: "move" },
        changeElement(change, kind),
        h("span", { class: "what" }, line.label, multipleMetrics ? h("span", { class: "metric" }, line.history.metric.label) : null),
      ),
    ),
    moves.length > shown.length ? h("span", { class: "move what" }, `${moves.length - shown.length} more`) : null,
  );
}

// Changes: the runs in view that regressed or improved, newest first.
// Closed, it is one summary line; opened, it lists the latest few, and then every one.
function renderChanges() {
  const container = document.getElementById("changes");
  const { first, last } = zoomWindow();
  const entries = [];
  let worse = 0;
  let better = 0;
  let moved = 0;
  let compared = 0;
  for (let j = last; j >= first; j -= 1) {
    const counts = countVerdicts(view.runs[j]);
    if (counts.measured) compared += 1;
    if (!counts.worse && !counts.better && !counts.moved) continue;
    if (counts.worse) worse += 1;
    if (counts.better) better += 1;
    if (counts.moved && !counts.worse && !counts.better) moved += 1;
    entries.push({ run: view.runs[j], j });
  }

  const open = state.changes !== "closed" && entries.length > 0;
  const setChanges = (value) => {
    state.changes = value;
    renderChanges();
    writeUrl();
  };
  const summary = h(
    "button",
    {
      type: "button",
      class: "changes-toggle disclosure",
      "aria-expanded": String(open),
      disabled: entries.length === 0,
      onclick: () => setChanges(open ? "closed" : "open"),
    },
    entries.length ? icon(open ? "down" : "right", "toggle-icon") : null,
    h("span", { class: "changes-title" }, "Changes"),
    entries.length
      ? h(
          "span",
          { class: "changes-counts" },
          worse ? h("span", { class: "change worse" }, icon("up"), `${worse} ${worse === 1 ? "run" : "runs"} regressed`) : null,
          better ? h("span", { class: "change better" }, icon("down"), `${better} ${better === 1 ? "run" : "runs"} improved`) : null,
          moved ? h("span", { class: "change moved" }, `${moved} ${moved === 1 ? "run" : "runs"} shifted, direction unknown`) : null,
        )
      : h("span", { class: "changes-counts" }, compared ? "no shifts beyond the noise" : "not enough runs to compare yet"),
  );
  if (!open) {
    container.replaceChildren(summary);
    return;
  }

  const shown = state.changes === "all" ? entries : entries.slice(0, CHANGES_SHOWN);
  const items = shown.map(({ run, j }) => {
    const moves = significantMoves(run);
    return h(
      "li",
      {
        class: "change-run",
        "data-view-index": String(j),
        "aria-selected": String(j === view.selected),
        onclick: () => selectRun(j),
        onmouseenter: () => preview(j),
        onmouseleave: () => preview(null),
      },
      h("span", { class: "lead" }, changeElement(moves[0].change, moves[0].kind)),
      h("span", { class: "subject", title: run.subject }, run.subject),
      movesElement(moves, 1),
      h(
        "span",
        { class: "when" },
        moves.every((m) => m.tentative) ? h("span", { class: "tentative", title: "Later runs have not confirmed this shift yet" }, "unconfirmed") : null,
        h("span", { class: "sha" }, run.short),
        " ",
        formatDate(run.date, true),
      ),
    );
  });
  const more =
    entries.length > CHANGES_SHOWN
      ? h(
          "button",
          { type: "button", class: "changes-more", onclick: () => setChanges(state.changes === "all" ? "open" : "all") },
          state.changes === "all" ? "Show fewer" : `Show all ${entries.length}`,
        )
      : null;
  container.replaceChildren(...[summary, h("ul", { class: "change-list" }, ...items), more].filter(Boolean));
}

// Hovering or selecting a run updates two things in place: the run bar above the charts, which
// stays on screen while the charts scroll, and the readout under every chart.
// Both keep one shape for every run, so moving along the trail changes text without moving the
// layout.
function renderSelected() {
  const shown = hovered !== null && view.runs[hovered] ? hovered : view.selected;
  const run = view.runs[shown];
  const bar = document.getElementById("run-bar");
  if (!run) {
    bar.replaceChildren();
    return;
  }
  bar.classList.toggle("is-preview", shown !== view.selected);
  const boundary = view.boundaries.get(run.index);
  const { worse, better } = countVerdicts(run);
  const tally = [
    worse
      ? h(
          "span",
          { class: "change worse", title: `${worse} ${worse === 1 ? "regression" : "regressions"}` },
          icon("up"),
          String(worse),
          h("span", { class: "word" }, worse === 1 ? " regression" : " regressions"),
        )
      : null,
    better
      ? h(
          "span",
          { class: "change better", title: `${better} ${better === 1 ? "improvement" : "improvements"}` },
          icon("down"),
          String(better),
          h("span", { class: "word" }, better === 1 ? " improvement" : " improvements"),
        )
      : null,
  ].filter(Boolean);
  bar.replaceChildren(
    h(
      "div",
      { class: "run-head" },
      h(
        "button",
        { type: "button", class: "step", "aria-label": "Previous run", disabled: view.selected === 0, onclick: () => selectRun(view.selected - 1) },
        icon("left"),
      ),
      h(
        "button",
        {
          type: "button",
          class: "step",
          "aria-label": "Next run",
          disabled: view.selected === view.runs.length - 1,
          onclick: () => selectRun(view.selected + 1),
        },
        icon("right"),
      ),
      run.url ? h("a", { class: "sha", href: run.url }, run.short) : h("span", { class: "sha" }, run.short),
      h("span", { class: "run-subject", title: run.subject }, subjectElement(run)),
      h("span", { class: "tally" }, ...tally),
    ),
    h(
      "div",
      { class: "run-facts" },
      `${run.author}, ${formatDateTime(run.date)}`,
      boundary ? h("span", { class: "boundary", title: "Changes are not compared across this run" }, boundary.join(", ")) : null,
    ),
  );
  updateReadouts(run);
}

// How many visible lines regressed or improved at a run.
function countVerdicts(run) {
  tallyView();
  return view.counts.get(run.index) ?? NO_COUNTS;
}

const NO_COUNTS = Object.freeze({ worse: 0, better: 0, moved: 0, measured: 0 });

// Counts the verdicts and collects the moves of every run in the view at once, the first time
// anything asks, by visiting each line's own observations.
// The trail, the run bar, and the changes list all ask, so this costs one pass over the
// observations rather than one pass over the lines for every run.
function tallyView() {
  if (view.counts) return;
  const counts = new Map();
  const moves = new Map();
  for (const line of view.benches) {
    for (const i of line.points) {
      const kind = lineVerdict(line, i);
      if (kind === "none" || kind === "unjudged") continue;
      let tally = counts.get(i);
      if (!tally) {
        tally = { worse: 0, better: 0, moved: 0, measured: 0 };
        counts.set(i, tally);
      }
      tally.measured += 1;
      if (kind === "noise") continue;
      tally[kind] += 1;
      const { shift, tentative } = line.history.verdicts[i];
      if (!moves.has(i)) moves.set(i, []);
      moves.get(i).push({ line, change: shift, kind, tentative });
    }
  }
  // Regressions first, then by size.
  const rank = { worse: 0, better: 1, moved: 2 };
  for (const list of moves.values()) list.sort((a, b) => rank[a.kind] - rank[b.kind] || Math.abs(b.change) - Math.abs(a.change));
  view.counts = counts;
  view.moves = moves;
}

// The selected run's full commit message and environment, at the foot of the charts.
// It follows the selection only, not the hover, so nothing below the charts moves while hovering.
function renderMessage() {
  const panel = document.getElementById("selected");
  const run = view.runs[view.selected];
  if (!run) {
    panel.replaceChildren();
    return;
  }
  const texts = unique(view.benches.map((b) => textAt(b, run.index)).filter(Boolean));
  const environment = unique(view.benches.flatMap((b) => Object.entries(environmentAt(b, run.index) ?? {}).map(([key, value]) => `${key} ${value}`)));
  const notes = texts.length === 1 ? texts[0] : null;
  const facts = [environment.length ? ["Environment", environment.join(", ")] : null, notes ? ["Notes", notes] : null].filter(Boolean);
  // The subject already heads the run bar, so this section adds only what the bar leaves out.
  panel.hidden = !run.body && !facts.length;
  panel.replaceChildren(
    ...[
      h("p", { class: "message-head" }, "Commit message"),
      run.body ? h("p", { class: "run-body" }, run.body) : null,
      facts.length ? h("dl", { class: "run-facts-list" }, ...facts.flatMap(([term, text]) => [h("dt", {}, term), h("dd", {}, text)])) : null,
    ].filter(Boolean),
  );
}

// The subject as text, with a trailing pull-request reference such as `(#57)` linked to the PR,
// and the given character ranges marked as search matches.
function subjectElement(run, marks = []) {
  const match = /^(.*?)\s*\(#(\d+)\)$/.exec(run.subject);
  const repo = safeUrl(data.repoUrl);
  if (!match || !repo || new URL(repo).hostname !== "github.com") return marked(run.subject, marks);
  const link = h("a", { href: `${repo.replace(/\/$/, "")}/pull/${match[2]}`, onclick: (event) => event.stopPropagation() }, `#${match[2]}`);
  return h("span", {}, marked(match[1], marks), " (", link, ")");
}

// Text with the given [start, end) ranges wrapped in <mark>; ranges past the text are ignored.
function marked(text, marks) {
  const ranges = marks
    .map(([a, b]) => [Math.max(0, a), Math.min(text.length, b)])
    .filter(([a, b]) => a < b)
    .sort((x, y) => x[0] - y[0]);
  if (!ranges.length) return document.createTextNode(text);
  const span = h("span");
  let at = 0;
  for (const [a, b] of ranges) {
    if (b <= at) continue;
    const from = Math.max(a, at);
    if (from > at) span.append(text.slice(at, from));
    span.append(h("mark", {}, text.slice(from, b)));
    at = b;
  }
  if (at < text.length) span.append(text.slice(at));
  return span;
}

// History table: opt-in, searchable, and sortable by any benchmark's change

function renderHistory() {
  const open = state.list;
  document.getElementById("history").hidden = !open;
  /** @type {HTMLInputElement} */ (document.getElementById("only-changes")).checked = state.onlyChanges;
  disclosure(document.getElementById("list-toggle"), open, open ? "Hide runs" : `All ${suite.runs.length} runs`);
  if (!open) return;

  const table = document.getElementById("history-table");
  const tokens = searchTokens(state.query);
  const sortLine = state.sort && view.benches.find((b) => b.sortKey === state.sort.bench);

  // The list follows the zoom window, so it always shows the runs the charts show.
  const { first, last } = zoomWindow();
  const significant = (run) => {
    const counts = countVerdicts(run);
    return counts.worse + counts.better + counts.moved > 0;
  };
  let runs = view.runs
    .map((run, j) => ({ run, j }))
    .filter(({ j }) => j >= first && j <= last)
    .map((entry) => ({ ...entry, match: tokens.length ? searchRun(entry.run, tokens, state.query) : null }))
    .filter(({ match }) => !tokens.length || match)
    .filter(({ run }) => !state.onlyChanges || significant(run));
  if (tokens.length && !sortLine) {
    // Search results rank by relevance, newest first among equals.
    runs.sort((a, b) => b.match.tier - a.match.tier || b.match.score - a.match.score || b.j - a.j);
  } else if (sortLine) {
    // Worst first sorts by regression size, best first by improvement size; runs without a
    // change for this benchmark go last either way.
    const sign = state.sort.order === "best" ? -1 : 1;
    const key = ({ run }) => badness(sortLine.history.metric, changeAt(sortLine, run.index));
    runs.sort((a, b) => Number(key(a) === null) - Number(key(b) === null) || sign * (key(b) - key(a)));
  } else {
    runs = runs.reverse();
  }

  const sortButton = (line, label) => {
    const active = sortLine === line;
    const marker = active ? icon(state.sort.order === "best" ? "up" : "down", "sort-icon") : null;
    return h(
      "button",
      {
        type: "button",
        class: "option",
        "aria-pressed": String(active),
        title: "Sort by change: worst first, then best first, then by date",
        onclick: () => {
          if (!active) state.sort = { bench: line.sortKey, order: "worst" };
          else if (state.sort.order === "worst") state.sort = { bench: line.sortKey, order: "best" };
          else state.sort = null;
          state.shown = PAGE_SIZE;
          renderHistory();
          writeUrl();
        },
      },
      label,
      marker,
    );
  };

  // A column per line only while the lines fit side by side; past that, or on a narrow screen,
  // one column lists each run's significant moves and wraps, so the table never scrolls sideways.
  const wide = view.benches.length > HISTORY_COLUMNS || narrow.matches;
  const head = h(
    "thead",
    {},
    h(
      "tr",
      {},
      h("th", {}, `${runs.length} ${runs.length === 1 ? "run" : "runs"}`),
      ...(wide
        ? [h("th", {}, "Changes")]
        : view.benches.map((line) => {
            const label = view.metrics.length > 1 ? `${line.label} ${line.history.metric.label}` : line.label;
            return h("th", {}, lineKey(line.style), sortButton(line, label));
          })),
    ),
  );

  const body = h("tbody", {});
  for (const { run, j, match } of runs.slice(0, state.shown)) {
    const cells = wide
      ? [h("td", { class: "moves-cell" }, movesElement(significantMoves(run), 4))]
      : view.benches.map((line) => {
          const value = valueAt(line, run.index);
          const change = changeAt(line, run.index);
          return h("td", {}, value === null ? "–" : formatValue(value, line.unit), changeElement(change, lineVerdict(line, run.index)));
        });
    body.append(
      h(
        "tr",
        { "data-view-index": String(j), "aria-selected": String(j === view.selected), onclick: () => selectRun(j) },
        h(
          "td",
          {},
          h("span", { class: "sha" }, run.short),
          " ",
          subjectElement(run, match?.marks),
          h("span", { class: "row-meta" }, `${run.author}, ${formatDateTime(run.date)}`),
        ),
        ...cells,
      ),
    );
  }
  if (runs.length === 0) {
    body.append(h("tr", { class: "empty-row" }, h("td", { colspan: String(wide ? 2 : view.benches.length + 1) }, "No runs match.")));
  }
  table.replaceChildren(head, body);

  const more = document.getElementById("more");
  more.hidden = runs.length <= state.shown;
  more.textContent = `Show ${Math.min(PAGE_SIZE, runs.length - state.shown)} more`;
}

// Search

function searchTokens(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// Scores a run against a query: every word must match somewhere, and the best place for each word
// decides its score.
// A commit SHA prefix or pull-request number ranks first, then the whole query as a phrase in the
// subject, then whole words, word prefixes, substrings, and finally the word's letters in order
// within one subject word, which tolerates letters left out of the query.
// Author and body matches count for less, and the body never matches loosely, since long
// squash-merge bodies mention almost everything.
// Results sort by tier first, so a SHA or pull request match always leads, then by score.
// Returns null when a word matches nowhere, otherwise the tier, score, and subject ranges to mark.
function searchRun(run, tokens, query) {
  const subject = run.subject.toLowerCase();
  const author = run.author.toLowerCase();
  const body = run.body.toLowerCase();
  const pr = /\(#(\d+)\)$/.exec(run.subject)?.[1];
  const marks = [];
  let score = 0;
  let tier = 1;
  for (const tok of tokens) {
    let best = 0;
    if ((tok.length >= 4 && run.id.toLowerCase().startsWith(tok)) || (pr && (tok === pr || tok === `#${pr}`))) {
      tier = 3;
      best = 1000;
    }
    const inSubject = wordMatch(subject, tok);
    if (inSubject) {
      best = Math.max(best, inSubject.score);
      marks.push(inSubject.range);
    }
    const inAuthor = wordMatch(author, tok, false);
    if (inAuthor) best = Math.max(best, inAuthor.score / 2);
    const inBody = wordMatch(body, tok, false);
    if (inBody && (inBody.score >= 200 || tok.length >= 4)) best = Math.max(best, inBody.score / 10);
    if (!best) return null;
    score += best;
  }
  const phrase = query.trim().toLowerCase();
  const at = tokens.length > 1 ? subject.indexOf(phrase) : -1;
  if (at >= 0) {
    tier = Math.max(tier, 2);
    marks.push([at, at + phrase.length]);
  }
  return { tier, score, marks };
}

// The best match of one word in a text: a whole word, a word prefix, a substring, or, when loose
// matching is allowed, the word's letters in order within one word of the text.
function wordMatch(text, tok, loose = true) {
  let best = null;
  const consider = (score, range) => {
    if (!best || score > best.score) best = { score, range };
  };
  for (let at = text.indexOf(tok); at >= 0; at = text.indexOf(tok, at + 1)) {
    const startsWord = at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]);
    const endsWord = at + tok.length === text.length || !/[\p{L}\p{N}]/u.test(text[at + tok.length]);
    consider(startsWord && endsWord ? 300 : startsWord ? 200 : 120, [at, at + tok.length]);
  }
  if (best || !loose || tok.length < 3) return best;
  for (const word of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const range = subsequence(word[0], tok);
    if (!range) continue;
    // Tighter spans score higher, and a span over twice the query's length is no match.
    const span = range[1] - range[0];
    if (span > tok.length * 2) continue;
    consider(10 + (50 * tok.length) / span, [word.index + range[0], word.index + range[1]]);
  }
  return best;
}

// The shortest span of `word` that holds every letter of `tok` in order, trying each place the
// first letter occurs, since the first occurrence is not always the tightest.
function subsequence(word, tok) {
  let best = null;
  for (let start = word.indexOf(tok[0]); start >= 0; start = word.indexOf(tok[0], start + 1)) {
    // A span longer than twice the query never counts as a match, so the scan stops there.
    const limit = Math.min(word.length, start + tok.length * 2);
    let i = 1;
    let j = start + 1;
    for (; j < limit && i < tok.length; j += 1) if (word[j] === tok[i]) i += 1;
    if (i < tok.length) continue;
    if (!best || j - start < best[1] - best[0]) best = [start, j];
  }
  return best;
}

function markHistorySelection() {
  const rows = /** @type {NodeListOf<HTMLElement>} */ (
    document.querySelectorAll("#changes .change-run[data-view-index], #history-table tbody tr[data-view-index]")
  );
  for (const row of rows) {
    row.setAttribute("aria-selected", String(Number(row.dataset.viewIndex) === view.selected));
  }
}

// Problems found while reading the history, behind a toggle at the foot of the page.
function renderNotes() {
  const problems = [...suite.problems.entries()];
  const container = document.getElementById("notes");
  container.hidden = problems.length === 0;
  if (!problems.length) return;
  const count = problems.reduce((sum, [, n]) => sum + n, 0);
  const button = h(
    "button",
    {
      type: "button",
      class: "option",
      "aria-expanded": String(state.notes),
      onclick: () => {
        state.notes = !state.notes;
        renderNotes();
      },
    },
    `${count} ${count === 1 ? "problem" : "problems"} reading this suite`,
  );
  const list = state.notes
    ? h("ul", { class: "notes-list" }, ...problems.map(([message, n]) => h("li", {}, n > 1 ? `${message} (${n} times)` : message)))
    : null;
  container.replaceChildren(...[button, list].filter(Boolean));
}

// Controls

function wireControls() {
  const search = /** @type {HTMLInputElement} */ (document.getElementById("search"));
  search.value = state.query;
  // Searching waits for a short pause in typing, so a long history is not searched per keystroke.
  let searchTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(
      safely(() => {
        state.query = search.value;
        state.shown = PAGE_SIZE;
        renderHistory();
        writeUrl();
      }),
      120,
    );
  });
  document.getElementById("more").addEventListener("click", () => {
    state.shown += PAGE_SIZE;
    renderHistory();
  });
  wireSettings();
  document.getElementById("list-toggle").addEventListener("click", () => {
    state.list = !state.list;
    renderHistory();
    writeUrl();
  });
  document.getElementById("only-changes").addEventListener("change", (event) => {
    state.onlyChanges = /** @type {HTMLInputElement} */ (event.target).checked;
    state.shown = PAGE_SIZE;
    renderHistory();
    writeUrl();
  });
  narrow.addEventListener("change", () => renderHistory());
  // A click outside the open menu closes it.
  // A click inside can re-render the menu, which detaches the clicked node, so those are skipped.
  document.addEventListener("click", (event) => {
    const target = /** @type {Element} */ (event.target);
    if (!state.menu || !target.isConnected || target.closest(".menu")) return;
    closeMenu(false);
  });
  // Arrow keys step through runs unless a control has focus.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.menu) {
      closeMenu(true);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (/** @type {Element} */ (event.target).closest?.("input, textarea, select, [role='radio'], [role='tab'], .menu")) return;
    if (event.key === "ArrowLeft") selectRun(view.selected - 1);
    else if (event.key === "ArrowRight") selectRun(view.selected + 1);
    else return;
    event.preventDefault();
  });
}

// The theme follows the system unless the reader picks one, which is remembered in this browser.
const THEMES = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

function renderTheme() {
  const current = document.documentElement.dataset.theme ?? "system";
  segmented("theme", THEMES, current, (choice) => {
    if (choice === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    try {
      if (choice === "system") localStorage.removeItem("benchtrail:theme");
      else localStorage.setItem("benchtrail:theme", choice);
    } catch {
      // Storage can be unavailable in private windows; the choice then lasts for this visit.
    }
    if (view) render();
    else renderTheme();
  });
}

function wireTheme() {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (view && !document.documentElement.dataset.theme) render();
  });
  renderTheme();
}

// The settings panel opens from the gear in the header and closes on Escape or a click outside,
// like the filter menus.
function wireSettings() {
  const toggle = document.getElementById("settings-toggle");
  const panel = document.getElementById("settings");
  toggle.replaceChildren(icon("gear"));
  const set = (open) => {
    state.options = open;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => set(!state.options));
  document.addEventListener("click", (event) => {
    const target = /** @type {Element} */ (event.target);
    if (state.options && target.isConnected && !target.closest(".settings")) set(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.options) {
      set(false);
      toggle.focus();
    }
  });
  set(false);
}

// URL state: every view is a shareable link.
// The theme is a personal preference kept in this browser, so it never enters a link.
// Parameters at their default are left out, and runs are named by commit, so a link keeps
// pointing at the same runs as the history grows.
// A dimension filter uses the dimension's name as its parameter, or `d.<name>` when the name is
// one of the page's own parameters.
// List values are separated by literal commas and each value is percent-encoded, so a value that
// contains a comma survives the round trip.

const URL_KEYS = new Set([
  "data",
  "suite",
  "section",
  "view",
  "runs",
  "metrics",
  "values",
  "x",
  "color",
  "dash",
  "smooth",
  "from",
  "to",
  "run",
  "more",
  "charts",
  "changes",
  "list",
  "q",
  "only",
  "sort",
  "order",
]);

function dimensionParam(key) {
  return URL_KEYS.has(key) || key.startsWith("d.") ? `d.${key}` : key;
}

function writeUrl() {
  const parts = [];
  const add = (key, value) => parts.push(`${encodeQuery(key)}=${encodeQuery(value)}`);
  const addList = (key, values) => parts.push(`${encodeQuery(key)}=${values.map(encodeQuery).join(",")}`);

  const dataParam = readQuery().get("data");
  if (dataParam !== undefined) add("data", dataParam);
  if (suites.length > 1 && suite !== suites[0]) add("suite", state.suite);
  if (suite.sections.length > 1 && section !== suite.sections[0]) {
    if (section.link === null) addList("section", section.keys.map(sectionKeyText));
    else add("section", section.link);
  }
  if (state.range !== "all") add("runs", state.range);
  // Visible sets rather than hidden ones, so a link names exactly what it shows.
  // An empty selection is written as `~`, which no value's link text can be.
  const visibleList = (key, values) => (values.length ? addList(key, values) : add(key, "~"));
  if (state.hiddenMetrics.size)
    visibleList(
      "metrics",
      section.metrics.filter((m) => !state.hiddenMetrics.has(m.key)).map((m) => m.slug),
    );
  for (const d of section.dims) {
    const hidden = state.hidden.get(d.key);
    if (hidden?.size)
      visibleList(
        dimensionParam(d.key),
        d.values.filter((v) => !hidden.has(v.token)).map((v) => v.param),
      );
  }
  // A choice the pivot could not honor stays out of the link.
  if (state.colorBy !== undefined && (state.colorBy || null) === view.pivot.color) add("color", state.colorBy || "~");
  if (state.dashBy !== undefined && (state.dashBy || null) === view.pivot.dash) add("dash", state.dashBy || "~");
  if (state.scale !== "absolute") add("values", state.scale);
  if (state.smooth !== null && state.smooth !== defaultSmoothing()) add("smooth", String(state.smooth));
  if (state.axis !== "run") add("x", state.axis);
  const zoom = zoomedRuns();
  if (zoom) {
    add("from", zoom.from.key);
    add("to", zoom.to.key);
  }
  const run = view.runs[view.selected];
  if (run && view.selected !== view.runs.length - 1) add("run", run.key);
  if (state.layout) add("view", state.layout);
  if (state.more) add("more", "1");
  if (state.allCharts) add("charts", "all");
  if (state.changes !== "closed") add("changes", state.changes);
  if (state.list) {
    add("list", "1");
    if (state.query.trim()) add("q", state.query.trim());
    if (state.onlyChanges) add("only", "changes");
    if (state.sort) {
      add("sort", state.sort.bench);
      if (state.sort.order !== "worst") add("order", state.sort.order);
    }
  }
  const query = parts.join("&");
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
}

// Slashes and colons are legal in a query, and leaving them unescaped keeps links readable.
function encodeQuery(text) {
  return encodeURIComponent(text).replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%20/g, "+");
}

function decodeQuery(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

// The query as raw values by name, first occurrence winning, so list values can be split on
// their literal commas before decoding.
function readQuery() {
  const raw = new Map();
  for (const part of location.search.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const at = part.indexOf("=");
    const key = decodeQuery(at < 0 ? part : part.slice(0, at));
    if (!raw.has(key)) raw.set(key, at < 0 ? "" : part.slice(at + 1));
  }
  return {
    has: (key) => raw.has(key),
    get: (key) => (raw.has(key) ? decodeQuery(raw.get(key)) : undefined),
    list: (key) => (raw.has(key) ? raw.get(key).split(",").map(decodeQuery) : undefined),
  };
}

function readUrl() {
  const query = readQuery();
  state.suite = query.get("suite") ?? null;
  const sectionParam = query.get("section");
  if (sectionParam === undefined) state.section = null;
  else if (sectionParam.startsWith("#")) state.section = { link: sectionParam };
  else state.section = { keys: query.list("section").map((key) => (key.startsWith("s:") ? key.slice(2) : key)) };
  if (RANGES.some((r) => r.key === query.get("runs"))) state.range = query.get("runs");
  if (SCALES.some((s) => s.key === query.get("values"))) state.scale = query.get("values");
  if (AXES.some((a) => a.key === query.get("x"))) state.axis = query.get("x");
  state.run = query.get("run") ?? null;
  state.more = query.get("more") === "1";
  state.allCharts = query.get("charts") === "all";
  if (["charts", "movers"].includes(query.get("view"))) state.layout = query.get("view");
  state.changes = ["open", "all"].includes(query.get("changes")) ? query.get("changes") : "closed";
  state.list = query.get("list") === "1";
  const smooth = Number(query.get("smooth"));
  if (SMOOTHING.some((option) => option.key === smooth)) state.smooth = smooth;
  state.query = query.get("q") ?? "";
  state.onlyChanges = query.get("only") === "changes";
  if (query.get("sort")) state.sort = { bench: query.get("sort"), order: query.get("order") === "best" ? "best" : "worst" };
  state.pending = { query, from: query.get("from"), to: query.get("to") };
}

// Applies the parts of the URL that name things inside a section, once the section is known.
function applyPendingUrl() {
  const pending = state.pending;
  state.pending = null;
  if (!pending) return;
  const { query } = pending;
  const choice = (key) => {
    const value = query.get(key);
    if (value === undefined) return undefined;
    if (value === "~") return "";
    return section.dims.some((d) => d.key === value && d.varying) ? value : undefined;
  };
  state.colorBy = choice("color");
  state.dashBy = choice("dash");
  const visibleList = (key) => (query.get(key) === "~" ? [] : query.list(key));
  const metrics = visibleList("metrics");
  if (metrics) {
    for (const metric of section.metrics) if (!metrics.includes(metric.slug)) state.hiddenMetrics.add(metric.key);
  }
  for (const d of section.dims) {
    const visible = visibleList(dimensionParam(d.key));
    if (!visible) continue;
    state.hidden.set(d.key, new Set(d.values.filter((v) => !visible.includes(v.param)).map((v) => v.token)));
  }
  if (pending.from || pending.to) {
    computeView();
    const find = (key) => view.runs.findIndex((run) => run.key === key);
    const from = find(pending.from);
    const to = find(pending.to);
    state.zoom = { start: from < 0 ? 0 : percentOfRun(from), end: to < 0 ? 100 : percentOfRun(to) };
  }
}

// Zoom windows are percentages of the x axis, which spans run positions or dates.
function percentOfRun(j) {
  const runs = view.runs;
  if (runs.length < 2) return 0;
  if (state.axis === "date") {
    const span = runs.at(-1).date - runs[0].date;
    return span > 0 ? ((runs[j].date - runs[0].date) / span) * 100 : 0;
  }
  return (j / (runs.length - 1)) * 100;
}

function runAtPercent(percent) {
  const runs = view.runs;
  if (state.axis !== "date") return runs[Math.round((percent / 100) * (runs.length - 1))];
  const target = runs[0].date + (percent / 100) * (runs.at(-1).date - runs[0].date);
  return runs.reduce((best, run) => (Math.abs(run.date - target) < Math.abs(best.date - target) ? run : best));
}

// The view positions of the first and last run in the zoom window, computed once per window and
// view, since axis label callbacks ask for them for every candidate label.
let windowCache = null;

function zoomWindow() {
  const key = `${state.zoom?.start}|${state.zoom?.end}|${state.axis}`;
  if (windowCache?.view === view && windowCache.key === key) return windowCache;
  const zoom = zoomedRuns();
  // Runs in a view are consecutive, so a run's position is its index past the view's offset.
  const first = zoom ? zoom.from.index - view.offset : 0;
  const last = zoom ? zoom.to.index - view.offset : view.runs.length - 1;
  windowCache = { view, key, first, last };
  return windowCache;
}

// The first and last run inside the zoom window, or null when nothing is zoomed.
function zoomedRuns() {
  if (!state.zoom || (state.zoom.start <= 0 && state.zoom.end >= 100)) return null;
  if (view.runs.length === 0) return null;
  return { from: runAtPercent(state.zoom.start), to: runAtPercent(state.zoom.end) };
}

// Helpers

function theme() {
  const style = getComputedStyle(document.documentElement);
  const get = (name) => style.getPropertyValue(`--${name}`).trim();
  return {
    bg: get("bg"),
    ink: get("ink"),
    ink2: get("ink-2"),
    muted: get("muted"),
    grid: get("grid"),
    axis: get("axis"),
    rule: get("rule"),
    accent: get("accent"),
    worse: get("worse"),
    better: get("better"),
    noise: get("noise"),
    font: get("font"),
    series: Array.from({ length: SLOTS }, (_, i) => get(`s${i + 1}`)),
  };
}

function withAlpha(color, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const n = parseInt(match[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Only numbers count; Number() would turn null, "" and false into a real zero.
function numeric(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// An unambiguous key for a flat map: sorted pairs, with each value's type kept, so `4` and `"4"`
// stay apart and no delimiter inside a value can collide.
function canonical(tags) {
  return JSON.stringify(
    Object.keys(tags ?? {})
      .sort()
      .map((key) => [key, tags[key]]),
  );
}

function token(value) {
  return value === undefined ? MISSING : `${typeof value}:${value}`;
}

// Escapes the characters that separate the parts of a link id, so joined parts stay apart.
function linkPart(text) {
  return String(text).replace(/[%/=#~:,]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

// A value as it reads in a link, which depends on the value alone, so a link keeps working as
// other values appear.
// Numbers and booleans read as plain text and no value reads as `-`.
// A string reads as itself unless it could be mistaken for one of those, for the empty selection
// `~`, or for a prefixed string, in which case it gets an `s:` prefix.
function urlText(value) {
  if (value === undefined) return "-";
  if (typeof value !== "string") return String(value);
  const ambiguous =
    value === "" || value === "-" || value === "~" || value === "true" || value === "false" || value.startsWith("s:") || String(Number(value)) === value;
  return ambiguous ? `s:${value}` : value;
}

function omit(source, keys) {
  const out = Object.create(null);
  for (const [key, value] of Object.entries(source ?? {})) if (!keys.has(key)) out[key] = value;
  return out;
}

function compareOrder(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d) return d;
  }
  return 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainObject(value) {
  return isPlainObject(value) ? value : {};
}

function unique(items) {
  return [...new Set(items)];
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

function showProblem(title, message) {
  const box = document.getElementById("problem");
  box.replaceChildren(h("h2", {}, title), h("p", {}, message));
  box.hidden = false;
  document.getElementById("summary").textContent = "";
}

// Boot last, once every module-level constant above is initialized.
boot();
