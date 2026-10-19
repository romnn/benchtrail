// Units as recorded: which family a unit belongs to and how it converts within that family.
// Metrics are keyed by unit family, so these rules decide which values can share an axis.

// Unit families, smallest step first, as [label, size in the family's base unit].
/** @type {Record<string, Array<[string, number]>>} */
export const FAMILIES = {
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

/** @type {Record<string, string>} */
const UNIT_ALIASES = { us: "µs", μs: "µs", sec: "s", secs: "s", seconds: "s", bytes: "B", byte: "B", KB: "kB", kb: "kB" };

/** @type {Record<string, string>} */
export const FAMILY_LABELS = { time: "Time", iec: "Size", si: "Size" };

/**
 * A unit's family, the size of its step in the family's base unit, and any rate or other tail,
 * such as the `/iter` of `ns/iter`; null for a unit outside every family.
 * @typedef {{ family: string, size: number, tail: string }} ParsedUnit
 */

/**
 * @param {string | null | undefined} unit
 * @returns {ParsedUnit | null}
 */
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
/**
 * @param {string} from
 * @param {string} to
 */
export function unitFactor(from, to) {
  if (from === to) return 1;
  const a = parseUnit(from);
  const b = parseUnit(to);
  return a && b && a.family === b.family ? a.size / b.size : 1;
}
