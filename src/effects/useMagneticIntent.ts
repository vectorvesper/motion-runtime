"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createHybridRef } from "../react/hybrid-ref";
import {
  MagneticElement,
  type MagneticOptions,
} from "../core/magnetic/MagneticElement";

/**
 * Magnetic attraction with anticipation: PointerIntent confidence drives the
 * pull while the cursor approaches, and proximity takes over up close.
 *
 *   const { ref } = useMagneticIntent<HTMLButtonElement>();
 *   <button ref={ref}>Get started</button>
 *
 * Owns the element's inline `transform` while mounted and restores it on
 * unmount. Inactive on touch devices and under reduced motion.
 */
export function useMagneticIntent<T extends HTMLElement = HTMLElement>(
  options: MagneticOptions = {},
): { ref: RefObject<T | null>; active: boolean } {
  // A hybrid ref, so the magnet attaches when its element arrives. A button
  // behind a hydration guard, a loading branch or `next/dynamic` has no element
  // on the first commit. See hybrid-ref.ts.
  const elementRef = useRef<T | null>(null);
  const [element, setElement] = useState<T | null>(null);
  // The factory only wires deferred getters/setters onto a function; it never
  // reads elementRef.current during render. The compiler cannot see that
  // through an opaque call, so it assumes the worst.
  // eslint-disable-next-line react-hooks/refs
  const ref = useMemo(() => createHybridRef<T>(elementRef, setElement), []);
  const [active, setActive] = useState(false);
  const instanceRef = useRef<MagneticElement | null>(null);
  const [initial] = useState(options);

  useEffect(() => {
    // `element` says the node has arrived and is what re-runs this; the node
    // itself comes from the ref, because the compiler treats state as immutable.
    const el = elementRef.current;
    if (!element || !el) return;
    // Bail only when there's no fine pointer at all. `(any-pointer: fine)` keeps
    // the effect alive on a touchscreen laptop that also has a mouse or
    // trackpad.
    if (!window.matchMedia("(any-pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const instance = new MagneticElement(el, initial);
    instanceRef.current = instance;
    const raf = requestAnimationFrame(() => setActive(true));
    return () => {
      cancelAnimationFrame(raf);
      instance.destroy();
      instanceRef.current = null;
      setActive(false);
    };
  }, [element, initial]);

  // `anticipate` is forwarded too, so changing it after mount takes effect.
  const { strength, reach, speed, scale, anticipate } = options;
  useEffect(() => {
    instanceRef.current?.update({ strength, reach, speed, scale, anticipate });
  }, [strength, reach, speed, scale, anticipate]);

  return { ref, active };
}
