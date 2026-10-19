// Finding runs by what a reader remembers of them: a commit, a pull request, words of the subject,
// or its author.

/** @param {string} query */
export function searchTokens(query) {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// Scores a run against a query: every word must match somewhere, and the best place for each word
// decides its score.
// A commit SHA prefix or pull-request number ranks first, then the whole query as a phrase in the
// subject, then whole words, word prefixes, substrings, and finally the word's letters in order
// within one subject word, which tolerates letters left out of the query.
// Author and body matches count for less, and the body never matches loosely, since long
// squash-merge bodies mention almost everything.
// Results sort by tier first, so a SHA or pull request match always leads, then by score.
// Returns null when a word matches nowhere, otherwise the tier, score, and subject ranges to mark.
/**
 * @param {import("./history.js").Run} run
 * @param {readonly string[]} tokens
 * @param {string} query
 * @returns {{ tier: number, score: number, marks: Array<[number, number]> } | null}
 */
export function searchRun(run, tokens, query) {
  const subject = run.subject.toLowerCase();
  const author = run.author.toLowerCase();
  const body = run.body.toLowerCase();
  const pr = /\(#(\d+)\)$/.exec(run.subject)?.[1];
  /** @type {Array<[number, number]>} */
  const marks = [];
  let score = 0;
  let tier = 1;
  for (const tok of tokens) {
    let best = 0;
    if ((tok.length >= 4 && run.id.toLowerCase().startsWith(tok)) || (pr && (tok === pr || tok === `#${pr}`))) {
      tier = 3;
      best = 1000;
    }
    const inSubject = wordMatch(subject, tok);
    if (inSubject) {
      best = Math.max(best, inSubject.score);
      marks.push(inSubject.range);
    }
    const inAuthor = wordMatch(author, tok, false);
    if (inAuthor) best = Math.max(best, inAuthor.score / 2);
    const inBody = wordMatch(body, tok, false);
    if (inBody && (inBody.score >= 200 || tok.length >= 4)) best = Math.max(best, inBody.score / 10);
    if (!best) return null;
    score += best;
  }
  const phrase = query.trim().toLowerCase();
  const at = tokens.length > 1 ? subject.indexOf(phrase) : -1;
  if (at >= 0) {
    tier = Math.max(tier, 2);
    marks.push([at, at + phrase.length]);
  }
  return { tier, score, marks };
}

// The best match of one word in a text: a whole word, a word prefix, a substring, or, when loose
// matching is allowed, the word's letters in order within one word of the text.
/**
 * @param {string} text
 * @param {string} tok
 * @param {boolean} [loose]
 * @returns {{ score: number, range: [number, number] } | null}
 */
function wordMatch(text, tok, loose = true) {
  /** @type {{ score: number, range: [number, number] } | null} */
  let best = null;
  const consider = (/** @type {number} */ score, /** @type {[number, number]} */ range) => {
    if (!best || score > best.score) best = { score, range };
  };
  for (let at = text.indexOf(tok); at >= 0; at = text.indexOf(tok, at + 1)) {
    const startsWord = at === 0 || !/[\p{L}\p{N}]/u.test(text[at - 1]);
    const endsWord = at + tok.length === text.length || !/[\p{L}\p{N}]/u.test(text[at + tok.length]);
    consider(startsWord && endsWord ? 300 : startsWord ? 200 : 120, [at, at + tok.length]);
  }
  if (best || !loose || tok.length < 3) return best;
  for (const word of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const range = subsequence(word[0], tok);
    if (!range) continue;
    // Tighter spans score higher, and a span over twice the query's length is no match.
    const span = range[1] - range[0];
    if (span > tok.length * 2) continue;
    const at = word.index ?? 0;
    consider(10 + (50 * tok.length) / span, [at + range[0], at + range[1]]);
  }
  return best;
}

// The shortest span of `word` that holds every letter of `tok` in order, trying each place the
// first letter occurs, since the first occurrence is not always the tightest.
/**
 * @param {string} word
 * @param {string} tok
 * @returns {[number, number] | null}
 */
function subsequence(word, tok) {
  /** @type {[number, number] | null} */
  let best = null;
  for (let start = word.indexOf(tok[0]); start >= 0; start = word.indexOf(tok[0], start + 1)) {
    // A span longer than twice the query never counts as a match, so the scan stops there.
    const limit = Math.min(word.length, start + tok.length * 2);
    let i = 1;
    let j = start + 1;
    for (; j < limit && i < tok.length; j += 1) if (word[j] === tok[i]) i += 1;
    if (i < tok.length) continue;
    if (!best || j - start < best[1] - best[0]) best = [start, j];
  }
  return best;
}
