"use client";

import { useEffect, useMemo } from "react";
import { getSensorBus, type SensorBus } from "../core/sensor-bus/SensorBus";

/**
 * Holds the `SensorBus` for the component's lifetime, managing listeners and
 * reference counting.
 *
 * This returns the bus, where `useAdaptiveQuality` and `useAnimationBudget`
 * return state, because sensor state changes every frame. A returned snapshot
 * would go stale at once, and state would re-render per frame. The bus is a
 * stable reference that never re-renders: read `.state` inside the frame loop.
 *
 * ```tsx
 * import { useEffect, useRef } from "react";
 * import { useSensorBus, getConductor } from "@vectorvesper/motion/react";
 *
 * export function InteractiveCard() {
 *   const elementRef = useRef<HTMLDivElement>(null);
 *   const bus = useSensorBus();
 *
 *   useEffect(() => {
 *     return getConductor().subscribe("render", () => {
 *       if (!elementRef.current) return;
 *
 *       const { x, y, speed } = bus.state.pointer;
 *       const scale = 1 + Math.min(0.1, speed / 1000);
 *
 *       elementRef.current.style.transform = `translate3d(${x * 0.05}px, ${y * 0.05}px, 0) scale(${scale})`;
 *     });
 *   }, [bus]);
 *
 *   return <div ref={elementRef} className="card">Move pointer here</div>;
 * }
 * ```
 *
 * @returns {SensorBus} The singleton SensorBus instance.
 */
export function useSensorBus(): SensorBus {
  const bus = useMemo(() => getSensorBus(), []);
  useEffect(() => bus.retain(), [bus]);
  return bus;
}

