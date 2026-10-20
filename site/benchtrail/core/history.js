// Reading github-action-benchmark's recorded runs into suites: each entry becomes an observation of
// a metric under named dimensions and an environment, and observations join into histories, traces,
// and sections.
// Recorded data is untrusted, so every field is checked here, once, before anything keys by it.

import { detect, relative } from "./detect.js";
import { canonical, linkPart, MISSING, token, urlText } from "./identity.js";
import { countBy, unique } from "./list.js";
import { FAMILY_LABELS, parseUnit, unitFactor } from "./units.js";

/** @typedef {import("./detect.js").Direction} Direction */
/** @typedef {import("./detect.js").Shift} Shift */
/** @typedef {import("./identity.js").Scalar} Scalar */
/** @typedef {import("./identity.js").Tags} Tags */
/** @typedef {import("./config.js").SuiteSettings} SuiteSettings */

/**
 * A recorded run: one commit's benchmark results.
 * `key` names the run in links: its short SHA, with a suffix for a re-run of the same commit.
 * @typedef {object} Run
 * @property {number} index
 * @property {string} id
 * @property {string} short
 * @property {string} key
 * @property {string} message
 * @property {string} subject
 * @property {string} body
 * @property {string | null} url
 * @property {string} author
 * @property {number} date
 * @property {unknown} tool
 */

/**
 * What was measured, keyed by id and unit family.
 * @typedef {object} Metric
 * @property {string} key
 * @property {string} id
 * @property {string} unit
 * @property {string | null} rowLabel
 * @property {Set<Direction>} explicit
 * @property {Set<Direction>} implied
 * @property {Direction} direction
 * @property {string} label
 * @property {string} slug
 */

/**
 * One benchmark measured in one metric, by run.
 * Each per-run array has one slot per run of the suite; `observed` marks the runs that recorded
 * the benchmark, with or without a usable value.
 * @typedef {object} History
 * @property {string} key
 * @property {Metric} metric
 * @property {string | null} benchmarkId
 * @property {string} name
 * @property {boolean[]} observed
 * @property {Array<number | null>} values
 * @property {Array<string | null>} ranges
 * @property {Array<string | null>} texts
 * @property {Array<Tags | null>} dimsAt
 * @property {Array<Tags | null>} envAt
 * @property {Array<number | null>} segment
 * @property {Array<number | null>} change
 * @property {Array<string[] | null>} boundary
 * @property {Array<Shift | null>} shifts
 * @property {Array<number | null>} baselines
 * @property {Set<string>} keys
 */

/**
 * The runs of one history recorded with one set of dimension values.
 * `own` holds the indices of those runs.
 * @typedef {object} Trace
 * @property {History} history
 * @property {Tags} dims
 * @property {Set<number>} own
 * @property {string} key
 * @property {string} label
 * @property {string} slug
 */

/**
 * A value a dimension takes in a section; `value` is undefined for traces without the dimension.
 * @typedef {object} DimensionValue
 * @property {string} token
 * @property {Scalar | undefined} value
 * @property {number} index
 * @property {string} text
 * @property {string} param
 */

/**
 * A dimension of a section.
 * `environment` marks an environment name the settings split benchmarks by: a trace without it was
 * recorded before the name was, so its value is unknown rather than absent.
 * @typedef {object} Dimension
 * @property {string} key
 * @property {string} label
 * @property {DimensionValue[]} values
 * @property {Map<string, DimensionValue>} byToken
 * @property {boolean} varying
 * @property {boolean} environment
 */

/**
 * Histories that share dimensions, shown together.
 * @typedef {object} Section
 * @property {string} label
 * @property {string[]} keys
 * @property {string | null} link
 * @property {History[]} histories
 * @property {Trace[]} traces
 * @property {Dimension[]} dims
 * @property {Metric[]} metrics
 * @property {SuiteSettings} settings
 */

/**
 * @typedef {object} Suite
 * @property {string} name
 * @property {Run[]} runs
 * @property {Map<string, Metric>} metrics
 * @property {Section[]} sections
 * @property {SuiteSettings} settings
 * @property {Map<string, number>} problems
 */

/**
 * An entry's identity and metadata, as read from its name or typed payload.
 * @typedef {object} Reading
 * @property {string | null} benchmarkId
 * @property {Tags} dimensions
 * @property {string} metricId
 * @property {string | null} metricLabel
 * @property {Direction | null} direction
 * @property {Tags} environment
 * @property {string | null} [text]
 */

/** @typedef {Reading & { index: number, entry: Record<string, unknown>, tool: unknown, unit: string }} Observation */
/** @typedef {(message: string) => void} Note */

// Tools whose values github-action-benchmark treats as "bigger is better"; every other tool
// records times or sizes.
const BIGGER_IS_BETTER = new Set(["customBiggerIsBetter", "benchmarkjs", "pytest"]);

// Reads one recorded entry into its benchmark identity, dimensions, metric, and environment.
// The action stores `extra` as a string, so typed metadata arrives as JSON text.
// Every tag map is a null-prototype object, so a dimension named `toString` or `__proto__` is an
// ordinary key.
/**
 * @param {Record<string, unknown>} entry
 * @param {SuiteSettings} settings
 * @param {Note} note
 * @returns {Reading}
 */
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
    if ("value" in typed) return { ...typed.value, text };
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
    const { metric = "", ...rest } = /** @type {Record<string, string | undefined>} */ (groups);
    const dimensions = tags({});
    for (const [key, value] of Object.entries(rest)) if (value !== undefined) dimensions[key] = value;
    return { benchmarkId: null, dimensions, metricId: metric.trim(), metricLabel: null, direction: null, environment: tags({}), text: extra };
  }
  return { benchmarkId: null, dimensions: tags({ benchmark: name }), metricId: "", metricLabel: null, direction: null, environment: tags({}), text: extra };
}

// Validates version 1 of the typed payload.
// Unknown properties are allowed, so later additions stay readable; recognized ones must be
// valid when present, and an invalid one rejects the whole payload rather than being dropped.
/**
 * @param {unknown} payload
 * @returns {{ ok: true, value: Reading } | { ok: false, error: string }}
 */
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
  if (Object.hasOwn(metric, "direction") && !isDirection(metric.direction)) {
    return { ok: false, error: `extra.benchtrail.metric.direction must be "lower", "higher", or "unknown"` };
  }
  if (Object.hasOwn(payload, "benchmarkId") && (typeof payload.benchmarkId !== "string" || payload.benchmarkId === "")) {
    return { ok: false, error: "extra.benchtrail.benchmarkId must be a non-empty string" };
  }
  return {
    ok: true,
    value: {
      benchmarkId: typeof payload.benchmarkId === "string" ? payload.benchmarkId : null,
      dimensions,
      metricId: metric.id,
      metricLabel: typeof metric.label === "string" && metric.label ? metric.label : null,
      direction: isDirection(metric.direction) ? metric.direction : null,
      environment,
    },
  };
}

/**
 * @param {unknown} value
 * @returns {Tags | null}
 */
function readTags(value) {
  if (!isPlainObject(value)) return null;
  for (const item of Object.values(value)) {
    const scalar = typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item));
    if (!scalar) return null;
  }
  return tags(/** @type {Tags} */ (value));
}

/**
 * @param {unknown} value
 * @returns {value is Direction}
 */
function isDirection(value) {
  return value === "lower" || value === "higher" || value === "unknown";
}

// A null-prototype copy of a tag map.
/**
 * @param {Tags} source
 * @returns {Tags}
 */
function tags(source) {
  return Object.assign(Object.create(null), source);
}

// Only numbers count; Number() would turn null, "" and false into a real zero.
/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numeric(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function plainObject(value) {
  return isPlainObject(value) ? value : {};
}

// The direction a tool implies for an entry without a declared one.
// The custom tools state it outright; the other tools record times and sizes, except that a rate
// such as MB/s or ops/sec is a throughput, where higher is better.
/**
 * @param {unknown} tool
 * @param {string} unit
 * @returns {Direction}
 */
function impliedDirection(tool, unit) {
  if (tool === "customBiggerIsBetter") return "higher";
  if (tool === "customSmallerIsBetter") return "lower";
  if ((typeof tool === "string" && BIGGER_IS_BETTER.has(tool)) || /\/\s*(s|sec|secs|second|seconds)$/i.test(unit.trim())) return "higher";
  return "lower";
}

// Reads one suite's recorded runs into its metrics, histories, and sections, with each history's
// segments and detected shifts.
// `threshold` is the smallest relative change detection may report.
/**
 * @param {string} name
 * @param {readonly unknown[]} rawRuns
 * @param {SuiteSettings} settings
 * @param {number} threshold
 * @returns {Suite}
 */
export function buildSuite(name, rawRuns, settings, threshold) {
  /** @type {Map<string, number>} */
  const problems = new Map();
  /** @type {Note} */
  const note = (message) => problems.set(message, (problems.get(message) ?? 0) + 1);
  for (const problem of settings.problems) note(problem);
  const valid = rawRuns.filter(isPlainObject);
  if (valid.length < rawRuns.length) note(`${rawRuns.length - valid.length} recorded runs are not objects and are skipped.`);
  const runs = valid.map((raw, index) => normalizeRun(raw, index));

  // Read every entry once, before anything is keyed by it.
  /** @type {Observation[]} */
  const observations = [];
  for (const [index, raw] of valid.entries()) {
    const entries = Array.isArray(raw.benches) ? raw.benches : [];
    for (const entry of entries) {
      if (!isPlainObject(entry)) {
        note(`run ${runs[index].short} has an entry that is not an object; it is skipped.`);
        continue;
      }
      const observation = splitEnvironment(readEntry(entry, settings, note), settings.splitEnvironment, String(entry.name ?? ""), note);
      observations.push({ index, entry, tool: raw.tool, unit: String(entry.unit ?? ""), ...observation });
    }
  }

  // Group the observations into metrics and histories, in order of first appearance.
  /** @type {Map<string, Metric>} */
  const metrics = new Map();
  /** @type {Map<string, History>} */
  const histories = new Map();
  for (const o of observations) {
    const metric = metricFor(metrics, o.metricId, o.unit, settings);
    if (o.metricLabel) metric.rowLabel = o.metricLabel;
    if (o.direction) metric.explicit.add(o.direction);
    else metric.implied.add(impliedDirection(o.tool, o.unit));

    // A history is one benchmark measured in one metric.
    // An explicit id keeps a benchmark's history together while its dimensions change; without
    // one, the dimensions themselves are its identity.
    // The environment never takes part, so a history keeps its identity across a toolchain change,
    // apart from the names the settings split by, which are dimensions by now; under an explicit id
    // their values still split the history, as they do without one.
    const split = o.benchmarkId !== null && settings.splitEnvironment.size ? `\u0003${canonical(pick(o.dimensions, settings.splitEnvironment))}` : "";
    const benchmark = o.benchmarkId !== null ? `id:${o.benchmarkId}${split}` : `dims:${canonical(o.dimensions)}`;
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
        shifts: [],
        baselines: [],
        keys: new Set(),
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
    history.texts[o.index] = o.text ?? null;
    history.ranges[o.index] = rangeText(o.entry.range, o.unit, o.tool);
    const value = numeric(o.entry.value);
    const scaled = value === null ? null : value * unitFactor(o.unit, metric.unit);
    if (scaled !== null && Number.isFinite(scaled)) history.values[o.index] = scaled;
  }

  resolveMetrics(metrics, settings, note);
  for (const history of histories.values()) {
    trace(history, settings);
    const detection = detect({ values: history.values, observed: history.observed, segment: history.segment, direction: history.metric.direction }, threshold);
    history.shifts = detection.shifts;
    history.baselines = detection.baselines;
  }

  // Runs are named by short commit SHA, with a suffix for re-runs of the same commit, so a link
  // can name each one.
  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const run of runs) {
    const count = seen.get(run.short) ?? 0;
    seen.set(run.short, count + 1);
    run.key = count === 0 ? run.short : `${run.short}~${count + 1}`;
  }

  const sections = buildSections([...histories.values()], settings);
  return { name, runs, metrics, sections, settings, problems };
}

// Moves the environment names the settings split by into the dimensions, so each of their values
// is a benchmark of its own, with its own history and change detection, rather than a new segment
// of one history: a value that alternates between runs, such as the CPU of a pool of hosted
// runners, would otherwise leave no segment long enough to judge.
// An entry recorded without the name gets no value for it, which the page shows as unknown.
// A dimension of the same name keeps its value, since the entry's identity is its dimensions.
/**
 * @param {Reading} reading
 * @param {Set<string>} keys
 * @param {string} name
 * @param {Note} note
 * @returns {Reading}
 */
function splitEnvironment(reading, keys, name, note) {
  if (!keys.size) return reading;
  const dimensions = tags(reading.dimensions);
  const environment = tags({});
  for (const [key, value] of Object.entries(reading.environment)) {
    if (!keys.has(key)) environment[key] = value;
    else if (Object.hasOwn(dimensions, key)) note(`${name} records ${key} both as a dimension and in its environment; the dimension is kept.`);
    else dimensions[key] = value;
  }
  return { ...reading, dimensions, environment };
}

/**
 * @param {Tags} source
 * @param {Set<string>} keys
 * @returns {Tags}
 */
function pick(source, keys) {
  const out = tags({});
  for (const [key, value] of Object.entries(source)) if (keys.has(key)) out[key] = value;
  return out;
}

// A recorded spread, with the recorded unit added when the spread is a bare number, since values
// are rescaled to the metric's unit while the spread is not.
// pytest records a duration spread beside a throughput value, so its spread stays as recorded.
/**
 * @param {unknown} range
 * @param {string} unit
 * @param {unknown} tool
 */
function rangeText(range, unit, tool) {
  if (range === undefined || range === null || range === "") return null;
  const text = String(range);
  if (tool !== "pytest" && unit && /^±?\s*[\d.,]+$/.test(text.trim())) return `${text} ${unit}`;
  return text;
}

// Metrics are keyed by id and unit family, so one id recorded in seconds and in ops/s never
// shares an axis, while seconds and milliseconds do.
/**
 * @param {Map<string, Metric>} metrics
 * @param {string} id
 * @param {string} unit
 * @param {SuiteSettings} settings
 * @returns {Metric}
 */
function metricFor(metrics, id, unit, settings) {
  const parsed = parseUnit(unit);
  const family = parsed ? `${parsed.family}|${parsed.tail}` : `raw|${unit}`;
  const key = `${id}\u0000${family}`;
  let metric = metrics.get(key);
  if (!metric) {
    // A configured unit of the same family becomes the metric's unit, so its values convert to it.
    const preferred = settings.metrics.get(id)?.unit ?? unit;
    const target = parseUnit(preferred);
    const canonicalUnit = target && parsed && target.family === parsed.family && target.tail === parsed.tail ? preferred : unit;
    metric = { key, id, unit: canonicalUnit, rowLabel: null, explicit: new Set(), implied: new Set(), direction: "lower", label: "", slug: "" };
    metrics.set(key, metric);
  }
  return metric;
}

// Direction comes from the entries, then the config, then the tool that recorded them.
// Conflicting declarations leave it unknown rather than letting the latest run rewrite history.
/**
 * @param {Map<string, Metric>} metrics
 * @param {SuiteSettings} settings
 * @param {Note} note
 */
function resolveMetrics(metrics, settings, note) {
  for (const metric of metrics.values()) {
    const configured = settings.metrics.get(metric.id) ?? {};
    const name = metric.id || metric.unit || "values";
    if (metric.explicit.size === 1) {
      metric.direction = [...metric.explicit][0];
    } else if (metric.explicit.size > 1) {
      metric.direction = "unknown";
      note(`metric ${name} declares conflicting directions; its changes are shown without a verdict.`);
    } else if (configured.direction) {
      metric.direction = configured.direction;
    } else if (metric.implied.size === 1) {
      metric.direction = [...metric.implied][0];
    } else {
      metric.direction = "unknown";
      note(`metric ${name} was recorded by tools with opposite directions; set its direction in benchtrail.json.`);
    }
    metric.label = configured.label ?? metric.rowLabel ?? metricLabel(metric.id, metric.unit);
  }
  const counts = countBy([...metrics.values()], (m) => m.label);
  for (const metric of metrics.values()) {
    if ((counts.get(metric.label) ?? 0) > 1) metric.label = `${metric.label} (${metric.unit})`;
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
/**
 * @param {History} history
 * @param {SuiteSettings} settings
 */
function trace(history, settings) {
  let segment = 0;
  let previousIndex = -1;
  /** @type {string | null} */
  let previousPrint = null;
  /** @type {number | null} */
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
    if (change !== null && Number.isFinite(change)) history.change[i] = change;
    previousValue = value;
  }
  history.keys = new Set(history.dimsAt.flatMap((dims) => (dims ? Object.keys(dims) : [])));
}

/**
 * @param {Tags | null} source
 * @param {Set<string>} keys
 * @returns {Tags}
 */
function omit(source, keys) {
  const out = Object.create(null);
  for (const [key, value] of Object.entries(source ?? {})) if (!keys.has(key)) out[key] = value;
  return out;
}

// Each name whose value differs between two tag maps, as `name before → after`.
/**
 * @param {Tags | null} before
 * @param {Tags | null} after
 */
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
/**
 * @param {History[]} histories
 * @param {SuiteSettings} settings
 * @returns {Section[]}
 */
function buildSections(histories, settings) {
  /** @type {Map<string, string>} */
  const parent = new Map();
  /** @param {string} x */
  const find = (x) => {
    while (parent.get(x) !== x) x = /** @type {string} */ (parent.get(x));
    return x;
  };
  /**
   * @param {string} a
   * @param {string} b
   */
  const union = (a, b) => parent.set(find(a), find(b));
  /** @param {History} history */
  const anchors = (history) => [
    ...[...history.keys].map((k) => `k:${k}`),
    ...(history.benchmarkId !== null || !history.keys.size ? [`b:${JSON.stringify(history.benchmarkId)}`] : []),
  ];
  for (const history of histories) {
    const keys = anchors(history);
    for (const key of keys) if (!parent.has(key)) parent.set(key, key);
    for (const key of keys.slice(1)) union(keys[0], key);
  }
  /** @type {Map<string, History[]>} */
  const groups = new Map();
  for (const history of histories) {
    const root = find(anchors(history)[0]);
    const group = groups.get(root) ?? [];
    group.push(history);
    groups.set(root, group);
  }

  const sections = [...groups.values()].map((members) => buildSection(members, settings));
  const counts = countBy(sections, (s) => s.label);
  for (const [i, s] of sections.entries()) if ((counts.get(s.label) ?? 0) > 1) s.label = `${s.label} ${i + 1}`;
  return sections;
}

// A section's traces split each history by its dimension values, so an observation is always
// drawn, labelled, colored, and filtered by the dimensions it was recorded with, even after its
// benchmark's dimensions changed.
// Traces of one history stay linked through it, which keeps change detection continuous.
/**
 * @param {History[]} histories
 * @param {SuiteSettings} settings
 * @returns {Section}
 */
function buildSection(histories, settings) {
  /** @type {Trace[]} */
  const traces = [];
  for (const history of histories) {
    /** @type {Map<string, Trace>} */
    const bySignature = new Map();
    for (let i = 0; i < history.observed.length; i += 1) {
      const dims = history.dimsAt[i];
      if (!history.observed[i] || !dims) continue;
      const signature = canonical(dims);
      // A trace keeps the set of runs it owns rather than a mask over every run, so a benchmark
      // whose dimensions change on every run stays linear in memory.
      let trace = bySignature.get(signature);
      if (!trace) {
        trace = { history, dims, own: new Set(), key: `${history.key}\u0002${signature}`, label: "", slug: "" };
        bySignature.set(signature, trace);
      }
      trace.own.add(i);
    }
    traces.push(...bySignature.values());
  }

  // Dimensions in config order, then in order of first appearance.
  const keys = unique(histories.flatMap((history) => [...history.keys]));
  const order = (/** @type {string} */ key) => settings.dimensions.get(key)?.order ?? Infinity;
  keys.sort((a, b) => order(a) - order(b));

  const dims = keys.map((key) => {
    /** @type {Map<string, Scalar>} */
    const values = new Map();
    let missing = false;
    for (const trace of traces) {
      if (!Object.hasOwn(trace.dims, key)) missing = true;
      else if (!values.has(token(trace.dims[key]))) values.set(token(trace.dims[key]), trace.dims[key]);
    }
    /** @type {DimensionValue[]} */
    const list = [...values.entries()].map(([tok, value]) => ({ token: tok, value, index: 0, text: "", param: "" }));
    // Numbers sort by size; strings and booleans keep their order of appearance.
    if (list.every(({ value }) => typeof value === "number")) list.sort((a, b) => Number(a.value) - Number(b.value));
    if (missing) list.push({ token: MISSING, value: undefined, index: 0, text: "", param: "" });
    const environment = settings.splitEnvironment.has(key);
    const texts = shortTexts(list.map(({ value }) => value));
    for (const [i, entry] of list.entries()) {
      entry.index = i;
      entry.text = entry.value === undefined && environment ? "unknown" : texts[i];
    }
    // On screen, a string that reads like another value of the dimension is shown quoted.
    const plain = countBy(list, (v) => String(v.value));
    for (const entry of list) {
      entry.param = urlText(entry.value);
      if ((plain.get(String(entry.value)) ?? 0) > 1 && typeof entry.value === "string") entry.text = `"${entry.value}"`;
    }
    return {
      key,
      label: dimensionLabel(key, settings),
      values: list,
      byToken: new Map(list.map((v) => [v.token, v])),
      varying: list.length > 1,
      environment,
    };
  });

  // A section with dimensions is linked by their keys; one without is a single benchmark, linked
  // by its id after `#`, or by `#` alone for the benchmark recorded with neither.
  const benchmarkId = histories[0]?.benchmarkId ?? null;
  /** @type {Section} */
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
    for (const trace of members) if ((counts.get(trace.label) ?? 0) > 1) trace.label = `${trace.label} (${trace.history.name})`;
    for (const trace of members) trace.slug = `${linkPart(metric.slug)}:${traceIdentity(trace)}`;
  }
  return section;
}

// A trace's identity in a link: its benchmark id after `#` when it has one, then its dimensions in
// key order as `key=value`, joined by `/`, with every part escaped so the joins stay unambiguous.
// Together with the metric, these identify exactly one trace, whatever runs are added later.
/** @param {Trace} trace */
function traceIdentity(trace) {
  const id = trace.history.benchmarkId;
  const dims = Object.keys(trace.dims)
    .sort()
    .map((key) => `${linkPart(key)}=${linkPart(urlText(trace.dims[key]))}`);
  return [...(id === null ? [] : [`#${linkPart(id)}`]), ...dims].join("/");
}

// A trace's label is the config template when every name it uses is one of the trace's
// dimensions, or an environment name the settings split by, which reads as unknown in a trace
// recorded without it; otherwise the label is the values of the dimensions that vary in its
// section.
/**
 * @param {Trace} trace
 * @param {Section} section
 */
function traceLabel(trace, section) {
  const { label: template, splitEnvironment } = section.settings;
  if (template) {
    const names = [...template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((m) => m[1]);
    if (names.length && names.every((name) => Object.hasOwn(trace.dims, name) || splitEnvironment.has(name))) {
      return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, name) => (Object.hasOwn(trace.dims, name) ? String(trace.dims[name]) : "unknown"));
    }
  }
  const parts = section.dims.filter((d) => d.varying).map((d) => valueText(d, trace.dims[d.key]));
  return parts.join(" / ") || trace.history.name;
}

/**
 * @param {Record<string, unknown>} raw
 * @param {number} index
 * @returns {Run}
 */
function normalizeRun(raw, index) {
  const commit = plainObject(raw.commit);
  const author = plainObject(commit.author);
  const message = String(commit.message ?? "");
  const id = String(commit.id ?? "");
  // Dates outside what Date can represent would throw when formatted.
  const date = [Number(raw.date), Date.parse(String(commit.timestamp))].find((ms) => Number.isFinite(ms) && Math.abs(ms) < 8.64e15) ?? 0;
  return {
    index,
    id,
    short: id.slice(0, 7) || `run${index + 1}`,
    key: "",
    message,
    subject: message.split("\n")[0].trim() || "(no commit message)",
    body: message.split("\n").slice(1).join("\n").trim(),
    url: safeUrl(commit.url),
    author: String(author.name || author.username || "unknown author"),
    date,
    tool: raw.tool,
  };
}

/**
 * @param {string} id
 * @param {string} unit
 */
function metricLabel(id, unit) {
  if (!id) {
    // A unit with a tail, such as MB/s, is a rate rather than a size, so it names itself.
    const parsed = parseUnit(unit);
    return parsed && !parsed.tail ? FAMILY_LABELS[parsed.family] : unit || "Value";
  }
  return humanize(id);
}

/**
 * @param {string} key
 * @param {SuiteSettings} settings
 */
function dimensionLabel(key, settings) {
  return settings.dimensions.get(key)?.label || humanize(key);
}

/** @param {string} id */
function humanize(id) {
  const words = id.replace(/[_]+/g, " ").replace(/\b(cpu|rss|gc|io|ram|ipc|gpu|simd)\b/gi, (word) => word.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// How a dimension value reads inside a label: strings as themselves, numbers and booleans with
// their dimension's name, since a bare `8` says nothing.
// No value reads as absent, or as unknown for an environment name the settings split by.
/**
 * @param {Dimension} dim
 * @param {Scalar | undefined} value
 * @returns {string}
 */
export function valueText(dim, value) {
  if (value === undefined) return `${dim.environment ? "unknown" : "no"} ${dim.label.toLowerCase()}`;
  if (typeof value === "number") return `${dim.label.toLowerCase()} ${value}`;
  if (typeof value === "boolean") return value ? dim.label.toLowerCase() : `no ${dim.label.toLowerCase()}`;
  return dim.byToken.get(token(value))?.text ?? value;
}

// Drops a prefix and suffix that every string value shares, cut at a delimiter, so
// `okta.hand-written` and `oxide.hand-written` read as `okta` and `oxide`.
/**
 * @param {Array<Scalar | undefined>} values
 * @returns {string[]}
 */
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
/**
 * @param {unknown} url
 * @returns {string | null}
 */
export function safeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
