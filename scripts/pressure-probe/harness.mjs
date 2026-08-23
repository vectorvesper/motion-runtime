/**
 * FramePressure — real-browser validation.
 *
 *   node scripts/pressure-probe/harness.mjs
 *
 * The classifier's decision logic is unit-tested against synthetic frames. Its
 * *measurement* layer cannot be: the main-thread share is a claim about how the browser
 * schedules a MessageChannel task relative to the rendering steps, and jsdom
 * has no rendering steps. This runs it against a real Chrome, under four loads
 * whose true cause we already know, and checks the verdict.
 *
 * It drives Chrome over CDP with the built-in WebSocket. No Playwright, no
 * Puppeteer — the whole thing is one dependency-free file so it can be run on
 * a machine that has nothing installed but Chrome.
 *
 * The browser is launched HEADED on purpose. A hidden or headless page pauses
 * requestAnimationFrame, so every measurement would be zero and every check
 * would pass while proving nothing.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(DIR, "../..");
const PORT = 9411;
const CDP_PORT = 9412;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

/** What each scenario is really doing, and therefore what it must be called. */
const EXPECTED = {
  idle: "none",
  runtime: "runtime",
  "main-thread": "main-thread",
  render: "render",
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json",
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let file;
      if (url.pathname === "/") file = path.join(DIR, "page.html");
      else if (url.pathname.startsWith("/dist/"))
        file = path.join(PKG, url.pathname.replace(/^\/+/, ""));
      else return res.writeHead(404).end("not found");

      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(PORT, "127.0.0.1", () => resolve(server)));
}

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("Chrome not found. Add its path to CHROME_CANDIDATES.");
}

/** Poll a URL until it answers, rather than sleeping a fixed guess. */
async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${url}`);
}

/** A minimal CDP client: send a method, await its reply. */
function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;

  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(ev.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  });

  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  return {
    ready,
    send(method, params = {}) {
      const mid = ++id;
      return new Promise((resolve, reject) => {
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

async function evaluate(cdp, expression) {
  const res = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? "evaluate failed");
  }
  return res.result.value;
}

async function main() {
  const server = await serve();
  const chromePath = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vv-pressure-"));

  const chrome = spawn(
    chromePath,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--window-size=1280,800",
      `http://127.0.0.1:${PORT}/`,
    ],
    { stdio: "ignore", detached: false },
  );

  let cdp = null;
  let failures = 0;

  try {
    await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`);

    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      const list = await waitFor(`http://127.0.0.1:${CDP_PORT}/json/list`);
      target = list.find((t) => t.type === "page" && t.url.includes(`:${PORT}`));
      if (!target) await new Promise((r) => setTimeout(r, 150));
    }
    if (!target) throw new Error("probe page never appeared in the target list");

    cdp = connect(target.webSocketDebuggerUrl);
    await cdp.ready;
    await cdp.send("Runtime.enable");

    // Wait for the module to finish booting rather than sleeping a guess.
    for (let i = 0; i < 100; i++) {
      const ok = await evaluate(cdp, "!!window.__probe");
      if (ok) break;
      await new Promise((r) => setTimeout(r, 150));
    }

    const hidden = await evaluate(cdp, "document.hidden");
    if (hidden) throw new Error("page is hidden — rAF is paused, measurements would be meaningless");

    const renderer = await evaluate(cdp, "window.__probe.renderer");
    console.log(`GPU: ${renderer}\n`);

    console.log("scenario      expected      got           conf   frame   runtime  other   off     fps");
    console.log("─".repeat(92));

    for (const [name, expected] of Object.entries(EXPECTED)) {
      const s = await evaluate(cdp, `window.__probe.run(${JSON.stringify(name)}, 4000)`);
      if (s.error) throw new Error(s.error);

      const ok = s.source === expected;
      if (!ok) failures++;
      const f = (v) => (v === null ? "  —  " : v.toFixed(1).padStart(5));
      console.log(
        `${ok ? "✓" : "✗"} ${name.padEnd(12)}${expected.padEnd(14)}${s.source.padEnd(14)}` +
          `${String(Math.round(s.confidence * 100)).padStart(3)}%  ` +
          `${f(s.frameMs)}  ${f(s.runtimeMs)}   ${f(s.mainOtherMs)}  ${f(s.offThreadMs)}  ` +
          `${s.frameMs > 0 ? Math.round(1000 / s.frameMs) : 0}`,
      );
    }

    console.log("");
    if (failures) {
      console.error(
        `✗ ${failures} scenario(s) misclassified. The measurement layer does not\n` +
          `  behave as the unit tests assume. Do not let anything consume the\n` +
          `  classifier until this is green.`,
      );
    } else {
      console.log("✓ All four loads classified correctly in a real browser.");
    }
  } finally {
    cdp?.close();
    chrome.kill();
    server.close();
    // Chrome holds the profile briefly after exit.
    await new Promise((r) => setTimeout(r, 500));
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* a locked profile dir in temp is not worth failing the run over */
    }
  }

  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error("✗ harness failed:", err.message);
  process.exit(1);
});
