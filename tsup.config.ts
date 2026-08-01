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
  // No sourcemaps. tsup embeds `sourcesContent` in every .map, which shipped
  // ~112 KB of the original commented TypeScript — the entire engine, source
  // comments included — inside the published tarball. Sourcemaps are a debugging
  // convenience for consumers; publishing our source is not a trade worth making.
  // They can still be generated locally by flipping this for a one-off build.
  sourcemap: false,
  // Ship a compiled artifact rather than annotated source. The unminified build
  // preserved `// src/core/<file>.ts` banners above each section, so the bundle
  // read like the repo. Minifying does not make the logic secret — code that runs
  // in a browser can always be read — it just stops the package from being a
  // copy-paste-ready source drop.
  minify: true,
  // react is a peer dependency — never bundle it.
  external: ["react", "react-dom", "react/jsx-runtime"],
});
