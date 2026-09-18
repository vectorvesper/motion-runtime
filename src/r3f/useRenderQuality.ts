"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SceneState } from "../react/useSceneGate";
import { getRendererHealth } from "../core/renderer-health/RendererHealth";
import { watchGPUDevice } from "../core/renderer-health/watchGPUDevice";
import { gpuDeviceOf, isContextLost } from "../core/renderer-health/rendererChecks";

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
   * The highest device pixel ratio the canvas draws at. Never above the
   * screen's own, so `dpr: 2` draws a 1x monitor at 1x and a 3x phone at 2.
   * Capping this is the single biggest saving available on a high-density
   * display: dropping from 3 to 1.5 quarters the pixels shaded.
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
 * The subset of R3F's `onCreated` argument this needs.
 *
 * `backend` is three's WebGPU-era renderer field, absent on a `WebGLRenderer`.
 * Optional and structurally typed, so `@webgpu/types` and `three/webgpu` stay
 * out of this package's dependency tree. `getContext` is how a context that
 * died before `onCreated` ran is noticed at all.
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
 * `<Canvas key>`. The loss R3F causes itself when it unmounts a canvas is not
 * reported: that is a teardown, not a failure.
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
  const { shadows } = profile;

  /**
   * Off screen: keep everything, draw nothing.
   *
   * Only `"idle"` stops the loop. `dormant`, `warming` and `poster` mean the
   * canvas should not exist yet, which is the gate's `mounted` decision rather
   * than this one, and stopping the loop for a canvas that is about to be
   * created would leave it blank on arrival.
   */
  const frameloop: "always" | "never" = state === "idle" ? "never" : "always";

  /**
   * The pixel ratio the canvas is already sized at, held across `idle`.
   *
   * Up to 4.0.1 an idle scene took the `reduced` profile like every other
   * non-active state, so scrolling one off screen lowered its dpr at the same
   * moment the loop stopped. **Changing dpr resizes the drawing buffer, and
   * resizing clears it.** With nothing drawing afterwards the scene did not
   * freeze on its last frame, it went black and stayed black — which is the
   * opposite of what the comment above promises and of why `idle` keeps the
   * context at all.
   *
   * It also bought nothing. A scene that is not drawing costs no frame time at
   * any resolution; the memory is already allocated. The dpr axis belongs to
   * `constrained`, where the scene is still drawing and should draw cheaper.
   *
   * So the resolution stops moving once drawing stops, and picks up again from
   * whatever the scene resumes into. A scene that *mounts* already idle has no
   * previous size and starts at the reduced profile, which is correct: there is
   * no frame to preserve yet.
   *
   * The render-phase update is React's documented way to adjust state when an
   * input changes. An effect would repaint once at the wrong size first, and a
   * ref cannot be read here without breaking the compiler rules this package
   * has to hold to.
   */
  const drawing = state !== "idle";
  const wanted = capToScreen(profile.dpr);
  const [sizedDpr, setSizedDpr] = useState(wanted);
  if (drawing && sizedDpr !== wanted) setSizedDpr(wanted);
  const dpr = drawing ? wanted : sizedDpr;

  /**
   * The live device watcher, so a rebuild does not leave the old one running.
   *
   * Not strictly required for correctness: three destroys the previous device
   * when the renderer is disposed, and a destroyed device is ignored. Stopping
   * it anyway means the guarantee does not rest on that one branch.
   */
  const stopWatchRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopWatchRef.current?.(), []);

  /**
   * The live canvas's loss listener, so a canvas the scene has finished with
   * cannot report a loss on behalf of the one that replaced it.
   *
   * Removed when the owner unmounts and when a rebuilt canvas takes over. The
   * `isConnected` check inside the listener covers the moment between a canvas
   * leaving the page and either of those, which is exactly when R3F's own
   * teardown loss arrives.
   */
  const stopListeningRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopListeningRef.current?.(), []);

  const onCreated = useCallback(({ gl }: CreatedState) => {
    const health = getRendererHealth();
    const canvas = gl.domElement;

    // The generation this canvas was built under. With it, a replacement lost
    // moments after it was built counts as a new failure, not as the reset
    // that built it reaching one more canvas (vv-lab R10). `<Canvas
    // key={generation}>` builds a new root on every bump, so this runs again
    // for each replacement.
    const builtAt = health.state.generation;

    // Whatever the previous canvas left running goes first.
    stopListeningRef.current?.();
    stopListeningRef.current = null;
    stopWatchRef.current?.();
    stopWatchRef.current = null;

    // A context can die before this runs. R3F creates it, builds the scene and
    // only then calls onCreated, and on a slow device a second reset can land
    // in between. Its event then fired with nothing here listening: three
    // logged "Context Lost", the runtime never heard, and the scene stayed
    // black (vv-lab R11, on WebKit). So the context is asked directly, and a
    // dead one is reported rather than announced as healthy.
    if (isContextLost(gl)) {
      if (canvas.isConnected) health.reportLost({ builtAt });
      return;
    }

    // Mounting at all means a working context. After a loss this is the
    // replacement announcing itself, which is what ends the recovery.
    health.reportHealthy();

    // Both paths, always, rather than one or the other.
    //
    // A WebGPU canvas never fires `webglcontextlost`, so the listener is inert
    // there. But a `WebGPURenderer` that fell back to WebGL draws to a canvas
    // that *does* fire it, and that case is invisible from the outside. Wiring
    // both means recovery does not depend on classifying the renderer
    // correctly; the classification only decides whether to add the device
    // watch on top.

    // Without preventDefault the browser will not attempt a restore, and some
    // drivers then refuse a new context on the page at all.
    //
    // Not every loss is a failure, though. R3F loses the context of every
    // `<Canvas>` it unmounts on purpose: `unmountComponentAtNode` calls
    // `forceContextLoss()` 500ms later (9.7), and that fires this same event.
    // Up to 4.1.0 it was reported, so closing one canvas moved the generation
    // and rebuilt every other scene on the page. Measured in vv-lab: six tab
    // switches under a managed hero rebuilt it four times on Chrome, and on
    // WebKit the rebuilds outran R3F's event wiring and left the hero dead.
    //
    // By the time that loss arrives React has taken the canvas out of the
    // document, and a canvas the visitor can still see never has. So a
    // detached canvas is being torn down, not failing, and nothing wants its
    // context back.
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
 * exactly as given. On a 1x monitor that drew four times the pixels the screen
 * can show, so the managed scene came out heavier than the unmanaged one it
 * replaced, whose default `[1, 2]` resolves to 1 there. Measured in vv-lab: an
 * AI-written R3F hero that copied `dpr: 2` from our own pattern ran at
 * 8–12fps, where the same page with the ratio capped ran at about 20 (T1). So
 * the number is a ceiling, which is what the docs always called it.
 *
 * During server rendering there is no screen to read and the value passes
 * through as written. The canvas only ever exists on the client.
 */
function capToScreen(dpr: number | undefined): number | undefined {
  if (dpr === undefined || typeof window === "undefined") return dpr;
  return Math.min(dpr, window.devicePixelRatio || 1);
}
