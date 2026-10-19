// benchtrail renders a github-action-benchmark history (`window.BENCHMARK_DATA`) as a dashboard.
// It needs no build step: ECharts comes from the CDN script tag in index.html, and everything else
// is in this module.
//
// Each recorded entry becomes an observation: a set of named dimensions, a metric, a value, and the
// environment it ran in.
// Typed entries carry these in `extra` as JSON under a `benchtrail` key; untyped entries fall back
// to a configured name pattern, or to their name as the only dimension.

const echarts = window.echarts;
const GROUP = "benchtrail";
const PAGE_SIZE = 30;
// Past these, the readout under a chart and the grid of charts fold behind a "show all" toggle.
const READOUT_ROWS = 8;
const CHART_LIMIT = 12;
const CHANGES_SHOWN = 5;
const HISTORY_COLUMNS = 6;
const MEDIAN_WINDOW = 10;
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
const AXES = [
  { key: "run", label: "By run" },
  { key: "date", label: "By date" },
];

// Unit families, smallest step first, as [label, size in the family's base unit].
const FAMILIES = {
  time: [
    ["ns", 1e-9],
    ["µs", 1e-6],
    ["ms", 1e-3],
    ["s", 1],
    ["min", 60],
    ["h", 3600],
  ],
  iec: [
    ["B", 1],
    ["KiB", 2 ** 10],
    ["MiB", 2 ** 20],
    ["GiB", 2 ** 30],
    ["TiB", 2 ** 40],
  ],
  si: [
    ["B", 1],
    ["kB", 1e3],
    ["MB", 1e6],
    ["GB", 1e9],
    ["TB", 1e12],
  ],
};
const UNIT_ALIASES = { us: "µs", μs: "µs", sec: "s", secs: "s", seconds: "s", bytes: "B", byte: "B", KB: "kB", kb: "kB" };
const FAMILY_LABELS = { time: "Time", iec: "Size", si: "Size" };

// Settings a config may give for every suite at its top level, or for one suite under `suites`.
const SETTING_KEYS = ["names", "label", "metrics", "dimensions", "colorBy", "dashBy", "ignoreEnvironment"];

// The token that stands for "this observation has no value for the dimension", in filters and links.
const MISSING = "-";

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
  // The open filter menu, as { key, focus, query }, or null.
  menu: null,
  allCharts: false,
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

boot();

async function boot() {
  wireTheme();
  if (!echarts) {
    showProblem("The chart library did not load", "This page loads ECharts from cdn.jsdelivr.net. Check the network connection or any content blocker, then reload.");
    return;
  }
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
  section = suite.sections.find((s) => s.label === state.section) ?? suite.sections[0];
  state.section = section.label;
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
    dataUrl: fromQuery && sameOrigin(fromQuery) ? fromQuery : raw.dataUrl ?? "data.js",
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
      reject(new Error(`Could not load ${url}. Check that github-action-benchmark has pushed its history next to this page, or point "dataUrl" in the page's config block at it.`));
    document.head.append(script);
  });
}

// Observations

// Reads one recorded entry into its benchmark identity, dimensions, metric, and environment.
// The action stores `extra` as a string, so typed metadata arrives as JSON text.
function readEntry(entry, settings, note) {
  const name = String(entry.name ?? "");
  const extra = typeof entry.extra === "string" ? entry.extra : null;
  let parsed = null;
  if (extra && extra.trimStart().startsWith("{")) {
    try {
      parsed = JSON.parse(extra);
    } catch {
      parsed = null;
    }
  }

  // Typed entry
  if (isPlainObject(parsed) && parsed.benchtrail !== undefined) {
    const typed = readTyped(parsed.benchtrail);
    const text = typeof parsed.text === "string" ? parsed.text : null;
    if (typed.ok) return { ...typed.value, text };
    // A payload that does not validate keeps its raw history, apart from every other history, so a
    // broken producer never merges into or splits a good one.
    note(`${name}: ${typed.error}; it is shown on its own, by name.`);
    return { benchmarkId: `\u0000invalid\u0000${name}`, dimensions: { benchmark: name }, metricId: "", metricLabel: null, direction: null, environment: {}, text };
  }

  // Untyped entry, read through the configured name pattern when it matches
  const groups = settings.names?.exec(name)?.groups;
  if (groups) {
    const { metric = "", ...rest } = groups;
    const dimensions = {};
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) dimensions[key] = value;
    return { benchmarkId: null, dimensions, metricId: metric.trim(), metricLabel: null, direction: null, environment: {}, text: extra };
  }
  return { benchmarkId: null, dimensions: { benchmark: name }, metricId: "", metricLabel: null, direction: null, environment: {}, text: extra };
}

// Validates version 1 of the typed payload.
// Unknown properties are allowed, so later additions stay readable; recognized ones must be valid.
function readTyped(payload) {
  if (!isPlainObject(payload)) return { ok: false, error: "extra.benchtrail is not an object" };
  if (payload.version !== 1) return { ok: false, error: `extra.benchtrail has unsupported version ${JSON.stringify(payload.version)}` };
  const dimensions = readTags(payload.dimensions ?? {});
  if (!dimensions) return { ok: false, error: "extra.benchtrail.dimensions must map names to strings, finite numbers, or booleans" };
  const environment = readTags(payload.environment ?? {});
  if (!environment) return { ok: false, error: "extra.benchtrail.environment must map names to strings, finite numbers, or booleans" };
  const metric = payload.metric;
  if (!isPlainObject(metric) || typeof metric.id !== "string" || metric.id === "") {
    return { ok: false, error: "extra.benchtrail.metric.id must be a non-empty string" };
  }
  if (payload.benchmarkId !== undefined && (typeof payload.benchmarkId !== "string" || payload.benchmarkId === "")) {
    return { ok: false, error: "extra.benchtrail.benchmarkId must be a non-empty string" };
  }
  const direction = ["lower", "higher", "unknown"].includes(metric.direction) ? metric.direction : null;
  return {
    ok: true,
    value: {
      benchmarkId: payload.benchmarkId ?? null,
      dimensions,
      metricId: metric.id,
      metricLabel: typeof metric.label === "string" && metric.label ? metric.label : null,
      direction,
      environment,
    },
  };
}

function readTags(tags) {
  if (!isPlainObject(tags)) return null;
  for (const value of Object.values(tags)) {
    const scalar = typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
    if (!scalar) return null;
  }
  return { ...tags };
}

// Model

function buildSuite(name, rawRuns) {
  const settings = suiteSettings(name);
  const runs = rawRuns.map((raw, index) => normalizeRun(raw, index));
  const problems = new Map();
  const note = (message) => problems.set(message, (problems.get(message) ?? 0) + 1);

  // Read every observation into its metric and its history, in order of first appearance.
  const metrics = new Map();
  const histories = new Map();
  for (const [index, raw] of rawRuns.entries()) {
    for (const entry of Array.isArray(raw.benches) ? raw.benches : []) {
      const observation = readEntry(entry, settings, note);
      const unit = String(entry.unit ?? "");
      const metric = metricFor(metrics, observation.metricId, unit, settings);
      if (observation.metricLabel) metric.rowLabel = observation.metricLabel;
      if (observation.direction) metric.explicit.add(observation.direction);
      else metric.implied.add(BIGGER_IS_BETTER.has(raw.tool) ? "higher" : "lower");

      // A history is one benchmark measured in one metric.
      // An explicit id keeps a benchmark's history together while its dimensions change; without
      // one, the dimensions themselves are its identity.
      const benchmark = observation.benchmarkId !== null ? `id:${observation.benchmarkId}` : `dims:${canonical(observation.dimensions)}`;
      const key = `${metric.key}\u0001${benchmark}`;
      let history = histories.get(key);
      if (!history) {
        history = {
          key,
          metric,
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
      if (history.observed[index]) {
        note(`${entry.name} is recorded more than once in run ${runs[index].short}; the page keeps the first value.`);
        continue;
      }
      history.observed[index] = true;
      history.name = String(entry.name ?? "");
      history.dimsAt[index] = observation.dimensions;
      history.envAt[index] = observation.environment;
      history.texts[index] = observation.text;
      history.ranges[index] = entry.range ?? null;
      const value = numeric(entry.value);
      if (value !== null) history.values[index] = value * unitFactor(unit, metric.unit);
    }
  }

  resolveMetrics(metrics, settings, note);
  for (const history of histories.values()) trace(history, settings);

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
    metric = { key, id, unit: canonicalUnit, rowLabel: null, explicit: new Set(), implied: new Set(), direction: "lower", label: "" };
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
    if (previousValue !== null && previousValue !== 0) history.change[i] = value / previousValue - 1;
    previousValue = value;
  }
  const last = history.dimsAt.findLast((dims) => dims !== null) ?? {};
  history.dims = last;
  history.keys = new Set(history.dimsAt.filter(Boolean).flatMap((dims) => Object.keys(dims)));
}

function describeChanges(before, after) {
  const keys = unique([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return keys
    .filter((key) => token(before?.[key]) !== token(after?.[key]))
    .map((key) => `${key} ${before?.[key] ?? "none"} → ${after?.[key] ?? "none"}`);
}

// Sections group histories that share at least one dimension, directly or through another history.
// Benchmarks with unrelated dimensions, such as two phases measured on different inputs, land in
// separate sections, while a benchmark that gains one dimension stays with its family.
function buildSections(histories, settings) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const union = (a, b) => parent.set(find(a), find(b));
  for (const history of histories) {
    const keys = history.keys.size ? [...history.keys].map((k) => `k:${k}`) : [`h:${history.key}`];
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (const key of keys.slice(1)) union(keys[0], key);
  }
  const groups = new Map();
  for (const history of histories) {
    const anchor = history.keys.size ? `k:${[...history.keys][0]}` : `h:${history.key}`;
    const root = find(anchor);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(history);
  }

  const sections = [...groups.values()].map((members) => buildSection(members, settings));
  const counts = countBy(sections, (s) => s.label);
  for (const [i, s] of sections.entries()) if (counts.get(s.label) > 1) s.label = `${s.label} ${i + 1}`;
  return sections;
}

function buildSection(histories, settings) {
  // Dimensions in config order, then in order of first appearance.
  const keys = unique(histories.flatMap((history) => [...history.keys]));
  const order = (key) => Number(settings.dimensions[key]?.order ?? Infinity);
  keys.sort((a, b) => order(a) - order(b));

  const dims = keys.map((key) => {
    const values = new Map();
    let missing = false;
    for (const history of histories) {
      for (const dims of history.dimsAt) {
        if (!dims) continue;
        if (dims[key] === undefined) missing = true;
        else if (!values.has(token(dims[key]))) values.set(token(dims[key]), dims[key]);
      }
    }
    const list = [...values.entries()].map(([tok, value]) => ({ token: tok, value }));
    // Numbers sort by size; strings and booleans keep their order of appearance.
    if (list.every(({ value }) => typeof value === "number")) list.sort((a, b) => a.value - b.value);
    if (missing) list.push({ token: MISSING, value: undefined });
    const texts = shortTexts(list.map(({ value }) => value));
    for (const [i, entry] of list.entries()) {
      entry.index = i;
      entry.text = texts[i];
    }
    const latest = new Set(histories.map((history) => token(history.dims[key])));
    return { key, label: dimensionLabel(key, settings), values: list, byToken: new Map(list.map((v) => [v.token, v])), varying: latest.size > 1 };
  });

  const section = {
    label: dims.map((d) => d.label).join(", ") || "Benchmarks",
    histories,
    dims,
    metrics: unique(histories.map((history) => history.metric)),
    settings,
  };
  for (const history of histories) history.label = historyLabel(history, section);
  // Two histories with the same label in one metric get their recorded names to tell them apart.
  for (const metric of section.metrics) {
    const members = histories.filter((history) => history.metric === metric);
    const counts = countBy(members, (history) => history.label);
    for (const history of members) if (counts.get(history.label) > 1) history.label = `${history.label} (${history.name})`;
  }
  return section;
}

// A history's label is the config template when every name it uses is a dimension of the
// history, otherwise the values of the dimensions that vary in its section.
function historyLabel(history, section) {
  const template = typeof section.settings.label === "string" ? section.settings.label : null;
  if (template) {
    const names = [...template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
    if (names.length && names.every((name) => history.dims[name] !== undefined)) {
      return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name) => String(history.dims[name]));
    }
  }
  const parts = section.dims.filter((d) => d.varying).map((d) => valueText(d, history.dims[d.key]));
  return parts.join(" / ") || history.name;
}

function normalizeRun(raw, index) {
  const commit = raw.commit ?? {};
  const message = String(commit.message ?? "");
  const id = String(commit.id ?? "");
  return {
    index,
    id,
    short: id.slice(0, 7),
    message,
    subject: message.split("\n")[0].trim() || "(no commit message)",
    body: message.split("\n").slice(1).join("\n").trim(),
    url: safeUrl(commit.url),
    author: commit.author?.name || commit.author?.username || "unknown author",
    date: Number(raw.date) || Date.parse(commit.timestamp) || 0,
    tool: raw.tool,
  };
}

function metricLabel(id, unit) {
  if (!id) {
    const family = parseUnit(unit)?.family;
    return family ? FAMILY_LABELS[family] : unit || "Value";
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

// Picks which dimension colors the lines, which sets their dash, and which split the charts.
// Every varying dimension that neither colors nor dashes splits the charts, so no two lines in one
// chart ever look the same.
function choosePivot() {
  const varying = section.dims.filter((d) => d.varying);
  const has = (key) => varying.some((d) => d.key === key);
  const size = (d) => d.values.length;
  const pick = (choice, configured, auto) => {
    if (choice === "") return null;
    if (choice && has(choice)) return choice;
    if (typeof configured === "string" && has(configured)) return configured;
    return auto();
  };

  const color = pick(state.colorBy, section.settings.colorBy, () => {
    const fits = varying.filter((d) => size(d) <= SLOTS);
    if (fits.length) return fits.reduce((best, d) => (size(d) > size(best) ? d : best)).key;
    const doubled = varying.filter((d) => size(d) <= SLOTS * 2);
    return doubled.length ? doubled.reduce((best, d) => (size(d) < size(best) ? d : best)).key : null;
  });
  const rest = varying.filter((d) => d.key !== color);
  const colorDim = varying.find((d) => d.key === color);
  const dash = pick(state.dashBy === color ? "" : state.dashBy, section.settings.dashBy === color ? null : section.settings.dashBy, () => {
    // Dashes only distinguish a few lines, and a color past its eighth slot already uses them.
    if (!colorDim || size(colorDim) > SLOTS) return null;
    const fits = rest.filter((d) => size(d) <= DASHES.length);
    return fits.length ? fits.reduce((best, d) => (size(d) < size(best) ? d : best)).key : null;
  });
  const facet = rest.filter((d) => d.key !== dash).map((d) => d.key);
  return { color, dash, facet };
}

function computeView() {
  const range = RANGES.find((r) => r.key === state.range) ?? RANGES.at(-1);
  const offset = Math.max(0, suite.runs.length - range.count);
  const runs = suite.runs.slice(offset);
  const pivot = choosePivot();
  const metrics = section.metrics.filter((m) => !state.hiddenMetrics.has(m.key));
  const dimsByKey = new Map(section.dims.map((d) => [d.key, d]));

  // Filters apply to each observation, since a benchmark's dimensions can change over its history.
  const passes = (dims) => section.dims.every((d) => !state.hidden.get(d.key)?.has(token(dims[d.key])));

  const lines = [];
  for (const history of section.histories) {
    if (state.hiddenMetrics.has(history.metric.key)) continue;
    const values = history.values.map((v, i) => (v !== null && passes(history.dimsAt[i]) ? v : null));
    if (!history.dimsAt.some((dims, i) => dims && i >= offset && passes(dims))) continue;
    const change = history.change.map((c, i) => (values[i] === null ? null : c));
    const facetDims = pivot.facet.map((key) => dimsByKey.get(key));
    const facetValues = facetDims.map((d) => d.byToken.get(token(history.dims[d.key])));
    lines.push({
      history,
      name: history.key,
      metricId: history.metric.key,
      unit: history.metric.unit,
      values,
      change,
      ranges: history.ranges,
      texts: history.texts,
      label: history.label,
      sortKey: `${history.metric.label}: ${history.label}`,
      style: lineStyle(history, pivot, dimsByKey),
      facet: {
        token: facetValues.map((v) => v.token).join("\u0003"),
        label: facetDims.map((d, i) => valueText(d, facetValues[i].value)).join(" / "),
        order: facetValues.map((v) => v.index),
      },
    });
  }
  // Lines sort by facet, then color, then dash, so tables read in the same order as the charts.
  lines.sort((a, b) => compareOrder(a.facet.order, b.facet.order) || a.style.colorIndex - b.style.colorIndex || a.style.dashIndex - b.style.dashIndex);

  // The first value in the range is the baseline for the change view.
  const baseline = new Map();
  for (const line of lines) {
    baseline.set(line.name, runs.map((run) => line.values[run.index]).find((v) => v !== null && v !== 0) ?? null);
  }

  // Runs where a visible history crossed a comparison boundary, with what changed.
  const boundaries = new Map();
  for (const line of lines) {
    for (const run of runs) {
      const changes = line.history.boundary[run.index];
      if (!changes || line.values[run.index] === null) continue;
      boundaries.set(run.index, unique([...(boundaries.get(run.index) ?? []), ...changes]));
    }
  }

  let selected = runs.findIndex((run) => state.run && run.key === state.run);
  if (selected < 0) selected = runs.length - 1;
  view = { runs, offset, benches: lines, metrics, baseline, boundaries, selected, pivot };
}

// A line's color comes from its value of the color dimension and its dash from the dash
// dimension, both by the value's fixed position, so filtering never repaints the lines that stay.
function lineStyle(history, pivot, dimsByKey) {
  const colorDim = pivot.color ? dimsByKey.get(pivot.color) : null;
  const dashDim = pivot.dash ? dimsByKey.get(pivot.dash) : null;
  const colorIndex = colorDim ? colorDim.byToken.get(token(history.dims[colorDim.key])).index : 0;
  let dashIndex = dashDim ? dashDim.byToken.get(token(history.dims[dashDim.key])).index : 0;
  if (!dashDim && colorIndex >= SLOTS) dashIndex = 1;
  const parts = [colorDim, dashDim].filter(Boolean).map((d) => valueText(d, history.dims[d.key]));
  return {
    slot: colorIndex % SLOTS,
    colorIndex,
    dashIndex,
    dash: DASHES[dashIndex % DASHES.length],
    label: parts.join(" / ") || history.label,
  };
}

function badness(metric, change) {
  if (change === null || metric.direction === "unknown") return null;
  return metric.direction === "higher" ? -change : change;
}

function verdict(metric, change) {
  const bad = badness(metric, change);
  if (bad === null) return change === null ? "none" : "noise";
  if (bad > config.threshold) return "worse";
  if (bad < -config.threshold) return "better";
  return "noise";
}

// The trail bar for a run is its largest regression when it has one, otherwise its largest
// improvement; both are signed so that regressions point up.
function runScore(runIndex) {
  let worst = 0;
  let best = 0;
  for (const line of view.benches) {
    const bad = badness(line.history.metric, line.change[runIndex]);
    if (bad === null) continue;
    worst = Math.max(worst, bad);
    best = Math.min(best, bad);
  }
  return worst > config.threshold || worst >= -best ? worst : best;
}

// Rendering

function render() {
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
}

function renderMasthead() {
  const repo = safeUrl(data.repoUrl);
  const path = repo ? new URL(repo).pathname.split("/").filter(Boolean) : [];
  const name = config.title ?? (path.slice(-2).join("/") || "Benchmarks");
  const link = document.getElementById("project-link");
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
      h("button", {
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
      }, s.name),
    ),
  );

  const sections = document.getElementById("sections");
  sections.hidden = suite.sections.length < 2;
  sections.replaceChildren(
    ...suite.sections.map((s) =>
      h("button", {
        type: "button",
        class: "option",
        role: "tab",
        "aria-selected": String(s === section),
        onclick: () => s !== section && switchSection(s),
      }, s.label),
    ),
  );
}

function switchSection(next) {
  section = next;
  state.section = next.label;
  state.hiddenMetrics = new Set();
  state.hidden.clear();
  state.menu = null;
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

  // Color and dash choices list the dimensions that vary, plus none.
  const varying = section.dims.filter((d) => d.varying);
  const choices = (exclude) => [
    ...varying.filter((d) => d.key !== exclude).map((d) => ({ key: d.key, label: d.label })),
    { key: "", label: "None" },
  ];
  document.getElementById("color-group").hidden = varying.length === 0;
  segmented("color", choices(null), view.pivot.color ?? "", (key) => {
    state.colorBy = key;
    render();
  });
  document.getElementById("dash-group").hidden = varying.length < 2 || !view.pivot.color;
  segmented("dash", choices(view.pivot.color), view.pivot.dash ?? "", (key) => {
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
    ...filter.items.map((item) =>
      toggleChip(item.text, !filter.hidden.has(item.token), item.style, () => {
        const next = new Set(filter.hidden);
        if (next.has(item.token)) next.delete(item.token);
        else next.add(item.token);
        filter.setHidden(next);
        render();
      }),
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
    visible.length === total ? "all" : visible.length === 0 ? "none" : visible.length <= 2 ? visible.map((item) => item.text).join(", ") : `${visible.length} of ${total}`;
  const open = state.menu?.key === filter.key;
  const apply = (next, focus) => {
    filter.setHidden(next);
    state.menu = { ...state.menu, key: filter.key, focus };
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
        state.menu = open ? null : { key: filter.key, focus: null, query: "" };
        render();
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

function filterMenuItems(menu) {
  const query = (state.menu?.query ?? "").trim().toLowerCase();
  for (const item of menu.querySelectorAll(".menu-item")) item.hidden = Boolean(query) && !item.dataset.text.includes(query);
}

// Restores the open menu after a render: its search text, its focus, and a position that keeps
// the panel inside the viewport.
function restoreMenu() {
  const menu = [...document.querySelectorAll(".menu")].find((m) => m.dataset.menu === state.menu.key);
  if (!menu) {
    state.menu = null;
    return;
  }
  const search = menu.querySelector(".menu-search");
  if (search) {
    search.value = state.menu.query ?? "";
    filterMenuItems(menu);
  }
  const panel = menu.querySelector(".menu-panel");
  const overflow = panel.getBoundingClientRect().right - (document.documentElement.clientWidth - 16);
  if (overflow > 0) panel.style.left = `${-overflow}px`;
  const focus = state.menu.focus;
  const target = [...menu.querySelectorAll("[data-focus]")].find((el) => el.dataset.focus === focus) ?? search ?? menu.querySelector("input");
  target?.focus({ preventScroll: true });
}

function closeMenu(returnFocus) {
  if (!state.menu) return;
  const key = state.menu.key;
  state.menu = null;
  render();
  if (returnFocus) [...document.querySelectorAll(".menu")].find((m) => m.dataset.menu === key)?.querySelector(".menu-button")?.focus();
}

function toggle(set, id) {
  if (set.has(id)) set.delete(id);
  else set.add(id);
  render();
}

function segmented(id, options, current, onChange) {
  document.getElementById(id).replaceChildren(
    ...options.map((option) =>
      h("button", {
        type: "button",
        class: "option",
        role: "radio",
        "aria-checked": String(option.key === current),
        onclick: () => option.key !== current && onChange(option.key),
      }, option.label),
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
  enableDragZoom(trail);
}

// Bar height is the square root of the change, so runner noise stays visible as texture while a
// real step still stands well above it. The details panel reports the actual change.
function trailOption(t) {
  const byDate = state.axis === "date";
  const scores = view.runs.map((run) => runScore(run.index));
  const height = (score) => Math.sign(score) * Math.sqrt(Math.abs(score) * 100);
  const reach = Math.max(height(config.threshold * 3), ...scores.map((s) => Math.abs(height(s))));
  const bars = view.runs.map((run, j) => {
    const score = scores[j];
    const tone = score > config.threshold ? t.worse : score < -config.threshold ? t.better : t.noise;
    return { value: byDate ? [run.date, height(score)] : height(score), itemStyle: { color: tone } };
  });
  return {
    animation: false,
    textStyle: { fontFamily: t.font, color: t.muted },
    grid: { left: 0, right: 0, top: 4, bottom: 44 },
    xAxis: xAxis(t, { line: false }),
    yAxis: { type: "value", min: -reach, max: reach, show: false },
    tooltip: crosshair(t),
    dataZoom: dataZoom(t, true),
    toolbox: { show: false, feature: { dataZoom: { yAxisIndex: "none" } } },
    series: [
      {
        id: "trail",
        type: "bar",
        data: bars,
        barCategoryGap: "30%",
        barMaxWidth: 6,
        barMinHeight: 1,
        markLine: markers(t),
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
  const t = theme();
  const faceted = view.pivot.facet.length > 0;

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
      chart.observer.disconnect();
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
    return { ...cell, card, dom, note, readout, titleNode: title, instance, observer: instance.observer };
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
          h("h2", {}, group.metric.label, " ", h("span", { class: "note" }, directionText(group.metric))),
          h("div", { class: "multiples" }, ...group.cells.map((cell) => charts.find((chart) => chart.key === cell.key).card)),
        ),
      ),
    );
  } else {
    container.replaceChildren(...charts.map((chart) => chart.card));
  }
  if (allToggle) container.append(allToggle);
  for (const chart of charts) {
    const { option, unitLabel } = lineOption(chart.metric, chart.benches, t, faceted);
    chart.titleNode.textContent = chart.title;
    chart.note.textContent = faceted ? unitLabel : `${unitLabel}, ${directionText(chart.metric)}`;
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
  chart.readoutItems = lines.map((line) => {
    const cells = { value: h("td", { class: "readout-value" }), change: h("td"), spread: h("td"), median: h("td") };
    const row = h(
      "tr",
      {},
      h("td", { class: "readout-label", title: line.label }, lineKey(line.style), line.style.label),
      cells.value,
      cells.change,
      state.more ? cells.spread : null,
      state.more ? cells.median : null,
    );
    return { line, cells, row };
  });
  const cols = [h("col"), h("col", { class: "num" }), h("col", { class: "num" })];
  if (state.more) cols.push(h("col", { class: "num" }), h("col", { class: "num" }));
  const head = state.more
    ? h("thead", {}, h("tr", {}, h("th"), h("th", {}, "Value"), h("th", {}, "Change"), h("th", {}, "Spread"), h("th", { title: `Change against the median of the previous ${MEDIAN_WINDOW} runs` }, "vs median")))
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
    ...[h("table", { class: "readout-table" }, h("colgroup", {}, ...cols), head, h("tbody", {}, ...chart.readoutItems.map((item) => item.row))), toggle].filter(Boolean),
  );
}

function updateReadouts(run) {
  for (const chart of charts) {
    for (const { line, cells } of chart.readoutItems ?? []) {
      const value = line.values[run.index];
      const change = line.change[run.index];
      const kind = verdict(chart.metric, change);
      cells.value.textContent = value === null ? "–" : formatValue(value, line.unit);
      cells.change.replaceChildren(changeElement(change, kind));
      // A row whose run regressed or improved is emphasized, so the lines that moved stand out.
      cells.value.parentElement.dataset.verdict = kind;
      if (state.more) {
        const median = medianBefore(line, run.index);
        const vsMedian = value !== null && median ? value / median - 1 : null;
        cells.spread.textContent = line.ranges[run.index] ?? "–";
        cells.median.replaceChildren(changeElement(vsMedian, verdict(chart.metric, vsMedian)));
      }
    }
  }
}

function directionText(metric) {
  if (metric.direction === "higher") return "higher is better";
  if (metric.direction === "lower") return "lower is better";
  return "direction unknown";
}

function lineOption(metric, benches, t, compact) {
  const byDate = state.axis === "date";
  const asChange = state.scale === "change";
  let magnitude = 0;
  for (const bench of benches) {
    for (const run of view.runs) magnitude = Math.max(magnitude, Math.abs(bench.values[run.index] ?? 0));
  }
  const unit = displayUnit(metric.unit, magnitude);
  const unitLabel = asChange ? `% since ${formatDate(view.runs[0].date)}` : unit.label || "value";

  const series = benches.map((bench, i) => {
    const color = t.series[bench.style.slot];
    const base = view.baseline.get(bench.name);
    const points = view.runs.map((run) => {
      const value = bench.values[run.index];
      let y = null;
      if (value !== null) y = asChange ? (base ? (value / base - 1) * 100 : null) : value * unit.factor;
      return byDate ? [run.date, y] : y;
    });
    return {
      id: bench.name,
      name: bench.style.label,
      type: "line",
      data: points,
      connectNulls: false,
      symbol: "circle",
      symbolSize: 7,
      showSymbol: view.runs.length <= 40,
      sampling: view.runs.length > 800 ? "lttb" : undefined,
      lineStyle: { width: 1.75, color, type: bench.style.dash, cap: "round", join: "round" },
      itemStyle: { color, borderColor: t.bg, borderWidth: 2 },
      emphasis: { disabled: true },
      labelLayout: { hideOverlap: true },
      markLine: i === 0 ? markers(t) : undefined,
    };
  });

  const option = {
    animation: false,
    textStyle: { fontFamily: t.font, color: t.muted },
    grid: { left: 0, right: 8, top: 12, bottom: 26, containLabel: true },
    xAxis: xAxis(t, { line: true }),
    yAxis: {
      type: "value",
      scale: asChange,
      splitNumber: compact ? 3 : 4,
      axisLabel: {
        color: t.muted,
        fontSize: 11,
        formatter: asChange ? (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Number(v.toFixed(1)))}%` : (v) => formatTick(v),
      },
      splitLine: { lineStyle: { color: t.grid, width: 1 } },
    },
    tooltip: crosshair(t),
    dataZoom: dataZoom(t, false),
    series,
  };
  return { option, unitLabel };
}

// Shared chart parts

// Every chart joins one group, so zoom and the hover crosshair move together. Hovering shows no
// overlay: it previews the run in the details panel below the charts instead.
function createChart(dom) {
  const instance = echarts.init(dom, null, { renderer: "svg" });
  instance.group = GROUP;
  echarts.connect(GROUP);
  instance.observer = observeSize(dom, instance);
  instance.on("datazoom", () => {
    const zoom = instance.getOption().dataZoom?.[0];
    if (!zoom) return;
    state.zoom = { start: zoom.start, end: zoom.end };
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      renderChanges();
      renderHistory();
      writeUrl();
    }, 250);
  });
  instance.on("updateAxisPointer", (event) => {
    const x = event.axesInfo?.find((info) => info.axisDim === "x")?.value;
    if (x !== undefined) preview(indexAtX(x));
  });
  instance.getZr().on("globalout", () => preview(null));
  instance.getZr().on("click", (event) => selectAtPixel(instance, event));
  return instance;
}

function crosshair(t) {
  return {
    trigger: "axis",
    showContent: false,
    axisPointer: { type: "line", lineStyle: { color: t.axis, width: 1, type: "solid" }, label: { show: false } },
  };
}

function xAxis(t, { line }) {
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
    axisLabel: { ...label, formatter: (value) => formatDate(suite.runs[Number(value.slice(1))]?.date) },
    splitLine: { show: false },
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
    moveOnMouseMove: !slider,
  };
  if (!slider) return [inside];
  return [
    inside,
    {
      type: "slider",
      filterMode: "none",
      start: zoom.start,
      end: zoom.end,
      height: 14,
      bottom: 2,
      left: 0,
      right: 0,
      borderColor: t.rule,
      borderRadius: 3,
      backgroundColor: "transparent",
      fillerColor: withAlpha(t.accent, 0.08),
      showDataShadow: false,
      handleIcon: "path://M0,0 L2,0 L2,24 L0,24 Z",
      handleSize: "100%",
      handleStyle: { color: t.muted, borderWidth: 0 },
      moveHandleSize: 0,
      emphasis: { handleStyle: { color: t.accent } },
      textStyle: { color: t.muted, fontFamily: t.font, fontSize: 11 },
      labelFormatter: (value) => {
        const run = state.axis === "date" ? null : suite.runs[Number(String(value).replace(/^r/, ""))] ?? view.runs[value];
        return formatDate(run ? run.date : value);
      },
      brushSelect: false,
    },
  ];
}

// Vertical rules for the selected run and for every comparison boundary in view, such as a
// toolchain upgrade, so a step in a line can be read against what changed.
// It always returns a mark line, even an empty one, so a merged update clears stale rules.
function markers(t) {
  const x = (run) => (state.axis === "date" ? run.date : `r${run.index}`);
  const rules = view.runs
    .filter((run) => view.boundaries.has(run.index))
    .map((run) => ({ xAxis: x(run), lineStyle: { color: t.axis, width: 1, type: [2, 3] } }));
  const run = view.runs[view.selected];
  if (run) rules.push({ xAxis: x(run), lineStyle: { color: t.ink2, width: 1, type: "solid", opacity: 0.6 } });
  return { symbol: ["none", "none"], silent: true, animation: false, label: { show: false }, data: rules };
}

// Dragging across the trail selects a range to zoom into, which ECharts provides through the
// toolbox's zoom cursor even while the toolbox itself is hidden.
function enableDragZoom(instance) {
  instance.dispatchAction({ type: "takeGlobalCursor", key: "dataZoomSelect", dataZoomSelectActive: true });
}

function observeSize(dom, instance) {
  const observer = new ResizeObserver(() => instance.resize());
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
  const marker = markers(theme());
  trail?.setOption({ series: [{ id: "trail", markLine: marker }] });
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
  const moves = [];
  for (const line of view.benches) {
    const change = line.change[run.index];
    const kind = verdict(line.history.metric, change);
    if (kind === "worse" || kind === "better") moves.push({ line, change, kind });
  }
  return moves.sort((a, b) => (a.kind === "worse" ? 0 : 1) - (b.kind === "worse" ? 0 : 1) || Math.abs(b.change) - Math.abs(a.change));
}

// A wrapping list of moves, each a signed change beside the line it belongs to.
function movesElement(moves, limit) {
  const multipleMetrics = view.metrics.length > 1;
  const shown = moves.slice(0, limit);
  return h(
    "span",
    { class: "moves" },
    ...shown.map(({ line, change, kind }) =>
      h("span", { class: "move" }, changeElement(change, kind), h("span", { class: "what" }, line.label, multipleMetrics ? h("span", { class: "metric" }, line.history.metric.label) : null)),
    ),
    moves.length > shown.length ? h("span", { class: "move what" }, `${moves.length - shown.length} more`) : null,
  );
}

// Changes: the runs in view that regressed or improved, newest first.
// Closed, it is one summary line; opened, it lists the latest few, and then every one.
function renderChanges() {
  const container = document.getElementById("changes");
  const zoom = zoomedRuns();
  const first = zoom ? view.runs.indexOf(zoom.from) : 0;
  const last = zoom ? view.runs.indexOf(zoom.to) : view.runs.length - 1;
  const entries = [];
  let worse = 0;
  let better = 0;
  for (let j = last; j >= first; j -= 1) {
    const moves = significantMoves(view.runs[j]);
    if (!moves.length) continue;
    if (moves.some((m) => m.kind === "worse")) worse += 1;
    if (moves.some((m) => m.kind === "better")) better += 1;
    entries.push({ run: view.runs[j], j, moves });
  }

  const threshold = `${Number((config.threshold * 100).toFixed(1))}%`;
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
      class: "changes-toggle",
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
        )
      : h("span", { class: "changes-counts" }, `no run moved more than ${threshold}`),
  );
  if (!open) {
    container.replaceChildren(summary);
    return;
  }

  const shown = state.changes === "all" ? entries : entries.slice(0, CHANGES_SHOWN);
  const items = shown.map(({ run, j, moves }) =>
    h(
      "li",
      { class: "change-run", "data-view-index": String(j), "aria-selected": String(j === view.selected), onclick: () => selectRun(j) },
      h("span", { class: "subject" }, run.subject),
      h("span", { class: "when" }, h("span", { class: "sha" }, run.short), " ", formatDate(run.date, true)),
      movesElement(moves, 6),
    ),
  );
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
    worse ? h("span", { class: "change worse" }, icon("up"), `${worse} ${worse === 1 ? "regression" : "regressions"}`) : null,
    better ? h("span", { class: "change better" }, icon("down"), `${better} ${better === 1 ? "improvement" : "improvements"}`) : null,
  ].filter(Boolean);
  bar.replaceChildren(
    h(
      "div",
      { class: "run-head" },
      h("button", { type: "button", class: "step", "aria-label": "Previous run", disabled: view.selected === 0, onclick: () => selectRun(view.selected - 1) }, icon("left")),
      h("button", { type: "button", class: "step", "aria-label": "Next run", disabled: view.selected === view.runs.length - 1, onclick: () => selectRun(view.selected + 1) }, icon("right")),
      run.url ? h("a", { class: "sha", href: run.url }, run.short) : h("span", { class: "sha" }, run.short),
      h("span", { class: "run-subject", title: run.subject }, subjectElement(run)),
      h("span", { class: "tally" }, ...tally),
      h(
        "button",
        {
          type: "button",
          class: "more-toggle option",
          "aria-expanded": String(state.more),
          title: "Show each value's spread and its change against the median of earlier runs",
          onclick: () => {
            state.more = !state.more;
            render();
          },
        },
        state.more ? "Less" : "More",
      ),
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
  let worse = 0;
  let better = 0;
  for (const line of view.benches) {
    const kind = verdict(line.history.metric, line.change[run.index]);
    if (kind === "worse") worse += 1;
    else if (kind === "better") better += 1;
  }
  return { worse, better };
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
  const texts = unique(view.benches.map((b) => b.texts[run.index]).filter(Boolean));
  const environment = unique(
    view.benches.flatMap((b) => Object.entries(b.history.envAt[run.index] ?? {}).map(([key, value]) => `${key} ${value}`)),
  );
  const facts = [environment.join(", "), texts.length === 1 ? texts[0] : null].filter(Boolean);
  panel.replaceChildren(
    ...[
      h("p", { class: "message-head" }, run.url ? h("a", { class: "sha", href: run.url }, run.short) : h("span", { class: "sha" }, run.short), " ", `${run.author}, ${formatDateTime(run.date)}`),
      h("h2", { class: "message-subject" }, subjectElement(run)),
      run.body ? h("p", { class: "run-body" }, run.body) : null,
      facts.length ? h("p", { class: "run-extra" }, facts.join("; ")) : null,
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

// The median of the values before a run, within the run's comparison segment.
function medianBefore(line, runIndex) {
  const segment = line.history.segment[runIndex];
  const window = [];
  for (let i = runIndex - 1; i >= 0 && window.length < MEDIAN_WINDOW; i -= 1) {
    if (line.history.segment[i] !== null && line.history.segment[i] !== segment) break;
    if (line.values[i] !== null) window.push(line.values[i]);
  }
  if (window.length === 0) return null;
  window.sort((a, b) => a - b);
  const mid = window.length >> 1;
  return window.length % 2 ? window[mid] : (window[mid - 1] + window[mid]) / 2;
}

// History table: opt-in, searchable, and sortable by any benchmark's change

function renderHistory() {
  const open = state.list;
  const only = document.getElementById("only-changes");
  document.getElementById("history").hidden = !open;
  document.getElementById("search").hidden = !open;
  only.hidden = !open;
  only.setAttribute("aria-pressed", String(state.onlyChanges));
  only.textContent = `Only changes beyond ${Number((config.threshold * 100).toFixed(1))}%`;
  const toggleButton = document.getElementById("list-toggle");
  toggleButton.textContent = open ? "Hide runs" : "Show runs";
  toggleButton.setAttribute("aria-expanded", String(open));
  if (!open) return;

  const table = document.getElementById("history-table");
  const tokens = searchTokens(state.query);
  const sortLine = state.sort && view.benches.find((b) => b.sortKey === state.sort.bench);

  // The list follows the zoom window, so it always shows the runs the charts show.
  const zoom = zoomedRuns();
  const first = zoom ? view.runs.indexOf(zoom.from) : 0;
  const last = zoom ? view.runs.indexOf(zoom.to) : view.runs.length - 1;
  const significant = (run) => view.benches.some((b) => ["worse", "better"].includes(verdict(b.history.metric, b.change[run.index])));
  let runs = view.runs
    .map((run, j) => ({ run, j, match: tokens.length ? searchRun(run, tokens, state.query) : null }))
    .filter(({ j }) => j >= first && j <= last)
    .filter(({ match }) => !tokens.length || match)
    .filter(({ run }) => !state.onlyChanges || significant(run));
  if (tokens.length && !sortLine) {
    // Search results rank by relevance, newest first among equals.
    runs.sort((a, b) => b.match.score - a.match.score || b.j - a.j);
  } else if (sortLine) {
    // Worst first sorts by regression size, best first by improvement size; runs without a
    // change for this benchmark go last either way.
    const sign = state.sort.order === "best" ? -1 : 1;
    const key = ({ run }) => badness(sortLine.history.metric, sortLine.change[run.index]);
    runs.sort((a, b) => (key(a) === null) - (key(b) === null) || sign * (key(b) - key(a)));
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
          const value = line.values[run.index];
          const change = line.change[run.index];
          return h(
            "td",
            {},
            value === null ? "–" : formatValue(value, line.unit),
            changeElement(change, verdict(line.history.metric, change)),
          );
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
// Returns null when a word matches nowhere, otherwise the score and the subject ranges to mark.
function searchRun(run, tokens, query) {
  const subject = run.subject.toLowerCase();
  const author = run.author.toLowerCase();
  const body = run.body.toLowerCase();
  const pr = /\(#(\d+)\)$/.exec(run.subject)?.[1];
  const marks = [];
  let score = 0;
  for (const tok of tokens) {
    let best = 0;
    if (tok.length >= 4 && run.id.toLowerCase().startsWith(tok)) best = 1000;
    if (pr && (tok === pr || tok === `#${pr}`)) best = Math.max(best, 900);
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
    score += 500;
    marks.push([at, at + phrase.length]);
  }
  return { score, marks };
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
    // Tighter spans score higher, and a span much longer than the word is no match.
    const span = range[1] - range[0];
    if (span > tok.length * 2) continue;
    consider(60 - (span - tok.length) * 8, [word.index + range[0], word.index + range[1]]);
  }
  return best;
}

// The span of the first in-order occurrence of every letter of `tok` within `word`.
function subsequence(word, tok) {
  let start = -1;
  let i = 0;
  for (let j = 0; j < word.length && i < tok.length; j += 1) {
    if (word[j] !== tok[i]) continue;
    if (start < 0) start = j;
    i += 1;
    if (i === tok.length) return [start, j + 1];
  }
  return null;
}

function markHistorySelection() {
  for (const row of document.querySelectorAll("#changes .change-run[data-view-index], #history-table tbody tr[data-view-index]")) {
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
  const list = state.notes ? h("ul", { class: "notes-list" }, ...problems.map(([message, n]) => h("li", {}, n > 1 ? `${message} (${n} times)` : message))) : null;
  container.replaceChildren(...[button, list].filter(Boolean));
}

// Controls

function wireControls() {
  const search = document.getElementById("search");
  search.value = state.query;
  search.addEventListener("input", () => {
    state.query = search.value;
    state.shown = PAGE_SIZE;
    renderHistory();
    writeUrl();
  });
  document.getElementById("more").addEventListener("click", () => {
    state.shown += PAGE_SIZE;
    renderHistory();
  });
  document.getElementById("options").hidden = !state.options;
  document.getElementById("options-toggle").setAttribute("aria-expanded", String(state.options));
  document.getElementById("options-toggle").addEventListener("click", (event) => {
    state.options = !state.options;
    document.getElementById("options").hidden = !state.options;
    event.currentTarget.setAttribute("aria-expanded", String(state.options));
  });
  document.getElementById("list-toggle").addEventListener("click", () => {
    state.list = !state.list;
    renderHistory();
    writeUrl();
  });
  document.getElementById("only-changes").addEventListener("click", () => {
    state.onlyChanges = !state.onlyChanges;
    state.shown = PAGE_SIZE;
    renderHistory();
    writeUrl();
  });
  narrow.addEventListener("change", () => renderHistory());
  // A click outside the open menu closes it.
  // A click inside can re-render the menu, which detaches the clicked node, so those are skipped.
  document.addEventListener("click", (event) => {
    if (!state.menu || !event.target.isConnected || event.target.closest(".menu")) return;
    closeMenu(false);
  });
  // Arrow keys step through runs unless a control has focus.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state.menu) {
      closeMenu(true);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest?.("input, textarea, select, [role='radio'], [role='tab'], .menu")) return;
    if (event.key === "ArrowLeft") selectRun(view.selected - 1);
    else if (event.key === "ArrowRight") selectRun(view.selected + 1);
    else return;
    event.preventDefault();
  });
}

function wireTheme() {
  const button = document.getElementById("theme");
  const choices = ["auto", "light", "dark"];
  const update = () => {
    button.textContent = `Theme: ${document.documentElement.dataset.theme ?? "auto"}`;
  };
  button.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme ?? "auto";
    const choice = choices[(choices.indexOf(current) + 1) % choices.length];
    if (choice === "auto") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = choice;
    try {
      if (choice === "auto") localStorage.removeItem("benchtrail:theme");
      else localStorage.setItem("benchtrail:theme", choice);
    } catch {
      // Storage can be unavailable in private windows; the choice then lasts for this visit.
    }
    update();
    if (view) render();
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (view && !document.documentElement.dataset.theme) render();
  });
  update();
}

// URL state: every view is a shareable link.
// Parameters at their default are left out, and runs are named by commit, so a link keeps
// pointing at the same runs as the history grows.
// A dimension filter uses the dimension's name as its parameter, or `d.<name>` when the name is
// one of the page's own parameters.
// List values are separated by literal commas and each value is percent-encoded, so a value that
// contains a comma survives the round trip.

const URL_KEYS = new Set(["data", "suite", "section", "runs", "metrics", "values", "x", "color", "dash", "from", "to", "run", "more", "charts", "changes", "list", "q", "only", "sort", "order"]);

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
  if (suite.sections.length > 1 && section !== suite.sections[0]) add("section", state.section);
  if (state.range !== "all") add("runs", state.range);
  // Visible sets rather than hidden ones, so a link names exactly what it shows.
  if (state.hiddenMetrics.size) addList("metrics", section.metrics.filter((m) => !state.hiddenMetrics.has(m.key)).map((m) => m.label));
  for (const d of section.dims) {
    const hidden = state.hidden.get(d.key);
    if (hidden?.size) addList(dimensionParam(d.key), d.values.filter((v) => !hidden.has(v.token)).map((v) => v.token));
  }
  if (state.colorBy !== undefined) add("color", state.colorBy || "none");
  if (state.dashBy !== undefined) add("dash", state.dashBy || "none");
  if (state.scale !== "absolute") add("values", state.scale);
  if (state.axis !== "run") add("x", state.axis);
  const zoom = zoomedRuns();
  if (zoom) {
    add("from", zoom.from.key);
    add("to", zoom.to.key);
  }
  const run = view.runs[view.selected];
  if (run && view.selected !== view.runs.length - 1) add("run", run.key);
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
  state.section = query.get("section") ?? null;
  if (RANGES.some((r) => r.key === query.get("runs"))) state.range = query.get("runs");
  if (SCALES.some((s) => s.key === query.get("values"))) state.scale = query.get("values");
  if (AXES.some((a) => a.key === query.get("x"))) state.axis = query.get("x");
  state.run = query.get("run") ?? null;
  state.more = query.get("more") === "1";
  state.allCharts = query.get("charts") === "all";
  state.changes = ["open", "all"].includes(query.get("changes")) ? query.get("changes") : "closed";
  state.list = query.get("list") === "1";
  // A link that changes a display option opens the options, so the reader sees why.
  state.options = ["runs", "values", "x", "color", "dash"].some((key) => query.has(key));
  state.query = query.get("q") ?? "";
  state.onlyChanges = query.get("only") === "changes";
  if (query.get("sort")) state.sort = { bench: query.get("sort"), order: query.get("order") === "best" ? "best" : "worst" };
  state.pending = { query, metrics: query.list("metrics"), from: query.get("from"), to: query.get("to") };
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
    if (value === "none") return "";
    return section.dims.some((d) => d.key === value && d.varying) ? value : undefined;
  };
  state.colorBy = choice("color");
  state.dashBy = choice("dash");
  if (pending.metrics) {
    for (const metric of section.metrics) if (!pending.metrics.includes(metric.label)) state.hiddenMetrics.add(metric.key);
  }
  for (const d of section.dims) {
    const visible = query.list(dimensionParam(d.key));
    if (!visible) continue;
    state.hidden.set(d.key, new Set(d.values.map((v) => v.token).filter((tok) => !visible.includes(tok))));
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

// The first and last run inside the zoom window, or null when nothing is zoomed.
function zoomedRuns() {
  if (!state.zoom || (state.zoom.start <= 0 && state.zoom.end >= 100)) return null;
  if (view.runs.length === 0) return null;
  return { from: runAtPercent(state.zoom.start), to: runAtPercent(state.zoom.end) };
}

// Formatting

function parseUnit(unit) {
  const match = /^\s*([^\s/]+)\s*(.*)$/.exec(unit ?? "");
  if (!match) return null;
  const head = UNIT_ALIASES[match[1]] ?? match[1];
  for (const [family, steps] of Object.entries(FAMILIES)) {
    const step = steps.find(([label]) => label === head);
    if (step) return { family, size: step[1], tail: match[2] };
  }
  return null;
}

// The factor that converts a value recorded in `from` into `to`; units outside a known family
// only ever meet themselves, since metrics are keyed by unit family.
function unitFactor(from, to) {
  if (from === to) return 1;
  const a = parseUnit(from);
  const b = parseUnit(to);
  return a && b && a.family === b.family ? a.size / b.size : 1;
}

// Picks the step that keeps `magnitude` at one or more, and returns the factor that converts a
// recorded value into it. Times stay in seconds up to ten minutes, which reads better than 2.3 min.
function displayUnit(unit, magnitude) {
  const parsed = parseUnit(unit);
  if (!parsed || !(magnitude > 0)) return { label: unit, factor: 1 };
  const base = magnitude * parsed.size;
  let chosen = FAMILIES[parsed.family][0];
  for (const step of FAMILIES[parsed.family]) {
    const floor = parsed.family === "time" && step[1] > 1 ? step[1] * 10 : step[1];
    if (base >= floor) chosen = step;
  }
  return { label: chosen[0] + parsed.tail, factor: parsed.size / chosen[1] };
}

function formatValue(value, unit) {
  const display = displayUnit(unit, Math.abs(value));
  const text = formatNumber(value * display.factor);
  return display.label ? `${text} ${display.label}` : text;
}

function formatNumber(x) {
  const abs = Math.abs(x);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return x.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatTick(x) {
  return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatSigned(x) {
  const rounded = Math.abs(x) < 0.05 ? 0 : x;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `${sign}${Math.abs(rounded).toFixed(Math.abs(rounded) >= 10 ? 0 : 1)}`;
}

function changeParts(ratio, kind) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return { text: "–", arrow: null, label: "no earlier value" };
  const arrow = kind === "worse" || kind === "better" ? (ratio > 0 ? "up" : "down") : null;
  const label = kind === "worse" ? "regression" : kind === "better" ? "improvement" : "within noise";
  return { text: `${formatSigned(ratio * 100)}%`, arrow, label };
}

// A significant change leads with an arrow in its direction, so color is never its only cue.
function changeElement(ratio, kind) {
  const { text, arrow, label } = changeParts(ratio, kind);
  return h("span", { class: `change ${kind}`, title: label }, arrow ? icon(arrow) : null, text);
}

// Thin stroked chevrons, drawn rather than typed, so every arrow on the page has one weight and
// sits on the text's baseline in every font.
const ICONS = {
  up: "M4 10l4-4 4 4",
  down: "M4 6l4 4 4-4",
  left: "M10 3.5 5.5 8l4.5 4.5",
  right: "M6 3.5 10.5 8 6 12.5",
};

function icon(name, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", `icon ${extraClass}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dateYearFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

function formatDate(ms, withYear = false) {
  if (!ms) return "";
  return (withYear ? dateYearFormat : dateFormat).format(ms);
}

function formatDateTime(ms) {
  return ms ? dateTimeFormat.format(ms) : "";
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

// Builds an element; text children become text nodes, so data never reaches the DOM as markup.
function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

function safeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
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
  return JSON.stringify(Object.keys(tags ?? {}).sort().map((key) => [key, tags[key]]));
}

function token(value) {
  return value === undefined ? MISSING : String(value);
}

function omit(tags, keys) {
  const out = {};
  for (const [key, value] of Object.entries(tags ?? {})) if (!keys.has(key)) out[key] = value;
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
