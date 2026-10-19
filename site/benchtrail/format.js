// How recorded values, units, changes, and dates read on the page.
// Nothing here touches the DOM, so it runs the same in Node.

// Unit families, smallest step first, as [label, size in the family's base unit].
/** @type {Record<string, Array<[string, number]>>} */
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

export const FAMILY_LABELS = { time: "Time", iec: "Size", si: "Size" };

export function parseUnit(unit) {
  const match = /^\s*([^\s/]+)\s*(.*)$/.exec(unit ?? "");
  if (!match) return null;
  const head = UNIT_ALIASES[match[1]] ?? match[1];
  for (const [family, steps] of Object.entries(FAMILIES)) {
    const step = steps.find(([label]) => label === head);
    if (step) return { family, size: step[1], tail: match[2] };
  }
  return null;
}

// The factor that converts a value recorded in `from` into `to`; units outside a known family
// only ever meet themselves, since metrics are keyed by unit family.
export function unitFactor(from, to) {
  if (from === to) return 1;
  const a = parseUnit(from);
  const b = parseUnit(to);
  return a && b && a.family === b.family ? a.size / b.size : 1;
}

// Picks the step that keeps `magnitude` at one or more, and returns the factor that converts a
// recorded value into it.
// Times stay in seconds up to ten minutes, which reads better than 2.3 min.
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

export function formatValue(value, unit) {
  const display = displayUnit(unit, Math.abs(value));
  const text = formatNumber(value * display.factor);
  return display.label ? `${text} ${display.label}` : text;
}

function formatNumber(x) {
  const abs = Math.abs(x);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return x.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// A tick label with as many decimals as the tick step needs, so neighbouring ticks never read the
// same; without a step, as on a log axis, it keeps three significant digits.
export function formatTick(x, step = null) {
  if (step > 0) {
    const digits = Math.min(10, Math.max(0, -Math.floor(Math.log10(step) + 1e-9)));
    return x.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }
  return x.toLocaleString(undefined, { maximumSignificantDigits: 3 });
}

function formatSigned(x) {
  const rounded = Math.abs(x) < 0.05 ? 0 : x;
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "±";
  return `${sign}${Math.abs(rounded).toFixed(Math.abs(rounded) >= 10 ? 0 : 1)}`;
}

export function changeParts(ratio, kind) {
  if (ratio === null || ratio === undefined || !Number.isFinite(ratio)) return { text: "–", arrow: null, label: "no earlier value" };
  const arrow = ["worse", "better", "moved"].includes(kind) ? (ratio > 0 ? "up" : "down") : null;
  const label =
    { worse: "regression", better: "improvement", moved: "shift of unknown direction", unjudged: "too few earlier runs to judge" }[kind] ?? "within noise";
  return { text: `${formatSigned(ratio * 100)}%`, arrow, label };
}

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });

const dateYearFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });

export const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });

const dateTimeFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

export function formatDate(ms, withYear = false) {
  if (!ms || !Number.isFinite(ms)) return "";
  return (withYear ? dateYearFormat : dateFormat).format(ms);
}

export function formatDateTime(ms) {
  return ms && Number.isFinite(ms) ? dateTimeFormat.format(ms) : "";
}
