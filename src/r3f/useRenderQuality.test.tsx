// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";

/**
 * The R3F adapter.
 *
 * ## What changed in 3.1, and why these tests look nothing like the old ones
 *
 * Up to 3.0.1 this hook ran inside `<Canvas>` and drove the renderer
 * imperatively: `setDpr`, `setFrameloop`, `gl.shadowMap.enabled`. The tests
 * mocked `useThree` and asserted those calls happened, and they passed.
 *
 * None of it worked. R3F re-runs its configure pass on every `<Canvas>` render
 * and resets all three from the props, so every call was undone on the next
 * render. The tests were green because they asserted the call, and the call
 * was real. What was missing was any check that the renderer ended up in the
 * requested state, which is the only thing a consumer cares about.
 *
 * So these test the returned props instead. There is nothing to mock: the hook
 * imports no R3F value, and whether R3F honours its own props is R3F's
 * business. The end-to-end claim, that a real renderer actually lands at the
 * requested pixel ratio and stops drawing, is checked in a real browser by
 * vv-site's tools/verify-render-quality.mjs, because that is the only place it
 * can be checked honestly.
 */

const PROFILES = {
  full: { dpr: 2, shadows: true },
  reduced: { dpr: 1, shadows: false },
} as const;

type SceneStateName =
  | "dormant"
  | "warming"
  | "active"
  | "constrained"
  | "idle"
  | "recovering"
  | "poster";

interface Props {
  dpr: number | undefined;
  frameloop: "always" | "never";
  shadows: boolean | undefined;
  onCreated: (s: { gl: { domElement: HTMLCanvasElement } }) => void;
}

/** Render the hook at one state and hand back what it returned. */
async function propsFor(state: SceneStateName): Promise<Props> {
  const { useRenderQuality } = await import("./useRenderQuality");
  let out: Props | null = null;
  function Probe() {
    out = useRenderQuality(state, PROFILES) as Props;
    return null;
  }
  render(<Probe />);
  return out!;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useRenderQuality — the render loop", () => {
  it("stops drawing when the scene is off screen", async () => {
    expect((await propsFor("idle")).frameloop).toBe("never");
  });

  it("draws while the scene is running", async () => {
    expect((await propsFor("active")).frameloop).toBe("always");
    cleanup();
    expect((await propsFor("constrained")).frameloop).toBe("always");
  });

  it("leaves the loop alone while the scene is only warming", async () => {
    // `warming` means the canvas is about to exist. Stopping the loop for it
    // would leave it blank on arrival, and it is the gate's `mounted` decision
    // that keeps it off screen until then, not this one.
    expect((await propsFor("warming")).frameloop).toBe("always");
  });
});

describe("useRenderQuality — the profile", () => {
  // jsdom reports a 1x screen, and a profile's dpr never goes above the
  // screen's own ratio. On a 3x phone every value below passes as written.
  beforeEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: 3, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
  });

  /**
   * T1 in vv-lab's findings. Every example writes `full: { dpr: 2 }` and R3F
   * applies a number as given, so a 1x monitor drew four times its pixels and
   * the managed scene came out heavier than the unmanaged one it replaced.
   */
  it("never draws above the screen's own pixel ratio", async () => {
    Object.defineProperty(window, "devicePixelRatio", { value: 1, configurable: true });
    expect((await propsFor("active")).dpr).toBe(1);
    cleanup();
    Object.defineProperty(window, "devicePixelRatio", { value: 1.5, configurable: true });
    expect((await propsFor("active")).dpr).toBe(1.5);
  });

  it("applies the full profile while active", async () => {
    const p = await propsFor("active");
    expect(p.dpr).toBe(2);
    expect(p.shadows).toBe(true);
  });

  it("applies the reduced profile while constrained", async () => {
    const p = await propsFor("constrained");
    expect(p.dpr).toBe(1);
    expect(p.shadows).toBe(false);
  });

  it("treats every non-active state as reduced", async () => {
    for (const state of ["idle", "recovering", "warming", "poster"] as const) {
      cleanup();
      const p = await propsFor(state);
      expect(p.dpr, state).toBe(1);
      expect(p.shadows, state).toBe(false);
    }
  });

  // The bug this pair exists for: an idle scene took the reduced profile, so
  // going off screen dropped its dpr at the same moment the loop stopped.
  // Changing dpr resizes the drawing buffer and resizing clears it, so with
  // nothing drawing afterwards the scene went black instead of holding its last
  // frame. Reported on vv-site's /lab/context-loss as "a few go black when I
  // scroll"; measured there as active cards at 660x494 and idle ones at
  // 330x247 and blank. Fixed in 4.0.2.
  it("does not resize the canvas when a drawing scene goes idle", async () => {
    const { useRenderQuality } = await import("./useRenderQuality");
    const seen: Array<number | undefined> = [];
    function Probe({ state }: { state: SceneStateName }) {
      seen.push(useRenderQuality(state, PROFILES).dpr);
      return null;
    }
    const view = render(<Probe state="active" />);
    view.rerender(<Probe state="idle" />);
    // Not the reduced 1. The canvas is already sized at 2 and must stay there.
    expect(seen.at(-1)).toBe(2);
  });

  it("holds the constrained ratio too, rather than snapping back to full", async () => {
    const { useRenderQuality } = await import("./useRenderQuality");
    const seen: Array<number | undefined> = [];
    function Probe({ state }: { state: SceneStateName }) {
      seen.push(useRenderQuality(state, PROFILES).dpr);
      return null;
    }
    const view = render(<Probe state="constrained" />);
    view.rerender(<Probe state="idle" />);
    expect(seen.at(-1)).toBe(1);
  });

  it("resumes the profile of whatever the scene comes back as", async () => {
    const { useRenderQuality } = await import("./useRenderQuality");
    const seen: Array<number | undefined> = [];
    function Probe({ state }: { state: SceneStateName }) {
      seen.push(useRenderQuality(state, PROFILES).dpr);
      return null;
    }
    const view = render(<Probe state="active" />);
    view.rerender(<Probe state="idle" />);
    view.rerender(<Probe state="constrained" />);
    // Drawing again, so the resize is wanted: it will be redrawn at once.
    expect(seen.at(-1)).toBe(1);
  });

  it("keeps a stable object while nothing changes", async () => {
    const { useRenderQuality } = await import("./useRenderQuality");
    const seen: unknown[] = [];
    function Probe({ tick }: { tick: number }) {
      seen.push(useRenderQuality("active", PROFILES));
      return <span>{tick}</span>;
    }
    // A fresh object every render would reconfigure the canvas on every parent
    // render, which is the churn this whole runtime exists to avoid.
    const view = render(<Probe tick={1} />);
    view.rerender(<Probe tick={2} />);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});

describe("useRenderQuality — a lost graphics context", () => {
  async function created() {
    vi.resetModules();
    const { useRenderQuality } = await import("./useRenderQuality");
    const { getRendererHealth } = await import("../core/renderer-health/RendererHealth");

    let props: Props | null = null;
    function Probe() {
      props = useRenderQuality("active", PROFILES) as Props;
      return null;
    }
    const view = render(<Probe />);

    // In the document, as every canvas R3F draws to is. A detached canvas is
    // one R3F is tearing down, and its loss is deliberately not reported.
    const canvas = document.body.appendChild(document.createElement("canvas"));
    await act(async () => {
      props!.onCreated({ gl: { domElement: canvas } });
    });
    return {
      canvas,
      health: getRendererHealth(),
      unmount: view.unmount,
      onCreated: (s: { gl: { domElement: HTMLCanvasElement } }) => props!.onCreated(s),
    };
  }

  it("reports healthy when a canvas is created", async () => {
    const { health } = await created();
    expect(health.state.lost).toBe(false);
  });

  it("calls preventDefault, or no replacement context is possible", async () => {
    const { canvas } = await created();
    const event = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("reports the loss so something outside the canvas can react", async () => {
    const { canvas, health } = await created();
    const before = health.state.generation;

    await act(async () => {
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });

    expect(health.state.lost).toBe(true);
    expect(health.state.generation).toBe(before + 1);
  });

  /**
   * R1 in vv-lab's findings. R3F calls `forceContextLoss()` on every canvas it
   * unmounts, 500ms after React has taken it out of the document, and that
   * fires `webglcontextlost` like any real loss. Reported, it moved the
   * generation, so closing one tab rebuilt every other scene on the page: a
   * managed hero rebuilt four times in six tab switches, and on WebKit died.
   */
  it("ignores the loss R3F causes when it tears a canvas down", async () => {
    const { canvas, health } = await created();
    const before = health.state.generation;

    canvas.remove();
    const event = new Event("webglcontextlost", { cancelable: true });
    await act(async () => {
      canvas.dispatchEvent(event);
    });

    expect(health.state.lost).toBe(false);
    expect(health.state.generation).toBe(before);
    // Nothing wants a torn-down canvas's context back.
    expect(event.defaultPrevented).toBe(false);
  });

  it("stops listening once the component that owns the canvas unmounts", async () => {
    const { canvas, health, unmount } = await created();
    const before = health.state.generation;

    // The canvas is still in the document, which the isConnected check cannot
    // tell from a live one: a parent that keeps the DOM but drops the tree, as
    // a hidden <Activity> does.
    unmount();
    await act(async () => {
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });

    expect(health.state.generation).toBe(before);
  });

  it("follows a rebuilt canvas and lets go of the one it replaced", async () => {
    const { canvas: first, health, onCreated } = await created();

    // What `<Canvas key={generation}>` does: React swaps the element, R3F
    // builds on the new one, and the old one is torn down afterwards.
    const second = document.body.appendChild(document.createElement("canvas"));
    first.remove();
    await act(async () => {
      onCreated({ gl: { domElement: second } });
    });
    const before = health.state.generation;

    await act(async () => {
      first.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });
    expect(health.state.generation).toBe(before);

    await act(async () => {
      second.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });
    expect(health.state.generation).toBe(before + 1);
  });

  /**
   * R10 in vv-lab's findings. Losses that arrive soon after a loss are folded
   * into its rebuild, because one driver reset reaches every canvas. The
   * replacement that rebuild built is the exception: it did not exist when the
   * reset happened, so losing it is a new failure. Folded in, it stayed black.
   */
  it("rebuilds again when the replacement is lost moments after it was built", async () => {
    const { canvas: first, health, onCreated } = await created();
    await act(async () => {
      first.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });
    const afterFirst = health.state.generation;

    // The rebuild: a new canvas, built under the new generation.
    const second = document.body.appendChild(document.createElement("canvas"));
    first.remove();
    await act(async () => {
      onCreated({ gl: { domElement: second } });
    });

    // Lost at once, well inside the window the first loss opened.
    await act(async () => {
      second.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });
    expect(health.state.generation).toBe(afterFirst + 1);
    expect(health.state.lost).toBe(true);
  });

  /**
   * R11 in vv-lab's findings. R3F creates the context, builds the scene, and
   * only then calls onCreated. A loss in between fires with no listener
   * attached, so onCreated has to ask the context itself.
   */
  it("reports a context that was already lost when it was handed over", async () => {
    vi.resetModules();
    const { useRenderQuality } = await import("./useRenderQuality");
    const { getRendererHealth } = await import("../core/renderer-health/RendererHealth");
    let props: Props | null = null;
    function Probe() {
      props = useRenderQuality("active", PROFILES) as Props;
      return null;
    }
    render(<Probe />);
    const health = getRendererHealth();
    const canvas = document.body.appendChild(document.createElement("canvas"));
    await act(async () => {
      (props!.onCreated as (s: unknown) => void)({
        gl: { domElement: canvas, getContext: () => ({ isContextLost: () => true }) },
      });
    });

    expect(health.state.generation).toBe(1);
    expect(health.state.lost).toBe(true);
  });

  it("rebuilds when the replacement died before it was handed over", async () => {
    const { canvas: first, health, onCreated } = await created();
    await act(async () => {
      first.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });
    const afterFirst = health.state.generation;

    // The second reset lands while R3F is still building the replacement.
    const second = document.body.appendChild(document.createElement("canvas"));
    first.remove();
    await act(async () => {
      (onCreated as (s: unknown) => void)({
        gl: { domElement: second, getContext: () => ({ isContextLost: () => true }) },
      });
    });

    expect(health.state.generation).toBe(afterFirst + 1);
  });

  it("still counts one reset across two canvases as one rebuild", async () => {
    vi.resetModules();
    const { useRenderQuality } = await import("./useRenderQuality");
    const { getRendererHealth } = await import("../core/renderer-health/RendererHealth");
    const props: Props[] = [];
    function Probe({ slot }: { slot: number }) {
      props[slot] = useRenderQuality("active", PROFILES) as Props;
      return null;
    }
    render(
      <>
        <Probe slot={0} />
        <Probe slot={1} />
      </>,
    );
    const canvases = [0, 1].map(() => document.body.appendChild(document.createElement("canvas")));
    await act(async () => {
      canvases.forEach((canvas, i) => props[i].onCreated({ gl: { domElement: canvas } }));
    });
    const health = getRendererHealth();
    const before = health.state.generation;

    // Both were built before the reset, so the second loss is the same reset.
    await act(async () => {
      for (const canvas of canvases) {
        canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
      }
    });
    expect(health.state.generation).toBe(before + 1);
  });
});

/**
 * WebGPU, added in 4.1.0.
 *
 * The shapes here are the ones three 0.184 actually produces, checked against
 * WebGPUBackend (`isWebGPUBackend`, `device`) and WebGLBackend
 * (`isWebGLBackend`, no device), and confirmed end to end in a real Chrome by
 * tools/verify-webgpu.mjs in the site repo.
 */
describe("useRenderQuality — a lost WebGPU device", () => {
  interface Backend {
    isWebGPUBackend?: boolean;
    isWebGLBackend?: boolean;
    device?: unknown;
  }

  /** A device whose `lost` promise the test controls. */
  function makeDevice() {
    let settle: (info: { reason?: string } | undefined) => void = () => {};
    const lost = new Promise<{ reason?: string } | undefined>((r) => {
      settle = r;
    });
    return { device: { lost }, lose: settle };
  }

  async function created(backend: Backend | undefined) {
    vi.resetModules();
    const { useRenderQuality } = await import("./useRenderQuality");
    const { getRendererHealth } = await import("../core/renderer-health/RendererHealth");

    let props: Props | null = null;
    function Probe() {
      props = useRenderQuality("active", PROFILES) as Props;
      return null;
    }
    render(<Probe />);

    const canvas = document.body.appendChild(document.createElement("canvas"));
    await act(async () => {
      (props!.onCreated as (s: unknown) => void)({ gl: { domElement: canvas, backend } });
    });
    return { canvas, health: getRendererHealth() };
  }

  const settle = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  it("rebuilds the scene when the device is lost", async () => {
    const { device, lose } = makeDevice();
    const { health } = await created({ isWebGPUBackend: true, device });
    const before = health.state.generation;

    lose({ reason: "unknown" });
    await settle();

    expect(health.state.lost).toBe(true);
    expect(health.state.generation).toBe(before + 1);
  });

  it("ignores a device the page destroyed itself", async () => {
    const { device, lose } = makeDevice();
    const { health } = await created({ isWebGPUBackend: true, device });
    const before = health.state.generation;

    lose({ reason: "destroyed" });
    await settle();

    expect(health.state.lost).toBe(false);
    expect(health.state.generation).toBe(before);
  });

  /**
   * The case that would ship broken if the renderer were classified by its
   * class. `Renderer.init` swaps in a WebGL backend when WebGPU fails, so this
   * is a WebGPURenderer drawing through WebGL. Its canvas fires the event, and
   * recovery has to come from the listener.
   */
  it("still recovers when three falls back to WebGL", async () => {
    const { canvas, health } = await created({ isWebGLBackend: true });
    const before = health.state.generation;

    await act(async () => {
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });

    expect(health.state.generation).toBe(before + 1);
  });

  it("ignores a backend whose device has not resolved yet", async () => {
    const { health } = await created({ isWebGPUBackend: true, device: null });
    // No device means nothing to watch, and no crash on the way past.
    expect(health.state.lost).toBe(false);
  });

  it("leaves a plain WebGLRenderer alone", async () => {
    const { canvas, health } = await created(undefined);
    const before = health.state.generation;

    await act(async () => {
      canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    });

    expect(health.state.generation).toBe(before + 1);
  });
});
