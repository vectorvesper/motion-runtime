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
 *     frameMs = runtimeMs + mainOtherMs + unattributedMs
 *
 * - `runtimeMs`   — our own subscribers. The conductor already measures this,
 *                   because it has to read the clock between subscribers
 *                   anyway to know how much of the frame is left.
 * - `mainOtherMs` — main-thread work that is not ours, on both sides of our
 *                   tick: another library's rAF loop, style, layout, paint.
 * - `unattributedMs` — the remainder. Compositing, the GPU, and on a healthy
 *                   page, simply waiting for the next vsync.
 *
 * That last point is why this only classifies when a frame is over budget. On
 * a page hitting 60fps, `unattributedMs` is mostly idle, and reading idle as
 * "render pressure" would be worse than saying nothing.
 *
 * ## How the main-thread share is measured
 *
 * Two numbers, because work happens on both sides of us.
 *
 * **After us:** a message is posted to a `MessageChannel` from the input lane.
 * Messages are delivered as tasks, and a task only runs once the main thread
 * finishes what it is doing — at that point in the frame, the rest of the
 * rendering steps. Measured directly in Chrome: with a competing rAF callback
 * burning 24ms, the round trip came back at 24.3ms. Our own update and render
 * work is inside that number too, so the conductor's separate measurement is
 * subtracted back out.
 *
 * **Before us:** `ConductorStats.preRuntimeMs`. Every rAF callback in a frame
 * receives the same start timestamp, so the gap between it and the moment our
 * tick runs is whatever ran first. Without this, a third-party loop registered
 * ahead of ours is invisible to the probe and lands in `unattributedMs` — which
 * made a pure main-thread load report as `"render"` at 97% confidence on the
 * first real-browser run.
 *
 * The probe is sampled at roughly 10Hz rather than every frame. The verdict
 * only changes slowly, and a probe running at frame rate is measuring a cost
 * it is helping to create.
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
 * **The decomposition is serial; the pipeline is not.** Frame time is closer to
 * the longer of the CPU and GPU paths than to their sum, so when the main
 * thread is the bottleneck, GPU time hides inside it and `unattributedMs` shrinks.
 * Measured under 6x CPU throttling, a GPU load that read as `"render"` at
 * normal speed correctly read as `"main-thread"` — the CPU could no longer feed
 * the GPU fast enough, so the CPU genuinely was the bottleneck. The verdict
 * stays actionable, because the answer in that case really is "fix the main
 * thread, do not reduce quality". But do not read `unattributedMs` as a measure of
 * how much GPU work exists; it measures how much of the frame the GPU was the
 * thing being waited on.
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
  /**
   * Main-thread time this frame that is NOT ours, ms — work before our tick
   * plus work after it. `null` until the probe has reported at least once.
   */
  mainOtherMs: number | null;
  /** Smoothed remainder — compositing, GPU, and vsync wait, ms. */
  unattributedMs: number;
  /** One presented frame at the detected display rate, ms. */
  budgetMs: number;
  /** Long tasks seen since the last emit. */
  longTasks: number;
}

/**
 * A frame this much over budget is worth explaining. 20.8ms at 60Hz, ~48fps.
 *
 * ## Why this is later than AnimationBudget's line
 *
 * AnimationBudget uses 1.11 — 18.5ms, ~54fps — and the gap between the two is
 * deliberate, not an oversight. They answer different questions:
 *
 * - **AnimationBudget**: is the page struggling? It degrades to tier 1 at 54fps,
 *   with real hysteresis behind it (30% of a 90-frame window, a 1.5s cooldown
 *   before degrading again, 8s of calm before recovering).
 * - **FramePressure**: once the frame is properly blown, *which* subsystem is
 *   to blame? That question is only worth asking when there is enough overrun
 *   to attribute confidently. Three roughly equal thirds of a mildly late frame
 *   is not a finding.
 *
 * So 54fps → 48fps is a real band where this reports `"none"`, and that is
 * correct: `useSceneGate` is already constraining there, on tier. Lowering this
 * to meet AnimationBudget's line would put a second, faster, un-damped signal
 * onto a decision tier already owns — two subsystems with two beliefs about the
 * same frame, which is the failure the 1.2.0 carried-overrun work existed to
 * remove. It would also tighten the quality feedback loop: reduce quality →
 * rendering gets cheap → the signal clears → quality returns → slow again.
 *
 * **Consequence worth stating plainly:** this is not a general render-pressure
 * detector. A page dropping to 55fps because of the GPU will read `"none"`.
 *
 * The browser harness (`scripts/pressure-probe/page.html`) drives its render
 * scenario to 2x-3.2x budget so it clears this line unambiguously. It used a
 * fixed shader iteration count until GPUs outgrew it, at which point the load
 * produced 17-19ms frames, this threshold correctly said `"none"`, and the test
 * failed for being right. If you change this constant, that band moves with it.
 */
const SLOW_FACTOR = 1.25;
/**
 * Frames to observe before saying anything at all.
 *
 * Low on purpose. At 30 this stayed silent for six seconds on a page running
 * at 5fps — which is exactly the page most in need of an answer. A verdict
 * from a dozen frames is coarse; no verdict at all is useless.
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
   * Raw MessageChannel round trip, or `null` when this frame was not probed.
   *
   * Measured from the input lane, so it contains our own update and render
   * work as well as everyone else's. `mainOther()` is what nets that out —
   * do not read this as "other people's time".
   */
  probeDelayMs: number | null;
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
  private preEma = 0;
  private budgetMs = 1000 / 60;
  private samples = 0;
  private longTasks = 0;
  private sinceEmit = 0;
  private source: PressureSource = "none";
  /**
   * Starts at 1, matching what `classify()` reports for a healthy page.
   *
   * `confidence` describes how sure we are of the named cause. When the source
   * is `"none"` there is no cause to be unsure about, so hedging it would make
   * the same verdict mean two different things depending on whether a frame
   * had been measured yet.
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
   * The probe is posted from the input lane, which runs first, so the delay it
   * measures also contains our own update and render work. Subtracting what the
   * conductor separately measured leaves other people's share. Work that ran
   * *before* our tick never reaches the probe at all, which is what
   * `preRuntimeMs` is for — without it, a third-party rAF loop registered ahead
   * of ours reads as off-thread, and the verdict comes back "render".
   */
  private mainOther(): number | null {
    if (this.tailEma === null) return null;
    const raw = this.preEma + Math.max(0, this.tailEma - this.runtimeEma);
    // The two halves are smoothed independently and can briefly total more
    // than the frame they are supposed to describe. Attributing more time than
    // the frame contains is never right, and a reader who spots it stops
    // trusting the whole readout.
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
    // Healthy frames are not a mystery worth solving. `unattributedMs` on a page
    // hitting its target is mostly waiting for vsync, and reading idle time as
    // render pressure would be worse than saying nothing.
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
