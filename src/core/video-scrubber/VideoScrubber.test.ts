import { describe, it, expect } from "vitest";
import { scrollProgress } from "./VideoScrubber";

describe("scrollProgress", () => {
  const VH = 1000;

  describe("pin mapping (tall sticky tracks)", () => {
    it("is 0 when the track top docks at the viewport top", () => {
      expect(scrollProgress(0, 3000, VH, "pin")).toBe(0);
    });

    it("is 0.5 halfway through the pinned distance", () => {
      expect(scrollProgress(-1000, 3000, VH, "pin")).toBeCloseTo(0.5);
    });

    it("is 1 when the track bottom reaches the viewport bottom", () => {
      expect(scrollProgress(-2000, 3000, VH, "pin")).toBe(1);
    });

    it("clamps outside the pinned range", () => {
      expect(scrollProgress(500, 3000, VH, "pin")).toBe(0);
      expect(scrollProgress(-2500, 3000, VH, "pin")).toBe(1);
    });
  });

  describe("cross mapping (short tracks)", () => {
    it("is 0 while the track waits below the viewport", () => {
      expect(scrollProgress(1000, 500, VH, "cross")).toBe(0);
    });

    it("is 1 once the track has exited above", () => {
      expect(scrollProgress(-500, 500, VH, "cross")).toBe(1);
    });

    it("progresses linearly through the crossing", () => {
      expect(scrollProgress(250, 500, VH, "cross")).toBeCloseTo(0.5);
    });
  });

  describe("auto mapping", () => {
    it("picks pin for tracks taller than 1.2 viewports", () => {
      expect(scrollProgress(-1000, 3000, VH, "auto")).toBeCloseTo(0.5); // pin math
    });

    it("picks cross for short tracks", () => {
      expect(scrollProgress(250, 500, VH, "auto")).toBeCloseTo(0.5); // cross math
    });
  });
});
