/**
 * RendererHealth — has the graphics context died, and how many times.
 *
 * A browser can take a WebGL context away at any moment: a GPU driver reset, a
 * tab backgrounded on a phone, too many live contexts on one page, the OS
 * reclaiming memory. When it happens the canvas fires `webglcontextlost`, three
 * passes the event along, and **React Three Fiber does nothing with it** —
 * verified against 9.6.1, there is no handler anywhere in the bundle. The
 * result is a permanently black canvas with no error in the console.
 *
 * ## Why this is a page-level singleton and not per-canvas
 *
 * A driver reset takes every context on the page at once, so a page-level
 * signal is the truthful one for the common case. It also has to be readable
 * from *outside* the canvas — R3F runs its own reconciler, so React context
 * does not cross the `<Canvas>` boundary, and the component that decides what
 * to render instead is on the other side of it.
 *
 * The cost is that a single lost context bumps the generation for every scene
 * on the page. Given a lost context is rare and a remount is cheap next to a
 * black canvas, that trade is deliberate.
 *
 * ## What recovery actually is
 *
 * Not `webglcontextrestored`. That event only helps if every buffer, texture,
 * program and render target is rebuilt by hand in the right order, which
 * almost nothing does correctly, and R3F does not do at all.
 *
 * The recovery here is a **generation counter**. It increments on loss, a
 * scene puts it on its `<Canvas key>`, React unmounts the dead tree and mounts
 * a fresh one, and R3F builds a new context with every resource re-created
 * from the React tree it already has. The rebuild is something React is
 * already good at; the only missing piece was knowing when to ask for it.
 *
 * `preventDefault()` on the lost event still matters and the adapter calls it —
 * without it the browser will not even attempt a restore, and some drivers
 * refuse a new context on the same page afterwards.
 */

export interface RendererHealthState {
  /** True between a context being lost and a replacement being mounted. */
  lost: boolean;
  /**
   * Increments once per loss. Put it on a `<Canvas key>` — changing it is what
   * makes React throw away the dead tree and build a working one.
   */
  generation: number;
  /** When the most recent loss happened, or `null` if there has not been one. */
  lastLostAt: number | null;
}

/** What a reporter can say about the canvas it lost. */
export interface ReportLostOptions {
  /**
   * The `generation` that was current when the lost canvas's renderer was
   * created. Read `getRendererHealth().state.generation` at that moment and
   * keep it with the renderer.
   *
   * It is how the runtime tells a replacement from the canvas it replaced. A
   * loss from a canvas built under the current generation always counts, even
   * inside the window that folds one reset reaching several canvases into one
   * rebuild, because that canvas did not exist yet when the reset happened.
   *
   * `useRenderQuality` and `watchGPUDevice` pass it for you.
   */
  builtAt?: number;
}

/**
 * How long after a loss another loss is treated as the same reset.
 *
 * A driver reset reaches every canvas on the page within a frame or two, so
 * this only has to be longer than that. Kept short so a genuinely separate
 * failure moments later still registers as one.
 */
const LOSS_COALESCE_MS = 250;

/**
 * How many rebuilds in a row freshly built canvases may trigger, each inside
 * the coalescing window of the one before.
 *
 * One is the case `builtAt` exists for: a replacement lost moments after it
 * was built. A long run means every rebuild is killing its own canvases, which
 * is what a page keeping more live contexts than the browser allows does: each
 * rebuild creates a full set, the browser evicts the oldest, and the eviction
 * reads as a fresh loss. Without a limit that loops for as long as the page is
 * open.
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
   * Calls inside the coalescing window do not stack. A driver reset fires the
   * event on every canvas on the page, and one reset should mean one rebuild,
   * not one rebuild per canvas.
   *
   * Pass `builtAt` and a canvas the last rebuild built is exempt: its loss is
   * new wherever it falls in the window. Up to 4.1.0 the window swallowed it,
   * so a replacement lost within 250ms of the loss that built it stayed black
   * with nothing left to rebuild it. Two quick clicks on vv-site's "Drop
   * Context" did exactly that (vv-lab R10). A report without `builtAt` is
   * judged by the window alone, as before.
   *
   * A later loss always counts, whether or not anything reported healthy in
   * between. Up to 4.1.0 this returned early while `lost` was still set, so a
   * scene whose code never called `reportHealthy()` survived exactly one loss:
   * the second was swallowed and the canvas stayed black for good. vv-site's
   * own landing demo died that way on its second "Drop Context". A forgotten
   * call should cost a stale badge, not a dead scene, and the grace timer
   * below clears the badge as well.
   */
  reportLost(options?: ReportLostOptions): void {
    /**
     * Why a time window and not a flag.
     *
     * A `lost` flag only holds until a replacement mounts and calls `reportHealthy()`,
     * and with N canvases that happens *between* the queued
     * `webglcontextlost` events, because those are async and the remount is
     * synchronous. So the sequence is lost, healthy, lost, healthy — and every
     * one of those losses looks like a fresh failure.
     *
     * Measured: sixteen canvases, one driver reset, **generation 16**. Each
     * bump remounts every scene on the page, so a single reset produced
     * sixteen full rebuilds and up to 256 context creations against a browser
     * that keeps about sixteen. Cards lose that race and stay black, which is
     * the failure this class exists to prevent.
     *
     * A loss arriving this soon after the last one is normally the same reset
     * reaching another canvas. The canvas reporting it has already been
     * replaced by the rebuild the first report triggered, so its event is about
     * an element that is no longer in the document. Ignored outright rather
     * than merely not counted: flipping `lost` back to true would report LOST
     * for a page whose replacements are already up.
     *
     * The exception is a report whose `builtAt` is the current generation.
     * Only the rebuild can have built that canvas, after the reset, so the
     * reset is not what killed it.
     *
     * The window is deliberately short. A genuinely new failure a second later
     * is a new failure and still counts.
     */
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
   * worked, and say so once.
   *
   * `lost` is what a scene gate reads to hold its scene in `recovering`, and a
   * scene held there draws at reduced quality. Without this, one forgotten
   * `reportHealthy()` kept every gated scene on the page reduced for the rest
   * of the visit. The warning names the call to add. A replacement that really
   * is still building reports healthy later, which by then changes nothing.
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
