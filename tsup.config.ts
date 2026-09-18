import { defineConfig } from "tsup";
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  // Substituted into `VERSION` in entry.core.ts. Read from package.json so the
  // exported version cannot drift from the published one.
  define: {
    __VV_VERSION__: JSON.stringify(pkg.version),
  },
  entry: {
    index: "src/entry.core.ts",
    react: "src/entry.react.ts",
    devtools: "src/entry.devtools.ts",
    r3f: "src/entry.r3f.ts",
    three: "src/entry.three.ts",
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
  // three and R3F are optional peers, for the /r3f and /three entries, and
  // neither entry imports them at runtime. Bundling either would drag a 3D
  // engine into a package that advertises none.
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "three",
    "@react-three/fiber",
  ],
});
