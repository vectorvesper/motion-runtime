/**
 * Serve the device test on the local network.
 *
 *   npm run bench:device
 *
 * The CDP harness binds to 127.0.0.1, which a phone cannot reach — and there is
 * no debugging protocol for someone's iPhone anyway. So the same scenarios get
 * a page with buttons on it, served on the LAN, and the device reports its own
 * numbers back.
 *
 * Nothing is published for this. It serves the local `dist/`, so whatever was
 * last built is what the phone runs.
 */

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "../lib/cdp.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(DIR, "../..");
const PORT = Number(process.env.PORT ?? 9431);

/** Every address a phone on the same network could actually use. */
function lanAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      out.push({ name, address: a.address });
    }
  }
  return out;
}

const server = await serve({
  port: PORT,
  host: "0.0.0.0",
  routes: {
    "/": path.join(DIR, "device.html"),
    "/scenarios.mjs": path.join(DIR, "scenarios.mjs"),
  },
  mounts: { "/dist/": path.join(PKG, "dist") },
});

const addrs = lanAddresses();

console.log("\nDevice test server running.\n");
if (addrs.length === 0) {
  console.log("  No network address found — is Wi-Fi on?\n");
} else {
  console.log("  Open one of these on the phone or tablet:\n");
  for (const { name, address } of addrs) {
    console.log(`    http://${address}:${PORT}/       (${name})`);
  }
}
console.log(`
  On this machine: http://localhost:${PORT}/

Both devices have to be on the same network, and a firewall prompt on first
run is normal — allow it for private networks.

Two things that quietly ruin a run:

  · The tab must stay in the FOREGROUND. Backgrounding a tab pauses animation
    on every mobile browser, so the numbers become zeros rather than bad.
  · Do not plug the phone in for the thermal test. Charging changes how
    aggressively it throttles, which is the thing being measured.

Ctrl-C to stop.
`);

process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
