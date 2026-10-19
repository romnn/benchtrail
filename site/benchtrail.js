// benchtrail renders a github-action-benchmark history (`window.BENCHMARK_DATA`) as a dashboard.
// It needs no build step: ECharts comes from the CDN script tag in index.html, and the page's own
// modules load from the `benchtrail/` directory beside this one.
//
// Each recorded entry becomes an observation: a set of named dimensions, a metric, a value, and the
// environment it ran in.
// Typed entries carry these in `extra` as JSON under a `benchtrail` key; untyped entries fall back
// to a configured name pattern, or to their name as the only dimension.

import { BASELINE_RUNS, median, relative } from "./benchtrail/core/detect.js";
import { displayUnit, formatDate, formatDateTime, formatTick, formatValue, timeFormat } from "./benchtrail/core/format.js";
import { buildSuite, readSettings, safeUrl, suiteSettings, valueText } from "./benchtrail/core/history.js";
import { linkPart, MISSING, token, urlText } from "./benchtrail/core/identity.js";
import { AXES, admits, formatLink, parseLink, RANGES, SCALES, SMOOTHING } from "./benchtrail/core/link.js";
import { compareOrder, unique } from "./benchtrail/core/list.js";
import { only, reduce } from "./benchtrail/core/selection.js";
import { changeElement, h, icon } from "./benchtrail/dom.js";

const echarts = window.echarts;
const PAGE_SIZE = 30;
// Past these, the readout under a chart and the grid of charts fold behind a "show all" toggle.
const READOUT_ROWS = 8;
const CHART_LIMIT = 12;
const CHANGES_SHOWN = 5;
const HISTORY_COLUMNS = 6;
const LOG_SPAN = 20;
// Past this many lines, the page opens on the ranked movers table instead of charts.
const MOVERS_FROM = 48;
const MOVERS_PAGE = 30;
// Values at each end of the window whose medians give a line's net change.
const MOVER_ENDS = 5;
const SLOTS = 8;
const DASHES = ["solid", "dashed", "dotted"];

const READOUTS = [
  { key: "basic", label: "Value and change" },
  { key: "detailed", label: "With spread and baseline" },
];

const config = readConfig();
const narrow = matchMedia("(max-width: 720px)");
// What the page shows, as its link says it.
// It changes only through `dispatch`, which also writes it to the address bar.
/** @type {import("./benchtrail/core/link.js").LinkState} */
let link = parseLink(location.search);

// Conveniences of this reader's session that a link leaves out.
const ui = {
  // How many runs the run list shows.
  shown: PAGE_SIZE,
  moversShown: MOVERS_PAGE,
  // Charts whose readout shows every line.
  openReadouts: new Set(),
  options: false,
  notes: false,
  // The open filter menu, as { key, focus, query, scroll }, or null.
  menu: null,
  // The zoom window as a gesture left it, in percent of the x axis, while the link still holds the
  // window it was committed as; see `zoom`.
  gesture: null,
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
    .map(([name, runs]) => buildSuite(name, runs, suiteSettings(config, name), config.threshold));
  suites = suites.filter((s) => s.sections.length > 0);
  if (suites.length === 0) {
    showProblem("No runs recorded yet", "The history file has no benchmark results. They appear after github-action-benchmark records its first run.");
    return;
  }
  for (const s of suites) for (const problem of s.problems.keys()) console.warn(`benchtrail: ${s.name}: ${problem}`);

  link = settle(link);
  publish();

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
  return {
    title: raw.title ?? null,
    // The history is loaded as a script, so a URL from the query string must stay on this origin;
    // otherwise any link to the page could run foreign code on it.
    dataUrl: fromQuery && safeDataPath(fromQuery) ? fromQuery : (raw.dataUrl ?? "data.js"),
    ...readSettings(raw),
  };
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

// Model

// View: the slice of the section that the filters select, and how it is laid out

// The dimensions that can color lines or dash them, given how many distinct styles each provides.
function colorable(d) {
  return d.varying && d.values.length <= SLOTS * 2;
}

function dashable(d, colorDim) {
  return d.varying && d.values.length <= DASHES.length && (!colorDim || colorDim.values.length <= SLOTS);
}

// The configured default window, when it is one of the offered sizes.
function defaultSmoothing(s = suite) {
  const configured = Number(s?.settings.smoothing ?? 0);
  return SMOOTHING.some((option) => option.key === configured) ? configured : 0;
}

// The smoothing window in effect: the reader's choice, or the current suite's default until the
// reader picks one, so switching suites follows each suite's own default.
function smoothing() {
  return link.smoothing.kind === "explicit" ? link.smoothing.window : defaultSmoothing();
}

// Picks which dimension colors the lines, which sets their dash, and which split the charts.
// Every varying dimension that neither colors nor dashes splits the charts, so no two lines in one
// chart ever look the same.
function choosePivot(at = section, from = link) {
  const varying = at.dims.filter((d) => d.varying);
  const size = (d) => d.values.length;
  const pick = (choice, configured, allowed, auto) => {
    if (choice.kind === "none") return null;
    if (choice.kind === "by" && allowed.some((d) => d.key === choice.key)) return choice.key;
    if (typeof configured === "string" && allowed.some((d) => d.key === configured)) return configured;
    return auto();
  };

  const colorChoices = varying.filter(colorable);
  const color = pick(from.color, at.settings.colorBy, colorChoices, () => {
    const fits = colorChoices.filter((d) => size(d) <= SLOTS);
    if (fits.length) return fits.reduce((best, d) => (size(d) > size(best) ? d : best)).key;
    return colorChoices.length ? colorChoices.reduce((best, d) => (size(d) < size(best) ? d : best)).key : null;
  });
  const colorDim = varying.find((d) => d.key === color);
  const dashChoices = varying.filter((d) => d.key !== color && dashable(d, colorDim));
  const dash = pick(from.dash, at.settings.dashBy, dashChoices, () => {
    if (!colorDim || !dashChoices.length) return null;
    return dashChoices.reduce((best, d) => (size(d) < size(best) ? d : best)).key;
  });
  const facet = varying.filter((d) => d.key !== color && d.key !== dash).map((d) => d.key);
  return { color, dash, facet };
}

function computeView() {
  suite = suites.find((s) => s.name === link.suite) ?? suites[0];
  section = findSection(suite, link.section);
  const runs = rangeRuns(suite, link.range);
  const offset = suite.runs.length - runs.length;
  const pivot = choosePivot();
  const metrics = section.metrics.filter((m) => admits(link.metrics, m.slug));
  const dimsByKey = new Map(section.dims.map((d) => [d.key, d]));
  // A hover index belongs to the previous view's runs, so it never carries over.
  resetHover();

  const passes = (dims) => section.dims.every((d) => admits(link.dimensions.get(d.key), urlText(dims[d.key])));

  // Each line keeps the runs in range that its trace owns, in run order, so per-line work scales
  // with its own observations rather than with every run.
  const lines = [];
  for (const trace of section.traces) {
    const history = trace.history;
    if (!admits(link.metrics, history.metric.slug) || !passes(trace.dims)) continue;
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

  const pinned = link.run;
  let selected = pinned.kind === "at" ? runs.findIndex((run) => run.key === pinned.key) : -1;
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
  const detected = line.history.shifts[runIndex];
  if (detected) return detected.kind;
  if (changeAt(line, runIndex) === null) return "none";
  return line.history.baselines[runIndex] === null ? "unjudged" : "noise";
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

// The runs a range keeps, newest last.
function rangeRuns(s, rangeKey) {
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[RANGES.length - 1];
  return s.runs.slice(Math.max(0, s.runs.length - range.count));
}

// Changing the link

// Applies the reader's action to the link, settles the result against the data, writes it to the
// address bar, and then draws what changed: the whole page unless the caller names less.
function dispatch(action, draw = render) {
  link = settle(reduce(link, action));
  publish();
  draw();
}

// Writes the link to the address bar, replacing the current entry, since changing what the page
// shows is not a navigation.
function publish() {
  const query = formatLink(link);
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}`);
}

// Settles a link against the data, so it names only what exists and leaves out what follows from
// the data anyway:
// - the first suite and section stay implicit, and an unknown one falls back to the first;
// - a dimension filter outside the section is dropped;
// - a color or dash choice the pivot cannot honor is dropped;
// - an explicit smoothing window equal to the suite's default follows the default;
// - a selected run that is the newest, or outside the range, follows the newest run;
// - a window that names runs outside the range is clipped, and one covering it all is dropped.
function settle(next) {
  const s = suites.find((candidate) => candidate.name === next.suite) ?? suites[0];
  const at = findSection(s, next.section);
  const settled = { ...next };
  settled.suite = s === suites[0] ? null : s.name;
  settled.section = s.sections.length > 1 && at !== s.sections[0] ? sectionRef(at) : null;

  // Filters
  const dimensions = new Map();
  for (const d of at.dims) {
    const filter = next.dimensions.get(d.key);
    if (filter && filter.kind === "only") dimensions.set(d.key, filter);
  }
  settled.dimensions = dimensions;

  // Pivot
  const pivot = choosePivot(at, settled);
  if (next.color.kind === "by" && next.color.key !== pivot.color) settled.color = { kind: "auto" };
  if (next.dash.kind === "by" && next.dash.key !== pivot.dash) settled.dash = { kind: "auto" };

  if (next.smoothing.kind === "explicit" && next.smoothing.window === defaultSmoothing(s)) settled.smoothing = { kind: "configured" };

  // Run and window
  const runs = rangeRuns(s, next.range);
  const position = (key) => (key === null ? -1 : runs.findIndex((run) => run.key === key));
  if (next.run.kind === "at") {
    const j = position(next.run.key);
    if (j < 0 || j === runs.length - 1) settled.run = { kind: "latest" };
  }
  if (next.window.kind === "between") {
    const from = Math.max(0, position(next.window.from));
    const to = position(next.window.to);
    const end = to < 0 ? runs.length - 1 : to;
    settled.window =
      runs.length === 0 || (from === 0 && end === runs.length - 1) ? { kind: "full" } : { kind: "between", from: runs[from].key, to: runs[end].key };
  }
  return settled;
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
            resetSectionUi();
            dispatch({ type: "suite", suite: s.name });
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
          onclick: () => {
            if (s === section) return;
            resetSectionUi();
            dispatch({ type: "section", section: sectionRef(s) });
          },
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
  if (wanted.kind === "benchmark") {
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

/** @returns {import("./benchtrail/core/link.js").SectionRef} */
function sectionRef(s) {
  return s.link === null ? { kind: "keys", keys: s.keys } : { kind: "benchmark", link: s.link };
}

// A new section closes its filter menu and starts its movers table at the first page.
function resetSectionUi() {
  ui.menu = null;
  ui.moversShown = MOVERS_PAGE;
}

function renderFilters() {
  segmented("range", RANGES, link.range, (key) => dispatch({ type: "range", range: key }));
  segmented("scale", SCALES, link.scale, (key) => dispatch({ type: "set", changes: { scale: key } }));
  // The window names runs, so a change of axis keeps the same runs in view.
  segmented("axis", AXES, link.axis, (key) => dispatch({ type: "set", changes: { axis: key } }));
  segmented("smooth", SMOOTHING, smoothing(), (key) => dispatch({ type: "set", changes: { smoothing: { kind: "explicit", window: key } } }));
  renderTheme();
  segmented("readout", READOUTS, link.more ? "detailed" : "basic", (key) => dispatch({ type: "set", changes: { more: key === "detailed" } }));

  // Color and dash choices list the dimensions with few enough values to style apart, the same
  // ones the pivot accepts, plus none.
  const varying = section.dims.filter((d) => d.varying);
  const colorDim = varying.find((d) => d.key === view.pivot.color);
  const choices = (dims) => [...dims.map((d) => ({ key: d.key, label: d.label })), { key: "", label: "None" }];
  const colorChoices = varying.filter(colorable);
  const dashChoices = varying.filter((d) => d.key !== view.pivot.color && dashable(d, colorDim));
  document.getElementById("color-group").hidden = colorChoices.length === 0;
  segmented("color", choices(colorChoices), view.pivot.color ?? "", (key) =>
    dispatch({ type: "set", changes: { color: key ? { kind: "by", key } : { kind: "none" } } }),
  );
  document.getElementById("dash-group").hidden = dashChoices.length === 0 || !view.pivot.color;
  segmented("dash", choices(dashChoices), view.pivot.dash ?? "", (key) =>
    dispatch({ type: "set", changes: { dash: key ? { kind: "by", key } : { kind: "none" } } }),
  );

  // Each filter is a list of values that can be toggled, each named by its link id.
  // The color and dash dimensions stay inline, since their rows double as the legend; every other
  // filter collapses into a menu, so the header stays one or two lines however many dimensions
  // a suite has.
  const filters = [];
  if (section.metrics.length > 1) {
    filters.push({
      key: "\u0000metric",
      label: "Metric",
      inline: section.metrics.length <= 4,
      items: section.metrics.map((metric) => ({ id: metric.slug, text: metric.label, style: null })),
      filtered: link.metrics.kind === "only",
      shown: (id) => admits(link.metrics, id),
      show: (selected) => dispatch({ type: "metrics", metrics: selected === "all" ? { kind: "all" } : only(selected) }),
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
      items: d.values.map((value) => ({ id: value.param, text: value.token === MISSING ? "none" : value.text, style: style(value) })),
      filtered: link.dimensions.has(d.key),
      shown: (id) => admits(link.dimensions.get(d.key), id),
      show: (selected) => dispatch({ type: "dimension", key: d.key, filter: selected === "all" ? { kind: "all" } : only(selected) }),
    });
  }
  // Inline rows first, so the legend keeps its place while menus are opened and closed.
  filters.sort((a, b) => b.inline - a.inline);
  document.getElementById("filters").replaceChildren(...filters.map((filter) => (filter.inline ? inlineFilter(filter) : menuFilter(filter))));
  if (ui.menu) restoreMenu();
}

// The ids a filter shows after toggling one of them, in the filter's own order, so one selection
// always reads as the same link.
function toggled(filter, id) {
  return filter.items.map((item) => item.id).filter((other) => (other === id ? !filter.shown(other) : filter.shown(other)));
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
      ...filter.items.map((item) => toggleChip(item.text, filter.shown(item.id), item.style, () => filter.show(toggled(filter, item.id)))),
      // A filtered row offers to show every value again, including values recorded later.
      filter.filtered ? h("button", { type: "button", class: "option chips-all", onclick: () => filter.show("all") }, "Show all") : null,
    ),
  );
}

// A menu button that summarizes the selection, over a panel of checkboxes.
// Each value also has an "only" action, since narrowing to one value is the common case.
// The page re-renders on every change, so the open menu, its search text, and its focus live in
// state and are restored afterwards.
function menuFilter(filter) {
  const total = filter.items.length;
  const visible = filter.items.filter((item) => filter.shown(item.id));
  // An explicit list of every value reads as a count, apart from the filter for all values.
  const summary = !filter.filtered
    ? "all"
    : visible.length === 0
      ? "none"
      : visible.length <= 2
        ? visible.map((item) => item.text).join(", ")
        : `${visible.length} of ${total}`;
  const open = ui.menu?.key === filter.key;
  const apply = (selected, focus) => {
    const panel = document.querySelector(`.menu[data-menu="${CSS.escape(filter.key)}"] .menu-panel`);
    ui.menu = { ...ui.menu, key: filter.key, focus, scroll: panel?.scrollTop ?? 0 };
    filter.show(selected);
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
        ui.menu = open ? null : { key: filter.key, focus: null, query: "", scroll: 0 };
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
            ui.menu.query = event.target.value;
            filterMenuItems(event.target.closest(".menu"));
          },
        })
      : null;
  const all = filter.filtered
    ? h(
        "button",
        {
          type: "button",
          class: "option menu-all",
          "data-focus": "\u0000all",
          onclick: () => apply("all", "\u0000all"),
        },
        "Show all",
      )
    : null;
  const items = filter.items.map((item) => {
    const id = `menu-${encodeURIComponent(filter.key)}-${encodeURIComponent(item.id)}`;
    return h(
      "div",
      { class: "menu-item", "data-text": item.text.toLowerCase() },
      h("input", {
        type: "checkbox",
        id,
        checked: filter.shown(item.id),
        "data-focus": item.id,
        onchange: () => apply(toggled(filter, item.id), item.id),
      }),
      h("label", { for: id }, item.style ? lineKey(item.style) : null, item.text),
      h(
        "button",
        {
          type: "button",
          class: "only",
          "aria-label": `Show only ${item.text}`,
          "data-focus": `\u0000only\u0000${item.id}`,
          onclick: () => apply(new Set([item.id]), item.id),
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
  const query = (ui.menu?.query ?? "").trim().toLowerCase();
  for (const item of menu.querySelectorAll(".menu-item")) item.hidden = Boolean(query) && !item.dataset.text.includes(query);
}

// Restores the open menu after a render: its search text, its focus, and a position that keeps
// the panel inside the viewport.
function restoreMenu() {
  const menu = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".menu"))].find((m) => m.dataset.menu === ui.menu.key);
  if (!menu) {
    ui.menu = null;
    return;
  }
  const search = /** @type {HTMLInputElement | null} */ (menu.querySelector(".menu-search"));
  if (search) {
    search.value = ui.menu.query ?? "";
    filterMenuItems(menu);
  }
  const panel = /** @type {HTMLElement} */ (menu.querySelector(".menu-panel"));
  const overflow = panel.getBoundingClientRect().right - (document.documentElement.clientWidth - 16);
  if (overflow > 0) panel.style.left = `${-overflow}px`;
  panel.scrollTop = ui.menu.scroll ?? 0;
  const focus = ui.menu.focus;
  const focusable = /** @type {NodeListOf<HTMLElement>} */ (menu.querySelectorAll("[data-focus]"));
  const target = [...focusable].find((el) => el.dataset.focus === focus) ?? search ?? menu.querySelector("input");
  target?.focus({ preventScroll: true });
}

function closeMenu(returnFocus) {
  if (!ui.menu) return;
  const key = ui.menu.key;
  ui.menu = null;
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
  const byDate = link.axis === "date";
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
  if (!link.allCharts && total > CHART_LIMIT) {
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
            onclick: () => dispatch({ type: "set", changes: { allCharts: !link.allCharts } }),
          },
          link.allCharts ? `Show the first ${CHART_LIMIT} charts` : `Show all ${total} charts`,
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
  const open = ui.openReadouts.has(chart.key);
  const lines = open ? chart.benches : chart.benches.slice(0, READOUT_ROWS);
  // The spread column appears only for lines that record one.
  const spread = link.more && chart.benches.some((line) => line.points.some((i) => line.history.ranges[i]));
  chart.readoutItems = lines.map((line) => {
    const cells = { value: h("td", { class: "readout-value" }), change: h("td"), spread: h("td"), median: h("td") };
    const row = h(
      "tr",
      {},
      h("td", { class: "readout-label", title: line.label }, lineKey(line.style), line.style.label),
      cells.value,
      cells.change,
      spread ? cells.spread : null,
      link.more ? cells.median : null,
    );
    return { line, cells, row };
  });
  const cols = [h("col"), h("col", { class: "num" }), h("col", { class: "num" })];
  if (spread) cols.push(h("col", { class: "num" }));
  if (link.more) cols.push(h("col", { class: "num" }));
  const head = link.more
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
              if (open) ui.openReadouts.delete(chart.key);
              else ui.openReadouts.add(chart.key);
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
      if (link.more) {
        const base = line.history.baselines[run.index];
        const vsBase = value !== null && base ? relative(value, base) : null;
        cells.spread.textContent = rangeAt(line, run.index) ?? "–";
        cells.median.replaceChildren(changeElement(vsBase, verdict(chart.metric, vsBase)));
      }
    }
  }
}

function currentLayout() {
  if (link.layout !== "auto") return link.layout;
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
            if (option.key !== current) dispatch({ type: "set", changes: { layout: option.key } });
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
    const shifts = inWindow.filter((i) => history.shifts[i]).length;
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
  const body = ordered.slice(0, ui.moversShown).map((row) =>
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
    ordered.length > ui.moversShown
      ? h(
          "button",
          {
            type: "button",
            class: "more",
            onclick: () => {
              ui.moversShown += MOVERS_PAGE;
              renderCharts();
            },
          },
          `Show ${Math.min(MOVERS_PAGE, ordered.length - ui.moversShown)} more`,
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
  const only = (value) => ({ kind: "only", values: new Set([value]) });
  const dimensions = new Map(view.pivot.facet.map((key) => [key, only(urlText(line.trace.dims[key]))]));
  dispatch({ type: "focus", metrics: view.metrics.length > 1 ? only(line.history.metric.slug) : null, dimensions });
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
  const key = `${smoothing()}|${link.scale}|${view.offset}|${view.runs.length}|${factor}|${base}`;
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
  if (link.scale === "change") return `% since ${formatDate(view.runs[0].date)}`;
  return displayUnit(group.metric.unit, groupMagnitude(group)).label || "value";
}

function lineOption(metric, benches, t, compact, sharedMagnitude = null, width = 0) {
  const byDate = link.axis === "date";
  const asChange = link.scale === "change";
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
      const moved = event.batch?.[0] ?? event;
      if (!Number.isFinite(moved.start) || !Number.isFinite(moved.end)) return;
      ui.gesture = { start: moved.start, end: moved.end, window: link.window, axis: link.axis };
      syncZoom(instance);
      clearTimeout(zoomTimer);
      // Once the gesture pauses, its window is committed to the link as the runs at its ends.
      zoomTimer = setTimeout(
        safely(() => {
          const gesture = ui.gesture;
          dispatch({ type: "set", changes: { window: windowAt(gesture, link.axis) } }, () => {
            gesture.window = link.window;
            renderChanges();
            renderHistory();
            // The movers table ranks lines over the window, so it follows the window once it settles.
            if (currentLayout() === "movers") renderMovers(document.getElementById("charts"));
          });
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
      const x = instance.convertToPixel({ xAxisIndex: 0 }, link.axis === "date" ? run.date : `r${run.index}`);
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
    const current = zoom();
    const key = `${current.start}|${current.end}|${charts.length}`;
    if (key === appliedZoom) return;
    appliedZoom = key;
    // A gesture on a chart moves its own window, but its value axis still needs refitting.
    pendingZoom.clear();
    const window = { start: current.start, end: current.end };
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
        for (const chart of pendingZoom) applyZoom(chart, zoom());
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
  if (link.axis === "date") {
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
  const { start, end } = zoom();
  // Plain wheel scrolling keeps moving the page; zooming needs a modifier or a pinch, which
  // browsers report as a wheel event with the control key held.
  const inside = {
    type: "inside",
    filterMode: "none",
    start,
    end,
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
      start,
      end,
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
  const x = (run) => (link.axis === "date" ? run.date : `r${run.index}`);
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
  if (link.axis !== "date") return Math.round(Number(x));
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
  // Selecting a run moves its markers and details in place rather than drawing the page again.
  dispatch({ type: "set", changes: { run: { kind: "at", key: view.runs[clamped].key } } }, () => {
    view.selected = clamped;
    const t = theme();
    const marker = markers(t, { selection: clamped !== view.runs.length - 1 });
    trail?.setOption({ series: [{ id: "trail", markLine: markers(t, { labels: true }) }] });
    for (const chart of charts) {
      chart.instance.setOption({ series: [{ id: chart.benches[0].name, markLine: marker }] });
    }
    renderSelected();
    renderMessage();
    markHistorySelection();
  });
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

  const open = link.changes !== "closed" && entries.length > 0;
  const setChanges = (value) => dispatch({ type: "set", changes: { changes: value } }, renderChanges);
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

  const shown = link.changes === "all" ? entries : entries.slice(0, CHANGES_SHOWN);
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
          { type: "button", class: "changes-more", onclick: () => setChanges(link.changes === "all" ? "open" : "all") },
          link.changes === "all" ? "Show fewer" : `Show all ${entries.length}`,
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
      const { shift, tentative } = line.history.shifts[i];
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
  const open = link.list;
  document.getElementById("history").hidden = !open;
  /** @type {HTMLInputElement} */ (document.getElementById("only-changes")).checked = link.onlyChanges;
  disclosure(document.getElementById("list-toggle"), open, open ? "Hide runs" : `All ${suite.runs.length} runs`);
  if (!open) return;

  const table = document.getElementById("history-table");
  const tokens = searchTokens(link.query);
  const sort = link.sort;
  const sortLine = sort && view.benches.find((b) => b.sortKey === sort.line);

  // The list follows the zoom window, so it always shows the runs the charts show.
  const { first, last } = zoomWindow();
  const significant = (run) => {
    const counts = countVerdicts(run);
    return counts.worse + counts.better + counts.moved > 0;
  };
  let runs = view.runs
    .map((run, j) => ({ run, j }))
    .filter(({ j }) => j >= first && j <= last)
    .map((entry) => ({ ...entry, match: tokens.length ? searchRun(entry.run, tokens, link.query) : null }))
    .filter(({ match }) => !tokens.length || match)
    .filter(({ run }) => !link.onlyChanges || significant(run));
  if (tokens.length && !sortLine) {
    // Search results rank by relevance, newest first among equals.
    runs.sort((a, b) => b.match.tier - a.match.tier || b.match.score - a.match.score || b.j - a.j);
  } else if (sortLine) {
    // Worst first sorts by regression size, best first by improvement size; runs without a
    // change for this benchmark go last either way.
    const sign = sort.order === "best" ? -1 : 1;
    const key = ({ run }) => badness(sortLine.history.metric, changeAt(sortLine, run.index));
    runs.sort((a, b) => Number(key(a) === null) - Number(key(b) === null) || sign * (key(b) - key(a)));
  } else {
    runs = runs.reverse();
  }

  const sortButton = (line, label) => {
    const active = sortLine === line;
    const marker = active ? icon(sort.order === "best" ? "up" : "down", "sort-icon") : null;
    return h(
      "button",
      {
        type: "button",
        class: "option",
        "aria-pressed": String(active),
        title: "Sort by change: worst first, then best first, then by date",
        onclick: () => {
          /** @type {import("./benchtrail/core/link.js").Sort | null} */
          let next = { line: line.sortKey, order: "worst" };
          if (active) next = sort.order === "worst" ? { line: line.sortKey, order: "best" } : null;
          ui.shown = PAGE_SIZE;
          dispatch({ type: "set", changes: { sort: next } }, renderHistory);
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
  for (const { run, j, match } of runs.slice(0, ui.shown)) {
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
  more.hidden = runs.length <= ui.shown;
  more.textContent = `Show ${Math.min(PAGE_SIZE, runs.length - ui.shown)} more`;
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
      "aria-expanded": String(ui.notes),
      onclick: () => {
        ui.notes = !ui.notes;
        renderNotes();
      },
    },
    `${count} ${count === 1 ? "problem" : "problems"} reading this suite`,
  );
  const list = ui.notes ? h("ul", { class: "notes-list" }, ...problems.map(([message, n]) => h("li", {}, n > 1 ? `${message} (${n} times)` : message))) : null;
  container.replaceChildren(...[button, list].filter(Boolean));
}

// Controls

function wireControls() {
  const search = /** @type {HTMLInputElement} */ (document.getElementById("search"));
  search.value = link.query;
  // Searching waits for a short pause in typing, so a long history is not searched per keystroke.
  let searchTimer = 0;
  search.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(
      safely(() => {
        ui.shown = PAGE_SIZE;
        dispatch({ type: "set", changes: { query: search.value } }, renderHistory);
      }),
      120,
    );
  });
  document.getElementById("more").addEventListener("click", () => {
    ui.shown += PAGE_SIZE;
    renderHistory();
  });
  wireSettings();
  document.getElementById("list-toggle").addEventListener("click", () => dispatch({ type: "set", changes: { list: !link.list } }, renderHistory));
  document.getElementById("only-changes").addEventListener("change", (event) => {
    ui.shown = PAGE_SIZE;
    dispatch({ type: "set", changes: { onlyChanges: /** @type {HTMLInputElement} */ (event.target).checked } }, renderHistory);
  });
  narrow.addEventListener("change", () => renderHistory());
  // A click outside the open menu closes it.
  // A click inside can re-render the menu, which detaches the clicked node, so those are skipped.
  document.addEventListener("click", (event) => {
    const target = /** @type {Element} */ (event.target);
    if (!ui.menu || !target.isConnected || target.closest(".menu")) return;
    closeMenu(false);
  });
  // Arrow keys step through runs unless a control has focus.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.menu) {
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
    ui.options = open;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => set(!ui.options));
  document.addEventListener("click", (event) => {
    const target = /** @type {Element} */ (event.target);
    if (ui.options && target.isConnected && !target.closest(".settings")) set(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && ui.options) {
      set(false);
      toggle.focus();
    }
  });
  set(false);
}

// Zoom windows are percentages of the x axis, which spans run positions or dates.
function percentOfRun(j, axis = link.axis) {
  const runs = view.runs;
  if (runs.length < 2) return 0;
  if (axis === "date") {
    const span = runs.at(-1).date - runs[0].date;
    return span > 0 ? ((runs[j].date - runs[0].date) / span) * 100 : 0;
  }
  return (j / (runs.length - 1)) * 100;
}

function runAtPercent(percent, axis = link.axis) {
  const runs = view.runs;
  if (axis !== "date") return runs[Math.round((percent / 100) * (runs.length - 1))];
  const target = runs[0].date + (percent / 100) * (runs.at(-1).date - runs[0].date);
  return runs.reduce((best, run) => (Math.abs(run.date - target) < Math.abs(best.date - target) ? run : best));
}

// The zoom window in percent of the x axis: as a gesture left it, until the link's window or axis
// changes for another reason, otherwise the positions of the runs the link names.
function zoom() {
  if (ui.gesture && ui.gesture.window === link.window && ui.gesture.axis === link.axis) return ui.gesture;
  const window = link.window;
  if (window.kind === "full" || view.runs.length === 0) return { start: 0, end: 100 };
  const position = (key) => view.runs.findIndex((run) => run.key === key);
  const from = position(window.from);
  const to = position(window.to);
  return { start: from < 0 ? 0 : percentOfRun(from), end: to < 0 ? 100 : percentOfRun(to) };
}

// The link's window for a zoom window in percent of an axis: the runs at its ends.
/** @returns {import("./benchtrail/core/link.js").PlotWindow} */
function windowAt({ start, end }, axis) {
  if ((start <= 0 && end >= 100) || view.runs.length === 0) return { kind: "full" };
  return { kind: "between", from: runAtPercent(start, axis).key, to: runAtPercent(end, axis).key };
}

// The view positions of the first and last run in the zoom window, computed once per window and
// view, since axis label callbacks ask for them for every candidate label.
let windowCache = null;

function zoomWindow() {
  const current = zoom();
  const key = `${current.start}|${current.end}|${link.axis}`;
  if (windowCache?.view === view && windowCache.key === key) return windowCache;
  const zoomed = zoomedRuns();
  // Runs in a view are consecutive, so a run's position is its index past the view's offset.
  const first = zoomed ? zoomed.from.index - view.offset : 0;
  const last = zoomed ? zoomed.to.index - view.offset : view.runs.length - 1;
  windowCache = { view, key, first, last };
  return windowCache;
}

// The first and last run inside the zoom window, or null when nothing is zoomed.
function zoomedRuns() {
  const { start, end } = zoom();
  if ((start <= 0 && end >= 100) || view.runs.length === 0) return null;
  return { from: runAtPercent(start), to: runAtPercent(end) };
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

function showProblem(title, message) {
  const box = document.getElementById("problem");
  box.replaceChildren(h("h2", {}, title), h("p", {}, message));
  box.hidden = false;
  document.getElementById("summary").textContent = "";
}

// Boot last, once every module-level constant above is initialized.
boot();
