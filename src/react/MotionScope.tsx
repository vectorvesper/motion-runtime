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
 */
export function MotionScope({
  name,
  claimOnPointer = true,
  as: Tag = "div",
  className,
  style,
  children,
}: MotionScopeProps): React.JSX.Element {
  const releaseRef = useRef<(() => void) | null>(null);

  const claim = () => {
    if (releaseRef.current) return; // already holding; claims must not stack
    releaseRef.current = getConductor().claimScope(name);
  };
  const release = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };

  // A region unmounted mid-drag must not leave the rest of the page demoted.
  useEffect(() => () => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const pointerProps = claimOnPointer
    ? {
        onPointerDown: claim,
        onPointerUp: release,
        onPointerCancel: release,
        onPointerLeave: release,
      }
    : {};

  return (
    <ScopeContext.Provider value={name}>
      <Tag className={className} style={style} {...pointerProps}>
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
