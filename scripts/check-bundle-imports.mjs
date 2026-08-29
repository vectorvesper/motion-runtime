/**
 * Fail the build if a bundle imports something a CDN-resolving host cannot get.
 *
 * ## The failure this exists to stop
 *
 * Up to 4.0.0 the `/react` entry imported `react/jsx-runtime`, because
 * `tsconfig.json` sets `jsx: "react-jsx"` and the automatic runtime emits that
 * import. It came from exactly two element constructions in `InteractionScope`.
 *
 * The root entry has no JSX and so imported nothing external. The result was an
 * asymmetry nobody had a reason to look for: in Framer, whose code components
 * resolve packages from a CDN and supply their own React, the ROOT entry loaded
 * and `/react` did not. Since every hook — `useSceneGate`, `useTick`,
 * `useAdaptiveQuality`, `useSafeToMount`, `useSensorBus` — lives only on
 * `/react`, that quietly meant no Framer component could use a runtime hook at
 * all, and the whole component port there was written around private frame
 * loops instead. It went unnoticed for weeks because nothing failed loudly;
 * one entry simply did not load.
 *
 * The fix was to write those two elements with `createElement`. This check is
 * the part that keeps it fixed: the import is one `jsx` config flag away from
 * returning, and nothing else in the pipeline would notice.
 *
 * ## What is allowed
 *
 * Relative chunk imports are fine — the root entry has always had them and
 * loads. Bare specifiers are the risk, because the host has to resolve each one
 * itself, so every entry declares exactly which it may carry.
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
