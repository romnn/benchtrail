// The trail across the top of the page: one bar per run for its regressions and improvements,
// with the zoom slider that moves every chart.

import { markers, trailOption } from "../core/chart-option.js";

/** @param {import("./page.js").Page} page */
export function trailRegion(page) {
  /** @type {import("echarts").ECharts | null} */
  let trail = null;

  function renderTrail() {
    const dom = document.getElementById("trail-chart");
    trail = page.runtime.trail(dom);
    trail.setOption(trailOption(page.plot(), dom.clientWidth), { notMerge: true });
  }

  // Moves the selected run's marker on the trail.
  function markSelection(shared) {
    trail?.setOption({ series: [{ id: "trail", markLine: markers(shared, { labels: true }) }] });
  }

  // A new suite, section, or page draws a new trail, so a drag of the old one's slider cannot
  // move the new view.
  function reset() {
    page.runtime.dropTrail();
    trail = null;
  }

  return { roots: ["trail-chart"], render: renderTrail, markSelection, reset };
}
