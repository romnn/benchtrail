// Where runs sit on the x axis, and how a zoom window maps to the runs at its ends.
// The x axis spans run positions, or dates, and a zoom window is a percentage range of it, as the
// chart library reports it; a link names the runs at its ends instead, so it keeps showing the
// same runs on either axis and as runs are added.

/** @typedef {import("./history.js").Run} Run */
/** @typedef {import("./link.js").AxisKey} AxisKey */
/** @typedef {import("./link.js").PlotWindow} PlotWindow */

/**
 * A zoom window in percent of the x axis.
 * @typedef {{ start: number, end: number }} Percent
 */

/**
 * A run position's place on the x axis, in percent.
 * @param {readonly Run[]} runs consecutive runs, oldest first
 * @param {number} j
 * @param {AxisKey} axis
 */
export function percentOfRun(runs, j, axis) {
  if (runs.length < 2) return 0;
  if (axis === "date") {
    const span = runs[runs.length - 1].date - runs[0].date;
    return span > 0 ? ((runs[j].date - runs[0].date) / span) * 100 : 0;
  }
  return (j / (runs.length - 1)) * 100;
}

/**
 * The run nearest a place on the x axis.
 * @param {readonly Run[]} runs consecutive runs, oldest first, at least one
 * @param {number} percent
 * @param {AxisKey} axis
 * @returns {Run}
 */
export function runAtPercent(runs, percent, axis) {
  if (axis !== "date") return runs[Math.round((percent / 100) * (runs.length - 1))];
  const target = runs[0].date + (percent / 100) * (runs[runs.length - 1].date - runs[0].date);
  return runs.reduce((best, run) => (Math.abs(run.date - target) < Math.abs(best.date - target) ? run : best));
}

/**
 * Whether a zoom window covers the whole axis, or there is nothing to zoom.
 * @param {readonly Run[]} runs
 * @param {Percent} zoom
 */
function unzoomed(runs, zoom) {
  return (zoom.start <= 0 && zoom.end >= 100) || runs.length === 0;
}

/**
 * The link's window for a zoom window: the runs at its ends.
 * @param {readonly Run[]} runs consecutive runs, oldest first
 * @param {Percent} zoom
 * @param {AxisKey} axis the axis the zoom window was made on
 * @returns {PlotWindow}
 */
export function windowAt(runs, zoom, axis) {
  if (unzoomed(runs, zoom)) return { kind: "full" };
  return { kind: "between", from: runAtPercent(runs, zoom.start, axis).key, to: runAtPercent(runs, zoom.end, axis).key };
}

/**
 * The zoom window for a link's window: the places of the runs it names, with an end the runs lack
 * left open.
 * @param {readonly Run[]} runs consecutive runs, oldest first
 * @param {PlotWindow} window
 * @param {AxisKey} axis
 * @returns {Percent}
 */
export function zoomOf(runs, window, axis) {
  if (window.kind === "full" || runs.length === 0) return { start: 0, end: 100 };
  const position = (/** @type {string | null} */ key) => runs.findIndex((run) => run.key === key);
  const from = position(window.from);
  const to = position(window.to);
  return { start: from < 0 ? 0 : percentOfRun(runs, from, axis), end: to < 0 ? 100 : percentOfRun(runs, to, axis) };
}

/**
 * The positions of the first and last run inside a zoom window.
 * @param {readonly Run[]} runs consecutive runs, oldest first
 * @param {Percent} zoom
 * @param {AxisKey} axis
 * @returns {{ first: number, last: number }}
 */
export function runsIn(runs, zoom, axis) {
  if (unzoomed(runs, zoom)) return { first: 0, last: runs.length - 1 };
  // Runs are consecutive, so a run's position is its index past the first run's.
  const offset = runs[0].index;
  return { first: runAtPercent(runs, zoom.start, axis).index - offset, last: runAtPercent(runs, zoom.end, axis).index - offset };
}
