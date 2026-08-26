// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The devtools overlay.
 *
 * Not tested for how it looks — that is what looking at it is for. Tested for
 * the three claims the vault records design decisions about, each of which was
 * arrived at by getting it wrong first:
 *
 * - it must never outrank what it measures
 * - it must appear in its own subscriber table
 * - it must let go of everything it held open
 *
 * All three are invisible on screen. An overlay that quietly ran as essential,
 * or quietly left the governor measuring after unmount, would look identical.
 */

let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafId = 0;
let now = 0;

function crank(timeMs: number): void {
  now = timeMs;
  const pending = [...rafCallbacks.values()];
  rafCallbacks = new Map();
  for (const cb of pending) cb(timeMs);
}

function crankFrames(count: number): void {
  for (let i = 0; i < count; i++) crank(now + 16);
}

async function fresh() {
  vi.resetModules();
  const overlay = await import("./overlay");
  const core = await import("../core/conductor");
  return { ...overlay, getConductor: core.getConductor };
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafId = 0;
  now = 0;
  document.body.innerHTML = "";
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => rafCallbacks.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mountDevtools — mounting", () => {
  it("attaches a host and takes it away again", async () => {
    const { mountDevtools } = await fresh();

    const unmount = mountDevtools();
    expect(document.querySelector("[data-vv-devtools]")).not.toBeNull();

    unmount();
    expect(document.querySelector("[data-vv-devtools]")).toBeNull();
  });

  it("keeps its styles out of the page", async () => {
    const { mountDevtools } = await fresh();
    mountDevtools();

    // A shadow root, so a debugging tool cannot restyle the thing being
    // debugged.
    const host = document.querySelector("[data-vv-devtools]");
    expect(host!.shadowRoot).not.toBeNull();
  });

  it("mounts where it is told", async () => {
    const { mountDevtools } = await fresh();
    const container = document.createElement("section");
    document.body.appendChild(container);

    mountDevtools({ container });
    expect(container.querySelector("[data-vv-devtools]")).not.toBeNull();
  });

  it("does nothing at all without a document", async () => {
    vi.resetModules();
    const doc = globalThis.document;
    // @ts-expect-error — deliberately removing it
    delete globalThis.document;
    try {
      const { mountDevtools } = await import("./overlay");
      // Importing this on a server must not throw, and calling it must hand
      // back something safe to call.
      expect(() => mountDevtools()()).not.toThrow();
    } finally {
      globalThis.document = doc;
    }
  });
});

describe("mountDevtools — never outranking what it measures", () => {
  it("subscribes as decorative", async () => {
    const { mountDevtools, getConductor } = await fresh();
    mountDevtools();
    crankFrames(2);

    const me = getConductor()
      .state
      .subscribers.find((s) => s.label === "devtools overlay");

    // It ran as `essential` once. Measured under 6x CPU throttling it was the
    // most expensive subscriber on the page, so privileging it meant shedding
    // the content in order to keep alive the readout about the content.
    expect(me).toBeDefined();
    expect(me!.priority).toBe("decorative");
  });

  it("throttles itself instead of painting every frame", async () => {
    const { mountDevtools, getConductor } = await fresh();
    mountDevtools({ hz: 5 });
    crankFrames(2);

    const me = getConductor()
      .state
      .subscribers.find((s) => s.label === "devtools overlay");

    // Numbers a human reads five times a second do not need 120 repaints.
    expect(me!.hz).toBe(5);
  });

  it("lists itself in its own table", async () => {
    const { mountDevtools, getConductor } = await fresh();
    mountDevtools();
    crankFrames(2);

    const labels = getConductor().state.subscribers.map((s) => s.label);
    // A profiler that hides its own cost is lying about the page.
    expect(labels).toContain("devtools overlay");
  });
});

describe("mountDevtools — letting go", () => {
  it("stops the governor and the classifier it held open", async () => {
    const { mountDevtools, getConductor } = await fresh();

    const unmount = mountDevtools();
    crankFrames(4);
    // Both only measure while something is subscribed, so the overlay holds
    // them open — otherwise every reading would be a frozen default.
    expect(getConductor().state.subscribers.length).toBeGreaterThan(1);

    unmount();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  it("survives being unmounted twice", async () => {
    const { mountDevtools } = await fresh();
    const unmount = mountDevtools();
    unmount();
    expect(() => unmount()).not.toThrow();
  });

  it("stops painting once unmounted", async () => {
    const { mountDevtools, getConductor } = await fresh();
    const unmount = mountDevtools();
    crankFrames(4);
    unmount();

    // Nothing left subscribed means nothing left to run, which is the only
    // way a removed overlay cannot keep costing frames.
    crankFrames(10);
    expect(getConductor().state.subscribers).toHaveLength(0);
  });
});

describe("mountDevtools — what it renders", () => {
  it("shows a pressure tile once the classifier has a verdict", async () => {
    const { mountDevtools } = await fresh();
    mountDevtools({ expanded: true });
    crankFrames(4);

    const root = document.querySelector("[data-vv-devtools]")!.shadowRoot!;
    // The tile that says whether shedding our own work would help at all.
    expect(root.textContent).toMatch(/pressure/i);
  });

  it("names the foreground region, not its generated id", async () => {
    const { mountDevtools, getConductor } = await fresh();
    // hz defaults to 5, so a paint needs 200ms of accumulated dt — four
    // frames is not enough, and asserting on four would have passed only
    // because the label happened to be static.
    mountDevtools({ expanded: true, hz: 60 });
    const release = getConductor().claimScope(":r7:", "Product gallery");
    crankFrames(4);

    const root = document.querySelector("[data-vv-devtools]")!.shadowRoot!;
    // Scope ids are generated now, so a readout showing ":r7:" would be
    // useless to a human.
    expect(root.textContent).toContain("Product gallery");
    release();
  });
});
