import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";

/**
 * Lints sample consumers under the React Compiler rules.
 *
 * `useSceneGate` and `usePointerIntent` hand back a hybrid ref — a callback ref
 * with a `current` accessor defined on it (see hybrid-ref.ts). Nothing in
 * `npm test`, `tsc` or `tsup` can tell you whether a component is allowed to
 * *call* those hooks: the compiler rules run in the consumer's app, against
 * consumer code, and the first sign of trouble is a red build in someone else's
 * repo. Four shipped components hit exactly that.
 *
 * So the check has to be a real lint over a real call site.
 *
 * The config is duplicated from `eslint.config.mjs` rather than imported. That
 * file is untyped ESM outside `src`, and this test wants a fixed config anyway:
 * a repo lint tweak should not quietly change what it asserts.
 */
const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: {
        parser: tsParser,
        ecmaVersion: "latest",
        sourceType: "module",
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      // The plugin's own types are narrower than ESLint's `Plugin`, which is
      // only a typing mismatch — the object is a valid plugin.
      plugins: { "react-hooks": reactHooks as unknown as ESLint.Plugin },
      rules: reactHooks.configs["recommended-latest"].rules,
    },
  ],
});

/**
 * Paths are relative to the repo root because ESLint resolves them against
 * `process.cwd()`, and vitest runs from the directory holding vitest.config.ts.
 * Resolving from `import.meta` instead would mean a `@types/node` dependency
 * this package does not otherwise need.
 */
async function lint(fixture: string) {
  const [result] = await eslint.lintFiles([`src/react/__fixtures__/${fixture}`]);
  return (result?.messages ?? []).map((m) => `${m.ruleId ?? "?"} @ ${m.line}:${m.column}`);
}

describe("consumers of the hybrid ref", () => {
  it("lints clean when the scene gate is destructured", async () => {
    expect(await lint("scene-gate-destructured.tsx")).toEqual([]);
  }, 60_000);

  it("lints clean when pointer intent is destructured, composed ref included", async () => {
    expect(await lint("pointer-intent-destructured.tsx")).toEqual([]);
  }, 60_000);

  /**
   * The rule is not specific to the hybrid ref — the four hooks in this fixture
   * return plain `useRef` objects and behave identically. Covering them means a
   * hook added later with a `{ ref }` shape is checked by the same test.
   */
  it("lints clean for every other hook that returns a ref", async () => {
    expect(await lint("ref-returning-hooks.tsx")).toEqual([]);
  }, 60_000);

  /**
   * The counterpart, and the reason the three above are worth asserting:
   * reaching the ref through `scene.ref` fails, and takes the rest of the
   * object with it.
   *
   * `ref={<member expression>}` makes the compiler unify the *object's* type
   * with `useRef`'s, so `scene.generation` — a number — is also reported as a
   * ref read during render. That is decided entirely at the call site; no shape
   * `createHybridRef` could return avoids it, and a plain `useRef` object or a
   * bare callback ref behaves identically.
   *
   * If this ever comes back empty the compiler fixed it upstream, and the
   * warnings on `SceneGate.ref` and its siblings can go.
   */
  it("still fails when the scene gate is reached by member access", async () => {
    const messages = await lint("scene-gate-member-access.tsx");
    expect(messages.filter((m) => m.startsWith("react-hooks/refs"))).not.toEqual([]);
  }, 60_000);
});
