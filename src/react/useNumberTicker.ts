"use client";

import { useEffect, useRef, type RefObject } from "react";
import { getConductor } from "../core/conductor";

export interface UseNumberTickerOptions {
  /** 
   * Damping responsiveness. Higher values mean a faster, snappier arrival.
   * Default is 6 (a smooth, dignified deceleration). 
   */
  k?: number;
  /** 
   * Intl.NumberFormat options to style currencies, percentages, decimals, etc.
   */
  format?: Intl.NumberFormatOptions;
  /**
   * Locale string for number formatting (e.g., "en-US", "de-DE"). 
   * Defaults to the user's browser locale.
   */
  locale?: string;
  /** 
   * Prefix string to prepend directly to the formatted number output (e.g., "+", "> ").
   */
  prefix?: string;
  /** 
   * Suffix string to append directly to the formatted number output (e.g., "%", " ms", " units").
   */
  suffix?: string;
}

/**
 * A high-performance numbers ticker hook that animates count values smoothly toward a target target value.
 * Bypasses React state updates entirely, writing frame updates directly to the DOM node's `textContent`
 * to achieve 120 FPS performance with zero component re-renders.
 *
 * Automatically respects the `prefers-reduced-motion` media query, snaps instantly to the target,
 * and enforces tabular layout to prevent horizontal digit wobbling.
 *
 * ### 📚 Usage Example:
 * ```tsx
 * import { useNumberTicker } from "@vectorvesper/motion/react";
 * 
 * export function ScoreDisplay() {
 *   const { ref } = useNumberTicker(8500, {
 *     prefix: "+",
 *     suffix: " pts",
 *     format: { style: "decimal" }
 *   });
 *   
 *   return <span ref={ref} className="font-bold text-lg" />;
 * }
 * ```
 *
 * @param {number} value The target number value to count towards.
 * @param {UseNumberTickerOptions} [options={}] Formatting configuration, damping speeds, prefixes, and suffixes.
 * @returns {{ ref: RefObject<T | null> }} A React ref to bind to the displaying DOM element.
 */
export function useNumberTicker<T extends HTMLElement = HTMLSpanElement>(
  value: number,
  options: UseNumberTickerOptions = {},
): { ref: RefObject<T | null> } {
  const ref = useRef<T>(null);
  const currentRef = useRef(0);
  const targetRef = useRef(value);
  const kRef = useRef(options.k ?? 6);
  
  // Cache formatter options and strings to avoid recreation inside the tick loop
  const formatterRef = useRef<Intl.NumberFormat | null>(null);
  const prefixRef = useRef(options.prefix ?? "");
  const suffixRef = useRef(options.suffix ?? "");

  useEffect(() => {
    kRef.current = options.k ?? 6;
    prefixRef.current = options.prefix ?? "";
    suffixRef.current = options.suffix ?? "";
    formatterRef.current = new Intl.NumberFormat(options.locale, options.format);
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Enforce monospaced numbers (tabular) so characters do not shift widths on change
    el.style.fontVariantNumeric = "tabular-nums";
    targetRef.current = value;

    const write = (v: number) => {
      const formatted = (formatterRef.current ?? new Intl.NumberFormat()).format(
        Math.round(v * 100) / 100, // Round to nearest 2 decimal places to allow fractional counts
      );
      el.textContent = `${prefixRef.current}${formatted}${suffixRef.current}`;
    };

    // Reduced motion fallback: snap instantly
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      currentRef.current = value;
      write(value);
      return;
    }

    // Subscribe to unified central conductor update loop rather than spawning independent RAF loops
    const unsubscribe = getConductor().subscribe("update", (dt) => {
      const target = targetRef.current;
      const current = currentRef.current;

      // Exponential damping
      let next = current + (target - current) * (1 - Math.exp(-kRef.current * dt));

      // Snapping threshold: if close enough, snap to target and stop ticking
      if (Math.abs(target - next) < 0.01) {
        next = target;
      }

      currentRef.current = next;
      write(next);
      // Decorative: a counter that updates less often under load still reads
      // correctly, because the damping is frame-rate independent. It just
      // arrives at the value a little later.
    }, { priority: "decorative", label: "useNumberTicker" });

    return () => {
      unsubscribe();
    };
  }, [value]);

  return { ref };
}
