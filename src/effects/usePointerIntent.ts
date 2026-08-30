"use client";

import { useEffect, useRef, useState, useMemo, type RefObject } from "react";
import {
  PointerIntent,
  type PointerIntentOptions,
} from "../core/pointer-intent/PointerIntent";
import { getConductor } from "../core/conductor";
import { createHybridRef } from "../react/hybrid-ref";


export interface UsePointerIntentOptions extends PointerIntentOptions {
  /**
   * Callback fired when the pointer's intent state changes.
   */
  onIntentChange?: (intent: boolean) => void;
}

export interface UsePointerIntentReturn<T extends HTMLElement> {
  /**
   * Ref to attach to the target DOM element.
   *
   * **Destructure this hook's result**, as the example below does. Reaching it
   * as `pointer.ref` is a lint error under the React Compiler rules, and it
   * poisons the sibling fields with it. See hybrid-ref.ts.
   */
  ref: RefObject<T | null>;
  /**
   * Boolean state that flips to true when the cursor trajectory is headed towards the element
   * at a sufficient speed, and false when it drifts away or slows down. Useful for triggering 
   * React conditional pre-rendering or warming.
   */
  intent: boolean;
  /**
   * Ref containing the smoothed time-to-impact confidence value (0 to 1). 
   * Updated frame-accurately in the background WITHOUT triggering component re-renders. 
   * Perfect for driving GPU-accelerated styling (e.g. magnetic pull, CSS variables, canvas distortion).
   */
  confidenceRef: RefObject<number>;
}

/**
 * A React hook that predicts whether the pointer is going to hover over an element *before* it arrives,
 * by casting the pointer's velocity vector forward and calculating time-to-impact against the element's bounding rect.
 *
 * Use this hook to hide the latency of expensive interactions (e.g., preloading 3D models, pre-compiling shaders,
 * fetching API data, warming up magnetic fields) 100ms - 300ms before the user actually hovers.
 *
 * ### 📚 Usage Example:
 * ```tsx
 * import { usePointerIntent } from "@vectorvesper/motion/react";
 * 
 * export function InteractiveCard() {
 *   const { ref, intent, confidenceRef } = usePointerIntent<HTMLDivElement>({
 *     horizon: 0.4,     // Cast velocity vector 400ms forward
 *     extend: 15,       // Inflate the target rect by 15px
 *     minSpeed: 100,    // Only predict if speed is > 100px/s
 *   });
 * 
 *   // confidenceRef is deliberately not state, so it must not be read during
 *   // render. Read it from a frame callback or an event handler instead.
 *   return (
 *     <div ref={ref} className="card-container">
 *       {intent && <PreloadedWebGLContent />}
 *       <span className="debug-readout" />
 *     </div>
 *   );
 * }
 * ```
 *
 * @param {UsePointerIntentOptions} [options={}] Configuration options specifying predictive horizons, thresholds, and callbacks.
 * @returns {UsePointerIntentReturn<T>} Object containing the hybrid ref, the reactive intent state, and the non-reactive confidence ref.
 */
export function usePointerIntent<T extends HTMLElement = HTMLElement>(
  options: UsePointerIntentOptions = {},
): UsePointerIntentReturn<T> {
  const [element, setElement] = useState<T | null>(null);
  const elementRef = useRef<T | null>(null);
  const confidenceRef = useRef(0);
  const [intent, setIntent] = useState(false);
  const instanceRef = useRef<PointerIntent | null>(null);

  const onChangeRef = useRef(options.onIntentChange);
  useEffect(() => {
    onChangeRef.current = options.onIntentChange;
  });

  const [initial] = useState(options);

  useEffect(() => {
    if (!element) return;
    const instance = new PointerIntent(element, initial, (next) => {
      setIntent(next);
      onChangeRef.current?.(next);
    });
    instanceRef.current = instance;
    // Mirror confidence into the ref on the render lane — frame-accurate,
    // after the core's update-lane work, without React re-renders.
    const offFrame = getConductor().subscribe("render", () => {
      confidenceRef.current = instance.confidence;
    }, { priority: "decorative", label: "usePointerIntent(mirror)" });
    return () => {
      offFrame();
      instance.destroy();
      instanceRef.current = null;
      setIntent(false);
    };
  }, [element, initial]);

  const { sensitivity, dynamic } = options;
  useEffect(() => {
    instanceRef.current?.update({ sensitivity, dynamic });
  }, [sensitivity, dynamic]);

  // The factory only wires deferred getters/setters onto a function; it never
  // reads elementRef.current during render. The compiler cannot see that
  // through an opaque call, so it assumes the worst.
  //
  // The directive has to sit on the line immediately above the code. Written as
  // `-- reason` with the reason wrapping onto a second comment line, it targets
  // the comment instead and silently suppresses nothing.
  // eslint-disable-next-line react-hooks/refs
  const ref = useMemo(() => createHybridRef<T>(elementRef, setElement), []);

  return { ref, intent, confidenceRef };
}

