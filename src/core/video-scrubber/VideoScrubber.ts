import { getConductor } from "../conductor";
import { getSensorBus } from "../sensor-bus/SensorBus";
import { damp, clamp01 } from "../math";

/**
 * VideoScrubber — maps scroll, pointer, or manual progress onto a video's
 * timeline. Framework-agnostic core; React (and future) adapters are thin
 * lifecycle bridges.
 *
 * What it handles that naive `currentTime = x` does not:
 * - Seek discipline: never issues a new seek while the previous one is
 *   in-flight (Safari queues them and stutters); sub-frame deltas are
 *   skipped; large jumps use `fastSeek` where available (keyframe-fast).
 * - iOS buffering: videos are primed with a muted play()/pause() round trip
 *   so Safari actually loads data before the first scrub.
 * - Attribute etiquette: `muted`/`playsInline`/`preload` are set for
 *   scrubbing but recorded first and restored exactly on destroy().
 * - Smoothing: frame-rate-independent damping on the shared conductor —
 *   no private rAF. Under prefers-reduced-motion the scrub still works
 *   (it is direct manipulation, not autonomous motion) but tracks
 *   instantly, with no trailing lag.
 */

export type ScrubDriver = "scroll" | "pointer" | "manual";

/**
 * How scroll position maps to progress when `driver: "scroll"`:
 * - "pin":   for tall tracks with sticky content — 0 when the track top
 *            docks at the viewport top, 1 when its bottom reaches the
 *            viewport bottom (the Apple scrollytelling pattern).
 * - "cross": 0 as the track top enters at the viewport bottom, 1 as its
 *            bottom exits at the top.
 * - "auto":  "pin" when the track is taller than ~1.2 viewports, else "cross".
 */
export type ScrubMapping = "auto" | "pin" | "cross";

export interface VideoScrubberOptions {
  /** What drives progress. Fixed for the instance lifetime. */
  driver?: ScrubDriver;
  /** Element whose geometry defines progress. Default: the video's parent. */
  track?: HTMLElement;
  /** Scroll→progress mapping (scroll driver only). */
  mapping?: ScrubMapping;
  /** Damping responsiveness per second; 0 = instant. */
  smooth?: number;
  /** Pointer driver: which axis of the track maps to progress. */
  pointerAxis?: "x" | "y";
  /** Fired when smoothed progress changes (per frame, deduplicated). */
  onProgress?: (progress: number, time: number) => void;
}

export const VIDEO_SCRUBBER_DEFAULTS = {
  driver: "scroll",
  mapping: "auto",
  smooth: 8,
  pointerAxis: "x",
} as const satisfies Omit<VideoScrubberOptions, "track" | "onProgress">;

const SEEK_EPSILON = 1 / 60;      // sub-frame target deltas are noise
const FAST_SEEK_THRESHOLD = 0.35; // seconds; beyond this, keyframe-fast seek
const PROGRESS_EPSILON = 1e-4;
const CULL_MARGIN_VH = 1;         // viewports beyond which seeking pauses

function supportsFastSeek(
  v: HTMLVideoElement,
): v is HTMLVideoElement & { fastSeek(time: number): void } {
  return "fastSeek" in v && typeof v.fastSeek === "function";
}

/**
 * Pure scroll→progress mapping (exported for tests).
 * `top` is the track's viewport-relative top (getBoundingClientRect().top).
 */
export function scrollProgress(
  top: number,
  height: number,
  viewportHeight: number,
  mapping: ScrubMapping,
): number {
  const pin =
    mapping === "pin" || (mapping === "auto" && height > viewportHeight * 1.2);
  return pin
    ? clamp01(-top / Math.max(height - viewportHeight, 1))
    : clamp01((viewportHeight - top) / (viewportHeight + height));
}

export class VideoScrubber {
  readonly video: HTMLVideoElement;
  readonly track: HTMLElement;

  private driver: ScrubDriver;
  private mapping: ScrubMapping;
  private smooth: number;
  /**
   * Sampled once, at construction, and honoured by every later write to
   * `smooth`. Without it the reduced-motion clamp applied only in the
   * constructor and any subsequent `update({ smooth })` silently restored the
   * trailing lag — which is exactly what a React wrapper does when a `smooth`
   * prop changes.
   */
  private readonly prefersReduced: boolean;
  private pointerAxis: "x" | "y";
  private onProgress?: (progress: number, time: number) => void;

  private target = 0;
  private current = 0;
  private lastEmitted = -1;
  private duration = 0;
  private unsubscribe: () => void;
  private releaseBus: () => void;
  private cleanups: Array<() => void> = [];
  private restore: {
    muted: boolean;
    playsInline: boolean;
    preload: HTMLMediaElement["preload"];
  };

  private trackOffsetTop = 0;
  private trackHeight = 0;
  private lastViewportWidth = 0;
  private lastViewportHeight = 0;

  private seekEpsilon = SEEK_EPSILON;
  private seekStartTime = 0;
  private warningTriggered = false;
  private lastSeekDuration = 0;

  constructor(video: HTMLVideoElement, options: VideoScrubberOptions = {}) {
    this.video = video;
    this.track = options.track ?? video.parentElement ?? video;
    this.driver = options.driver ?? VIDEO_SCRUBBER_DEFAULTS.driver;
    this.mapping = options.mapping ?? VIDEO_SCRUBBER_DEFAULTS.mapping;
    this.pointerAxis = options.pointerAxis ?? VIDEO_SCRUBBER_DEFAULTS.pointerAxis;
    this.onProgress = options.onProgress;

    this.prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.smooth = this.resolveSmooth(options.smooth ?? VIDEO_SCRUBBER_DEFAULTS.smooth);

    this.restore = {
      muted: video.muted,
      playsInline: video.playsInline,
      preload: video.preload,
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    if (Number.isFinite(video.duration) && video.duration > 0) {
      this.duration = video.duration;
    } else {
      const onMeta = () => { this.duration = video.duration; };
      video.addEventListener("loadedmetadata", onMeta);
      this.cleanups.push(() => video.removeEventListener("loadedmetadata", onMeta));
    }

    this.releaseBus = getSensorBus().retain();
    this.measureTrack();

    // Adaptive Seek Throttle: monitor seek latency and throttle if browser is struggling
    const onSeeking = () => {
      this.seekStartTime = performance.now();
    };
    const onSeeked = () => {
      if (this.seekStartTime > 0) {
        const seekDuration = performance.now() - this.seekStartTime;
        this.lastSeekDuration = seekDuration;
        // If a seek takes longer than 60ms (very slow decoder due to lack of I-frames)
        if (seekDuration > 60) {
          // Increase seek epsilon to skip near-frame seeks (up to 0.5s of throttle)
          this.seekEpsilon = Math.min(0.5, this.seekEpsilon + 0.05);
          
          if (seekDuration > 150 && !this.warningTriggered) {
            console.warn(
              `[vv-motion] VideoScrubber seeking is slow (${seekDuration.toFixed(0)}ms). ` +
              `This is usually caused by unoptimized video keyframe encoding. ` +
              `For 120 FPS jank-free scrubbing, encode your video with keyframes on every frame:\n` +
              `ffmpeg -i input.mp4 -g 1 -coder 0 -bf 0 output.mp4`
            );
            this.warningTriggered = true;
          }
        } else {
          // Fast seeks: slowly decay back to the minimum
          this.seekEpsilon = Math.max(SEEK_EPSILON, this.seekEpsilon - 0.01);
        }
        this.seekStartTime = 0;
      }
    };
    video.addEventListener("seeking", onSeeking);
    video.addEventListener("seeked", onSeeked);
    this.cleanups.push(() => {
      video.removeEventListener("seeking", onSeeking);
      video.removeEventListener("seeked", onSeeked);
    });

    this.prime();
    if (this.driver === "pointer") this.attachPointer();
    // Essential: this is direct manipulation. A scrub that stutters under
    // load reads as a broken scrub, not as a tastefully degraded one.
    this.unsubscribe = getConductor().subscribe("update", this.frame, {
      priority: "essential",
      label: "VideoScrubber",
    });
  }

  /** Muted play/pause round trip so iOS Safari buffers before the first scrub. */
  private prime(): void {
    const p = this.video.play();
    if (p) p.then(() => this.video.pause()).catch(() => {});
  }

  private attachPointer(): void {
    const onMove = (e: PointerEvent) => {
      const r = this.track.getBoundingClientRect();
      this.target = clamp01(
        this.pointerAxis === "x"
          ? (e.clientX - r.left) / Math.max(r.width, 1)
          : (e.clientY - r.top) / Math.max(r.height, 1),
      );
    };
    this.track.addEventListener("pointermove", onMove);
    this.cleanups.push(() => this.track.removeEventListener("pointermove", onMove));
  }

  /** Smoothed progress, 0..1. */
  get progress(): number {
    return this.current;
  }

  /** Where progress is heading before smoothing settles. */
  get targetProgress(): number {
    return this.target;
  }

  /**
   * Set progress directly. The natural API for `driver: "manual"`; under
   * other drivers the next frame's read overwrites it.
   */
  set(progress: number): void {
    this.target = clamp01(progress);
  }

  /**
   * Reduced motion wins over any requested smoothing. Scrubbing itself is
   * direct manipulation, so it stays enabled — but the trailing lag is
   * autonomous motion, and that is the part to drop.
   */
  private resolveSmooth(requested: number): number {
    return this.prefersReduced ? 0 : requested;
  }

  /** Live-tunable options. `driver` and `track` are fixed by design. */
  update(options: Pick<VideoScrubberOptions, "smooth" | "mapping" | "pointerAxis" | "onProgress">): void {
    if (options.smooth !== undefined) this.smooth = this.resolveSmooth(options.smooth);
    if (options.mapping !== undefined) this.mapping = options.mapping;
    if (options.pointerAxis !== undefined) this.pointerAxis = options.pointerAxis;
    if (options.onProgress !== undefined) this.onProgress = options.onProgress;
  }

  private measureTrack(): void {
    let top = 0;
    let curr: HTMLElement | null = this.track;
    while (curr) {
      top += curr.offsetTop;
      curr = curr.offsetParent as HTMLElement | null;
    }
    this.trackOffsetTop = top;
    this.trackHeight = this.track.offsetHeight;
  }

  private frame = (dt: number): void => {
    let cullSeek = false;
    const { scroll, viewport } = getSensorBus().state;

    // Recalculate track geometry only if viewport size changed (resize)
    if (viewport.width !== this.lastViewportWidth || viewport.height !== this.lastViewportHeight) {
      this.measureTrack();
      this.lastViewportWidth = viewport.width;
      this.lastViewportHeight = viewport.height;
    }

    if (this.driver === "scroll") {
      const top = this.trackOffsetTop - scroll.y;
      const height = this.trackHeight;
      const vh = viewport.height;

      this.target = scrollProgress(top, height, vh, this.mapping);
      cullSeek =
        (top + height) < -vh * CULL_MARGIN_VH || top > vh * (1 + CULL_MARGIN_VH);
    }

    this.current =
      this.smooth > 0 ? damp(this.current, this.target, this.smooth, dt) : this.target;

    if (Math.abs(this.current - this.lastEmitted) > PROGRESS_EPSILON) {
      this.lastEmitted = this.current;
      this.onProgress?.(this.current, this.current * this.duration);
    }

    if (this.duration === 0 || cullSeek) return;

    const v = this.video;
    if (v.seeking) return; // let the in-flight seek land first

    const t = this.current * this.duration;
    const delta = Math.abs(t - v.currentTime);
    if (delta < this.seekEpsilon) return;

    if (delta > FAST_SEEK_THRESHOLD && supportsFastSeek(v)) v.fastSeek(t);
    else v.currentTime = t;
  };

  /** Stops everything and restores the video element exactly as found. */
  destroy(): void {
    this.unsubscribe();
    this.releaseBus();
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
    this.video.muted = this.restore.muted;
    this.video.playsInline = this.restore.playsInline;
    this.video.preload = this.restore.preload;
  }
}
