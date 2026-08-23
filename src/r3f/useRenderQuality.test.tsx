// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { render, cleanup } from "@testing-library/react";

/**
 * The R3F adapter.
 *
 * R3F is mocked rather than mounted: a real `<Canvas>` needs a WebGL context,
 * which jsdom does not have, and the thing being tested is not the renderer —
 * it is which renderer calls this hook makes, and when. That is exactly what a
 * mock can answer honestly.
 */

const canvas = document.createElement("canvas");

const store = {
  gl: { domElement: canvas, shadowMap: { enabled: true, needsUpdate: false } },
  setDpr: vi.fn(),
  setFrameloop: vi.fn(),
  invalidate: vi.fn(),
};

vi.mock("@react-three/fiber", () => ({
  useThree: (selector: (s: typeof store) => unknown) => selector(store),
}));

const PROFILES = {
  full: { dpr: 2, shadows: true },
  reduced: { dpr: 1, shadows: false },
};

beforeEach(() => {
  store.gl.shadowMap.enabled = true;
  store.gl.shadowMap.needsUpdate = false;
  store.setDpr.mockClear();
  store.setFrameloop.mockClear();
  store.invalidate.mockClear();
});

afterEach(() => cleanup());

async function mount(state: string) {
  const { useRenderQuality } = await import("./useRenderQuality");
  function Rig() {
    useRenderQuality(state as never, PROFILES);
    return null;
  }
  return render(<Rig />);
}

describe("useRenderQuality — the render loop", () => {
  it("stops drawing when the scene is off screen", async () => {
    await mount("idle");

    // The context, the textures and the geometry all stay. Only the drawing
    // stops, so coming back into view is instant.
    expect(store.setFrameloop).toHaveBeenCalledWith("never");
  });

  it("starts drawing again, and asks for a frame", async () => {
    await mount("active");

    expect(store.setFrameloop).toHaveBeenCalledWith("always");
    // A stopped loop has nothing queued, so without this the picture would
    // wait for something unrelated to request a frame.
    expect(store.invalidate).toHaveBeenCalled();
  });

  it("leaves the loop alone while the scene is only warming", async () => {
    await mount("warming");

    expect(store.setFrameloop).not.toHaveBeenCalled();
  });
});

describe("useRenderQuality — the profile", () => {
  it("applies the full profile while active", async () => {
    await mount("active");

    expect(store.setDpr).toHaveBeenCalledWith(2);
    expect(store.gl.shadowMap.enabled).toBe(true);
  });

  it("applies the reduced profile while constrained", async () => {
    await mount("constrained");

    expect(store.setDpr).toHaveBeenCalledWith(1);
    expect(store.gl.shadowMap.enabled).toBe(false);
  });

  it("marks the shadow map dirty when the setting changes", async () => {
    await mount("constrained");

    // Materials were compiled against the old shadow setting and would keep
    // their old shader until something else marked them dirty.
    expect(store.gl.shadowMap.needsUpdate).toBe(true);
  });

  it("does not touch the renderer while off screen", async () => {
    await mount("idle");

    // Nothing is being drawn, so changing quality now would only cost a
    // recompile that the next visible frame would pay for anyway.
    expect(store.setDpr).not.toHaveBeenCalled();
  });

  it("puts the page's own shadow setting back on unmount", async () => {
    store.gl.shadowMap.enabled = true;
    const view = await mount("constrained");
    expect(store.gl.shadowMap.enabled).toBe(false);

    view.unmount();
    // The scene borrowed the renderer; it has to give it back as it found it.
    expect(store.gl.shadowMap.enabled).toBe(true);
  });
});


describe("useRenderQuality — a lost graphics context", () => {
  async function health() {
    const mod = await import("../core/renderer-health/RendererHealth");
    return mod.getRendererHealth();
  }

  it("calls preventDefault, or no replacement context is possible", async () => {
    await mount("active");

    const event = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(event);

    // Without this the browser will not attempt a restore, and some drivers
    // then refuse a new context on the page at all.
    expect(event.defaultPrevented).toBe(true);
  });

  it("reports the loss so something outside the canvas can react", async () => {
    const h = await health();
    const before = h.state.generation;

    await mount("active");
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));

    expect(h.state.lost).toBe(true);
    expect(h.state.generation).toBe(before + 1);
  });

  it("reports healthy when a replacement mounts", async () => {
    const h = await health();
    await mount("active");
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(h.state.lost).toBe(true);

    cleanup();
    // The remount under a new key is the recovery. A renderer mounting at all
    // means a working context.
    await mount("active");
    expect(h.state.lost).toBe(false);
  });

  it("stops listening on unmount", async () => {
    const h = await health();
    const view = await mount("active");
    view.unmount();

    const before = h.state.generation;
    canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));

    expect(h.state.generation).toBe(before);
  });
});
