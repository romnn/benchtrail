// The page header: the project's name, the suite and section tabs, the filters and their menus,
// and the settings panel with the theme.

import { formatDate } from "../core/format.js";
import { safeUrl } from "../core/history.js";
import { MISSING } from "../core/identity.js";
import { AXES, admits, RANGES, SCALES, SMOOTHING } from "../core/link.js";
import { only } from "../core/selection.js";
import { colorable, DASHES, dashable, SLOTS, sectionRef } from "../core/view.js";
import { h, icon, lineKey } from "../dom.js";

const READOUTS = [
  { key: "basic", label: "Value and change" },
  { key: "detailed", label: "With spread and baseline" },
];
// The theme follows the system unless the reader picks one, which is remembered in this browser.
const THEMES = [
  { key: "system", label: "System" },
  { key: "light", label: "Light" },
  { key: "dark", label: "Dark" },
];

/** @param {import("./page.js").Page} page */
export function headerRegion(page) {
  // The open filter menu, as { key, focus, query, scroll }, or null, and whether the settings panel
  // is open.
  let menu = null;
  let settingsOpen = false;

  function renderMasthead() {
    const repo = safeUrl(page.data.repoUrl);
    const path = repo ? new URL(repo).pathname.split("/").filter(Boolean) : [];
    const name = page.config.title ?? (path.slice(-2).join("/") || "Benchmarks");
    const anchor = /** @type {HTMLAnchorElement} */ (document.getElementById("project-link"));
    anchor.textContent = name;
    if (repo) anchor.href = repo;
    document.title = name;
  }

  function renderSummary() {
    const runs = page.suite.runs;
    const count = `${runs.length} ${runs.length === 1 ? "run" : "runs"}`;
    const span = runs.length === 1 ? formatDate(runs[0].date, true) : `${formatDate(runs[0].date, true)} – ${formatDate(runs.at(-1).date, true)}`;
    document.getElementById("summary").textContent = `${count}, ${span}`;
  }

  function renderSuites() {
    const nav = document.getElementById("suites");
    nav.hidden = page.suites.length < 2;
    nav.replaceChildren(
      ...page.suites.map((s) =>
        h(
          "button",
          {
            type: "button",
            class: "option",
            role: "tab",
            "aria-selected": String(s === page.suite),
            onclick: () => {
              if (s === page.suite) return;
              page.dispatch({ type: "suite", suite: s.name });
            },
          },
          s.name,
        ),
      ),
    );

    const sections = document.getElementById("sections");
    sections.hidden = page.suite.sections.length < 2;
    sections.replaceChildren(
      ...page.suite.sections.map((s) =>
        h(
          "button",
          {
            type: "button",
            class: "option",
            role: "tab",
            "aria-selected": String(s === page.section),
            onclick: () => {
              if (s === page.section) return;
              page.dispatch({ type: "section", section: sectionRef(s) });
            },
          },
          s.label,
        ),
      ),
    );
  }

  function renderFilters() {
    segmented("range", RANGES, page.link.range, (key) => page.dispatch({ type: "range", range: key }));
    segmented("scale", SCALES, page.link.scale, (key) => page.dispatch({ type: "set", changes: { scale: key } }));
    // The window names runs, so a change of axis keeps the same runs in view.
    segmented("axis", AXES, page.link.axis, (key) => page.dispatch({ type: "set", changes: { axis: key } }));
    segmented("smooth", SMOOTHING, page.smoothing(), (key) => page.dispatch({ type: "set", changes: { smoothing: { kind: "explicit", window: key } } }));
    renderTheme();
    segmented("readout", READOUTS, page.link.more ? "detailed" : "basic", (key) => page.dispatch({ type: "set", changes: { more: key === "detailed" } }));

    // Color and dash choices list the dimensions with few enough values to style apart, the same
    // ones the pivot accepts, plus none.
    const varying = page.section.dims.filter((d) => d.varying);
    const colorDim = varying.find((d) => d.key === page.view.pivot.color);
    const choices = (dims) => [...dims.map((d) => ({ key: d.key, label: d.label })), { key: "", label: "None" }];
    const colorChoices = varying.filter(colorable);
    const dashChoices = varying.filter((d) => d.key !== page.view.pivot.color && dashable(d, colorDim));
    document.getElementById("color-group").hidden = colorChoices.length === 0;
    segmented("color", choices(colorChoices), page.view.pivot.color ?? "", (key) =>
      page.dispatch({ type: "set", changes: { color: key ? { kind: "by", key } : { kind: "none" } } }),
    );
    document.getElementById("dash-group").hidden = dashChoices.length === 0 || !page.view.pivot.color;
    segmented("dash", choices(dashChoices), page.view.pivot.dash ?? "", (key) =>
      page.dispatch({ type: "set", changes: { dash: key ? { kind: "by", key } : { kind: "none" } } }),
    );

    // Each filter is a list of values that can be toggled, each named by its link id.
    // The color and dash dimensions stay inline, since their rows double as the legend; every other
    // filter collapses into a menu, so the header stays one or two lines however many dimensions
    // a suite has.
    const filters = [];
    if (page.section.metrics.length > 1) {
      filters.push({
        key: "\u0000metric",
        label: "Metric",
        inline: page.section.metrics.length <= 4,
        items: page.section.metrics.map((metric) => ({ id: metric.slug, text: metric.label, style: null })),
        filtered: page.link.metrics.kind === "only",
        shown: (id) => admits(page.link.metrics, id),
        show: (selected) => page.dispatch({ type: "metrics", metrics: selected === "all" ? { kind: "all" } : only(selected) }),
      });
    }
    for (const d of page.section.dims.filter((d) => d.values.length > 1)) {
      const legend = d.key === page.view.pivot.color || d.key === page.view.pivot.dash;
      const style = (value) => {
        if (d.key === page.view.pivot.color) return { slot: value.index % SLOTS, dash: !page.view.pivot.dash && value.index >= SLOTS ? "dashed" : "solid" };
        if (d.key === page.view.pivot.dash) return { slot: null, dash: DASHES[value.index % DASHES.length] };
        return null;
      };
      filters.push({
        key: d.key,
        label: d.label,
        inline: legend,
        items: d.values.map((value) => ({ id: value.param, text: value.token === MISSING ? "none" : value.text, style: style(value) })),
        filtered: page.link.dimensions.has(d.key),
        shown: (id) => admits(page.link.dimensions.get(d.key), id),
        show: (selected) => page.dispatch({ type: "dimension", key: d.key, filter: selected === "all" ? { kind: "all" } : only(selected) }),
      });
    }
    // Inline rows first, so the legend keeps its place while menus are opened and closed.
    filters.sort((a, b) => b.inline - a.inline);
    document.getElementById("filters").replaceChildren(...filters.map((filter) => (filter.inline ? inlineFilter(filter) : menuFilter(filter))));
    if (menu) restoreMenu();
  }

  // The ids a filter shows after toggling one of them, in the filter's own order, so one selection
  // always reads as the same link.
  function toggled(filter, id) {
    return filter.items.map((item) => item.id).filter((other) => (other === id ? !filter.shown(other) : filter.shown(other)));
  }

  function inlineFilter(filter) {
    return h(
      "div",
      { class: "filter", role: "group", "aria-label": filter.label },
      h("span", { class: "filter-label" }, filter.label),
      // The chips wrap in their own box, so a second line hangs under the first chip, not the label.
      h(
        "span",
        { class: "chips" },
        ...filter.items.map((item) => toggleChip(item.text, filter.shown(item.id), item.style, () => filter.show(toggled(filter, item.id)))),
        // A filtered row offers to show every value again, including values recorded later.
        filter.filtered ? h("button", { type: "button", class: "option chips-all", onclick: () => filter.show("all") }, "Show all") : null,
      ),
    );
  }

  // A menu button that summarizes the selection, over a panel of checkboxes.
  // Each value also has an "only" action, since narrowing to one value is the common case.
  // The page re-renders on every change, so the open menu, its search text, and its focus live in
  // state and are restored afterwards.
  function menuFilter(filter) {
    const total = filter.items.length;
    const visible = filter.items.filter((item) => filter.shown(item.id));
    // An explicit list of every value reads as a count, apart from the filter for all values.
    const summary = !filter.filtered
      ? "all"
      : visible.length === 0
        ? "none"
        : visible.length <= 2
          ? visible.map((item) => item.text).join(", ")
          : `${visible.length} of ${total}`;
    const open = menu?.key === filter.key;
    const apply = (selected, focus) => {
      const panel = document.querySelector(`.menu[data-menu="${CSS.escape(filter.key)}"] .menu-panel`);
      menu = { ...menu, key: filter.key, focus, scroll: panel?.scrollTop ?? 0 };
      filter.show(selected);
    };

    const button = h(
      "button",
      {
        type: "button",
        class: "menu-button option",
        "aria-expanded": String(open),
        "aria-haspopup": "true",
        onclick: () => {
          // Opening or closing a menu changes no data, so only the filters are drawn again.
          menu = open ? null : { key: filter.key, focus: null, query: "", scroll: 0 };
          renderFilters();
        },
      },
      h("span", { class: "filter-label" }, filter.label),
      h("span", { class: "menu-summary" }, summary),
      icon("down", "chevron"),
    );
    if (!open) return h("div", { class: "menu", "data-menu": filter.key }, button);

    const search =
      total > 10
        ? h("input", {
            class: "search menu-search",
            type: "search",
            placeholder: `Filter ${filter.label.toLowerCase()}`,
            "aria-label": `Filter ${filter.label} values`,
            "data-focus": "\u0000search",
            oninput: (event) => {
              menu.query = event.target.value;
              filterMenuItems(event.target.closest(".menu"));
            },
          })
        : null;
    const all = filter.filtered
      ? h(
          "button",
          {
            type: "button",
            class: "option menu-all",
            "data-focus": "\u0000all",
            onclick: () => apply("all", "\u0000all"),
          },
          "Show all",
        )
      : null;
    const items = filter.items.map((item) => {
      const id = `menu-${encodeURIComponent(filter.key)}-${encodeURIComponent(item.id)}`;
      return h(
        "div",
        { class: "menu-item", "data-text": item.text.toLowerCase() },
        h("input", {
          type: "checkbox",
          id,
          checked: filter.shown(item.id),
          "data-focus": item.id,
          onchange: () => apply(toggled(filter, item.id), item.id),
        }),
        h("label", { for: id }, item.style ? lineKey(item.style) : null, item.text),
        h(
          "button",
          {
            type: "button",
            class: "only",
            "aria-label": `Show only ${item.text}`,
            "data-focus": `\u0000only\u0000${item.id}`,
            onclick: () => apply(new Set([item.id]), item.id),
          },
          "only",
        ),
      );
    });
    const panel = h("div", { class: "menu-panel", role: "group", "aria-label": filter.label }, search, all, h("div", { class: "menu-items" }, ...items));
    return h("div", { class: "menu", "data-menu": filter.key }, button, panel);
  }

  function filterMenuItems(element) {
    const query = (menu?.query ?? "").trim().toLowerCase();
    for (const item of element.querySelectorAll(".menu-item")) item.hidden = Boolean(query) && !item.dataset.text.includes(query);
  }

  // Restores the open menu after a render: its search text, its focus, and a position that keeps
  // the panel inside the viewport.
  function restoreMenu() {
    const element = [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".menu"))].find((m) => m.dataset.menu === menu.key);
    if (!element) {
      menu = null;
      return;
    }
    const search = /** @type {HTMLInputElement | null} */ (element.querySelector(".menu-search"));
    if (search) {
      search.value = menu.query ?? "";
      filterMenuItems(element);
    }
    const panel = /** @type {HTMLElement} */ (element.querySelector(".menu-panel"));
    const overflow = panel.getBoundingClientRect().right - (document.documentElement.clientWidth - 16);
    if (overflow > 0) panel.style.left = `${-overflow}px`;
    panel.scrollTop = menu.scroll ?? 0;
    const focus = menu.focus;
    const focusable = /** @type {NodeListOf<HTMLElement>} */ (element.querySelectorAll("[data-focus]"));
    const target = [...focusable].find((el) => el.dataset.focus === focus) ?? search ?? element.querySelector("input");
    target?.focus({ preventScroll: true });
  }

  function closeMenu(returnFocus) {
    if (!menu) return;
    const key = menu.key;
    menu = null;
    renderFilters();
    if (returnFocus)
      /** @type {HTMLElement | null | undefined} */ (
        [.../** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(".menu"))].find((m) => m.dataset.menu === key)?.querySelector(".menu-button")
      )?.focus();
  }

  function segmented(id, options, current, onChange) {
    document.getElementById(id).replaceChildren(
      ...options.map((option) =>
        h(
          "button",
          {
            type: "button",
            class: "option",
            role: "radio",
            "aria-checked": String(option.key === current),
            onclick: () => option.key !== current && onChange(option.key),
          },
          option.label,
        ),
      ),
    );
  }

  function toggleChip(label, pressed, style, onClick) {
    const children = style ? [lineKey(style), label] : [label];
    return h("button", { type: "button", class: "option", "aria-pressed": String(pressed), onclick: onClick }, ...children);
  }

  function renderTheme() {
    const current = document.documentElement.dataset.theme ?? "system";
    segmented("theme", THEMES, current, (choice) => {
      if (choice === "system") delete document.documentElement.dataset.theme;
      else document.documentElement.dataset.theme = choice;
      try {
        if (choice === "system") localStorage.removeItem("benchtrail:theme");
        else localStorage.setItem("benchtrail:theme", choice);
      } catch {
        // Storage can be unavailable in private windows; the choice then lasts for this visit.
      }
      if (page.view) page.render();
      else renderTheme();
    });
  }

  function wireTheme() {
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (page.view && !document.documentElement.dataset.theme) page.render();
    });
    renderTheme();
  }

  // The settings panel opens from the gear in the header and closes on Escape or a click outside,
  // like the filter menus.
  function wireSettings() {
    const toggle = document.getElementById("settings-toggle");
    const panel = document.getElementById("settings");
    toggle.replaceChildren(icon("gear"));
    const set = (open) => {
      settingsOpen = open;
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
    };
    toggle.addEventListener("click", () => set(!settingsOpen));
    document.addEventListener("click", (event) => {
      const target = /** @type {Element} */ (event.target);
      if (settingsOpen && target.isConnected && !target.closest(".settings")) set(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && settingsOpen) {
        set(false);
        toggle.focus();
      }
    });
    set(false);
  }

  // A click outside the open menu closes it, and so does Escape.
  // A click inside can re-render the menu, which detaches the clicked node, so those are skipped.
  function wire() {
    wireSettings();
    document.addEventListener("click", (event) => {
      const target = /** @type {Element} */ (event.target);
      if (!menu || !target.isConnected || target.closest(".menu")) return;
      closeMenu(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && menu) closeMenu(true);
    });
  }

  // A new section closes its filter menu.
  function reset() {
    menu = null;
  }

  // The tabs, filters, and summary follow the view; the masthead is drawn once, at boot.
  function render() {
    renderSuites();
    renderFilters();
    renderSummary();
  }

  return { render, renderMasthead, wireTheme, wire, reset };
}
