import { defineConfig } from "vitest/config";
import { createRequire } from "node:module";

const pkg = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  // This package carries its own react devDependency. Without deduping, a test
  // that imports a hook from src and react-dom from node_modules gets two React
  // copies and a null hook dispatcher.
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  // tsup substitutes this at build time. Tests import the source directly, so
  // without the same define, anything touching entry.core throws.
  define: {
    __VV_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    environment: "node",
    // Core tests are pure logic and run in node. React tests opt into jsdom
    // with a `// @vitest-environment jsdom` docblock at the top of the file.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
