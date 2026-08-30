/**
 * The shape that does NOT work, kept so the test can prove it still fails.
 *
 * `ref={<member expression>}` makes the compiler unify the *object's* type with
 * `useRef`'s, so every later read off `scene` counts as reading `ref.current`
 * during render — `scene.generation` and `scene.mounted` included, neither of
 * which is a ref. Nothing the runtime returns can change this; it is decided at
 * the call site.
 *
 * If this fixture ever lints clean, the compiler fixed it upstream and the
 * warning in `SceneGate.ref` can be relaxed.
 */
import { useSceneGate } from "../useSceneGate";

export function SceneGateMemberAccess({ label }: { label: string }) {
  const scene = useSceneGate<HTMLDivElement>({ label });

  return (
    <div ref={scene.ref}>
      {scene.mounted ? <canvas key={scene.generation} /> : null}
    </div>
  );
}
