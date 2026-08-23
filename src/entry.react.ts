"use client";

/**
 * @vectorvesper/motion/react — React adapters ("./react")
 *
 * Thin hooks over the core runtime. Requires react + react-dom as peers.
 *
 * ## This entry also re-exports the core singletons
 *
 * Framer cannot load the root entry — `Module @vectorvesper/motion is not a
 * valid npm package (f3)`. That blocked the whole Framer port, because 21
 * components need `getConductor` and it lived only on the path Framer refuses.
 * The workaround people reached for was a private `requestAnimationFrame` loop,
 * which is the exact thing the conductor exists to replace.
 *
 * So the core value exports are mirrored here. Framer components import
 * everything from "@vectorvesper/motion/react".
 *
 * ## Why `const` re-binding, and why no type re-export
 *
 * Both are the same constraint, learned the hard way across 1.1.0 and 1.1.1.
 *
 * Framer's validator rejects a module whose declarations contain **forwarded
 * re-exports pointing at a relative chunk file**. Not barrels in general — that
 * specific shape. Counting them in the published builds:
 *
 *   1.0.4  react.js none · react.d.ts none  → Framer loads it
 *   1.1.0  react.js two  · react.d.ts two   → rejected (added `export *`)
 *   1.1.1  react.js none · react.d.ts two   → still rejected (fixed JS only)
 *
 * `export *` compiles to that shape in the JavaScript. Assigning to a `const`
 * does not — it is a local binding, emitted as ordinary code.
 *
 * `export type *` compiles to that shape in the **.d.ts**, which is what an
 * editor validates. That is why 1.1.1 still failed after the JS was clean, and
 * why core *types* are deliberately not re-exported here. They remain available
 * from "@vectorvesper/motion"; only the callable surface is mirrored.
 *
 * The singleton is unaffected either way: a const alias holds the same function
 * object, so `getConductor()` through this entry and through the root return the
 * one shared instance. A second conductor would mean a second frame loop, which
 * would defeat the entire runtime.
 *
 * ## Regression test
 *
 * After any build-config change, both `dist/react.js` and `dist/react.d.ts`
 * must contain **zero** forwarded re-exports pointing at a chunk file. Check
 * both — 1.1.1 shipped broken because only the first was checked.
 *
 * Note this file is `"use client"`, so core helpers reached through it are
 * client-only. Server or framework-agnostic code should import from
 * "@vectorvesper/motion" directly.
 */

import {
  VERSION as _VERSION,
  clamp01 as _clamp01,
  damp as _damp,
  getAdaptiveQuality as _getAdaptiveQuality,
  getAnimationBudget as _getAnimationBudget,
  getConductor as _getConductor,
  getSensorBus as _getSensorBus,
  rayRectIntersect as _rayRectIntersect,
} from "./entry.core";

export const VERSION = _VERSION;
export const clamp01 = _clamp01;
export const damp = _damp;
export const getAdaptiveQuality = _getAdaptiveQuality;
export const getAnimationBudget = _getAnimationBudget;
export const getConductor = _getConductor;
export const getSensorBus = _getSensorBus;
export const rayRectIntersect = _rayRectIntersect;

export { useSensorBus } from "./react/useSensorBus";
export { useAnimationBudget } from "./react/useAnimationBudget";
export {
  useSafeToMount,
  type UseSafeToMountOptions,
  type MountCost,
} from "./react/useSafeToMount";
export {
  InteractionScope,
  useInteractionScope,
  useTick,
  type InteractionScopeProps,
  type UseTickOptions,
} from "./react/InteractionScope";
export { useAdaptiveQuality } from "./react/useAdaptiveQuality";
export { useFramePressure } from "./react/useFramePressure";
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
