"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useSceneGate, type SceneCause, type SceneState } from "../react/useSceneGate";
import type { MountCost } from "../react/useSafeToMount";
import { getConductor } from "../core/conductor";
import { getRendererHealth } from "../core/renderer-health/RendererHealth";
import { watchGPUDevice } from "../core/renderer-health/watchGPUDevice";
import { gpuDeviceOf, isContextLost } from "../core/renderer-health/rendererChecks";

/**
 * The part of a three.js renderer this drives.
 *
 * `WebGLRenderer` and `WebGPURenderer` both fit. Structural on purpose: three
 * is an optional peer this package never imports, and your renderer's own type
 * flows through to `setup` untouched.
 */
export interface ThreeRendererLike {
  domElement: HTMLCanvasElement;
  setPixelRatio(value: number): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  render(scene: unknown, camera: unknown): unknown;
  dispose(): void;
}

/**
 * A three.js `Scene`, or any `Object3D`. What is drawn every frame, and what is
 * walked and freed when the scene goes.
 */
export interface ThreeSceneLike {
  traverse(callback: (object: unknown) => void): void;
}

/** What `setup` is given. */
export interface ThreeSceneContext<R extends ThreeRendererLike = ThreeRendererLike> {
  /** The renderer `renderer()` made, already in the page and sized. */
  renderer: R;
  /** The width of the element the scene fills, in CSS pixels. */
  width: number;
  /** Its height, in CSS pixels. */
  height: number;
  /**
   * The quality the scene starts at. It can change while the scene runs:
   * `frame.quality` in `update` is the live value.
   */
  quality: "full" | "reduced";
}

/**
 * What `update` and `render` are given each frame.
 *
 * The same object every frame, so nothing is allocated per frame. Copy
 * anything you want to keep.
 */
export interface ThreeSceneFrame {
  /** Seconds since the previous frame. */
  dt: number;
  /**
   * Seconds this scene has spent drawing. It stands still while the scene is
   * off screen, and carries on across a rebuild after a lost context.
   */
  time: number;
  /**
   * `"full"` or `"reduced"`, live. Key anything cheap to change off it, such as
   * how many particles draw. Rebuilding geometry every time it changes is not
   * cheap.
   */
  quality: "full" | "reduced";
  /**
   * The pixel ratio the canvas draws at, live. Pass it to anything measured in
   * device pixels, such as the size of point sprites.
   */
  pixelRatio: number;
  /** The element's width, in CSS pixels. */
  width: number;
  /** The element's height, in CSS pixels. */
  height: number;
}

/** What `setup` hands back. */
export interface ThreeSceneHandle {
  /** Drawn with `camera` every frame. Everything in it is freed when the scene goes. */
  scene: ThreeSceneLike;
  /** What the scene is drawn from. A `PerspectiveCamera`'s aspect follows the element's size. */
  camera: object;
  /** Called before each draw. Animate here. */
  update?(frame: ThreeSceneFrame): void;
  /**
   * Draws the frame instead of `renderer.render(scene, camera)`. For an
   * `EffectComposer`, or anything else drawn in more than one pass.
   */
  render?(frame: ThreeSceneFrame): void;
  /**
   * Called with the element's size before the first frame, and whenever the
   * drawing buffer changes: the element resizing, or the pixel ratio moving
   * with quality. Resize anything sized in device pixels here, such as a
   * composer's render targets.
   */
  resize?(width: number, height: number): void;
  /**
   * Called when the scene goes. Free what is not reachable from `scene`: render
   * targets, composers, controls, anything holding an event listener.
   */
  dispose?(): void;
}

export interface UseThreeSceneOptions<R extends ThreeRendererLike = ThreeRendererLike> {
  /**
   * Make the renderer, a new one each time:
   * `() => new THREE.WebGLRenderer({ antialias: true })`.
   *
   * Called whenever the scene is built: when it first comes near the viewport,
   * and again after the browser takes the graphics context away. It may return
   * a promise, so three can be loaded on demand.
   */
  renderer: () => R | Promise<R>;
  /**
   * Build the scene: camera, meshes, materials, lights. Called right after
   * `renderer`, every time the scene is built, and may return a promise.
   * Return what to draw.
   *
   * Make every three.js object in here, not outside it. A scene rebuilt after a
   * lost graphics context starts again from this function.
   */
  setup: (context: ThreeSceneContext<R>) => ThreeSceneHandle | Promise<ThreeSceneHandle>;
  /** Shown in devtools and in warnings. */
  label?: string;
  /** How expensive the scene is to start. Default `"heavy"`; see `useSceneGate`. */
  cost?: MountCost;
  /** How far before the viewport to start building, in px. Default 200. */
  preload?: number;
  /**
   * The highest pixel ratio each quality may draw at. Never above the screen's
   * own, so a 1x monitor is never drawn at 2x. Default `{ full: 2, reduced: 1 }`.
   */
  maxDpr?: { full?: number; reduced?: number };
}

/** What `useThreeScene` returns. Destructure it; see `SceneGate.ref` for why. */
export interface ThreeScene {
  /**
   * Put this on the element the scene fills, and give that element a size: a
   * height, or `position: absolute; inset: 0`. The canvas is added inside it.
   */
  ref: RefObject<HTMLDivElement | null>;
  /** Where the scene is in its life. See `useSceneGate`. */
  state: SceneState;
  /**
   * Whether the scene exists. While false, show a still image or a background
   * in the element instead: before the scene first comes near the viewport,
   * under reduced motion, and on a device that cannot draw it smoothly.
   */
  mounted: boolean;
  /** How much scene is drawing, or `null` when there is none. */
  quality: "full" | "reduced" | null;
  /** Why the scene is in its current state, in one word. Branch on this. */
  cause: SceneCause;
  /** The same, in a sentence, for a devtools row or a support thread. */
  reason: string;
}

/**
 * A plain three.js scene, made production-safe in one call.
 *
 * ```tsx
 * "use client";
 * import * as THREE from "three";
 * import { useThreeScene } from "@vectorvesper/motion/three";
 *
 * export default function Hero() {
 *   const { ref, mounted } = useThreeScene({
 *     label: "hero",
 *     renderer: () => new THREE.WebGLRenderer({ antialias: true }),
 *     setup({ width, height }) {
 *       const scene = new THREE.Scene();
 *       const camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 100);
 *       camera.position.z = 5;
 *       const knot = new THREE.Mesh(
 *         new THREE.TorusKnotGeometry(1, 0.3, 200, 32),
 *         new THREE.MeshNormalMaterial(),
 *       );
 *       scene.add(knot);
 *       return { scene, camera, update: ({ dt }) => { knot.rotation.y += dt * 0.5; } };
 *     },
 *   });
 *
 *   return (
 *     <div ref={ref} style={{ position: "relative", height: "100vh" }}>
 *       {!mounted && <img src="/hero.jpg" alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
 *     </div>
 *   );
 * }
 * ```
 *
 * You write the scene. Everything else a hand-written hero has to get right,
 * and that the vv-lab stranger tests watched capable models skip, is done
 * here:
 *
 * - **Starts late.** Nothing is built until the element is near the viewport
 *   and the page can afford it, and never mid-scroll (`useSceneGate`).
 * - **Draws on the shared frame loop**, never a `requestAnimationFrame` of its
 *   own, and not at all while the element is off screen. The context and every
 *   buffer stay put, so coming back is instant.
 * - **Sizes itself to the screen.** The pixel ratio never exceeds the screen's
 *   own and drops when the frame rate cannot hold. It changes on the renderer
 *   it already has: nothing is rebuilt for a quality change.
 * - **Follows the element's size**, and a `PerspectiveCamera`'s aspect with it.
 * - **Survives a lost graphics context.** It listens from the moment the
 *   renderer exists, reports the loss, builds a fresh renderer and scene, and
 *   says when the new one has drawn.
 * - **Cleans up completely.** Every geometry, material and texture in the
 *   scene, the renderer, and the context itself, which the browser caps per
 *   page and takes back oldest first.
 * - **Respects reduced motion** and devices below the floor. The scene is
 *   never built there, and `mounted` stays false so your still image shows.
 *
 * ## Why the renderer is yours to make
 *
 * This package imports nothing from three. Your `renderer()` decides which
 * renderer and which options, and its type flows through to `setup`, so a
 * `WebGPURenderer` works the same way: a lost WebGPU device is recovered
 * exactly as a lost WebGL context is.
 *
 * ## What it does not do
 *
 * It does not decide what "reduced" looks like beyond the pixel ratio. Read
 * `frame.quality` in `update` for anything else. It does not load models or
 * textures for you either; load them inside `setup`, so a rebuild loads them
 * onto the new context.
 */
export function useThreeScene<R extends ThreeRendererLike>(options: UseThreeSceneOptions<R>): ThreeScene {
  const { label, cost, preload } = options;
  const { ref, state, mounted, quality, generation, cause, reason } = useSceneGate<HTMLDivElement>({
    label,
    cost,
    preload,
  });

  // The latest options, read when a scene is built. Callbacks written inline
  // are new functions on every render, and rebuilding the scene for that would
  // be exactly the churn this exists to prevent.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  // Read by the frame callback, which is registered once per build.
  const liveRef = useRef<Live>({ state, quality });
  useEffect(() => {
    liveRef.current = { state, quality };
  }, [state, quality]);

  // The scene's clock, kept across rebuilds so an animation carries on from
  // where it was rather than jumping back to its first frame.
  const elapsedRef = useRef(0);

  // One build per graphics context. `generation` moves when the context is
  // lost, and a new context needs a new renderer and a new scene.
  useEffect(() => {
    if (!mounted) return;
    const host = ref.current;
    if (!host) return;
    return build(host, optionsRef, liveRef, elapsedRef);
  }, [mounted, generation, ref]);

  return { ref, state, mounted, quality, cause, reason };
}

interface Live {
  state: SceneState;
  quality: "full" | "reduced" | null;
}

interface Size {
  width: number;
  height: number;
}

/** Run `next` with a value now, or once it resolves if it is a promise. */
function whenReady<T>(value: T | PromiseLike<T>, next: (value: T) => void, fail: (error: unknown) => void): void {
  if (typeof (value as { then?: unknown } | null)?.then === "function") {
    (value as PromiseLike<T>).then(next, fail);
  } else {
    next(value as T);
  }
}

/** The pixel ratio a quality draws at: its cap, never above the screen's own. */
function pixelRatioFor(quality: "full" | "reduced", maxDpr: UseThreeSceneOptions["maxDpr"]): number {
  const cap = quality === "full" ? (maxDpr?.full ?? 2) : (maxDpr?.reduced ?? 1);
  return Math.min(window.devicePixelRatio || 1, cap);
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(message);
}

/**
 * One scene on one graphics context, from renderer to teardown. Returns the
 * teardown.
 *
 * All of it happens again from the start after a lost context: a new renderer,
 * a new scene, nothing carried over from the dead one but the clock.
 */
function build<R extends ThreeRendererLike>(
  host: HTMLElement,
  optionsRef: { current: UseThreeSceneOptions<R> },
  liveRef: { current: Live },
  elapsedRef: { current: number },
): () => void {
  const name = optionsRef.current.label ?? "three scene";
  const health = getRendererHealth();
  // The generation this build belongs to, so losing its context moments after
  // the loss that caused the build still counts as a new failure (vv-lab R10).
  const builtAt = health.state.generation;

  let stopped = false;
  // Undone last-first, so the loss listener comes off before the context is
  // released, and the loop stops before anything it draws is freed.
  const undo: Array<() => void> = [];
  const teardown = () => {
    stopped = true;
    while (undo.length) {
      try {
        undo.pop()!();
      } catch (error) {
        console.error(`vv-motion: useThreeScene (${name}) failed while cleaning up.`, error);
      }
    }
  };
  const fail = (error: unknown) => {
    if (stopped) return;
    console.error(`vv-motion: useThreeScene (${name}) could not build its scene.`, error);
  };

  const start = (renderer: R) => {
    if (stopped) {
      renderer.dispose();
      return;
    }
    const canvas = renderer.domElement;
    canvas.style.display = "block";
    host.appendChild(canvas);
    undo.push(() => {
      renderer.dispose();
      // Hands the context back now rather than whenever the collector reaches
      // the canvas. The browser caps live contexts per page and evicts the
      // oldest first, which on a landing page is the hero (vv-lab T5).
      (renderer as { forceContextLoss?: () => void }).forceContextLoss?.();
      canvas.remove();
    });

    const size: Size = { width: host.clientWidth, height: host.clientHeight };
    const quality = liveRef.current.quality === "full" ? "full" : "reduced";
    renderer.setPixelRatio(pixelRatioFor(quality, optionsRef.current.maxDpr));
    renderer.setSize(size.width, size.height);

    // Listening from the moment the context exists, so no loss can land before
    // anything hears it. preventDefault keeps the browser willing to hand a
    // context over again.
    const onLost = (event: Event) => {
      if (!canvas.isConnected) return;
      event.preventDefault();
      health.reportLost({ builtAt });
    };
    canvas.addEventListener("webglcontextlost", onLost);
    undo.push(() => canvas.removeEventListener("webglcontextlost", onLost));
    // Dead on arrival, which a context made while the GPU process restarts can be.
    if (isContextLost(renderer)) {
      health.reportLost({ builtAt });
      return;
    }

    // A WebGPU renderer has to finish connecting to its device before it draws.
    const init = (renderer as { init?: () => PromiseLike<unknown> }).init;
    whenReady(
      typeof init === "function" ? init.call(renderer) : undefined,
      () => {
        if (stopped) return;
        // A lost WebGPU device resolves a promise instead of firing an event.
        const device = gpuDeviceOf(renderer);
        if (device) undo.push(watchGPUDevice(device));

        let made: ThreeSceneHandle | Promise<ThreeSceneHandle>;
        try {
          made = optionsRef.current.setup({ renderer, width: size.width, height: size.height, quality });
        } catch (error) {
          fail(error);
          return;
        }
        whenReady(made, (handle) => run(renderer, handle, size), fail);
      },
      fail,
    );
  };

  const run = (renderer: R, handle: ThreeSceneHandle, size: Size) => {
    if (stopped) {
      free(handle);
      return;
    }
    undo.push(() => free(handle));

    // Measured here, never in the frame: reading layout in the render lane
    // forces a synchronous reflow every frame. Applied at the next draw rather
    // than here, because resizing clears the canvas, and a scene that is off
    // screen would sit cleared until it drew again.
    let resized = true;
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        size.width = host.clientWidth;
        size.height = host.clientHeight;
        resized = true;
      });
      observer.observe(host);
      undo.push(() => observer.disconnect());
    }

    const frame: ThreeSceneFrame = {
      dt: 0,
      time: elapsedRef.current,
      quality: "reduced",
      pixelRatio: 0,
      width: size.width,
      height: size.height,
    };
    let announced = false;

    undo.push(
      getConductor().subscribe(
        "render",
        (dt) => {
          const live = liveRef.current;
          // Off screen: keep the context and every buffer, draw nothing.
          if (live.state === "idle") return;
          // Dead: the loss is reported and a rebuild is on its way.
          if (isContextLost(renderer)) return;

          const quality = live.quality === "full" ? "full" : "reduced";
          const pixelRatio = pixelRatioFor(quality, optionsRef.current.maxDpr);
          // A quality change resizes the renderer it already has. Rebuilding
          // for it would mean a new context every time (vv-lab T4).
          if (resized || pixelRatio !== frame.pixelRatio) {
            renderer.setPixelRatio(pixelRatio);
            renderer.setSize(size.width, size.height);
            fitCamera(handle.camera, size);
            // Either change resizes the drawing buffer, and that is what
            // anything sized in device pixels follows: a composer's targets.
            handle.resize?.(size.width, size.height);
            if (resized) {
              resized = false;
              if (!size.width || !size.height) {
                warnOnce(
                  `size:${name}`,
                  `vv-motion: useThreeScene (${name}) is in an element with no size, so it has nothing to ` +
                    "draw into. Give the element a height, or position: absolute with inset: 0.",
                );
              }
            }
          }

          elapsedRef.current += dt;
          frame.dt = dt;
          frame.time = elapsedRef.current;
          frame.quality = quality;
          frame.pixelRatio = pixelRatio;
          frame.width = size.width;
          frame.height = size.height;
          handle.update?.(frame);
          if (handle.render) handle.render(frame);
          else renderer.render(handle.scene, handle.camera);

          // The first frame this context draws is the proof it works, and
          // saying so is what ends the recovery.
          if (!announced) {
            announced = true;
            health.reportHealthy();
          }
        },
        { label: name },
      ),
    );
  };

  try {
    whenReady(optionsRef.current.renderer(), start, fail);
  } catch (error) {
    fail(error);
  }
  return teardown;
}

/** A `PerspectiveCamera` follows the element's shape. Any other camera is left alone. */
function fitCamera(camera: object, size: Size): void {
  const c = camera as { isPerspectiveCamera?: boolean; aspect?: number; updateProjectionMatrix?: () => void };
  if (!c.isPerspectiveCamera || !size.width || !size.height) return;
  c.aspect = size.width / size.height;
  c.updateProjectionMatrix?.();
}

/** What `dispose` frees, then everything in the scene graph. */
function free(handle: ThreeSceneHandle): void {
  try {
    handle.dispose?.();
  } finally {
    disposeScene(handle.scene);
  }
}

/**
 * Free what a scene holds on the GPU: every geometry, every material and the
 * textures it uses, and the background and environment maps.
 *
 * three frees none of it on its own. Without this, a scene rebuilt after a
 * lost context would leave the whole previous one behind, and so would every
 * visit to a page that mounts one.
 */
function disposeScene(root: ThreeSceneLike): void {
  const freed = new Set<unknown>();
  const release = (thing: unknown) => {
    if (!thing || typeof thing !== "object" || freed.has(thing)) return;
    freed.add(thing);
    const dispose = (thing as { dispose?: unknown }).dispose;
    if (typeof dispose === "function") dispose.call(thing);
  };
  const isTexture = (value: unknown) => (value as { isTexture?: boolean } | null)?.isTexture === true;
  const releaseMaterial = (material: unknown) => {
    if (!material || typeof material !== "object") return;
    for (const value of Object.values(material)) if (isTexture(value)) release(value);
    const uniforms = (material as { uniforms?: Record<string, { value?: unknown } | undefined> }).uniforms;
    if (uniforms) {
      for (const uniform of Object.values(uniforms)) if (isTexture(uniform?.value)) release(uniform?.value);
    }
    release(material);
  };

  root.traverse((object) => {
    const o = object as { geometry?: unknown; material?: unknown };
    release(o.geometry);
    if (Array.isArray(o.material)) o.material.forEach(releaseMaterial);
    else releaseMaterial(o.material);
  });
  const s = root as { background?: unknown; environment?: unknown };
  if (isTexture(s.background)) release(s.background);
  if (isTexture(s.environment)) release(s.environment);
}
