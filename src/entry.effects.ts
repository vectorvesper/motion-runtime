/**
 * @vectorvesper/motion/effects — self-contained visual effects.
 *
 * These are recipes, not runtime. Each one does a single visible thing and
 * owns its own lifecycle; none of them is a piece of the coordination the rest
 * of the package exists to provide, and nothing else in the package depends on
 * them.
 *
 * They live behind their own import so the runtime entries describe one idea
 * each — the kernel coordinates, the health layer judges, the policy layer
 * decides, the adapters apply. An effect is none of those, and mixing them in
 * made the surface read as a grab bag rather than infrastructure.
 *
 * Practical consequence, and the reason this is worth the churn: a reader
 * landing on `@vectorvesper/motion/react` now sees only things that are part
 * of the runtime story.
 */

export { useMagneticIntent } from "./effects/useMagneticIntent";
export type { MagneticOptions } from "./core/magnetic/MagneticElement";

export {
  usePointerIntent,
  type UsePointerIntentOptions,
  type UsePointerIntentReturn,
} from "./effects/usePointerIntent";
export type {
  PointerIntentOptions,
  PointerIntentSensitivity,
} from "./core/pointer-intent/PointerIntent";

export { useImageTrail, type UseImageTrailOptions } from "./effects/useImageTrail";

export {
  useNumberTicker,
  type UseNumberTickerOptions,
} from "./effects/useNumberTicker";

export {
  useVideoScrubber,
  type UseVideoScrubberOptions,
  type UseVideoScrubberReturn,
} from "./effects/useVideoScrubber";
export type {
  VideoScrubberOptions,
  ScrubDriver,
  ScrubMapping,
} from "./core/video-scrubber/VideoScrubber";
