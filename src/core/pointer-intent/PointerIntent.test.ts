import { describe, it, expect, vi } from "vitest";
import { PointerIntent } from "./PointerIntent";

// Mock Conductor
let conductorCallbacks: ((dt: number, time: number) => void)[] = [];
vi.mock("../conductor", () => {
  return {
    getConductor: () => ({
      subscribe: (lane: string, fn: any) => {
        conductorCallbacks.push(fn);
        return () => {
          conductorCallbacks = conductorCallbacks.filter((c) => c !== fn);
        };
      },
    }),
  };
});

// Mock SensorBus state variables
const sensorState = {
  pointer: { seen: true, x: 0, y: 0, vx: 0, vy: 0, speed: 0, down: false },
  scroll: { x: 0, y: 0, vx: 0, vy: 0 },
  viewport: { width: 1024, height: 768, dpr: 1 },
};

let busRetains = 0;
let busReleases = 0;

vi.mock("../sensor-bus/SensorBus", () => {
  return {
    getSensorBus: () => ({
      retain: () => {
        busRetains++;
        return () => {
          busReleases++;
        };
      },
      get state() {
        return sensorState;
      },
    }),
  };
});

describe("PointerIntent", () => {
  it("gives no intent and 0 confidence on idle start", () => {
    const mockElement = {
      getBoundingClientRect: () => ({
        left: 100,
        top: 100,
        right: 200,
        bottom: 200,
        width: 100,
        height: 100,
      }),
    } as unknown as HTMLElement;

    conductorCallbacks = [];
    const p = new PointerIntent(mockElement);
    expect(conductorCallbacks).toHaveLength(1);

    expect(p.intent).toBe(false);
    expect(p.confidence).toBe(0);
    p.destroy();
  });

  it("gains intent when pointer enters the element bounding box", () => {
    const mockElement = {
      getBoundingClientRect: () => ({
        left: 100,
        top: 100,
        right: 200,
        bottom: 200,
        width: 100,
        height: 100,
      }),
    } as unknown as HTMLElement;

    conductorCallbacks = [];
    const p = new PointerIntent(mockElement);

    // Simulate mouse hover inside the box (inside x=150, y=150)
    sensorState.pointer = { seen: true, x: 150, y: 150, vx: 0, vy: 0, speed: 0, down: false };
    
    // Fire conductor frames to allow the confidence value to damp to 1
    for (let i = 0; i < 30; i++) {
      conductorCallbacks[0](0.016, i * 0.016);
    }

    expect(p.confidence).toBeGreaterThan(0.9);
    expect(p.intent).toBe(true);
    p.destroy();
  });

  it("gains intent when pointer is approaching the element on a trajectory", () => {
    const mockElement = {
      getBoundingClientRect: () => ({
        left: 100,
        top: 100,
        right: 200,
        bottom: 200,
        width: 100,
        height: 100,
      }),
    } as unknown as HTMLElement;

    conductorCallbacks = [];
    const p = new PointerIntent(mockElement, { enter: 0.3 });

    // Pointer is outside the box (at x=50, y=150) moving right (vx=400, vy=0) straight towards it
    sensorState.pointer = { seen: true, x: 50, y: 150, vx: 400, vy: 0, speed: 400, down: false };

    // Fire frames
    for (let i = 0; i < 30; i++) {
      conductorCallbacks[0](0.016, i * 0.016);
    }

    expect(p.confidence).toBeGreaterThan(0.35);
    expect(p.intent).toBe(true);
    p.destroy();
  });

  it("caches bounding client rect and avoids layout thrashing", () => {
    const mockElement = {
      getBoundingClientRect: vi.fn(() => ({
        left: 100,
        top: 100,
        right: 200,
        bottom: 200,
        width: 100,
        height: 100,
      })),
    } as unknown as HTMLElement;

    conductorCallbacks = [];
    const p = new PointerIntent(mockElement);
    expect(conductorCallbacks).toHaveLength(1);

    // Initial frame tick (time = 0.1)
    sensorState.pointer = { seen: true, x: 0, y: 0, vx: 0, vy: 0, speed: 0, down: false };
    sensorState.scroll = { x: 0, y: 0, vx: 0, vy: 0 };
    conductorCallbacks[0](0.016, 0.1);

    expect(mockElement.getBoundingClientRect).toHaveBeenCalledTimes(1);

    // Frame tick 2: pointer moves, but no scroll/resize/heartbeat (time = 0.2)
    sensorState.pointer = { seen: true, x: 10, y: 10, vx: 100, vy: 0, speed: 100, down: false };
    conductorCallbacks[0](0.016, 0.2);

    // getBoundingClientRect should NOT have been called again!
    expect(mockElement.getBoundingClientRect).toHaveBeenCalledTimes(1);

    // Frame tick 3: scroll changes (time = 0.3)
    sensorState.scroll = { x: 10, y: 0, vx: 100, vy: 0 };
    conductorCallbacks[0](0.016, 0.3);

    // getBoundingClientRect should be called again because scroll changed!
    expect(mockElement.getBoundingClientRect).toHaveBeenCalledTimes(2);

    // Frame tick 4: window resizes (time = 0.4)
    sensorState.viewport = { width: 1200, height: 768, dpr: 1 };
    conductorCallbacks[0](0.016, 0.4);

    expect(mockElement.getBoundingClientRect).toHaveBeenCalledTimes(3);

    // Frame tick 5: 1.5 seconds later (heartbeat check)
    conductorCallbacks[0](0.016, 2.0); // time = 2.0 (since last measure was at 0.4, 2.0 - 0.4 = 1.6 > 1.0)
    expect(mockElement.getBoundingClientRect).toHaveBeenCalledTimes(4);

    p.destroy();
  });
});

describe("PointerIntent — edge cases", () => {
  const rectEl = (rect: { left: number; top: number; right: number; bottom: number }) =>
    ({
      getBoundingClientRect: () => ({
        ...rect,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      }),
    }) as unknown as HTMLElement;

  const drive = (fn: (dt: number, time: number) => void, frames = 30, t0 = 0) => {
    for (let i = 0; i < frames; i++) fn(0.016, t0 + i * 0.016);
  };

  it("update() with partial options never clobbers the unspecified ones", () => {
    // Regression: a naive { ...opts, ...partial } spread would set enter to
    // undefined here, making `confidence > enter` always false so intent could
    // never be gained. The fix ignores undefined fields.
    conductorCallbacks = [];
    sensorState.pointer = { seen: true, x: 0, y: 0, vx: 0, vy: 0, speed: 0, down: false };
    sensorState.scroll = { x: 0, y: 0, vx: 0, vy: 0 };
    sensorState.viewport = { width: 1024, height: 768, dpr: 1 };

    const p = new PointerIntent(rectEl({ left: 100, top: 100, right: 200, bottom: 200 }), {
      enter: 0.3,
      exit: 0.1,
    });

    // A partial update that omits enter/exit — exactly what the React adapter
    // sends when a dev only passes { horizon }.
    p.update({ horizon: 0.9 });

    sensorState.pointer = { seen: true, x: 150, y: 150, vx: 0, vy: 0, speed: 0, down: false };
    drive(conductorCallbacks[0]);

    expect(p.confidence).toBeGreaterThan(0.9);
    expect(p.intent).toBe(true); // false if enter had been clobbered to undefined
    p.destroy();
  });

  it("loses intent when the pointer leaves (exit hysteresis)", () => {
    conductorCallbacks = [];
    const p = new PointerIntent(rectEl({ left: 100, top: 100, right: 200, bottom: 200 }));

    sensorState.pointer = { seen: true, x: 150, y: 150, vx: 0, vy: 0, speed: 0, down: false };
    drive(conductorCallbacks[0]);
    expect(p.intent).toBe(true);

    // Jump far away, stationary → target 0 → confidence decays below exit.
    sensorState.pointer = { seen: true, x: 900, y: 40, vx: 0, vy: 0, speed: 0, down: false };
    drive(conductorCallbacks[0]);
    expect(p.confidence).toBeLessThan(0.18);
    expect(p.intent).toBe(false);
    p.destroy();
  });

  it("aims at a moved element only after the rect cache is invalidated", () => {
    conductorCallbacks = [];
    sensorState.scroll = { x: 0, y: 0, vx: 0, vy: 0 };
    sensorState.viewport = { width: 1024, height: 768, dpr: 1 };

    let rect = { left: 100, top: 100, right: 200, bottom: 200 };
    const el = {
      getBoundingClientRect: () => ({
        ...rect,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      }),
    } as unknown as HTMLElement;

    const p = new PointerIntent(el);
    sensorState.pointer = { seen: true, x: 150, y: 150, vx: 0, vy: 0, speed: 0, down: false };
    conductorCallbacks[0](0.016, 0.1); // first measure at old position, pointer inside
    expect(p.confidence).toBeGreaterThan(0);

    // Element teleports right (no scroll, no resize). Pointer follows to it.
    rect = { left: 600, top: 100, right: 700, bottom: 200 };
    sensorState.pointer = { seen: true, x: 650, y: 150, vx: 0, vy: 0, speed: 0, down: false };

    // Within the 1s heartbeat window the cache is stale → reads as outside.
    drive(conductorCallbacks[0], 30, 0.12);
    expect(p.confidence).toBeLessThan(0.1);

    // Past the heartbeat the rect re-measures to the new spot → inside.
    drive(conductorCallbacks[0], 30, 1.2);
    expect(p.confidence).toBeGreaterThan(0.9);
    p.destroy();
  });

  it("unsubscribes and releases the bus on destroy, balanced per instance", () => {
    conductorCallbacks = [];
    busRetains = 0;
    busReleases = 0;

    const a = new PointerIntent(rectEl({ left: 0, top: 0, right: 10, bottom: 10 }));
    const b = new PointerIntent(rectEl({ left: 0, top: 0, right: 10, bottom: 10 }));
    expect(conductorCallbacks).toHaveLength(2);
    expect(busRetains).toBe(2);

    a.destroy();
    b.destroy();
    expect(conductorCallbacks).toHaveLength(0); // no leaked frame callbacks
    expect(busReleases).toBe(2); // retain/release balanced, no sensor-bus leak
  });

  it("dynamic mode tracks a moving element without waiting for the heartbeat", () => {
    conductorCallbacks = [];
    sensorState.scroll = { x: 0, y: 0, vx: 0, vy: 0 };
    sensorState.viewport = { width: 1024, height: 768, dpr: 1 };

    let rect = { left: 100, top: 100, right: 200, bottom: 200 };
    const el = {
      getBoundingClientRect: () => ({
        ...rect,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
      }),
    } as unknown as HTMLElement;

    const p = new PointerIntent(el, { dynamic: true });
    sensorState.pointer = { seen: true, x: 150, y: 150, vx: 0, vy: 0, speed: 0, down: false };
    drive(conductorCallbacks[0], 20, 0.02); // confidence climbs, active tracking engages
    expect(p.confidence).toBeGreaterThan(0.9);

    // Element translates; pointer rides along. No scroll, no resize, and well
    // inside the heartbeat window — only per-frame re-measure can stay locked on.
    rect = { left: 600, top: 100, right: 700, bottom: 200 };
    sensorState.pointer = { seen: true, x: 650, y: 150, vx: 0, vy: 0, speed: 0, down: false };
    drive(conductorCallbacks[0], 20, 0.4);
    expect(p.confidence).toBeGreaterThan(0.9); // stayed on the moved target
    p.destroy();
  });
});
