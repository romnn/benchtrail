// benchtrail renders a github-action-benchmark history (`window.BENCHMARK_DATA`) as a dashboard.
// It needs no build step: ECharts comes from the CDN script tag in index.html, and everything else
// is in this module.

const echarts = window.echarts;
const GROUP = "benchtrail";
const PAGE_SIZE = 30;
const MEDIAN_WINDOW = 10;
const SLOTS = 8;

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

const config = readConfig();
const state = {
  suite: null,
  range: "all",
  scale: "absolute",
  axis: "run",
  hiddenMetrics: new Set(),
  hiddenSeries: new Set(),
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
};

let data = null;
let suites = [];
let suite = null;
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
  if (suites.length === 0) {
    showProblem("No runs recorded yet", "The history file has no benchmark results. They appear after github-action-benchmark records its first run.");
    return;
  }

  readUrl();
  suite = suites.find((s) => s.name === state.suite) ?? suites[0];
  state.suite = suite.name;
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
  let split = /^(?<series>\S+)\s+(?<metric>.+)$/;
  try {
    if (raw.split) split = new RegExp(raw.split);
  } catch (error) {
    console.warn("benchtrail: ignoring the split pattern because it is not a valid regex", error);
  }
  return {
    title: raw.title ?? null,
    // The history is loaded as a script, so a URL from the query string must stay on this origin;
    // otherwise any link to the page could run foreign code on it.
    dataUrl: fromQuery && sameOrigin(fromQuery) ? fromQuery : raw.dataUrl ?? "data.js",
    threshold: Number.isFinite(Number(raw.threshold)) ? Number(raw.threshold) : 0.05,
    labels: raw.labels ?? {},
    split,
  };
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

// Model

function buildSuite(name, rawRuns) {
  const runs = rawRuns.map((raw, index) => normalizeRun(raw, index));

  // Benchmarks in order of first appearance, which also fixes each series' color slot.
  const benches = new Map();
  for (const [index, raw] of rawRuns.entries()) {
    for (const entry of raw.benches ?? []) {
      const unit = entry.unit ?? "";
      // A benchmark whose unit changes within one family (s to ms) is rescaled into its first
      // unit; a change across families starts a separate history rather than a false jump.
      let bench = benches.get(entry.name);
      let scale = 1;
      if (bench && bench.unit !== unit) {
        const from = parseUnit(unit);
        const to = parseUnit(bench.unit);
        if (from && to && from.family === to.family && from.tail === to.tail) scale = from.size / to.size;
        else bench = benches.get(`${entry.name}\u0000${unit}`);
      }
      if (!bench) {
        const parts = splitName(entry.name);
        bench = {
          name: benches.has(entry.name) ? `${entry.name}\u0000${unit}` : entry.name,
          seriesId: parts.series,
          metricName: parts.metric,
          unit,
          values: new Array(runs.length).fill(null),
          ranges: new Array(runs.length).fill(null),
          extras: new Array(runs.length).fill(null),
          change: new Array(runs.length).fill(null),
        };
        benches.set(bench.name, bench);
      }
      // Only numbers count; Number() would turn null, "" and false into a real zero.
      const value = typeof entry.value === "string" && entry.value.trim() !== "" ? Number(entry.value) : entry.value;
      if (typeof value === "number" && Number.isFinite(value)) bench.values[index] = value * scale;
      bench.ranges[index] = entry.range ?? null;
      bench.extras[index] = entry.extra ?? null;
    }
  }

  // Metrics are keyed by name and unit, so one name measured in two units never shares an axis.
  const metrics = new Map();
  for (const bench of benches.values()) {
    bench.metricId = `${bench.metricName ?? ""}|${bench.unit}`;
    if (!metrics.has(bench.metricId)) {
      metrics.set(bench.metricId, {
        id: bench.metricId,
        name: bench.metricName,
        unit: bench.unit,
        label: metricLabel(bench.metricName, bench.unit),
        biggerIsBetter: BIGGER_IS_BETTER.has(rawRuns.at(-1)?.tool),
      });
    }
  }
  const labelCounts = countBy([...metrics.values()], (m) => m.label);
  for (const metric of metrics.values()) {
    if (labelCounts.get(metric.label) > 1) metric.label = `${metric.label} (${metric.unit})`;
  }

  const seriesIds = unique([...benches.values()].map((b) => b.seriesId));
  const { labels, context } = stripSharedAffixes(seriesIds);
  const series = new Map(
    seriesIds.map((id, i) => [id, { id, label: labels[i], slot: i % SLOTS, dashed: i >= SLOTS }]),
  );

  // Relative change against the previous run that measured the same benchmark.
  for (const bench of benches.values()) {
    let previous = null;
    for (let i = 0; i < runs.length; i += 1) {
      const value = bench.values[i];
      if (value === null) continue;
      if (previous !== null && previous !== 0) bench.change[i] = value / previous - 1;
      previous = value;
    }
  }

  // Runs are named by short commit SHA, with a suffix for re-runs of the same commit, so a link
  // can name each one.
  const seen = new Map();
  for (const run of runs) {
    const count = seen.get(run.short) ?? 0;
    seen.set(run.short, count + 1);
    run.key = count === 0 ? run.short : `${run.short}~${count + 1}`;
  }

  return { name, runs, benches: [...benches.values()], metrics, series, context };
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

function splitName(name) {
  const groups = config.split.exec(name)?.groups;
  if (groups?.series && groups?.metric) return { series: groups.series, metric: groups.metric.trim() };
  return { series: name, metric: null };
}

function metricLabel(name, unit) {
  if (name && config.labels[name]) return config.labels[name];
  if (!name) {
    const family = parseUnit(unit)?.family;
    return family ? FAMILY_LABELS[family] : unit || "Value";
  }
  const words = name.replace(/\b(cpu|rss|gc|io|ram|ipc|gpu)\b/gi, (word) => word.toUpperCase());
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// Drops a prefix and suffix that every series shares, cut at a delimiter, so `okta.hand-written`
// and `oxide.hand-written` read as `okta` and `oxide`. The shared part becomes context text.
function stripSharedAffixes(ids) {
  const delimiter = /[./:_\-\s]/;
  if (ids.length < 2) return { labels: ids, context: "" };

  let prefix = ids.reduce((common, id) => {
    let i = 0;
    while (i < common.length && common[i] === id[i]) i += 1;
    return common.slice(0, i);
  });
  let end = prefix.length;
  while (end > 0 && !delimiter.test(prefix[end - 1])) end -= 1;
  prefix = prefix.slice(0, end);

  let suffix = ids.reduce((common, id) => {
    let i = 0;
    while (i < common.length && common[common.length - 1 - i] === id[id.length - 1 - i]) i += 1;
    return common.slice(common.length - i);
  });
  let start = 0;
  while (start < suffix.length && !delimiter.test(suffix[start])) start += 1;
  suffix = suffix.slice(start);

  const labels = ids.map((id) => id.slice(prefix.length, id.length - suffix.length));
  if (labels.some((label) => label.length === 0) || new Set(labels).size !== ids.length) {
    return { labels: ids, context: "" };
  }
  const trim = (text) => text.replace(/^[./:_\-\s]+|[./:_\-\s]+$/g, "");
  const context = [trim(prefix), trim(suffix)].filter(Boolean).join(" ");
  return { labels, context };
}

// View: the slice of the suite that the filters select

function computeView() {
  const range = RANGES.find((r) => r.key === state.range) ?? RANGES.at(-1);
  const offset = Math.max(0, suite.runs.length - range.count);
  const runs = suite.runs.slice(offset);
  const benches = suite.benches.filter(
    (b) => !state.hiddenMetrics.has(b.metricId) && !state.hiddenSeries.has(b.seriesId),
  );
  const metrics = [...suite.metrics.values()].filter((m) => !state.hiddenMetrics.has(m.id));

  // The first value in the range is the baseline for the change view.
  const baseline = new Map();
  for (const bench of suite.benches) {
    baseline.set(bench.name, runs.map((run) => bench.values[run.index]).find((v) => v !== null && v !== 0) ?? null);
  }

  let selected = runs.findIndex((run) => state.run && run.key === state.run);
  if (selected < 0) selected = runs.length - 1;
  view = { runs, offset, benches, metrics, baseline, selected };
}

function badness(metric, change) {
  if (change === null) return null;
  return metric.biggerIsBetter ? -change : change;
}

function verdict(metric, change) {
  const bad = badness(metric, change);
  if (bad === null) return "none";
  if (bad > config.threshold) return "worse";
  if (bad < -config.threshold) return "better";
  return "noise";
}

// The trail bar for a run is its largest regression when it has one, otherwise its largest
// improvement; both are signed so that regressions point up.
function runScore(runIndex) {
  let worst = 0;
  let best = 0;
  for (const bench of view.benches) {
    const bad = badness(suite.metrics.get(bench.metricId), bench.change[runIndex]);
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
  renderTrail();
  renderCharts();
  renderSelected();
  renderHistory();
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
  nav.setAttribute("role", "tablist");
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
          state.hiddenMetrics.clear();
          state.hiddenSeries.clear();
          state.run = null;
          state.zoom = null;
          render();
        },
      }, s.name),
    ),
  );
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

  const metrics = [...suite.metrics.values()];
  document.getElementById("metrics").hidden = metrics.length < 2;
  document.getElementById("metrics").replaceChildren(
    ...metrics.map((metric) => toggleChip(metric.label, !state.hiddenMetrics.has(metric.id), null, () => toggle(state.hiddenMetrics, metric.id))),
  );

  const series = [...suite.series.values()];
  document.getElementById("series").hidden = series.length < 2;
  document.getElementById("series").replaceChildren(
    ...series.map((s) => toggleChip(s.label, !state.hiddenSeries.has(s.id), s, () => toggle(state.hiddenSeries, s.id))),
  );
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

function toggleChip(label, pressed, series, onClick) {
  const children = series ? [lineKey(series), label] : [label];
  return h("button", { type: "button", class: "option", "aria-pressed": String(pressed), onclick: onClick }, ...children);
}

function lineKey(series) {
  return h("span", {
    class: series.dashed ? "line-key dashed" : "line-key",
    style: `--key: var(--s${series.slot + 1})`,
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
        markLine: selectionMarker(t),
      },
    ],
  };
}

// Metric charts

// Charts are updated in place and only created or removed when the set of metrics changes, so
// changing a filter never tears the page down and rebuilds it.
function renderCharts() {
  const container = document.getElementById("charts");
  const t = theme();
  const wanted = view.metrics
    .map((metric) => ({ metric, benches: view.benches.filter((b) => b.metricId === metric.id) }))
    .filter(({ benches }) => benches.length > 0);

  for (const chart of charts) {
    if (!wanted.some(({ metric }) => metric.id === chart.metric.id)) {
      chart.observer.disconnect();
      chart.instance.dispose();
    }
  }
  charts = wanted.map(({ metric, benches }) => {
    const existing = charts.find((chart) => chart.metric.id === metric.id && !chart.instance.isDisposed());
    if (existing) return Object.assign(existing, { metric, benches });
    const dom = h("div", { class: "chart", role: "img", "aria-label": `${metric.label} per run` });
    const note = h("span", { class: "note" });
    const card = h("article", { class: "chart-card" }, h("h2", {}, h("span", { class: "title" }), " ", note), dom);
    const instance = createChart(dom);
    return { metric, benches, card, dom, note, instance, observer: instance.observer };
  });

  if (charts.length === 0) {
    container.replaceChildren(h("p", { class: "empty" }, "Select at least one metric and one series."));
    return;
  }
  container.replaceChildren(...charts.map((chart) => chart.card));
  for (const chart of charts) {
    const { option, note } = lineOption(chart.metric, chart.benches, t);
    chart.card.querySelector(".title").textContent = chart.metric.label;
    chart.note.textContent = note;
    chart.instance.setOption(option, { notMerge: true });
    chart.instance.resize();
  }
}

function lineOption(metric, benches, t) {
  const byDate = state.axis === "date";
  const asChange = state.scale === "change";
  let magnitude = 0;
  for (const bench of benches) {
    for (const run of view.runs) magnitude = Math.max(magnitude, Math.abs(bench.values[run.index] ?? 0));
  }
  const unit = displayUnit(metric.unit, magnitude);
  const direction = metric.biggerIsBetter ? "higher is better" : "lower is better";
  const note = `${asChange ? `% since ${formatDate(view.runs[0].date)}` : unit.label}, ${direction}`;
  const labelled = benches.length <= 4;

  const series = benches.map((bench, i) => {
    const s = suite.series.get(bench.seriesId);
    const color = t.series[s.slot];
    const base = view.baseline.get(bench.name);
    const points = view.runs.map((run) => {
      const value = bench.values[run.index];
      let y = null;
      if (value !== null) y = asChange ? (base ? (value / base - 1) * 100 : null) : value * unit.factor;
      return byDate ? [run.date, y] : y;
    });
    return {
      id: bench.name,
      name: s.label,
      type: "line",
      data: points,
      connectNulls: false,
      symbol: "circle",
      symbolSize: 7,
      showSymbol: view.runs.length <= 40,
      sampling: view.runs.length > 800 ? "lttb" : undefined,
      lineStyle: { width: 1.75, color, type: s.dashed ? "dashed" : "solid", cap: "round", join: "round" },
      itemStyle: { color, borderColor: t.bg, borderWidth: 2 },
      emphasis: { disabled: true },
      endLabel: { show: labelled, formatter: () => s.label, color: t.ink2, fontSize: 12, distance: 8 },
      labelLayout: { hideOverlap: true },
      markLine: i === 0 ? selectionMarker(t) : undefined,
    };
  });

  const option = {
    animation: false,
    textStyle: { fontFamily: t.font, color: t.muted },
    grid: { left: 0, right: labelled ? 84 : 8, top: 12, bottom: 26, containLabel: true },
    xAxis: xAxis(t, { line: true }),
    yAxis: {
      type: "value",
      scale: asChange,
      splitNumber: 4,
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
  return { option, note };
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

function selectionMarker(t) {
  const run = view.runs[view.selected];
  if (!run) return undefined;
  return {
    symbol: ["none", "none"],
    silent: true,
    animation: false,
    label: { show: false },
    lineStyle: { color: t.ink2, width: 1, type: "solid", opacity: 0.6 },
    data: [{ xAxis: state.axis === "date" ? run.date : `r${run.index}` }],
  };
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
  const marker = selectionMarker(theme());
  trail?.setOption({ series: [{ id: "trail", markLine: marker }] });
  for (const chart of charts) {
    chart.instance.setOption({ series: [{ id: chart.benches[0].name, markLine: marker }] });
  }
  renderSelected();
  markHistorySelection();
  writeUrl();
}

// The details panel keeps one shape for every run: a fixed head, a two-line subject, and one row
// per benchmark, so hovering along the trail changes numbers without moving the layout.
function renderSelected() {
  const section = document.getElementById("selected");
  const shown = hovered !== null && view.runs[hovered] ? hovered : view.selected;
  const run = view.runs[shown];
  if (!run) {
    section.replaceChildren();
    return;
  }
  const extras = unique(view.benches.map((b) => b.extras[run.index]).filter(Boolean));
  section.classList.toggle("is-preview", shown !== view.selected);
  section.classList.toggle("is-expanded", state.more);

  const head = h(
    "div",
    { class: "run-head" },
    h("button", { type: "button", class: "step", "aria-label": "Previous run", disabled: view.selected === 0, onclick: () => selectRun(view.selected - 1) }, "←"),
    h("button", { type: "button", class: "step", "aria-label": "Next run", disabled: view.selected === view.runs.length - 1, onclick: () => selectRun(view.selected + 1) }, "→"),
    run.url ? h("a", { class: "sha", href: run.url }, run.short) : h("span", { class: "sha" }, run.short),
    h("span", { class: "facts" }, `${run.author}, ${formatDateTime(run.date)}`),
  );
  const subject = h("p", { class: "run-subject", title: run.subject }, subjectElement(run));
  // The full message and environment are opt-in, behind the More toggle.
  const body = run.body ? h("p", { class: "run-body more-only" }, run.body) : null;
  const extra = extras.length === 1 ? h("p", { class: "run-extra more-only" }, extras[0]) : null;
  const more = h(
    "button",
    {
      type: "button",
      class: "more-toggle",
      "aria-expanded": String(state.more),
      onclick: () => {
        state.more = !state.more;
        renderSelected();
        writeUrl();
      },
    },
    state.more ? "Less" : "More",
  );

  const rows = [];
  for (const metric of view.metrics) {
    const benches = view.benches.filter((b) => b.metricId === metric.id);
    if (benches.length === 0) continue;
    if (view.metrics.length > 1) rows.push(h("tr", { class: "group" }, h("td", { colspan: "5" }, metric.label)));
    for (const bench of benches) {
      const s = suite.series.get(bench.seriesId);
      const value = bench.values[run.index];
      const change = bench.change[run.index];
      const median = medianBefore(bench, run.index);
      const vsMedian = value !== null && median ? value / median - 1 : null;
      rows.push(
        h(
          "tr",
          {},
          h("td", {}, lineKey(s), s.label),
          h("td", {}, value === null ? "–" : formatValue(value, bench.unit)),
          h("td", {}, changeElement(change, verdict(metric, change))),
          h("td", { class: "more-only" }, bench.ranges[run.index] ?? "–"),
          h("td", { class: "more-only" }, changeElement(vsMedian, verdict(metric, vsMedian))),
        ),
      );
    }
  }
  const table = h(
    "table",
    { class: "run-table" },
    h("colgroup", {}, h("col"), h("col", { class: "num" }), h("col", { class: "num" }), h("col", { class: "num more-only" }), h("col", { class: "num more-only" })),
    h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, ""),
        h("th", {}, "Value"),
        h("th", {}, "Change"),
        h("th", { class: "more-only" }, "Spread"),
        h("th", { class: "more-only" }, `vs median of ${MEDIAN_WINDOW}`),
      ),
    ),
    h("tbody", {}, ...rows),
  );
  section.replaceChildren(...[head, subject, body, extra, h("div", { class: "table-wrap" }, table), more].filter(Boolean));
}

// The subject as text, with a trailing pull-request reference such as `(#57)` linked to the PR.
function subjectElement(run) {
  const match = /^(.*?)\s*\(#(\d+)\)$/.exec(run.subject);
  const repo = safeUrl(data.repoUrl);
  if (!match || !repo || new URL(repo).hostname !== "github.com") return document.createTextNode(run.subject);
  const link = h("a", { href: `${repo.replace(/\/$/, "")}/pull/${match[2]}`, onclick: (event) => event.stopPropagation() }, `#${match[2]}`);
  return h("span", {}, `${match[1]} (`, link, ")");
}

function medianBefore(bench, runIndex) {
  const window = [];
  for (let i = runIndex - 1; i >= 0 && window.length < MEDIAN_WINDOW; i -= 1) {
    if (bench.values[i] !== null) window.push(bench.values[i]);
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
  const toggle = document.getElementById("list-toggle");
  toggle.textContent = open ? "Hide runs" : "Show runs";
  toggle.setAttribute("aria-expanded", String(open));
  if (!open) return;

  const table = document.getElementById("history-table");
  const query = state.query.trim().toLowerCase();
  const sortBench = state.sort && view.benches.find((b) => b.name === state.sort.bench);
  const sortMetric = sortBench && suite.metrics.get(sortBench.metricId);

  // The list follows the zoom window, so it always shows the runs the charts show.
  const zoom = zoomedRuns();
  const first = zoom ? view.runs.indexOf(zoom.from) : 0;
  const last = zoom ? view.runs.indexOf(zoom.to) : view.runs.length - 1;
  const significant = (run) =>
    view.benches.some((b) => ["worse", "better"].includes(verdict(suite.metrics.get(b.metricId), b.change[run.index])));
  let runs = view.runs
    .map((run, j) => ({ run, j }))
    .filter(({ j }) => j >= first && j <= last)
    .filter(({ run }) => !query || [run.id, run.message, run.author].some((field) => field.toLowerCase().includes(query)))
    .filter(({ run }) => !state.onlyChanges || significant(run));
  if (sortBench) {
    // Worst first sorts by regression size, best first by improvement size; runs without a
    // change for this benchmark go last either way.
    const sign = state.sort.order === "best" ? -1 : 1;
    const key = ({ run }) => badness(sortMetric, sortBench.change[run.index]);
    runs.sort((a, b) => (key(a) === null) - (key(b) === null) || sign * (key(b) - key(a)));
  } else {
    runs = runs.reverse();
  }

  const sortButton = (bench, label) => {
    const active = sortBench === bench;
    const marker = active ? (state.sort.order === "best" ? " ↑" : " ↓") : "";
    return h(
      "button",
      {
        type: "button",
        class: "option",
        "aria-pressed": String(active),
        title: "Sort by change: worst first, then best first, then by date",
        onclick: () => {
          if (!active) state.sort = { bench: bench.name, order: "worst" };
          else if (state.sort.order === "worst") state.sort = { bench: bench.name, order: "best" };
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

  const head = h(
    "thead",
    {},
    h(
      "tr",
      {},
      h("th", {}, `${runs.length} ${runs.length === 1 ? "run" : "runs"}`),
      ...view.benches.map((bench) => {
        const s = suite.series.get(bench.seriesId);
        const metric = suite.metrics.get(bench.metricId);
        const label = view.metrics.length > 1 ? `${s.label} ${metric.label}` : s.label;
        return h("th", {}, lineKey(s), sortButton(bench, label));
      }),
    ),
  );

  const body = h("tbody", {});
  for (const { run, j } of runs.slice(0, state.shown)) {
    const cells = view.benches.map((bench) => {
      const value = bench.values[run.index];
      const change = bench.change[run.index];
      return h(
        "td",
        {},
        value === null ? "–" : formatValue(value, bench.unit),
        changeElement(change, verdict(suite.metrics.get(bench.metricId), change)),
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
          subjectElement(run),
          h("span", { class: "row-meta" }, `${run.author}, ${formatDateTime(run.date)}`),
        ),
        ...cells,
      ),
    );
  }
  if (runs.length === 0) {
    body.append(h("tr", { class: "empty-row" }, h("td", { colspan: String(view.benches.length + 1) }, "No runs match.")));
  }
  table.replaceChildren(head, body);

  const more = document.getElementById("more");
  more.hidden = runs.length <= state.shown;
  more.textContent = `Show ${Math.min(PAGE_SIZE, runs.length - state.shown)} more`;
}

function markHistorySelection() {
  for (const row of document.querySelectorAll("#history-table tbody tr[data-view-index]")) {
    row.setAttribute("aria-selected", String(Number(row.dataset.viewIndex) === view.selected));
  }
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
  // Arrow keys step through runs unless a control has focus.
  document.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target.closest?.("input, textarea, select, [role='radio'], [role='tab']")) return;
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

const URL_KEYS = ["suite", "runs", "metrics", "series", "values", "x", "from", "to", "run", "more", "list", "q", "only", "sort", "order"];

function writeUrl() {
  const params = new URLSearchParams(location.search);
  for (const key of URL_KEYS) params.delete(key);
  if (suites.length > 1 && suite !== suites[0]) params.set("suite", state.suite);
  if (state.range !== "all") params.set("runs", state.range);
  // Visible sets rather than hidden ones, so a link names exactly what it shows.
  if (state.hiddenMetrics.size) params.set("metrics", [...suite.metrics.values()].filter((m) => !state.hiddenMetrics.has(m.id)).map((m) => m.label).join(","));
  if (state.hiddenSeries.size) params.set("series", [...suite.series.values()].filter((s) => !state.hiddenSeries.has(s.id)).map((s) => s.label).join(","));
  if (state.scale !== "absolute") params.set("values", state.scale);
  if (state.axis !== "run") params.set("x", state.axis);
  const zoom = zoomedRuns();
  if (zoom) {
    params.set("from", zoom.from.key);
    params.set("to", zoom.to.key);
  }
  const run = view.runs[view.selected];
  if (run && view.selected !== view.runs.length - 1) params.set("run", run.key);
  if (state.more) params.set("more", "1");
  if (state.list) {
    params.set("list", "1");
    if (state.query.trim()) params.set("q", state.query.trim());
    if (state.onlyChanges) params.set("only", "changes");
    if (state.sort) {
      params.set("sort", state.sort.bench);
      if (state.sort.order !== "worst") params.set("order", state.sort.order);
    }
  }
  // Slashes and commas are legal in a query, and leaving them unescaped keeps links readable.
  const query = params.toString().replace(/%2F/gi, "/").replace(/%2C/gi, ",");
  history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}`);
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.suite = params.get("suite");
  if (RANGES.some((r) => r.key === params.get("runs"))) state.range = params.get("runs");
  if (SCALES.some((s) => s.key === params.get("values"))) state.scale = params.get("values");
  if (AXES.some((a) => a.key === params.get("x"))) state.axis = params.get("x");
  state.run = params.get("run");
  state.more = params.get("more") === "1";
  state.list = params.get("list") === "1";
  // A link that changes a display option opens the options, so the reader sees why.
  state.options = ["runs", "values", "x"].some((key) => params.has(key));
  state.query = params.get("q") ?? "";
  state.onlyChanges = params.get("only") === "changes";
  if (params.get("sort")) state.sort = { bench: params.get("sort"), order: params.get("order") === "best" ? "best" : "worst" };
  state.pending = {
    metrics: params.get("metrics")?.split(","),
    series: params.get("series")?.split(","),
    from: params.get("from"),
    to: params.get("to"),
  };
}

// Applies the parts of the URL that name things inside a suite, once the suite is known.
function applyPendingUrl() {
  const pending = state.pending;
  state.pending = null;
  if (!pending) return;
  if (pending.metrics) {
    for (const metric of suite.metrics.values()) if (!pending.metrics.includes(metric.label)) state.hiddenMetrics.add(metric.id);
  }
  if (pending.series) {
    for (const series of suite.series.values()) if (!pending.series.includes(series.label)) state.hiddenSeries.add(series.id);
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
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return { text: "–", icon: "", label: "no earlier value" };
  const icon = kind === "worse" || kind === "better" ? (ratio > 0 ? "▲" : "▼") : "";
  const label = kind === "worse" ? "regression" : kind === "better" ? "improvement" : "within noise";
  return { text: `${formatSigned(ratio * 100)}%`, icon, label };
}

function changeElement(ratio, kind) {
  const { text, icon, label } = changeParts(ratio, kind);
  return h("span", { class: `change ${kind}`, title: label }, h("span", { class: "icon", "aria-hidden": "true" }, icon), text);
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
