"use client";

/**
 * @vectorvesper/motion/three — the plain three.js adapter.
 *
 * One hook, `useThreeScene`, for a scene written with three.js directly rather
 * than through React Three Fiber. You write the scene; it gates, sizes, draws,
 * recovers and cleans up. The R3F adapter is `@vectorvesper/motion/r3f`.
 *
 * Like that entry it imports nothing from three at runtime. The renderer is
 * yours to make and is read by its shape, so this pulls in nothing beyond
 * React, and a project that never renders 3D never pays for it.
 */

export {
  useThreeScene,
  type UseThreeSceneOptions,
  type ThreeScene,
  type ThreeSceneContext,
  type ThreeSceneFrame,
  type ThreeSceneHandle,
  type ThreeRendererLike,
  type ThreeSceneLike,
} from "./three/useThreeScene";
