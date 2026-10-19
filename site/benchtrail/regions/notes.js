// The problems found while reading the history, behind a toggle at the foot of the page.

import { h } from "../dom.js";

/** @param {import("./page.js").Page} page */
export function notesRegion(page) {
  // Whether the list of problems is open.
  let expanded = false;

  // Problems found while reading the history, behind a toggle at the foot of the page.
  function renderNotes() {
    const problems = [...page.suite.problems.entries()];
    const container = document.getElementById("notes");
    container.hidden = problems.length === 0;
    if (!problems.length) return;
    const count = problems.reduce((sum, [, n]) => sum + n, 0);
    const button = h(
      "button",
      {
        type: "button",
        class: "option",
        "aria-expanded": String(expanded),
        onclick: () => {
          expanded = !expanded;
          renderNotes();
        },
      },
      `${count} ${count === 1 ? "problem" : "problems"} reading this suite`,
    );
    const list = expanded
      ? h("ul", { class: "notes-list" }, ...problems.map(([message, n]) => h("li", {}, n > 1 ? `${message} (${n} times)` : message)))
      : null;
    container.replaceChildren(...[button, list].filter(Boolean));
  }

  return { roots: ["notes"], render: renderNotes };
}
