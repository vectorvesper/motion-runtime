import { getConductor } from "../conductor";

/**
 * AnimationBudget — the frame-headroom governor.
 *
 * Measures real frame intervals on the shared conductor and collapses them
 * into a coarse quality tier every effect can consume. The contract:
 *
 * - tier 0 "high":   frames are healthy, run the designed look
 * - tier 1 "medium": sustained drops below ~54fps — shed extras
 * - tier 2 "low":    sustained drops below ~30fps — survival mode
 *
 * Those lines are absolute, not a fraction of the display rate. See
 * QUALITY_FLOOR_S: a display faster than 60Hz does not get a stricter test,
 * because "not saturating a 240Hz panel" is not the same as "struggling".
 *
 * Hysteresis is asymmetric BY DESIGN: degrading is fast (users feel jank
 * within a second), upgrading is slow and cautious (8s of clean frames),
 * with a cooldown so quality never flaps. A burst of very-slow frames can
 * jump straight to tier 2.
 *
 * The decision logic lives in BudgetPolicy — a pure class with no browser
 * dependencies, unit-tested by feeding synthetic frame times. The exported
 * singleton is just conductor plumbing around it.
 *
 * ## Refresh-rate relative (v0.3)
 *
 * Thresholds were absolute (54fps / 30fps), which told a 120Hz display
 * limping at 70fps that everything was fine. They became multiples of the
 * measured frame budget, chosen to reproduce the old constants EXACTLY at
 * 60Hz (18.5ms and 34ms).
 *
 * ## Floored again (v4.0.1)
 *
 * Purely relative thresholds inverted the whole mechanism on good hardware:
 * a steady 100fps read as tier 0 on a 60Hz panel and tier 2 on a 240Hz one.
 * The multiples remain, but the budget they multiply is floored at 1/60 —
 * so a slow display still gets a relaxed line and a fast one never gets a
 * stricter one. See QUALITY_FLOOR_S for the reasoning and what it gives up.
 *
 * ## Honest headroom (v0.3)
 *
 * `headroom` used to be `frameBudget - dt`. Because rAF is pinned to vsync,
 * dt on a healthy 60Hz page is 16.6ms — so a perfectly idle page reported
 * ~0ms of headroom and the whole signal was unusable below 60Hz. It now
 * answers the question it always claimed to: **how much of this frame is
 * still free?**
 *
 * - While frames are landing on time, the only consumption we can attribute
 *   is the runtime's own measured work, so headroom is `budget - work`.
 * - Once a frame runs slow, the wall clock is the truth — something off our
 *   books is eating the frame — so consumption is the whole interval and
 *   headroom goes negative by the overrun.
 *
 * Smoothed as an EMA so one spike doesn't tank it. Use it with
 * `useSafeToMount` to pre-check before mounting expensive components,
 * rather than waiting for the tier to degrade.
 */

export type BudgetTier = 0 | 1 | 2;

export interface BudgetState {
  tier: BudgetTier;
  label: "high" | "medium" | "low";
  /** Rolling average frame interval, in milliseconds. */
  avgFrameMs: number;
  /** Share of recent frames slower than the degradation line, 0..1. */
  slowRatio: number;
  /**
   * Estimated milliseconds still free in the current frame budget, smoothed.
   * Positive = room available; zero or negative = already over budget. Use
   * this as a leading indicator before mounting expensive components — see
   * `useSafeToMount`.
   */
  headroom: number;
  /**
   * Milliseconds the motion runtime itself spent on the last frame, smoothed.
   * Everything else in `avgFrameMs` belongs to the browser, React, or
   * third-party scripts.
   */
  workMs: number;
  /** One presented frame at the detected display rate, in milliseconds. */
  frameBudgetMs: number;
}

const WINDOW = 90;            // frames in the rolling window
const MIN_SAMPLES = 40;       // no verdicts before this many frames
const DOWN_RATIO = 0.3;       // degrade when 30% of window is slow
const PANIC_RATIO = 0.3;      // very-slow share that jumps straight to tier 2
const VERY_SLOW_TRIGGER = 0.15; // very-slow share that forces a degradation
const UP_RATIO = 0.06;        // upgrade only when almost nothing is slow
const DOWN_COOLDOWN = 1.5;    // s between degradations
const UP_DELAY = 8;           // s of stability before an upgrade
const EMIT_INTERVAL = 0.5;    // s — heartbeat emits for HUDs/debug

/**
 * Slow / very-slow lines as multiples of one presented frame. At 60Hz these
 * land on 18.5ms and 34ms — the exact absolute constants used in v0.1.
 */
const SLOW_FACTOR = 1.11;
const VERY_SLOW_FACTOR = 2.04;

/**
 * The tier never judges a device against a target faster than 60fps.
 *
 * Scoring purely against the detected refresh rate asks "are we hitting this
 * monitor's maximum?" and treats "no" as "this device is struggling". Those are
 * different questions. Measured on a 240Hz panel, a rock-steady 100fps scored
 * every frame as slow AND very slow and reported tier 2 — survival mode on a
 * machine that needed no help, while the same 100fps on a 60Hz panel reported
 * tier 0. The better the display, the worse the verdict: exactly backwards for
 * a mechanism whose job is protecting weak hardware.
 *
 * So the comparison floors here. Below 60fps is jank on any display and still
 * degrades; above it nobody is suffering, and dropping quality to chase 144Hz
 * makes the experience worse rather than better. A display SLOWER than 60Hz
 * keeps its own budget, since the floor only ever raises the line.
 *
 * The cost is deliberate: a 120Hz page steady at 80fps no longer reads as
 * degraded. That is the correct call — 80fps is not a quality emergency.
 */
const QUALITY_FLOOR_S = 1 / 60;

/** Frame-duration lines for a budget, never stricter than the 60fps floor. */
function thresholdsFor(frameBudgetS: number): { slowS: number; verySlowS: number } {
  const judged = Math.max(frameBudgetS, QUALITY_FLOOR_S);
  return { slowS: judged * SLOW_FACTOR, verySlowS: judged * VERY_SLOW_FACTOR };
}

const LABELS = ["high", "medium", "low"] as const;

// 3-frame EMA alpha for headroom smoothing — fast response.
const HEADROOM_ALPHA = 2 / (3 + 1); // α = 0.5
/** Default frame budget in seconds (16.6ms at 60fps) until the probe settles. */
const DEFAULT_FRAME_BUDGET_S = 1 / 60;
/** A frame longer than this is a spike, device sleep, or resume-from-sleep. */
const SPIKE_S = 0.15;

/** Pure hysteresis state machine. push() returns a state when it should be emitted. */
export class BudgetPolicy {
  private dts = new Float32Array(WINDOW);
  private head = 0;
  private count = 0;
  private sum = 0;
  private slowCount = 0;
  private verySlowCount = 0;
  private tier: BudgetTier = 0;
  private lastChange = 0;
  private lastEmit = 0;
  private frameBudgetS: number;
  private slowS: number;
  private verySlowS: number;
  /** EMA of the free share of the frame, in seconds. Starts optimistic. */
  private headroomEma: number;
  /** EMA of the runtime's own per-frame work, in seconds. */
  private workEma = 0;

  constructor(frameBudgetS: number = DEFAULT_FRAME_BUDGET_S) {
    this.frameBudgetS = frameBudgetS;
    ({ slowS: this.slowS, verySlowS: this.verySlowS } = thresholdsFor(frameBudgetS));
    this.headroomEma = frameBudgetS;
  }

  /**
   * Retarget to a new display refresh rate. The rolling window was scored
   * against the old thresholds, so it is discarded rather than reinterpreted.
   * No-op when the change is negligible.
   */
  setFrameBudget(frameBudgetS: number): void {
    if (Math.abs(frameBudgetS - this.frameBudgetS) < 1e-4) return;
    this.frameBudgetS = frameBudgetS;
    ({ slowS: this.slowS, verySlowS: this.verySlowS } = thresholdsFor(frameBudgetS));
    this.reset();
  }

  get state(): BudgetState {
    const n = Math.max(this.count, 1);
    return {
      tier: this.tier,
      label: LABELS[this.tier],
      avgFrameMs: (this.sum / n) * 1000,
      slowRatio: this.slowCount / n,
      headroom: this.headroomEma * 1000, // expose in ms
      workMs: this.workEma * 1000,
      frameBudgetMs: this.frameBudgetS * 1000,
    };
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.sum = 0;
    this.slowCount = 0;
    this.verySlowCount = 0;
    this.tier = 0;
    this.lastChange = 0;
    this.lastEmit = 0;
    this.headroomEma = this.frameBudgetS;
    this.workEma = 0;
  }

  /**
   * Feed one frame interval (seconds) at absolute time (seconds).
   * `workS` is the runtime's own measured work for that frame, in seconds.
   * Returns the state to emit (tier change or heartbeat), or null.
   */
  push(dt: number, time: number, workS = 0): BudgetState | null {
    // A frame longer than 150ms is a transient spike, device sleep, or
    // resume-from-sleep. Reset rather than let it trigger a false panic.
    if (dt > SPIKE_S) {
      this.reset();
      this.lastChange = time;
      this.lastEmit = time;
      return this.state;
    }

    if (this.count === WINDOW) {
      const old = this.dts[this.head];
      this.sum -= old;
      if (old > this.slowS) this.slowCount--;
      if (old > this.verySlowS) this.verySlowCount--;
    } else {
      this.count++;
    }
    this.dts[this.head] = dt;
    this.head = (this.head + 1) % WINDOW;
    this.sum += dt;
    if (dt > this.slowS) this.slowCount++;
    if (dt > this.verySlowS) this.verySlowCount++;

    this.workEma += (workS - this.workEma) * HEADROOM_ALPHA;

    // While frames land on time, the interval is vsync, not consumption — the
    // only thing we can honestly account for is our own work. Once a frame
    // runs slow the wall clock IS the consumption, whoever caused it.
    const consumedS = dt > this.slowS ? dt : workS;
    const sample = this.frameBudgetS - consumedS;
    this.headroomEma += (sample - this.headroomEma) * HEADROOM_ALPHA;

    if (this.count < MIN_SAMPLES) return null;

    const slowRatio = this.slowCount / this.count;
    const panicRatio = this.verySlowCount / this.count;
    const sinceChange = time - this.lastChange;

    let next = this.tier;
    if (
      sinceChange > DOWN_COOLDOWN &&
      this.tier < 2 &&
      (slowRatio > DOWN_RATIO || panicRatio > VERY_SLOW_TRIGGER)
    ) {
      next = panicRatio > PANIC_RATIO ? 2 : ((this.tier + 1) as BudgetTier);
    } else if (sinceChange > UP_DELAY && this.tier > 0 && slowRatio < UP_RATIO) {
      next = (this.tier - 1) as BudgetTier;
    }

    if (next !== this.tier) {
      this.tier = next;
      this.lastChange = time;
      this.lastEmit = time;
      return this.state;
    }
    if (time - this.lastEmit > EMIT_INTERVAL) {
      this.lastEmit = time;
      return this.state;
    }
    return null;
  }
}

type BudgetListener = (state: BudgetState) => void;

class AnimationBudget {
  private policy = new BudgetPolicy();
  private listeners = new Set<BudgetListener>();
  private unsubscribe: (() => void) | null = null;

  constructor() {
    if (typeof document !== "undefined") {
      // visibilitychange is dispatched on document (window misses it in Safari).
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
  }

  private handleVisibilityChange = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      this.policy.reset();
      const state = this.policy.state;
      for (const fn of [...this.listeners]) fn(state);
    }
  };

  get state(): BudgetState {
    return this.policy.state;
  }

  /**
   * Discard the rolling window. Call on SPA route changes: a new scene should
   * not be judged by the frames the previous one produced.
   */
  reset(): void {
    this.policy.reset();
    const state = this.policy.state;
    for (const fn of [...this.listeners]) fn(state);
  }

  /** Emits current state immediately, then on tier changes + a slow heartbeat. */
  subscribe(fn: BudgetListener): () => void {
    this.listeners.add(fn);
    if (this.unsubscribe === null) {
      // Measure on the input lane: conductor dt is the rAF-to-rAF interval,
      // i.e. the true cost of the previous full frame. Essential — the
      // governor cannot govern from a sampled subset of frames.
      this.unsubscribe = getConductor().subscribe("input", this.measure, {
        priority: "essential",
        label: "AnimationBudget",
      });
    }
    fn(this.policy.state);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0 && this.unsubscribe !== null) {
        this.unsubscribe();
        this.unsubscribe = null;
        this.policy.reset();
      }
    };
  }

  private measure = (dt: number, time: number): void => {
    if (typeof document !== "undefined" && document.hidden) {
      return;
    }
    const conductor = getConductor();
    this.policy.setFrameBudget(conductor.frameBudgetMs / 1000);
    // The input lane runs first, so the conductor's work figure is the
    // completed previous frame — the same vintage as `dt`.
    const emit = this.policy.push(dt, time, conductor.workMs / 1000);
    if (emit !== null) {
      for (const fn of [...this.listeners]) fn(emit);
    }
  };
}

let instance: AnimationBudget | null = null;

/** Lazy singleton — client-only construction, SSR-import-safe. */
export function getAnimationBudget(): AnimationBudget {
  if (instance === null) instance = new AnimationBudget();
  return instance;
}
