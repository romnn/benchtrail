// Finding the runs where a benchmark's level shifted, robustly enough that noise and lone outliers
// do not count.

/** @typedef {"lower" | "higher" | "unknown"} Direction */

/**
 * How a detected shift reads for the benchmark: worse or better when the metric has a direction,
 * moved when it does not.
 * @typedef {"worse" | "better" | "moved"} ShiftKind
 */

/**
 * How a value at a run reads: a shift, noise when it was judged without finding one, unjudged
 * when too few earlier values allow a judgement, and none where nothing was measured.
 * @typedef {ShiftKind | "noise" | "unjudged" | "none"} Judgement
 */

/**
 * A detected shift at the run that started it.
 * `shift` is that run's own relative change against the baseline, and a tentative shift has not
 * yet been confirmed by enough later runs.
 * @typedef {{ kind: ShiftKind, shift: number, tentative: boolean }} Shift
 */

/**
 * One benchmark's values in run order, as detection reads them.
 * `observed` marks the runs that recorded the benchmark at all, with or without a usable value,
 * and `segment` numbers the comparison segment of each observed run.
 * @typedef {object} Series
 * @property {ReadonlyArray<number | null>} values
 * @property {ReadonlyArray<boolean>} observed
 * @property {ReadonlyArray<number | null>} segment
 * @property {Direction} direction
 */

/**
 * By run: the shift detected there, and the baseline the run was judged against, or null where it
 * was not judged.
 * @typedef {{ shifts: Array<Shift | null>, baselines: Array<number | null> }} Detection
 */

// Change detection compares each value with the median of up to BASELINE_RUNS earlier values in
// its regime, and confirms a shift with the median of CONFIRM_RUNS values starting at the run.
export const BASELINE_RUNS = 20;
const MIN_BASELINE = 8;
const CONFIRM_RUNS = 3;
// How many noise widths a confirmed shift must exceed, on top of the configured threshold.
const NOISE_WIDTHS = 4;
// The spread of a few values usually understates their noise, so the limit widens by a factor of
// 1 + SHORT_BASELINE / n for a baseline of n values.
const SHORT_BASELINE = 3;

// Finds the runs where a history's level shifted, and whether that made it worse or better.
//
// Each value is compared with the median of up to BASELINE_RUNS earlier values in its regime,
// where a regime starts at the beginning of a comparison segment or at the previous detected
// shift.
// The candidate level is the median of the run and the next CONFIRM_RUNS - 1 values, against
// that baseline, so a single outlier that returns to normal never counts.
// It must exceed the configured threshold and NOISE_WIDTHS times the uncertainty of the level's
// difference from the baseline.
// That uncertainty is the baseline's median absolute deviation, scaled to a standard deviation,
// times sqrt(1 / baseline + 1 / confirming) for the two medians, and widened for a short baseline.
// The run must also start the shift itself, so a step is reported once, at its onset, with the
// run's own change against the baseline.
//
// Noise that alternates between a few distinct levels can have no median absolute deviation at
// all, so every confirming value must also lie beyond all but one of the baseline's values.
// Allowing one keeps a single earlier outlier from hiding a real step.
//
// A shift at one of the last runs has fewer confirming values and is marked tentative.
// With only two, both must clear the limit on their own.
// A candidate cut short by the end of its segment is never reported, because later runs cannot
// confirm it; an observation without a usable value still ends the segment.
// A comparison that is not finite, such as against a vanishingly small baseline, is never
// reported.
// Without a known direction, a shift is still found but only reported as a move.
/**
 * @param {Series} series
 * @param {number} threshold the smallest relative change that may be reported
 * @returns {Detection}
 */
export function detect(series, threshold) {
  const n = series.values.length;
  /** @type {Detection} */
  const result = { shifts: new Array(n).fill(null), baselines: new Array(n).fill(null) };
  // The runs with a usable value, which are the only ones compared.
  /** @type {number[]} */
  const points = [];
  // The last observed run of each segment, valued or not, where confirmation must stop.
  /** @type {Map<number | null, number>} */
  const segmentEnd = new Map();
  let lastObserved = -1;
  for (let i = 0; i < n; i += 1) {
    if (series.observed[i]) {
      segmentEnd.set(series.segment[i], i);
      lastObserved = i;
    }
    if (series.values[i] !== null) points.push(i);
  }
  const value = (/** @type {number} */ i) => /** @type {number} */ (series.values[i]);
  // Both lists below are never empty where their median is taken.
  const middleOf = (/** @type {number[]} */ values) => /** @type {number} */ (median(values));

  let regime = 0;
  for (let p = 0; p < points.length; p += 1) {
    const i = points[p];
    if (p > 0 && series.segment[i] !== series.segment[points[p - 1]]) regime = p;
    const before = points.slice(Math.max(regime, p - BASELINE_RUNS), p).map(value);
    if (before.length < MIN_BASELINE) continue;
    const base = middleOf(before);
    // A zero baseline has no relative scale, so it leaves the run unjudged.
    if (!base) continue;
    result.baselines[i] = base;

    // Confirming values
    const end = /** @type {number} */ (segmentEnd.get(series.segment[i]));
    const after = [];
    for (let q = p; q < points.length && points[q] <= end && after.length < CONFIRM_RUNS; q += 1) after.push(value(points[q]));
    if (after.length < CONFIRM_RUNS && end < lastObserved) continue;

    // Limit
    const level = relative(middleOf(after), base);
    const own = relative(value(i), base);
    const sigma = (1.4826 * middleOf(before.map((x) => Math.abs(x - base)))) / Math.abs(base);
    const spread = Math.sqrt(1 / before.length + 1 / after.length) * (1 + SHORT_BASELINE / before.length);
    const limit = Math.max(threshold, NOISE_WIDTHS * 1.25 * sigma * spread);
    if (![level, own, limit].every(Number.isFinite)) continue;
    if (Math.abs(level) <= limit || Math.abs(own) <= limit || Math.sign(own) !== Math.sign(level)) continue;
    if (after.length === 2 && !after.every((x) => Math.sign(relative(x, base)) === Math.sign(level) && Math.abs(relative(x, base)) > limit)) continue;

    // Range gate
    const sorted = [...before].sort((a, b) => a - b);
    const beyond = level > 0 ? (/** @type {number} */ x) => x > sorted[sorted.length - 2] : (/** @type {number} */ x) => x < sorted[1];
    if (!after.every(beyond)) continue;

    // Detected shift
    regime = p;
    /** @type {ShiftKind} */
    let kind = "moved";
    if (series.direction === "higher") kind = level < 0 ? "worse" : "better";
    else if (series.direction === "lower") kind = level > 0 ? "worse" : "better";
    result.shifts[i] = { kind, shift: own, tentative: after.length < CONFIRM_RUNS };
  }
  return result;
}

// The signed change from a reference, scaled by its magnitude, so a rise is positive even for a
// negative reference.
// Dividing before subtracting keeps the difference of two huge values of opposite sign finite;
// the result is still not finite for a vanishingly small reference, which callers reject.
/**
 * @param {number} value
 * @param {number} reference
 */
export function relative(value, reference) {
  return value / Math.abs(reference) - Math.sign(reference);
}

// The midpoint of two values of opposite sign is their halved sum, and of two values of the same
// sign a half step from the lower one, so neither form can overflow.
/**
 * @param {readonly number[]} values
 * @returns {number | null}
 */
export function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2) return sorted[mid];
  const [a, b] = [sorted[mid - 1], sorted[mid]];
  return Math.sign(a) === Math.sign(b) ? a + (b - a) / 2 : (a + b) / 2;
}
