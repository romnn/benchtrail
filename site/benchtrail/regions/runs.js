// The run list: every run in range on a page of its own, searchable and sortable by any line's
// change; the overview links to it.

import { formatDateTime, formatValue } from "../core/format.js";
import { runsRoute } from "../core/link.js";
import { searchRun, searchTokens } from "../core/search.js";
import { badness } from "../core/view.js";
import { changeElement, h, icon, lineKey } from "../dom.js";
import { movesElement, subjectElement } from "./run-elements.js";

// Runs shown at first, and added by each "show more".
const PAGE_SIZE = 30;
const HISTORY_COLUMNS = 6;

/** @param {import("./page.js").Page} page */
export function runsRegion(page) {
  // How many runs the list shows, and the search waiting for a pause in typing.
  let shown = PAGE_SIZE;
  let searchTimer = 0;

  function render() {
    const listed = page.link.route.kind === "runs";
    const count = page.view.runs.length;
    document
      .getElementById("runs-link")
      .replaceChildren(
        listed
          ? ""
          : page.anchor(
              { type: "open", route: runsRoute() },
              { class: "wide-toggle" },
              `All ${count} ${count === 1 ? "run" : "runs"}`,
              icon("right", "toggle-icon"),
            ),
      );
    document.getElementById("history").hidden = !listed;
    if (listed) renderHistory();
  }

  function renderHistory() {
    const route = page.link.route;
    if (route.kind !== "runs") return;
    const list = route.list;
    const search = /** @type {HTMLInputElement} */ (document.getElementById("search"));
    if (search.value !== list.query && document.activeElement !== search) search.value = list.query;
    /** @type {HTMLInputElement} */ (document.getElementById("only-changes")).checked = list.onlyChanges;

    const table = document.getElementById("history-table");
    const tokens = searchTokens(list.query);
    const sort = list.sort;
    const sortLine = sort && page.view.lines.find((b) => b.slug === sort.line);

    // The list shows every run in range, or, when the reader asks, only those in the zoom window.
    const { first, last } = page.zoomWindow();
    const zoomed = first > 0 || last < page.view.runs.length - 1;
    const windowed = zoomed && list.inWindow;
    renderWindowToggle(list, zoomed, first, last);
    const significant = (run) => {
      const counts = page.view.counts(run);
      return counts.worse + counts.better + counts.moved > 0;
    };
    let runs = page.view.runs
      .map((run, j) => ({ run, j }))
      .filter(({ j }) => !windowed || (j >= first && j <= last))
      .map((entry) => ({ ...entry, match: tokens.length ? searchRun(entry.run, tokens, list.query) : null }))
      .filter(({ match }) => !tokens.length || match)
      .filter(({ run }) => !list.onlyChanges || significant(run));
    if (tokens.length && !sortLine) {
      // Search results rank by relevance, newest first among equals.
      runs.sort((a, b) => b.match.tier - a.match.tier || b.match.score - a.match.score || b.j - a.j);
    } else if (sortLine) {
      // Worst first sorts by regression size, best first by improvement size; runs without a
      // change for this benchmark go last either way.
      const sign = sort.order === "best" ? -1 : 1;
      const key = ({ run }) => badness(sortLine.metric, sortLine.change(run.index));
      runs.sort((a, b) => Number(key(a) === null) - Number(key(b) === null) || sign * (key(b) - key(a)));
    } else {
      runs = runs.reverse();
    }

    const sortButton = (line, label) => {
      const active = sortLine === line;
      const marker = active ? icon(sort.order === "best" ? "up" : "down", "sort-icon") : null;
      return h(
        "button",
        {
          type: "button",
          class: "option",
          "aria-pressed": String(active),
          title: "Sort by change: worst first, then best first, then by date",
          onclick: () => {
            /** @type {import("../core/link.js").Sort | null} */
            let next = { line: line.slug, order: "worst" };
            if (active) next = sort.order === "worst" ? { line: line.slug, order: "best" } : null;
            shown = PAGE_SIZE;
            page.dispatch({ type: "list", changes: { sort: next } }, renderHistory);
          },
        },
        label,
        marker,
      );
    };

    // A column per line only while the lines fit side by side; past that, or on a narrow screen,
    // one column lists each run's significant moves and wraps, so the table never scrolls sideways.
    const wide = page.view.lines.length > HISTORY_COLUMNS || page.narrow.matches;
    const head = h(
      "thead",
      {},
      h(
        "tr",
        {},
        h("th", {}, `${runs.length} ${runs.length === 1 ? "run" : "runs"}`),
        ...(wide
          ? [h("th", {}, "Changes")]
          : page.view.lines.map((line) => {
              const label = page.view.metrics.length > 1 ? `${line.label} ${line.metric.label}` : line.label;
              return h("th", {}, lineKey(line.style), sortButton(line, label));
            })),
      ),
    );

    const body = h("tbody", {});
    for (const { run, j, match } of runs.slice(0, shown)) {
      const cells = wide
        ? [h("td", { class: "moves-cell" }, movesElement(page.view.moves(run), 4, page.view.metrics.length > 1))]
        : page.view.lines.map((line) => {
            const value = line.value(run.index);
            const change = line.change(run.index);
            return h("td", {}, value === null ? "–" : formatValue(value, line.unit), changeElement(change, line.judgement(run.index)));
          });
      body.append(
        h(
          "tr",
          { "data-view-index": String(j), "aria-selected": String(j === page.view.selected), onclick: () => page.selectRun(j) },
          h(
            "td",
            {},
            h("span", { class: "sha" }, run.short),
            " ",
            subjectElement(run, page.data.repoUrl, match?.marks),
            h("span", { class: "row-meta" }, `${run.author}, ${formatDateTime(run.date)}`, showInCharts(run, j, first, last)),
          ),
          ...cells,
        ),
      );
    }
    if (runs.length === 0) {
      body.append(h("tr", { class: "empty-row" }, h("td", { colspan: String(wide ? 2 : page.view.lines.length + 1) }, "No runs match.")));
    }
    table.replaceChildren(head, body);

    const more = document.getElementById("more");
    more.hidden = runs.length <= shown;
    more.textContent = `Show ${Math.min(PAGE_SIZE, runs.length - shown)} more`;
  }

  // The toggle that keeps the list to the zoom window, offered while the charts are zoomed.
  function renderWindowToggle(list, zoomed, first, last) {
    const label = document.getElementById("in-window-label");
    label.hidden = !zoomed;
    /** @type {HTMLInputElement} */ (document.getElementById("in-window")).checked = list.inWindow;
    const runs = page.view.runs;
    document.getElementById("in-window-range").textContent = zoomed ? `${runs[first].short} to ${runs[last].short}, ${last - first + 1} runs` : "";
  }

  // Opens the overview at a run, kept in the zoom window when it lies inside it.
  function showInCharts(run, j, first, last) {
    /** @type {import("../core/link.js").PlotWindow} */
    const window = j >= first && j <= last ? page.link.window : { kind: "full" };
    return page.anchor(
      { type: "open", route: { kind: "overview" }, changes: { run: { kind: "at", key: run.key }, window } },
      { class: "show-run" },
      "Show in charts",
    );
  }

  function markHistorySelection() {
    const rows = /** @type {NodeListOf<HTMLElement>} */ (
      document.querySelectorAll("#changes .change-run[data-view-index], #history-table tbody tr[data-view-index]")
    );
    for (const row of rows) {
      row.setAttribute("aria-selected", String(Number(row.dataset.viewIndex) === page.view.selected));
    }
  }

  function wire() {
    const search = /** @type {HTMLInputElement} */ (document.getElementById("search"));
    // Searching waits for a short pause in typing, so a long history is not searched per keystroke.
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(
        page.safely(() => {
          shown = PAGE_SIZE;
          page.dispatch({ type: "list", changes: { query: search.value } }, renderHistory);
        }),
        120,
      );
    });
    document.getElementById("more").addEventListener("click", () => {
      shown += PAGE_SIZE;
      renderHistory();
      page.saveEntry();
    });
    document.getElementById("only-changes").addEventListener("change", (event) => {
      shown = PAGE_SIZE;
      page.dispatch({ type: "list", changes: { onlyChanges: /** @type {HTMLInputElement} */ (event.target).checked } }, renderHistory);
    });
    document.getElementById("in-window").addEventListener("change", (event) => {
      shown = PAGE_SIZE;
      page.dispatch({ type: "list", changes: { inWindow: /** @type {HTMLInputElement} */ (event.target).checked } }, renderHistory);
    });
    page.narrow.addEventListener("change", () => {
      if (page.link.route.kind === "runs") renderHistory();
    });
  }

  // A new suite, section, or page shows the first runs, and drops a search still waiting to run.
  function reset() {
    shown = PAGE_SIZE;
    clearTimeout(searchTimer);
  }

  // A history entry keeps how many runs its list showed, so its scroll position finds them again.
  function snapshot() {
    return shown;
  }

  /** @param {unknown} saved */
  function restore(saved) {
    if (typeof saved === "number" && Number.isFinite(saved)) shown = Math.max(PAGE_SIZE, saved);
  }

  return { roots: ["runs"], render, markHistorySelection, wire, reset, snapshot, restore };
}
