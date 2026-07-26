"use client";

/**
 * @vectorvesper/motion/react — React adapters ("./react")
 *
 * Thin hooks over the core runtime. Requires react + react-dom as peers.
 * Core singletons and classes are imported from "@vectorvesper/motion".
 */

export { useSensorBus } from "./react/useSensorBus";
export { useAnimationBudget } from "./react/useAnimationBudget";
export { useSafeToMount, type UseSafeToMountOptions } from "./react/useSafeToMount";
export { useAdaptiveQuality } from "./react/useAdaptiveQuality";
export {
  usePointerIntent,
  type UsePointerIntentOptions,
  type UsePointerIntentReturn,
} from "./react/usePointerIntent";
export { useMagneticIntent } from "./react/useMagneticIntent";
export { useLazyScene, type UseLazySceneOptions } from "./react/useLazyScene";
export {
  useVideoScrubber,
  type UseVideoScrubberOptions,
  type UseVideoScrubberReturn,
} from "./react/useVideoScrubber";
export { useImageTrail, type UseImageTrailOptions } from "./react/useImageTrail";
export { useNumberTicker, type UseNumberTickerOptions } from "./react/useNumberTicker";
