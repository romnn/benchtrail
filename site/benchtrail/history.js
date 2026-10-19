// Reading github-action-benchmark's recorded runs into suites: each entry becomes an observation of
// a metric under named dimensions and an environment, and observations join into histories, traces,
// and sections.
// Recorded data is untrusted, so every field is checked here, once, before anything keys by it.

import { detect, relative } from "./detect.js";
import { FAMILY_LABELS, parseUnit, unitFactor } from "./format.js";
import { canonical, linkPart, MISSING, token, urlText } from "./identity.js";
import { countBy, unique } from "./list.js";

// Settings a config may give for every suite at its top level, or for one suite under `suites`.
const SETTING_KEYS = ["names", "label", "metrics", "dimensions", "colorBy", "dashBy", "ignoreEnvironment", "smoothing"];

// Tools whose values github-action-benchmark treats as "bigger is better"; every other tool
// records times or sizes.
const BIGGER_IS_BETTER = new Set(["customBiggerIsBetter", "benchmarkjs", "pytest"]);

// The parts of the page config that shape how runs are read: the detection threshold, the
// settings for every suite, and each suite's own.
export function readSettings(raw) {
  const defaults = {};
  for (const key of SETTING_KEYS) if (raw[key] !== undefined) defaults[key] = raw[key];
  return {
    threshold: Number.isFinite(Number(raw.threshold)) ? Number(raw.threshold) : 0.05,
    defaults,
    suites: isPlainObject(raw.suites) ? raw.suites : {},
  };
}

// A suite's own settings override the top-level ones; metric and dimension entries merge by key.
// `defaults` holds the top-level settings and `suites` each suite's own, as the page config gives
// them.
export function suiteSettings({ defaults, suites }, name) {
  const own = isPlainObject(suites[name]) ? suites[name] : {};
  const merged = { ...defaults, ...own };
  merged.metrics = { ...plainObject(defaults.metrics), ...plainObject(own.metrics) };
  merged.dimensions = { ...plainObject(defaults.dimensions), ...plainObject(own.dimensions) };
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

// Only numbers count; Number() would turn null, "" and false into a real zero.
function numeric(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function plainObject(value) {
  return isPlainObject(value) ? value : {};
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

// Reads one suite's recorded runs into its metrics, histories, and sections, with each history's
// segments and detected shifts.
// `threshold` is the smallest relative change detection may report.
export function buildSuite(name, rawRuns, settings, threshold) {
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
    detect(history, threshold);
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

function omit(source, keys) {
  const out = Object.create(null);
  for (const [key, value] of Object.entries(source ?? {})) if (!keys.has(key)) out[key] = value;
  return out;
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
export function valueText(dim, value) {
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

// A link target from recorded data, kept only when it is an http or https URL.
export function safeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
