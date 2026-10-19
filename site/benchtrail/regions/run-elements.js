// Elements that show a run, shared by the regions that list runs: its subject and its moves.

import { safeUrl } from "../core/history.js";
import { changeElement, h } from "../dom.js";

// The subject as text, with a trailing pull-request reference such as `(#57)` linked to the PR,
// and the given character ranges marked as search matches.
/**
 * @param {import("../core/history.js").Run} run
 * @param {string | undefined} repoUrl the repository the history names, if any
 * @param {Array<[number, number]>} [marks]
 */
export function subjectElement(run, repoUrl, marks = []) {
  const match = /^(.*?)\s*\(#(\d+)\)$/.exec(run.subject);
  const repo = safeUrl(repoUrl);
  if (!match || !repo || new URL(repo).hostname !== "github.com") return marked(run.subject, marks);
  const anchor = h("a", { href: `${repo.replace(/\/$/, "")}/pull/${match[2]}`, onclick: (event) => event.stopPropagation() }, `#${match[2]}`);
  return h("span", {}, marked(match[1], marks), " (", anchor, ")");
}

// Text with the given [start, end) ranges wrapped in <mark>; ranges past the text are ignored.
/**
 * @param {string} text
 * @param {Array<[number, number]>} marks
 */
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

// A wrapping list of moves, each a signed change beside the line it belongs to, with the line's
// metric when the view shows several.
/**
 * @param {import("../core/view.js").Move[]} moves
 * @param {number} limit
 * @param {boolean} multipleMetrics
 */
export function movesElement(moves, limit, multipleMetrics) {
  const shown = moves.slice(0, limit);
  return h(
    "span",
    { class: "moves" },
    ...shown.map(({ line, change, kind }) =>
      h(
        "span",
        { class: "move" },
        changeElement(change, kind),
        h("span", { class: "what" }, line.label, multipleMetrics ? h("span", { class: "metric" }, line.metric.label) : null),
      ),
    ),
    moves.length > shown.length ? h("span", { class: "move what" }, `${moves.length - shown.length} more`) : null,
  );
}
