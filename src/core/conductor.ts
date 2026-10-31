import { RefreshRateProbe } from "./refresh-rate";

/**
 * FrameConductor: the single rAF loop every effect subscribes to, and the
 * scheduler that decides what runs inside it.
 *
 * - Lanes run in a fixed order, input then update then render, so sensors read
 *   before anything draws.
 * - The loop only runs while it has subscribers.
 * - dt is clamped so a tab waking from the background doesn't feed a huge delta
 *   into spring and damping maths.
 * - When a frame runs long, low-priority work is skipped for that frame. A
 *   subscriber skipped `MAX_CONSECUTIVE_SHED` times in a row is forced through.
 *
 * The budget each frame shrinks by how far the previous frame overran, so time
 * lost to React, layout, paint or the GPU counts too. Per-subscriber cost comes
 * from the clock reads the shed decision already makes, so measuring it is free.
 */

export type ConductorLane = "input" | "update" | "render";
export type FrameFn = (dt: number, time: number) => void;

/** What a subscriber is worth when the frame runs out of room. */
export type SubscriberPriority = "essential" | "enhanced" | "decorative";

export interface SubscribeOptions {
  /**
   * Shed order under load. Default `"enhanced"`.
   *
   * `"essential"` is never shed: use it for sensors, governors and direct
   * manipulation. `"decorative"` sheds first and can fall to about 12fps under
   * sustained load, so pair it with `hz` for anything whose position a viewer
   * follows.
   */
  priority?: SubscriberPriority;
  /**
   * Cap this subscriber's cadence, in runs per second. Omit or `0` for every
   * frame. The dt passed in accumulates, so damping stays correct.
   *
   * Set this on decorative work whose motion the eye tracks. The starvation
   * guard forces shed work through every fifth frame, which is 12fps at 60Hz and
   * looks broken on anything being followed. `hz: 30` runs on a steady two-frame
   * gap and does less total work. A shader or particle field doesn't need it.
   */
  hz?: number;
  /** Name shown in devtools and in slow-subscriber warnings. */
  label?: string;
  /**
   * The interaction scope this work belongs to. While another scope holds the
   * foreground lease, this subscriber sheds one band earlier. Omit for work that
   * belongs to no region: it counts as background whenever a lease is held.
   * `essential` work is never affected.
   */
  scope?: string;
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
  /**
   * The interaction region this work belongs to, or `null` for background
   * work. Compare against `ConductorStats.activeScope` to see what is
   * currently protected.
   */
  scope: string | null;
}

export interface ConductorStats {
  running: boolean;
  /** Detected display refresh rate. 60 until the probe settles. */
  displayHz: number;
  /** One presented frame in ms, the budget everything is measured against. */
  frameBudgetMs: number;
  /** Smoothed frames per second, from the rAF interval. */
  fps: number;
  /** Smoothed rAF-to-rAF interval, in ms. */
  frameMs: number;
  /** Smoothed time this runtime spent executing subscribers, in ms. */
  workMs: number;
  /** Decaying peak of `workMs`, in ms. */
  worstWorkMs: number;
  /**
   * How much of this frame was already spent before we ran anything, carried
   * from the previous frame's overrun. Non-zero means something outside this
   * runtime is eating the frame, and it is why low-priority work is shedding.
   */
  carriedOverrunMs: number;
  /** Scope currently holding the foreground lease, or null. */
  activeScope: string | null;
  /** Human-readable name of that scope, when one was given. */
  activeScopeLabel: string | null;
  /**
   * How much of this frame was gone before the runtime got it, in ms, smoothed.
   * Every rAF callback in a frame receives the same start timestamp, so the gap
   * between that and our tick is other code's frame work, usually a third-party
   * library's own loop. Large values mean shedding our own work will help least.
   */
  preRuntimeMs: number;
  subscriberCount: number;
  /** Subscribers skipped on the most recent frame. */
  shedLastFrame: number;
  /** Per-subscriber breakdown, most expensive first. */
  subscribers: SubscriberStat[];
}

export interface ConductorConfig {
  /**
   * Drop low-priority work when a frame runs long. Default `true`. Turning it
   * off makes every subscriber run unconditionally.
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
// Two frames can share a timestamp and a clock can step backwards. Either gives
// a dt of zero or less, and one NaN from rate maths then survives every
// smoothing pass. A real frame is never this short: 240Hz is 4.16ms.
const MIN_DT = 0.001;

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

/**
 * Thresholds for work outside the scope holding the foreground lease. Each band
 * drops to the next one down, so during a drag ambient work yields before the
 * thing under the finger does.
 */
const DEMOTED_THRESHOLD: Record<SubscriberPriority, number> = {
  essential: Infinity,
  enhanced: 0.45,
  decorative: 0.2,
};

/**
 * Smoothing for the carried overrun. It reacts within a few frames and recovers
 * over about half a second, because symmetric smoothing oscillates: shedding
 * rescues the frame, the debt clears, the work returns, the frame blows out.
 */
const OVERRUN_RISE_ALPHA = 0.25;
const OVERRUN_DECAY_ALPHA = 0.03;

/**
 * Cap the debt at one frame budget. Beyond that it would take longer to pay off
 * after a one-off stall (a tab wake, a long task) than the information is worth.
 */
const MAX_DEBT_FACTOR = 1;

/**
 * Debt shrinks the budget and never takes it below this fraction. Spending the
 * debt up front instead would put every threshold below the starting position
 * at full debt, so all three bands would shed on frame entry and priority would
 * stop meaning anything.
 */
const MIN_BUDGET_FRACTION = 0.25;

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
  demotedShedAt: number;
  scope: string | null;
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

/**
 * The rate the browser is presenting at when it holds the page below the
 * display's rate, or null when it isn't. An iPhone in Low Power Mode and Chrome
 * with Energy Saver both run rAF at 30fps on a 60Hz panel.
 *
 * Set only by presentation-cap.ts. It is module state because every public
 * member of FrameConductor is published API through `getConductor()`.
 */
let presentationCapHz: number | null = null;

/** Internal. Not exported from any entry; see presentation-cap.ts. */
export function setPresentationCap(hz: number | null): void {
  presentationCapHz = hz;
}

/**
 * One presented frame in ms: the display's period, or the capped one. A capped
 * page is judged against the rate it is allowed to run at.
 */
function budgetMsFor(refresh: RefreshRateProbe): number {
  return presentationCapHz !== null ? 1000 / presentationCapHz : refresh.frameBudgetMs;
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
  private preRuntimeEma = 0;
  private overrunEma = 0;
  /** Innermost-last. The tail holds the foreground lease. */
  private scopeStack: Array<{ scope: string; label?: string }> = [];

  private shedding = true;
  private onError: ConductorConfig["onError"];
  private slowSubscriberMs = 0;

  /**
   * Tune scheduling and diagnostics. Safe to call at any time. Omitted fields
   * keep their current value.
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

  /** One presented frame in ms, what "over budget" is measured against. */
  get frameBudgetMs(): number {
    return budgetMsFor(this.refresh);
  }

  /**
   * Time spent executing subscribers on the previous frame, in ms, smoothed.
   * Read from the input lane, which runs first, this is the completed previous
   * frame, matching `dt`.
   */
  get workMs(): number {
    return this.workMsEma;
  }

  /** The scope currently holding the foreground claim, or null. */
  get foregroundScope(): string | null {
    return this.scopeStack.length > 0
      ? this.scopeStack[this.scopeStack.length - 1].scope
      : null;
  }

  /**
   * The label of the scope holding the foreground claim, for display. Scope ids
   * are generated, so this is the only part a human can read.
   */
  get foregroundLabel(): string | null {
    return this.scopeStack.length > 0
      ? (this.scopeStack[this.scopeStack.length - 1].label ?? null)
      : null;
  }

  /**
   * Claim the foreground for an interaction. Returns a release function.
   *
   * ```ts
   * const release = getConductor().claimScope("gallery");
   * // on pointerup:
   * release();
   * ```
   *
   * While a lease is held, subscribers outside this scope shed one band earlier,
   * so ambient work gives up its frame time to what the user is touching.
   * Essential work is exempt. Claims nest: releasing restores the one beneath,
   * and releasing twice is a no-op.
   */
  claimScope(scope: string, label?: string): () => void {
    this.scopeStack.push({ scope, label });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      // Remove the newest matching claim, not the oldest: overlapping claims on
      // the same scope must unwind in the order they were taken.
      for (let i = this.scopeStack.length - 1; i >= 0; i--) {
        if (this.scopeStack[i].scope === scope) {
          this.scopeStack.splice(i, 1);
          return;
        }
      }
    };
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
      demotedShedAt: DEMOTED_THRESHOLD[priority],
      scope: options.scope ?? null,
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
   * A snapshot for devtools and HUDs. Allocates, so call it a few times a second
   * at most, never inside a frame loop.
   */
  get state(): ConductorStats {
    const subscribers: SubscriberStat[] = [];
    for (const lane of LANE_ORDER) {
      for (const s of this.lanes[lane]) {
        if (!s.alive) continue;
        subscribers.push({
          scope: s.scope,
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
      frameBudgetMs: budgetMsFor(this.refresh),
      fps: this.frameMsEma > 0 ? 1000 / this.frameMsEma : 0,
      frameMs: this.frameMsEma,
      workMs: this.workMsEma,
      worstWorkMs: this.worstWorkMs,
      carriedOverrunMs: this.overrunEma,
      activeScope: this.foregroundScope,
      activeScopeLabel: this.foregroundLabel,
      preRuntimeMs: this.preRuntimeEma,
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

    // No frames on a server. Subscribing still succeeds and returns a working
    // unsubscribe, and the loop starts when the client subscribes. This entry is
    // framework-agnostic, so a Vue `setup()` or a SvelteKit load can reach here.
    if (typeof requestAnimationFrame === "undefined") return;

    this.last = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;

    // A stopped loop has no recent past and can't decay these back down. Left
    // alone, work mounted later would inherit a full frame of debt and shed from
    // its first frame.
    this.overrunEma = 0;
    this.preRuntimeEma = 0;
    this.shedLastFrame = 0;
  }

  private report(error: unknown, sub: Subscriber): void {
    if (this.onError) {
      this.onError(error, sub.label, sub.lane);
      return;
    }
    // Log the first failure per subscriber. One throwing every frame would
    // otherwise bury the actual bug in the console.
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

    // `now` is when the frame's rendering steps began, and every rAF callback
    // in the frame receives it. So the difference between it and the clock
    // right now is whatever ran before us this frame.
    this.preRuntimeEma += (performance.now() - now - this.preRuntimeEma) * 0.2;

    const rawIntervalMs = now - this.last;
    this.last = now;
    const dt = Math.min(Math.max(rawIntervalMs / 1000, MIN_DT), MAX_DT);
    this.time += dt;

    this.refresh.push(rawIntervalMs);
    const budgetMs = budgetMsFor(this.refresh);

    // How far the previous frame overran, capped so a single stall doesn't
    // leave us shedding for seconds afterwards. Rises fast, decays slow.
    const overrunMs = Math.min(
      Math.max(0, rawIntervalMs - budgetMs),
      budgetMs * MAX_DEBT_FACTOR,
    );
    this.overrunEma +=
      (overrunMs - this.overrunEma) *
      (overrunMs > this.overrunEma ? OVERRUN_RISE_ALPHA : OVERRUN_DECAY_ALPHA);
    const debtMs = this.overrunEma;
    // What is actually left of this frame to spend, floored so the priority
    // bands stay ordered even when the debt is at its cap.
    const effectiveBudgetMs = Math.max(
      budgetMs - debtMs,
      budgetMs * MIN_BUDGET_FRACTION,
    );
    const foreground = this.foregroundScope;

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
          // Half-frame bias: run on the frame nearest the requested cadence. A
          // plain `accum >= interval` turns 30Hz into 20Hz whenever the interval
          // doesn't divide evenly into the frame time.
          if (sub.accum + dt * 0.5 < sub.interval) continue; // not due yet
        }

        // Work outside the scope holding the lease yields a band early.
        const shedAt =
          foreground === null || sub.scope === foreground ? sub.shedAt : sub.demotedShedAt;

        if (
          this.shedding &&
          sub.starve < MAX_CONSECUTIVE_SHED &&
          cursor - frameStart > effectiveBudgetMs * shedAt
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
          // One broken effect must not stop the loop.
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

/** Lazy singleton: safe to import in SSR modules, constructed on first use. */
export function getConductor(): FrameConductor {
  if (instance === null) instance = new FrameConductor();
  return instance;
}
