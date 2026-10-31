import { getConductor } from "../conductor";

/**
 * FramePressure: what is eating the frame.
 *
 * AnimationBudget says the page is late but not why, and the answer decides the
 * response. Shedding our own work doesn't help when the GPU is the bottleneck,
 * and lowering render quality doesn't help when another script is blocking the
 * main thread.
 *
 * One frame is split three ways:
 *
 *     frameMs = runtimeMs + mainOtherMs + unattributedMs
 *
 * - `runtimeMs`: our own subscribers, measured by the conductor.
 * - `mainOtherMs`: main-thread work that isn't ours, before and after our tick.
 * - `unattributedMs`: the remainder. Compositing, the GPU, and on a healthy page
 *   waiting for vsync, which is why only over-budget frames are classified.
 *
 * Work after our tick is measured with a `MessageChannel` message posted from
 * the input lane, because a task only runs once the main thread finishes the
 * rest of the frame. Work before it comes from `ConductorStats.preRuntimeMs`.
 * The probe runs at about 10Hz: the verdict changes slowly, and a probe at frame
 * rate measures a cost it helps create.
 *
 * Limits:
 *
 * - No GPU time. That needs `EXT_disjoint_timer_query` on a context the runtime
 *   doesn't own, so `"render"` means the main thread was free and the frame was
 *   still late.
 * - Long tasks only count as positive evidence. The API fires above 50ms, so
 *   25ms per frame of main-thread JS produces none.
 * - The split is serial and the pipeline isn't. Frame time is closer to the
 *   longer of the CPU and GPU paths than to their sum, so `unattributedMs` shows
 *   how long the frame waited on the GPU, not how much GPU work exists.
 *
 * AdaptiveQuality's `fuse()` reads the verdict and holds a subscription, because
 * this only measures while subscribed. Shedding and mount gates don't read it.
 */

/** What is eating the frame. */
export type PressureSource =
  /** Frames are healthy. Nothing is being eaten. */
  | "none"
  /** Our own subscribers are the largest cost. Shedding them will help. */
  | "runtime"
  /** Someone else's main-thread work. Delay mounts and warm-up, do not shed. */
  | "main-thread"
  /** The main thread was free and the frame was still late. Lower quality. */
  | "render"
  /** Not enough evidence. Hold quality and change nothing. */
  | "unknown";

export interface PressureState {
  source: PressureSource;
  /**
   * How clearly the winner beat the runner-up, 0 to 1. Below about 0.3 the
   * verdict is only a lean. Anything acting on this should require a floor.
   */
  confidence: number;
  /** Smoothed wall-clock frame interval, ms. */
  frameMs: number;
  /** Smoothed time in our own subscribers, ms. */
  runtimeMs: number;
  /**
   * Main-thread time this frame that isn't ours, in ms: work before our tick
   * plus work after it. `null` until the probe has reported at least once.
   */
  mainOtherMs: number | null;
  /** Smoothed remainder: compositing, GPU and vsync wait, in ms. */
  unattributedMs: number;
  /** One presented frame at the detected display rate, ms. */
  budgetMs: number;
  /** Long tasks seen since the last emit. */
  longTasks: number;
}

/**
 * A render verdict below this confidence isn't acted on. A realistic heavy
 * scene measures about 0.52 in a real browser, so the floor sits under that
 * while still rejecting a coin-flip.
 *
 * Internal, and shared with AdaptiveQuality and presentation-cap.ts so the
 * number has one home.
 */
export const RENDER_CONFIDENCE_FLOOR = 0.4;

/**
 * A frame this much over budget is worth explaining: 20.8ms at 60Hz, about
 * 48fps.
 *
 * AnimationBudget's line is lower, 1.11 or about 54fps, because it answers a
 * different question. It asks whether the page is struggling, with hysteresis
 * behind it. This asks which subsystem is to blame, which needs enough overrun
 * to attribute.
 *
 * Between 54 and 48fps this reports `"none"` while `useSceneGate` is already
 * constraining on tier. Matching AnimationBudget's line would put a second,
 * undamped signal on a decision the tier owns, and tighten the quality feedback
 * loop: reduced quality makes rendering cheap, the signal clears, quality
 * returns, and frames go slow again.
 *
 * So this isn't a general render-pressure detector: a page at 55fps because of
 * the GPU reads `"none"`. `scripts/pressure-probe/page.html` drives its render
 * scenario to 2x-3.2x budget to clear this line, so that band moves with this
 * constant.
 */
const SLOW_FACTOR = 1.25;
/**
 * Frames to observe before saying anything. At 30 this stays silent for six
 * seconds on a page running at 5fps, the page most in need of an answer.
 */
const MIN_SAMPLES = 12;
/** Emit at most this often, in seconds. */
const EMIT_INTERVAL = 0.5;
/** EMA weight. Slower than the budget's, because this drives quality choices. */
const ALPHA = 0.15;
/**
 * A share below this is never called the cause, even if it is the largest.
 * Three roughly equal thirds is not a finding.
 */
const MIN_WINNING_SHARE = 0.4;

export interface PressureSample {
  frameMs: number;
  runtimeMs: number;
  /** Time gone in this frame before the runtime ran. Other people's rAF work. */
  preRuntimeMs: number;
  /**
   * Raw MessageChannel round trip, or `null` when this frame wasn't probed.
   * Measured from the input lane, so it includes our own update and render
   * work. `mainOther()` nets that out.
   */
  probeDelayMs: number | null;
  budgetMs: number;
  /** Long tasks observed since the previous sample. */
  longTasks: number;
}

/**
 * The decision logic with no browser in it, tested by feeding synthetic frames
 * the same way BudgetPolicy is.
 */
export class PressurePolicy {
  private frameEma = 0;
  private runtimeEma = 0;
  private tailEma: number | null = null;
  private preEma = 0;
  private budgetMs = 1000 / 60;
  private samples = 0;
  private longTasks = 0;
  private sinceEmit = 0;
  private source: PressureSource = "none";
  /**
   * Starts at 1, matching what `classify()` reports for a healthy page.
   * `confidence` describes the named cause, and `"none"` has no cause to be
   * unsure about.
   */
  private confidence = 1;

  get state(): PressureState {
    const other = this.mainOther();
    const off = Math.max(0, this.frameEma - this.runtimeEma - (other ?? 0));
    return {
      source: this.source,
      confidence: this.confidence,
      frameMs: this.frameEma,
      runtimeMs: this.runtimeEma,
      mainOtherMs: other,
      unattributedMs: off,
      budgetMs: this.budgetMs,
      longTasks: this.longTasks,
    };
  }

  /**
   * Main-thread time that belongs to somebody else.
   *
   * The probe is posted from the input lane, which runs first, so its delay
   * also contains our own update and render work. Subtracting the conductor's
   * figure leaves other people's share. Work before our tick never reaches the
   * probe, which is what `preRuntimeMs` is for. Without it, a third-party rAF
   * loop registered ahead of ours reads as off-thread and the verdict comes
   * back "render".
   */
  private mainOther(): number | null {
    if (this.tailEma === null) return null;
    const raw = this.preEma + Math.max(0, this.tailEma - this.runtimeEma);
    // The two halves are smoothed independently and can briefly total more than
    // the frame they describe. Attributing more time than the frame contains is
    // never right.
    return Math.min(raw, Math.max(0, this.frameEma - this.runtimeEma));
  }

  reset(): void {
    this.frameEma = 0;
    this.runtimeEma = 0;
    this.tailEma = null;
    this.preEma = 0;
    this.samples = 0;
    this.longTasks = 0;
    this.sinceEmit = 0;
    this.source = "none";
    this.confidence = 1;
  }

  /** Feed one frame. Returns a state when it is worth emitting, else null. */
  push(sample: PressureSample): PressureState | null {
    this.budgetMs = sample.budgetMs;
    this.longTasks += sample.longTasks;
    this.samples++;

    const a = this.samples === 1 ? 1 : ALPHA;
    this.frameEma += (sample.frameMs - this.frameEma) * a;
    this.runtimeEma += (sample.runtimeMs - this.runtimeEma) * a;
    this.preEma += (sample.preRuntimeMs - this.preEma) * a;
    if (sample.probeDelayMs !== null) {
      this.tailEma =
        this.tailEma === null
          ? sample.probeDelayMs
          : this.tailEma + (sample.probeDelayMs - this.tailEma) * ALPHA;
    }

    this.sinceEmit += sample.frameMs / 1000;
    if (this.samples < MIN_SAMPLES || this.sinceEmit < EMIT_INTERVAL) return null;
    this.sinceEmit = 0;

    this.classify();
    const out = this.state;
    this.longTasks = 0;
    return out;
  }

  private classify(): void {
    // `unattributedMs` on a page hitting its target is mostly waiting for vsync,
    // and reading idle time as render pressure would be worse than saying
    // nothing.
    if (this.frameEma <= this.budgetMs * SLOW_FACTOR) {
      this.source = "none";
      this.confidence = 1;
      return;
    }

    const frame = this.frameEma;
    const runtime = this.runtimeEma;
    const tail = this.mainOther();

    // Without the probe we can still recognise our own work, because the
    // conductor measures that directly. We cannot split the rest.
    if (tail === null) {
      const share = runtime / frame;
      if (share >= MIN_WINNING_SHARE) {
        this.source = "runtime";
        this.confidence = share;
      } else if (this.longTasks > 0) {
        // A weak lean. The Long Task API only proves something blocked; it
        // cannot say how much of this frame it accounts for.
        this.source = "main-thread";
        this.confidence = 0.3;
      } else {
        this.source = "unknown";
        this.confidence = 0;
      }
      return;
    }

    const off = Math.max(0, frame - runtime - tail);
    const shares: Array<[PressureSource, number]> = [
      ["runtime", runtime / frame],
      ["main-thread", tail / frame],
      ["render", off / frame],
    ];
    shares.sort((x, y) => y[1] - x[1]);

    const [winner, winShare] = shares[0];
    const runnerUp = shares[1][1];

    if (winShare < MIN_WINNING_SHARE) {
      // Three roughly equal thirds is not a finding.
      this.source = "unknown";
      this.confidence = 0;
      return;
    }

    this.source = winner;
    // How clearly it won, not how large it was. A 45% winner over a 44%
    // runner-up should not read as confident.
    this.confidence = Math.min(1, (winShare - runnerUp) / winShare);

    // A long task corroborates a main-thread verdict and cannot corroborate
    // anything else, so it only ever raises confidence in that one direction.
    if (winner === "main-thread" && this.longTasks > 0) {
      this.confidence = Math.min(1, this.confidence + 0.2);
    }
  }
}

type PressureListener = (state: PressureState) => void;

class FramePressure {
  private policy = new PressurePolicy();
  private listeners = new Set<PressureListener>();
  private unsubscribe: (() => void) | null = null;
  private observer: PerformanceObserver | null = null;
  private channel: MessageChannel | null = null;

  private longTasksSinceFrame = 0;
  private probeSentAt = 0;
  private probeInFlight = false;
  private pendingTail: number | null = null;
  private framesSinceProbe = 0;

  get state(): PressureState {
    return this.policy.state;
  }

  subscribe(fn: PressureListener): () => void {
    this.listeners.add(fn);
    if (this.unsubscribe === null) this.start();
    fn(this.policy.state);
    return () => {
      this.listeners.delete(fn);
      if (this.listeners.size === 0) this.stop();
    };
  }

  private start(): void {
    this.startLongTaskObserver();
    this.startProbe();
    // Essential, and on the input lane: a classifier shed while the page
    // struggles would go quiet in the only situation it exists for. It costs
    // one subtraction and, ten times a second, one postMessage.
    this.unsubscribe = getConductor().subscribe("input", this.frame, {
      priority: "essential",
      label: "FramePressure",
    });
  }

  private stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.observer?.disconnect();
    this.observer = null;
    this.channel?.port1.close();
    this.channel?.port2.close();
    this.channel = null;
    this.probeInFlight = false;
    this.pendingTail = null;
    this.longTasksSinceFrame = 0;
    this.policy.reset();
  }

  private startLongTaskObserver(): void {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      this.observer = new PerformanceObserver((list) => {
        this.longTasksSinceFrame += list.getEntries().length;
      });
      this.observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Not supported here. The classifier degrades to timing alone, which is
      // why long tasks are never load-bearing on their own.
      this.observer = null;
    }
  }

  private startProbe(): void {
    if (typeof MessageChannel === "undefined") return;
    this.channel = new MessageChannel();
    this.channel.port1.onmessage = () => {
      this.pendingTail = performance.now() - this.probeSentAt;
      this.probeInFlight = false;
    };
    this.channel.port1.start();
  }

  private frame = (): void => {
    const conductor = getConductor();
    const stats = conductor.state;

    const longTasks = this.longTasksSinceFrame;
    this.longTasksSinceFrame = 0;

    const tail = this.pendingTail;
    this.pendingTail = null;

    const emitted = this.policy.push({
      frameMs: stats.frameMs,
      runtimeMs: stats.workMs,
      probeDelayMs: tail,
      preRuntimeMs: stats.preRuntimeMs,
      budgetMs: stats.frameBudgetMs,
      longTasks,
    });

    // Sample about ten times a second. The verdict changes slowly, and a probe
    // at frame rate measures a cost it helps create.
    const every = Math.max(1, Math.round(stats.displayHz / 10));
    this.framesSinceProbe++;
    if (!this.probeInFlight && this.framesSinceProbe >= every && this.channel) {
      this.framesSinceProbe = 0;
      this.probeInFlight = true;
      this.probeSentAt = performance.now();
      this.channel.port2.postMessage(null);
    }

    if (emitted) for (const fn of [...this.listeners]) fn(emitted);
  };
}

let instance: FramePressure | null = null;

/** Lazy singleton. Client-only construction, SSR-import-safe. */
export function getFramePressure(): FramePressure {
  if (instance === null) instance = new FramePressure();
  return instance;
}

export type { FramePressure };
