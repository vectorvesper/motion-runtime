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
  getFramePressure as _getFramePressure,
  getRendererHealth as _getRendererHealth,
  getSensorBus as _getSensorBus,
  rayRectIntersect as _rayRectIntersect,
  POINTER_INTENT_SENSITIVITY as _POINTER_INTENT_SENSITIVITY,
} from "./entry.core";

export const VERSION = _VERSION;
export const clamp01 = _clamp01;
export const damp = _damp;
export const getAdaptiveQuality = _getAdaptiveQuality;
export const getAnimationBudget = _getAnimationBudget;
export const getConductor = _getConductor;
export const getSensorBus = _getSensorBus;
export const rayRectIntersect = _rayRectIntersect;
// Closing two of the three gaps 2.x left here. A React app importing
// everything else from this entry had to reach into the core entry for these,
// and only these.
export const getFramePressure = _getFramePressure;
export const getRendererHealth = _getRendererHealth;
// Read-only view of what each sensitivity band resolves to, for anything that
// has to explain a preset rather than just use one.
export const POINTER_INTENT_SENSITIVITY = _POINTER_INTENT_SENSITIVITY;

export { useSensorBus } from "./react/useSensorBus";
export { useAnimationBudget } from "./react/useAnimationBudget";
export {
  useSafeToMount,
  SAFE_TO_MOUNT_COST,
  type UseSafeToMountOptions,
  type MountCost,
  type MountCostThresholds,
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
  useSceneGate,
  type UseSceneGateOptions,
  type SceneGate,
  type SceneState,
} from "./react/useSceneGate";

// ── Effects ─────────────────────────────────────────────────────────
// Merged back from "./effects" in 3.0. The split was argued as "the entries
// match the layers", and the layering was real, but an entry has to earn its
// place by protecting the consumer from a dependency they do not have.
// `sideEffects: false` already tree-shakes an unused hook, so this one
// protected nobody from anything, and both of our own apps immediately wrote
// the same shim collapsing it back.
//
// These forward from ./effects/*, which after the merge belong to this entry
// alone, so tsup inlines them rather than emitting the chunk-forwarding shape
// Framer rejects. The core OPTION types they reference deliberately stay on
// the core entry, for the same reason core types are not mirrored here.
export { useMagneticIntent } from "./effects/useMagneticIntent";
export {
  usePointerIntent,
  type UsePointerIntentOptions,
  type UsePointerIntentReturn,
} from "./effects/usePointerIntent";
export { useImageTrail, type UseImageTrailOptions } from "./effects/useImageTrail";
export { useNumberTicker, type UseNumberTickerOptions } from "./effects/useNumberTicker";
export {
  useVideoScrubber,
  type UseVideoScrubberOptions,
  type UseVideoScrubberReturn,
} from "./effects/useVideoScrubber";
