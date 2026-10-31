/**
 * Fail the build if a bundle imports something a CDN-resolving host can't get.
 *
 * Framer's code components resolve packages from a CDN and supply their own
 * React, so a `react/jsx-runtime` import stops the `/react` entry loading
 * there, and every hook lives on `/react`. Any JSX in the source brings that
 * import back, because `tsconfig.json` sets `jsx: "react-jsx"`.
 *
 * Relative chunk imports are fine. Bare specifiers are the risk, because the
 * host has to resolve each one itself, so every entry declares which it may
 * carry.
 */
import fs from "node:fs";
import path from "node:path";

const DIST = path.resolve(import.meta.dirname, "../dist");

/** Bare specifiers each entry is permitted to import. */
const ALLOWED = {
  index: [],
  devtools: [],
  react: ["react"],
  r3f: ["react", "three", "@react-three/fiber"],
  // Reads the renderer it is handed by shape. Importing three here would bundle
  // the engine's resolution into every page that uses the hook.
  three: ["react"],
};

/** Never allowed anywhere, whatever the entry. */
const BANNED = ["react/jsx-runtime", "react/jsx-dev-runtime"];

const BARE = /(?:from|import)\s*["']([^"'.][^"']*)["']|require\(["']([^"'.][^"']*)["']\)/g;

let failed = false;

for (const [entry, allowed] of Object.entries(ALLOWED)) {
  for (const ext of ["js", "cjs"]) {
    const file = path.join(DIST, `${entry}.${ext}`);
    if (!fs.existsSync(file)) {
      console.error(`✗ ${entry}.${ext} is missing — did the build fail?`);
      failed = true;
      continue;
    }
    const src = fs.readFileSync(file, "utf8");
    const found = new Set();
    for (const m of src.matchAll(BARE)) found.add(m[1] ?? m[2]);

    for (const spec of found) {
      if (BANNED.includes(spec)) {
        console.error(
          `✗ ${entry}.${ext} imports "${spec}". A host that supplies its own React ` +
            `may not resolve it, and that is what stopped /react loading in Framer. ` +
            `Build JSX with createElement instead of the automatic runtime.`,
        );
        failed = true;
      } else if (!allowed.includes(spec)) {
        console.error(
          `✗ ${entry}.${ext} imports "${spec}", which is not on its allow-list ` +
            `[${allowed.join(", ") || "none"}]. Add it deliberately if it belongs.`,
        );
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log("🔗 check-bundle-imports: every entry carries only what a CDN host can resolve.");
