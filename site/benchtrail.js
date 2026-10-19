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
import { percentOfRun, runsIn, windowAt, zoomOf } from "./benchtrail/core/viewport.js";
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
  saveEntry: () => persistEntry(),
  render,
  selectRun,
  preview,
  shownRun,
  showRun,
  plot,
  zoomWindow,
  smoothing,
  get runtime() {
    return runtime;
  },
  safely,
  reportFailure,
};

/** @satisfies {Record<string, import("./benchtrail/regions/page.js").Region>} */
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

// Each page lists the regions it shows, drawn in this order; the others are hidden.
/** @satisfies {Record<import("./benchtrail/core/link.js").Route["kind"], readonly import("./benchtrail/regions/page.js").Region[]>} */
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
    percentOfRun: (j) => percentOfRun(view.runs, j, link.axis),
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
  // A reload keeps the entry's state, which says how the page was left.
  const saved = history.state ?? {};
  entryId = saved.id ?? nextEntryId();
  entries.set(entryId, { scroll: saved.scroll, regions: saved.regions });
  history.replaceState({ ...saved, id: entryId }, "", url(link));
  // Back and Forward restore a page as it was left once it is drawn, which the browser cannot do
  // itself, since every page is drawn in place.
  history.scrollRestoration = "manual";
  window.addEventListener(
    "scroll",
    () => {
      remember({ scroll: scrollY });
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(persistEntry, 150);
    },
    { passive: true },
  );
  window.addEventListener(
    "popstate",
    safely((event) => {
      // The entry just left can no longer be written, so it is remembered in memory alone.
      clearTimeout(scrollTimer);
      remember({ scroll: scrollY, regions: snapshot() });
      entryId = event.state?.id ?? nextEntryId();
      const saved = entries.get(entryId) ?? event.state ?? {};
      enter(parseLink(location.search), saved.regions);
      history.replaceState({ ...history.state, id: entryId }, "", url(link));
      refreshAnchors();
      scrollTo(0, saved.scroll ?? 0);
    }),
  );

  // Canvas text keeps whatever font is ready when it draws, so wait briefly for the web font.
  await Promise.race([document.fonts?.ready, new Promise((resolve) => setTimeout(resolve, 1500))]);

  regions.header.renderMasthead();
  document.getElementById("main").hidden = false;
  document.getElementById("controls").hidden = false;
  wireControls();
  restoreRegions(saved.regions);
  render();
  if (saved.scroll) scrollTo(0, saved.scroll);
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
// A zoom gesture still waiting for its pause is committed first, so the action applies to the
// window the reader sees; the page is then drawn whole, since the window changed too.
function dispatch(action, draw = render) {
  const redraw = commitGesture() ? render : draw;
  if (action.type === "suite" || action.type === "section") startAfresh();
  link = settle(suites, reduce(link, action));
  publish();
  redraw();
}

// Opens another page, as a navigation: the address bar gains an entry that Back returns from, and
// the entry it leaves keeps the page as it was left, including a zoom gesture made just before.
function go(action) {
  if (commitGesture()) publish();
  clearTimeout(scrollTimer);
  remember({ scroll: scrollY, regions: snapshot() });
  persistEntry();
  enter(reduce(link, action));
  entryId = nextEntryId();
  history.pushState({ id: entryId }, "", url(link));
  refreshAnchors();
  scrollTo(0, 0);
  // Focus moves to the new page's heading, or to the project's name on the overview, so a
  // keyboard or screen reader starts from it.
  document.getElementById(link.route.kind === "overview" ? "project-link" : "page-title")?.focus({ preventScroll: true });
}

// Shows the page a link opens, with every region's own state and any pending work started afresh,
// since that state belongs to the page being left, or restored as a history entry left it.
function enter(next, saved = undefined) {
  startAfresh();
  restoreRegions(saved);
  clearTimeout(zoomTimer);
  zoomTimer = 0;
  gesture = null;
  link = settle(suites, next);
  render();
}

// History entries
//
// Each entry carries an id in its state, under which the page remembers how the entry was left:
// its scroll position, and what its regions had expanded, such as how many runs the list shows.
// The record changes in memory at once, and is written to the entry after a pause, since browsers
// limit how often an entry can be replaced; the written copy outlasts a reload.

/** @type {Map<string, { scroll?: number, regions?: Record<string, unknown> }>} */
const entries = new Map();
const pageLoad = Date.now().toString(36);
let entryCount = 0;
let entryId = "";
let scrollTimer = 0;

function nextEntryId() {
  entryCount += 1;
  return `${pageLoad}.${entryCount}`;
}

function remember(record) {
  entries.set(entryId, { ...entries.get(entryId), ...record });
}

// Writes the entry's record, with its regions as they are now, since a region that expanded may
// not have scrolled since.
function persistEntry() {
  remember({ regions: snapshot() });
  history.replaceState({ ...history.state, ...entries.get(entryId), id: entryId }, "");
}

/** @param {Record<string, unknown> | undefined} saved */
function restoreRegions(saved) {
  for (const [name, region] of Object.entries(regions)) if (saved?.[name] !== undefined) region.restore?.(saved[name]);
}

// What each region would restore of its own state, by region name.
function snapshot() {
  return Object.fromEntries(Object.entries(regions).flatMap(([name, region]) => (region.snapshot ? [[name, region.snapshot()]] : [])));
}

// Starts the state that belongs to one suite, section, or page afresh, each region's own.
function startAfresh() {
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
  for (const group of document.querySelectorAll("[data-group]")) {
    /** @type {HTMLElement} */ (group).hidden = [...group.children].every((child) => /** @type {HTMLElement} */ (child).hidden);
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
  hoverFrame = requestAnimationFrame(showRun);
}

// The run the run bar and the readouts show: the one under the pointer, or else the selected one.
function shownRun() {
  return view.runs[hovered !== null && view.runs[hovered] ? hovered : view.selected];
}

// Shows the hovered or selected run in place, in the run bar and under every chart.
function showRun() {
  if (onPage(regions.runBar)) regions.runBar.renderSelected();
  const run = shownRun();
  if (run && onPage(regions.charts)) regions.charts.updateReadouts(run);
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
    if (onPage(regions.trail)) regions.trail.markSelection(shared);
    if (onPage(regions.charts)) regions.charts.markSelection(shared);
    if (onPage(regions.runBar)) regions.runBar.renderMessage();
    showRun();
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

// The zoom window as a gesture left it, in percent of the x axis, while the link still holds the
// window it was committed as; see `zoom`.
// The timer is 0 while no gesture waits to be committed.
let gesture = null;
let zoomTimer = 0;

// A gesture moved the zoom window: it is shown at once, and committed to the link as the runs at
// its ends once the gesture pauses.
function zoomMoved(start, end) {
  gesture = { start, end, window: link.window, axis: link.axis };
  clearTimeout(zoomTimer);
  zoomTimer = setTimeout(
    safely(() => {
      zoomTimer = 0;
      const settled = gesture;
      dispatch({ type: "set", changes: { window: windowAt(view.runs, settled, settled.axis) } }, () => {
        settled.window = link.window;
        for (const region of [regions.changes, regions.runs]) if (onPage(region)) region.render();
        // The movers table ranks lines over the window, so it follows the window once it settles.
        regions.charts.refreshMovers();
      });
    }),
    250,
  );
}

// Commits a gesture still waiting for its pause, as the runs at its ends on the axis it was made
// on, and says whether there was one.
function commitGesture() {
  if (!zoomTimer) return false;
  clearTimeout(zoomTimer);
  zoomTimer = 0;
  link = settle(suites, reduce(link, { type: "set", changes: { window: windowAt(view.runs, gesture, gesture.axis) } }));
  gesture.window = link.window;
  return true;
}

// The zoom window in percent of the x axis: as a gesture left it, until the link's window or axis
// changes for another reason, otherwise the positions of the runs the link names.
function zoom() {
  if (gesture && gesture.window === link.window && gesture.axis === link.axis) return gesture;
  return zoomOf(view.runs, link.window, link.axis);
}

// The view positions of the first and last run in the zoom window, computed once per window and
// view, since axis label callbacks ask for them for every candidate label.
let windowCache = null;

function zoomWindow() {
  const current = zoom();
  const key = `${current.start}|${current.end}|${link.axis}`;
  if (windowCache?.view === view && windowCache.key === key) return windowCache;
  windowCache = { view, key, ...runsIn(view.runs, current, link.axis) };
  return windowCache;
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
