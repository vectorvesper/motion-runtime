// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
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
    render(<Probe />);

    const canvas = document.createElement("canvas");
    await act(async () => {
      props!.onCreated({ gl: { domElement: canvas } });
    });
    return { canvas, health: getRendererHealth() };
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
});
