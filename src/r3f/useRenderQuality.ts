"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import type { SceneState } from "../react/useSceneGate";
import { getRendererHealth } from "../core/renderer-health/RendererHealth";

/**
 * Renderer settings for one quality level.
 *
 * Only what the adapter can genuinely apply to the renderer itself. Particle
 * counts, geometry detail and post-processing passes are not here on purpose —
 * those live in your own components, keyed off `gate.quality`. An option that
 * looks applied and is not is worse than no option.
 */
export interface RenderProfile {
  /**
   * Device pixel ratio. Capping this is the single biggest saving available on
   * a high-density display: dropping from 3 to 1.5 quarters the pixels shaded.
   */
  dpr?: number;
  /** Whether shadow maps are drawn at all. */
  shadows?: boolean;
}

export interface RenderProfiles {
  full: RenderProfile;
  reduced: RenderProfile;
}

/**
 * Apply a scene gate's decision to the R3F renderer.
 *
 * ```tsx
 * function Rig({ state }: { state: SceneState }) {
 *   useRenderQuality(state, {
 *     full:    { dpr: 2, shadows: true },
 *     reduced: { dpr: 1, shadows: false },
 *   });
 *   return null;
 * }
 *
 * // and outside the canvas
 * const scene = useSceneGate<HTMLDivElement>({ label: "hero" });
 *
 * <div ref={scene.ref}>
 *   {scene.mounted && (
 *     <Canvas>
 *       <Rig state={scene.state} />
 *       <Hero detail={scene.quality} />
 *     </Canvas>
 *   )}
 * </div>
 * ```
 *
 * Three jobs.
 *
 * **It applies the profile.** Pixel ratio and shadows follow the state, live,
 * without rebuilding the scene.
 *
 * **It stops the render loop when the scene is off screen.** R3F draws
 * continuously by default, so a hero three screens up keeps shading every
 * frame for nobody. On `"idle"` the loop is set to `"never"` and the context,
 * the textures and the geometry all stay exactly where they were — coming back
 * into view is instant, where a remount would pay for the whole upload again.
 *
 * **It notices when the graphics context dies.** A browser can take a WebGL
 * context away at any time, and R3F has no handler for it — verified against
 * 9.6.1, there is nothing in the bundle. What you get is a permanently black
 * canvas and a clean console. This calls `preventDefault()` so a replacement
 * context is possible at all, and reports the loss so the scene gate can hand
 * back a new `generation` for the `<Canvas key>`.
 *
 * ## Why this is a separate import
 *
 * `@vectorvesper/motion` has no dependencies. Three and R3F are optional peers
 * reached through `@vectorvesper/motion/r3f`, so a project that never renders
 * 3D never pays for any of this.
 *
 * ## Why quality is not changed with `#define`
 *
 * Recompiling a shader is a stall of exactly the kind this is trying to avoid,
 * and it lands at the worst possible moment — when the page is already
 * struggling. Everything here is a renderer setting or a uniform. If you need
 * a cheaper shader variant, compile both up front and switch which one draws.
 */
export function useRenderQuality(
  state: SceneState,
  profiles: RenderProfiles,
): void {
  const gl = useThree((s) => s.gl);
  const setDpr = useThree((s) => s.setDpr);
  const setFrameloop = useThree((s) => s.setFrameloop);
  const invalidate = useThree((s) => s.invalidate);

  const running = state === "active" || state === "constrained";
  const profile = state === "active" ? profiles.full : profiles.reduced;
  const { dpr, shadows } = profile;

  // Off screen: keep everything, draw nothing.
  useEffect(() => {
    if (state === "idle") {
      setFrameloop("never");
      return;
    }
    if (running) {
      setFrameloop("always");
      // A loop that was stopped has nothing queued, so ask for one frame to
      // get the picture back rather than waiting for something else to.
      invalidate();
    }
  }, [state, running, setFrameloop, invalidate]);

  // The context can go at any moment: a driver reset, a phone backgrounding
  // the tab, too many live contexts. Without preventDefault the browser will
  // not attempt a restore, and some drivers then refuse a new context on the
  // page at all — so this runs whatever the scene's state is.
  useEffect(() => {
    const canvas = gl.domElement;
    const onLost = (event: Event) => {
      event.preventDefault();
      getRendererHealth().reportLost();
    };
    canvas.addEventListener("webglcontextlost", onLost);

    // Mounting at all means a working context. After a loss this is the
    // replacement announcing itself, which is what ends the recovery.
    getRendererHealth().reportHealthy();

    return () => canvas.removeEventListener("webglcontextlost", onLost);
  }, [gl]);

  useEffect(() => {
    if (!running || dpr === undefined) return;
    setDpr(dpr);
    invalidate();
  }, [running, dpr, setDpr, invalidate]);

  useEffect(() => {
    if (!running || shadows === undefined) return;
    const previous = gl.shadowMap.enabled;
    gl.shadowMap.enabled = shadows;
    // Existing materials were compiled against the old shadow setting and will
    // otherwise keep their old shader until something else marks them dirty.
    gl.shadowMap.needsUpdate = true;
    invalidate();
    return () => {
      gl.shadowMap.enabled = previous;
    };
  }, [running, shadows, gl, invalidate]);
}
