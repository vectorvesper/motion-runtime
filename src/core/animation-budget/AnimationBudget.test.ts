import { describe, it, expect } from "vitest";
import { CapPolicy } from "../presentation-cap";
import { BudgetPolicy, type BudgetState, type BudgetTier } from "./AnimationBudget";

/** Feed `frames` intervals of `dtMs` starting at time `t`; collect emits. */
function feed(
  policy: BudgetPolicy,
  dtMs: number,
  frames: number,
  t: number,
): { t: number; emits: BudgetState[] } {
  const dt = dtMs / 1000;
  const emits: BudgetState[] = [];
  for (let i = 0; i < frames; i++) {
    t += dt;
    const s = policy.push(dt, t);
    if (s) emits.push(s);
  }
  return { t, emits };
}

const FAST = 16.6; // ms, healthy 60fps
const SLOW = 25;   // ms, ~40fps, slow but not very-slow
const PANIC = 50;  // ms, 20fps

describe("BudgetPolicy", () => {
  it("gives no verdict before MIN_SAMPLES", () => {
    const p = new BudgetPolicy();
    const { emits } = feed(p, PANIC, 39, 0);
    expect(emits).toHaveLength(0);
    expect(p.state.tier).toBe(0);
  });

  it("degrades one tier under sustained slow (not very-slow) frames", () => {
    const p = new BudgetPolicy();
    const t = feed(p, FAST, 60, 0).t;
    const { emits } = feed(p, SLOW, 120, t);
    const tierChanges = emits.filter((e) => e.tier > 0);
    expect(tierChanges.length).toBeGreaterThan(0);
    expect(tierChanges[0].tier).toBe(1); // first step is one tier, not a jump
  });

  it("cascades to tier 2 if slowness persists past the cooldown", () => {
    const p = new BudgetPolicy();
    const t = feed(p, FAST, 60, 0).t;
    feed(p, SLOW, 400, t); // ~10s of slow frames
    expect(p.state.tier).toBe(2);
  });

  it("degrades to tier 2 within seconds under very-slow frames", () => {
    const p = new BudgetPolicy();
    const t = feed(p, FAST, 60, 0).t;
    // From a healthy window the 15% very-slow trigger fires a one-tier step
    // first; the next cooldown lands tier 2. ~4s of 20fps must be enough.
    feed(p, PANIC, 80, t);
    expect(p.state.tier).toBe(2);
  });

  it("recovers cautiously: one tier per ~8s of clean frames", () => {
    const p = new BudgetPolicy();
    let t = feed(p, FAST, 60, 0).t;
    t = feed(p, PANIC, 80, t).t; // now tier 2
    expect(p.state.tier).toBe(2);

    // ~9 seconds of healthy frames: one step up, not a jump to 0
    t = feed(p, FAST, 550, t).t;
    expect(p.state.tier).toBe(1);

    // another ~9 seconds: back to full quality
    feed(p, FAST, 550, t);
    expect(p.state.tier).toBe(0);
  });

  it("emits heartbeats without tier changes", () => {
    const p = new BudgetPolicy();
    const { emits } = feed(p, FAST, 300, 0); // ~5s healthy
    expect(emits.length).toBeGreaterThan(5); // ~2Hz heartbeat
    expect(emits.every((e) => e.tier === 0)).toBe(true);
  });

  it("headroom starts at the full 16.6ms budget and decreases as frames slow", () => {
    const p = new BudgetPolicy();
    // After healthy frames, headroom should be close to 16.6ms
    feed(p, FAST, 60, 0);
    expect(p.state.headroom).toBeGreaterThan(0);

    // After slow frames (25ms each), headroom goes negative
    feed(p, SLOW, 60, 1);
    expect(p.state.headroom).toBeLessThan(0);
  });

  it("headroom EMA smooths single spikes — one bad frame doesn't tank it", () => {
    const p = new BudgetPolicy();
    // Warm up with 50 healthy frames
    const { t } = feed(p, FAST, 50, 0);
    const headroomBefore = p.state.headroom;

    // One 40ms spike
    p.push(0.04, t + 0.04);
    const headroomAfter = p.state.headroom;

    // EMA smoothing: a single 40ms spike contributes α=0.5 of the new sample.
    // Healthy 16.6ms frames sit at ~16.6ms of headroom (the runtime reports no
    // work in this synthetic feed), and the spike pulls that down toward the
    // raw sample of -23ms without ever reaching it.
    expect(headroomAfter).toBeLessThan(headroomBefore);
    expect(headroomAfter).toBeGreaterThan(-15); // well above the raw spike floor of -23ms
  });

  it("headroom resets to full budget on reset()", () => {
    const p = new BudgetPolicy();
    feed(p, PANIC, 80, 0); // tank the headroom
    expect(p.state.headroom).toBeLessThan(0);
    p.reset();
    // After reset, headroom EMA is restored to the initial full-budget value
    expect(p.state.headroom).toBeCloseTo(1000 / 60, 0); // ~16.6ms
  });

  it("holds the tier through a single long frame", () => {
    const p = new BudgetPolicy();
    let t = feed(p, FAST, 60, 0).t;
    t = feed(p, PANIC, 80, t).t;
    expect(p.currentTier).toBe(2);

    // A stall, a sleep or a resume says nothing about sustained load.
    t += 0.3;
    expect(p.push(0.3, t)?.tier).toBe(2);
    expect(p.state.slowRatio).toBe(0);
  });
});

describe("BudgetPolicy — the 60fps quality floor", () => {
  /**
   * Purely refresh-relative thresholds would invert the mechanism: a steady
   * 100fps would score tier 0 on a 60Hz panel and tier 2 on a 240Hz one.
   */
  const HUNDRED_FPS = 10; // ms, excellent for a 3D scene on any display

  for (const [label, hz] of [["120Hz", 120], ["144Hz", 144], ["240Hz", 240]] as const) {
    it(`stays at tier 0 on a ${label} display running a steady 100fps`, () => {
      const p = new BudgetPolicy();
      p.setFrameBudget(1 / hz);
      feed(p, HUNDRED_FPS, 200, 0);
      expect(p.state.tier).toBe(0);
      expect(p.state.slowRatio).toBe(0);
    });
  }

  it("still degrades a high-refresh display that is genuinely janky", () => {
    const p = new BudgetPolicy();
    p.setFrameBudget(1 / 144);
    feed(p, PANIC, 200, 0); // 20fps, bad on any display
    expect(p.state.tier).toBe(2);
  });

  it("leaves 60Hz behaviour exactly as it was", () => {
    const healthy = new BudgetPolicy();
    healthy.setFrameBudget(1 / 60);
    feed(healthy, FAST, 200, 0);
    expect(healthy.state.tier).toBe(0);

    const janky = new BudgetPolicy();
    janky.setFrameBudget(1 / 60);
    feed(janky, SLOW, 200, 0); // ~40fps
    expect(janky.state.tier).toBeGreaterThan(0);
  });

  it("still relaxes the line for a display slower than 60Hz", () => {
    // The floor only ever raises the target; a 30Hz panel keeps its own budget.
    const p = new BudgetPolicy();
    p.setFrameBudget(1 / 30);
    feed(p, 25, 200, 0); // 40fps, faster than this display can present
    expect(p.state.tier).toBe(0);
  });
});

describe("BudgetPolicy — a new budget (RB-1)", () => {
  it("says when a new budget discards the window, so listeners hear it at once", () => {
    const p = new BudgetPolicy();
    // Negligible change: nothing discarded.
    expect(p.setFrameBudget(1 / 60)).toBe(false);

    // A battery saver at 30fps, judged against 60: every frame is slow.
    feed(p, 1000 / 30, 400, 0);
    expect(p.currentTier).toBe(2);

    // The cap is recognised and becomes the budget. The verdicts were scored
    // against a line the page could never reach, so they go.
    expect(p.setFrameBudget(1 / 30)).toBe(true);
    expect(p.currentTier).toBe(0);
    expect(p.state.headroom).toBeCloseTo(1000 / 30, 0);
  });

  it("judges a capped page fairly once the cap is its budget", () => {
    const p = new BudgetPolicy();
    p.setFrameBudget(1 / 30);
    feed(p, 1000 / 30, 400, 0);
    expect(p.currentTier).toBe(0);
    // Headroom is what is left of the capped frame, so a mount gate can open.
    expect(p.state.headroom).toBeGreaterThan(6);
  });
});

describe("BudgetPolicy — a new budget re-judges the steps down", () => {
  // A GPU-bound scene on a 60Hz panel lands on whole vsyncs. Full quality
  // takes three, and even the cheapest version misses every other one, so its
  // steady 30fps looks like a battery-saver cap.
  const VSYNC = 1000 / 60;

  it("keeps a step down the new line would still take", () => {
    const p = new BudgetPolicy();
    let t = feed(p, 3 * VSYNC, 60, 0).t;
    expect(p.currentTier).toBe(2);
    t = feed(p, 2 * VSYNC, 90, t).t;

    // Full quality is slow against 30fps too. Dropping to tier 0 here would
    // only bring back the load that caused the step.
    expect(p.setFrameBudget(1 / 30)).toBe(true);
    expect(p.currentTier).toBe(2);
    expect(p.state.slowRatio).toBe(0);

    // The climb back is the normal one, timed from the step at 2s.
    t = feed(p, 2 * VSYNC, 90, t).t; // to 9s
    expect(p.currentTier).toBe(2);
    feed(p, 2 * VSYNC, 45, t); // to 10.5s
    expect(p.currentTier).toBe(1);
  });

  it("undoes only the steps the new line would not take, newest first", () => {
    const p = new BudgetPolicy();
    let t = feed(p, 3 * VSYNC, 40, 0).t; // full quality at 20fps: straight to 2
    t = feed(p, FAST, 500, t).t; // tier 2 holds 60fps, so back up to 1
    expect(p.currentTier).toBe(1);
    feed(p, 2 * VSYNC, 60, t); // tier 1 runs at 30fps, so down again
    expect(p.currentTier).toBe(2);

    // Against 30fps, tier 1 was on time but full quality was still slow.
    p.setFrameBudget(1 / 30);
    expect(p.currentTier).toBe(1);
  });

  it("keeps the tier when the cap lifts", () => {
    const p = new BudgetPolicy();
    p.setFrameBudget(1 / 30);
    feed(p, 3 * VSYNC, 120, 0); // slow against the capped line
    expect(p.currentTier).toBe(2);

    // A stricter line agrees with every step already taken.
    expect(p.setFrameBudget(1 / 60)).toBe(true);
    expect(p.currentTier).toBe(2);
  });

  /**
   * Wired as AnimationBudget wires it: the cap is judged first, every fifth
   * frame as the watcher does, a believed cap becomes the budget, then the
   * frame is scored. `load` is the page's frame time at the tier it was told.
   */
  function governed(
    load: (tier: BudgetTier, frame: number) => number,
    ourScenesDrawing: boolean,
    seconds: number,
  ): { capAt: number | null; steps: Array<{ t: number; tier: BudgetTier }> } {
    const policy = new BudgetPolicy();
    const cap = new CapPolicy();
    const steps: Array<{ t: number; tier: BudgetTier }> = [];
    let budgetS = 1 / 60;
    let capAt: number | null = null;
    let t = 0;
    for (let frame = 1; t < seconds; frame++) {
      const tier = policy.currentTier;
      const ms = load(tier, frame);
      t += ms / 1000;
      cap.push(ms);
      if (frame % 5 === 0) {
        const change = cap.evaluate(t, {
          pressure: { source: "render", confidence: 0.9 },
          ourScenesDrawing,
          lowestTier: tier === 2,
        });
        if (change !== undefined) {
          budgetS = change === null ? 1 / 60 : 1 / change;
          if (change !== null && capAt === null) capAt = t;
        }
      }
      policy.setFrameBudget(budgetS);
      policy.push(ms / 1000, t);
      if (policy.currentTier !== tier) steps.push({ t, tier: policy.currentTier });
    }
    return { capAt, steps };
  }

  it("does not bring the full load back to a GPU-bound page", () => {
    const gpuBound = (tier: BudgetTier, frame: number) =>
      (tier === 0 ? 3 : tier === 1 ? 2 + (frame % 2) : 2) * VSYNC;
    const { capAt, steps } = governed(gpuBound, true, 60);

    expect(capAt).not.toBeNull();
    expect(steps[0].tier).toBeGreaterThan(0);
    expect(steps.filter((s) => s.tier === 0)).toEqual([]);
  });

  it("returns a battery-saver page to full quality once the cap is believed", () => {
    const { capAt, steps } = governed(() => 1000 / 30, false, 20);

    // Every step was the old line's doing, and none comes back under the cap.
    expect(capAt).not.toBeNull();
    expect(steps[steps.length - 1]).toEqual({ t: capAt, tier: 0 });
  });
});
