/**
 * Public API guard — the photo of the menu taped to the wall.
 *
 *   node scripts/check-api.mjs           # fail if the built surface drifted
 *   node scripts/check-api.mjs --update  # accept the current surface as the new truth
 *
 * The package is 1.0: every exported name is a support commitment, and removing
 * one is a breaking change. This reads the built .d.ts for each published entry,
 * lists what's exported, and diffs it against the committed api-surface.json.
 * Any add or removal that isn't deliberately blessed with --update fails the
 * build — so nobody widens or breaks the public API by accident.
 *
 * Wired into prepublishOnly, so a drifted surface can't be published.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, "..");
const SNAPSHOT = path.join(ROOT, "api-surface.json");

/** The published entry points, by their package export path. */
const ENTRIES = {
  ".": "dist/index.d.ts",
  "./react": "dist/react.d.ts",
  "./devtools": "dist/devtools.d.ts",
};

/** Pull the exported names out of a .d.ts, splitting values from types. */
function readSurface(file) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) {
    console.error(`✗ ${file} not built. Run \`npm run build\` first.`);
    process.exit(1);
  }
  const text = fs.readFileSync(abs, "utf-8");
  const values = new Set();
  const types = new Set();
  for (const block of text.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const raw of block[1].split(",")) {
      let entry = raw.trim();
      if (!entry) continue;
      const isType = /^type\s/.test(entry);
      entry = entry.replace(/^type\s+/, "");
      const name = entry.split(/\s+as\s+/).pop().trim();
      if (name) (isType ? types : values).add(name);
    }
  }
  return { values: [...values].sort(), types: [...types].sort() };
}

const current = {};
for (const [entry, file] of Object.entries(ENTRIES)) current[entry] = readSurface(file);

if (process.argv.includes("--update")) {
  fs.writeFileSync(SNAPSHOT, JSON.stringify(current, null, 2) + "\n");
  console.log("✓ api-surface.json updated to the current built surface.");
  process.exit(0);
}

if (!fs.existsSync(SNAPSHOT)) {
  console.error("✗ No api-surface.json. Create it with: node scripts/check-api.mjs --update");
  process.exit(1);
}

const saved = JSON.parse(fs.readFileSync(SNAPSHOT, "utf-8"));
const problems = [];

for (const entry of Object.keys(ENTRIES)) {
  for (const kind of ["values", "types"]) {
    const was = new Set(saved[entry]?.[kind] ?? []);
    const now = new Set(current[entry][kind]);
    for (const name of now) if (!was.has(name)) problems.push(`+ ${entry} added ${kind.slice(0, -1)}: ${name}`);
    for (const name of was) if (!now.has(name)) problems.push(`- ${entry} removed ${kind.slice(0, -1)}: ${name}`);
  }
}

if (problems.length) {
  console.error("✗ Public API surface changed:\n");
  for (const p of problems) console.error("  " + p);
  console.error(
    "\nRemoving an export is a BREAKING change (major bump). Adding one is a new" +
      "\ncommitment. If this change is intentional, re-run with --update and bump" +
      "\nthe version accordingly.",
  );
  process.exit(1);
}

console.log("✓ Public API surface matches api-surface.json.");
