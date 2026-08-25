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

/**
 * How eager the prediction is.
 *
 * This replaced five separate numbers — look-ahead horizon, rect inflation, a
 * minimum pointer speed, and a pair of confidence thresholds for gaining and
 * losing intent. The last two are hysteresis: correct to have, impossible to
 * pick by hand, and meaningless in isolation.
 */
export type PointerIntentSensitivity = "low" | "normal" | "high";

export interface PointerIntentOptions {
  /**
   * How readily the pointer is judged to be heading here. Default `"normal"`.
   *
   * - `"low"` — only a clear, committed approach counts
   * - `"normal"` — a good default for a link or a card
   * - `"high"` — fires early and more often, for something cheap to prepare
   */
  sensitivity?: PointerIntentSensitivity;
  /**
   * Re-measure the element every frame instead of caching its position. Needed
   * only when the element itself moves — a carousel, something being animated.
   * Default false.
   */
  dynamic?: boolean;
}

/**
 * What one sensitivity setting actually resolves to.
 *
 * These five numbers were the public options before 2.0. They are tuning, not
 * a control surface — "how far ahead do I look, in seconds" is not a question
 * a developer can answer without reading the implementation, which is why they
 * collapsed into three named presets.
 *
 * They are still readable, because something has to be able to show them: a
 * devtools panel explaining why a preset fired, or a demo drawing the
 * prediction geometry. The alternative is every such tool keeping its own copy
 * of the table and drifting from the one the runtime uses.
 */
export interface PointerIntentTuning {
  /** How far ahead the pointer's path is projected, in seconds. */
  readonly horizon: number;
  /** How far outside the element still counts as a hit, in px. */
  readonly extend: number;
  /** Below this speed the pointer is drifting, not heading somewhere, in px/s. */
  readonly minSpeed: number;
  /** Confidence needed to gain intent. */
  readonly enter: number;
  /** Confidence it must fall below to lose it. Lower than `enter` — hysteresis. */
  readonly exit: number;
}

/**
 * The tuning each sensitivity resolves to. Frozen: this is the runtime's own
 * table, not a template to copy and edit.
 */
export const POINTER_INTENT_SENSITIVITY: Readonly<
  Record<PointerIntentSensitivity, PointerIntentTuning>
> = Object.freeze({
  low: Object.freeze({ horizon: 0.3, extend: 8, minSpeed: 120, enter: 0.5, exit: 0.3 }),
  normal: Object.freeze({ horizon: 0.5, extend: 12, minSpeed: 80, enter: 0.35, exit: 0.18 }),
  high: Object.freeze({ horizon: 0.8, extend: 20, minSpeed: 50, enter: 0.25, exit: 0.12 }),
});

const DEFAULTS: Required<PointerIntentOptions> = {
  sensitivity: "normal",
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
  private tuning: PointerIntentTuning;
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
    this.tuning = POINTER_INTENT_SENSITIVITY[this.opts.sensitivity];
    this.onChange = onChange;
    this.releaseBus = getSensorBus().retain();
    // Update lane: runs after the bus's input-lane derivative pass.
    // Decorative: this produces a confidence signal for prefetching, never
    // visible motion. Shedding it under load costs a slightly later prefetch,
    // which is the correct thing to give up when the frame is already full.
    this.unsubscribe = getConductor().subscribe("update", this.frame, {
      priority: "decorative",
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
    // would clobber the unspecified ones back to undefined.
    for (const key of Object.keys(options) as (keyof PointerIntentOptions)[]) {
      const value = options[key];
      if (value !== undefined) {
        (this.opts as Record<string, unknown>)[key] = value;
      }
    }
    this.tuning = POINTER_INTENT_SENSITIVITY[this.opts.sensitivity];
  }

  destroy(): void {
    this.unsubscribe();
    this.releaseBus();
  }

  private measureRect(time: number): void {
    const r = this.el.getBoundingClientRect();
    const e = this.tuning.extend;
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
      } else if (pointer.speed > this.tuning.minSpeed) {
        const tHit = rayRectIntersect(pointer.x, pointer.y, pointer.vx, pointer.vy, rect);
        if (tHit !== null && tHit <= this.tuning.horizon) {
          target = Math.max(0.2, 1 - tHit / this.tuning.horizon);
        }
      }
    }

    this.confidenceValue = damp(this.confidenceValue, target, CONFIDENCE_DAMP, dt);

    const next = this.intentValue
      ? this.confidenceValue > this.tuning.exit
      : this.confidenceValue > this.tuning.enter;
    if (next !== this.intentValue) {
      this.intentValue = next;
      this.onChange?.(next);
    }
  };
}
