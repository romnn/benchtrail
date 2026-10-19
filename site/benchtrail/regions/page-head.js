// The head of a page below the overview: the way back to the overview, and what the page shows.

import { h, icon } from "../dom.js";

/** @param {import("./page.js").Page} page */
export function pageHeadRegion(page) {
  function render() {
    const back = page.anchor({ type: "open", route: { kind: "overview" } }, { class: "back" }, icon("left"), "Overview");
    const title = h("h2", { id: "page-title", tabindex: "-1" }, page.link.route.kind === "chart" ? chartTitle() : "All runs");
    document.getElementById("page-head").replaceChildren(...[back, title, page.link.route.kind === "chart" ? chartNote() : null].filter(Boolean));
  }

  // The chart's metric, then the values it fixes, each as its dimension and value.
  function chartTitle() {
    const chart = page.view.chart;
    return h(
      "span",
      { class: "page-title" },
      chart?.metric?.label ?? "Chart",
      ...(chart?.dims ?? []).map((d) => h("span", { class: "scope" }, h("span", { class: "scope-key" }, d.label), " ", d.text)),
    );
  }

  // A chart link fixes the dimensions that split charts when it was made.
  // When more split them now, as after the history gained a dimension, it matches several charts,
  // and when the history no longer has its chart, none.
  function chartNote() {
    if (page.view.lines.length === 0) return h("p", { class: "page-note" }, "No chart in this history matches this link.");
    const count = new Set(page.view.lines.map((line) => line.facet.token)).size;
    if (count < 2) return null;
    const split = page.view.pivot.facet.map((key) => page.section.dims.find((d) => d.key === key)?.label ?? key);
    return h("p", { class: "page-note" }, `This link matches ${count} charts, split by ${split.join(" and ")}.`);
  }

  return { roots: ["page-head"], render };
}
