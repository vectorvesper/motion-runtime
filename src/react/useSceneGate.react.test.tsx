// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup, act } from "@testing-library/react";

/**
 * The scene gate as a React hook.
 *
 * `useSceneGate.test.ts` covers `decide()`, which is the rule. This covers the
 * wiring around it: the visibility observer, the don't-mount-mid-scroll wait,
 * and letting go of both on unmount. Most of this behaviour arrived here when
 * useLazyScene was deleted, so these tests came with it.
 */

let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafId = 0;
let now = 0;
let observers: StubObserver[] = [];
let scrollSpeed = 0;

interface StubObserver {
  callback: IntersectionObserverCallback;
  observed: Element[];
  disconnected: boolean;
}

function crank(timeMs: number): void {
  now = timeMs;
  const pending = [...rafCallbacks.values()];
  rafCallbacks = new Map();
  for (const cb of pending) cb(timeMs);
}

function crankFrames(count: number): void {
  for (let i = 0; i < count; i++) crank(now + 16);
}

function intersect(is: boolean): void {
  for (const o of observers) {
    o.callback(
      o.observed.map((target) => ({ isIntersecting: is, target })) as
        unknown as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
  }
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafId = 0;
  now = 0;
  observers = [];
  scrollSpeed = 0;

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => rafCallbacks.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observed: Element[] = [];
      disconnected = false;
      constructor(public callback: IntersectionObserverCallback) {
        observers.push(this as unknown as StubObserver);
      }
      observe(el: Element) { this.observed.push(el); }
      unobserve() {}
      disconnect() { this.disconnected = true; }
      takeRecords() { return []; }
    },
  );
  // jsdom has no WebGL2, so the device probe would correctly rate every test
  // machine as the bottom tier and every scene as a poster. Give it a GPU.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) =>
      kind === "webgl2"
        ? {
            getExtension: () => null,
            getParameter: () => "Test GPU",
          }
        : null) as never,
  );
  vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(8);

  // The gate reads scroll velocity off the sensor bus to decide whether the
  // page is still. jsdom never scrolls, so it is driven directly.
  Object.defineProperty(window, "scrollY", {
    get: () => (now / 16) * scrollSpeed * 0.016,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountGate() {
  vi.resetModules();
  const { useSceneGate } = await import("./useSceneGate");
  const seen: string[] = [];
  function Scene() {
    const gate = useSceneGate<HTMLDivElement>({ cost: "light" });
    seen.push(gate.state);
    return <div ref={gate.ref} data-mounted={String(gate.mounted)} />;
  }
  const view = render(<Scene />);
  return { view, seen, last: () => seen[seen.length - 1] };
}

describe("useSceneGate — coming into view", () => {
  it("starts dormant, before anything is known", async () => {
    const { last } = await mountGate();
    expect(last()).toBe("dormant");
  });

  it("warms once near, then runs once the page can afford it", async () => {
    const { last } = await mountGate();

    await act(async () => intersect(true));
    expect(last()).toBe("warming");

    await act(async () => crankFrames(8));
    expect(last()).toBe("active");
  });

  it("observes the element it was given", async () => {
    await mountGate();
    expect(observers).toHaveLength(1);
    expect(observers[0].observed[0]).toBeInstanceOf(HTMLElement);
  });
});

describe("useSceneGate — scrolling past", () => {
  it("pauses rather than unmounting, and comes back", async () => {
    const { last } = await mountGate();

    await act(async () => intersect(true));
    await act(async () => crankFrames(8));
    expect(last()).toBe("active");

    await act(async () => intersect(false));
    // Still mounted. Tearing the scene down here would throw away a WebGL
    // context and every texture on it.
    expect(last()).toBe("idle");

    await act(async () => intersect(true));
    expect(last()).toBe("active");
  });
});

describe("useSceneGate — letting go", () => {
  it("disconnects the observer and drops its frame work on unmount", async () => {
    vi.resetModules();
    const { useSceneGate } = await import("./useSceneGate");
    const { getConductor } = await import("../core/conductor");

    function Scene() {
      const gate = useSceneGate<HTMLDivElement>({ cost: "light" });
      return <div ref={gate.ref} />;
    }

    const view = render(<Scene />);
    await act(async () => {
      intersect(true);
      crankFrames(8);
    });

    view.unmount();
    expect(observers.every((o) => o.disconnected)).toBe(true);
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});
