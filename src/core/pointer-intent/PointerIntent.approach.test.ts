// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * PointerIntent against a real approach, end to end.
 *
 * PointerIntent.test.ts mocks the conductor and hands the sensor bus a fixed
 * velocity, which checks the geometry and nothing else. The lateness vv-lab
 * measured (R8: firing 131–357ms after the pointer would have arrived, or not
 * at all) lives in what those mocks skip: the bus deriving a velocity from
 * pointer events that land between frames, and the confidence smoothing on top
 * of it. So this drives the real conductor, the real bus and the real
 * PointerIntent with pointermove events on the lab probe's own schedule, and
 * measures when intent fires against when the pointer would have reached the
 * element.
 *
 * The hook promises to know the pointer is coming "100–300ms before it
 * arrives". 100ms is the floor asserted here.
 */

let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafId = 0;
let now = 0;

beforeEach(() => {
  rafCallbacks = new Map();
  rafId = 0;
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const FRAME_MS = 1000 / 60;

type Point = { x: number; y: number };
type Sensitivity = "low" | "normal" | "high";

/** A pill-shaped call to action, the size of the lab's "Start a project". */
const BUTTON = { cx: 700, cy: 400, w: 160, h: 44 };
const RECT = {
  left: BUTTON.cx - BUTTON.w / 2,
  right: BUTTON.cx + BUTTON.w / 2,
  top: BUTTON.cy - BUTTON.h / 2,
  bottom: BUTTON.cy + BUTTON.h / 2,
};

/**
 * The lab's `intent-prefetch` approach (probes/dom-probes.mjs), in the same
 * geometry: from 520px left and 220px below the centre, straight at it, 22
 * pointer events over 450ms, stopping 110px short of the edge. `arrivalMs` is
 * computed exactly as the probe computes it: when the pointer would have
 * reached the button's edge had it kept its speed.
 */
function labApproach(): { from: Point; to: Point; ms: number; steps: number; arrivalMs: number } {
  const from = { x: BUTTON.cx - 520, y: BUTTON.cy + 220 };
  const dx = BUTTON.cx - from.x;
  const dy = BUTTON.cy - from.y;
  const len = Math.hypot(dx, dy);
  const short = BUTTON.w / 2 + 110;
  const to = { x: BUTTON.cx - (dx / len) * short, y: BUTTON.cy - (dy / len) * short };
  const speed = (len - short) / 450;
  return { from, to, ms: 450, steps: 22, arrivalMs: Math.round((len - BUTTON.w / 2) / speed) };
}

/**
 * Replay a move and report when intent first fired, in ms from the start of the
 * move, or null if it never did. Pointer events go out on the probe's cadence
 * (dispatch, then wait ms/steps) and frames run at 60Hz, each seeing whatever
 * events landed since the last one, as a browser would.
 */
async function replay(
  path: { from: Point; to: Point; ms: number; steps: number },
  sensitivity: Sensitivity,
  tailMs = 1200,
): Promise<number | null> {
  vi.resetModules();
  const { PointerIntent } = await import("./PointerIntent");
  const el = {
    getBoundingClientRect: () => ({
      ...RECT,
      x: RECT.left,
      y: RECT.top,
      width: RECT.right - RECT.left,
      height: RECT.bottom - RECT.top,
    }),
  } as unknown as HTMLElement;

  const frameAt = (time: number) => {
    now = time;
    const pending = [...rafCallbacks.values()];
    rafCallbacks = new Map();
    for (const cb of pending) cb(time);
  };
  const move = (p: Point) => window.dispatchEvent(new MouseEvent("pointermove", { clientX: p.x, clientY: p.y }));

  const start = 2000;
  let firedAt: number | null = null;
  const intent = new PointerIntent(el, { sensitivity }, (on) => {
    if (on && firedAt === null) firedAt = Math.round(now - start);
  });

  // Park the pointer at the start and let everything settle, as the probe does.
  let t = 1000;
  now = t;
  move(path.from);
  for (; t < start; t += FRAME_MS) frameAt(t);

  const events = Array.from({ length: path.steps }, (_, i) => {
    const k = (i + 1) / path.steps;
    return {
      at: start + (path.ms * i) / path.steps,
      p: { x: path.from.x + (path.to.x - path.from.x) * k, y: path.from.y + (path.to.y - path.from.y) * k },
    };
  });
  let next = 0;
  for (; t < start + path.ms + tailMs; t += FRAME_MS) {
    while (next < events.length && events[next].at <= t) move(events[next++].p);
    frameAt(t);
  }

  intent.destroy();
  // `VV_REPORT=1 npx vitest run PointerIntent.approach` prints the numbers.
  // Read through globalThis: the package's typecheck carries no Node types.
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env;
  if (env?.VV_REPORT) {
    const arrival = (path as { arrivalMs?: number }).arrivalMs;
    console.info(
      `[${sensitivity}] ${path.ms}ms move: fired at ${firedAt ?? "never"}` +
        (arrival !== undefined && firedAt !== null ? `, arrival ${arrival}ms, lead ${arrival - firedAt}ms` : ""),
    );
  }
  return firedAt;
}

describe("PointerIntent — a real approach", () => {
  it("knows at least 100ms ahead on the lab's fast, direct approach", async () => {
    const path = labApproach();
    const firedAt = await replay(path, "normal");

    expect(firedAt, "never fired").not.toBeNull();
    expect(path.arrivalMs - firedAt!, `fired at ${firedAt}ms, arrival at ${path.arrivalMs}ms`).toBeGreaterThanOrEqual(100);
  });

  it("knows ahead at high sensitivity too, and no later than at normal", async () => {
    const path = labApproach();
    const high = await replay(path, "high");
    const normal = await replay(path, "normal");

    expect(high, "never fired").not.toBeNull();
    expect(path.arrivalMs - high!, `fired at ${high}ms, arrival at ${path.arrivalMs}ms`).toBeGreaterThanOrEqual(100);
    if (normal !== null) expect(high!).toBeLessThanOrEqual(normal);
  });

  it("knows ahead on an approach that goes all the way to the button", async () => {
    const lab = labApproach();
    // Same line and speed, continued onto the button's centre.
    const len = Math.hypot(BUTTON.cx - lab.from.x, BUTTON.cy - lab.from.y);
    const ms = Math.round((len / Math.hypot(lab.to.x - lab.from.x, lab.to.y - lab.from.y)) * lab.ms);
    const firedAt = await replay({ from: lab.from, to: { x: BUTTON.cx, y: BUTTON.cy }, ms, steps: Math.round(ms / (450 / 22)) }, "normal");

    expect(firedAt, "never fired").not.toBeNull();
    expect(lab.arrivalMs - firedAt!, `fired at ${firedAt}ms, arrival at ${lab.arrivalMs}ms`).toBeGreaterThanOrEqual(100);
  });

  it("stays quiet for a pointer passing by", async () => {
    // Parallel to the button, 120px below it, at the same speed.
    const y = RECT.bottom + 120;
    const firedAt = await replay({ from: { x: BUTTON.cx - 500, y }, to: { x: BUTTON.cx + 500, y }, ms: 1200, steps: 58 }, "normal");

    expect(firedAt).toBeNull();
  });

  it("stays quiet for a pointer moving away", async () => {
    const firedAt = await replay(
      { from: { x: RECT.left - 60, y: BUTTON.cy + 60 }, to: { x: RECT.left - 440, y: BUTTON.cy + 220 }, ms: 450, steps: 22 },
      "normal",
    );

    expect(firedAt).toBeNull();
  });
});
