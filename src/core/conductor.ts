import { RefreshRateProbe } from "./refresh-rate";

/**
 * FrameConductor — the single rAF loop every VV effect subscribes to, and the
 * scheduler that decides what actually gets to run inside it.
 *
 * Rules it enforces:
 * - One loop per page. Effects never create private rAF loops.
 * - Lanes run in a fixed order each frame: input → update → render,
 *   so readers (sensors) always run before writers (draw calls).
 * - The loop only runs while it has subscribers (zero idle cost).
 * - dt is clamped so a backgrounded tab waking up doesn't feed a huge
 *   delta into spring/damping math.
 *
 * ## Scheduling (v0.3)
 *
 * A shared loop is tidy. A shared loop that *makes decisions* is the reason
 * this is a runtime and not a utility. Subscribers declare what they are:
 *
 * - `essential`  — sensors, governors, direct manipulation. Always runs.
 * - `enhanced`   — interaction feedback. Shed once the frame is nearly spent.
 * - `decorative` — ambient garnish. Shed first.
 *
 * When a frame runs long, low-priority work is skipped FOR THAT FRAME rather
 * than letting everything degrade together — so ten coordinated effects can
 * cost less than three uncoordinated ones. Nothing starves: a subscriber
 * skipped `MAX_CONSECUTIVE_SHED` times in a row is forced through, so heavy
 * pages degrade decorative work to a lower framerate instead of freezing it.
 *
 * `hz` throttles a subscriber to a slower cadence. The accumulated dt is
 * passed through, so frame-rate-independent damping stays correct at any
 * cadence — an ambient background at 30Hz looks identical and costs half.
 *
 * ## Attribution
 *
 * Per-subscriber cost measurement is free: the scheduler already has to read
 * the clock after each subscriber to know how much of the frame is left, so
 * the shed decision and the cost breakdown come from the same timestamp.
 * There is exactly one `performance.now()` call per executed subscriber.
 */

export type ConductorLane = "input" | "update" | "render";
export type FrameFn = (dt: number, time: number) => void;

/** What a subscriber is worth when the frame runs out of room. */
export type SubscriberPriority = "essential" | "enhanced" | "decorative";

export interface SubscribeOptions {
  /**
   * Shed order under load. Default `"enhanced"`.
   * `"essential"` is never shed — reserve it for sensors, governors and
   * direct manipulation (a scrub that stutters is a broken scrub).
   */
  priority?: SubscriberPriority;
  /**
   * Cap this subscriber's cadence, in runs per second. Omit or `0` for every
   * frame. The dt passed in accumulates, so damping math stays correct.
   */
  hz?: number;
  /** Name shown in devtools and in slow-subscriber warnings. */
  label?: string;
}

export interface SubscriberStat {
  label: string;
  lane: ConductorLane;
  priority: SubscriberPriority;
  /** Smoothed execution time of this subscriber alone, in ms. */
  costMs: number;
  /** Most recent execution time, in ms. */
  lastCostMs: number;
  /** Throttle cadence, or `null` when it runs every frame. */
  hz: number | null;
  /** Frames this subscriber has executed. */
  runs: number;
  /** Frames skipped because the frame ran out of budget. */
  shed: number;
}

export interface ConductorStats {
  running: boolean;
  /** Detected display refresh rate. 60 until the probe settles. */
  displayHz: number;
  /** One presented frame, in ms — the budget everything is measured against. */
  frameBudgetMs: number;
  /** Smoothed frames per second, from the rAF interval. */
  fps: number;
  /** Smoothed rAF-to-rAF interval, in ms. */
  frameMs: number;
  /** Smoothed time this runtime spent executing subscribers, in ms. */
  workMs: number;
  /** Decaying peak of `workMs`, in ms. */
  worstWorkMs: number;
  subscriberCount: number;
  /** Subscribers skipped on the most recent frame. */
  shedLastFrame: number;
  /** Per-subscriber breakdown, most expensive first. */
  subscribers: SubscriberStat[];
}

export interface ConductorConfig {
  /**
   * Drop low-priority work when a frame runs long. Default `true` — turning
   * it off makes every subscriber run unconditionally, as in v0.1.
   */
  shedding?: boolean;
  /**
   * Called instead of `console.error` when a subscriber throws. The loop
   * always continues regardless.
   */
  onError?: (error: unknown, label: string, lane: ConductorLane) => void;
  /**
   * Warn once per subscriber that exceeds this execution time, in ms.
   * `0` disables. Default `0`.
   */
  slowSubscriberMs?: number;
}

const LANE_ORDER: ConductorLane[] = ["input", "update", "render"];
const MAX_DT = 0.1; // seconds; anything longer is a tab-sleep artifact

const PRIORITY_RANK: Record<SubscriberPriority, number> = {
  essential: 0,
  enhanced: 1,
  decorative: 2,
};

/**
 * Fraction of the frame budget after which each priority stops running.
 * Essential work has no ceiling. Decorative work yields early so that
 * interaction feedback still has room behind it.
 */
const SHED_THRESHOLD: Record<SubscriberPriority, number> = {
  essential: Infinity,
  enhanced: 0.7,
  decorative: 0.45,
};

/** A subscriber skipped this many frames running is forced through. */
const MAX_CONSECUTIVE_SHED = 4;

/** Smoothing for the rolling frame/work averages. */
const EMA_ALPHA = 0.1;
/** Per-frame decay applied to the worst-work peak. */
const WORST_DECAY = 0.98;

interface Subscriber {
  fn: FrameFn;
  lane: ConductorLane;
  priority: SubscriberPriority;
  rank: number;
  shedAt: number;
  label: string;
  /** Seconds between runs; 0 = every frame. */
  interval: number;
  hz: number | null;
  /** dt banked since this subscriber last ran (throttling only). */
  accum: number;
  costMs: number;
  lastCostMs: number;
  runs: number;
  shed: number;
  /** Consecutive frames shed, for the starvation guard. */
  starve: number;
  alive: boolean;
  warnedSlow: boolean;
  warnedError: boolean;
}

class FrameConductor {
  private lanes: Record<ConductorLane, Subscriber[]> = {
    input: [],
    update: [],
    render: [],
  };
  private liveCount = 0;
  private compactNeeded = false;
  private ticking = false;

  private rafId: number | null = null;
  private last = 0;
  private time = 0;

  private refresh = new RefreshRateProbe();
  private frameMsEma = 0;
  private workMsEma = 0;
  private worstWorkMs = 0;
  private shedLastFrame = 0;

  private shedding = true;
  private onError: ConductorConfig["onError"];
  private slowSubscriberMs = 0;

  /**
   * Tune scheduling and diagnostics. Safe to call at any time; partial —
   * omitted fields keep their current value.
   */
  configure(config: ConductorConfig): void {
    if (config.shedding !== undefined) this.shedding = config.shedding;
    if (config.onError !== undefined) this.onError = config.onError;
    if (config.slowSubscriberMs !== undefined) {
      this.slowSubscriberMs = config.slowSubscriberMs;
    }
  }

  /** Detected display refresh rate in Hz. */
  get displayHz(): number {
    return this.refresh.hz;
  }

  /** One presented frame in ms — what "over budget" is measured against. */
  get frameBudgetMs(): number {
    return this.refresh.frameBudgetMs;
  }

  /**
   * Time this runtime spent executing subscribers on the previous frame, in
   * ms, smoothed. Read from the input lane (which runs first) this is the
   * completed previous frame — the same vintage as `dt`.
   */
  get workMs(): number {
    return this.workMsEma;
  }

  subscribe(lane: ConductorLane, fn: FrameFn, options: SubscribeOptions = {}): () => void {
    const priority = options.priority ?? "enhanced";
    const hz = options.hz !== undefined && options.hz > 0 ? options.hz : null;
    const sub: Subscriber = {
      fn,
      lane,
      priority,
      rank: PRIORITY_RANK[priority],
      shedAt: SHED_THRESHOLD[priority],
      label: options.label ?? "anonymous",
      interval: hz === null ? 0 : 1 / hz,
      hz,
      accum: 0,
      costMs: 0,
      lastCostMs: 0,
      runs: 0,
      shed: 0,
      starve: 0,
      alive: true,
      warnedSlow: false,
      warnedError: false,
    };

    // Keep each lane ordered by priority so that when the budget runs out we
    // have already done the work that matters. Insertion order is preserved
    // within a priority band.
    const list = this.lanes[lane];
    let at = list.length;
    for (let i = 0; i < list.length; i++) {
      if (list[i].rank > sub.rank) {
        at = i;
        break;
      }
    }
    list.splice(at, 0, sub);

    this.liveCount++;
    this.start();

    return () => {
      if (!sub.alive) return; // double-unsubscribe must not evict a re-added fn
      sub.alive = false;
      this.liveCount--;
      this.compactNeeded = true;
      if (!this.ticking) this.compact();
      if (this.liveCount === 0) this.stop();
    };
  }

  /**
   * A snapshot for devtools and HUDs. Allocates — call it at a human refresh
   * rate (a few times a second), never inside a frame loop.
   */
  getStats(): ConductorStats {
    const subscribers: SubscriberStat[] = [];
    for (const lane of LANE_ORDER) {
      for (const s of this.lanes[lane]) {
        if (!s.alive) continue;
        subscribers.push({
          label: s.label,
          lane: s.lane,
          priority: s.priority,
          costMs: s.costMs,
          lastCostMs: s.lastCostMs,
          hz: s.hz,
          runs: s.runs,
          shed: s.shed,
        });
      }
    }
    subscribers.sort((a, b) => b.costMs - a.costMs);
    return {
      running: this.rafId !== null,
      displayHz: this.refresh.hz,
      frameBudgetMs: this.refresh.frameBudgetMs,
      fps: this.frameMsEma > 0 ? 1000 / this.frameMsEma : 0,
      frameMs: this.frameMsEma,
      workMs: this.workMsEma,
      worstWorkMs: this.worstWorkMs,
      subscriberCount: this.liveCount,
      shedLastFrame: this.shedLastFrame,
      subscribers,
    };
  }

  private compact(): void {
    if (!this.compactNeeded) return;
    this.compactNeeded = false;
    for (const lane of LANE_ORDER) {
      const list = this.lanes[lane];
      let write = 0;
      for (let read = 0; read < list.length; read++) {
        if (list[read].alive) list[write++] = list[read];
      }
      list.length = write;
    }
  }

  private start(): void {
    if (this.rafId !== null) return;
    this.last = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;
  }

  private report(error: unknown, sub: Subscriber): void {
    if (this.onError) {
      this.onError(error, sub.label, sub.lane);
      return;
    }
    // Default: log the first failure per subscriber. A subscriber throwing
    // every frame at 60fps would otherwise make the console unusable, and an
    // unusable console hides the actual bug.
    if (sub.warnedError) return;
    sub.warnedError = true;
    console.error(
      `vv-motion: subscriber "${sub.label}" (${sub.lane}) threw; the loop continues. ` +
        `Further errors from this subscriber are suppressed.`,
      error,
    );
  }

  private tick = (now: number): void => {
    this.rafId = requestAnimationFrame(this.tick);

    const rawIntervalMs = now - this.last;
    this.last = now;
    const dt = Math.min(rawIntervalMs / 1000, MAX_DT);
    this.time += dt;

    this.refresh.push(rawIntervalMs);
    const budgetMs = this.refresh.frameBudgetMs;

    this.ticking = true;
    const frameStart = performance.now();
    // Advances only when a subscriber actually executes, so it doubles as
    // "time spent so far this frame" for the shed decision.
    let cursor = frameStart;
    let shed = 0;

    for (const lane of LANE_ORDER) {
      const list = this.lanes[lane];
      // Snapshot the length: anything subscribed mid-frame starts next frame.
      const n = list.length;
      for (let i = 0; i < n; i++) {
        const sub = list[i];
        if (!sub.alive) continue;

        if (sub.interval > 0) {
          sub.accum += dt;
          // Half-frame bias: run on the frame NEAREST the requested cadence
          // rather than always the one after it. Testing `accum >= interval`
          // straight would turn a 30Hz request into 20Hz whenever the
          // interval doesn't divide evenly into the frame time.
          if (sub.accum + dt * 0.5 < sub.interval) continue; // not due yet
        }

        if (
          this.shedding &&
          sub.starve < MAX_CONSECUTIVE_SHED &&
          cursor - frameStart > budgetMs * sub.shedAt
        ) {
          // Out of room. Skip without touching accum, so a throttled
          // subscriber stays due and runs with the correct dt next frame.
          sub.starve++;
          sub.shed++;
          shed++;
          continue;
        }
        sub.starve = 0;

        const stepDt = sub.interval > 0 ? sub.accum : dt;
        sub.accum = 0;

        try {
          sub.fn(stepDt, this.time);
        } catch (error) {
          // One broken effect must never kill the page's heartbeat.
          this.report(error, sub);
        }

        const after = performance.now();
        const cost = after - cursor;
        cursor = after;

        sub.lastCostMs = cost;
        sub.costMs = sub.runs === 0 ? cost : sub.costMs + (cost - sub.costMs) * EMA_ALPHA;
        sub.runs++;

        if (this.slowSubscriberMs > 0 && cost > this.slowSubscriberMs && !sub.warnedSlow) {
          sub.warnedSlow = true;
          console.warn(
            `vv-motion: subscriber "${sub.label}" (${sub.lane}) took ${cost.toFixed(1)}ms ` +
              `on one frame, over the ${this.slowSubscriberMs}ms threshold. ` +
              `Further warnings from this subscriber are suppressed.`,
          );
        }
      }
    }

    const workMs = cursor - frameStart;
    this.workMsEma += (workMs - this.workMsEma) * EMA_ALPHA;
    this.frameMsEma =
      this.frameMsEma === 0
        ? rawIntervalMs
        : this.frameMsEma + (rawIntervalMs - this.frameMsEma) * EMA_ALPHA;
    this.worstWorkMs = Math.max(workMs, this.worstWorkMs * WORST_DECAY);
    this.shedLastFrame = shed;

    this.ticking = false;
    this.compact();
  };
}

let instance: FrameConductor | null = null;

/** Lazy singleton — safe to import in SSR modules, only constructed on use. */
export function getConductor(): FrameConductor {
  if (instance === null) instance = new FrameConductor();
  return instance;
}
