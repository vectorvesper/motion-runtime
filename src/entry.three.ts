"use client";

/**
 * @vectorvesper/motion/three: the plain three.js adapter.
 *
 * One hook, `useThreeScene`, for a scene written with three.js directly. You
 * write the scene, and it gates, sizes, draws, recovers and cleans up. The R3F
 * adapter is `@vectorvesper/motion/r3f`.
 *
 * It imports nothing from three at runtime. The renderer is yours to make and
 * is read by its shape, so this pulls in nothing beyond React.
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
