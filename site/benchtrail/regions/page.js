// What a region of the page may read and do: the link and the view it shows, the data behind
// them, and the page's actions.
// Regions read these through getters, so they always see the current link and view.
//
// Each region names its roots, the elements of the page it draws into, which are shown only on
// pages that list the region.
// A region may also offer `reset`, to start its own state afresh for a new suite, section, or
// page, and `leave`, to release what it holds while its page is not shown.
// One that expands, such as a list showing more rows, offers `snapshot` and `restore`, so a
// history entry returns to it as it was left.

/**
 * @typedef {object} Page
 * @property {import("../core/link.js").LinkState} link
 * @property {import("../core/view.js").View} view
 * @property {import("../core/history.js").Suite[]} suites
 * @property {import("../core/history.js").Suite} suite
 * @property {import("../core/history.js").Section} section
 * @property {{ repoUrl?: string }} data
 * @property {{ title: string | null, threshold: number }} config
 * @property {MediaQueryList} narrow whether the page is laid out for a narrow screen
 * @property {(action: import("../core/selection.js").Action, draw?: () => void) => void} dispatch
 * @property {(action: import("../core/selection.js").Action) => void} go opens the page an action leads to, as a navigation
 * @property {(action: import("../core/selection.js").Action) => string} href the address of the page an action leads to
 * @property {(action: import("../core/selection.js").Action, attributes: Record<string, unknown>, ...children: Array<Node | string | null>) => HTMLAnchorElement} anchor
 * @property {() => void} render
 * @property {(index: number, pin?: boolean) => void} selectRun
 * @property {(index: number | null) => void} preview
 * @property {number | null} hovered the run position under the pointer, if any
 * @property {() => import("../core/chart-option.js").Plot} plot
 * @property {() => { first: number, last: number }} zoomWindow
 * @property {() => number} smoothing
 * @property {ReturnType<typeof import("../chart-runtime.js").createRuntime>} runtime
 * @property {<A extends unknown[]>(handler: (...args: A) => void) => (...args: A) => void} safely
 * @property {(error: unknown) => void} reportFailure
 * @property {Regions} regions
 */

/**
 * @typedef {object} Regions
 * @property {ReturnType<typeof import("./header.js").headerRegion>} header
 * @property {ReturnType<typeof import("./page-head.js").pageHeadRegion>} pageHead
 * @property {ReturnType<typeof import("./trail.js").trailRegion>} trail
 * @property {ReturnType<typeof import("./changes.js").changesRegion>} changes
 * @property {ReturnType<typeof import("./charts.js").chartsRegion>} charts
 * @property {ReturnType<typeof import("./run-bar.js").runBarRegion>} runBar
 * @property {ReturnType<typeof import("./runs.js").runsRegion>} runs
 * @property {ReturnType<typeof import("./notes.js").notesRegion>} notes
 */

export {};
