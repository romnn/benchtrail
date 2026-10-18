// Writes `sample/data.js`: a synthetic history in the format github-action-benchmark commits to
// gh-pages, for developing the page without a real project.
//
// Usage: node sample/generate.mjs [runs]
//
// The output is deterministic, so a regenerated sample only changes when this script does.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RUNS = Number(process.argv[2] ?? 220);
const REPO = "https://github.com/benchtrail/sample";
const DAY = 86_400_000;
const START = Date.UTC(2026, 3, 6, 9, 0, 0);

// Mulberry32, so every run of the script produces the same history.
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(20261018);
const gauss = () => {
  const u = 1 - random();
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const pick = (items) => items[Math.floor(random() * items.length)];
const hex = (n) => Array.from({ length: n }, () => Math.floor(random() * 16).toString(16)).join("");

const AUTHORS = [
  { name: "Sam Rivera", email: "sam@example.com", username: "samrivera" },
  { name: "Noor Haddad", email: "noor@example.com", username: "noorh" },
  { name: "Jun Park", email: "jun@example.com", username: "junpark" },
];

const SUBJECTS = [
  "feat(shape): read nullable enums as one optional variant",
  "fix(contract): keep titled types apart when merging unions",
  "refactor(resolve): walk references with an explicit stack",
  "feat(codegen): emit builders for request bodies",
  "fix(serde): accept integer strings for int64 fields",
  "docs(readme): describe the strict and lenient clients",
  "test(corpus): add the discriminator-heavy documents",
  "chore(deps): bump serde_json to 1.0.140",
  "feat(cli): add --jobs to run documents in parallel",
  "fix(naming): avoid keywords in generated field names",
  "refactor(doc): own a bundle's root types",
  "ci(lint): run layer checks on every push",
  "feat(support): stream large response bodies",
  "fix(shape): treat empty allOf as an open object",
  "chore(fmt): format the workspace",
  "refactor(codegen): share the visitor between models and clients",
  "fix(contract): make a tag-only union branch a unit variant, and keep titled types apart when two schemas share a discriminator value but declare different titles",
  "feat(shape): read known values or any string as one enum that admits the rest, with a catch-all variant that keeps the original string for round-tripping",
];

// Squash-merge bodies, so the page is exercised with long, multi-paragraph messages.
const BODIES = [
  "* refactor(doc): own a bundle's root types, and rank bundle in the layer table\n\n`bundle` and `doc` imported each other, so `bundle` could not be ranked and `xtask lint-layers` failed on every push since bundles landed. `Direction` and `Selected` are part of the parsed document, so they live in `doc` now; `bundle` builds them and sits between `doc` and `resolve`.\n\n* fix(support): leave the lenient-only report method out of a strict client\n\n* chore(fmt): format the workspace with rustfmt",
  "The resolver walked references recursively, which overflowed the stack on deeply nested discriminator documents. It now keeps an explicit stack of pending references and visits each one once.\n\nCo-authored-by: Jun Park <jun@example.com>",
  "Large response bodies were buffered in full before deserialization. Clients now stream them through `serde_json::Deserializer::from_reader`, which keeps peak memory flat for paginated list endpoints that return tens of megabytes per page.",
  "Splits the visitor so models and clients share one traversal.\n\n- one pass over the schema graph instead of two\n- stable output order, so generated files no longer churn between runs\n- removes 1,200 lines of duplicated match arms",
];

// Named moments in the history, so the sample shows steps as well as noise. Each multiplies the
// listed benchmarks from its run onward.
const EVENTS = [
  { at: 34, subject: "feat(codegen): derive Debug on every generated type", scale: { cpu: 1.07, "ns/iter": 1.0 } },
  { at: 71, subject: "perf(resolve): intern schema names", scale: { "peak rss": 0.88, "ns/iter": 0.93 } },
  { at: 118, subject: "perf(codegen): emit one impl block per type", scale: { cpu: 0.84 } },
  { at: 152, subject: "chore(toolchain): build with rustc 1.97", scale: { cpu: 1.03, "peak rss": 1.02 }, toolchain: "rustc 1.97.0 (3b7c4ea1d 2026-07-09)" },
  { at: 187, subject: "feat(shape): read discriminators as tagged enums", scale: { cpu: 1.11, "peak rss": 1.06 }, only: ["okta"] },
  { at: 203, subject: "fix(codegen): drop the unused From impls for tagged enums", scale: { cpu: 0.93 }, only: ["okta"] },
];

// The compile-cost suite mirrors progeny's `customSmallerIsBetter` output: one entry per document
// and metric, named `<document>.<strategy> <metric>`.
const DOCUMENTS = [
  { name: "petstore-31", cpu: 0.68, rss: 334 },
  { name: "oxide", cpu: 9.0, rss: 1251 },
  { name: "okta", cpu: 26.3, rss: 3012 },
];

// The throughput suite mirrors a `cargo bench` suite: names without a metric part, one shared unit.
const PARSERS = [
  { name: "parse/petstore-31", ns: 41_800 },
  { name: "parse/oxide", ns: 2_310_000 },
  { name: "parse/okta", ns: 5_870_000 },
  { name: "resolve/okta", ns: 3_140_000 },
];

const factors = new Map();
const factor = (key) => factors.get(key) ?? 1;
const applyEvent = (event, document, metric) => {
  if (event.only && !event.only.includes(document)) return;
  const scale = event.scale[metric];
  if (scale) factors.set(`${document} ${metric}`, factor(`${document} ${metric}`) * scale);
};

const compile = [];
const throughput = [];
let toolchain = "rustc 1.94.1 (e408947bf 2026-03-25)";
let time = START;

for (let run = 0; run < RUNS; run += 1) {
  const event = EVENTS.find((e) => e.at === run);
  for (const document of [...DOCUMENTS.map((d) => d.name), ...PARSERS.map((p) => p.name)]) {
    for (const metric of ["cpu", "peak rss", "ns/iter"]) {
      if (event) applyEvent(event, document.replace(/^(parse|resolve)\//, ""), metric);
    }
  }
  if (event?.toolchain) toolchain = event.toolchain;

  // Pushes to main cluster on weekdays, a few hours apart.
  time += Math.round(random() < 0.35 ? DAY * (1 + Math.floor(random() * 2)) : 3_600_000 * (1 + random() * 7));
  const author = pick(AUTHORS);
  const id = hex(40);
  const subject = event?.subject ?? pick(SUBJECTS);
  const commit = {
    author,
    committer: { email: "noreply@github.com", name: "GitHub", username: "web-flow" },
    distinct: true,
    id,
    message: `${subject} (#${100 + run})${random() < 0.3 ? `\n\n${pick(BODIES)}` : ""}`,
    timestamp: new Date(time - 600_000).toISOString().replace("Z", "+00:00"),
    tree_id: hex(40),
    url: `${REPO}/commit/${id}`,
  };
  const date = time;

  const benches = [];
  for (const doc of DOCUMENTS) {
    // Runner noise is a little over 1% on CPU time and well under that on peak RSS.
    const cpu = doc.cpu * factor(`${doc.name} cpu`) * (1 + gauss() * 0.012);
    const rss = doc.rss * factor(`${doc.name} peak rss`) * (1 + gauss() * 0.003);
    const extra = `3 kept, 0 discarded, ${toolchain}`;
    benches.push(
      { name: `${doc.name}.hand-written cpu`, value: cpu, range: `± ${(cpu * 0.004).toFixed(2)}`, unit: "s", extra },
      { name: `${doc.name}.hand-written peak rss`, value: rss, range: `± ${(rss * 0.001).toFixed(1)}`, unit: "MiB", extra },
    );
  }
  compile.push({ commit, date, tool: "customSmallerIsBetter", benches });

  throughput.push({
    commit,
    date: date + 120_000,
    tool: "cargo",
    benches: PARSERS.map((p) => {
      const key = p.name.replace(/^(parse|resolve)\//, "");
      const value = Math.round(p.ns * factor(`${key} ns/iter`) * (1 + gauss() * 0.02));
      return { name: p.name, value, range: `± ${Math.round(value * 0.015)}`, unit: "ns/iter" };
    }),
  });
}

const data = {
  lastUpdate: time + 180_000,
  repoUrl: REPO,
  entries: {
    "Generated-crate compile cost": compile,
    "Parser throughput": throughput,
  },
};

const out = join(dirname(fileURLToPath(import.meta.url)), "data.js");
writeFileSync(out, `window.BENCHMARK_DATA = ${JSON.stringify(data, null, 2)}\n`);
console.log(`wrote ${RUNS} runs to ${out}`);
