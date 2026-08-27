"use client";

/**
 * @vectorvesper/motion/r3f — the React Three Fiber adapter.
 *
 * Kept out of the main entries so the package stays dependency-free. Three and
 * `@react-three/fiber` are optional peers, reached only through this import, so
 * a project that never renders 3D never pays for any of it.
 *
 * This layer applies decisions; it does not make them. `useSceneGate` on the
 * React entry decides whether a scene runs and how much of it, and knows
 * nothing about a renderer. That split is deliberate: the policy is worth
 * having whether you draw with three, with a 2D canvas, or with something that
 * does not exist yet.
 *
 * Since 4.0 the adapter is a plain hook that returns `<Canvas>` props and
 * imports no R3F value, so this entry pulls in nothing at runtime beyond React.
 * The peers stay declared because the props it returns are only meaningful to
 * an R3F canvas.
 */

export {
  useRenderQuality,
  type RenderProfile,
  type RenderProfiles,
  type RenderQualityProps,
} from "./r3f/useRenderQuality";
