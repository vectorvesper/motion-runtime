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

/**
 * How long after a loss another loss is treated as the same reset.
 *
 * A driver reset reaches every canvas on the page within a frame or two, so
 * this only has to be longer than that. Kept short so a genuinely separate
 * failure moments later still registers as one.
 */
const LOSS_COALESCE_MS = 250;

type HealthListener = (state: RendererHealthState) => void;

class RendererHealth {
  private lost = false;
  private generation = 0;
  private lastLostAt: number | null = null;
  private listeners = new Set<HealthListener>();

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
   * Repeated calls while already lost do not stack. A driver reset fires the
   * event on every canvas on the page, and one reset should mean one rebuild,
   * not one rebuild per canvas.
   */
  reportLost(): void {
    if (this.lost) return;

    /**
     * The `lost` flag above is not enough on a page with several canvases.
     *
     * It only holds until a replacement mounts and calls `reportHealthy()`,
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
     * A loss arriving this soon after the last one is the same reset reaching
     * another canvas. The canvas reporting it has already been replaced by the
     * rebuild the first report triggered, so its event is about a element that
     * is no longer in the document. Ignored outright rather than merely not
     * counted: flipping `lost` back to true would report LOST for a page whose
     * replacements are already up.
     *
     * The window is deliberately short. A genuinely new failure a second later
     * is a new failure and still counts.
     */
    const now = Date.now();
    if (this.lastLostAt !== null && now - this.lastLostAt < LOSS_COALESCE_MS) return;

    this.lost = true;
    this.generation++;
    this.lastLostAt = now;
    this.emit();
  }

  /**
   * Report a working context. Called when a renderer mounts successfully,
   * which after a loss means the replacement is up.
   */
  reportHealthy(): void {
    if (!this.lost) return;
    this.lost = false;
    this.emit();
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
