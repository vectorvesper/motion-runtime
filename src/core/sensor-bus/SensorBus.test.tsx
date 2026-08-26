// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * SensorBus — the one set of input listeners for the page.
 *
 * jsdom for window + events. rAF is stubbed and hand-cranked, and the module
 * is re-imported per test so the conductor and the bus are both fresh, the
 * same pattern the core conductor tests use.
 */

let rafCallback: FrameRequestCallback | null = null;
let rafId = 0;
let now = 0;

function crank(timeMs: number): void {
  now = timeMs;
  const cb = rafCallback;
  rafCallback = null;
  cb?.(timeMs);
}

async function freshBus() {
  vi.resetModules();
  const mod = await import("./SensorBus");
  return mod.getSensorBus();
}

function setScroll(x: number, y: number): void {
  Object.defineProperty(window, "scrollX", { value: x, configurable: true });
  Object.defineProperty(window, "scrollY", { value: y, configurable: true });
}

function movePointer(x: number, y: number): void {
  window.dispatchEvent(
    new PointerEvent("pointermove", { clientX: x, clientY: y }),
  );
}

beforeEach(() => {
  rafCallback = null;
  rafId = 0;
  now = 0;
  setScroll(0, 0);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallback = cb;
    return ++rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SensorBus lifecycle", () => {
  it("starts on the first retain and stops when the last consumer releases", async () => {
    const bus = await freshBus();
    const { getConductor } = await import("../conductor");

    expect(getConductor().state.subscribers).toHaveLength(0);

    const releaseA = bus.retain();
    const releaseB = bus.retain();
    expect(getConductor().state.subscribers).toHaveLength(1);

    releaseA();
    expect(getConductor().state.subscribers).toHaveLength(1);

    releaseB();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  it("ignores a release called twice, so one consumer cannot stop another's sensors", async () => {
    const bus = await freshBus();
    const { getConductor } = await import("../conductor");

    const releaseA = bus.retain();
    const releaseB = bus.retain();

    releaseA();
    releaseA();
    releaseA();

    expect(getConductor().state.subscribers).toHaveLength(1);
    releaseB();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  it("subscribes as essential on the input lane", async () => {
    const bus = await freshBus();
    const { getConductor } = await import("../conductor");

    bus.retain();
    const sub = getConductor().state.subscribers[0];

    // Shedding the sensors would feed the whole page stale input.
    expect(sub.label).toBe("SensorBus");
    expect(sub.priority).toBe("essential");
    expect(sub.lane).toBe("input");
  });

  it("detaches its window listeners on stop", async () => {
    const bus = await freshBus();
    const release = bus.retain();

    movePointer(100, 50);
    crank(16);
    expect(bus.state.pointer.x).toBe(100);

    release();
    movePointer(400, 400);
    expect(bus.state.pointer.x).toBe(100);
  });
});

describe("SensorBus pointer", () => {
  it("tracks position and reports zero velocity on first contact", async () => {
    const bus = await freshBus();
    bus.retain();

    movePointer(200, 120);
    crank(16);

    // History snaps on first sight, so the pointer does not appear to have
    // teleported from 0,0 at enormous speed.
    expect(bus.state.pointer.x).toBe(200);
    expect(bus.state.pointer.y).toBe(120);
    expect(bus.state.pointer.seen).toBe(true);
    expect(bus.state.pointer.speed).toBe(0);
  });

  it("builds velocity once the pointer actually moves", async () => {
    const bus = await freshBus();
    bus.retain();

    movePointer(0, 0);
    crank(16);
    movePointer(100, 0);
    crank(32);

    expect(bus.state.pointer.vx).toBeGreaterThan(0);
    expect(bus.state.pointer.speed).toBeGreaterThan(0);
  });

  it("tracks the pressed state", async () => {
    const bus = await freshBus();
    bus.retain();

    expect(bus.state.pointer.down).toBe(false);
    window.dispatchEvent(new PointerEvent("pointerdown"));
    expect(bus.state.pointer.down).toBe(true);
    window.dispatchEvent(new PointerEvent("pointerup"));
    expect(bus.state.pointer.down).toBe(false);

    window.dispatchEvent(new PointerEvent("pointerdown"));
    window.dispatchEvent(new PointerEvent("pointercancel"));
    expect(bus.state.pointer.down).toBe(false);
  });
});

describe("SensorBus scroll and viewport", () => {
  it("reads scroll per frame, so a programmatic scroll is caught", async () => {
    const bus = await freshBus();
    bus.retain();

    // No scroll listener exists. Position is read on the frame instead, which
    // is what makes a scroll nothing fired an event for still register.
    setScroll(0, 500);
    crank(16);

    expect(bus.state.scroll.y).toBe(500);
  });

  it("syncs viewport size and dpr on the frame", async () => {
    const bus = await freshBus();
    bus.retain();

    Object.defineProperty(window, "devicePixelRatio", {
      value: 3,
      configurable: true,
    });
    crank(16);

    expect(bus.state.viewport.width).toBe(window.innerWidth);
    expect(bus.state.viewport.height).toBe(window.innerHeight);
    expect(bus.state.viewport.dpr).toBe(3);
  });
});

describe("SensorBus state hygiene", () => {
  it("clears every velocity on stop, not just the pointer's", async () => {
    const bus = await freshBus();
    const release = bus.retain();

    movePointer(0, 0);
    setScroll(0, 0);
    crank(16);
    movePointer(200, 200);
    setScroll(0, 900);
    crank(32);

    expect(bus.state.pointer.speed).toBeGreaterThan(0);
    expect(bus.state.scroll.vy).not.toBe(0);

    release();

    // A stopped bus reporting live velocity is a stale reading that anything
    // reading `.state` will believe.
    expect(bus.state.pointer.vx).toBe(0);
    expect(bus.state.pointer.vy).toBe(0);
    expect(bus.state.pointer.speed).toBe(0);
    expect(bus.state.scroll.vx).toBe(0);
    expect(bus.state.scroll.vy).toBe(0);
  });

  it("does not invent a velocity spike when restarted after the pointer moved away", async () => {
    const bus = await freshBus();
    const release = bus.retain();

    movePointer(0, 0);
    crank(16);
    release();

    // While stopped there are no listeners, so the bus never saw the pointer
    // travel. On restart it must not treat the jump as movement.
    const restart = bus.retain();
    movePointer(1200, 800);
    crank(48);

    expect(bus.state.pointer.speed).toBe(0);
    restart();
  });

  it("survives a zero-length frame without poisoning velocity with NaN", async () => {
    const bus = await freshBus();
    bus.retain();

    movePointer(10, 10);
    crank(16);
    // Two frames on the same timestamp make dt 0. The conductor clamps dt at
    // the top but has no floor, and velocity here is a division by dt.
    crank(16);

    expect(Number.isFinite(bus.state.pointer.vx)).toBe(true);
    expect(Number.isFinite(bus.state.pointer.speed)).toBe(true);
    expect(Number.isFinite(bus.state.scroll.vy)).toBe(true);
  });
});
