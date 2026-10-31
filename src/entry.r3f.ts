"use client";

/**
 * @vectorvesper/motion/r3f: the React Three Fiber adapter.
 *
 * Three and `@react-three/fiber` are optional peers, reached only through this
 * import, so a project that never renders 3D never pays for them.
 *
 * This layer applies decisions. `useSceneGate` on the React entry makes them
 * and knows nothing about a renderer, so the policy works with three, a 2D
 * canvas or anything else.
 *
 * The adapter is a plain hook that returns `<Canvas>` props and imports no R3F
 * value, so this entry pulls in nothing at runtime beyond React.
 */

export {
  useRenderQuality,
  type RenderProfile,
  type RenderProfiles,
  type RenderQualityProps,
} from "./r3f/useRenderQuality";
