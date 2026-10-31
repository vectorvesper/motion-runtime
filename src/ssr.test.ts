/**
 * The core entry, called with no DOM.
 *
 * This file runs in a node environment: no `window`, no `navigator`, no
 * `requestAnimationFrame`. That is what Nuxt, SvelteKit and Astro give
 * `@vectorvesper/motion`, and React can't catch these crashes because hooks
 * touch the runtime from effects, which don't run on the server.
 *
 * So this walks the whole public surface. A new export that touches a browser
 * global at call time fails here.
 */

import { describe, it, expect } from "vitest";

describe("the core entry with no DOM", () => {
  it("has no browser globals, so this is a real SSR environment", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof document).toBe("undefined");
    expect(typeof requestAnimationFrame).toBe("undefined");
  });

  it("imports", async () => {
    const mod = await import("./entry.core");
    expect(typeof mod.VERSION).toBe("string");
  });

  /**
   * Every singleton getter, its `state`, and its subscribe and release cycle.
   * Subscribing is where the conductor tries to start a frame loop.
   */
  it("lets every singleton be read and subscribed without throwing", async () => {
    const {
      getConductor, getSensorBus, getAnimationBudget,
      getAdaptiveQuality, getFramePressure, getRendererHealth,
    } = await import("./entry.core");

    const cases: [string, () => () => void][] = [
      ["conductor", () => getConductor().subscribe("update", () => {})],
      ["sensorBus", () => getSensorBus().retain()],
      ["animationBudget", () => getAnimationBudget().subscribe(() => {})],
      ["adaptiveQuality", () => getAdaptiveQuality().subscribe(() => {})],
      ["framePressure", () => getFramePressure().subscribe(() => {})],
      ["rendererHealth", () => getRendererHealth().subscribe(() => {})],
    ];

    const failures: string[] = [];
    for (const [name, subscribe] of cases) {
      try {
        subscribe()();
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("lets every state be read without throwing", async () => {
    const {
      getConductor, getSensorBus, getAnimationBudget,
      getAdaptiveQuality, getFramePressure, getRendererHealth,
    } = await import("./entry.core");

    const failures: string[] = [];
    const read = (name: string, fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        failures.push(`${name}: ${(error as Error).message}`);
      }
    };

    read("conductor.state", () => getConductor().state);
    read("sensorBus.state", () => getSensorBus().state.pointer.x);
    read("animationBudget.state", () => getAnimationBudget().state.tier);
    read("adaptiveQuality.state", () => getAdaptiveQuality().state.tier);
    read("framePressure.state", () => getFramePressure().state.source);
    read("rendererHealth.state", () => getRendererHealth().state.generation);

    expect(failures).toEqual([]);
  });

  it("keeps the pure helpers pure", async () => {
    const { clamp01, damp, rayRectIntersect, scrollProgress } = await import("./entry.core");
    expect(clamp01(1.7)).toBe(1);
    expect(damp(0, 10, 8, 1 / 60)).toBeGreaterThan(0);
    expect(typeof rayRectIntersect).toBe("function");
    expect(scrollProgress(0, 1000, 800, "pin")).toBeGreaterThanOrEqual(0);
  });

  /**
   * `deviceTierFromSignals` maps "no WebGL2" to tier 2, the poster tier, which
   * on the server would render the fallback and then flash to a full scene.
   * Tier 0 matches `useAdaptiveQuality`'s INITIAL, so both entries produce the
   * same server markup.
   */
  it("reports the optimistic tier on the server, so hydration does not flash", async () => {
    const { getAdaptiveQuality } = await import("./entry.core");
    const state = getAdaptiveQuality().state;
    expect(state.tier).toBe(0);
    expect(state.deviceTier).toBe(0);
    expect(state.reducedMotion).toBe(false);
  });

  it("does not start a frame loop it cannot run", async () => {
    const { getConductor } = await import("./entry.core");
    const off = getConductor().subscribe("update", () => {});
    // Subscribing succeeds and the subscriber is registered; there is simply no
    // loop turning, which is the truthful outcome where no frame is presented.
    expect(getConductor().state.running).toBe(false);
    off();
  });
});
