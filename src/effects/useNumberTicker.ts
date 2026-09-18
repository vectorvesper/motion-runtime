"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { getConductor } from "../core/conductor";
import { createHybridRef } from "../react/hybrid-ref";

export interface UseNumberTickerOptions {
  /**
   * How quickly the number reaches its target. Higher arrives sooner.
   * Default 6, which reads as a smooth deceleration.
   *
   * Not a duration: the value chases its target rather than running a fixed
   * timeline, which is what lets it retarget mid-flight without restarting.
   */
  speed?: number;
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
  // A hybrid ref, not a plain one, so the ticker starts when its element
  // arrives rather than only on the first commit. A counter behind a hydration
  // guard, a loading branch or `next/dynamic` has no element there yet; up to
  // 4.1.0 the effect bailed, nothing re-ran it, and the number stayed blank.
  // See hybrid-ref.ts.
  const elementRef = useRef<T | null>(null);
  const [element, setElement] = useState<T | null>(null);
  // The factory only wires deferred getters/setters onto a function; it never
  // reads elementRef.current during render. The compiler cannot see that
  // through an opaque call, so it assumes the worst.
  // eslint-disable-next-line react-hooks/refs
  const ref = useMemo(() => createHybridRef<T>(elementRef, setElement), []);

  const currentRef = useRef(0);
  /** True once the number has reached its target and nothing is ticking. */
  const landedRef = useRef(false);
  const targetRef = useRef(value);
  const speedRef = useRef(options.speed ?? 6);
  
  // Cache formatter options and strings to avoid recreation inside the tick loop
  const formatterRef = useRef<Intl.NumberFormat | null>(null);
  const prefixRef = useRef(options.prefix ?? "");
  const suffixRef = useRef(options.suffix ?? "");

  useEffect(() => {
    speedRef.current = options.speed ?? 6;
    prefixRef.current = options.prefix ?? "";
    suffixRef.current = options.suffix ?? "";
    formatterRef.current = new Intl.NumberFormat(options.locale, options.format);

    // A landed counter is no longer ticking, so nothing else would show a new
    // prefix, suffix or format until the value changed. Write it once here,
    // and only if the text is actually different.
    const el = elementRef.current;
    if (el && landedRef.current) {
      writeText(el, textFor(currentRef.current, formatterRef.current, prefixRef.current, suffixRef.current));
    }
  });

  useEffect(() => {
    // `element` says the node has arrived, and is what re-runs this. The node
    // itself comes from the ref: the compiler treats state as immutable, and
    // writing its style or its text is a mutation.
    const el = elementRef.current;
    if (!element || !el) return;

    // Enforce monospaced numbers (tabular) so characters do not shift widths on change
    el.style.fontVariantNumeric = "tabular-nums";
    targetRef.current = value;

    const write = (v: number) =>
      writeText(el, textFor(v, formatterRef.current, prefixRef.current, suffixRef.current));

    // Reduced motion fallback: snap instantly
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      currentRef.current = value;
      write(value);
      landedRef.current = true;
      return;
    }

    // Subscribe to unified central conductor update loop rather than spawning independent RAF loops
    landedRef.current = false;
    let stop: (() => void) | null = null;
    stop = getConductor().subscribe("update", (dt) => {
      const target = targetRef.current;
      const current = currentRef.current;

      // Exponential damping
      let next = current + (target - current) * (1 - Math.exp(-speedRef.current * dt));

      // Snapping threshold: if close enough, snap to target
      if (Math.abs(target - next) < 0.01) {
        next = target;
      }

      currentRef.current = next;
      write(next);

      // Landed, so stop ticking. Up to 4.1.0 the subscription stayed and every
      // frame assigned the same text again for the life of the page: vv-lab
      // measured 105 text writes a second on a page of three counters with
      // nothing moving. A new value re-runs this effect and starts a fresh
      // approach from wherever the number is now.
      if (next === target) {
        landedRef.current = true;
        stop?.();
        stop = null;
      }
      // Decorative: a counter that updates less often under load still reads
      // correctly, because the damping is frame-rate independent. It just
      // arrives at the value a little later.
    }, { priority: "decorative", label: "useNumberTicker" });

    return () => stop?.();
  }, [element, value]);

  return { ref };
}

/** One value as the caller wants it shown, rounded to two places so fractional counts read cleanly. */
function textFor(v: number, formatter: Intl.NumberFormat | null, prefix: string, suffix: string): string {
  return `${prefix}${(formatter ?? new Intl.NumberFormat()).format(Math.round(v * 100) / 100)}${suffix}`;
}

/**
 * Touch the DOM only when the text changes. Near the end of an approach several
 * frames round to the same string, and assigning `textContent` replaces the
 * text node whether or not the string moved.
 */
function writeText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}
