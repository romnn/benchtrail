// How dimension values are identified: in memory as typed tokens, so the number 4 and the string
// "4" stay apart, and in links as text that keeps the same distinctions.

/**
 * A recorded dimension or environment value.
 * @typedef {string | number | boolean} Scalar
 */

/**
 * Named scalar values, as dimensions or an environment.
 * Built without a prototype, so names such as `toString` are ordinary keys.
 * @typedef {Record<string, Scalar>} Tags
 */

// Filter tokens keep each value's type, so the number 4 and the string "4" stay apart, and the
// token for "no value" cannot equal any value's.
export const MISSING = "\u0000missing";

/** @param {Scalar | undefined} value */
export function token(value) {
  return value === undefined ? MISSING : `${typeof value}:${value}`;
}

// An unambiguous key for a flat map: sorted pairs, with each value's type kept, so `4` and `"4"`
// stay apart and no delimiter inside a value can collide.
/** @param {Tags | null | undefined} tags */
export function canonical(tags) {
  return JSON.stringify(
    Object.keys(tags ?? {})
      .sort()
      .map((key) => [key, tags?.[key]]),
  );
}

// Escapes the characters that separate the parts of a link id, so joined parts stay apart.
/** @param {Scalar} text */
export function linkPart(text) {
  return String(text).replace(/[%/=#~:,]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

// A value as it reads in a link, which depends on the value alone, so a link keeps working as
// other values appear.
// Numbers and booleans read as plain text and no value reads as `-`.
// A string reads as itself unless it could be mistaken for one of those, for the empty selection
// `~`, or for a prefixed string, in which case it gets an `s:` prefix.
/** @param {Scalar | undefined} value */
export function urlText(value) {
  if (value === undefined) return "-";
  if (typeof value !== "string") return String(value);
  const ambiguous =
    value === "" || value === "-" || value === "~" || value === "true" || value === "false" || value.startsWith("s:") || String(Number(value)) === value;
  return ambiguous ? `s:${value}` : value;
}
