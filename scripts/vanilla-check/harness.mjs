/**
 * Exercise the core entry with no React anywhere.
 *
 * The package has advertised vanilla / Vue / Svelte support since 1.0, and 3.0
 * exported the effect engines specifically so a non-React consumer could use
 * them. Nothing had ever run that path. Every test in the repo is either a node
 * unit test or a jsdom React test, and every browser check goes through the
 * docs site, which is React.
 *
 * So this serves the built `dist/` to a plain HTML page that imports it as an
 * ES module, constructs the classes by hand, and drives it with real input. If
 * the framework-agnostic claim is wrong, it is wrong here.
 *
 * Run: npm run build && node scripts/vanilla-check/harness.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve, launch } from "../lib/cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const PORT = 8123;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}

// `serve` resolves once the socket is listening, so awaiting it is the wait.
// `waitFor` is not usable here: it calls `r.json()` on the response, which an
// HTML page never satisfies, so it polls until it times out.
const server = await serve({
  port: PORT,
  routes: { "/": path.join(here, "page.html") },
  mounts: { "/dist": path.join(root, "dist") },
});

const { cdp, evaluate, front, dispose } = await launch({
  url: `http://127.0.0.1:${PORT}/`,
  cdpPort: 9411,
  windowSize: "1200,900",
});

const mouse = (type, x, y) =>
  cdp.send("Input.dispatchMouseEvent", {
    type, x, y, button: "none", buttons: 0, clickCount: 0, pointerType: "mouse",
  });

try {
  await front();
  await sleep(2500);

  const boot = JSON.parse(await evaluate(`JSON.stringify(window.__vv ?? null)`));
  check("the core entry imports as a plain ES module", boot?.imported === true);
  if (!boot?.imported) {
    console.log(boot?.errors?.join("\n") ?? "no error captured");
    throw new Error("import failed");
  }
  check("no errors during setup", boot.errors.length === 0, boot.errors.join(" | "));

  console.log(`\n   version ${boot.checks.version}, ${boot.exports.length} exports\n`);

  for (const [k, v] of Object.entries(boot.checks)) {
    if (k === "version") continue;
    check(`  ${k}`, v === true, v === true ? "" : String(v));
  }

  /* ── the loop runs with nothing but the core ──────────────────── */
  await sleep(1500);
  const running = JSON.parse(await evaluate(`JSON.stringify(window.__vvRead())`));
  check(
    "the conductor ticks without React",
    running.ticks > 30 && running.lastDt > 0,
    `${running.ticks} ticks, dt ${running.lastDt.toFixed(4)}s`,
  );
  check("governors are subscribed", running.subscribers >= 2, `${running.subscribers} subscribers`);
  check(
    "the governors report",
    typeof running.budgetTier === "number" && typeof running.qualityTier === "number",
    `budget tier ${running.budgetTier}, quality tier ${running.qualityTier}, pressure "${running.pressureSource}"`,
  );

  /* ── real pointer input into SensorBus and the effects ────────── */
  const stage = JSON.parse(
    await evaluate(
      `(() => { const r = document.getElementById("stage").getBoundingClientRect();
        return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) }); })()`,
    ),
  );

  let peakSpeed = 0;
  let magnetMoved = false;
  for (let i = 0; i <= 30; i++) {
    await mouse("mouseMoved", stage.x + 10 + Math.round(((stage.w - 20) * i) / 30), stage.y);
    await sleep(18);
    if (i % 4 === 0) {
      const s = JSON.parse(await evaluate(`JSON.stringify(window.__vvRead())`));
      peakSpeed = Math.max(peakSpeed, s.pointer.speed);
      if (s.magnetTransform && s.magnetTransform !== "none" &&
          !/matrix\(1, 0, 0, 1, 0, 0\)/.test(s.magnetTransform)) magnetMoved = true;
    }
  }
  const afterPointer = JSON.parse(await evaluate(`JSON.stringify(window.__vvRead())`));

  check("SensorBus sees a real pointer", peakSpeed > 50, `peak ${Math.round(peakSpeed)} px/s`);
  check("MagneticElement displaces its target", magnetMoved, afterPointer.magnetTransform);
  check("PointerIntent fires", afterPointer.intentFired === true, `intentFired=${afterPointer.intentFired}`);

  /* ── scroll ───────────────────────────────────────────────────── */
  await evaluate(`window.scrollTo(0, 900)`);
  await sleep(900);
  const afterScroll = JSON.parse(await evaluate(`JSON.stringify(window.__vvRead())`));
  check("SensorBus tracks scroll", afterScroll.scrollY > 100, `scrollY ${Math.round(afterScroll.scrollY)}`);

  /* ── teardown leaves nothing behind ───────────────────────────── */
  const left = Number(await evaluate(`window.__vvTeardown()`));
  check("everything releases the loop on destroy", left === 0, `${left} subscribers left`);
} finally {
  await dispose();
  server.close();
}

console.log(
  failures === 0
    ? "\n✓ the core works with no framework at all\n"
    : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
