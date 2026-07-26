import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Scheduler behaviour: priority ordering, budget shedding, starvation, hz
 * throttling and cost attribution.
 *
 * The clock is controllable, so a subscriber can *be* expensive simply by
 * advancing it. That is exactly what the real conductor measures — it reads
 * `performance.now()` after each subscriber — so a subscriber that burns 5ms
 * of mock clock is indistinguishable from one that burns 5ms of CPU.
 */

let rafCallback: FrameRequestCallback | null = null;
let rafId = 0;
let clock = 0;
let frameTime = 0;

/** Advance the mock clock, as a subscriber doing `ms` of work would. */
function burn(ms: number): void {
  clock += ms;
}

/**
 * Present one frame. rAF timestamps and `performance.now()` share a clock in
 * the browser, so they share one here too — but the frame lands on its vsync
 * slot regardless of how much a subscriber burned, which is what really
 * happens while the page is still inside its budget.
 */
function crank(intervalMs = 16.67): void {
  frameTime += intervalMs;
  clock = Math.max(clock, frameTime); // time never runs backwards
  const cb = rafCallback;
  rafCallback = null;
  cb?.(clock);
}

async function freshConductor() {
  vi.resetModules();
  const mod = await import("./conductor");
  return mod.getConductor();
}

beforeEach(() => {
  rafCallback = null;
  rafId = 0;
  clock = 0;
  frameTime = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallback = cb;
    return ++rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("performance", { now: () => clock });
});

describe("priority ordering", () => {
  it("runs essential → enhanced → decorative within a lane, whatever the subscribe order", async () => {
    const conductor = await freshConductor();
    const order: string[] = [];
    conductor.subscribe("update", () => order.push("decorative"), { priority: "decorative" });
    conductor.subscribe("update", () => order.push("enhanced"), { priority: "enhanced" });
    conductor.subscribe("update", () => order.push("essential"), { priority: "essential" });
    crank();
    expect(order).toEqual(["essential", "enhanced", "decorative"]);
  });

  it("keeps subscribe order stable within one priority band", async () => {
    const conductor = await freshConductor();
    const order: string[] = [];
    for (const n of ["a", "b", "c"]) {
      conductor.subscribe("update", () => order.push(n), { priority: "enhanced" });
    }
    crank();
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("still runs lanes in input → update → render order", async () => {
    const conductor = await freshConductor();
    const order: string[] = [];
    // A decorative in an earlier lane beats an essential in a later one:
    // lanes are a data-flow contract, priority only orders within a lane.
    conductor.subscribe("render", () => order.push("render"), { priority: "essential" });
    conductor.subscribe("input", () => order.push("input"), { priority: "decorative" });
    crank();
    expect(order).toEqual(["input", "render"]);
  });
});

describe("budget shedding", () => {
  it("sheds decorative work once the frame is mostly spent", async () => {
    const conductor = await freshConductor();
    const ran: string[] = [];
    // 8ms is past the decorative line (45% of a 16.67ms frame = 7.5ms) but
    // short of the enhanced line (70% = 11.7ms).
    conductor.subscribe("update", () => { ran.push("essential"); burn(8); }, {
      priority: "essential",
    });
    conductor.subscribe("update", () => ran.push("enhanced"), { priority: "enhanced" });
    conductor.subscribe("update", () => ran.push("decorative"), { priority: "decorative" });
    crank();
    expect(ran).toEqual(["essential", "enhanced"]);
  });

  it("sheds enhanced work too once the frame is nearly gone", async () => {
    const conductor = await freshConductor();
    const ran: string[] = [];
    conductor.subscribe("update", () => { ran.push("essential"); burn(13); }, {
      priority: "essential",
    });
    conductor.subscribe("update", () => ran.push("enhanced"), { priority: "enhanced" });
    crank();
    expect(ran).toEqual(["essential"]);
  });

  it("never sheds essential work, however far over budget the frame is", async () => {
    const conductor = await freshConductor();
    const ran: string[] = [];
    conductor.subscribe("update", () => { ran.push("hog"); burn(200); }, {
      priority: "essential",
    });
    conductor.subscribe("update", () => ran.push("sensor"), { priority: "essential" });
    crank();
    expect(ran).toEqual(["hog", "sensor"]);
  });

  it("does not shed when the frame has room", async () => {
    const conductor = await freshConductor();
    const ran: string[] = [];
    conductor.subscribe("update", () => { ran.push("essential"); burn(1); }, {
      priority: "essential",
    });
    conductor.subscribe("update", () => ran.push("decorative"), { priority: "decorative" });
    crank();
    expect(ran).toEqual(["essential", "decorative"]);
  });

  it("can be turned off entirely", async () => {
    const conductor = await freshConductor();
    conductor.configure({ shedding: false });
    const ran: string[] = [];
    conductor.subscribe("update", () => { ran.push("hog"); burn(50); }, {
      priority: "essential",
    });
    conductor.subscribe("update", () => ran.push("decorative"), { priority: "decorative" });
    crank();
    expect(ran).toEqual(["hog", "decorative"]);
  });

  it("reports what it shed", async () => {
    const conductor = await freshConductor();
    conductor.subscribe("update", () => burn(13), { priority: "essential" });
    conductor.subscribe("update", () => {}, { priority: "decorative", label: "garnish" });
    crank();
    const stats = conductor.getStats();
    expect(stats.shedLastFrame).toBe(1);
    expect(stats.subscribers.find((s) => s.label === "garnish")?.shed).toBe(1);
  });
});

describe("starvation guard", () => {
  it("forces a persistently shed subscriber through rather than freezing it", async () => {
    const conductor = await freshConductor();
    let decorativeRuns = 0;
    conductor.subscribe("update", () => burn(13), { priority: "essential" });
    conductor.subscribe("update", () => { decorativeRuns++; }, { priority: "decorative" });

    // Four frames of being shed, then the guard lets it through on the fifth.
    for (let i = 0; i < 4; i++) crank();
    expect(decorativeRuns).toBe(0);
    crank();
    expect(decorativeRuns).toBe(1);

    // And it keeps degrading gracefully rather than dying: four more shed
    // frames, one more run.
    for (let i = 0; i < 4; i++) crank();
    expect(decorativeRuns).toBe(1);
    crank();
    expect(decorativeRuns).toBe(2);
  });
});

describe("hz throttling", () => {
  it("runs a 30Hz subscriber every other frame at 60fps", async () => {
    const conductor = await freshConductor();
    let runs = 0;
    conductor.subscribe("update", () => { runs++; }, { hz: 30 });
    for (let i = 0; i < 10; i++) crank();
    expect(runs).toBe(5);
  });

  it("passes the accumulated dt so damping stays frame-rate independent", async () => {
    const conductor = await freshConductor();
    const deltas: number[] = [];
    conductor.subscribe("update", (dt) => deltas.push(dt), { hz: 30 });
    for (let i = 0; i < 4; i++) crank();
    // Two runs, each carrying ~two frames' worth of time — not one frame's.
    expect(deltas).toHaveLength(2);
    for (const dt of deltas) expect(dt).toBeCloseTo(0.0333, 2);
  });

  it("cannot run faster than the loop", async () => {
    const conductor = await freshConductor();
    let runs = 0;
    conductor.subscribe("update", () => { runs++; }, { hz: 240 });
    for (let i = 0; i < 5; i++) crank();
    expect(runs).toBe(5);
  });

  it("keeps a throttled subscriber due when it is shed", async () => {
    const conductor = await freshConductor();
    const deltas: number[] = [];
    conductor.subscribe("update", () => burn(13), { priority: "essential" });
    conductor.subscribe("update", (dt) => deltas.push(dt), { priority: "decorative", hz: 30 });
    // Frame 1 it simply isn't due. Frames 2–5 it is due but gets shed, and
    // being shed must not consume the banked time. The starvation guard
    // releases it on frame 6, with a dt covering every frame it missed.
    for (let i = 0; i < 5; i++) crank();
    expect(deltas).toHaveLength(0);
    crank();
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toBeCloseTo(0.1, 2); // six frames of banked time
  });
});

describe("attribution", () => {
  it("charges each subscriber only for its own time", async () => {
    const conductor = await freshConductor();
    conductor.subscribe("update", () => burn(4), { priority: "essential", label: "cheap" });
    conductor.subscribe("update", () => burn(1), { priority: "essential", label: "cheaper" });
    crank();
    const stats = conductor.getStats();
    expect(stats.subscribers.find((s) => s.label === "cheap")?.lastCostMs).toBeCloseTo(4, 1);
    expect(stats.subscribers.find((s) => s.label === "cheaper")?.lastCostMs).toBeCloseTo(1, 1);
  });

  it("sorts the breakdown most expensive first", async () => {
    const conductor = await freshConductor();
    conductor.subscribe("update", () => burn(1), { priority: "essential", label: "small" });
    conductor.subscribe("update", () => burn(6), { priority: "essential", label: "big" });
    conductor.subscribe("update", () => burn(3), { priority: "essential", label: "mid" });
    crank();
    expect(conductor.getStats().subscribers.map((s) => s.label)).toEqual([
      "big",
      "mid",
      "small",
    ]);
  });

  it("totals the runtime's own work for the frame", async () => {
    const conductor = await freshConductor();
    conductor.subscribe("update", () => burn(3), { priority: "essential" });
    conductor.subscribe("render", () => burn(2), { priority: "essential" });
    crank();
    // First frame seeds the EMA directly with the observed total.
    expect(conductor.workMs).toBeCloseTo(0.5, 1); // 5ms * α(0.1) from a 0 start
    for (let i = 0; i < 60; i++) crank();
    expect(conductor.workMs).toBeCloseTo(5, 0);
  });

  it("does not count a shed subscriber as having run", async () => {
    const conductor = await freshConductor();
    conductor.subscribe("update", () => burn(13), { priority: "essential" });
    conductor.subscribe("update", () => {}, { priority: "decorative", label: "garnish" });
    crank();
    const garnish = conductor.getStats().subscribers.find((s) => s.label === "garnish");
    expect(garnish?.runs).toBe(0);
    expect(garnish?.shed).toBe(1);
  });
});

describe("diagnostics", () => {
  it("routes errors to a pluggable handler instead of the console", async () => {
    const conductor = await freshConductor();
    const onError = vi.fn();
    conductor.configure({ onError });
    conductor.subscribe("update", () => { throw new Error("boom"); }, { label: "bad" });
    crank();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toBe("bad");
    expect(onError.mock.calls[0][2]).toBe("update");
  });

  it("logs a throwing subscriber once, not once per frame", async () => {
    const conductor = await freshConductor();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    conductor.subscribe("update", () => { throw new Error("boom"); });
    for (let i = 0; i < 30; i++) crank();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("warns once about a slow subscriber when profiling is on", async () => {
    const conductor = await freshConductor();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    conductor.configure({ slowSubscriberMs: 4 });
    conductor.subscribe("update", () => burn(9), { priority: "essential", label: "hog" });
    for (let i = 0; i < 10; i++) crank();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("hog");
    warnSpy.mockRestore();
  });

  it("stays quiet about slow subscribers by default", async () => {
    const conductor = await freshConductor();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    conductor.subscribe("update", () => burn(40), { priority: "essential" });
    crank();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("detects the display rate from the frames it sees", async () => {
    const conductor = await freshConductor();
    conductor.subscribe("update", () => {});
    for (let i = 0; i < 20; i++) crank(1000 / 120);
    const stats = conductor.getStats();
    expect(stats.displayHz).toBe(120);
    expect(stats.frameBudgetMs).toBeCloseTo(8.33, 1);
  });

  it("scales the shed lines to the display, not to 60Hz", async () => {
    const FRAMES = 40;

    // At 60Hz, 5ms of essential work sits comfortably inside the 7.5ms
    // decorative line, so nothing is ever shed.
    const at60 = await freshConductor();
    let ran60 = 0;
    at60.subscribe("update", () => burn(5), { priority: "essential" });
    at60.subscribe("update", () => { ran60++; }, { priority: "decorative" });
    for (let i = 0; i < FRAMES; i++) crank(1000 / 60);
    expect(ran60).toBe(FRAMES);

    // The same 5ms on a 120Hz display is past that display's 3.75ms line. The
    // work did not change; the standard it is held to did. Once the probe has
    // settled, only the starvation guard lets the decorative pass through.
    const at120 = await freshConductor();
    let ran120 = 0;
    at120.subscribe("update", () => burn(5), { priority: "essential" });
    at120.subscribe("update", () => { ran120++; }, { priority: "decorative" });
    for (let i = 0; i < FRAMES; i++) crank(1000 / 120);
    expect(ran120).toBeLessThan(FRAMES / 2);
    expect(ran120).toBeGreaterThan(0); // degraded to a lower cadence, not frozen
  });
});
