// benchtrail renders a github-action-benchmark history (`window.BENCHMARK_DATA`) as a dashboard.
// It needs no build step: ECharts comes from the CDN script tag in index.html, and the page's own
// modules load from the `benchtrail/` directory beside this one.
//
// Each recorded entry becomes an observation: a set of named dimensions, a metric, a value, and the
// environment it ran in.
// Typed entries carry these in `extra` as JSON under a `benchtrail` key; untyped entries fall back
// to a configured name pattern, or to their name as the only dimension.
//
// This module ties the page together: it loads the history, keeps the link the page shows, builds
// the view from it, and draws the regions of the page the link opens.

import { createRuntime } from "./benchtrail/chart-runtime.js";
import { yRange } from "./benchtrail/core/chart-option.js";
import { buildSuite, readSettings, suiteSettings } from "./benchtrail/core/history.js";
import { formatLink, parseLink } from "./benchtrail/core/link.js";
import { reduce } from "./benchtrail/core/selection.js";
import { buildView, SLOTS, settle, smoothingWindow } from "./benchtrail/core/view.js";
import { h } from "./benchtrail/dom.js";
import { changesRegion } from "./benchtrail/regions/changes.js";
import { chartsRegion } from "./benchtrail/regions/charts.js";
import { headerRegion } from "./benchtrail/regions/header.js";
import { notesRegion } from "./benchtrail/regions/notes.js";
import { pageHeadRegion } from "./benchtrail/regions/page-head.js";
import { runBarRegion } from "./benchtrail/regions/run-bar.js";
import { runsRegion } from "./benchtrail/regions/runs.js";
import { trailRegion } from "./benchtrail/regions/trail.js";

const echarts = window.echarts;

const config = readConfig();
const narrow = matchMedia("(max-width: 720px)");

// What the page shows, as its link says it.
// It changes only through `dispatch` and `go`, which also write it to the address bar, and when
// the reader moves through the browser's history.
/** @type {import("./benchtrail/core/link.js").LinkState} */
let link = parseLink(location.search);

let data = null;
let suites = [];
let suite = null;
let section = null;
let view = null;
let runtime = null;

// What every region may read and do; its getters always answer with the current state.
/** @type {import("./benchtrail/regions/page.js").Page} */
const page = {
  get link() {
    return link;
  },
  get view() {
    return view;
  },
  get suites() {
    return suites;
  },
  get suite() {
    return suite;
  },
  get section() {
    return section;
  },
  get data() {
    return data;
  },
  config,
  narrow,
  dispatch,
  go,
  href,
  anchor,
  render,
  selectRun,
  preview,
  get hovered() {
    return hovered;
  },
  plot,
  zoomWindow,
  smoothing,
  get runtime() {
    return runtime;
  },
  safely,
  reportFailure,
  regions: null,
};

const regions = {
  header: headerRegion(page),
  pageHead: pageHeadRegion(page),
  trail: trailRegion(page),
  changes: changesRegion(page),
  charts: chartsRegion(page),
  runBar: runBarRegion(page),
  runs: runsRegion(page),
  notes: notesRegion(page),
};
page.regions = regions;

// Each page lists the regions it shows, drawn in this order; the others are hidden.
const PAGES = {
  overview: [regions.header, regions.changes, regions.trail, regions.charts, regions.runBar, regions.runs, regions.notes],
  runs: [regions.header, regions.pageHead, regions.runs],
  chart: [regions.header, regions.pageHead, regions.changes, regions.trail, regions.charts, regions.runBar],
};

async function boot() {
  window.addEventListener("error", (event) => reportFailure(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => reportFailure(event.reason));
  // The theme can be changed even when the history fails to load.
  regions.header.wireTheme();
  if (!echarts) {
    showProblem(
      "The chart library did not load",
      "This page loads ECharts from cdn.jsdelivr.net. Check the network connection or any content blocker, then reload.",
    );
    return;
  }
  runtime = createRuntime(echarts, {
    view: () => view,
    axis: () => link.axis,
    zoom,
    window: zoomWindow,
    percentOfRun: (j) => percentOfRun(j),
    refit: (/** @type {any} */ chart) => {
      const yAxis = yRange(zoomWindow(), chart.plotted, chart.log);
      // The tick formatter reads the step from this object, so labels follow the refitted axis.
      if (chart.scale) chart.scale.interval = yAxis.interval;
      return yAxis;
    },
    zoomed: zoomMoved,
    hovered: preview,
    selected: (j) => selectRun(j),
    fail: reportFailure,
  });
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

  link = settle(suites, link);
  publish();
  // Back and Forward restore a page's scroll position once it is drawn, which the browser cannot
  // do itself, since every page is drawn in place.
  history.scrollRestoration = "manual";
  window.addEventListener(
    "popstate",
    safely((event) => {
      enter(parseLink(location.search));
      publish();
      scrollTo(0, event.state?.scroll ?? 0);
    }),
  );

  // Canvas text keeps whatever font is ready when it draws, so wait briefly for the web font.
  await Promise.race([document.fonts?.ready, new Promise((resolve) => setTimeout(resolve, 1500))]);

  regions.header.renderMasthead();
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

// The view

// Draws from a fresh view of the link; a hover index belongs to the previous view's runs, so it
// never carries over.
function computeView() {
  view = buildView(suites, link);
  suite = view.suite;
  section = view.section;
  resetHover();
}

function smoothing() {
  return smoothingWindow(suite, link);
}

// Changing the link

// Applies the reader's action to the link, settles the result against the data, writes it to the
// address bar, and then draws what changed: the whole page unless the caller names less.
// A new suite or section also starts every region's own state afresh.
function dispatch(action, draw = render) {
  if (action.type === "suite" || action.type === "section") resetRegions();
  link = settle(suites, reduce(link, action));
  publish();
  draw();
}

// Opens another page, as a navigation: the address bar gains an entry that Back returns from, and
// the entry it leaves keeps its scroll position.
function go(action) {
  history.replaceState({ scroll: scrollY }, "");
  enter(reduce(link, action));
  history.pushState(null, "", url(link));
  refreshAnchors();
  scrollTo(0, 0);
  // Focus moves to the new page's heading, so a keyboard or screen reader starts from it.
  document.getElementById("page-title")?.focus({ preventScroll: true });
}

// Shows the page a link opens, with every region's own state and any pending work started afresh,
// since that state belongs to the page being left.
function enter(next) {
  resetRegions();
  clearTimeout(zoomTimer);
  gesture = null;
  link = settle(suites, next);
  render();
}

function resetRegions() {
  for (const region of Object.values(regions)) region.reset?.();
}

// Writes the link to the address bar, replacing the current entry, since changing what the page
// shows is not a navigation.
function publish() {
  history.replaceState(history.state, "", url(link));
  refreshAnchors();
}

/** @param {import("./benchtrail/core/link.js").LinkState} target */
function url(target) {
  const query = formatLink(target);
  return `${location.pathname}${query ? `?${query}` : ""}`;
}

// The address of the page an action opens from the current link.
function href(action) {
  return url(settle(suites, reduce(link, action)));
}

// Anchors to other pages, by the action each opens.
// Their addresses follow the link as it changes, so a copied or newly opened link always carries
// the page as it is now.
const destinations = new WeakMap();

// A link to another page: a real anchor, so it can be copied or opened in a new tab, which a plain
// click opens in place.
function anchor(action, attributes, ...children) {
  const element = h(
    "a",
    {
      ...attributes,
      href: href(action),
      "data-destination": "",
      // The click is the anchor's alone, even one that opens a new tab, so a row around it does
      // not also take it.
      onclick: (event) => {
        event.stopPropagation();
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        go(action);
      },
    },
    ...children,
  );
  destinations.set(element, action);
  return element;
}

function refreshAnchors() {
  for (const element of /** @type {NodeListOf<HTMLAnchorElement>} */ (document.querySelectorAll("a[data-destination]"))) {
    const action = destinations.get(element);
    if (action) element.href = href(action);
  }
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
    const shown = PAGES[link.route.kind];
    arrange(shown);
    for (const region of shown) region.render();
  } catch (error) {
    reportFailure(error);
  } finally {
    rendering = false;
  }
}

// Shows the parts of the page its regions draw into and hides the rest, and lets a region that is
// not shown release what it holds.
function arrange(shown) {
  const visible = new Set(shown.flatMap((region) => region.roots));
  for (const region of Object.values(regions)) {
    for (const id of region.roots) document.getElementById(id).hidden = !visible.has(id);
    if (!shown.includes(region)) region.leave?.();
  }
  document.getElementById("main").dataset.page = link.route.kind;
}

// Whether a region is part of the page the link opens.
function onPage(region) {
  return PAGES[link.route.kind].includes(region);
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

// What every chart of the current view shares, for the option builders.
const smoothCache = new Map();

/** @returns {import("./benchtrail/core/chart-option.js").Plot} */
function plot() {
  return { view, axis: link.axis, scale: link.scale, smoothing: smoothing(), zoom: zoom(), window: zoomWindow, theme: theme(), smoothCache };
}

// Selection and hover

// Hover previews a run in the details panel; leaving the charts returns to the selected run.
// The return waits a moment, so moving between charts does not flicker back and forth.
let hovered = null;
let hoverTimer = 0;
let hoverFrame = 0;

function resetHover() {
  clearTimeout(hoverTimer);
  cancelAnimationFrame(hoverFrame);
  runtime.cancelPointer();
  hovered = null;
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
  hoverFrame = requestAnimationFrame(regions.runBar.renderSelected);
}

// Choosing a run pins it, even the newest, so a link keeps showing it as runs are added; without
// `pin`, the page follows the newest run instead.
function selectRun(index, pin = true) {
  const clamped = Math.min(view.runs.length - 1, Math.max(0, index));
  /** @type {import("./benchtrail/core/link.js").RunSelection} */
  const run = pin ? { kind: "at", key: view.runs[clamped].key } : { kind: "latest" };
  if (clamped === view.selected && link.run.kind === run.kind) return;
  // Selecting a run moves its markers and details in place rather than drawing the page again.
  dispatch({ type: "set", changes: { run } }, () => {
    view.selected = clamped;
    const shared = plot();
    regions.trail.markSelection(shared);
    regions.charts.markSelection(shared);
    regions.runBar.render();
    regions.runs.markHistorySelection();
  });
}

// Controls

function wireControls() {
  regions.header.wire();
  regions.runs.wire();
  // Arrow keys step through runs unless a control has focus.
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (/** @type {Element} */ (event.target).closest?.("input, textarea, select, [role='radio'], [role='tab'], .menu")) return;
    if (event.key === "ArrowLeft") selectRun(view.selected - 1);
    else if (event.key === "ArrowRight") selectRun(view.selected + 1);
    else return;
    event.preventDefault();
  });
}

// The zoom window

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

// The zoom window as a gesture left it, in percent of the x axis, while the link still holds the
// window it was committed as; see `zoom`.
let gesture = null;
let zoomTimer = 0;

// A gesture moved the zoom window: it is shown at once, and committed to the link as the runs at
// its ends once the gesture pauses.
function zoomMoved(start, end) {
  gesture = { start, end, window: link.window, axis: link.axis };
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(
    safely(() => {
      const settled = gesture;
      dispatch({ type: "set", changes: { window: windowAt(settled, link.axis) } }, () => {
        settled.window = link.window;
        for (const region of [regions.changes, regions.runs]) if (onPage(region)) region.render();
        // The movers table ranks lines over the window, so it follows the window once it settles.
        regions.charts.refreshMovers();
      });
    }),
    250,
  );
}

// The zoom window in percent of the x axis: as a gesture left it, until the link's window or axis
// changes for another reason, otherwise the positions of the runs the link names.
function zoom() {
  if (gesture && gesture.window === link.window && gesture.axis === link.axis) return gesture;
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

function showProblem(title, message) {
  const box = document.getElementById("problem");
  box.replaceChildren(h("h2", {}, title), h("p", {}, message));
  box.hidden = false;
  document.getElementById("summary").textContent = "";
}

// Boot last, once every module-level constant above is initialized.
boot();
