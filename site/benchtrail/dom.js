// Page elements built from data: every value reaches the DOM as text or as a checked attribute,
// never as markup.

import { changeParts } from "./core/format.js";

// Builds an element; text children become text nodes, so data never reaches the DOM as markup.
export function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    element.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return element;
}

// Thin stroked chevrons, drawn rather than typed, so every arrow on the page has one weight and
// sits on the text's baseline in every font.
const ICONS = {
  up: "M4 10l4-4 4 4",
  down: "M4 6l4 4 4-4",
  left: "M10 3.5 5.5 8l4.5 4.5",
  right: "M6 3.5 10.5 8 6 12.5",
};

// A gear of eight teeth around a hub, generated so its geometry stays exact at any size.
ICONS.gear = (() => {
  const teeth = 8;
  const points = [];
  for (let i = 0; i < teeth * 4; i += 1) {
    const angle = (i / (teeth * 4)) * Math.PI * 2 - Math.PI / 2;
    const radius = i % 4 < 2 ? 6.6 : 5.1;
    points.push(`${(8 + radius * Math.cos(angle)).toFixed(2)} ${(8 + radius * Math.sin(angle)).toFixed(2)}`);
  }
  return `M${points.join("L")}ZM8 5.8a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 1 0 0-4.4`;
})();

export function icon(name, extraClass = "") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("class", `icon ${extraClass}`.trim());
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

// A significant change leads with an arrow in its direction, so color is never its only cue.
export function changeElement(ratio, kind) {
  const { text, arrow, label } = changeParts(ratio, kind);
  return h("span", { class: `change ${kind}`, title: label }, arrow ? icon(arrow) : null, text);
}

export function lineKey(style) {
  return h("span", {
    class: style.dash === "solid" ? "line-key" : `line-key ${style.dash}`,
    style: `--key: ${style.slot === null ? "var(--ink-2)" : `var(--s${style.slot + 1})`}`,
    "aria-hidden": "true",
  });
}
