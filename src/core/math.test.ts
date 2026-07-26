import { describe, it, expect } from "vitest";
import { damp, clamp01, rayRectIntersect } from "./math";

describe("damp", () => {
  it("converges toward the target", () => {
    let v = 0;
    for (let i = 0; i < 60; i++) v = damp(v, 1, 10, 1 / 60);
    expect(v).toBeGreaterThan(0.99);
  });

  it("is frame-rate independent: two half-steps equal one full step", () => {
    const full = damp(0, 1, 8, 1 / 30);
    let halves = damp(0, 1, 8, 1 / 60);
    halves = damp(halves, 1, 8, 1 / 60);
    expect(halves).toBeCloseTo(full, 10);
  });
});

describe("clamp01", () => {
  it("clamps", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(0.5)).toBe(0.5);
  });
});

describe("rayRectIntersect", () => {
  const rect = { left: 100, top: 0, right: 200, bottom: 100 };

  it("hits a rect straight ahead with the correct time-to-impact", () => {
    // 100px away at 100px/s → 1 second
    expect(rayRectIntersect(0, 50, 100, 0, rect)).toBeCloseTo(1);
  });

  it("misses when moving away", () => {
    expect(rayRectIntersect(0, 50, -100, 0, rect)).toBeNull();
  });

  it("returns 0 when already inside", () => {
    expect(rayRectIntersect(150, 50, 100, 0, rect)).toBe(0);
  });

  it("misses on a parallel path outside the slab", () => {
    // Moving rightward but 200px above the rect
    expect(rayRectIntersect(0, -200, 100, 0, rect)).toBeNull();
  });

  it("handles zero velocity: only hits if already within the axis span", () => {
    expect(rayRectIntersect(0, 50, 0, 0, rect)).toBeNull();
    expect(rayRectIntersect(150, 50, 0, 0, rect)).toBe(0);
  });

  it("hits on a diagonal", () => {
    // From origin toward the rect's center-ish at equal speed
    const t = rayRectIntersect(0, -100, 100, 100, rect);
    expect(t).not.toBeNull();
    expect(t!).toBeCloseTo(1); // x reaches 100 at t=1, y reaches 0 at t=1
  });
});
