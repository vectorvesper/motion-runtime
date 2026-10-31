"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import { getConductor } from "../entry.core";
import type { ConductorLane, FrameFn, SubscribeOptions } from "../entry.core";

/**
 * The scope id that `useTick` calls beneath this provider join. `null` at the
 * root, meaning the work belongs to no particular region.
 */
const ScopeContext = createContext<string | null>(null);

export interface InteractionScopeProps {
  children?: React.ReactNode;
  /**
   * A human-readable name for this region, shown in devtools. It has no effect
   * on behaviour, and it does not have to be unique.
   */
  label?: string;
  /**
   * When this region counts as the one the visitor is working in.
   *
   * - `"pointer"` (default) activates while a pointer is down inside it.
   * - `true` holds it active. For a camera engaged by keyboard, an open modal.
   * - `false` never activates.
   *
   * `true` and `false` run through React state, so they arrive a render later
   * than `"pointer"`, which is a direct DOM listener. Fine for a modal, not for
   * a drag.
   */
  active?: boolean | "pointer";
  /**
   * Use the single child element instead of rendering a wrapper `div`. Use it
   * when an extra element would break a flex or grid layout.
   */
  asChild?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Mark the region the visitor is working in.
 *
 * ```tsx
 * <InteractionScope label="Product gallery">
 *   <DraggableGallery />
 * </InteractionScope>
 * ```
 *
 * While a pointer is down inside it, VV's non-essential work outside the region
 * yields earlier when the page runs out of frame time. On a healthy frame
 * nothing changes.
 *
 * Use it around a draggable, a scrubber, or an interactive canvas that shares a
 * page with other VV visuals. It only coordinates work registered with VV, so
 * it can't pause another library's animation or undo submitted GPU work.
 *
 * Every `useTick` rendered inside joins this region automatically. Nesting
 * works, and the innermost provider wins.
 *
 * Pointer down is caught in the capture phase on the DOM node, because drag
 * code often calls `stopPropagation()` on pointerdown. The end of the drag is
 * watched on `window`, because a drag routinely leaves the element it started
 * in. Pointers are counted by id, so lifting a second finger doesn't end a
 * one-finger drag.
 *
 * `setPointerCapture` isn't used, because it would fight any child that
 * captures the pointer for its own drag.
 */
export function InteractionScope({
  children,
  label,
  active = "pointer",
  asChild = false,
  className,
  style,
}: InteractionScopeProps): React.JSX.Element {
  // Generated, because two regions sharing a hand-written name would silently
  // share one claim.
  const id = useId();
  const hostRef = useRef<HTMLElement | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const pointersRef = useRef<Set<number>>(new Set());

  // "pointer" is the uncontrolled mode: the DOM listener below drives it.
  // Anything else is the caller holding the switch.
  const controlled = active !== "pointer";

  // Controlled: the boolean is the whole story.
  useEffect(() => {
    if (!controlled) return;
    if (active === true) {
      releaseRef.current ??= getConductor().claimScope(id, label);
    } else {
      releaseRef.current?.();
      releaseRef.current = null;
    }
    return () => {
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, [controlled, active, id, label]);

  // Uncontrolled: pointer input drives it.
  useEffect(() => {
    const host = hostRef.current;
    if (controlled || !host) return;

    const pointers = pointersRef.current;

    const stopWatching = () => {
      window.removeEventListener("pointerup", onPointerEnd, true);
      window.removeEventListener("pointercancel", onPointerEnd, true);
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
      if (!wasIdle) return; // already active; claims must not stack
      releaseRef.current = getConductor().claimScope(id, label);
      window.addEventListener("pointerup", onPointerEnd, true);
      window.addEventListener("pointercancel", onPointerEnd, true);
    }

    host.addEventListener("pointerdown", onPointerDown, true);

    // A region unmounted mid-drag must not leave the rest of the page yielding.
    return () => {
      host.removeEventListener("pointerdown", onPointerDown, true);
      releaseRef.current?.();
      releaseRef.current = null;
      pointers.clear();
      stopWatching();
    };
  }, [controlled, id, label, asChild]);

  // `createElement` instead of JSX, because JSX makes the build import
  // `react/jsx-runtime` into the `/react` entry. An environment that resolves
  // packages from a CDN with its own React can fail on that subpath, and
  // Framer's code components do.
  //
  // The compiler reads handing hostRef to createElement as a render-phase ref
  // access. It is the false positive described in hybrid-ref.ts, and it is what
  // JSX ref={} lowers to anyway.
  const content = asChild
    ? // eslint-disable-next-line react-hooks/refs -- see the note above
      cloneWithRef(children, hostRef)
    : React.createElement(
        "div",
        { ref: hostRef as React.Ref<HTMLDivElement>, className, style },
        children,
      );

  return React.createElement(ScopeContext.Provider, { value: id }, content);
}

/**
 * Attach our ref to the single child without discarding a ref it already has.
 * React 19 carries `ref` in props; React 18 carries it on the element.
 */
function cloneWithRef(
  children: React.ReactNode,
  ourRef: React.MutableRefObject<HTMLElement | null>,
): React.JSX.Element {
  const child = React.Children.only(children) as React.ReactElement<{
    ref?: React.Ref<HTMLElement>;
  }> & { ref?: React.Ref<HTMLElement> };

  const theirs = child.props?.ref ?? child.ref;

  const merged: React.RefCallback<HTMLElement> = (node) => {
    ourRef.current = node;
    if (typeof theirs === "function") theirs(node);
    else if (theirs) (theirs as React.MutableRefObject<HTMLElement | null>).current = node;
  };

  return React.cloneElement(child, { ref: merged });
}

/** The scope this subtree belongs to, or `null` outside any provider. */
export function useInteractionScope(): string | null {
  return useContext(ScopeContext);
}

export interface UseTickOptions extends Omit<SubscribeOptions, "scope"> {
  /**
   * Keep this work in the background even inside an {@link InteractionScope}:
   * an ambient layer behind a gallery, say, which yields while the gallery
   * is being used.
   */
  background?: boolean;
  /** Skip subscribing entirely while false. Default `true`. */
  enabled?: boolean;
}

/**
 * Run a function on the shared frame loop.
 *
 * ```tsx
 * useTick("render", (dt) => {
 *   x.current += (target.current - x.current) * (1 - Math.exp(-18 * dt));
 *   el.current.style.transform = `translate3d(${x.current}px,0,0)`;
 * });
 * ```
 *
 * Prefer this over calling `getConductor().subscribe` from a component. The
 * callback is held in a ref, so it can read current props without
 * resubscribing on every render, and it joins the surrounding
 * {@link InteractionScope} on its own.
 *
 * The subscription is removed on unmount. Changing `lane`, `priority`, `hz` or
 * `background` resubscribes; changing the function alone does not.
 */
export function useTick(
  lane: ConductorLane,
  fn: FrameFn,
  options: UseTickOptions = {},
): void {
  const inherited = useContext(ScopeContext);
  const { priority, hz, label, enabled = true, background = false } = options;
  const scope = background ? null : inherited;

  // The loop calls this every frame; resubscribing on every render would churn
  // the lane arrays and reset the cost average, so the latest closure is
  // swapped in behind a stable callback instead.
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
