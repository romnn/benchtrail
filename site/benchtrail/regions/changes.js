// The changes list: the runs in view that regressed or improved, newest first.

import { formatDate } from "../core/format.js";
import { changeElement, h, icon } from "../dom.js";
import { movesElement } from "./run-elements.js";

const CHANGES_SHOWN = 5;

/** @param {import("./page.js").Page} page */
export function changesRegion(page) {
  // Changes: the runs in view that regressed or improved, newest first.
  // Closed, it is one summary line; opened, it lists the latest few, and then every one.
  function renderChanges() {
    const container = document.getElementById("changes");
    const { first, last } = page.zoomWindow();
    const entries = [];
    let worse = 0;
    let better = 0;
    let moved = 0;
    let compared = 0;
    for (let j = last; j >= first; j -= 1) {
      const counts = page.view.counts(page.view.runs[j]);
      if (counts.measured) compared += 1;
      if (!counts.worse && !counts.better && !counts.moved) continue;
      if (counts.worse) worse += 1;
      if (counts.better) better += 1;
      if (counts.moved && !counts.worse && !counts.better) moved += 1;
      entries.push({ run: page.view.runs[j], j });
    }

    const open = page.link.changes !== "closed" && entries.length > 0;
    const setChanges = (value) => page.dispatch({ type: "set", changes: { changes: value } }, renderChanges);
    const summary = h(
      "button",
      {
        type: "button",
        class: "changes-toggle disclosure",
        "aria-expanded": String(open),
        disabled: entries.length === 0,
        onclick: () => setChanges(open ? "closed" : "open"),
      },
      entries.length ? icon(open ? "down" : "right", "toggle-icon") : null,
      h("span", { class: "changes-title" }, "Changes"),
      entries.length
        ? h(
            "span",
            { class: "changes-counts" },
            worse ? h("span", { class: "change worse" }, icon("up"), `${worse} ${worse === 1 ? "run" : "runs"} regressed`) : null,
            better ? h("span", { class: "change better" }, icon("down"), `${better} ${better === 1 ? "run" : "runs"} improved`) : null,
            moved ? h("span", { class: "change moved" }, `${moved} ${moved === 1 ? "run" : "runs"} shifted, direction unknown`) : null,
          )
        : h("span", { class: "changes-counts" }, compared ? "no shifts beyond the noise" : "not enough runs to compare yet"),
    );
    if (!open) {
      container.replaceChildren(summary);
      return;
    }

    const shown = page.link.changes === "all" ? entries : entries.slice(0, CHANGES_SHOWN);
    const items = shown.map(({ run, j }) => {
      const moves = page.view.moves(run);
      return h(
        "li",
        {
          class: "change-run",
          "data-view-index": String(j),
          "aria-selected": String(j === page.view.selected),
          onclick: () => page.selectRun(j),
          onmouseenter: () => page.preview(j),
          onmouseleave: () => page.preview(null),
        },
        h("span", { class: "lead" }, changeElement(moves[0].change, moves[0].kind)),
        h("span", { class: "subject", title: run.subject }, run.subject),
        movesElement(moves, 1, page.view.metrics.length > 1),
        h(
          "span",
          { class: "when" },
          moves.every((m) => m.tentative) ? h("span", { class: "tentative", title: "Later runs have not confirmed this shift yet" }, "unconfirmed") : null,
          h("span", { class: "sha" }, run.short),
          " ",
          formatDate(run.date, true),
        ),
      );
    });
    const more =
      entries.length > CHANGES_SHOWN
        ? h(
            "button",
            { type: "button", class: "changes-more", onclick: () => setChanges(page.link.changes === "all" ? "open" : "all") },
            page.link.changes === "all" ? "Show fewer" : `Show all ${entries.length}`,
          )
        : null;
    container.replaceChildren(...[summary, h("ul", { class: "change-list" }, ...items), more].filter(Boolean));
  }

  return { roots: ["changes"], render: renderChanges };
}
