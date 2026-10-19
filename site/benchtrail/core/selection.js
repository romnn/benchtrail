// How the page's link changes in response to what the reader does.
// Every change goes through `reduce`, which returns a new link and leaves the old one as it was,
// so the rules that change several things at once, such as switching sections, live in one place.

/** @typedef {import("./link.js").LinkState} LinkState */
/** @typedef {import("./link.js").RangeKey} RangeKey */
/** @typedef {import("./link.js").SectionRef} SectionRef */
/**
 * @template T
 * @typedef {import("./link.js").Filter<T>} Filter
 */

/**
 * The parts of a link that change on their own, without touching anything else.
 * @typedef {Pick<LinkState, "scale" | "axis" | "smoothing" | "color" | "dash" | "window" | "run" | "layout" | "more" | "allCharts" | "changes" | "list" | "query" | "onlyChanges" | "sort">} Settable
 */

/**
 * @typedef {{ type: "set", changes: Partial<Settable> }
 *   | { type: "suite", suite: string | null }
 *   | { type: "section", section: SectionRef | null }
 *   | { type: "range", range: RangeKey }
 *   | { type: "metrics", metrics: Filter<string> }
 *   | { type: "dimension", key: string, filter: Filter<string> }
 *   | { type: "focus", metrics: Filter<string> | null, dimensions: ReadonlyMap<string, Filter<string>> }
 * } Action
 */

/**
 * @param {LinkState} link
 * @param {Action} action
 * @returns {LinkState}
 */
export function reduce(link, action) {
  switch (action.type) {
    case "set":
      return { ...link, ...action.changes };
    // Filters, pivot, run, window, and sort name things inside one section, so a new suite or
    // section starts them afresh.
    case "suite":
      return { ...link, ...sectionDefaults(), suite: action.suite, section: null };
    case "section":
      return { ...link, ...sectionDefaults(), section: action.section };
    // A window names runs inside the range, so a new range shows all of it.
    case "range":
      return { ...link, range: action.range, window: { kind: "full" } };
    case "metrics":
      return { ...link, metrics: action.metrics };
    case "dimension": {
      const dimensions = new Map(link.dimensions);
      if (action.filter.kind === "all") dimensions.delete(action.key);
      else dimensions.set(action.key, action.filter);
      return { ...link, dimensions };
    }
    // Narrowing to one line's chart sets the filters that single it out and shows charts.
    case "focus": {
      const dimensions = new Map(link.dimensions);
      for (const [key, filter] of action.dimensions) dimensions.set(key, filter);
      return { ...link, metrics: action.metrics ?? link.metrics, dimensions, layout: "charts" };
    }
    default:
      return unreachable(action);
  }
}

/** @returns {Pick<LinkState, "metrics" | "dimensions" | "color" | "dash" | "layout" | "run" | "window" | "sort">} */
function sectionDefaults() {
  return {
    metrics: { kind: "all" },
    dimensions: new Map(),
    color: { kind: "auto" },
    dash: { kind: "auto" },
    layout: "auto",
    run: { kind: "latest" },
    window: { kind: "full" },
    sort: null,
  };
}

/**
 * @param {never} value
 * @returns {never}
 */
function unreachable(value) {
  throw new Error(`unhandled action ${JSON.stringify(value)}`);
}

/**
 * The filter that shows exactly the selected values.
 * It stays a list even when it names every value there is now, so values that appear later stay
 * out of it; only the filter for all values follows them.
 * @param {Iterable<string>} selected
 * @returns {Filter<string>}
 */
export function only(selected) {
  return { kind: "only", values: new Set(selected) };
}
