import { getConductor } from "../conductor";
import { damp } from "../math";

/**
 * SensorBus — ONE set of input listeners for the whole page.
 *
 * Ten effects that each attach pointermove/scroll/resize listeners and each
 * compute their own velocities do ten times the work for one answer. The
 * bus attaches passive listeners once, computes smoothed derivatives once
 * per frame (conductor input lane — before any consumer runs), and exposes
 * a live snapshot consumers READ during their own frame work.
 *
 * Consumption contract (deliberate, GSAP-style pragmatism): `.state`
 * returns live internal objects — read fields each frame, never retain or
 * mutate them. There are no per-event callbacks; the conductor IS the
 * delivery mechanism.
 *
 * Lifecycle is ref-counted: `retain()` starts the sensors, the returned
 * release stops them when the last consumer lets go.
 */

export interface PointerSensor {
  /** The current pointer X coordinate in client space (CSS pixels). */
  x: number;
  /** The current pointer Y coordinate in client space (CSS pixels). */
  y: number;
  /** The damped horizontal velocity of the pointer in pixels per second. */
  vx: number;
  /** The damped vertical velocity of the pointer in pixels per second. */
  vy: number;
  /** The current speed of the pointer in pixels per second (magnitude of velocity vector). */
  speed: number;
  /** True if the primary pointer button (e.g., mouse left click or screen touch) is currently held down. */
  down: boolean;
  /** Set to true after the first pointer movement is detected. Useful to prevent initial jump calculations. */
  seen: boolean;
}

export interface ScrollSensor {
  /** The current horizontal scroll position (window.scrollX). */
  x: number;
  /** The current vertical scroll position (window.scrollY). */
  y: number;
  /** The damped horizontal scroll velocity in pixels per second. */
  vx: number;
  /** The damped vertical scroll velocity in pixels per second. */
  vy: number;
}

export interface ViewportSensor {
  /** The width of the viewport layout boundary (window.innerWidth). */
  width: number;
  /** The height of the viewport layout boundary (window.innerHeight). */
  height: number;
  /** The device pixel ratio (DPR) of the current display. */
  dpr: number;
}

export interface SensorState {
  /** Pointer movement and interaction metrics. */
  pointer: PointerSensor;
  /** Window scroll position and scroll velocity metrics. */
  scroll: ScrollSensor;
  /** Window layout bounds and device pixel ratio. */
  viewport: ViewportSensor;
}

const VELOCITY_DAMP = 14; // responsiveness of the velocity smoothing

/**
 * SensorBus manages a single, centralized set of passive listeners for the entire page.
 * It coordinates mouse/touch inputs, page scrolls, and resize events, computing smoothed
 * velocities and device ratios exactly once per frame on the animation budget loop.
 *
 * Rather than creating multiple individual listeners that trigger layout thrashing, components
 * and hooks read from this singleton bus state inside their frame ticks.
 */
export class SensorBus {
  private pointer: PointerSensor = {
    x: 0, y: 0, vx: 0, vy: 0, speed: 0, down: false, seen: false,
  };
  private scroll: ScrollSensor = { x: 0, y: 0, vx: 0, vy: 0 };
  private viewport: ViewportSensor = { width: 0, height: 0, dpr: 1 };

  private prevPointerX = 0;
  private prevPointerY = 0;
  private prevScrollX = 0;
  private prevScrollY = 0;

  private refs = 0;
  private unsubscribe: (() => void) | null = null;
  private teardown: (() => void) | null = null;

  /**
   * Retrieves the current snapshot of all active sensor states.
   *
   * @readonly
   * @type {SensorState}
   */
  get state(): SensorState {
    return { pointer: this.pointer, scroll: this.scroll, viewport: this.viewport };
  }

  /**
   * Retains the sensor bus by incrementing its reference count.
   * If this is the first reference, it attaches all event listeners and schedules
   * the update loop.
   *
   * @returns {() => void} A release function that decrements the reference count and cleans up listeners if reference count reaches zero.
   */
  retain(): () => void {
    this.refs++;
    if (this.refs === 1) this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.refs--;
      if (this.refs === 0) this.stop();
    };
  }

  private start(): void {
    /**
     * Nothing to listen to on a server.
     *
     * `retain()` still succeeds and still returns a working release, so a Vue
     * `setup()` or a SvelteKit load can hold the bus without a branch; the
     * sensors simply report their zeroed defaults until the client hydrates and
     * retains for real.
     *
     * Without this, `retain()` threw "window is not defined" during SSR. React
     * consumers never hit it because `useSensorBus` retains from an effect, but
     * this entry carries no "use client" and is advertised as
     * framework-agnostic.
     */
    if (typeof window === "undefined") return;

    const onPointerMove = (e: PointerEvent) => {
      if (!this.pointer.seen) {
        // First contact: snap history so the first frame reads zero velocity.
        this.prevPointerX = e.clientX;
        this.prevPointerY = e.clientY;
        this.pointer.seen = true;
      }
      this.pointer.x = e.clientX;
      this.pointer.y = e.clientY;
    };
    const onPointerDown = () => { this.pointer.down = true; };
    const onPointerUp = () => { this.pointer.down = false; };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("pointercancel", onPointerUp, { passive: true });

    this.scroll.x = window.scrollX;
    this.scroll.y = window.scrollY;
    this.prevScrollX = this.scroll.x;
    this.prevScrollY = this.scroll.y;
    this.syncViewport();

    this.teardown = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
    // Essential: every other effect reads the snapshot this pass produces.
    // Shedding the sensors would feed the whole page stale input.
    this.unsubscribe = getConductor().subscribe("input", this.frame, {
      priority: "essential",
      label: "SensorBus",
    });
  }

  private stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.teardown?.();
    this.teardown = null;

    // Everything derived from movement is cleared, not just the pointer.
    // A stopped bus still reporting velocity is a stale reading, and anything
    // holding `.state` reads it as live.
    this.pointer.vx = 0;
    this.pointer.vy = 0;
    this.pointer.speed = 0;
    this.scroll.vx = 0;
    this.scroll.vy = 0;

    // Forget that the pointer was ever seen. While stopped there are no
    // listeners, so the bus does not watch the pointer travel — and on restart
    // the distance it covered in between would otherwise read as one enormous
    // move. Clearing this makes the next pointermove snap history again.
    this.pointer.seen = false;
  }

  private syncViewport(): void {
    this.viewport.width = window.innerWidth;
    this.viewport.height = window.innerHeight;
    this.viewport.dpr = window.devicePixelRatio || 1;
  }

  private frame = (dt: number): void => {
    // Scroll is read per frame (no scroll listener): position is cheap and
    // this catches programmatic scrolls that never fire events.
    const sx = window.scrollX;
    const sy = window.scrollY;
    const instSvx = (sx - this.prevScrollX) / dt;
    const instSvy = (sy - this.prevScrollY) / dt;
    this.scroll.x = sx;
    this.scroll.y = sy;
    this.scroll.vx = damp(this.scroll.vx, instSvx, VELOCITY_DAMP, dt);
    this.scroll.vy = damp(this.scroll.vy, instSvy, VELOCITY_DAMP, dt);
    this.prevScrollX = sx;
    this.prevScrollY = sy;

    const instPvx = (this.pointer.x - this.prevPointerX) / dt;
    const instPvy = (this.pointer.y - this.prevPointerY) / dt;
    this.pointer.vx = damp(this.pointer.vx, instPvx, VELOCITY_DAMP, dt);
    this.pointer.vy = damp(this.pointer.vy, instPvy, VELOCITY_DAMP, dt);
    this.pointer.speed = Math.hypot(this.pointer.vx, this.pointer.vy);
    this.prevPointerX = this.pointer.x;
    this.prevPointerY = this.pointer.y;

    this.syncViewport();
  };
}

let instance: SensorBus | null = null;

/**
 * Lazy singleton retriever for the unified SensorBus instance.
 * Safe for use in Server-Side Rendering (SSR) environments.
 *
 * @returns {SensorBus} The singleton SensorBus instance.
 */
export function getSensorBus(): SensorBus {
  if (instance === null) instance = new SensorBus();
  return instance;
}
