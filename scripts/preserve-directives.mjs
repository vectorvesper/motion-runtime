/**
 * Put `"use client"` back on the entries whose source declares it.
 *
 * esbuild strips module-level directives when bundling. Without this, importing
 * a hook into a React Server Component gives a confusing failure from inside a
 * `useState` call in a bundled chunk, where it should be a clear client-boundary
 * error.
 *
 * This is a post-build step because tsup's `banner` applies per output format,
 * so it would stamp `"use client"` onto `index.js` too, and the core has to stay
 * usable from a server.
 *
 * The directive is read from the source, so the built output follows any
 * change. Running twice doesn't stack directives.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..");

/**
 * Source entry to built basename, read straight out of tsup.config.ts.
 *
 * A hand-written list would have to stay in step with that file, so the config
 * is parsed and anything it builds is covered. A shape this script can't parse
 * is a hard error, because silently covering nothing is the failure to avoid.
 */
function readTsupEntries() {
  const configPath = path.join(ROOT, "tsup.config.ts");
  const config = fs.readFileSync(configPath, "utf8");

  const block = /entry:\s*\{([\s\S]*?)\}/.exec(config);
  if (!block) {
    console.error(
      "✗ preserve-directives: could not find the `entry` map in tsup.config.ts. " +
        "The config shape changed; update this parser rather than leaving it silent.",
    );
    process.exit(1);
  }

  const entries = {};
  for (const [, base, src] of block[1].matchAll(
    /([A-Za-z0-9_$]+)\s*:\s*["']([^"']+)["']/g,
  )) {
    entries[src] = base;
  }

  if (Object.keys(entries).length === 0) {
    console.error(
      "✗ preserve-directives: parsed tsup.config.ts's `entry` map and found no entries.",
    );
    process.exit(1);
  }

  return entries;
}

const ENTRIES = readTsupEntries();

/** Matches a leading "use client" / 'use strict' style directive. */
const DIRECTIVE_RE = /^\s*(["'])(use [a-z]+)\1\s*;?/;

let stamped = 0;

for (const [srcRel, base] of Object.entries(ENTRIES)) {
  const srcPath = path.join(ROOT, srcRel);
  if (!fs.existsSync(srcPath)) {
    console.error(
      `✗ preserve-directives: ${srcRel} is missing. tsup.config.ts and this script have diverged.`,
    );
    process.exit(1);
  }

  const match = DIRECTIVE_RE.exec(fs.readFileSync(srcPath, "utf8"));
  if (!match) continue; // no directive in source, nothing to restore
  const directive = `"${match[2]}";`;

  for (const ext of [".js", ".cjs"]) {
    const outPath = path.join(ROOT, "dist", base + ext);
    if (!fs.existsSync(outPath)) continue;

    const code = fs.readFileSync(outPath, "utf8");
    const existing = DIRECTIVE_RE.exec(code);
    if (existing && existing[2] === match[2]) continue; // already correct

    // Must be the first statement in the file to count as a directive.
    fs.writeFileSync(outPath, `${directive}\n${code}`);
    stamped += 1;
  }
}

console.log(
  stamped > 0
    ? `🏷️  preserve-directives: restored "use client" on ${stamped} bundle(s).`
    : "🏷️  preserve-directives: nothing to restore.",
);
