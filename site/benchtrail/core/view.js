// The view: what a link selects from the data, resolved into the lines, runs, and styles the page
// draws.
// It reads the data only through lines, whose accessors answer for the runs their trace owns, so
// no part of the page can show one trace's observation as another's.

import { median, relative } from "./detect.js";
import { valueText } from "./history.js";
import { linkPart, token, unlinkPart, urlText } from "./identity.js";
import { admits, RANGES } from "./link.js";
import { compareOrder, unique } from "./list.js";

/** @typedef {import("./detect.js").Judgement} Judgement */
/** @typedef {import("./detect.js").Shift} Shift */
/** @typedef {import("./detect.js").ShiftKind} ShiftKind */
/** @typedef {import("./history.js").Dimension} Dimension */
/** @typedef {import("./history.js").Metric} Metric */
/** @typedef {import("./history.js").Run} Run */
/** @typedef {import("./history.js").Section} Section */
/** @typedef {import("./history.js").Suite} Suite */
/** @typedef {import("./history.js").Trace} Trace */
/** @typedef {import("./identity.js").Tags} Tags */
/** @typedef {import("./link.js").LinkState} LinkState */
/** @typedef {import("./link.js").RangeKey} RangeKey */
/** @typedef {import("./link.js").SectionRef} SectionRef */

// Distinct line colors, and the dashes that tell lines of one color apart.
export const SLOTS = 8;
export const DASHES = /** @type {const} */ (["solid", "dashed", "dotted"]);

/**
 * Which dimension colors the lines, which dashes them, and which split them into charts.
 * @typedef {{ color: string | null, dash: string | null, facet: string[] }} Pivot
 */

/**
 * How a line is drawn: its color slot and dash, by the position of its values in the color and
 * dash dimensions, and the label those values give it.
 * @typedef {object} LineStyle
 * @property {number} slot
 * @property {number} colorIndex
 * @property {number} dashIndex
 * @property {(typeof DASHES)[number]} dash
 * @property {string} label
 */

/**
 * The chart a line belongs to, by its values of the dimensions that split charts.
 * @typedef {{ token: string, label: string, order: number[] }} Facet
 */

/**
 * One trace of one benchmark as the page shows it.
 * Every accessor takes a run index and answers only for runs the trace owns, with null elsewhere.
 * `points` lists those runs within the view's range, in run order.
 * @typedef {object} Line
 * @property {string} key
 * @property {string} slug the line's id in links
 * @property {Metric} metric
 * @property {string} unit
 * @property {string} label
 * @property {Tags} dims
 * @property {readonly number[]} points
 * @property {LineStyle} style
 * @property {Facet} facet
 * @property {(i: number) => number | null} value
 * @property {(i: number) => number | null} change the change against the previous value in its segment
 * @property {(i: number) => Shift | null} shift
 * @property {(i: number) => number | null} detectionBaseline the median the run was judged against
 * @property {(i: number) => number | null} segment
 * @property {(i: number) => string[] | null} boundary what changed at the run that started a segment
 * @property {(i: number) => string | null} spread
 * @property {(i: number) => string | null} note
 * @property {(i: number) => Tags | null} environment
 * @property {(i: number) => Judgement} judgement
 */

/**
 * The chart a chart page shows, as its link names it: a metric by link id, and the link text of
 * its values of the dimensions that split charts.
 * @typedef {{ metric: string, dims: ReadonlyMap<string, string> }} ChartScope
 */

/**
 * A chart page's chart as the data resolves it, for its heading.
 * `metric` is null, and `dims` keep their link text, for names the data no longer has.
 * @typedef {object} ChartHeading
 * @property {Metric | null} metric
 * @property {Array<{ key: string, label: string, text: string }>} dims
 */

/** @typedef {{ worse: number, better: number, moved: number, measured: number }} Counts */
/** @typedef {{ line: Line, change: number, kind: ShiftKind, tentative: boolean }} Move */

/**
 * @typedef {object} View
 * @property {Suite} suite
 * @property {Section} section
 * @property {Run[]} runs the runs in range, oldest first
 * @property {number} offset the index of the first run in range among the suite's runs
 * @property {Line[]} lines
 * @property {Metric[]} metrics
 * @property {Pivot} pivot
 * @property {ChartHeading | null} chart the chart a chart page shows, or null on any other page
 * @property {number} selected the position of the selected run in `runs`
 * @property {Map<string, number | null>} firstValues by line key, the first value in range, which anchors the change scale
 * @property {Map<number, string[]>} boundaries by run index, what changed for the visible lines
 * @property {(run: Run) => Counts} counts how many visible lines were judged, and how many shifted, at a run
 * @property {(run: Run) => Move[]} moves the visible lines that shifted at a run, regressions first, then by size
 */

const NO_COUNTS = Object.freeze({ worse: 0, better: 0, moved: 0, measured: 0 });

// The facet token of a dimension that does not apply to a trace, which no value's token can equal.
const INAPPLICABLE = "\u0000inapplicable";

// Resolving a link

/**
 * The runs a range keeps, oldest first.
 * @param {Suite} suite
 * @param {RangeKey} rangeKey
 */
export function rangeRuns(suite, rangeKey) {
  const range = RANGES.find((r) => r.key === rangeKey) ?? RANGES[RANGES.length - 1];
  return suite.runs.slice(Math.max(0, suite.runs.length - range.count));
}

/**
 * The suite and section a link names, or the first ones in their place, and whether the link's
 * own were found.
 * The overview falls back to the first suite and section, while a chart page shows nothing in
 * another's place, since its chart belongs to the ones it names.
 * @typedef {{ suite: Suite, section: Section, found: boolean }} Target
 */

/**
 * @param {readonly Suite[]} suites
 * @param {LinkState} link
 * @returns {Target}
 */
function resolveTarget(suites, link) {
  const named = link.suite === null ? suites[0] : suites.find((s) => s.name === link.suite);
  const suite = named ?? suites[0];
  const section = findSection(suite, link.section);
  return { suite, section: section ?? suite.sections[0], found: named !== undefined && section !== null };
}

// A link names a section by its dimension keys, which stay put as runs are added.
// When no section has exactly those keys, as after a section gained a dimension, the first
// section with all of them is chosen.
// A section without dimensions is named by its benchmark, which is found again in whichever
// section holds it once it gains dimensions.
/**
 * @param {Suite} suite
 * @param {SectionRef | null} wanted
 * @returns {Section | null} null when no section matches
 */
function findSection(suite, wanted) {
  if (!wanted) return suite.sections[0];
  if (wanted.kind === "benchmark") {
    return (
      suite.sections.find((candidate) => candidate.link === wanted.link) ??
      suite.sections.find((candidate) => candidate.histories.some((history) => benchmarkLink(history.benchmarkId) === wanted.link)) ??
      null
    );
  }
  const { keys } = wanted;
  const keyed = suite.sections.filter((candidate) => candidate.keys.length);
  const exact = keyed.find((candidate) => candidate.keys.length === keys.length && keys.every((key) => candidate.keys.includes(key)));
  return exact ?? keyed.find((candidate) => keys.every((key) => candidate.keys.includes(key))) ?? null;
}

/** @param {string | null} benchmarkId */
function benchmarkLink(benchmarkId) {
  return `#${benchmarkId === null ? "" : linkPart(benchmarkId)}`;
}

/**
 * @param {Section} section
 * @returns {SectionRef}
 */
export function sectionRef(section) {
  return section.link === null ? { kind: "keys", keys: section.keys } : { kind: "benchmark", link: section.link };
}

// A chart's id in links: its metric, then its values of the dimensions that split charts, in key
// order as `key=value` joined by `/`, with every part escaped as in a line's slug.
// It names a chart by what it shows rather than by its position, so it keeps naming the same chart
// as runs are added.
/**
 * @param {Metric} metric
 * @param {readonly string[]} keys the dimensions that split charts
 * @param {Tags} dims the dimensions of any line in the chart
 */
export function chartId(metric, keys, dims) {
  const parts = [...keys].sort().map((key) => `${linkPart(key)}=${linkPart(urlText(dims[key]))}`);
  return parts.length ? `${linkPart(metric.slug)}:${parts.join("/")}` : linkPart(metric.slug);
}

// The chart a link's chart page shows, or null on any other page.
// A part without a value names a value no dimension has, so a damaged link shows nothing rather
// than more than it names.
/**
 * @param {LinkState} link
 * @returns {ChartScope | null}
 */
export function chartScope(link) {
  if (link.route.kind !== "chart") return null;
  const id = link.route.chart;
  const at = id.indexOf(":");
  /** @type {Map<string, string>} */
  const dims = new Map();
  if (at >= 0) {
    for (const part of id.slice(at + 1).split("/")) {
      const eq = part.indexOf("=");
      dims.set(unlinkPart(eq < 0 ? part : part.slice(0, eq)), eq < 0 ? "" : unlinkPart(part.slice(eq + 1)));
    }
  }
  return { metric: unlinkPart(at < 0 ? id : id.slice(0, at)), dims };
}

/**
 * The smoothing window in effect: the link's explicit choice, or the suite's default, so a page
 * that never chose follows each suite's own default.
 * @param {Suite} suite
 * @param {LinkState} link
 */
export function smoothingWindow(suite, link) {
  return link.smoothing.kind === "explicit" ? link.smoothing.window : suite.settings.smoothing;
}

// Settles a link against the data, so it names only what can apply and leaves out what follows
// from the data anyway:
// - the first suite and section stay implicit, and an unknown one falls back to the first;
// - a chart page names its suite and section even when they come first, since its chart belongs
//   to them and which suite or section comes first can change as more are recorded;
// - a chart page whose suite or section the data lacks is left as it is, since it names nothing
//   the data could settle it against;
// - a dimension filter outside the section is dropped;
// - a color or dash choice the pivot cannot honor is dropped;
// - an explicit smoothing window equal to the suite's default follows the default;
// - a selected run outside the range follows the newest run;
// - a window that names runs outside the range is clipped, and one covering it all is dropped.
/**
 * @param {readonly Suite[]} suites
 * @param {LinkState} next
 * @returns {LinkState}
 */
export function settle(suites, next) {
  const { suite, section, found } = resolveTarget(suites, next);
  const explicit = next.route.kind === "chart";
  if (explicit && !found) return next;
  const settled = { ...next };
  settled.suite = !explicit && suite === suites[0] ? null : suite.name;
  settled.section = explicit || (suite.sections.length > 1 && section !== suite.sections[0]) ? sectionRef(section) : null;

  // Filters
  /** @type {Map<string, import("./link.js").Filter<string>>} */
  const dimensions = new Map();
  for (const d of section.dims) {
    const filter = next.dimensions.get(d.key);
    if (filter && filter.kind === "only") dimensions.set(d.key, filter);
  }
  settled.dimensions = dimensions;

  // Pivot
  const pivot = choosePivot(section, settled);
  if (next.color.kind === "by" && next.color.key !== pivot.color) settled.color = { kind: "auto" };
  if (next.dash.kind === "by" && next.dash.key !== pivot.dash) settled.dash = { kind: "auto" };

  if (next.smoothing.kind === "explicit" && next.smoothing.window === suite.settings.smoothing) settled.smoothing = { kind: "configured" };

  // Run and window
  const runs = rangeRuns(suite, next.range);
  const position = (/** @type {string | null} */ key) => (key === null ? -1 : runs.findIndex((run) => run.key === key));
  if (next.run.kind === "at" && position(next.run.key) < 0) settled.run = { kind: "latest" };
  if (next.window.kind === "between") {
    const from = Math.max(0, position(next.window.from));
    const to = position(next.window.to);
    const end = to < 0 ? runs.length - 1 : to;
    settled.window =
      runs.length === 0 || (from === 0 && end === runs.length - 1) ? { kind: "full" } : { kind: "between", from: runs[from].key, to: runs[end].key };
  }
  return settled;
}

// Pivot

/**
 * The dimensions that can color lines, given how many distinct styles colors provide.
 * @param {Dimension} d
 */
export function colorable(d) {
  return d.varying && d.values.length <= SLOTS * 2;
}

/**
 * @param {Dimension} d
 * @param {Dimension | undefined} colorDim
 */
export function dashable(d, colorDim) {
  return d.varying && d.values.length <= DASHES.length && (!colorDim || colorDim.values.length <= SLOTS);
}

// Picks which dimension colors the lines, which sets their dash, and which split the charts.
// Every varying dimension that neither colors nor dashes splits the charts, so no two lines in one
// chart ever look the same.
// A chart page fixes the values of the dimensions that split its chart, so those vary no longer.
/**
 * @param {Section} section
 * @param {LinkState} link
 * @returns {Pivot}
 */
export function choosePivot(section, link) {
  const fixed = chartScope(link)?.dims;
  const varying = section.dims.filter((d) => d.varying && !fixed?.has(d.key));
  const size = (/** @type {Dimension} */ d) => d.values.length;
  /**
   * @param {import("./link.js").DimensionChoice} choice
   * @param {unknown} configured
   * @param {Dimension[]} allowed
   * @param {() => string | null} auto
   * @returns {string | null}
   */
  const pick = (choice, configured, allowed, auto) => {
    if (choice.kind === "none") return null;
    if (choice.kind === "by" && allowed.some((d) => d.key === choice.key)) return choice.key;
    if (typeof configured === "string" && allowed.some((d) => d.key === configured)) return configured;
    return auto();
  };

  const colorChoices = varying.filter(colorable);
  const color = pick(link.color, section.settings.colorBy, colorChoices, () => {
    const fits = colorChoices.filter((d) => size(d) <= SLOTS);
    if (fits.length) return fits.reduce((best, d) => (size(d) > size(best) ? d : best)).key;
    return colorChoices.length ? colorChoices.reduce((best, d) => (size(d) < size(best) ? d : best)).key : null;
  });
  const colorDim = varying.find((d) => d.key === color);
  const dashChoices = varying.filter((d) => d.key !== color && dashable(d, colorDim));
  const dash = pick(link.dash, section.settings.dashBy, dashChoices, () => {
    if (!colorDim || !dashChoices.length) return null;
    return dashChoices.reduce((best, d) => (size(d) < size(best) ? d : best)).key;
  });
  const facet = varying.filter((d) => d.key !== color && d.key !== dash).map((d) => d.key);
  return { color, dash, facet };
}

// A line's color comes from its value of the color dimension and its dash from the dash
// dimension, both by the value's fixed position, so filtering never repaints the lines that stay.
// A trace the dimension does not apply to takes the position after every value, so it never
// looks like one of them, and its label leaves the dimension out.
/**
 * @param {Trace} trace
 * @param {Pivot} pivot
 * @param {Map<string, Dimension>} dimsByKey
 * @returns {LineStyle}
 */
function lineStyle(trace, pivot, dimsByKey) {
  const colorDim = pivot.color ? dimsByKey.get(pivot.color) : undefined;
  const dashDim = pivot.dash ? dimsByKey.get(pivot.dash) : undefined;
  const position = (/** @type {Dimension | undefined} */ d) => {
    if (!d) return 0;
    if (trace.inapplicable.has(d.key)) return d.values.length;
    return d.byToken.get(token(trace.dims[d.key]))?.index ?? 0;
  };
  const colorIndex = position(colorDim);
  let dashIndex = position(dashDim);
  if (!dashDim && colorIndex >= SLOTS) dashIndex = 1;
  const parts = [colorDim, dashDim].flatMap((d) => (d && !trace.inapplicable.has(d.key) ? [valueText(d, trace.dims[d.key])] : []));
  return {
    slot: colorIndex % SLOTS,
    colorIndex,
    dashIndex,
    dash: DASHES[dashIndex % DASHES.length],
    label: parts.join(" / ") || trace.label,
  };
}

// Lines

/**
 * @param {Trace} trace
 * @param {readonly number[]} points
 * @param {LineStyle} style
 * @param {Facet} facet
 * @returns {Line}
 */
function makeLine(trace, points, style, facet) {
  const { history, own } = trace;
  /**
   * @template T
   * @param {readonly T[]} values
   * @returns {(i: number) => T | null}
   */
  const owned = (values) => (i) => (own.has(i) ? values[i] : null);
  const value = owned(history.values);
  const change = owned(history.change);
  const shift = owned(history.shifts);
  const detectionBaseline = owned(history.baselines);
  return {
    key: trace.key,
    slug: trace.slug,
    metric: history.metric,
    unit: history.metric.unit,
    label: trace.label,
    dims: trace.dims,
    points,
    style,
    facet,
    value,
    change,
    shift,
    detectionBaseline,
    segment: owned(history.segment),
    boundary: owned(history.boundary),
    spread: owned(history.ranges),
    note: owned(history.texts),
    environment: owned(history.envAt),
    // Worse or better at a shift, noise for any other value judged against a baseline, unjudged
    // for a value without enough earlier runs to judge it, and none where nothing was measured.
    judgement: (i) => {
      if (value(i) === null) return "none";
      const detected = shift(i);
      if (detected) return detected.kind;
      if (change(i) === null) return "none";
      return detectionBaseline(i) === null ? "unjudged" : "noise";
    },
  };
}

// The view

/**
 * @param {readonly Suite[]} suites
 * @param {LinkState} link
 * @returns {View}
 */
export function buildView(suites, link) {
  const { suite, section, found } = resolveTarget(suites, link);
  const runs = rangeRuns(suite, link.range);
  const offset = suite.runs.length - runs.length;
  const pivot = choosePivot(section, link);
  const dimsByKey = new Map(section.dims.map((d) => [d.key, d]));
  // A chart page shows its chart's metric and dimension values in place of the filters for them,
  // and nothing at all when it names a dimension the section lacks.
  const scope = chartScope(link);
  const shows = (/** @type {Metric} */ metric) => (scope ? metric.slug === scope.metric : admits(link.metrics, metric.slug));
  const known = !scope || (found && [...scope.dims.keys()].every((key) => dimsByKey.has(key)));
  // A dimension that does not apply to a trace never filters it out.
  const passes = (/** @type {Trace} */ trace) =>
    known &&
    section.dims.every((d) => {
      if (trace.inapplicable.has(d.key)) return true;
      const text = urlText(trace.dims[d.key]);
      const fixed = scope?.dims.get(d.key);
      return fixed === undefined ? admits(link.dimensions.get(d.key), text) : fixed === text;
    });
  const metrics = section.metrics.filter(shows);

  // Each line keeps the runs in range that its trace owns, in run order, so per-line work scales
  // with its own observations rather than with every run.
  /** @type {Line[]} */
  const lines = [];
  for (const trace of section.traces) {
    const history = trace.history;
    if (!shows(history.metric) || !passes(trace)) continue;
    const points = [];
    for (const i of trace.own) if (i >= offset) points.push(i);
    if (!points.some((i) => history.values[i] !== null)) continue;
    const facetDims = pivot.facet.map((key) => /** @type {Dimension} */ (dimsByKey.get(key)));
    // A facet dimension that does not apply to the trace puts it in a chart after every value's.
    const facetValues = facetDims.map((d) =>
      trace.inapplicable.has(d.key) ? null : /** @type {import("./history.js").DimensionValue} */ (d.byToken.get(token(trace.dims[d.key]))),
    );
    const facet = {
      token: facetValues.map((v) => v?.token ?? INAPPLICABLE).join("\u0003"),
      label: facetDims.flatMap((d, i) => (facetValues[i] ? [valueText(d, facetValues[i].value)] : [])).join(" / "),
      order: facetValues.map((v, i) => v?.index ?? facetDims[i].values.length),
    };
    lines.push(makeLine(trace, points, lineStyle(trace, pivot, dimsByKey), facet));
  }
  // Lines sort by facet, then color, then dash, so tables read in the same order as the charts.
  lines.sort((a, b) => compareOrder(a.facet.order, b.facet.order) || a.style.colorIndex - b.style.colorIndex || a.style.dashIndex - b.style.dashIndex);

  // The first value in range anchors the change scale; a zero has no relative change, so that line
  // is left out of the change view rather than rebased.
  /** @type {Map<string, number | null>} */
  const firstValues = new Map();
  for (const line of lines) {
    const first = line.points.find((i) => line.value(i) !== null);
    firstValues.set(line.key, first === undefined ? null : line.value(first));
  }

  // Runs where a visible line crossed a comparison boundary, with what changed.
  // An observation without a usable value still starts its segment, so it keeps its marker.
  /** @type {Map<number, string[]>} */
  const boundaries = new Map();
  for (const line of lines) {
    for (const i of line.points) {
      const changes = line.boundary(i);
      if (changes) boundaries.set(i, unique([...(boundaries.get(i) ?? []), ...changes]));
    }
  }

  const pinned = link.run;
  let selected = pinned.kind === "at" ? runs.findIndex((run) => run.key === pinned.key) : -1;
  if (selected < 0) selected = runs.length - 1;

  const tally = tallies(lines);
  return {
    suite,
    section,
    runs,
    offset,
    lines,
    metrics,
    pivot,
    chart: scope ? chartHeading(found ? section : null, scope) : null,
    selected,
    firstValues,
    boundaries,
    counts: (run) => tally().counts.get(run.index) ?? NO_COUNTS,
    moves: (run) => tally().moves.get(run.index) ?? [],
  };
}

/**
 * @param {Section | null} section null when the data lacks the chart's section
 * @param {ChartScope} scope
 * @returns {ChartHeading}
 */
function chartHeading(section, scope) {
  const dims = [...scope.dims].map(([key, text]) => {
    const d = section?.dims.find((candidate) => candidate.key === key);
    const value = d?.values.find((candidate) => candidate.param === text);
    return { key, label: d?.label ?? key, text: value ? value.text : text };
  });
  return { metric: section?.metrics.find((m) => m.slug === scope.metric) ?? null, dims };
}

// Counts the judgements and collects the moves of every run at once, the first time anything
// asks, by visiting each line's own observations.
// The trail, the run bar, and the changes list all ask, so this costs one pass over the
// observations rather than one pass over the lines for every run.
/**
 * @param {readonly Line[]} lines
 * @returns {() => { counts: Map<number, Counts>, moves: Map<number, Move[]> }}
 */
function tallies(lines) {
  /** @type {{ counts: Map<number, Counts>, moves: Map<number, Move[]> } | null} */
  let result = null;
  return () => {
    if (result) return result;
    /** @type {Map<number, Counts>} */
    const counts = new Map();
    /** @type {Map<number, Move[]>} */
    const moves = new Map();
    for (const line of lines) {
      for (const i of line.points) {
        const kind = line.judgement(i);
        if (kind === "none" || kind === "unjudged") continue;
        const tally = counts.get(i) ?? { worse: 0, better: 0, moved: 0, measured: 0 };
        counts.set(i, tally);
        tally.measured += 1;
        if (kind === "noise") continue;
        tally[kind] += 1;
        const { shift, tentative } = /** @type {Shift} */ (line.shift(i));
        const list = moves.get(i) ?? [];
        list.push({ line, change: shift, kind, tentative });
        moves.set(i, list);
      }
    }
    const rank = { worse: 0, better: 1, moved: 2 };
    for (const list of moves.values()) list.sort((a, b) => rank[a.kind] - rank[b.kind] || Math.abs(b.change) - Math.abs(a.change));
    result = { counts, moves };
    return result;
  };
}

// Movers

// Values at each end of the window whose medians give a line's net change.
const MOVER_ENDS = 5;

/**
 * A line's net change across a window, and how it reads.
 * `bad` is the change in the direction where positive is worse, or zero without a direction.
 * @typedef {{ line: Line, net: number | null, bad: number, kind: Judgement, shifts: number, latest: number }} Mover
 */

// Ranks lines by their net change across the given runs: regressions first, then improvements
// from the largest, then everything else by size.
// The net change compares the medians of the first and last MOVER_ENDS values, so a single noisy
// run at either end does not decide the rank.
// It only spans the latest comparison segment in the window, so a changed parameter or toolchain
// never counts as a move.
/**
 * @param {readonly Line[]} lines
 * @param {readonly Run[]} runs consecutive runs, oldest first
 * @param {number} threshold
 * @returns {Mover[]}
 */
export function rankMovers(lines, runs, threshold) {
  const from = runs[0]?.index ?? 0;
  const to = runs[runs.length - 1]?.index ?? -1;
  /** @type {Mover[]} */
  const rows = [];
  for (const line of lines) {
    const inWindow = line.points.filter((i) => i >= from && i <= to && line.value(i) !== null);
    if (!inWindow.length) continue;
    const segment = line.segment(inWindow[inWindow.length - 1]);
    const measured = inWindow.filter((i) => line.segment(i) === segment).map((i) => /** @type {number} */ (line.value(i)));
    if (measured.length < 2) continue;
    // The two ends never overlap, so a short segment compares its first and second half.
    const ends = Math.min(MOVER_ENDS, Math.floor(measured.length / 2));
    const start = /** @type {number} */ (median(measured.slice(0, ends)));
    const end = /** @type {number} */ (median(measured.slice(-ends)));
    const change = start ? relative(end, start) : null;
    const net = change !== null && Number.isFinite(change) ? change : null;
    const bad = badness(line.metric, net);
    /** @type {Judgement} */
    const kind = bad === null ? "noise" : bad > threshold ? "worse" : bad < -threshold ? "better" : "noise";
    const shifts = inWindow.filter((i) => line.shift(i)).length;
    rows.push({ line, net, bad: bad ?? 0, kind, shifts, latest: measured[measured.length - 1] });
  }
  rows.sort((a, b) => b.bad - a.bad);
  return [
    ...rows.filter((r) => r.kind === "worse"),
    ...rows.filter((r) => r.kind === "better").reverse(),
    ...rows.filter((r) => r.kind === "noise").sort((a, b) => Math.abs(b.net ?? 0) - Math.abs(a.net ?? 0)),
  ];
}

// Judging changes

/**
 * A change in the direction where positive is worse, or null without a known direction.
 * @param {Metric} metric
 * @param {number | null} change
 */
export function badness(metric, change) {
  if (change === null || metric.direction === "unknown") return null;
  return metric.direction === "higher" ? -change : change;
}

// A judgement from a change ratio alone, against the threshold, for comparisons that are not
// change points, such as a value against its baseline.
/**
 * @param {Metric} metric
 * @param {number | null} change
 * @param {number} threshold
 * @returns {Judgement}
 */
export function judge(metric, change, threshold) {
  const bad = badness(metric, change);
  if (bad === null) return change === null ? "none" : "noise";
  if (bad > threshold) return "worse";
  if (bad < -threshold) return "better";
  return "noise";
}
