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
 * The classes behind those singletons (PointerIntent, MagneticElement,
 * VideoScrubber, SensorBus, BudgetPolicy) are not exported. Use the React
 * hooks instead. They handle setup and teardown for you. Refresh-rate
 * detection and the device-tier heuristic are internal.
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
