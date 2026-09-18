"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createHybridRef } from "../react/hybrid-ref";
import {
  MagneticElement,
  type MagneticOptions,
} from "../core/magnetic/MagneticElement";

/**
 * Magnetic attraction with anticipation — the element starts reaching
 * while the cursor is still approaching (PointerIntent confidence drives
 * pre-touch pull; proximity takes over up close).
 *
 *   const { ref } = useMagneticIntent<HTMLButtonElement>();
 *   <button ref={ref}>Get started</button>
 *
 * Owns the element's inline `transform` while mounted (restored exactly on
 * unmount). Inactive on touch devices and under reduced motion — this one
 * IS motion, so it fails open to a perfectly normal element.
 */
export function useMagneticIntent<T extends HTMLElement = HTMLElement>(
  options: MagneticOptions = {},
): { ref: RefObject<T | null>; active: boolean } {
  // A hybrid ref, so the magnet attaches when its element arrives rather than
  // only on the first commit. A button behind a hydration guard, a loading
  // branch or `next/dynamic` has no element there yet; up to 4.1.0 the effect
  // bailed, nothing re-ran it, and the magnet never attached. See hybrid-ref.ts.
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
    // Bail only when there's NO fine pointer at all (pure touch). Using
    // `(any-pointer: fine)` — not `(pointer: coarse)` — keeps the effect alive
    // on a touchscreen laptop that also has a mouse/trackpad.
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

  // `anticipate` is forwarded too. It used to be readable only at construction,
  // so changing it after mount silently did nothing.
  const { strength, reach, speed, scale, anticipate } = options;
  useEffect(() => {
    instanceRef.current?.update({ strength, reach, speed, scale, anticipate });
  }, [strength, reach, speed, scale, anticipate]);

  return { ref, active };
}
