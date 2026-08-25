/**
 * Put `"use client"` back on the entries whose source declares it.
 *
 * esbuild strips module-level directives when bundling — it warns
 * `"use client" in "dist/react.js" was ignored` and drops the line. So
 * entry.react.ts has said `"use client"` since 1.0, and **every published
 * bundle up to and including 1.0.4 shipped without it.**
 *
 * Nobody noticed because every component that consumes these hooks already
 * declares `"use client"` itself, which establishes the boundary anyway. It
 * surfaces the first time someone imports a hook into a React Server Component:
 * instead of the clear "this needs a client boundary" error, they get a
 * confusing failure from inside a `useState` call in a bundled chunk.
 *
 * ## Why a post-build step and not tsup's `banner`
 *
 * `banner` applies per output FORMAT, not per entry — it would stamp
 * `"use client"` onto `index.js` too. The core is deliberately
 * framework-agnostic and usable from a server, vanilla JS, Vue or Svelte;
 * marking it client-only would be a real regression to fix a cosmetic one.
 *
 * A plugin (esbuild-plugin-preserve-directives) would also work, at the cost of
 * a build dependency for something this file does in twenty lines.
 *
 * ## What it does
 *
 * The directive is read FROM THE SOURCE rather than hardcoded, so this cannot
 * drift: add or remove `"use client"` in an entry and the built output follows.
 * Idempotent — running twice does not stack directives.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..");

/**
 * Source entry → built basename, read straight out of tsup.config.ts.
 *
 * This used to be a hand-written list, and it silently rotted the moment the
 * build grew an entry. The effects and r3f entries were added to the build in
 * the 2.0 work and never added here, so four bundles full of React hooks
 * shipped with no client boundary — the exact bug this file exists to prevent,
 * reintroduced by the one change the file could not see.
 *
 * A list that has to be kept in step with another file will eventually not be.
 * So there is no list: the config is parsed, and anything it builds is covered
 * automatically. A shape this script cannot parse is a hard error, because
 * silently covering nothing is how the first version failed.
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
  if (!match) continue; // no directive in source — nothing to restore
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
