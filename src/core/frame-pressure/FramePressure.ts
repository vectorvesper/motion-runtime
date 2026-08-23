import { getConductor } from "../conductor";

/**
 * FramePressure — what is actually eating the frame.
 *
 * AnimationBudget can tell you the page is late. It cannot tell you why, and
 * the difference decides what to do about it. Shedding our own work when the
 * GPU is the bottleneck removes motion and fixes nothing; lowering render
 * quality when a third-party script is blocking the main thread does the same.
 *
 * ## The decomposition
 *
 * One frame is split three ways:
 *
 *     frameMs = runtimeMs + mainTailMs + offThreadMs
 *
 * - `runtimeMs`  — our own subscribers. The conductor already measures this,
 *                  because it has to read the clock between subscribers anyway
 *                  to know how much of the frame is left.
 * - `mainTailMs` — how long the main thread stayed busy after our callback
 *                  returned: everyone else's rAF work, style, layout, paint.
 * - `offThreadMs`— the remainder. Compositing, the GPU, and on a healthy page,
 *                  simply waiting for the next vsync.
 *
 * That last point is why this only classifies when a frame is over budget. On
 * a page hitting 60fps, `offThreadMs` is mostly idle, and reading idle as
 * "render pressure" would be worse than saying nothing.
 *
 * ## How mainTailMs is measured
 *
 * A message is posted to a `MessageChannel` at the end of the frame callback.
 * Messages are delivered as tasks, and tasks only run once the main thread
 * finishes what it is doing — which, at that point in the frame, means the rest
 * of the rendering steps. The delay before it arrives is the main thread's
 * remaining frame work.
 *
 * It is sampled at roughly 10Hz rather than every frame. The classifier only
 * needs to update a few times a second, and posting a task 120 times a second
 * to measure cost is its own kind of cost — see the note in the vault about
 * anything that watches the runtime also running inside it.
 *
 * ## What this deliberately does NOT claim
 *
 * **It does not measure GPU time.** No browser exposes that without an
 * `EXT_disjoint_timer_query` on a WebGL context the runtime does not own.
 * `"render"` means "the main thread was free and the frame was still late",
 * which points at compositing or the GPU without proving which.
 *
 * **Long tasks are a positive signal only.** The Long Task API fires above
 * 50ms, so a page spending 25ms per frame on main-thread JS produces no long
 * tasks at all. Seeing one is evidence of main-thread pressure; not seeing one
 * is evidence of nothing.
 *
 * **Nothing acts on this yet.** It reports. Shedding, quality tiers and mount
 * gates are unchanged. A classifier that is wrong is worse than no classifier,
 * so it earns the right to drive decisions by being read first.
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
   * How clearly the winner beat the runner-up, 0–1. Below ~0.3 the verdict is
   * a lean, not a finding. Anything acting on this should require a floor.
   */
  confidence: number;
  /** Smoothed wall-clock frame interval, ms. */
  frameMs: number;
  /** Smoothed time in our own subscribers, ms. */
  runtimeMs: number;
  /** Smoothed main-thread time after our callback, ms. `null` until probed. */
  mainTailMs: number | null;
  /** Smoothed remainder — compositing, GPU, and vsync wait, ms. */
  offThreadMs: number;
  /** One presented frame at the detected display rate, ms. */
  budgetMs: number;
  /** Long tasks seen since the last emit. */
  longTasks: number;
}

/** A frame this much over budget is worth explaining. */
const SLOW_FACTOR = 1.25;
/** Frames to observe before saying anything at all. */
const MIN_SAMPLES = 30;
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
  /** `null` when this frame was not probed. */
  mainTailMs: number | null;
  budgetMs: number;
  /** Long tasks observed since the previous sample. */
  longTasks: number;
}

/**
 * The decision logic, with no browser in it.
 *
 * Separated so it can be tested by feeding synthetic frames, the same way
 * BudgetPolicy is. Everything a browser is needed for lives in the singleton
 * below.
 */
export class PressurePolicy {
  private frameEma = 0;
  private runtimeEma = 0;
  private tailEma: number | null = null;
  private budgetMs = 1000 / 60;
  private samples = 0;
  private longTasks = 0;
  private sinceEmit = 0;
  private source: PressureSource = "none";
  private confidence = 0;

  get state(): PressureState {
    const tail = this.tailEma;
    const off = Math.max(0, this.frameEma - this.runtimeEma - (tail ?? 0));
    return {
      source: this.source,
      confidence: this.confidence,
      frameMs: this.frameEma,
      runtimeMs: this.runtimeEma,
      mainTailMs: tail,
      offThreadMs: off,
      budgetMs: this.budgetMs,
      longTasks: this.longTasks,
    };
  }

  reset(): void {
    this.frameEma = 0;
    this.runtimeEma = 0;
    this.tailEma = null;
    this.samples = 0;
    this.longTasks = 0;
    this.sinceEmit = 0;
    this.source = "none";
    this.confidence = 0;
  }

  /** Feed one frame. Returns a state when it is worth emitting, else null. */
  push(sample: PressureSample): PressureState | null {
    this.budgetMs = sample.budgetMs;
    this.longTasks += sample.longTasks;
    this.samples++;

    const a = this.samples === 1 ? 1 : ALPHA;
    this.frameEma += (sample.frameMs - this.frameEma) * a;
    this.runtimeEma += (sample.runtimeMs - this.runtimeEma) * a;
    if (sample.mainTailMs !== null) {
      this.tailEma =
        this.tailEma === null
          ? sample.mainTailMs
          : this.tailEma + (sample.mainTailMs - this.tailEma) * ALPHA;
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
    // Healthy frames are not a mystery worth solving. `offThreadMs` on a page
    // hitting its target is mostly waiting for vsync, and reading idle time as
    // render pressure would be worse than saying nothing.
    if (this.frameEma <= this.budgetMs * SLOW_FACTOR) {
      this.source = "none";
      this.confidence = 1;
      return;
    }

    const frame = this.frameEma;
    const runtime = this.runtimeEma;
    const tail = this.tailEma;

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
    // Essential, and on the input lane: a classifier that gets shed exactly
    // when the page is struggling would go quiet in the only situation it
    // exists for. It costs one subtraction and, ten times a second, one
    // postMessage.
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
    const stats = conductor.getStats();

    const longTasks = this.longTasksSinceFrame;
    this.longTasksSinceFrame = 0;

    const tail = this.pendingTail;
    this.pendingTail = null;

    const emitted = this.policy.push({
      frameMs: stats.frameMs,
      runtimeMs: stats.workMs,
      mainTailMs: tail,
      budgetMs: stats.frameBudgetMs,
      longTasks,
    });

    // Sample the main thread roughly ten times a second rather than every
    // frame. The verdict only changes slowly, and a probe that runs at frame
    // rate is measuring a cost it is helping to create.
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
