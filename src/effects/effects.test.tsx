// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup, act } from "@testing-library/react";

/**
 * The self-contained effects.
 *
 * The recurring defect across this catalogue is lifecycle, not maths — work
 * that outlives its component. So the contract tested here is: does it start,
 * and does it let go of everything on unmount.
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
    expect(getConductor().state.subscribers).toHaveLength(0);
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
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  /**
   * R4 in vv-lab's findings. After landing, the subscription stayed and every
   * frame assigned the same text again, for the life of the page: 105 text
   * writes a second on a page of three counters with nothing moving, and 180
   * for an agent's integration of the same page.
   */
  it("stops ticking once it lands", async () => {
    vi.resetModules();
    const { useNumberTicker } = await import("./useNumberTicker");
    const { getConductor } = await import("../core/conductor");

    function Score() {
      const { ref } = useNumberTicker<HTMLSpanElement>(42);
      return <span ref={ref} />;
    }

    const view = render(<Score />);
    await act(async () => {
      crankFrames(150);
    });

    expect(view.container.querySelector("span")!.textContent).toBe("42");
    // Still mounted, and nothing of it left on the loop.
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  it("writes nothing to the page once it has landed", async () => {
    vi.resetModules();
    const { useNumberTicker } = await import("./useNumberTicker");

    function Score() {
      const { ref } = useNumberTicker<HTMLSpanElement>(42);
      return <span ref={ref} />;
    }

    const view = render(<Score />);
    await act(async () => {
      crankFrames(150);
    });

    // What the lab's dom-rest probe watches for: a text write while nothing moves.
    // Records are delivered in a microtask, which act() flushes, so collect
    // them in the callback as well as taking whatever is still queued. Reading
    // only takeRecords() here passed against the broken hook.
    const span = view.container.querySelector("span")!;
    const writes: MutationRecord[] = [];
    const mo = new MutationObserver((records) => writes.push(...records));
    mo.observe(span, { childList: true, characterData: true, subtree: true });
    await act(async () => {
      crankFrames(60);
    });
    writes.push(...mo.takeRecords());
    mo.disconnect();

    expect(writes).toHaveLength(0);
  });

  it("counts on from where it is when the value changes after landing", async () => {
    vi.resetModules();
    const { useNumberTicker } = await import("./useNumberTicker");
    const { getConductor } = await import("../core/conductor");

    function Score({ value }: { value: number }) {
      const { ref } = useNumberTicker<HTMLSpanElement>(value);
      return <span ref={ref} />;
    }

    const view = render(<Score value={42} />);
    await act(async () => {
      crankFrames(150);
    });
    const span = view.container.querySelector("span")!;

    view.rerender(<Score value={100} />);
    await act(async () => {
      crankFrames(5);
    });
    const mid = Number(span.textContent);
    expect(mid).toBeGreaterThan(42);
    expect(mid).toBeLessThan(100);

    await act(async () => {
      crankFrames(150);
    });
    expect(span.textContent).toBe("100");
    expect(getConductor().state.subscribers).toHaveLength(0);
  });

  it("shows a new suffix after it has landed, without waiting for a new value", async () => {
    vi.resetModules();
    const { useNumberTicker } = await import("./useNumberTicker");

    function Score({ suffix }: { suffix: string }) {
      const { ref } = useNumberTicker<HTMLSpanElement>(42, { suffix });
      return <span ref={ref} />;
    }

    const view = render(<Score suffix="%" />);
    await act(async () => {
      crankFrames(150);
    });
    const span = view.container.querySelector("span")!;
    expect(span.textContent).toBe("42%");

    // Nothing is ticking any more, so the options change has to write it.
    view.rerender(<Score suffix=" pts" />);
    expect(span.textContent).toBe("42 pts");
  });

  /**
   * The element arriving on a later commit: a hydration guard, a loading
   * branch, `next/dynamic`. The effect read `ref.current` once, found nothing,
   * and waited for a value change that might never come, so the counter stayed
   * blank. The arrangement matrix only checks cleanup, which a hook that never
   * started passes.
   */
  it("starts when its element arrives on a later commit", async () => {
    vi.resetModules();
    const { useNumberTicker } = await import("./useNumberTicker");

    function Score() {
      const { ref } = useNumberTicker<HTMLSpanElement>(42);
      const [ready, setReady] = React.useState(false);
      React.useEffect(() => setReady(true), []);
      return ready ? <span ref={ref} /> : <i />;
    }

    const view = render(<Score />);
    await act(async () => {
      crankFrames(150);
    });

    expect(view.container.querySelector("span")!.textContent).toBe("42");
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
    expect(getConductor().state.subscribers).toHaveLength(0);
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
        <div ref={scrub.ref}>
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
        <div ref={scrub.ref}>
          <video ref={scrub.videoRef} />
        </div>
      );
    }

    const view = render(<Scrubber />);
    await act(async () => {
      crankFrames(2);
    });

    view.unmount();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });
});


/** matchMedia is not implemented in jsdom; the magnetic hook gates on it. */
function stubMatchMedia(matches: Record<string, boolean>): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: matches[query] ?? false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

function finePointerNoReducedMotion(): void {
  stubMatchMedia({
    "(any-pointer: fine)": true,
    "(prefers-reduced-motion: reduce)": false,
  });
}

/**
 * The element arriving on a later commit, for every hook that takes one.
 *
 * R9 found `useNumberTicker` reading `ref.current` once in an effect keyed only
 * on its value, so a counter behind a hydration guard, a loading branch or
 * `next/dynamic` never started. Up to 4.1.0 these three read their element the
 * same way, in an effect keyed on mount-time options that never change, and
 * every late variant below failed. The arrangement matrix only checks cleanup,
 * which a hook that never started passes, so liveness is checked here.
 */
describe("a ref that arrives on a later commit", () => {
  /** The real element from the first commit, or a placeholder first when `late`. */
  function useReady(late: boolean): boolean {
    const [ready, setReady] = React.useState(!late);
    React.useEffect(() => setReady(true), []);
    return ready;
  }

  // Each check runs twice. With the element there from the first commit it is
  // a control: if that fails, the check is broken, not the hook.
  for (const late of [false, true]) {
    const when = late ? "on a later commit" : "on the first commit (control)";

    it(`useMagneticIntent attaches when its element arrives ${when}`, async () => {
      finePointerNoReducedMotion();
      vi.resetModules();
      const { useMagneticIntent } = await import("./useMagneticIntent");

      let isActive = false;
      function Cta() {
        const { ref, active } = useMagneticIntent<HTMLButtonElement>();
        isActive = active;
        return useReady(late) ? <button ref={ref} /> : <i />;
      }

      render(<Cta />);
      await act(async () => {
        crankFrames(3);
      });

      expect(isActive).toBe(true);
    });

    it(`useImageTrail builds its pool when its element arrives ${when}`, async () => {
      finePointerNoReducedMotion();
      // jsdom has no Web Animations, and the trail cancels its animations on cleanup.
      Object.defineProperty(Element.prototype, "getAnimations", { value: () => [], configurable: true });
      try {
        vi.resetModules();
        const { useImageTrail } = await import("./useImageTrail");

        function Trail() {
          const { ref } = useImageTrail<HTMLDivElement>({ images: ["/a.png", "/b.png"], maxActive: 4 });
          return useReady(late) ? <div ref={ref} /> : <i />;
        }

        const view = render(<Trail />);
        await act(async () => {
          crankFrames(2);
        });

        expect(view.container.querySelectorAll("img")).toHaveLength(4);
        view.unmount();
      } finally {
        delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
      }
    });

    it(`useVideoScrubber builds its scrubber when its element arrives ${when}`, async () => {
      vi.resetModules();
      const { useVideoScrubber } = await import("./useVideoScrubber");

      let scrubber: unknown = null;
      function Scrub() {
        const { ref, videoRef, scrubberRef } = useVideoScrubber<HTMLDivElement>();
        const ready = useReady(late);
        React.useEffect(() => {
          scrubber = scrubberRef.current;
        });
        return ready ? (
          <div ref={ref}>
            <video ref={videoRef} />
          </div>
        ) : (
          <div />
        );
      }

      render(<Scrub />);
      await act(async () => {
        crankFrames(2);
      });

      expect(scrubber).not.toBeNull();
    });
  }
});

describe("useMagneticIntent", () => {
  it("stays inactive when there is no fine pointer", async () => {
    stubMatchMedia({ "(any-pointer: fine)": false });
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");

    let active = true;
    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      active = magnetic.active;
      return <button ref={magnetic.ref}>Get started</button>;
    }

    render(<Target />);
    act(() => crank(16));
    // Touch only: the element has to behave like an ordinary button.
    expect(active).toBe(false);
  });

  it("stays inactive under reduced motion", async () => {
    stubMatchMedia({
      "(any-pointer: fine)": true,
      "(prefers-reduced-motion: reduce)": true,
    });
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");

    let active = true;
    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      active = magnetic.active;
      return <button ref={magnetic.ref}>Get started</button>;
    }

    render(<Target />);
    act(() => crank(16));
    // This hook IS the motion, so it fails open to a normal element.
    expect(active).toBe(false);
  });

  it("activates with a fine pointer and no reduced-motion preference", async () => {
    finePointerNoReducedMotion();
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");

    let active = false;
    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      active = magnetic.active;
      return <button ref={magnetic.ref}>Get started</button>;
    }

    render(<Target />);
    act(() => crank(16));
    expect(active).toBe(true);
  });

  it("hands the transform back exactly as it found it", async () => {
    finePointerNoReducedMotion();
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");

    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      return (
        <button ref={magnetic.ref} style={{ transform: "rotate(45deg)" }}>
          Get started
        </button>
      );
    }

    const view = render(<Target />);
    const el = view.container.querySelector("button") as HTMLButtonElement;
    act(() => crank(16));

    // The hook owns transform while mounted, so a page that set its own
    // has to get it back untouched.
    view.unmount();
    expect(el.style.transform).toBe("rotate(45deg)");
  });

  it("releases its frame subscription on unmount", async () => {
    finePointerNoReducedMotion();
    vi.resetModules();
    const { useMagneticIntent } = await import("./useMagneticIntent");
    const { getConductor } = await import("../core/conductor");

    function Target() {
      const magnetic = useMagneticIntent<HTMLButtonElement>();
      return <button ref={magnetic.ref}>Get started</button>;
    }

    const view = render(<Target />);
    act(() => crank(16));
    view.unmount();
    expect(getConductor().state.subscribers).toHaveLength(0);
  });
});
