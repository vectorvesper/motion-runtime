import { getConductor } from "../conductor";
import { getSensorBus } from "../sensor-bus/SensorBus";
import { damp, rayRectIntersect } from "../math";

/**
 * PointerIntent — predicts that the pointer is COMING to an element before
 * it arrives, from the SensorBus's smoothed velocity: cast the pointer's
 * trajectory forward and measure time-to-impact against the (inflated)
 * element rect. Confidence rises as impact nears; being inside is
 * confidence 1. Hysteresis (enter/exit thresholds) keeps the boolean calm.
 *
 * Use it to pre-warm expensive hovers: start the video, compile the shader,
 * begin the magnetic pull — 100–300ms before the cursor lands.
 */

export interface PointerIntentOptions {
  /** Look-ahead horizon in seconds. Default 0.5. */
  horizon?: number;
  /** Rect inflation in px — how generous the target is. Default 12. */
  extend?: number;
  /** Below this pointer speed (px/s) prediction is off; hover still counts. Default 80. */
  minSpeed?: number;
  /** Confidence needed to gain intent. Default 0.35. */
  enter?: number;
  /** Confidence below which intent is lost. Default 0.18. */
  exit?: number;
  /** If true, bypasses rect caching and re-measures the element frame-accurately whenever approached. Use for translating/animating elements. Default false. */
  dynamic?: boolean;
}

const DEFAULTS: Required<PointerIntentOptions> = {
  horizon: 0.5,
  extend: 12,
  minSpeed: 80,
  enter: 0.35,
  exit: 0.18,
  dynamic: false,
};

// How fast confidence chases its target each frame (higher = snappier).
const CONFIDENCE_DAMP = 10;

// Re-measure the element at least this often even when scroll and viewport look
// unchanged. Bounds how stale the cached rect can get when the element moves for
// reasons the cache can't infer on its own: sticky headers, carousels, async
// layout shifts. See measureRect / the invalidation check in frame().
const RECT_HEARTBEAT_S = 1.0;

export class PointerIntent {
  readonly el: HTMLElement;

  private opts: Required<PointerIntentOptions>;
  private onChange?: (intent: boolean) => void;
  private confidenceValue = 0;
  private intentValue = false;
  private unsubscribe: () => void;
  private releaseBus: () => void;

  private cachedRect: { left: number; top: number; right: number; bottom: number } | null = null;
  private lastScrollX = 0;
  private lastScrollY = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private lastRectMeasureTime = 0;

  constructor(
    el: HTMLElement,
    options: PointerIntentOptions = {},
    onChange?: (intent: boolean) => void,
  ) {
    this.el = el;
    this.opts = { ...DEFAULTS, ...options };
    this.onChange = onChange;
    this.releaseBus = getSensorBus().retain();
    // Update lane: runs after the bus's input-lane derivative pass.
    this.unsubscribe = getConductor().subscribe("update", this.frame, {
      priority: "enhanced",
      label: "PointerIntent",
    });
  }

  /** Smoothed 0..1 — how sure we are the pointer is coming (or here). */
  get confidence(): number {
    return this.confidenceValue;
  }

  /** Hysteresis-gated boolean. */
  get intent(): boolean {
    return this.intentValue;
  }

  update(options: PointerIntentOptions): void {
    // Merge only the fields that are actually set. The React adapter spreads
    // possibly-undefined props whenever any option changes; a naive spread
    // would clobber the unspecified ones back to undefined and quietly break
    // horizon and the enter/exit hysteresis.
    for (const key of Object.keys(options) as (keyof PointerIntentOptions)[]) {
      const value = options[key];
      if (value !== undefined) {
        (this.opts as any)[key] = value;
      }
    }
  }

  destroy(): void {
    this.unsubscribe();
    this.releaseBus();
  }

  private measureRect(time: number): void {
    const r = this.el.getBoundingClientRect();
    const e = this.opts.extend;
    this.cachedRect = {
      left: r.left - e,
      top: r.top - e,
      right: r.right + e,
      bottom: r.bottom + e,
    };
    const { scroll, viewport } = getSensorBus().state;
    this.lastScrollX = scroll.x;
    this.lastScrollY = scroll.y;
    this.lastWidth = viewport.width;
    this.lastHeight = viewport.height;
    this.lastRectMeasureTime = time;
  }

  private frame = (dt: number, time: number): void => {
    const { pointer, scroll, viewport } = getSensorBus().state;
    let target = 0;

    if (pointer.seen) {
      // The rect is cached; we only pay for a layout read when something
      // plausibly moved the element (page scroll, viewport resize) or the
      // heartbeat elapses. This keeps the per-frame hot path allocation- and
      // layout-free.
      const scrollChanged = scroll.x !== this.lastScrollX || scroll.y !== this.lastScrollY;
      const viewportChanged = viewport.width !== this.lastWidth || viewport.height !== this.lastHeight;
      const heartbeatDue = time - this.lastRectMeasureTime > RECT_HEARTBEAT_S;
      // Dynamic mode: once the element is being approached, re-measure every
      // frame so a translating or animating target stays tracked exactly.
      const activeTracking = this.opts.dynamic && this.confidenceValue > 0.01;

      if (!this.cachedRect || scrollChanged || viewportChanged || heartbeatDue || activeTracking) {
        this.measureRect(time);
      }

      const rect = this.cachedRect!;

      const inside =
        pointer.x >= rect.left && pointer.x <= rect.right &&
        pointer.y >= rect.top && pointer.y <= rect.bottom;

      if (inside) {
        target = 1;
      } else if (pointer.speed > this.opts.minSpeed) {
        const tHit = rayRectIntersect(pointer.x, pointer.y, pointer.vx, pointer.vy, rect);
        if (tHit !== null && tHit <= this.opts.horizon) {
          target = Math.max(0.2, 1 - tHit / this.opts.horizon);
        }
      }
    }

    this.confidenceValue = damp(this.confidenceValue, target, CONFIDENCE_DAMP, dt);

    const next = this.intentValue
      ? this.confidenceValue > this.opts.exit
      : this.confidenceValue > this.opts.enter;
    if (next !== this.intentValue) {
      this.intentValue = next;
      this.onChange?.(next);
    }
  };
}
