// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

/**
 * The React adapter for the pressure classifier.
 *
 * The policy has its own tests and the measurement layer has a real-browser
 * harness. This is the thin part in between — and the thin part is where the
 * lifecycle bugs in this codebase have consistently been.
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

beforeEach(() => {
  rafCallbacks = new Map();
  rafId = 0;
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => rafCallbacks.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useFramePressure", () => {
  it("reports no pressure before anything has been measured", async () => {
    vi.resetModules();
    const { useFramePressure } = await import("./useFramePressure");

    let seen: { source: string; confidence: number } | null = null;
    function Consumer() {
      const s = useFramePressure();
      seen = { source: s.source, confidence: s.confidence };
      return null;
    }

    render(<Consumer />);
    // Reporting a problem before measuring one would make every page load
    // look like it was in trouble.
    expect(seen).toEqual({ source: "none", confidence: 1 });
  });

  it("starts the classifier while mounted and stops it on unmount", async () => {
    vi.resetModules();
    const { useFramePressure } = await import("./useFramePressure");
    const { getConductor } = await import("../core/conductor");

    function Consumer() {
      useFramePressure();
      return null;
    }

    const view = render(<Consumer />);
    await act(async () => crankFrames(2));
    // It only measures while something is subscribed — reading `.state`
    // without holding it open shows a permanently healthy page.
    expect(getConductor().state.subscribers.length).toBeGreaterThan(0);

    view.unmount();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  it("shares one classifier between consumers", async () => {
    vi.resetModules();
    const { useFramePressure } = await import("./useFramePressure");
    const { getConductor } = await import("../core/conductor");

    function Consumer() {
      useFramePressure();
      return null;
    }

    const a = render(<Consumer />);
    const b = render(<Consumer />);
    await act(async () => crankFrames(2));

    // The probe posts a task and the classifier reads the clock. Doing that
    // once per consumer would be measuring a cost it was creating.
    const mine = getConductor()
      .state
      .subscribers.filter((s) => s.label === "FramePressure");
    expect(mine).toHaveLength(1);

    a.unmount();
    expect(
      getConductor().state.subscribers.filter((s) => s.label === "FramePressure"),
    ).toHaveLength(1);

    b.unmount();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  it("measures as essential, so it does not go quiet under load", async () => {
    vi.resetModules();
    const { useFramePressure } = await import("./useFramePressure");
    const { getConductor } = await import("../core/conductor");

    function Consumer() {
      useFramePressure();
      return null;
    }

    render(<Consumer />);
    await act(async () => crankFrames(2));

    const me = getConductor()
      .state
      .subscribers.find((s) => s.label === "FramePressure");

    // A classifier that gets shed exactly when the page is struggling would
    // go silent in the only situation it exists for.
    expect(me!.priority).toBe("essential");
    expect(me!.lane).toBe("input");
  });

  it("does not re-render on every frame", async () => {
    vi.resetModules();
    const { useFramePressure } = await import("./useFramePressure");

    let renders = 0;
    function Consumer() {
      renders++;
      useFramePressure();
      return null;
    }

    render(<Consumer />);
    const before = renders;
    await act(async () => crankFrames(30));

    // Verdicts change slowly and emit at most twice a second. Thirty frames of
    // React renders would make the classifier a cost rather than a readout.
    expect(renders - before).toBeLessThan(4);
  });
});
