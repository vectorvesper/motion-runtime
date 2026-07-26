import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/entry.core.ts",
    react: "src/entry.react.ts",
    devtools: "src/entry.devtools.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  treeshake: true,
  splitting: true,
  sourcemap: true,
  // react is a peer dependency — never bundle it.
  external: ["react", "react-dom", "react/jsx-runtime"],
});
