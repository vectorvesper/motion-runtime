import { describe, it, expect } from "vitest";
import { deviceTierFromSignals, fuse, type DeviceSignals } from "./AdaptiveQuality";

const capable: DeviceSignals = {
  webgl2: true,
  renderer: "ANGLE (NVIDIA GeForce RTX 4070)",
  deviceMemory: 16,
  cores: 12,
  reducedMotion: false,
};

describe("deviceTierFromSignals", () => {
  it("rates a capable desktop GPU tier 0", () => {
    const { tier, reasons } = deviceTierFromSignals(capable);
    expect(tier).toBe(0);
    expect(reasons).toEqual(["capable GPU"]);
  });

  it("floors missing WebGL2 at tier 2", () => {
    expect(deviceTierFromSignals({ ...capable, webgl2: false }).tier).toBe(2);
  });

  it("floors software renderers at tier 2", () => {
    const { tier, reasons } = deviceTierFromSignals({
      ...capable,
      renderer: "Google SwiftShader",
    });
    expect(tier).toBe(2);
    expect(reasons).toContain("software GL renderer");
  });

  it("rates mobile-class GPUs tier 1", () => {
    expect(
      deviceTierFromSignals({ ...capable, renderer: "Adreno (TM) 740" }).tier,
    ).toBe(1);
    expect(
      deviceTierFromSignals({ ...capable, renderer: "Apple GPU" }).tier,
    ).toBe(1);
  });

  it("bumps constrained devices one tier", () => {
    expect(deviceTierFromSignals({ ...capable, deviceMemory: 4 }).tier).toBe(1);
    // mobile GPU + low memory stacks to 2
    expect(
      deviceTierFromSignals({
        ...capable,
        renderer: "Mali-G78",
        deviceMemory: 4,
      }).tier,
    ).toBe(2);
  });

  it("treats unknown signals as capable rather than punishing them", () => {
    const { tier } = deviceTierFromSignals({
      ...capable,
      renderer: "",
      deviceMemory: null,
      cores: null,
    });
    expect(tier).toBe(0);
  });
});

/**
 * The rule the whole runtime is built around.
 *
 * Up to 2.x it lived inside useSceneGate, so the twenty-one components reading
 * the governor directly got `max(deviceTier, budgetTier)` and degraded whenever
 * the frame rate sagged, including when the cause was a third-party script.
 * These tests exist because the fusion landed with 250 tests green and none of
 * them noticed, which is the same coverage shape that let useSceneGate ship
 * broken in 2.0.0.
 */
describe("fuse: would reducing quality actually help", () => {
  const quiet = { source: "none" as const, confidence: 1 };

  it("leaves a healthy page alone", () => {
    expect(fuse(0, 0, false, quiet)).toEqual({ effective: 0, cause: "ok" });
  });

  it("treats reduced motion as an absolute floor", () => {
    expect(fuse(0, 0, true, quiet)).toEqual({ effective: 2, cause: "reduced-motion" });
  });

  it("treats a weak device as a floor no measurement can lift", () => {
    const out = fuse(2, 0, false, { source: "render", confidence: 1 });
    expect(out).toEqual({ effective: 2, cause: "device" });
  });

  it("degrades when rendering is confidently the bottleneck", () => {
    const out = fuse(0, 1, false, { source: "render", confidence: 0.6 });
    expect(out).toEqual({ effective: 1, cause: "render" });
  });

  it("REFUSES to degrade for a blocked main thread", () => {
    // The headline of 3.0. A smaller scene does not unblock a blocked thread,
    // so the budget tier is overruled and the refusal is reported.
    const out = fuse(0, 1, false, { source: "main-thread", confidence: 1 });
    expect(out).toEqual({ effective: 0, cause: "held" });
  });

  it("refuses for our own runtime work too, since shedding already answers it", () => {
    const out = fuse(0, 1, false, { source: "runtime", confidence: 1 });
    expect(out).toEqual({ effective: 0, cause: "held" });
  });

  it("trusts the frame rate when the classifier has no verdict", () => {
    // Silence from the classifier means the frame is under its attribution
    // line, not that nothing is wrong. Between roughly 54 and 48fps this is
    // the only signal there is.
    const out = fuse(0, 1, false, { source: "none", confidence: 1 });
    expect(out).toEqual({ effective: 1, cause: "frame-rate" });
  });

  it("trusts the frame rate when a blaming verdict is not confident enough", () => {
    // A coin-flip main-thread guess must not stop a real degradation.
    const out = fuse(0, 1, false, { source: "main-thread", confidence: 0.2 });
    expect(out).toEqual({ effective: 1, cause: "frame-rate" });
  });

  it("ignores a render verdict it is not confident about", () => {
    const out = fuse(0, 0, false, { source: "render", confidence: 0.2 });
    expect(out).toEqual({ effective: 0, cause: "ok" });
  });

  it("keeps the device floor when the budget is healthier than the device", () => {
    const out = fuse(1, 0, false, quiet);
    expect(out).toEqual({ effective: 1, cause: "device" });
  });
});

/**
 * Server-side rendering.
 *
 * This file runs in a node environment, so `window` and `navigator` are genuinely
 * absent, which is the same situation Nuxt or SvelteKit put the core entry in.
 * The core carries no "use client" and the README advertises it as
 * framework-agnostic, so reading the governor on the server has to work.
 */
describe("AdaptiveQuality without a DOM", () => {
  it("reports a tier instead of throwing", async () => {
    const { getAdaptiveQuality } = await import("./AdaptiveQuality");
    expect(typeof window).toBe("undefined");
    expect(() => getAdaptiveQuality().state).not.toThrow();
  });

  it("reports the optimistic tier, so SSR markup matches the first client render", async () => {
    const { getAdaptiveQuality } = await import("./AdaptiveQuality");
    const state = getAdaptiveQuality().state;
    // Not tier 2. The signals-based classifier maps "no WebGL2" to the poster
    // tier, and using that on the server would render the fallback and then
    // flash to a full scene the moment a capable device hydrated.
    expect(state.tier).toBe(0);
    expect(state.deviceTier).toBe(0);
    expect(state.reducedMotion).toBe(false);
  });

  it("says why it did not probe", async () => {
    const { getAdaptiveQuality } = await import("./AdaptiveQuality");
    expect(getAdaptiveQuality().state.reasons.join(" ")).toMatch(/no browser environment/);
  });

  it("subscribing on the server does not throw either", async () => {
    const { getAdaptiveQuality } = await import("./AdaptiveQuality");
    // A property rather than a `let`: control-flow analysis cannot see the
    // assignment inside the callback, so a local narrows to `never`.
    const held: { off?: () => void } = {};
    expect(() => {
      held.off = getAdaptiveQuality().subscribe(() => {});
    }).not.toThrow();
    held.off?.();
  });
});
