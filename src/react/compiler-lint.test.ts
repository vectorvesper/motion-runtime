import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";

/**
 * Lints sample consumers under the React Compiler rules.
 *
 * `useSceneGate` and `usePointerIntent` hand back a hybrid ref (see
 * hybrid-ref.ts). `npm test`, `tsc` and `tsup` can't tell you whether a
 * component may call those hooks: the compiler rules run in the consumer's app.
 * So the check is a real lint over a real call site.
 *
 * The config is duplicated from `eslint.config.mjs`, which is untyped ESM
 * outside `src`, and a repo lint tweak shouldn't change what this asserts.
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
      // only a typing mismatch: the object is a valid plugin.
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
   * The rule isn't specific to the hybrid ref. Covering these means a hook
   * added later with a `{ ref }` shape gets the same check.
   */
  it("lints clean for every other hook that returns a ref", async () => {
    expect(await lint("ref-returning-hooks.tsx")).toEqual([]);
  }, 60_000);

  /**
   * The counterpart: reaching the ref through `scene.ref` fails, and takes the
   * rest of the object with it. `scene.generation`, a number, is reported as a
   * ref read during render too. This is decided at the call site.
   *
   * If this ever comes back empty the compiler fixed it, and the warnings on
   * `SceneGate.ref` and its siblings can go.
   */
  it("still fails when the scene gate is reached by member access", async () => {
    const messages = await lint("scene-gate-member-access.tsx");
    expect(messages.filter((m) => m.startsWith("react-hooks/refs"))).not.toEqual([]);
  }, 60_000);
});
