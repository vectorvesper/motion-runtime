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
 * ## Carried overrun (v0.4)
 *
 * Shedding used to compare only our own elapsed work against the budget. That
 * made it unreachable in the normal case: when React, style, layout, paint or
 * the GPU are what is eating the frame, our subscribers might total 3ms of a
 * 16.6ms budget while the frame actually lands in 28ms. We would measure 3ms,
 * conclude there was room, and run everything — on a page visibly at 29fps.
 *
 * So the budget each frame is reduced by how far the PREVIOUS frame overran,
 * taken from the wall clock: a frame that landed 11ms late leaves about 5ms to
 * spend rather than 16.6, and every band scales down with it. The debt is what
 * the interval says, whoever caused it.
 *
 * Reducing the budget rather than pre-spending the frame is deliberate.
 * Pre-spending collapses the design under load — at full debt every threshold
 * lies below the starting position, so all three bands shed on frame entry and
 * priority stops meaning anything precisely when it matters most.
 *
 * The debt rises quickly and decays slowly on purpose. Symmetric smoothing
 * oscillates — shedding rescues the frame, the debt clears, the work returns,
 * the frame blows out again. Slow decay holds the quality decision steady
 * until the page has been healthy for a while.
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
   *
   * `"essential"` is never shed — reserve it for sensors, governors and
   * direct manipulation (a scrub that stutters is a broken scrub).
   *
   * `"decorative"` sheds first, and under sustained load lands on the
   * starvation floor of roughly 12fps. That is right for ambient work and
   * wrong for anything whose position a viewer follows — pair it with `hz` in
   * that case, and read the note there.
   */
  priority?: SubscriberPriority;
  /**
   * Cap this subscriber's cadence, in runs per second. Omit or `0` for every
   * frame. The dt passed in accumulates, so damping math stays correct.
   *
   * **Declare this for any decorative work whose motion the eye tracks.**
   *
   * Shedding does not stutter — the starvation guard forces a skipped
   * subscriber through after four frames, so heavily shed work runs on a
   * perfectly regular beat. The problem is which beat: every fifth frame is
   * 12fps at 60Hz, and 12fps reads as broken for anything whose *position* is
   * being followed, however even it is. Film is 24.
   *
   * Measured on the benchmark: one decorative element left to shedding ran on
   * a 5-frame gap 59 times out of 59 — regular, and visibly bad. The same
   * element with `hz: 30` ran on a 2-frame gap, looked fine, and did *less*
   * total work than the shed version.
   *
   * So this is not a consolation prize for slow work. For tracked motion it is
   * better looking and cheaper than the alternative.
   *
   * Work that degrades gracefully — a shader, a particle field, an ambient
   * canvas — does not need it. Rendering that slightly less often is not
   * something anyone can point at.
   */
  hz?: number;
  /** Name shown in devtools and in slow-subscriber warnings. */
  label?: string;
  /**
   * Which interaction scope this work belongs to. While some OTHER scope holds
   * the foreground lease, this subscriber sheds one band earlier than its
   * priority would normally allow. Omit for work that belongs to no particular
   * region — that is treated as background whenever any lease is held.
   *
   * `essential` is never affected, whatever the scope.
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
   * How much of this frame was already gone before the runtime got it, in ms,
   * smoothed. Every rAF callback in a frame receives the same start timestamp,
   * so the gap between that and the moment our tick actually runs is other
   * people's frame work — a third-party library's own loop, most often.
   *
   * Large values mean the page is main-thread bound by something that is not
   * us, which is the one case where shedding our own work helps least.
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
// Two frames can arrive on the same timestamp, and a clock can step backwards.
// Either produces a dt of zero or less, and anything doing rate math divides by
// it — one NaN then sticks forever, because NaN survives every smoothing pass
// it touches. A real frame is never this short: 240Hz is 4.16ms.
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
 * Thresholds used for work OUTSIDE the scope currently holding the foreground
 * lease. Each band drops to the next one down, so during a drag the ambient
 * work elsewhere on the page yields before the thing under the finger does.
 * Essential work is exempt at any threshold.
 */
const DEMOTED_THRESHOLD: Record<SubscriberPriority, number> = {
  essential: Infinity,
  enhanced: 0.45,
  decorative: 0.2,
};

/**
 * Smoothing for the carried overrun. Asymmetric on purpose: react within a few
 * frames, recover over roughly half a second, so quality decisions don't flap.
 */
const OVERRUN_RISE_ALPHA = 0.25;
const OVERRUN_DECAY_ALPHA = 0.03;

/**
 * Cap the debt at one frame budget. Beyond that it would take longer to pay off
 * after a one-off stall (a tab wake, a long task) than the information is worth.
 */
const MAX_DEBT_FACTOR = 1;

/**
 * Debt shrinks the budget rather than pre-spending the frame, and never below
 * this fraction of it. Pre-spending was the obvious model and it was wrong: at
 * full debt every threshold sat below the starting position, so all three
 * priority bands crossed their line on frame entry and shedding stopped
 * discriminating at exactly the load where discriminating matters. Keeping a
 * floor means the bands stay ordered however deep the debt gets.
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
   * While a lease is held, every subscriber that did NOT declare this scope
   * sheds one band earlier — so ambient work elsewhere on the page gives up its
   * frame time to the thing the user is actually touching. Priorities are a
   * fixed statement about what work is worth; a lease is a live statement about
   * where attention currently is. Essential work is exempt either way.
   *
   * Claims nest. The most recent holds the lease, and releasing restores the one
   * beneath it. Releasing twice is a no-op.
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
   * A snapshot for devtools and HUDs. Allocates, so call it at a human refresh
   * rate (a few times a second) and never inside a frame loop.
   *
   * Named `state` since 3.0 to match the other five singletons. This was the
   * only one exposing a method, and it is the one people reach for most.
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
      frameBudgetMs: this.refresh.frameBudgetMs,
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
    this.last = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  private stop(): void {
    if (this.rafId === null) return;
    cancelAnimationFrame(this.rafId);
    this.rafId = null;

    // Everything describing the recent past stops being true the moment the
    // loop stops, because a stopped loop has no recent past — and unlike a
    // running one it cannot decay these back down.
    //
    // Left alone, a page that struggled, unmounted everything, and later
    // mounted something new would hand the new work a full frame of inherited
    // debt and shed it from the very first frame. That looks like motion
    // glitching for no reason, and the reason stopped existing a while ago.
    this.overrunEma = 0;
    this.preRuntimeEma = 0;
    this.shedLastFrame = 0;
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

    // `now` is when the frame's rendering steps began, and every rAF callback
    // in the frame receives it. So the difference between it and the clock
    // right now is whatever ran before us this frame.
    this.preRuntimeEma += (performance.now() - now - this.preRuntimeEma) * 0.2;

    const rawIntervalMs = now - this.last;
    this.last = now;
    const dt = Math.min(Math.max(rawIntervalMs / 1000, MIN_DT), MAX_DT);
    this.time += dt;

    this.refresh.push(rawIntervalMs);
    const budgetMs = this.refresh.frameBudgetMs;

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
          // Half-frame bias: run on the frame NEAREST the requested cadence
          // rather than always the one after it. Testing `accum >= interval`
          // straight would turn a 30Hz request into 20Hz whenever the
          // interval doesn't divide evenly into the frame time.
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
