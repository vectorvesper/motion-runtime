"use client";

import { useEffect, useMemo } from "react";
import { getSensorBus, type SensorBus } from "../core/sensor-bus/SensorBus";

/**
 * A React hook that retains the unified `SensorBus` instance for the lifetime
 * of the component, automatically managing event-listener attachments and reference counting.
 *
 * ### Why this one returns the bus and its siblings return state
 *
 * `useAdaptiveQuality`, `useAnimationBudget` and `useFramePressure` all hand
 * back a state object directly, and the extra `.state` hop here looks like an
 * oversight. It is load-bearing.
 *
 * Those three change rarely: a tier flips, pressure emits at about 2Hz, and
 * re-rendering on that is cheap. Sensor state changes EVERY FRAME. Returning it
 * from a hook would mean either a snapshot that is stale the moment you hold
 * it, or a re-render per frame, which is the layout thrashing this whole
 * runtime exists to prevent.
 *
 * So the bus is the return value and `.state` is read fresh inside the frame
 * loop. This was queued for "consistency" in the 3.0 cleanup and reverted once
 * the contract below was read. Please do not flatten it.
 *
 * ### ⚡ Performance Optimization Contract
 * `useSensorBus` deliberately returns a **stable reference** to the bus object and **does not trigger React state re-renders**
 * when mouse moves, scroll offsets change, or window resizes. This is to avoid severe rendering bottlenecks (60 FPS layout thrashing).
 * Read and apply values inside the global `FrameConductor` frame loop instead.
 *
 * ### 📚 Usage Example:
 * ```tsx
 * import { useEffect, useRef } from "react";
 * import { useSensorBus, getConductor } from "@vectorvesper/motion";
 *
 * export function InteractiveCard() {
 *   const elementRef = useRef<HTMLDivElement>(null);
 *   const bus = useSensorBus();
 *
 *   useEffect(() => {
 *     // Subscribe to the render lane of the central loop
 *     return getConductor().subscribe("render", () => {
 *       if (!elementRef.current) return;
 *       
 *       // Read fresh sensor data per-frame without re-rendering the component
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
 * @returns {SensorBus} The singleton SensorBus instance, with automatic lifecycle hook attachments.
 */
export function useSensorBus(): SensorBus {
  const bus = useMemo(() => getSensorBus(), []);
  useEffect(() => bus.retain(), [bus]);
  return bus;
}

