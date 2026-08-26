import {
  getFramePressure,
  type PressureState,
} from "../core/frame-pressure/FramePressure";
import { getConductor } from "../core/conductor";
import { getAnimationBudget, type BudgetState } from "../core/animation-budget/AnimationBudget";

/**
 * The motion devtools overlay — a live readout of what the runtime is doing
 * to your frame.
 *
 * This exists because the runtime's whole value is invisible. "One rAF loop"
 * and "we shed decorative work under load" are claims until you can watch the
 * numbers move. It answers the question no component library can answer:
 * **which effect on this page is eating the frame?**
 *
 * Design constraints it holds itself to:
 * - Zero dependencies, zero framework. It is a DOM function; call it from a
 *   React effect, a Vue `onMounted`, or the console.
 * - Shadow DOM, so no page stylesheet can reach in and no style of ours can
 *   leak out.
 * - It refreshes at 5Hz and writes through `textContent` against nodes built
 *   once. A profiler that shows up in its own profile is a bad profiler —
 *   though it does list itself in the table rather than hiding.
 * - It subscribes as `decorative`, so it is shed before the work it measures.
 *   An instrument that outranks its subject distorts the reading.
 * - It is a separate entry point (`@vectorvesper/motion/devtools`), so it
 *   only reaches a bundle that explicitly imports it.
 */

export type DevtoolsCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export interface DevtoolsOptions {
  /** Where to dock the panel. Default `"bottom-right"`. */
  position?: DevtoolsCorner;
  /** Start with the subscriber table open. Default `true`. */
  expanded?: boolean;
  /** Refreshes per second. Default `5`. */
  hz?: number;
  /** Node to attach the host element to. Default `document.body`. */
  container?: HTMLElement;
}

const CORNER_CSS: Record<DevtoolsCorner, string> = {
  "top-left": "top:12px;left:12px;",
  "top-right": "top:12px;right:12px;",
  "bottom-left": "bottom:12px;left:12px;",
  "bottom-right": "bottom:12px;right:12px;",
};

const STYLE = `
:host { all: initial; }
.panel {
  position: fixed;
  z-index: 2147483000;
  width: 268px;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color: #e7e7ea;
  background: rgba(8, 8, 11, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  backdrop-filter: blur(8px);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  user-select: none;
}
.head {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 10px;
  cursor: pointer;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: #34d399; flex: none; }
.dot[data-tier="1"] { background: #fbbf24; }
.dot[data-tier="2"] { background: #f87171; }
.name { letter-spacing: 0.08em; text-transform: uppercase; font-size: 9px; color: #9b9ba4; flex: 1; }
.head-fps { font-variant-numeric: tabular-nums; color: #f2f2f5; }
.chev { color: #6b6b76; font-size: 9px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: rgba(255,255,255,0.06); }
.cell { background: #0b0b0f; padding: 7px 10px; }
.k { font-size: 8.5px; letter-spacing: 0.08em; text-transform: uppercase; color: #6b6b76; }
.v { font-size: 13px; font-variant-numeric: tabular-nums; color: #f2f2f5; }
.v small { font-size: 9px; color: #6b6b76; margin-left: 2px; }
.v[data-neg="1"] { color: #f87171; }
table { width: 100%; border-collapse: collapse; }
thead th {
  text-align: left; font-weight: 400; font-size: 8.5px;
  letter-spacing: 0.08em; text-transform: uppercase; color: #6b6b76;
  padding: 6px 10px 4px;
}
thead th.num, tbody td.num { text-align: right; }
tbody td {
  padding: 3px 10px; font-variant-numeric: tabular-nums;
  border-top: 1px solid rgba(255,255,255,0.05);
}
tbody td.label { color: #cfcfd6; max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
tbody td.cost { color: #f2f2f5; }
tbody tr[data-priority="decorative"] td.label { color: #8b8b95; }
tbody tr[data-priority="essential"] td.label { color: #a5d8ff; }
.pri { font-size: 8px; color: #6b6b76; }
.empty { padding: 10px; color: #6b6b76; }
.foot { padding: 6px 10px; color: #6b6b76; font-size: 9px; border-top: 1px solid rgba(255,255,255,0.08); }
.hidden { display: none; }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** One metric tile, returning the value node so the loop can write into it. */
function cell(grid: HTMLElement, key: string, unit?: string): HTMLElement {
  const wrap = el("div", "cell");
  const k = el("div", "k");
  k.textContent = key;
  const v = el("div", "v");
  const value = document.createTextNode("—");
  v.appendChild(value);
  if (unit) {
    const u = el("small");
    u.textContent = unit;
    v.appendChild(u);
  }
  wrap.append(k, v);
  grid.appendChild(wrap);
  // Return the container: the loop writes `firstChild.nodeValue` so the unit
  // suffix survives.
  return v;
}

function setValue(node: HTMLElement, text: string, negative = false): void {
  const first = node.firstChild;
  if (first) first.nodeValue = text;
  if (negative) node.setAttribute("data-neg", "1");
  else node.removeAttribute("data-neg");
}

/**
 * Mount the devtools overlay. Returns a function that removes it.
 *
 * ```ts
 * import { mountDevtools } from "@vectorvesper/motion/devtools";
 *
 * if (process.env.NODE_ENV !== "production") mountDevtools();
 * ```
 *
 * In React, call it from an effect and return the result:
 *
 * ```tsx
 * useEffect(() => mountDevtools({ position: "bottom-left" }), []);
 * ```
 */
export function mountDevtools(options: DevtoolsOptions = {}): () => void {
  if (typeof document === "undefined") return () => {};

  const position = options.position ?? "bottom-right";
  const hz = options.hz ?? 5;
  let expanded = options.expanded ?? true;

  const host = el("div");
  host.setAttribute("data-vv-devtools", "");
  const root = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = STYLE;

  const panel = el("div", "panel");
  panel.setAttribute("style", CORNER_CSS[position]);

  // ---- header -------------------------------------------------------------
  const head = el("div", "head");
  const dot = el("div", "dot");
  const name = el("div", "name");
  name.textContent = "vv-motion";
  const headFps = el("div", "head-fps");
  headFps.textContent = "—";
  const chev = el("div", "chev");
  head.append(dot, name, headFps, chev);

  // ---- metric tiles -------------------------------------------------------
  const grid = el("div", "grid");
  const vFps = cell(grid, "fps");
  const vFrame = cell(grid, "frame", "ms");
  const vWork = cell(grid, "runtime work", "ms");
  const vHeadroom = cell(grid, "headroom", "ms");
  const vTier = cell(grid, "tier");
  const vShed = cell(grid, "shed / frame");
  // Non-zero means the previous frame overran and this one starts already
  // spent — the reason low-priority work is being dropped.
  const vCarried = cell(grid, "carried", "ms");
  // Which region currently holds the foreground lease, if any.
  const vScope = cell(grid, "foreground");
  // What is eating the frame, when anything is. This is the tile that says
  // whether shedding our own work would help at all.
  const vPressure = cell(grid, "pressure");

  // ---- subscriber table ---------------------------------------------------
  const table = el("table");
  const thead = el("thead");
  const headRow = el("tr");
  for (const [text, cls] of [
    ["subscriber", ""],
    ["lane", ""],
    ["ms", "num"],
  ] as const) {
    const th = el("th", cls);
    th.textContent = text;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  const tbody = el("tbody");
  table.append(thead, tbody);

  const foot = el("div", "foot");
  foot.textContent = "—";

  panel.append(head, grid, table, foot);
  root.append(style, panel);
  (options.container ?? document.body).appendChild(host);

  const applyExpanded = () => {
    table.classList.toggle("hidden", !expanded);
    foot.classList.toggle("hidden", !expanded);
    grid.classList.toggle("hidden", !expanded);
    chev.textContent = expanded ? "▾" : "▸";
  };
  applyExpanded();

  const onToggle = () => {
    expanded = !expanded;
    applyExpanded();
  };
  head.addEventListener("click", onToggle);

  // Rows are created once per subscriber slot and reused; only text changes.
  interface Row {
    tr: HTMLTableRowElement;
    label: HTMLTableCellElement;
    lane: HTMLTableCellElement;
    cost: HTMLTableCellElement;
  }
  const rows: Row[] = [];

  const ensureRows = (n: number) => {
    while (rows.length < n) {
      const tr = el("tr");
      const label = el("td", "label");
      const lane = el("td", "pri");
      const cost = el("td", "num cost");
      tr.append(label, lane, cost);
      tbody.appendChild(tr);
      rows.push({ tr, label, lane, cost });
    }
    for (let i = n; i < rows.length; i++) rows[i].tr.classList.add("hidden");
    for (let i = 0; i < n; i++) rows[i].tr.classList.remove("hidden");
  };

  // Hold the governor open so tier and headroom are live rather than frozen
  // at their defaults, and keep the latest emission for the paint pass.
  let budget: BudgetState = getAnimationBudget().state;
  const releaseBudget = getAnimationBudget().subscribe((s) => {
    budget = s;
  });

  // Same for the pressure classifier — it only measures while something is
  // subscribed, so reading `.state` without holding it open would show a
  // permanently healthy page.
  let pressure: PressureState = getFramePressure().state;
  const releasePressure = getFramePressure().subscribe((s) => {
    pressure = s;
  });

  const paint = () => {
    const stats = getConductor().state;

    headFps.textContent = `${Math.round(stats.fps)}fps`;
    dot.setAttribute("data-tier", String(budget.tier));

    if (!expanded) return;

    setValue(vFps, String(Math.round(stats.fps)));
    setValue(vFrame, stats.frameMs.toFixed(1));
    setValue(vWork, stats.workMs.toFixed(2));
    setValue(vHeadroom, budget.headroom.toFixed(1), budget.headroom < 0);
    setValue(vTier, `${budget.tier} ${budget.label}`);
    setValue(vShed, String(stats.shedLastFrame));
    setValue(vCarried, stats.carriedOverrunMs.toFixed(1), stats.carriedOverrunMs > 0.5);
    setValue(
      vScope,
      stats.activeScopeLabel ?? stats.activeScope ?? "—",
      stats.activeScope !== null,
    );
    setValue(
      vPressure,
      pressure.source === "none"
        ? "—"
        : `${pressure.source} ${Math.round(pressure.confidence * 100)}%`,
      pressure.source !== "none" && pressure.source !== "unknown",
    );

    const subs = stats.subscribers;
    if (subs.length === 0) {
      ensureRows(0);
    } else {
      ensureRows(subs.length);
      for (let i = 0; i < subs.length; i++) {
        const s = subs[i];
        const row = rows[i];
        row.tr.setAttribute("data-priority", s.priority);
        row.label.textContent = s.hz ? `${s.label} @${s.hz}Hz` : s.label;
        row.lane.textContent = s.lane;
        row.cost.textContent = s.costMs.toFixed(2);
      }
    }

    foot.textContent =
      `${stats.subscriberCount} subscribers · 1 rAF loop · ` +
      `${stats.displayHz}Hz display (${stats.frameBudgetMs.toFixed(1)}ms budget)`;
  };

  // Decorative, deliberately. The worry with shedding a profiler is that it
  // vanishes at the moment you care about — but it cannot: a subscriber skipped
  // MAX_CONSECUTIVE_SHED frames running is forced through, so under heavy load
  // this degrades from 5Hz to roughly 3Hz rather than stopping.
  //
  // Essential would be worse than useless here. Measured under CPU throttling
  // this was the most expensive subscriber on the page, so privileging it means
  // shedding the content in order to keep the readout about the content alive.
  // An instrument must never outrank what it measures.
  const off = getConductor().subscribe("render", paint, {
    priority: "decorative",
    hz,
    label: "devtools overlay",
  });

  return () => {
    off();
    releaseBudget();
    releasePressure();
    head.removeEventListener("click", onToggle);
    host.remove();
  };
}
