"use client";

import { useCallback, useMemo } from "react";
import type { SceneState } from "../react/useSceneGate";
import { getRendererHealth } from "../core/renderer-health/RendererHealth";

/**
 * Renderer settings for one quality level.
 *
 * Only what the adapter can genuinely apply to the renderer itself. Particle
 * counts, geometry detail and post-processing passes are not here on purpose:
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

/** The subset of R3F's `onCreated` argument this needs. */
interface CreatedState {
  gl: { domElement: HTMLCanvasElement };
}

/**
 * Props to spread onto `<Canvas>`. Every field is a prop R3F owns.
 */
export interface RenderQualityProps {
  dpr: number | undefined;
  frameloop: "always" | "never";
  shadows: boolean | undefined;
  onCreated: (state: CreatedState) => void;
}

/**
 * Turn a scene gate's decision into `<Canvas>` props.
 *
 * ```tsx
 * const { ref, state, mounted, quality, generation } =
 *   useSceneGate<HTMLDivElement>({ label: "hero" });
 * const canvas = useRenderQuality(state, {
 *   full:    { dpr: 2, shadows: true },
 *   reduced: { dpr: 1, shadows: false },
 * });
 *
 * <div ref={ref}>
 *   {mounted && (
 *     <Canvas key={generation} {...canvas}>
 *       <Hero detail={quality} />
 *     </Canvas>
 *   )}
 * </div>
 * ```
 *
 * Called OUTSIDE the canvas, because that is where its output goes. It touches
 * no R3F context and renders nothing.
 *
 * Three jobs.
 *
 * **It applies the profile.** Pixel ratio and shadows follow the state, live,
 * without rebuilding the scene.
 *
 * **It stops the render loop when the scene is off screen.** R3F draws
 * continuously by default, so a hero three screens up keeps shading every
 * frame for nobody. On `"idle"` the loop is set to `"never"` and the context,
 * the textures and the geometry all stay exactly where they were, so coming
 * back into view is instant where a remount would pay for the whole upload
 * again.
 *
 * **It notices when the graphics context dies.** A browser can take a WebGL
 * context away at any time, and R3F has no handler for it: verified against
 * 9.6.1, there is nothing in the bundle. What you get is a permanently black
 * canvas and a clean console. `onCreated` attaches a listener that calls
 * `preventDefault()`, so a replacement context is possible at all, and reports
 * the loss so the scene gate can hand back a new `generation` for the
 * `<Canvas key>`.
 *
 * ## Why props, when 3.0 did this imperatively
 *
 * Up to 3.0.1 this ran inside the canvas and called `setDpr`, `setFrameloop`
 * and assigned `gl.shadowMap.enabled` directly. None of it survived.
 *
 * R3F re-runs its configure pass on every `<Canvas>` render and resets the
 * renderer from the props:
 *
 * ```js
 * if (dpr && state.viewport.dpr !== calculateDpr(dpr)) state.setDpr(dpr);
 * if (state.frameloop !== frameloop) state.setFrameloop(frameloop);
 * gl.shadowMap.enabled = !!shadows;
 * ```
 *
 * v9 defaults `dpr` to `[1, 2]`, `frameloop` to `"always"` and `shadows` to
 * undefined, so every imperative call was undone on the next render. Measured
 * in a real browser against 3.0.1: an idle scene kept rendering, 167 further
 * frames in three seconds, and a renderer asked for `dpr: 1` sat at 1.25.
 *
 * These are R3F's settings. The only way to hold them is to be the thing R3F
 * reconciles against, which means props.
 *
 * ## Why this is a separate import
 *
 * `@vectorvesper/motion` has no dependencies. Three and R3F are optional peers
 * reached through `@vectorvesper/motion/r3f`, so a project that never renders
 * 3D never pays for any of this. As of 4.0 this module imports no R3F value at
 * all, only React.
 *
 * ## Why quality is not changed with `#define`
 *
 * Recompiling a shader is a stall of exactly the kind this is trying to avoid,
 * and it lands at the worst possible moment, when the page is already
 * struggling. Everything here is a renderer setting or a uniform. If you need
 * a cheaper shader variant, compile both up front and switch which one draws.
 */
export function useRenderQuality(
  state: SceneState,
  profiles: RenderProfiles,
): RenderQualityProps {
  const profile = state === "active" ? profiles.full : profiles.reduced;
  const { dpr, shadows } = profile;

  /**
   * Off screen: keep everything, draw nothing.
   *
   * Only `"idle"` stops the loop. `dormant`, `warming` and `poster` mean the
   * canvas should not exist yet, which is the gate's `mounted` decision rather
   * than this one, and stopping the loop for a canvas that is about to be
   * created would leave it blank on arrival.
   */
  const frameloop: "always" | "never" = state === "idle" ? "never" : "always";

  const onCreated = useCallback(({ gl }: CreatedState) => {
    // Mounting at all means a working context. After a loss this is the
    // replacement announcing itself, which is what ends the recovery.
    getRendererHealth().reportHealthy();

    // Without preventDefault the browser will not attempt a restore, and some
    // drivers then refuse a new context on the page at all.
    gl.domElement.addEventListener("webglcontextlost", (event: Event) => {
      event.preventDefault();
      getRendererHealth().reportLost();
    });
  }, []);

  return useMemo(
    () => ({ dpr, frameloop, shadows, onCreated }),
    [dpr, frameloop, shadows, onCreated],
  );
}
