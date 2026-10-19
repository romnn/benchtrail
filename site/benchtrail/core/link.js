// What a link says: the page's shareable state, and how it reads from and writes to a query
// string.
// Every view is a shareable link; only the theme, a personal preference kept in the browser,
// never enters one.
// A link is read without the data, so it keeps what it names even when the data no longer has
// it; resolving names against the data is the view's job.
//
// Parameters at their default are left out, and runs are named by commit, so a link keeps
// pointing at the same runs as the history grows.
// A dimension filter uses the dimension's name as its parameter, or `d.<name>` when the name is
// one of the page's own parameters.
// List values are separated by literal commas and each value is percent-encoded, so a value that
// contains a comma survives the round trip.

/**
 * Every value, including values that appear later; or exactly the listed ones, by link text.
 * @template T
 * @typedef {{ kind: "all" } | { kind: "only", values: ReadonlySet<T> }} Filter
 */

/**
 * Which dimension colors or dashes the lines: chosen automatically, none, or a named one.
 * @typedef {{ kind: "auto" } | { kind: "none" } | { kind: "by", key: string }} DimensionChoice
 */

/**
 * A section is named by its dimension keys, or, for one without dimensions, by its benchmark.
 * @typedef {{ kind: "keys", keys: readonly string[] } | { kind: "benchmark", link: string }} SectionRef
 */

/**
 * The run the page shows: the newest one, following later runs, or a named one.
 * @typedef {{ kind: "latest" } | { kind: "at", key: string }} RunSelection
 */

/**
 * The plotted window: every run, or the runs between two named ones, either end open.
 * @typedef {{ kind: "full" } | { kind: "between", from: string | null, to: string | null }} PlotWindow
 */

/**
 * The smoothing window: the suite's configured default, or an explicit number of runs.
 * @typedef {{ kind: "configured" } | { kind: "explicit", window: number }} SmoothingChoice
 */

/**
 * How the runs page lists runs: its search, whether it keeps to runs with a change or to the zoom
 * window, and its sort.
 * @typedef {object} RunList
 * @property {string} query
 * @property {boolean} onlyChanges
 * @property {boolean} inWindow
 * @property {Sort | null} sort
 */

/**
 * The page a link opens: the overview, the list of runs as it is searched and sorted, or one
 * chart, named by its chart id (see `chartId` in the view).
 * The list's choices belong to its page, so no other page can carry them unseen.
 * @typedef {{ kind: "overview" } | { kind: "runs", list: RunList } | { kind: "chart", chart: string }} Route
 */

/** @typedef {"30" | "100" | "all"} RangeKey */
/** @typedef {"absolute" | "change"} ScaleKey */
/** @typedef {"run" | "date"} AxisKey */
/** @typedef {"auto" | "charts" | "movers"} LayoutKey */
/** @typedef {"closed" | "open" | "all"} ChangesKey */
/** @typedef {{ line: string, order: "worst" | "best" }} Sort */

/**
 * @typedef {object} LinkState
 * @property {Route} route
 * @property {string | null} data the history script the page loads, when the link names one
 * @property {string | null} suite null for the first suite
 * @property {SectionRef | null} section null for the suite's first section
 * @property {RangeKey} range
 * @property {Filter<string>} metrics by metric link id
 * @property {ReadonlyMap<string, Filter<string>>} dimensions by dimension key, values by link text
 * @property {DimensionChoice} color
 * @property {DimensionChoice} dash
 * @property {ScaleKey} scale
 * @property {SmoothingChoice} smoothing
 * @property {AxisKey} axis
 * @property {PlotWindow} window
 * @property {RunSelection} run
 * @property {LayoutKey} layout
 * @property {boolean} more whether readouts show their detailed columns
 * @property {boolean} allCharts
 * @property {ChangesKey} changes
 */

/** The run counts a link can limit the page to, newest runs last. */
export const RANGES = /** @type {const} */ ([
  { key: "30", label: "Last 30", count: 30 },
  { key: "100", label: "Last 100", count: 100 },
  { key: "all", label: "All", count: Infinity },
]);

export const SCALES = /** @type {const} */ ([
  { key: "absolute", label: "Absolute" },
  { key: "change", label: "Change" },
]);

// Window sizes for the rolling median, in runs; odd, so each window centers on its run.
export const SMOOTHING = /** @type {const} */ ([
  { key: 0, label: "Off" },
  { key: 5, label: "5 runs" },
  { key: 11, label: "11 runs" },
  { key: 21, label: "21 runs" },
]);

export const AXES = /** @type {const} */ ([
  { key: "run", label: "By run" },
  { key: "date", label: "By date" },
]);

/** @returns {LinkState} */
export function emptyLink() {
  return {
    route: { kind: "overview" },
    data: null,
    suite: null,
    section: null,
    range: "all",
    metrics: { kind: "all" },
    dimensions: new Map(),
    color: { kind: "auto" },
    dash: { kind: "auto" },
    scale: "absolute",
    smoothing: { kind: "configured" },
    axis: "run",
    window: { kind: "full" },
    run: { kind: "latest" },
    layout: "auto",
    more: false,
    allCharts: false,
    changes: "closed",
  };
}

/**
 * The runs page as it first opens: every run, newest first.
 * @returns {Route}
 */
export function runsRoute() {
  return { kind: "runs", list: { query: "", onlyChanges: false, inWindow: false, sort: null } };
}

/**
 * @template T
 * @param {Filter<T> | undefined} filter
 * @param {T} value
 */
export function admits(filter, value) {
  return !filter || filter.kind === "all" || filter.values.has(value);
}

// The query, raw

/**
 * A query's values by name, first occurrence winning, kept raw so list values split on their
 * literal commas before decoding.
 * @typedef {object} Query
 * @property {(key: string) => boolean} has
 * @property {(key: string) => string | undefined} get
 * @property {(key: string) => string[] | undefined} list
 * @property {() => string[]} keys
 */

/**
 * @param {string} search
 * @returns {Query}
 */
export function readQuery(search) {
  /** @type {Map<string, string>} */
  const raw = new Map();
  for (const part of search.replace(/^\?/, "").split("&")) {
    if (!part) continue;
    const at = part.indexOf("=");
    const key = decodeQuery(at < 0 ? part : part.slice(0, at));
    if (!raw.has(key)) raw.set(key, at < 0 ? "" : part.slice(at + 1));
  }
  return {
    has: (key) => raw.has(key),
    get: (key) => {
      const value = raw.get(key);
      return value === undefined ? undefined : decodeQuery(value);
    },
    list: (key) => raw.get(key)?.split(",").map(decodeQuery),
    keys: () => [...raw.keys()],
  };
}

// Slashes and colons are legal in a query, and leaving them unescaped keeps links readable.
/** @param {string} text */
function encodeQuery(text) {
  return encodeURIComponent(text).replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%20/g, "+");
}

/** @param {string} text */
function decodeQuery(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

// Parameters

/**
 * One parameter, or a group that shares keys such as `from` and `to`: how it reads into a link
 * and how it writes back out.
 * `write` returns the key and value pairs to write, in order, with list values joined by commas.
 * @typedef {object} Codec
 * @property {readonly string[]} keys
 * @property {(query: Query, link: LinkState) => void} read
 * @property {(link: LinkState) => Array<[string, string | string[]]>} write
 */

/**
 * @template {string} K
 * @param {readonly { key: K }[]} options
 * @param {string | undefined} value
 * @param {K} fallback
 * @returns {K}
 */
function oneOf(options, value, fallback) {
  return options.find((option) => option.key === value)?.key ?? fallback;
}

// An empty selection is written as `~`, which no value's link text can be.
/**
 * @param {Query} query
 * @param {string} key
 * @returns {Filter<string>}
 */
function readFilter(query, key) {
  if (!query.has(key)) return { kind: "all" };
  return { kind: "only", values: new Set(query.get(key) === "~" ? [] : query.list(key)) };
}

/**
 * @param {Filter<string>} filter
 * @returns {string | string[] | null}
 */
function writeFilter(filter) {
  if (filter.kind === "all") return null;
  return filter.values.size ? [...filter.values] : "~";
}

/**
 * @param {string | undefined} value
 * @returns {DimensionChoice}
 */
function readChoice(value) {
  if (value === undefined) return { kind: "auto" };
  return value === "~" ? { kind: "none" } : { kind: "by", key: value };
}

/**
 * @param {DimensionChoice} choice
 * @returns {string | null}
 */
function writeChoice(choice) {
  return choice.kind === "auto" ? null : choice.kind === "none" ? "~" : choice.key;
}

// Section keys are escaped when they could read as a benchmark link.
/** @param {string} key */
function sectionKeyText(key) {
  return key.startsWith("#") || key.startsWith("s:") ? `s:${key}` : key;
}

/**
 * Every parameter the page reads and writes, in the order a link lists them.
 * Dimension filters fill the remaining names, so these are reserved for the page.
 * @type {readonly Codec[]}
 */
const CODECS = [
  {
    // A chart page is named by its chart alone, which reads better than a page name beside it.
    keys: ["page", "chart"],
    read: (q, link) => {
      const chart = q.get("chart");
      if (chart) link.route = { kind: "chart", chart };
      else link.route = q.get("page") === "runs" ? runsRoute() : { kind: "overview" };
    },
    write: (link) => {
      const route = link.route;
      if (route.kind === "chart") return [["chart", route.chart]];
      return route.kind === "runs" ? [["page", "runs"]] : [];
    },
  },
  {
    keys: ["data"],
    read: (q, link) => {
      link.data = q.get("data") ?? null;
    },
    write: (link) => (link.data === null ? [] : [["data", link.data]]),
  },
  {
    keys: ["suite"],
    read: (q, link) => {
      link.suite = q.get("suite") ?? null;
    },
    write: (link) => (link.suite === null ? [] : [["suite", link.suite]]),
  },
  {
    keys: ["section"],
    read: (q, link) => {
      const value = q.get("section");
      if (value === undefined) link.section = null;
      else if (value.startsWith("#")) link.section = { kind: "benchmark", link: value };
      else link.section = { kind: "keys", keys: (q.list("section") ?? []).map((key) => (key.startsWith("s:") ? key.slice(2) : key)) };
    },
    write: (link) => {
      const section = link.section;
      if (!section) return [];
      return section.kind === "benchmark" ? [["section", section.link]] : [["section", section.keys.map(sectionKeyText)]];
    },
  },
  {
    keys: ["runs"],
    read: (q, link) => {
      link.range = oneOf(RANGES, q.get("runs"), "all");
    },
    write: (link) => (link.range === "all" ? [] : [["runs", link.range]]),
  },
  {
    keys: ["metrics"],
    read: (q, link) => {
      link.metrics = readFilter(q, "metrics");
    },
    write: (link) => {
      const value = writeFilter(link.metrics);
      return value === null ? [] : [["metrics", value]];
    },
  },
  {
    // Placed here so dimension filters follow the metric filter in a link.
    keys: [],
    read: (q, link) => {
      /** @type {Map<string, Filter<string>>} */
      const dimensions = new Map();
      for (const name of q.keys()) {
        if (RESERVED.has(name)) continue;
        dimensions.set(name.startsWith("d.") ? name.slice(2) : name, readFilter(q, name));
      }
      link.dimensions = dimensions;
    },
    write: (link) => {
      /** @type {Array<[string, string | string[]]>} */
      const pairs = [];
      for (const [key, filter] of link.dimensions) {
        const value = writeFilter(filter);
        if (value !== null) pairs.push([dimensionParam(key), value]);
      }
      return pairs;
    },
  },
  {
    keys: ["color"],
    read: (q, link) => {
      link.color = readChoice(q.get("color"));
    },
    write: (link) => {
      const value = writeChoice(link.color);
      return value === null ? [] : [["color", value]];
    },
  },
  {
    keys: ["dash"],
    read: (q, link) => {
      link.dash = readChoice(q.get("dash"));
    },
    write: (link) => {
      const value = writeChoice(link.dash);
      return value === null ? [] : [["dash", value]];
    },
  },
  {
    keys: ["values"],
    read: (q, link) => {
      link.scale = oneOf(SCALES, q.get("values"), "absolute");
    },
    write: (link) => (link.scale === "absolute" ? [] : [["values", link.scale]]),
  },
  {
    keys: ["smooth"],
    read: (q, link) => {
      const window = Number(q.get("smooth"));
      link.smoothing = q.has("smooth") && SMOOTHING.some((option) => option.key === window) ? { kind: "explicit", window } : { kind: "configured" };
    },
    write: (link) => (link.smoothing.kind === "configured" ? [] : [["smooth", String(link.smoothing.window)]]),
  },
  {
    keys: ["x"],
    read: (q, link) => {
      link.axis = oneOf(AXES, q.get("x"), "run");
    },
    write: (link) => (link.axis === "run" ? [] : [["x", link.axis]]),
  },
  {
    keys: ["from", "to"],
    read: (q, link) => {
      const from = q.get("from") || null;
      const to = q.get("to") || null;
      link.window = from || to ? { kind: "between", from, to } : { kind: "full" };
    },
    write: (link) => {
      if (link.window.kind === "full") return [];
      /** @type {Array<[string, string]>} */
      const pairs = [];
      if (link.window.from) pairs.push(["from", link.window.from]);
      if (link.window.to) pairs.push(["to", link.window.to]);
      return pairs;
    },
  },
  {
    keys: ["run"],
    read: (q, link) => {
      const key = q.get("run");
      link.run = key ? { kind: "at", key } : { kind: "latest" };
    },
    write: (link) => (link.run.kind === "latest" ? [] : [["run", link.run.key]]),
  },
  {
    keys: ["view"],
    read: (q, link) => {
      link.layout = oneOf([{ key: "charts" }, { key: "movers" }], q.get("view"), /** @type {"charts" | "movers" | "auto"} */ ("auto"));
    },
    write: (link) => (link.layout === "auto" ? [] : [["view", link.layout]]),
  },
  {
    keys: ["more"],
    read: (q, link) => {
      link.more = q.get("more") === "1";
    },
    write: (link) => (link.more ? [["more", "1"]] : []),
  },
  {
    keys: ["charts"],
    read: (q, link) => {
      link.allCharts = q.get("charts") === "all";
    },
    write: (link) => (link.allCharts ? [["charts", "all"]] : []),
  },
  {
    keys: ["changes"],
    read: (q, link) => {
      link.changes = oneOf([{ key: "open" }, { key: "all" }], q.get("changes"), /** @type {ChangesKey} */ ("closed"));
    },
    write: (link) => (link.changes === "closed" ? [] : [["changes", link.changes]]),
  },
  {
    // The run list's search, sort, and window belong to the runs page, and come last in its link.
    keys: ["q", "only", "sort", "order", "in"],
    read: (q, link) => {
      if (link.route.kind !== "runs") return;
      const line = q.get("sort");
      link.route.list = {
        query: q.get("q") ?? "",
        onlyChanges: q.get("only") === "changes",
        inWindow: q.get("in") === "window",
        sort: line ? { line, order: q.get("order") === "best" ? "best" : "worst" } : null,
      };
    },
    write: (link) => {
      if (link.route.kind !== "runs") return [];
      const list = link.route.list;
      /** @type {Array<[string, string]>} */
      const pairs = [];
      if (list.query.trim()) pairs.push(["q", list.query.trim()]);
      if (list.onlyChanges) pairs.push(["only", "changes"]);
      if (list.sort) {
        pairs.push(["sort", list.sort.line]);
        if (list.sort.order !== "worst") pairs.push(["order", list.sort.order]);
      }
      if (list.inWindow) pairs.push(["in", "window"]);
      return pairs;
    },
  },
];

// The page's own parameter names, which a dimension can only use with a `d.` prefix.
const RESERVED = new Set(CODECS.flatMap((codec) => codec.keys));

/** @param {string} key */
export function dimensionParam(key) {
  return RESERVED.has(key) || key.startsWith("d.") ? `d.${key}` : key;
}

/**
 * A link read from a query string, complete on its own: anything the query leaves out takes its
 * default, never a value from an earlier link.
 * @param {string} search
 * @returns {LinkState}
 */
export function parseLink(search) {
  const query = readQuery(search);
  const link = emptyLink();
  for (const codec of CODECS) codec.read(query, link);
  return link;
}

/**
 * The query string for a link, without the leading `?`.
 * @param {LinkState} link
 */
export function formatLink(link) {
  return CODECS.flatMap((codec) => codec.write(link))
    .map(([key, value]) => `${encodeQuery(key)}=${Array.isArray(value) ? value.map(encodeQuery).join(",") : encodeQuery(value)}`)
    .join("&");
}
