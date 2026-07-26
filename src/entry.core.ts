/**
 * @vectorvesper/motion — core entry (".")
 *
 * Zero runtime dependencies. Framework-agnostic: usable from vanilla JS, Vue,
 * Svelte, or any renderer. React adapters live in "@vectorvesper/motion/react".
 */

// scheduling
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
export {
  RefreshRateProbe,
  snapToCandidate,
  REFRESH_CANDIDATES,
  DEFAULT_HZ,
} from "./core/refresh-rate";

// math helpers
export { damp, clamp01, rayRectIntersect, type RectLike } from "./core/math";

// shared input
export {
  getSensorBus,
  SensorBus,
  type SensorState,
  type PointerSensor,
  type ScrollSensor,
  type ViewportSensor,
} from "./core/sensor-bus/SensorBus";

// performance governance
export {
  getAnimationBudget,
  BudgetPolicy,
  type BudgetState,
  type BudgetTier,
} from "./core/animation-budget/AnimationBudget";
export {
  getAdaptiveQuality,
  deviceTierFromSignals,
  type AdaptiveState,
  type DeviceSignals,
} from "./core/adaptive-quality/AdaptiveQuality";

// interaction
export { PointerIntent, type PointerIntentOptions } from "./core/pointer-intent/PointerIntent";
export { MagneticElement, type MagneticOptions } from "./core/magnetic/MagneticElement";

// media
export {
  VideoScrubber,
  VIDEO_SCRUBBER_DEFAULTS,
  scrollProgress,
  type VideoScrubberOptions,
  type ScrubDriver,
  type ScrubMapping,
} from "./core/video-scrubber/VideoScrubber";
