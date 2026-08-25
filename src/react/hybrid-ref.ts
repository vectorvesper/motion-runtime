"use client";

import type { RefObject } from "react";

/**
 * A callback ref that also behaves like a `RefObject`, notifying React state
 * when the element attaches or detaches.
 *
 * ## Why this exists
 *
 * The obvious way to observe an element is to read `ref.current` inside an
 * effect. It is also wrong whenever the element is rendered conditionally:
 *
 * ```tsx
 * if (!hydrated) return <Spinner />;   // first commit — ref target absent
 * return <div ref={gate.ref}>…</div>;  // second commit — nothing re-runs
 * ```
 *
 * On the first commit `ref.current` is `null`, so the effect bails. On the
 * second the element exists, but no dependency changed, so the effect never
 * runs again and the observer is never attached. The failure is silent: no
 * error, no warning, just a hook that quietly does nothing forever.
 *
 * That shape is everywhere in real components — a hydration guard, a loading
 * branch, a Suspense fallback, `next/dynamic` with `ssr: false`. It cost
 * `useSceneGate` a shipped 2.0.0 release, where a ported gallery sat in
 * `dormant` permanently because its spinner rendered first.
 *
 * A callback ref fixes it because React calls it on attach AND detach. Routing
 * that through `useState` gives the effect a real dependency to key on.
 *
 * ## Why not just return a plain callback ref
 *
 * `<div ref={x}>` accepts either, so consumers would not notice — but anyone
 * reading `x.current` imperatively would break, and the published type would
 * change. Defining `current` as an accessor keeps both shapes working, so this
 * stays a bug fix rather than an API change.
 *
 * The ref accesses here run during commit (the ref callback) or from
 * imperative reads, never during render.
 */
export function createHybridRef<T>(
  store: { current: T | null },
  notify: (node: T | null) => void,
): RefObject<T | null> {
  const fn = (node: T | null) => {
    store.current = node;
    notify(node);
  };
  return Object.defineProperties(fn, {
    current: {
      get() {
        return store.current;
      },
      set(value: T | null) {
        store.current = value;
        notify(value);
      },
      configurable: true,
      enumerable: true,
    },
  }) as unknown as RefObject<T | null>;
}
