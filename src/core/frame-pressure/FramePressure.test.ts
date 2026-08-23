import { describe, it, expect } from "vitest";
import { PressurePolicy, type PressureSample } from "./FramePressure";

/**
 * The pressure classifier, fed synthetic frames.
 *
 * All the browser-dependent measurement lives in the singleton; this is the
 * decision logic on its own, which is the part that has to be right. A wrong
 * verdict here would make the runtime lower quality for the wrong reason.
 */

const BUDGET = 1000 / 60; // 16.6ms

/** Push `count` identical frames and return the last emitted state. */
function run(policy: PressurePolicy, sample: Partial<PressureSample>, count = 60) {
  const full: PressureSample = {
    frameMs: BUDGET,
    runtimeMs: 1,
    mainTailMs: null,
    budgetMs: BUDGET,
    longTasks: 0,
    ...sample,
  };
  let last = null;
  for (let i = 0; i < count; i++) last = policy.push(full) ?? last;
  return last;
}

describe("PressurePolicy — saying nothing", () => {
  it("stays quiet until it has seen enough frames", () => {
    const p = new PressurePolicy();
    const sample: PressureSample = {
      frameMs: 40,
      runtimeMs: 30,
      mainTailMs: 5,
      budgetMs: BUDGET,
      longTasks: 0,
    };
    // A verdict from three frames would be noise presented as a finding.
    for (let i = 0; i < 5; i++) expect(p.push(sample)).toBeNull();
  });

  it("reports no pressure while frames are healthy", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: BUDGET, runtimeMs: 2, mainTailMs: 3 });

    // Most of a healthy frame is waiting for vsync. Calling that idle time
    // "render pressure" would be worse than saying nothing.
    expect(out!.source).toBe("none");
  });

  it("still reports none when a healthy frame is mostly off-thread", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: BUDGET, runtimeMs: 0.5, mainTailMs: 0.5 });

    expect(out!.offThreadMs).toBeGreaterThan(10);
    expect(out!.source).toBe("none");
  });
});

describe("PressurePolicy — naming the cause", () => {
  it("blames our own subscribers when they dominate", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: 40, runtimeMs: 30, mainTailMs: 4 });

    expect(out!.source).toBe("runtime");
    expect(out!.confidence).toBeGreaterThan(0.5);
  });

  it("blames the main thread when someone else's work dominates", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: 50, runtimeMs: 2, mainTailMs: 40 });

    expect(out!.source).toBe("main-thread");
    expect(out!.confidence).toBeGreaterThan(0.5);
  });

  it("blames rendering when the main thread was free and the frame was still late", () => {
    const p = new PressurePolicy();
    // 2ms of our work, 3ms of everything else's, and a 45ms frame. The main
    // thread finished early and the frame still missed — that is the GPU or
    // the compositor.
    const out = run(p, { frameMs: 45, runtimeMs: 2, mainTailMs: 3 });

    expect(out!.source).toBe("render");
    expect(out!.offThreadMs).toBeGreaterThan(35);
  });

  it("is the case AnimationBudget alone gets wrong", () => {
    const p = new PressurePolicy();
    // The scenario from the runtime notes: 2ms of JS against 30ms of GPU.
    // Headroom looks generous, so shedding JS would remove motion and fix
    // nothing.
    const out = run(p, { frameMs: 32, runtimeMs: 2, mainTailMs: 1 });

    expect(out!.source).toBe("render");
    expect(out!.runtimeMs).toBeLessThan(3);
  });
});

describe("PressurePolicy — refusing to guess", () => {
  it("says unknown when no single cause is large enough", () => {
    const p = new PressurePolicy();
    // Three roughly equal thirds. Something is wrong; nothing is the cause.
    const out = run(p, { frameMs: 45, runtimeMs: 15, mainTailMs: 15 });

    expect(out!.source).toBe("unknown");
    expect(out!.confidence).toBe(0);
  });

  it("reports low confidence when the winner barely wins", () => {
    const p = new PressurePolicy();
    const clear = run(new PressurePolicy(), { frameMs: 50, runtimeMs: 44, mainTailMs: 2 });
    const narrow = run(p, { frameMs: 50, runtimeMs: 21, mainTailMs: 20 });

    // Confidence is how clearly it won, not how large it was.
    expect(clear!.confidence).toBeGreaterThan(narrow!.confidence);
  });
});

describe("PressurePolicy — without the main-thread probe", () => {
  it("still recognises our own work, because that is measured directly", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: 40, runtimeMs: 30, mainTailMs: null });

    expect(out!.source).toBe("runtime");
    expect(out!.mainTailMs).toBeNull();
  });

  it("will not split the rest without evidence", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: 40, runtimeMs: 2, mainTailMs: null });

    // Something is eating 38ms. Which of the main thread or the GPU it is
    // cannot be answered from timing alone.
    expect(out!.source).toBe("unknown");
  });

  it("leans on a long task, but only as a lean", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: 40, runtimeMs: 2, mainTailMs: null, longTasks: 1 });

    expect(out!.source).toBe("main-thread");
    // The Long Task API fires above 50ms, so it proves something blocked and
    // nothing about how much of this frame it accounts for.
    expect(out!.confidence).toBeLessThan(0.5);
  });
});

describe("PressurePolicy — long tasks are a positive signal only", () => {
  it("corroborates a main-thread verdict", () => {
    const withTask = run(new PressurePolicy(), {
      frameMs: 50, runtimeMs: 2, mainTailMs: 40, longTasks: 1,
    });
    const without = run(new PressurePolicy(), {
      frameMs: 50, runtimeMs: 2, mainTailMs: 40, longTasks: 0,
    });

    expect(withTask!.confidence).toBeGreaterThan(without!.confidence);
  });

  it("does not weaken a render verdict by being absent", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: 45, runtimeMs: 2, mainTailMs: 3, longTasks: 0 });

    // A page spending 25ms per frame on main-thread JS produces no long tasks
    // at all, so absence has to mean nothing.
    expect(out!.source).toBe("render");
    expect(out!.confidence).toBeGreaterThan(0.5);
  });
});

describe("PressurePolicy — housekeeping", () => {
  it("scales with the display, not with 60Hz", () => {
    const p = new PressurePolicy();
    const budget120 = 1000 / 120; // 8.3ms
    // 12ms is comfortable at 60Hz and a miss at 120Hz.
    const out = run(p, {
      frameMs: 12, runtimeMs: 9, mainTailMs: 1, budgetMs: budget120,
    });

    expect(out!.source).toBe("runtime");
  });

  it("clears its verdict on reset", () => {
    const p = new PressurePolicy();
    run(p, { frameMs: 40, runtimeMs: 30, mainTailMs: 4 });
    expect(p.state.source).toBe("runtime");

    p.reset();
    expect(p.state.source).toBe("none");
    expect(p.state.mainTailMs).toBeNull();
    expect(p.state.frameMs).toBe(0);
  });
});
