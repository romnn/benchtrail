// benchtrail renders a github-action-benchmark history (`window.BENCHMARK_DATA`) as a dashboard.
// It needs no build step: ECharts comes from the CDN script tag in index.html, and the page's own
// modules load from the `benchtrail/` directory beside this one.
//
// Each recorded entry becomes an observation: a set of named dimensions, a metric, a value, and the
// environment it ran in.
// Typed entries carry these in `extra` as JSON under a `benchtrail` key; untyped entries fall back
// to a configured name pattern, or to their name as the only dimension.

import { createRuntime } from "./benchtrail/chart-runtime.js";
import { groupMagnitude, lineOption, markers, trailOption, yRange } from "./benchtrail/core/chart-option.js";
import { BASELINE_RUNS, relative } from "./benchtrail/core/detect.js";
import { displayUnit, formatDate, formatDateTime, formatValue } from "./benchtrail/core/format.js";
import { buildSuite, readSettings, safeUrl, suiteSettings } from "./benchtrail/core/history.js";
import { MISSING, urlText } from "./benchtrail/core/identity.js";
import { AXES, admits, formatLink, parseLink, RANGES, SCALES, SMOOTHING } from "./benchtrail/core/link.js";
import { unique } from "./benchtrail/core/list.js";
import { searchRun, searchTokens } from "./benchtrail/core/search.js";
import { only, reduce } from "./benchtrail/core/selection.js";
import { badness, buildView, colorable, DASHES, dashable, judge, rankMovers, SLOTS, sectionRef, settle, smoothingWindow } from "./benchtrail/core/view.js";
import { changeElement, h, icon } from "./benchtrail/dom.js";

const echarts = window.echarts;
const PAGE_SIZE = 30;
// Past these, the readout under a chart and the grid of charts fold behind a "show all" toggle.
const READOUT_ROWS = 8;
const CHART_LIMIT = 12;
const CHANGES_SHOWN = 5;
const HISTORY_COLUMNS = 6;
// Past this many lines, the page opens on the ranked movers table instead of charts.
const MOVERS_FROM = 48;
const MOVERS_PAGE = 30;

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
/**
 * A metric chart on the page: its runtime instance, the lines it plots, and what the zoom sync
 * needs to refit its value axis.
 * @typedef {object} MetricChartFields
 * @property {string} key
 * @property {import("./benchtrail/core/history.js").Metric} metric
 * @property {string} title
 * @property {import("./benchtrail/core/view.js").Line[]} benches
 * @property {HTMLElement} card
 * @property {HTMLElement} titleNode
 * @property {HTMLElement} note
 * @property {HTMLElement} readout
 * @property {any[]} [readoutItems]
 * @property {Array<Array<number | null>>} [plotted]
 * @property {boolean} [log]
 * @property {{ interval: number | null }} [scale]
 */
/** @typedef {import("./benchtrail/chart-runtime.js").Chart & MetricChartFields} MetricChart */
/** @type {MetricChart[]} */
let charts = [];
let trail = null;
let runtime = null;
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
  runtime = createRuntime(echarts, {
    view: () => view,
    axis: () => link.axis,
    zoom,
    window: zoomWindow,
    percentOfRun: (j) => percentOfRun(j),
    refit: (/** @type {MetricChart} */ chart) => {
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
function dispatch(action, draw = render) {
  link = settle(suites, reduce(link, action));
  publish();
  draw();
}

// Writes the link to the address bar, replacing the current entry, since changing what the page
// shows is not a navigation.
function publish() {
  const query = formatLink(link);
  history.replaceState(history.state, "", `${location.pathname}${query ? `?${query}` : ""}`);
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
  trail = runtime.trail(dom);
  trail.setOption(trailOption(plot(), dom.clientWidth), { notMerge: true });
}

// Metric charts

// Charts are updated in place and only created or removed when the set of charts changes, so
// changing a filter never tears the page down and rebuilds it.
// When dimensions split the charts, each metric gets a heading over its grid of small charts.
function renderCharts() {
  const container = document.getElementById("charts");
  runtime.redrawn();
  const shared = plot();
  const faceted = view.pivot.facet.length > 0;
  renderLayoutSwitch();
  if (currentLayout() === "movers") {
    for (const chart of charts) runtime.unmount(chart);
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
    for (const line of view.lines) {
      if (line.metric.key !== metric.key) continue;
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

  for (const chart of charts) if (!wanted.some((cell) => cell.key === chart.key)) runtime.unmount(chart);
  charts = wanted.map((cell) => {
    const existing = charts.find((chart) => chart.key === cell.key && !chart.instance.isDisposed());
    if (existing) return Object.assign(existing, cell);
    const dom = h("div", { class: "chart", role: "img", "aria-label": `${cell.metric.label} ${cell.title} per run` });
    const note = h("span", { class: "note" });
    const title = h("span", { class: "title" });
    const readout = h("div", { class: "readout" });
    const card = h("article", { class: "chart-card" }, h("h3", {}, title, " ", note), dom, readout);
    return runtime.mount({ ...cell, card, dom, note, readout, titleNode: title });
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
          h("h2", {}, group.metric.label, " ", h("span", { class: "note" }, `${groupUnitLabel(shared, group)}, ${directionText(group.metric)}`)),
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
      shared,
      chart.metric,
      chart.benches,
      faceted,
      group ? groupMagnitude(shared, group) : null,
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
  const spread = link.more && chart.benches.some((line) => line.points.some((i) => line.spread(i)));
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
      const value = line.value(run.index);
      const change = line.change(run.index);
      const kind = line.judgement(run.index);
      cells.value.textContent = value === null ? "–" : formatValue(value, line.unit);
      cells.change.replaceChildren(changeElement(change, kind));
      // A row whose run regressed or improved is emphasized, so the lines that moved stand out.
      cells.value.parentElement.dataset.verdict = kind;
      if (link.more) {
        const base = line.detectionBaseline(run.index);
        const vsBase = value !== null && base ? relative(value, base) : null;
        cells.spread.textContent = line.spread(run.index) ?? "–";
        cells.median.replaceChildren(changeElement(vsBase, judge(chart.metric, vsBase, config.threshold)));
      }
    }
  }
}

function currentLayout() {
  if (link.layout !== "auto") return link.layout;
  return view.lines.length > MOVERS_FROM ? "movers" : "charts";
}

// The switch between charts and the movers table, shown once there are enough lines to need it.
function renderLayoutSwitch() {
  const bar = document.getElementById("layout");
  bar.hidden = view.lines.length <= 8;
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
    h("span", { class: "layout-count" }, `${view.lines.length} lines`),
  );
}

// Movers: every visible line ranked by its net change across the window in view, worst first,
// with a sparkline.
// Choosing a row narrows the filters to that line's chart and switches to charts.
function renderMovers(container) {
  const { first, last } = zoomWindow();
  const runs = view.runs.slice(first, last + 1);
  const ordered = rankMovers(view.lines, runs, config.threshold);

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
        multipleMetrics ? h("span", { class: "metric" }, row.line.metric.label) : null,
      ),
      h(
        "td",
        { class: "spark-cell" },
        sparkline(
          runs.map((run) => row.line.value(run.index)),
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
  const dimensions = new Map(view.pivot.facet.map((key) => [key, only(urlText(line.dims[key]))]));
  dispatch({ type: "focus", metrics: view.metrics.length > 1 ? only(line.metric.slug) : null, dimensions });
  document.querySelector(".charts-area")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function directionText(metric) {
  if (metric.direction === "higher") return "higher is better";
  if (metric.direction === "lower") return "lower is better";
  return "direction unknown";
}

function groupUnitLabel(shared, group) {
  if (link.scale === "change") return `% since ${formatDate(view.runs[0].date)}`;
  return displayUnit(group.metric.unit, groupMagnitude(shared, group)).label || "value";
}

// What every chart of the current view shares, for the option builders.
const smoothCache = new Map();

/** @returns {import("./benchtrail/core/chart-option.js").Plot} */
function plot() {
  return { view, axis: link.axis, scale: link.scale, smoothing: smoothing(), zoom: zoom(), window: zoomWindow, theme: theme(), smoothCache };
}

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
  hoverFrame = requestAnimationFrame(renderSelected);
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
    const marker = markers(shared, { selection: clamped !== view.runs.length - 1 });
    trail?.setOption({ series: [{ id: "trail", markLine: markers(shared, { labels: true }) }] });
    for (const chart of charts) {
      chart.instance.setOption({ series: [{ id: chart.benches[0].key, markLine: marker }] });
    }
    renderSelected();
    renderMessage();
    markHistorySelection();
  });
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
        h("span", { class: "what" }, line.label, multipleMetrics ? h("span", { class: "metric" }, line.metric.label) : null),
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
    const counts = view.counts(view.runs[j]);
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
    const moves = view.moves(run);
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
  const { worse, better } = view.counts(run);
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
      link.run.kind === "at" && shown === view.selected
        ? h(
            "button",
            {
              type: "button",
              class: "follow",
              title: "Show the newest run, and keep following new ones",
              onclick: () => selectRun(view.runs.length - 1, false),
            },
            "Follow newest",
          )
        : null,
    ),
  );
  updateReadouts(run);
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
  const texts = unique(view.lines.map((b) => b.note(run.index)).filter(Boolean));
  const environment = unique(view.lines.flatMap((b) => Object.entries(b.environment(run.index) ?? {}).map(([key, value]) => `${key} ${value}`)));
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
  const sortLine = sort && view.lines.find((b) => b.slug === sort.line);

  // The list follows the zoom window, so it always shows the runs the charts show.
  const { first, last } = zoomWindow();
  const significant = (run) => {
    const counts = view.counts(run);
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
    const key = ({ run }) => badness(sortLine.metric, sortLine.change(run.index));
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
          let next = { line: line.slug, order: "worst" };
          if (active) next = sort.order === "worst" ? { line: line.slug, order: "best" } : null;
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
  const wide = view.lines.length > HISTORY_COLUMNS || narrow.matches;
  const head = h(
    "thead",
    {},
    h(
      "tr",
      {},
      h("th", {}, `${runs.length} ${runs.length === 1 ? "run" : "runs"}`),
      ...(wide
        ? [h("th", {}, "Changes")]
        : view.lines.map((line) => {
            const label = view.metrics.length > 1 ? `${line.label} ${line.metric.label}` : line.label;
            return h("th", {}, lineKey(line.style), sortButton(line, label));
          })),
    ),
  );

  const body = h("tbody", {});
  for (const { run, j, match } of runs.slice(0, ui.shown)) {
    const cells = wide
      ? [h("td", { class: "moves-cell" }, movesElement(view.moves(run), 4))]
      : view.lines.map((line) => {
          const value = line.value(run.index);
          const change = line.change(run.index);
          return h("td", {}, value === null ? "–" : formatValue(value, line.unit), changeElement(change, line.judgement(run.index)));
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
    body.append(h("tr", { class: "empty-row" }, h("td", { colspan: String(wide ? 2 : view.lines.length + 1) }, "No runs match.")));
  }
  table.replaceChildren(head, body);

  const more = document.getElementById("more");
  more.hidden = runs.length <= ui.shown;
  more.textContent = `Show ${Math.min(PAGE_SIZE, runs.length - ui.shown)} more`;
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

// A gesture moved the zoom window: it is shown at once, and committed to the link as the runs at
// its ends once the gesture pauses.
function zoomMoved(start, end) {
  ui.gesture = { start, end, window: link.window, axis: link.axis };
  clearTimeout(zoomTimer);
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

function showProblem(title, message) {
  const box = document.getElementById("problem");
  box.replaceChildren(h("h2", {}, title), h("p", {}, message));
  box.hidden = false;
  document.getElementById("summary").textContent = "";
}

// Boot last, once every module-level constant above is initialized.
boot();
