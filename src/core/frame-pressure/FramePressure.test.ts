import { describe, it, expect } from "vitest";
import { PressurePolicy, type PressureSample } from "./FramePressure";

/**
 * The pressure classifier, fed synthetic frames.
 *
 * All the browser-dependent measurement lives in the singleton; this is the
 * decision logic on its own, which is the part that has to be right. A wrong
 * verdict here would make the runtime lower quality for the wrong reason.
 *
 * Note what `probeDelayMs` means in a sample: the raw MessageChannel round
 * trip, measured from the input lane, which contains our own update and render
 * work as well as everyone else's. That is why a "someone else is burning the
 * main thread after us" case sets it to their time PLUS `runtimeMs`. The
 * policy nets our share back out. Getting this wrong in a test would be
 * testing a decomposition nobody performs.
 */

const BUDGET = 1000 / 60; // 16.6ms

/** Push identical frames until the policy has emitted, and return the last. */
function run(policy: PressurePolicy, sample: Partial<PressureSample>, count = 60) {
  const full: PressureSample = {
    frameMs: BUDGET,
    runtimeMs: 1,
    probeDelayMs: null,
    preRuntimeMs: 0,
    budgetMs: BUDGET,
    longTasks: 0,
    ...sample,
  };
  let last = null;
  for (let i = 0; i < count; i++) last = policy.push(full) ?? last;
  return last;
}

/** Someone else burning `ms` on the main thread AFTER our tick. */
const otherAfter = (ms: number, runtimeMs: number) => ({
  runtimeMs,
  probeDelayMs: runtimeMs + ms,
});

describe("PressurePolicy — saying nothing", () => {
  it("stays quiet until it has seen enough frames", () => {
    const p = new PressurePolicy();
    const sample: PressureSample = {
      frameMs: 40,
      runtimeMs: 30,
      probeDelayMs: 31,
      preRuntimeMs: 0,
      budgetMs: BUDGET,
      longTasks: 0,
    };
    // A verdict from three frames would be noise presented as a finding.
    for (let i = 0; i < 5; i++) expect(p.push(sample)).toBeNull();
  });

  it("reports no pressure while frames are healthy", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: BUDGET, runtimeMs: 2, probeDelayMs: 3 });

    // Most of a healthy frame is waiting for vsync. Calling that idle time
    // "render pressure" would be worse than saying nothing.
    expect(out!.source).toBe("none");
  });

  it("still reports none when a healthy frame is mostly off-thread", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: BUDGET, runtimeMs: 0.5, probeDelayMs: 1 });

    expect(out!.offThreadMs).toBeGreaterThan(10);
    expect(out!.source).toBe("none");
  });
});

describe("PressurePolicy — naming the cause", () => {
  it("blames our own subscribers when they dominate", () => {
    const p = new PressurePolicy();
    // 30ms of our work; the probe sees our work plus a little of theirs.
    const out = run(p, { frameMs: 40, ...otherAfter(1, 30) });

    expect(out!.source).toBe("runtime");
    expect(out!.confidence).toBeGreaterThan(0.5);
  });

  it("blames the main thread when someone else's work runs after us", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: 50, ...otherAfter(40, 2) });

    expect(out!.source).toBe("main-thread");
    expect(out!.mainOtherMs).toBeGreaterThan(30);
  });

  it("blames the main thread when someone else's work runs BEFORE us", () => {
    const p = new PressurePolicy();
    // A third-party rAF loop registered ahead of ours. The probe cannot see
    // it at all — this is the case that read as "render" at 97% confidence on
    // the first real-browser run.
    const out = run(p, {
      frameMs: 50, runtimeMs: 1, probeDelayMs: 2, preRuntimeMs: 42,
    });

    expect(out!.source).toBe("main-thread");
  });

  it("blames rendering when the main thread was free and the frame was still late", () => {
    const p = new PressurePolicy();
    // Nothing ran before us, our work is trivial, the probe came straight
    // back — and the frame still missed. That is the GPU or the compositor.
    const out = run(p, {
      frameMs: 45, runtimeMs: 2, probeDelayMs: 3, preRuntimeMs: 0.4,
    });

    expect(out!.source).toBe("render");
    expect(out!.offThreadMs).toBeGreaterThan(35);
  });

  it("is the case AnimationBudget alone gets wrong", () => {
    const p = new PressurePolicy();
    // The scenario from the runtime notes: 2ms of JS against 30ms of GPU.
    // Headroom looks generous, so shedding JS would remove motion and fix
    // nothing.
    const out = run(p, {
      frameMs: 32, runtimeMs: 2, probeDelayMs: 2.5, preRuntimeMs: 0.2,
    });

    expect(out!.source).toBe("render");
    expect(out!.runtimeMs).toBeLessThan(3);
  });
});

describe("PressurePolicy — refusing to guess", () => {
  it("says unknown when no single cause is large enough", () => {
    const p = new PressurePolicy();
    // Roughly equal thirds. Something is wrong; nothing is the cause.
    const out = run(p, {
      frameMs: 45, runtimeMs: 15, probeDelayMs: 30, preRuntimeMs: 0,
    });

    expect(out!.source).toBe("unknown");
    expect(out!.confidence).toBe(0);
  });

  it("reports low confidence when the winner barely wins", () => {
    const clear = run(new PressurePolicy(), { frameMs: 50, ...otherAfter(2, 44) });
    const narrow = run(new PressurePolicy(), { frameMs: 50, ...otherAfter(20, 21) });

    // Confidence is how clearly it won, not how large it was.
    expect(clear!.confidence).toBeGreaterThan(narrow!.confidence);
  });
});

describe("PressurePolicy — without the main-thread probe", () => {
  it("still recognises our own work, because that is measured directly", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: 40, runtimeMs: 30, probeDelayMs: null });

    expect(out!.source).toBe("runtime");
    expect(out!.mainOtherMs).toBeNull();
  });

  it("will not split the rest without evidence", () => {
    const p = new PressurePolicy();
    const out = run(p, { frameMs: 40, runtimeMs: 2, probeDelayMs: null });

    // Something is eating 38ms. Which of the main thread or the GPU it is
    // cannot be answered from timing alone.
    expect(out!.source).toBe("unknown");
  });

  it("leans on a long task, but only as a lean", () => {
    const p = new PressurePolicy();
    const out = run(p, {
      frameMs: 40, runtimeMs: 2, probeDelayMs: null, longTasks: 1,
    });

    expect(out!.source).toBe("main-thread");
    // The Long Task API fires above 50ms, so it proves something blocked and
    // nothing about how much of this frame it accounts for.
    expect(out!.confidence).toBeLessThan(0.5);
  });
});

describe("PressurePolicy — long tasks are a positive signal only", () => {
  it("corroborates a main-thread verdict", () => {
    const withTask = run(new PressurePolicy(), {
      frameMs: 50, ...otherAfter(40, 2), longTasks: 1,
    });
    const without = run(new PressurePolicy(), {
      frameMs: 50, ...otherAfter(40, 2), longTasks: 0,
    });

    expect(withTask!.confidence).toBeGreaterThan(without!.confidence);
  });

  it("does not weaken a render verdict by being absent", () => {
    const p = new PressurePolicy();
    const out = run(p, {
      frameMs: 45, runtimeMs: 2, probeDelayMs: 3, preRuntimeMs: 0.4, longTasks: 0,
    });

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
      frameMs: 12, ...otherAfter(0.5, 9), budgetMs: budget120,
    });

    expect(out!.source).toBe("runtime");
  });

  it("speaks up on a page running at 5fps", () => {
    const p = new PressurePolicy();
    // At 30 required samples this stayed silent for six seconds — on exactly
    // the page most in need of an answer.
    let emitted = null;
    for (let i = 0; i < 15; i++) {
      emitted =
        p.push({
          frameMs: 200,
          runtimeMs: 4,
          probeDelayMs: 5,
          preRuntimeMs: 1,
          budgetMs: BUDGET,
          longTasks: 0,
        }) ?? emitted;
    }
    expect(emitted).not.toBeNull();
    expect(emitted!.source).toBe("render");
  });

  it("reports the same confidence for a healthy page before and after measuring", () => {
    const fresh = new PressurePolicy();
    const measured = run(new PressurePolicy(), { frameMs: BUDGET, runtimeMs: 1 });

    // The same verdict must not mean two different things depending on whether
    // a frame has been seen yet. There is no cause to be unsure about when
    // there is no cause.
    expect(fresh.state.source).toBe("none");
    expect(measured!.source).toBe("none");
    expect(fresh.state.confidence).toBe(measured!.confidence);
  });

  it("clears its verdict on reset", () => {
    const p = new PressurePolicy();
    run(p, { frameMs: 40, ...otherAfter(1, 30) });
    expect(p.state.source).toBe("runtime");

    p.reset();
    expect(p.state.source).toBe("none");
    expect(p.state.mainOtherMs).toBeNull();
    expect(p.state.frameMs).toBe(0);
  });
});
