"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { getAnimationBudget } from "../core/animation-budget/AnimationBudget";
import { getSensorBus } from "../core/sensor-bus/SensorBus";
import { getConductor } from "../core/conductor";
import type { MountCost } from "./useSafeToMount";

export interface UseLazySceneOptions {
  /**
   * How far before the element reaches the viewport to start, in pixels.
   * Default 200.
   */
  preload?: number;
  /**
   * How expensive the scene is. Default `"normal"`. It decides how much the
   * hook waits for besides visibility:
   *
   * - `"light"` — mount as soon as it is near the viewport
   * - `"normal"` — also wait for a free slot on the main thread
   * - `"heavy"` — also wait for frames to recover if the page is struggling,
   *   up to three seconds
   */
  cost?: MountCost;
}

/**
 * Hold a heavy scene back until the page can afford it.
 *
 * ```tsx
 * const { ref, ready } = useLazyScene<HTMLDivElement>({ cost: "heavy" });
 *
 * return <div ref={ref}>{ready ? <Scene /> : <Poster />}</div>;
 * ```
 *
 * It waits for the element to come near the viewport, then for whatever else
 * the `cost` asks for. Once it is ready it stays ready — tearing a scene down
 * and rebuilding it on the way back up costs far more than leaving it running.
 *
 * It also holds off while the visitor is actively scrolling, whatever the cost,
 * because mounting mid-scroll is what a reader feels as a stutter.
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
        if (initial.cost !== "heavy") return proceed();
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
      const wantsIdle = (initial.cost ?? "normal") !== "light";
      if (wantsIdle && "requestIdleCallback" in window) {
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
      { rootMargin: `${initial.preload ?? 200}px` },
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
