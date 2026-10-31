// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StrictMode, useEffect, useState, type ComponentType } from "react";
import { render, cleanup, act } from "@testing-library/react";

/**
 * The arrangement matrix.
 *
 * Every other test mounts a hook in the simplest tree: one component, rendered
 * directly. Real bugs live elsewhere, such as a ref target that arrives on a
 * later commit behind a spinner, a Suspense fallback or a `next/dynamic`
 * placeholder.
 *
 * Every hook, in every arrangement, must leave the page as it found it. After
 * unmount:
 *
 *   1. the conductor has no subscribers left
 *   2. every IntersectionObserver has been disconnected
 *   3. every window and document listener added has been removed
 *
 * The last one is how a leaked SensorBus retain shows up, because the bus
 * refcount is private.
 *
 * Liveness is checked separately, where an arrangement could break it: a hook
 * that cleans up perfectly while doing nothing would pass all three.
 */

// ── frame + observer stubs ──────────────────────────────────────────

let rafCallbacks = new Map<number, FrameRequestCallback>();
let rafId = 0;
let now = 0;
let observers: StubObserver[] = [];
let listenerBalance = new Map<string, number>();

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

function intersect(is: boolean): void {
  for (const o of observers) {
    o.callback(
      o.observed.map((target) => ({ isIntersecting: is, target })) as unknown as
        IntersectionObserverEntry[],
      {} as IntersectionObserver,
    );
  }
}

/**
 * Listener bookkeeping on window and document.
 *
 * React attaches its own delegated listeners to the container element rather
 * than to either of these, so what lands here is ours. The balance is reset
 * per test, so a leak from an earlier test cannot make a later one fail: each
 * cell is judged only on what it added itself.
 */
const originals = {
  windowAdd: window.addEventListener,
  windowRemove: window.removeEventListener,
  documentAdd: document.addEventListener,
  documentRemove: document.removeEventListener,
};

function bump(key: string, delta: number): void {
  listenerBalance.set(key, (listenerBalance.get(key) ?? 0) + delta);
}

function trackListeners(): void {
  window.addEventListener = function (this: Window, type: string, ...rest: unknown[]) {
    bump(`window:${type}`, 1);
    return (originals.windowAdd as (...a: unknown[]) => void).call(this, type, ...rest);
  } as typeof window.addEventListener;

  window.removeEventListener = function (this: Window, type: string, ...rest: unknown[]) {
    bump(`window:${type}`, -1);
    return (originals.windowRemove as (...a: unknown[]) => void).call(this, type, ...rest);
  } as typeof window.removeEventListener;

  document.addEventListener = function (this: Document, type: string, ...rest: unknown[]) {
    bump(`document:${type}`, 1);
    return (originals.documentAdd as (...a: unknown[]) => void).call(this, type, ...rest);
  } as typeof document.addEventListener;

  document.removeEventListener = function (this: Document, type: string, ...rest: unknown[]) {
    bump(`document:${type}`, -1);
    return (originals.documentRemove as (...a: unknown[]) => void).call(this, type, ...rest);
  } as typeof document.removeEventListener;
}

/**
 * Listeners that legitimately outlive the component that triggered them. Both
 * are page-lifetime and attach at most once, so the allowance is a count: a
 * second one means something is attaching per component.
 *
 *   document:visibilitychange   AnimationBudget's constructor, a page singleton
 *                               with no destroy. `vi.resetModules()` builds a
 *                               fresh one per test.
 *
 *   document:selectionchange    React DOM's own: it shows up on a bare div with
 *                               no runtime import.
 */
const PAGE_LIFETIME_LISTENERS: Readonly<Record<string, number>> = {
  "document:visibilitychange": 1,
  "document:selectionchange": 1,
};

/** Listener types outstanding beyond their allowance, for a readable failure. */
function leakedListeners(): string[] {
  return [...listenerBalance.entries()]
    .filter(([key, n]) => n > (PAGE_LIFETIME_LISTENERS[key] ?? 0))
    .map(([key, n]) => `${key} ×${n}`);
}

beforeEach(() => {
  rafCallbacks = new Map();
  rafId = 0;
  now = 0;
  observers = [];
  listenerBalance = new Map();

  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafCallbacks.set(++rafId, cb);
    return rafId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => rafCallbacks.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => now);

  // Neither of these exists in jsdom.
  vi.stubGlobal("requestIdleCallback", (cb: () => void) => {
    cb();
    return 1;
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

  // jsdom has no WebGL2, so the device probe would correctly rate every test
  // machine as the bottom tier and send every scene straight to a poster.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    ((kind: string) =>
      kind === "webgl2" ? { getExtension: () => null, getParameter: () => "Test GPU" } : null) as never,
  );
  vi.spyOn(navigator, "hardwareConcurrency", "get").mockReturnValue(8);

  trackListeners();
});

afterEach(() => {
  cleanup();
  window.addEventListener = originals.windowAdd;
  window.removeEventListener = originals.windowRemove;
  document.addEventListener = originals.documentAdd;
  document.removeEventListener = originals.documentRemove;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── the subjects ────────────────────────────────────────────────────

/**
 * Every subject takes the same prop, so an arrangement can be applied to any
 * of them without knowing which hook is inside.
 */
interface SubjectProps {
  /**
   * Attach the hook's ref on a later commit. The hook itself still runs on the
   * first render, and only its element arrives late, the shape a spinner or a
   * `next/dynamic` placeholder produces.
   */
  deferRef?: boolean;
}

/** Ref target that appears on the first commit, or one commit later. */
function useDeferredAttach(defer: boolean): boolean {
  const [attached, setAttached] = useState(!defer);
  useEffect(() => setAttached(true), []);
  return attached;
}

interface Loaded {
  Subject: ComponentType<SubjectProps>;
  subscribers: () => number;
}

type SubjectName =
  | "useSceneGate"
  | "useSafeToMount"
  | "useTick"
  | "useSensorBus"
  | "usePointerIntent"
  | "useMagneticIntent"
  | "useImageTrail"
  | "useNumberTicker"
  | "useVideoScrubber";

/**
 * Load one subject against a freshly reset module graph.
 *
 * The conductor, the sensor bus and the governors are all singletons, so every
 * cell has to start from a clean graph or it inherits the previous cell's
 * subscribers. The conductor is imported in the same epoch as the hook, which
 * is what makes `subscribers()` read the instance the hook actually joined.
 */
async function load(name: SubjectName): Promise<Loaded> {
  vi.resetModules();
  const { getConductor } = await import("../core/conductor");
  const subscribers = () => getConductor().state.subscribers.length;

  switch (name) {
    case "useSceneGate": {
      const { useSceneGate } = await import("./useSceneGate");
      return {
        subscribers,
        Subject: ({ deferRef = false }) => {
          const gate = useSceneGate<HTMLDivElement>({ cost: "light" });
          const attached = useDeferredAttach(deferRef);
          return attached ? <div ref={gate.ref} data-state={gate.state} /> : <div />;
        },
      };
    }
    case "useSafeToMount": {
      const { useSafeToMount } = await import("./useSafeToMount");
      return {
        subscribers,
        Subject: ({ deferRef = false }) => {
          const safe = useSafeToMount({ cost: "light" });
          const attached = useDeferredAttach(deferRef);
          return attached ? <div data-safe={String(safe)} /> : <div />;
        },
      };
    }
    case "useTick": {
      const { useTick } = await import("./InteractionScope");
      return {
        subscribers,
        Subject: ({ deferRef = false }) => {
          useTick("update", () => {}, { label: "matrix" });
          const attached = useDeferredAttach(deferRef);
          return attached ? <div /> : <span />;
        },
      };
    }
    case "useSensorBus": {
      const { useSensorBus } = await import("./useSensorBus");
      return {
        subscribers,
        Subject: ({ deferRef = false }) => {
          const bus = useSensorBus();
          const attached = useDeferredAttach(deferRef);
          return attached ? <div data-has-bus={String(!!bus)} /> : <div />;
        },
      };
    }
    case "usePointerIntent": {
      const { usePointerIntent } = await import("../effects/usePointerIntent");
      return {
        subscribers,
        Subject: ({ deferRef = false }) => {
          const { ref, intent } = usePointerIntent<HTMLDivElement>();
          const attached = useDeferredAttach(deferRef);
          return attached ? <div ref={ref} data-intent={String(intent)} /> : <div />;
        },
      };
    }
    case "useMagneticIntent": {
      const { useMagneticIntent } = await import("../effects/useMagneticIntent");
      return {
        subscribers,
        Subject: ({ deferRef = false }) => {
          const { ref, active } = useMagneticIntent<HTMLDivElement>();
          const attached = useDeferredAttach(deferRef);
          return attached ? <div ref={ref} data-active={String(active)} /> : <div />;
        },
      };
    }
    case "useImageTrail": {
      const { useImageTrail } = await import("../effects/useImageTrail");
      return {
        subscribers,
        Subject: ({ deferRef = false }) => {
          const { ref } = useImageTrail<HTMLDivElement>({ images: ["/a.png", "/b.png"] });
          const attached = useDeferredAttach(deferRef);
          return attached ? <div ref={ref} /> : <div />;
        },
      };
    }
    case "useNumberTicker": {
      const { useNumberTicker } = await import("../effects/useNumberTicker");
      return {
        subscribers,
        Subject: ({ deferRef = false }) => {
          const { ref } = useNumberTicker<HTMLSpanElement>(42);
          const attached = useDeferredAttach(deferRef);
          return attached ? <span ref={ref} /> : <span />;
        },
      };
    }
    case "useVideoScrubber": {
      const { useVideoScrubber } = await import("../effects/useVideoScrubber");
      return {
        subscribers,
        Subject: ({ deferRef = false }) => {
          const scrub = useVideoScrubber<HTMLDivElement>();
          const attached = useDeferredAttach(deferRef);
          return attached ? (
            <div ref={scrub.ref}>
              <video ref={scrub.videoRef} />
            </div>
          ) : (
            <div />
          );
        },
      };
    }
  }
}

const SUBJECTS: SubjectName[] = [
  "useSceneGate",
  "useSafeToMount",
  "useTick",
  "useSensorBus",
  "usePointerIntent",
  "useMagneticIntent",
  "useImageTrail",
  "useNumberTicker",
  "useVideoScrubber",
];

// ── the arrangements ────────────────────────────────────────────────

interface Arrangement {
  name: string;
  /** Mount the subject in this shape and hand back a way to tear it down. */
  mount: (Subject: ComponentType<SubjectProps>) => Promise<() => void>;
}

/** Let effects settle and give the runtime a few frames to do its work. */
async function settle(): Promise<void> {
  await act(async () => {
    intersect(true);
    crankFrames(8);
  });
}

const ARRANGEMENTS: Arrangement[] = [
  {
    name: "plain",
    mount: async (Subject) => {
      const view = render(<Subject />);
      await settle();
      return () => view.unmount();
    },
  },
  {
    name: "ref arrives on a later commit",
    mount: async (Subject) => {
      const view = render(<Subject deferRef />);
      await settle();
      return () => view.unmount();
    },
  },
  {
    name: "StrictMode double invoke",
    mount: async (Subject) => {
      const view = render(
        <StrictMode>
          <Subject />
        </StrictMode>,
      );
      await settle();
      return () => view.unmount();
    },
  },
  {
    name: "mounted, unmounted, mounted again",
    mount: async (Subject) => {
      const first = render(<Subject />);
      await settle();
      first.unmount();
      const second = render(<Subject />);
      await settle();
      return () => second.unmount();
    },
  },
  {
    name: "two instances on one page",
    mount: async (Subject) => {
      const view = render(
        <>
          <Subject />
          <Subject />
        </>,
      );
      await settle();
      return () => view.unmount();
    },
  },
  {
    name: "mounted after the first paint",
    mount: async (Subject) => {
      function Late() {
        const [show, setShow] = useState(false);
        useEffect(() => setShow(true), []);
        return show ? <Subject /> : null;
      }
      const view = render(<Late />);
      await settle();
      return () => view.unmount();
    },
  },
];

// ── the matrix ──────────────────────────────────────────────────────

describe("arrangements: every hook leaves the page as it found it", () => {
  for (const name of SUBJECTS) {
    for (const arrangement of ARRANGEMENTS) {
      it(`${name} · ${arrangement.name}`, async () => {
        const { Subject, subscribers } = await load(name);

        const unmount = await arrangement.mount(Subject);
        unmount();

        // Some teardown is queued rather than immediate, so give the loop a
        // chance to drain before judging it.
        await act(async () => {
          crankFrames(2);
        });

        expect(subscribers(), "conductor subscribers after unmount").toBe(0);
        expect(
          observers.filter((o) => !o.disconnected),
          "IntersectionObservers still connected",
        ).toHaveLength(0);
        expect(leakedListeners(), "window/document listeners not removed").toEqual([]);
      });
    }
  }
});

// ── liveness, where an arrangement could plausibly break it ─────────

/**
 * Cleaning up perfectly while doing nothing passes every check above. So the
 * arrangements that can strand a hook get a second assertion: it still reached
 * the state that makes it useful.
 */
describe("arrangements: the hook still works", () => {
  it("useSceneGate reaches active when its ref arrives on a later commit", async () => {
    const { useSceneGate } = await (async () => {
      vi.resetModules();
      return import("./useSceneGate");
    })();

    const seen: string[] = [];
    function Scene() {
      const { ref, state } = useSceneGate<HTMLDivElement>({ cost: "light" });
      const attached = useDeferredAttach(true);
      seen.push(state);
      return attached ? <div ref={ref} /> : <div />;
    }

    render(<Scene />);
    await settle();

    expect(observers).toHaveLength(1);
    expect(seen[seen.length - 1]).toBe("active");
  });

  it("useSceneGate reaches active under StrictMode", async () => {
    vi.resetModules();
    const { useSceneGate } = await import("./useSceneGate");

    const seen: string[] = [];
    function Scene() {
      const { ref, state } = useSceneGate<HTMLDivElement>({ cost: "light" });
      seen.push(state);
      return <div ref={ref} />;
    }

    render(
      <StrictMode>
        <Scene />
      </StrictMode>,
    );
    await settle();

    expect(seen[seen.length - 1]).toBe("active");
  });

  it("useSceneGate reaches active again after a remount", async () => {
    vi.resetModules();
    const { useSceneGate } = await import("./useSceneGate");

    let last = "";
    function Scene() {
      const { ref, state } = useSceneGate<HTMLDivElement>({ cost: "light" });
      last = state;
      return <div ref={ref} />;
    }

    const first = render(<Scene />);
    await settle();
    first.unmount();

    render(<Scene />);
    await settle();

    expect(last).toBe("active");
  });

  it("two gates on one page both reach active", async () => {
    vi.resetModules();
    const { useSceneGate } = await import("./useSceneGate");

    const states: Record<string, string> = {};
    function Scene({ id }: { id: string }) {
      const { ref, state } = useSceneGate<HTMLDivElement>({ cost: "light", label: id });
      states[id] = state;
      return <div ref={ref} />;
    }

    render(
      <>
        <Scene id="a" />
        <Scene id="b" />
      </>,
    );
    await settle();

    expect(states).toEqual({ a: "active", b: "active" });
  });

  it("useSafeToMount opens under StrictMode", async () => {
    vi.resetModules();
    const { useSafeToMount } = await import("./useSafeToMount");

    let safe = false;
    function Gate() {
      safe = useSafeToMount({ cost: "light" });
      return null;
    }

    render(
      <StrictMode>
        <Gate />
      </StrictMode>,
    );
    await settle();

    expect(safe).toBe(true);
  });

  it("useTick keeps ticking after a remount", async () => {
    vi.resetModules();
    const { useTick } = await import("./InteractionScope");

    let ticks = 0;
    function Ticker() {
      useTick("update", () => {
        ticks++;
      });
      return null;
    }

    const first = render(<Ticker />);
    await settle();
    first.unmount();

    ticks = 0;
    render(<Ticker />);
    await settle();

    expect(ticks).toBeGreaterThan(0);
  });

  it("usePointerIntent attaches to an element that arrives on a later commit", async () => {
    vi.resetModules();
    const { usePointerIntent } = await import("../effects/usePointerIntent");
    const { getConductor } = await import("../core/conductor");

    function Target() {
      const { ref } = usePointerIntent<HTMLDivElement>();
      const attached = useDeferredAttach(true);
      return attached ? <div ref={ref} /> : <div />;
    }

    render(<Target />);
    await settle();

    // The engine only joins the loop once it has an element to measure
    // against, so a subscriber is the evidence that the late ref was seen.
    expect(getConductor().state.subscribers.length).toBeGreaterThan(0);
  });
});

// ── server render, then hydrate ─────────────────────────────────────

/**
 * The server has no frame timings, no pointer and no GPU, so any hook that
 * opened on its first render would produce markup the client disagrees with.
 * Both of these start closed, and this test says so.
 */
describe("arrangements: server render and hydration", () => {
  it("useSafeToMount renders closed on the server", async () => {
    vi.resetModules();
    const { renderToString } = await import("react-dom/server");
    const { useSafeToMount } = await import("./useSafeToMount");

    function Gate() {
      const safe = useSafeToMount({ cost: "light" });
      return <div data-safe={String(safe)} />;
    }

    expect(renderToString(<Gate />)).toContain('data-safe="false"');
  });

  it("useSceneGate renders dormant on the server, with no scene", async () => {
    vi.resetModules();
    const { renderToString } = await import("react-dom/server");
    const { useSceneGate } = await import("./useSceneGate");

    function Scene() {
      const { ref, state, mounted } = useSceneGate<HTMLDivElement>({ cost: "light" });
      return <div ref={ref} data-state={state} data-mounted={String(mounted)} />;
    }

    const html = renderToString(<Scene />);
    expect(html).toContain('data-state="dormant"');
    expect(html).toContain('data-mounted="false"');
  });

  it("hydrating a gate over server markup logs no mismatch", async () => {
    vi.resetModules();
    const { renderToString } = await import("react-dom/server");
    const { hydrateRoot } = await import("react-dom/client");
    const { useSceneGate } = await import("./useSceneGate");

    function Scene() {
      const { ref, state } = useSceneGate<HTMLDivElement>({ cost: "light" });
      return <div ref={ref} data-state={state} />;
    }

    const container = document.createElement("div");
    container.innerHTML = renderToString(<Scene />);
    document.body.appendChild(container);

    const errors: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    // A property rather than a `let`: control-flow analysis cannot see the
    // assignment inside the act callback, so a local would narrow to `never`.
    const mounted: { root?: { unmount: () => void } } = {};
    await act(async () => {
      mounted.root = hydrateRoot(container, <Scene />);
    });
    await settle();

    spy.mockRestore();
    mounted.root?.unmount();
    container.remove();

    expect(errors.filter((e) => /hydrat|did not match|mismatch/i.test(e))).toEqual([]);
  });
});

// ── the control ─────────────────────────────────────────────────────

describe("arrangements: the harness itself", () => {
  /**
   * With no runtime code in the tree, the accounting comes out clean. If this
   * ever fails, the harness is measuring React or jsdom and not the runtime.
   *
   * React attaches `selectionchange` per document on its first render, so this
   * test can't assert the count directly: the matrix above has already
   * triggered it. Rendering a bare div as the only test in a file shows it with
   * no runtime import.
   */
  it("a bare render leaves nothing the runtime is answerable for", () => {
    render(<div>no runtime here</div>);
    expect(leakedListeners()).toEqual([]);
  });
});
