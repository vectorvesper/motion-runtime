"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
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
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);
  const instanceRef = useRef<MagneticElement | null>(null);
  const [initial] = useState(options);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
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
  }, [initial]);

  // `anticipate` is forwarded too. It used to be readable only at construction,
  // so changing it after mount silently did nothing.
  const { strength, reach, speed, scale, anticipate } = options;
  useEffect(() => {
    instanceRef.current?.update({ strength, reach, speed, scale, anticipate });
  }, [strength, reach, speed, scale, anticipate]);

  return { ref, active };
}
