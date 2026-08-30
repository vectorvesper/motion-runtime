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
 * if (!hydrated) return <Spinner />;  // first commit — ref target absent
 * return <div ref={ref}>…</div>;      // second commit — nothing re-runs
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
 *
 * ## What this is NOT responsible for
 *
 * Under the React Compiler lint rules (`eslint-plugin-react-hooks` v7), a
 * consumer that writes
 *
 * ```tsx
 * const gate = useSceneGate();
 * return <div ref={gate.ref}>{gate.mounted && <Canvas key={gate.generation} />}</div>;
 * ```
 *
 * gets `react-hooks/refs` — "Cannot access ref value during render" — on all
 * three of those reads, `gate.generation` included, which is a number.
 *
 * That is not this file's doing, and no shape it could return avoids it. The
 * compiler unifies whatever is passed to a JSX `ref` attribute with the type of
 * `useRef`'s result. When the operand is a member expression the unification
 * flows back into the *object*, so the whole hook result is thereafter treated
 * as a ref and every field read off it is a ref read during render. Verified
 * against all three shapes: this hybrid ref, a bare callback ref, and a plain
 * `useRef` object, plus an inline `useMemo` object literal with no hook in
 * sight. All four fail identically; renaming the property away from `ref` does
 * not help either.
 *
 * The fix is one line at the call site — destructure the hook's result:
 *
 * ```tsx
 * const { ref, mounted, generation } = useSceneGate();
 * return <div ref={ref}>{mounted && <Canvas key={generation} />}</div>;
 * ```
 *
 * Destructuring lowers to a different instruction, so nothing propagates back
 * to the object and the whole call site lints clean — composing the ref with
 * the component's own in a callback ref included. `compiler-lint.test.ts` lints
 * fixture consumers for every hook here that returns a `ref` so this stays
 * true, and it asserts the member-access form still fails: when that assertion
 * starts failing, the compiler has fixed it upstream and these warnings can go.
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
