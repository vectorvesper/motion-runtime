import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PressureSource } from "../frame-pressure/FramePressure";

/**
 * The governor keeps FramePressure running itself, and tests a reduction
 * before it refuses one.
 *
 * `fuse()` was always tested with a verdict handed straight to it, so nothing
 * noticed when, from 4.0.0, the verdict it read in production was the initial
 * "none" forever: FramePressure only measures while subscribed, and the one
 * subscriber left with useSceneGate's old code (vault RB-2). These drive the
 * class through its subscriptions, the way every page does.
 */

type Verdict = { source: PressureSource; confidence: number; frameMs: number };

const pressure = {
  state: { source: "none", confidence: 1, frameMs: 16.7 } as Verdict,
  listeners: new Set<(s: Verdict) => void>(),
  report(next: Verdict) {
    this.state = next;
    for (const fn of [...this.listeners]) fn(next);
  },
};

const budget = {
  listeners: new Set<(b: { tier: 0 | 1 | 2 }) => void>(),
  report(tier: 0 | 1 | 2) {
    for (const fn of [...this.listeners]) fn({ tier });
  },
};

vi.mock("../frame-pressure/FramePressure", async (original) => ({
  ...(await original<typeof import("../frame-pressure/FramePressure")>()),
  getFramePressure: () => ({
    get state() {
      return pressure.state;
    },
    subscribe(fn: (s: Verdict) => void) {
      pressure.listeners.add(fn);
      fn(pressure.state);
      return () => pressure.listeners.delete(fn);
    },
  }),
}));

vi.mock("../animation-budget/AnimationBudget", async (original) => ({
  ...(await original<typeof import("../animation-budget/AnimationBudget")>()),
  getAnimationBudget: () => ({
    subscribe(fn: (b: { tier: 0 | 1 | 2 }) => void) {
      budget.listeners.add(fn);
      return () => budget.listeners.delete(fn);
    },
  }),
}));

async function governor() {
  vi.resetModules();
  const { getAdaptiveQuality } = await import("./AdaptiveQuality");
  const seen: { tier: number; cause: string }[] = [];
  const off = getAdaptiveQuality().subscribe((s) => seen.push({ tier: s.tier, cause: s.cause }));
  return { seen, off, last: () => seen.at(-1) };
}

const healthy: Verdict = { source: "none", confidence: 1, frameMs: 16.7 };
const blocked: Verdict = { source: "main-thread", confidence: 0.99, frameMs: 23.3 };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["performance"] });
  pressure.state = healthy;
  pressure.listeners.clear();
  budget.listeners.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AdaptiveQuality keeps its own classifier running (RB-2)", () => {
  it("subscribes to FramePressure while anything listens, and lets go after", async () => {
    const { off } = await governor();
    expect(pressure.listeners.size).toBe(1);
    off();
    expect(pressure.listeners.size).toBe(0);
  });

  it("stays quiet when a new verdict changes nothing", async () => {
    const { seen } = await governor();
    const settled = seen.length;
    pressure.report(healthy);
    pressure.report({ source: "unknown", confidence: 0, frameMs: 16.7 });
    expect(seen.length).toBe(settled);
  });
});

describe("AdaptiveQuality tries a reduction before refusing one (RB-2)", () => {
  it("reduces for a blocked main thread, then restores full quality once reducing did not help", async () => {
    const g = await governor();
    pressure.report(blocked);
    budget.report(1);
    // Reduce first, even though the main thread is blamed.
    expect(g.last()).toEqual({ tier: 1, cause: "frame-rate" });

    vi.advanceTimersByTime(2100);
    // Two seconds later frames are no faster: a smaller scene cannot fix this.
    pressure.report({ ...blocked, frameMs: 23.1 });
    expect(g.last()).toEqual({ tier: 0, cause: "held" });
  });

  it("keeps the reduction when it made frames faster, even when the main thread is blamed", async () => {
    // An overloaded GPU stalling the main thread inside WebGL calls: the
    // classifier blames the main thread, but reducing fixes it.
    const g = await governor();
    pressure.report({ source: "main-thread", confidence: 0.9, frameMs: 33.3 });
    budget.report(2);
    expect(g.last()).toEqual({ tier: 2, cause: "frame-rate" });

    vi.advanceTimersByTime(2100);
    pressure.report({ source: "main-thread", confidence: 0.9, frameMs: 17.2 });
    expect(g.last()).toEqual({ tier: 2, cause: "frame-rate" });

    // And it does not get a second chance to hold later in the same spell.
    vi.advanceTimersByTime(5000);
    pressure.report({ source: "main-thread", confidence: 0.99, frameMs: 30 });
    expect(g.last()).toEqual({ tier: 2, cause: "frame-rate" });
  });

  it("stays full after the block lifts, while the budget waits out its recovery", async () => {
    const g = await governor();
    pressure.report(blocked);
    budget.report(2);
    vi.advanceTimersByTime(2100);
    pressure.report(blocked);
    expect(g.last()).toEqual({ tier: 0, cause: "held" });

    // Frames are healthy again, but the budget tier has not recovered yet.
    pressure.report(healthy);
    expect(g.last()).toEqual({ tier: 0, cause: "held" });

    budget.report(0);
    expect(g.last()).toEqual({ tier: 0, cause: "ok" });
  });

  it("does not hold when nobody can be blamed", async () => {
    const g = await governor();
    pressure.report({ source: "unknown", confidence: 0, frameMs: 24 });
    budget.report(2);
    vi.advanceTimersByTime(2100);
    pressure.report({ source: "unknown", confidence: 0, frameMs: 24 });
    expect(g.last()).toEqual({ tier: 2, cause: "frame-rate" });
  });

  it("drops a hold when rendering becomes the bottleneck", async () => {
    const g = await governor();
    pressure.report(blocked);
    budget.report(2);
    vi.advanceTimersByTime(2100);
    pressure.report(blocked);
    expect(g.last()).toEqual({ tier: 0, cause: "held" });

    pressure.report({ source: "render", confidence: 0.8, frameMs: 30 });
    expect(g.last()).toEqual({ tier: 2, cause: "render" });
  });

  it("lowers quality at once when rendering is confidently the bottleneck", async () => {
    const g = await governor();
    budget.report(1);
    pressure.report({ source: "render", confidence: 0.8, frameMs: 25 });
    expect(g.last()).toEqual({ tier: 1, cause: "render" });
  });

  it("starts a fresh trial in the next slow spell", async () => {
    const g = await governor();
    pressure.report(blocked);
    budget.report(2);
    vi.advanceTimersByTime(2100);
    pressure.report(blocked);
    expect(g.last()).toEqual({ tier: 0, cause: "held" });

    budget.report(0);
    pressure.report(healthy);
    expect(g.last()).toEqual({ tier: 0, cause: "ok" });

    // A new spell is reduced first again, not held on the strength of the old one.
    pressure.report(blocked);
    budget.report(1);
    expect(g.last()).toEqual({ tier: 1, cause: "frame-rate" });
  });
});
