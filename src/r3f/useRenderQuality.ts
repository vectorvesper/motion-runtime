"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SceneState } from "../react/useSceneGate";
import { getRendererHealth } from "../core/renderer-health/RendererHealth";
import { watchGPUDevice } from "../core/renderer-health/watchGPUDevice";
import { gpuDeviceOf, isContextLost } from "../core/renderer-health/rendererChecks";

/**
 * Renderer settings for one quality level. Only what the adapter can apply to
 * the renderer itself. Particle counts, geometry detail and post-processing
 * live in your own components, keyed off `gate.quality`.
 */
export interface RenderProfile {
  /**
   * The highest device pixel ratio the canvas draws at. Never above the
   * screen's own, so `dpr: 2` draws a 1x monitor at 1x and a 3x phone at 2.
   * Dropping from 3 to 1.5 quarters the pixels shaded.
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
 * The subset of R3F's `onCreated` argument this needs. `backend` is absent on a
 * `WebGLRenderer`. Optional and structurally typed, so `@webgpu/types` and
 * `three/webgpu` stay out of this package's dependency tree. `getContext` is
 * how a context that died before `onCreated` ran is noticed.
 */
interface CreatedState {
  gl: {
    domElement: HTMLCanvasElement;
    backend?: {
      isWebGPUBackend?: boolean;
      device?: unknown;
    };
    getContext?: () => { isContextLost?: () => boolean } | null;
  };
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
 * Called outside the canvas, because that is where its output goes. It touches
 * no R3F context and renders nothing. It does three jobs:
 *
 * - Applies the profile. Pixel ratio and shadows follow the state, live,
 *   without rebuilding the scene.
 * - Stops the render loop off screen. On `"idle"` the loop is set to `"never"`
 *   and the context, textures and geometry stay put, so coming back into view
 *   is instant.
 * - Notices when the graphics context dies. R3F has no handler for that
 *   (checked against 9.6.1). `onCreated` attaches a listener that calls
 *   `preventDefault()`, so a replacement context is possible, and reports the
 *   loss so the gate can hand back a new `generation`. The loss R3F causes when
 *   it unmounts a canvas is a teardown and isn't reported.
 *
 * It returns props because R3F re-runs its configure pass on every `<Canvas>`
 * render and resets the renderer from them, so imperative `setDpr`,
 * `setFrameloop` and `gl.shadowMap.enabled` calls are undone on the next
 * render.
 *
 * Three and R3F are optional peers reached through `@vectorvesper/motion/r3f`,
 * and this module imports no R3F value at all, only React.
 *
 * Quality never changes through `#define`. Recompiling a shader is a stall, and
 * it would land when the page is already struggling. If you need a cheaper
 * shader variant, compile both up front and switch which one draws.
 */
export function useRenderQuality(
  state: SceneState,
  profiles: RenderProfiles,
): RenderQualityProps {
  const profile = state === "active" ? profiles.full : profiles.reduced;
  const { shadows } = profile;

  /**
   * Off screen: keep everything, draw nothing.
   *
   * Only `"idle"` stops the loop. `dormant`, `warming` and `poster` mean the
   * canvas shouldn't exist yet, and stopping the loop for a canvas about to be
   * created would leave it blank on arrival.
   */
  const frameloop: "always" | "never" = state === "idle" ? "never" : "always";

  /**
   * The pixel ratio the canvas is already sized at, held across `idle`.
   *
   * Changing dpr resizes the drawing buffer, and resizing clears it, so reducing
   * it as the loop stops would turn the scene black. A scene that isn't drawing
   * costs no frame time at any resolution anyway. A scene that mounts already
   * idle has no previous size and starts at the reduced profile.
   *
   * The render-phase update is React's documented way to adjust state when an
   * input changes. An effect would repaint once at the wrong size first, and a
   * ref can't be read here without breaking the compiler rules.
   */
  const drawing = state !== "idle";
  const wanted = capToScreen(profile.dpr);
  const [sizedDpr, setSizedDpr] = useState(wanted);
  if (drawing && sizedDpr !== wanted) setSizedDpr(wanted);
  const dpr = drawing ? wanted : sizedDpr;

  /**
   * The live device watcher, so a rebuild doesn't leave the old one running.
   * three destroys the previous device on dispose and a destroyed device is
   * ignored, so this is a second guarantee.
   */
  const stopWatchRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWatchRef.current?.(), []);

  /**
   * The live canvas's loss listener, so a canvas the scene has finished with
   * can't report a loss for the one that replaced it. Removed when the owner
   * unmounts and when a rebuilt canvas takes over. The `isConnected` check in
   * the listener covers the moment between, when R3F's own teardown loss
   * arrives.
   */
  const stopListeningRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopListeningRef.current?.(), []);

  const onCreated = useCallback(({ gl }: CreatedState) => {
    const health = getRendererHealth();
    const canvas = gl.domElement;

    // The generation this canvas was built under. With it, a replacement lost
    // moments after it was built counts as a new failure. `<Canvas
    // key={generation}>` builds a new root on every bump, so this runs again
    // for each replacement.
    const builtAt = health.state.generation;

    // Whatever the previous canvas left running goes first.
    stopListeningRef.current?.();
    stopListeningRef.current = null;
    stopWatchRef.current?.();
    stopWatchRef.current = null;

    // A context can die before this runs: R3F creates it, builds the scene and
    // only then calls onCreated, and a second reset can land in between with
    // nothing listening. So the context is asked directly, and a dead one is
    // reported instead of announced as healthy.
    if (isContextLost(gl)) {
      if (canvas.isConnected) health.reportLost({ builtAt });
      return;
    }

    // Mounting at all means a working context. After a loss this is the
    // replacement announcing itself, which is what ends the recovery.
    health.reportHealthy();

    // Both paths, always. A WebGPU canvas never fires `webglcontextlost`, but a
    // `WebGPURenderer` that fell back to WebGL does, and that case is invisible
    // from outside. Recovery shouldn't depend on classifying the renderer.

    // Without preventDefault the browser won't attempt a restore, and some
    // drivers then refuse a new context on the page at all.
    //
    // R3F also loses the context of every `<Canvas>` it unmounts:
    // `unmountComponentAtNode` calls `forceContextLoss()` 500ms later (9.7),
    // firing this same event. Reporting it would rebuild every other scene
    // on the page. By then React has taken the canvas out of the document, so a
    // detached canvas is a teardown and is skipped.
    const onLost = (event: Event) => {
      if (!canvas.isConnected) return;
      event.preventDefault();
      health.reportLost({ builtAt });
    };
    canvas.addEventListener("webglcontextlost", onLost);
    stopListeningRef.current = () => canvas.removeEventListener("webglcontextlost", onLost);

    // WebGPU announces a dead device by resolving a promise instead, so the
    // listener above would never hear it.
    const device = gpuDeviceOf(gl);
    stopWatchRef.current = device ? watchGPUDevice(device) : null;
  }, []);

  return useMemo(
    () => ({ dpr, frameloop, shadows, onCreated }),
    [dpr, frameloop, shadows, onCreated],
  );
}

/**
 * A profile's pixel ratio, never above the screen's own.
 *
 * `full: { dpr: 2 }` is how every example writes it, and R3F applies a number
 * exactly as given, so a 1x monitor would draw four times the pixels it can
 * show. The number is a ceiling. During server rendering there is no screen to
 * read and the value passes through, because the canvas only exists on the
 * client.
 */
function capToScreen(dpr: number | undefined): number | undefined {
  if (dpr === undefined || typeof window === "undefined") return dpr;
  return Math.min(dpr, window.devicePixelRatio || 1);
}
