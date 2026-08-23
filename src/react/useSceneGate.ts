"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { useAdaptiveQuality } from "./useAdaptiveQuality";
import { useFramePressure } from "./useFramePressure";
import { useSafeToMount, type MountCost } from "./useSafeToMount";
import { getConductor } from "../core/conductor";
import { getSensorBus } from "../core/sensor-bus/SensorBus";
import { getRendererHealth } from "../core/renderer-health/RendererHealth";

/** Where a heavy scene is in its life. */
export type SceneState =
  /** Too far from the viewport to be worth existing. */
  | "dormant"
  /** Close enough to matter, waiting for the page to be able to afford it. */
  | "warming"
  /** Running, full quality. */
  | "active"
  /** Running, reduced quality — the device or the frame rate cannot take more. */
  | "constrained"
  /**
   * Started, currently off screen. Still alive, drawing nothing.
   *
   * Scrolling past a scene must not destroy it. Rebuilding a WebGL context and
   * re-uploading its textures costs far more than leaving it mounted and
   * paused, so once a scene has started it never returns to `dormant`.
   */
  | "idle"
  /**
   * The graphics context was taken away and a replacement is being built.
   *
   * Still `mounted` — the rebuild happens by remounting the canvas under a new
   * `generation`, so hiding it here would prevent the very thing that fixes it.
   */
  | "recovering"
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
  /**
   * Should the scene exist? True for `active`, `constrained` and `idle` —
   * `idle` included, because a scene that is merely off screen should be
   * paused, not torn down.
   */
  mounted: boolean;
  /** How much scene to build. Only meaningful while `mounted`. */
  quality: "full" | "reduced";
  /**
   * Put this on the `<Canvas key>`. It changes when the graphics context is
   * lost, which is what makes React throw away the dead tree and build a
   * working one — the rebuild React is already good at.
   */
  generation: number;
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
 * It composes `useSafeToMount`, `useAdaptiveQuality` and `useFramePressure`
 * rather than reimplementing any of them, and all three still work on their
 * own. It replaced `useLazyScene` outright: that hook carried a second,
 * differently-behaved answer to "is the page healthy enough to mount", which
 * is the one shape this codebase cannot afford to keep duplicating.
 */
export function useSceneGate<T extends HTMLElement = HTMLDivElement>({
  label,
  cost = "heavy",
  preload = 200,
}: UseSceneGateOptions = {}): SceneGate<T> {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  const [settled, setSettled] = useState(false);

  // One definition of "the page can afford this", shared with every other
  // caller of useSafeToMount.
  const safe = useSafeToMount({ cost });

  // Close enough to be worth existing.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      { rootMargin: `${preload}px` },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [preload]);

  // Mounting a scene while the reader is mid-scroll is what they feel as a
  // stutter, whatever the frame numbers say. Only the first mount waits for
  // this — once the scene exists, scrolling past it is free.
  useEffect(() => {
    if (settled) return;
    const release = getSensorBus().retain();
    const off = getConductor().subscribe(
      "update",
      () => {
        const { scroll } = getSensorBus().state;
        if (Math.hypot(scroll.vx, scroll.vy) < SETTLED_SCROLL_SPEED) setSettled(true);
      },
      { priority: "essential", label: "useSceneGate(settle)" },
    );
    return () => {
      off();
      release();
    };
  }, [settled]);

  const ready = near && safe && settled;

  // Once it has run, it has run. This is what keeps a scene alive when the
  // reader scrolls past it. State rather than a ref, because it changes what
  // renders — a ref written during render survives a discarded render, which
  // is a real defect class in this codebase and one eslint already catches.
  const [started, setStarted] = useState(false);
  useEffect(() => {
    if (ready) setStarted(true);
  }, [ready]);
  const quality = useAdaptiveQuality();
  const pressure = useFramePressure();

  const [health, setHealth] = useState(() => getRendererHealth().state);
  useEffect(() => getRendererHealth().subscribe(setHealth), []);

  // Once quality drops, hold it down for a moment. Every input here already
  // has its own smoothing, but they can still disagree frame to frame, and a
  // scene that rebuilds its detail level twice a second is worse than one that
  // is simply a bit too plain for four.
  const constrainedSince = useRef(0);
  const [, force] = useState(0);

  const verdict = decide({
    near,
    ready,
    started,
    tier: quality.tier,
    reducedMotion: quality.reducedMotion,
    deviceTier: quality.deviceTier,
    pressure: pressure.source,
    confidence: pressure.confidence,
    contextLost: health.lost,
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
    mounted:
      state === "active" ||
      state === "constrained" ||
      state === "idle" ||
      state === "recovering",
    generation: health.generation,
    quality: state === "active" ? "full" : "reduced",
    reason: label ? `${label}: ${reason}` : reason,
  };
}

/** Scroll speed, px/s, below which the page counts as still. */
const SETTLED_SCROLL_SPEED = 40;
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
  /** Has this scene ever been allowed to run? */
  started: boolean;
  /** Has the graphics context been taken away? */
  contextLost: boolean;
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

  // A dead context outranks everything except never running at all. It is also
  // only meaningful for a scene that has actually started — a context lost
  // elsewhere on the page says nothing about one that was never built.
  if (i.started && i.contextLost) {
    return { state: "recovering", reason: "the graphics context was lost, rebuilding" };
  }

  if (!i.started) {
    if (!i.near) return { state: "dormant", reason: "not near the viewport yet" };
    if (!i.ready) return { state: "warming", reason: "waiting for a free moment" };
  } else if (!i.near) {
    // Alive but off screen. The renderer adapter stops the render loop here;
    // unmounting instead would throw away the WebGL context and every texture
    // on it, to save nothing.
    return { state: "idle", reason: "scrolled off screen, paused" };
  }

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
