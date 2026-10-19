// The ECharts options for the page's charts, built from the view and the plot settings alone, so
// every chart is described by data and the chart runtime only applies it.

import { median, relative } from "./detect.js";
import { displayUnit, formatDate, formatTick, timeFormat } from "./format.js";

/** @typedef {import("./view.js").Line} Line */
/** @typedef {import("./view.js").View} View */
/** @typedef {import("./history.js").Metric} Metric */
/** @typedef {import("./history.js").Run} Run */

/**
 * The page's colors and font, as read from its style.
 * @typedef {object} Theme
 * @property {string} bg
 * @property {string} ink
 * @property {string} ink2
 * @property {string} muted
 * @property {string} grid
 * @property {string} axis
 * @property {string} rule
 * @property {string} accent
 * @property {string} worse
 * @property {string} better
 * @property {string} noise
 * @property {string} font
 * @property {string[]} series
 */

/**
 * What every chart of one view shares.
 * `zoom` is the zoom window in percent of the x axis when the options are built, while `window`
 * answers for the zoom at the moment it is asked, since ECharts lays out axis labels again on
 * every zoom without new options.
 * @typedef {object} Plot
 * @property {View} view
 * @property {import("./link.js").AxisKey} axis
 * @property {import("./link.js").ScaleKey} scale
 * @property {number} smoothing the rolling median window, in runs, or 0
 * @property {{ start: number, end: number }} zoom
 * @property {() => { first: number, last: number }} window the positions of the first and last run in the zoom window
 * @property {Theme} theme
 * @property {Map<string, { key: string, values: Array<number | null> }>} smoothCache smoothed values by line, kept across renders
 */

const LOG_SPAN = 20;

// Each run gets a bar up for its regressions and a bar down for its improvements, sized by the
// square root of how many lines shifted, so one shift is plainly visible and a broad one stands
// taller without dwarfing it.
// Moves of unknown direction stack on top of the regressions, splitting the bar in proportion to
// their counts, so the stack stays as tall as the square root of their sum.
// A run without any shift gets a short neutral tick, so the trail still shows every run.
/**
 * @param {Plot} plot
 * @param {number} width the trail's width in pixels
 */
export function trailOption(plot, width) {
  const t = plot.theme;
  const byDate = plot.axis === "date";
  const counts = plot.view.runs.map((run) => plot.view.counts(run));
  const reach = Math.max(1, ...counts.map(({ worse, better, moved }) => Math.sqrt(Math.max(worse + moved, better))));
  const point = (/** @type {Run} */ run, /** @type {number | null} */ y) => (byDate ? [run.date, y] : y);
  const up = (/** @type {number} */ count, /** @type {import("./view.js").Counts} */ { worse, moved }) =>
    count ? (Math.sqrt(worse + moved) * count) / (worse + moved) : null;
  const bar = (/** @type {string} */ color, opacity = 1) => ({
    type: "bar",
    stack: "trail",
    barCategoryGap: "30%",
    barMaxWidth: 6,
    itemStyle: { color, opacity },
    silent: true,
  });
  return {
    animation: false,
    textStyle: { fontFamily: t.font, color: t.muted },
    grid: { left: 0, right: 0, top: 14, bottom: 44 },
    xAxis: xAxis(plot, { line: false, width }),
    yAxis: { type: "value", min: -reach, max: reach, show: false },
    tooltip: crosshair(t),
    dataZoom: dataZoom(plot, true),
    series: [
      {
        ...bar(t.worse),
        id: "trail",
        data: plot.view.runs.map((run, j) => point(run, up(counts[j].worse, counts[j]))),
        markLine: markers(plot, { labels: true }),
      },
      { ...bar(t.better), id: "trail-better", data: plot.view.runs.map((run, j) => point(run, counts[j].better ? -Math.sqrt(counts[j].better) : null)) },
      { ...bar(t.axis), id: "trail-moved", data: plot.view.runs.map((run, j) => point(run, up(counts[j].moved, counts[j]))) },
      {
        ...bar(t.noise),
        id: "trail-runs",
        data: plot.view.runs.map((run, j) => point(run, counts[j].worse || counts[j].better || counts[j].moved || !counts[j].measured ? null : reach * 0.12)),
      },
    ],
  };
}

// Smoothed values are cached per line for the inputs they depend on, so a render that changes
// nothing about a line, such as toggling another filter, does not smooth it again.
/**
 * @param {Plot} plot
 * @param {Line} line
 * @param {Array<number | null>} ys
 * @param {number} factor
 * @param {number | null | undefined} base
 */
function smoothedCached(plot, line, ys, factor, base) {
  const key = `${plot.smoothing}|${plot.scale}|${plot.view.offset}|${plot.view.runs.length}|${factor}|${base}`;
  const cached = plot.smoothCache.get(line.key);
  if (cached?.key === key) return cached.values;
  const values = smoothed(plot.view.runs, line, ys, plot.smoothing);
  plot.smoothCache.set(line.key, { key, values });
  return values;
}

// A centered rolling median over `window` runs, within each comparison segment.
// A median drops one-off outliers, such as a slow runner, yet keeps a real step sharp at the run
// where it happened, where an average would smear it across the window.
/**
 * @param {readonly Run[]} runs
 * @param {Line} line
 * @param {Array<number | null>} ys
 * @param {number} window
 * @returns {Array<number | null>}
 */
function smoothed(runs, line, ys, window) {
  const half = (window - 1) >> 1;
  const segment = (/** @type {number} */ j) => line.segment(runs[j].index);
  return ys.map((y, j) => {
    if (y === null) return null;
    /** @type {number[]} */
    const near = [];
    for (let k = Math.max(0, j - half); k <= Math.min(ys.length - 1, j + half); k += 1) {
      const neighbour = ys[k];
      if (neighbour !== null && segment(k) === segment(j)) near.push(neighbour);
    }
    return median(near);
  });
}

/**
 * A metric's charts when dimensions split them, which share one display unit.
 * @typedef {{ metric: Metric, cells: Array<{ benches: Line[] }>, magnitude?: number }} ChartGroup
 */

/**
 * @param {Plot} plot
 * @param {ChartGroup} group
 */
export function groupMagnitude(plot, group) {
  if (group.magnitude !== undefined) return group.magnitude;
  let magnitude = 0;
  for (const cell of group.cells) {
    for (const line of cell.benches) for (const run of plot.view.runs) magnitude = Math.max(magnitude, Math.abs(line.value(run.index) ?? 0));
  }
  // Computed once per group and render, since the heading and every chart of the group ask.
  group.magnitude = magnitude;
  return magnitude;
}

/**
 * @param {Plot} plot
 * @param {Metric} metric
 * @param {readonly Line[]} benches
 * @param {boolean} compact whether the chart is one of several small ones
 * @param {number | null} [sharedMagnitude] the magnitude that picks the display unit, shared by sibling charts
 * @param {number} [width] the chart's width in pixels
 */
export function lineOption(plot, metric, benches, compact, sharedMagnitude = null, width = 0) {
  const t = plot.theme;
  const byDate = plot.axis === "date";
  const asChange = plot.scale === "change";
  let magnitude = 0;
  let smallest = Infinity;
  for (const bench of benches) {
    for (const run of plot.view.runs) {
      const value = bench.value(run.index);
      if (value === null) continue;
      magnitude = Math.max(magnitude, Math.abs(value));
      smallest = Math.min(smallest, value);
    }
  }
  const unit = displayUnit(metric.unit, sharedMagnitude ?? magnitude);
  // Lines more than LOG_SPAN apart share a log axis, so a small line's steps stay as visible as a
  // large one's instead of lying flat along the bottom.
  const log = !asChange && smallest > 0 && magnitude / smallest > LOG_SPAN;
  const unitLabel = asChange ? `% since ${formatDate(plot.view.runs[0].date)}` : `${unit.label || "value"}${log ? ", log scale" : ""}`;

  /** @type {object[]} */
  const series = [];
  /** @type {Array<Array<number | null>>} */
  const plotted = [];
  for (const [i, bench] of benches.entries()) {
    const color = t.series[bench.style.slot];
    const base = plot.view.firstValues.get(bench.key);
    const ys = plot.view.runs.map((run) => {
      const value = bench.value(run.index);
      if (value === null) return null;
      return asChange ? (base ? relative(value, base) * 100 : null) : value * unit.factor;
    });
    const shown = plot.smoothing ? smoothedCached(plot, bench, ys, unit.factor, base) : ys;
    plotted.push(ys, shown);
    const points = shown.map((y, j) => (byDate ? [plot.view.runs[j].date, y] : y));
    // With smoothing on, the recorded values stay visible as faint dots behind the trend.
    if (plot.smoothing) {
      series.push({
        id: `${bench.key}\u0004raw`,
        type: "scatter",
        data: ys.map((y, j) => (byDate ? [plot.view.runs[j].date, y] : y)),
        symbolSize: 3,
        itemStyle: { color, opacity: 0.35 },
        silent: true,
        z: 1,
      });
    }
    series.push({
      id: bench.key,
      name: bench.style.label,
      type: "line",
      data: points,
      connectNulls: false,
      symbol: "circle",
      symbolSize: 7,
      showSymbol: plot.view.runs.length <= 40,
      sampling: plot.view.runs.length > 800 ? "lttb" : undefined,
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
      markLine: i === 0 ? markers(plot, { selection: plot.view.selected !== plot.view.runs.length - 1 }) : undefined,
    });
  }

  const range = yRange(plot.window(), plotted, log);
  // The tick step changes with every zoom, so labels read it from this object, which the zoom sync
  // updates, rather than from the value captured here.
  const scale = { interval: range.interval };
  const option = {
    animation: false,
    textStyle: { fontFamily: t.font, color: t.muted },
    grid: { left: 0, right: 8, top: 12, bottom: 26, containLabel: true },
    xAxis: xAxis(plot, { line: true, width }),
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
        formatter: asChange
          ? (/** @type {number} */ v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Number(v.toFixed(1)))}%`
          : (/** @type {number} */ v) => formatTick(v, scale.interval),
      },
      splitLine: { lineStyle: { color: t.grid, width: 1 } },
    },
    tooltip: crosshair(t),
    dataZoom: dataZoom(plot, false),
    series,
  };
  return { option, unitLabel, plotted, log, scale };
}

// The value axis range for the runs inside the zoom window, rounded to a readable step, so zooming
// in magnifies the lines instead of keeping the whole history's range.
/**
 * @param {{ first: number, last: number }} window the positions of the first and last run in the zoom window
 * @param {ReadonlyArray<ReadonlyArray<number | null | undefined>>} plotted
 * @param {boolean} log
 * @returns {{ min: number | null, max: number | null, interval: number | null }}
 */
export function yRange({ first, last }, plotted, log) {
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
/**
 * @param {number} x
 * @param {(x: number) => number} round
 */
function niceBound(x, round) {
  const power = 10 ** Math.floor(Math.log10(x));
  const steps = round === Math.floor ? [5, 2, 1] : [1, 2, 5, 10];
  const fraction = x / power;
  const pick = round === Math.floor ? steps.find((m) => m <= fraction) : steps.find((m) => m >= fraction);
  return (pick ?? 1) * power;
}

/** @param {number} x */
function niceStep(x) {
  const power = 10 ** Math.floor(Math.log10(x));
  const fraction = x / power;
  return (fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10) * power;
}

/** @param {Theme} t */
function crosshair(t) {
  return {
    trigger: "axis",
    showContent: false,
    axisPointer: { type: "line", lineStyle: { color: t.axis, width: 1, type: "solid" }, label: { show: false } },
  };
}

/**
 * @param {Plot} plot
 * @param {{ line: boolean, width: number }} options
 */
function xAxis(plot, { line, width }) {
  const t = plot.theme;
  const label = { color: t.muted, fontSize: 11, hideOverlap: true };
  if (plot.axis === "date") {
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
    data: plot.view.runs.map((run) => `r${run.index}`),
    boundaryGap: !line,
    axisLine: { show: line, onZero: !line, lineStyle: { color: t.rule } },
    axisTick: { show: false },
    // The first and last labels align inward, so they never run past the plot's edges, and any
    // labels that still collide at a narrow width are hidden.
    axisLabel: { ...label, alignMinLabel: "left", alignMaxLabel: "right", ...runLabels(plot, width) },
    splitLine: { show: false },
  };
}

// Labels for the run axis: every k-th run of the zoom window, with k chosen so about one label fits
// per LABEL_SPACING pixels, so labels sit evenly across the plot whatever the run times are.
// Labels name the day, or the time of day when they fall less than a day apart, with the day
// shown where it changes; both callbacks read the zoom when ECharts lays out the axis, so the
// labels follow every zoom without rebuilding the chart.
const LABEL_SPACING = 96;

/**
 * @param {Plot} plot
 * @param {number} width
 */
function runLabels(plot, width) {
  /** @type {{ range: { first: number, last: number }, first: number, last: number, step: number, byTime: boolean } | null} */
  let memo = null;
  const window = () => {
    const range = plot.window();
    if (memo?.range === range) return memo;
    const { first, last } = range;
    const target = Math.max(2, Math.min(10, Math.floor((width || 600) / LABEL_SPACING)));
    const step = Math.max(1, Math.ceil((last - first + 1) / target));
    const span = (plot.view.runs[last]?.date ?? 0) - (plot.view.runs[first]?.date ?? 0);
    memo = { range, first, last, step, byTime: span / target < 86_400_000 };
    return memo;
  };
  return {
    interval: (/** @type {number} */ j) => {
      const { first, last, step } = window();
      return j >= first && j <= last && (j - first) % step === 0;
    },
    // The formatter is given the label's position among the shown labels, not the run's, so the
    // run comes from the category value, which names its run index.
    formatter: (/** @type {string} */ value) => {
      const j = Number(String(value).slice(1)) - plot.view.offset;
      const { first, step, byTime } = window();
      const date = plot.view.runs[j]?.date;
      if (!byTime) return formatDate(date);
      const previous = plot.view.runs[j - step]?.date;
      return j === first || formatDate(previous) !== formatDate(date) ? formatDate(date) : timeFormat.format(date);
    },
  };
}

/**
 * @param {Plot} plot
 * @param {boolean} slider
 */
function dataZoom(plot, slider) {
  const t = plot.theme;
  const { start, end } = plot.zoom;
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
/**
 * @param {Plot} plot
 * @param {{ labels?: boolean, selection?: boolean }} [options]
 */
export function markers(plot, { labels = false, selection = true } = {}) {
  const t = plot.theme;
  const x = (/** @type {Run} */ run) => (plot.axis === "date" ? run.date : `r${run.index}`);
  const rules = plot.view.runs
    .filter((run) => plot.view.boundaries.has(run.index))
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
            formatter: () => boundaryLabel(plot.view.boundaries.get(run.index) ?? []),
          }
        : { show: false },
    }));
  /** @type {object[]} */
  const all = rules;
  const run = plot.view.runs[plot.view.selected];
  if (run && selection) all.push({ xAxis: x(run), lineStyle: { color: t.ink2, width: 1, type: "solid", opacity: 0.6 } });
  return { symbol: ["none", "none"], silent: true, animation: false, label: { show: false }, data: all };
}

// The new values a boundary changed to, e.g. `rustc 1.97.0` for `rustc 1.96.0 → 1.97.0`.
/** @param {string[]} changes */
function boundaryLabel(changes) {
  const text = changes.map((change) => change.replace(/^(\S+) .* → /, "$1 ")).join(", ");
  return text.length > 32 ? `${text.slice(0, 31)}…` : text;
}

/**
 * @param {string} color
 * @param {number} alpha
 */
function withAlpha(color, alpha) {
  const match = /^#([0-9a-f]{6})$/i.exec(color);
  if (!match) return color;
  const n = parseInt(match[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}
