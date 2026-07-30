/**
 * @vectorvesper/motion — core entry (".")
 *
 * Zero runtime dependencies. Framework-agnostic: usable from vanilla JS, Vue,
 * Svelte, or any renderer. React adapters live in "@vectorvesper/motion/react".
 *
 * ## Public API — frozen at 1.0
 *
 * This is the whole supported surface. It is deliberately small: the four
 * singleton accessors, a few pure helpers, and the types you need to consume
 * them. The imperative core classes (PointerIntent, MagneticElement,
 * VideoScrubber, SensorBus, BudgetPolicy) are NOT exported — you drive them
 * through the React hooks, which own their lifecycle. Refresh-rate detection
 * and the device-tier heuristic are internal and stay that way.
 *
 * Anything added here is a permanent commitment (removing it is a breaking
 * change). `scripts/check-api.mjs` guards the surface against silent drift.
 */

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
  type AdaptiveState,
  type DeviceSignals,
} from "./core/adaptive-quality/AdaptiveQuality";

// ── Option types ────────────────────────────────────────────────────
// The classes these configure are internal; the option shapes are public so
// the React hooks that wrap them can be typed against a named contract.
export type { PointerIntentOptions } from "./core/pointer-intent/PointerIntent";
export type { MagneticOptions } from "./core/magnetic/MagneticElement";
export type {
  VideoScrubberOptions,
  ScrubDriver,
  ScrubMapping,
} from "./core/video-scrubber/VideoScrubber";
