import { setPresentationCap } from "./conductor";
import {
  getFramePressure,
  RENDER_CONFIDENCE_FLOOR,
  type PressureSource,
} from "./frame-pressure/FramePressure";
import { scenesDrawing } from "./scene-activity";

/**
 * Presentation cap: noticing when the browser is the one setting the pace.
 *
 * Browsers on battery saver present pages below the display's rate. An iPhone
 * in Low Power Mode and Chrome with Energy Saver hold rAF to 30fps on a 60Hz
 * panel. Against the display's budget that reads as a page missing every
 * frame: the tier falls to 2, headroom goes negative, `useSafeToMount` never opens,
 * so every gated scene stays unmounted for the whole visit.
 *
 * refresh-rate.ts refuses to read a steady 30fps as a 30Hz display, and that
 * stays right when the page's own load holds it there. This module overrides
 * it only when all three of these hold, unbroken, for HOLD_S:
 *
 * 1. The cadence is steady and below 60fps. Nearly every recent frame lands
 *    within LOCK_TOLERANCE of the same interval. A cap is metronomic, and load
 *    is ragged.
 * 2. The main thread is idle. FramePressure attributes the late frame to
 *    something off the main thread, with confidence. Its probe posts a message
 *    ten times a second, so it only runs while a cap is suspected.
 * 3. Our own scenes aren't the reason. Either none is drawing, or the budget is
 *    at its lowest tier and the cadence didn't move. If the cheapest version of
 *    a scene can't escape the cadence, the full rate is out of reach anyway.
 *
 * Once believed, the cap becomes the conductor's frame budget. It lifts as soon
 * as full-rate frames return, because those are impossible under a cap.
 *
 * The rule may lean towards the cap because the costs are uneven. A false cap
 * holds quality a little too high until the next fast frames. A missed cap
 * leaves scenes unmounted for the whole visit.
 */

/** Recent intervals the cadence is read from: 1.5s at 30fps. */
const WINDOW = 45;
/** No verdict from fewer intervals than this. */
const MIN_SAMPLES = 30;
/** Share of the window that must sit on the cadence for it to count as steady. */
const LOCK_SHARE = 0.9;
/** How close to the cadence an interval must be, relative to it. */
const LOCK_TOLERANCE = 0.1;
/**
 * A cadence must be slower than this to matter, in ms. AnimationBudget never
 * judges a page against more than 60fps, so a cap at or above 60 changes
 * nothing; 17.5ms leaves room for a 60Hz panel's own jitter.
 */
const SLOWEST_UNCAPPED_MS = 17.5;
/** Seconds every condition must hold, unbroken, before the cap is believed. */
const HOLD_S = 1.5;
/**
 * A frame this much shorter than the capped period cannot happen under the
 * cap, so seeing them means it has lifted.
 */
const LIFT_RATIO = 0.75;
/**
 * How many such frames in the window lift the cap. Six, the same
 * corroboration refresh-rate.ts demands, so a two- or three-callback burst
 * after a stall does not.
 */
const LIFT_COUNT = 6;
/** Longer than this is a stall or a resumed tab, not a cadence. */
const MAX_INTERVAL_MS = 90;
/** Frames between verdicts. The window moves slowly; no need to sort it every frame. */
const EVALUATE_EVERY = 5;

/** What the policy needs to know beyond the frame intervals. */
export interface CapContext {
  /** FramePressure's verdict, or null when it is not running. */
  pressure: { source: PressureSource; confidence: number } | null;
  /** Is any of the runtime's own scenes drawing? */
  ourScenesDrawing: boolean;
  /** Is the budget already at its lowest tier? */
  lowestTier: boolean;
}

/** The decision, with no browser in it, so it can be tested directly. */
export class CapPolicy {
  private window = new Float32Array(WINDOW);
  private scratch = new Float32Array(WINDOW);
  private next = 0;
  private filled = 0;
  private cap: number | null = null;
  private heldSince: number | null = null;

  /** The believed cap in Hz, or null. */
  get capHz(): number | null {
    return this.cap;
  }

  /** Feed one frame interval, in ms. */
  push(intervalMs: number): void {
    if (!(intervalMs > 0) || intervalMs > MAX_INTERVAL_MS) return;
    this.window[this.next] = intervalMs;
    this.next = (this.next + 1) % WINDOW;
    if (this.filled < WINDOW) this.filled++;
  }

  /**
   * The rate the recent frames are locked to, in Hz, when they are steady and
   * slower than 60fps. Null otherwise.
   */
  steadyRate(): number | null {
    const n = this.filled;
    if (n < MIN_SAMPLES) return null;

    const sorted = this.scratch.subarray(0, n);
    sorted.set(this.window.subarray(0, n));
    sorted.sort();
    const median = n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    if (median <= SLOWEST_UNCAPPED_MS) return null;

    const tolerance = median * LOCK_TOLERANCE;
    let on = 0;
    for (let i = 0; i < n; i++) if (Math.abs(sorted[i] - median) <= tolerance) on++;
    if (on / n < LOCK_SHARE) return null;

    return Math.round(10000 / median) / 10;
  }

  /**
   * Re-judge at `time` (seconds). Returns the new cap when it changes, a rate
   * when believed and null when it lifts, and undefined when nothing changed.
   */
  evaluate(time: number, ctx: CapContext): number | null | undefined {
    if (this.cap !== null) {
      const fast = (1000 / this.cap) * LIFT_RATIO;
      let quick = 0;
      for (let i = 0; i < this.filled; i++) if (this.window[i] < fast) quick++;
      if (quick < LIFT_COUNT) return undefined;
      this.cap = null;
      this.heldSince = null;
      // The window is full of capped frames. Kept, it would read as a steady
      // cadence again on the very next verdict.
      this.filled = 0;
      this.next = 0;
      return null;
    }

    const rate = this.steadyRate();
    const idle =
      ctx.pressure !== null &&
      ctx.pressure.source === "render" &&
      ctx.pressure.confidence >= RENDER_CONFIDENCE_FLOOR;
    const notOurs = !ctx.ourScenesDrawing || ctx.lowestTier;

    if (rate === null || !idle || !notOurs) {
      this.heldSince = null;
      return undefined;
    }
    if (this.heldSince === null) {
      this.heldSince = time;
      return undefined;
    }
    if (time - this.heldSince < HOLD_S) return undefined;

    this.cap = rate;
    this.heldSince = null;
    return rate;
  }

  reset(): void {
    this.filled = 0;
    this.next = 0;
    this.cap = null;
    this.heldSince = null;
  }
}

const noop = (): void => {};

/**
 * The policy wired to the browser. AnimationBudget owns one for as long as it
 * is measuring and feeds it every frame it measures, so the cap is watched
 * exactly when something is judging frames against a budget.
 */
export class PresentationCapWatcher {
  private policy = new CapPolicy();
  private releasePressure: (() => void) | null = null;
  private sinceVerdict = 0;

  /** One frame: its interval in ms, the conductor time in seconds. */
  frame(intervalMs: number, time: number, lowestTier: boolean): void {
    this.policy.push(intervalMs);
    if (++this.sinceVerdict < EVALUATE_EVERY) return;
    this.sinceVerdict = 0;

    // Only while a cap is suspected and not yet believed. FramePressure posts a
    // message ten times a second while it runs; a page at full rate, or one
    // already known to be capped, has no question for it.
    const suspected = this.policy.capHz === null && this.policy.steadyRate() !== null;
    if (suspected && this.releasePressure === null) {
      this.releasePressure = getFramePressure().subscribe(noop);
    } else if (!suspected && this.releasePressure !== null) {
      this.releasePressure();
      this.releasePressure = null;
    }

    const change = this.policy.evaluate(time, {
      pressure: this.releasePressure !== null ? getFramePressure().state : null,
      ourScenesDrawing: scenesDrawing() > 0,
      lowestTier,
    });
    if (change !== undefined) setPresentationCap(change);
  }

  /**
   * Stop watching. A cap nobody watches can go stale when the charger goes in,
   * so it is cleared.
   */
  dispose(): void {
    this.releasePressure?.();
    this.releasePressure = null;
    if (this.policy.capHz !== null) setPresentationCap(null);
    this.policy.reset();
  }
}
