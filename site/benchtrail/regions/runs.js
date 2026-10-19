// The run list: every run in view, searchable and sortable by any line's change.

import { formatDateTime, formatValue } from "../core/format.js";
import { searchRun, searchTokens } from "../core/search.js";
import { badness } from "../core/view.js";
import { changeElement, disclosure, h, icon, lineKey } from "../dom.js";

// Runs shown at first, and added by each "show more".
const PAGE_SIZE = 30;
const HISTORY_COLUMNS = 6;

/** @param {import("./page.js").Page} page */
export function runsRegion(page) {
  // How many runs the list shows.
  let shown = PAGE_SIZE;

  function renderHistory() {
    const open = page.link.list;
    document.getElementById("history").hidden = !open;
    /** @type {HTMLInputElement} */ (document.getElementById("only-changes")).checked = page.link.onlyChanges;
    disclosure(document.getElementById("list-toggle"), open, open ? "Hide runs" : `All ${page.suite.runs.length} runs`);
    if (!open) return;

    const table = document.getElementById("history-table");
    const tokens = searchTokens(page.link.query);
    const sort = page.link.sort;
    const sortLine = sort && page.view.lines.find((b) => b.slug === sort.line);

    // The list follows the zoom window, so it always shows the runs the charts show.
    const { first, last } = page.zoomWindow();
    const significant = (run) => {
      const counts = page.view.counts(run);
      return counts.worse + counts.better + counts.moved > 0;
    };
    let runs = page.view.runs
      .map((run, j) => ({ run, j }))
      .filter(({ j }) => j >= first && j <= last)
      .map((entry) => ({ ...entry, match: tokens.length ? searchRun(entry.run, tokens, page.link.query) : null }))
      .filter(({ match }) => !tokens.length || match)
      .filter(({ run }) => !page.link.onlyChanges || significant(run));
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
            page.dispatch({ type: "set", changes: { sort: next } }, renderHistory);
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
        ? [h("td", { class: "moves-cell" }, page.regions.changes.movesElement(page.view.moves(run), 4))]
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
            page.regions.runBar.subjectElement(run, match?.marks),
            h("span", { class: "row-meta" }, `${run.author}, ${formatDateTime(run.date)}`),
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
    search.value = page.link.query;
    // Searching waits for a short pause in typing, so a long history is not searched per keystroke.
    let searchTimer = 0;
    search.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(
        page.safely(() => {
          shown = PAGE_SIZE;
          page.dispatch({ type: "set", changes: { query: search.value } }, renderHistory);
        }),
        120,
      );
    });
    document.getElementById("more").addEventListener("click", () => {
      shown += PAGE_SIZE;
      renderHistory();
    });
    document.getElementById("list-toggle").addEventListener("click", () => page.dispatch({ type: "set", changes: { list: !page.link.list } }, renderHistory));
    document.getElementById("only-changes").addEventListener("change", (event) => {
      shown = PAGE_SIZE;
      page.dispatch({ type: "set", changes: { onlyChanges: /** @type {HTMLInputElement} */ (event.target).checked } }, renderHistory);
    });
    page.narrow.addEventListener("change", () => renderHistory());
  }

  return { render: renderHistory, markHistorySelection, wire };
}
