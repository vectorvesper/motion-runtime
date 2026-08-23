import { getConductor } from "../conductor";
import { getSensorBus } from "../sensor-bus/SensorBus";
import { PointerIntent } from "../pointer-intent/PointerIntent";
import { damp } from "../math";

/**
 * MagneticElement — attraction with anticipation.
 *
 * The thousand free magnetic-button tutorials react to hover. This one
 * rides the engine: engagement = max(PointerIntent confidence, proximity
 * falloff), so the element starts reaching WHILE THE CURSOR IS STILL ON
 * ITS WAY — the pre-touch that makes award-site buttons feel alive.
 *
 * Anchor correctness: the element's rect moves as it translates, so the
 * true anchor is rect-center MINUS the current offset. Without this the
 * target drifts and the element chases its own tail.
 *
 * Writes only `transform` (compositor-safe); records and restores the
 * previous inline transform on destroy.
 *
 * ## Read/write split (v0.3)
 *
 * v0.1 called `getBoundingClientRect()` inside the render lane, immediately
 * before writing `transform`. With two magnetic elements on a page that
 * becomes read → write → read, and the second read is a forced synchronous
 * layout because the first write dirtied the tree — layout thrash scaling
 * with the number of magnetic elements, in the engine whose whole premise is
 * reads-before-writes.
 *
 * The measurement now lives in the input lane, so every magnetic element on
 * the page has finished reading before any of them writes. The anchor is also
 * cached and only re-measured when something could plausibly have moved it
 * (scroll, resize) or the heartbeat elapses, so the steady state costs no
 * layout reads at all.
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
    // writes. Essential — a stale anchor makes the element pull toward the
    // wrong place, which is worse than not pulling at all.
    this.offMeasure = getConductor().subscribe("input", this.measure, {
      priority: "essential",
      label: "MagneticElement(measure)",
    });
    // Render lane: after intent's update-lane confidence pass. Pure math and
    // a single transform write — no layout reads.
    this.offRender = getConductor().subscribe("render", this.frame, {
      priority: "enhanced",
      label: "MagneticElement",
    });
  }

  /**
   * Retune in place. Keys explicitly set to `undefined` are IGNORED rather than
   * applied, because the React adapter destructures the caller's options object
   * and passes every key on every change — so an option the caller simply never
   * supplied arrives here as `undefined`.
   *
   * A naive `{ ...this.opts, ...options }` let that wipe a default. With `damp`
   * gone, `damp(current, target, undefined, dt)` evaluates `Math.exp(-undefined)`
   * → NaN, the element's transform became `translate3d(NaNpx, NaNpx, 0)`, the
   * browser discarded it as invalid, and the magnet silently never moved. The
   * documented zero-argument call `useMagneticIntent()` hit this.
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
   * Build or tear down the approach detector to match `anticipate`.
   *
   * Called from `update` as well as the constructor: this used to be read only
   * at construction, so turning anticipation on or off after mount silently
   * did nothing.
   *
   * Sensitivity is derived from `reach` rather than passed through. A wider
   * magnetic field should start reaching from further out, and the detector no
   * longer takes a raw pixel inflation — it takes a band.
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
    this.lastScrollX = scroll.x;
    this.lastScrollY = scroll.y;
    this.lastWidth = viewport.width;
    this.lastHeight = viewport.height;
    this.lastMeasureTime = time;
    this.haveAnchor = true;
  };

  private frame = (dt: number): void => {
    if (!this.haveAnchor) return; // nothing measured yet — wait for the input lane
    const { pointer } = getSensorBus().state;
    const cx = this.anchorX;
    const cy = this.anchorY;

    let targetX = 0;
    let targetY = 0;
    let targetEngagement = 0;

    if (pointer.seen) {
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
