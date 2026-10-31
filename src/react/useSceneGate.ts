"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createHybridRef } from "./hybrid-ref";
import { useAdaptiveQuality } from "./useAdaptiveQuality";
import { useHeadroom, type MountCost } from "./useSafeToMount";
import { markSceneDrawing } from "../core/scene-activity";
import { getConductor } from "../core/conductor";
import { getSensorBus } from "../core/sensor-bus/SensorBus";
import { getRendererHealth } from "../core/renderer-health/RendererHealth";
import { isWebGLRefused } from "../core/adaptive-quality/AdaptiveQuality";

/** Where a heavy scene is in its life. */
export type SceneState =
  /** Too far from the viewport to be worth existing. */
  | "dormant"
  /** Close enough to matter, waiting for the page to be able to afford it. */
  | "warming"
  /** Running, full quality. */
  | "active"
  /** Running, reduced quality: the device or frame rate can't take more. */
  | "constrained"
  /**
   * Started, currently off screen. Still alive, drawing nothing.
   *
   * Rebuilding a WebGL context and re-uploading its textures costs far more
   * than leaving it mounted and paused, so a started scene never returns to
   * `dormant`.
   */
  | "idle"
  /**
   * The graphics context was taken away and a replacement is being built. Still
   * `mounted`, because the rebuild happens by remounting the canvas under a new
   * `generation`.
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
  /**
   * What is behind the gate is content the visitor came for. Default false.
   *
   * It still waits to be near the viewport, for the scroll to settle and for
   * frame headroom, but it is never withheld. Reduced motion and a device below
   * the floor otherwise send the gate straight to `poster`, so a visitor who
   * asked for less motion would never see a chart.
   */
  content?: boolean;
}

/**
 * Why the gate is in its current state, in one machine-readable word. Branch on
 * this: `reason` is the same fact for humans and isn't stable to switch on.
 */
export type SceneCause =
  | "ok"
  | "not-near"
  | "waiting-for-headroom"
  | "off-screen"
  | "render-bound"
  | "frame-rate"
  | "device-floor"
  | "reduced-motion"
  | "context-lost";

export interface SceneGate<T extends HTMLElement> {
  /**
   * Attach to the element that holds the scene.
   *
   * Destructure this hook's result. `<div ref={gate.ref}>` is a lint error
   * under the React Compiler rules, and it takes the rest of the object with
   * it: `gate.generation` gets reported as a ref read during render too. See
   * hybrid-ref.ts, and `compiler-lint.test.ts` for the check.
   */
  ref: RefObject<T | null>;
  state: SceneState;
  /**
   * Should the scene exist? True for `active`, `constrained` and `idle`,
   * because a scene that is merely off screen should be paused and kept.
   */
  mounted: boolean;
  /** How much scene to build, or `null` when there is no scene. */
  quality: "full" | "reduced" | null;
  /**
   * Put this on the `<Canvas key>`. It changes when the graphics context is
   * lost, which makes React throw away the dead tree and build a working one.
   */
  generation: number;
  /** Machine-readable counterpart to `reason`. Branch on this one. */
  cause: SceneCause;
  /**
   * Why it is in this state, in a sentence. Written for a support thread and a
   * devtools row. Branch on `cause` instead; this text is free to change.
   */
  reason: string;
}

/**
 * Decide whether a heavy scene should exist, and how much of it.
 *
 * ```tsx
 * const { ref, mounted, quality } = useSceneGate<HTMLDivElement>({ label: "hero" });
 *
 * return (
 *   <div ref={ref}>
 *     {mounted ? (
 *       <Canvas dpr={quality === "full" ? 2 : 1}>
 *         <Hero detail={quality} />
 *       </Canvas>
 *     ) : (
 *       <img src="/hero-poster.jpg" alt="" />
 *     )}
 *   </div>
 * );
 * ```
 * Destructure it, as above: see `ref` on {@link SceneGate}.
 *
 * It answers three questions: is this scene close enough to matter, can the
 * page afford to start it, and once running, would reducing quality fix
 * anything going wrong. Reduced quality only helps when rendering is the slow
 * part, so the gate reads AdaptiveQuality's fused tier, which covers that.
 *
 * It decides and doesn't apply. Nothing here touches a renderer, a device pixel
 * ratio or a post-processing pass: you own what `"full"` and `"reduced"` look
 * like. The adapters in `/r3f` and `/three` apply them.
 *
 * It composes `useSafeToMount` and `useAdaptiveQuality`, and both still work on
 * their own.
 */
export function useSceneGate<T extends HTMLElement = HTMLDivElement>({
  label,
  cost = "heavy",
  preload = 200,
  content = false,
}: UseSceneGateOptions = {}): SceneGate<T> {
  // A hybrid ref: a component that renders a spinner, a Suspense fallback or a
  // `next/dynamic` placeholder first has no element on the first commit, and an
  // effect keyed only on [preload] would never look again, leaving the gate in
  // `dormant` for good. See hybrid-ref.ts.
  const elementRef = useRef<T | null>(null);
  const [element, setElement] = useState<T | null>(null);
  // The factory only wires deferred getters and setters onto a function and
  // never reads elementRef.current during render, but the compiler can't see
  // that through an opaque call.
  //
  // The directive must sit on the line above the code. A `-- reason` wrapping
  // onto a second comment line targets the comment and suppresses nothing.
  // eslint-disable-next-line react-hooks/refs
  const ref = useMemo(() => createHybridRef<T>(elementRef, setElement), []);

  const [near, setNear] = useState(false);
  const [settled, setSettled] = useState(false);

  // Once it has run, it has run. This keeps a scene alive when the reader
  // scrolls past it. State, because it changes what renders, and a ref written
  // during render survives a discarded render.
  const [started, setStarted] = useState(false);

  // One definition of "the page can afford this", shared with every other
  // caller of useSafeToMount. The give-up clock only runs while the scene is
  // near and still waiting, so a scene far down the page can't time out unseen
  // and then mount mid-scroll.
  const safe = useHeadroom(cost, near && !started);

  // Close enough to be worth existing.
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      { rootMargin: `${preload}px` },
    );
    io.observe(element);
    return () => io.disconnect();
  }, [element, preload]);

  // Mounting a scene mid-scroll feels like a stutter, whatever the numbers
  // say. Only the first mount waits for this.
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

  useEffect(() => {
    // A latch: this fires at most once per mount, so the rule's concern, an
    // effect that re-renders on every pass, doesn't apply.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (ready) setStarted(true);
  }, [ready]);
  const quality = useAdaptiveQuality();

  const [health, setHealth] = useState(() => getRendererHealth().state);
  useEffect(() => getRendererHealth().subscribe(setHealth), []);

  // Once quality drops, hold it down for a moment. The inputs can disagree
  // frame to frame, and a scene that rebuilds its detail level twice a second
  // is worse than one that stays a bit too plain for four.
  const [dwelling, setDwelling] = useState(false);

  const verdict = decide({
    near,
    ready,
    started,
    tier: quality.tier,
    reducedMotion: quality.reducedMotion,
    deviceTier: quality.deviceTier,
    qualityCause: quality.cause,
    contextLost: health.lost,
    content,
    // Read during render: it only changes together with an AdaptiveQuality
    // emit, which is what re-renders this hook.
    webglRefused: isWebGLRefused(),
  });

  let state = verdict.state;
  if (state === "active" && dwelling) state = "constrained";

  // The dwell is owned by the two effects below. A ref written during render
  // survives a discarded render, so an interrupted render could start or clear
  // the hold without committing, and Date.now() in render is impure.
  //
  // Raise on the way in. The verdict already reports "constrained" then, so
  // this can't flicker back to "active" for a frame first.
  useEffect(() => {
    // Keyed on verdict.state, so this runs only when the verdict changes band.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (verdict.state === "constrained") setDwelling(true);
    else if (verdict.state !== "active") setDwelling(false);
  }, [verdict.state]);

  // Fall on its own after the full window. The timer is keyed on the flag, so
  // recovering mid-dwell doesn't cancel it. Without a timer, a page that
  // recovers while nothing else changes would stay constrained until the next
  // re-render.
  useEffect(() => {
    if (!dwelling) return;
    const id = setTimeout(() => setDwelling(false), CONSTRAIN_DWELL_MS);
    return () => clearTimeout(id);
  }, [dwelling]);

  const reason = state === verdict.state ? verdict.reason : "recently reduced, holding steady";
  const cause: SceneCause = state === verdict.state ? verdict.cause : "frame-rate";
  const mounted =
    state === "active" || state === "constrained" || state === "idle" || state === "recovering";

  // Counted while drawing, so presentation-cap.ts can tell a cadence the
  // browser imposed from one our own scenes are causing.
  const drawing = state === "active" || state === "constrained";
  useEffect(() => (drawing ? markSceneDrawing() : undefined), [drawing]);

  return {
    ref,
    state,
    mounted,
    generation: health.generation,
    quality: mounted ? (state === "active" ? "full" : "reduced") : null,
    cause,
    reason: label ? `${label}: ${reason}` : reason,
  };
}

/** Scroll speed, px/s, below which the page counts as still. */
const SETTLED_SCROLL_SPEED = 40;
/** How long a reduced scene stays reduced after conditions improve. */
const CONSTRAIN_DWELL_MS = 4000;
interface Inputs {
  near: boolean;
  ready: boolean;
  /** Has this scene ever been allowed to run? */
  started: boolean;
  /** Has the graphics context been taken away? */
  contextLost: boolean;
  /**
   * The fused tier from AdaptiveQuality, which already accounts for what is
   * costing the frame.
   */
  tier: 0 | 1 | 2;
  deviceTier: 0 | 1 | 2;
  reducedMotion: boolean;
  /** Why the governor arrived at that tier, passed through for reporting. */
  qualityCause: "ok" | "device" | "reduced-motion" | "render" | "frame-rate" | "held";
  /** Content the visitor came for, which is never sent to the poster. */
  content?: boolean;
  /** The browser refused a WebGL context on this page. */
  webglRefused?: boolean;
}

/** The decision, with no React in it, so it can be tested directly. */
export function decide(i: Inputs): { state: SceneState; reason: string; cause: SceneCause } {
  // Both of these outrank position and timing: there is no point warming a
  // scene that will never be allowed to run. Content is the exception, because
  // a visitor who asked for less motion still came for it. It waits like
  // anything else, and once mounted reads as constrained.
  //
  // Nothing can be drawn at all here, so even content gets its still. A refusal
  // also sends the device tier to 2. This check keeps the reason accurate and
  // keeps content off a dead canvas.
  if (i.webglRefused) {
    return { state: "poster", reason: "the browser refused a WebGL context", cause: "device-floor" };
  }
  if (!i.content && i.reducedMotion) {
    return { state: "poster", reason: "reduced motion is turned on", cause: "reduced-motion" };
  }
  if (!i.content && i.deviceTier === 2) {
    return { state: "poster", reason: "this device cannot render it smoothly", cause: "device-floor" };
  }

  // A dead context outranks everything except never running at all. It only
  // matters for a scene that has started: a context lost elsewhere on the page
  // says nothing about one never built.
  if (i.started && i.contextLost) {
    return { state: "recovering", reason: "the graphics context was lost, rebuilding", cause: "context-lost" };
  }

  if (!i.started) {
    if (!i.near) return { state: "dormant", reason: "not near the viewport yet", cause: "not-near" };
    if (!i.ready) return { state: "warming", reason: "waiting for a free moment", cause: "waiting-for-headroom" };
  } else if (!i.near) {
    // Alive but off screen. The renderer adapter stops the render loop here.
    // Unmounting would throw away the WebGL context and every texture on it.
    return { state: "idle", reason: "scrolled off screen, paused", cause: "off-screen" };
  }

  // `tier` arrives already knowing whether reducing quality would help, and the
  // governor says why, so this can report it.
  //
  // Tier 2 counts too, or the worst tier would fall through to "active" and the
  // harder a page struggled the more the gate asked of it. The fused tier only
  // reaches 2 when reducing would help or can't be ruled out: a main thread
  // blocked elsewhere arrives as "held" at the device's own tier. The gate has
  // one reduced level. A scene that wants a deeper cut reads
  // `useAdaptiveQuality().tier`.
  if (i.tier >= 1) {
    // Only content reaches here under reduced motion or on a device below the
    // floor, since a scene went to its poster above. Say which, because the
    // frame rate may be fine.
    if (i.qualityCause === "reduced-motion") {
      return { state: "constrained", reason: "reduced motion is turned on", cause: "reduced-motion" };
    }
    if (i.deviceTier === 2) {
      return {
        state: "constrained",
        reason: "this device is below the floor for full quality",
        cause: "device-floor",
      };
    }
    return i.qualityCause === "render"
      ? { state: "constrained", reason: "rendering is the bottleneck", cause: "render-bound" }
      : { state: "constrained", reason: "the frame rate is not holding up", cause: "frame-rate" };
  }

  return { state: "active", reason: "running at full quality", cause: "ok" };
}
