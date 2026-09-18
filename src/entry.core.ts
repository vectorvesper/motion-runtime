/**
 * @vectorvesper/motion — core entry (".")
 *
 * Zero runtime dependencies. Framework-agnostic: usable from vanilla JS, Vue,
 * Svelte, or any renderer. React adapters live in "@vectorvesper/motion/react".
 *
 * ## What this entry exports
 *
 * The whole public core API. It is small on purpose: four singleton getters,
 * a few pure helpers, and the types you need to use them.
 *
 * The three effect engines (PointerIntent, MagneticElement, VideoScrubber)
 * ARE exported as of 3.0. Prefer the React hooks, which handle setup and
 * teardown for you; reach for the classes when there is no React, which is the
 * case this entry has advertised support for since 1.0 while shipping no way to
 * act on it. SensorBus and BudgetPolicy stay internal because you get their
 * instances from a getter. Refresh-rate detection and the device-tier
 * heuristic are internal.
 *
 * This surface can still change while 2.0 is in progress. Once 2.0 ships,
 * removing anything from it is a breaking change. `scripts/check-api.mjs`
 * diffs the built output against api-surface.json so nothing moves by
 * accident.
 */

// ── Version ─────────────────────────────────────────────────────────
/**
 * The published package version. Support questions start with "which version?",
 * and until now there was no way for a consumer to answer that at runtime.
 *
 * Substituted at build time from package.json by tsup's `define`, so it cannot
 * drift from the actual version.
 *
 * It was added hoping it would also fix a structural problem — this file is
 * otherwise entirely `export … from`, which compiles to a root entry whose every
 * statement forwards to a hashed chunk, and Framer's resolver rejects that as
 * "not a valid npm package (f3)". **It did not fix it.** With splitting on, and
 * with "./react" now mirroring this surface, the constant is shared between both
 * entries, so tsup hoists it into the chunk and the root stays a pure barrel.
 *
 * The working fix is that "./react" re-exports everything here — see
 * entry.react.ts. Import from "@vectorvesper/motion/react" in Framer.
 */
export const VERSION: string = __VV_VERSION__;

// ── Scheduling ──────────────────────────────────────────────────────
export {
  getConductor,
  type ConductorLane,
  type FrameFn,
  type SubscribeOptions,
  type SubscriberPriority,
  type SubscriberStat,
  type ConductorStats,
  type ConductorConfig,
} from "./core/conductor";

// ── Math helpers ────────────────────────────────────────────────────
export { damp, clamp01, rayRectIntersect, type RectLike } from "./core/math";

// ── Shared input ────────────────────────────────────────────────────
// `SensorBus` is a type only — you get the instance from `getSensorBus()`,
// you never construct one.
export {
  getSensorBus,
  type SensorBus,
  type SensorState,
  type PointerSensor,
  type ScrollSensor,
  type ViewportSensor,
} from "./core/sensor-bus/SensorBus";

// ── Performance governance ──────────────────────────────────────────
export {
  getAnimationBudget,
  type BudgetState,
  type BudgetTier,
} from "./core/animation-budget/AnimationBudget";
export {
  getAdaptiveQuality,
  fuse,
  type AdaptiveState,
  type DeviceSignals,
  type QualityCause,
} from "./core/adaptive-quality/AdaptiveQuality";

// ── Option types ────────────────────────────────────────────────────
// The classes these configure are internal; the option shapes are public so
// the React hooks that wrap them can be typed against a named contract.
export { getFramePressure } from "./core/frame-pressure/FramePressure";
export { getRendererHealth } from "./core/renderer-health/RendererHealth";
export type { RendererHealthState, ReportLostOptions } from "./core/renderer-health/RendererHealth";

// WebGPU. A dead device resolves `device.lost` instead of firing an event, so
// it needs its own wiring, and the recovery behind it is the same counter.
export { watchGPUDevice } from "./core/renderer-health/watchGPUDevice";
export type {
  GPUDeviceLike,
  StopWatchingDevice,
} from "./core/renderer-health/watchGPUDevice";
export type {
  PressureState,
  PressureSource,
} from "./core/frame-pressure/FramePressure";

// ── Effect engines ──────────────────────────────────────────────────
// New in 3.0. The README has claimed vanilla / Vue / Svelte support since 1.0,
// and until now a non-React consumer got the conductor, the sensors, the
// governors and the maths, and could not use a single effect: these classes
// were internal while their option types were public, so you could name the
// options and not construct the thing.
export { PointerIntent } from "./core/pointer-intent/PointerIntent";
export { MagneticElement } from "./core/magnetic/MagneticElement";
export { VideoScrubber, VIDEO_SCRUBBER_DEFAULTS, scrollProgress } from "./core/video-scrubber/VideoScrubber";
export type {
  PointerIntentOptions,
  PointerIntentSensitivity,
  PointerIntentTuning,
} from "./core/pointer-intent/PointerIntent";
export { POINTER_INTENT_SENSITIVITY } from "./core/pointer-intent/PointerIntent";
export type { MagneticOptions } from "./core/magnetic/MagneticElement";
export type {
  VideoScrubberOptions,
  ScrubDriver,
  ScrubMapping,
} from "./core/video-scrubber/VideoScrubber";
