"use client";

/**
 * @vectorvesper/motion/react: React adapters ("./react"). Thin hooks over the
 * core runtime. Requires react and react-dom as peers.
 *
 * This entry also mirrors the core singletons, because Framer can't load the
 * root entry (`Module @vectorvesper/motion is not a valid npm package (f3)`).
 * Framer components import everything from here.
 *
 * Framer's validator rejects a module whose declarations contain forwarded
 * re-exports pointing at a relative chunk file. `export *` compiles to that
 * shape in the JavaScript, and `export type *` compiles to it in the .d.ts. So
 * values are re-bound to a `const`, which is ordinary code, and core types
 * aren't re-exported. They stay available from "@vectorvesper/motion".
 *
 * A const alias holds the same function object, so `getConductor()` here and on
 * the root return the one shared instance.
 *
 * After any build-config change, both `dist/react.js` and `dist/react.d.ts` must
 * contain zero forwarded re-exports pointing at a chunk file.
 *
 * This file is `"use client"`, so core helpers reached through it are
 * client-only. Server or framework-agnostic code should import from
 * "@vectorvesper/motion".
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
// So a React app doesn't have to reach into the core entry for these.
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
// These forward from ./effects/*, which belong to this entry alone, so tsup
// inlines them instead of emitting the chunk-forwarding shape Framer rejects.
// The core option types they reference stay on the core entry, for the same
// reason core types aren't mirrored here.
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
