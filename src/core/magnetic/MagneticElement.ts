import { getConductor } from "../conductor";
import { getSensorBus } from "../sensor-bus/SensorBus";
import { PointerIntent } from "../pointer-intent/PointerIntent";
import { damp } from "../math";

/**
 * MagneticElement: attraction with anticipation.
 *
 * Engagement is max(PointerIntent confidence, proximity falloff), so the
 * element starts reaching while the cursor is still on its way.
 *
 * The element's rect moves as it translates, so the true anchor is rect centre
 * minus the current offset. Without this the element chases its own tail.
 *
 * Writes only `transform`, and restores the previous inline transform on
 * destroy.
 *
 * Measuring happens in the input lane, so every magnetic element on the page
 * has finished reading before any of them writes. Reading in the render lane
 * would force a synchronous layout per element. The anchor is cached and only
 * re-measured when scroll or resize could have moved it, or the heartbeat
 * elapses, so the steady state costs no layout reads.
 */

export interface MagneticOptions {
  /** Max translation in px at full engagement. Default 12. */
  strength?: number;
  /** Distance (px from center) where proximity pull begins. Default 90. */
  reach?: number;
  /** How quickly the element follows the pointer. Higher is snappier. Default 12. */
  speed?: number;
  /** Scale at full engagement (1 = off). Default 1.04. */
  scale?: number;
  /** Start reaching while the pointer is still approaching. Default true. */
  anticipate?: boolean;
}

const DEFAULTS: Required<MagneticOptions> = {
  strength: 12,
  reach: 90,
  speed: 12,
  scale: 1.04,
  anticipate: true,
};

// Re-measure at least this often even when scroll and viewport look
// unchanged, so sticky headers and async layout shifts can't strand the
// anchor. Mirrors PointerIntent's heartbeat.
const ANCHOR_HEARTBEAT_S = 1.0;

export class MagneticElement {
  readonly el: HTMLElement;

  private opts: Required<MagneticOptions>;
  private intentInst: PointerIntent | null = null;
  private ox = 0;
  private oy = 0;
  private engagement = 0;
  private prevTransform: string;
  private offMeasure: () => void;
  private offRender: () => void;
  private releaseBus: () => void;

  /** Resting centre of the element, with our own translation removed. */
  private anchorX = 0;
  private anchorY = 0;
  /** Half the element's measured size, to tell when it is off screen. */
  private halfW = 0;
  private halfH = 0;
  private haveAnchor = false;
  private lastScrollX = 0;
  private lastScrollY = 0;
  private lastWidth = 0;
  private lastHeight = 0;
  private lastMeasureTime = 0;

  constructor(el: HTMLElement, options: MagneticOptions = {}) {
    this.el = el;
    this.opts = { ...DEFAULTS, ...options };
    this.prevTransform = el.style.transform;
    this.syncAnticipation();
    this.releaseBus = getSensorBus().retain();
    // Input lane: every layout read on the page happens here, before anything
    // writes. Essential, because a stale anchor pulls the element toward the
    // wrong place, which is worse than not pulling at all.
    this.offMeasure = getConductor().subscribe("input", this.measure, {
      priority: "essential",
      label: "MagneticElement(measure)",
    });
    // Render lane: after intent's update-lane confidence pass. Pure maths and a
    // single transform write, with no layout reads.
    this.offRender = getConductor().subscribe("render", this.frame, {
      priority: "enhanced",
      label: "MagneticElement",
    });
  }

  /**
   * Retune in place. Keys set to `undefined` are ignored, because the React
   * adapter passes every key on every change, so an option the caller never
   * supplied arrives as `undefined`. Applied, it would wipe a default and put
   * NaN in the transform.
   */
  update(options: MagneticOptions): void {
    for (const key of Object.keys(options) as (keyof MagneticOptions)[]) {
      const value = options[key];
      if (value !== undefined) {
        (this.opts as Record<string, unknown>)[key] = value;
      }
    }
    this.syncAnticipation();
  }

  /**
   * Build or tear down the approach detector to match `anticipate`. Called from
   * `update` as well as the constructor, so turning anticipation on or off
   * works after mount.
   *
   * Sensitivity is derived from `reach`: a wider magnetic field should start
   * reaching from further out.
   */
  private syncAnticipation(): void {
    if (!this.opts.anticipate) {
      this.intentInst?.destroy();
      this.intentInst = null;
      return;
    }
    const sensitivity = this.opts.reach >= 120 ? "high" : "normal";
    if (this.intentInst) {
      this.intentInst.update({ sensitivity });
      return;
    }
    this.intentInst = new PointerIntent(this.el, { sensitivity, dynamic: true });
  }

  destroy(): void {
    this.offMeasure();
    this.offRender();
    this.releaseBus();
    this.intentInst?.destroy();
    this.el.style.transform = this.prevTransform;
  }

  private measure = (_dt: number, time: number): void => {
    const { scroll, viewport } = getSensorBus().state;
    const moved =
      scroll.x !== this.lastScrollX ||
      scroll.y !== this.lastScrollY ||
      viewport.width !== this.lastWidth ||
      viewport.height !== this.lastHeight;
    const stale = time - this.lastMeasureTime > ANCHOR_HEARTBEAT_S;
    if (this.haveAnchor && !moved && !stale) return;

    const rect = this.el.getBoundingClientRect();
    // True anchor: subtract our own offset or the target chases itself.
    // Scale is centre-origin, so it doesn't shift the centre.
    this.anchorX = rect.left + rect.width / 2 - this.ox;
    this.anchorY = rect.top + rect.height / 2 - this.oy;
    this.halfW = rect.width / 2;
    this.halfH = rect.height / 2;
    this.lastScrollX = scroll.x;
    this.lastScrollY = scroll.y;
    this.lastWidth = viewport.width;
    this.lastHeight = viewport.height;
    this.lastMeasureTime = time;
    this.haveAnchor = true;
  };

  private frame = (dt: number): void => {
    if (!this.haveAnchor) return; // nothing measured yet, wait for the input lane
    const { pointer, viewport } = getSensorBus().state;
    const cx = this.anchorX;
    const cy = this.anchorY;

    // An element entirely off screen isn't pulled. It eases back to rest, and
    // once at rest the transform it writes stops changing, so the page sees no
    // more writes. A viewport not yet measured (0) counts as unbounded.
    const onScreen =
      cx + this.halfW > 0 &&
      cx - this.halfW < (viewport.width || Infinity) &&
      cy + this.halfH > 0 &&
      cy - this.halfH < (viewport.height || Infinity);

    let targetX = 0;
    let targetY = 0;
    let targetEngagement = 0;

    if (pointer.seen && onScreen) {
      const dx = pointer.x - cx;
      const dy = pointer.y - cy;
      const dist = Math.hypot(dx, dy);

      const proximity = 1 - Math.min(dist / this.opts.reach, 1);
      const confidence = this.intentInst?.confidence ?? 0;
      targetEngagement = Math.max(proximity, confidence);

      if (targetEngagement > 0.01 && dist > 0.001) {
        const pull = targetEngagement;
        targetX = dx * pull;
        targetY = dy * pull;
        const len = Math.hypot(targetX, targetY);
        if (len > this.opts.strength) {
          targetX = (targetX / len) * this.opts.strength;
          targetY = (targetY / len) * this.opts.strength;
        }
      }
    }

    this.ox = damp(this.ox, targetX, this.opts.speed, dt);
    this.oy = damp(this.oy, targetY, this.opts.speed, dt);
    this.engagement = damp(this.engagement, targetEngagement, this.opts.speed, dt);

    const s = 1 + (this.opts.scale - 1) * this.engagement;
    this.el.style.transform =
      `translate3d(${this.ox.toFixed(2)}px, ${this.oy.toFixed(2)}px, 0) scale(${s.toFixed(4)})`;
  };
}
