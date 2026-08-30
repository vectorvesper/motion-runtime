/**
 * The documented way to call `useSceneGate`. Must lint clean.
 *
 * Every field is read here on purpose: the failure this pins down poisons the
 * whole returned object, not just `ref`, so a fixture that touched only `ref`
 * would pass for the wrong reason.
 */
import { useSceneGate } from "../useSceneGate";

export function SceneGateDestructured({ label }: { label: string }) {
  const { ref, state, mounted, quality, generation, cause, reason } =
    useSceneGate<HTMLDivElement>({ label });

  return (
    <div ref={ref} data-state={state} data-cause={cause} title={reason}>
      {mounted ? <canvas key={generation} data-quality={quality} /> : <img alt="" src="/poster.jpg" />}
    </div>
  );
}
