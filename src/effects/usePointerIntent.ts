"use client";

import { useEffect, useRef, useState, useMemo, type RefObject } from "react";
import {
  PointerIntent,
  type PointerIntentOptions,
} from "../core/pointer-intent/PointerIntent";
import { getConductor } from "../core/conductor";
import { createHybridRef } from "../react/hybrid-ref";


export interface UsePointerIntentOptions extends PointerIntentOptions {
  /** Called when the pointer's intent state changes. */
  onIntentChange?: (intent: boolean) => void;
}

export interface UsePointerIntentReturn<T extends HTMLElement> {
  /**
   * Ref to attach to the target element.
   *
   * Destructure this hook's result, as the example below does. Reaching it as
   * `pointer.ref` is a lint error under the React Compiler rules. See
   * hybrid-ref.ts.
   */
  ref: RefObject<T | null>;
  /**
   * True while the cursor is heading for the element at sufficient speed.
   * Useful for conditional pre-rendering or warming.
   */
  intent: boolean;
  /**
   * Ref holding the smoothed confidence, 0 to 1. Updated every frame without
   * re-rendering. Use it to drive a magnetic pull, CSS variables or canvas
   * distortion.
   */
  confidenceRef: RefObject<number>;
}

/**
 * Predicts whether the pointer will reach an element before it arrives, by
 * casting its velocity forward and measuring time-to-impact against the rect.
 *
 * Use it to hide the latency of expensive interactions, such as preloading 3D
 * models, compiling shaders or fetching data, 100-300ms before the hover.
 *
 * ```tsx
 * import { usePointerIntent } from "@vectorvesper/motion/react";
 *
 * export function InteractiveCard() {
 *   const { ref, intent, confidenceRef } = usePointerIntent<HTMLDivElement>({
 *     sensitivity: "high",
 *   });
 *
 *   // confidenceRef isn't state, so read it from a frame callback or an event
 *   // handler, never during render.
 *   return (
 *     <div ref={ref} className="card-container">
 *       {intent && <PreloadedWebGLContent />}
 *       <span className="debug-readout" />
 *     </div>
 *   );
 * }
 * ```
 *
 * @param {UsePointerIntentOptions} [options={}] Sensitivity and intent callback.
 * @returns {UsePointerIntentReturn<T>} The ref, intent state and confidence ref.
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
    // Mirror confidence into the ref on the render lane, after the core's
    // update-lane work, without React re-renders.
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
  // eslint-disable-next-line react-hooks/refs
  const ref = useMemo(() => createHybridRef<T>(elementRef, setElement), []);

  return { ref, intent, confidenceRef };
}

