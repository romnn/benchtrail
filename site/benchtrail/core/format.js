// How recorded values, changes, and dates read on the page.
// Nothing here touches the DOM, so it runs the same in Node.

import { FAMILIES, parseUnit } from "./units.js";

/** @typedef {import("./detect.js").Judgement} Judgement */

// Picks the step that keeps `magnitude` at one or more, and returns the factor that converts a
// recorded value into it.
// Times stay in seconds up to ten minutes, which reads better than 2.3 min.
/**
 * @param {string} unit
 * @param {number} magnitude
 * @returns {{ label: string, factor: number }}
 */
export function displayUnit(unit, magnitude) {
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

/**
 * @param {number} value
 * @param {string} unit
 */
export function formatValue(value, unit) {
  const display = displayUnit(unit, Math.abs(value));
  const text = formatNumber(value * display.factor);
  return display.label ? `${text} ${display.label}` : text;
}

/** @param {number} x */
function formatNumber(x) {
  const abs = Math.abs(x);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return x.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// A tick label with as many decimals as the tick step needs, so neighbouring ticks never read the
// same; without a step, as on a log axis, it keeps three significant digits.
/**
 * @param {number} x
 * @param {number | null} [step]
 */
export function formatTick(x, step = null) {
  if (step && step > 0) {
    const digits = Math.min(10, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
    return x.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  return x.toLocaleString(undefined, { maximumSignificantDigits: 3 });
}

/** @param {number} x */
function formatSigned(x) {
  const rounded = Math.abs(x) < 0.05 ? 0 : x;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `${sign}${Math.abs(rounded).toFixed(Math.abs(rounded) >= 10 ? 0 : 1)}`;
}

// A relative change as text, with the arrow and description its judgement calls for.
/**
 * @param {number | null | undefined} ratio
 * @param {Judgement} kind
 * @returns {{ text: string, arrow: "up" | "down" | null, label: string }}
 */
export function changeParts(ratio, kind) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return { text: "–", arrow: null, label: "no earlier value" };
  const arrow = ["worse", "better", "moved"].includes(kind) ? (ratio > 0 ? "up" : "down") : null;
  /** @type {Partial<Record<Judgement, string>>} */
  const labels = { worse: "regression", better: "improvement", moved: "shift of unknown direction", unjudged: "too few earlier runs to judge" };
  const label = labels[kind] ?? "within noise";
  return { text: `${formatSigned(ratio * 100)}%`, arrow, label };
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const dateYearFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
export const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * @param {number} ms
 * @param {boolean} [withYear]
 */
export function formatDate(ms, withYear = false) {
  if (!ms || !Number.isFinite(ms)) return "";
  return (withYear ? dateYearFormat : dateFormat).format(ms);
}

/** @param {number} ms */
export function formatDateTime(ms) {
  return ms && Number.isFinite(ms) ? dateTimeFormat.format(ms) : "";
}
