/**
 * Strip private class internals out of the built .d.ts files.
 *
 * TypeScript emits every private member into a declaration file by name —
 * `private frameMsEma;`, `private prevPointerX;`, `private shedLastFrame;` — so
 * the published types documented the internal structure of FrameConductor,
 * SensorBus and AnimationBudget field by field. A consumer needs none of it: the
 * classes are only reachable as the return type of `getConductor()` /
 * `getSensorBus()`, and every member they are allowed to touch is public.
 *
 * Each run of private members is replaced with a single `#private;` marker,
 * which is TypeScript's own way of saying "this class has private state." That
 * keeps the class nominally typed — dropping the members entirely would make it
 * structurally typed, so any object of the same shape would start type-checking
 * as a real conductor — while publishing nothing about what the state is.
 *
 * Export statements are never touched: `scripts/check-api.mjs` diffs them to
 * guard the frozen public surface, and the CLI's scaffolder parses them to route
 * each engine import to the right entry point. Both would break if this script
 * rewrote an export.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist");

/** `private foo;`, `private static foo;`, `private readonly foo;` */
const PRIVATE_MEMBER = /^(\s*)private\s+(?:static\s+)?(?:readonly\s+)?[#\w$]+\s*(?:\?)?\s*;\s*$/;

function sanitize(file) {
  const abs = path.join(DIST, file);
  const lines = fs.readFileSync(abs, "utf-8").split(/\r?\n/);
  const out = [];
  let stripped = 0;
  // One `#private;` per class, not one per member it replaces.
  let brandEmitted = false;

  for (const line of lines) {
    // A new class declaration starts a new brand scope.
    if (/^\s*(?:declare\s+)?(?:abstract\s+)?class\s/.test(line)) brandEmitted = false;

    const match = line.match(PRIVATE_MEMBER);
    if (match) {
      stripped++;
      if (!brandEmitted) {
        out.push(`${match[1]}#private;`);
        brandEmitted = true;
      }
      continue;
    }
    out.push(line);
  }

  if (stripped > 0) fs.writeFileSync(abs, out.join("\n"), "utf-8");
  return stripped;
}

const targets = fs.existsSync(DIST) ? fs.readdirSync(DIST).filter((f) => /\.d\.(ts|cts|mts)$/.test(f)) : [];

if (targets.length === 0) {
  console.error("✗ sanitize-dts: no .d.ts files in dist/ — run tsup first.");
  process.exit(1);
}

let total = 0;
for (const file of targets) total += sanitize(file);

// A guard on the guard: if a private name survives anywhere, the regex missed a
// shape and the types are still publishing internals.
const leaked = [];
for (const file of targets) {
  const text = fs.readFileSync(path.join(DIST, file), "utf-8");
  for (const m of text.matchAll(/^\s*private\s+.*$/gm)) leaked.push(`${file}: ${m[0].trim()}`);
}
if (leaked.length > 0) {
  console.error(`✗ sanitize-dts: private members still present:\n   ${leaked.join("\n   ")}`);
  process.exit(1);
}

console.log(`🔒 sanitize-dts: removed ${total} private member declaration(s) from ${targets.length} .d.ts file(s).`);
