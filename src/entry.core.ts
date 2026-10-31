/**
 * @vectorvesper/motion: core entry (".")
 *
 * No runtime dependencies. Framework-agnostic: usable from vanilla JS, Vue,
 * Svelte or any renderer. React adapters live in "@vectorvesper/motion/react".
 *
 * Prefer the React hooks, which handle setup and teardown. Use the effect
 * classes (PointerIntent, MagneticElement, VideoScrubber) when there is no
 * React. SensorBus and BudgetPolicy stay internal because you get their
 * instances from a getter. Refresh-rate detection and the device-tier heuristic
 * are internal.
 *
 * Removing anything here is a breaking change. `scripts/check-api.mjs` diffs
 * the built output against api-surface.json so nothing moves by accident.
 */

// ── Version ─────────────────────────────────────────────────────────
/**
 * The published package version, substituted at build time from package.json by
 * tsup's `define`, so support questions can be answered at runtime.
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
// `SensorBus` is a type only: you get the instance from `getSensorBus()`.
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
// For consumers without React.
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
