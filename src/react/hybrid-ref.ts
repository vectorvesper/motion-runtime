"use client";

import type { RefObject } from "react";

/**
 * A callback ref that also behaves like a `RefObject`, notifying React state
 * when the element attaches or detaches.
 *
 * Reading `ref.current` inside an effect fails whenever the element is rendered
 * conditionally:
 *
 * ```tsx
 * if (!hydrated) return <Spinner />;  // first commit, ref target absent
 * return <div ref={ref}>…</div>;      // second commit, nothing re-runs
 * ```
 *
 * On the first commit the effect bails. On the second no dependency changed, so
 * it never runs again, with no error or warning. A hydration guard, a loading
 * branch, a Suspense fallback or `next/dynamic` with `ssr: false` all do this.
 *
 * React calls a callback ref on attach and detach, and routing that through
 * `useState` gives the effect a real dependency. `current` stays as an accessor
 * so imperative readers and the published type keep working. The ref accesses
 * here run during commit or from imperative reads, never during render.
 *
 * Under the React Compiler lint rules, a consumer that writes
 *
 * ```tsx
 * const gate = useSceneGate();
 * return <div ref={gate.ref}>{gate.mounted && <Canvas key={gate.generation} />}</div>;
 * ```
 *
 * gets `react-hooks/refs` on all three reads, `gate.generation` included. No
 * shape this could return avoids it: the compiler unifies a JSX `ref` operand
 * with `useRef`'s result, and a member expression flows that back into the
 * whole object. The fix is to destructure the hook's result:
 *
 * ```tsx
 * const { ref, mounted, generation } = useSceneGate();
 * return <div ref={ref}>{mounted && <Canvas key={generation} />}</div>;
 * ```
 *
 * `compiler-lint.test.ts` lints fixture consumers for every hook here that
 * returns a `ref`, and asserts the member-access form still fails. When that
 * assertion starts failing, the compiler has fixed it and these warnings can
 * go.
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
