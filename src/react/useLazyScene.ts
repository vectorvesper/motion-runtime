"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { getAnimationBudget } from "../core/animation-budget/AnimationBudget";
import { getSensorBus } from "../core/sensor-bus/SensorBus";
import { getConductor } from "../core/conductor";

export interface UseLazySceneOptions {
  /**
   * IntersectionObserver rootMargin (in CSS margin syntax) used to expand or contract
   * the viewport intersection bounds. Enables pre-mounting elements before they scroll into view.
   * @default "200px"
   */
  rootMargin?: string;
  /**
   * If true, delays mounting until the browser reaches an idle period (using `requestIdleCallback`).
   * Ensures the main thread is not blocked during heavy scroll actions.
   * @default true
   */
  requireIdle?: boolean;
  /**
   * If true, delays mounting if the global `AnimationBudget` performance tier is low (Tier 2/dropping frames).
   * It will wait for the budget to recover, up to a maximum timeout of 3 seconds (fail-open safeguard).
   * @default false
   */
  deferWhileLow?: boolean;
}

/**
 * A React hook that defers mounting heavy content (such as Three.js canvases, WebGL shaders, or autoplaying videos)
 * until the element is close to the viewport, the browser has reached an idle frame slot, and the animation budget is healthy.
 *
 * Once loaded, the component remains mounted to prevent unmounting/remounting overhead on subsequent scroll actions.
 *
 * ### 📚 Usage Example:
 * ```tsx
 * import { useLazyScene } from "@vectorvesper/motion/react";
 * import { HeavyWebGLCanvas } from "./HeavyWebGLCanvas";
 * 
 * export function LazySceneWrapper() {
 *   const { ref, ready } = useLazyScene<HTMLDivElement>({
 *     rootMargin: "300px", // Mount when element is within 300px of viewport
 *     requireIdle: true,   // Wait for main thread idle slot
 *     deferWhileLow: true  // Defer if frame rate is currently dropping
 *   });
 * 
 *   return (
 *     <div ref={ref} className="canvas-placeholder">
 *       {ready ? <HeavyWebGLCanvas /> : <div className="spinner">Loading...</div>}
 *     </div>
 *   );
 * }
 * ```
 *
 * @param {UseLazySceneOptions} [options={}] Configuration options for layout, idle, and performance budget gates.
 * @returns {{ ref: RefObject<T | null>; ready: boolean }} A ref to attach to the placeholder element, and a boolean `ready` indicating if the heavy scene should mount.
 */
export function useLazyScene<T extends HTMLElement = HTMLDivElement>(
  options: UseLazySceneOptions = {},
): { ref: RefObject<T | null>; ready: boolean } {
  const ref = useRef<T>(null);
  const [ready, setReady] = useState(false);
  const [initial] = useState(options);

  useEffect(() => {
    if (ready) return;
    const el = ref.current;
    if (!el) return;

    let cancelled = false;
    let idleHandle: number | null = null;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let offBudget: (() => void) | null = null;

    // Retain the SensorBus singleton so scroll velocity calculations are active
    const releaseBus = getSensorBus().retain();

    const stopWaiting = () => {
      if (idleHandle !== null && "cancelIdleCallback" in window) {
        window.cancelIdleCallback(idleHandle);
        idleHandle = null;
      }
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (offBudget !== null) {
        offBudget();
        offBudget = null;
      }
    };

    const proceed = () => {
      if (!cancelled) {
        setReady(true);
        io.disconnect(); // Stop observing once we are mounted
      }
    };

    const gateOnBudget = () => {
      // Clear scheduling handles since the callback has fired
      idleHandle = null;
      timeoutId = null;

      const attemptMount = () => {
        // 1. Thread-safety: If the user is scrolling actively, defer mounting
        const { scroll } = getSensorBus().state;
        const scrollSpeed = Math.hypot(scroll.vx, scroll.vy);
        if (scrollSpeed > 40) {
          // Still scrolling! Defer mounting to subsequent frame ticks
          if (!offBudget) {
            offBudget = getConductor().subscribe("update", attemptMount, {
              priority: "essential",
              label: "useLazyScene(gate)",
            });
          }
          return;
        }

        // Scroll stopped, unsubscribe frame ticks
        if (offBudget) {
          offBudget();
          offBudget = null;
        }

        // 2. Budget-safety: Check performance budget if enabled
        if (!initial.deferWhileLow) return proceed();
        const budget = getAnimationBudget();
        if (budget.state.tier < 2) return proceed();
        
        offBudget = budget.subscribe((s) => {
          if (s.tier < 2) {
            offBudget?.();
            offBudget = null;
            proceed();
          }
        });
        timeoutId = setTimeout(() => {
          offBudget?.();
          offBudget = null;
          proceed();
        }, 3000);
      };

      attemptMount();
    };

    const startWaiting = () => {
      stopWaiting(); // Clean up any existing active timers
      if (initial.requireIdle !== false && "requestIdleCallback" in window) {
        idleHandle = window.requestIdleCallback(gateOnBudget, { timeout: 1500 });
      } else {
        timeoutId = setTimeout(gateOnBudget, 0);
      }
    };

    const io = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.some((e) => e.isIntersecting);
        if (intersecting) {
          startWaiting();
        } else {
          stopWaiting();
        }
      },
      { rootMargin: initial.rootMargin ?? "200px" },
    );
    io.observe(el);

    return () => {
      cancelled = true;
      io.disconnect();
      stopWaiting();
      releaseBus();
    };
  }, [ready, initial]);

  return { ref, ready };
}
