"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createHybridRef } from "../react/hybrid-ref";

/**
 * useImageTrail — images spawn along the pointer's path and fade away:
 * the classic award-site gallery flourish. What the free tutorials leak,
 * this pools: a fixed set of <img> nodes created once and recycled, each
 * flight animated with the Web Animations API — no rAF loop, no GC churn,
 * nothing allocated per move.
 *
 *   const { ref } = useImageTrail({ images: ["/a.jpg", "/b.jpg", …] });
 *   <section ref={ref} className="relative h-[70vh]">…</section>
 *
 * Fails open (does nothing) on touch devices and under reduced motion.
 *
 * A *creative* hook, not a foundation one: it is deliberately self-contained
 * and does NOT join the shared conductor or SensorBus. Each flight is handed to
 * the Web Animations API, which runs on the compositor — cheaper than a
 * per-frame conductor subscription would be for this effect. It needs nothing
 * else in the package to work.
 */

export interface UseImageTrailOptions {
  /** Image sources, cycled in order. */
  images: string[];
  /** Rendered width of each trail image, px. Default 160. */
  size?: number;
  /** Pointer distance between spawns, px. Default 90. */
  spacing?: number;
  /** How long each image stays on screen, in ms. Default 900. */
  duration?: number;
  /** Pool size = max simultaneously visible images. Default 10. */
  maxActive?: number;
}

export function useImageTrail<T extends HTMLElement = HTMLDivElement>(
  options: UseImageTrailOptions,
): { ref: RefObject<T | null> } {
  // A hybrid ref, so the trail starts when its element arrives rather than only
  // on the first commit. A section behind a hydration guard, a loading branch
  // or `next/dynamic` has no element there yet; up to 4.1.0 the effect bailed,
  // nothing re-ran it, and no image ever followed the pointer. See hybrid-ref.ts.
  const elementRef = useRef<T | null>(null);
  const [element, setElement] = useState<T | null>(null);
  // The factory only wires deferred getters/setters onto a function; it never
  // reads elementRef.current during render. The compiler cannot see that
  // through an opaque call, so it assumes the worst.
  // eslint-disable-next-line react-hooks/refs
  const ref = useMemo(() => createHybridRef<T>(elementRef, setElement), []);
  const [initial] = useState(options); // mount-time options

  useEffect(() => {
    // `element` says the node has arrived and is what re-runs this; the node
    // itself comes from the ref, because the compiler treats state as immutable
    // and this writes the container's style.
    const container = elementRef.current;
    if (!element || !container || initial.images.length === 0) return;
    if (!window.matchMedia("(any-pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const size = initial.size ?? 160;
    const spacing = initial.spacing ?? 90;
    const duration = initial.duration ?? 900;
    const poolSize = initial.maxActive ?? 10;

    // The container must position its children.
    const prevPosition = container.style.position;
    if (getComputedStyle(container).position === "static") {
      container.style.position = "relative";
    }
    const prevOverflow = container.style.overflow;
    container.style.overflow = "hidden";

    // Build the pool once.
    const pool: HTMLImageElement[] = [];
    for (let i = 0; i < poolSize; i++) {
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.setAttribute("aria-hidden", "true");
      img.style.cssText =
        `position:absolute;width:${size}px;height:auto;left:0;top:0;` +
        "opacity:0;pointer-events:none;will-change:transform,opacity;";
      container.appendChild(img);
      pool.push(img);
    }

    let poolIndex = 0;
    let imageIndex = 0;
    let lastX = 0;
    let lastY = 0;
    let primed = false;

    const spawn = (x: number, y: number) => {
      const img = pool[poolIndex];
      poolIndex = (poolIndex + 1) % poolSize;
      img.getAnimations().forEach((a) => a.cancel()); // steal from the oldest flight
      img.src = initial.images[imageIndex];
      imageIndex = (imageIndex + 1) % initial.images.length;

      const drift = (Math.random() - 0.5) * 24;
      const tilt = (Math.random() - 0.5) * 14;
      img.animate(
        [
          {
            opacity: 0,
            transform: `translate(${x - size / 2}px, ${y - size / 2}px) scale(0.55) rotate(${tilt}deg)`,
          },
          {
            opacity: 1,
            transform: `translate(${x - size / 2 + drift * 0.3}px, ${y - size / 2 - 8}px) scale(1) rotate(${tilt * 0.4}deg)`,
            offset: 0.25,
          },
          {
            opacity: 0,
            transform: `translate(${x - size / 2 + drift}px, ${y - size / 2 + 36}px) scale(0.9) rotate(0deg)`,
          },
        ],
        { duration: duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
      );
    };

    const onMove = (e: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (!primed) {
        primed = true;
        lastX = x;
        lastY = y;
        return;
      }
      const dx = x - lastX;
      const dy = y - lastY;
      if (dx * dx + dy * dy >= spacing * spacing) {
        lastX = x;
        lastY = y;
        spawn(x, y);
      }
    };

    container.addEventListener("pointermove", onMove);
    return () => {
      container.removeEventListener("pointermove", onMove);
      for (const img of pool) {
        img.getAnimations().forEach((a) => a.cancel());
        img.remove();
      }
      container.style.position = prevPosition;
      container.style.overflow = prevOverflow;
    };
  }, [element, initial]);

  return { ref };
}
