// Editor tooling that instruments source (Console Ninja and friends) can bake
// its hooks into a bundle without anyone noticing. The build that gets
// published is the local one, so this runs before every publish, not only in CI.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const MARKERS = /console-ninja|consoleninja|__oo_|oo_oo/i;

const found = [];
for (const name of readdirSync(DIST, { recursive: true })) {
  const file = join(DIST, String(name));
  if (!/\.(c?js|d\.c?ts)$/.test(file)) continue;
  if (MARKERS.test(readFileSync(file, "utf8"))) found.push(file);
}

if (found.length) {
  console.error("✗ The build carries editor instrumentation. Disable the extension and rebuild:");
  for (const file of found) console.error(`  ${file}`);
  process.exit(1);
}
console.log("✓ no editor instrumentation in dist");
