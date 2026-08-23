/**
 * What does a MessageChannel task actually wait for?
 *
 *   node scripts/pressure-probe/scheduling-check.mjs
 *
 * FramePressure assumes a message posted from inside a rAF callback is
 * delivered only once the main thread has finished the frame — later rAF
 * callbacks included. The first real-browser run contradicted that: a page
 * with a competing rAF burning 24ms reported a 0.7ms tail.
 *
 * Rather than guessing at a fix, this measures the ordering directly.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CDP_PORT = 9413;
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
].find((p) => fs.existsSync(p));

const EXPERIMENT = `
new Promise((done) => {
  const results = [];
  let frames = 0;

  const burn = (ms) => {
    const end = performance.now() + ms;
    let x = 0;
    while (performance.now() < end) x += Math.sqrt(x + 1);
    return x;
  };

  const ch = new MessageChannel();
  let postedAt = 0;
  let sawMessage = 0;
  ch.port1.onmessage = () => { sawMessage = performance.now(); };
  ch.port1.start();

  // rAF A — registered FIRST, so it runs first each frame. Posts the probe.
  const tickA = () => {
    if (frames >= 30) {
      done({
        samples: results.length,
        medianTail: results.slice().sort((a,b)=>a-b)[Math.floor(results.length/2)],
        tails: results.slice(0, 8).map((v) => +v.toFixed(2)),
      });
      return;
    }
    frames++;
    if (sawMessage) results.push(sawMessage - postedAt);
    sawMessage = 0;
    postedAt = performance.now();
    ch.port2.postMessage(null);
    requestAnimationFrame(tickA);
  };

  // rAF B — registered SECOND, burns 24ms. If the task waits for the whole
  // frame, the measured tail should be about 24ms. If it does not, it will be
  // near zero.
  const tickB = () => { burn(24); requestAnimationFrame(tickB); };

  requestAnimationFrame(tickA);
  requestAnimationFrame(tickB);
});
`;

async function waitFor(url, tries = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out: ${url}`);
}

function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let id = 0;
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    const e = pending.get(m.id);
    if (!e) return;
    pending.delete(m.id);
    m.error ? e.reject(new Error(m.error.message)) : e.resolve(m.result);
  });
  const ready = new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  return {
    ready,
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const mid = ++id;
        pending.set(mid, { resolve, reject });
        ws.send(JSON.stringify({ id: mid, method, params }));
      }),
    close: () => ws.close(),
  };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vv-sched-"));
const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-renderer-backgrounding",
    "--window-size=900,600",
    "about:blank",
  ],
  { stdio: "ignore" },
);

let cdp = null;
try {
  await waitFor(`http://127.0.0.1:${CDP_PORT}/json/version`);
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    const list = await waitFor(`http://127.0.0.1:${CDP_PORT}/json/list`);
    target = list.find((t) => t.type === "page");
    if (!target) await new Promise((r) => setTimeout(r, 150));
  }
  cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send("Runtime.enable");

  const res = await cdp.send("Runtime.evaluate", {
    expression: EXPERIMENT,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description);

  const v = res.result.value;
  console.log(`samples      : ${v.samples}`);
  console.log(`median tail  : ${v.medianTail?.toFixed(2)} ms`);
  console.log(`first tails  : ${v.tails.join(", ")}`);
  console.log("");
  console.log(
    v.medianTail > 15
      ? "→ The task DOES wait for the rest of the frame. Posting from the last\n" +
        "  lane is enough, and the original model was right."
      : "→ The task does NOT wait for later rAF callbacks. mainTailMs cannot be\n" +
        "  measured this way, and the classifier needs a different signal.",
  );
} finally {
  cdp?.close();
  chrome.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
}
