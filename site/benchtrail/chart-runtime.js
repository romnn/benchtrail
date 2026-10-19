// The chart runtime: every ECharts instance on the page, from creation to disposal, and the links
// between them, so zoom and the hover crosshair move all charts together.
// It owns each chart's observers, drag listeners, frames, and timers, and unmounting a chart ends
// all of them, so a chart that left the page can never act on it again.
// It changes nothing about what the page shows; it reports gestures to the page, which decides.

import { h } from "./dom.js";

/** @typedef {import("echarts").ECharts} Instance */
/** @typedef {import("./core/view.js").View} View */

/**
 * What the runtime needs from the page.
 * @typedef {object} Host
 * @property {() => View} view
 * @property {() => import("./core/link.js").AxisKey} axis
 * @property {() => { start: number, end: number }} zoom the zoom window in percent of the x axis
 * @property {() => { first: number, last: number }} window the positions of the first and last run in the zoom window
 * @property {(j: number) => number} percentOfRun a run position's place on the x axis, in percent
 * @property {(chart: Chart) => object} refit the value axis for a chart's zoomed runs, applied with each zoom
 * @property {(start: number, end: number) => void} zoomed a gesture moved the zoom window
 * @property {(j: number | null) => void} hovered the pointer is over a run, or left the charts
 * @property {(j: number) => void} selected a click chose a run
 * @property {(error: unknown) => void} fail
 */

/**
 * A metric chart as the runtime keeps it; the page may add its own fields.
 * @typedef {{ dom: HTMLElement, instance: Instance }} Chart
 */

// A sideways drag shorter than this, in pixels, is a click.
const DRAG_MIN = 5;

/**
 * @param {typeof import("echarts")} echarts
 * @param {Host} host
 */
export function createRuntime(echarts, host) {
  /** @type {Instance | null} */
  let trail = null;
  /** @type {Set<Chart>} */
  const charts = new Set();
  /** @type {Map<Instance, () => void>} */
  const teardowns = new Map();

  // Runs a handler so that an error inside it is reported instead of escaping into the chart
  // library, where it could interrupt the library's own event dispatch.
  /**
   * @template {unknown[]} A
   * @param {(...args: A) => void} handler
   * @returns {(...args: A) => void}
   */
  const safely =
    (handler) =>
    (...args) => {
      try {
        handler(...args);
      } catch (error) {
        host.fail(error);
      }
    };
  /** @param {() => void} update */
  const guarded = (update) => safely(update)();

  const all = () => [trail, ...[...charts].map((chart) => chart.instance)].filter((instance) => instance !== null && !instance.isDisposed());

  // Mounting

  /**
   * @param {HTMLElement} dom
   * @returns {Instance}
   */
  function create(dom) {
    const instance = echarts.init(dom, null, { renderer: "svg" });
    const size = observeSize(dom, instance);
    const drag = wireDragZoom(dom, instance);
    // The event carries the window, which avoids cloning every chart's option through getOption.
    instance.on(
      "datazoom",
      safely((/** @type {any} */ event) => {
        if (syncingZoom) return;
        const moved = event.batch?.[0] ?? event;
        if (!Number.isFinite(moved.start) || !Number.isFinite(moved.end)) return;
        host.zoomed(moved.start, moved.end);
        syncZoom(instance);
      }),
    );
    instance.on(
      "updateAxisPointer",
      safely((/** @type {any} */ event) => {
        if (syncingPointer) return;
        const x = event.axesInfo?.find((/** @type {any} */ info) => info.axisDim === "x")?.value;
        if (x === undefined) return;
        const j = indexAtX(x);
        host.hovered(j);
        syncPointer(instance, j);
      }),
    );
    instance.getZr().on(
      "globalout",
      safely(() => {
        host.hovered(null);
        syncPointer(instance, null);
      }),
    );
    instance.getZr().on(
      "click",
      safely((/** @type {any} */ event) => {
        // The click that ends a drag has already zoomed, so it selects nothing.
        if (drag.justZoomed()) return;
        selectAtPixel(instance, event);
      }),
    );
    teardowns.set(instance, () => {
      size.disconnect();
      drag.dispose();
    });
    return instance;
  }

  /**
   * @param {Instance} instance
   */
  function dispose(instance) {
    teardowns.get(instance)?.();
    teardowns.delete(instance);
    if (!instance.isDisposed()) instance.dispose();
  }

  // Resizes a chart when its box changes size, and only then, so a layout change caused by the
  // resize itself cannot feed back into another one.
  /**
   * @param {HTMLElement} dom
   * @param {Instance} instance
   */
  function observeSize(dom, instance) {
    let size = "";
    const observer = new ResizeObserver(
      safely(() => {
        const next = `${dom.clientWidth}x${dom.clientHeight}`;
        if (next === size || instance.isDisposed()) return;
        size = next;
        instance.resize();
      }),
    );
    observer.observe(dom);
    return observer;
  }

  // Selection

  // Maps an x-axis value to a run position: a category index, or the nearest run in date mode.
  /** @param {unknown} x */
  function indexAtX(x) {
    const runs = host.view().runs;
    if (host.axis() !== "date") return Math.round(Number(x));
    let index = 0;
    for (let j = 1; j < runs.length; j += 1) {
      if (Math.abs(runs[j].date - Number(x)) < Math.abs(runs[index].date - Number(x))) index = j;
    }
    return index;
  }

  /**
   * @param {Instance} instance
   * @param {{ offsetX: number, offsetY: number }} event
   */
  function selectAtPixel(instance, event) {
    const point = [event.offsetX, event.offsetY];
    if (!instance.containPixel({ gridIndex: 0 }, point)) return;
    const x = /** @type {unknown[] | undefined} */ (instance.convertFromPixel({ gridIndex: 0 }, point))?.[0];
    if (x === undefined || Number.isNaN(Number(x))) return;
    host.selected(indexAtX(x));
  }

  // Pointer

  // Moves the crosshair of every other chart to the same run, or hides it, so hovering one chart
  // reads across the page.
  // The charts are linked by hand rather than through an ECharts group, whose own zoom relay would
  // echo the zoom sync below without end.
  // Broadcasts are coalesced to one per frame, and each chart's crosshair is placed by the run's
  // position on its axis rather than by a point of one series, which may have no value there.
  // A request remembers the view it was made in, since a run position means nothing in another.
  // A broadcast is skipped only when both the run and the source chart are unchanged, because the
  // chart the pointer just left hid its own crosshair and needs it back.
  let syncingPointer = false;
  /** @type {number | null} */
  let pointerAt = null;
  /** @type {Instance | null} */
  let pointerFrom = null;
  let pointerFrame = 0;
  /** @type {{ source: Instance, view: View, j: number | null } | null} */
  let pointerRequest = null;

  /**
   * @param {Instance} source
   * @param {number | null} j
   */
  function syncPointer(source, j) {
    const view = host.view();
    pointerRequest = { source, view, j: j !== null && Number.isInteger(j) && view.runs[j] ? j : null };
    if (pointerFrame) return;
    pointerFrame = requestAnimationFrame(
      safely(() => {
        pointerFrame = 0;
        const request = pointerRequest;
        pointerRequest = null;
        if (!request || request.view !== host.view()) return;
        const { source: from, j: at } = request;
        if (at === pointerAt && from === pointerFrom) return;
        pointerAt = at;
        pointerFrom = from;
        // Charts scrolled out of view are skipped, and catch up when they come back into view.
        for (const instance of all()) {
          if (instance !== from && (instance === trail || onScreen.has(instance.getDom()))) placePointer(instance, at);
        }
      }),
    );
  }

  // Moves one chart's crosshair to a run, or hides it.
  /**
   * @param {Instance} instance
   * @param {number | null} at
   */
  function placePointer(instance, at) {
    const run = at === null ? undefined : host.view().runs[at];
    syncingPointer = true;
    try {
      guarded(() => {
        if (!run) {
          instance.dispatchAction({ type: "updateAxisPointer", currTrigger: "leave" });
          instance.dispatchAction({ type: "hideTip" });
          return;
        }
        const x = instance.convertToPixel({ xAxisIndex: 0 }, host.axis() === "date" ? run.date : `r${run.index}`);
        if (Number.isFinite(x)) instance.dispatchAction({ type: "showTip", x, y: instance.getHeight() / 2 });
      });
    } finally {
      syncingPointer = false;
    }
  }

  // Forgets pending and shown crosshair positions, which belong to the view they were made in.
  function cancelPointer() {
    cancelAnimationFrame(pointerFrame);
    pointerFrame = 0;
    pointerRequest = null;
    pointerAt = null;
    pointerFrom = null;
  }

  // Zoom

  // Applies the zoom window to every other chart, so the trail's slider, a drag in any chart, and a
  // zoom gesture all move the whole page together.
  // Updates are coalesced to one per frame with the latest window, and each chart gets a single
  // silent setOption carrying both its window and its refitted value axis: silent updates emit no
  // datazoom events, so the sync cannot echo, and a continuous gesture costs one pass per frame.
  let syncingZoom = false;
  let zoomFrame = 0;
  /** @type {Instance | null} */
  let zoomSource = null;
  let appliedZoom = "";
  /** @type {Set<Chart>} */
  const pendingZoom = new Set();
  let offscreenTimer = 0;

  /** @param {Instance | null} source the chart whose own gesture moved the window, if any */
  function syncZoom(source) {
    zoomSource = source;
    if (zoomFrame) return;
    zoomFrame = requestAnimationFrame(
      safely(() => {
        zoomFrame = 0;
        const { start, end } = host.zoom();
        const key = `${start}|${end}|${charts.size}`;
        if (key === appliedZoom) return;
        appliedZoom = key;
        // A gesture on a chart moves its own window, but its value axis still needs refitting.
        pendingZoom.clear();
        const window = { start, end };
        syncingZoom = true;
        try {
          if (trail && !trail.isDisposed() && trail !== zoomSource) {
            const shown = trail;
            guarded(() => shown.setOption({ dataZoom: [window, window] }, { silent: true }));
          }
          // Charts on screen follow every frame; those scrolled out of view catch up once the
          // gesture pauses, since nobody sees them move.
          for (const chart of charts) {
            if (onScreen.has(chart.dom)) applyZoom(chart, window);
            else pendingZoom.add(chart);
          }
        } finally {
          syncingZoom = false;
        }
        clearTimeout(offscreenTimer);
        offscreenTimer = setTimeout(
          safely(() => {
            for (const chart of pendingZoom) applyZoom(chart, host.zoom());
            pendingZoom.clear();
          }),
          200,
        );
      }),
    );
  }

  /**
   * @param {Chart} chart
   * @param {{ start: number, end: number }} window
   */
  function applyZoom(chart, window) {
    const instance = chart.instance;
    if (instance.isDisposed()) return;
    /** @type {Record<string, unknown>} */
    const option = { yAxis: host.refit(chart) };
    if (instance !== zoomSource) option.dataZoom = [window];
    guarded(() => instance.setOption(option, { silent: true }));
  }

  // The chart boxes currently on screen, kept by one observer for all charts.
  /** @type {Set<Element>} */
  const onScreen = new Set();
  const screenObserver = new IntersectionObserver(
    safely((/** @type {IntersectionObserverEntry[]} */ entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          onScreen.delete(entry.target);
          continue;
        }
        onScreen.add(entry.target);
        // A chart coming into view takes up the crosshair it missed while away.
        const instance = [...charts].find((chart) => chart.dom === entry.target)?.instance;
        if (instance && !instance.isDisposed() && instance !== pointerFrom) placePointer(instance, pointerAt);
      }
    }),
  );

  // Dragging

  // Dragging across a plot zooms every chart to the runs it covers; a faint band follows the
  // pointer meanwhile, and a double click shows all runs again.
  // The plot allows vertical page scrolling on touch screens, so only a sideways drag zooms.
  /**
   * @param {HTMLElement} dom
   * @param {Instance} instance
   */
  function wireDragZoom(dom, instance) {
    /** @type {number | null} */
    let from = null;
    /** @type {number | null} */
    let pointer = null;
    /** @type {HTMLElement | null} */
    let band = null;
    let zoomedAt = 0;
    const x = (/** @type {PointerEvent} */ event) => event.clientX - dom.getBoundingClientRect().left;
    const y = (/** @type {PointerEvent} */ event) => event.clientY - dom.getBoundingClientRect().top;

    // Moves and the release are followed on the window, so a drag that leaves the chart still ends
    // where the pointer is let go, while a plain click still reaches the chart and selects a run.
    // Every way a drag can end removes those listeners: release, cancellation, losing focus, and
    // the chart being removed.
    const cancel = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      from = null;
      pointer = null;
      band?.remove();
      band = null;
    };
    const move = safely((/** @type {PointerEvent} */ event) => {
      if (from === null || event.pointerId !== pointer || Math.abs(x(event) - from) < DRAG_MIN) return;
      band ??= dom.appendChild(h("div", { class: "drag-band", "aria-hidden": "true" }));
      const left = Math.max(0, Math.min(from, x(event)));
      band.style.left = `${left}px`;
      band.style.width = `${Math.min(dom.clientWidth, Math.max(from, x(event))) - left}px`;
    });
    const up = safely((/** @type {PointerEvent} */ event) => {
      if (event.pointerId !== pointer) return;
      const start = from;
      const end = Math.max(0, Math.min(dom.clientWidth, x(event)));
      cancel();
      if (start === null || Math.abs(end - start) < DRAG_MIN || instance.isDisposed()) return;
      const top = instance.getHeight() / 2;
      const runAt = (/** @type {number} */ px) => {
        const value = /** @type {unknown[] | undefined} */ (instance.convertFromPixel({ gridIndex: 0 }, [px, top]))?.[0];
        return value === undefined || Number.isNaN(Number(value)) ? null : indexAtX(value);
      };
      const last = host.view().runs.length - 1;
      const clamp = (/** @type {number} */ j) => Math.min(last, Math.max(0, j));
      const a = runAt(Math.min(start, end));
      const b = runAt(Math.max(start, end));
      if (a === null || b === null || clamp(b) <= clamp(a)) return;
      zoomedAt = performance.now();
      instance.dispatchAction({ type: "dataZoom", start: host.percentOfRun(clamp(a)), end: host.percentOfRun(clamp(b)) });
    });
    const down = safely((/** @type {PointerEvent} */ event) => {
      if (event.button !== 0 || !instance.containPixel({ gridIndex: 0 }, [x(event), y(event)])) return;
      cancel();
      from = x(event);
      pointer = event.pointerId;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("blur", cancel);
    });
    const reset = safely(() => {
      if (!instance.isDisposed()) instance.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
    });
    dom.addEventListener("pointerdown", down);
    dom.addEventListener("dblclick", reset);
    return {
      justZoomed: () => performance.now() - zoomedAt < 300,
      dispose: () => {
        cancel();
        dom.removeEventListener("pointerdown", down);
        dom.removeEventListener("dblclick", reset);
      },
    };
  }

  return {
    /**
     * The trail, which carries the zoom slider; created once and kept.
     * @param {HTMLElement} dom
     */
    trail(dom) {
      trail ??= create(dom);
      return trail;
    },
    /**
     * Mounts a metric chart in its box, which the page has placed.
     * @template {{ dom: HTMLElement }} T
     * @param {T} chart
     * @returns {T & Chart}
     */
    mount(chart) {
      const mounted = Object.assign(chart, { instance: create(chart.dom) });
      charts.add(mounted);
      screenObserver.observe(chart.dom);
      return mounted;
    },
    /**
     * Ends everything a metric chart started: its instance, observers, listeners, and pending zoom.
     * @param {Chart} chart
     */
    unmount(chart) {
      charts.delete(chart);
      pendingZoom.delete(chart);
      screenObserver.unobserve(chart.dom);
      onScreen.delete(chart.dom);
      dispose(chart.instance);
    },
    /**
     * Ends the trail with everything it started, including a drag of its slider, which the chart
     * library follows on the document; the next `trail` call creates it afresh.
     */
    dropTrail() {
      if (trail) dispose(trail);
      trail = null;
    },
    syncZoom,
    // New charts are drawn with the current window, so the next sync must reach all of them.
    redrawn() {
      appliedZoom = "";
    },
    cancelPointer,
  };
}
