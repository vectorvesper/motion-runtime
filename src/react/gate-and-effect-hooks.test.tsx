// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup, act } from "@testing-library/react";

/**
 * The mount gate (useSafeToMount), the interaction adapter
 * (usePointerIntent), and the self-contained effects (useNumberTicker,
 * useImageTrail, useVideoScrubber).
 *
 * The recurring defect across this catalogue is lifecycle, not maths — work
 * that outlives its component, or a gate that never opens. So the contract
 * tested here is: does it start, does it open when it should, and does it let
 * go of everything on unmount.
 */

let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafId = 0;
let now = 0;
let idleCallbacks: Array<() => void> = [];
let observers: StubObserver[] = [];

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

/** Run n frames at a healthy 60Hz cadence. */
function crankFrames(count: number): void {
  for (let i = 0; i < count; i++) crank(now + 16);
}

function flushIdle(): void {
  const pending = idleCallbacks;
  idleCallbacks = [];
  for (const cb of pending) cb();
}

function intersect(): void {
  for (const o of observers) {
    o.callback(
      o.observed.map((target) => ({ isIntersecting: true, target })) as
        unknown as IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
  }
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafId = 0;
  now = 0;
  idleCallbacks = [];
  observers = [];

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafCallbacks.delete(id);
  });
  vi.spyOn(performance, "now").mockImplementation(() => now);

  // Neither of these exists in jsdom.
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
    idleCallbacks.push(cb);
    return idleCallbacks.length;
  });
  vi.stubGlobal("cancelIdleCallback", () => {});
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observed: Element[] = [];
      disconnected = false;
      constructor(public callback: IntersectionObserverCallback) {
        observers.push(this as unknown as StubObserver);
      }
      observe(el: Element) {
        this.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
      takeRecords() {
        return [];
      }
    },
  );
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSafeToMount", () => {
  it("starts closed, so the server and the first client render agree", async () => {
    vi.resetModules();
    const { useSafeToMount } = await import("./useSafeToMount");

    let safe = true;
    function Gate() {
      safe = useSafeToMount();
      return null;
    }

    render(<Gate />);
    // The server has no frame timings. Opening on the first render would be a
    // hydration mismatch every time.
    expect(safe).toBe(false);
  });

  it("opens once the loop has sustained enough clean frames", async () => {
    vi.resetModules();
    const { useSafeToMount } = await import("./useSafeToMount");

    let safe = false;
    function Gate() {
      safe = useSafeToMount({ cost: "light" });
      return null;
    }

    render(<Gate />);
    await act(async () => {
      crankFrames(6);
    });

    expect(safe).toBe(true);
  });

  it("never closes again once it has opened", async () => {
    vi.resetModules();
    const { useSafeToMount } = await import("./useSafeToMount");

    let safe = false;
    function Gate() {
      safe = useSafeToMount({ cost: "light" });
      return null;
    }

    render(<Gate />);
    await act(async () => {
      crankFrames(5);
    });
    expect(safe).toBe(true);

    // Something expensive that unmounted itself the moment it made the page
    // slow would oscillate forever, so the gate is one-way by design.
    await act(async () => {
      crank(now + 400);
      crank(now + 400);
      crank(now + 400);
    });
    expect(safe).toBe(true);
  });

  it("gives up permanently on a machine below the core floor", async () => {
    // Cores never improve while the page is open, so this is the one
    // condition that legitimately ends the story early.
    vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(1);
    vi.resetModules();
    const { useSafeToMount } = await import("./useSafeToMount");
    const { getConductor } = await import("../core/conductor");

    let safe = true;
    function Gate() {
      safe = useSafeToMount({ cost: "heavy" });
      return null;
    }

    render(<Gate />);
    await act(async () => {
      crankFrames(10);
    });

    expect(safe).toBe(false);
    // And it must not have left the governor running to find that out.
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });

  it("lets a light mount through on hardware that blocks a heavy one", async () => {
    // Two cores clears "light" and fails "normal" and "heavy".
    vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(2);
    vi.resetModules();
    const { useSafeToMount } = await import("./useSafeToMount");

    let light = false;
    let heavy = true;
    function Gate() {
      light = useSafeToMount({ cost: "light" });
      heavy = useSafeToMount({ cost: "heavy" });
      return null;
    }

    render(<Gate />);
    await act(async () => {
      crankFrames(6);
    });

    expect(light).toBe(true);
    expect(heavy).toBe(false);
  });

  it("releases the governor and its frame subscription on unmount", async () => {
    vi.resetModules();
    const { useSafeToMount } = await import("./useSafeToMount");
    const { getConductor } = await import("../core/conductor");

    function Gate() {
      useSafeToMount({ cost: "light" });
      return null;
    }

    const view = render(<Gate />);
    await act(async () => {
      crankFrames(2);
    });
    expect(getConductor().getStats().subscribers.length).toBeGreaterThan(0);

    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});

describe("usePointerIntent", () => {
  it("reports no intent before the pointer has done anything", async () => {
    vi.resetModules();
    const { usePointerIntent } = await import("./usePointerIntent");

    let intent = true;
    function Card() {
      const pointer = usePointerIntent<HTMLDivElement>();
      intent = pointer.intent;
      return <div ref={pointer.ref} />;
    }

    render(<Card />);
    await act(async () => {
      crankFrames(2);
    });
    expect(intent).toBe(false);
  });

  it("exposes confidence through a ref rather than state", async () => {
    vi.resetModules();
    const { usePointerIntent } = await import("./usePointerIntent");

    let confidence: React.RefObject<number> | null = null;
    function Card() {
      const pointer = usePointerIntent<HTMLDivElement>();
      confidence = pointer.confidenceRef;
      return <div ref={pointer.ref} />;
    }

    render(<Card />);
    await act(async () => {
      crankFrames(2);
    });

    // A confidence that re-rendered every frame would be the thing it exists
    // to avoid.
    expect(typeof confidence!.current).toBe("number");
  });

  it("tears down its mirror subscription on unmount", async () => {
    vi.resetModules();
    const { usePointerIntent } = await import("./usePointerIntent");
    const { getConductor } = await import("../core/conductor");

    function Card() {
      const pointer = usePointerIntent<HTMLDivElement>();
      return <div ref={pointer.ref} />;
    }

    const view = render(<Card />);
    await act(async () => {
      crankFrames(2);
    });

    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});

describe("useNumberTicker", () => {
  it("writes through the DOM node instead of re-rendering", async () => {
    vi.resetModules();
    const { useNumberTicker } = await import("./useNumberTicker");

    let renders = 0;
    function Score({ value }: { value: number }) {
      renders++;
      const { ref } = useNumberTicker<HTMLSpanElement>(value);
      return <span ref={ref} />;
    }

    const view = render(<Score value={0} />);
    const before = renders;

    view.rerender(<Score value={5000} />);
    await act(async () => {
      crankFrames(10);
    });

    // Ten frames of animation must not be ten React renders.
    expect(renders).toBe(before + 1);
    expect(view.container.querySelector("span")!.textContent).not.toBe("");
  });

  it("unsubscribes on unmount", async () => {
    vi.resetModules();
    const { useNumberTicker } = await import("./useNumberTicker");
    const { getConductor } = await import("../core/conductor");

    function Score() {
      const { ref } = useNumberTicker<HTMLSpanElement>(42);
      return <span ref={ref} />;
    }

    const view = render(<Score />);
    await act(async () => {
      crankFrames(2);
    });

    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});

describe("useImageTrail", () => {
  it("cleans up everything it added on unmount", async () => {
    vi.resetModules();
    const { useImageTrail } = await import("./useImageTrail");
    const { getConductor } = await import("../core/conductor");

    function Trail() {
      const { ref } = useImageTrail<HTMLDivElement>({
        images: ["/a.png", "/b.png"],
      });
      return <div ref={ref} />;
    }

    const view = render(<Trail />);
    await act(async () => {
      crankFrames(3);
    });

    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});

describe("useVideoScrubber", () => {
  it("hands back refs and holds progress outside React state", async () => {
    vi.resetModules();
    const { useVideoScrubber } = await import("./useVideoScrubber");

    let progress: React.RefObject<number> | null = null;
    function Scrubber() {
      const scrub = useVideoScrubber<HTMLDivElement>();
      progress = scrub.progressRef;
      return (
        <div ref={scrub.trackRef}>
          <video ref={scrub.videoRef} />
        </div>
      );
    }

    render(<Scrubber />);
    await act(async () => {
      crankFrames(2);
    });

    expect(typeof progress!.current).toBe("number");
  });

  it("releases its frame work on unmount", async () => {
    vi.resetModules();
    const { useVideoScrubber } = await import("./useVideoScrubber");
    const { getConductor } = await import("../core/conductor");

    function Scrubber() {
      const scrub = useVideoScrubber<HTMLDivElement>();
      return (
        <div ref={scrub.trackRef}>
          <video ref={scrub.videoRef} />
        </div>
      );
    }

    const view = render(<Scrubber />);
    await act(async () => {
      crankFrames(2);
    });

    view.unmount();
    expect(getConductor().getStats().subscribers).toHaveLength(0);
  });
});
