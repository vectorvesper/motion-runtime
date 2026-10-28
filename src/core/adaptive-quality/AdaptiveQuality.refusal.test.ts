// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * RB-3: a WebGL context the browser refuses after the page has loaded.
 *
 * The probe needs a WebGL2 context to rate the device, and jsdom has none, so
 * getContext is faked for the probe. The refusal itself is a real event on a
 * real (jsdom) canvas in the document, the way a browser delivers it.
 */
function fakeProbeContext() {
  return {
    getExtension: (name: string) =>
      name === "WEBGL_debug_renderer_info" ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : name === "WEBGL_lose_context" ? { loseContext() {} } : null,
    getParameter: () => "ANGLE (NVIDIA GeForce RTX 4070)",
  };
}

function refuseOn(canvas: HTMLCanvasElement, statusMessage?: string) {
  const event = new Event("webglcontextcreationerror");
  if (statusMessage) Object.assign(event, { statusMessage });
  canvas.dispatchEvent(event);
}

describe("AdaptiveQuality — WebGL refused mid-visit", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      ((type: string) => (type === "webgl2" ? fakeProbeContext() : null)) as never,
    );
    Object.defineProperty(navigator, "hardwareConcurrency", { value: 12, configurable: true });
    // jsdom has no matchMedia; the probe reads the reduced-motion preference.
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("drops a capable device to the poster tier, says why, and tells listeners at once", async () => {
    const { getAdaptiveQuality, isWebGLRefused } = await import("./AdaptiveQuality");
    const seen: number[] = [];
    const off = getAdaptiveQuality().subscribe((s) => seen.push(s.deviceTier));
    expect(getAdaptiveQuality().state.deviceTier).toBe(0);

    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    refuseOn(canvas, "Web page caused context loss and was blocked");

    expect(isWebGLRefused()).toBe(true);
    const state = getAdaptiveQuality().state;
    expect(state.deviceTier).toBe(2);
    expect(state.tier).toBe(2);
    expect(state.reasons.at(-1)).toBe("WebGL refused by the browser: Web page caused context loss and was blocked");
    expect(seen.at(-1)).toBe(2);
    off();
  });

  it("hears a refusal from a canvas nested anywhere in the page", async () => {
    const { getAdaptiveQuality, isWebGLRefused } = await import("./AdaptiveQuality");
    const off = getAdaptiveQuality().subscribe(() => {});
    const wrap = document.createElement("section");
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    document.body.appendChild(wrap);
    refuseOn(canvas);
    expect(isWebGLRefused()).toBe(true);
    expect(getAdaptiveQuality().state.reasons.at(-1)).toBe("WebGL refused by the browser");
    off();
  });

  it("listens only while something subscribes, and leaves the page as it found it", async () => {
    const add = vi.spyOn(document, "addEventListener");
    const remove = vi.spyOn(document, "removeEventListener");
    const { getAdaptiveQuality, isWebGLRefused } = await import("./AdaptiveQuality");
    const off = getAdaptiveQuality().subscribe(() => {});
    expect(add.mock.calls.filter((c) => c[0] === "webglcontextcreationerror")).toHaveLength(1);
    off();
    expect(remove.mock.calls.filter((c) => c[0] === "webglcontextcreationerror")).toHaveLength(1);
    const canvas = document.createElement("canvas");
    document.body.appendChild(canvas);
    refuseOn(canvas);
    expect(isWebGLRefused()).toBe(false);
  });

  it("keeps the first refusal's reason", async () => {
    const { getAdaptiveQuality, reportWebGLRefused } = await import("./AdaptiveQuality");
    void getAdaptiveQuality().state;
    reportWebGLRefused("first");
    reportWebGLRefused("second");
    expect(getAdaptiveQuality().state.reasons.at(-1)).toBe("WebGL refused by the browser: first");
  });

  it("leaves a healthy page alone", async () => {
    const { getAdaptiveQuality, isWebGLRefused } = await import("./AdaptiveQuality");
    expect(getAdaptiveQuality().state.deviceTier).toBe(0);
    expect(isWebGLRefused()).toBe(false);
  });
});
