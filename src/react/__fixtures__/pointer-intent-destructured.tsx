/**
 * `usePointerIntent` returns the same hybrid ref, so it carries the same
 * call-site rule. Must lint clean.
 *
 * The second component covers the case a real consumer hits next: the element
 * already has a ref of its own, so both have to be written from one callback.
 * Writing `ref.current` from a committed callback is fine — what the compiler
 * objects to is reaching the ref through a member expression during render.
 */
import { useCallback, useRef } from "react";
import { usePointerIntent } from "../../effects/usePointerIntent";

export function PointerIntentDestructured() {
  const { ref, intent } = usePointerIntent<HTMLDivElement>();

  return <div ref={ref} data-intent={intent ? "yes" : "no"} />;
}

export function PointerIntentComposedRef() {
  const own = useRef<HTMLDivElement | null>(null);
  const { ref, intent } = usePointerIntent<HTMLDivElement>();

  const attach = useCallback(
    (node: HTMLDivElement | null) => {
      own.current = node;
      ref.current = node;
    },
    [ref],
  );

  return <div ref={attach} data-intent={intent ? "yes" : "no"} />;
}
