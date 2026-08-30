# Compiler-lint fixtures

Sample consumers linted by `src/react/compiler-lint.test.ts` under the React
Compiler rules (`eslint-plugin-react-hooks` v7 + `eslint.config.mjs`).

They are not unit tests and are never imported at runtime. They exist because a
hook that returns a ref can look perfectly correct in this repo and still be
impossible to call from a compiled app, and nothing else in the toolchain
notices.
