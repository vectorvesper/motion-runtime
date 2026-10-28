// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * MagneticElement.
 *
 * Covered through `useMagneticIntent` until now, which meant the two things
 * that actually matter here were only checked indirectly: it borrows an
 * element's inline transform, and it holds three subscriptions. Both are the
 * kind of thing that looks fine on screen and leaks.
 */

let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafId = 0;
let now = 0;

function crank(timeMs: number): void {
  now = timeMs;
  const pending = [...rafCallbacks.values()];
  rafCallbacks = new Map();
  for (const cb of pending) cb(timeMs);
}

function crankFrames(count: number): void {
  for (let i = 0; i < count; i++) crank(now + 16);
}

async function fresh() {
  vi.resetModules();
  const mod = await import("./MagneticElement");
  const core = await import("../conductor");
  return { ...mod, getConductor: core.getConductor };
}

function target(): HTMLButtonElement {
  const el = document.createElement("button");
  el.getBoundingClientRect = () =>
    ({ left: 100, top: 100, right: 200, bottom: 150, width: 100, height: 50, x: 100, y: 100 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafId = 0;
  now = 0;
  document.body.innerHTML = "";
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => rafCallbacks.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("MagneticElement — borrowing the transform", () => {
  it("gives back exactly what it found", async () => {
    const { MagneticElement } = await fresh();
    const el = target();
    el.style.transform = "rotate(45deg)";

    const magnet = new MagneticElement(el);
    crankFrames(4);
    magnet.destroy();

    // A page that set its own transform has to get it back untouched — this
    // hook owns the property while it is alive, not forever.
    expect(el.style.transform).toBe("rotate(45deg)");
  });

  it("leaves an element that had no transform without one", async () => {
    const { MagneticElement } = await fresh();
    const el = target();

    const magnet = new MagneticElement(el);
    crankFrames(4);
    magnet.destroy();

    // Handing back an empty string is not the same as handing back
    // `translate3d(0,0,0)`, which would beat a later CSS rule.
    expect(el.style.transform).toBe("");
  });
});

describe("MagneticElement — lifecycle", () => {
  it("takes an input pass and a render pass, and gives both back", async () => {
    const { MagneticElement, getConductor } = await fresh();
    const el = target();

    const magnet = new MagneticElement(el);
    crankFrames(2);
    const labels = getConductor().state.subscribers.map((s) => s.label);

    // Reads on input, writes on render. Doing both in one pass is what makes
    // ten of these on a page thrash layout.
    expect(labels).toContain("MagneticElement(measure)");
    expect(labels).toContain("MagneticElement");

    magnet.destroy();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  it("survives being destroyed twice", async () => {
    const { MagneticElement } = await fresh();
    const magnet = new MagneticElement(target());
    magnet.destroy();
    expect(() => magnet.destroy()).not.toThrow();
  });

  it("releases the sensor bus it retained", async () => {
    const { MagneticElement, getConductor } = await fresh();

    const a = new MagneticElement(target());
    const b = new MagneticElement(target());
    crankFrames(2);

    a.destroy();
    // Ref-counted, so one of two letting go must not stop the sensors.
    expect(getConductor().state.subscribers.length).toBeGreaterThan(0);

    b.destroy();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });
});

describe("MagneticElement — anticipation", () => {
  it("builds an approach detector by default", async () => {
    const { MagneticElement, getConductor } = await fresh();
    const magnet = new MagneticElement(target());
    crankFrames(2);

    const count = getConductor().state.subscribers.length;
    magnet.destroy();

    const bare = new MagneticElement(target(), { anticipate: false });
    crankFrames(2);
    const bareCount = getConductor().state.subscribers.length;
    bare.destroy();

    // The detector is its own subscriber, so turning it off costs less.
    expect(count).toBeGreaterThan(bareCount);
  });

  it("can be turned on and off after construction", async () => {
    const { MagneticElement, getConductor } = await fresh();
    const magnet = new MagneticElement(target(), { anticipate: false });
    crankFrames(2);
    const off = getConductor().state.subscribers.length;

    // This used to be read only in the constructor, so changing it later
    // silently did nothing.
    magnet.update({ anticipate: true });
    crankFrames(2);
    expect(getConductor().state.subscribers.length).toBeGreaterThan(off);

    magnet.update({ anticipate: false });
    crankFrames(2);
    expect(getConductor().state.subscribers.length).toBe(off);

    magnet.destroy();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });
});

describe("MagneticElement — off screen", () => {
  // What the magnet writes at rest: no offset, no scale.
  const REST = "translate3d(0.00px, 0.00px, 0) scale(1.0000)";

  const move = (x: number, y: number) =>
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: x, clientY: y }));

  /** Move the pointer in a straight line, one event per frame, and return every transform written. */
  function sweep(el: HTMLElement, from: { x: number; y: number }, to: { x: number; y: number }, frames: number): string[] {
    const seen: string[] = [];
    for (let i = 1; i <= frames; i++) {
      const k = i / frames;
      move(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k);
      crank(now + 16);
      seen.push(el.style.transform);
    }
    return seen;
  }

  it("pulls a button on screen when the pointer comes close", async () => {
    const { MagneticElement } = await fresh();
    const el = target();
    const magnet = new MagneticElement(el, { reach: 120 });
    crankFrames(2);

    const seen = sweep(el, { x: 400, y: 400 }, { x: 160, y: 130 }, 20);
    magnet.destroy();

    expect(seen.some((t) => t !== REST)).toBe(true);
  });

  it("leaves a button scrolled out of view at rest, even with the pointer racing towards it", async () => {
    // RB-5: the lab saw a magnetic button 15 to 31 transform writes a second
    // while scrolled away. Its approach detector projected a fast pointer up
    // to 0.8s ahead, past the edge of the screen, onto the button. jsdom's
    // viewport is 1024 x 768; this button sits 630px below it.
    const { MagneticElement } = await fresh();
    const el = document.createElement("button");
    el.getBoundingClientRect = () =>
      ({ left: 450, top: 1400, right: 550, bottom: 1450, width: 100, height: 50, x: 450, y: 1400 }) as DOMRect;
    document.body.appendChild(el);
    const magnet = new MagneticElement(el, { reach: 120 });
    crankFrames(2);

    const seen: string[] = [];
    for (let k = 0; k < 4; k++) {
      seen.push(...sweep(el, { x: 500, y: 40 }, { x: 500, y: 760 }, 8));
      seen.push(...sweep(el, { x: 500, y: 760 }, { x: 500, y: 40 }, 8));
    }
    // Then parked at the bottom edge, as close as a pointer can get.
    seen.push(...sweep(el, { x: 500, y: 760 }, { x: 500, y: 767 }, 30));
    magnet.destroy();

    expect([...new Set(seen)]).toEqual([REST]);
  });
});
