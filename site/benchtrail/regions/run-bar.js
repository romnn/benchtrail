// The run bar above the charts, which names the selected or hovered run, and the selected run's
// commit message below them.

import { formatDateTime } from "../core/format.js";
import { safeUrl } from "../core/history.js";
import { unique } from "../core/list.js";
import { h, icon } from "../dom.js";

/** @param {import("./page.js").Page} page */
export function runBarRegion(page) {
  // Hovering or selecting a run updates two things in place: the run bar above the charts, which
  // stays on screen while the charts scroll, and the readout under every chart.
  // Both keep one shape for every run, so moving along the trail changes text without moving the
  // layout.
  function renderSelected() {
    const shown = page.hovered !== null && page.view.runs[page.hovered] ? page.hovered : page.view.selected;
    const run = page.view.runs[shown];
    const bar = document.getElementById("run-bar");
    if (!run) {
      bar.replaceChildren();
      return;
    }
    bar.classList.toggle("is-preview", shown !== page.view.selected);
    const boundary = page.view.boundaries.get(run.index);
    const { worse, better } = page.view.counts(run);
    const tally = [
      worse
        ? h(
            "span",
            { class: "change worse", title: `${worse} ${worse === 1 ? "regression" : "regressions"}` },
            icon("up"),
            String(worse),
            h("span", { class: "word" }, worse === 1 ? " regression" : " regressions"),
          )
        : null,
      better
        ? h(
            "span",
            { class: "change better", title: `${better} ${better === 1 ? "improvement" : "improvements"}` },
            icon("down"),
            String(better),
            h("span", { class: "word" }, better === 1 ? " improvement" : " improvements"),
          )
        : null,
    ].filter(Boolean);
    bar.replaceChildren(
      h(
        "div",
        { class: "run-head" },
        h(
          "button",
          {
            type: "button",
            class: "step",
            "aria-label": "Previous run",
            disabled: page.view.selected === 0,
            onclick: () => page.selectRun(page.view.selected - 1),
          },
          icon("left"),
        ),
        h(
          "button",
          {
            type: "button",
            class: "step",
            "aria-label": "Next run",
            disabled: page.view.selected === page.view.runs.length - 1,
            onclick: () => page.selectRun(page.view.selected + 1),
          },
          icon("right"),
        ),
        run.url ? h("a", { class: "sha", href: run.url }, run.short) : h("span", { class: "sha" }, run.short),
        h("span", { class: "run-subject", title: run.subject }, subjectElement(run)),
        h("span", { class: "tally" }, ...tally),
      ),
      h(
        "div",
        { class: "run-facts" },
        `${run.author}, ${formatDateTime(run.date)}`,
        boundary ? h("span", { class: "boundary", title: "Changes are not compared across this run" }, boundary.join(", ")) : null,
        page.link.run.kind === "at" && shown === page.view.selected
          ? h(
              "button",
              {
                type: "button",
                class: "follow",
                title: "Show the newest run, and keep following new ones",
                onclick: () => page.selectRun(page.view.runs.length - 1, false),
              },
              "Follow newest",
            )
          : null,
      ),
    );
    page.regions.charts.updateReadouts(run);
  }

  // The selected run's full commit message and environment, at the foot of the charts.
  // It follows the selection only, not the hover, so nothing below the charts moves while hovering.
  function renderMessage() {
    const panel = document.getElementById("selected");
    const run = page.view.runs[page.view.selected];
    if (!run) {
      panel.replaceChildren();
      return;
    }
    const texts = unique(page.view.lines.map((b) => b.note(run.index)).filter(Boolean));
    const environment = unique(page.view.lines.flatMap((b) => Object.entries(b.environment(run.index) ?? {}).map(([key, value]) => `${key} ${value}`)));
    const notes = texts.length === 1 ? texts[0] : null;
    const facts = [environment.length ? ["Environment", environment.join(", ")] : null, notes ? ["Notes", notes] : null].filter(Boolean);
    // The subject already heads the run bar, so this section adds only what the bar leaves out.
    panel.hidden = !run.body && !facts.length;
    panel.replaceChildren(
      ...[
        h("p", { class: "message-head" }, "Commit message"),
        run.body ? h("p", { class: "run-body" }, run.body) : null,
        facts.length ? h("dl", { class: "run-facts-list" }, ...facts.flatMap(([term, text]) => [h("dt", {}, term), h("dd", {}, text)])) : null,
      ].filter(Boolean),
    );
  }

  // The subject as text, with a trailing pull-request reference such as `(#57)` linked to the PR,
  // and the given character ranges marked as search matches.
  function subjectElement(run, marks = []) {
    const match = /^(.*?)\s*\(#(\d+)\)$/.exec(run.subject);
    const repo = safeUrl(page.data.repoUrl);
    if (!match || !repo || new URL(repo).hostname !== "github.com") return marked(run.subject, marks);
    const anchor = h("a", { href: `${repo.replace(/\/$/, "")}/pull/${match[2]}`, onclick: (event) => event.stopPropagation() }, `#${match[2]}`);
    return h("span", {}, marked(match[1], marks), " (", anchor, ")");
  }

  // Text with the given [start, end) ranges wrapped in <mark>; ranges past the text are ignored.
  function marked(text, marks) {
    const ranges = marks
      .map(([a, b]) => [Math.max(0, a), Math.min(text.length, b)])
      .filter(([a, b]) => a < b)
      .sort((x, y) => x[0] - y[0]);
    if (!ranges.length) return document.createTextNode(text);
    const span = h("span");
    let at = 0;
    for (const [a, b] of ranges) {
      if (b <= at) continue;
      const from = Math.max(a, at);
      if (from > at) span.append(text.slice(at, from));
      span.append(h("mark", {}, text.slice(from, b)));
      at = b;
    }
    if (at < text.length) span.append(text.slice(at));
    return span;
  }

  function render() {
    renderSelected();
    renderMessage();
  }

  return { render, renderSelected, subjectElement };
}
