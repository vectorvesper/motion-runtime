import reactHooks from "eslint-plugin-react-hooks";
import tsParser from "@typescript-eslint/parser";

/**
 * The React Compiler rules, run against this package's own React source.
 *
 * This exists for one reason: a hook that returns a ref can lint clean inside
 * this repo and still be impossible to call from a compiled app, and nothing
 * else in the toolchain notices. `src/react/compiler-lint.test.ts` carries the
 * matching config and lints the consumer fixtures in `src/react/__fixtures__`,
 * which are ignored here — one of them is an expected failure and would make
 * `npm run lint` permanently red.
 */
export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "scripts/**",
      "devtools/**",
      "r3f/**",
      "react/**",
      "src/react/__fixtures__/**",
    ],
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs["recommended-latest"].rules,
  },
  {
    // Test harnesses have to break component rules to build the arrangements
    // they are testing: `useEffect(() => setState(true), [])` IS the deferred
    // attach that 2.0.0 got wrong, and capturing render output into an outer
    // variable is how an assertion sees it. Instrumentation, not modelling.
    //
    // `react-hooks/refs` stays ON here on purpose. Tests are call sites like
    // any other, and the destructuring rule the docs give consumers has to hold
    // in this package first — see the note in hybrid-ref.ts.
    files: ["src/**/*.test.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/globals": "off",
      "react-hooks/immutability": "off",
    },
  },
];
