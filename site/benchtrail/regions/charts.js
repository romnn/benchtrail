// The charts: one per metric, or small multiples when dimensions split them, each with a readout
// of its lines; or, for many lines, the movers table that ranks them.
// On the overview, each chart's title opens the chart's own page, which shows it alone and large.

import { groupMagnitude, lineOption, markers } from "../core/chart-option.js";
import { BASELINE_RUNS, relative } from "../core/detect.js";
import { displayUnit, formatDate, formatValue } from "../core/format.js";
import { urlText } from "../core/identity.js";
import { only } from "../core/selection.js";
import { chartId, judge, rankMovers } from "../core/view.js";
import { changeElement, h, lineKey } from "../dom.js";

// Past these, the readout under a chart and the grid of charts fold behind a "show all" toggle.
const READOUT_ROWS = 8;
const CHART_LIMIT = 12;
// Past this many lines, the page opens on the ranked movers table instead of charts.
const MOVERS_FROM = 48;
const MOVERS_PAGE = 30;

/**
 * A metric chart on the page: its runtime instance, the lines it plots, and what the zoom sync
 * needs to refit its value axis.
 * @typedef {object} MetricChartFields
 * @property {string} key
 * @property {import("../core/history.js").Metric} metric
 * @property {string} title
 * @property {import("../core/view.js").Line[]} benches
 * @property {HTMLElement} card
 * @property {HTMLElement} titleNode
 * @property {HTMLElement} note
 * @property {HTMLElement} readout
 * @property {any[]} [readoutItems]
 * @property {Array<Array<number | null>>} [plotted]
 * @property {boolean} [log]
 * @property {{ interval: number | null }} [scale]
 */
/** @typedef {import("../chart-runtime.js").Chart & MetricChartFields} MetricChart */

/** @param {import("./page.js").Page} page */
export function chartsRegion(page) {
  /** @type {MetricChart[]} */
  let charts = [];
  // Charts whose readout shows every line, and how many rows the movers table shows.
  const openReadouts = new Set();
  let moversShown = MOVERS_PAGE;

  // Charts are updated in place and only created or removed when the set of charts changes, so
  // changing a filter never tears the page down and rebuilds it.
  // When dimensions split the charts, each metric gets a heading over its grid of small charts.
  function renderCharts() {
    const container = document.getElementById("charts");
    page.runtime.redrawn();
    const shared = page.plot();
    const faceted = page.view.pivot.facet.length > 0;
    const charted = page.link.route.kind === "chart";
    renderLayoutSwitch();
    if (currentLayout() === "movers") {
      for (const chart of charts) page.runtime.unmount(chart);
      charts = [];
      container.classList.remove("is-faceted");
      container.classList.add("is-movers");
      renderMovers(container);
      return;
    }
    container.classList.remove("is-movers");

    const groups = [];
    for (const metric of page.view.metrics) {
      const cells = new Map();
      for (const line of page.view.lines) {
        if (line.metric.key !== metric.key) continue;
        if (!cells.has(line.facet.token)) {
          cells.set(line.facet.token, { key: `${metric.key}\u0002${line.facet.token}`, metric, title: faceted ? line.facet.label : metric.label, benches: [] });
        }
        cells.get(line.facet.token).benches.push(line);
      }
      if (cells.size) groups.push({ metric, cells: [...cells.values()] });
    }
    const total = groups.reduce((sum, group) => sum + group.cells.length, 0);
    // A chart page shows every chart its link matches, which are few.
    if (!charted && !page.link.allCharts && total > CHART_LIMIT) {
      let left = CHART_LIMIT;
      for (const group of groups) {
        group.cells = group.cells.slice(0, left);
        left -= group.cells.length;
      }
    }
    const shownGroups = groups.filter((group) => group.cells.length);
    const wanted = shownGroups.flatMap((group) => group.cells);

    for (const chart of charts) if (!wanted.some((cell) => cell.key === chart.key)) page.runtime.unmount(chart);
    charts = wanted.map((cell) => {
      const existing = charts.find((chart) => chart.key === cell.key && !chart.instance.isDisposed());
      if (existing) return Object.assign(existing, cell);
      const dom = h("div", { class: "chart", role: "img", "aria-label": `${cell.metric.label} ${cell.title} per run` });
      const note = h("span", { class: "note" });
      const title = h("span", { class: "title" });
      const readout = h("div", { class: "readout" });
      const card = h("article", { class: "chart-card" }, h("h3", {}, title, " ", note), dom, readout);
      return page.runtime.mount({ ...cell, card, dom, note, readout, titleNode: title });
    });

    container.classList.toggle("is-faceted", faceted);
    if (charts.length === 0) {
      container.replaceChildren(h("p", { class: "empty" }, "Nothing matches these filters."));
      return;
    }
    const allToggle =
      !charted && total > CHART_LIMIT
        ? h(
            "button",
            {
              type: "button",
              class: "option charts-more",
              onclick: () => page.dispatch({ type: "set", changes: { allCharts: !page.link.allCharts } }),
            },
            page.link.allCharts ? `Show the first ${CHART_LIMIT} charts` : `Show all ${total} charts`,
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
      renderTitle(chart, charted);
      chart.note.textContent = faceted ? "" : `${unitLabel}, ${directionText(chart.metric)}`;
      buildReadout(chart);
      chart.instance.setOption(option, { notMerge: true });
      chart.instance.resize();
    }
    const run = page.shownRun();
    if (run) updateReadouts(run);
  }

  // On the overview a chart's title links to its page.
  // On its own page the page head names a lone chart, so only its unit and direction remain.
  function renderTitle(chart, charted) {
    /** @type {import("../core/link.js").Route} */
    const route = { kind: "chart", chart: chartId(chart.metric, page.view.pivot.facet, chart.benches[0].dims) };
    chart.titleNode.replaceChildren(charted ? chart.title : page.anchor({ type: "open", route }, { class: "chart-link" }, chart.title));
    chart.titleNode.hidden = charted && charts.length === 1;
  }

  // Each chart carries a readout under its plot: one row per line with its value and change at the
  // hovered run, or the selected one, so the numbers sit next to the chart they belong to without an
  // overlay covering it.
  // It doubles as the chart's legend.
  // The spread and median columns exist only when expanded, since a fixed table layout keeps the
  // width of hidden columns.
  function buildReadout(chart) {
    const open = openReadouts.has(chart.key);
    const lines = open ? chart.benches : chart.benches.slice(0, READOUT_ROWS);
    // The spread column appears only for lines that record one.
    const spread = page.link.more && chart.benches.some((line) => line.points.some((i) => line.spread(i)));
    chart.readoutItems = lines.map((line) => {
      const cells = { value: h("td", { class: "readout-value" }), change: h("td"), spread: h("td"), median: h("td") };
      const row = h(
        "tr",
        {},
        h("td", { class: "readout-label", title: line.label }, lineKey(line.style), line.style.label),
        cells.value,
        cells.change,
        spread ? cells.spread : null,
        page.link.more ? cells.median : null,
      );
      return { line, cells, row };
    });
    const cols = [h("col"), h("col", { class: "num" }), h("col", { class: "num" })];
    if (spread) cols.push(h("col", { class: "num" }));
    if (page.link.more) cols.push(h("col", { class: "num" }));
    const head = page.link.more
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
                if (open) openReadouts.delete(chart.key);
                else openReadouts.add(chart.key);
                buildReadout(chart);
                page.showRun();
              },
            },
            open ? "Show fewer" : `Show ${rest} more`,
          )
        : null;
    chart.readout.replaceChildren(
      ...[
        h("table", { class: "readout-table" }, h("colgroup", {}, ...cols), head, h("tbody", {}, ...chart.readoutItems.map((item) => item.row))),
        toggle,
      ].filter(Boolean),
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
        if (page.link.more) {
          const base = line.detectionBaseline(run.index);
          const vsBase = value !== null && base ? relative(value, base) : null;
          cells.spread.textContent = line.spread(run.index) ?? "–";
          cells.median.replaceChildren(changeElement(vsBase, judge(chart.metric, vsBase, page.config.threshold)));
        }
      }
    }
  }

  // A chart page always shows its charts.
  function currentLayout() {
    if (page.link.route.kind === "chart") return "charts";
    if (page.link.layout !== "auto") return page.link.layout;
    return page.view.lines.length > MOVERS_FROM ? "movers" : "charts";
  }

  // The switch between charts and the movers table, shown once there are enough lines to need it.
  function renderLayoutSwitch() {
    const bar = document.getElementById("layout");
    bar.hidden = page.link.route.kind === "chart" || page.view.lines.length <= 8;
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
              if (option.key !== current) page.dispatch({ type: "set", changes: { layout: /** @type {"charts" | "movers"} */ (option.key) } });
            },
          },
          option.label,
        ),
      ),
      h("span", { class: "layout-count" }, `${page.view.lines.length} lines`),
    );
  }

  // Movers: every visible line ranked by its net change across the window in view, worst first,
  // with a sparkline.
  // Choosing a row narrows the filters to that line's chart and switches to charts.
  function renderMovers(container) {
    const { first, last } = page.zoomWindow();
    const runs = page.view.runs.slice(first, last + 1);
    const ordered = rankMovers(page.view.lines, runs, page.config.threshold);

    const multipleMetrics = page.view.metrics.length > 1;
    const body = ordered.slice(0, moversShown).map((row) =>
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
      ordered.length > moversShown
        ? h(
            "button",
            {
              type: "button",
              class: "more",
              onclick: () => {
                moversShown += MOVERS_PAGE;
                renderCharts();
              },
            },
            `Show ${Math.min(MOVERS_PAGE, ordered.length - moversShown)} more`,
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
    const dimensions = new Map(page.view.pivot.facet.map((key) => [key, only([urlText(line.dims[key])])]));
    page.dispatch({ type: "focus", metrics: page.view.metrics.length > 1 ? only([line.metric.slug]) : null, dimensions });
    document.querySelector(".charts-area")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function directionText(metric) {
    if (metric.direction === "higher") return "higher is better";
    if (metric.direction === "lower") return "lower is better";
    return "direction unknown";
  }

  function groupUnitLabel(shared, group) {
    if (page.link.scale === "change") return `% since ${formatDate(page.view.runs[0].date)}`;
    return displayUnit(group.metric.unit, groupMagnitude(shared, group)).label || "value";
  }

  // Moves the selected run's marker on every chart.
  function markSelection(shared) {
    const marker = markers(shared, { selection: page.view.selected !== page.view.runs.length - 1 });
    for (const chart of charts) chart.instance.setOption({ series: [{ id: chart.benches[0].key, markLine: marker }] });
  }

  // A new suite, section, or page starts its movers table at the first page.
  function reset() {
    moversShown = MOVERS_PAGE;
  }

  // A history entry keeps how many rows its movers table showed.
  function snapshot() {
    return moversShown;
  }

  /** @param {unknown} saved */
  function restore(saved) {
    if (typeof saved === "number" && Number.isFinite(saved)) moversShown = Math.max(MOVERS_PAGE, saved);
  }

  // A page without charts releases them, with everything their instances hold.
  function leave() {
    for (const chart of charts) page.runtime.unmount(chart);
    charts = [];
    document.getElementById("charts").replaceChildren();
  }

  // Redraws the movers table alone, when it is the layout, as after the zoom window settles.
  function refreshMovers() {
    if (currentLayout() === "movers") renderMovers(document.getElementById("charts"));
  }

  return { roots: ["layout", "charts"], render: renderCharts, updateReadouts, refreshMovers, markSelection, reset, leave, snapshot, restore };
}
