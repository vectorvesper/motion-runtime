import { describe, it, expect } from "vitest";
import { deviceTierFromSignals, type DeviceSignals } from "./AdaptiveQuality";

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
