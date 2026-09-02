import { describe, it, expect } from "vitest";
import { BudgetPolicy, type BudgetState } from "./AnimationBudget";

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

const FAST = 16.6; // ms — healthy 60fps
const SLOW = 25;   // ms — ~40fps, slow but not very-slow
const PANIC = 50;  // ms — 20fps

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

    // ~9 seconds of healthy frames → one step up, not a jump to 0
    t = feed(p, FAST, 550, t).t;
    expect(p.state.tier).toBe(1);

    // another ~9 seconds → back to full quality
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
});

describe("BudgetPolicy — the 60fps quality floor", () => {
  /**
   * Purely refresh-relative thresholds inverted the mechanism: the better the
   * display, the harsher the verdict. A steady 100fps scored tier 0 on a 60Hz
   * panel and tier 2 on a 240Hz one — survival mode on hardware that needed no
   * help at all, which is the opposite of what adaptive quality is for.
   */
  const HUNDRED_FPS = 10; // ms — excellent for a 3D scene on any display

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
    feed(p, PANIC, 200, 0); // 20fps — bad on any display
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
    feed(p, 25, 200, 0); // 40fps — faster than this display can present
    expect(p.state.tier).toBe(0);
  });
});
