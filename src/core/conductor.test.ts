import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The conductor is a module singleton driven by rAF — each test gets a
 * fresh module instance (vi.resetModules) and a hand-cranked rAF.
 */

let rafCallback: FrameRequestCallback | null = null;
let rafId = 0;
const cancelled: number[] = [];

function crank(timeMs: number): void {
  const cb = rafCallback;
  rafCallback = null;
  cb?.(timeMs);
}

async function freshConductor() {
  vi.resetModules();
  const mod = await import("./conductor");
  return mod.getConductor();
}

beforeEach(() => {
  rafCallback = null;
  rafId = 0;
  cancelled.length = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallback = cb;
    return ++rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    cancelled.push(id);
  });
  vi.stubGlobal("performance", { now: () => 0 });
});

describe("FrameConductor", () => {
  it("runs lanes in input → update → render order regardless of subscribe order", async () => {
    const conductor = await freshConductor();
    const order: string[] = [];
    conductor.subscribe("render", () => order.push("render"));
    conductor.subscribe("input", () => order.push("input"));
    conductor.subscribe("update", () => order.push("update"));
    crank(16);
    expect(order).toEqual(["input", "update", "render"]);
  });

  it("clamps dt after a tab sleep", async () => {
    const conductor = await freshConductor();
    let seenDt = 0;
    conductor.subscribe("update", (dt) => {
      seenDt = dt;
    });
    crank(5000); // 5s since start — a sleep artifact
    expect(seenDt).toBe(0.1);
  });

  it("isolates a throwing subscriber from its siblings", async () => {
    const conductor = await freshConductor();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let siblingRan = false;
    conductor.subscribe("update", () => {
      throw new Error("boom");
    });
    conductor.subscribe("update", () => {
      siblingRan = true;
    });
    crank(16);
    expect(siblingRan).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("stops the loop when the last subscriber leaves", async () => {
    const conductor = await freshConductor();
    const off = conductor.subscribe("render", () => {});
    expect(rafCallback).not.toBeNull();
    off();
    expect(cancelled.length).toBeGreaterThan(0);
  });

  it("survives double-unsubscribe without evicting a re-added subscriber", async () => {
    const conductor = await freshConductor();
    const fn = vi.fn();
    const off1 = conductor.subscribe("update", fn);
    off1();
    conductor.subscribe("update", fn); // re-added
    off1(); // stale release must be a no-op
    crank(16);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
