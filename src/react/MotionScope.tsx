"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { getConductor } from "../entry.core";
import type { ConductorLane, FrameFn, SubscribeOptions } from "../entry.core";

/**
 * The scope name any `useMotionFrame` beneath this provider joins. `null` at
 * the root, which means "belongs to no region" — background work whenever some
 * other scope holds the lease.
 */
const ScopeContext = createContext<string | null>(null);

export interface MotionScopeProps {
  /** Region name. Any string; it only has to be unique on the page. */
  name: string;
  /**
   * Take the lease while a pointer is down inside this region. Default `true`.
   * Turn it off to drive `claim`/`release` yourself — a menu that stays open, a
   * camera control engaged by keyboard.
   */
  claimOnPointer?: boolean;
  /** Rendered as this element. Default `"div"`. */
  as?: "div" | "section" | "main" | "aside";
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
}

/**
 * Mark a region of the page as one interaction scope.
 *
 * ```tsx
 * <MotionScope name="gallery" className="relative">
 *   <Gallery />
 * </MotionScope>
 * ```
 *
 * Two things happen. Every `useMotionFrame` rendered inside joins the scope, so
 * the name is written once instead of repeated at each subscription. And while
 * a pointer is down inside the region, the scope holds the foreground lease —
 * so ambient work elsewhere on the page sheds a band earlier and gives up its
 * frame time to whatever the user is touching.
 *
 * Nesting works: the innermost provider wins for both membership and the lease.
 *
 * This is the reason to prefer it over passing `scope` by hand — a name typed
 * in two places can disagree, and a scope that never matches fails silently
 * rather than loudly.
 *
 * ## How the lease tracks a drag
 *
 * Three details, all of which exist because the obvious version got them wrong:
 *
 * - **Pointer down is caught in the capture phase**, on the DOM node rather
 *   than through a React prop. Drag code very often calls `stopPropagation()`
 *   on pointerdown so an outer handler does not also react to the press. A
 *   bubble-phase listener never runs when that happens, so the scope would
 *   silently do nothing in the exact case it is for.
 * - **The end of the drag is watched on `window`, not on the region.** A drag
 *   routinely travels outside the element it started in, and that is still the
 *   same drag. Releasing on pointer leave demotes the region at the moment the
 *   user is dragging it.
 * - **The lease is held until the last pointer lifts.** Pointers are counted by
 *   id, so lifting a second finger does not end a one-finger drag.
 *
 * Pointer capture is deliberately not used here. Calling `setPointerCapture` on
 * this wrapper would fight any child that captures the pointer for its own drag.
 */
export function MotionScope({
  name,
  claimOnPointer = true,
  as: Tag = "div",
  className,
  style,
  children,
}: MotionScopeProps): React.JSX.Element {
  const hostRef = useRef<HTMLElement | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const pointersRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    const host = hostRef.current;
    if (!claimOnPointer || !host) return;

    const pointers = pointersRef.current;

    const stopWatching = () => {
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
    };

    const releaseNow = () => {
      releaseRef.current?.();
      releaseRef.current = null;
      pointers.clear();
      stopWatching();
    };

    function onPointerEnd(event: PointerEvent) {
      if (!pointers.delete(event.pointerId)) return;
      if (pointers.size > 0) return; // another finger is still down
      releaseRef.current?.();
      releaseRef.current = null;
      stopWatching();
    }

    function onPointerDown(event: PointerEvent) {
      const wasIdle = pointers.size === 0;
      pointers.add(event.pointerId);
      if (!wasIdle) return; // already holding; claims must not stack
      releaseRef.current = getConductor().claimScope(name);
      window.addEventListener("pointerup", onPointerEnd, true);
      window.addEventListener("pointercancel", onPointerEnd, true);
    }

    host.addEventListener("pointerdown", onPointerDown, true);

    // A region unmounted mid-drag must not leave the rest of the page demoted.
    return () => {
      host.removeEventListener("pointerdown", onPointerDown, true);
      releaseNow();
    };
    // Tag is in the deps because changing it swaps the host element, and the
    // listener has to move with it.
  }, [claimOnPointer, name, Tag]);

  return (
    <ScopeContext.Provider value={name}>
      <Tag
        ref={hostRef as React.Ref<HTMLDivElement>}
        className={className}
        style={style}
      >
        {children}
      </Tag>
    </ScopeContext.Provider>
  );
}

/** The scope this subtree belongs to, or `null` outside any provider. */
export function useMotionScope(): string | null {
  return useContext(ScopeContext);
}

export interface UseMotionFrameOptions extends Omit<SubscribeOptions, "scope"> {
  /**
   * Override the scope inherited from the nearest {@link MotionScope}. Rarely
   * needed — pass `null` for work that should stay background even inside a
   * scoped region, such as an ambient layer rendered within a gallery.
   */
  scope?: string | null;
  /** Skip subscribing entirely while false. Default `true`. */
  enabled?: boolean;
}

/**
 * Run a function on the shared frame loop, in the scope of the surrounding
 * {@link MotionScope}.
 *
 * ```tsx
 * useMotionFrame("render", (dt) => {
 *   x.current += (target.current - x.current) * (1 - Math.exp(-18 * dt));
 *   el.current.style.transform = `translate3d(${x.current}px,0,0)`;
 * }, { priority: "enhanced" });
 * ```
 *
 * Prefer this over calling `getConductor().subscribe` from a component: the
 * callback is kept fresh through a ref, so it can close over current props
 * without resubscribing every render, and the scope comes from the tree rather
 * than from a string you have to keep in sync by hand.
 *
 * The subscription is torn down on unmount. Changing `lane`, `priority`, `hz`
 * or `scope` resubscribes; changing the function alone does not.
 */
export function useMotionFrame(
  lane: ConductorLane,
  fn: FrameFn,
  options: UseMotionFrameOptions = {},
): void {
  const inherited = useContext(ScopeContext);
  const { priority, hz, label, enabled = true } = options;
  const scope = options.scope === undefined ? inherited : options.scope;

  // The loop calls this every frame; re-subscribing on every render would churn
  // the lane arrays and reset the cost EMA, so the latest closure is swapped in
  // behind a stable callback instead.
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });

  const subOptions = useMemo<SubscribeOptions>(
    () => ({
      priority,
      hz,
      label,
      ...(scope === null ? {} : { scope }),
    }),
    [priority, hz, label, scope],
  );

  useEffect(() => {
    if (!enabled) return;
    return getConductor().subscribe(
      lane,
      (dt, time) => fnRef.current(dt, time),
      subOptions,
    );
  }, [lane, enabled, subOptions]);
}
