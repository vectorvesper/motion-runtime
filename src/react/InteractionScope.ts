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
   * Up to 2.x this was `boolean | undefined`, where `undefined` and `false`
   * meant different things: leaving it off gave you pointer activation, and
   * setting it to anything at all turned pointer activation off. Opting back
   * in therefore meant passing `undefined`, and an A/B toggle came out as
   * `active={on ? undefined : false}`, which is a shape no reader can guess.
   *
   * Three named values, no hidden state in the absence of a prop.
   *
   * Worth knowing: `true` and `false` run through React state, so they arrive a
   * render later than `"pointer"` does, which is a direct DOM listener. Fine
   * for a modal. Not a drop-in for a drag.
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
 * While a pointer is down inside it, VV's own non-essential work *outside* the
 * region yields earlier when the page runs out of frame time. On a healthy
 * frame nothing changes at all.
 *
 * Reach for it around a draggable, a scrubber, or an interactive canvas that
 * shares a page with other VV visuals. Two things it cannot do: pause another
 * library's animation, or undo GPU work that has already been submitted. It
 * only coordinates work registered with VV.
 *
 * Every `useTick` rendered inside joins this region automatically. Nesting
 * works, and the innermost provider wins.
 *
 * ## How activation tracks a drag
 *
 * Three details, each because the obvious version got it wrong:
 *
 * - **Pointer down is caught in the capture phase**, on the DOM node rather
 *   than through a React prop. Drag code very often calls `stopPropagation()`
 *   on pointerdown so an outer handler does not also react to the press. A
 *   bubble-phase listener never runs when that happens, and the region would
 *   silently do nothing in the exact case it is for.
 * - **The end of the drag is watched on `window`, not on the region.** A drag
 *   routinely travels outside the element it started in, and that is still the
 *   same drag.
 * - **Activation lasts until the last pointer lifts.** Pointers are counted by
 *   id, so lifting a second finger does not end a one-finger drag.
 *
 * Pointer capture is deliberately not used. Calling `setPointerCapture` on this
 * wrapper would fight any child that captures the pointer for its own drag.
 */
export function InteractionScope({
  children,
  label,
  active = "pointer",
  asChild = false,
  className,
  style,
}: InteractionScopeProps): React.JSX.Element {
  // Generated rather than asked for. A page-unique string is work the library
  // can do itself, and two regions that happened to share a hand-written name
  // would silently share one claim.
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

  // Written as `createElement` rather than JSX, deliberately.
  //
  // These are the only two element constructions in the package, and with JSX
  // the build emitted an import of `react/jsx-runtime` into the `/react` entry.
  // That is a subpath of React itself, and an environment that resolves
  // packages from a CDN while supplying its own React can fail on it — Framer's
  // code components do, which is why `/react` would not load there while the
  // root entry did. Two `createElement` calls cost nothing and remove the
  // dependency at the source, where no build-config change can bring it back.
  const content = asChild
    ? cloneWithRef(children, hostRef)
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
   * Keep this work in the background even when it is rendered inside an
   * {@link InteractionScope} — an ambient layer behind a gallery, say, which
   * should yield like everything else while the gallery is being used.
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
