import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CapPolicy, type CapContext } from "./presentation-cap";

/**
 * The battery-saver cap.
 *
 * A browser on battery saver presents the page at 30fps on a 60Hz panel.
 * CapPolicy decides when the evidence says the browser set that pace. These
 * tests pin both halves: it must believe a real cap and must not pass a page
 * that is slow because of its own load.
 */

const CAPPED = 1000 / 30;
const FULL = 1000 / 60;

const idle: CapContext = {
  pressure: { source: "render", confidence: 0.9 },
  ourScenesDrawing: false,
  lowestTier: false,
};

/** Feed frames and judge after each, as the watcher does, advancing a clock. */
function run(
  policy: CapPolicy,
  intervals: number[],
  ctx: CapContext,
  clock: { t: number },
): Array<number | null | undefined> {
  const changes: Array<number | null | undefined> = [];
  for (const ms of intervals) {
    policy.push(ms);
    clock.t += ms / 1000;
    const change = policy.evaluate(clock.t, ctx);
    if (change !== undefined) changes.push(change);
  }
  return changes;
}

const repeat = (ms: number, n: number) => Array.from({ length: n }, () => ms);

describe("CapPolicy — believing a cap", () => {
  it("believes a steady 30fps on an idle main thread, after the hold", () => {
    const policy = new CapPolicy();
    const clock = { t: 0 };
    // 1s of frames is not enough: the window and the hold both need time.
    run(policy, repeat(CAPPED, 30), idle, clock);
    expect(policy.capHz).toBeNull();

    const changes = run(policy, repeat(CAPPED, 60), idle, clock);
    expect(changes).toEqual([30]);
    expect(policy.capHz).toBe(30);
  });

  it("does not believe it while the main thread is busy", () => {
    // A page held at 30fps by its own script, style or layout work. This is
    // the case refresh-rate.ts protects: it must not be congratulated.
    const policy = new CapPolicy();
    const busy = { ...idle, pressure: { source: "main-thread" as const, confidence: 0.8 } };
    run(policy, repeat(CAPPED, 150), busy, { t: 0 });
    expect(policy.capHz).toBeNull();
  });

  it("does not believe it without a confident verdict", () => {
    const policy = new CapPolicy();
    const unsure = { ...idle, pressure: { source: "render" as const, confidence: 0.2 } };
    run(policy, repeat(CAPPED, 150), unsure, { t: 0 });
    expect(policy.capHz).toBeNull();

    const notRunning = { ...idle, pressure: null };
    run(policy, repeat(CAPPED, 150), notRunning, { t: 0 });
    expect(policy.capHz).toBeNull();
  });

  it("does not blame the browser while our own scenes are drawing at full quality", () => {
    // Steady and off the main thread is also what a GPU-bound scene looks
    // like. Reducing quality might reach 60fps, so the cap is not believed yet.
    const policy = new CapPolicy();
    const drawing = { ...idle, ourScenesDrawing: true };
    run(policy, repeat(CAPPED, 150), drawing, { t: 0 });
    expect(policy.capHz).toBeNull();
  });

  it("believes it once the lowest tier has not moved the cadence", () => {
    // The cheapest version of the scene still cannot escape 30fps, so judging
    // against 30fps is right whatever set it.
    const policy = new CapPolicy();
    const lowest = { ...idle, ourScenesDrawing: true, lowestTier: true };
    run(policy, repeat(CAPPED, 150), lowest, { t: 0 });
    expect(policy.capHz).toBe(30);
  });

  it("does not read ragged frames as a cap", () => {
    // Load changes from frame to frame. A cap does not.
    const policy = new CapPolicy();
    const ragged = Array.from({ length: 150 }, (_, i) => (i % 2 === 0 ? 24 : 46));
    run(policy, ragged, idle, { t: 0 });
    expect(policy.steadyRate()).toBeNull();
    expect(policy.capHz).toBeNull();
  });

  it("ignores a page running at the display's own rate", () => {
    const policy = new CapPolicy();
    run(policy, repeat(FULL, 150), idle, { t: 0 });
    expect(policy.steadyRate()).toBeNull();
    expect(policy.capHz).toBeNull();
  });

  it("starts the hold again when a condition breaks", () => {
    const policy = new CapPolicy();
    const clock = { t: 0 };
    run(policy, repeat(CAPPED, 40), idle, clock); // window full, hold started
    const busy = { ...idle, pressure: { source: "main-thread" as const, confidence: 0.8 } };
    run(policy, repeat(CAPPED, 5), busy, clock); // broken
    // Less than a full hold after the break: still not believed.
    run(policy, repeat(CAPPED, 40), idle, clock);
    expect(policy.capHz).toBeNull();
    run(policy, repeat(CAPPED, 20), idle, clock);
    expect(policy.capHz).toBe(30);
  });

  it("reads a 20fps cap as 20", () => {
    const policy = new CapPolicy();
    run(policy, repeat(50, 120), idle, { t: 0 });
    expect(policy.capHz).toBe(20);
  });
});

describe("CapPolicy — lifting a cap", () => {
  function capped(): { policy: CapPolicy; clock: { t: number } } {
    const policy = new CapPolicy();
    const clock = { t: 0 };
    run(policy, repeat(CAPPED, 100), idle, clock);
    expect(policy.capHz).toBe(30);
    return { policy, clock };
  }

  it("lifts as soon as full-rate frames come back", () => {
    // A charger plugged in. Frames this fast are impossible under the cap.
    const { policy, clock } = capped();
    const changes = run(policy, repeat(FULL, 6), idle, clock);
    expect(changes).toEqual([null]);
    expect(policy.capHz).toBeNull();
  });

  it("forgets the capped window when it lifts, so it cannot re-trigger at once", () => {
    const { policy, clock } = capped();
    run(policy, repeat(FULL, 6), idle, clock);
    expect(policy.steadyRate()).toBeNull();
  });

  it("is not lifted by a burst of two or three short frames", () => {
    // Browsers deliver callbacks back to back after a stall.
    const { policy, clock } = capped();
    run(policy, [CAPPED, 4, 4, 4, CAPPED, CAPPED], idle, clock);
    expect(policy.capHz).toBe(30);
  });

  it("stays believed when the main thread gets busy under it", () => {
    // Under the cap the frame is within budget, so the classifier goes quiet.
    // The cap is about the browser, not the page's load, and only fast frames
    // can disprove it.
    const { policy, clock } = capped();
    const quiet = { ...idle, pressure: null };
    run(policy, repeat(CAPPED, 100), quiet, clock);
    expect(policy.capHz).toBe(30);
  });
});

describe("PresentationCapWatcher — wired to the conductor", () => {
  let pressureSubs = 0;

  beforeEach(() => {
    pressureSubs = 0;
    vi.resetModules();
    vi.doMock("./frame-pressure/FramePressure", async (importOriginal) => {
      const real = await importOriginal<typeof import("./frame-pressure/FramePressure")>();
      return {
        ...real,
        getFramePressure: () => ({
          state: { source: "render", confidence: 0.9 },
          subscribe: () => {
            pressureSubs++;
            return () => {
              pressureSubs--;
            };
          },
        }),
      };
    });
  });

  afterEach(() => {
    vi.doUnmock("./frame-pressure/FramePressure");
  });

  it("moves the conductor's budget to the cap, and back on dispose", async () => {
    const { PresentationCapWatcher } = await import("./presentation-cap");
    const { getConductor } = await import("./conductor");
    const watcher = new PresentationCapWatcher();

    expect(getConductor().frameBudgetMs).toBeCloseTo(FULL, 1);
    let t = 0;
    for (let i = 0; i < 120; i++) {
      t += CAPPED / 1000;
      watcher.frame(CAPPED, t, false);
    }
    expect(getConductor().frameBudgetMs).toBeCloseTo(CAPPED, 1);
    expect(getConductor().state.frameBudgetMs).toBeCloseTo(CAPPED, 1);

    // A cap nobody is watching could go stale, so it does not outlive us.
    watcher.dispose();
    expect(getConductor().frameBudgetMs).toBeCloseTo(FULL, 1);
  });

  it("only keeps the pressure classifier running while a cap is in question", async () => {
    const { PresentationCapWatcher } = await import("./presentation-cap");
    const watcher = new PresentationCapWatcher();
    let t = 0;

    // Full rate: nothing to ask.
    for (let i = 0; i < 60; i++) watcher.frame(FULL, (t += FULL / 1000), false);
    expect(pressureSubs).toBe(0);

    // Steady 30fps, once it fills the window: suspected, so the classifier
    // runs...
    for (let i = 0; i < 45; i++) watcher.frame(CAPPED, (t += CAPPED / 1000), false);
    expect(pressureSubs).toBe(1);

    // ...and is released once the cap is believed.
    for (let i = 0; i < 80; i++) watcher.frame(CAPPED, (t += CAPPED / 1000), false);
    expect(pressureSubs).toBe(0);

    watcher.dispose();
  });
});
