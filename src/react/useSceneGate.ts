"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useLazyScene } from "./useLazyScene";
import { useAdaptiveQuality } from "./useAdaptiveQuality";
import { useFramePressure } from "./useFramePressure";
import type { MountCost } from "./useSafeToMount";

/**
 * Where a heavy scene is in its life.
 *
 * There is deliberately no `"recovering"` state yet. Nothing can enter it
 * until WebGL context-loss handling exists, and a state nobody can reach is a
 * branch a reader has to write dead code for.
 */
export type SceneState =
  /** Too far from the viewport to be worth existing. */
  | "dormant"
  /** Close enough to matter, waiting for the page to be able to afford it. */
  | "warming"
  /** Running, full quality. */
  | "active"
  /** Running, reduced quality — the device or the frame rate cannot take more. */
  | "constrained"
  /** Not running at all. Show a still image instead. */
  | "poster";

export interface UseSceneGateOptions {
  /** Shown in devtools. No effect on behaviour. */
  label?: string;
  /** How expensive the scene is. Default `"heavy"`. */
  cost?: MountCost;
  /** How far before the viewport to start warming, in px. Default 200. */
  preload?: number;
}

export interface SceneGate<T extends HTMLElement> {
  /** Attach to the element that holds the scene. */
  ref: RefObject<T | null>;
  state: SceneState;
  /** Should the scene be rendered at all? True for `active` and `constrained`. */
  mounted: boolean;
  /** How much scene to build. Only meaningful while `mounted`. */
  quality: "full" | "reduced";
  /**
   * Why it is in this state, in a sentence. Written for a support thread and
   * a devtools row, not for a machine — do not branch on it.
   */
  reason: string;
}

/**
 * Decide whether a heavy scene should exist, and how much of it.
 *
 * ```tsx
 * const scene = useSceneGate<HTMLDivElement>({ label: "hero" });
 *
 * return (
 *   <div ref={scene.ref}>
 *     {scene.mounted ? (
 *       <Canvas dpr={scene.quality === "full" ? 2 : 1}>
 *         <Hero detail={scene.quality} />
 *       </Canvas>
 *     ) : (
 *       <img src="/hero-poster.jpg" alt="" />
 *     )}
 *   </div>
 * );
 * ```
 *
 * It answers three questions the page cannot answer for itself: is this scene
 * close enough to matter, can the page afford to start it, and once running,
 * is anything going wrong that reducing quality would actually fix.
 *
 * That last word matters. **Reduced quality is only a fix for rendering being
 * slow.** If a third-party script is blocking the main thread, halving the
 * particle count makes the page uglier and just as slow — so this gate reads
 * the pressure classifier and only responds to `"render"`. Nothing else
 * degrades the scene.
 *
 * ## What it does not do
 *
 * It decides; it does not apply. Nothing here touches a renderer, a device
 * pixel ratio or a post-processing pass — you own what `"full"` and
 * `"reduced"` look like. The renderer adapter that applies these decisions to
 * a real three.js scene is a separate piece.
 *
 * It is also an addition, not a replacement. `useSafeToMount`,
 * `useLazyScene`, `useAdaptiveQuality` and `useFramePressure` all still work
 * on their own, and this composes them rather than hiding them.
 */
export function useSceneGate<T extends HTMLElement = HTMLDivElement>({
  label,
  cost = "heavy",
  preload = 200,
}: UseSceneGateOptions = {}): SceneGate<T> {
  const { ref, near, ready } = useLazyScene<T>({ preload, cost });
  const quality = useAdaptiveQuality();
  const pressure = useFramePressure();

  // Once quality drops, hold it down for a moment. Every input here already
  // has its own smoothing, but they can still disagree frame to frame, and a
  // scene that rebuilds its detail level twice a second is worse than one that
  // is simply a bit too plain for four.
  const constrainedSince = useRef(0);
  const [, force] = useState(0);

  const verdict = decide({
    near,
    ready,
    tier: quality.tier,
    reducedMotion: quality.reducedMotion,
    deviceTier: quality.deviceTier,
    pressure: pressure.source,
    confidence: pressure.confidence,
  });

  let state = verdict.state;
  if (state === "constrained") {
    constrainedSince.current = constrainedSince.current || Date.now();
  } else if (state === "active" && constrainedSince.current) {
    const held = Date.now() - constrainedSince.current;
    if (held < CONSTRAIN_DWELL_MS) state = "constrained";
    else constrainedSince.current = 0;
  } else {
    constrainedSince.current = 0;
  }

  // The dwell has to end on its own, or a page that recovers while nothing
  // else changes would stay constrained until the next unrelated re-render.
  useEffect(() => {
    if (state !== "constrained" || verdict.state !== "active") return;
    const wait = CONSTRAIN_DWELL_MS - (Date.now() - constrainedSince.current);
    const id = setTimeout(() => force((n) => n + 1), Math.max(16, wait));
    return () => clearTimeout(id);
  }, [state, verdict.state]);

  const reason = state === verdict.state ? verdict.reason : "recently reduced, holding steady";

  return {
    ref,
    state,
    mounted: state === "active" || state === "constrained",
    quality: state === "active" ? "full" : "reduced",
    reason: label ? `${label}: ${reason}` : reason,
  };
}

/** How long a reduced scene stays reduced after conditions improve. */
const CONSTRAIN_DWELL_MS = 4000;
/**
 * Confidence below which a render verdict is ignored.
 *
 * Measured in a real browser, a realistic heavy scene reads about 0.52 — so
 * this has to sit below that, and well above the 0.3 the classifier assigns to
 * a bare long-task hint. Reading `source` without checking `confidence` would
 * degrade scenes on a guess.
 */
const RENDER_CONFIDENCE_FLOOR = 0.4;

interface Inputs {
  near: boolean;
  ready: boolean;
  tier: 0 | 1 | 2;
  deviceTier: 0 | 1 | 2;
  reducedMotion: boolean;
  pressure: string;
  confidence: number;
}

/** The decision, with no React in it, so it can be tested directly. */
export function decide(i: Inputs): { state: SceneState; reason: string } {
  // Both of these outrank position and timing: there is no point warming a
  // scene that is never going to be allowed to run.
  if (i.reducedMotion) {
    return { state: "poster", reason: "reduced motion is turned on" };
  }
  if (i.deviceTier === 2) {
    return { state: "poster", reason: "this device cannot render it smoothly" };
  }

  if (!i.near) return { state: "dormant", reason: "not near the viewport yet" };
  if (!i.ready) return { state: "warming", reason: "waiting for a free moment" };

  if (i.tier === 1) {
    return { state: "constrained", reason: "the frame rate is not holding up" };
  }
  // Only rendering pressure is worth reducing quality for. Main-thread
  // pressure is somebody else's script, and a smaller scene does not unblock
  // a blocked thread.
  if (i.pressure === "render" && i.confidence >= RENDER_CONFIDENCE_FLOOR) {
    return { state: "constrained", reason: "rendering is the bottleneck" };
  }

  return { state: "active", reason: "running at full quality" };
}
