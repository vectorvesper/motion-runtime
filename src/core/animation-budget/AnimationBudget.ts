import { getConductor } from "../conductor";
import { PresentationCapWatcher } from "../presentation-cap";

/**
 * AnimationBudget: the frame-headroom governor.
 *
 * Measures real frame intervals on the shared conductor and collapses them into
 * a coarse quality tier every effect can consume:
 *
 * - tier 0 "high": frames are healthy, run the designed look
 * - tier 1 "medium": sustained drops below about 54fps, shed extras
 * - tier 2 "low": sustained drops below about 30fps, survival mode
 *
 * These lines are multiples of one presented frame, floored at 1/60 so a faster
 * display never gets a stricter test (see QUALITY_FLOOR_S).
 *
 * Degrading is fast, because users feel jank within a second. Upgrading takes
 * 8s of clean frames, with a cooldown so quality never flaps. A burst of very
 * slow frames can jump straight to tier 2.
 *
 * The decision logic lives in BudgetPolicy, a pure class tested by feeding
 * synthetic frame times. The exported singleton is conductor plumbing around
 * it.
 *
 * `headroom` answers how much of this frame is still free. rAF is pinned to
 * vsync, so dt on a healthy page says nothing about consumption. While frames
 * land on time, the only consumption we can attribute is the runtime's own
 * work, so headroom is `budget - work`. Once a frame runs slow the wall clock
 * takes over and headroom goes negative by the overrun. It is smoothed so one
 * spike doesn't tank it. Use it with `useSafeToMount` to check before mounting
 * expensive components.
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
   * Zero or negative means already over budget. Use it as a leading indicator
   * before mounting expensive components: see `useSafeToMount`.
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
const EMIT_INTERVAL = 0.5;    // s, heartbeat emits for HUDs/debug

/**
 * Slow and very-slow lines as multiples of one presented frame. At 60Hz these
 * land on 18.5ms and 34ms.
 */
const SLOW_FACTOR = 1.11;
const VERY_SLOW_FACTOR = 2.04;

/**
 * The tier never judges a device against a target faster than 60fps.
 *
 * Scoring against the detected refresh rate asks whether we hit the monitor's
 * maximum, which is a different question from whether the device is struggling.
 * A steady 100fps on a 240Hz panel would score every frame as very slow and
 * report tier 2, while the same 100fps on a 60Hz panel reports tier 0.
 *
 * So the comparison floors here. Below 60fps is jank on any display, and above
 * it dropping quality to chase 144Hz only makes things worse. A display slower
 * than 60Hz keeps its own budget, since the floor only raises the line.
 *
 * The cost: a 120Hz page steady at 80fps doesn't read as degraded, which is
 * right, because 80fps isn't a quality emergency.
 */
const QUALITY_FLOOR_S = 1 / 60;

/** Frame-duration lines for a budget, never stricter than the 60fps floor. */
function thresholdsFor(frameBudgetS: number): { slowS: number; verySlowS: number } {
  const judged = Math.max(frameBudgetS, QUALITY_FLOOR_S);
  return { slowS: judged * SLOW_FACTOR, verySlowS: judged * VERY_SLOW_FACTOR };
}

const LABELS = ["high", "medium", "low"] as const;

// 3-frame EMA alpha for headroom smoothing, for a fast response.
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
   * No-op when the change is negligible. Returns whether the window was
   * discarded, so the caller can tell listeners at once.
   */
  setFrameBudget(frameBudgetS: number): boolean {
    if (Math.abs(frameBudgetS - this.frameBudgetS) < 1e-4) return false;
    this.frameBudgetS = frameBudgetS;
    ({ slowS: this.slowS, verySlowS: this.verySlowS } = thresholdsFor(frameBudgetS));
    this.reset();
    return true;
  }

  /** The current tier, without building a state object. Read every frame. */
  get currentTier(): BudgetTier {
    return this.tier;
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

    // While frames land on time, the interval is vsync, not consumption, so the
    // only thing we can account for is our own work. Once a frame runs slow the
    // wall clock is the consumption, whoever caused it.
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
  /** Watches for a battery-saver frame cap while this governor is measuring. */
  private cap: PresentationCapWatcher | null = null;

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
      this.cap = new PresentationCapWatcher();
      // Measure on the input lane: conductor dt is the rAF-to-rAF interval, the
      // true cost of the previous full frame. Essential, because the governor
      // can't govern from a sampled subset of frames.
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
        this.cap?.dispose();
        this.cap = null;
        this.policy.reset();
      }
    };
  }

  private measure = (dt: number, time: number): void => {
    if (typeof document !== "undefined" && document.hidden) {
      return;
    }
    const conductor = getConductor();
    // Before the budget is read: a cap believed on this frame moves the
    // conductor's budget, and this frame should already be judged against it.
    this.cap?.frame(dt * 1000, time, this.policy.currentTier === 2);
    if (this.policy.setFrameBudget(conductor.frameBudgetMs / 1000)) {
      // The window was scored against the old budget and has been discarded.
      // Say so now: left to push(), listeners would hear nothing for MIN_SAMPLES
      // frames, and a gate would keep a stale tier for over a second.
      const reset = this.policy.state;
      for (const fn of [...this.listeners]) fn(reset);
    }
    // The input lane runs first, so the conductor's work figure is the
    // completed previous frame, the same vintage as `dt`.
    const emit = this.policy.push(dt, time, conductor.workMs / 1000);
    if (emit !== null) {
      for (const fn of [...this.listeners]) fn(emit);
    }
  };
}

let instance: AnimationBudget | null = null;

/** Lazy singleton: client-only construction, safe to import in SSR. */
export function getAnimationBudget(): AnimationBudget {
  if (instance === null) instance = new AnimationBudget();
  return instance;
}
