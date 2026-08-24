/**
 * Driving a real headed Chrome, with nothing installed but Chrome.
 *
 * Shared by the pressure harness and the benchmark kit. It was one file's worth
 * of plumbing copied once; a second copy is how the rest of this project ended
 * up with five copies of everything.
 *
 * No Playwright, no Puppeteer — Node's built-in WebSocket plus the CDP HTTP
 * endpoints is enough, and it means these scripts run on a machine that has
 * only a browser.
 *
 * The browser is launched HEADED on purpose. A hidden or headless page pauses
 * requestAnimationFrame, so every frame measurement would be zero and every
 * check would pass while proving nothing.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe"),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json",
};

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("Chrome not found. Add its path to CHROME_CANDIDATES in scripts/lib/cdp.mjs.");
}

/**
 * Serve one page plus a directory of built files.
 *
 * `routes` maps a pathname to an absolute file. `mounts` maps a path prefix to
 * a directory.
 */
export function serve({ port, routes = {}, mounts = {} }) {
  const server = createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, "http://localhost");
      let file = routes[pathname];

      if (!file) {
        for (const [prefix, dir] of Object.entries(mounts)) {
          if (!pathname.startsWith(prefix)) continue;
          const rel = pathname.slice(prefix.length).replace(/^\/+/, "");
          // Never let a request climb out of the mounted directory.
          const candidate = path.resolve(dir, rel);
          if (candidate.startsWith(path.resolve(dir))) file = candidate;
          break;
        }
      }
      if (!file) return res.writeHead(404).end("not found");

      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

/** Poll a URL until it answers, rather than sleeping a fixed guess. */
export async function waitFor(url, tries = 100) {
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

/**
 * Launch Chrome at a URL and hand back a connected CDP session.
 *
 * Returns `{ cdp, evaluate, front, dispose }`. Always call `dispose`.
 */
export async function launch({ url, cdpPort, windowSize = "1280,800" }) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vv-cdp-"));
  const chrome = spawn(
    findChrome(),
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      `--window-size=${windowSize}`,
      url,
    ],
    { stdio: "ignore" },
  );

  await waitFor(`http://127.0.0.1:${cdpPort}/json/version`);

  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    const list = await waitFor(`http://127.0.0.1:${cdpPort}/json/list`);
    target = list.find((t) => t.type === "page" && t.url.startsWith(url.split("?")[0]));
    if (!target) await new Promise((r) => setTimeout(r, 150));
  }
  if (!target) throw new Error("the page never appeared in the CDP target list");

  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  async function evaluate(expression) {
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

  /**
   * Bring the page to the front and wait until it is really visible.
   *
   * Anything stealing focus mid-run makes the tab hidden, which pauses rAF and
   * turns every later measurement into zeros. This is not optional politeness.
   */
  async function front() {
    await cdp.send("Page.bringToFront");
    for (let i = 0; i < 20 && (await evaluate("document.hidden")); i++) {
      await new Promise((r) => setTimeout(r, 250));
      await cdp.send("Page.bringToFront");
    }
    if (await evaluate("document.hidden")) {
      throw new Error("page is hidden — rAF is paused, measurements would be meaningless");
    }
  }

  return {
    cdp,
    evaluate,
    front,
    async dispose() {
      cdp.close();
      chrome.kill();
      await new Promise((r) => setTimeout(r, 400));
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* a locked temp profile is not worth failing a run over */
      }
    },
  };
}

/** Wait for a boolean expression to become true in the page. */
export async function until(evaluate, expression, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (await evaluate(expression)) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for: ${expression}`);
}

/** p-th percentile of an unsorted numeric array. */
export function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
