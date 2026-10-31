/**
 * RendererHealth: has the graphics context died, and how many times.
 *
 * A browser can take a WebGL context away at any moment: a GPU driver reset, a
 * tab backgrounded on a phone, too many live contexts, the OS reclaiming
 * memory. The canvas fires `webglcontextlost`, and React Three Fiber has no
 * handler for it (checked against 9.6.1), so the result is a permanently black
 * canvas with no console error.
 *
 * This is a page-level singleton because a driver reset takes every context at
 * once, and because it must be readable from outside the canvas: R3F runs its
 * own reconciler, so React context doesn't cross the `<Canvas>` boundary. The
 * cost is that one lost context bumps the generation for every scene on the
 * page, which is acceptable: a loss is rare, and a remount is cheap next to a
 * black canvas.
 *
 * Recovery is a generation counter. `webglcontextrestored` only helps if every
 * buffer, texture, program and render target is rebuilt by hand, which R3F
 * doesn't do. Instead the counter increments on loss, a scene puts it on its
 * `<Canvas key>`, React unmounts the dead tree, and R3F builds a new context
 * from the React tree it already has.
 *
 * The adapter still calls `preventDefault()` on the lost event: without it the
 * browser won't attempt a restore, and some drivers refuse a new context on the
 * same page.
 */

export interface RendererHealthState {
  /** True between a context being lost and a replacement being mounted. */
  lost: boolean;
  /**
   * Increments once per loss. Put it on a `<Canvas key>`: changing it makes
   * React throw away the dead tree and build a working one.
   */
  generation: number;
  /** When the most recent loss happened, or `null` if there has not been one. */
  lastLostAt: number | null;
}

/** What a reporter can say about the canvas it lost. */
export interface ReportLostOptions {
  /**
   * The `generation` current when the lost canvas's renderer was created. Read
   * `getRendererHealth().state.generation` at that moment and keep it with the
   * renderer.
   *
   * It tells a replacement from the canvas it replaced. A loss from a canvas
   * built under the current generation always counts, even inside the
   * coalescing window, because that canvas didn't exist when the reset happened.
   *
   * `useRenderQuality` and `watchGPUDevice` pass it for you.
   */
  builtAt?: number;
}

/**
 * How long after a loss another loss is treated as the same reset. A driver
 * reset reaches every canvas within a frame or two. Kept short so a separate
 * failure moments later still registers.
 */
const LOSS_COALESCE_MS = 250;

/**
 * How many rebuilds in a row freshly built canvases may trigger, each inside
 * the coalescing window of the one before.
 *
 * One is the case `builtAt` exists for: a replacement lost moments after it was
 * built. A long run means a page is keeping more live contexts than the browser
 * allows: each rebuild creates a full set, the browser evicts the oldest, and
 * the eviction reads as a fresh loss. Without a limit that loops for as long as
 * the page is open.
 */
const MAX_RAPID_REBUILDS = 3;

/**
 * How long after a loss a rebuild may take before the runtime assumes it
 * worked. Long enough for a slow device to remount a scene and compile its
 * shaders; a replacement that reports healthy sooner ends the wait at once.
 */
const RECOVERY_GRACE_MS = 5000;

type HealthListener = (state: RendererHealthState) => void;

class RendererHealth {
  private lost = false;
  private generation = 0;
  private lastLostAt: number | null = null;
  private listeners = new Set<HealthListener>();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private warnedGrace = false;
  private rapidRebuilds = 0;
  private warnedRebuildLoop = false;

  get state(): RendererHealthState {
    return {
      lost: this.lost,
      generation: this.generation,
      lastLostAt: this.lastLostAt,
    };
  }

  subscribe(fn: HealthListener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Report a lost context. Called by the R3F adapter.
   *
   * Calls inside the coalescing window don't stack: a driver reset fires on
   * every canvas, and one reset should mean one rebuild. Pass `builtAt` and a
   * canvas the last rebuild built is exempt, because its loss is new wherever
   * it falls in the window. A report without `builtAt` is judged by the window
   * alone.
   *
   * A later loss always counts, whether or not anything reported healthy in
   * between, so a forgotten `reportHealthy()` can't kill a scene. The grace
   * timer below clears the stale badge.
   */
  reportLost(options?: ReportLostOptions): void {
    // A time window, because a `lost` flag only holds until a replacement mounts
    // and calls `reportHealthy()`, which happens between the queued loss events.
    // Every loss would look new: one reset across sixteen canvases would mean
    // sixteen rebuilds and up to 256 context creations.
    //
    // A loss this soon after the last is normally the same reset reaching a
    // canvas already replaced, so it is ignored outright: setting `lost` again
    // would report LOST for a page whose replacements are up. A report whose
    // `builtAt` is the current generation is the exception, because only the
    // rebuild can have built that canvas.
    const now = Date.now();
    if (this.lastLostAt !== null && now - this.lastLostAt < LOSS_COALESCE_MS) {
      if (options?.builtAt !== this.generation) return;
      if (this.rapidRebuilds >= MAX_RAPID_REBUILDS) {
        this.warnRebuildLoop();
        return;
      }
      this.rapidRebuilds++;
    } else {
      this.rapidRebuilds = 0;
    }

    this.lost = true;
    this.generation++;
    this.lastLostAt = now;
    this.armGrace();
    this.emit();
  }

  /**
   * Report a working context. Called when a renderer mounts successfully,
   * which after a loss means the replacement is up.
   */
  reportHealthy(): void {
    this.clearGrace();
    if (!this.lost) return;
    this.lost = false;
    this.emit();
  }

  /**
   * If nothing reports healthy within the grace period, assume the rebuild
   * worked and say so once.
   *
   * A scene gate reads `lost` to hold its scene in `recovering`, at reduced
   * quality, so one forgotten `reportHealthy()` would keep every gated scene
   * reduced for the rest of the visit. The warning names the call to add.
   */
  private armGrace(): void {
    this.clearGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      if (!this.lost) return;
      if (!this.warnedGrace) {
        this.warnedGrace = true;
        console.warn(
          `vv-motion: a lost graphics context was not reported healthy within ${RECOVERY_GRACE_MS / 1000}s, ` +
            "so the runtime assumed the rebuilt scene is up. Call getRendererHealth().reportHealthy() " +
            "once the replacement renderer has drawn; useRenderQuality does this for you.",
        );
      }
      this.lost = false;
      this.emit();
    }, RECOVERY_GRACE_MS);
  }

  private clearGrace(): void {
    if (this.graceTimer === null) return;
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  /**
   * Said once per page. After the limit, a fresh canvas lost inside the window
   * is ignored like any other report there, until a loss outside the window
   * starts a new run.
   */
  private warnRebuildLoop(): void {
    if (this.warnedRebuildLoop) return;
    this.warnedRebuildLoop = true;
    console.warn(
      `vv-motion: a rebuilt scene lost its graphics context again within ${LOSS_COALESCE_MS}ms, ` +
        `${MAX_RAPID_REBUILDS} times in a row, so the runtime stopped rebuilding until the next separate loss. ` +
        "The usual cause is a page with more live canvases than the browser keeps contexts for, so every " +
        "rebuild makes it drop one of the new ones. Keep fewer canvases mounted at once.",
    );
  }

  private emit(): void {
    const s = this.state;
    for (const fn of [...this.listeners]) fn(s);
  }
}

let instance: RendererHealth | null = null;

/** Lazy singleton. Client-only construction, SSR-import-safe. */
export function getRendererHealth(): RendererHealth {
  if (instance === null) instance = new RendererHealth();
  return instance;
}

export type { RendererHealth };
